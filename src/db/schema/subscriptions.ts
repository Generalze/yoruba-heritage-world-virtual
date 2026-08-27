import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { spiritualContentVersions } from './guidance'
import { users } from './users'

/**
 * Daily spiritual subscriptions (Phase One, canon §42 item 22).
 *
 * Canon §2 fixes the shape of this system: subscriptions are a
 * DISTINCT system from appointment bookings, and every piece of
 * spiritual content a subscriber receives must already be entered,
 * reviewed, versioned and APPROVED through the existing workflow. This
 * engine therefore stores no spiritual text of its own — it only
 * schedules and records references to published content versions.
 *
 * Authorised Phase One rules (recorded in TECHNICAL_CANON.md §47):
 *  - delivery is APPROVED TEXT/AUDIO only — no generated video, so no
 *    paid provider call sits on a subscriber-day;
 *  - purchase is a PREPAID FIXED TERM, never a recurring mandate;
 *  - each day's item is an ADMIN-SCHEDULED SEQUENCE per plan, so two
 *    subscribers on the same plan receive the same item on the same
 *    date, and no AI chooses spiritual content.
 *
 * Payment linkage is deliberately absent at this step: payment_attempts
 * is bound to appointments today, and making it polymorphic is its own
 * verified change. Activation goes through an explicit service call,
 * which is the seam that step will use.
 *
 * FK constraint names are short — MariaDB caps identifiers at 64.
 */

/**
 * A sellable prepaid offer. This is OPERATIONAL COMMERCIAL CONFIG, not
 * cultural content: it carries no spiritual text and so has no review
 * or approval workflow — ADMIN/SUPER_ADMIN manage it, exactly as they
 * manage Sacred House booking settings.
 *
 * `active` defaults FALSE so a migration or seed can never silently
 * put a plan on sale, and price is NULLABLE so a plan can exist before
 * anyone has decided what it costs. A plan with no price is never
 * sellable — the service layer refuses it rather than inventing a
 * figure.
 */
export const subscriptionPlans = mysqlTable(
  'subscription_plans',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    code: varchar('code', { length: 60 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    description: text('description'),
    /** Fixed prepaid term length. There is no renewal mandate. */
    termDays: int('term_days', { unsigned: true }).notNull(),
    /** NULL until an administrator sets a real price. Never seeded. */
    priceMinor: int('price_minor', { unsigned: true }),
    currency: varchar('currency', { length: 3 }),
    active: boolean('active').notNull().default(false),
    createdBy: bigint('created_by', { mode: 'number', unsigned: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('sp_public_id_unique').on(table.publicId),
    uniqueIndex('sp_code_unique').on(table.code),
    index('sp_active_idx').on(table.active),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [users.id],
      name: 'sp_created_by_fk',
    }).onDelete('set null'),
  ],
)

export const SUBSCRIPTION_STATUSES = [
  'PENDING_PAYMENT',
  'ACTIVE',
  'EXPIRED',
  'CANCELLED',
] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

/**
 * One subscriber's prepaid term.
 *
 * The plan's commercial terms are SNAPSHOTTED here at purchase time,
 * exactly as an appointment snapshots its service: later edits to the
 * plan must never rewrite what somebody already bought. The subscriber
 * timezone is snapshotted too, because "today" for delivery is a
 * calendar date in the subscriber's own timezone, not the server's.
 */
export const subscriptions = mysqlTable(
  'subscriptions',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    planId: int('plan_id', { unsigned: true }).notNull(),
    planNameSnapshot: varchar('plan_name_snapshot', { length: 200 }).notNull(),
    termDaysSnapshot: int('term_days_snapshot', { unsigned: true }).notNull(),
    priceMinorSnapshot: int('price_minor_snapshot', { unsigned: true }),
    currencySnapshot: varchar('currency_snapshot', { length: 3 }),
    userTimezoneSnapshot: varchar('user_timezone_snapshot', {
      length: 64,
    }).notNull(),
    status: mysqlEnum('status', SUBSCRIPTION_STATUSES)
      .notNull()
      .default('PENDING_PAYMENT'),
    /** Inclusive first and last delivery dates, in the snapshot timezone. */
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    activatedAt: timestamp('activated_at'),
    cancelledAt: timestamp('cancelled_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('sub_public_id_unique').on(table.publicId),
    index('sub_user_status_idx').on(table.userId, table.status),
    index('sub_window_idx').on(table.startDate, table.endDate),
    index('sub_plan_idx').on(table.planId),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'sub_user_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.planId],
      foreignColumns: [subscriptionPlans.id],
      name: 'sub_plan_fk',
    }).onDelete('restrict'),
  ],
)

/**
 * The admin-scheduled sequence: one approved content version per plan
 * per calendar date. Every subscriber on that plan receives that item
 * on that date, so the schedule is fully deterministic and reviewable
 * ahead of time — no AI selects spiritual content.
 *
 * The composite foreign key guarantees the version row genuinely
 * belongs to the item row, the same integrity pattern the appointment
 * guidance assignments use. That the version is PUBLISHED is enforced
 * at the service layer, where the status machine lives.
 */
export const subscriptionContent = mysqlTable(
  'subscription_content',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    planId: int('plan_id', { unsigned: true }).notNull(),
    scheduledDate: date('scheduled_date', { mode: 'string' }).notNull(),
    contentItemId: int('content_item_id', { unsigned: true }).notNull(),
    contentVersionId: bigint('content_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    scheduledBy: bigint('scheduled_by', { mode: 'number', unsigned: true }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    // One item per plan per day: the sequence is unambiguous.
    uniqueIndex('subc_plan_date_unique').on(table.planId, table.scheduledDate),
    index('subc_version_idx').on(table.contentVersionId),
    foreignKey({
      columns: [table.planId],
      foreignColumns: [subscriptionPlans.id],
      name: 'subc_plan_fk',
    }).onDelete('cascade'),
    // Composite integrity: the version must belong to the item.
    foreignKey({
      columns: [table.contentVersionId, table.contentItemId],
      foreignColumns: [
        spiritualContentVersions.id,
        spiritualContentVersions.contentItemId,
      ],
      name: 'subc_ver_item_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.scheduledBy],
      foreignColumns: [users.id],
      name: 'subc_by_fk',
    }).onDelete('set null'),
  ],
)

/**
 * What a subscriber was actually served, and when.
 *
 * This is the audit trail, not a cache: it records the exact content
 * version delivered on a given date, so a later edit to the schedule
 * can never rewrite history. At most one row per subscription per
 * date, enforced by the unique index rather than by hope.
 */
export const subscriptionHistory = mysqlTable(
  'subscription_history',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    subscriptionId: bigint('subscription_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    deliveredDate: date('delivered_date', { mode: 'string' }).notNull(),
    contentItemId: int('content_item_id', { unsigned: true }).notNull(),
    contentVersionId: bigint('content_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    deliveredAt: timestamp('delivered_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('subh_sub_date_unique').on(
      table.subscriptionId,
      table.deliveredDate,
    ),
    index('subh_version_idx').on(table.contentVersionId),
    foreignKey({
      columns: [table.subscriptionId],
      foreignColumns: [subscriptions.id],
      name: 'subh_sub_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.contentVersionId, table.contentItemId],
      foreignColumns: [
        spiritualContentVersions.id,
        spiritualContentVersions.contentItemId,
      ],
      name: 'subh_ver_item_fk',
    }).onDelete('restrict'),
  ],
)
