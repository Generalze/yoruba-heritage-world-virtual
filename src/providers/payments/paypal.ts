import { utcMsToSql } from '@/lib/schedule-time'
import {
  decodeRawBody,
  getHeader,
  parseJsonSafely,
  providerRequest,
  readProviderJson,
  defaultTransport,
} from './http'
import { decimalStringToMinor, minorToDecimalString } from './money'
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
 * PayPal adapter — official Orders API v2 (spec §22/§23).
 *
 * Flow: server creates the order (PayPal-Request-Id = attempt
 * idempotency key, custom_id/invoice_id = internal attempt identity) →
 * buyer approves on PayPal → an authenticated, owner-checked server
 * action captures. The browser return URL is never proof of payment;
 * only COMPLETED captures with matching amount/currency settle.
 *
 * OAuth: client-credentials server-side with a small in-process token
 * cache (single-instance architecture — no Redis). The client secret
 * never reaches browser code.
 *
 * Webhooks: verified through PayPal's official
 * verify-webhook-signature API with the configured PAYPAL_WEBHOOK_ID
 * and the provider's transmission headers, BEFORE any processing.
 */

export interface PaypalConfig {
  enabled: boolean
  envName: 'sandbox' | 'live'
  clientId: string
  clientSecret: string
  webhookId: string
  currencies: Array<string>
  transport?: ProviderTransport
  baseUrl?: string
}

interface PaypalCapture {
  id?: string
  status?: string
  amount?: { currency_code?: string; value?: string }
  create_time?: string
  custom_id?: string
}

interface PaypalOrder {
  id?: string
  status?: string
  links?: Array<{ rel?: string; href?: string }>
  purchase_units?: Array<{
    custom_id?: string
    payments?: { captures?: Array<PaypalCapture> }
  }>
}

function isoToSql(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? utcMsToSql(ms) : null
}

