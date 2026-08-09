import {
  bigint,
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

import { appointments } from './appointments'
import { GUIDANCE_LANGUAGES } from './guidance'

/**
 * Appointment-bound prayer generation jobs, immutable recipe snapshots
 * and the DB-backed queue (Phase One, Step 12; canon §10.5).
 *
 * Verified payment → CONFIRMED appointment → generation job atomically
 * queued (same transaction) → DB worker claims via bounded lease →
 * Step 11 recipe built + validated → append-only snapshot →
 * STORYBOARDING. No human approves an individual generation; Step 12
 * calls NO provider (no Kling/OpenArt/TTS/Remotion/FFmpeg) and uses NO
 * Redis — the queue is these tables.
 *
 * Privacy: rows/events carry ids, statuses, hashes and bounded machine
 * codes only — never sacred bodies, private requests, payment data,
 * phone/DOB, consent references, storage keys or provider payloads.
 */

export const GENERATION_JOB_STATUSES = [
  'QUEUED',
  'PREPARING',
  'STORYBOARDING',
  'GENERATING_VISUALS',
  'GENERATING_AUDIO',
  'RENDERING',
  'UPLOADING',
  'READY',
  'RETRYING',
  'FAILED',
  'CANCELLED',
] as const
export type GenerationJobStatus = (typeof GENERATION_JOB_STATUSES)[number]

export const prayerGenerationJobs = mysqlTable(
  'prayer_generation_jobs',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    publicId: varchar('public_id', { length: 36 }).notNull(),
    appointmentId: bigint('appointment_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    serviceIdSnapshot: int('service_id_snapshot', { unsigned: true }).notNull(),
    sacredHouseIdSnapshot: int('sacred_house_id_snapshot', {
      unsigned: true,
    }).notNull(),
    languageSnapshot: mysqlEnum(
      'language_snapshot',
      GUIDANCE_LANGUAGES,
    ).notNull(),
    variationSeed: varchar('variation_seed', { length: 64 }).notNull(),
    status: mysqlEnum('status', GENERATION_JOB_STATUSES)
      .notNull()
      .default('QUEUED'),
    attemptCount: int('attempt_count', { unsigned: true }).notNull().default(0),
    maxAttempts: int('max_attempts', { unsigned: true }).notNull().default(5),
    resumeStatus: mysqlEnum('resume_status', GENERATION_JOB_STATUSES),
    nextAttemptAt: timestamp('next_attempt_at'),
    leaseToken: varchar('lease_token', { length: 36 }),
    leaseOwner: varchar('lease_owner', { length: 100 }),
    leaseAcquiredAt: timestamp('lease_acquired_at'),
    leaseExpiresAt: timestamp('lease_expires_at'),
    lastErrorCode: varchar('last_error_code', { length: 60 }),
    lastErrorMessage: varchar('last_error_message', { length: 500 }),
    preparedAt: timestamp('prepared_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex('pgj_public_id_unique').on(table.publicId),
    // Exactly ONE normal generation job per appointment — duplicate
    // settlement/webhook replays can never create a second one.
    uniqueIndex('pgj_appointment_unique').on(table.appointmentId),
    index('pgj_status_idx').on(table.status),
    index('pgj_due_idx').on(table.status, table.nextAttemptAt),
    index('pgj_lease_idx').on(table.leaseExpiresAt),
    foreignKey({
      columns: [table.appointmentId],
      foreignColumns: [appointments.id],
      name: 'pgj_appointment_fk',
    }).onDelete('restrict'),
  ],
)

/** Append-only validated recipe snapshots. Historical snapshots are
 * NEVER updated or deleted; a new preparation appends the next
 * snapshot_number. */
export const prayerGenerationRecipeSnapshots = mysqlTable(
  'prayer_generation_recipe_snapshots',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    generationJobId: bigint('generation_job_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    snapshotNumber: int('snapshot_number', { unsigned: true }).notNull(),
    recipeJsonText: text('recipe_json_text').notNull(),
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    recipeSha256: varchar('recipe_sha256', { length: 64 }).notNull(),
    templateVersionId: bigint('template_version_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    templateDefinitionSha256: varchar('template_definition_sha256', {
      length: 64,
    }).notNull(),
    visualBibleVersionId: bigint('visual_bible_version_id', {
      mode: 'number',
      unsigned: true,
    }),
    visualBibleDefinitionSha256: varchar('visual_bible_definition_sha256', {
      length: 64,
    }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pgrs_job_num_unique').on(
      table.generationJobId,
      table.snapshotNumber,
    ),
    foreignKey({
      columns: [table.generationJobId],
      foreignColumns: [prayerGenerationJobs.id],
      name: 'pgrs_job_fk',
    }).onDelete('restrict'),
  ],
)

/** Bounded machine-readable job event trail (status transitions,
 * lease/retry/admin actions). Safe metadata only. */
export const prayerGenerationJobEvents = mysqlTable(
  'prayer_generation_job_events',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    generationJobId: bigint('generation_job_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    fromStatus: mysqlEnum('from_status', GENERATION_JOB_STATUSES),
    toStatus: mysqlEnum('to_status', GENERATION_JOB_STATUSES).notNull(),
    eventCode: varchar('event_code', { length: 60 }).notNull(),
    attemptNumber: int('attempt_number', { unsigned: true })
      .notNull()
      .default(0),
    detailCode: varchar('detail_code', { length: 100 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('pgje_job_idx').on(table.generationJobId),
    foreignKey({
      columns: [table.generationJobId],
      foreignColumns: [prayerGenerationJobs.id],
      name: 'pgje_job_fk',
    }).onDelete('restrict'),
  ],
)
