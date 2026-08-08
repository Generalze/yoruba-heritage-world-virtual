import { and, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import { permissions, rolePermissions, roles, userRoles } from '@/db/schema'
import type { DbClient } from '@/db'

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
  'deities.view',
  'deities.manage',
  'sacred_houses.view',
  'sacred_houses.manage',
  'services.view',
  'services.manage',
  'catalogue.approve',
  'catalogue.publish',
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
    description: 'Authors catalogue content and submits it for review',
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
  'deities.view': {
    name: 'View deity profiles (admin)',
    description: 'View deity profiles in any status, including drafts',
  },
  'deities.manage': {
    name: 'Manage deity profiles',
    description: 'Create, edit, review, publish, unpublish, archive deities',
  },
  'sacred_houses.view': {
    name: 'View Sacred Houses (admin)',
    description: 'View Sacred Houses in any status, including drafts',
  },
  'sacred_houses.manage': {
    name: 'Manage Sacred Houses',
    description:
      'Create, edit, publish, archive Sacred Houses, members and focus areas',
  },
  'services.view': {
    name: 'View services (admin)',
    description: 'View service catalogue in any status, including drafts',
  },
  'services.manage': {
    name: 'Manage services',
    description: 'Create, edit and submit services for review',
  },
  'catalogue.approve': {
    name: 'Approve catalogue content',
    description:
      'Cultural/spiritual approval authority: approve or return submitted catalogue records',
  },
  'catalogue.publish': {
    name: 'Publish catalogue content',
    description:
      'Technical publication: publish APPROVED records, unpublish and archive operationally',
  },
}

const CATALOGUE_VIEW: Array<PermissionCode> = [
  'deities.view',
  'sacred_houses.view',
  'services.view',
]

const CATALOGUE_MANAGE: Array<PermissionCode> = [
  'deities.manage',
  'sacred_houses.manage',
  'services.manage',
]

/**
 * Locked catalogue access model (Step 3.5): two day-to-day staff types.
 *
 * CONTENT_MANAGER authors: creates records, edits DRAFTs, submits for
 * review — never approves or publishes (holds neither catalogue.approve
 * nor catalogue.publish).
 *
 * ADMIN is the final catalogue approval authority: reviews, returns
 * with a reason, approves, publishes, unpublishes, archives.
 * SUPER_ADMIN (platform owner / technical safety role) inherits the
 * same catalogue capabilities.
 *
 * Entity *.manage never implies approval or publication — those require
 * catalogue.approve / catalogue.publish explicitly, and the status
 * machine independently refuses to publish anything not APPROVED (no
 * bypass role exists).
 */
export const ROLE_PERMISSION_MAP: Record<RoleCode, Array<PermissionCode>> = {
  USER: ['account.self.read', 'account.self.update'],
  CONTENT_MANAGER: [
    'account.self.read',
    'account.self.update',
    ...CATALOGUE_VIEW,
    ...CATALOGUE_MANAGE,
  ],
  ADMIN: [
    'account.self.read',
    'account.self.update',
    'admin.access',
    ...CATALOGUE_VIEW,
    ...CATALOGUE_MANAGE,
    'catalogue.approve',
    'catalogue.publish',
  ],
  SUPER_ADMIN: [
    'account.self.read',
    'account.self.update',
    'admin.access',
    ...CATALOGUE_VIEW,
    ...CATALOGUE_MANAGE,
    'catalogue.approve',
    'catalogue.publish',
  ],
}

/** The only role public registration may ever assign. */
export const DEFAULT_REGISTRATION_ROLE: RoleCode = 'USER'

export async function assignRoleToUser(
  userId: number,
  roleCode: RoleCode,
  // Pass a transaction client to make the assignment atomic with
  // surrounding writes (registration does this).
  db: DbClient = getDb(),
): Promise<void> {
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
