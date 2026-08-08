import { redirect } from '@tanstack/react-router'

import { getSessionCookie } from './cookies'
import { validateSessionToken } from './session'
import { getUserRoleCodes, userHasPermission } from './rbac'
import type { PermissionCode, RoleCode } from './rbac'
import type { SafeUser } from './session'

/**
 * Server-side authorization helpers (stage spec §10, §17).
 *
 * All checks run on the server; hiding UI is never the safeguard.
 * Invalid, expired, or revoked cookies simply mean "unauthenticated".
 */

export class ForbiddenError extends Error {
  constructor() {
    // Deliberately generic — reveals nothing about why access failed.
    super('Forbidden')
    this.name = 'ForbiddenError'
  }
}

/** Resolves the current request's user, or null. Never throws. */
export async function getAuthenticatedUser(): Promise<SafeUser | null> {
  const token = getSessionCookie()
  if (!token) return null
  const validated = await validateSessionToken(token)
  return validated?.user ?? null
}

/** For server-side code that requires a signed-in user. */
export async function requireUser(): Promise<SafeUser> {
  const user = await getAuthenticatedUser()
  if (!user) throw redirect({ to: '/login' })
  return user
}

export async function requireRole(
  userId: number,
  roleCode: RoleCode,
): Promise<void> {
  const codes = await getUserRoleCodes(userId)
  if (!codes.includes(roleCode)) throw new ForbiddenError()
}

export async function requirePermission(
  userId: number,
  permissionCode: PermissionCode,
): Promise<void> {
  if (!(await userHasPermission(userId, permissionCode))) {
    throw new ForbiddenError()
  }
}
