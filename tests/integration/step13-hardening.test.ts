import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb, getPool } from '@/db'
import {
  appointmentGuidanceAssignments,
  appointmentGuidanceSets,
  appointments,
  auditLogs,
  mediaAssetVersions,
  mediaAssets,
  prayerGenerationJobEvents,
  prayerGenerationJobs,
  prayerGenerationManifestSnapshots,
  prayerGenerationRecipeSnapshots,
  prayerGenerationStoryboardSnapshots,
  prayerSessionTemplateSlots,
  prayerSessionTemplateVersions,
  prayerSessionTemplates,
  prayerTemplateForbiddenPairs,
  prayerTemplateSlotPins,
  prayerTemplateSlotScopes,
  sacredContentMediaLinks,
  sacredContentVersionProfiles,
  sacredHouseAvailability,
  sacredHouseBookingSettings,
  sacredHouses,
  services,
  spiritualContentItems,
  spiritualContentVersions,
  users,
  visualBibleRules,
  visualBibleVersions,
  visualBibles,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { assignRoleToUser } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import { acceptRequiredConsents, savePersonalDetails } from '@/services/profile'
import {
  addAvailabilityWindow,
  getOrCreateBookingSettings,
  updateBookingSettings,
} from '@/services/scheduling'
import { confirmReservation, createReservation } from '@/services/appointments'
import {
  approveVersion,
  publishVersion,
  submitVersionForReview,
} from '@/services/spiritual-content'
import {
  createSacredContentItem,
  createSacredVersion,
  setSacredRightsStatus,
  setSacredRuntimeEnabled,
} from '@/services/sacred-content'
import {
  approveTemplateVersion,
  createPrayerTemplate,
  createTemplateVersion,
  publishTemplateVersion,
  submitTemplateVersion,
} from '@/services/prayer-templates'
import {
  LocalMediaStorageProvider,
  resetMediaStorageForTests,
  setMediaStorageForTests,
} from '@/providers/media/storage'
import {
  approveMediaVersion,
  createMediaAsset,
  createMediaVersion,
  createSacredMediaLink,
  publishMediaVersion,
  setMediaRightsStatus,
  setMediaRuntimeEnabled,
  submitMediaVersion,
} from '@/services/media-assets'
import {
  approveVisualBibleVersion,
  createVisualBible,
  createVisualBibleVersion,
  publishVisualBibleVersion,
  submitVisualBibleVersion,
} from '@/services/visual-bibles'
import {
  DEFAULT_LEASE_MS,
  RETRY_SCHEDULE_MINUTES,
  claimNextStoryboardJob,
  loadAndValidateGenerationRecipe,
  recoverExpiredGenerationLeases,
  runGenerationPreparationOnce,
  scheduleRetryOrFail,
} from '@/services/generation-jobs'
import {
  MANIFEST_SCHEMA_VERSION,
  MAX_SCENE_MS,
  STORYBOARD_SCHEMA_VERSION,
  buildValidatedGenerationStoryboard,
  computeManifestSha256,
  computeStoryboardSha256,
  computeVisualTaskIdempotencyKey,
  loadAndValidateGenerationManifest,
  loadGenerationManifestSnapshot,
  loadGenerationStoryboardSnapshot,
  runStoryboardPlanningOnce,
} from '@/services/generation-storyboards'
import { computeRecipeSha256 } from '@/services/video-recipes'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type {
  GenerationManifest,
  GenerationStoryboard,
} from '@/services/generation-storyboards'
import type { VideoRecipe } from '@/services/video-recipes'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * Step 13 ADVERSARIAL hardening regressions.
 *
 * These tests attack the places where a "looks fine" storyboard,
 * manifest or lease is actually wrong:
 *
 *   1. audio requirements must describe the FULL recipe segment window,
 *      not just the first presentational sub-scene;
 *   2. a snapshot whose every checksum recomputes exactly can still be
 *      semantically dead — the validator must catch it WITHOUT relying
 *      on a hash mismatch;
 *   3. a persisted snapshot from an older/unknown schema version must
 *      fail closed rather than be reinterpreted;
 *   4. structurally impossible recipes must fail closed in the builder
 *      and write NOTHING;
 *   5. lease grants, retry accounting and lease recovery must derive
 *      from the authoritative time read AFTER the row lock and from the
 *      job row re-read under that lock — never from a stale pre-lock
 *      reading or a stale in-memory copy.
 *
 * Synthetic fixtures only. No provider, TTS, render or queue broker is
 * touched anywhere in this file.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `step13 hardening passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const createdItemIds: Array<number> = []
const createdAssetIds: Array<number> = []
const createdTemplateIds: Array<number> = []
const createdBibleIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'

let adminId: number
let cmId: number
let houseId: number
let storageRoot: string
let storage: LocalMediaStorageProvider
let servicePool: Array<number> = []
let serviceCursor = 0

const RUN_KEY = crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')
const CODE_PREFIX = `H13_${RUN_KEY}`
let codeCounter = 0
function nextCode(prefix = 'X'): string {
  codeCounter += 1
  return `${CODE_PREFIX}_${prefix}_${codeCounter}`
}
function nextService(): number {
  const id = servicePool.at(serviceCursor)
  serviceCursor += 1
  if (id == null) throw new Error('service pool exhausted — enlarge fixture')
  return id
}

const today = currentLocalDate(HOUSE_TZ, Date.now())
let slotCursor = 0
function nextSlot(): string {
  const hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00']
  const index = slotCursor++
  const date = addDays(today, 2 + Math.floor(index / hours.length))
  return utcMsToSql(localToUtcMs(HOUSE_TZ, date, hours[index % hours.length]))
}

function makeFakeClock(startMs: number) {
  let t = startMs
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function syntheticBytes(marker: string = crypto.randomUUID()): Uint8Array {
  return new TextEncoder().encode(`synthetic-test-media-bytes ${marker}`)
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `h13-${crypto.randomUUID()}@test.local`,
      preferredName: 'H13 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role) await assignRoleToUser(result.user.id, role)
  return result.user.id
}

async function makeEligibleUser(): Promise<number> {
  const id = await makeUser()
  await savePersonalDetails(
    id,
    {
      fullName: 'Adéwálé Olúṣọlá Adébáyọ̀',
      preferredName: 'Adéwálé',
      phone: '+2348012345678',
      countryCode: 'NG',
      timezone: 'Africa/Lagos',
      preferredLanguage: 'en',
      dateOfBirth: '1990-03-21',
    },
    ctx,
  )
  await acceptRequiredConsents(id, ctx)
  return id
}

function sacredProfile(
  overrides: Partial<SacredProfileInput> = {},
): SacredProfileInput {
  return {
    variantKind: 'ORIGINAL',
    provenanceType: 'ORIGINAL_AUTHORED',
    sourceCommunity: null,
    sourcePlace: null,
    sourceReference: null,
    publicAttributionText: null,
    internalProvenanceNote: null,
    digitalStorageAuthorized: true,
    themeCode: null,
    durationHintSeconds: 30,
    repeatable: false,
    voicePolicy: 'TEXT_ONLY',
    externalAiPolicy: 'METADATA_ONLY',
    accessPolicy: 'PRAYER_ROOM_PRIVATE',
    ...overrides,
  }
}

const SACRED_BODY_MARKER = 'Integration-test prayer block'

async function makeEligibleSacred(options: {
  themeCode: string
  contentType?: 'PRAYER' | 'CHANT' | 'BLESSING'
  voicePolicy?: 'HUMAN_RECORDED_REQUIRED' | 'APPROVED_TTS_ALLOWED' | 'TEXT_ONLY'
  externalAiPolicy?:
    'NO_EXTERNAL_AI' | 'METADATA_ONLY' | 'APPROVED_TEXT_CONTEXT'
  durationHintSeconds?: number
}): Promise<{ itemId: number; versionId: number }> {
  const item = await createSacredContentItem(cmId, ctx, {
    code: nextCode('SC'),
    contentType: options.contentType ?? 'PRAYER',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    sortOrder: 0,
  })
  createdItemIds.push(item.id)
  const version = await createSacredVersion(
    cmId,
    ctx,
    item.id,
    {
      language: 'en',
      title: 'Integration-test sacred block',
      body: `${SACRED_BODY_MARKER} ${crypto.randomUUID()}`,
    },
    sacredProfile({
      themeCode: options.themeCode,
      voicePolicy: options.voicePolicy ?? 'TEXT_ONLY',
      externalAiPolicy: options.externalAiPolicy ?? 'METADATA_ONLY',
      durationHintSeconds: options.durationHintSeconds ?? 30,
    }),
  )
  await submitVersionForReview(cmId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, version.id, true)
  return { itemId: item.id, versionId: version.id }
}

const MIME_BY_KIND = {
  AUDIO: 'audio/mpeg',
  IMAGE: 'image/png',
  VIDEO: 'video/mp4',
} as const

async function makeEligibleMedia(options: {
  assetKind?: 'AUDIO' | 'IMAGE' | 'VIDEO'
  contentType?: 'PRAYER' | 'CHANT' | 'BLESSING' | null
  themeCode?: string | null
  language?: 'en' | 'yo' | null
  sourceType?: 'HUMAN_RECORDED' | 'IN_HOUSE' | 'LICENSED'
  durationSeconds?: number | null
}): Promise<{ assetId: number; versionId: number }> {
  const assetKind = options.assetKind ?? 'IMAGE'
  const asset = await createMediaAsset(cmId, ctx, {
    code: nextCode('MA'),
    assetKind,
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    contentType: options.contentType ?? null,
    themeCode: options.themeCode ?? null,
  })
  createdAssetIds.push(asset.id)
  const version = await createMediaVersion(
    cmId,
    ctx,
    asset.id,
    syntheticBytes(),
    MIME_BY_KIND[assetKind],
    {
      sourceType: options.sourceType ?? 'IN_HOUSE',
      language: options.language ?? null,
      durationSeconds: options.durationSeconds ?? null,
      width: null,
      height: null,
      containsIdentifiablePerson: false,
      consentStatus: 'NOT_APPLICABLE',
      consentReference: null,
      externalAiPolicy: 'NO_EXTERNAL_AI',
      voiceCloneAuthorized: false,
    },
  )
  await submitMediaVersion(cmId, ctx, version.id)
  await approveMediaVersion(adminId, ctx, version.id)
  await publishMediaVersion(adminId, ctx, version.id)
  await setMediaRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setMediaRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setMediaRuntimeEnabled(adminId, ctx, version.id, true)
  return { assetId: asset.id, versionId: version.id }
}

function filterSlot(overrides: Partial<SlotInput> = {}): SlotInput {
  return {
    slotKey: 'MAIN_PRAYER',
    position: 1,
    slotKind: 'CONTENT',
    minSelect: 1,
    maxSelect: 1,
    contentType: 'PRAYER',
    selectorMode: 'ELIGIBLE_FILTER',
    themeCode: null,
    variantKind: null,
    silenceDurationSeconds: null,
    allowedScopes: ['PLATFORM'],
    pinnedContentVersionIds: [],
    ...overrides,
  }
}

async function makeServiceTemplate(
  serviceId: number,
  slots: Array<SlotInput>,
): Promise<number> {
  const template = await createPrayerTemplate(cmId, ctx, {
    code: nextCode('TPL'),
    scopeType: 'SERVICE',
    sacredHouseId: null,
    serviceId,
  })
  createdTemplateIds.push(template.id)
  const version = await createTemplateVersion(cmId, ctx, template.id, {
    language: 'en',
    priority: 0,
    selectionWeight: 1,
    targetMinSeconds: 10,
    targetMaxSeconds: 3600,
    slots,
    forbiddenPairs: [],
  })
  await submitTemplateVersion(cmId, ctx, version.id)
  await approveTemplateVersion(adminId, ctx, version.id)
  await publishTemplateVersion(adminId, ctx, version.id)
  return template.id
}

async function jobForAppointment(appointmentId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.appointmentId, appointmentId))
  ).at(0)
}

async function jobRow(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
  ).at(0)!
}

/** Cancels other live jobs so a claim targets the job under test. */
async function quiesceOtherJobs(exceptJobId: number): Promise<void> {
  const db = getDb()
  const apptRows = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(eq(appointments.sacredHouseId, houseId))
  const apptIds = apptRows.map((row) => row.id)
  if (apptIds.length === 0) return
  const live = await db
    .select({ id: prayerGenerationJobs.id })
    .from(prayerGenerationJobs)
    .where(inArray(prayerGenerationJobs.appointmentId, apptIds))
  for (const row of live) {
    if (row.id === exceptJobId) continue
    await db
      .update(prayerGenerationJobs)
      .set({ status: 'CANCELLED', leaseToken: null, leaseExpiresAt: null })
      .where(
        and(
          eq(prayerGenerationJobs.id, row.id),
          inArray(prayerGenerationJobs.status, [
            'QUEUED',
            'RETRYING',
            'STORYBOARDING',
          ]),
        ),
      )
  }
}

/** Confirms an appointment and runs Step 12 preparation so the job is
 * parked in STORYBOARDING, ready for Step 13. */
async function makeStoryboardReadyJob(
  serviceId: number,
): Promise<{ jobId: number; appointmentId: number }> {
  const userId = await makeEligibleUser()
  const reservation = await createReservation(userId, ctx, {
    serviceId,
    startsAtUtc: nextSlot(),
  })
  await confirmReservation(reservation.appointmentId, ctx)
  const job = (await jobForAppointment(reservation.appointmentId))!
  await quiesceOtherJobs(job.id)
  const prepared = await runGenerationPreparationOnce('h13-prep', {
    now: () => new Date(),
  })
  expect(prepared.status).toBe('PREPARED')
  expect((await jobForAppointment(reservation.appointmentId))!.status).toBe(
    'STORYBOARDING',
  )
  return { jobId: job.id, appointmentId: reservation.appointmentId }
}

async function storyboardRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationStoryboardSnapshots)
    .where(eq(prayerGenerationStoryboardSnapshots.generationJobId, jobId))
}

async function manifestRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationManifestSnapshots)
    .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
}

async function latestStoryboardRow(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationStoryboardSnapshots)
      .where(eq(prayerGenerationStoryboardSnapshots.generationJobId, jobId))
      .orderBy(sql`${prayerGenerationStoryboardSnapshots.snapshotNumber} DESC`)
      .limit(1)
  ).at(0)!
}

async function latestManifestRow(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationManifestSnapshots)
      .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
      .orderBy(sql`${prayerGenerationManifestSnapshots.snapshotNumber} DESC`)
      .limit(1)
  ).at(0)!
}

async function latestRecipeRow(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationRecipeSnapshots)
      .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
      .orderBy(sql`${prayerGenerationRecipeSnapshots.snapshotNumber} DESC`)
      .limit(1)
  ).at(0)!
}

type ReadyRecipe = Extract<VideoRecipe, { status: 'RECIPE_READY' }>

/**
 * Rewrites a persisted storyboard snapshot AND recomputes every
 * checksum (the embedded storyboardSha256 and the row payload hash) so
 * the tampering is completely invisible to an integrity check. Only a
 * SEMANTIC validation against current authority can catch it.
 */
async function rewriteStoryboardSnapshot(
  jobId: number,
  mutate: (storyboard: GenerationStoryboard) => void,
): Promise<GenerationStoryboard> {
  const row = await latestStoryboardRow(jobId)
  const parsed = JSON.parse(row.storyboardJsonText) as GenerationStoryboard
  mutate(parsed)
  const { storyboardSha256, ...body } = parsed
  void storyboardSha256
  const resealed: GenerationStoryboard = {
    ...body,
    storyboardSha256: computeStoryboardSha256(body),
  }
  const text = JSON.stringify(resealed)
  await getDb()
    .update(prayerGenerationStoryboardSnapshots)
    .set({
      storyboardJsonText: text,
      payloadSha256: sha256(text),
      storyboardSha256: resealed.storyboardSha256,
    })
    .where(eq(prayerGenerationStoryboardSnapshots.id, row.id))
  return resealed
}

/** Same trick for the manifest snapshot. */
async function rewriteManifestSnapshot(
  jobId: number,
  mutate: (manifest: GenerationManifest) => void,
): Promise<GenerationManifest> {
  const row = await latestManifestRow(jobId)
  const parsed = JSON.parse(row.manifestJsonText) as GenerationManifest
  mutate(parsed)
  const { manifestSha256, ...body } = parsed
  void manifestSha256
  const resealed: GenerationManifest = {
    ...body,
    manifestSha256: computeManifestSha256(body),
  }
  const text = JSON.stringify(resealed)
  await getDb()
    .update(prayerGenerationManifestSnapshots)
    .set({
      manifestJsonText: text,
      payloadSha256: sha256(text),
      manifestSha256: resealed.manifestSha256,
    })
    .where(eq(prayerGenerationManifestSnapshots.id, row.id))
  return resealed
}

/**
 * Re-binds a manifest to a rewritten storyboard so the ONLY remaining
 * defect is the semantic one under test: the storyboard hash, the task
 * intents, the deterministic idempotency keys and the approved-media
 * projection are all recomputed exactly as buildManifest() would.
 *
 * audioRequirements are deliberately NOT rebuilt — a corrupted audio
 * binding must be caught whether the validator compares the manifest
 * against the storyboard or the storyboard against the recipe.
 */
async function resyncManifestToStoryboard(
  jobId: number,
  storyboard: GenerationStoryboard,
): Promise<GenerationManifest> {
  return rewriteManifestSnapshot(jobId, (manifest) => {
    manifest.storyboardSha256 = storyboard.storyboardSha256
    manifest.totalDurationMs = storyboard.totalDurationMs
    for (const task of manifest.visualTasks) {
      const scene = storyboard.scenes.find(
        (candidate) => candidate.sceneId === task.sceneId,
      )
      if (scene?.generationIntent) {
        task.generationIntent = scene.generationIntent
        task.durationMs = scene.durationMs
      }
      task.idempotencyKey = computeVisualTaskIdempotencyKey({
        generationJobId: storyboard.generationJobId,
        storyboardSha256: storyboard.storyboardSha256,
        sceneId: task.sceneId,
      })
    }
    manifest.approvedMedia = storyboard.scenes
      .filter(
        (scene) =>
          scene.sourceMode === 'APPROVED_MEDIA' &&
          scene.mediaAssetVersionId != null &&
          scene.mediaAssetId != null &&
          scene.mediaFileSha256 != null,
      )
      .map((scene) => ({
        sceneId: scene.sceneId,
        mediaAssetVersionId: scene.mediaAssetVersionId!,
        mediaAssetId: scene.mediaAssetId!,
        fileSha256: scene.mediaFileSha256!,
        assetKind: scene.mediaAssetKind ?? '',
        startMs: scene.startMs,
        endMs: scene.endMs,
      }))
  })
}

/**
 * Rewrites the immutable Step 12 recipe snapshot with every checksum
 * recomputed, so the CURRENT Step 11 authority still validates it and
 * the Step 13 builder is driven by a controlled — but structurally
 * impossible — recipe.
 */
async function rewriteRecipeSnapshot(
  jobId: number,
  mutate: (recipe: ReadyRecipe) => void,
): Promise<ReadyRecipe> {
  const row = await latestRecipeRow(jobId)
  const parsed = JSON.parse(row.recipeJsonText) as ReadyRecipe
  mutate(parsed)
  const { recipeSha256, ...body } = parsed
  void recipeSha256
  const resealed: ReadyRecipe = {
    ...body,
    recipeSha256: computeRecipeSha256(body),
  }
  const text = JSON.stringify(resealed)
  await getDb()
    .update(prayerGenerationRecipeSnapshots)
    .set({
      recipeJsonText: text,
      payloadSha256: sha256(text),
      recipeSha256: resealed.recipeSha256,
    })
    .where(eq(prayerGenerationRecipeSnapshots.id, row.id))
  return resealed
}

/**
 * Holds a WRITE lock on the jobs table from a dedicated connection, so
 * a concurrent claim/recovery genuinely BLOCKS before it can read any
 * job row. Returns an idempotent release.
 */
async function holdJobsTableLock(): Promise<() => Promise<void>> {
  const connection = await getPool().getConnection()
  await connection.query('LOCK TABLES prayer_generation_jobs WRITE')
  let released = false
  return async () => {
    if (released) return
    released = true
    try {
      await connection.query('UNLOCK TABLES')
      connection.release()
    } catch {
      connection.destroy()
    }
  }
}

/** Settles a promise without ever leaving it unhandled while the test
 * orchestrates a lock hold around it. */
function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
}

/** A CONTENT fixture whose scenes come from approved library media. */
async function makeApprovedMediaService(tag: string): Promise<number> {
  const serviceId = nextService()
  const theme = `H13_${tag}_${RUN_KEY}`
  await makeEligibleSacred({ themeCode: theme, durationHintSeconds: 30 })
  await makeEligibleMedia({
    assetKind: 'IMAGE',
    contentType: 'PRAYER',
    themeCode: theme,
  })
  await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
  return serviceId
}

/** A CHANT fixture with no library visual → a generation descriptor. */
async function makeGenerationService(tag: string): Promise<number> {
  const serviceId = nextService()
  const theme = `H13_${tag}_${RUN_KEY}`
  await makeEligibleSacred({
    themeCode: theme,
    contentType: 'CHANT',
    externalAiPolicy: 'METADATA_ONLY',
    durationHintSeconds: 20,
  })
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'CHANT' }),
  ])
  return serviceId
}

/** A human-audio fixture whose single CONTENT window is long enough to
 * split into several presentational sub-scenes. */
let sharedAudioService: { serviceId: number; audioVersionId: number } | null =
  null
async function ensureAudioService(): Promise<{
  serviceId: number
  audioVersionId: number
}> {
  if (sharedAudioService) return sharedAudioService
  const serviceId = nextService()
  const theme = `H13_AUDSHARE_${RUN_KEY}`
  const sacred = await makeEligibleSacred({
    themeCode: theme,
    voicePolicy: 'HUMAN_RECORDED_REQUIRED',
    durationHintSeconds: 20,
  })
  const audio = await makeEligibleMedia({
    assetKind: 'AUDIO',
    language: 'en',
    sourceType: 'HUMAN_RECORDED',
    durationSeconds: 20,
  })
  await createSacredMediaLink(adminId, ctx, {
    contentVersionId: sacred.versionId,
    mediaAssetVersionId: audio.versionId,
    role: 'PRIMARY_AUDIO',
  })
  await makeEligibleMedia({
    assetKind: 'IMAGE',
    contentType: 'PRAYER',
    themeCode: theme,
  })
  await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
  sharedAudioService = { serviceId, audioVersionId: audio.versionId }
  return sharedAudioService
}

/** Plans a job end-to-end and asserts it starts out completely VALID. */
async function planAndAssertValid(
  serviceId: number,
  workerId: string,
): Promise<{ jobId: number; appointmentId: number }> {
  const created = await makeStoryboardReadyJob(serviceId)
  const outcome = await runStoryboardPlanningOnce(workerId, {
    now: () => new Date(),
  })
  expect(outcome.status).toBe('PLANNED')
  expect((await loadAndValidateGenerationManifest(created.jobId)).status).toBe(
    'VALID',
  )
  return created
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-step13-hardening-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'H13\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'H13\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'H13\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `H13H_${key}`.toUpperCase(),
    name: `H13 House ${key}`,
    slug: `h13h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 16; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `H13S${i}_${key}`.toUpperCase(),
      name: `H13 Service ${i} ${key}`,
      slug: `h13s${i}-${key}`,
      serviceStatus: 'PUBLISHED',
      durationMinutes: 60,
      priceMinor: 500_000,
      currency: 'NGN',
    })
    servicePool.push(inserted[0].insertId)
  }

  await getOrCreateBookingSettings(houseId)
  await updateBookingSettings(adminId, ctx, houseId, {
    schedulingTimezone: HOUSE_TZ,
    bookingEnabled: true,
    slotIncrementMinutes: 30,
    minimumLeadMinutes: 1440,
    maximumAdvanceDays: 90,
    reservationHoldMinutes: 15,
    cancellationCutoffMinutes: 1440,
    rescheduleCutoffMinutes: 1440,
  })
  for (let day = 1; day <= 7; day++) {
    await addAvailabilityWindow(adminId, ctx, houseId, {
      dayOfWeek: day,
      startLocalTime: '09:00',
      endLocalTime: '17:00',
    })
  }

  // Published Visual Bible for the House (generated scenes require it).
  const bible = await createVisualBible(cmId, ctx, houseId)
  createdBibleIds.push(bible.id)
  const bibleVersion = await createVisualBibleVersion(cmId, ctx, bible.id, {
    rules: [
      {
        category: 'ENVIRONMENT',
        position: 1,
        ruleText: 'Synthetic test rule: riverside at dawn.',
      },
      {
        category: 'PROHIBITED_IMAGERY',
        position: 2,
        ruleText: 'Synthetic test rule: no modern logos.',
      },
    ],
  })
  await submitVisualBibleVersion(cmId, ctx, bibleVersion.id)
  await approveVisualBibleVersion(adminId, ctx, bibleVersion.id)
  await publishVisualBibleVersion(adminId, ctx, bibleVersion.id)
})

