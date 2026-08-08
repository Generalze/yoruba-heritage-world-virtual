import { createCsrfMiddleware, createStart } from '@tanstack/react-start'

/**
 * CSRF / request-origin protection (stage spec §19). Layered approach:
 *
 * 1. The session cookie is SameSite=Lax + HttpOnly (src/auth/cookies.ts),
 *    so browsers already withhold it from cross-site POSTs.
 * 2. This global request middleware independently validates every
 *    state-changing request using TanStack Start's built-in CSRF
 *    middleware: Sec-Fetch-Site must be same-origin, or the Origin
 *    (with Referer fallback) must match the request origin. Requests
 *    with no origin signals at all are rejected (default-deny), and
 *    failures receive 403 before any handler runs.
 *
 * Safe methods (GET/HEAD/OPTIONS) are not filtered so the public pages
 * and /api/health remain reachable by non-browser clients. No external
 * or paid security service is involved.
 */
const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Provider webhook routes are server-to-server: payment providers
 * cannot send browser CSRF/origin signals, so ONLY these exact paths
 * are exempted (no wildcard trust). Each route independently requires
 * provider signature/authentication before any processing — an
 * unauthenticated request to these paths does nothing. Every normal
 * user/admin POST route remains fully CSRF-protected.
 */
const WEBHOOK_EXEMPT_PATHS = new Set([
  '/api/webhooks/paystack',
  '/api/webhooks/stripe',
  '/api/webhooks/paypal',
  '/api/webhooks/crypto',
])

const csrfProtection = createCsrfMiddleware({
  filter: ({ request }) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return false
    return !WEBHOOK_EXEMPT_PATHS.has(new URL(request.url).pathname)
  },
})

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfProtection],
}))
