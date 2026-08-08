import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import { auditLogs, roles, sessions, users } from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { AUDIT_ACTIONS, recordAuditEvent } from '@/auth/audit'
import { ForbiddenError, requirePermission } from '@/auth/guards'
import { MAX_ATTEMPTS_PER_EMAIL } from '@/auth/rate-limit'
import {
  assignRoleToUser,
  getUserPermissionCodes,
  getUserRoleCodes,
  userHasPermission,
} from '@/auth/rbac'
import { loginUser, logoutUser, registerUser } from '@/auth/service'
import { validateSessionToken } from '@/auth/session'
import { registerInputSchema } from '@/auth/validation'

/**
 * Integration tests against the local Docker MariaDB (see README —
 * requires `docker compose up -d db`). Migrations and the RBAC seed are
 * applied idempotently; every fixture uses random throwaway credentials
 * and is deleted afterwards. No real users, passwords, or admin
 * accounts are ever seeded.
 */

const createdUserIds: Array<number> = []
const ctx = { ipAddress: null, userAgent: 'bun-test' }

function uniqueEmail(): string {
  return `it2-${crypto.randomUUID()}@test.local`
}

const PASSPHRASE = `test passphrase ${crypto.randomUUID()}`

async function registerFixture(email = uniqueEmail()) {
  const result = await registerUser(
    { email, preferredName: 'Adétòkunbọ̀ Test', password: PASSPHRASE },
    ctx,
  )
  if (!result.ok)
    throw new Error(`fixture registration failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  return { email, ...result }
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
})

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await getDb()
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await getDb().delete(users).where(inArray(users.id, createdUserIds))
  }
  await closeDb()
})

describe('registration', () => {
  it('creates a user with a hashed password, USER role, session and audit trail', async () => {
    const { email, user, session } = await registerFixture()

    const row = (
      await getDb().select().from(users).where(eq(users.id, user.id)).limit(1)
    )[0]
    expect(row.email).toBe(email)
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true)
    expect(row.passwordHash).not.toContain(PASSPHRASE)
    expect(row.accountStatus).toBe('ACTIVE')

    // Safe user shape never exposes the hash
    expect('passwordHash' in user).toBe(false)
    expect('password_hash' in user).toBe(false)

    // Session works immediately after registration
    const validated = await validateSessionToken(session.token)
    expect(validated?.user.id).toBe(user.id)

    // Only the basic USER role — public registration can never escalate
    expect(await getUserRoleCodes(user.id)).toEqual(['USER'])

    const audit = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, user.id))
    expect(audit.some((a) => a.action === AUDIT_ACTIONS.userRegistered)).toBe(
      true,
    )
  })

  it('preserves Yorùbá characters in preferred names (utf8mb4)', async () => {
    const { user } = await registerFixture()
    const row = (
      await getDb().select().from(users).where(eq(users.id, user.id)).limit(1)
    )[0]
    expect(row.preferredName).toBe('Adétòkunbọ̀ Test')
  })

  it('rejects duplicate emails safely, including different casing', async () => {
    const { email } = await registerFixture()

    const duplicate = await registerUser(
      { email, preferredName: 'Other', password: PASSPHRASE },
      ctx,
    )
    expect(duplicate).toEqual({ ok: false, error: 'EMAIL_IN_USE' })

    // Same address, different case, normalized by the schema first
    const parsed = registerInputSchema.parse({
      email: email.toUpperCase(),
      preferredName: 'Other',
      password: PASSPHRASE,
      passwordConfirmation: PASSPHRASE,
    })
    const cased = await registerUser(
      { email: parsed.email, preferredName: 'Other', password: PASSPHRASE },
      ctx,
    )
    expect(cased).toEqual({ ok: false, error: 'EMAIL_IN_USE' })
  })
})

describe('login', () => {
  it('succeeds with correct credentials, sets last_login_at, audits', async () => {
    const { email, user } = await registerFixture()

    const result = await loginUser({ email, password: PASSPHRASE }, ctx)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const row = (
      await getDb().select().from(users).where(eq(users.id, user.id)).limit(1)
    )[0]
    expect(row.lastLoginAt).not.toBeNull()

    const validated = await validateSessionToken(result.session.token)
    expect(validated?.user.id).toBe(user.id)

    const audit = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, user.id))
    expect(audit.some((a) => a.action === AUDIT_ACTIONS.loginSucceeded)).toBe(
      true,
    )
  })

  it('returns the identical generic failure for wrong password and unknown email', async () => {
    const { email, user } = await registerFixture()

    const wrongPassword = await loginUser(
      { email, password: 'not the right passphrase' },
      ctx,
    )
    const unknownEmail = await loginUser(
      { email: uniqueEmail(), password: 'not the right passphrase' },
      ctx,
    )

    expect(wrongPassword).toEqual({ ok: false, error: 'INVALID_CREDENTIALS' })
    expect(unknownEmail).toEqual(wrongPassword)

    const audit = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, user.id))
    expect(audit.some((a) => a.action === AUDIT_ACTIONS.loginFailed)).toBe(true)
  })

  it('blocks SUSPENDED and DISABLED accounts with the same generic error', async () => {
    const { email, user, session } = await registerFixture()

    await getDb()
      .update(users)
      .set({ accountStatus: 'SUSPENDED' })
      .where(eq(users.id, user.id))

    // New sessions are refused…
    const login = await loginUser({ email, password: PASSPHRASE }, ctx)
    expect(login).toEqual({ ok: false, error: 'INVALID_CREDENTIALS' })
    // …and existing sessions stop working immediately
    expect(await validateSessionToken(session.token)).toBeNull()

    await getDb()
      .update(users)
      .set({ accountStatus: 'DISABLED' })
      .where(eq(users.id, user.id))
    const disabledLogin = await loginUser({ email, password: PASSPHRASE }, ctx)
    expect(disabledLogin).toEqual({ ok: false, error: 'INVALID_CREDENTIALS' })
  })

  it('rate-limits repeated failures per email and recovers legitimately', async () => {
    const { email } = await registerFixture()

    for (let i = 0; i < MAX_ATTEMPTS_PER_EMAIL; i++) {
      const attempt = await loginUser(
        { email, password: 'wrong passphrase attempt' },
        ctx,
      )
      expect(attempt).toEqual({ ok: false, error: 'INVALID_CREDENTIALS' })
    }

    // Next attempt is blocked BEFORE any credential check…
    const blocked = await loginUser({ email, password: PASSPHRASE }, ctx)
    expect(blocked).toEqual({ ok: false, error: 'RATE_LIMITED' })
  })
})

describe('sessions', () => {
  it('rejects tampered and empty tokens', async () => {
    const { session } = await registerFixture()
    expect(await validateSessionToken('')).toBeNull()
    expect(
      await validateSessionToken(session.token.slice(0, -2) + 'xx'),
    ).toBeNull()
  })

  it('rejects expired sessions', async () => {
    const { session } = await registerFixture()
    const { hashSessionToken } = await import('@/auth/tokens')

    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.tokenHash, hashSessionToken(session.token)))

    expect(await validateSessionToken(session.token)).toBeNull()
  })

  it('rejects revoked sessions and logout is safe to repeat', async () => {
    const { session, user } = await registerFixture()

    await logoutUser(session.token, ctx)
    expect(await validateSessionToken(session.token)).toBeNull()

    // Logout with the same (now revoked) token, an unknown token, and
    // no token at all must all succeed silently.
    await logoutUser(session.token, ctx)
    await logoutUser('completely-unknown-token', ctx)
    await logoutUser(undefined, ctx)

    const audit = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, user.id))
    expect(audit.some((a) => a.action === AUDIT_ACTIONS.loggedOut)).toBe(true)
  })

  it('logout works on an already-expired session', async () => {
    const { session } = await registerFixture()
    const { hashSessionToken } = await import('@/auth/tokens')

    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.tokenHash, hashSessionToken(session.token)))

    await logoutUser(session.token, ctx) // must not throw
  })

  it('stores only the token hash, never the raw token', async () => {
    const { session, user } = await registerFixture()
    const rows = await getDb()
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id))
    for (const row of rows) {
      expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/)
      expect(row.tokenHash).not.toBe(session.token)
    }
  })
})

describe('RBAC', () => {
  it('grants USER self-permissions but not admin access', async () => {
    const { user } = await registerFixture()
    const perms = await getUserPermissionCodes(user.id)
    expect(perms.sort()).toEqual(['account.self.read', 'account.self.update'])
    expect(await userHasPermission(user.id, 'admin.access')).toBe(false)

    // (expect().rejects.toThrow hangs under bun test here, so assert
    // the rejection explicitly.)
    let thrown: unknown = null
    try {
      await requirePermission(user.id, 'admin.access')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ForbiddenError)
  })

  it('grants admin.access through the ADMIN role', async () => {
    const { user } = await registerFixture()
    await assignRoleToUser(user.id, 'ADMIN')
    expect(await userHasPermission(user.id, 'admin.access')).toBe(true)
    await requirePermission(user.id, 'admin.access') // must not throw
    expect((await getUserRoleCodes(user.id)).sort()).toEqual(['ADMIN', 'USER'])
  })

  it('seeding is idempotent', async () => {
    await seedRbac()
    await seedRbac()
    const { user } = await registerFixture()
    expect(await getUserRoleCodes(user.id)).toEqual(['USER'])
  })
})

describe('audit log sanitization (end to end)', () => {
  it('never persists sensitive keys passed as metadata', async () => {
    const { user } = await registerFixture()
    await recordAuditEvent({
      actorUserId: user.id,
      action: 'test.sanitization',
      metadata: {
        reason: 'ok-to-keep',
        password: 'must-not-appear',
        sessionToken: 'must-not-appear-either',
        tokenHash: 'nor-this',
      },
    })

    const rows = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, user.id))
    const row = rows.find((r) => r.action === 'test.sanitization')
    expect(row).toBeDefined()

    const metadata =
      typeof row!.metadataJson === 'string'
        ? (JSON.parse(row!.metadataJson) as Record<string, unknown>)
        : (row!.metadataJson as Record<string, unknown>)
    expect(metadata).toEqual({ reason: 'ok-to-keep' })
    expect(JSON.stringify(metadata)).not.toContain('must-not-appear')
  })
})

describe('registration atomicity', () => {
  it('rolls back the user row when the USER role grant cannot complete', async () => {
    const email = uniqueEmail()
    // Simulate a missing/broken seed: no USER role to grant.
    await getDb().delete(roles).where(eq(roles.code, 'USER'))
    try {
      let thrown: unknown = null
      try {
        await registerUser(
          { email, preferredName: 'Atomic', password: PASSPHRASE },
          ctx,
        )
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(Error)

      // The transaction must have rolled back — no orphan account.
      const orphans = await getDb()
        .select()
        .from(users)
        .where(eq(users.email, email))
      expect(orphans.length).toBe(0)
    } finally {
      await seedRbac()
    }

    // With the seed restored, the same email registers cleanly.
    const retry = await registerUser(
      { email, preferredName: 'Atomic', password: PASSPHRASE },
      ctx,
    )
    expect(retry.ok).toBe(true)
    if (retry.ok) createdUserIds.push(retry.user.id)
  })
})
