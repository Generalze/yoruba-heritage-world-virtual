import { utcMsToSql } from '@/lib/schedule-time'
import {
  decodeRawBody,
  getHeader,
  hmacHex,
  parseJsonSafely,
  providerRequest,
  readProviderJson,
  timingSafeEqualHex,
  defaultTransport,
} from './http'
import { PaymentProviderError } from './types'
import type {
  AttemptIdentity,
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentProvider,
  ProviderTransport,
  VerifiedPaymentResult,
  WebhookVerificationResult,
} from './types'

/**
 * Stripe adapter — hosted Checkout Session via the official REST API
 * (spec §21). No custom raw-card Elements; no Adaptive Pricing or
 * automatic currency conversion — the session amount/currency are
 * always the appointment snapshot, expressed as dynamic price_data.
 *
 * The Idempotency-Key header carries the attempt's stable identity so
 * a retried initialization can never create a second session/charge.
 *
 * Webhooks: Stripe-Signature (t=…,v1=…) is verified as
 * HMAC-SHA256(`${t}.${rawBody}`) over the EXACT raw bytes with the
 * webhook secret, timing-safe, with a timestamp tolerance window. A
 * success return URL is never proof of payment — fulfillment flows only
 * from verified webhook/API state.
 */

export interface StripeConfig {
  enabled: boolean
  secretKey: string
  webhookSecret: string
  currencies: Array<string>
  transport?: ProviderTransport
  baseUrl?: string
  /** Webhook timestamp tolerance (replay window), seconds. */
  toleranceSeconds?: number
}

interface StripeCheckoutSession {
  id?: string
  url?: string | null
  status?: string
  payment_status?: string
  payment_intent?: string | null
  amount_total?: number | null
  currency?: string | null
  client_reference_id?: string | null
  created?: number
  metadata?: Record<string, string> | null
}

const RELEVANT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
])

/**
 * Stripe CHARGE "special case" currencies (docs.stripe.com/currencies):
 * ISO 4217 treats them as zero-decimal but Stripe's charge API keeps a
 * two-decimal representation whose last two digits must be 00. Our
 * ledger stores ISO minor units, so amounts sent to / read from Stripe
 * must be scaled — without this, an ISK/UGX appointment would be
 * charged at 1/100 of its price while verification still "matched".
 *
 * Deliberately ONLY ISK and UGX: Stripe's documented HUF/TWD special
 * behavior concerns PAYOUTS — their normal charges remain ordinary
 * two-decimal amounts and must not be scaled.
 */
const STRIPE_TWO_DECIMAL_EXCEPTIONS = new Set(['ISK', 'UGX'])

function toStripeAmount(amountMinor: number, currency: string): number {
  return STRIPE_TWO_DECIMAL_EXCEPTIONS.has(currency.toUpperCase())
    ? amountMinor * 100
    : amountMinor
}

/** Returns null when Stripe reports an amount that does not scale back
 * to whole ISO minor units — the settlement layer then records it as an
 * AMOUNT_MISMATCH review instead of guessing. */
function fromStripeAmount(
  stripeAmount: number | null | undefined,
  currency: string | null | undefined,
): number | null {
  if (typeof stripeAmount !== 'number' || !currency) {
    return typeof stripeAmount === 'number' ? stripeAmount : null
  }
  if (!STRIPE_TWO_DECIMAL_EXCEPTIONS.has(currency.toUpperCase())) {
    return stripeAmount
  }
  return stripeAmount % 100 === 0 ? stripeAmount / 100 : null
}

