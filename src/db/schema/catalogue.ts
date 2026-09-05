import {
  bigint,
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { SACRED_VOICE_PROFILES } from '@/lib/sacred-voice-routing'
import { users } from './users'

/**
 * Spiritual-domain catalogue (Phase One, Step 3; canon §25 domains:
 * deities, sacred_houses, sacred_house_members, services).
 *
 * Locked domain rule (canon §1): Deity Profile → Sacred House →
 * Service → Appointment (later). Appointments are booked with SACRED
 * HOUSES; individual members never have public booking.
 *
 * The database is the source of truth: seeded records are development
 * data, not a hard-coded catalogue. Future authorized administrators
 * create/edit/publish/archive records through admin tooling without
 * source-code changes.
 *
 * Publication model (canon §30): rows carry a status plus an `active`
 * flag. Public queries show only PUBLISHED + active rows. New records
 * default to DRAFT; publication requires the cultural/spiritual
 * approval process (later stage). Archive/deactivate instead of
 * destructive deletion.
 *
 * Display names preserve approved Yorùbá spelling exactly (utf8mb4);
 * machine codes and URL slugs are stable ASCII identifiers and never
 * replace the visible names.
 */

export const CATALOGUE_STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
  'PUBLISHED',
  'ARCHIVED',
] as const
export type CatalogueStatus = (typeof CATALOGUE_STATUSES)[number]

export const deities = mysqlTable(
  'deities',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 150 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    // Nullable on purpose: descriptions require cultural/spiritual
    // approval and must never be auto-filled.
    shortDescription: varchar('short_description', { length: 1000 }),
    profileStatus: mysqlEnum('profile_status', CATALOGUE_STATUSES)
      .notNull()
      .default('DRAFT'),
    // Approval trail (canon §30): who approved the current content and
    // when. Cleared whenever content changes after approval. Kept as
    // SET NULL so the trail's row survives account deletion (full
    // history also lands in audit_logs).
    approvedBy: bigint('approved_by', {
      mode: 'number',
      unsigned: true,
    }).references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at'),
    // Reviewer's reason when a submission is returned to DRAFT;
    // cleared on the next submission.
    reviewNote: varchar('review_note', { length: 500 }),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('deities_code_unique').on(table.code),
    uniqueIndex('deities_slug_unique').on(table.slug),
    index('deities_status_idx').on(table.profileStatus, table.active),
  ],
)

export const sacredHouses = mysqlTable(
  'sacred_houses',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 150 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    shortDescription: varchar('short_description', { length: 1000 }),
    /**
     * The approved production voice for machine-spoken sacred text
     * belonging to this House. NULL means no voice has been approved,
     * and NULL fails closed — a House without a ruled voice is never
     * spoken by a machine, it is not given a default one.
     *
     * The four launch Houses are additionally pinned in source
     * (`SACRED_HOUSE_VOICE_PROFILE`); for those, a value here that
     * disagrees with the ruling stops synthesis rather than overriding
     * it. See src/lib/sacred-voice-routing.ts.
     */
    approvedVoiceProfile: mysqlEnum(
      'approved_voice_profile',
      SACRED_VOICE_PROFILES,
    ),
    status: mysqlEnum('status', CATALOGUE_STATUSES).notNull().default('DRAFT'),
    approvedBy: bigint('approved_by', {
      mode: 'number',
      unsigned: true,
    }).references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at'),
    reviewNote: varchar('review_note', { length: 500 }),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('sacred_houses_code_unique').on(table.code),
    uniqueIndex('sacred_houses_slug_unique').on(table.slug),
    index('sacred_houses_status_idx').on(table.status, table.active),
  ],
)

/**
 * Informational coverage areas of a Sacred House. Deliberately distinct
 * from services: focus areas are NOT billable and never become
 * bookable by themselves.
 */
export const sacredHouseFocusAreas = mysqlTable(
  'sacred_house_focus_areas',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    sacredHouseId: int('sacred_house_id', { unsigned: true })
      .notNull()
      .references(() => sacredHouses.id, { onDelete: 'cascade' }),
    label: varchar('label', { length: 200 }).notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('focus_areas_house_label_unique').on(
      table.sacredHouseId,
      table.label,
    ),
  ],
)

export const MEMBER_TYPES = [
  'PRAYER_WARRIOR',
  'PRIEST',
  'BABALAWO',
  'REPRESENTATIVE',
] as const
export type MemberType = (typeof MEMBER_TYPES)[number]

/**
 * Approved public member list of a Sacred House. These records are
 * NEVER connected to authentication users, hold no contact details,
 * and have no booking capability — appointments belong to the House.
 */
export const sacredHouseMembers = mysqlTable(
  'sacred_house_members',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    sacredHouseId: int('sacred_house_id', { unsigned: true })
      .notNull()
      .references(() => sacredHouses.id, { onDelete: 'cascade' }),
    displayName: varchar('display_name', { length: 150 }).notNull(),
    memberType: mysqlEnum('member_type', MEMBER_TYPES).notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('members_house_name_unique').on(
      table.sacredHouseId,
      table.displayName,
    ),
  ],
)

/**
 * Bookable service catalogue of a Sacred House. Price/duration are
 * nullable until an authorised catalogue is approved — never invented.
 * onDelete: restrict — a Sacred House with services (and, later,
 * appointment history hanging off services) must be archived or
 * deactivated, not casually deleted.
 */
export const services = mysqlTable(
  'services',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    sacredHouseId: int('sacred_house_id', { unsigned: true })
      .notNull()
      .references(() => sacredHouses.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 50 }).notNull(),
    name: varchar('name', { length: 150 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    shortDescription: varchar('short_description', { length: 1000 }),
    serviceStatus: mysqlEnum('service_status', CATALOGUE_STATUSES)
      .notNull()
      .default('DRAFT'),
    approvedBy: bigint('approved_by', {
      mode: 'number',
      unsigned: true,
    }).references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at'),
    reviewNote: varchar('review_note', { length: 500 }),
    durationMinutes: int('duration_minutes', { unsigned: true }),
    priceMinor: int('price_minor', { unsigned: true }),
    currency: varchar('currency', { length: 3 }),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('services_code_unique').on(table.code),
    uniqueIndex('services_slug_unique').on(table.slug),
    index('services_house_idx').on(table.sacredHouseId),
    index('services_status_idx').on(table.serviceStatus, table.active),
  ],
)

export const deitySacredHouses = mysqlTable(
  'deity_sacred_houses',
  {
    deityId: int('deity_id', { unsigned: true })
      .notNull()
      .references(() => deities.id, { onDelete: 'cascade' }),
    sacredHouseId: int('sacred_house_id', { unsigned: true })
      .notNull()
      .references(() => sacredHouses.id, { onDelete: 'cascade' }),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deityId, table.sacredHouseId] }),
    index('deity_houses_house_idx').on(table.sacredHouseId),
  ],
)

/**
 * Deity ↔ service relationships. Modeled now; seeded only when the
 * approved specification establishes an unambiguous link (currently
 * none — deliberately empty).
 */
export const deityServices = mysqlTable(
  'deity_services',
  {
    deityId: int('deity_id', { unsigned: true })
      .notNull()
      .references(() => deities.id, { onDelete: 'cascade' }),
    serviceId: int('service_id', { unsigned: true })
      .notNull()
      .references(() => services.id, { onDelete: 'cascade' }),
    sortOrder: int('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deityId, table.serviceId] }),
    index('deity_services_service_idx').on(table.serviceId),
  ],
)
