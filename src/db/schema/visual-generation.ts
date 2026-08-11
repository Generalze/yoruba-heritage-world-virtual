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
import { prayerGenerationManifestSnapshots } from './storyboards'

/**
 * Visual generation task execution/result persistence (Phase One,
 * Step 14; canon §10.7).
 *
 *   GENERATING_VISUALS job + validated Step 13 manifest
 *   → ONE row per GENERATION_REQUIRED manifest task, submitted at most
 *     once per idempotency key
 *   → async provider submit/poll (no transaction, no provider call held
 *     open)
 *   → SUCCEEDED (safe result metadata only) or bounded FAILED
 *   → once every task SUCCEEDED and the manifest revalidates → GENERATING_AUDIO
 *
 * A row is the SAME durable anti-duplicate-submission guard the job
 * queue itself provides: `(generation_job_id, manifest_snapshot_id,
 * task_id)` and `idempotency_key` are BOTH unique at the DB level, so a
 * re-claimed/re-run job can never submit the same paid generation
 * twice. NEVER contains sacred body text, a raw provider request or
 * response payload, or Visual Bible rule text — only ids, an opaque
 * provider operation id, status/attempts, safe artifact metadata (hash/
 * mime/duration), a private internal artifact reference, timestamps and
 * bounded error codes.
 */

export const VISUAL_TASK_STATUSES = [
  'PENDING',
  'SUBMITTED',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const
export type VisualTaskStatus = (typeof VISUAL_TASK_STATUSES)[number]

export const prayerGenerationVisualTasks = mysqlTable(
  'prayer_generation_visual_tasks',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    generationJobId: bigint('generation_job_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    manifestSnapshotId: bigint('manifest_snapshot_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    // From GenerationManifest.visualTasks[].taskId / .sceneId — bounded
    // deterministic identifiers, never sacred content.
    taskId: varchar('task_id', { length: 100 }).notNull(),
    sceneId: varchar('scene_id', { length: 100 }).notNull(),
    // Deterministic sha256 over (job, storyboardSha256, sceneId).
    //
    // This is a STABLE IDENTITY, not by itself a defence against a
    // second paid call: it makes a task recognisable across retries and
    // is offered to providers that support an external request id. What
    // actually prevents duplicate spend is the durable pre-call
    // reservation in runVisualGenerationOnce.
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
    status: mysqlEnum('status', VISUAL_TASK_STATUSES)
      .notNull()
      .default('PENDING'),
    attemptCount: int('attempt_count', { unsigned: true }).notNull().default(0),
    // Opaque provider identity only — never a request/response payload.
    providerCode: varchar('provider_code', { length: 40 }),
    providerOperationId: varchar('provider_operation_id', { length: 200 }),
    // Safe result metadata only.
    artifactSha256: varchar('artifact_sha256', { length: 64 }),
    artifactMimeType: varchar('artifact_mime_type', { length: 100 }),
    artifactDurationMs: int('artifact_duration_ms', { unsigned: true }),
    // Private internal reference (e.g. a storage key) — never a public
    // URL and never the artifact bytes themselves.
    artifactStorageRef: varchar('artifact_storage_ref', { length: 255 }),
    lastErrorCode: varchar('last_error_code', { length: 60 }),
    lastErrorMessage: varchar('last_error_message', { length: 500 }),
    // Due time for the NEXT provider poll. Distinct from the parent
    // job's nextAttemptAt/retry budget — a task legitimately awaiting a
    // provider result is not a failure (see generation-jobs.ts).
    nextPollAt: timestamp('next_poll_at'),
    submittedAt: timestamp('submitted_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    // Anti-duplicate-submission backbone: one row per manifest task,
    // ever, for a given job + manifest snapshot.
    uniqueIndex('pgvt_job_manifest_task_unique').on(
      table.generationJobId,
      table.manifestSnapshotId,
      table.taskId,
    ),
    // Belt-and-braces: the provider-facing dedup key is unique on its
    // own too, independent of how it was looked up.
    uniqueIndex('pgvt_idempotency_unique').on(table.idempotencyKey),
    index('pgvt_status_idx').on(table.status),
    index('pgvt_poll_idx').on(table.status, table.nextPollAt),
    foreignKey({
      columns: [table.generationJobId],
      foreignColumns: [prayerGenerationJobs.id],
      name: 'pgvt_job_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.manifestSnapshotId],
      foreignColumns: [prayerGenerationManifestSnapshots.id],
      name: 'pgvt_manifest_fk',
    }).onDelete('restrict'),
  ],
)