export function createPaypalProvider(cfg: PaypalConfig): PaymentProvider {
  const transport = cfg.transport ?? defaultTransport
  const baseUrl =
    cfg.baseUrl ??
    (cfg.envName === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com')
  const currencies = new Set(cfg.currencies.map((c) => c.toUpperCase()))

  // In-process access-token cache (single-instance architecture).
  let cachedToken: { token: string; expiresAtMs: number } | null = null

  async function getAccessToken(nowMs: number = Date.now()): Promise<string> {
    if (cachedToken && cachedToken.expiresAtMs > nowMs) {
      return cachedToken.token
    }
    const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString(
      'base64',
    )
    const response = await providerRequest(
      transport,
      `${baseUrl}/v1/oauth2/token`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
    )
    const body = (await readProviderJson(response)) as {
      access_token?: string
      expires_in?: number
    }
    if (!response.ok || !body.access_token) {
      throw new PaymentProviderError(
        'PAYPAL_AUTH_FAILED',
        'PayPal authentication failed.',
        response.status >= 500,
      )
    }
    cachedToken = {
      token: body.access_token,
      // Refresh a minute early so an about-to-expire token is never used.
      expiresAtMs: nowMs + Math.max((body.expires_in ?? 300) - 60, 60) * 1000,
    }
    return cachedToken.token
  }

  /** 5xx/429/401 are transport/auth conditions, never payment verdicts;
   * 401 additionally drops the token cache so the retry re-auths. */
  function throwIfTransient(response: Response, code: string): void {
    if (response.status >= 500 || response.status === 429) {
      throw new PaymentProviderError(
        code,
        'PayPal is temporarily unavailable.',
        true,
      )
    }
    if (response.status === 401) {
      cachedToken = null
      throw new PaymentProviderError(
        'PAYPAL_AUTH_EXPIRED',
        'PayPal authentication expired — please retry.',
        true,
      )
    }
  }

  function normalizeCapture(
    capture: PaypalCapture,
    orderId: string | null,
    attemptPublicId: string | null,
  ): VerifiedPaymentResult {
    const status = capture.status ?? 'UNKNOWN'
    let outcome: VerifiedPaymentResult['outcome'] = 'PENDING'
    if (status === 'COMPLETED') outcome = 'SUCCEEDED'
    else if (status === 'DECLINED' || status === 'FAILED') outcome = 'FAILED'
    const currency = capture.amount?.currency_code?.toUpperCase() ?? null
    const amountMinor =
      currency && capture.amount?.value != null
        ? decimalStringToMinor(capture.amount.value, currency)
        : null
    return {
      provider: 'PAYPAL',
      providerReference: null,
      providerPaymentId: capture.id ?? null,
      providerCheckoutId: orderId,
      attemptPublicId: capture.custom_id ?? attemptPublicId,
      outcome,
      amountMinor,
      currency,
      paidAtSql: outcome === 'SUCCEEDED' ? isoToSql(capture.create_time) : null,
      providerStatus: status,
      failureCode: outcome === 'FAILED' ? status : null,
      failureMessage: null,
    }
  }

  function normalizeOrder(order: PaypalOrder): VerifiedPaymentResult {
    const unit = order.purchase_units?.at(0)
    const capture = unit?.payments?.captures?.at(0)
    if (capture) {
      return normalizeCapture(
        capture,
        order.id ?? null,
        unit?.custom_id ?? null,
      )
    }
    let outcome: VerifiedPaymentResult['outcome'] = 'PENDING'
    if (order.status === 'VOIDED') outcome = 'CANCELLED'
    return {
      provider: 'PAYPAL',
      providerReference: null,
      providerPaymentId: null,
      providerCheckoutId: order.id ?? null,
      attemptPublicId: unit?.custom_id ?? null,
      outcome,
      amountMinor: null,
      currency: null,
      paidAtSql: null,
      providerStatus: order.status ?? null,
      failureCode: null,
      failureMessage: null,
    }
  }

  return {
    code: 'PAYPAL',
    displayName: 'PayPal',

    isEnabled() {
      return (
        cfg.enabled &&
        cfg.clientId.length > 0 &&
        cfg.clientSecret.length > 0 &&
        cfg.webhookId.length > 0
      )
    },

    canVerifyWebhooks() {
      return (
        cfg.clientId.length > 0 &&
        cfg.clientSecret.length > 0 &&
        cfg.webhookId.length > 0
      )
    },

    supportsCurrency(currency: string) {
      return currencies.has(currency.toUpperCase())
    },

    async initializePayment(
      input: InitializePaymentInput,
    ): Promise<InitializePaymentResult> {
      const token = await getAccessToken()
      const response = await providerRequest(
        transport,
        `${baseUrl}/v2/checkout/orders`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'PayPal-Request-Id': input.attempt.idempotencyKey,
          },
          body: JSON.stringify({
            intent: 'CAPTURE',
            purchase_units: [
              {
                reference_id: 'default',
                custom_id: input.attempt.publicId,
                invoice_id: input.attempt.idempotencyKey,
                amount: {
                  currency_code: input.attempt.currency,
                  value: minorToDecimalString(
                    input.attempt.amountMinor,
                    input.attempt.currency,
                  ),
                },
              },
            ],
            payment_source: {
              paypal: {
                experience_context: {
                  return_url: input.returnUrl,
                  cancel_url: input.cancelUrl,
                  user_action: 'PAY_NOW',
                  shipping_preference: 'NO_SHIPPING',
                },
              },
            },
          }),
        },
      )
      throwIfTransient(response, 'PAYPAL_UNAVAILABLE')
      const order = (await readProviderJson(response)) as PaypalOrder
      if (!response.ok || !order.id) {
        throw new PaymentProviderError(
          'PAYPAL_REJECTED',
          'PayPal rejected the payment initialization.',
          false,
        )
      }
      const approveUrl = order.links?.find(
        (link) => link.rel === 'payer-action' || link.rel === 'approve',
      )?.href
      if (!approveUrl) {
        throw new PaymentProviderError(
          'PAYPAL_NO_CHECKOUT_URL',
          'PayPal did not return an approval URL.',
          false,
        )
      }
      return {
        checkoutUrl: approveUrl,
        providerReference: input.attempt.idempotencyKey,
        providerPaymentId: null,
        providerCheckoutId: order.id,
        providerStatus: order.status ?? null,
        cryptoQuote: null,
      }
    },

    async verifyPayment(
      attempt: AttemptIdentity,
    ): Promise<VerifiedPaymentResult> {
      if (!attempt.providerCheckoutId) {
        return {
          provider: 'PAYPAL',
          providerReference: attempt.providerReference,
          providerPaymentId: null,
          providerCheckoutId: null,
          attemptPublicId: attempt.publicId,
          outcome: 'PENDING',
          amountMinor: null,
          currency: null,
          paidAtSql: null,
          providerStatus: 'no_order',
          failureCode: null,
          failureMessage: null,
        }
      }
      const token = await getAccessToken()
      const response = await providerRequest(
        transport,
        `${baseUrl}/v2/checkout/orders/${encodeURIComponent(attempt.providerCheckoutId)}`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        },
      )
      throwIfTransient(response, 'PAYPAL_UNAVAILABLE')
      const order = (await readProviderJson(response)) as PaypalOrder
      if (!response.ok || !order.id) {
        throw new PaymentProviderError(
          'PAYPAL_VERIFY_FAILED',
          'PayPal could not verify the order.',
          false,
        )
      }
      return normalizeOrder(order)
    },

    async capturePayment(
      attempt: AttemptIdentity,
    ): Promise<VerifiedPaymentResult> {
      if (!attempt.providerCheckoutId) {
        throw new PaymentProviderError(
          'PAYPAL_NO_ORDER',
          'There is no PayPal order to capture.',
          false,
        )
      }
      const token = await getAccessToken()
      const response = await providerRequest(
        transport,
        `${baseUrl}/v2/checkout/orders/${encodeURIComponent(attempt.providerCheckoutId)}/capture`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            // Same idempotent identity (suffixed for the capture call):
            // a retried capture never double-captures.
            'PayPal-Request-Id': `${attempt.idempotencyKey}-cap`,
          },
          body: '{}',
        },
      )
      throwIfTransient(response, 'PAYPAL_UNAVAILABLE')
      const order = (await readProviderJson(response)) as PaypalOrder & {
        details?: Array<{ issue?: string }>
      }
      if (!response.ok) {
        const issue = order.details?.at(0)?.issue
        if (issue === 'ORDER_ALREADY_CAPTURED') {
          // Idempotent re-entry: read the order's real state instead.
          return this.verifyPayment(attempt)
        }
        // A capture REJECTION is not a payment failure. The order may
        // still be approvable/capturable (buyer hasn't approved yet,
        // instrument declined and retryable, further payer action
        // needed) — report PENDING so the attempt stays live and a
        // later approval can still capture. Only provider-ASSERTED
        // capture outcomes (DECLINED capture objects, DENIED webhooks)
        // ever mark an attempt FAILED; unknown rejections surface as a
        // retryable error that leaves the ledger untouched.
        if (
          issue === 'ORDER_NOT_APPROVED' ||
          issue === 'INSTRUMENT_DECLINED' ||
          issue === 'PAYER_ACTION_REQUIRED'
        ) {
          return {
            provider: 'PAYPAL',
            providerReference: null,
            providerPaymentId: null,
            providerCheckoutId: attempt.providerCheckoutId,
            attemptPublicId: attempt.publicId,
            outcome: 'PENDING',
            amountMinor: null,
            currency: null,
            paidAtSql: null,
            providerStatus: issue,
            failureCode: null,
            failureMessage: null,
          }
        }
        throw new PaymentProviderError(
          'PAYPAL_CAPTURE_REJECTED',
          'PayPal did not accept the capture request.',
          true,
        )
      }
      return normalizeOrder(order)
    },

    async parseAndVerifyWebhook(
      rawBody: Uint8Array,
      headers: Record<string, string>,
    ): Promise<WebhookVerificationResult> {
      if (!this.canVerifyWebhooks()) {
        return { ok: false, reason: 'not_configured' }
      }
      const transmissionId = getHeader(headers, 'paypal-transmission-id')
      const transmissionTime = getHeader(headers, 'paypal-transmission-time')
      const transmissionSig = getHeader(headers, 'paypal-transmission-sig')
      const certUrl = getHeader(headers, 'paypal-cert-url')
      const authAlgo = getHeader(headers, 'paypal-auth-algo')
      if (
        !transmissionId ||
        !transmissionTime ||
        !transmissionSig ||
        !certUrl ||
        !authAlgo
      ) {
        return { ok: false, reason: 'missing_transmission_headers' }
      }
      const event = parseJsonSafely(decodeRawBody(rawBody)) as {
        id?: string
        event_type?: string
        resource?: PaypalCapture & {
          supplementary_data?: { related_ids?: { order_id?: string } }
        }
      } | null
      if (!event?.id || typeof event.event_type !== 'string') {
        return { ok: false, reason: 'unparseable_payload' }
      }
      // Official verification API — PayPal itself authenticates the
      // transmission against the configured webhook id.
      const token = await getAccessToken()
      const response = await providerRequest(
        transport,
        `${baseUrl}/v1/notifications/verify-webhook-signature`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            auth_algo: authAlgo,
            cert_url: certUrl,
            transmission_id: transmissionId,
            transmission_sig: transmissionSig,
            transmission_time: transmissionTime,
            webhook_id: cfg.webhookId,
            webhook_event: event,
          }),
        },
      )
      const verdict = (await readProviderJson(response)) as {
        verification_status?: string
      }
      if (!response.ok || verdict.verification_status !== 'SUCCESS') {
        return { ok: false, reason: 'verification_failed' }
      }
      const base = {
        ok: true as const,
        eventKey: event.id,
        providerEventId: event.id,
        eventType: event.event_type,
      }
      if (
        event.event_type === 'PAYMENT.CAPTURE.COMPLETED' ||
        event.event_type === 'PAYMENT.CAPTURE.DENIED'
      ) {
        const resource = event.resource ?? {}
        return {
          ...base,
          relevant: true,
          verified: normalizeCapture(
            resource,
            resource.supplementary_data?.related_ids?.order_id ?? null,
            null,
          ),
        }
      }
      return { ...base, relevant: false, verified: null }
    },
  }
}
