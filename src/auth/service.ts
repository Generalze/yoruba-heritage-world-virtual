import { eq } from 'drizzle-orm'

import { getDb } from '@/db'
import { users } from '@/db/schema'
import { AUDIT_ACTIONS, recordAuditEvent } from './audit'
import { getDummyPasswordHash, hashPassword, verifyPassword } from './password'
import {
  clearLoginFailures,
  isLoginBlocked,
  recordFailedLogin,
} from './rate-limit'
import { DEFAULT_REGISTRATION_ROLE, assignRoleToUser } from './rbac'
import { createSession, revokeSessionByToken, toSafeUser } from './session'
import type { CreatedSession, SafeUser } from './session'
import type { LoginInput, RegisterInput } from './validation'

/**
 * Authentication orchestration (stage spec §11–§13).
 *
 * Pure service layer: receives already-validated input plus request
 * context (ip / user agent) and talks to password, session, RBAC and
 * audit modules. HTTP concerns (cookies, redirects) live in
 * src/auth/actions.ts.
 */

export interface RequestContext {
  ipAddress: string | null
  userAgent: string | null
}

export type AuthFailureCode =
  'EMAIL_IN_USE' | 'INVALID_CREDENTIALS' | 'RATE_LIMITED'

export type AuthResult =
  | { ok: true; user: SafeUser; session: CreatedSession }
  | { ok: false; error: AuthFailureCode }

function isDuplicateKeyError(error: unknown): boolean {
  // Drizzle wraps driver errors (DrizzleQueryError.cause holds the
  // mysql2 error), so walk the cause chain looking for ER_DUP_ENTRY.
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null; depth++) {
    if (typeof current !== 'object') break
    if ((current as { code?: unknown }).code === 'ER_DUP_ENTRY') return true
    current = (current as { cause?: unknown }).cause ?? null
  }
  return false
}

export async function registerUser(
  input: Omit<RegisterInput, 'passwordConfirmation'>,
  ctx: RequestContext,
): Promise<AuthResult> {
  const db = getDb()
  const passwordHash = await hashPassword(input.password)

  let userId: number
  try {
    // User creation and the mandatory USER role grant are one
    // transaction: registration can never leave an orphan account
    // without its role (e.g. if the seed is missing, everything rolls
    // back).
    userId = await db.transaction(async (tx) => {
      const result = await tx.insert(users).values({
        email: input.email,
        passwordHash,
        preferredName: input.preferredName,
      })
      const id = result[0].insertId
      // Public registration only ever grants the basic USER role.
      await assignRoleToUser(id, DEFAULT_REGISTRATION_ROLE, tx)
      return id
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Unique-email constraint is the source of truth; a concurrent or
      // repeated registration lands here safely.
      return { ok: false, error: 'EMAIL_IN_USE' }
    }
    throw error
  }

  await recordAuditEvent({
    actorUserId: userId,
    action: AUDIT_ACTIONS.userRegistered,
    entityType: 'user',
    entityId: String(userId),
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  const session = await createSession(userId)

  return { ok: true, user: toSafeUser(rows[0]), session }
}

export async function loginUser(
  input: LoginInput,
  ctx: RequestContext,
): Promise<AuthResult> {
  if (isLoginBlocked(input.email, ctx.ipAddress)) {
    return { ok: false, error: 'RATE_LIMITED' }
  }

  const db = getDb()
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.email, input.email))
    .limit(1)
  const user = rows.at(0)

  if (!user) {
    // Equalize timing so responses don't reveal whether an email exists;
    // deliberately no email stored in the audit trail for unknown accounts.
    await verifyPassword(input.password, await getDummyPasswordHash())
    recordFailedLogin(input.email, ctx.ipAddress)
    await recordAuditEvent({
      action: AUDIT_ACTIONS.loginFailed,
      metadata: { reason: 'unknown_account' },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
    return { ok: false, error: 'INVALID_CREDENTIALS' }
  }

  const passwordValid = await verifyPassword(input.password, user.passwordHash)
  if (!passwordValid) {
    recordFailedLogin(input.email, ctx.ipAddress)
    await recordAuditEvent({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.loginFailed,
      entityType: 'user',
      entityId: String(user.id),
      metadata: { reason: 'invalid_password' },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
    return { ok: false, error: 'INVALID_CREDENTIALS' }
  }

  if (user.accountStatus !== 'ACTIVE') {
    // Externally indistinguishable from bad credentials; the real
    // reason is preserved in the audit trail.
    await recordAuditEvent({
      actorUserId: user.id,
      action: AUDIT_ACTIONS.loginFailed,
      entityType: 'user',
      entityId: String(user.id),
      metadata: { reason: `account_${user.accountStatus.toLowerCase()}` },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
    return { ok: false, error: 'INVALID_CREDENTIALS' }
  }

  clearLoginFailures(input.email)
  await db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id))

  const session = await createSession(user.id)

  await recordAuditEvent({
    actorUserId: user.id,
    action: AUDIT_ACTIONS.loginSucceeded,
    entityType: 'user',
    entityId: String(user.id),
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })

  return {
    ok: true,
    user: toSafeUser({ ...user, lastLoginAt: new Date() }),
    session,
  }
}

/** Always succeeds, even for unknown or already-expired tokens. */
export async function logoutUser(
  token: string | undefined,
  ctx: RequestContext,
): Promise<void> {
  if (!token) return

  const userId = await revokeSessionByToken(token)
  await recordAuditEvent({
    actorUserId: userId,
    action: AUDIT_ACTIONS.loggedOut,
    entityType: userId === null ? undefined : 'user',
    entityId: userId === null ? undefined : String(userId),
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}
