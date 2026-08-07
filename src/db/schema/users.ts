import {
  bigint,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

/**
 * Approved account states (stage spec §21). Registration creates ACTIVE
 * users; SUSPENDED and DISABLED users cannot create or keep sessions.
 */
export const ACCOUNT_STATUSES = ['ACTIVE', 'SUSPENDED', 'DISABLED'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

/**
 * Identity table. Timestamp convention (applies to every table in this
 * schema): TIMESTAMP columns stored in UTC with second precision;
 * `created_at` set on insert, `updated_at` maintained by the database.
 *
 * - email is stored normalized (trimmed, lower-cased) and unique
 * - password_hash holds only the Argon2id hash string, never plaintext
 * - preferred_name supports full Unicode/Yorùbá text (utf8mb4 database)
 */
export const users = mysqlTable(
  'users',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    email: varchar('email', { length: 255 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    preferredName: varchar('preferred_name', { length: 100 }).notNull(),
    accountStatus: mysqlEnum('account_status', ACCOUNT_STATUSES)
      .notNull()
      .default('ACTIVE'),
    emailVerifiedAt: timestamp('email_verified_at'),
    lastLoginAt: timestamp('last_login_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [uniqueIndex('users_email_unique').on(table.email)],
)
