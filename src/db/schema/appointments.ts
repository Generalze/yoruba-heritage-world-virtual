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
  time,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { sacredHouseMembers, sacredHouses, services } from './catalogue'
import { users } from './users'

/**
 * Appointment scheduling & reservation foundation (Phase One, Step 5;
 * canon §25 appointment domains).
 *
 * Locked model: the scheduling resource is the SACRED HOUSE (capacity:
 * one concurrent appointment). Individual members are never bookable
 * and have no calendars. The House is always derived server-side from
 * the selected service. Appointment instants are stored as UTC
 * DATETIME strings written by application code (never driver/VPS
 * timezone dependent); the user and House timezones are snapshotted at
 * reservation time.
 *
 * All FK constraint names are explicit and short — MariaDB caps
 * identifiers at 64 characters.
 */

/**
 * One-to-one operational booking configuration per Sacred House. This
 * row doubles as the House's scheduling LOCK RESOURCE: every code path
 * that allocates a House time interval first takes SELECT … FOR UPDATE
 * on this row. booking_enabled defaults FALSE so a migration/seed never
 * silently opens a House for booking. Operational config only — not
 * part of the cultural approval workflow; ADMIN/SUPER_ADMIN manage it.
 */
export const sacredHouseBookingSettings = mysqlTable(
  'sacred_house_booking_settings',
  {
    sacredHouseId: int('sacred_house_id', { unsigned: true }).primaryKey(),
    schedulingTimezone: varchar('scheduling_timezone', { length: 64 })
      .notNull()
      .default('Africa/Lagos'),
    bookingEnabled: boolean('booking_enabled').notNull().default(false),
    slotIncrementMinutes: int('slot_increment_minutes', { unsigned: true })
      .notNull()
      .default(30),
    minimumLeadMinutes: int('minimum_lead_minutes', { unsigned: true })
      .notNull()
      .default(1440),
    maximumAdvanceDays: int('maximum_advance_days', { unsigned: true })
      .notNull()
      .default(90),
    reservationHoldMinutes: int('reservation_hold_minutes', { unsigned: true })
      .notNull()
      .default(15),
    cancellationCutoffMinutes: int('cancellation_cutoff_minutes', {
      unsigned: true,
    })
      .notNull()
      .default(1440),
    rescheduleCutoffMinutes: int('reschedule_cutoff_minutes', {
      unsigned: true,
    })
      .notNull()
      .default(1440),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.sacredHouseId],
      foreignColumns: [sacredHouses.id],
      name: 'shbs_house_fk',
    }).onDelete('cascade'),
  ],
)

/**
 * Recurring weekly availability windows in the House's scheduling
 * timezone. day_of_week is ISO: 1 = Monday … 7 = Sunday. Multiple
 * windows per day are allowed; active overlapping windows for the same
 * House/day are rejected at the service layer. Never seeded — admins
 * configure real hours.
 */
export const sacredHouseAvailability = mysqlTable(
  'sacred_house_availability',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    sacredHouseId: int('sacred_house_id', { unsigned: true }).notNull(),
    dayOfWeek: int('day_of_week', { unsigned: true }).notNull(),
    startLocalTime: time('start_local_time').notNull(),
    endLocalTime: time('end_local_time').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index('sha_house_day_idx').on(table.sacredHouseId, table.dayOfWeek),
    foreignKey({
      columns: [table.sacredHouseId],
      foreignColumns: [sacredHouses.id],
      name: 'sha_house_fk',
    }).onDelete('cascade'),
  ],
)

export const EXCEPTION_TYPES = ['CLOSED', 'BLOCK', 'OPEN'] as const
export type ExceptionType = (typeof EXCEPTION_TYPES)[number]

/**
 * Date-specific exceptions in House-local dates: CLOSED (whole day),
 * BLOCK (remove an interval), OPEN (add an exceptional interval).
 * Labels are internal/operational — never shown publicly.
 */
