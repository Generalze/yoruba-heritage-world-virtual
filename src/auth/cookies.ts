import {
  deleteCookie,
  getCookie,
  setCookie,
} from '@tanstack/react-start/server'

import { env } from '@/lib/env'

/**
 * Centralized session cookie configuration (stage spec §8).
 *
 * - HttpOnly: token is never readable by JavaScript
 * - SameSite=Lax: one layer of CSRF defense (origin middleware is the
 *   other — see src/start.ts)
 * - Secure in production (local HTTP development only exception)
 * - Path=/ with expiry matching the server-side session
 *
 * Authentication state lives only in this cookie — never in
 * localStorage or sessionStorage.
 */
export const SESSION_COOKIE_NAME = 'yhwv_session'

const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  path: '/',
} as const

export function setSessionCookie(token: string, expiresAt: Date): void {
  setCookie(SESSION_COOKIE_NAME, token, {
    ...BASE_COOKIE_OPTIONS,
    expires: expiresAt,
  })
}

export function getSessionCookie(): string | undefined {
  return getCookie(SESSION_COOKIE_NAME)
}

export function clearSessionCookie(): void {
  deleteCookie(SESSION_COOKIE_NAME, BASE_COOKIE_OPTIONS)
}
