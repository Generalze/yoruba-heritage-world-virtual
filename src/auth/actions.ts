import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader, getRequestIP } from '@tanstack/react-start/server'

import { env } from '@/lib/env'
import {
  clearSessionCookie,
  getSessionCookie,
  setSessionCookie,
} from './cookies'
import { getAuthenticatedUser } from './guards'
import { loginUser, logoutUser, registerUser } from './service'
import { loginInputSchema, registerInputSchema } from './validation'
import type { RequestContext } from './service'
import type { SafeUser } from './session'

/**
 * HTTP boundary for authentication (server functions).
 *
 * Session tokens travel ONLY via the HttpOnly cookie set here — they
 * are never part of any RPC response body. Failure responses carry
 * machine-readable codes; the generic INVALID_CREDENTIALS message never
 * reveals whether an email exists. CSRF/origin validation happens
 * before these handlers run (global middleware in src/start.ts).
 */

export interface AuthActionResult {
  ok: boolean
  error?: string
}

function requestContext(): RequestContext {
  // X-Forwarded-For is honored only behind an explicitly trusted proxy
  // (TRUST_PROXY=true); otherwise the socket address is authoritative
  // so clients cannot spoof their IP (rate limiting, audit logs).
  return {
    ipAddress: getRequestIP({ xForwardedFor: env.TRUST_PROXY }) ?? null,
    userAgent: getRequestHeader('user-agent') ?? null,
  }
}

export const registerFn = createServerFn({ method: 'POST' })
  .validator(registerInputSchema)
  .handler(async ({ data }): Promise<AuthActionResult> => {
    const result = await registerUser(
      {
        email: data.email,
        preferredName: data.preferredName,
        password: data.password,
      },
      requestContext(),
    )
    if (!result.ok) return { ok: false, error: result.error }

    setSessionCookie(result.session.token, result.session.expiresAt)
    return { ok: true }
  })

export const loginFn = createServerFn({ method: 'POST' })
  .validator(loginInputSchema)
  .handler(async ({ data }): Promise<AuthActionResult> => {
    const result = await loginUser(data, requestContext())
    if (!result.ok) return { ok: false, error: result.error }

    setSessionCookie(result.session.token, result.session.expiresAt)
    return { ok: true }
  })

export const logoutFn = createServerFn({ method: 'POST' }).handler(
  async (): Promise<AuthActionResult> => {
    await logoutUser(getSessionCookie(), requestContext())
    clearSessionCookie()
    return { ok: true }
  },
)

/** Used by route guards; returns null when unauthenticated. */
export const getCurrentUserFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<SafeUser | null> => getAuthenticatedUser(),
)
