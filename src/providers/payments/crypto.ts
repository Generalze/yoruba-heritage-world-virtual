import { utcMsToSql } from '@/lib/schedule-time'
import {
  decodeRawBody,
  getHeader,
  hmacHex,
  parseJsonSafely,
  timingSafeEqualHex,
} from './http'
import { minorToDecimalString } from './money'
import type {
  AttemptIdentity,
  InitializePaymentInput,
  InitializePaymentResult,
  PaymentProvider,
  VerifiedPaymentResult,
  WebhookVerificationResult,
} from './types'

/**
 * Crypto payment provider contract (spec §24/§25).
 *
 * NO CONCRETE PROCESSOR IS SELECTED. Do not invent one. The contract is
 * PaymentProvider-compatible and carries processor-returned invoice/
 * reference, hosted checkout URL, fiat amount/currency, quoted asset,
 * quoted amount as a DECIMAL STRING (never floating point), network,
 * quote expiry, payment status and provider event identity. The
 * interface prefers stablecoin capability (USDC/USDT) but claims
 * nothing until an approved processor/network confirms it.
 *
 * Security invariants: the platform never requests or stores wallet
 * seed phrases, private keys or recovery phrases; there is no
 * application-managed hot-wallet custody; screenshots/manual hashes/
 * chat confirmations are never proof of payment — truth comes only from
 * the configured processor's authenticated API or signed webhook.
 *
 * Only MockCryptoPaymentProvider exists today. Production
 * CRYPTO_ENABLED=true fails safe: env validation rejects the mock in
 * production and rejects any not-implemented processor name, and this
 * factory independently returns an unavailable provider for both.
 */

export interface CryptoProviderConfig {
  nodeEnv: string
  enabled: boolean
  /** Processor selector — only 'mock' is implemented. */
  providerName: string
  webhookSecret: string
  fiatCurrencies: Array<string>
  now?: () => number
}

interface CryptoEventFixture {
  id: string
  type: 'invoice.paid' | 'invoice.expired' | 'invoice.pending'
  reference: string
  fiatAmountMinor: number
  fiatCurrency: string
  asset?: string
  amount?: string
  network?: string
  paidAtMs?: number
}

export const MOCK_CRYPTO_WEBHOOK_SECRET = 'mock-crypto-webhook-secret-dev-only'

/** Builds a correctly signed mock crypto webhook for tests/dev. */
export function buildMockCryptoWebhook(
  fixture: CryptoEventFixture,
  secret: string = MOCK_CRYPTO_WEBHOOK_SECRET,
): { rawBody: Uint8Array; headers: Record<string, string> } {
  const rawBody = new TextEncoder().encode(JSON.stringify(fixture))
  return {
    rawBody,
    headers: {
      'x-crypto-signature': hmacHex('sha256', secret, rawBody),
    },
  }
}

const MOCK_QUOTE_VALIDITY_MS = 15 * 60_000

export function createCryptoProvider(
  cfg: CryptoProviderConfig,
): PaymentProvider {
  // FAIL SAFE: available only as the mock, and never in production.
  const available =
    cfg.enabled && cfg.providerName === 'mock' && cfg.nodeEnv !== 'production'
  const now = cfg.now ?? (() => Date.now())
  const secret = cfg.webhookSecret || MOCK_CRYPTO_WEBHOOK_SECRET
  const currencies = new Set(cfg.fiatCurrencies.map((c) => c.toUpperCase()))

  return {
    code: 'CRYPTO',
    displayName: 'Crypto (stablecoin)',

    isEnabled() {
      return available
    },

    canVerifyWebhooks() {
      return available
    },

    supportsCurrency(currency: string) {
      return currencies.has(currency.toUpperCase())
    },

    async initializePayment(
      input: InitializePaymentInput,
    ): Promise<InitializePaymentResult> {
      // Mock quote: 1 stablecoin unit per fiat unit, six decimal places,
      // integer math only. A real processor would return its own quote.
      const fiatDecimal = minorToDecimalString(
        input.attempt.amountMinor,
        input.attempt.currency,
      )
      const [units, fraction = ''] = fiatDecimal.split('.')
      const quotedAmount = `${units}.${fraction.padEnd(6, '0')}`
      return {
        checkoutUrl: null,
        providerReference: input.attempt.idempotencyKey,
        providerPaymentId: null,
        providerCheckoutId: `mock-invoice-${input.attempt.publicId}`,
        providerStatus: 'quote_issued',
        cryptoQuote: {
          quotedAsset: 'USDC',
          quotedAmount,
          quotedNetwork: 'MOCK-TESTNET',
          quoteExpiresAt: utcMsToSql(now() + MOCK_QUOTE_VALIDITY_MS),
        },
      }
    },

    async verifyPayment(
      attempt: AttemptIdentity,
    ): Promise<VerifiedPaymentResult> {
      return {
        provider: 'CRYPTO',
        providerReference: attempt.providerReference ?? attempt.idempotencyKey,
        providerPaymentId: null,
        providerCheckoutId: attempt.providerCheckoutId,
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
      const signature = getHeader(headers, 'x-crypto-signature')
      if (!signature) return { ok: false, reason: 'missing_signature' }
      const expected = hmacHex('sha256', secret, rawBody)
      if (!timingSafeEqualHex(expected, signature.toLowerCase())) {
        return { ok: false, reason: 'invalid_signature' }
      }
      const event = parseJsonSafely(
        decodeRawBody(rawBody),
      ) as Partial<CryptoEventFixture> | null
      if (!event?.id || !event.type || !event.reference) {
        return { ok: false, reason: 'unparseable_payload' }
      }
      const outcome =
        event.type === 'invoice.paid'
          ? 'SUCCEEDED'
          : event.type === 'invoice.expired'
            ? 'EXPIRED'
            : 'PENDING'
      return {
        ok: true,
        eventKey: event.id,
        providerEventId: event.id,
        eventType: event.type,
        relevant: true,
        verified: {
          provider: 'CRYPTO',
          providerReference: event.reference,
          providerPaymentId: event.id,
          providerCheckoutId: null,
          attemptPublicId: null,
          outcome,
          amountMinor:
            typeof event.fiatAmountMinor === 'number'
              ? event.fiatAmountMinor
              : null,
          currency: event.fiatCurrency
            ? event.fiatCurrency.toUpperCase()
            : null,
          paidAtSql:
            outcome === 'SUCCEEDED' && event.paidAtMs != null
              ? utcMsToSql(event.paidAtMs)
              : null,
          providerStatus: event.type,
          failureCode: null,
          failureMessage: null,
        },
      }
    },
  }
}
