import { describe, expect, it } from 'bun:test'
import { isCsrfRequestAllowed } from '@tanstack/react-start'

/**
 * Verifies the origin-validation behavior configured in src/start.ts:
 * TanStack Start's CSRF middleware with default options — same-origin
 * required, Referer fallback, default-deny when no origin signals exist.
 */

type CsrfCtx = Parameters<typeof isCsrfRequestAllowed>[1]

function ctxFor(headers: Record<string, string>): CsrfCtx {
  return {
    request: new Request('https://app.example.com/_serverFn/login', {
      method: 'POST',
      headers,
    }),
  } as CsrfCtx
}

describe('CSRF / origin protection (middleware configuration)', () => {
  it('allows same-origin requests (Sec-Fetch-Site)', async () => {
    expect(
      await isCsrfRequestAllowed(
        {},
        ctxFor({ 'sec-fetch-site': 'same-origin' }),
      ),
    ).toBe(true)
  })

  it('rejects cross-site requests (Sec-Fetch-Site)', async () => {
    expect(
      await isCsrfRequestAllowed(
        {},
        ctxFor({ 'sec-fetch-site': 'cross-site' }),
      ),
    ).toBe(false)
  })

  it('allows matching Origin headers and rejects foreign ones', async () => {
    expect(
      await isCsrfRequestAllowed(
        {},
        ctxFor({ origin: 'https://app.example.com' }),
      ),
    ).toBe(true)
    expect(
      await isCsrfRequestAllowed(
        {},
        ctxFor({ origin: 'https://evil.example' }),
      ),
    ).toBe(false)
  })

  it('accepts a same-origin Referer fallback but rejects foreign Referers', async () => {
    expect(
      await isCsrfRequestAllowed(
        {},
        ctxFor({ referer: 'https://app.example.com/login' }),
      ),
    ).toBe(true)
    expect(
      await isCsrfRequestAllowed(
        {},
        ctxFor({ referer: 'https://evil.example/attack' }),
      ),
    ).toBe(false)
  })

  it('default-denies state-changing requests with no origin signals', async () => {
    expect(await isCsrfRequestAllowed({}, ctxFor({}))).toBe(false)
  })
})
