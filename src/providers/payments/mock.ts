import { utcMsToSql } from '@/lib/schedule-time'
import {
  decodeRawBody,
  getHeader,
  hmacHex,
  parseJsonSafely,
  timingSafeEqualHex,
} from './http'
import type {
  AttemptIdentity,
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentOutcome,
  PaymentProvider,
  VerifiedPaymentResult,
  WebhookVerificationResult,
} from './types'

/**
 * MockPaymentProvider (spec §52): deterministic development/testing
 * provider so no real money or credentials are ever needed locally.
 *
 * HARD SAFETY RULE: the mock can NEVER run in production — isEnabled()
 * and canVerifyWebhooks() both require a non-production NODE_ENV, and
 * env validation independently refuses mock-crypto production configs.
 *
 * Simulated events flow through the SAME signed-webhook pipeline as
 * real providers (HMAC-SHA256 over raw bytes), so success/failure/
 * late-success/mismatch/duplicate/reordered fixtures exercise the real
 * verification, idempotency and settlement code — not a parallel path.
 */

export const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret-dev-only'

export interface MockProviderConfig {
  nodeEnv: string
  enabled: boolean
}

export interface MockEventFixture {
  id: string
  type:
    | 'payment.succeeded'
    | 'payment.failed'
    | 'payment.cancelled'
    | 'payment.pending'
    | 'payment.expired'
  reference: string
  amountMinor: number
  currency: string
  paidAtMs?: number
}

/** Builds a correctly signed mock webhook (raw bytes + headers). Tests
 * mutate the returned body to prove mutation breaks the signature. */
export function buildMockWebhook(fixture: MockEventFixture): {
  rawBody: Uint8Array
  headers: Record<string, string>
} {
  const rawBody = new TextEncoder().encode(JSON.stringify(fixture))
  return {
    rawBody,
    headers: {
      'x-mock-signature': hmacHex('sha256', MOCK_WEBHOOK_SECRET, rawBody),
    },
  }
}

const OUTCOME_BY_TYPE: Record<MockEventFixture['type'], PaymentOutcome> = {
  'payment.succeeded': 'SUCCEEDED',
  'payment.failed': 'FAILED',
  'payment.cancelled': 'CANCELLED',
  'payment.pending': 'PENDING',
  'payment.expired': 'EXPIRED',
}

export function createMockProvider(cfg: MockProviderConfig): PaymentProvider {
  const available = cfg.enabled && cfg.nodeEnv !== 'production'

  return {
    code: 'MOCK',
    displayName: 'Mock provider (development)',

    isEnabled() {
      return available
    },

    canVerifyWebhooks() {
      return available
    },

    supportsCurrency(currency: string) {
      return available && /^[A-Z]{3}$/i.test(currency)
    },

    async initializePayment(
      input: InitializePaymentInput,
    ): Promise<InitializePaymentResult> {
      // No hosted page: the checkout UI shows an inline simulator for
      // MOCK attempts in development.
      return {
        checkoutUrl: null,
        providerReference: input.attempt.idempotencyKey,
        providerPaymentId: null,
        providerCheckoutId: null,
        providerStatus: 'mock_ready',
        cryptoQuote: null,
      }
    },

    async verifyPayment(
      attempt: AttemptIdentity,
    ): Promise<VerifiedPaymentResult> {
      // The stateless mock has no provider-side memory; truth arrives
      // only through simulated signed events.
      return {
        provider: 'MOCK',
        providerReference: attempt.providerReference ?? attempt.idempotencyKey,
        providerPaymentId: null,
        providerCheckoutId: null,
        attemptPublicId: attempt.publicId,
        outcome: 'PENDING',
        amountMinor: null,
        currency: null,
        paidAtSql: null,
        providerStatus: 'mock_pending',
        failureCode: null,
        failureMessage: null,
      }
    },

    async parseAndVerifyWebhook(
      rawBody: Uint8Array,
      headers: Record<string, string>,
    ): Promise<WebhookVerificationResult> {
      if (!available) return { ok: false, reason: 'not_configured' }
      const signature = getHeader(headers, 'x-mock-signature')
      if (!signature) return { ok: false, reason: 'missing_signature' }
      const expected = hmacHex('sha256', MOCK_WEBHOOK_SECRET, rawBody)
      if (!timingSafeEqualHex(expected, signature.toLowerCase())) {
        return { ok: false, reason: 'invalid_signature' }
      }
      const event = parseJsonSafely(
        decodeRawBody(rawBody),
      ) as Partial<MockEventFixture> | null
      const outcome = event?.type
        ? (OUTCOME_BY_TYPE[event.type] as PaymentOutcome | undefined)
        : undefined
      if (!event?.id || !event.type || !event.reference || !outcome) {
        return { ok: false, reason: 'unparseable_payload' }
      }
      return {
        ok: true,
        eventKey: event.id,
        providerEventId: event.id,
        eventType: event.type,
        relevant: true,
        verified: {
          provider: 'MOCK',
          providerReference: event.reference,
          providerPaymentId: event.id,
          providerCheckoutId: null,
          attemptPublicId: null,
          outcome,
          amountMinor:
            typeof event.amountMinor === 'number' ? event.amountMinor : null,
          currency: event.currency ? event.currency.toUpperCase() : null,
          paidAtSql:
            outcome === 'SUCCEEDED' && event.paidAtMs != null
              ? utcMsToSql(event.paidAtMs)
              : null,
          providerStatus: event.type,
          failureCode: outcome === 'FAILED' ? 'mock_failed' : null,
          failureMessage: null,
        },
      }
    },
  }
}
