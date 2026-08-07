import { getDb } from '@/db'
import { auditLogs } from '@/db/schema'

/**
 * Audit logging service (stage spec §18).
 *
 * Records security-relevant events with only operationally justified
 * data. Metadata is sanitized before insert so passwords, tokens,
 * hashes, and secrets can never land in the audit trail even if a
 * caller passes them by mistake. Audit failures are logged and
 * swallowed — an audit write must never break an auth flow.
 */

export const AUDIT_ACTIONS = {
  userRegistered: 'user.registered',
  loginSucceeded: 'user.login_succeeded',
  loginFailed: 'user.login_failed',
  loggedOut: 'user.logged_out',
} as const

const SENSITIVE_KEY_PATTERN =
  /password|token|secret|hash|credential|authorization|cookie|apikey|api_key/i

const MAX_METADATA_DEPTH = 4

export function sanitizeAuditMetadata(
  metadata: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> | null {
  if (!metadata) return null
  if (depth >= MAX_METADATA_DEPTH) return null

  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue
    if (value === null || value === undefined) {
      clean[key] = value
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = sanitizeAuditMetadata(
        value as Record<string, unknown>,
        depth + 1,
      )
      if (nested !== null) clean[key] = nested
    } else if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      clean[key] = typeof value === 'string' ? value.slice(0, 500) : value
    }
    // Arrays, functions, symbols, etc. are dropped — audit metadata
    // should be small flat facts, not payload dumps.
  }
  return clean
}

export interface AuditEvent {
  actorUserId?: number | null
  action: string
  entityType?: string
  entityId?: string
  metadata?: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
}

export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await getDb()
      .insert(auditLogs)
      .values({
        actorUserId: event.actorUserId ?? null,
        action: event.action.slice(0, 100),
        entityType: event.entityType?.slice(0, 50) ?? null,
        entityId: event.entityId?.slice(0, 64) ?? null,
        metadataJson: sanitizeAuditMetadata(event.metadata),
        ipAddress: event.ipAddress?.slice(0, 45) ?? null,
        userAgent: event.userAgent?.slice(0, 255) ?? null,
      })
  } catch (error) {
    // Never let audit failures break authentication; never log event
    // metadata here either — it may be the thing that failed to insert.
    console.error(`audit: failed to record ${event.action}`, error)
  }
}
