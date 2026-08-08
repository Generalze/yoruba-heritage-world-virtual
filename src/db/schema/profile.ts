import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { users } from './users'

/**
 * User personal profile, private spiritual profile and consent records
 * (Phase One, Step 4).
 *
 * Deliberately separate from the authentication `users` table: no
 * password/session/auth data lives here, and sensitive spiritual data
 * is never mixed into authentication rows. The user's preferred name
 * remains canonical on `users.preferred_name`.
 *
 * Privacy: spiritual-interest selections are PRIVATE user data — never
 * shown on public pages, never exposed through admin browsing, never
 * sent to external providers in this stage.
 */

/** 1:1 personal profile. Fields are nullable so users can complete
 * their profile progressively; completion is computed server-side from
 * the actual data (never a stored boolean). Date of birth is stored as
 * a calendar DATE — age is always calculated at evaluation time, never
 * persisted. */
export const userProfiles = mysqlTable('user_profiles', {
  userId: bigint('user_id', { mode: 'number', unsigned: true })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  fullName: varchar('full_name', { length: 200 }),
  phoneE164: varchar('phone_e164', { length: 20 }),
  countryCode: varchar('country_code', { length: 2 }),
  timezone: varchar('timezone', { length: 64 }),
  preferredLanguage: varchar('preferred_language', { length: 8 }),
  dateOfBirth: date('date_of_birth', { mode: 'string' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
})

/**
 * System-controlled spiritual-interest catalogue. Seed data only —
 * never AI-generated, never user-editable, expanded only by deliberate
 * product decision.
 */
export const spiritualInterests = mysqlTable(
  'spiritual_interests',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 100 }).notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('spiritual_interests_code_unique').on(table.code)],
)

/**
 * A user's selected interests: zero, one or many. Composite key
 * prevents duplicates. Interests never imply a deity, Sacred House,
 * service or doctrine. Deleting a user removes their selections
 * (cascade); the master catalogue is protected (restrict) — deactivate
 * instead of delete.
 */
export const userSpiritualInterests = mysqlTable(
  'user_spiritual_interests',
  {
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    spiritualInterestId: int('spiritual_interest_id', {
      unsigned: true,
    }).notNull(),
    selectedAt: timestamp('selected_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.spiritualInterestId] }),
    index('usi_interest_idx').on(table.spiritualInterestId),
    // Explicit short constraint names — MariaDB identifiers cap at 64
    // characters and the auto-generated names exceed that.
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'usi_user_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.spiritualInterestId],
      foreignColumns: [spiritualInterests.id],
      name: 'usi_interest_fk',
    }).onDelete('restrict'),
  ],
)

export const CONSENT_TYPES = [
  'TERMS',
  'PRIVACY',
  'SPIRITUAL_NOTICE',
  'MARKETING',
] as const
export type ConsentType = (typeof CONSENT_TYPES)[number]

/**
 * Versioned consent records (never a bare boolean). One row per
 * (user, type, version) with acceptance time; MARKETING rows may be
 * revoked and re-granted — required consents are never revocable
 * in-app at this stage.
 */
export const userConsents = mysqlTable(
  'user_consents',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    userId: bigint('user_id', { mode: 'number', unsigned: true })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    consentType: mysqlEnum('consent_type', CONSENT_TYPES).notNull(),
    version: varchar('version', { length: 20 }).notNull(),
    acceptedAt: timestamp('accepted_at').notNull().defaultNow(),
    revokedAt: timestamp('revoked_at'),
  },
  (table) => [
    uniqueIndex('user_consents_user_type_version_unique').on(
      table.userId,
      table.consentType,
      table.version,
    ),
    index('user_consents_user_idx').on(table.userId),
  ],
)
