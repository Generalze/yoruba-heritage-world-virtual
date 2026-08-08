import { eq } from 'drizzle-orm'

import { closeDb, getDb } from '@/db'
import { users } from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { ROLE_CODES, assignRoleToUser } from '@/auth/rbac'
import type { RoleCode } from '@/auth/rbac'

/**
 * Local operator CLI: grant a role to an EXISTING registered user.
 *
 *   bun run admin:grant <email> <ROLE_CODE>
 *
 * This is how the first administrator / cultural reviewer is
 * bootstrapped in a fresh environment. It creates no users, stores no
 * passwords, and only works for accounts that already registered
 * through the application. The grant is audited.
 */
export async function grantRoleByEmail(
  email: string,
  roleCode: RoleCode,
): Promise<{ userId: number }> {
  const normalized = email.trim().toLowerCase()
  const user = (
    await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1)
  ).at(0)
  if (!user) {
    throw new Error(`No registered user found for ${normalized}`)
  }

  await assignRoleToUser(user.id, roleCode)
  await recordAuditEvent({
    actorUserId: null,
    action: 'user.role_granted',
    entityType: 'user',
    entityId: String(user.id),
    metadata: { role: roleCode, grantedVia: 'cli' },
  })
  return { userId: user.id }
}

if (import.meta.main) {
  const [email, roleInput] = process.argv.slice(2) as Array<string | undefined>
  const role = roleInput?.toUpperCase()
  if (
    !email ||
    !role ||
    !(ROLE_CODES as ReadonlyArray<string>).includes(role)
  ) {
    console.error(
      `Usage: bun run admin:grant <email> <${ROLE_CODES.join('|')}>`,
    )
    process.exit(1)
  }
  const { userId } = await grantRoleByEmail(email, role as RoleCode)
  console.log(`Granted ${role} to user ${userId} (${email.toLowerCase()})`)
  await closeDb()
}