export const sacredHouseAvailabilityExceptions = mysqlTable(
  'sacred_house_availability_exceptions',
  {
    id: int('id', { unsigned: true }).autoincrement().primaryKey(),
    sacredHouseId: int('sacred_house_id', { unsigned: true }).notNull(),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    type: mysqlEnum('type', EXCEPTION_TYPES).notNull(),
    startLocalTime: time('start_local_time'),
    endLocalTime: time('end_local_time'),
    label: varchar('label', { length: 200 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('shae_house_date_idx').on(table.sacredHouseId, table.localDate),
    foreignKey({
      columns: [table.sacredHouseId],
      foreignColumns: [sacredHouses.id],
      name: 'shae_house_fk',
    }).onDelete('cascade'),
  ],
)

/**
 * Locked appointment lifecycle. There is deliberately NO 'PAID' status:
 * payment state will belong to later payment records. PENDING_PAYMENT
 * blocks a slot only while reservation_expires_at is in the future
 * (lazy expiration — correctness never depends on a cleanup worker).
 */
export const APPOINTMENT_STATUSES = [
  'PENDING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
  'EXPIRED',
] as const
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]

/**
 * Appointments. starts/ends/expiry are UTC 'YYYY-MM-DD HH:MM:SS'
 * strings written by application code for VPS-timezone independence.
 * Commercial/scheduling facts are snapshotted at reservation time so
 * later catalogue edits never rewrite history; service/House FKs are
 * RESTRICT for the same reason. public_id is a server-generated UUID —
 * sequential ids are never a public reference.
 */
export const appointments = mysqlTable(
  'appointments',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    userId: bigint('user_id', { mode: 'number', unsigned: true }).notNull(),
    serviceId: int('service_id', { unsigned: true }).notNull(),
    sacredHouseId: int('sacred_house_id', { unsigned: true }).notNull(),
    status: mysqlEnum('status', APPOINTMENT_STATUSES).notNull(),
    startsAtUtc: varchar('starts_at_utc', { length: 19 }).notNull(),
    endsAtUtc: varchar('ends_at_utc', { length: 19 }).notNull(),
    userTimezone: varchar('user_timezone', { length: 64 }).notNull(),
    houseTimezone: varchar('house_timezone', { length: 64 }).notNull(),
    reservationExpiresAt: varchar('reservation_expires_at', { length: 19 }),
    serviceNameSnapshot: varchar('service_name_snapshot', {
      length: 150,
    }).notNull(),
    serviceCodeSnapshot: varchar('service_code_snapshot', {
      length: 50,
    }).notNull(),
    houseNameSnapshot: varchar('house_name_snapshot', {
      length: 150,
    }).notNull(),
    durationMinutesSnapshot: int('duration_minutes_snapshot', {
      unsigned: true,
    }).notNull(),
    priceMinorSnapshot: int('price_minor_snapshot', {
      unsigned: true,
    }).notNull(),
    currencySnapshot: varchar('currency_snapshot', { length: 3 }).notNull(),
    privateRequestNote: varchar('private_request_note', { length: 1500 }),
    cancelledAt: timestamp('cancelled_at'),
    cancelledByUserId: bigint('cancelled_by_user_id', {
      mode: 'number',
      unsigned: true,
    }),
    cancellationReason: varchar('cancellation_reason', { length: 500 }),
    completedAt: timestamp('completed_at'),
    noShowAt: timestamp('no_show_at'),
    rescheduleCount: int('reschedule_count', { unsigned: true })
      .notNull()
      .default(0),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('appt_public_id_unique').on(table.publicId),
    index('appt_house_start_idx').on(table.sacredHouseId, table.startsAtUtc),
    index('appt_user_start_idx').on(table.userId, table.startsAtUtc),
    index('appt_status_idx').on(table.status),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [users.id],
      name: 'appt_user_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.serviceId],
      foreignColumns: [services.id],
      name: 'appt_service_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.sacredHouseId],
      foreignColumns: [sacredHouses.id],
      name: 'appt_house_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.cancelledByUserId],
      foreignColumns: [users.id],
      name: 'appt_cancelled_by_fk',
    }).onDelete('set null'),
  ],
)

export const ASSIGNMENT_ROLES = ['PRIMARY', 'SUPPORT'] as const
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number]

/**
 * Private post-confirmation representative assignments. Zero, one or
 * many members per appointment; at most one PRIMARY (enforced in the
 * service layer). Members must belong to the appointment's House and
 * be active. Assignment never affects scheduling capacity and members
 * remain publicly non-bookable.
 */
export const appointmentRepresentatives = mysqlTable(
  'appointment_representatives',
  {
    appointmentId: bigint('appointment_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    sacredHouseMemberId: int('sacred_house_member_id', {
      unsigned: true,
    }).notNull(),
    assignmentRole: mysqlEnum('assignment_role', ASSIGNMENT_ROLES).notNull(),
    assignedBy: bigint('assigned_by', { mode: 'number', unsigned: true }),
    assignedAt: timestamp('assigned_at').notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'ar_pk',
      columns: [table.appointmentId, table.sacredHouseMemberId],
    }),
    index('ar_member_idx').on(table.sacredHouseMemberId),
    foreignKey({
      columns: [table.appointmentId],
      foreignColumns: [appointments.id],
      name: 'ar_appt_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.sacredHouseMemberId],
      foreignColumns: [sacredHouseMembers.id],
      name: 'ar_member_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.assignedBy],
      foreignColumns: [users.id],
      name: 'ar_assigned_by_fk',
    }).onDelete('set null'),
  ],
)
