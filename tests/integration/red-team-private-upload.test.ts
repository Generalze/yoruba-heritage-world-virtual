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
  prayerGenerationUploads,
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
  publishMediaVersion,
  setMediaRightsStatus,
  setMediaRuntimeEnabled,
  submitMediaVersion,
} from '@/services/media-assets'
import {
  AUDIO_TASK_POLL_DELAY_MS,
  DEFAULT_LEASE_MS,
  GENERATION_TRANSITIONS,
  VISUAL_TASK_POLL_DELAY_MS,
  claimNextUploadJob,
  isLegalTransition,
  recoverExpiredGenerationLeases,
  runAudioGenerationOnce,
  runGenerationPreparationOnce,
  runVisualGenerationOnce,
} from '@/services/generation-jobs'
import { runStoryboardPlanningOnce } from '@/services/generation-storyboards'
import { runRenderOnce } from '@/services/render-assembly'
import {
  buildCanonicalObjectKey,
  computeUploadIdempotencyKey,
  runUploadOnce,
} from '@/services/render-upload'
import {
  LocalPrivateObjectStorage,
  isValidPrivateObjectKey,
} from '@/providers/object-storage/local'
import {
  checkObjectStorageAllowed,
  resetObjectStorageForTests,
  setObjectStorageForTests,
} from '@/providers/object-storage/registry'
import {
  MAX_SIGNED_URL_TTL_SECONDS,
  OBJECT_ALREADY_EXISTS_CODE,
  ObjectStorageError,
} from '@/providers/object-storage/types'
import { resolveS3CompatibleConfig } from '@/providers/object-storage/s3'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { GenerationClock } from '@/services/generation-jobs'
import type {
  ObjectStorageProvider,
  PrivateObjectDescriptor,
} from '@/providers/object-storage/types'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * ============================================================================
 * RED TEAM — Phase One, Step 17 (private object storage + upload),
 * verified against landed source: src/db/schema/uploads.ts,
 * src/services/render-upload.ts and
 * src/providers/object-storage/{types,local,s3,registry}.ts.
 *
 * The properties this suite exists to defend:
 *   1. the destination key is SERVER-GENERATED from an opaque identity
 *      and carries nothing anyone could recognise;
 *   2. an interrupted upload converges — the canonical object is
 *      adopted, never duplicated, and a DIFFERENT object at that key is
 *      never overwritten;
 *   3. "the provider said OK" is never proof — remote integrity is
 *      re-proved against the exact local artifact, and an ETag is never
 *      accepted as a SHA-256; and
 *   4. nothing is exposed: no signed URL is persisted or logged, and
 *      local/mock storage can never stand in for production.
 * ============================================================================
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `redteam upload test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const createdItemIds: Array<number> = []
const createdAssetIds: Array<number> = []
const createdTemplateIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'

let adminId: number
let cmId: number
let houseId: number
let mediaRoot: string
let objectRoot: string
let mediaStorage: LocalMediaStorageProvider
let objectStorage: LocalPrivateObjectStorage
let servicePool: Array<number> = []
let serviceCursor = 0

const RUN_KEY = crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')
const CODE_PREFIX = `RTU_${RUN_KEY}`
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

/** Recognisable personal details — every one of them must be absent
 * from the object key, the upload row and the event log. */
const PERSONAL_NAME_MARKER = 'Adéwálé Olúṣọlá Adébáyọ̀'
const PERSONAL_PHONE_MARKER = '+2348012345678'
const SACRED_BODY_MARKER = 'Red-team-upload sacred block body'

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `rtu-${crypto.randomUUID()}@test.local`,
      preferredName: 'RTU Fixture',
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

async function makeEligibleSacred(options: {
  themeCode: string
  voicePolicy?: 'TEXT_ONLY' | 'APPROVED_TTS_ALLOWED'
}): Promise<{ versionId: number; bodyMarker: string }> {
  const bodyMarker = `${SACRED_BODY_MARKER} ${crypto.randomUUID()}`
  const item = await createSacredContentItem(cmId, ctx, {
    code: nextCode('SC'),
    contentType: 'PRAYER',
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
    { language: 'en', title: 'Red-team upload sacred block', body: bodyMarker },
    sacredProfile({
      themeCode: options.themeCode,
      voicePolicy: options.voicePolicy ?? 'APPROVED_TTS_ALLOWED',
    }),
  )
  await submitVersionForReview(cmId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, version.id, true)
  return { versionId: version.id, bodyMarker }
}

async function makeEligibleImage(themeCode: string): Promise<number> {
  const asset = await createMediaAsset(cmId, ctx, {
    code: nextCode('MA'),
    assetKind: 'IMAGE',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    contentType: 'PRAYER',
    themeCode,
  })
  createdAssetIds.push(asset.id)
  const version = await createMediaVersion(
    cmId,
    ctx,
    asset.id,
    new TextEncoder().encode(`redteam-upload-image ${crypto.randomUUID()}`),
    'image/png',
    {
      sourceType: 'IN_HOUSE',
      language: null,
      durationSeconds: null,
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
  return version.id
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
): Promise<void> {
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

async function uploadRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationUploads)
    .where(eq(prayerGenerationUploads.generationJobId, jobId))
}

async function renderResultRow(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationRenderResults)
      .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
      .limit(1)
  ).at(0)!
}

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
        'UPLOADING',
      ]),
    )
  await getDb()
    .update(prayerGenerationJobs)
    .set({ status: 'QUEUED' })
    .where(eq(prayerGenerationJobs.id, exceptJobId))
}

/** Drives one appointment through every real upstream stage to
 * UPLOADING. Nothing about the upload stage is faked into place. */
async function makeUploadableJob(): Promise<{
  jobId: number
  clock: ReturnType<typeof makeFakeClock>
  bodyMarker: string
}> {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_U_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  const sacred = await makeEligibleSacred({ themeCode: theme })
  await makeEligibleImage(theme)
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
  ])
  const userId = await makeEligibleUser()
  const reservation = await createReservation(userId, ctx, {
    serviceId,
    startsAtUtc: nextSlot(),
  })
  await confirmReservation(reservation.appointmentId, ctx)
  const job = (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.appointmentId, reservation.appointmentId))
  ).at(0)!
  await quiesceOtherJobs(job.id)
  const clock = makeFakeClock(Date.now())
  expect((await runGenerationPreparationOnce('rtu-prep', clock)).status).toBe(
    'PREPARED',
  )
  expect((await runStoryboardPlanningOnce('rtu-plan', clock)).status).toBe(
    'PLANNED',
  )
  for (let cycle = 0; cycle < 8; cycle += 1) {
    if ((await jobRow(job.id)).status !== 'GENERATING_VISUALS') break
    const outcome = await runVisualGenerationOnce(`rtu-vis-${cycle}`, clock)
    if (outcome.status === 'WAITING') {
      clock.advance(VISUAL_TASK_POLL_DELAY_MS + 1_000)
    }
  }
  for (let cycle = 0; cycle < 8; cycle += 1) {
    if ((await jobRow(job.id)).status !== 'GENERATING_AUDIO') break
    const outcome = await runAudioGenerationOnce(`rtu-aud-${cycle}`, clock)
    if (outcome.status === 'WAITING') {
      clock.advance(AUDIO_TASK_POLL_DELAY_MS + 1_000)
    }
  }
  expect((await runRenderOnce('rtu-render', clock)).status).toBe('COMPLETE')
  expect((await jobRow(job.id)).status).toBe('UPLOADING')
  return { jobId: job.id, clock, bodyMarker: sacred.bodyMarker }
}

/** The canonical destination this job's artifact must land at, computed
 * independently of the service so the test proves the key rather than
 * echoing it. */
async function canonicalKeyFor(jobId: number): Promise<{
  objectKey: string
  idempotencyKey: string
  sha256: string
  byteSize: number
}> {
  const result = await renderResultRow(jobId)
  const idempotencyKey = computeUploadIdempotencyKey({
    generationJobId: jobId,
    renderResultId: result.id,
    renderPlanSha256: result.renderPlanSha256,
    artifactSha256: result.artifactSha256!,
  })
  const canonical = buildCanonicalObjectKey(
    idempotencyKey,
    result.artifactMimeType!,
  )
  expect(canonical.ok).toBe(true)
  if (!canonical.ok) throw new Error('canonical key failed')
  const bytes = new Uint8Array(
    readFileSync(join(mediaRoot, result.artifactStorageRef!)),
  )
  return {
    objectKey: canonical.objectKey,
    idempotencyKey,
    sha256: result.artifactSha256!,
    byteSize: bytes.length,
  }
}

async function localArtifactBytes(jobId: number): Promise<Uint8Array> {
  const result = await renderResultRow(jobId)
  return new Uint8Array(readFileSync(join(mediaRoot, result.artifactStorageRef!)))
}

/** Wraps the suite's object storage and counts real writes, so "no
 * second upload" is proved by observation rather than inference. */
function countingObjectStorage(counter: { puts: number }): ObjectStorageProvider {
  return {
    code: objectStorage.code,
    isLocal: objectStorage.isLocal,
    isEnabled: () => objectStorage.isEnabled(),
    putPrivateObject: async (input) => {
      counter.puts += 1
      return objectStorage.putPrivateObject(input)
    },
    headPrivateObject: (key) => objectStorage.headPrivateObject(key),
    getPrivateObject: (key) => objectStorage.getPrivateObject(key),
    removePrivateObject: (key) => objectStorage.removePrivateObject(key),
    verifyPrivateObjectIntegrity: (input) =>
      objectStorage.verifyPrivateObjectIntegrity(input),
    createSignedReadUrl: (input) => objectStorage.createSignedReadUrl(input),
  }
}

beforeAll(async () => {
  mediaRoot = mkdtempSync(join(tmpdir(), 'yhw-redteam-upload-media-'))
  objectRoot = mkdtempSync(join(tmpdir(), 'yhw-redteam-upload-objects-'))
  mediaStorage = new LocalMediaStorageProvider(mediaRoot)
  objectStorage = new LocalPrivateObjectStorage(objectRoot)
  setMediaStorageForTests(mediaStorage)
  setObjectStorageForTests(objectStorage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'RTU\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'RTU\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'RTU\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `RTUH_${key}`.toUpperCase(),
    name: `RTU House ${key}`,
    slug: `rtuh-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 32; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `RTUS${i}_${key}`.toUpperCase(),
      name: `RTU Service ${i} ${key}`,
      slug: `rtus${i}-${key}`,
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
          .delete(prayerGenerationUploads)
          .where(inArray(prayerGenerationUploads.generationJobId, jobIds))
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
  resetObjectStorageForTests()
  for (const dir of [mediaRoot, objectRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort temp cleanup
    }
  }
  await closeDb()
})

