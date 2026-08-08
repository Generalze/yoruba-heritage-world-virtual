import { utcMsToSql } from '@/lib/schedule-time'
import {
  decodeRawBody,
  getHeader,
  hmacHex,
  parseJsonSafely,
  providerRequest,
  readProviderJson,
  sha256Hex,
  timingSafeEqualHex,
  defaultTransport,
} from './http'
import { PaymentProviderError } from './types'
import type {
  AttemptIdentity,
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentOutcome,
  PaymentProvider,
  ProviderTransport,
  VerifiedPaymentResult,
  WebhookVerificationResult,
} from './types'

/**
 * Paystack adapter — official REST transaction flow (spec §20).
 *
 * - Initialization happens ONLY from the backend with a server-generated
 *   unique reference (the attempt's idempotency key), the appointment
 *   snapshot amount in subunits, and minimal metadata (attempt +
 *   appointment public ids — never spiritual context, DOB or notes).
 * - Verification is by reference against the authenticated API.
 * - Webhooks are authenticated by HMAC-SHA512 of the EXACT raw request
 *   bytes with the secret key, compared timing-safe against
 *   x-paystack-signature BEFORE any payload processing.
 * - Callback query parameters are never proof of payment — the return
 *   page only triggers server-side verification.
 */

export interface PaystackConfig {
  enabled: boolean
  secretKey: string
  currencies: Array<string>
  transport?: ProviderTransport
  baseUrl?: string
}

interface PaystackTransactionData {
  status?: string
  reference?: string
  id?: number | string
  amount?: number
  currency?: string
  paid_at?: string | null
  gateway_response?: string
}

function isoToSql(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? utcMsToSql(ms) : null
}

function mapTransactionOutcome(status: string | undefined): PaymentOutcome {
  switch (status) {
    case 'success':
      return 'SUCCEEDED'
    case 'failed':
    case 'reversed':
      return 'FAILED'
    case 'abandoned':
      return 'CANCELLED'
    default:
      // ongoing / pending / processing / queued / unknown: never guess a
      // terminal state from an unrecognized provider status.
      return 'PENDING'
  }
}

