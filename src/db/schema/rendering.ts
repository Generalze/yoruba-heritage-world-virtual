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

import { prayerGenerationJobs } from './generation'
import { prayerGenerationManifestSnapshots } from './storyboards'

/**
 * Immutable render plans and durable render results (Phase One,
 * Step 16; canon §10.9).
 *
 *   RENDERING job + validated Step 13 manifest
 *   + VERIFIED Step 14 visual outputs / approved media
 *   + VERIFIED Step 15 speech outputs / approved human audio
 *   → ONE deterministic, immutable render plan (canonical SHA-256)
 *   → ONE render result per (job, manifest snapshot, render plan)
 *   → UPLOADING (a verified LOCAL artifact, uploaded nowhere)
 *
 * Both tables carry render-significant SAFE metadata only: ids, hashes,
 * timings, bounded machine codes and a PRIVATE local storage reference.
 * NEVER sacred body text, spoken text, Visual Bible rule text, provider
 * request/response payloads, credentials, or any personal detail of the
 * person who booked the appointment.
 *
 * Render plans are APPEND-ONLY and immutable: historical rows are never
 * updated or deleted. A re-render of the same authority reproduces the
 * SAME plan hash and reuses that snapshot rather than appending a
 * duplicate — determinism is what makes the retry safe.
 */

export const RENDER_RESULT_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const
export type RenderResultStatus = (typeof RENDER_RESULT_STATUSES)[number]

export const prayerGenerationRenderPlans = mysqlTable(
  'prayer_generation_render_plans',
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
    snapshotNumber: int('snapshot_number', { unsigned: true }).notNull(),
    planJsonText: text('plan_json_text').notNull(),
    /** sha256 of the exact stored JSON text — detects row tampering
     * independently of the plan's own canonical hash. */
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    /** Canonical hash over the plan's decisions, recomputable from the
     * same inputs by any worker. */
    renderPlanSha256: varchar('render_plan_sha256', { length: 64 }).notNull(),
    /** The manifest this plan was derived from, so a plan can never be
     * silently re-pointed at a different one. */
    manifestSha256: varchar('manifest_sha256', { length: 64 }).notNull(),
    sceneCount: int('scene_count', { unsigned: true }).notNull(),
    audioSegmentCount: int('audio_segment_count', { unsigned: true }).notNull(),
    totalDurationMs: int('total_duration_ms', { unsigned: true }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pgrp_job_num_unique').on(
      table.generationJobId,
      table.snapshotNumber,
    ),
    index('pgrp_manifest_idx').on(table.manifestSnapshotId),
    index('pgrp_hash_idx').on(table.generationJobId, table.renderPlanSha256),
    foreignKey({
      columns: [table.generationJobId],
      foreignColumns: [prayerGenerationJobs.id],
      name: 'pgrp_job_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.manifestSnapshotId],
      foreignColumns: [prayerGenerationManifestSnapshots.id],
      name: 'pgrp_manifest_fk',
    }).onDelete('restrict'),
  ],
)

export const prayerGenerationRenderResults = mysqlTable(
  'prayer_generation_render_results',
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
    renderPlanSnapshotId: bigint('render_plan_snapshot_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    /** sha256(render-v1|job|manifestSha256|renderPlanSha256) — the SAME
     * authority always maps to the SAME row, so a deterministic retry
     * can never produce a second accepted output. */
    idempotencyKey: varchar('idempotency_key', { length: 64 }).notNull(),
    /** Which engine produced this, and at what version. A mock result is
     * identifiable forever, not just at the moment it was made. */
    rendererCode: varchar('renderer_code', { length: 40 }).notNull(),
    rendererVersion: varchar('renderer_version', { length: 40 }).notNull(),
    rendererIsMock: int('renderer_is_mock', { unsigned: true })
      .notNull()
      .default(0),
    status: mysqlEnum('status', RENDER_RESULT_STATUSES)
      .notNull()
      .default('PENDING'),
    attemptCount: int('attempt_count', { unsigned: true }).notNull().default(0),
    renderPlanSha256: varchar('render_plan_sha256', { length: 64 }).notNull(),
    // Safe result metadata only.
    artifactSha256: varchar('artifact_sha256', { length: 64 }),
    artifactMimeType: varchar('artifact_mime_type', { length: 100 }),
    artifactDurationMs: int('artifact_duration_ms', { unsigned: true }),
    /** PRIVATE LOCAL reference — never a public URL, never an object
     * store key, and never the artifact bytes themselves. Step 16
     * uploads nowhere. */
    artifactStorageRef: varchar('artifact_storage_ref', { length: 255 }),
    lastErrorCode: varchar('last_error_code', { length: 60 }),
    lastErrorMessage: varchar('last_error_message', { length: 500 }),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    // ONE result per job + manifest snapshot + render plan, ever.
    uniqueIndex('pgrr_job_manifest_plan_unique').on(
      table.generationJobId,
      table.manifestSnapshotId,
      table.renderPlanSnapshotId,
    ),
    uniqueIndex('pgrr_idempotency_unique').on(table.idempotencyKey),
    index('pgrr_status_idx').on(table.status),
    foreignKey({
      columns: [table.generationJobId],
      foreignColumns: [prayerGenerationJobs.id],
      name: 'pgrr_job_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.manifestSnapshotId],
      foreignColumns: [prayerGenerationManifestSnapshots.id],
      name: 'pgrr_manifest_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.renderPlanSnapshotId],
      foreignColumns: [prayerGenerationRenderPlans.id],
      name: 'pgrr_plan_fk',
    }).onDelete('restrict'),
  ],
)
