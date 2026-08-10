import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  appointmentGuidanceAssignments,
  appointmentGuidanceSets,
  appointments,
  auditLogs,
  mediaAssetVersions,
  mediaAssets,
  prayerGenerationAudioTasks,
  prayerGenerationJobEvents,
  prayerGenerationJobs,
  prayerGenerationManifestSnapshots,
  prayerGenerationRecipeSnapshots,
  prayerGenerationRenderPlans,
  prayerGenerationRenderResults,
  prayerGenerationStoryboardSnapshots,
  prayerGenerationVisualTasks,
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
  computeFileSha256,
  resetMediaStorageForTests,
  setMediaStorageForTests,
} from '@/providers/media/storage'
import {
  approveMediaVersion,
  createMediaAsset,
  createMediaVersion,
  createSacredMediaLink,
  publishMediaVersion,
  removeSacredMediaLink,
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
  AUDIO_TASK_POLL_DELAY_MS,
  DEFAULT_LEASE_MS,
  GENERATION_TRANSITIONS,
  VISUAL_TASK_POLL_DELAY_MS,
  isLegalTransition,
  recoverExpiredGenerationLeases,
  runAudioGenerationOnce,
  runGenerationPreparationOnce,
  runVisualGenerationOnce,
} from '@/services/generation-jobs'
import { runStoryboardPlanningOnce } from '@/services/generation-storyboards'
import {
  MAX_RENDER_MS,
  buildRenderPlan,
  buildValidatedRenderPlan,
  verifyCompletedRender,
  computeRenderIdempotencyKey,
  computeRenderPlanSha256,
  loadRenderPlanSnapshot,
  runRenderOnce,
} from '@/services/render-assembly'
import {
  checkRenderEngineAllowed,
  resetRenderEngineForTests,
  setRenderEngineForTests,
} from '@/providers/render/registry'
import {
  MOCK_RENDER_MAGIC_HEADER,
  createMockRenderEngine,
} from '@/providers/render/mock'
import {
  resetTtsProviderForTests,
  setTtsProviderForTests,
} from '@/providers/tts/registry'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { GenerationClock } from '@/services/generation-jobs'
import type {
  GenerationManifest,
  GenerationStoryboard,
} from '@/services/generation-storyboards'
import type { MediaStorageProvider } from '@/providers/media/storage'
import type { RenderEngine } from '@/providers/render/types'
import type { AudioDurationProbe } from '@/providers/render/media-probe'
import type {
  SpeechPollResult,
  SpeechSynthesisRequest,
  SpeechSynthesisSubmission,
  TtsProvider,
} from '@/providers/tts/types'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * ============================================================================
 * RED TEAM — Phase One, Step 16 (render assembly), verified against landed
 * source: src/db/schema/rendering.ts, src/services/render-assembly.ts and
 * src/providers/render/{types,mock,registry}.ts.
 *
 * The properties this suite exists to defend:
 *   1. sacred audio is NEVER truncated, stretched, looped or replaced —
 *      the timeline bends around it, not the other way round;
 *   2. every scene resolves EXACTLY once to approved media, a verified
 *      generated artifact, or a held previous visual — nothing is
 *      invented, and a leading HOLD_PREVIOUS fails closed;
 *   3. a missing, tampered or withdrawn source means NO RENDER; and
 *   4. a MOCK render can never be walked forward as if it were a
 *      deliverable.
 *
 * File-local prefix RTR_ so this file's fixtures never collide with the
 * RTV_/RTW_/RTA_ suites.
 * ============================================================================
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `redteam render test passphrase ${crypto.randomUUID()}`
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
const CODE_PREFIX = `RTR_${RUN_KEY}`
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

function makeFakeClock(startMs: number): GenerationClock & {
  advance: (ms: number) => void
} {
  let t = startMs
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function syntheticBytes(marker: string = crypto.randomUUID()): Uint8Array {
  return new TextEncoder().encode(`redteam-render-bytes ${marker}`)
}

const PERSONAL_NAME_MARKER = 'Adéwálé Olúṣọlá Adébáyọ̀'
const PERSONAL_PHONE_MARKER = '+2348012345678'

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `rtr-${crypto.randomUUID()}@test.local`,
      preferredName: 'RTR Fixture',
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
      fullName: PERSONAL_NAME_MARKER,
      preferredName: 'Adéwálé',
      phone: PERSONAL_PHONE_MARKER,
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
    durationHintSeconds: 10,
    repeatable: false,
    voicePolicy: 'TEXT_ONLY',
    externalAiPolicy: 'METADATA_ONLY',
    accessPolicy: 'PRAYER_ROOM_PRIVATE',
    ...overrides,
  }
}

const SACRED_BODY_MARKER = 'Red-team-render sacred block body'

async function makeEligibleSacred(options: {
  themeCode: string
  contentType?: 'PRAYER' | 'CHANT' | 'BLESSING'
  voicePolicy?: 'TEXT_ONLY' | 'APPROVED_TTS_ALLOWED' | 'HUMAN_RECORDED_REQUIRED'
  durationHintSeconds?: number
}): Promise<{ itemId: number; versionId: number; bodyMarker: string }> {
  const bodyMarker = `${SACRED_BODY_MARKER} ${crypto.randomUUID()}`
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
    { language: 'en', title: 'Red-team render sacred block', body: bodyMarker },
    sacredProfile({
      themeCode: options.themeCode,
      voicePolicy: options.voicePolicy ?? 'APPROVED_TTS_ALLOWED',
      durationHintSeconds: options.durationHintSeconds ?? 10,
    }),
  )
  await submitVersionForReview(cmId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, version.id, true)
  return { itemId: item.id, versionId: version.id, bodyMarker }
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
  sourceType?: 'IN_HOUSE' | 'HUMAN_RECORDED' | 'LICENSED'
  language?: 'en' | 'yo' | null
  durationSeconds?: number | null
}): Promise<{ assetId: number; versionId: number; fileSha256: string }> {
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
      durationSeconds:
        options.durationSeconds !== undefined
          ? options.durationSeconds
          : assetKind === 'AUDIO'
            ? 10
            : null,
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
  const row = (
    await getDb()
      .select({ fileSha256: mediaAssetVersions.fileSha256 })
      .from(mediaAssetVersions)
      .where(eq(mediaAssetVersions.id, version.id))
      .limit(1)
  ).at(0)!
  return { assetId: asset.id, versionId: version.id, fileSha256: row.fileSha256 }
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
    targetMinSeconds: 5,
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

async function renderPlanRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationRenderPlans)
    .where(eq(prayerGenerationRenderPlans.generationJobId, jobId))
}

async function renderResultRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationRenderResults)
    .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
}

/** Cancels every OTHER non-terminal job table-wide: the render claim
 * queue is a GLOBAL FIFO and RENDERING is where every earlier suite's
 * finished jobs come to rest. */
async function quiesceOtherJobs(exceptJobId: number): Promise<void> {
  await getDb()
    .update(prayerGenerationJobs)
    .set({ status: 'CANCELLED', leaseToken: null, leaseExpiresAt: null })
    .where(
      inArray(prayerGenerationJobs.status, [
        'QUEUED',
        'RETRYING',
        'STORYBOARDING',
        'GENERATING_VISUALS',
        'GENERATING_AUDIO',
        'RENDERING',
      ]),
    )
  await getDb()
    .update(prayerGenerationJobs)
    .set({ status: 'QUEUED' })
    .where(eq(prayerGenerationJobs.id, exceptJobId))
}

async function latestManifest(jobId: number): Promise<GenerationManifest> {
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationManifestSnapshots)
      .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
  ).at(-1)!
  return JSON.parse(row.manifestJsonText) as GenerationManifest
}

async function latestStoryboard(jobId: number): Promise<GenerationStoryboard> {
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationStoryboardSnapshots)
      .where(eq(prayerGenerationStoryboardSnapshots.generationJobId, jobId))
  ).at(-1)!
  return JSON.parse(row.storyboardJsonText) as GenerationStoryboard
}

/** A TTS provider whose artifact length deliberately differs from the
 * planned window — the only way to exercise timeline reconciliation,
 * since the deterministic mock always echoes the window exactly. */
function driftingTtsProvider(deltaMs: number): TtsProvider {
  const submitted = new Map<string, number>()
  return {
    code: 'MOCK_TTS',
    displayName: 'Red-team drifting TTS provider',
    isEnabled: () => true,
    submitSpeech: async (
      request: SpeechSynthesisRequest,
    ): Promise<SpeechSynthesisSubmission> => {
      const providerJobId = `drift-${request.idempotencyKey}`
      submitted.set(providerJobId, request.targetDurationMs)
      return { providerJobId, status: 'PENDING' }
    },
    pollSpeech: async (providerJobId: string): Promise<SpeechPollResult> => {
      const target = submitted.get(providerJobId)
      if (target == null) {
        return { status: 'FAILED', artifact: null, failureCode: 'unknown_job' }
      }
      return {
        status: 'COMPLETED',
        artifact: {
          bytes: new TextEncoder().encode(`drifted-speech-${providerJobId}`),
          mimeType: 'audio/mpeg',
          durationMs: Math.max(1, target + deltaMs),
        },
        failureCode: null,
      }
    },
  }
}

