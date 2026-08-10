import { describe, expect, it } from 'bun:test'

import {
  contentSecurityPolicy,
  securityHeaders,
  withSecurityHeaders,
} from '@/lib/security-headers'
import { readinessResponseSchema } from '@/types/health'

/**
 * ============================================================================
 * HTTP SECURITY POSTURE — Phase One, Step 20.
 *
 * Headers are cheap to add and easy to add WRONG: an HSTS header sent
 * over plain HTTP pins a development machine to HTTPS for two years; a
 * blanket header pass that overwrites what a handler chose deliberately
 * silently undoes an authorization decision. Both are asserted here.
 * ============================================================================
 */

const PRODUCTION = { isProduction: true, isHttps: true }
const DEVELOPMENT = { isProduction: false, isHttps: false }

describe('security headers', () => {
  it('sends HSTS only in production over HTTPS', () => {
    // TEETH: a browser told this REMEMBERS it. Sending it from a
    // plain-HTTP development box costs somebody an afternoon.
    expect(securityHeaders(PRODUCTION)['Strict-Transport-Security']).toContain(
      'max-age=63072000',
    )
    expect(
      securityHeaders(DEVELOPMENT)['Strict-Transport-Security'],
    ).toBeUndefined()
    expect(
      securityHeaders({ isProduction: true, isHttps: false })[
        'Strict-Transport-Security'
      ],
    ).toBeUndefined()
  })

  it('sets the baseline headers in every environment', () => {
    for (const options of [PRODUCTION, DEVELOPMENT]) {
      const headers = securityHeaders(options)
      expect(headers['X-Content-Type-Options']).toBe('nosniff')
      expect(headers['X-Frame-Options']).toBe('DENY')
      expect(headers['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
      expect(headers['Permissions-Policy']).toContain('camera=()')
      expect(headers['Permissions-Policy']).toContain('microphone=()')
      expect(headers['Permissions-Policy']).toContain('geolocation=()')
      expect(headers['Permissions-Policy']).toContain('payment=()')
    }
  })

  it('writes a CSP that closes the classic escape hatches', () => {
    const policy = contentSecurityPolicy(PRODUCTION)
    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("frame-ancestors 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("base-uri 'self'")
    expect(policy).toContain("form-action 'self'")
    // A recorded prayer plays only from this origin — never from a
    // public bucket or a CDN.
    expect(policy).toContain("media-src 'self'")
    expect(policy).toContain('upgrade-insecure-requests')
    expect(contentSecurityPolicy(DEVELOPMENT)).not.toContain(
      'upgrade-insecure-requests',
    )
    // No third-party origin is fetchable at all: this platform has no
    // CDN, no analytics and no external fonts.
    expect(policy).not.toContain('https://')
    expect(policy).not.toContain('*')
  })

  it('never overwrites a header a handler set deliberately', () => {
    // TEETH: the Prayer Room's private media chooses its own caching
    // and framing headers as PART of an authorization decision. A
    // blanket pass that clobbered them would silently undo it.
    const handlerResponse = new Response('bytes', {
      status: 206,
      headers: {
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'X-Content-Type-Options': 'nosniff',
        'Content-Range': 'bytes 0-9/100',
      },
    })
    const wrapped = withSecurityHeaders(handlerResponse, PRODUCTION)
    expect(wrapped.status).toBe(206)
    expect(wrapped.headers.get('cache-control')).toBe('private, no-store')
    expect(wrapped.headers.get('vary')).toBe('Cookie')
    expect(wrapped.headers.get('content-range')).toBe('bytes 0-9/100')
    // …while still adding the ones it did not set.
    expect(wrapped.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    )
  })

  it('preserves the body and status of what it wraps', async () => {
    const wrapped = withSecurityHeaders(
      new Response('hello', { status: 404, statusText: 'Not Found' }),
      DEVELOPMENT,
    )
    expect(wrapped.status).toBe(404)
    expect(await wrapped.text()).toBe('hello')
  })
})

describe('the server entry', () => {
  it('applies the headers to static files and app responses alike', async () => {
    const server = await Bun.file('server.ts').text()
    // Both branches, or the one that forgot is the one an attacker
    // finds.
    expect(server.split('withSecurityHeaders(').length - 1).toBeGreaterThanOrEqual(3)
  })

  it('never shows a production client a stack trace', async () => {
    const server = await Bun.file('server.ts').text()
    expect(server).toContain('Internal Server Error')
    // The stack goes to the log; the response body is a bare string.
    expect(server).toContain('console.error')
    expect(server).not.toContain('JSON.stringify(error)')
    expect(server).not.toContain('body: error')
  })

  it('drains in-flight requests on SIGTERM', async () => {
    const server = await Bun.file('server.ts').text()
    expect(server).toContain('SIGTERM')
    expect(server).toContain('server.stop(false)')
  })
})

describe('session cookies', () => {
  it('stay HttpOnly and SameSite, and become Secure in production', async () => {
    const cookies = await Bun.file('src/auth/cookies.ts').text()
    expect(cookies).toContain('httpOnly: true')
    expect(cookies).toContain("sameSite: 'lax'")
    expect(cookies).toContain("secure: env.NODE_ENV === 'production'")
  })

  it('need no signing secret — and none was invented', async () => {
    // Sessions are 256-bit random bearer tokens stored hashed, so there
    // is nothing to leak or rotate. Step 20 deliberately did NOT add a
    // SESSION_SECRET that would have to be managed for no benefit.
    const env = await Bun.file('src/lib/env.ts').text()
    expect(env).not.toContain('SESSION_SECRET')
    const example = await Bun.file('.env.example').text()
    expect(example).not.toContain('SESSION_SECRET=')
  })
})

describe('proxy trust and webhook bodies', () => {
  it('keeps TRUST_PROXY explicit rather than trusting X-Forwarded-For', async () => {
    const env = await Bun.file('src/lib/env.ts').text()
    expect(env).toContain('TRUST_PROXY')
    const context = await Bun.file('src/server/request-context.ts').text()
    // The header is consulted ONLY behind the flag.
    expect(context).toContain('TRUST_PROXY')
  })

  it('still verifies payment webhooks over RAW BYTES', async () => {
    // A proxy that re-serializes JSON breaks every signature, and a
    // handler that parsed first would never notice.
    const payments = await Bun.file('src/services/payments.ts').text()
    expect(payments).toContain('rawBody: Uint8Array')
    expect(payments).toContain('parseAndVerifyWebhook')
    const start = await Bun.file('src/start.ts').text()
    // Webhook paths are exempt from CSRF by EXACT path, never a
    // wildcard — provider requests carry no browser origin signals.
    expect(start).toContain('WEBHOOK_EXEMPT_PATHS')
    expect(start).not.toContain('startsWith(\'/api/webhooks')
  })
})

describe('health output', () => {
  it('is a CLOSED schema, so a future field cannot leak by accident', () => {
    expect(() =>
      readinessResponseSchema.parse({
        status: 'ready',
        service: 'yoruba-heritage-world-virtual',
        timestamp: new Date().toISOString(),
        uptimeSeconds: 1,
        checks: { configuration: 'ok', database: 'connected' },
        issues: [],
        unavailable: [],
        // The kind of well-meant addition that ships a secret.
        objectStorageEndpoint: 'https://s3.example',
      }),
    ).toThrow()
  })

  it('carries issue CODES but never environment variable names', async () => {
    // Codes are not secrets; a list of the variables a deployment is
    // missing is a map of its configuration, and there is no reason to
    // publish one to anyone who can request a URL.
    const health = await Bun.file('src/server/health.ts').text()
    expect(health).toContain('issue.code')
    expect(health).not.toContain('issue.envName')
  })
})
