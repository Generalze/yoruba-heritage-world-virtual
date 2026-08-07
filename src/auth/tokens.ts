import { createHash, randomBytes } from 'node:crypto'

/**
 * Session token primitives (stage spec §7).
 *
 * A session token is 32 bytes (256 bits) from the platform CSPRNG,
 * base64url-encoded. The database stores only SHA-256(token) as
 * lowercase hex; the raw token exists solely in the HttpOnly cookie.
 *
 * Plain SHA-256 (no server secret / HMAC) is deliberate: the token
 * itself carries 256 bits of entropy and cannot be guessed, so hashing
 * here only needs to make a leaked sessions table useless for cookie
 * forgery. This is why no SESSION_SECRET environment variable exists.
 */

export const SESSION_TOKEN_BYTES = 32

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
