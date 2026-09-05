import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb, getPool } from '@/db'
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
  AUDIO_TASK_POLL_DELAY_MS,
  DEFAULT_LEASE_MS,
  PROVIDER_OUTCOME_UNKNOWN,
  RESERVATION_STALE_AFTER_MS,
  adminRetryGenerationJob,
  GENERATION_TRANSITIONS,
  claimNextAudioGenerationJob,
  isLegalTransition,
  recoverExpiredGenerationLeases,
  runAudioGenerationOnce,
  runGenerationPreparationOnce,
  runVisualGenerationOnce,
} from '@/services/generation-jobs'
import { runStoryboardPlanningOnce } from '@/services/generation-storyboards'
import {
  compileSpeechSynthesisRequest,
  computeAudioTaskIdempotencyKey,
  pollSpeech,
  submitSpeech,
  verifyExistingHumanAudio,
} from '@/services/audio-generation'
import { TtsProviderError } from '@/providers/tts/types'
import { createNaijalingoTtsProvider } from '@/providers/tts/naijalingo'
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
import { env } from '@/lib/env'
import type {
  AudioGenerationDependencies,
  AudioTaskPollResult,
  GenerationClock,
} from '@/services/generation-jobs'
import type {
  GenerationManifest,
  ManifestAudioRequirement,
} from '@/services/generation-storyboards'
import type {
  SpeechPollResult,
  SpeechSynthesisRequest,
  SpeechSynthesisSubmission,
  TtsProvider,
} from '@/providers/tts/types'
import type {
  NaijalingoSpeechRequestBody,
  NaijalingoTtsConfig,
} from '@/providers/tts/naijalingo'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * ============================================================================
 * RED TEAM — Phase One, Step 15 (approved speech synthesis / audio
 * generation), verified against landed source: src/db/schema/
 * audio-generation.ts, src/services/audio-generation.ts,
 * src/providers/tts/{types,mock,registry}.ts and the Step-15 section of
 * src/services/generation-jobs.ts.
 *
 * The two properties this suite exists to defend, above all others:
 *   1. an approved HUMAN recording of sacred text is NEVER synthesized,
 *      never regenerated, and never sent to any provider; and
 *   2. machine speech happens ONLY where the CURRENT authoritative voice
 *      policy still says APPROVED_TTS_ALLOWED, using the EXACT approved
 *      body, which never reaches a database row, an event or a log.
 *
 * Everything else (lease/CAS/orphan/identity discipline) is the Step 14
 * machinery re-proved for this stage, because a shared pattern that
 * silently regressed in one stage is not actually shared.
 *
 * File-local prefix RTA_ so this file's fixtures never collide with the
 * RTV_/RTW_ visual suites.
 * ============================================================================
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `redteam audio test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const createdItemIds: Array<number> = []
const createdAssetIds: Array<number> = []
const createdTemplateIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'

let adminId: number
let cmId: number
let houseId: number
let storageRoot: string
let storage: LocalMediaStorageProvider
let servicePool: Array<number> = []
let serviceCursor = 0

const RUN_KEY = crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')
const CODE_PREFIX = `RTA_${RUN_KEY}`
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
  return new TextEncoder().encode(`redteam-audio-bytes ${marker}`)
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `rta-${crypto.randomUUID()}@test.local`,
      preferredName: 'RTA Fixture',
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
    durationHintSeconds: 10,
    repeatable: false,
    voicePolicy: 'TEXT_ONLY',
    externalAiPolicy: 'METADATA_ONLY',
    accessPolicy: 'PRAYER_ROOM_PRIVATE',
    ...overrides,
  }
}

const SACRED_BODY_MARKER = 'Red-team-audio sacred block body'

async function makeEligibleSacred(options: {
  themeCode: string
  contentType?: 'PRAYER' | 'CHANT' | 'BLESSING'
  voicePolicy?: 'TEXT_ONLY' | 'APPROVED_TTS_ALLOWED' | 'HUMAN_RECORDED_REQUIRED'
  durationHintSeconds?: number
  language?: 'en' | 'yo'
  /** A DIFFERENT House than the suite's own — for proving refusals. */
  sacredHouseId?: number
}): Promise<{ itemId: number; versionId: number; bodyMarker: string }> {
  const bodyMarker = `${SACRED_BODY_MARKER} ${crypto.randomUUID()}`
  const item = await createSacredContentItem(cmId, ctx, {
    code: nextCode('SC'),
    contentType: options.contentType ?? 'PRAYER',
    // HOUSE-SCOPED, like every real launch block. Sacred speech is
    // spoken in the voice of the House whose words they are, so
    // House-less sacred content has no approved voice and is refused;
    // fixtures that pretended otherwise were testing a shape that no
    // longer reaches synthesis.
    scopeType: 'SACRED_HOUSE',
    sacredHouseId: options.sacredHouseId ?? houseId,
    serviceId: null,
    sortOrder: 0,
  })
  createdItemIds.push(item.id)
  const version = await createSacredVersion(
    cmId,
    ctx,
    item.id,
    {
      language: options.language ?? 'en',
      title: 'Red-team audio sacred block',
      body: bodyMarker,
    },
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
      durationSeconds: assetKind === 'AUDIO' ? 10 : null,
      width: null,
      height: null,
      containsIdentifiablePerson: false,
      consentStatus: 'NOT_APPLICABLE',
      consentReference: null,
      externalAiPolicy: 'NO_EXTERNAL_AI',
      // NEVER authorized: Step 15 performs no voice or likeness cloning.
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
    shotFamily: 'MEDIUM_PRAYER',
    referenceRequirement: 'OPTIONAL',
    // The suite's sacred blocks belong to the suite's House, exactly as
    // every launch block belongs to one of the four.
    allowedScopes: ['SACRED_HOUSE'],
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

async function audioTaskRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationAudioTasks)
    .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
}

async function jobEventRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationJobEvents)
    .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
}

/**
 * Cancels every OTHER non-terminal job in the table, not just this
 * house's. The audio claim queue is a GLOBAL FIFO ordered by id, and
 * GENERATING_AUDIO is where every earlier suite's finished jobs come to
 * rest — so a house-scoped quiesce (enough for the earlier stages)
 * would leave foreign jobs that always win the race and make these
 * tests assert against somebody else's job.
 */
async function quiesceOtherJobs(exceptJobId: number): Promise<void> {
  await getDb()
    .update(prayerGenerationJobs)
    .set({ status: 'CANCELLED', leaseToken: null, leaseExpiresAt: null })
    .where(
      and(
        inArray(prayerGenerationJobs.status, [
          'QUEUED',
          'RETRYING',
          'STORYBOARDING',
          'GENERATING_VISUALS',
          'GENERATING_AUDIO',
        ]),
      ),
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

/**
 * Drives one appointment all the way to GENERATING_AUDIO. Every fixture
 * below pairs its sacred block with an APPROVED_MEDIA library image, so
 * the Step 14 visual stage has ZERO tasks and completes in a single
 * cycle — this suite is about audio, and a real visual round-trip would
 * only add unrelated ways to fail.
 */
async function driveToGeneratingAudio(
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
  const clock = { now: () => new Date() }
  expect((await runGenerationPreparationOnce('rta-prep', clock)).status).toBe(
    'PREPARED',
  )
  expect((await runStoryboardPlanningOnce('rta-plan', clock)).status).toBe(
    'PLANNED',
  )
  // Zero visual tasks ⇒ the visual cycle finalizes immediately.
  expect((await runVisualGenerationOnce('rta-visual', clock)).status).toBe(
    'COMPLETE',
  )
  const row = (await jobForAppointment(reservation.appointmentId))!
  expect(row.status).toBe('GENERATING_AUDIO')
  return { jobId: job.id, appointmentId: reservation.appointmentId }
}

/** A job whose single audio requirement is TTS_PENDING (voice policy
 * APPROVED_TTS_ALLOWED, no linked human recording available). */
async function makeTtsJob(): Promise<{
  jobId: number
  manifest: GenerationManifest
  requirement: ManifestAudioRequirement
  bodyMarker: string
  contentVersionId: number
}> {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_TTS_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  const sacred = await makeEligibleSacred({
    themeCode: theme,
    contentType: 'PRAYER',
    voicePolicy: 'APPROVED_TTS_ALLOWED',
  })
  await makeEligibleMedia({
    assetKind: 'IMAGE',
    contentType: 'PRAYER',
    themeCode: theme,
  })
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
  ])
  const { jobId } = await driveToGeneratingAudio(serviceId)
  const manifest = await latestManifest(jobId)
  const requirement = manifest.audioRequirements[0]
  expect(manifest.audioRequirements.length).toBe(1)
  expect(requirement.mode).toBe('TTS_PENDING')
  return {
    jobId,
    manifest,
    requirement,
    bodyMarker: sacred.bodyMarker,
    contentVersionId: sacred.versionId,
  }
}

/** A job whose single audio requirement is an approved HUMAN recording
 * (voice policy HUMAN_RECORDED_REQUIRED + a linked PRIMARY_AUDIO). */
async function makeHumanAudioJob(): Promise<{
  jobId: number
  manifest: GenerationManifest
  requirement: ManifestAudioRequirement
  contentVersionId: number
  audioVersionId: number
  linkId: number
}> {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_HUM_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  const sacred = await makeEligibleSacred({
    themeCode: theme,
    contentType: 'PRAYER',
    voicePolicy: 'HUMAN_RECORDED_REQUIRED',
  })
  const audio = await makeEligibleMedia({
    assetKind: 'AUDIO',
    contentType: 'PRAYER',
    themeCode: theme,
    sourceType: 'HUMAN_RECORDED',
    language: 'en',
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
  const { jobId } = await driveToGeneratingAudio(serviceId)
  const manifest = await latestManifest(jobId)
  const requirement = manifest.audioRequirements[0]
  expect(manifest.audioRequirements.length).toBe(1)
  expect(requirement.mode).toBe('EXISTING_HUMAN_AUDIO')
  return {
    jobId,
    manifest,
    requirement,
    contentVersionId: sacred.versionId,
    audioVersionId: audio.versionId,
    linkId: link.id,
  }
}

/** A job with NO audio at all (TEXT_ONLY sacred content). */
async function makeTextOnlyJob(): Promise<{
  jobId: number
  manifest: GenerationManifest
}> {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_TXT_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  await makeEligibleSacred({
    themeCode: theme,
    contentType: 'PRAYER',
    voicePolicy: 'TEXT_ONLY',
  })
  await makeEligibleMedia({
    assetKind: 'IMAGE',
    contentType: 'PRAYER',
    themeCode: theme,
  })
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
  ])
  const { jobId } = await driveToGeneratingAudio(serviceId)
  const manifest = await latestManifest(jobId)
  expect(manifest.audioRequirements.length).toBe(0)
  return { jobId, manifest }
}

/** The manifest-derived identity every provider action is keyed on.
 * Tests pass this rather than inventing a key: the executor recomputes
 * the authoritative one and refuses anything that disagrees, so a
 * hand-made key would only ever prove the refusal path (which has its
 * own dedicated tests below). */
function identity(jobId: number, manifest: GenerationManifest) {
  return { generationJobId: jobId, manifestSha256: manifest.manifestSha256 }
}

/** Real executor wiring — the same functions the worker uses. */
const realDependencies: AudioGenerationDependencies = {
  submitSpeech,
  pollSpeech,
}

const submitOnlyDeps: AudioGenerationDependencies = {
  submitSpeech: async () => ({
    status: 'SUBMITTED',
    providerCode: 'MOCK_TTS',
    providerOperationId: `op-${crypto.randomUUID()}`,
  }),
  pollSpeech: async () => ({ status: 'PROCESSING' }),
}

function neverCalledDeps(spy: {
  submitCalls: number
  pollCalls: number
}): AudioGenerationDependencies {
  return {
    submitSpeech: async () => {
      spy.submitCalls += 1
      throw new Error('provider must not be called in this test')
    },
    pollSpeech: async () => {
      spy.pollCalls += 1
      throw new Error('provider must not be called in this test')
    },
  }
}

type SucceededPoll = Extract<AudioTaskPollResult, { status: 'SUCCEEDED' }>

/** Stores REAL bytes and returns the exact SUCCEEDED shape a genuine
 * poll produces — finalization re-reads the object and recomputes its
 * hash, so a fabricated reference models a MISSING artifact, not a
 * successful synthesis. */
async function storeRealArtifact(durationMs: number): Promise<SucceededPoll> {
  const bytes = new TextEncoder().encode(
    `rta-speech-artifact-${crypto.randomUUID()}`,
  )
  const { storageKey } = await storage.put(bytes, 'mp3')
  return {
    status: 'SUCCEEDED',
    artifactSha256: computeFileSha256(bytes),
    artifactMimeType: 'audio/mpeg',
    artifactDurationMs: durationMs,
    artifactStorageRef: storageKey,
  }
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-redteam-audio-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'RTA\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'RTA\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'RTA\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `RTAH_${key}`.toUpperCase(),
    name: `RTA House ${key}`,
    slug: `rtah-${key}`,
    // This suite owns its House, so it also owns that House's approved
    // voice — which is why the routing rule is governed data and not a
    // source-code literal: a fixture House can be given a ruled voice
    // without borrowing, mutating or impersonating a real one.
    approvedVoiceProfile: 'YO_MALE',
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 72; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `RTAS${i}_${key}`.toUpperCase(),
      name: `RTA Service ${i} ${key}`,
      slug: `rtas${i}-${key}`,
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
  resetTtsProviderForTests()
  try {
    rmSync(storageRoot, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
  await closeDb()
})

// ----------------------------------------------------------------------------
// Item 1: an approved HUMAN recording is NEVER synthesized
// ----------------------------------------------------------------------------

describe('red-team: approved human audio is never synthesized', () => {
  it('an EXISTING_HUMAN_AUDIO requirement creates ZERO tasks, calls NO provider, and still advances', async () => {
    const { jobId, requirement } = await makeHumanAudioJob()
    expect(requirement.mediaAssetVersionId).not.toBeNull()
    const spy = { submitCalls: 0, pollCalls: 0 }
    const outcome = await runAudioGenerationOnce(
      'rta-human',
      { now: () => new Date() },
      neverCalledDeps(spy),
    )
    // TEETH: a human recording is used exactly as approved — there is
    // no synthesis to attempt, so the provider is never reached and no
    // durable task row is ever created for it.
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect((await audioTaskRows(jobId)).length).toBe(0)
    expect(outcome.status).toBe('COMPLETE')
    expect((await jobRow(jobId)).status).toBe('RENDERING')
  }, 240_000)

  it('compileSpeechSynthesisRequest refuses a human-audio requirement outright', async () => {
    const { jobId, manifest, requirement } = await makeHumanAudioJob()
    const compiled = await compileSpeechSynthesisRequest(requirement, identity(jobId, manifest))
    expect(compiled.status).toBe('FAILED')
    if (compiled.status === 'FAILED') {
      expect(compiled.reasonCode).toBe('not_a_tts_requirement')
    }
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 2: TTS only where the CURRENT authoritative policy permits it
// ----------------------------------------------------------------------------

describe('red-team: a forbidding voice policy is never synthesized', () => {
  it('HUMAN_RECORDED_REQUIRED content fails closed even if a TTS requirement claims otherwise', async () => {
    const { jobId, manifest, requirement, contentVersionId } =
      await makeHumanAudioJob()
    // A tampered/forged requirement that CLAIMS TTS for content whose
    // authoritative policy demands a human voice.
    const forged: ManifestAudioRequirement = {
      ...requirement,
      mode: 'TTS_PENDING',
      voicePolicy: 'APPROVED_TTS_ALLOWED',
    }
    expect(forged.contentVersionId).toBe(contentVersionId)
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('MOCK_TTS', counters))
    try {
      const compiled = await compileSpeechSynthesisRequest(forged, identity(jobId, manifest))
      // TEETH: the AUTHORITATIVE profile policy decides, not the
      // manifest's copy of it.
      expect(compiled.status).toBe('FAILED')
      if (compiled.status === 'FAILED') {
        expect(compiled.reasonCode).toBe('voice_policy_forbids_tts')
      }
      const submitted = await submitSpeech({
        requirement: forged,
        ...identity(jobId, manifest),
      })
      expect(submitted.status).toBe('FAILED')
      // TEETH: refused before any provider call — a human-voice-only
      // text is never sent to a synthesizer, not even to be rejected
      // there.
      expect(counters.submits).toBe(0)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('a requirement whose snapshotted policy is not APPROVED_TTS_ALLOWED is refused without touching the database', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const forged: ManifestAudioRequirement = {
      ...requirement,
      voicePolicy: 'TEXT_ONLY',
    }
    const compiled = await compileSpeechSynthesisRequest(forged, identity(jobId, manifest))
    expect(compiled.status).toBe('FAILED')
    if (compiled.status === 'FAILED') {
      expect(compiled.reasonCode).toBe('voice_policy_forbids_tts')
    }
  }, 240_000)

  it('a voice policy downgraded AFTER planning stops the cycle before ANY synthesis', async () => {
    const { jobId, contentVersionId } = await makeTtsJob()
    // The house changes its mind: this text now requires a human voice.
    await getDb()
      .update(sacredContentVersionProfiles)
      .set({ voicePolicy: 'HUMAN_RECORDED_REQUIRED' })
      .where(eq(sacredContentVersionProfiles.contentVersionId, contentVersionId))
    const spy = { submitCalls: 0, pollCalls: 0 }
    let outcome
    try {
      outcome = await runAudioGenerationOnce(
        'rta-policy-withdrawn',
        { now: () => new Date() },
        neverCalledDeps(spy),
      )
    } finally {
      await getDb()
        .update(sacredContentVersionProfiles)
        .set({ voicePolicy: 'APPROVED_TTS_ALLOWED' })
        .where(
          eq(sacredContentVersionProfiles.contentVersionId, contentVersionId),
        )
    }
    // TEETH: the frozen plan does not survive a policy change. The
    // whole-manifest revalidation at the TOP of the cycle catches it
    // before the task loop is even entered, so nothing is submitted, no
    // durable task row is created, and the job never reaches RENDERING.
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('RENDERING')
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect((await audioTaskRows(jobId)).length).toBe(0)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 3 & 4: exact approved body, never persisted or logged
// ----------------------------------------------------------------------------

/** Records every request it is handed so a test can prove exactly what
 * crossed the provider boundary. */
function capturingProvider(
  captured: Array<SpeechSynthesisRequest>,
  code = 'MOCK_TTS',
): TtsProvider {
  return {
    code,
    displayName: 'Red-team capturing TTS provider',
    isEnabled: () => true,
    submitSpeech: async (
      request: SpeechSynthesisRequest,
    ): Promise<SpeechSynthesisSubmission> => {
      captured.push(request)
      return { providerJobId: `cap-${request.idempotencyKey}`, status: 'PENDING' }
    },
    pollSpeech: async (): Promise<SpeechPollResult> => ({
      status: 'COMPLETED',
      artifact: {
        bytes: new TextEncoder().encode('captured provider speech bytes'),
        mimeType: 'audio/mpeg',
        durationMs: 10_000,
      },
      failureCode: null,
    }),
  }
}

describe('red-team: the approved body is spoken exactly and never persisted', () => {
  it('the provider receives the EXACT approved text and nothing else', async () => {
    const { jobId, manifest, requirement, bodyMarker } = await makeTtsJob()
    const captured: Array<SpeechSynthesisRequest> = []
    setTtsProviderForTests(capturingProvider(captured))
    try {
      const submitted = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
      })
      expect(submitted.status).toBe('SUBMITTED')
      expect(captured.length).toBe(1)
      // TEETH: the key the provider was handed is the AUTHORITATIVE one,
      // derived from manifest authority — not something a caller chose.
      expect(captured[0].idempotencyKey).toBe(
        computeAudioTaskIdempotencyKey({
          generationJobId: jobId,
          manifestSha256: manifest.manifestSha256,
          requirementId: requirement.requirementId!,
        }),
      )
      // TEETH: byte-for-byte the approved body — not rewritten, not
      // translated, not summarized, not extended with an invented
      // prayer or a synthesized introduction.
      expect(captured[0].approvedText).toBe(bodyMarker)
      expect(captured[0].language).toBe('en')
      expect(captured[0].voicePolicy).toBe('APPROVED_TTS_ALLOWED')
      // The House's own approved voice, as a PROFILE — the platform's
      // word for a voice, not the vendor's. No catalogue id, no UUID,
      // and nothing a provider could resolve to a particular person.
      expect(captured[0].voiceProfile).toBe('YO_MALE')
      // TEETH: the contract carries NO likeness input at all — there is
      // nothing on this request a provider could clone a voice from.
      expect(Object.keys(captured[0]).sort()).toEqual([
        'approvedText',
        'idempotencyKey',
        'language',
        'requirementId',
        'sceneId',
        'targetDurationMs',
        'voicePolicy',
        'voiceProfile',
      ])
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('a full successful cycle never writes the body into any row or event', async () => {
    const { jobId, bodyMarker } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('rta-priv-1', clock, realDependencies))
        .status,
    ).toBe('WAITING')
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)
    expect(
      (await runAudioGenerationOnce('rta-priv-2', clock, realDependencies))
        .status,
    ).toBe('COMPLETE')
    expect((await jobRow(jobId)).status).toBe('RENDERING')

    const rows = await audioTaskRows(jobId)
    const events = await jobEventRows(jobId)
    const payload = JSON.stringify({ rows, events, job: await jobRow(jobId) })
    // TEETH: nothing about the spoken text survives anywhere in
    // persisted state — not the body, not a fragment of it.
    expect(payload).not.toContain(bodyMarker)
    expect(payload).not.toContain(SACRED_BODY_MARKER)
    // Nor does it leak through the artifact bytes: the mock derives
    // them from identity fields only, never from the text.
    const artifactBytes = readFileSync(
      join(storageRoot, rows[0].artifactStorageRef!),
    ).toString('utf8')
    expect(artifactBytes).not.toContain(bodyMarker)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 5: authority withdrawal before submit / before poll
// ----------------------------------------------------------------------------

describe('red-team: authority withdrawal fails closed before spending anything', () => {
  it('runtime disabled before the first cycle blocks the whole cycle, provider untouched', async () => {
    const { jobId, contentVersionId } = await makeTtsJob()
    await setSacredRuntimeEnabled(adminId, ctx, contentVersionId, false)
    const spy = { submitCalls: 0, pollCalls: 0 }
    let outcome
    try {
      outcome = await runAudioGenerationOnce(
        'rta-withdraw-submit',
        { now: () => new Date() },
        neverCalledDeps(spy),
      )
    } finally {
      await setSacredRuntimeEnabled(adminId, ctx, contentVersionId, true)
    }
    // TEETH: authority is checked BEFORE spending anything, not after a
    // failed call — the whole-manifest revalidation refuses the cycle
    // and no task row is created at all.
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('RENDERING')
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect((await audioTaskRows(jobId)).length).toBe(0)
  }, 240_000)

  it('the executor itself re-verifies authority at SUBMIT time, independently of the job loop', async () => {
    const { jobId, manifest, requirement, contentVersionId } =
      await makeTtsJob()
    await setSacredRuntimeEnabled(adminId, ctx, contentVersionId, false)
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('MOCK_TTS', counters))
    try {
      const submitted = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
      })
      // TEETH: submitScene's own re-verification is not a duplicate of
      // the loop's — it is what protects any other caller, and it fails
      // closed WITHOUT reaching the provider.
      expect(submitted.status).toBe('FAILED')
      if (submitted.status === 'FAILED') {
        expect(submitted.errorCode).toBe('sacred_content_ineligible')
      }
      expect(counters.submits).toBe(0)
    } finally {
      resetTtsProviderForTests()
      await setSacredRuntimeEnabled(adminId, ctx, contentVersionId, true)
    }
  }, 240_000)

  it('authority withdrawn while a synthesis is IN FLIGHT stops the result being accepted', async () => {
    const { jobId, manifest, requirement, contentVersionId } =
      await makeTtsJob()
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('MOCK_TTS', counters))
    try {
      // Submitted while fully authorized …
      const submitted = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
      })
      expect(submitted.status).toBe('SUBMITTED')
      if (submitted.status !== 'SUBMITTED') return
      // … then the rights are pulled while the provider is working.
      await setSacredRightsStatus(
        adminId,
        ctx,
        contentVersionId,
        'RESTRICTED',
        'red-team: rights pulled mid-synthesis',
      )
      const polled = await pollSpeech({
        providerCode: submitted.providerCode,
        providerOperationId: submitted.providerOperationId,
        requirement,
        ...identity(jobId, manifest),
      })
      // TEETH: polling re-verifies authority BEFORE accepting a result
      // — a completed synthesis whose governing rights vanished
      // mid-flight is never returned as a success, and its bytes never
      // reach storage.
      expect(polled.status).toBe('FAILED')
      if (polled.status === 'FAILED') {
        expect(polled.errorCode).toBe('sacred_content_ineligible')
      }
      expect(counters.polls).toBe(0)
    } finally {
      // No rights restore: RESTRICTED is deliberately terminal for
      // CLEARED (the Step 8 transition map forbids un-restricting), and
      // this fixture is per-test anyway.
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('an approved human recording whose link is removed blocks RENDERING', async () => {
    const { jobId, linkId } = await makeHumanAudioJob()
    await removeSacredMediaLink(adminId, ctx, linkId)
    const spy = { submitCalls: 0, pollCalls: 0 }
    const outcome = await runAudioGenerationOnce(
      'rta-human-unlinked',
      { now: () => new Date() },
      neverCalledDeps(spy),
    )
    // TEETH: removing the governing link invalidates the recording
    // immediately — and the answer is NEVER "synthesize it instead".
    expect(spy.submitCalls).toBe(0)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('RENDERING')
    // The whole-manifest revalidation names the exact reason; the
    // finalization gate re-proves the same thing independently (see
    // verifyExistingHumanAudio, asserted directly below).
    expect((await jobRow(jobId)).lastErrorMessage).toContain(
      'audio_no_longer_linked',
    )
    expect((await audioTaskRows(jobId)).length).toBe(0)
  }, 240_000)

  it('an approved human recording whose stored bytes were tampered with blocks RENDERING', async () => {
    const { jobId, requirement, audioVersionId } = await makeHumanAudioJob()
    const version = (
      await getDb()
        .select({ storageKey: mediaAssetVersions.storageKey })
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.id, audioVersionId))
        .limit(1)
    ).at(0)!
    const absolute = join(storageRoot, version.storageKey)
    const original = readFileSync(absolute)
    writeFileSync(absolute, Buffer.from('tampered-human-recording-bytes'))
    let outcome
    try {
      outcome = await runAudioGenerationOnce(
        'rta-human-tampered',
        { now: () => new Date() },
        neverCalledDeps({ submitCalls: 0, pollCalls: 0 }),
      )
      // Also provable directly, with the exact frozen hash.
      const verified = await verifyExistingHumanAudio(requirement, {
        serviceId: (await jobRow(jobId)).serviceIdSnapshot,
        sacredHouseId: (await jobRow(jobId)).sacredHouseIdSnapshot,
        language: 'en',
      })
      expect(verified.ok).toBe(false)
    } finally {
      writeFileSync(absolute, original)
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('RENDERING')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 6: duplicate / idempotent submission
// ----------------------------------------------------------------------------

describe('red-team: duplicate submission is structurally impossible', () => {
  it('two racing cycles never both claim the same GENERATING_AUDIO job', async () => {
    const { jobId } = await makeTtsJob()
    const clock: GenerationClock = { now: () => new Date() }
    const [claimA, claimB] = await Promise.all([
      claimNextAudioGenerationJob('rta-race-A', clock),
      claimNextAudioGenerationJob('rta-race-B', clock),
    ])
    const claims = [claimA, claimB].filter(
      (claim) => claim != null && claim.job.id === jobId,
    )
    expect(claims.length).toBe(1)
  }, 240_000)

  it('two full cycles never submit the same requirement twice, and the key is deterministic', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    let submitCalls = 0
    const seenKeys = new Set<string>()
    const countingDeps = (): AudioGenerationDependencies => ({
      submitSpeech: async (input) => {
        submitCalls += 1
        // The loop always supplies the key it wrote on the row; the
        // executor would recompute and reject a wrong one.
        expect(input.idempotencyKey).toBeDefined()
        seenKeys.add(input.idempotencyKey!)
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          providerOperationId: `op-${input.idempotencyKey!}`,
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('rta-dup-1', clock, countingDeps())).status,
    ).toBe('WAITING')
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)
    await runAudioGenerationOnce('rta-dup-2', clock, countingDeps())
    // TEETH: exactly ONE submission for this requirement, ever — the
    // second cycle polls the row it already owns rather than paying for
    // a second synthesis.
    expect(submitCalls).toBe(1)
    const rows = await audioTaskRows(jobId)
    expect(rows.length).toBe(1)
    // TEETH: the key is derived from manifest authority alone, so it is
    // reproducible from outside the executor.
    expect([...seenKeys][0]).toBe(
      computeAudioTaskIdempotencyKey({
        generationJobId: jobId,
        manifestSha256: manifest.manifestSha256,
        requirementId: requirement.requirementId!,
      }),
    )
    expect(rows[0].idempotencyKey).toBe([...seenKeys][0])
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 7: provider identity binding
// ----------------------------------------------------------------------------

function countingProvider(
  code: string,
  counters: { submits: number; polls: number },
): TtsProvider {
  return {
    code,
    displayName: `Red-team counting TTS provider ${code}`,
    isEnabled: () => true,
    submitSpeech: async (
      request: SpeechSynthesisRequest,
    ): Promise<SpeechSynthesisSubmission> => {
      counters.submits += 1
      return { providerJobId: `${code}-${request.idempotencyKey}`, status: 'PENDING' }
    },
    pollSpeech: async (): Promise<SpeechPollResult> => {
      counters.polls += 1
      return {
        status: 'COMPLETED',
        artifact: {
          bytes: new TextEncoder().encode('foreign provider speech bytes'),
          mimeType: 'audio/mpeg',
          durationMs: 10_000,
        },
        failureCode: null,
      }
    },
  }
}

describe('red-team: a poll is bound to the provider that issued the operation', () => {
  it('a persisted provider code that no longer matches the active provider fails closed WITHOUT polling', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('OTHER_TTS', counters))
    try {
      const result = await pollSpeech({
        providerCode: 'MOCK_TTS',
        providerOperationId: 'operation-issued-by-a-different-provider',
        requirement,
        ...identity(jobId, manifest),
      })
      // TEETH: refused on identity alone — a foreign recording is never
      // accepted as the voice of approved sacred text.
      expect(result.status).toBe('FAILED')
      if (result.status === 'FAILED') {
        expect(result.errorCode).toBe('provider_code_mismatch')
      }
      expect(counters.polls).toBe(0)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('the SAME poll succeeds once the persisted code names the active provider (control)', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('OTHER_TTS', counters))
    try {
      const submitted = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
      })
      expect(submitted.status).toBe('SUBMITTED')
      if (submitted.status !== 'SUBMITTED') return
      expect(submitted.providerCode).toBe('OTHER_TTS')
      const result = await pollSpeech({
        providerCode: submitted.providerCode,
        providerOperationId: submitted.providerOperationId,
        requirement,
        ...identity(jobId, manifest),
      })
      expect(result.status).toBe('SUCCEEDED')
      expect(counters.polls).toBe(1)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 8 & 9: stale worker, CAS, orphan cleanup
// ----------------------------------------------------------------------------

describe('red-team: a stale worker never wins and never litters', () => {
  it('a losing SUCCEEDED poll removes the artifact it just stored and keeps the winner intact', async () => {
    const { jobId, requirement } = await makeTtsJob()
    const windowMs = requirement.endMs - requirement.startMs
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('rta-orphan-seed', clock, submitOnlyDeps))
        .status,
    ).toBe('WAITING')
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)
    const winner = await storeRealArtifact(windowMs)
    const loser = await storeRealArtifact(windowMs)
    expect(loser.artifactStorageRef).not.toBe(winner.artifactStorageRef)

    const outcome = await runAudioGenerationOnce('rta-orphan', clock, {
      submitSpeech: async () => {
        throw new Error('no submit expected in this cycle')
      },
      pollSpeech: async () => {
        // WHILE our poll is in flight, another worker resolves the row.
        // Our lease is untouched — a purely lost row-status CAS.
        await getDb()
          .update(prayerGenerationAudioTasks)
          .set({
            status: 'SUCCEEDED',
            artifactSha256: winner.artifactSha256,
            artifactMimeType: winner.artifactMimeType,
            artifactDurationMs: winner.artifactDurationMs,
            artifactStorageRef: winner.artifactStorageRef,
            nextPollAt: null,
            completedAt: new Date(),
          })
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
        return loser
      },
    })

    expect(outcome.status).toBe('WAITING')
    const row = (await audioTaskRows(jobId))[0]
    expect(row.artifactSha256).toBe(winner.artifactSha256)
    expect(row.artifactStorageRef).toBe(winner.artifactStorageRef)
    // TEETH: our unreferenced speech artifact is GONE, the referenced
    // one is untouched.
    expect(await storage.exists(loser.artifactStorageRef)).toBe(false)
    expect(await storage.exists(winner.artifactStorageRef)).toBe(true)
  }, 240_000)

  it('a late poll FAILED cannot clobber a newer SUCCEEDED row', async () => {
    const { jobId, requirement } = await makeTtsJob()
    const windowMs = requirement.endMs - requirement.startMs
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('rta-late-seed', clock, submitOnlyDeps))
        .status,
    ).toBe('WAITING')
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)
    const winner = await storeRealArtifact(windowMs)

    const outcome = await runAudioGenerationOnce('rta-late', clock, {
      submitSpeech: async () => {
        throw new Error('no submit expected in this cycle')
      },
      pollSpeech: async () => {
        await getDb()
          .update(prayerGenerationAudioTasks)
          .set({
            status: 'SUCCEEDED',
            artifactSha256: winner.artifactSha256,
            artifactMimeType: winner.artifactMimeType,
            artifactDurationMs: winner.artifactDurationMs,
            artifactStorageRef: winner.artifactStorageRef,
            nextPollAt: null,
            completedAt: new Date(),
          })
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
        return {
          status: 'FAILED',
          errorCode: 'stale_late_poll_failure',
          errorMessage: 'a verdict from a cycle that no longer owns this row',
        }
      },
    })

    const row = (await audioTaskRows(jobId))[0]
    // TEETH: the genuine result survives in EVERY field.
    expect(row.status).toBe('SUCCEEDED')
    expect(row.artifactSha256).toBe(winner.artifactSha256)
    expect(row.lastErrorCode).toBeNull()
    expect(outcome.status).not.toBe('FAILED')
  }, 240_000)

  it('losing the lease mid-cycle discards the poll, its artifact, and every further provider action', async () => {
    const { jobId, requirement } = await makeTtsJob()
    const windowMs = requirement.endMs - requirement.startMs
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('rta-fence-seed', clock, submitOnlyDeps))
        .status,
    ).toBe('WAITING')
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)
    const stranded = await storeRealArtifact(windowMs)
    let pollCalls = 0

    const outcome = await runAudioGenerationOnce('rta-fence', clock, {
      submitSpeech: async () => {
        throw new Error('no submit expected in this cycle')
      },
      pollSpeech: async () => {
        pollCalls += 1
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
        return stranded
      },
    })

    expect(outcome.status).toBe('LEASE_LOST')
    expect(pollCalls).toBe(1)
    const row = (await audioTaskRows(jobId))[0]
    // TEETH: nothing accepted on a lease we no longer hold …
    expect(row.status).toBe('SUBMITTED')
    expect(row.artifactSha256).toBeNull()
    // … and the bytes that result had already written are gone.
    expect(await storage.exists(stranded.artifactStorageRef)).toBe(false)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 10: waiting consumes no retry budget
// ----------------------------------------------------------------------------

describe('red-team: an outstanding synthesis never consumes retry budget', () => {
  it('WAITING releases the lease and reschedules WITHOUT incrementing attemptCount', async () => {
    const { jobId } = await makeTtsJob()
    const before = await jobRow(jobId)
    const t0 = new Date()
    const outcome = await runAudioGenerationOnce(
      'rta-wait',
      { now: () => t0 },
      submitOnlyDeps,
    )
    expect(outcome.status).toBe('WAITING')
    const after = await jobRow(jobId)
    // TEETH: attemptCount UNCHANGED — a legitimate async wait is never
    // an attempt.
    expect(after.attemptCount).toBe(before.attemptCount)
    expect(after.status).toBe('GENERATING_AUDIO')
    expect(after.leaseToken).toBeNull()
    expect(after.nextAttemptAt).not.toBeNull()
    expect(
      Math.abs(
        new Date(after.nextAttemptAt!).getTime() -
          (t0.getTime() + AUDIO_TASK_POLL_DELAY_MS),
      ),
    ).toBeLessThanOrEqual(1_000)
  }, 240_000)

  it('an expired GENERATING_AUDIO lease (worker crash) DOES consume budget', async () => {
    const { jobId } = await makeTtsJob()
    const before = await jobRow(jobId)
    const clock = makeFakeClock(Date.now())
    const outcome = await runAudioGenerationOnce('rta-hang', clock, {
      submitSpeech: async () => {
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          providerOperationId: 'op-hung',
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(outcome.status).toBe('LEASE_LOST')
    expect(await recoverExpiredGenerationLeases(clock)).toBeGreaterThanOrEqual(1)
    const after = await jobRow(jobId)
    expect(after.attemptCount).toBe(before.attemptCount + 1)
    expect(after.status).toBe('RETRYING')
    expect(after.resumeStatus).toBe('GENERATING_AUDIO')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Items 11–13: the finalization gate
// ----------------------------------------------------------------------------

/** Seeds ONE job whose single TTS row is SUCCEEDED with `claim`, then
 * runs the finalize-only cycle (provider provably untouched). */
async function runFinalizeOnlyCycle(
  label: string,
  buildClaim: (windowMs: number) => Promise<{
    artifactSha256: string | null
    artifactMimeType: string | null
    artifactDurationMs: number | null
    artifactStorageRef: string | null
  }>,
  mutate?: (jobId: number) => Promise<void>,
) {
  const { jobId, requirement } = await makeTtsJob()
  const windowMs = requirement.endMs - requirement.startMs
  const clock = makeFakeClock(Date.now())
  expect(
    (await runAudioGenerationOnce(`${label}-seed`, clock, submitOnlyDeps))
      .status,
  ).toBe('WAITING')
  const claim = await buildClaim(windowMs)
  await getDb()
    .update(prayerGenerationAudioTasks)
    .set({
      status: 'SUCCEEDED',
      artifactSha256: claim.artifactSha256,
      artifactMimeType: claim.artifactMimeType,
      artifactDurationMs: claim.artifactDurationMs,
      artifactStorageRef: claim.artifactStorageRef,
      nextPollAt: null,
      completedAt: new Date(),
    })
    .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
  if (mutate) await mutate(jobId)
  clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)
  const spy = { submitCalls: 0, pollCalls: 0 }
  const outcome = await runAudioGenerationOnce(
    `${label}-final`,
    clock,
    neverCalledDeps(spy),
  )
  expect(spy.submitCalls).toBe(0)
  expect(spy.pollCalls).toBe(0)
  return { jobId, outcome, job: await jobRow(jobId) }
}

describe('red-team: finalization verifies speech artifacts against private storage', () => {
  it('a truthful stored artifact DOES finalize to RENDERING (control)', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-ok',
      async (windowMs) => await storeRealArtifact(windowMs),
    )
    expect(outcome.status).toBe('COMPLETE')
    expect(job.status).toBe('RENDERING')
  }, 240_000)

  it('a SUCCEEDED row whose stored object is GONE never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-missing',
      async (windowMs) => {
        const artifact = await storeRealArtifact(windowMs)
        await storage.remove(artifact.artifactStorageRef)
        return artifact
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('RENDERING')
    expect(job.lastErrorCode).toBe('AUDIO_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('artifact_missing_from_storage')
  }, 240_000)

  it('a SUCCEEDED row whose stored BYTES were tampered with never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-tamper',
      async (windowMs) => {
        const artifact = await storeRealArtifact(windowMs)
        writeFileSync(
          join(storageRoot, artifact.artifactStorageRef),
          Buffer.from('tampered-speech-bytes-not-the-synthesized-ones'),
        )
        return artifact
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('RENDERING')
    expect(job.lastErrorMessage).toBe('artifact_hash_mismatch')
  }, 240_000)

  it('a SUCCEEDED row whose stored bytes are EMPTY never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-empty',
      async (windowMs) => {
        const artifact = await storeRealArtifact(windowMs)
        writeFileSync(
          join(storageRoot, artifact.artifactStorageRef),
          Buffer.alloc(0),
        )
        return artifact
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.lastErrorMessage).toBe('artifact_missing_from_storage')
  }, 240_000)

  it('a SUCCEEDED row with a non-audio MIME type never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-mime',
      async (windowMs) => ({
        ...(await storeRealArtifact(windowMs)),
        artifactMimeType: 'video/mp4',
      }),
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.lastErrorMessage).toBe('artifact_mime_invalid')
  }, 240_000)

  it('a SUCCEEDED row with no storage reference never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-noref',
      async (windowMs) => ({
        ...(await storeRealArtifact(windowMs)),
        artifactStorageRef: null,
      }),
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.lastErrorMessage).toBe('artifact_storage_ref_invalid')
  }, 240_000)
})

describe('red-team: finalization requires the task rows to BE the manifest requirements', () => {
  it('an EXTRA task row blocks finalization', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-extra',
      async (windowMs) => await storeRealArtifact(windowMs),
      async (jobId) => {
        const existing = (await audioTaskRows(jobId))[0]
        await getDb()
          .insert(prayerGenerationAudioTasks)
          .values({
            generationJobId: jobId,
            manifestSnapshotId: existing.manifestSnapshotId,
            requirementId: `${existing.requirementId}-EXTRA`,
            sceneId: existing.sceneId,
            idempotencyKey: crypto.randomUUID().replace(/-/g, '').repeat(2),
            status: 'SUCCEEDED',
            artifactSha256: existing.artifactSha256,
            artifactMimeType: existing.artifactMimeType,
            artifactDurationMs: existing.artifactDurationMs,
            artifactStorageRef: existing.artifactStorageRef,
          })
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.lastErrorMessage).toBe('task_count_mismatch')
  }, 240_000)

  it('a task row re-pointed at a different scene blocks finalization', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-scene',
      async (windowMs) => await storeRealArtifact(windowMs),
      async (jobId) => {
        await getDb()
          .update(prayerGenerationAudioTasks)
          .set({ sceneId: 'NOT-A-MANIFEST-SCENE' })
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.lastErrorMessage).toBe('task_scene_mismatch')
  }, 240_000)

  it('a task row carrying a forged idempotency key blocks finalization', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rta-fin-idem',
      async (windowMs) => await storeRealArtifact(windowMs),
      async (jobId) => {
        await getDb()
          .update(prayerGenerationAudioTasks)
          .set({
            idempotencyKey: crypto.randomUUID().replace(/-/g, '').repeat(2),
          })
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.lastErrorMessage).toBe('task_idempotency_mismatch')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 12b: malformed provider output is rejected at storage time
// ----------------------------------------------------------------------------

describe('red-team: malformed provider output is never persisted as success', () => {
  async function expectRejected(
    poll: () => Promise<SpeechPollResult>,
    expectedReasonCode: string,
  ) {
    const { jobId, manifest, requirement } = await makeTtsJob()
    setTtsProviderForTests({
      code: 'BAD_TTS',
      displayName: 'Red-team malformed-output TTS provider',
      isEnabled: () => true,
      submitSpeech: async (request) => ({
        providerJobId: `bad-${request.idempotencyKey}`,
        status: 'PENDING',
      }),
      pollSpeech: poll,
    })
    try {
      const submitted = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
      })
      expect(submitted.status).toBe('SUBMITTED')
      if (submitted.status !== 'SUBMITTED') return
      const polled = await pollSpeech({
        providerCode: submitted.providerCode,
        providerOperationId: submitted.providerOperationId,
        requirement,
        ...identity(jobId, manifest),
      })
      expect(polled.status).toBe('FAILED')
      if (polled.status === 'FAILED') {
        expect(polled.errorCode).toBe(expectedReasonCode)
      }
    } finally {
      resetTtsProviderForTests()
    }
  }

  it('empty bytes are rejected (artifact_empty)', async () => {
    await expectRejected(
      async () => ({
        status: 'COMPLETED',
        artifact: {
          bytes: new Uint8Array(0),
          mimeType: 'audio/mpeg',
          durationMs: 10_000,
        },
        failureCode: null,
      }),
      'artifact_empty',
    )
  }, 240_000)

  it('a non-audio mime type is rejected (artifact_mime_invalid)', async () => {
    await expectRejected(
      async () => ({
        status: 'COMPLETED',
        artifact: {
          bytes: new TextEncoder().encode('not actually speech'),
          mimeType: 'video/mp4',
          durationMs: 10_000,
        },
        failureCode: null,
      }),
      'artifact_mime_invalid',
    )
  }, 240_000)

  it('an unbounded duration is rejected (artifact_duration_bound)', async () => {
    await expectRejected(
      async () => ({
        status: 'COMPLETED',
        artifact: {
          bytes: new TextEncoder().encode('some bytes that sound like speech'),
          mimeType: 'audio/mpeg',
          durationMs: 99_999_999,
        },
        failureCode: null,
      }),
      'artifact_duration_bound',
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 14: the zero-audio path
// ----------------------------------------------------------------------------

describe('red-team: a manifest with no audio advances only after full validation', () => {
  it('a TEXT_ONLY manifest reaches RENDERING with zero tasks and zero provider calls', async () => {
    const { jobId, manifest } = await makeTextOnlyJob()
    expect(manifest.audioRequirements.length).toBe(0)
    const spy = { submitCalls: 0, pollCalls: 0 }
    const outcome = await runAudioGenerationOnce(
      'rta-zero',
      { now: () => new Date() },
      neverCalledDeps(spy),
    )
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect(outcome.status).toBe('COMPLETE')
    expect((await audioTaskRows(jobId)).length).toBe(0)
    expect((await jobRow(jobId)).status).toBe('RENDERING')
  }, 240_000)

  it('a zero-audio manifest that fails CURRENT authority does NOT advance', async () => {
    const { jobId } = await makeTextOnlyJob()
    const job = await jobRow(jobId)
    // Break the manifest's own authority: the storyboard snapshot is
    // what the revalidation rebuilds against.
    await getDb()
      .update(prayerGenerationManifestSnapshots)
      .set({ manifestSha256: 'f'.repeat(64) })
      .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
    const spy = { submitCalls: 0, pollCalls: 0 }
    const outcome = await runAudioGenerationOnce(
      'rta-zero-invalid',
      { now: () => new Date() },
      neverCalledDeps(spy),
    )
    // TEETH: zero audio is NOT a free pass — full validation still
    // applies and must block this advance.
    expect(outcome.status).not.toBe('COMPLETE')
    expect(spy.submitCalls).toBe(0)
    expect((await jobRow(jobId)).status).not.toBe('RENDERING')
    void job
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 15: no premature RENDERING
// ----------------------------------------------------------------------------

describe('red-team: RENDERING is reachable only through the central transition map', () => {
  it('no earlier stage may jump straight to RENDERING', () => {
    expect(isLegalTransition('GENERATING_AUDIO', 'RENDERING')).toBe(true)
    // TEETH: every earlier stage must go through the audio stage first.
    expect(isLegalTransition('QUEUED', 'RENDERING')).toBe(false)
    expect(isLegalTransition('PREPARING', 'RENDERING')).toBe(false)
    expect(isLegalTransition('STORYBOARDING', 'RENDERING')).toBe(false)
    expect(isLegalTransition('GENERATING_VISUALS', 'RENDERING')).toBe(false)
    // And Step 15 still cannot produce a deliverable.
    expect(isLegalTransition('GENERATING_AUDIO', 'UPLOADING')).toBe(false)
    expect(isLegalTransition('GENERATING_AUDIO', 'READY')).toBe(false)
  })

  it('removing the edge from the central map stops the finalize step at runtime', async () => {
    const { jobId, requirement } = await makeTtsJob()
    const windowMs = requirement.endMs - requirement.startMs
    const clock = makeFakeClock(Date.now())
    const artifact = await storeRealArtifact(windowMs)
    expect(
      (await runAudioGenerationOnce('rta-bypass-seed', clock, submitOnlyDeps))
        .status,
    ).toBe('WAITING')
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)

    const original = [...GENERATION_TRANSITIONS.GENERATING_AUDIO]
    GENERATION_TRANSITIONS.GENERATING_AUDIO = original.filter(
      (status) => status !== 'RENDERING',
    )
    let outcome
    try {
      outcome = await runAudioGenerationOnce('rta-bypass', clock, {
        submitSpeech: async () => {
          throw new Error('no submit expected in this cycle')
        },
        pollSpeech: async () => artifact,
      })
    } finally {
      GENERATION_TRANSITIONS.GENERATING_AUDIO = original
    }
    // TEETH: with the edge removed from the CENTRAL map, finalization
    // must refuse — proving it consults the map at runtime rather than
    // hardcoding the transition.
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('RENDERING')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 16: no paid/network calls anywhere in the Step 15 provider layer
// ----------------------------------------------------------------------------

/** Strips block and line comments before pattern-matching, so a doc
 * comment that NAMES a forbidden pattern (to explain why the code
 * avoids it) is never mistaken for the pattern being used. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('red-team: no real provider/network calls anywhere in the Step 15 layer', () => {
  it('the audio executor and every TTS provider file never touch a real endpoint', () => {
    const files = [
      'src/services/audio-generation.ts',
      'src/providers/tts/types.ts',
      'src/providers/tts/mock.ts',
      'src/providers/tts/registry.ts',
    ]
    for (const file of files) {
      const source = stripComments(
        readFileSync(join(process.cwd(), file), 'utf8'),
      )
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(
        /https?:\/\/[^'"\s]*(elevenlabs|openai|azure|polly|playht)/i,
      )
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(ioredis|redis|bullmq|amqplib|kafkajs)/i,
      )
      expect(source).not.toMatch(/import[^\n]*(remotion|ffmpeg)/i)
      expect(source).not.toMatch(/Math\.random\s*\(/)
      expect(source).not.toMatch(/Date\.now\s*\(/)
    }
  })

  it('Step 15 renders nothing: no compositing dependency anywhere in the stage', () => {
    for (const file of [
      'src/services/audio-generation.ts',
      'src/services/generation-jobs.ts',
      'src/services/generation-pipeline.ts',
      'src/workers/prayer-generation-worker.ts',
    ]) {
      const source = stripComments(
        readFileSync(join(process.cwd(), file), 'utf8'),
      )
      expect(source).not.toMatch(/(from\s+['"]|require\()['"]?@?remotion/i)
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(fluent-)?ffmpeg/i,
      )
    }
  })
})

// ----------------------------------------------------------------------------
// Step 15 hardening item 1: the sacred body is never READ unless synthesis is
// currently authorized
// ----------------------------------------------------------------------------

/**
 * Counts how many times the sacred BODY column is actually selected, by
 * spying on the shared db client's query path. Nothing subtler will do:
 * "the body was fetched and then not used" is exactly the failure this
 * suite exists to rule out, and only observing the read itself can rule
 * it out.
 */
async function countBodyReads<T>(
  run: () => Promise<T>,
): Promise<{ result: T; bodyReads: number }> {
  const pool = getPool() as unknown as Record<
    string,
    (...args: Array<unknown>) => unknown
  >
  const originalQuery = pool.query.bind(pool)
  const originalExecute = pool.execute.bind(pool)
  let bodyReads = 0
  const inspect = (args: Array<unknown>) => {
    const first = args[0]
    const sql =
      typeof first === 'string'
        ? first
        : String((first as { sql?: string } | undefined)?.sql ?? '')
    if (sql.includes('spiritual_content_versions') && /`body`/.test(sql)) {
      bodyReads += 1
    }
  }
  pool.query = (...args: Array<unknown>) => {
    inspect(args)
    return originalQuery(...args)
  }
  pool.execute = (...args: Array<unknown>) => {
    inspect(args)
    return originalExecute(...args)
  }
  try {
    return { result: await run(), bodyReads }
  } finally {
    pool.query = originalQuery
    pool.execute = originalExecute
  }
}

describe('red-team: a forbidden requirement never reaches the sacred body', () => {
  it('a CURRENT voice policy that forbids TTS causes ZERO body reads and ZERO provider calls', async () => {
    const { jobId, manifest, requirement, contentVersionId } = await makeTtsJob()
    // The policy is withdrawn after planning: the manifest still says
    // APPROVED_TTS_ALLOWED, the authoritative profile no longer does.
    await getDb()
      .update(sacredContentVersionProfiles)
      .set({ voicePolicy: 'HUMAN_RECORDED_REQUIRED' })
      .where(eq(sacredContentVersionProfiles.contentVersionId, contentVersionId))
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('MOCK_TTS', counters))
    try {
      const { result, bodyReads } = await countBodyReads(
        async () =>
          await submitSpeech({ requirement, ...identity(jobId, manifest) }),
      )
      expect(result.status).toBe('FAILED')
      if (result.status === 'FAILED') {
        expect(result.errorCode).toBe('voice_policy_forbids_tts')
      }
      // TEETH: the body was never even SELECTed. Authorization is
      // proved on metadata alone, and only an authorized synthesis is
      // allowed to read the approved text at all.
      expect(bodyReads).toBe(0)
      expect(counters.submits).toBe(0)
    } finally {
      resetTtsProviderForTests()
      await getDb()
        .update(sacredContentVersionProfiles)
        .set({ voicePolicy: 'APPROVED_TTS_ALLOWED' })
        .where(
          eq(sacredContentVersionProfiles.contentVersionId, contentVersionId),
        )
    }
  }, 240_000)

  it('a withdrawn runtime flag causes ZERO body reads on the submission path', async () => {
    const { jobId, manifest, requirement, contentVersionId } = await makeTtsJob()
    await setSacredRuntimeEnabled(adminId, ctx, contentVersionId, false)
    try {
      const { result, bodyReads } = await countBodyReads(
        async () =>
          await submitSpeech({ requirement, ...identity(jobId, manifest) }),
      )
      expect(result.status).toBe('FAILED')
      if (result.status === 'FAILED') {
        expect(result.errorCode).toBe('sacred_content_ineligible')
      }
      expect(bodyReads).toBe(0)
    } finally {
      await setSacredRuntimeEnabled(adminId, ctx, contentVersionId, true)
    }
  }, 240_000)

  it('an AUTHORIZED submission does read the body exactly once (control)', async () => {
    const { jobId, manifest, requirement, bodyMarker } = await makeTtsJob()
    const captured: Array<SpeechSynthesisRequest> = []
    setTtsProviderForTests(capturingProvider(captured))
    try {
      const { result, bodyReads } = await countBodyReads(
        async () =>
          await submitSpeech({ requirement, ...identity(jobId, manifest) }),
      )
      expect(result.status).toBe('SUBMITTED')
      // TEETH: the zero-read assertions above are about ORDER, not about
      // the body being unreachable — an authorized synthesis still reads
      // it, once, and speaks it verbatim.
      expect(bodyReads).toBe(1)
      expect(captured[0].approvedText).toBe(bodyMarker)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('POLLING never reads the body and never recompiles a request', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const captured: Array<SpeechSynthesisRequest> = []
    setTtsProviderForTests(capturingProvider(captured))
    try {
      const submitted = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
      })
      expect(submitted.status).toBe('SUBMITTED')
      if (submitted.status !== 'SUBMITTED') return
      const submissionCount = captured.length
      const { result, bodyReads } = await countBodyReads(
        async () =>
          await pollSpeech({
            providerCode: submitted.providerCode,
            providerOperationId: submitted.providerOperationId,
            requirement,
            ...identity(jobId, manifest),
          }),
      )
      expect(result.status).toBe('SUCCEEDED')
      // TEETH: a poll CONTINUES an operation. It re-proves current
      // authority (metadata only) but never re-reads the approved text
      // and never hands a provider a second request — there is nothing
      // to rewrite, resend or re-translate on this path.
      expect(bodyReads).toBe(0)
      expect(captured.length).toBe(submissionCount)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 15 hardening item 2: the idempotency key is authority, not input
// ----------------------------------------------------------------------------

describe('red-team: a caller-supplied idempotency key is never trusted', () => {
  it('a well-formed but WRONG key fails closed before any provider call, on submit', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('MOCK_TTS', counters))
    try {
      const result = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
        // 64 hex characters, structurally indistinguishable from the
        // real thing — and for a DIFFERENT task.
        idempotencyKey: 'a'.repeat(64),
      })
      expect(result.status).toBe('FAILED')
      if (result.status === 'FAILED') {
        expect(result.errorCode).toBe('idempotency_key_mismatch')
      }
      // TEETH: an accepted wrong key would mint a brand-new provider job
      // for speech that may already have been synthesized and paid for.
      expect(counters.submits).toBe(0)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('a wrong key fails closed on poll too, without contacting the provider', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('MOCK_TTS', counters))
    try {
      const result = await pollSpeech({
        providerCode: 'MOCK_TTS',
        providerOperationId: 'op-whatever',
        requirement,
        ...identity(jobId, manifest),
        idempotencyKey: 'b'.repeat(64),
      })
      expect(result.status).toBe('FAILED')
      if (result.status === 'FAILED') {
        expect(result.errorCode).toBe('idempotency_key_mismatch')
      }
      expect(counters.polls).toBe(0)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('a key for the RIGHT requirement but the WRONG job is still refused', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const counters = { submits: 0, polls: 0 }
    setTtsProviderForTests(countingProvider('MOCK_TTS', counters))
    try {
      const result = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
        // Correctly DERIVED — just derived for somebody else's job.
        idempotencyKey: computeAudioTaskIdempotencyKey({
          generationJobId: jobId + 1,
          manifestSha256: manifest.manifestSha256,
          requirementId: requirement.requirementId!,
        }),
      })
      expect(result.status).toBe('FAILED')
      expect(counters.submits).toBe(0)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('the executor computes the authoritative key when none is supplied (control)', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const captured: Array<SpeechSynthesisRequest> = []
    setTtsProviderForTests(capturingProvider(captured))
    try {
      const result = await submitSpeech({
        requirement,
        ...identity(jobId, manifest),
      })
      expect(result.status).toBe('SUBMITTED')
      expect(captured[0].idempotencyKey).toBe(
        computeAudioTaskIdempotencyKey({
          generationJobId: jobId,
          manifestSha256: manifest.manifestSha256,
          requirementId: requirement.requirementId!,
        }),
      )
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 15 hardening item 3: task row identity is proved BEFORE provider spend
// ----------------------------------------------------------------------------

describe('red-team: a tampered task row never reaches a provider', () => {
  /** Seeds the task row through one real cycle, tampers with it, then
   * runs a second cycle whose dependencies must never be called. */
  async function runAfterTamper(
    label: string,
    tamper: (jobId: number) => Promise<void>,
  ) {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce(`${label}-seed`, clock, submitOnlyDeps))
        .status,
    ).toBe('WAITING')
    await tamper(jobId)
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)
    const spy = { submitCalls: 0, pollCalls: 0 }
    const outcome = await runAudioGenerationOnce(
      `${label}-run`,
      clock,
      neverCalledDeps(spy),
    )
    return { jobId, outcome, spy, job: await jobRow(jobId) }
  }

  it('a tampered sceneId blocks BEFORE the provider call', async () => {
    const { outcome, spy, job } = await runAfterTamper(
      'rta-ident-scene',
      async (jobId) => {
        await getDb()
          .update(prayerGenerationAudioTasks)
          .set({ sceneId: 'NOT-THIS-SCENE' })
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
      },
    )
    // TEETH: refused at the identity gate — no submit, no poll, no
    // spend — rather than discovered at finalization after the provider
    // had already been paid.
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('RENDERING')
    expect(job.lastErrorCode).toBe('AUDIO_TASK_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('task_scene_mismatch')
  }, 240_000)

  it('a tampered idempotencyKey blocks BEFORE the provider call', async () => {
    const { outcome, spy, job } = await runAfterTamper(
      'rta-ident-key',
      async (jobId) => {
        await getDb()
          .update(prayerGenerationAudioTasks)
          .set({ idempotencyKey: 'c'.repeat(64) })
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
      },
    )
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('RENDERING')
    expect(job.lastErrorCode).toBe('AUDIO_TASK_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('task_idempotency_mismatch')
  }, 240_000)

  it('a tampered requirementId blocks BEFORE the provider call', async () => {
    const { outcome, spy, job } = await runAfterTamper(
      'rta-ident-req',
      async (jobId) => {
        await getDb()
          .update(prayerGenerationAudioTasks)
          .set({ requirementId: 'not-a-manifest-requirement' })
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
      },
    )
    // A re-pointed requirement id is not found by the row lookup, so a
    // FRESH row is inserted for the real requirement — and that insert
    // collides with the tampered row's still-unique idempotency key.
    // Either way the outcome is the same one that matters: nothing was
    // submitted and the job did not advance.
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('RENDERING')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 20 follow-up: the audio stage gets the SAME adversarial choreography
// the visual stage has — reclaimed workers, live vs stale reservations, late
// responses, spend classification and the admin gate. DB-driven throughout.
// ----------------------------------------------------------------------------

async function readJob(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
  ).at(0)!
}

async function advanceToNextAttempt(
  jobId: number,
  clock: ReturnType<typeof makeFakeClock>,
): Promise<void> {
  const job = await readJob(jobId)
  if (job.nextAttemptAt != null) {
    const dueMs = new Date(job.nextAttemptAt).getTime()
    if (dueMs > clock.now().getTime()) {
      clock.advance(dueMs - clock.now().getTime() + 1_000)
    }
  }
}

describe('red-team: a reclaimed audio worker never submits a second time', () => {
  it('a fresh reservation makes B WAIT; a stale one is quarantined; a late FAILED cannot overwrite', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    let freshSubmits = 0
    let staleSubmits = 0

    const zombie: AudioGenerationDependencies = {
      submitSpeech: async () => {
        submits += 1
        // A's heartbeat stalls; its job lease is reclaimed while it
        // waits on the provider.
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
        await advanceToNextAttempt(jobId, clock)

        // --- B, while the reservation is FRESH ---------------------
        const bFresh = await runAudioGenerationOnce('b-fresh', clock, {
          submitSpeech: async () => {
            freshSubmits += 1
            throw new Error('B must not submit while a reservation is live')
          },
          pollSpeech: async () => ({ status: 'PROCESSING' }),
        })
        // TEETH: B waits. Zero submissions, zero quarantines of a
        // request that may still be in flight.
        expect(bFresh.status).toBe('WAITING')
        expect(freshSubmits).toBe(0)
        const live = (await audioTaskRows(jobId))[0]
        expect(live.status).toBe('SUBMITTED')
        expect(live.providerOperationId).toBeNull()

        // --- B, once it is genuinely STALE -------------------------
        clock.advance(RESERVATION_STALE_AFTER_MS + 60_000)
        await recoverExpiredGenerationLeases(clock)
        await advanceToNextAttempt(jobId, clock)
        const bStale = await runAudioGenerationOnce('b-stale', clock, {
          submitSpeech: async () => {
            staleSubmits += 1
            throw new Error('B must never resubmit')
          },
          pollSpeech: async () => ({ status: 'PROCESSING' }),
        })
        expect(bStale.status).toBe('FAILED')
        expect(staleSubmits).toBe(0)
        const quarantined = (await audioTaskRows(jobId))[0]
        expect(quarantined.status).toBe('CANCELLED')
        expect(quarantined.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)

        // ONLY NOW does A's late verdict come back.
        return {
          status: 'FAILED',
          providerCode: 'MOCK_TTS',
          errorCode: 'late_zombie_failure',
          errorMessage: null,
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    }

    const a = await runAudioGenerationOnce('worker-A', clock, zombie)
    expect(a.status).toBe('LEASE_LOST')

    // TEETH: A's late FAILED cannot replace the quarantine, and the
    // whole episode cost exactly ONE provider submission.
    const final = (await audioTaskRows(jobId))[0]
    expect(final.status).toBe('CANCELLED')
    expect(final.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    expect(submits).toBe(1)

    const job = await readJob(jobId)
    expect(job.status).toBe('FAILED')
    expect(job.lastErrorCode).toBe('TTS_PROVIDER_OUTCOME_UNKNOWN')
    expect(job.nextAttemptAt).toBeNull()
  }, 240_000)

  it('a late operation id cannot resurrect a quarantined reservation', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())

    const zombie: AudioGenerationDependencies = {
      submitSpeech: async () => {
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        await recoverExpiredGenerationLeases(clock)
        clock.advance(RESERVATION_STALE_AFTER_MS + 60_000)
        await recoverExpiredGenerationLeases(clock)
        await advanceToNextAttempt(jobId, clock)
        const bStale = await runAudioGenerationOnce('b-stale-2', clock, {
          submitSpeech: async () => {
            throw new Error('B must never resubmit')
          },
          pollSpeech: async () => ({ status: 'PROCESSING' }),
        })
        expect(bStale.status).toBe('FAILED')
        // A's answer arrives AFTER the quarantine — with a perfectly
        // valid operation id.
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          providerOperationId: 'op-arrived-too-late',
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    }

    const a = await runAudioGenerationOnce('worker-A2', clock, zombie)
    expect(a.status).toBe('LEASE_LOST')
    // TEETH: the success write CASes on the reserved state, so it
    // loses against CANCELLED — the operation id is never recorded and
    // the quarantine stands.
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.providerOperationId).toBeNull()
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
  }, 240_000)

  it('a durably recorded operation id is POLLED by the next worker, never resubmitted', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    const first = await runAudioGenerationOnce('w-op-1', clock, {
      submitSpeech: async () => {
        submits += 1
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          providerOperationId: 'op-continue-me',
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(first.status).toBe('WAITING')

    // Long past the staleness threshold: a KNOWN operation is still
    // continued, never quarantined and never resubmitted.
    clock.advance(RESERVATION_STALE_AFTER_MS + 60_000)
    await recoverExpiredGenerationLeases(clock)
    await advanceToNextAttempt(jobId, clock)

    const polls: Array<string> = []
    const second = await runAudioGenerationOnce('w-op-2', clock, {
      submitSpeech: async () => {
        submits += 1
        throw new Error('a known operation must be polled, never resubmitted')
      },
      pollSpeech: async (input) => {
        polls.push(input.providerOperationId)
        return { status: 'PROCESSING' }
      },
    })
    expect(second.status).toBe('WAITING')
    expect(polls).toEqual(['op-continue-me'])
    expect(submits).toBe(1)
  }, 240_000)

  it('a late stale poll verdict cannot overwrite a genuine SUCCEEDED result', async () => {
    const { jobId, requirement } = await makeTtsJob()
    const windowMs = requirement.endMs - requirement.startMs
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('w-succ-seed', clock, {
        submitSpeech: async () => ({
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          providerOperationId: 'op-to-finish',
        }),
        pollSpeech: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('WAITING')
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 1_000)
    const artifact = await storeRealArtifact(windowMs)

    const zombiePoll: AudioGenerationDependencies = {
      submitSpeech: async () => {
        throw new Error('no submission expected')
      },
      pollSpeech: async () => {
        // A's poll stalls; B reclaims and finishes the SAME operation.
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        await recoverExpiredGenerationLeases(clock)
        await advanceToNextAttempt(jobId, clock)
        const b = await runAudioGenerationOnce('b-finishes', clock, {
          submitSpeech: async () => {
            throw new Error('B polls, it does not resubmit')
          },
          pollSpeech: async () => artifact,
        })
        expect(b.status).not.toBe('IDLE')
        const succeeded = (await audioTaskRows(jobId))[0]
        expect(succeeded.status).toBe('SUCCEEDED')
        // A's own stale verdict lands only now.
        return {
          status: 'FAILED',
          errorCode: 'late_stale_poll_verdict',
          errorMessage: null,
        }
      },
    }
    const a = await runAudioGenerationOnce('worker-A3', clock, zombiePoll)
    expect(a.status).toBe('LEASE_LOST')
    // TEETH: the row still holds the genuine result, byte for byte.
    const final = (await audioTaskRows(jobId))[0]
    expect(final.status).toBe('SUCCEEDED')
    expect(final.artifactSha256).toBe(artifact.artifactSha256)
  }, 240_000)
})

describe('red-team: audio spend classification decides retry or quarantine', () => {
  it('a NOT_SENT refusal lands on the RESERVED row and is retryable', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    const first = await runAudioGenerationOnce('a-ns-1', clock, {
      submitSpeech: async () => {
        submits += 1
        return {
          status: 'FAILED',
          providerCode: 'MOCK_TTS',
          errorCode: 'synthetic_pre_network_refusal',
          errorMessage: null,
          spendState: 'NOT_SENT',
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(first.status).toBe('RETRY_SCHEDULED')
    const afterFirst = (await audioTaskRows(jobId))[0]
    // TEETH for the reserved-state CAS: the DATABASE changed.
    expect(afterFirst.status).toBe('FAILED')
    expect(afterFirst.submittedAt).toBeNull()
    expect(afterFirst.providerOperationId).toBeNull()

    await advanceToNextAttempt(jobId, clock)
    const second = await runAudioGenerationOnce('a-ns-2', clock, {
      submitSpeech: async () => {
        submits += 1
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          providerOperationId: 'op-after-free-retry',
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(second.status).toBe('WAITING')
    expect(submits).toBe(2)
    expect((await audioTaskRows(jobId))[0].status).toBe('SUBMITTED')
  }, 240_000)

  it('an UNKNOWN failure quarantines and can NEVER take the retry path', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    const outcome = await runAudioGenerationOnce('a-unk-1', clock, {
      submitSpeech: async () => {
        submits += 1
        // NO spendState: absence is UNKNOWN, and UNKNOWN never retries.
        return {
          status: 'FAILED',
          providerCode: 'MOCK_TTS',
          errorCode: 'ambiguous_transport_failure',
          errorMessage: null,
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') {
      expect(outcome.errorCode).toBe('TTS_PROVIDER_OUTCOME_UNKNOWN')
    }
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    expect(row.submittedAt).not.toBeNull()
    const job = await readJob(jobId)
    expect(job.status).toBe('FAILED')
    expect(job.nextAttemptAt).toBeNull()
    const again = await runAudioGenerationOnce('a-unk-2', clock, {
      submitSpeech: async () => {
        submits += 1
        throw new Error('a quarantined job must never resubmit')
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(again.status).toBe('IDLE')
    expect(submits).toBe(1)
  }, 240_000)

  it('an operation id too long for its column is quarantined after contact', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    const outcome = await runAudioGenerationOnce('a-long-op', clock, {
      submitSpeech: async () => ({
        status: 'SUBMITTED',
        providerCode: 'MOCK_TTS',
        providerOperationId: 'x'.repeat(201),
      }),
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(outcome.status).toBe('FAILED')
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    expect(row.providerOperationId).toBeNull()
  }, 240_000)

  it('a compile refusal in the REAL submitSpeech is provably NOT_SENT', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    // A wrong caller-supplied idempotency key is refused during
    // compilation, strictly before any provider work.
    const result = await submitSpeech({
      requirement,
      generationJobId: jobId,
      manifestSha256: manifest.manifestSha256,
      idempotencyKey: 'deliberately-wrong',
    })
    expect(result.status).toBe('FAILED')
    if (result.status !== 'FAILED') return
    expect(result.errorCode).toBe('idempotency_key_mismatch')
    expect(result.spendState).toBe('NOT_SENT')
  }, 240_000)

  it('a provider-boundary failure in the REAL submitSpeech is never NOT_SENT', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    setTtsProviderForTests({
      code: 'MOCK_TTS',
      displayName: 'throwing test provider',
      isEnabled: () => true,
      submitSpeech: async () => {
        throw new TtsProviderError(
          'provider_unreachable',
          'synthetic transport failure',
          true,
        )
      },
      pollSpeech: async () => {
        throw new TtsProviderError('unused', 'unused', false)
      },
    })
    try {
      const result = await submitSpeech({
        requirement,
        generationJobId: jobId,
        manifestSha256: manifest.manifestSha256,
      })
      expect(result.status).toBe('FAILED')
      if (result.status !== 'FAILED') return
      expect(result.errorCode).toBe('provider_unreachable')
      // The request may have crossed the boundary before the throw.
      expect(result.spendState).toBeUndefined()
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('an in-seam provider SWITCH refusal — NOT_SENT under the NEW code — stays retryable', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    const first = await runAudioGenerationOnce('a-switch-1', clock, {
      submitSpeech: async () => {
        submits += 1
        // The seam's own selection check caught a provider switch and
        // refused BEFORE the network — reporting the NEW provider's
        // code, because that is who it honestly saw. NOT_SENT must be
        // honored BEFORE the provider-binding gate: gating first would
        // quarantine this free refusal into a dead recording.
        return {
          status: 'FAILED',
          providerCode: 'SWITCHED_TTS',
          errorCode: 'provider_selection_changed',
          errorMessage: null,
          spendState: 'NOT_SENT',
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(first.status).toBe('RETRY_SCHEDULED')
    const afterFirst = (await audioTaskRows(jobId))[0]
    // TEETH: retryable, not quarantined — the DATABASE says so.
    expect(afterFirst.status).toBe('FAILED')
    expect(afterFirst.submittedAt).toBeNull()
    expect(afterFirst.providerOperationId).toBeNull()
    expect(afterFirst.lastErrorCode).toBe('provider_selection_changed')

    await advanceToNextAttempt(jobId, clock)
    const second = await runAudioGenerationOnce('a-switch-2', clock, {
      submitSpeech: async () => {
        submits += 1
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          providerOperationId: 'op-after-switch-refusal',
        }
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    // The refusal cost nothing: the SAME requirement submits cleanly
    // under the provider actually reserved.
    expect(second.status).toBe('WAITING')
    expect(submits).toBe(2)
    expect((await audioTaskRows(jobId))[0].status).toBe('SUBMITTED')
  }, 240_000)

  it('a submitSpeech that THROWS after the reservation is quarantined, raw error dropped', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    const marker = `boom-${crypto.randomUUID()}`
    let submits = 0
    const outcome = await runAudioGenerationOnce('a-throw-1', clock, {
      submitSpeech: async () => {
        submits += 1
        // The reservation is durable and the call was in flight when
        // this escaped — the request may already have been accepted.
        throw new Error(marker)
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    // Quarantined DETERMINISTICALLY — never handed to the generic
    // error path, which would burn the budget as a retry and leave
    // the row waiting to go stale.
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') {
      expect(outcome.errorCode).toBe('TTS_PROVIDER_OUTCOME_UNKNOWN')
    }
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    // Submission evidence retained — the NOT_SENT reset can never
    // touch this row.
    expect(row.submittedAt).not.toBeNull()
    // The exception itself was DROPPED, not recorded: raw provider
    // errors reach neither rows nor events.
    expect(
      JSON.stringify({
        rows: await audioTaskRows(jobId),
        events: await jobEventRows(jobId),
      }),
    ).not.toContain(marker)
    const job = await readJob(jobId)
    expect(job.status).toBe('FAILED')
    expect(job.lastErrorCode).toBe('TTS_PROVIDER_OUTCOME_UNKNOWN')
    expect(job.nextAttemptAt).toBeNull()
    const again = await runAudioGenerationOnce('a-throw-2', clock, {
      submitSpeech: async () => {
        submits += 1
        throw new Error('a quarantined job must never resubmit')
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    expect(again.status).toBe('IDLE')
    expect(submits).toBe(1)
  }, 240_000)
})

describe('red-team: admin retry refuses unresolved audio spend (DB-driven)', () => {
  it('a quarantined audio task blocks the generic admin retry', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('a-adm-1', clock, {
        submitSpeech: async () => ({
          status: 'FAILED',
          providerCode: 'MOCK_TTS',
          errorCode: 'ambiguous',
          errorMessage: null,
        }),
        pollSpeech: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('FAILED')
    let refused: unknown
    try {
      await adminRetryGenerationJob(adminId, ctx, jobId)
    } catch (error) {
      refused = error
    }
    expect(String((refused as Error).message)).toContain('unresolved')
    expect((await readJob(jobId)).status).toBe('FAILED')
  }, 240_000)

  it('a LEGACY failed-with-evidence audio row blocks it too', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('a-adm-2', clock, {
        submitSpeech: async () => ({
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          providerOperationId: 'op-legacy',
        }),
        pollSpeech: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('WAITING')
    await getDb()
      .update(prayerGenerationAudioTasks)
      .set({
        status: 'FAILED',
        providerOperationId: null,
        lastErrorCode: 'legacy_provider_error',
      })
      .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
    await getDb()
      .update(prayerGenerationJobs)
      .set({
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      })
      .where(eq(prayerGenerationJobs.id, jobId))
    let refused: unknown
    try {
      await adminRetryGenerationJob(adminId, ctx, jobId)
    } catch (error) {
      refused = error
    }
    expect(String((refused as Error).message)).toContain('unresolved')
  }, 240_000)

  it('a MAX-ATTEMPT STRANDED reservation — still SUBMITTED, no operation id — blocks it', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    // Spend the whole budget beforehand, so the next lease recovery is
    // the LAST: the job dies with its reservation still open, and no
    // later worker cycle ever exists to normalize the row.
    const fresh = await readJob(jobId)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ attemptCount: fresh.maxAttempts - 1 })
      .where(eq(prayerGenerationJobs.id, jobId))

    let refusedWhileStranded: unknown
    const outcome = await runAudioGenerationOnce('a-adm-strand', clock, {
      submitSpeech: async () => {
        // The durable reservation exists NOW. This worker "dies": its
        // lease expires and recovery — budget exhausted — fails the
        // job terminally, stranding the reservation.
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
        const dead = await readJob(jobId)
        expect(dead.status).toBe('FAILED')
        expect(dead.lastErrorCode).toBe('LEASE_EXPIRED')
        expect(dead.nextAttemptAt).toBeNull()
        const stranded = (await audioTaskRows(jobId))[0]
        // THE SHAPE A NARROWER GUARD MISSES: not a quarantine, not a
        // legacy FAILED — literally SUBMITTED with no operation id,
        // while the request may be executing right now.
        expect(stranded.status).toBe('SUBMITTED')
        expect(stranded.providerOperationId).toBeNull()
        expect(stranded.submittedAt).not.toBeNull()
        try {
          await adminRetryGenerationJob(adminId, ctx, jobId)
        } catch (error) {
          refusedWhileStranded = error
        }
        throw new Error('worker dies without a provider verdict')
      },
      pollSpeech: async () => ({ status: 'PROCESSING' }),
    })
    // Refused AT THE MOMENT the row was still a bare reservation.
    expect(String((refusedWhileStranded as Error).message)).toContain(
      'unresolved',
    )
    expect(outcome.status).toBe('LEASE_LOST')
    // The dying worker's own throw then sealed the reservation, and
    // the refusal holds for the sealed shape too.
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    expect(row.submittedAt).not.toBeNull()
    expect((await readJob(jobId)).status).toBe('FAILED')
    let refusedAfter: unknown
    try {
      await adminRetryGenerationJob(adminId, ctx, jobId)
    } catch (error) {
      refusedAfter = error
    }
    expect(String((refusedAfter as Error).message)).toContain('unresolved')
  }, 240_000)

  it('a KNOWN OPERATION mid-poll — SUBMITTED with an operation id — blocks it', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('a-adm-op', clock, {
        submitSpeech: async () => ({
          status: 'SUBMITTED',
          providerCode: 'MOCK_TTS',
          // Deliberately unnormalized: interior caps and surrounding
          // whitespace, valid because it is non-empty after trimming.
          providerOperationId: '  Op-Verbatim-TTS  ',
        }),
        pollSpeech: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('WAITING')
    // BYTE-FOR-BYTE: the id was validated raw and persisted verbatim —
    // never trimmed, lowercased or otherwise "tidied" — because the
    // provider will be asked for it back exactly as issued.
    const submitted = (await audioTaskRows(jobId))[0]
    expect(submitted.providerOperationId).toBe('  Op-Verbatim-TTS  ')
    // The job dies later for an unrelated reason; the paid operation
    // itself is still out there.
    await getDb()
      .update(prayerGenerationJobs)
      .set({
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastErrorCode: 'LEASE_EXPIRED',
      })
      .where(eq(prayerGenerationJobs.id, jobId))
    let refused: unknown
    try {
      await adminRetryGenerationJob(adminId, ctx, jobId)
    } catch (error) {
      refused = error
    }
    expect(String((refused as Error).message)).toContain('unresolved')
    // And the operation record is untouched — reconciliation, not
    // amnesia.
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('SUBMITTED')
    expect(row.providerOperationId).toBe('  Op-Verbatim-TTS  ')
  }, 240_000)

  it('even a SUCCEEDED task blocks it — paid output a restart would abandon and re-buy', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('a-adm-succ-1', clock, realDependencies))
        .status,
    ).toBe('WAITING')
    clock.advance(AUDIO_TASK_POLL_DELAY_MS + 60_000)
    expect(
      (await runAudioGenerationOnce('a-adm-succ-2', clock, realDependencies))
        .status,
    ).toBe('COMPLETE')
    expect((await readJob(jobId)).status).toBe('RENDERING')
    // A LATER stage then fails the job; the audio spend is real and
    // already delivered.
    await getDb()
      .update(prayerGenerationJobs)
      .set({
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      })
      .where(eq(prayerGenerationJobs.id, jobId))
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('SUCCEEDED')
    expect(row.submittedAt).not.toBeNull()
    let refused: unknown
    try {
      await adminRetryGenerationJob(adminId, ctx, jobId)
    } catch (error) {
      refused = error
    }
    // Restart-from-PREPARING would mint fresh task identities and buy
    // this synthesis a second time while abandoning the artifact
    // already paid for.
    expect(String((refused as Error).message)).toContain('unresolved')
  }, 240_000)

  it('a provably-unsent failure (submittedAt NULL) remains retryable — the control', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runAudioGenerationOnce('a-adm-free', clock, {
        submitSpeech: async () => ({
          status: 'FAILED',
          providerCode: 'MOCK_TTS',
          errorCode: 'synthetic_pre_network_refusal',
          errorMessage: null,
          spendState: 'NOT_SENT',
        }),
        pollSpeech: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('RETRY_SCHEDULED')
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('FAILED')
    expect(row.submittedAt).toBeNull()
    // The job's own budget then runs out on later, equally free
    // failures — seeded directly; the row keeps its NOT_SENT shape.
    await getDb()
      .update(prayerGenerationJobs)
      .set({
        status: 'FAILED',
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        resumeStatus: null,
      })
      .where(eq(prayerGenerationJobs.id, jobId))
    // TEETH: the blunt rule does NOT overreach. No submission evidence
    // exists, so the generic retry PROCEEDS.
    await adminRetryGenerationJob(adminId, ctx, jobId)
    const retried = await readJob(jobId)
    expect(retried.status).toBe('RETRYING')
    expect(retried.resumeStatus).toBe('PREPARING')
    expect(retried.attemptCount).toBe(0)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 20: 9jaLingo — the synchronous production TTS provider
// ----------------------------------------------------------------------------

/** Test doubles ONLY: zero network, zero real API, zero spend. */
const NAIJALINGO_TEST_CONFIG: NaijalingoTtsConfig = {
  apiKey: 'rt-test-secret-key',
  baseUrl: 'https://api.example-9jalingo.test/v1',
  model: 'naijalingo-tts-1',
  maleVoiceId: 'adeola_yo_male',
  femaleVoiceId: 'adeola_yo_female',
}

/** Minimal coherent PCM WAV (16 kHz mono 16-bit ⇒ byteRate 32000). */
function buildTestWav(dataBytes: number): Uint8Array {
  const data = new Uint8Array(dataBytes)
  for (let i = 0; i < data.length; i += 1) data[i] = (i * 7) % 251
  const bytes = new Uint8Array(44 + data.length)
  const view = new DataView(bytes.buffer)
  const writeTag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      bytes[offset + i] = text.charCodeAt(i)
    }
  }
  writeTag(0, 'RIFF')
  view.setUint32(4, 36 + data.length, true)
  writeTag(8, 'WAVE')
  writeTag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 16_000, true)
  view.setUint32(28, 32_000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeTag(36, 'data')
  view.setUint32(40, data.length, true)
  bytes.set(data, 44)
  return bytes
}

/** A REAL yo-language sacred fixture plus the manifest-shaped
 * requirement the executor would derive for it — no job or template
 * plumbing needed for service-level proofs. */
async function makeYorubaTtsRequirement(): Promise<{
  requirement: ManifestAudioRequirement
  bodyMarker: string
  identity: { generationJobId: number; manifestSha256: string }
}> {
  const theme = `${CODE_PREFIX}_9JA_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  const sacred = await makeEligibleSacred({
    themeCode: theme,
    contentType: 'PRAYER',
    voicePolicy: 'APPROVED_TTS_ALLOWED',
    language: 'yo',
  })
  const profile = (
    await getDb()
      .select({
        contentSha256: sacredContentVersionProfiles.contentSha256,
      })
      .from(sacredContentVersionProfiles)
      .where(eq(sacredContentVersionProfiles.contentVersionId, sacred.versionId))
      .limit(1)
  ).at(0)!
  const requirement: ManifestAudioRequirement = {
    mode: 'TTS_PENDING',
    mediaAssetVersionId: null,
    fileSha256: null,
    contentVersionId: sacred.versionId,
    contentSha256: profile.contentSha256!,
    language: 'yo',
    voicePolicy: 'APPROVED_TTS_ALLOWED',
    requirementId: `req-9ja-${crypto.randomUUID().slice(0, 8)}`,
    sceneId: 'scene-9ja-1',
    startMs: 0,
    endMs: 10_000,
  }
  return {
    requirement,
    bodyMarker: sacred.bodyMarker,
    identity: {
      generationJobId: 987_654,
      manifestSha256: 'b'.repeat(64),
    },
  }
}

