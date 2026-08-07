import { and, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import { permissions, rolePermissions, roles, userRoles } from '@/db/schema'

/**
 * RBAC foundation (stage spec §15–§17).
 *
 * Role and permission codes are stable machine-readable identifiers.
 * These names were checked against TECHNICAL_CANON.md, which mandates
 * role-based administration but names no roles — no conflict.
 *
 * Public registration assigns only USER (hardcoded in the registration
 * service; role input is never accepted from clients). Elevated roles
 * can only be granted by later-stage admin tooling / operators.
 */

export const ROLE_CODES = [
  'USER',
  'CONTENT_MANAGER',
  'ADMIN',
  'SUPER_ADMIN',
] as const
export type RoleCode = (typeof ROLE_CODES)[number]

export const PERMISSION_CODES = [
  'account.self.read',
  'account.self.update',
  'admin.access',
] as const
export type PermissionCode = (typeof PERMISSION_CODES)[number]

export const ROLE_DEFINITIONS: Record<
  RoleCode,
  { name: string; description: string }
> = {
  USER: {
    name: 'User',
    description: 'Standard registered user',
  },
  CONTENT_MANAGER: {
    name: 'Content Manager',
    description:
      'Reviews and manages cultural/spiritual content (later stages)',
  },
  ADMIN: {
    name: 'Administrator',
    description: 'Platform administration',
  },
  SUPER_ADMIN: {
    name: 'Super Administrator',
    description: 'Full platform control, including role management',
  },
}

export const PERMISSION_DEFINITIONS: Record<
  PermissionCode,
  { name: string; description: string }
> = {
  'account.self.read': {
    name: 'Read own account',
    description: 'View own profile and account information',
  },
  'account.self.update': {
    name: 'Update own account',
    description: 'Change own profile and account information',
  },
  'admin.access': {
    name: 'Administrative access',
    description: 'Access administrative areas and tooling',
  },
}

export const ROLE_PERMISSION_MAP: Record<RoleCode, Array<PermissionCode>> = {
  USER: ['account.self.read', 'account.self.update'],
  CONTENT_MANAGER: ['account.self.read', 'account.self.update'],
  ADMIN: ['account.self.read', 'account.self.update', 'admin.access'],
  SUPER_ADMIN: ['account.self.read', 'account.self.update', 'admin.access'],
}

/** The only role public registration may ever assign. */
export const DEFAULT_REGISTRATION_ROLE: RoleCode = 'USER'

export async function assignRoleToUser(
  userId: number,
  roleCode: RoleCode,
): Promise<void> {
  const db = getDb()
  const roleRows = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, roleCode))
    .limit(1)
  const role = roleRows.at(0)
  if (!role) {
    throw new Error(`Role ${roleCode} is not seeded — run bun run db:seed`)
  }
  await db
    .insert(userRoles)
    .values({ userId, roleId: role.id })
    .onDuplicateKeyUpdate({ set: { roleId: role.id } })
}

export async function getUserRoleCodes(userId: number): Promise<Array<string>> {
  const rows = await getDb()
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId))
  return rows.map((row) => row.code)
}

export async function getUserPermissionCodes(
  userId: number,
): Promise<Array<string>> {
  const rows = await getDb()
    .selectDistinct({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(userRoles.userId, userId))
  return rows.map((row) => row.code)
}

export async function userHasPermission(
  userId: number,
  permissionCode: PermissionCode,
): Promise<boolean> {
  const rows = await getDb()
    .select({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(
      and(eq(userRoles.userId, userId), eq(permissions.code, permissionCode)),
    )
    .limit(1)
  return rows.length > 0
}