// ----------------------------------------------------------------------------
// Item 1: the happy path, deterministic identity, and an opaque key
// ----------------------------------------------------------------------------

describe('red-team: a verified render uploads once to a canonical private key', () => {
  it('reaches READY with one upload row at the independently-derived key', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const expected = await canonicalKeyFor(jobId)
    const counter = { puts: 0 }
    setObjectStorageForTests(countingObjectStorage(counter))
    let outcome
    try {
      outcome = await runUploadOnce('rtu-upload', clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(outcome.status).toBe('COMPLETE')
    expect((await jobRow(jobId)).status).toBe('READY')
    expect(counter.puts).toBe(1)

    const rows = await uploadRows(jobId)
    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row.status).toBe('SUCCEEDED')
    // TEETH: the key and the idempotency hash are derivable from
    // authority alone — the service did not invent them.
    expect(row.idempotencyKey).toBe(expected.idempotencyKey)
    expect(row.objectKey).toBe(expected.objectKey)
    expect(row.artifactSha256).toBe(expected.sha256)
    expect(row.byteSize).toBe(expected.byteSize)
    expect(row.providerIsLocal).toBe(1)
    // And the object really is there, byte-identical.
    const stored = await objectStorage.getPrivateObject(row.objectKey)
    expect(stored).not.toBeNull()
    expect(computeFileSha256(stored!)).toBe(expected.sha256)
  }, 240_000)

  it('the object key is opaque: no name, phone, appointment or service text', async () => {
    const { jobId, clock } = await makeUploadableJob()
    expect((await runUploadOnce('rtu-key', clock)).status).toBe('COMPLETE')
    const row = (await uploadRows(jobId))[0]
    // TEETH: the shape is renders/<shard>/<64 hex>.<ext> and nothing
    // else — a storage listing is not a list of who prayed for what.
    expect(isValidPrivateObjectKey(row.objectKey)).toBe(true)
    expect(row.objectKey).toBe(
      `renders/${row.idempotencyKey.slice(0, 2)}/${row.idempotencyKey}.mp4`,
    )
    for (const marker of [
      PERSONAL_NAME_MARKER,
      PERSONAL_PHONE_MARKER,
      'Adéwálé',
      'prayer',
      'RTU',
    ]) {
      expect(row.objectKey.toLowerCase()).not.toContain(marker.toLowerCase())
    }
    // Deliberately NOT a substring test for the numeric job id: any two
    // digits appear in a 64-character hex digest by chance, so such a
    // test would fail at random while proving nothing. The exact-shape
    // assertion above is the real proof — the ONLY variable part of the
    // key is the hash, so nothing else can have leaked into it.
    expect(row.objectKey.split('/').length).toBe(3)
    expect(row.objectKey.startsWith('renders/')).toBe(true)
  }, 240_000)

  it('two workers racing the same UPLOADING job never both claim it', async () => {
    const { jobId } = await makeUploadableJob()
    const clock: GenerationClock = { now: () => new Date() }
    const [a, b] = await Promise.all([
      claimNextUploadJob('rtu-race-A', clock),
      claimNextUploadJob('rtu-race-B', clock),
    ])
    const claims = [a, b].filter(
      (claim) => claim != null && claim.job.id === jobId,
    )
    expect(claims.length).toBe(1)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 2: crash-safe idempotent upload
// ----------------------------------------------------------------------------

describe('red-team: an interrupted upload converges instead of duplicating', () => {
  it('an IDENTICAL object already at the canonical key is adopted, not re-uploaded', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const expected = await canonicalKeyFor(jobId)
    // Models exactly the dangerous case: the provider write SUCCEEDED,
    // then the process died before the database row could record it.
    await objectStorage.putPrivateObject({
      objectKey: expected.objectKey,
      bytes: await localArtifactBytes(jobId),
      mimeType: 'video/mp4',
      sha256: expected.sha256,
    })
    const counter = { puts: 0 }
    setObjectStorageForTests(countingObjectStorage(counter))
    let outcome
    try {
      outcome = await runUploadOnce('rtu-crash-recovery', clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(outcome.status).toBe('COMPLETE')
    expect((await jobRow(jobId)).status).toBe('READY')
    // TEETH: ZERO further writes — the retry recognised its own object,
    // verified it, and recorded success without a second upload.
    expect(counter.puts).toBe(0)
    const rows = await uploadRows(jobId)
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('SUCCEEDED')
    expect(rows[0].objectKey).toBe(expected.objectKey)
  }, 240_000)

  it('a DIFFERENT object at the canonical key fails closed and is never overwritten', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const expected = await canonicalKeyFor(jobId)
    const foreign = new TextEncoder().encode('somebody-elses-object-bytes')
    await objectStorage.putPrivateObject({
      objectKey: expected.objectKey,
      bytes: foreign,
      mimeType: 'video/mp4',
      sha256: computeFileSha256(foreign),
    })
    const counter = { puts: 0 }
    setObjectStorageForTests(countingObjectStorage(counter))
    let outcome
    try {
      outcome = await runUploadOnce('rtu-conflict', clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('READY')
    expect((await jobRow(jobId)).lastErrorCode).toBe('UPLOAD_OBJECT_CONFLICT')
    expect(counter.puts).toBe(0)
    // TEETH: the foreign object is EXACTLY as it was. Destroying it is
    // not this stage's decision to make.
    const stillThere = await objectStorage.getPrivateObject(expected.objectKey)
    expect(stillThere).not.toBeNull()
    expect(computeFileSha256(stillThere!)).toBe(computeFileSha256(foreign))
  }, 240_000)

  it('a retry after a failure converges on the SAME row and object', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const expected = await canonicalKeyFor(jobId)
    // attemptCount is a RUNNING total across the WHOLE job lifecycle
    // (five stages already succeeded), so reset it to isolate what THIS
    // stage does to the budget.
    await getDb()
      .update(prayerGenerationJobs)
      .set({ attemptCount: 0 })
      .where(eq(prayerGenerationJobs.id, jobId))
    const failing = await runUploadOnce('rtu-retry-1', clock, {
      putPrivateObject: async () => {
        throw new ObjectStorageError('transient', 'synthetic', true)
      },
    })
    expect(failing.status).not.toBe('COMPLETE')
    const afterFailure = await jobRow(jobId)
    // TEETH: a genuine failure consumes budget and resumes at UPLOADING.
    expect(afterFailure.status).toBe('RETRYING')
    expect(afterFailure.resumeStatus).toBe('UPLOADING')
    expect((await uploadRows(jobId))[0].status).toBe('FAILED')

    clock.advance(60 * 60_000)
    expect((await runUploadOnce('rtu-retry-2', clock)).status).toBe('COMPLETE')
    const rows = await uploadRows(jobId)
    expect(rows.length).toBe(1)
    expect(rows[0].status).toBe('SUCCEEDED')
    expect(rows[0].objectKey).toBe(expected.objectKey)
    expect((await jobRow(jobId)).status).toBe('READY')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 3: source revalidation — the Step 16 proof is re-run, not trusted
// ----------------------------------------------------------------------------

describe('red-team: a broken or altered render is never uploaded', () => {
  async function expectBlocked(
    label: string,
    breakIt: (jobId: number) => Promise<void>,
  ) {
    const { jobId, clock } = await makeUploadableJob()
    await breakIt(jobId)
    const counter = { puts: 0 }
    setObjectStorageForTests(countingObjectStorage(counter))
    let outcome
    try {
      outcome = await runUploadOnce(label, clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('READY')
    // TEETH: refused BEFORE any object is written.
    expect(counter.puts).toBe(0)
    return await jobRow(jobId)
  }

  it('a local render artifact that vanished blocks the upload', async () => {
    const job = await expectBlocked('rtu-local-missing', async (jobId) => {
      const result = await renderResultRow(jobId)
      await mediaStorage.remove(result.artifactStorageRef!)
    })
    expect(job.lastErrorCode).toBe('RENDER_ARTIFACT_INVALID')
  }, 240_000)

  it('a tampered local render artifact blocks the upload', async () => {
    const job = await expectBlocked('rtu-local-tampered', async (jobId) => {
      const result = await renderResultRow(jobId)
      writeFileSync(
        join(mediaRoot, result.artifactStorageRef!),
        Buffer.from('tampered-render-bytes'),
      )
    })
    expect(job.lastErrorMessage).toBe('artifact_hash_mismatch')
  }, 240_000)

  it('a render result whose identity was re-pointed blocks the upload', async () => {
    const job = await expectBlocked('rtu-result-identity', async (jobId) => {
      await getDb()
        .update(prayerGenerationRenderResults)
        .set({ idempotencyKey: 'd'.repeat(64) })
        .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    })
    expect(job.lastErrorCode).toBe('RENDER_RESULT_IDENTITY_MISMATCH')
  }, 240_000)

  it('a render result marked with the wrong MIME blocks the upload', async () => {
    const job = await expectBlocked('rtu-result-mime', async (jobId) => {
      await getDb()
        .update(prayerGenerationRenderResults)
        .set({ artifactMimeType: 'video/webm' })
        .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    })
    expect(job.lastErrorMessage).toBe('artifact_mime_mismatch')
  }, 240_000)

  it('a render result marked with the wrong duration blocks the upload', async () => {
    const job = await expectBlocked('rtu-result-duration', async (jobId) => {
      const result = await renderResultRow(jobId)
      await getDb()
        .update(prayerGenerationRenderResults)
        .set({ artifactDurationMs: result.artifactDurationMs! + 1_000 })
        .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
    })
    expect(job.lastErrorMessage).toBe('artifact_duration_mismatch')
  }, 240_000)

  it('an edited render plan snapshot blocks the upload', async () => {
    const job = await expectBlocked('rtu-plan-tamper', async (jobId) => {
      const plan = (
        await getDb()
          .select()
          .from(prayerGenerationRenderPlans)
          .where(eq(prayerGenerationRenderPlans.generationJobId, jobId))
          .limit(1)
      ).at(0)!
      const parsed = JSON.parse(plan.planJsonText) as { totalDurationMs: number }
      parsed.totalDurationMs += 1_000
      const edited = JSON.stringify(parsed)
      await getDb()
        .update(prayerGenerationRenderPlans)
        .set({
          planJsonText: edited,
          payloadSha256: computeFileSha256(new TextEncoder().encode(edited)),
        })
        .where(eq(prayerGenerationRenderPlans.id, plan.id))
    })
    expect(job.lastErrorCode).toBe('RENDER_PLAN_UNREADABLE')
  }, 240_000)

  it('a tampered upload row blocks BEFORE any object is written', async () => {
    const { jobId, clock } = await makeUploadableJob()
    // Seed the row through a failing attempt, then re-point it.
    await runUploadOnce('rtu-rowid-seed', clock, {
      putPrivateObject: async () => {
        throw new ObjectStorageError('transient', 'synthetic', true)
      },
    })
    expect((await uploadRows(jobId)).length).toBe(1)
    await getDb()
      .update(prayerGenerationUploads)
      .set({ idempotencyKey: 'c'.repeat(64) })
      .where(eq(prayerGenerationUploads.generationJobId, jobId))
    await getDb()
      .update(prayerGenerationJobs)
      .set({
        status: 'UPLOADING',
        attemptCount: 0,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(eq(prayerGenerationJobs.id, jobId))
    const counter = { puts: 0 }
    setObjectStorageForTests(countingObjectStorage(counter))
    let outcome
    try {
      outcome = await runUploadOnce('rtu-rowid', clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect(counter.puts).toBe(0)
    expect((await jobRow(jobId)).lastErrorCode).toBe('UPLOAD_IDENTITY_MISMATCH')
    expect((await jobRow(jobId)).lastErrorMessage).toBe(
      'upload_idempotency_mismatch',
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 4: remote integrity — "the provider said OK" is never proof
// ----------------------------------------------------------------------------

describe('red-team: remote integrity is proved, not assumed', () => {
  it('a provider that reports success but stores nothing fails closed', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const outcome = await runUploadOnce('rtu-remote-missing', clock, {
      putPrivateObject: async (input): Promise<PrivateObjectDescriptor> => ({
        // Cheerful, complete, and a lie: nothing was written.
        objectKey: input.objectKey,
        byteSize: input.bytes.length,
        mimeType: input.mimeType,
        providerEtag: 'etag-from-a-provider-that-did-nothing',
        providerVersionId: null,
        providerChecksumSha256: input.sha256,
      }),
    })
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('READY')
    expect((await jobRow(jobId)).lastErrorCode).toBe(
      'UPLOAD_REMOTE_INTEGRITY_FAILURE',
    )
    expect((await jobRow(jobId)).lastErrorMessage).toBe('object_missing')
    expect((await uploadRows(jobId))[0].status).toBe('FAILED')
  }, 240_000)

  it('a remote object whose bytes differ from the local artifact fails closed', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const expected = await canonicalKeyFor(jobId)
    const outcome = await runUploadOnce('rtu-remote-tampered', clock, {
      putPrivateObject: async (input) => {
        // Writes DIFFERENT bytes than it was handed — deliberately the
        // SAME LENGTH, so only a real checksum can catch it.
        const wrong = new Uint8Array(input.bytes.length).fill(7)
        return objectStorage.putPrivateObject({
          objectKey: input.objectKey,
          bytes: wrong,
          mimeType: input.mimeType,
          sha256: computeFileSha256(wrong),
        })
      },
    })
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).lastErrorMessage).toBe(
      'object_checksum_mismatch',
    )
    // The bad object is left exactly where it is: the canonical key is
    // shared by every attempt, so this stage never deletes it.
    expect(await objectStorage.headPrivateObject(expected.objectKey)).not.toBeNull()
  }, 240_000)

  it('a remote object that vanishes after success blocks the final gate', async () => {
    const { jobId, clock } = await makeUploadableJob()
    expect((await runUploadOnce('rtu-gate-seed', clock)).status).toBe('COMPLETE')
    const row = (await uploadRows(jobId))[0]
    await objectStorage.removePrivateObject(row.objectKey)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'UPLOADING', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, jobId))
    const outcome = await runUploadOnce('rtu-gate-missing', clock)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('READY')
    expect((await jobRow(jobId)).lastErrorCode).toBe(
      'UPLOAD_REMOTE_INTEGRITY_FAILURE',
    )
  }, 240_000)

  it('an ETag is never accepted as a SHA-256', async () => {
    const { jobId, clock } = await makeUploadableJob()
    expect((await runUploadOnce('rtu-etag', clock)).status).toBe('COMPLETE')
    const row = (await uploadRows(jobId))[0]
    // TEETH 1: the recorded ETag is provider bookkeeping and is NOT the
    // content hash — a codebase that confused them would show it here.
    expect(row.providerEtag).not.toBeNull()
    expect(row.providerEtag).not.toBe(row.artifactSha256)

    // TEETH 2: a provider that offers ONLY an ETag (no real checksum
    // capability) cannot satisfy the integrity requirement — it fails
    // closed rather than having its ETag accepted as proof.
    const { jobId: jobId2, clock: clock2 } = await makeUploadableJob()
    const etagOnly: ObjectStorageProvider = {
      ...countingObjectStorage({ puts: 0 }),
      verifyPrivateObjectIntegrity: async () => ({
        ok: false,
        reasonCode: 'checksum_not_supported',
      }),
    }
    setObjectStorageForTests(etagOnly)
    let outcome
    try {
      outcome = await runUploadOnce('rtu-etag-only', clock2)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId2)).status).not.toBe('READY')
    expect((await jobRow(jobId2)).lastErrorMessage).toBe(
      'checksum_not_supported',
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 5: lease discipline
// ----------------------------------------------------------------------------

describe('red-team: a stale worker neither finalizes nor corrupts', () => {
  it('losing the lease during the upload records nothing and keeps the object', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const expected = await canonicalKeyFor(jobId)
    const outcome = await runUploadOnce('rtu-lease-lost', clock, {
      putPrivateObject: async (input) => {
        const stored = await objectStorage.putPrivateObject(input)
        // The write landed; then this worker lost the job.
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
        return stored
      },
    })
    expect(outcome.status).toBe('LEASE_LOST')
    expect((await jobRow(jobId)).status).not.toBe('READY')
    const row = (await uploadRows(jobId))[0]
    expect(row.status).not.toBe('SUCCEEDED')
    // TEETH: the canonical object is NOT deleted. It is shared by every
    // attempt, so removing it could destroy a newer worker's valid
    // upload — the next attempt will adopt it.
    expect(await objectStorage.headPrivateObject(expected.objectKey)).not.toBeNull()
  }, 240_000)

  it('a stale worker never writes its failure onto a newer owner’s row', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const NEWER_MARKER = 'newer_worker_owns_this_row'
    const outcome = await runUploadOnce('rtu-stale-write', clock, {
      putPrivateObject: async () => {
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
        // The newer owner has taken this row for its OWN attempt.
        await getDb()
          .update(prayerGenerationUploads)
          .set({
            status: 'UPLOADING',
            attemptCount: 99,
            lastErrorCode: NEWER_MARKER,
          })
          .where(eq(prayerGenerationUploads.generationJobId, jobId))
        throw new ObjectStorageError('transient', 'synthetic', true)
      },
    })
    expect(outcome.status).toBe('LEASE_LOST')
    const row = (await uploadRows(jobId))[0]
    // TEETH: our FAILED verdict was never written.
    expect(row.status).toBe('UPLOADING')
    expect(row.attemptCount).toBe(99)
    expect(row.lastErrorCode).toBe(NEWER_MARKER)
    expect((await jobRow(jobId)).status).not.toBe('READY')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 6: environment, privacy and exposure
// ----------------------------------------------------------------------------

describe('red-team: local storage is never production, and nothing is exposed', () => {
  it('checkObjectStorageAllowed refuses a local provider under production', () => {
    expect(objectStorage.isLocal).toBe(true)
    const production = checkObjectStorageAllowed(objectStorage, 'production')
    expect(production.ok).toBe(false)
    if (!production.ok) {
      expect(production.reasonCode).toBe(
        'local_object_storage_forbidden_in_production',
      )
    }
    // A real provider is permitted in the same environment …
    expect(
      checkObjectStorageAllowed(
        { code: 'S3', isLocal: false, isEnabled: () => true },
        'production',
      ).ok,
    ).toBe(true)
    // … and the local one remains usable in development and test.
    expect(checkObjectStorageAllowed(objectStorage, 'test').ok).toBe(true)
    expect(checkObjectStorageAllowed(objectStorage, 'development').ok).toBe(true)
  })

  it('a disabled provider blocks the upload entirely', async () => {
    const { jobId, clock } = await makeUploadableJob()
    setObjectStorageForTests({
      ...countingObjectStorage({ puts: 0 }),
      isEnabled: () => false,
    })
    let outcome
    try {
      outcome = await runUploadOnce('rtu-disabled', clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).lastErrorCode).toBe(
      'OBJECT_STORAGE_NOT_PERMITTED',
    )
    expect((await uploadRows(jobId)).length).toBe(0)
  }, 240_000)

  it('the S3 boundary fails closed rather than falling back to local', () => {
    // Missing configuration names the MISSING KEYS, never their values.
    const missing = resolveS3CompatibleConfig({})
    expect(missing.ok).toBe(false)
    if (!missing.ok) {
      expect(missing.missing).toContain('OBJECT_STORAGE_BUCKET')
      expect(missing.missing).toContain('OBJECT_STORAGE_SECRET_ACCESS_KEY')
    }
    const complete = resolveS3CompatibleConfig({
      OBJECT_STORAGE_ENDPOINT: 'https://example-object-store.invalid',
      OBJECT_STORAGE_REGION: 'eu-west-1',
      OBJECT_STORAGE_BUCKET: 'private-renders',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'id',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret',
    })
    expect(complete.ok).toBe(true)
    if (complete.ok) expect(complete.config.forcePathStyle).toBe(true)
  })

  it('a signed read URL is bounded, private, and never persisted', async () => {
    const { jobId, clock } = await makeUploadableJob()
    expect((await runUploadOnce('rtu-signed', clock)).status).toBe('COMPLETE')
    const row = (await uploadRows(jobId))[0]
    const events = await getDb()
      .select()
      .from(prayerGenerationJobEvents)
      .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
    const persisted = JSON.stringify({ row, events })
    // TEETH 1: the pipeline generated none, and there is nowhere for one
    // to live — no URL, no signature, no token anywhere in the row.
    expect(persisted).not.toMatch(/https?:\/\//)
    expect(persisted.toLowerCase()).not.toContain('signature')
    expect(persisted.toLowerCase()).not.toContain('signed')
    expect(persisted).not.toContain('local-private://')

    // TEETH 2: the capability exists for a LATER approved stage, is
    // bounded, and verifies — but Step 17 hands it to nobody.
    const now = new Date()
    const signed = await objectStorage.createSignedReadUrl({
      objectKey: row.objectKey,
      ttlSeconds: 60,
      now,
    })
    expect(signed.url.startsWith('local-private://')).toBe(true)
    expect(signed.expiresAt.getTime()).toBe(now.getTime() + 60_000)
    expect(objectStorage.verifySignedReadUrl(signed.url, now)).toBe(true)
    // Expired links stop working.
    expect(
      objectStorage.verifySignedReadUrl(
        signed.url,
        new Date(now.getTime() + 120_000),
      ),
    ).toBe(false)
    // TTL is hard-bounded.
    await expect(
      objectStorage.createSignedReadUrl({
        objectKey: row.objectKey,
        ttlSeconds: MAX_SIGNED_URL_TTL_SECONDS + 1,
        now,
      }),
    ).rejects.toThrow()
  }, 240_000)

  it('no sacred body or personal detail reaches the upload row or events', async () => {
    const { jobId, clock, bodyMarker } = await makeUploadableJob()
    expect((await runUploadOnce('rtu-privacy', clock)).status).toBe('COMPLETE')
    const rows = await uploadRows(jobId)
    const events = await getDb()
      .select()
      .from(prayerGenerationJobEvents)
      .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
    const payload = JSON.stringify({ rows, events })
    expect(payload).not.toContain(bodyMarker)
    expect(payload).not.toContain(SACRED_BODY_MARKER)
    expect(payload).not.toContain(PERSONAL_NAME_MARKER)
    expect(payload).not.toContain(PERSONAL_PHONE_MARKER)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 7: transition authority
// ----------------------------------------------------------------------------

describe('red-team: READY is reachable only through the central map', () => {
  it('no earlier stage may jump straight to READY', () => {
    expect(isLegalTransition('UPLOADING', 'READY')).toBe(true)
    expect(isLegalTransition('QUEUED', 'READY')).toBe(false)
    expect(isLegalTransition('PREPARING', 'READY')).toBe(false)
    expect(isLegalTransition('STORYBOARDING', 'READY')).toBe(false)
    expect(isLegalTransition('GENERATING_VISUALS', 'READY')).toBe(false)
    expect(isLegalTransition('GENERATING_AUDIO', 'READY')).toBe(false)
    expect(isLegalTransition('RENDERING', 'READY')).toBe(false)
    // READY is terminal.
    expect(GENERATION_TRANSITIONS.READY.length).toBe(0)
  })

  it('removing the edge from the central map stops the finalize step at runtime', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const original = [...GENERATION_TRANSITIONS.UPLOADING]
    GENERATION_TRANSITIONS.UPLOADING = original.filter(
      (status) => status !== 'READY',
    )
    let outcome
    try {
      outcome = await runUploadOnce('rtu-bypass', clock)
    } finally {
      GENERATION_TRANSITIONS.UPLOADING = original
    }
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('READY')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 8: no network, no public exposure anywhere in the Step 17 layer
// ----------------------------------------------------------------------------

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('red-team: Step 17 makes no network call and exposes nothing publicly', () => {
  it('the upload service and object-storage layer never touch a network endpoint', () => {
    for (const file of [
      'src/services/render-upload.ts',
      'src/providers/object-storage/types.ts',
      'src/providers/object-storage/local.ts',
      'src/providers/object-storage/registry.ts',
    ]) {
      const source = stripComments(
        readFileSync(join(process.cwd(), file), 'utf8'),
      )
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(/https?:\/\//)
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(@aws-sdk|aws-sdk|minio|@google-cloud|node-fetch|axios)/i,
      )
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(child_process|node:child_process)/,
      )
    }
  })

  it('no public ACL, public bucket policy or public URL appears anywhere in the layer', () => {
    for (const file of [
      'src/services/render-upload.ts',
      'src/providers/object-storage/types.ts',
      'src/providers/object-storage/local.ts',
      'src/providers/object-storage/registry.ts',
      'src/providers/object-storage/s3.ts',
    ]) {
      const source = stripComments(
        readFileSync(join(process.cwd(), file), 'utf8'),
      )
      expect(source).not.toMatch(/public-read/i)
      expect(source).not.toMatch(/publicRead/i)
      expect(source).not.toMatch(/\bACL\b/)
      expect(source).not.toMatch(/cloudfront|cdn\./i)
    }
  })

  it('no object-storage SDK is installed at this stage', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
    for (const name of Object.keys(all)) {
      expect(name).not.toMatch(/^(@aws-sdk|aws-sdk|minio)/)
    }
  })
})

// ----------------------------------------------------------------------------
// Step 17 hardening item 1: the canonical object is created, never overwritten
// ----------------------------------------------------------------------------

/** Reports "nothing there" however many objects actually exist, so a
 * test can drive the service into the exact HEAD→PUT gap a second
 * worker would race through. */
function blindHeadStorage(counter: { puts: number }): ObjectStorageProvider {
  return {
    code: objectStorage.code,
    isLocal: objectStorage.isLocal,
    isEnabled: () => objectStorage.isEnabled(),
    putPrivateObject: async (input) => {
      counter.puts += 1
      return objectStorage.putPrivateObject(input)
    },
    // The lie that opens the race.
    headPrivateObject: async () => null,
    getPrivateObject: (key) => objectStorage.getPrivateObject(key),
    removePrivateObject: (key) => objectStorage.removePrivateObject(key),
    verifyPrivateObjectIntegrity: (input) =>
      objectStorage.verifyPrivateObjectIntegrity(input),
    createSignedReadUrl: (input) => objectStorage.createSignedReadUrl(input),
  }
}

describe('red-team: a canonical object is created exclusively, never overwritten', () => {
  it('a second direct PUT with different bytes cannot replace the first', async () => {
    const key = `renders/aa/${'a'.repeat(64)}.mp4`
    const first = new TextEncoder().encode('the-original-canonical-bytes')
    await objectStorage.putPrivateObject({
      objectKey: key,
      bytes: first,
      mimeType: 'video/mp4',
      sha256: computeFileSha256(first),
    })
    const second = new TextEncoder().encode('an-impostor-trying-to-overwrite')
    // TEETH: the storage layer itself refuses — this is an atomic
    // exclusive create, not a head-then-write with a gap in it.
    await expect(
      objectStorage.putPrivateObject({
        objectKey: key,
        bytes: second,
        mimeType: 'video/mp4',
        sha256: computeFileSha256(second),
      }),
    ).rejects.toThrow(ObjectStorageError)
    const stored = await objectStorage.getPrivateObject(key)
    expect(stored).not.toBeNull()
    expect(computeFileSha256(stored!)).toBe(computeFileSha256(first))
    await objectStorage.removePrivateObject(key)
  })

  it('the refusal carries the well-known already-exists code', async () => {
    const key = `renders/bb/${'b'.repeat(64)}.mp4`
    const bytes = new TextEncoder().encode('canonical')
    await objectStorage.putPrivateObject({
      objectKey: key,
      bytes,
      mimeType: 'video/mp4',
      sha256: computeFileSha256(bytes),
    })
    let caught: unknown
    try {
      await objectStorage.putPrivateObject({
        objectKey: key,
        bytes,
        mimeType: 'video/mp4',
        sha256: computeFileSha256(bytes),
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(ObjectStorageError)
    expect((caught as ObjectStorageError).code).toBe(OBJECT_ALREADY_EXISTS_CODE)
    await objectStorage.removePrivateObject(key)
  })

  it('an IDENTICAL object appearing between HEAD and PUT is adopted, not overwritten', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const expected = await canonicalKeyFor(jobId)
    // The racing worker's object is already there …
    const racing = await localArtifactBytes(jobId)
    await objectStorage.putPrivateObject({
      objectKey: expected.objectKey,
      bytes: racing,
      mimeType: 'video/mp4',
      sha256: expected.sha256,
    })
    const before = await objectStorage.headPrivateObject(expected.objectKey)
    // … but our HEAD says otherwise, so we attempt the create and lose.
    const counter = { puts: 0 }
    setObjectStorageForTests(blindHeadStorage(counter))
    let outcome
    try {
      outcome = await runUploadOnce('rtu-race-identical', clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    // TEETH: we tried, the atomic create refused, and the byte-identical
    // winner was verified and adopted rather than replaced.
    expect(counter.puts).toBe(1)
    expect(outcome.status).toBe('COMPLETE')
    expect((await jobRow(jobId)).status).toBe('READY')
    const after = await objectStorage.headPrivateObject(expected.objectKey)
    expect(after?.providerEtag).toBe(before?.providerEtag)
    const stored = await objectStorage.getPrivateObject(expected.objectKey)
    expect(computeFileSha256(stored!)).toBe(expected.sha256)
  }, 240_000)

  it('a DIFFERENT object appearing between HEAD and PUT is preserved and fails closed', async () => {
    const { jobId, clock } = await makeUploadableJob()
    const expected = await canonicalKeyFor(jobId)
    const foreign = new TextEncoder().encode('another-workers-different-object')
    await objectStorage.putPrivateObject({
      objectKey: expected.objectKey,
      bytes: foreign,
      mimeType: 'video/mp4',
      sha256: computeFileSha256(foreign),
    })
    const counter = { puts: 0 }
    setObjectStorageForTests(blindHeadStorage(counter))
    let outcome
    try {
      outcome = await runUploadOnce('rtu-race-different', clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(counter.puts).toBe(1)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('READY')
    expect((await jobRow(jobId)).lastErrorCode).toBe('UPLOAD_OBJECT_CONFLICT')
    // TEETH: the object that was already there is byte-for-byte intact —
    // not overwritten by our create, and not deleted afterwards either.
    const stored = await objectStorage.getPrivateObject(expected.objectKey)
    expect(stored).not.toBeNull()
    expect(computeFileSha256(stored!)).toBe(computeFileSha256(foreign))
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 17 hardening item 2: an upload row is bound to its storage backend
// ----------------------------------------------------------------------------

describe('red-team: an in-flight upload never moves between storage backends', () => {
  it('a provider change between attempts fails closed with ZERO storage calls', async () => {
    const { jobId, clock } = await makeUploadableJob()
    // Seed the row against the LOCAL provider via a failing attempt.
    await runUploadOnce('rtu-provider-seed', clock, {
      putPrivateObject: async () => {
        throw new ObjectStorageError('transient', 'synthetic', true)
      },
    })
    const seeded = (await uploadRows(jobId))[0]
    expect(seeded.providerCode).toBe('LOCAL_PRIVATE')

    // A DIFFERENT backend is now active.
    const counter = { puts: 0 }
    let headCalls = 0
    setObjectStorageForTests({
      ...blindHeadStorage(counter),
      code: 'OTHER_PRIVATE_STORE',
      isLocal: false,
      headPrivateObject: async () => {
        headCalls += 1
        return null
      },
    })
    await getDb()
      .update(prayerGenerationJobs)
      .set({
        status: 'UPLOADING',
        attemptCount: 0,
        leaseToken: null,
        leaseExpiresAt: null,
      })
      .where(eq(prayerGenerationJobs.id, jobId))
    let outcome
    try {
      outcome = await runUploadOnce('rtu-provider-change', clock)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    // TEETH: refused before touching storage — an in-flight row is never
    // silently re-pointed at a different backend.
    expect(counter.puts).toBe(0)
    expect(headCalls).toBe(0)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('READY')
    expect((await jobRow(jobId)).lastErrorCode).toBe('UPLOAD_PROVIDER_MISMATCH')
    expect((await jobRow(jobId)).lastErrorMessage).toBe(
      'upload_provider_changed',
    )
    // The row still names the backend it was created for.
    expect((await uploadRows(jobId))[0].providerCode).toBe('LOCAL_PRIVATE')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 17 hardening item 3: the final gate binds to the REVALIDATED render
// ----------------------------------------------------------------------------

describe('red-team: the final gate trusts the render, not the upload row', () => {
  /** Tampers the upload row DURING the upload — after the pre-spend
   * identity check has already passed — so only the final gate's
   * binding to the freshly revalidated render can catch it. */
  async function expectGateBlocks(
    label: string,
    patch: Partial<typeof prayerGenerationUploads.$inferInsert>,
  ) {
    const { jobId, clock } = await makeUploadableJob()
    const outcome = await runUploadOnce(label, clock, {
      putPrivateObject: async (input) => {
        const stored = await objectStorage.putPrivateObject(input)
        await getDb()
          .update(prayerGenerationUploads)
          .set(patch)
          .where(eq(prayerGenerationUploads.generationJobId, jobId))
        return stored
      },
    })
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('READY')
    return await jobRow(jobId)
  }

  it('a duration altered mid-flight blocks READY', async () => {
    const job = await expectGateBlocks('rtu-gate-duration', {
      artifactDurationMs: 999_000,
    })
    expect(job.lastErrorCode).toBe('UPLOAD_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('upload_artifact_duration_mismatch')
  }, 240_000)

  it('a MIME altered mid-flight blocks READY', async () => {
    const job = await expectGateBlocks('rtu-gate-mime', {
      artifactMimeType: 'video/webm',
    })
    expect(job.lastErrorCode).toBe('UPLOAD_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('upload_artifact_mime_mismatch')
  }, 240_000)

  it('a byte size altered mid-flight blocks READY', async () => {
    const job = await expectGateBlocks('rtu-gate-size', { byteSize: 12 })
    expect(job.lastErrorCode).toBe('UPLOAD_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('upload_byte_size_mismatch')
  }, 240_000)

  it('a render-plan snapshot id altered mid-flight blocks READY', async () => {
    const job = await expectGateBlocks('rtu-gate-plan', {
      renderPlanSnapshotId: 999_999,
    })
    expect(job.lastErrorCode).toBe('UPLOAD_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('upload_plan_snapshot_mismatch')
  }, 240_000)

  it('an artifact hash altered mid-flight blocks READY', async () => {
    const job = await expectGateBlocks('rtu-gate-hash', {
      artifactSha256: 'e'.repeat(64),
    })
    expect(job.lastErrorCode).toBe('UPLOAD_IDENTITY_MISMATCH')
    expect(job.lastErrorMessage).toBe('upload_artifact_hash_mismatch')
  }, 240_000)
})
