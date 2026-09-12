import {
  bigint,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { appointments } from './appointments'
import { users } from './users'

/**
 * Admin-prepared Prayer Room recordings.
 *
 * A booked appointment no longer starts an autonomous video generation
 * pipeline. Staff use the appointment's private booking details outside
 * this table, prepare the video, and attach exactly one active private
 * object to the appointment. The member-facing Prayer Room still opens
 * only at the current appointment start and still re-proves private
 * storage integrity on every media request.
 *
 * Rows carry safe delivery metadata only: no booking note, no prompt,
 * no spiritual body text, no signed URL and no public path.
 */

export const APPOINTMENT_PRAYER_ROOM_MEDIA_STATUSES = [
  'ACTIVE',
  'REVOKED',
] as const
export type AppointmentPrayerRoomMediaStatus =
  (typeof APPOINTMENT_PRAYER_ROOM_MEDIA_STATUSES)[number]

export const appointmentPrayerRoomMedia = mysqlTable(
  'appointment_prayer_room_media',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    appointmentId: bigint('appointment_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    uploadedBy: bigint('uploaded_by', { mode: 'number', unsigned: true }),
    status: mysqlEnum(
      'status',
      APPOINTMENT_PRAYER_ROOM_MEDIA_STATUSES,
    )
      .notNull()
      .default('ACTIVE'),
    providerCode: varchar('provider_code', { length: 40 }).notNull(),
    providerIsLocal: int('provider_is_local', { unsigned: true })
      .notNull()
      .default(0),
    objectKey: varchar('object_key', { length: 255 }).notNull(),
    fileSha256: varchar('file_sha256', { length: 64 }).notNull(),
    mimeType: varchar('mime_type', { length: 100 }).notNull(),
    byteSize: int('byte_size', { unsigned: true }).notNull(),
    durationSeconds: int('duration_seconds', { unsigned: true }),
    providerEtag: varchar('provider_etag', { length: 200 }),
    providerVersionId: varchar('provider_version_id', { length: 200 }),
    adminNote: varchar('admin_note', { length: 500 }),
    uploadedAt: timestamp('uploaded_at').notNull().defaultNow(),
    revokedAt: timestamp('revoked_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('aprm_appointment_unique').on(table.appointmentId),
    uniqueIndex('aprm_object_key_unique').on(table.objectKey),
    index('aprm_status_idx').on(table.status),
    foreignKey({
      columns: [table.appointmentId],
      foreignColumns: [appointments.id],
      name: 'aprm_appointment_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.uploadedBy],
      foreignColumns: [users.id],
      name: 'aprm_uploaded_by_fk',
    }).onDelete('set null'),
  ],
)
