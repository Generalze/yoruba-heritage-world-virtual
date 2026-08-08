import { and, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import { sessions, users } from '@/db/schema'
import { generateSessionToken, hashSessionToken } from './tokens'
import type { AccountStatus } from '@/db/schema'

/**
 * Server-side session service (stage spec §7, §9, §10).
 *
 * Lifetime rules live here so they can change in one place. Fixed
 * 30-day maximum lifetime; no sliding renewal or remember-me yet.
 */
export const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
/** lastSeenAt writes are throttled to avoid a DB write on every request. */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000

/** User shape safe for clients and loaders — never includes password_hash. */
export interface SafeUser {
  id: number
  email: string
  preferredName: string
  accountStatus: AccountStatus
  emailVerifiedAt: Date | null
  lastLoginAt: Date | null
  createdAt: Date
}

export function toSafeUser(user: typeof users.$inferSelect): SafeUser {
  return {
    id: user.id,
    email: user.email,
    preferredName: user.preferredName,
    accountStatus: user.accountStatus,
    emailVerifiedAt: user.emailVerifiedAt,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  }
}

export interface CreatedSession {
  token: string
  expiresAt: Date
}

export async function createSession(userId: number): Promise<CreatedSession> {
  const token = generateSessionToken()
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS)

  await getDb()
    .insert(sessions)
    .values({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
    })

  return { token, expiresAt }
}

export interface ValidatedSession {
  user: SafeUser
  session: {
    id: number
    createdAt: Date
    lastSeenAt: Date
    expiresAt: Date
  }
}

/**
 * Resolves a raw cookie token to a user. Returns null (unauthenticated)
 * for unknown, expired, or revoked sessions and for users whose account
 * is no longer ACTIVE — suspension takes effect immediately, not at
 * next login.
 */
export async function validateSessionToken(
  token: string,
): Promise<ValidatedSession | null> {
  if (!token || token.length > 128) return null

  const tokenHash = hashSessionToken(token)
  const db = getDb()

  const rows = await db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.tokenHash, tokenHash))
    .limit(1)

  const row = rows.at(0)
  if (!row) return null

  const now = new Date()
  if (row.session.revokedAt !== null) return null
  if (row.session.expiresAt.getTime() <= now.getTime()) return null
  if (row.user.accountStatus !== 'ACTIVE') return null

  if (
    now.getTime() - row.session.lastSeenAt.getTime() >
    SESSION_TOUCH_INTERVAL_MS
  ) {
    await db
      .update(sessions)
      .set({ lastSeenAt: now })
      .where(eq(sessions.id, row.session.id))
  }

  return {
    user: toSafeUser(row.user),
    session: {
      id: row.session.id,
      createdAt: row.session.createdAt,
      lastSeenAt: row.session.lastSeenAt,
      expiresAt: row.session.expiresAt,
    },
  }
}

/**
 * Revokes the session belonging to a raw token. Safe to call with an
 * expired or unknown token — logout must always succeed. Returns the
 * user id of the revoked session when one was found.
 */
export async function revokeSessionByToken(
  token: string,
): Promise<number | null> {
  const tokenHash = hashSessionToken(token)
  const db = getDb()

  const rows = await db
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash)))
    .limit(1)

  const row = rows.at(0)
  if (!row) return null

  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(eq(sessions.id, row.id))

  return row.userId
}
