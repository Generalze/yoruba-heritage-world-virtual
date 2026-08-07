import {
  bigint,
  index,
  json,
  mysqlTable,
  timestamp,
  varchar,
} from 'drizzle-orm/mysql-core'

import { users } from './users'

/**
 * Audit log foundation (stage spec §18, canon §31).
 *
 * Stores only operationally justified data. Passwords, session tokens,
 * token hashes, and secrets must never appear here — metadata is
 * sanitized by src/auth/audit.ts before insert. actor_user_id is
 * preserved as NULL (not cascaded away) when a user is deleted so the
 * audit trail survives account removal.
 */
export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    actorUserId: bigint('actor_user_id', {
      mode: 'number',
      unsigned: true,
    }).references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 100 }).notNull(),
    entityType: varchar('entity_type', { length: 50 }),
    entityId: varchar('entity_id', { length: 64 }),
    metadataJson: json('metadata_json'),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('audit_logs_actor_idx').on(table.actorUserId),
    index('audit_logs_action_idx').on(table.action),
    index('audit_logs_created_at_idx').on(table.createdAt),
  ],
)
