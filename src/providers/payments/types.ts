import type { PaymentProviderCode } from '@/db/schema'

/**
 * Payment provider abstraction (canon §23/§28; Step 6).
 *
 * Provider-specific code lives ONLY in this directory. Application
 * services talk to the PaymentProvider interface through the registry —
 * never through provider conditionals scattered across the codebase.
 *
 * Adapters are deliberately STATELESS translators: they initialize,
 * verify and normalize provider truth into VerifiedPaymentResult.
 * Business decisions (settlement, confirmation, review resolutions)
 * belong exclusively to the central payment domain, never to adapters.
 */

/** Provider-facing view of a payment attempt. Amount/currency are the
 * appointment snapshot values copied at attempt creation — adapters
 * must never receive browser-supplied money facts. */
export interface AttemptIdentity {
  publicId: string
  /** Stable per-attempt identity reused across retries of the SAME
   * attempt (Paystack reference / Stripe Idempotency-Key / PayPal
   * PayPal-Request-Id) so an ambiguous network failure never produces
   * a duplicate provider charge. */
  idempotencyKey: string
  amountMinor: number
  currency: string
  providerReference: string | null
  providerPaymentId: string | null
  providerCheckoutId: string | null
}

export interface InitializePaymentInput {
  attempt: AttemptIdentity
  appointmentPublicId: string
  userEmail: string
  /** Server-generated from APP_BASE_URL — never accepted from the
   * browser (open-redirect protection). */
  returnUrl: string
  cancelUrl: string
}

/** Crypto quote facts as returned by a processor. quotedAmount is a
 * DECIMAL STRING — floating point is never used for crypto amounts. */
export interface CryptoQuote {
  quotedAsset: string
  quotedAmount: string
  quotedNetwork: string
  /** UTC 'YYYY-MM-DD HH:MM:SS'. */
  quoteExpiresAt: string
}

export interface InitializePaymentResult {
  checkoutUrl: string | null
  providerReference: string
  providerPaymentId: string | null
  providerCheckoutId: string | null
  providerStatus: string | null
  cryptoQuote: CryptoQuote | null
}

/** Internal normalized outcome of provider-reported payment state. */
export type PaymentOutcome =
  'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'PENDING' | 'EXPIRED'

/**
 * One normalized shape for every provider's verified payment truth —
 * produced only after signature verification (webhooks) or an
 * authenticated provider API call (verify/capture). The central
 * settlement service consumes exactly this; adapters never decide what
 * a success MEANS for the appointment.
 */
export interface VerifiedPaymentResult {
  provider: PaymentProviderCode
  providerReference: string | null
  providerPaymentId: string | null
  providerCheckoutId: string | null
  /** Our attempt public id when the provider echoes it back via
   * metadata/custom_id — an additional locator, never an authority. */
  attemptPublicId: string | null
  outcome: PaymentOutcome
  amountMinor: number | null
  currency: string | null
  /** UTC 'YYYY-MM-DD HH:MM:SS' when the provider reported payment. */
  paidAtSql: string | null
  providerStatus: string | null
  failureCode: string | null
  failureMessage: string | null
}

export interface WebhookVerificationResult {
  /** True only when provider authentication (signature / verification
   * API) succeeded on the EXACT raw bytes received. */
  ok: boolean
  /** Safe machine reason when !ok (never echoes secrets/payloads). */
  reason?: string
  /** Stable dedupe identity — unique per (provider, event). */
  eventKey?: string
  providerEventId?: string | null
  eventType?: string
  /** False for authenticated events this platform does not process
   * (recorded as IGNORED). */
  relevant?: boolean
  verified?: VerifiedPaymentResult | null
}

/**
 * Thrown by adapters for provider-call failures. `retryable` encodes
 * the initialization-failure semantics (spec §19): an explicit provider
 * rejection is NOT retryable (the attempt may be FAILED); an ambiguous
 * network timeout IS retryable — the provider may have created the
 * transaction, so the SAME attempt/idempotency identity must be reused,
 * never a fresh charge.
 */
export class PaymentProviderError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'PaymentProviderError'
    this.code = code
    this.retryable = retryable
  }
}

export interface PaymentProvider {
  readonly code: PaymentProviderCode
  readonly displayName: string
  /** Checkout availability: switched on AND fully configured. */
  isEnabled: () => boolean
  /** Webhook verifiability: credentials present. Kept separate from
   * isEnabled() so money that arrives after an operator disables a
   * provider is still verified and recorded — evidence is never lost. */
  canVerifyWebhooks: () => boolean
  /** Operator-configured merchant-account allowlist — never a claim
   * about the provider's global capabilities. */
  supportsCurrency: (currency: string) => boolean
  initializePayment: (
    input: InitializePaymentInput,
  ) => Promise<InitializePaymentResult>
  verifyPayment: (attempt: AttemptIdentity) => Promise<VerifiedPaymentResult>
  parseAndVerifyWebhook: (
    rawBody: Uint8Array,
    headers: Record<string, string>,
    nowMs?: number,
  ) => Promise<WebhookVerificationResult>
  /** Providers with an explicit server-side capture step (PayPal). */
  capturePayment?: (attempt: AttemptIdentity) => Promise<VerifiedPaymentResult>
}

/** Injectable HTTP transport so automated tests NEVER reach live
 * provider networks. */
export type ProviderTransport = (
  url: string,
  init: RequestInit,
) => Promise<Response>