afterAll(async () => {
  const db = getDb()
  if (houseId) {
    const apptRows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.sacredHouseId, houseId))
    const apptIds = apptRows.map((row) => row.id)
    if (apptIds.length > 0) {
      const jobs = await db
        .select({ id: prayerGenerationJobs.id })
        .from(prayerGenerationJobs)
        .where(inArray(prayerGenerationJobs.appointmentId, apptIds))
      const jobIds = jobs.map((row) => row.id)
      if (jobIds.length > 0) {
        await db
          .delete(prayerGenerationManifestSnapshots)
          .where(
            inArray(prayerGenerationManifestSnapshots.generationJobId, jobIds),
          )
        await db
          .delete(prayerGenerationStoryboardSnapshots)
          .where(
            inArray(
              prayerGenerationStoryboardSnapshots.generationJobId,
              jobIds,
            ),
          )
        await db
          .delete(prayerGenerationJobEvents)
          .where(inArray(prayerGenerationJobEvents.generationJobId, jobIds))
        await db
          .delete(prayerGenerationRecipeSnapshots)
          .where(
            inArray(prayerGenerationRecipeSnapshots.generationJobId, jobIds),
          )
        await db
          .delete(prayerGenerationJobs)
          .where(inArray(prayerGenerationJobs.id, jobIds))
      }
      await db
        .delete(appointmentGuidanceAssignments)
        .where(inArray(appointmentGuidanceAssignments.appointmentId, apptIds))
      await db
        .delete(appointmentGuidanceSets)
        .where(inArray(appointmentGuidanceSets.appointmentId, apptIds))
      await db.delete(appointments).where(inArray(appointments.id, apptIds))
    }
    if (createdTemplateIds.length > 0) {
      const versionRows = await db
        .select({ id: prayerSessionTemplateVersions.id })
        .from(prayerSessionTemplateVersions)
        .where(
          inArray(prayerSessionTemplateVersions.templateId, createdTemplateIds),
        )
      const versionIds = versionRows.map((row) => row.id)
      if (versionIds.length > 0) {
        const slotRows = await db
          .select({ id: prayerSessionTemplateSlots.id })
          .from(prayerSessionTemplateSlots)
          .where(
            inArray(prayerSessionTemplateSlots.templateVersionId, versionIds),
          )
        const slotIds = slotRows.map((row) => row.id)
        if (slotIds.length > 0) {
          await db
            .delete(prayerTemplateSlotPins)
            .where(inArray(prayerTemplateSlotPins.slotId, slotIds))
          await db
            .delete(prayerTemplateSlotScopes)
            .where(inArray(prayerTemplateSlotScopes.slotId, slotIds))
          await db
            .delete(prayerSessionTemplateSlots)
            .where(inArray(prayerSessionTemplateSlots.id, slotIds))
        }
        await db
          .delete(prayerTemplateForbiddenPairs)
          .where(
            inArray(prayerTemplateForbiddenPairs.templateVersionId, versionIds),
          )
        await db
          .delete(prayerSessionTemplateVersions)
          .where(inArray(prayerSessionTemplateVersions.id, versionIds))
      }
      await db
        .delete(prayerSessionTemplates)
        .where(inArray(prayerSessionTemplates.id, createdTemplateIds))
    }
    if (createdAssetIds.length > 0) {
      const versionRows = await db
        .select({ id: mediaAssetVersions.id })
        .from(mediaAssetVersions)
        .where(inArray(mediaAssetVersions.assetId, createdAssetIds))
      const versionIds = versionRows.map((row) => row.id)
      if (versionIds.length > 0) {
        await db
          .delete(sacredContentMediaLinks)
          .where(
            inArray(sacredContentMediaLinks.mediaAssetVersionId, versionIds),
          )
        await db
          .delete(mediaAssetVersions)
          .where(inArray(mediaAssetVersions.id, versionIds))
      }
      await db
        .delete(mediaAssets)
        .where(inArray(mediaAssets.id, createdAssetIds))
    }
    if (createdBibleIds.length > 0) {
      const bibleVersions = await db
        .select({ id: visualBibleVersions.id })
        .from(visualBibleVersions)
        .where(inArray(visualBibleVersions.visualBibleId, createdBibleIds))
      const bibleVersionIds = bibleVersions.map((row) => row.id)
      if (bibleVersionIds.length > 0) {
        await db
          .delete(visualBibleRules)
          .where(inArray(visualBibleRules.bibleVersionId, bibleVersionIds))
        await db
          .delete(visualBibleVersions)
          .where(inArray(visualBibleVersions.id, bibleVersionIds))
      }
      await db
        .delete(visualBibles)
        .where(inArray(visualBibles.id, createdBibleIds))
    }
    if (createdItemIds.length > 0) {
      await db
        .delete(sacredContentVersionProfiles)
        .where(
          inArray(sacredContentVersionProfiles.contentItemId, createdItemIds),
        )
      await db
        .delete(spiritualContentVersions)
        .where(inArray(spiritualContentVersions.contentItemId, createdItemIds))
      await db
        .delete(spiritualContentItems)
        .where(inArray(spiritualContentItems.id, createdItemIds))
    }
    await db
      .delete(sacredHouseAvailability)
      .where(eq(sacredHouseAvailability.sacredHouseId, houseId))
    await db
      .delete(sacredHouseBookingSettings)
      .where(eq(sacredHouseBookingSettings.sacredHouseId, houseId))
    await db.delete(services).where(eq(services.sacredHouseId, houseId))
    await db.delete(sacredHouses).where(eq(sacredHouses.id, houseId))
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  resetMediaStorageForTests()
  try {
    rmSync(storageRoot, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
  await closeDb()
})

// ----------------------------------------------------------------------------

describe('split CONTENT windows keep ONE full-segment audio requirement', () => {
  it('a ~100s segment splits into sub-scenes but its audio still spans the WHOLE segment', async () => {
    const serviceId = nextService()
    const theme = `H13_SPLITAUD_${RUN_KEY}`
    const sacred = await makeEligibleSacred({
      themeCode: theme,
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
      durationHintSeconds: 100,
    })
    // The recipe takes its window from the linked recording's duration.
    const audio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      language: 'en',
      sourceType: 'HUMAN_RECORDED',
      durationSeconds: 100,
    })
    await createSacredMediaLink(adminId, ctx, {
      contentVersionId: sacred.versionId,
      mediaAssetVersionId: audio.versionId,
      role: 'PRIMARY_AUDIO',
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId } = await planAndAssertValid(serviceId, 'h13-splitaud')

    const loaded = await loadGenerationStoryboardSnapshot(jobId)
    if (loaded.status !== 'OK') throw new Error('expected a storyboard')
    const scenes = loaded.storyboard.scenes.filter(
      (scene) => scene.recipeSegmentIndex === 0,
    )
    // A purely PRESENTATIONAL split of one 100s recipe segment.
    expect(scenes.length).toBe(Math.ceil(100_000 / MAX_SCENE_MS))
    expect(scenes.length).toBeGreaterThan(1)
    expect(scenes[0].startMs).toBe(0)
    expect(scenes.at(-1)!.endMs).toBe(100_000)

    // Splitting never duplicates the requirement…
    const voiced = scenes.filter((scene) => scene.audio.mode !== 'NONE')
    expect(voiced.length).toBe(1)
    expect(voiced[0].audio.mode).toBe('EXISTING_HUMAN_AUDIO')
    expect(voiced[0].audio.mediaAssetVersionId).toBe(audio.versionId)
    // …and the recording covers the FULL segment, not one sub-scene.
    expect(voiced[0].durationMs).toBeLessThan(100_000)
    expect(voiced[0].audio.segmentStartMs).toBe(0)
    expect(voiced[0].audio.segmentEndMs).toBe(100_000)
    for (const scene of scenes.filter((s) => s.audio.mode === 'NONE')) {
      expect(scene.audio.segmentStartMs).toBeNull()
      expect(scene.audio.segmentEndMs).toBeNull()
    }

    const manifest = await loadGenerationManifestSnapshot(jobId)
    if (manifest.status !== 'OK') throw new Error('expected a manifest')
    const requirements = manifest.manifest.audioRequirements.filter(
      (requirement) => requirement.sceneId.startsWith('s0-'),
    )
    expect(requirements.length).toBe(1)
    expect(requirements[0].startMs).toBe(0)
    expect(requirements[0].endMs).toBe(100_000)
    expect(requirements[0].endMs - requirements[0].startMs).toBe(100_000)
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )
    // No sacred body ever reaches a persisted planning payload.
    expect(
      JSON.stringify([await storyboardRows(jobId), await manifestRows(jobId)]),
    ).not.toContain(SACRED_BODY_MARKER)
  }, 300_000)
})