export function createStripeProvider(cfg: StripeConfig): PaymentProvider {
  const transport = cfg.transport ?? defaultTransport
  const baseUrl = cfg.baseUrl ?? 'https://api.stripe.com'
  const tolerance = cfg.toleranceSeconds ?? 300
  const currencies = new Set(cfg.currencies.map((c) => c.toUpperCase()))

  function normalizeSession(
    session: StripeCheckoutSession,
    eventType: string | null,
    eventCreatedMs: number | null,
  ): VerifiedPaymentResult {
    let outcome: VerifiedPaymentResult['outcome'] = 'PENDING'
    if (session.payment_status === 'paid') {
      outcome = 'SUCCEEDED'
    } else if (eventType === 'checkout.session.async_payment_failed') {
      outcome = 'FAILED'
    } else if (
      eventType === 'checkout.session.expired' ||
      session.status === 'expired'
    ) {
      outcome = 'EXPIRED'
    }
    return {
      provider: 'STRIPE',
      providerReference: null,
      providerPaymentId: session.payment_intent ?? null,
      providerCheckoutId: session.id ?? null,
      attemptPublicId:
        session.metadata?.paymentAttemptPublicId ??
        session.client_reference_id ??
        null,
      outcome,
      amountMinor: fromStripeAmount(session.amount_total, session.currency),
      currency: session.currency ? session.currency.toUpperCase() : null,
      paidAtSql:
        outcome === 'SUCCEEDED' && eventCreatedMs != null
          ? utcMsToSql(eventCreatedMs)
          : null,
      providerStatus: session.payment_status ?? session.status ?? null,
      failureCode: outcome === 'FAILED' ? 'async_payment_failed' : null,
      failureMessage: null,
    }
  }

  return {
    code: 'STRIPE',
    displayName: 'Stripe',

    isEnabled() {
      return (
        cfg.enabled && cfg.secretKey.length > 0 && cfg.webhookSecret.length > 0
      )
    },

    canVerifyWebhooks() {
      return cfg.webhookSecret.length > 0
    },

    supportsCurrency(currency: string) {
      return currencies.has(currency.toUpperCase())
    },

    async initializePayment(
      input: InitializePaymentInput,
    ): Promise<InitializePaymentResult> {
      // Neutral product label only — no spiritual context is ever sent
      // to a payment company (spec §60).
      const params = new URLSearchParams({
        mode: 'payment',
        client_reference_id: input.attempt.publicId,
        success_url: input.returnUrl,
        cancel_url: input.cancelUrl,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]':
          input.attempt.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(
          toStripeAmount(input.attempt.amountMinor, input.attempt.currency),
        ),
        'line_items[0][price_data][product_data][name]': `Appointment ${input.appointmentPublicId}`,
        'metadata[paymentAttemptPublicId]': input.attempt.publicId,
        'metadata[appointmentPublicId]': input.appointmentPublicId,
        'payment_intent_data[metadata][paymentAttemptPublicId]':
          input.attempt.publicId,
      })
      const response = await providerRequest(
        transport,
        `${baseUrl}/v1/checkout/sessions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.secretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Idempotency-Key': input.attempt.idempotencyKey,
          },
          body: params.toString(),
        },
      )
      if (response.status >= 500) {
        throw new PaymentProviderError(
          'STRIPE_UNAVAILABLE',
          'Stripe is temporarily unavailable.',
          true,
        )
      }
      const session = (await readProviderJson(
        response,
      )) as StripeCheckoutSession & { error?: { message?: string } }
      if (!response.ok || !session.id || !session.url) {
        throw new PaymentProviderError(
          'STRIPE_REJECTED',
          'Stripe rejected the payment initialization.',
          false,
        )
      }
      return {
        checkoutUrl: session.url,
        providerReference: input.attempt.idempotencyKey,
        providerPaymentId: session.payment_intent ?? null,
        providerCheckoutId: session.id,
        providerStatus: session.status ?? null,
        cryptoQuote: null,
      }
    },

    async verifyPayment(
      attempt: AttemptIdentity,
    ): Promise<VerifiedPaymentResult> {
      if (!attempt.providerCheckoutId) {
        return {
          provider: 'STRIPE',
          providerReference: attempt.providerReference,
          providerPaymentId: null,
          providerCheckoutId: null,
          attemptPublicId: attempt.publicId,
          outcome: 'PENDING',
          amountMinor: null,
          currency: null,
          paidAtSql: null,
          providerStatus: 'no_session',
          failureCode: null,
          failureMessage: null,
        }
      }
      const response = await providerRequest(
        transport,
        `${baseUrl}/v1/checkout/sessions/${encodeURIComponent(attempt.providerCheckoutId)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${cfg.secretKey}` },
        },
      )
      if (response.status >= 500) {
        throw new PaymentProviderError(
          'STRIPE_UNAVAILABLE',
          'Stripe is temporarily unavailable.',
          true,
        )
      }
      const session = (await readProviderJson(
        response,
      )) as StripeCheckoutSession
      if (!response.ok || !session.id) {
        throw new PaymentProviderError(
          'STRIPE_VERIFY_FAILED',
          'Stripe could not verify the payment session.',
          false,
        )
      }
      // Direct API verification carries NO payment-completion
      // timestamp: session.created is the Checkout Session OBJECT
      // creation time, not when the buyer paid, and must never be
      // presented as a payment time. paidAtSql stays null here — the
      // central settlement layer stamps its fresh in-lock settlement
      // clock as the fallback. (Webhook success events keep using the
      // provider EVENT timestamp — that is a genuine provider-reported
      // time for the success notification.)
      return normalizeSession(session, null, null)
    },

    async parseAndVerifyWebhook(
      rawBody: Uint8Array,
      headers: Record<string, string>,
      nowMs: number = Date.now(),
    ): Promise<WebhookVerificationResult> {
      if (cfg.webhookSecret.length === 0) {
        return { ok: false, reason: 'not_configured' }
      }
      const signatureHeader = getHeader(headers, 'stripe-signature')
      if (!signatureHeader) return { ok: false, reason: 'missing_signature' }

      let timestamp: string | null = null
      const candidates: Array<string> = []
      for (const part of signatureHeader.split(',')) {
        const separator = part.indexOf('=')
        if (separator === -1) continue
        const key = part.slice(0, separator).trim()
        const value = part.slice(separator + 1).trim()
        if (key === 't' && value) timestamp = value
        if (key === 'v1' && value) candidates.push(value)
      }
      if (!timestamp || candidates.length === 0) {
        return { ok: false, reason: 'malformed_signature' }
      }
      const timestampSeconds = Number(timestamp)
      if (
        !Number.isFinite(timestampSeconds) ||
        Math.abs(nowMs / 1000 - timestampSeconds) > tolerance
      ) {
        return { ok: false, reason: 'timestamp_outside_tolerance' }
      }
      // Signed payload is `${t}.${raw body bytes}` — the body is NEVER
      // parsed/re-stringified before verification.
      const signedPayload = Buffer.concat([
        Buffer.from(`${timestamp}.`, 'utf8'),
        Buffer.from(rawBody),
      ])
      const expected = hmacHex('sha256', cfg.webhookSecret, signedPayload)
      const matched = candidates.some((candidate) =>
        timingSafeEqualHex(expected, candidate.toLowerCase()),
      )
      if (!matched) return { ok: false, reason: 'invalid_signature' }

      const event = parseJsonSafely(decodeRawBody(rawBody)) as {
        id?: string
        type?: string
        created?: number
        data?: { object?: StripeCheckoutSession }
      } | null
      if (!event?.id || typeof event.type !== 'string') {
        return { ok: false, reason: 'unparseable_payload' }
      }
      const base = {
        ok: true as const,
        eventKey: event.id,
        providerEventId: event.id,
        eventType: event.type,
      }
      if (!RELEVANT_EVENTS.has(event.type) || !event.data?.object) {
        return { ...base, relevant: false, verified: null }
      }
      return {
        ...base,
        relevant: true,
        verified: normalizeSession(
          event.data.object,
          event.type,
          event.created != null ? event.created * 1000 : null,
        ),
      }
    },
  }
}