function syntheticStoryboardFor(
  scenes: Array<Partial<GenerationStoryboard['scenes'][number]>>,
): GenerationStoryboard {
  return {
    schemaVersion: 'storyboard-v1',
    generationJobId: 1,
    serviceId: 1,
    sacredHouseId: 1,
    language: 'en',
    variationSeed: 'a'.repeat(64),
    recipeSnapshotId: 1,
    recipeSnapshotNumber: 1,
    recipeSha256: 'b'.repeat(64),
    templateVersionId: 1,
    templateDefinitionSha256: 'c'.repeat(64),
    visualBibleVersionId: null,
    visualBibleVersionNumber: null,
    visualBibleSha256: null,
    scenes: scenes.map((scene, index) => ({
      sceneId: `s${index}`,
      order: index,
      recipeSegmentIndex: index,
      slotKey: 'MAIN_PRAYER',
      kind: 'CONTENT',
      contentVersionId: null,
      contentSha256: null,
      contentType: null,
      themeCode: null,
      startMs: index * 1000,
      endMs: (index + 1) * 1000,
      durationMs: 1000,
      segmentStartMs: index * 1000,
      segmentEndMs: (index + 1) * 1000,
      splitIndex: 0,
      splitCount: 1,
      sourceMode: 'HOLD_PREVIOUS',
      mediaAssetVersionId: null,
      mediaAssetId: null,
      mediaFileSha256: null,
      mediaAssetKind: null,
      generationIntent: null,
      audio: {
        mode: 'NONE',
        mediaAssetVersionId: null,
        fileSha256: null,
        contentVersionId: null,
        contentSha256: null,
        language: null,
        voicePolicy: null,
        requirementId: null,
      },
      bibleRuleRefs: [],
      ...scene,
    })),
    sceneCount: scenes.length,
    totalDurationMs: scenes.length * 1000,
    storyboardSha256: 'd'.repeat(64),
  }
}

function emptyManifestFor(): GenerationManifest {
  return {
  schemaVersion: 'manifest-v1',
  generationJobId: 1,
  storyboardSnapshotId: 1,
  storyboardSnapshotNumber: 1,
  storyboardSha256: 'd'.repeat(64),
  totalDurationMs: 1000,
  visualTasks: [],
  approvedMedia: [],
  audioRequirements: [],
    manifestSha256: 'e'.repeat(64),
  }
}


/** Wraps the suite storage and records every key minted during a run,
 * so an orphan-cleanup test can name the exact object and prove it is
 * gone rather than inferring it from a null column. */
function recordingStorage(
  keys: Array<string>,
  afterPut?: () => Promise<void>,
): MediaStorageProvider {
  return {
    put: async (bytes: Uint8Array, extension: string) => {
      const result = await storage.put(bytes, extension)
      keys.push(result.storageKey)
      if (afterPut) await afterPut()
      return result
    },
    get: (key: string) => storage.get(key),
    exists: (key: string) => storage.exists(key),
    remove: (key: string) => storage.remove(key),
  }
}

/**
 * Drives one appointment all the way to RENDERING through every real
 * upstream stage — Step 12 preparation, Step 13 planning, Step 14
 * visuals and Step 15 audio, all with their own deterministic mocks.
 * Nothing about the render stage is faked into place.
 */
async function driveToRendering(serviceId: number): Promise<{
  jobId: number
  appointmentId: number
  clock: ReturnType<typeof makeFakeClock>
}> {
  const userId = await makeEligibleUser()
  const reservation = await createReservation(userId, ctx, {
    serviceId,
    startsAtUtc: nextSlot(),
  })
  await confirmReservation(reservation.appointmentId, ctx)
  const job = (await jobForAppointment(reservation.appointmentId))!
  await quiesceOtherJobs(job.id)
  const clock = makeFakeClock(Date.now())
  expect((await runGenerationPreparationOnce('rtr-prep', clock)).status).toBe(
    'PREPARED',
  )
  expect((await runStoryboardPlanningOnce('rtr-plan', clock)).status).toBe(
    'PLANNED',
  )
  for (let cycle = 0; cycle < 8; cycle += 1) {
    if ((await jobRow(job.id)).status !== 'GENERATING_VISUALS') break
    const outcome = await runVisualGenerationOnce(`rtr-vis-${cycle}`, clock)
    if (outcome.status === 'WAITING') {
      clock.advance(VISUAL_TASK_POLL_DELAY_MS + 1_000)
    }
  }
  expect((await jobRow(job.id)).status).toBe('GENERATING_AUDIO')
  for (let cycle = 0; cycle < 8; cycle += 1) {
    if ((await jobRow(job.id)).status !== 'GENERATING_AUDIO') break
    const outcome = await runAudioGenerationOnce(`rtr-aud-${cycle}`, clock)
    if (outcome.status === 'WAITING') {
      clock.advance(AUDIO_TASK_POLL_DELAY_MS + 1_000)
    }
  }
  expect((await jobRow(job.id)).status).toBe('RENDERING')
  return { jobId: job.id, appointmentId: reservation.appointmentId, clock }
}

/** APPROVED_MEDIA still + one TTS segment — the simplest renderable
 * shape, and the one most tests use. */