describe('checksum-valid but semantically corrupt snapshots fail closed', () => {
  it('an audio binding that no longer matches authority is INVALID', async () => {
    const { serviceId } = await ensureAudioService()
    const { jobId } = await planAndAssertValid(serviceId, 'h13-audbind')

    const storyboard = await rewriteStoryboardSnapshot(jobId, (sb) => {
      const scene = sb.scenes.find((s) => s.audio.mode !== 'NONE')
      if (!scene) throw new Error('expected a voiced scene')
      scene.audio.mediaAssetVersionId = scene.audio.mediaAssetVersionId! + 1_000
    })
    const sceneId = storyboard.scenes.find(
      (s) => s.audio.mode !== 'NONE',
    )!.sceneId
    await resyncManifestToStoryboard(jobId, storyboard)

    // Every checksum still recomputes exactly — nothing is "tampered".
    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe('OK')
    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe('OK')
    // But the audio no longer binds to the approved recording.
    const validated = await loadAndValidateGenerationManifest(jobId)
    expect(validated.status).toBe('INVALID')
    if (validated.status !== 'INVALID') return
    expect(validated.reasons).toContain(`audio_binding:${sceneId}`)
  }, 300_000)

  it('an audio window that no longer covers its segment is INVALID', async () => {
    const { serviceId } = await ensureAudioService()
    const { jobId } = await planAndAssertValid(serviceId, 'h13-audwin')

    const before = await loadGenerationManifestSnapshot(jobId)
    if (before.status !== 'OK') throw new Error('expected a manifest')
    const sceneId = before.manifest.audioRequirements[0].sceneId
    await rewriteManifestSnapshot(jobId, (manifest) => {
      const requirement = manifest.audioRequirements[0]
      // A window that no longer covers the recipe segment it voices.
      requirement.endMs = requirement.startMs + 1
    })

    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe('OK')
    const validated = await loadAndValidateGenerationManifest(jobId)
    expect(validated.status).toBe('INVALID')
    if (validated.status !== 'INVALID') return
    expect(validated.reasons).toContain(`audio_window:${sceneId}`)
  }, 300_000)

  it('a generation intent bound to the wrong content identity is INVALID', async () => {
    const serviceId = await makeGenerationService('INTENT')
    const { jobId } = await planAndAssertValid(serviceId, 'h13-intent')

    const storyboard = await rewriteStoryboardSnapshot(jobId, (sb) => {
      const scene = sb.scenes.find((s) => s.generationIntent != null)
      if (!scene) throw new Error('expected a generated scene')
      // Bible binding, hashes and task keys stay perfect: only the
      // sacred content this scene claims to depict is swapped.
      scene.generationIntent!.contentVersionId += 1_000
    })
    const sceneId = storyboard.scenes.find(
      (s) => s.generationIntent != null,
    )!.sceneId
    await resyncManifestToStoryboard(jobId, storyboard)

    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe('OK')
    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe('OK')
    const validated = await loadAndValidateGenerationManifest(jobId)
    expect(validated.status).toBe('INVALID')
    if (validated.status !== 'INVALID') return
    expect(validated.reasons).toContain(`intent_content_binding:${sceneId}`)
  }, 300_000)

  it('a leading CONTENT HOLD_PREVIOUS scene is INVALID (nothing to hold)', async () => {
    const { serviceId } = await ensureAudioService()
    const { jobId } = await planAndAssertValid(serviceId, 'h13-leadhold')

    const storyboard = await rewriteStoryboardSnapshot(jobId, (sb) => {
      expect(sb.scenes[0].kind).toBe('CONTENT')
      expect(sb.scenes[0].recipeSegmentIndex).toBe(0)
      // The whole leading CONTENT segment now claims to hold a visual
      // that no earlier scene ever established.
      for (const scene of sb.scenes.filter((s) => s.recipeSegmentIndex === 0)) {
        scene.sourceMode = 'HOLD_PREVIOUS'
        scene.mediaAssetVersionId = null
        scene.mediaAssetId = null
        scene.mediaFileSha256 = null
        scene.mediaAssetKind = null
      }
    })
    await resyncManifestToStoryboard(jobId, storyboard)

    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe('OK')
    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe('OK')
    const validated = await loadAndValidateGenerationManifest(jobId)
    expect(validated.status).toBe('INVALID')
    if (validated.status !== 'INVALID') return
    expect(validated.reasons).toContain('leading_hold_previous')
  }, 300_000)

  it('an older or unknown persisted schema version is an INTEGRITY_FAILURE', async () => {
    const serviceId = await makeApprovedMediaService('SCHEMA')
    const { jobId } = await planAndAssertValid(serviceId, 'h13-schema')

    // An unknown version is fatal however perfect its checksums are.
    await rewriteStoryboardSnapshot(jobId, (sb) => {
      sb.schemaVersion = 'storyboard-v0-unknown'
    })
    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    await rewriteStoryboardSnapshot(jobId, (sb) => {
      sb.schemaVersion = STORYBOARD_SCHEMA_VERSION
    })
    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe('OK')

    // A perfectly checksummed payload from the PREVIOUS schema must
    // never be reinterpreted by the current loader either.
    await rewriteStoryboardSnapshot(jobId, (sb) => {
      sb.schemaVersion = 'storyboard-v1'
    })
    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    await rewriteStoryboardSnapshot(jobId, (sb) => {
      sb.schemaVersion = STORYBOARD_SCHEMA_VERSION
    })
    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe('OK')

    await rewriteManifestSnapshot(jobId, (manifest) => {
      manifest.schemaVersion = 'manifest-v1'
    })
    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    // An entirely unknown version is equally fatal — never healed.
    await rewriteManifestSnapshot(jobId, (manifest) => {
      manifest.schemaVersion = 'manifest-v0-unknown'
    })
    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )

    // Step 13 hardening reshapes both payloads → both versions bump.
    expect(STORYBOARD_SCHEMA_VERSION).toBe('storyboard-v2')
    expect(MANIFEST_SCHEMA_VERSION).toBe('manifest-v2')
  }, 300_000)
})

