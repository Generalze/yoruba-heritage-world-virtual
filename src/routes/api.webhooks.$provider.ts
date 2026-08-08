import { createFileRoute } from '@tanstack/react-router'

import { processProviderWebhook, readBodyWithLimit } from '@/services/payments'
import type { PaymentProviderCode } from '@/db/schema'

/**
 * Provider webhook endpoints (spec §27/§28):
 *
 *   POST /api/webhooks/paystack
 *   POST /api/webhooks/stripe
 *   POST /api/webhooks/paypal
 *   POST /api/webhooks/crypto
 *
 * These four exact paths are exempt from browser CSRF (src/start.ts) —
 * provider signature verification replaces it, performed on the EXACT
 * raw request bytes before any parsing (Paystack HMAC-SHA512, Stripe
 * t/v1 HMAC-SHA256, PayPal verification API, crypto processor HMAC).
 * The MOCK provider has NO public webhook route: simulated events run
 * through dev-only authenticated actions.
 *
 * Responses follow provider retry semantics: 2xx acknowledges handled/
 * duplicate/ignored events; 4xx rejects unverifiable requests; 5xx asks
 * the provider to retry after a transient processing failure.
 */

const WEBHOOK_PROVIDERS: Partial<Record<string, PaymentProviderCode>> = {
  paystack: 'PAYSTACK',
  stripe: 'STRIPE',
  paypal: 'PAYPAL',
  crypto: 'CRYPTO',
}

export const Route = createFileRoute('/api/webhooks/$provider')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const providerCode = WEBHOOK_PROVIDERS[params.provider]
        if (!providerCode) {
          return new Response('unknown provider', { status: 404 })
        }
        // Raw bytes, captured BEFORE any JSON parsing — signatures are
        // computed over exactly what arrived on the wire. The size cap
        // is enforced WHILE streaming (Content-Length is only a hint —
        // chunked bodies have none and headers can lie).
        const rawBody = await readBodyWithLimit(request)
        if (rawBody === null) {
          return new Response('payload too large', { status: 413 })
        }
        const headers: Record<string, string> = {}
        request.headers.forEach((value, key) => {
          headers[key] = value
        })
        const result = await processProviderWebhook(
          providerCode,
          rawBody,
          headers,
        )
        return new Response(result.body, { status: result.httpStatus })
      },
    },
  },
})
