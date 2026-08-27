import {
  bigint,
  boolean,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { users } from './users'

/**
 * Notifications (Phase One, canon §42 item 23).
 *
 * Canon fixes two things and leaves the rest open: notification jobs
 * and appointment reminders run on a MariaDB-backed job table with no
 * Redis (§3.1), and a notifications table exists (§25). The operating
 * rules below were authorised explicitly and are recorded in
 * TECHNICAL_CANON.md §48.
 *
 * WHAT A NOTIFICATION MAY SAY. Nothing sacred, and nothing internal. A
 * notification carries only the same safe snapshots the appointment and
 * Prayer Room pages already show their owner — service name, Sacred
 * House name, scheduled time. Never spiritual or prayer text, never a
 * hash, provider code, object key, job id or pipeline error, and never
 * the private request note.
 *
 * FK constraint names are short — MariaDB caps identifiers at 64.
 */

/** The three categories authorised for Phase One. */
export const NOTIFICATION_CATEGORIES = [
  'APPOINTMENT',
  'PRAYER_ROOM',
  'PAYMENT',
] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/** Specific events. Each belongs to exactly one category. */
export const NOTIFICATION_TYPES = [
  'APPOINTMENT_CONFIRMED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_RESCHEDULED',
  'APPOINTMENT_EXPIRED',
  'PRAYER_ROOM_READY',
  'PAYMENT_SUCCEEDED',
  'PAYMENT_UNDER_REVIEW',
] as const
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

/**
 * One thing that happened, worth telling one member about.
 *
 * This row is the RECORD of the event and is written whatever the
 * member's preferences say. Preferences decide which channels may
 * carry it, not whether it happened — so muting a category can never
 * quietly erase the history of a payment or a cancellation.
 */
export const notifications = mysqlTable(
  'notifications',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    category: mysqlEnum('category', NOTIFICATION_CATEGORIES).notNull(),
    type: mysqlEnum('type', NOTIFICATION_TYPES).notNull(),
    /** Safe snapshots only — see the file docblock. */
    title: varchar('title', { length: 200 }).notNull(),
    body: varchar('body', { length: 500 }).notNull(),
    /** Where the member should be taken. A public id, never an internal one. */
    linkPublicId: varchar('link_public_id', { length: 36 }),
    readAt: timestamp('read_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ntf_public_id_unique').on(table.publicId),
    index('ntf_user_created_idx').on(table.userId, table.createdAt),
    index('ntf_user_read_idx').on(table.userId, table.readAt),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'ntf_user_fk',
    }).onDelete('cascade'),
  ],
)

export const NOTIFICATION_CHANNELS = ['IN_APP', 'EMAIL'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export const DELIVERY_STATUSES = [
  'PENDING',
  'SENT',
  'FAILED',
  'SUPPRESSED',
] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

/**
 * One channel's attempt to carry one notification.
 *
 * This IS canon §3.1's notification job table: a PENDING row is a
 * queued job, and the worker claims and completes it here. No Redis,
 * no second queue.
 *
 * A channel the member has muted is recorded SUPPRESSED rather than
 * silently omitted, so "we chose not to send this" stays visible and
 * auditable instead of looking like a delivery that never happened.
 */
export const notificationDeliveries = mysqlTable(
  'notification_deliveries',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    notificationId: bigint('notification_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    channel: mysqlEnum('channel', NOTIFICATION_CHANNELS).notNull(),
    status: mysqlEnum('status', DELIVERY_STATUSES).notNull().default('PENDING'),
    attempts: bigint('attempts', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    /** An operator-facing reason. Never the notification's own content. */
    lastError: varchar('last_error', { length: 300 }),
    sentAt: timestamp('sent_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    // One attempt row per channel per notification: re-running the
    // dispatcher can never fan out duplicate sends.
    uniqueIndex('nd_ntf_channel_unique').on(
      table.notificationId,
      table.channel,
    ),
    // The queue read: claim PENDING work oldest-first.
    index('nd_status_idx').on(table.status, table.createdAt),
    foreignKey({
      columns: [table.notificationId],
      foreignColumns: [notifications.id],
      name: 'nd_ntf_fk',
    }).onDelete('cascade'),
  ],
)

/**
 * Per-member, per-category channel preferences.
 *
 * Absence of a row means "not muted": a member who has never touched
 * preferences receives everything, and no migration has to backfill a
 * row per member per category to make that true.
 *
 * Preferences are consulted when the notification is RAISED, not when
 * it is rendered, so a muted channel never becomes queued work.
 */
export const notificationPreferences = mysqlTable(
  'notification_preferences',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    category: mysqlEnum('category', NOTIFICATION_CATEGORIES).notNull(),
    inAppEnabled: boolean('in_app_enabled').notNull().default(true),
    emailEnabled: boolean('email_enabled').notNull().default(true),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('np_user_category_unique').on(table.userId, table.category),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'np_user_fk',
    }).onDelete('cascade'),
  ],
)