async function makeRenderableJob(options: { audioDeltaMs?: number } = {}) {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_R_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  const sacred = await makeEligibleSacred({
    themeCode: theme,
    contentType: 'PRAYER',
    voicePolicy: 'APPROVED_TTS_ALLOWED',
  })
  const media = await makeEligibleMedia({
    assetKind: 'IMAGE',
    contentType: 'PRAYER',
    themeCode: theme,
  })
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
  ])
  if (options.audioDeltaMs != null) {
    setTtsProviderForTests(driftingTtsProvider(options.audioDeltaMs))
  }
  try {
    const driven = await driveToRendering(serviceId)
    return {
      ...driven,
      contentVersionId: sacred.versionId,
      bodyMarker: sacred.bodyMarker,
      mediaVersionId: media.versionId,
    }
  } finally {
    if (options.audioDeltaMs != null) resetTtsProviderForTests()
  }
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-redteam-render-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'RTR\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'RTR\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'RTR\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `RTRH_${key}`.toUpperCase(),
    name: `RTR House ${key}`,
    slug: `rtrh-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 40; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `RTRS${i}_${key}`.toUpperCase(),
      name: `RTR Service ${i} ${key}`,
      slug: `rtrs${i}-${key}`,
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

  const bible = await createVisualBible(cmId, ctx, houseId)
  createdBibleIds.push(bible.id)
  const bibleVersion = await createVisualBibleVersion(cmId, ctx, bible.id, {
    rules: [
      {
        category: 'ENVIRONMENT',
        position: 1,
        ruleText: 'Red-team render synthetic rule: riverside at dawn.',
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
          .delete(prayerGenerationRenderResults)
          .where(inArray(prayerGenerationRenderResults.generationJobId, jobIds))
        await db
          .delete(prayerGenerationRenderPlans)
          .where(inArray(prayerGenerationRenderPlans.generationJobId, jobIds))
        await db
          .delete(prayerGenerationAudioTasks)
          .where(inArray(prayerGenerationAudioTasks.generationJobId, jobIds))
        await db
          .delete(prayerGenerationVisualTasks)
          .where(inArray(prayerGenerationVisualTasks.generationJobId, jobIds))
        await db
          .delete(prayerGenerationManifestSnapshots)
          .where(
            inArray(prayerGenerationManifestSnapshots.generationJobId, jobIds),
          )
        await db
          .delete(prayerGenerationStoryboardSnapshots)
          .where(
            inArray(prayerGenerationStoryboardSnapshots.generationJobId, jobIds),
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
    if (createdItemIds.length > 0) {
      const sacredVersions = await db
        .select({ id: spiritualContentVersions.id })
        .from(spiritualContentVersions)
        .where(inArray(spiritualContentVersions.contentItemId, createdItemIds))
      const sacredVersionIds = sacredVersions.map((row) => row.id)
      if (sacredVersionIds.length > 0) {
        await db
          .delete(sacredContentMediaLinks)
          .where(
            inArray(sacredContentMediaLinks.contentVersionId, sacredVersionIds),
          )
      }
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
    if (createdAssetIds.length > 0) {
      const versionRows = await db
        .select({ id: mediaAssetVersions.id })
        .from(mediaAssetVersions)
        .where(inArray(mediaAssetVersions.assetId, createdAssetIds))
      const versionIds = versionRows.map((row) => row.id)
      if (versionIds.length > 0) {
        await db
          .delete(mediaAssetVersions)
          .where(inArray(mediaAssetVersions.id, versionIds))
      }
      await db
        .delete(mediaAssets)
        .where(inArray(mediaAssets.id, createdAssetIds))
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
  resetRenderEngineForTests()
  resetTtsProviderForTests()
  try {
    rmSync(storageRoot, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
  await closeDb()
})

// ----------------------------------------------------------------------------
// Item 1: the happy path, determinism and idempotency
// ----------------------------------------------------------------------------

describe('red-team: the render plan is deterministic and the render is idempotent', () => {
  it('a fully verified job renders once and advances to UPLOADING', async () => {
    const { jobId, clock } = await makeRenderableJob()
    const outcome = await runRenderOnce('rtr-render', clock)
    expect(outcome.status).toBe('COMPLETE')
    expect((await jobRow(jobId)).status).toBe('UPLOADING')

    const plans = await renderPlanRows(jobId)
    expect(plans.length).toBe(1)
    const results = await renderResultRows(jobId)
    expect(results.length).toBe(1)
    expect(results[0].status).toBe('SUCCEEDED')
    // TEETH: the artifact is recorded as a MOCK, permanently and
    // visibly — nothing downstream can mistake it for a deliverable.
    expect(results[0].rendererCode).toBe('MOCK_RENDER')
    expect(results[0].rendererIsMock).toBe(1)
    expect(results[0].artifactStorageRef).not.toBeNull()
    const bytes = new Uint8Array(
      readFileSync(join(storageRoot, results[0].artifactStorageRef!)),
    )
    expect(new TextDecoder().decode(bytes)).toContain(MOCK_RENDER_MAGIC_HEADER)
    expect(computeFileSha256(bytes)).toBe(results[0].artifactSha256!)
    expect(results[0].artifactDurationMs).toBe(plans[0].totalDurationMs)
    // The idempotency key is derivable from manifest + plan authority
    // alone, so it is reproducible from outside the executor.
    const manifest = await latestManifest(jobId)
    expect(results[0].idempotencyKey).toBe(
      computeRenderIdempotencyKey({
        generationJobId: jobId,
        manifestSha256: manifest.manifestSha256,
        renderPlanSha256: plans[0].renderPlanSha256,
      }),
    )
  }, 240_000)

  it('building the plan twice from the same authority yields the SAME hash', async () => {
    const { jobId } = await makeRenderableJob()
    const manifest = await latestManifest(jobId)
    const storyboard = await latestStoryboard(jobId)
    const manifestRow = (
      await getDb()
        .select()
        .from(prayerGenerationManifestSnapshots)
        .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
    ).at(-1)!
    const job = await jobRow(jobId)
    const context = {
      serviceId: job.serviceIdSnapshot,
      sacredHouseId: job.sacredHouseIdSnapshot,
      language: job.languageSnapshot,
    }
    const first = await buildValidatedRenderPlan(
      jobId,
      manifestRow.id,
      storyboard,
      manifest,
      context,
    )
    const second = await buildValidatedRenderPlan(
      jobId,
      manifestRow.id,
      storyboard,
      manifest,
      context,
    )
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    // TEETH: identical inputs, identical hash — this is what makes the
    // retry path safe and the plan comparable at the final gate.
    expect(first.plan.renderPlanSha256).toBe(second.plan.renderPlanSha256)
    const { renderPlanSha256: _drop, ...body } = first.plan
    expect(computeRenderPlanSha256(body)).toBe(first.plan.renderPlanSha256)
  }, 240_000)

  it('a MEASURED recording longer than its database row GROWS the segment and shifts what follows', async () => {
    // THE LOCKED RULE, end to end:
    //   finalSegmentDuration = max(plannedSegmentDuration, actualAudio)
    //
    // `media_asset_versions.duration_seconds` is whole SECONDS typed by
    // a person. A 12.4-second recording stored as 12 would be given a
    // 12 000 ms window, and 400 ms of somebody's prayer would have
    // nowhere to play. Measuring the file first must make the SEGMENT
    // grow — never make the render refuse, and never trim the audio.
    const { jobId } = await makeRenderableJob()
    const manifest = await latestManifest(jobId)
    const storyboard = await latestStoryboard(jobId)
    const manifestRow = (
      await getDb()
        .select()
        .from(prayerGenerationManifestSnapshots)
        .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
    ).at(-1)!
    const job = await jobRow(jobId)
    const context = {
      serviceId: job.serviceIdSnapshot,
      sacredHouseId: job.sacredHouseIdSnapshot,
      language: job.languageSnapshot,
    }

    // The mock path: database metadata is authoritative, exactly as
    // Step 16 has always behaved.
    const fromDatabase = await buildValidatedRenderPlan(
      jobId,
      manifestRow.id,
      storyboard,
      manifest,
      context,
    )
    expect(fromDatabase.ok).toBe(true)
    if (!fromDatabase.ok) return

    // The real path: the FILE says 400 ms more than the row did.
    const OVERRUN_MS = 400
    const measured: AudioDurationProbe = async () => ({
      ok: true,
      durationMs:
        fromDatabase.plan.audio[0].durationMs + OVERRUN_MS,
    })
    const fromFile = await buildValidatedRenderPlan(
      jobId,
      manifestRow.id,
      storyboard,
      manifest,
      context,
      { measureAudioDuration: measured },
    )
    expect(fromFile.ok).toBe(true)
    if (!fromFile.ok) return

    const before = fromDatabase.plan.audio[0]
    const after = fromFile.plan.audio[0]
    // The recording is placed at its REAL length and played once, in
    // full — the window grew to hold it.
    expect(after.durationMs).toBe(before.durationMs + OVERRUN_MS)
    expect(after.endMs - after.startMs).toBe(after.durationMs)
    expect(after.plannedWindowMs).toBe(before.plannedWindowMs)
    expect(after.finalWindowMs).toBe(
      Math.max(after.plannedWindowMs, after.durationMs),
    )
    // Everything after it shifts by exactly the overrun; the whole
    // timeline is longer by exactly the overrun. Nothing was cut.
    expect(fromFile.plan.totalDurationMs).toBe(
      fromDatabase.plan.totalDurationMs + OVERRUN_MS,
    )
    const lastBefore = fromDatabase.plan.scenes.at(-1)!
    const lastAfter = fromFile.plan.scenes.at(-1)!
    expect(lastAfter.endMs).toBe(lastBefore.endMs + OVERRUN_MS)
    // The absorbing split holds its OWN approved visual for longer —
    // it does not acquire a different picture.
    expect(lastAfter.visualSourceSceneId).toBe(lastBefore.visualSourceSceneId)
    expect(lastAfter.plannedDurationMs).toBe(lastBefore.plannedDurationMs)

    // A different timeline is a different plan, and therefore a
    // different render identity.
    expect(fromFile.plan.renderPlanSha256).not.toBe(
      fromDatabase.plan.renderPlanSha256,
    )
    // AND IT REBUILDS IDENTICALLY. verifyCompletedRender rebuilds this
    // plan and compares the hash byte-for-byte on every playback
    // request; if measurement were not deterministic, a finished
    // recording would become permanently unavailable.
    const rebuilt = await buildValidatedRenderPlan(
      jobId,
      manifestRow.id,
      storyboard,
      manifest,
      context,
      { measureAudioDuration: measured },
    )
    expect(rebuilt.ok).toBe(true)
    if (!rebuilt.ok) return
    expect(rebuilt.plan.renderPlanSha256).toBe(fromFile.plan.renderPlanSha256)
  }, 240_000)

  it('fails closed when a recording cannot be measured, rather than guessing from the row', async () => {
    const { jobId } = await makeRenderableJob()
    const manifest = await latestManifest(jobId)
    const storyboard = await latestStoryboard(jobId)
    const manifestRow = (
      await getDb()
        .select()
        .from(prayerGenerationManifestSnapshots)
        .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
    ).at(-1)!
    const job = await jobRow(jobId)
    const unmeasurable: AudioDurationProbe = async () => ({
      ok: false,
      reasonCode: 'probe_unavailable',
    })
    const built = await buildValidatedRenderPlan(
      jobId,
      manifestRow.id,
      storyboard,
      manifest,
      {
        serviceId: job.serviceIdSnapshot,
        sacredHouseId: job.sacredHouseIdSnapshot,
        language: job.languageSnapshot,
      },
      { measureAudioDuration: unmeasurable },
    )
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.reasonCode).toContain('probe_unavailable')
  }, 240_000)

  it('a second render cycle re-uses the SAME plan and artifact, rendering nothing again', async () => {
    const { jobId, clock } = await makeRenderableJob()
    let renderCalls = 0
    const counting: RenderEngine = {
      ...createMockRenderEngine(),
      render: async (request) => {
        renderCalls += 1
        return createMockRenderEngine().render(request)
      },
    }
    setRenderEngineForTests(counting)
    try {
      expect((await runRenderOnce('rtr-idem-1', clock)).status).toBe('COMPLETE')
      const first = (await renderResultRows(jobId))[0]
      // Put the job back into RENDERING exactly as a recovered lease
      // would, and run again.
      await getDb()
        .update(prayerGenerationJobs)
        .set({ status: 'RENDERING', leaseToken: null, leaseExpiresAt: null })
        .where(eq(prayerGenerationJobs.id, jobId))
      expect((await runRenderOnce('rtr-idem-2', clock)).status).toBe('COMPLETE')
      // TEETH: one plan, one result, one render — a deterministic retry
      // converges instead of producing a second accepted output.
      expect(renderCalls).toBe(1)
      expect((await renderPlanRows(jobId)).length).toBe(1)
      const results = await renderResultRows(jobId)
      expect(results.length).toBe(1)
      expect(results[0].artifactStorageRef).toBe(first.artifactStorageRef)
      expect(results[0].artifactSha256).toBe(first.artifactSha256)
    } finally {
      resetRenderEngineForTests()
    }
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 2: timeline reconciliation around sacred audio
// ----------------------------------------------------------------------------

describe('red-team: the timeline bends around sacred audio, never the reverse', () => {
  it('audio LONGER than its window extends that segment and shifts every later scene', async () => {
    const serviceId = nextService()
    const themeA = `${CODE_PREFIX}_LA_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
    const themeB = `${CODE_PREFIX}_LB_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
    await makeEligibleSacred({
      themeCode: themeA,
      contentType: 'PRAYER',
      voicePolicy: 'APPROVED_TTS_ALLOWED',
      durationHintSeconds: 10,
    })
    await makeEligibleSacred({
      themeCode: themeB,
      contentType: 'CHANT',
      // No audio at all for the SECOND segment, so the only movement in
      // the timeline is the first segment's overrun.
      voicePolicy: 'TEXT_ONLY',
      durationHintSeconds: 10,
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: themeA,
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'CHANT',
      themeCode: themeB,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ slotKey: 'MAIN_PRAYER', position: 1, themeCode: themeA, contentType: 'PRAYER' }),
      filterSlot({ slotKey: 'CLOSING_PRAYER', position: 2, themeCode: themeB, contentType: 'CHANT' }),
    ])
    const OVERRUN_MS = 4_000
    setTtsProviderForTests(driftingTtsProvider(OVERRUN_MS))
    let jobId: number
    let clock: ReturnType<typeof makeFakeClock>
    try {
      const driven = await driveToRendering(serviceId)
      jobId = driven.jobId
      clock = driven.clock
    } finally {
      resetTtsProviderForTests()
    }
    expect((await runRenderOnce('rtr-long', clock)).status).toBe('COMPLETE')

    const loaded = await loadRenderPlanSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    if (loaded.status !== 'OK') return
    const plan = loaded.plan
    const storyboard = await latestStoryboard(jobId)
    const plannedFirst = storyboard.scenes[0].durationMs
    const plannedTotal = storyboard.totalDurationMs

    // TEETH 1: the segment carrying the long audio grew by EXACTLY the
    // overrun — not by a rounded, padded or averaged amount.
    expect(plan.scenes[0].durationMs).toBe(plannedFirst + OVERRUN_MS)
    expect(plan.scenes[0].plannedDurationMs).toBe(plannedFirst)
    // TEETH 2: the held visual absorbs it rather than new footage being
    // invented.
    expect(plan.scenes[0].visualFit).toBe('STILL_HOLD')
    // TEETH 3: every later scene shifted deterministically by the same
    // overrun, and the total grew by exactly that much.
    expect(plan.scenes[1].startMs).toBe(plannedFirst + OVERRUN_MS)
    expect(plan.totalDurationMs).toBe(plannedTotal + OVERRUN_MS)
    // TEETH 4: the audio itself is untouched — placed once, in full.
    expect(plan.audio.length).toBe(1)
    expect(plan.audio[0].durationMs).toBe(plannedFirst + OVERRUN_MS)
    expect(plan.audio[0].endMs - plan.audio[0].startMs).toBe(
      plan.audio[0].durationMs,
    )
    expect(plan.audio[0].finalWindowMs).toBe(plannedFirst + OVERRUN_MS)
  }, 240_000)

  it('audio SHORTER than its window never shrinks the planned segment', async () => {
    const UNDERRUN_MS = 4_000
    const { jobId, clock } = await makeRenderableJob({
      audioDeltaMs: -UNDERRUN_MS,
    })
    expect((await runRenderOnce('rtr-short', clock)).status).toBe('COMPLETE')
    const loaded = await loadRenderPlanSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    if (loaded.status !== 'OK') return
    const storyboard = await latestStoryboard(jobId)

    // TEETH: the planned visual window is kept exactly as planned; the
    // remaining time is simply silent. Nothing is stretched, sped up or
    // looped to fill it.
    expect(loaded.plan.totalDurationMs).toBe(storyboard.totalDurationMs)
    expect(loaded.plan.scenes[0].durationMs).toBe(storyboard.scenes[0].durationMs)
    const audio = loaded.plan.audio[0]
    expect(audio.durationMs).toBe(storyboard.scenes[0].durationMs - UNDERRUN_MS)
    expect(audio.finalWindowMs).toBe(audio.plannedWindowMs)
    // And the audio still plays in full — its own length, never clipped
    // to the window and never padded out to it.
    expect(audio.endMs - audio.startMs).toBe(audio.durationMs)
    expect(audio.endMs).toBeLessThan(loaded.plan.totalDurationMs)
  }, 240_000)

  it('a split visual segment carries its audio exactly ONCE', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_SP_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
    await makeEligibleSacred({
      themeCode: theme,
      contentType: 'PRAYER',
      voicePolicy: 'APPROVED_TTS_ALLOWED',
      // Well over Step 13's 15s scene ceiling, so the storyboard splits
      // this ONE recipe segment into several visual scenes.
      durationHintSeconds: 40,
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
    ])
    const { jobId, clock } = await driveToRendering(serviceId)
    expect((await runRenderOnce('rtr-split', clock)).status).toBe('COMPLETE')

    const loaded = await loadRenderPlanSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    if (loaded.status !== 'OK') return
    const plan = loaded.plan
    expect(plan.scenes.length).toBeGreaterThan(1)
    expect(new Set(plan.scenes.map((s) => s.recipeSegmentIndex)).size).toBe(1)
    // TEETH: one recipe segment, several visual scenes, and EXACTLY ONE
    // audio placement — a split never repeats, re-cuts or re-enters the
    // sacred recording.
    expect(plan.audio.length).toBe(1)
    expect(plan.audio[0].startMs).toBe(plan.scenes[0].startMs)
    expect(plan.audio[0].durationMs).toBe(
      plan.scenes.reduce((total, scene) => total + scene.durationMs, 0),
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 3: scene resolution rules
// ----------------------------------------------------------------------------

describe('red-team: every scene resolves exactly once, and nothing is invented', () => {
  it('a LEADING HOLD_PREVIOUS scene fails closed', () => {
    const built = buildRenderPlan({
      storyboard: syntheticStoryboardFor([{ sourceMode: 'HOLD_PREVIOUS' }]),
      manifest: emptyManifestFor(),
      manifestSnapshotId: 1,
      visualBySceneId: new Map(),
      audioBySegment: new Map(),
      audioRequirementBySegment: new Map(),
    })
    // TEETH: there is nothing to hold, and inventing a first picture is
    // exactly what Step 16 must never do.
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.reasonCode).toBe('leading_hold_previous')
  })

  it('a scene with no resolved visual fails closed rather than rendering a gap', () => {
    const built = buildRenderPlan({
      storyboard: syntheticStoryboardFor([{ sourceMode: 'APPROVED_MEDIA' }]),
      manifest: emptyManifestFor(),
      manifestSnapshotId: 1,
      visualBySceneId: new Map(),
      audioBySegment: new Map(),
      audioRequirementBySegment: new Map(),
    })
    expect(built.ok).toBe(false)
    if (!built.ok) expect(built.reasonCode).toBe('unresolved_scene_visual')
  })

  it('the plan covers EXACTLY the storyboard scenes — no missing, no extra', async () => {
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-cover', clock)).status).toBe('COMPLETE')
    const loaded = await loadRenderPlanSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    if (loaded.status !== 'OK') return
    const storyboard = await latestStoryboard(jobId)
    expect(loaded.plan.scenes.length).toBe(storyboard.scenes.length)
    expect(loaded.plan.scenes.map((s) => s.sceneId)).toEqual(
      storyboard.scenes.map((s) => s.sceneId),
    )
    // Contiguous, gapless, in order.
    let cursor = 0
    for (const scene of loaded.plan.scenes) {
      expect(scene.startMs).toBe(cursor)
      expect(scene.endMs).toBe(cursor + scene.durationMs)
      cursor = scene.endMs
    }
    expect(cursor).toBe(loaded.plan.totalDurationMs)
    expect(loaded.plan.totalDurationMs).toBeLessThanOrEqual(MAX_RENDER_MS)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 4: source integrity — a bad source means NO render
// ----------------------------------------------------------------------------

describe('red-team: a missing, tampered or withdrawn source means no render', () => {
  async function expectBlocked(
    label: string,
    breakIt: (jobId: number) => Promise<void>,
  ) {
    const { jobId, clock } = await makeRenderableJob()
    await breakIt(jobId)
    let renderCalls = 0
    const outcome = await runRenderOnce(label, clock, {
      render: async () => {
        renderCalls += 1
        throw new Error('engine must not be reached in this test')
      },
    })
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
    // TEETH: refused BEFORE the engine — a broken source is never
    // rendered around, substituted for, or partially assembled.
    expect(renderCalls).toBe(0)
    expect((await renderResultRows(jobId)).length).toBe(0)
    return await jobRow(jobId)
  }

  it('approved media whose runtime authority was withdrawn blocks the render', async () => {
    const job = await expectBlocked('rtr-media-withdrawn', async (jobId) => {
      const manifest = await latestManifest(jobId)
      await setMediaRuntimeEnabled(
        adminId,
        ctx,
        manifest.approvedMedia[0].mediaAssetVersionId,
        false,
      )
    })
    expect(job.lastErrorCode).toBeTruthy()
  }, 240_000)

  it('approved media whose stored bytes were tampered with blocks the render', async () => {
    await expectBlocked('rtr-media-tampered', async (jobId) => {
      const manifest = await latestManifest(jobId)
      const version = (
        await getDb()
          .select({ storageKey: mediaAssetVersions.storageKey })
          .from(mediaAssetVersions)
          .where(
            eq(mediaAssetVersions.id, manifest.approvedMedia[0].mediaAssetVersionId),
          )
          .limit(1)
      ).at(0)!
      writeFileSync(
        join(storageRoot, version.storageKey),
        Buffer.from('tampered-approved-media-bytes'),
      )
    })
  }, 240_000)

  it('a TTS artifact whose stored bytes were tampered with blocks the render', async () => {
    const job = await expectBlocked('rtr-tts-tampered', async (jobId) => {
      const row = (
        await getDb()
          .select()
          .from(prayerGenerationAudioTasks)
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
          .limit(1)
      ).at(0)!
      writeFileSync(
        join(storageRoot, row.artifactStorageRef!),
        Buffer.from('tampered-speech-bytes'),
      )
    })
    expect(job.lastErrorMessage).toBe('tts_artifact_hash_mismatch')
  }, 240_000)

  it('a TTS artifact that vanished from storage blocks the render', async () => {
    const job = await expectBlocked('rtr-tts-missing', async (jobId) => {
      const row = (
        await getDb()
          .select()
          .from(prayerGenerationAudioTasks)
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
          .limit(1)
      ).at(0)!
      await storage.remove(row.artifactStorageRef!)
    })
    expect(job.lastErrorMessage).toBe('tts_artifact_missing_from_storage')
  }, 240_000)

  it('a TTS task row re-pointed at another requirement blocks the render', async () => {
    const job = await expectBlocked('rtr-tts-identity', async (jobId) => {
      await getDb()
        .update(prayerGenerationAudioTasks)
        .set({ sceneId: 'NOT-A-MANIFEST-SCENE' })
        .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
    })
    expect(job.lastErrorMessage).toBe('audio_task_identity_mismatch')
  }, 240_000)

  it('a generated visual whose artifact was tampered with blocks the render', async () => {
    // This fixture has a GENERATION_REQUIRED scene (no library image for
    // its theme) and no audio at all.
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_GV_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
    await makeEligibleSacred({
      themeCode: theme,
      contentType: 'BLESSING',
      voicePolicy: 'TEXT_ONLY',
      durationHintSeconds: 10,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'BLESSING' }),
    ])
    const { jobId, clock } = await driveToRendering(serviceId)
    const task = (
      await getDb()
        .select()
        .from(prayerGenerationVisualTasks)
        .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
        .limit(1)
    ).at(0)!
    expect(task.status).toBe('SUCCEEDED')
    writeFileSync(
      join(storageRoot, task.artifactStorageRef!),
      Buffer.from('tampered-generated-visual-bytes'),
    )
    let renderCalls = 0
    const outcome = await runRenderOnce('rtr-visual-tampered', clock, {
      render: async () => {
        renderCalls += 1
        throw new Error('engine must not be reached')
      },
    })
    expect(outcome.status).not.toBe('COMPLETE')
    expect(renderCalls).toBe(0)
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
    expect((await jobRow(jobId)).lastErrorMessage).toBe(
      'visual_artifact_hash_mismatch',
    )
  }, 240_000)

  it('an approved human recording whose link was removed blocks the render', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_HU_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
    const sacred = await makeEligibleSacred({
      themeCode: theme,
      contentType: 'PRAYER',
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
      durationHintSeconds: 10,
    })
    const audio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      contentType: 'PRAYER',
      themeCode: theme,
      sourceType: 'HUMAN_RECORDED',
      language: 'en',
      durationSeconds: 10,
    })
    const link = await createSacredMediaLink(adminId, ctx, {
      contentVersionId: sacred.versionId,
      mediaAssetVersionId: audio.versionId,
      role: 'PRIMARY_AUDIO',
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
    ])
    const { jobId, clock } = await driveToRendering(serviceId)
    // A human recording never became a task; only a fresh re-proof at
    // render time can notice that its governing link is gone.
    await removeSacredMediaLink(adminId, ctx, link.id)
    let renderCalls = 0
    const outcome = await runRenderOnce('rtr-human-unlinked', clock, {
      render: async () => {
        renderCalls += 1
        throw new Error('engine must not be reached')
      },
    })
    expect(outcome.status).not.toBe('COMPLETE')
    expect(renderCalls).toBe(0)
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 5: privacy — the plan and the result carry nothing they shouldn't
// ----------------------------------------------------------------------------

describe('red-team: no sacred text, provider payload or personal detail reaches the plan', () => {
  it('the persisted plan, result row and events are free of body, name and phone', async () => {
    const { jobId, clock, bodyMarker } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-privacy', clock)).status).toBe('COMPLETE')
    const plans = await renderPlanRows(jobId)
    const results = await renderResultRows(jobId)
    const events = await getDb()
      .select()
      .from(prayerGenerationJobEvents)
      .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
    const payload = JSON.stringify({ plans, results, events })
    // TEETH: none of it — not the sacred body, not the marker prefix,
    // not the booker's name or phone, not a provider payload.
    expect(payload).not.toContain(bodyMarker)
    expect(payload).not.toContain(SACRED_BODY_MARKER)
    expect(payload).not.toContain(PERSONAL_NAME_MARKER)
    expect(payload).not.toContain(PERSONAL_PHONE_MARKER)
    expect(payload).not.toContain('riverside at dawn')
    // The rendered artifact itself is derived from hashes and identity
    // only, never from source bytes or approved text.
    const artifact = readFileSync(
      join(storageRoot, results[0].artifactStorageRef!),
    ).toString('utf8')
    expect(artifact).not.toContain(bodyMarker)
    expect(artifact).not.toContain(PERSONAL_NAME_MARKER)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 6: lease, CAS and orphan discipline
// ----------------------------------------------------------------------------

describe('red-team: a stale worker never finalizes and never litters', () => {
  it('losing the lease DURING the render discards the artifact and finalizes nothing', async () => {
    const { jobId, clock } = await makeRenderableJob()
    const minted: Array<string> = []
    // Writing a real composition takes time: the lease expires and is
    // recovered AFTER the bytes have already landed on disk, which is
    // the only moment an orphan can actually exist.
    setMediaStorageForTests(
      recordingStorage(minted, async () => {
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
      }),
    )
    let outcome
    try {
      outcome = await runRenderOnce('rtr-lease-lost', clock, {
        render: async (request) => createMockRenderEngine().render(request),
      })
    } finally {
      setMediaStorageForTests(storage)
    }
    expect(outcome.status).toBe('LEASE_LOST')
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
    const results = await renderResultRows(jobId)
    // TEETH 1: the result was never accepted on a lease we no longer
    // held — the row is not SUCCEEDED and holds no artifact.
    expect(results[0].status).not.toBe('SUCCEEDED')
    expect(results[0].artifactStorageRef).toBeNull()
    // TEETH 2: and the bytes that render already wrote are GONE — a
    // worker that lost its lease leaves no artifact behind.
    expect(minted.length).toBe(1)
    expect(await storage.exists(minted[0])).toBe(false)
  }, 240_000)

  it('a CAS-losing render removes its own orphan artifact', async () => {
    const { jobId, clock } = await makeRenderableJob()
    const minted: Array<string> = []
    setMediaStorageForTests(recordingStorage(minted))
    let outcome
    try {
      outcome = await runRenderOnce('rtr-cas-lost', clock, {
      render: async (request) => {
        // While we render, another worker resolves the row.
        await getDb()
          .update(prayerGenerationRenderResults)
          .set({ status: 'FAILED', lastErrorCode: 'other_worker_verdict' })
          .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
        return createMockRenderEngine().render(request)
      },
      })
    } finally {
      setMediaStorageForTests(storage)
    }
    expect(outcome.status).not.toBe('COMPLETE')
    const results = await renderResultRows(jobId)
    // TEETH: our verdict was discarded and our artifact with it — the
    // other worker's row is untouched.
    expect(results[0].status).toBe('FAILED')
    expect(results[0].lastErrorCode).toBe('other_worker_verdict')
    expect(results[0].artifactStorageRef).toBeNull()
    expect(minted.length).toBe(1)
    expect(await storage.exists(minted[0])).toBe(false)
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
  }, 240_000)

  it('a render failure consumes retry budget and resumes at RENDERING', async () => {
    const { jobId, clock } = await makeRenderableJob()
    // attemptCount is a RUNNING total across the WHOLE job lifecycle
    // (four stages already succeeded), so reset it to isolate what THIS
    // stage does to the budget rather than testing the leftover total.
    await getDb()
      .update(prayerGenerationJobs)
      .set({ attemptCount: 0 })
      .where(eq(prayerGenerationJobs.id, jobId))
    const before = await jobRow(jobId)
    const outcome = await runRenderOnce('rtr-fail', clock, {
      render: async () => {
        throw new Error('synthetic engine failure')
      },
    })
    expect(outcome.status).not.toBe('COMPLETE')
    const after = await jobRow(jobId)
    expect(after.attemptCount).toBe(before.attemptCount + 1)
    expect(after.status).toBe('RETRYING')
    expect(after.resumeStatus).toBe('RENDERING')
    expect((await renderResultRows(jobId))[0].status).toBe('FAILED')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 7: the final gate
// ----------------------------------------------------------------------------

describe('red-team: the final gate re-proves everything before UPLOADING', () => {
  it('a render artifact that vanished after success blocks the advance', async () => {
    const { jobId, clock } = await makeRenderableJob()
    // First cycle renders and advances; put the job back into RENDERING
    // and remove the artifact so the gate runs against a broken result.
    expect((await runRenderOnce('rtr-gate-seed', clock)).status).toBe('COMPLETE')
    const result = (await renderResultRows(jobId))[0]
    await storage.remove(result.artifactStorageRef!)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    const outcome = await runRenderOnce('rtr-gate-missing', clock)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
    expect((await jobRow(jobId)).lastErrorMessage).toBe(
      'artifact_missing_from_storage',
    )
  }, 240_000)

  it('a render artifact whose bytes were tampered with blocks the advance', async () => {
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-gate-seed2', clock)).status).toBe(
      'COMPLETE',
    )
    const result = (await renderResultRows(jobId))[0]
    writeFileSync(
      join(storageRoot, result.artifactStorageRef!),
      Buffer.from('tampered-render-bytes'),
    )
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    const outcome = await runRenderOnce('rtr-gate-tamper', clock)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).lastErrorMessage).toBe('artifact_hash_mismatch')
  }, 240_000)

  it('a persisted plan whose JSON was edited fails its own integrity check', async () => {
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-gate-seed3', clock)).status).toBe(
      'COMPLETE',
    )
    const plan = (await renderPlanRows(jobId))[0]
    const parsed = JSON.parse(plan.planJsonText) as { totalDurationMs: number }
    parsed.totalDurationMs += 1_000
    const edited = JSON.stringify(parsed)
    await getDb()
      .update(prayerGenerationRenderPlans)
      .set({
        planJsonText: edited,
        // Payload hash recomputed so ONLY the plan's own canonical hash
        // can catch this.
        payloadSha256: computeFileSha256(new TextEncoder().encode(edited)),
      })
      .where(eq(prayerGenerationRenderPlans.id, plan.id))
    const loaded = await loadRenderPlanSnapshot(jobId)
    expect(loaded.status).toBe('INTEGRITY_FAILURE')

    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    const outcome = await runRenderOnce('rtr-gate-plan', clock)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 8: the mock can never be mistaken for a deliverable
// ----------------------------------------------------------------------------

describe('red-team: a MOCK render is never permitted in production', () => {
  it('checkRenderEngineAllowed refuses a mock engine under production', () => {
    const mock = createMockRenderEngine()
    expect(mock.isMock).toBe(true)
    const production = checkRenderEngineAllowed(mock, 'production')
    // TEETH: refused outright — there is no flag and no override.
    expect(production.ok).toBe(false)
    if (!production.ok) {
      expect(production.reasonCode).toBe(
        'mock_renderer_forbidden_in_production',
      )
    }
    // A real engine is permitted in the same environment.
    expect(
      checkRenderEngineAllowed(
        { code: 'REAL', isMock: false, isEnabled: () => true },
        'production',
      ).ok,
    ).toBe(true)
    // And the mock remains usable in development and test, which is the
    // whole point of having it.
    expect(checkRenderEngineAllowed(mock, 'test').ok).toBe(true)
    expect(checkRenderEngineAllowed(mock, 'development').ok).toBe(true)
  })

  it('a disabled engine blocks the render entirely', async () => {
    const { jobId, clock } = await makeRenderableJob()
    setRenderEngineForTests({
      ...createMockRenderEngine(),
      isEnabled: () => false,
    })
    let outcome
    try {
      outcome = await runRenderOnce('rtr-disabled', clock)
    } finally {
      resetRenderEngineForTests()
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
    expect((await jobRow(jobId)).lastErrorCode).toBe('RENDERER_NOT_PERMITTED')
    expect((await renderResultRows(jobId)).length).toBe(0)
  }, 240_000)

  it('a result produced by an engine that no longer resolves cannot advance', async () => {
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-engine-seed', clock)).status).toBe(
      'COMPLETE',
    )
    await getDb()
      .update(prayerGenerationRenderResults)
      .set({ rendererCode: 'SOME_OTHER_ENGINE' })
      .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    const outcome = await runRenderOnce('rtr-engine-mismatch', clock)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).lastErrorMessage).toBe('renderer_code_mismatch')
  }, 240_000)

  it('a result whose recorded renderer VERSION was altered cannot advance', async () => {
    // Step 20 hardening: a matching code is not enough. A compositor
    // upgrade composes differently, rounds differently and may honour a
    // fit differently — vouching for an artifact recorded against one
    // version while another is installed is vouching for output this
    // build never produced.
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-version-seed', clock)).status).toBe(
      'COMPLETE',
    )
    await getDb()
      .update(prayerGenerationRenderResults)
      .set({ rendererVersion: 'mock-99' })
      .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    const outcome = await runRenderOnce('rtr-version-mismatch', clock)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).lastErrorMessage).toBe(
      'renderer_version_mismatch',
    )
  }, 240_000)

  it('a result whose recorded MOCK FLAG was altered cannot advance', async () => {
    // TEETH: flipping the flag is how a synthetic artifact would try to
    // pass itself off as a real render — the flag is what the
    // production guard refuses on.
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-flag-seed', clock)).status).toBe(
      'COMPLETE',
    )
    await getDb()
      .update(prayerGenerationRenderResults)
      .set({ rendererIsMock: 0 })
      .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    const outcome = await runRenderOnce('rtr-flag-mismatch', clock)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).lastErrorMessage).toBe(
      'renderer_mock_flag_mismatch',
    )
  }, 240_000)

  it('a tampered identity blocks PLAYBACK too, not merely the render worker', async () => {
    // verifyCompletedRender is re-run by verifyCompletedUpload on every
    // Prayer Room request, so the same refusal must hold there.
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-playback-seed', clock)).status).toBe(
      'COMPLETE',
    )
    const job = await jobRow(jobId)
    const context = {
      serviceId: job.serviceIdSnapshot,
      sacredHouseId: job.sacredHouseIdSnapshot,
      language: job.languageSnapshot,
    }
    expect((await verifyCompletedRender(jobId, context)).ok).toBe(true)
    await getDb()
      .update(prayerGenerationRenderResults)
      .set({ rendererVersion: 'mock-tampered' })
      .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    const after = await verifyCompletedRender(jobId, context)
    expect(after.ok).toBe(false)
    if (after.ok) return
    expect(after.errorCode).toBe('RENDERER_NOT_PERMITTED')
    expect(after.detail).toBe('renderer_version_mismatch')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 9: transition authority
// ----------------------------------------------------------------------------

describe('red-team: UPLOADING is reachable only through the central map', () => {
  it('no earlier stage may jump straight to UPLOADING', () => {
    expect(isLegalTransition('RENDERING', 'UPLOADING')).toBe(true)
    expect(isLegalTransition('QUEUED', 'UPLOADING')).toBe(false)
    expect(isLegalTransition('PREPARING', 'UPLOADING')).toBe(false)
    expect(isLegalTransition('STORYBOARDING', 'UPLOADING')).toBe(false)
    expect(isLegalTransition('GENERATING_VISUALS', 'UPLOADING')).toBe(false)
    expect(isLegalTransition('GENERATING_AUDIO', 'UPLOADING')).toBe(false)
    // Step 16 still cannot produce a deliverable.
    expect(isLegalTransition('RENDERING', 'READY')).toBe(false)
  })

  it('removing the edge from the central map stops the finalize step at runtime', async () => {
    const { jobId, clock } = await makeRenderableJob()
    const original = [...GENERATION_TRANSITIONS.RENDERING]
    GENERATION_TRANSITIONS.RENDERING = original.filter(
      (status) => status !== 'UPLOADING',
    )
    let outcome
    try {
      outcome = await runRenderOnce('rtr-bypass', clock)
    } finally {
      GENERATION_TRANSITIONS.RENDERING = original
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 10: no network, no paid calls, no invented presentation
// ----------------------------------------------------------------------------

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('red-team: no real compositor, network or upload anywhere in Step 16', () => {
  it('the assembly service and every render provider file stay local and offline', () => {
    const files = [
      'src/services/render-assembly.ts',
      'src/providers/render/types.ts',
      'src/providers/render/mock.ts',
      'src/providers/render/registry.ts',
    ]
    for (const file of files) {
      const source = stripComments(
        readFileSync(join(process.cwd(), file), 'utf8'),
      )
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(/https?:\/\//)
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(ioredis|redis|bullmq|amqplib|kafkajs)/i,
      )
      // The REAL compositor boundary exists, but nothing here imports a
      // compositor or a shell: no Remotion render is invoked by
      // automated verification.
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?@?(remotion|fluent-ffmpeg|ffmpeg)/i,
      )
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(child_process|node:child_process)/,
      )
      // No object storage / upload SDK of any kind.
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(@aws-sdk|aws-sdk|minio|@google-cloud)/i,
      )
      expect(source).not.toMatch(/Math\.random\s*\(/)
      expect(source).not.toMatch(/Date\.now\s*\(/)
    }
  })

  it('Remotion is present, version-locked, and never the default engine', async () => {
    // Through Step 19 this asserted that NO Remotion package existed,
    // which was right while the compositor was a documented boundary.
    // Step 20 is the step that legitimately lands it. The fence is not
    // deleted — it now enforces the two conditions the original comment
    // named as the price of admission: ONE compatible version across
    // every @remotion/* package, and OPT-IN selection only.
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    }
    const remotion = Object.keys(all)
      .filter((name) => /^@?remotion/.test(name))
      .sort()
    expect(remotion).toEqual(['@remotion/bundler', '@remotion/renderer', 'remotion'])
    expect(new Set(remotion.map((name) => all[name])).size).toBe(1)

    // OPT-IN: the mock is still what the registry selects unless
    // RENDER_DRIVER says otherwise, and this suite — like all automated
    // verification — runs on the mock.
    const registry = readFileSync(
      join(process.cwd(), 'src/providers/render/registry.ts'),
      'utf8',
    )
    expect(registry).toContain("case 'REMOTION':")
    expect(registry).toContain("case 'MOCK':")
    const { getRenderEngine } = await import('@/providers/render/registry')
    expect(getRenderEngine().isMock).toBe(true)
  })

  it('the plan contains only identities, hashes and timings — no presentation invented', async () => {
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-shape', clock)).status).toBe('COMPLETE')
    const loaded = await loadRenderPlanSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    if (loaded.status !== 'OK') return
    // TEETH: the plan's vocabulary is closed. There is no field a
    // subtitle, a title, a participant name, a music bed or an invented
    // prompt could travel in.
    expect(Object.keys(loaded.plan).sort()).toEqual([
      'audio',
      'generationJobId',
      'manifestSha256',
      'manifestSnapshotId',
      'outputMimeType',
      'renderPlanSha256',
      'sceneCount',
      'scenes',
      'schemaVersion',
      'storyboardSha256',
      'totalDurationMs',
    ])
    expect(Object.keys(loaded.plan.scenes[0]).sort()).toEqual([
      'durationMs',
      'endMs',
      'mediaAssetVersionId',
      'order',
      'plannedDurationMs',
      'recipeSegmentIndex',
      'sceneId',
      'splitCount',
      'splitIndex',
      'startMs',
      'visualFit',
      'visualKind',
      'visualMimeType',
      'visualSha256',
      'visualSourceDurationMs',
      'visualSourceSceneId',
      'visualTaskId',
    ])
    expect(Object.keys(loaded.plan.audio[0]).sort()).toEqual([
      'audioMimeType',
      'audioSha256',
      'durationMs',
      'endMs',
      'finalWindowMs',
      'kind',
      'mediaAssetVersionId',
      'plannedWindowMs',
      'recipeSegmentIndex',
      'requirementId',
      'sceneId',
      'startMs',
    ])
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 16 hardening item 1: visual type and hold semantics
//
// What a source IS comes from authoritative asset metadata, never from
// whether a duration happens to be recorded. And HOLD_PREVIOUS means
// exactly one thing — freeze the frame that was last displayed.
// ----------------------------------------------------------------------------

describe('red-team: hold semantics and visual type are unambiguous', () => {
  /** Minimal storyboard for the unit-level fit tests: scene 0 shows a
   * visual, scene 1 holds it. */
  function holdStoryboard(): GenerationStoryboard {
    return syntheticStoryboardFor([
      { sceneId: 'v0', sourceMode: 'APPROVED_MEDIA', recipeSegmentIndex: 0 },
      { sceneId: 'h1', sourceMode: 'HOLD_PREVIOUS', recipeSegmentIndex: 1 },
    ])
  }

  it('HOLD_PREVIOUS after a LONGER video holds the last frame — never TRIM, never replay', () => {
    const built = buildRenderPlan({
      storyboard: holdStoryboard(),
      manifest: emptyManifestFor(),
      manifestSnapshotId: 1,
      visualBySceneId: new Map([
        [
          'v0',
          {
            sceneId: 'v0',
            kind: 'APPROVED_MEDIA' as const,
            mediaKind: 'VIDEO' as const,
            mediaAssetVersionId: 1,
            visualTaskId: null,
            storageKey: 'ab/' + 'c'.repeat(32) + '.mp4',
            sha256: 'a'.repeat(64),
            mimeType: 'video/mp4',
            // Far LONGER than either scene window.
            durationMs: 30_000,
          },
        ],
      ]),
      audioBySegment: new Map(),
      audioRequirementBySegment: new Map(),
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    // The scene that actually SHOWS the clip trims it to its window …
    expect(built.plan.scenes[0].visualKind).toBe('APPROVED_MEDIA')
    expect(built.plan.scenes[0].visualFit).toBe('TRIM')
    // … and the scene that HOLDS it freezes, whatever footage remains.
    // TEETH: a hold is not a second chance to play the clip.
    expect(built.plan.scenes[1].visualKind).toBe('HOLD_PREVIOUS')
    expect(built.plan.scenes[1].visualFit).toBe('HOLD_LAST_FRAME')
    expect(built.plan.scenes[1].visualSourceSceneId).toBe('v0')
  })

  it('HOLD_PREVIOUS after a still also holds — one unambiguous fit either way', () => {
    const built = buildRenderPlan({
      storyboard: holdStoryboard(),
      manifest: emptyManifestFor(),
      manifestSnapshotId: 1,
      visualBySceneId: new Map([
        [
          'v0',
          {
            sceneId: 'v0',
            kind: 'APPROVED_MEDIA' as const,
            mediaKind: 'IMAGE' as const,
            mediaAssetVersionId: 1,
            visualTaskId: null,
            storageKey: 'ab/' + 'c'.repeat(32) + '.png',
            sha256: 'a'.repeat(64),
            mimeType: 'image/png',
            durationMs: null,
          },
        ],
      ]),
      audioBySegment: new Map(),
      audioRequirementBySegment: new Map(),
    })
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.plan.scenes[0].visualFit).toBe('STILL_HOLD')
    expect(built.plan.scenes[1].visualFit).toBe('HOLD_LAST_FRAME')
  })

  it('an IMAGE with stray duration metadata is STILL held, never treated as a clip', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_IMGD_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
    await makeEligibleSacred({
      themeCode: theme,
      contentType: 'PRAYER',
      voicePolicy: 'TEXT_ONLY',
      durationHintSeconds: 10,
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
      // Nonsense for a still — and exactly the kind of stray metadata
      // that must not decide how it is composed.
      durationSeconds: 7,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
    ])
    const { jobId, clock } = await driveToRendering(serviceId)
    expect((await runRenderOnce('rtr-image-duration', clock)).status).toBe(
      'COMPLETE',
    )
    const loaded = await loadRenderPlanSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    if (loaded.status !== 'OK') return
    // TEETH: the asset's declared kind decides, not its metadata.
    expect(loaded.plan.scenes[0].visualKind).toBe('APPROVED_MEDIA')
    expect(loaded.plan.scenes[0].visualFit).toBe('STILL_HOLD')
    expect(loaded.plan.scenes[0].visualSourceDurationMs).toBeNull()
  }, 240_000)

  it('a VIDEO with NO recorded duration fails closed rather than being guessed at', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_VIDN_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
    await makeEligibleSacred({
      themeCode: theme,
      contentType: 'PRAYER',
      voicePolicy: 'TEXT_ONLY',
      durationHintSeconds: 10,
    })
    await makeEligibleMedia({
      assetKind: 'VIDEO',
      contentType: 'PRAYER',
      themeCode: theme,
      durationSeconds: null,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
    ])
    const { jobId, clock } = await driveToRendering(serviceId)
    let renderCalls = 0
    const outcome = await runRenderOnce('rtr-video-unknown', clock, {
      render: async () => {
        renderCalls += 1
        throw new Error('engine must not be reached')
      },
    })
    // TEETH: an unknown clip length cannot be trimmed or held
    // correctly, so nothing is rendered at all.
    expect(outcome.status).not.toBe('COMPLETE')
    expect(renderCalls).toBe(0)
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
    expect((await jobRow(jobId)).lastErrorMessage).toBe(
      'approved_video_duration_unknown',
    )
  }, 240_000)

  it('a VIDEO with a known duration plans normally (control)', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_VIDK_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
    await makeEligibleSacred({
      themeCode: theme,
      contentType: 'PRAYER',
      voicePolicy: 'TEXT_ONLY',
      durationHintSeconds: 10,
    })
    await makeEligibleMedia({
      assetKind: 'VIDEO',
      contentType: 'PRAYER',
      themeCode: theme,
      // Longer than the 10s window, so this also proves a real clip
      // still trims when it is the scene actually being shown.
      durationSeconds: 30,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
    ])
    const { jobId, clock } = await driveToRendering(serviceId)
    expect((await runRenderOnce('rtr-video-known', clock)).status).toBe(
      'COMPLETE',
    )
    const loaded = await loadRenderPlanSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    if (loaded.status !== 'OK') return
    expect(loaded.plan.scenes[0].visualSourceDurationMs).toBe(30_000)
    expect(loaded.plan.scenes[0].visualFit).toBe('TRIM')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 16 hardening item 2: the output container is bound to the plan
// ----------------------------------------------------------------------------

describe('red-team: the render output must be the container the plan committed to', () => {
  it('a WEBM result for an MP4 plan is refused at acceptance', async () => {
    const { jobId, clock } = await makeRenderableJob()
    const outcome = await runRenderOnce('rtr-mime-webm', clock, {
      render: async (request) => {
        const output = await createMockRenderEngine().render(request)
        // Allowlisted, well-formed, correct length — and the WRONG
        // container for this plan.
        return { ...output, mimeType: 'video/webm' }
      },
    })
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
    expect((await jobRow(jobId)).lastErrorMessage).toBe('artifact_mime_mismatch')
    const results = await renderResultRows(jobId)
    // TEETH: never accepted, and no artifact reference recorded.
    expect(results[0].status).toBe('FAILED')
    expect(results[0].artifactStorageRef).toBeNull()
  }, 240_000)

  it('a stored result whose mime was edited afterwards cannot pass the final gate', async () => {
    const { jobId, clock } = await makeRenderableJob()
    expect((await runRenderOnce('rtr-mime-seed', clock)).status).toBe(
      'COMPLETE',
    )
    await getDb()
      .update(prayerGenerationRenderResults)
      .set({ artifactMimeType: 'video/webm' })
      .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    const outcome = await runRenderOnce('rtr-mime-gate', clock)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
    expect((await jobRow(jobId)).lastErrorMessage).toBe('artifact_mime_mismatch')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 16 hardening item 3: result-row identity before any render spend
// ----------------------------------------------------------------------------

describe('red-team: a tampered result row never reaches the engine', () => {
  /** Seeds a result row through one failing cycle, tampers with it, then
   * runs a second cycle whose engine must never be called. */
  async function runAfterResultTamper(
    label: string,
    tamper: (jobId: number) => Promise<void>,
  ) {
    const { jobId, clock } = await makeRenderableJob()
    await runRenderOnce(`${label}-seed`, clock, {
      render: async () => {
        throw new Error('seed failure to create the result row')
      },
    })
    expect((await renderResultRows(jobId)).length).toBe(1)
    await tamper(jobId)
    // The seed failure consumed budget; reset so THIS cycle's outcome is
    // about identity, not an exhausted attempt count.
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING', attemptCount: 0, leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    let renderCalls = 0
    const outcome = await runRenderOnce(`${label}-run`, clock, {
      render: async () => {
        renderCalls += 1
        throw new Error('engine must not be reached')
      },
    })
    return { jobId, outcome, renderCalls, job: await jobRow(jobId) }
  }

  it('a forged idempotency key blocks BEFORE the render', async () => {
    const { outcome, renderCalls, job } = await runAfterResultTamper(
      'rtr-rid-key',
      async (jobId) => {
        await getDb()
          .update(prayerGenerationRenderResults)
          .set({ idempotencyKey: 'f'.repeat(64) })
          .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
      },
    )
    // TEETH: refused at the identity gate — no engine call, no spend —
    // rather than discovered after the render.
    expect(renderCalls).toBe(0)
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('UPLOADING')
    expect(job.lastErrorCode).toBe('RENDER_RESULT_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('result_idempotency_mismatch')
  }, 240_000)

  it('a re-pointed plan hash blocks BEFORE the render', async () => {
    const { outcome, renderCalls, job } = await runAfterResultTamper(
      'rtr-rid-plan',
      async (jobId) => {
        await getDb()
          .update(prayerGenerationRenderResults)
          .set({ renderPlanSha256: 'e'.repeat(64) })
          .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
      },
    )
    expect(renderCalls).toBe(0)
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.lastErrorCode).toBe('RENDER_RESULT_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('result_plan_hash_mismatch')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 16 hardening item 4: a worker that lost its lease writes nothing
// ----------------------------------------------------------------------------

describe('red-team: a stale worker never writes its verdict onto a newer row', () => {
  const NEWER_MARKER = 'newer_worker_owns_this_row'

  /** Models the real race: while our render is in flight the lease
   * expires, is recovered, and the newer owner resets the row for its
   * own attempt. Whatever our render then does must not touch it. */
  async function loseLeaseThen<T>(
    jobId: number,
    clock: ReturnType<typeof makeFakeClock>,
    then: () => Promise<T>,
  ): Promise<T> {
    clock.advance(DEFAULT_LEASE_MS + 60_000)
    expect(await recoverExpiredGenerationLeases(clock)).toBeGreaterThanOrEqual(1)
    await getDb()
      .update(prayerGenerationRenderResults)
      .set({
        // The newer owner has taken this row for its OWN attempt, so it
        // is legitimately RUNNING again. The status CAS alone cannot
        // tell that apart from our own stale attempt — only the lease
        // can, which is exactly why the fence exists.
        status: 'RUNNING',
        attemptCount: 99,
        lastErrorCode: NEWER_MARKER,
      })
      .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    return then()
  }

  it('a render that THROWS after the lease was lost leaves the row untouched', async () => {
    const { jobId, clock } = await makeRenderableJob()
    const outcome = await runRenderOnce('rtr-stale-throw', clock, {
      render: async () =>
        loseLeaseThen(jobId, clock, async () => {
          throw new Error('synthetic failure from a worker that lost its lease')
        }),
    })
    expect(outcome.status).toBe('LEASE_LOST')
    const row = (await renderResultRows(jobId))[0]
    // TEETH: our FAILED verdict was never written — the newer owner's
    // in-flight attempt stands exactly as it left it.
    expect(row.status).toBe('RUNNING')
    expect(row.attemptCount).toBe(99)
    expect(row.lastErrorCode).toBe(NEWER_MARKER)
    expect(row.artifactStorageRef).toBeNull()
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
  }, 240_000)

  it('an INVALID render result produced after the lease was lost leaves the row untouched', async () => {
    const { jobId, clock } = await makeRenderableJob()
    const outcome = await runRenderOnce('rtr-stale-invalid', clock, {
      render: async (request) =>
        loseLeaseThen(jobId, clock, async () => {
          const output = await createMockRenderEngine().render(request)
          // Rejected on arrival — but by then we no longer own the job.
          return { ...output, mimeType: 'video/webm' }
        }),
    })
    expect(outcome.status).toBe('LEASE_LOST')
    const row = (await renderResultRows(jobId))[0]
    expect(row.status).toBe('RUNNING')
    expect(row.attemptCount).toBe(99)
    expect(row.lastErrorCode).toBe(NEWER_MARKER)
    expect(row.artifactStorageRef).toBeNull()
    expect((await jobRow(jobId)).status).not.toBe('UPLOADING')
  }, 240_000)
})