describe('the builder fails closed on impossible recipes', () => {
  it('a leading CONTENT segment with nothing to hold is GOVERNANCE_IMPOSSIBLE', async () => {
    const serviceId = await makeApprovedMediaService('HOLDREC')
    const { jobId, appointmentId } = await makeStoryboardReadyJob(serviceId)

    await rewriteRecipeSnapshot(jobId, (recipe) => {
      const segment = recipe.segments[0]
      expect(segment.kind).toBe('CONTENT')
      segment.visual = null
      segment.visualMode = 'HOLD_PREVIOUS'
      segment.generation = null
    })
    // The recipe still passes CURRENT Step 11 authority…
    expect((await loadAndValidateGenerationRecipe(jobId)).status).toBe('VALID')
    // …but the very first scene would hold a visual that never existed.
    const built = await buildValidatedGenerationStoryboard(jobId)
    expect(built.status).toBe('GOVERNANCE_IMPOSSIBLE')
    if (built.status === 'GOVERNANCE_IMPOSSIBLE') {
      expect(built.reasons).toContain('leading_hold_previous')
    }

    // The worker fails the job closed and persists NOTHING.
    await quiesceOtherJobs(jobId)
    const outcome = await runStoryboardPlanningOnce('h13-holdrec', {
      now: () => new Date(),
    })
    expect(outcome.status).toBe('FAILED')
    const job = (await jobForAppointment(appointmentId))!
    expect(job.status).toBe('FAILED')
    expect(job.lastErrorCode).toBe('GOVERNANCE_IMPOSSIBLE')
    expect((await storyboardRows(jobId)).length).toBe(0)
    expect((await manifestRows(jobId)).length).toBe(0)
  }, 300_000)

  it('a generation descriptor with no content identity is GOVERNANCE_IMPOSSIBLE', async () => {
    const serviceId = await makeGenerationService('GENID')
    const { jobId } = await makeStoryboardReadyJob(serviceId)

    await rewriteRecipeSnapshot(jobId, (recipe) => {
      const segment = recipe.segments.find((s) => s.generation != null)
      if (!segment) throw new Error('expected a generation descriptor')
      // A generated scene that cannot say WHICH approved sacred text it
      // depicts must never become a paid generation task.
      segment.contentVersionId = null
      segment.contentSha256 = null
    })
    expect((await loadAndValidateGenerationRecipe(jobId)).status).toBe('VALID')

    const built = await buildValidatedGenerationStoryboard(jobId)
    expect(built.status).toBe('GOVERNANCE_IMPOSSIBLE')
    if (built.status === 'GOVERNANCE_IMPOSSIBLE') {
      expect(built.reasons).toContain('generation_missing_content_identity')
    }
    expect((await storyboardRows(jobId)).length).toBe(0)
    expect((await manifestRows(jobId)).length).toBe(0)
  }, 300_000)

  it('a segment claiming BOTH an approved visual and a generation descriptor is GOVERNANCE_IMPOSSIBLE', async () => {
    const serviceId = nextService()
    const visualTheme = `H13_INCOA_${RUN_KEY}`
    const generationTheme = `H13_INCOB_${RUN_KEY}`
    // Slot 1 resolves to an APPROVED library visual. Slot 2 is a CHANT
    // for which no library visual exists, so Step 11 emits a future
    // GENERATION descriptor instead.
    await makeEligibleSacred({
      themeCode: visualTheme,
      durationHintSeconds: 20,
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: visualTheme,
    })
    await makeEligibleSacred({
      themeCode: generationTheme,
      contentType: 'CHANT',
      externalAiPolicy: 'METADATA_ONLY',
      durationHintSeconds: 20,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({
        slotKey: 'MAIN_PRAYER',
        position: 1,
        themeCode: visualTheme,
      }),
      filterSlot({
        slotKey: 'CLOSING_PRAYER',
        position: 2,
        themeCode: generationTheme,
        contentType: 'CHANT',
      }),
    ])
    const { jobId } = await makeStoryboardReadyJob(serviceId)

    await rewriteRecipeSnapshot(jobId, (recipe) => {
      // Two CONTENT segments: only the SECOND is corrupted, so the
      // leading-scene rule cannot mask this reason.
      expect(recipe.segments.length).toBeGreaterThanOrEqual(2)
      const approved = recipe.segments.find((s) => s.visual != null)
      const generated = recipe.segments.find((s) => s.generation != null)
      if (!approved?.visual || !generated) {
        throw new Error('expected an approved visual AND a generation segment')
      }
      // ONE segment now claims BOTH an already-approved visual source
      // AND a future paid generation task. No coherent source can be
      // chosen for it, and nothing may be invented to break the tie.
      generated.visual = approved.visual
      // This combination only survives CURRENT Step 11/12 authority when
      // the segment carries no content identity — an identified segment
      // is refused earlier as generation_mode_inconsistent.
      generated.contentVersionId = null
      generated.contentSha256 = null
    })
    expect((await loadAndValidateGenerationRecipe(jobId)).status).toBe('VALID')

    const built = await buildValidatedGenerationStoryboard(jobId)
    expect(built.status).toBe('GOVERNANCE_IMPOSSIBLE')
    if (built.status === 'GOVERNANCE_IMPOSSIBLE') {
      expect(built.reasons).toContain('incoherent_scene_source')
    }
    expect((await storyboardRows(jobId)).length).toBe(0)
    expect((await manifestRows(jobId)).length).toBe(0)
  }, 300_000)
})

