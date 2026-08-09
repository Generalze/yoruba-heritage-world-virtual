import {
  bigint,
  foreignKey,
  index,
  int,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import {
  prayerGenerationJobs,
  prayerGenerationRecipeSnapshots,
} from './generation'

/**
 * Deterministic storyboards and provider-neutral generation manifests
 * (Phase One, Step 13; canon §10.6).
 *
 *   validated recipe snapshot (Step 12)
 *   → deterministic storyboard
 *   → provider-neutral generation manifest
 *   → GENERATING_VISUALS (ready for a FUTURE visual executor)
 *
 * Both snapshot tables are APPEND-ONLY and immutable: historical rows
 * are never updated or deleted. Neither contains sacred bodies, PII,
 * private requests, consent references, rights notes, media storage
 * keys, provider payloads or provider credentials — only ids, hashes,
 * timings and bounded machine-readable planning metadata.
 *
 * Step 13 selects NO provider and calls NO provider (no Kling/OpenArt/
 * TTS/Remotion/FFmpeg); manifests are provider-neutral plans only.
 */

export const prayerGenerationStoryboardSnapshots = mysqlTable(
  'prayer_generation_storyboard_snapshots',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    generationJobId: bigint('generation_job_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    recipeSnapshotId: bigint('recipe_snapshot_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    snapshotNumber: int('snapshot_number', { unsigned: true }).notNull(),
    storyboardJsonText: text('storyboard_json_text').notNull(),
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    storyboardSha256: varchar('storyboard_sha256', { length: 64 }).notNull(),
    sceneCount: int('scene_count', { unsigned: true }).notNull(),
    totalDurationMs: int('total_duration_ms', { unsigned: true }).notNull(),
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
    uniqueIndex('pgss_job_num_unique').on(
      table.generationJobId,
      table.snapshotNumber,
    ),
    index('pgss_recipe_idx').on(table.recipeSnapshotId),
    foreignKey({
      columns: [table.generationJobId],
      foreignColumns: [prayerGenerationJobs.id],
      name: 'pgss_job_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.recipeSnapshotId],
      foreignColumns: [prayerGenerationRecipeSnapshots.id],
      name: 'pgss_recipe_fk',
    }).onDelete('restrict'),
  ],
)

export const prayerGenerationManifestSnapshots = mysqlTable(
  'prayer_generation_manifest_snapshots',
  {
    id: bigint('id', { mode: 'number', unsigned: true })
      .autoincrement()
      .primaryKey(),
    generationJobId: bigint('generation_job_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    storyboardSnapshotId: bigint('storyboard_snapshot_id', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    snapshotNumber: int('snapshot_number', { unsigned: true }).notNull(),
    manifestJsonText: text('manifest_json_text').notNull(),
    payloadSha256: varchar('payload_sha256', { length: 64 }).notNull(),
    manifestSha256: varchar('manifest_sha256', { length: 64 }).notNull(),
    visualTaskCount: int('visual_task_count', { unsigned: true }).notNull(),
    audioRequirementCount: int('audio_requirement_count', {
      unsigned: true,
    }).notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pgms_job_num_unique').on(
      table.generationJobId,
      table.snapshotNumber,
    ),
    index('pgms_storyboard_idx').on(table.storyboardSnapshotId),
    foreignKey({
      columns: [table.generationJobId],
      foreignColumns: [prayerGenerationJobs.id],
      name: 'pgms_job_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.storyboardSnapshotId],
      foreignColumns: [prayerGenerationStoryboardSnapshots.id],
      name: 'pgms_storyboard_fk',
    }).onDelete('restrict'),
  ],
)
