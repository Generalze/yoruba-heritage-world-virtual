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

import { prayerGenerationJobs } from './generation'
import { prayerGenerationRenderResults } from './rendering'

/**
 * Private object-storage uploads of finished renders (Phase One,
 * Step 17; canon §10.10).
 *
 *   UPLOADING job + the EXACT successful Step 16 render result
 *   → ONE upload identity per render result, keyed by a deterministic
 *     idempotency hash
 *   → the verified local artifact placed at a SERVER-GENERATED
 *     canonical private object key
 *   → remote integrity re-proved against the exact local artifact
 *   → READY
 *
 * READY means the generation pipeline's artifact is complete and
 * PRIVATELY stored. Step 17 creates no Prayer Room, exposes no media
 * and hands no URL to anybody.
 *
 * Rows carry SAFE metadata only: ids, hashes, a server-generated opaque
 * object key, sizes/timings, an opaque provider etag/version identity
 * and bounded machine codes. NEVER the file bytes, a signed URL, any
 * credential, sacred body text, spoken text, personal detail of the
 * person who booked, or a raw provider response.
 */

export const UPLOAD_STATUSES = [
  'PENDING',
  'UPLOADING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const
export type UploadStatus = (typeof UPLOAD_STATUSES)[number]

export const prayerGenerationUploads = mysqlTable(
  'prayer_generation_uploads',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    generationJobId: bigint('generation_job_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    renderResultId: bigint('render_result_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    renderPlanSnapshotId: bigint('render_plan_snapshot_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    renderPlanSha256: varchar('render_plan_sha256', { length: 64 }).notNull(),
    /** sha256(upload-v1|job|renderResultId|renderPlanSha256|artifactSha256)
     * — the SAME authority always maps to the SAME upload and the SAME
     * canonical object, which is what makes a crash-interrupted upload
     * recoverable without a second accepted object. */
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
    providerCode: varchar('provider_code', { length: 40 }).notNull(),
    /** 1 for the local/test adapter. Persisted so a local object is
     * identifiable forever, not just at the moment it was written. */
    providerIsLocal: int('provider_is_local', { unsigned: true })
      .notNull()
      .default(0),
    /** SERVER-GENERATED from the opaque idempotency key alone. Contains
     * no appointment, user, house or service text of any kind. */
    objectKey: varchar('object_key', { length: 255 }).notNull(),
    artifactSha256: varchar('artifact_sha256', { length: 64 }).notNull(),
    artifactMimeType: varchar('artifact_mime_type', { length: 100 }).notNull(),
    artifactDurationMs: int('artifact_duration_ms', {
      unsigned: true,
    }).notNull(),
    byteSize: int('byte_size', { unsigned: true }).notNull(),
    /** Opaque provider bookkeeping — NEVER accepted as a content hash. */
    providerEtag: varchar('provider_etag', { length: 200 }),
    providerVersionId: varchar('provider_version_id', { length: 200 }),
    status: mysqlEnum('status', UPLOAD_STATUSES).notNull().default('PENDING'),
    attemptCount: int('attempt_count', { unsigned: true }).notNull().default(0),
    lastErrorCode: varchar('last_error_code', { length: 60 }),
    lastErrorMessage: varchar('last_error_message', { length: 500 }),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    // ONE upload per render result, ever.
    uniqueIndex('pgu_job_result_unique').on(
      table.generationJobId,
      table.renderResultId,
    ),
    uniqueIndex('pgu_idempotency_unique').on(table.idempotencyKey),
    // The canonical object key is derived from that same identity, so
    // it is unique by construction — enforced here as well so two rows
    // can never claim the same object.
    uniqueIndex('pgu_object_key_unique').on(table.objectKey),
    index('pgu_status_idx').on(table.status),
    foreignKey({
      columns: [table.generationJobId],
      foreignColumns: [prayerGenerationJobs.id],
      name: 'pgu_job_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.renderResultId],
      foreignColumns: [prayerGenerationRenderResults.id],
      name: 'pgu_result_fk',
    }).onDelete('restrict'),
  ],
)