describe('lease time and attempt accounting are read under the lock', () => {
  it('a storyboard claim grants a lease derived from the POST-lock reading', async () => {
    const serviceId = await makeApprovedMediaService('CLAIM')
    const { jobId } = await makeStoryboardReadyJob(serviceId)

    const t0 = Date.now()
    const clock = makeFakeClock(t0)
    const ADVANCE_MS = 90_000

    const release = await holdJobsTableLock()
    let claimed: Awaited<ReturnType<typeof claimNextStoryboardJob>> = null
    let stillBlocked = false
    try {
      // The claim blocks before it can read ANY job row…
      let finished = false
      const pending = settle(
        claimNextStoryboardJob('h13-postlock', clock),
      ).then((result) => {
        finished = true
        return result
      })
      await sleep(400)
      stillBlocked = !finished
      // …and the world moves on while it waits.
      clock.advance(ADVANCE_MS)
      await release()
      const settled = await pending
      if (!settled.ok) throw settled.error
      claimed = settled.value
    } finally {
      await release()
    }

    expect(claimed?.job.id).toBe(jobId)
    const row = await jobRow(jobId)
    expect(row.leaseToken).toBe(claimed!.leaseToken)
    expect(row.leaseAcquiredAt).not.toBeNull()
    expect(row.leaseExpiresAt).not.toBeNull()
    const acquired = new Date(row.leaseAcquiredAt!).getTime()
    const expires = new Date(row.leaseExpiresAt!).getTime()
    // The grant derives from the time read AFTER the row lock…
    expect(Math.abs(acquired - (t0 + ADVANCE_MS))).toBeLessThanOrEqual(2_000)
    expect(Math.abs(expires - acquired - DEFAULT_LEASE_MS)).toBeLessThanOrEqual(
      1_000,
    )
    // …never from the stale pre-lock reading, which would have granted
    // a lease that is already most of the way to expiry.
    expect(expires).toBeGreaterThan(t0 + DEFAULT_LEASE_MS + ADVANCE_MS / 2)
    // The scenario is only meaningful if the claim really waited.
    expect(stillBlocked).toBe(true)
  }, 300_000)

  it('the retry path re-reads attempt accounting under the lock', async () => {
    const serviceId = await makeApprovedMediaService('RETRY')
    const { jobId, appointmentId } = await makeStoryboardReadyJob(serviceId)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ maxAttempts: 8, attemptCount: 0 })
      .where(eq(prayerGenerationJobs.id, jobId))

    const clock = makeFakeClock(Date.now())
    const claimed = await claimNextStoryboardJob('h13-race', clock.now())
    expect(claimed?.job.id).toBe(jobId)
    expect(claimed!.job.attemptCount).toBe(0)

    // A concurrent recovery/operator bumps the attempt count while this
    // worker still holds the lease: the worker's in-memory row is now
    // stale and must NOT be written back.
    await getDb()
      .update(prayerGenerationJobs)
      .set({ attemptCount: 3 })
      .where(eq(prayerGenerationJobs.id, jobId))

    const outcome = await scheduleRetryOrFail(
      claimed!.job,
      claimed!.leaseToken,
      clock,
      'SYNTHETIC_RACE',
      null,
      'STORYBOARDING',
    )
    expect(outcome).toBe('RETRYING')

    const row = (await jobForAppointment(appointmentId))!
    expect(row.status).toBe('RETRYING')
    expect(row.resumeStatus).toBe('STORYBOARDING')
    // Accounting continues from the CURRENT row, never from the stale
    // copy (which would have rewritten 3 back down to 1).
    expect(row.attemptCount).toBe(4)
    // …and the deterministic backoff derives from the re-read count.
    const expectedDelayMs = RETRY_SCHEDULE_MINUTES[3] * 60_000
    const staleDelayMs = RETRY_SCHEDULE_MINUTES[0] * 60_000
    expect(expectedDelayMs).not.toBe(staleDelayMs)
    expect(row.nextAttemptAt).not.toBeNull()
    expect(
      Math.abs(
        new Date(row.nextAttemptAt!).getTime() -
          (clock.now().getTime() + expectedDelayMs),
      ),
    ).toBeLessThanOrEqual(2_000)
  }, 300_000)

  it('expired-lease recovery derives nextAttemptAt from the POST-lock reading', async () => {
    const serviceId = await makeApprovedMediaService('RECOVER')
    const { jobId, appointmentId } = await makeStoryboardReadyJob(serviceId)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ maxAttempts: 8, attemptCount: 0 })
      .where(eq(prayerGenerationJobs.id, jobId))

    const t0 = Date.now()
    const clock = makeFakeClock(t0)
    const claimed = await claimNextStoryboardJob('h13-recover', clock.now())
    expect(claimed?.job.id).toBe(jobId)
    clock.advance(DEFAULT_LEASE_MS + 60_000)
    const expiredAt = clock.now().getTime()
    const ADVANCE_MS = 90_000

    const release = await holdJobsTableLock()
    let recovered = 0
    let stillBlocked = false
    try {
      let finished = false
      const pending = settle(recoverExpiredGenerationLeases(clock)).then(
        (result) => {
          finished = true
          return result
        },
      )
      await sleep(400)
      stillBlocked = !finished
      clock.advance(ADVANCE_MS)
      await release()
      const settled = await pending
      if (!settled.ok) throw settled.error
      recovered = settled.value
    } finally {
      await release()
    }

    expect(recovered).toBeGreaterThanOrEqual(1)
    const row = (await jobForAppointment(appointmentId))!
    expect(row.status).toBe('RETRYING')
    expect(row.resumeStatus).toBe('STORYBOARDING')
    expect(row.attemptCount).toBe(1)
    expect(row.lastErrorCode).toBe('LEASE_EXPIRED')
    expect(row.nextAttemptAt).not.toBeNull()
    const delayMs = RETRY_SCHEDULE_MINUTES[0] * 60_000
    const due = new Date(row.nextAttemptAt!).getTime()
    expect(
      Math.abs(due - (expiredAt + ADVANCE_MS + delayMs)),
    ).toBeLessThanOrEqual(2_000)
    expect(due).toBeGreaterThan(expiredAt + delayMs + ADVANCE_MS / 2)
    // The scenario is only meaningful if recovery really waited.
    expect(stillBlocked).toBe(true)
  }, 300_000)
})

describe('hardening guards', () => {
  it('the hardened modules still call no provider, TTS, render tool or broker', () => {
    const files = [
      'src/services/generation-storyboards.ts',
      'src/services/generation-jobs.ts',
    ]
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(ioredis|redis|bullmq|amqplib|kafkajs)/i,
      )
      expect(source).not.toMatch(
        /https?:\/\/[^'"\s]*(kling|openart|elevenlabs|openai|anthropic)/i,
      )
      expect(source).not.toMatch(
        /import[^\n]*(remotion|ffmpeg|elevenlabs|openai|@anthropic)/i,
      )
      expect(source).not.toMatch(
        /texttospeech|speechSynthesis|generateImage|generateVideo|renderVideo|cloneVoice/i,
      )
      // Determinism: no ambient randomness and no ambient wall clock —
      // every time reading arrives through the injected clock.
      expect(source).not.toMatch(/Math\.random\s*\(/)
      expect(source).not.toMatch(/Date\.now\s*\(/)
    }
  })

  it('no job reaches READY through any hardened path', async () => {
    const ready = await getDb()
      .select({ id: prayerGenerationJobs.id })
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.status, 'READY'))
    expect(ready.length).toBe(0)
  })
})