export function createPaystackProvider(cfg: PaystackConfig): PaymentProvider {
  const transport = cfg.transport ?? defaultTransport
  const baseUrl = cfg.baseUrl ?? 'https://api.paystack.co'
  const currencies = new Set(cfg.currencies.map((c) => c.toUpperCase()))

  function normalize(
    data: PaystackTransactionData,
    fallbackReference: string | null,
  ): VerifiedPaymentResult {
    const outcome = mapTransactionOutcome(data.status)
    return {
      provider: 'PAYSTACK',
      providerReference: data.reference ?? fallbackReference,
      providerPaymentId: data.id != null ? String(data.id) : null,
      providerCheckoutId: null,
      attemptPublicId: null,
      outcome,
      amountMinor: typeof data.amount === 'number' ? data.amount : null,
      currency: data.currency ? data.currency.toUpperCase() : null,
      paidAtSql: isoToSql(data.paid_at),
      providerStatus: data.status ?? null,
      failureCode: outcome === 'FAILED' ? (data.status ?? 'failed') : null,
      failureMessage:
        outcome === 'FAILED' || outcome === 'CANCELLED'
          ? (data.gateway_response ?? null)
          : null,
    }
  }

  return {
    code: 'PAYSTACK',
    displayName: 'Paystack',

    isEnabled() {
      return cfg.enabled && cfg.secretKey.length > 0
    },

    canVerifyWebhooks() {
      return cfg.secretKey.length > 0
    },

    supportsCurrency(currency: string) {
      return currencies.has(currency.toUpperCase())
    },

    async initializePayment(
      input: InitializePaymentInput,
    ): Promise<InitializePaymentResult> {
      const reference = input.attempt.idempotencyKey
      const response = await providerRequest(
        transport,
        `${baseUrl}/transaction/initialize`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.secretKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: input.userEmail,
            amount: input.attempt.amountMinor,
            currency: input.attempt.currency,
            reference,
            callback_url: input.returnUrl,
            metadata: {
              paymentAttemptPublicId: input.attempt.publicId,
              appointmentPublicId: input.appointmentPublicId,
            },
          }),
        },
      )
      if (response.status >= 500) {
        throw new PaymentProviderError(
          'PAYSTACK_UNAVAILABLE',
          'Paystack is temporarily unavailable.',
          true,
        )
      }
      const body = (await readProviderJson(response)) as {
        status?: boolean
        message?: string
        data?: { authorization_url?: string; reference?: string }
      }
      if (!response.ok || body.status !== true || !body.data) {
        // A duplicate-reference rejection means an EARLIER initialize
        // with this same idempotent reference already reached Paystack
        // (e.g. its response was lost to a timeout). That is not a
        // payment failure: the original transaction may be open or even
        // paid. Surface it as retryable so the attempt is never falsely
        // FAILED; the domain then verifies the reference to recover the
        // real state.
        if (/duplicate/i.test(body.message ?? '')) {
          throw new PaymentProviderError(
            'PAYSTACK_DUPLICATE_REFERENCE',
            'This payment reference is already open with Paystack.',
            true,
          )
        }
        throw new PaymentProviderError(
          'PAYSTACK_REJECTED',
          'Paystack rejected the payment initialization.',
          false,
        )
      }
      if (body.data.reference && body.data.reference !== reference) {
        throw new PaymentProviderError(
          'PAYSTACK_REFERENCE_MISMATCH',
          'Paystack returned an unexpected transaction reference.',
          false,
        )
      }
      if (!body.data.authorization_url) {
        throw new PaymentProviderError(
          'PAYSTACK_NO_CHECKOUT_URL',
          'Paystack did not return a checkout URL.',
          false,
        )
      }
      return {
        checkoutUrl: body.data.authorization_url,
        providerReference: reference,
        providerPaymentId: null,
        providerCheckoutId: null,
        providerStatus: 'initialized',
        cryptoQuote: null,
      }
    },

    async verifyPayment(
      attempt: AttemptIdentity,
    ): Promise<VerifiedPaymentResult> {
      const reference = attempt.providerReference ?? attempt.idempotencyKey
      const response = await providerRequest(
        transport,
        `${baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${cfg.secretKey}` },
        },
      )
      if (response.status >= 500) {
        throw new PaymentProviderError(
          'PAYSTACK_UNAVAILABLE',
          'Paystack is temporarily unavailable.',
          true,
        )
      }
      const body = (await readProviderJson(response)) as {
        status?: boolean
        data?: PaystackTransactionData
      }
      if (!response.ok || body.status !== true || !body.data) {
        // Unknown reference / rejected verify — report a non-terminal
        // PENDING rather than inventing a failure the provider did not
        // assert.
        return {
          provider: 'PAYSTACK',
          providerReference: reference,
          providerPaymentId: null,
          providerCheckoutId: null,
          attemptPublicId: null,
          outcome: 'PENDING',
          amountMinor: null,
          currency: null,
          paidAtSql: null,
          providerStatus: 'unverifiable',
          failureCode: null,
          failureMessage: null,
        }
      }
      return normalize(body.data, reference)
    },

    async parseAndVerifyWebhook(
      rawBody: Uint8Array,
      headers: Record<string, string>,
    ): Promise<WebhookVerificationResult> {
      if (cfg.secretKey.length === 0) {
        return { ok: false, reason: 'not_configured' }
      }
      const signature = getHeader(headers, 'x-paystack-signature')
      if (!signature) return { ok: false, reason: 'missing_signature' }
      // HMAC over the EXACT raw bytes — any body mutation invalidates it.
      const expected = hmacHex('sha512', cfg.secretKey, rawBody)
      if (!timingSafeEqualHex(expected, signature.toLowerCase())) {
        return { ok: false, reason: 'invalid_signature' }
      }
      const parsed = parseJsonSafely(decodeRawBody(rawBody)) as {
        event?: string
        data?: PaystackTransactionData
      } | null
      if (!parsed || typeof parsed.event !== 'string') {
        return { ok: false, reason: 'unparseable_payload' }
      }
      const data = parsed.data ?? {}
      // Stable event identity: immutable transaction id when present,
      // then reference, then the payload digest (spec §6).
      const eventKey =
        data.id != null
          ? `${parsed.event}:${String(data.id)}`
          : data.reference
            ? `${parsed.event}:${data.reference}`
            : `${parsed.event}:${sha256Hex(rawBody)}`
      const base = {
        ok: true as const,
        eventKey,
        providerEventId: data.id != null ? String(data.id) : null,
        eventType: parsed.event,
      }
      if (
        parsed.event === 'charge.success' ||
        parsed.event === 'charge.failed'
      ) {
        return {
          ...base,
          relevant: true,
          verified: normalize(data, data.reference ?? null),
        }
      }
      return { ...base, relevant: false, verified: null }
    },
  }
}