describe('red-team: 9jaLingo synchronous synthesis (fake client, ZERO network)', () => {
  it('the REAL seam + REAL adapter sends the exact approved Yoruba text once and answers COMPLETED with stored, hashed bytes', async () => {
    const { requirement, bodyMarker, identity: taskIdentity } =
      await makeYorubaTtsRequirement()
    const wav = buildTestWav(64_000) // 2000 ms at byteRate 32000
    const calls: Array<NaijalingoSpeechRequestBody> = []
    setTtsProviderForTests(
      createNaijalingoTtsProvider(NAIJALINGO_TEST_CONFIG, {
        async createSpeech(body) {
          calls.push(body)
          return wav
        },
      }),
    )
    try {
      const result = await submitSpeech({ requirement, ...taskIdentity })
      // ONE call carrying the approved text VERBATIM — the fixture's
      // exact body — under the operator-configured voice and model,
      // as Yoruba, as WAV, and nothing else.
      expect(calls).toHaveLength(1)
      expect(calls[0].input).toBe(bodyMarker)
      expect(calls[0].lang).toBe('yo')
      expect(calls[0].response_format).toBe('wav')
      // The fixture House speaks with the approved male voice, so the
      // MALE catalogue id is the one that left the process.
      expect(calls[0].voice).toBe(NAIJALINGO_TEST_CONFIG.maleVoiceId)
      expect(calls[0].model).toBe(NAIJALINGO_TEST_CONFIG.model)
      expect(Object.keys(calls[0]).sort()).toEqual([
        'input',
        'lang',
        'model',
        'response_format',
        'voice',
      ])

      expect(result.status).toBe('COMPLETED')
      if (result.status !== 'COMPLETED') return
      expect(result.providerCode).toBe('9JALINGO')
      // The ACTUAL returned bytes were hashed fresh and stored — the
      // claim is provable against private storage right now.
      expect(result.artifactSha256).toBe(computeFileSha256(wav))
      expect(result.artifactMimeType).toBe('audio/wav')
      expect(result.artifactDurationMs).toBe(2_000)
      const stored = readFileSync(join(storageRoot, result.artifactStorageRef))
      expect(new Uint8Array(stored)).toEqual(new Uint8Array(wav))
      // And the result the pipeline would persist carries no text.
      expect(JSON.stringify(result)).not.toContain(bodyMarker)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('an unsupported language is refused NOT_SENT, BEFORE compilation, with ZERO client calls', async () => {
    let clientCalls = 0
    setTtsProviderForTests(
      createNaijalingoTtsProvider(NAIJALINGO_TEST_CONFIG, {
        async createSpeech() {
          clientCalls += 1
          throw new Error('the client must never be reached')
        },
      }),
    )
    try {
      // The contentVersionId deliberately does NOT exist: if the
      // language gate ran AFTER compilation, this would surface
      // sacred_content_missing instead. Seeing the language refusal
      // proves the gate fires before the body could even be looked up.
      const requirement = {
        mode: 'TTS_PENDING',
        mediaAssetVersionId: null,
        fileSha256: null,
        contentVersionId: 999_999_999,
        contentSha256: 'c'.repeat(64),
        language: 'en',
        voicePolicy: 'APPROVED_TTS_ALLOWED',
        requirementId: 'req-9ja-en-refusal',
        sceneId: 'scene-9ja-en',
        startMs: 0,
        endMs: 10_000,
      } as ManifestAudioRequirement
      const result = await submitSpeech({
        requirement,
        generationJobId: 987_655,
        manifestSha256: 'b'.repeat(64),
      })
      expect(result.status).toBe('FAILED')
      if (result.status !== 'FAILED') return
      expect(result.errorCode).toBe('language_unsupported_by_provider')
      // PROVABLY not sent: freely retryable, never quarantined — and
      // the prayer is NEVER translated to fit a provider.
      expect(result.spendState).toBe('NOT_SENT')
      expect(clientCalls).toBe(0)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('a thrown client call surfaces as a FIXED unknown-spend failure with no text or key in it', async () => {
    const { requirement, bodyMarker, identity: taskIdentity } =
      await makeYorubaTtsRequirement()
    const marker = `leak-${crypto.randomUUID()}`
    setTtsProviderForTests(
      createNaijalingoTtsProvider(NAIJALINGO_TEST_CONFIG, {
        async createSpeech() {
          throw new Error(
            `transport blew up: ${marker} key=${NAIJALINGO_TEST_CONFIG.apiKey}`,
          )
        },
      }),
    )
    try {
      const result = await submitSpeech({ requirement, ...taskIdentity })
      expect(result.status).toBe('FAILED')
      if (result.status !== 'FAILED') return
      expect(result.errorCode).toBe('provider_call_failed')
      // NO spendState: the call was in flight, so the executor treats
      // it as an unknown outcome and quarantines — the exact discipline
      // every ambiguous submission already gets.
      expect(result.spendState).toBeUndefined()
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain(marker)
      expect(serialized).not.toContain(NAIJALINGO_TEST_CONFIG.apiKey)
      expect(serialized).not.toContain(bodyMarker)
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('bytes that are not a coherent WAV are a failed synthesis with unknown spend — never an artifact', async () => {
    const { requirement, identity: taskIdentity } =
      await makeYorubaTtsRequirement()
    setTtsProviderForTests(
      createNaijalingoTtsProvider(NAIJALINGO_TEST_CONFIG, {
        async createSpeech() {
          return new TextEncoder().encode('<html>502 Bad Gateway</html>')
        },
      }),
    )
    try {
      const result = await submitSpeech({ requirement, ...taskIdentity })
      expect(result.status).toBe('FAILED')
      if (result.status !== 'FAILED') return
      expect(result.errorCode).toBe('artifact_wav_invalid')
      expect(result.spendState).toBeUndefined()
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)
})

describe('red-team: the synchronous COMPLETED path through the JOB LOOP (DB-driven)', () => {
  it('a synchronous success resolves the reservation DIRECTLY to SUCCEEDED and finalizes in ONE cycle', async () => {
    const { jobId, bodyMarker } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    const wav = buildTestWav(64_000)
    const outcome = await runAudioGenerationOnce('a-sync-ok', clock, {
      submitSpeech: async () => {
        submits += 1
        // AT-MOST-ONCE IS PRESERVED: the durable reservation exists
        // BEFORE the synchronous call, exactly as for async providers.
        const reserved = (await audioTaskRows(jobId))[0]
        expect(reserved.status).toBe('SUBMITTED')
        expect(reserved.providerOperationId).toBeNull()
        expect(reserved.submittedAt).not.toBeNull()
        // The seam stores the verified bytes BEFORE answering — this
        // fake does exactly what the real one does.
        const { storageKey } = await storage.put(wav, 'wav')
        return {
          status: 'COMPLETED',
          providerCode: 'MOCK_TTS',
          artifactSha256: computeFileSha256(wav),
          artifactMimeType: 'audio/wav',
          artifactDurationMs: 2_000,
          artifactStorageRef: storageKey,
        }
      },
      pollSpeech: async () => {
        throw new Error('a synchronous completion must never be polled')
      },
    })
    // ONE cycle: submit → SUCCEEDED → finalization gate → RENDERING.
    expect(outcome.status).toBe('COMPLETE')
    expect(submits).toBe(1)
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('SUCCEEDED')
    // No operation id ever existed and none was invented.
    expect(row.providerOperationId).toBeNull()
    // Submission evidence is RETAINED — the generic admin retry stays
    // blocked for this paid, delivered work.
    expect(row.submittedAt).not.toBeNull()
    expect(row.artifactSha256).toBe(computeFileSha256(wav))
    expect(row.artifactMimeType).toBe('audio/wav')
    const stored = readFileSync(join(storageRoot, row.artifactStorageRef!))
    expect(new Uint8Array(stored)).toEqual(new Uint8Array(wav))
    expect((await readJob(jobId)).status).toBe('RENDERING')
    // Nothing about the approved text survives anywhere.
    const payload = JSON.stringify({
      rows: await audioTaskRows(jobId),
      events: await jobEventRows(jobId),
      job: await readJob(jobId),
    })
    expect(payload).not.toContain(bodyMarker)
  }, 240_000)

  it('a LOST success CAS removes the freshly stored artifact and NEVER synthesizes again', async () => {
    const { jobId } = await makeTtsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    let storedKey: string | null = null
    const wav = buildTestWav(32_000)
    const outcome = await runAudioGenerationOnce('a-sync-lost', clock, {
      submitSpeech: async () => {
        submits += 1
        // While the (long) synchronous call is in flight, another
        // worker judges the reservation stale and seals it — the same
        // quarantine the stale-reservation sweep writes.
        await getDb()
          .update(prayerGenerationAudioTasks)
          .set({
            status: 'CANCELLED',
            lastErrorCode: 'provider_outcome_unknown',
            completedAt: new Date(),
          })
          .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
        const { storageKey } = await storage.put(wav, 'wav')
        storedKey = storageKey
        expect(await storage.exists(storageKey)).toBe(true)
        return {
          status: 'COMPLETED',
          providerCode: 'MOCK_TTS',
          artifactSha256: computeFileSha256(wav),
          artifactMimeType: 'audio/wav',
          artifactDurationMs: 1_000,
          artifactStorageRef: storageKey,
        }
      },
      pollSpeech: async () => {
        throw new Error('nothing exists to poll')
      },
    })
    // The job fails CLOSED on the unresolved spend…
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') {
      expect(outcome.errorCode).toBe('TTS_PROVIDER_OUTCOME_UNKNOWN')
    }
    // …the orphan bytes this cycle stored are GONE…
    expect(storedKey).not.toBeNull()
    expect(await storage.exists(storedKey!)).toBe(false)
    // …the quarantine stands untouched…
    const row = (await audioTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    // …and there is NO automatic second synthesis, ever.
    const again = await runAudioGenerationOnce('a-sync-lost-2', clock, {
      submitSpeech: async () => {
        submits += 1
        throw new Error('a sealed spend must never be re-bought')
      },
      pollSpeech: async () => {
        throw new Error('nothing exists to poll')
      },
    })
    expect(again.status).toBe('IDLE')
    expect(submits).toBe(1)
  }, 240_000)
})

describe('red-team: nothing personal can become sacred speech', () => {
  /**
   * THE BOUNDARY THIS PINS, and why it is worth a test rather than a
   * comment.
   *
   * Phase One personalization is governed SELECTION and appointment-
   * specific COMPOSITION — which approved blocks, in which order, over
   * which approved imagery, seeded from the appointment. It is not, and
   * must not silently become, textual substitution into approved sacred
   * wording.
   *
   * That distinction is currently kept by ABSENCE: there is no merge
   * field, no placeholder syntax, no interpolation step, and no field on
   * the provider contract a recipient's name could travel through.
   * Absence is fragile — a single well-meaning `body.replace(...)` would
   * end it without any governance decision being taken. So the absence
   * is asserted.
   *
   * Spoken recipient-name address may well be wanted later. When it is,
   * it should arrive as an approved capability with its own authority
   * and its own evidence — and this test should fail loudly and be
   * changed deliberately, which is exactly the point.
   */
  function sourceOf(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  const SPEECH_PATH = [
    'src/services/audio-generation.ts',
    'src/providers/tts/types.ts',
    'src/providers/tts/naijalingo.ts',
    'src/providers/tts/mock.ts',
    'src/providers/tts/disabled.ts',
  ]

  it('carries no personal appointment field anywhere near synthesis', () => {
    for (const file of SPEECH_PATH) {
      const source = sourceOf(file)
      for (const forbidden of [
        'preferredName',
        'recipientName',
        'fullName',
        'privateRequestNote',
        'dateOfBirth',
        'phone',
      ]) {
        expect(`${file}:${forbidden}`).toBe(
          source.includes(forbidden) ? `${file}:LEAKED` : `${file}:${forbidden}`,
        )
      }
    }
  })

  it('has no substitution mechanism the approved body passes through', () => {
    for (const file of SPEECH_PATH) {
      const source = sourceOf(file)
      // Template-ish syntaxes a merge field would plausibly use.
      expect(source).not.toContain('{{')
      expect(source).not.toContain('%NAME%')
      // And no rewriting of the body itself. The body is read, hashed
      // and handed over; it is never edited.
      expect(source).not.toMatch(/\bbody\s*\.\s*(replace|replaceAll)\b/)
      expect(source).not.toMatch(/\bapprovedText\s*\.\s*(replace|replaceAll)\b/)
      expect(source).not.toMatch(/approvedText\s*:\s*`/)
    }
  })

  it('hands the provider the approved body itself, unmodified', () => {
    const source = sourceOf('src/services/audio-generation.ts')
    // The compiled request names the body directly — not a derived
    // string, not a formatted one.
    expect(source).toContain('approvedText: body')
  })

  it('offers the vendor no field a name or a voice sample could enter', () => {
    const contract = sourceOf('src/providers/tts/types.ts')
    const request = contract.slice(
      contract.indexOf('export interface SpeechSynthesisRequest'),
      contract.indexOf('export type SpeechSynthesisJobStatus'),
    )
    expect(request.length).toBeGreaterThan(0)
    for (const forbidden of [
      'speakerSample',
      'referenceAudio',
      'voiceSample',
      'personalization',
      'variables',
      'context',
    ]) {
      expect(request).not.toContain(forbidden)
    }
    // The adapter's outbound body is a closed allowlist; nothing that
    // is not one of these five fields can reach the vendor.
    const adapter = sourceOf('src/providers/tts/naijalingo.ts')
    expect(adapter).toContain('input')
    expect(adapter).toContain('response_format')
    expect(adapter).not.toContain('temperature')
    expect(adapter).not.toContain('top_p')
    expect(adapter).not.toContain('repetition_penalty')
  })

  it('keeps the preflight local — it contacts no provider at all', () => {
    // The configuration probe must remain unable to spend AND unable to
    // overstate. An earlier version called GET {baseUrl}/models on the
    // reasoning that the synthesis surface is OpenAI-compatible; that
    // was an inference rather than a documented contract, and worse, a
    // 404 from an undocumented path cannot show that credentials were
    // accepted — a server may answer 404 before it looks at
    // authorization at all. So the script makes no network call, and
    // this asserts it structurally rather than trusting the comment.
    const preflight = sourceOf('scripts/tts-preflight.ts')
    expect(preflight).not.toContain('audio/speech')
    expect(preflight).not.toContain('submitSpeech')
    expect(preflight).not.toContain('approvedText')
    expect(preflight).not.toContain('/models')
    expect(preflight).not.toContain('fetch(')
    expect(preflight).not.toContain('XMLHttpRequest')
    // And it must say plainly what it could not establish.
    expect(preflight).toContain('NOT VERIFIED')
    // And presence is not plausibility: an unreplaced template
    // string must fail rather than pass. This script once answered
    // "0 failing" for a model configured as YOUR_VERIFIED_MODEL_ID.
    expect(preflight).toContain('PLACEHOLDER_PREFIXES')
    expect(preflight).toContain('looksUnset')
  })

  it('claims only that byte-identical re-synthesis is UNGUARANTEED', () => {
    /**
     * A wording correction worth pinning, because the stronger claim is
     * both wrong and tempting.
     *
     * The vendor's synthesis takes sampling parameters with nonzero
     * defaults, which this adapter deliberately does not send. It
     * follows that repeated synthesis of the same approved text is not
     * GUARANTEED to be byte-identical — not that it CANNOT be. Two
     * stochastic generations may coincide, and a vendor may change its
     * defaults.
     *
     * The architectural point survives either way and is the one that
     * matters: nothing may depend on re-synthesis reproducing bytes.
     * The stored artifact's SHA-256 is the integrity identity, and it
     * is taken from the artifact that was actually produced.
     */
    for (const file of [
      'scripts/tts-preflight.ts',
      'src/providers/tts/naijalingo.ts',
      'src/services/audio-generation.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).not.toContain('will not produce byte-identical')
      expect(source).not.toContain('cannot be byte-identical')
      expect(source).not.toContain('never byte-identical')
    }
  })
})

// ----------------------------------------------------------------------------
// Step 21: the House decides the voice — and an undecided House is silent
// ----------------------------------------------------------------------------

/** Sets the fixture House's approved voice for one test and puts it
 * back afterwards. The suite owns this House, so it owns its voice. */
async function withHouseVoice(
  profile: 'YO_MALE' | 'YO_FEMALE' | null,
  run: () => Promise<void>,
): Promise<void> {
  const db = getDb()
  try {
    await db
      .update(sacredHouses)
      .set({ approvedVoiceProfile: profile })
      .where(eq(sacredHouses.id, houseId))
    await run()
  } finally {
    await db
      .update(sacredHouses)
      .set({ approvedVoiceProfile: 'YO_MALE' })
      .where(eq(sacredHouses.id, houseId))
  }
}

describe('red-team: the voice belongs to the House, not to the caller', () => {
  it('speaks a House-scoped prayer in that House’s approved voice', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    await withHouseVoice('YO_FEMALE', async () => {
      const captured: Array<SpeechSynthesisRequest> = []
      setTtsProviderForTests(capturingProvider(captured))
      try {
        const submitted = await submitSpeech({
          requirement,
          ...identity(jobId, manifest),
        })
        expect(submitted.status).toBe('SUBMITTED')
        expect(captured).toHaveLength(1)
        // TEETH: the voice followed the HOUSE. Nothing about the
        // requirement, the job or the appointment changed between this
        // test and the male-voiced one — only whose words they are.
        expect(captured[0].voiceProfile).toBe('YO_FEMALE')
      } finally {
        resetTtsProviderForTests()
      }
    })
  }, 240_000)

  it('refuses a House that has no approved voice — before the body is read', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    await withHouseVoice(null, async () => {
      const counters = { submits: 0, polls: 0 }
      setTtsProviderForTests(countingProvider('MOCK_TTS', counters))
      try {
        const compiled = await compileSpeechSynthesisRequest(
          requirement,
          identity(jobId, manifest),
        )
        expect(compiled.status).toBe('FAILED')
        if (compiled.status !== 'FAILED') return
        // A bounded machine code — never a provider string, never a
        // House name, and never the words themselves.
        expect(compiled.reasonCode).toBe('voice_profile_unassigned')

        const submitted = await submitSpeech({
          requirement,
          ...identity(jobId, manifest),
        })
        expect(submitted.status).toBe('FAILED')
        if (submitted.status !== 'FAILED') return
        expect(submitted.errorCode).toBe('voice_profile_unassigned')
        // TEETH: no provider was reached, so nothing was spent and the
        // spend state is provable rather than assumed.
        expect(submitted.spendState).toBe('NOT_SENT')
        expect(counters.submits).toBe(0)
      } finally {
        resetTtsProviderForTests()
      }
    })
  }, 240_000)

  it('carries a PROFILE across the boundary, never a vendor catalogue id', async () => {
    const { jobId, manifest, requirement } = await makeTtsJob()
    const captured: Array<SpeechSynthesisRequest> = []
    setTtsProviderForTests(capturingProvider(captured))
    try {
      await submitSpeech({ requirement, ...identity(jobId, manifest) })
      expect(captured).toHaveLength(1)
      // Everything EXCEPT the approved body, whose text is the House's
      // own and is checked verbatim elsewhere. (This suite's fixture
      // body carries a UUID marker, so including it here would prove
      // nothing about the vendor's namespace.)
      const { approvedText, ...rest } = captured[0]
      expect(approvedText.length).toBeGreaterThan(0)
      const serialized = JSON.stringify(rest)
      // The vendor's namespace stops at the adapter. Whatever this
      // deployment has configured, it is not in the compiled request —
      // and neither is anything else UUID-shaped.
      for (const configured of [
        env.NAIJALINGO_YO_MALE_VOICE_ID,
        env.NAIJALINGO_YO_FEMALE_VOICE_ID,
      ]) {
        if (configured.trim().length > 0) {
          expect(serialized).not.toContain(configured)
        }
      }
      expect(serialized).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      )
      // Nor the API key, in whole or in part.
      if (env.NAIJALINGO_API_KEY.trim().length > 0) {
        expect(serialized).not.toContain(env.NAIJALINGO_API_KEY)
      }
    } finally {
      resetTtsProviderForTests()
    }
  }, 240_000)

  it('has no path by which a request could choose its own voice', () => {
    const service = readFileSync(
      join(process.cwd(), 'src/services/audio-generation.ts'),
      'utf8',
    )
    // The profile is resolved from the loaded House row and from
    // nothing else. If the compiled request ever read a voice out of
    // the requirement, the manifest or the task identity, a forged
    // manifest could pick the voice of a House it does not belong to.
    expect(service).toContain('voiceProfile: voice.profile')
    expect(service).not.toContain('requirement.voiceProfile')
    expect(service).not.toContain('input.voiceProfile')
    expect(service).not.toContain('request.voiceProfile')
  })
})
