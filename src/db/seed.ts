import { eq } from 'drizzle-orm'

import { getDb, getPool } from '@/db'
import { permissions, rolePermissions, roles } from '@/db/schema'
import {
  PERMISSION_CODES,
  PERMISSION_DEFINITIONS,
  ROLE_CODES,
  ROLE_DEFINITIONS,
  ROLE_PERMISSION_MAP,
} from '@/auth/rbac'

/**
 * Idempotent development seed (stage spec §24): roles, permissions and
 * role→permission grants only. Safe to run repeatedly — existing rows
 * are updated in place, never duplicated.
 *
 * Deliberately seeds NO users, NO passwords, NO admin accounts and no
 * personal data of any kind. Test users exist only inside isolated
 * test fixtures with random credentials.
 *
 * Run with: bun run db:seed
 */
export async function seedRbac(): Promise<void> {
  const db = getDb()

  for (const code of ROLE_CODES) {
    const def = ROLE_DEFINITIONS[code]
    await db
      .insert(roles)
      .values({ code, name: def.name, description: def.description })
      .onDuplicateKeyUpdate({
        set: { name: def.name, description: def.description },
      })
  }

  for (const code of PERMISSION_CODES) {
    const def = PERMISSION_DEFINITIONS[code]
    await db
      .insert(permissions)
      .values({ code, name: def.name, description: def.description })
      .onDuplicateKeyUpdate({
        set: { name: def.name, description: def.description },
      })
  }

  for (const roleCode of ROLE_CODES) {
    const roleRow = (
      await db
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, roleCode))
        .limit(1)
    )[0]
    for (const permissionCode of ROLE_PERMISSION_MAP[roleCode]) {
      const permissionRow = (
        await db
          .select({ id: permissions.id })
          .from(permissions)
          .where(eq(permissions.code, permissionCode))
          .limit(1)
      )[0]
      await db
        .insert(rolePermissions)
        .values({ roleId: roleRow.id, permissionId: permissionRow.id })
        .onDuplicateKeyUpdate({ set: { roleId: roleRow.id } })
    }
  }
}

if (import.meta.main) {
  await seedRbac()
  console.log(
    `Seeded ${ROLE_CODES.length} roles and ${PERMISSION_CODES.length} permissions (idempotent).`,
  )
  await getPool().end()
}
