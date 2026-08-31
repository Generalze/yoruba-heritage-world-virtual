import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  GENERATION_JOB_STATUSES,
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
  sessions,
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
  VISUAL_TASK_POLL_DELAY_MS,
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
} from '@/providers/object-storage/local'
import {
  checkObjectStorageAllowed,
  resetObjectStorageForTests,
  setObjectStorageForTests,
} from '@/providers/object-storage/registry'
import {
  MAX_SIGNED_URL_TTL_SECONDS,
} from '@/providers/object-storage/types'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { GenerationClock } from '@/services/generation-jobs'
import type { GenerationJobStatus } from '@/db/schema'
import type { GenerationManifest } from '@/services/generation-storyboards'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'
import { createSession, validateSessionToken } from '@/auth/session'
import {
  PRAYER_ROOM_IN_FLIGHT_GENERATION_STATUSES,
  PRAYER_ROOM_SIGNED_URL_TTL_SECONDS,
  getPrayerRoomStatus,
  servePrayerRoomMedia,
} from '@/services/prayer-room'
import { resolveMediaRange } from '@/lib/media-range'

/**
 * ============================================================================
 * PRAYER ROOM RUNTIME — Phase One, Step 18. Verified against landed
 * source: src/services/prayer-room.ts, src/lib/media-range.ts and the
 * shared verifyCompletedUpload proof in src/services/render-upload.ts.
 *
 * The properties this suite exists to defend:
 *   1. ONLY the appointment owner ever reaches a recording — no staff
 *      bypass, and an unknown room answers exactly like somebody else's;
 *   2. the gate is the CURRENT appointment start, so a reschedule moves
 *      it and nothing expires a recording on its own;
 *   3. every single request re-runs the whole Step 17 proof, so a
 *      withdrawal or tamper closes the room on the next byte; and
 *   4. nothing leaks: no object key, storage path, provider, hash,
 *      job/upload id, private note or signed URL.
 *
 * The pipeline fixture below is the Step 17 one, driven one stage
 * further to READY.
 * ============================================================================
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `prayer room test passphrase ${crypto.randomUUID()}`
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
const CODE_PREFIX = `RTP_${RUN_KEY}`
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
const SACRED_BODY_MARKER = 'Prayer-room sacred block body'

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `rtp-${crypto.randomUUID()}@test.local`,
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
    shotFamily: 'MEDIUM_PRAYER',
    referenceRequirement: 'OPTIONAL',
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
  expect((await runGenerationPreparationOnce('rtp-prep', clock)).status).toBe(
    'PREPARED',
  )
  expect((await runStoryboardPlanningOnce('rtp-plan', clock)).status).toBe(
    'PLANNED',
  )
  for (let cycle = 0; cycle < 8; cycle += 1) {
    if ((await jobRow(job.id)).status !== 'GENERATING_VISUALS') break
    const outcome = await runVisualGenerationOnce(`rtp-vis-${cycle}`, clock)
    if (outcome.status === 'WAITING') {
      clock.advance(VISUAL_TASK_POLL_DELAY_MS + 1_000)
    }
  }
  for (let cycle = 0; cycle < 8; cycle += 1) {
    if ((await jobRow(job.id)).status !== 'GENERATING_AUDIO') break
    const outcome = await runAudioGenerationOnce(`rtp-aud-${cycle}`, clock)
    if (outcome.status === 'WAITING') {
      clock.advance(AUDIO_TASK_POLL_DELAY_MS + 1_000)
    }
  }
  expect((await runRenderOnce('rtp-render', clock)).status).toBe('COMPLETE')
  expect((await jobRow(job.id)).status).toBe('UPLOADING')
  return { jobId: job.id, clock, bodyMarker: sacred.bodyMarker }
}

/** The canonical destination this job's artifact must land at, computed
 * independently of the service so the test proves the key rather than
 * echoing it. */
async function latestManifest(jobId: number): Promise<GenerationManifest> {
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationManifestSnapshots)
      .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
  ).at(-1)!
  return JSON.parse(row.manifestJsonText) as GenerationManifest
}

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

beforeAll(async () => {
  mediaRoot = mkdtempSync(join(tmpdir(), 'yhw-prayer-room-media-'))
  objectRoot = mkdtempSync(join(tmpdir(), 'yhw-prayer-room-objects-'))
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
    code: `RTPH_${key}`.toUpperCase(),
    name: `RTU House ${key}`,
    slug: `rtuh-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 64; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `RTPS${i}_${key}`.toUpperCase(),
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
// Step 18 helpers: drive a job to READY, then control the time gate by
// moving the appointment's CURRENT start — which is exactly what a
// reschedule does.
// ----------------------------------------------------------------------------

/** Drives one appointment all the way to READY through every real
 * upstream stage, and returns the owner plus the identities a test
 * needs to tamper with. */
async function makeReadyAppointment(): Promise<{
  jobId: number
  appointmentId: number
  publicId: string
  ownerId: number
  clock: ReturnType<typeof makeFakeClock>
}> {
  const { jobId, clock } = await makeUploadableJob()
  expect((await runUploadOnce('rtp-upload', clock)).status).toBe('COMPLETE')
  expect((await jobRow(jobId)).status).toBe('READY')
  const job = await jobRow(jobId)
  const appointment = (
    await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, job.appointmentId))
      .limit(1)
  ).at(0)!
  return {
    jobId,
    appointmentId: appointment.id,
    publicId: appointment.publicId,
    ownerId: appointment.userId,
    clock,
  }
}

function utcSql(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

/** Moves the appointment's CURRENT start — the only thing the gate
 * reads, so this is both "time passes" and "the owner rescheduled". */
async function setAppointmentStart(
  appointmentId: number,
  ms: number,
): Promise<void> {
  await getDb()
    .update(appointments)
    .set({ startsAtUtc: utcSql(ms) })
    .where(eq(appointments.id, appointmentId))
}

async function setAppointmentStatus(
  appointmentId: number,
  status: 'PENDING_PAYMENT' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW' | 'EXPIRED',
): Promise<void> {
  await getDb()
    .update(appointments)
    .set({ status })
    .where(eq(appointments.id, appointmentId))
}

/** Places this appointment's generation job in a given state. Used only
 * to test how the Prayer Room READS a job — the pipeline's own tests
 * prove how a job legitimately arrives in each of these. */
async function setJobStatus(
  jobId: number,
  status: GenerationJobStatus,
): Promise<void> {
  await getDb()
    .update(prayerGenerationJobs)
    .set({ status })
    .where(eq(prayerGenerationJobs.id, jobId))
}

function mediaRequest(rangeHeader?: string): Request {
  return new Request('http://localhost/api/prayer-room/x/media', {
    headers: rangeHeader ? { range: rangeHeader } : {},
  })
}

async function expectedBytes(jobId: number): Promise<Uint8Array> {
  const key = await canonicalKeyFor(jobId)
  const stored = await objectStorage.getPrivateObject(key.objectKey)
  expect(stored).not.toBeNull()
  return stored!
}

// ----------------------------------------------------------------------------
// Item 1: access — ownership is the query, and nobody bypasses it
// ----------------------------------------------------------------------------

describe('prayer room: only the appointment owner, ever', () => {
  it('an authenticated owner reaches an open room and can play it', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)

    const status = await getPrayerRoomStatus(ownerId, publicId, now)
    expect(status?.state).toBe('AVAILABLE')
    const response = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(),
      now,
    })
    expect(response.status).toBe(200)
    const body = new Uint8Array(await response.arrayBuffer())
    // TEETH: byte-for-byte the object that was verified — proxied, not
    // redirected, and not re-encoded.
    expect(computeFileSha256(body)).toBe(
      computeFileSha256(await expectedBytes(jobId)),
    )
  }, 240_000)

  it('an UNAUTHENTICATED request is refused neutrally', async () => {
    const { appointmentId, publicId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const response = await servePrayerRoomMedia({
      userId: null,
      publicId,
      request: mediaRequest(),
      now,
    })
    expect(response.status).toBe(404)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  }, 240_000)

  it('a DIFFERENT user is refused, with the same answer as an unknown room', async () => {
    const { appointmentId, publicId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const stranger = await makeEligibleUser()

    expect(await getPrayerRoomStatus(stranger, publicId, now)).toBeNull()
    const crossUser = await servePrayerRoomMedia({
      userId: stranger,
      publicId,
      request: mediaRequest(),
      now,
    })
    const unknownRoom = await servePrayerRoomMedia({
      userId: stranger,
      publicId: crypto.randomUUID(),
      request: mediaRequest(),
      now,
    })
    // TEETH: identical shape — a caller cannot probe for the existence
    // of other people's appointments.
    expect(crossUser.status).toBe(404)
    expect(unknownRoom.status).toBe(404)
    expect(await getPrayerRoomStatus(stranger, crypto.randomUUID(), now)).toBeNull()
  }, 240_000)

  it('STAFF ROLES GRANT NO BYPASS — an admin still cannot open it', async () => {
    const { appointmentId, publicId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const staff = await makeEligibleUser()
    await assignRoleToUser(staff, 'ADMIN')
    await assignRoleToUser(staff, 'CONTENT_MANAGER')

    // TEETH: every permission in the system, and still nothing — the
    // access path never asks about roles at all.
    expect(await getPrayerRoomStatus(staff, publicId, now)).toBeNull()
    const response = await servePrayerRoomMedia({
      userId: staff,
      publicId,
      request: mediaRequest(),
      now,
    })
    expect(response.status).toBe(404)
  }, 240_000)

  it('an expired SESSION removes access', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const session = await createSession(ownerId)
    // A live session resolves to the owner …
    expect((await validateSessionToken(session.token))?.user.id).toBe(ownerId)
    await getDb()
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.userId, ownerId))
    // … and an expired one resolves to nobody, which is exactly the
    // input the media endpoint treats as unauthenticated.
    const resolved = await validateSessionToken(session.token)
    expect(resolved).toBeNull()
    const response = await servePrayerRoomMedia({
      userId: resolved?.user.id ?? null,
      publicId,
      request: mediaRequest(),
      now,
    })
    expect(response.status).toBe(404)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 2: the appointment-time gate
// ----------------------------------------------------------------------------

describe('prayer room: the gate is the CURRENT appointment start', () => {
  it('CONFIRMED before the start is LOCKED and serves nothing', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() + 60 * 60_000)
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'LOCKED',
    )
    const response = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(),
      now,
    })
    expect(response.status).toBe(404)
  }, 240_000)

  it('the EXACT start instant opens the room', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    // startsAtUtc is stored to the SECOND, so the boundary is tested a
    // whole second either side rather than by a millisecond the column
    // cannot represent.
    const startMs = Math.floor(Date.now() / 1000) * 1000
    await setAppointmentStart(appointmentId, startMs)
    // One second before: still closed.
    expect(
      (
        await getPrayerRoomStatus(ownerId, publicId, new Date(startMs - 1000))
      )?.state,
    ).toBe('LOCKED')
    // TEETH: at exactly startsAtUtc it is open — the boundary is
    // inclusive, not "some time after".
    expect(
      (await getPrayerRoomStatus(ownerId, publicId, new Date(startMs)))?.state,
    ).toBe('AVAILABLE')
    const response = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(),
      now: new Date(startMs),
    })
    expect(response.status).toBe(200)
  }, 240_000)

  it('a RESCHEDULE moves the gate automatically', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'AVAILABLE',
    )
    // The owner moves the appointment later; the room closes again with
    // no separate gate to update.
    await setAppointmentStart(appointmentId, now.getTime() + 2 * 60 * 60_000)
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'LOCKED',
    )
    expect(
      (
        await servePrayerRoomMedia({
          userId: ownerId,
          publicId,
          request: mediaRequest(),
          now,
        })
      ).status,
    ).toBe(404)
  }, 240_000)

  it('COMPLETED after the start still plays', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    await setAppointmentStatus(appointmentId, 'COMPLETED')
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'AVAILABLE',
    )
    expect(
      (
        await servePrayerRoomMedia({
          userId: ownerId,
          publicId,
          request: mediaRequest(),
          now,
        })
      ).status,
    ).toBe(200)
  }, 240_000)

  it('PENDING_PAYMENT, CANCELLED, NO_SHOW and EXPIRED are all refused', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    for (const status of [
      'PENDING_PAYMENT',
      'CANCELLED',
      'NO_SHOW',
      'EXPIRED',
    ] as const) {
      await setAppointmentStatus(appointmentId, status)
      // TEETH: a recording follows a kept appointment. None of these
      // states may reach one, even though the file exists and verifies.
      expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
        'UNAVAILABLE',
      )
      expect(
        (
          await servePrayerRoomMedia({
            userId: ownerId,
            publicId,
            request: mediaRequest(),
            now,
          })
        ).status,
      ).toBe(404)
    }
  }, 240_000)

  it('a job that is not READY reports PREPARING and serves nothing', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING' })
      .where(eq(prayerGenerationJobs.id, jobId))
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'PREPARING',
    )
    expect(
      (
        await servePrayerRoomMedia({
          userId: ownerId,
          publicId,
          request: mediaRequest(),
          now,
        })
      ).status,
    ).toBe(404)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 3: the Step 17 proof is re-run on every request
// ----------------------------------------------------------------------------

describe('prayer room: playback re-proves the whole upload, every time', () => {
  async function readyAndOpen() {
    const made = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(made.appointmentId, now.getTime() - 60_000)
    // Sanity: it plays BEFORE the tamper, so a later refusal is caused
    // by the tamper and nothing else.
    expect((await getPrayerRoomStatus(made.ownerId, made.publicId, now))?.state).toBe(
      'AVAILABLE',
    )
    return { ...made, now }
  }

  it('a tampered PRIVATE OBJECT blocks playback', async () => {
    const { jobId, publicId, ownerId, now } = await readyAndOpen()
    const key = await canonicalKeyFor(jobId)
    // Overwrite the stored object out of band (the provider itself
    // refuses overwrites, so this models disk-level tampering).
    writeFileSync(
      join(objectRoot, key.objectKey),
      Buffer.from('tampered-private-object-bytes'),
    )
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'UNAVAILABLE',
    )
    expect(
      (
        await servePrayerRoomMedia({
          userId: ownerId,
          publicId,
          request: mediaRequest(),
          now,
        })
      ).status,
    ).toBe(404)
  }, 240_000)

  it('a MISSING private object blocks playback', async () => {
    const { jobId, publicId, ownerId, now } = await readyAndOpen()
    const key = await canonicalKeyFor(jobId)
    await objectStorage.removePrivateObject(key.objectKey)
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'UNAVAILABLE',
    )
    expect(
      (
        await servePrayerRoomMedia({
          userId: ownerId,
          publicId,
          request: mediaRequest(),
          now,
        })
      ).status,
    ).toBe(404)
  }, 240_000)

  it('a tampered UPLOAD ROW blocks playback', async () => {
    const { jobId, publicId, ownerId, now } = await readyAndOpen()
    await getDb()
      .update(prayerGenerationUploads)
      .set({ artifactSha256: 'a'.repeat(64) })
      .where(eq(prayerGenerationUploads.generationJobId, jobId))
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'UNAVAILABLE',
    )
  }, 240_000)

  it('a tampered LOCAL RENDER ARTIFACT blocks playback', async () => {
    const { jobId, publicId, ownerId, now } = await readyAndOpen()
    const result = await renderResultRow(jobId)
    writeFileSync(
      join(mediaRoot, result.artifactStorageRef!),
      Buffer.from('tampered-local-render'),
    )
    // TEETH: the proof reaches all the way back through Step 16 — a
    // corrupted local render invalidates playback even though the
    // uploaded object is untouched.
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'UNAVAILABLE',
    )
  }, 240_000)

  it('WITHDRAWN upstream authority blocks playback', async () => {
    const { jobId, publicId, ownerId, now } = await readyAndOpen()
    const manifest = await latestManifest(jobId)
    const mediaVersionId = manifest.approvedMedia[0].mediaAssetVersionId
    await setMediaRuntimeEnabled(adminId, ctx, mediaVersionId, false)
    try {
      // TEETH: a Sacred House withdrawing an approved asset closes the
      // room on the next request — nothing is cached from page load.
      expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
        'UNAVAILABLE',
      )
      expect(
        (
          await servePrayerRoomMedia({
            userId: ownerId,
            publicId,
            request: mediaRequest(),
            now,
          })
        ).status,
      ).toBe(404)
    } finally {
      await setMediaRuntimeEnabled(adminId, ctx, mediaVersionId, true)
    }
    // And it opens again once authority is restored.
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'AVAILABLE',
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 4: byte ranges
// ----------------------------------------------------------------------------

describe('prayer room: range requests behave exactly as a player expects', () => {
  it('resolves the range forms a player actually sends', () => {
    expect(resolveMediaRange(100, null)).toEqual({ kind: 'FULL' })
    expect(resolveMediaRange(100, '')).toEqual({ kind: 'FULL' })
    expect(resolveMediaRange(100, 'bytes=0-9')).toEqual({
      kind: 'PARTIAL',
      start: 0,
      end: 9,
      length: 10,
    })
    expect(resolveMediaRange(100, 'bytes=90-')).toEqual({
      kind: 'PARTIAL',
      start: 90,
      end: 99,
      length: 10,
    })
    expect(resolveMediaRange(100, 'bytes=-10')).toEqual({
      kind: 'PARTIAL',
      start: 90,
      end: 99,
      length: 10,
    })
    // An end past the object is clamped, per RFC 9110.
    expect(resolveMediaRange(100, 'bytes=95-999')).toEqual({
      kind: 'PARTIAL',
      start: 95,
      end: 99,
      length: 5,
    })
    // Refused rather than guessed at.
    for (const bad of [
      'bytes=100-',
      'bytes=200-300',
      'bytes=10-5',
      'bytes=-0',
      'bytes=abc-def',
      'items=0-9',
      'bytes=0-9, 20-29',
      'bytes=-',
    ]) {
      expect(resolveMediaRange(100, bad)).toEqual({ kind: 'UNSATISFIABLE' })
    }
  })

  it('serves a full response, an exact slice, and refuses a bad range', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const bytes = await expectedBytes(jobId)
    const size = bytes.length
    expect(size).toBeGreaterThan(100)

    const full = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(),
      now,
    })
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('content-type')).toBe('video/mp4')
    expect(full.headers.get('content-length')).toBe(String(size))
    expect(full.headers.get('cache-control')).toBe('private, no-store')
    expect(full.headers.get('x-content-type-options')).toBe('nosniff')
    expect(full.headers.get('content-range')).toBeNull()

    const partial = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest('bytes=10-19'),
      now,
    })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-length')).toBe('10')
    expect(partial.headers.get('content-range')).toBe(
      `bytes 10-19/${String(size)}`,
    )
    const slice = new Uint8Array(await partial.arrayBuffer())
    // TEETH: the EXACT slice, not a re-read or an off-by-one window.
    expect(Array.from(slice)).toEqual(Array.from(bytes.subarray(10, 20)))

    const openEnded = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(`bytes=${String(size - 5)}-`),
      now,
    })
    expect(openEnded.status).toBe(206)
    expect(openEnded.headers.get('content-length')).toBe('5')
    expect(Array.from(new Uint8Array(await openEnded.arrayBuffer()))).toEqual(
      Array.from(bytes.subarray(size - 5)),
    )

    const suffix = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest('bytes=-7'),
      now,
    })
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe(
      `bytes ${String(size - 7)}-${String(size - 1)}/${String(size)}`,
    )

    const unsatisfiable = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(`bytes=${String(size + 10)}-`),
      now,
    })
    expect(unsatisfiable.status).toBe(416)
    expect(unsatisfiable.headers.get('content-range')).toBe(
      `bytes */${String(size)}`,
    )
    expect((await unsatisfiable.arrayBuffer()).byteLength).toBe(0)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 5: nothing about the pipeline or the storage leaks
// ----------------------------------------------------------------------------

describe('prayer room: no path, key, identity or private note is exposed', () => {
  it('the media response carries no object key, storage path or provider', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const key = await canonicalKeyFor(jobId)
    const response = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(),
      now,
    })
    const headerBlob = JSON.stringify([...response.headers.entries()])
    // TEETH: not the object key, not the shard, not the storage root,
    // not the provider code, not a filename.
    expect(headerBlob).not.toContain(key.objectKey)
    expect(headerBlob).not.toContain(key.idempotencyKey)
    expect(headerBlob).not.toContain('renders/')
    expect(headerBlob).not.toContain(objectRoot)
    expect(headerBlob).not.toContain('LOCAL_PRIVATE')
    expect(headerBlob.toLowerCase()).not.toContain('content-disposition')
  }, 240_000)

  it('the owner status view carries only safe snapshots', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const status = await getPrayerRoomStatus(ownerId, publicId, now)
    expect(status).not.toBeNull()
    // TEETH: a closed vocabulary — there is no field a hash, key,
    // provider, job/upload id or pipeline error could travel in.
    expect(Object.keys(status!).sort()).toEqual([
      'houseName',
      'opensAtUtc',
      'serviceName',
      'startsAtUtc',
      'state',
      'userTimezone',
    ])
    const key = await canonicalKeyFor(jobId)
    const blob = JSON.stringify(status)
    expect(blob).not.toContain(key.objectKey)
    expect(blob).not.toContain(key.sha256)
    expect(blob).not.toContain(String(jobId))
    expect(blob).not.toContain('LOCAL_PRIVATE')
  }, 240_000)

  it('the browser cannot name an object, provider, upload or job', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    // Query parameters a hostile client might try — there is no
    // parameter for any of them, so they are simply not read.
    const response = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: new Request(
        'http://localhost/api/prayer-room/x/media?objectKey=renders/00/' +
          'f'.repeat(64) +
          '.mp4&provider=OTHER&uploadId=1&jobId=1',
      ),
      now,
    })
    // TEETH: served the OWNER's own recording regardless of what was
    // asked for — the parameters had nowhere to go.
    expect(response.status).toBe(200)
    const body = new Uint8Array(await response.arrayBuffer())
    expect(body.length).toBeGreaterThan(0)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 6: the remote-provider path — signed, bounded, never stored
// ----------------------------------------------------------------------------

describe('prayer room: a remote provider gets a short-lived signed GET, after authorization', () => {
  /** A non-local provider that records every signed-URL request, so a
   * test can prove one is created ONLY after authorization passes. */
  function remoteProvider(calls: Array<{ objectKey: string; ttl: number }>) {
    return {
      code: 'REMOTE_PRIVATE_TEST',
      isLocal: false,
      isEnabled: () => true,
      putPrivateObject: (input: Parameters<typeof objectStorage.putPrivateObject>[0]) =>
        objectStorage.putPrivateObject(input),
      headPrivateObject: (key: string) => objectStorage.headPrivateObject(key),
      getPrivateObject: (key: string) => objectStorage.getPrivateObject(key),
      removePrivateObject: (key: string) =>
        objectStorage.removePrivateObject(key),
      verifyPrivateObjectIntegrity: (
        input: Parameters<typeof objectStorage.verifyPrivateObjectIntegrity>[0],
      ) => objectStorage.verifyPrivateObjectIntegrity(input),
      createSignedReadUrl: async (input: {
        objectKey: string
        ttlSeconds: number
        now: Date
      }) => {
        calls.push({ objectKey: input.objectKey, ttl: input.ttlSeconds })
        return {
          url: `https://private.example.invalid/${input.objectKey}?sig=deadbeef`,
          expiresAt: new Date(input.now.getTime() + input.ttlSeconds * 1000),
        }
      },
    }
  }

  it('an UNAUTHORIZED request never causes a signed URL to be created', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    // Still locked.
    await setAppointmentStart(appointmentId, now.getTime() + 60 * 60_000)
    const calls: Array<{ objectKey: string; ttl: number }> = []
    // The upload row names LOCAL_PRIVATE, so a remote provider cannot
    // resolve it — which is itself part of the refusal.
    setObjectStorageForTests(remoteProvider(calls))
    try {
      const stranger = await makeEligibleUser()
      for (const userId of [null, stranger, ownerId]) {
        const response = await servePrayerRoomMedia({
          userId,
          publicId,
          request: mediaRequest(),
          now,
        })
        expect(response.status).toBe(404)
      }
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    // TEETH: not one signed URL was minted for any refused request.
    expect(calls.length).toBe(0)
    void jobId
  }, 240_000)

  it('an AUTHORIZED request redirects to a bounded signed GET that is never persisted', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const calls: Array<{ objectKey: string; ttl: number }> = []
    const remote = remoteProvider(calls)
    setObjectStorageForTests(remote)
    // The upload row must name the provider that holds the object.
    await getDb()
      .update(prayerGenerationUploads)
      .set({ providerCode: remote.code, providerIsLocal: 0 })
      .where(eq(prayerGenerationUploads.generationJobId, jobId))
    let response: Response
    try {
      response = await servePrayerRoomMedia({
        userId: ownerId,
        publicId,
        request: mediaRequest(),
        now,
      })
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(response.status).toBe(302)
    const location = response.headers.get('location')
    expect(location).toContain('https://private.example.invalid/')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    // TEETH 1: exactly one signed URL, for the canonical key, with a
    // TTL inside Step 17's own ceiling.
    expect(calls.length).toBe(1)
    expect(calls[0].objectKey).toBe((await canonicalKeyFor(jobId)).objectKey)
    expect(calls[0].ttl).toBe(PRAYER_ROOM_SIGNED_URL_TTL_SECONDS)
    expect(PRAYER_ROOM_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(
      MAX_SIGNED_URL_TTL_SECONDS,
    )

    // TEETH 2: it exists in the response and NOWHERE else.
    const rows = await uploadRows(jobId)
    const events = await getDb()
      .select()
      .from(prayerGenerationJobEvents)
      .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
    const persisted = JSON.stringify({ rows, events })
    expect(persisted).not.toContain('sig=deadbeef')
    expect(persisted).not.toContain('private.example.invalid')
    expect(persisted.toLowerCase()).not.toContain('signature')
  }, 240_000)

  it('a signed URL on a DIFFERENT origin is never redirected to', async () => {
    // Step 20 hardening: Phase One delivers by redirecting to the
    // CONFIGURED private-storage endpoint, and the production CSP
    // allows only that origin. A signed URL pointing anywhere else is
    // either a misconfigured adapter or a redirect to somebody else’s
    // host, and neither is followed.
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const calls: Array<{ objectKey: string; ttl: number }> = []
    const remote = remoteProvider(calls)
    setObjectStorageForTests(remote)
    await getDb()
      .update(prayerGenerationUploads)
      .set({ providerCode: remote.code, providerIsLocal: 0 })
      .where(eq(prayerGenerationUploads.generationJobId, jobId))
    try {
      // The adapter mints https://private.example.invalid/... while the
      // deployment is configured for a different host.
      const mismatched = await servePrayerRoomMedia({
        userId: ownerId,
        publicId,
        request: mediaRequest(),
        now,
        expectedMediaOrigin: 'https://objects.example',
      })
      expect(mismatched.status).toBe(404)
      expect(mismatched.headers.get('location')).toBeNull()

      // The EXACT configured origin is followed.
      const matched = await servePrayerRoomMedia({
        userId: ownerId,
        publicId,
        request: mediaRequest(),
        now,
        expectedMediaOrigin: 'https://private.example.invalid',
      })
      expect(matched.status).toBe(302)
      expect(matched.headers.get('location')).toContain(
        'https://private.example.invalid/',
      )
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    // Neither attempt persisted or logged a signed URL.
    const rows = await uploadRows(jobId)
    expect(JSON.stringify(rows)).not.toContain('sig=deadbeef')
  }, 240_000)
  it('production still refuses local object storage', async () => {
    // The environment guard is what stops a local object ever being
    // served from production, and it is re-checked on every request
    // through the shared upload proof.
    expect(checkObjectStorageAllowed(objectStorage, 'production').ok).toBe(false)
    expect(checkObjectStorageAllowed(objectStorage, 'test').ok).toBe(true)
  })

  it('a disabled provider closes the room', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    setObjectStorageForTests({
      code: objectStorage.code,
      isLocal: objectStorage.isLocal,
      isEnabled: () => false,
      putPrivateObject: (input) => objectStorage.putPrivateObject(input),
      headPrivateObject: (key) => objectStorage.headPrivateObject(key),
      getPrivateObject: (key) => objectStorage.getPrivateObject(key),
      removePrivateObject: (key) => objectStorage.removePrivateObject(key),
      verifyPrivateObjectIntegrity: (input) =>
        objectStorage.verifyPrivateObjectIntegrity(input),
      createSignedReadUrl: (input) => objectStorage.createSignedReadUrl(input),
    })
    try {
      expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
        'UNAVAILABLE',
      )
      expect(
        (
          await servePrayerRoomMedia({
            userId: ownerId,
            publicId,
            request: mediaRequest(),
            now,
          })
        ).status,
      ).toBe(404)
    } finally {
      setObjectStorageForTests(objectStorage)
    }
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 7: no network, no public exposure, no new spiritual content
// ----------------------------------------------------------------------------

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('prayer room: the Step 18 layer stays local, private and quiet', () => {
  it('makes no network call and imports no SDK', () => {
    for (const file of [
      'src/services/prayer-room.ts',
      'src/services/prayer-room-actions.ts',
      'src/lib/media-range.ts',
      'src/routes/api.prayer-room.$publicId.media.ts',
    ]) {
      const source = stripComments(
        readFileSync(join(process.cwd(), file), 'utf8'),
      )
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(/https?:\/\//)
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(@aws-sdk|aws-sdk|minio|node-fetch|axios)/i,
      )
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(child_process|node:child_process)/,
      )
    }
  })

  it('exposes no share link, download control or direct object URL in the page', () => {
    const page = readFileSync(
      join(process.cwd(), 'src/routes/prayer-room.$publicId.tsx'),
      'utf8',
    )
    const code = stripComments(page)
    // The video points at the AUTHENTICATED endpoint and nothing else.
    expect(code).toContain('/api/prayer-room/')
    expect(code).not.toMatch(/https?:\/\//)
    // Downloading is actively SUPPRESSED, and no anchor offers the
    // media by another route.
    expect(code).toContain('controlsList="nodownload"')
    expect(code).not.toMatch(/<a[^>]*\bdownload\b/i)
    expect(code).not.toMatch(/\bshare\b/i)
    expect(code).not.toContain('objectKey')
    expect(code).not.toContain('privateRequestNote')
    // And it carries the existing spiritual-service framing — now by
    // rendering the SHARED notice rather than repeating its words, so
    // the page and the consent page can never drift apart.
    expect(code).toContain('SPIRITUAL_SERVICE_NOTICE_BODY')
    expect(code).toContain("from '@/lib/spiritual-service-notice'")
  })

  it('adds no table of its own, and the schema only grows when authorised', async () => {
    const rows = (await getDb().execute(
      "SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE()",
    )) as unknown as Array<Array<{ c: number }>>
    const count = Number(rows[0][0].c)
    // TEETH: Step 18 stores nothing of its own — appointment, job and
    // upload state already say everything a Prayer Room needs.
    //
    // 55 at Step 18, plus four daily subscription tables (canon §42
    // item 22, rules in §47), three notification tables (§42 item 23,
    // rules in §48) and one Visual Bible reference-media table
    // (Step 24). Nothing may move it without an authorised reason.
    expect(count).toBe(63)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 18 hardening item 1: the bytes SERVED are re-proved, not just the
// object that verified a moment earlier
// ----------------------------------------------------------------------------

describe('prayer room: no tampered byte is ever served', () => {
  it('a SAME-LENGTH substitution between verification and read is refused', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const key = await canonicalKeyFor(jobId)
    const real = (await objectStorage.getPrivateObject(key.objectKey))!

    // A provider that VERIFIES honestly and then hands back different
    // bytes of exactly the same length. A size check alone waves this
    // through; only re-hashing what is about to be written catches it.
    let reads = 0
    setObjectStorageForTests({
      code: objectStorage.code,
      isLocal: objectStorage.isLocal,
      isEnabled: () => objectStorage.isEnabled(),
      putPrivateObject: (input) => objectStorage.putPrivateObject(input),
      headPrivateObject: (k) => objectStorage.headPrivateObject(k),
      removePrivateObject: (k) => objectStorage.removePrivateObject(k),
      verifyPrivateObjectIntegrity: (input) =>
        objectStorage.verifyPrivateObjectIntegrity(input),
      createSignedReadUrl: (input) => objectStorage.createSignedReadUrl(input),
      getPrivateObject: async (k) => {
        reads += 1
        const bytes = await objectStorage.getPrivateObject(k)
        if (!bytes) return bytes
        const swapped = new Uint8Array(bytes)
        // One flipped byte, identical length.
        swapped[0] = swapped[0] ^ 0xff
        return swapped
      },
    })
    let response: Response
    try {
      response = await servePrayerRoomMedia({
        userId: ownerId,
        publicId,
        request: mediaRequest(),
        now,
      })
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    // TEETH: the verification passed (it read the real object), the read
    // returned a same-length impostor, and NOTHING was served.
    expect(reads).toBeGreaterThan(0)
    expect(response.status).toBe(404)
    expect((await response.arrayBuffer()).byteLength).toBe(0)

    // The genuine object is untouched and still plays.
    expect(
      computeFileSha256((await objectStorage.getPrivateObject(key.objectKey))!),
    ).toBe(computeFileSha256(real))
    const good = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(),
      now,
    })
    expect(good.status).toBe(200)
  }, 240_000)

  it('a truncated read is refused too', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    setObjectStorageForTests({
      code: objectStorage.code,
      isLocal: objectStorage.isLocal,
      isEnabled: () => objectStorage.isEnabled(),
      putPrivateObject: (input) => objectStorage.putPrivateObject(input),
      headPrivateObject: (k) => objectStorage.headPrivateObject(k),
      removePrivateObject: (k) => objectStorage.removePrivateObject(k),
      verifyPrivateObjectIntegrity: (input) =>
        objectStorage.verifyPrivateObjectIntegrity(input),
      createSignedReadUrl: (input) => objectStorage.createSignedReadUrl(input),
      getPrivateObject: async (k) => {
        const bytes = await objectStorage.getPrivateObject(k)
        return bytes ? bytes.subarray(0, bytes.length - 1) : bytes
      },
    })
    let response: Response
    try {
      response = await servePrayerRoomMedia({
        userId: ownerId,
        publicId,
        request: mediaRequest(),
        now,
      })
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    expect(response.status).toBe(404)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 18 hardening item 2: the signed capability is validated, not assumed
// ----------------------------------------------------------------------------

describe('prayer room: a signed read capability is checked before it is handed out', () => {
  /** A remote provider whose signed-URL result the test controls
   * exactly, so each way an adapter can misbehave gets its own case. */
  function remoteWith(
    build: (input: { objectKey: string; ttlSeconds: number; now: Date }) => {
      url: string
      expiresAt: Date
    },
    calls: Array<number>,
  ) {
    return {
      code: 'REMOTE_SIGNED_TEST',
      isLocal: false,
      isEnabled: () => true,
      putPrivateObject: (input: Parameters<typeof objectStorage.putPrivateObject>[0]) =>
        objectStorage.putPrivateObject(input),
      headPrivateObject: (k: string) => objectStorage.headPrivateObject(k),
      getPrivateObject: (k: string) => objectStorage.getPrivateObject(k),
      removePrivateObject: (k: string) => objectStorage.removePrivateObject(k),
      verifyPrivateObjectIntegrity: (
        input: Parameters<typeof objectStorage.verifyPrivateObjectIntegrity>[0],
      ) => objectStorage.verifyPrivateObjectIntegrity(input),
      createSignedReadUrl: async (input: {
        objectKey: string
        ttlSeconds: number
        now: Date
      }) => {
        calls.push(input.ttlSeconds)
        return build(input)
      },
    }
  }

  async function serveWithRemote(
    build: (input: { objectKey: string; ttlSeconds: number; now: Date }) => {
      url: string
      expiresAt: Date
    },
  ) {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const calls: Array<number> = []
    const provider = remoteWith(build, calls)
    setObjectStorageForTests(provider)
    await getDb()
      .update(prayerGenerationUploads)
      .set({ providerCode: provider.code, providerIsLocal: 0 })
      .where(eq(prayerGenerationUploads.generationJobId, jobId))
    let response: Response
    try {
      response = await servePrayerRoomMedia({
        userId: ownerId,
        publicId,
        request: mediaRequest(),
        now,
      })
    } finally {
      setObjectStorageForTests(objectStorage)
    }
    return { response, calls, now, jobId }
  }

  it('a normal five-minute HTTPS capability redirects', async () => {
    const { response, calls, now } = await serveWithRemote((input) => ({
      url: `https://private.example.invalid/${input.objectKey}?sig=ok`,
      expiresAt: new Date(input.now.getTime() + input.ttlSeconds * 1000),
    }))
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toContain('https://')
    expect(calls).toEqual([PRAYER_ROOM_SIGNED_URL_TTL_SECONDS])
    expect(PRAYER_ROOM_SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(
      MAX_SIGNED_URL_TTL_SECONDS,
    )
    void now
  }, 240_000)

  it('an OVERLONG expiry is refused, whatever TTL we asked for', async () => {
    const { response } = await serveWithRemote((input) => ({
      url: `https://private.example.invalid/${input.objectKey}?sig=long`,
      // Ignores the requested TTL and issues a day-long capability.
      expiresAt: new Date(input.now.getTime() + 24 * 60 * 60_000),
    }))
    // TEETH: the bound we requested is not evidence — the bound we were
    // GIVEN is what would actually govern the capability.
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  }, 240_000)

  it('an ALREADY-EXPIRED capability is refused', async () => {
    const { response } = await serveWithRemote((input) => ({
      url: `https://private.example.invalid/${input.objectKey}?sig=dead`,
      expiresAt: new Date(input.now.getTime() - 1_000),
    }))
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  }, 240_000)

  it('an INSECURE http capability is refused', async () => {
    const { response } = await serveWithRemote((input) => ({
      url: `http://private.example.invalid/${input.objectKey}?sig=plain`,
      expiresAt: new Date(input.now.getTime() + 60_000),
    }))
    // TEETH: a private recording is never fetched over a channel that
    // can be read in transit.
    expect(response.status).toBe(404)
    expect(response.headers.get('location')).toBeNull()
  }, 240_000)

  it('a malformed capability is refused', async () => {
    const { response } = await serveWithRemote((input) => ({
      url: 'not-a-url',
      expiresAt: new Date(input.now.getTime() + 60_000),
    }))
    expect(response.status).toBe(404)
  }, 240_000)

  it('an invalid expiry date is refused', async () => {
    const { response } = await serveWithRemote((input) => ({
      url: `https://private.example.invalid/${input.objectKey}?sig=nan`,
      expiresAt: new Date(Number.NaN),
    }))
    expect(response.status).toBe(404)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 18 hardening item 3: historical snapshots and the existing notice
// ----------------------------------------------------------------------------

describe('prayer room: what the owner sees is the appointment they booked', () => {
  it('a Sacred House RENAME does not rewrite the appointment snapshot', async () => {
    const { appointmentId, publicId, ownerId } = await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    const before = await getPrayerRoomStatus(ownerId, publicId, now)
    expect(before?.houseName).toBeTruthy()

    const renamed = `Renamed House ${crypto.randomUUID().slice(0, 8)}`
    await getDb()
      .update(sacredHouses)
      .set({ name: renamed })
      .where(eq(sacredHouses.id, houseId))
    const after = await getPrayerRoomStatus(ownerId, publicId, now)
    // TEETH: the historical snapshot stands. A House renaming itself
    // must not silently rewrite what somebody was shown when they
    // booked.
    expect(after?.houseName).toBe(before!.houseName)
    expect(after?.houseName).not.toBe(renamed)
  }, 240_000)

  it('the Prayer Room shows the EXISTING Spiritual Service Notice, shared with consent', () => {
    const notice = readFileSync(
      join(process.cwd(), 'src/lib/spiritual-service-notice.ts'),
      'utf8',
    )
    // The wording is the consent page's, verbatim — no new legal or
    // spiritual text was invented for the Prayer Room.
    expect(notice).toContain('do not')
    expect(notice).toContain('guarantee outcomes')
    expect(notice).toContain('not substitutes for medical care')
    expect(notice).toContain('psychiatric or mental-health care')
    expect(notice).toContain('emergency service')

    // BOTH pages render it from that one source.
    for (const page of [
      'src/routes/prayer-room.$publicId.tsx',
      'src/routes/profile.consents.tsx',
    ]) {
      const source = readFileSync(join(process.cwd(), page), 'utf8')
      expect(source).toContain('SPIRITUAL_SERVICE_NOTICE_BODY')
      expect(source).toContain("from '@/lib/spiritual-service-notice'")
      // And neither carries a hand-written paraphrase of it.
      expect(source).not.toContain('substitute for professional medical')
    }
  })
})

// ----------------------------------------------------------------------------
// Step 18 hardening item 4: the four states are true
// ----------------------------------------------------------------------------

describe('prayer room: state precedence reflects what is actually true', () => {
  it('a FUTURE appointment whose job is not READY reports PREPARING, not LOCKED', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    // Both conditions hold at once: the room has not opened AND there is
    // no finished recording.
    await setAppointmentStart(appointmentId, now.getTime() + 60 * 60_000)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING' })
      .where(eq(prayerGenerationJobs.id, jobId))
    // TEETH: readiness wins. Telling an owner their room is merely
    // "locked" when nothing has been made would be the wrong thing to
    // say.
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'PREPARING',
    )
    expect(
      (
        await servePrayerRoomMedia({
          userId: ownerId,
          publicId,
          request: mediaRequest(),
          now,
        })
      ).status,
    ).toBe(404)
  }, 240_000)

  it('a non-playable status outranks everything else', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() + 60 * 60_000)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ status: 'RENDERING' })
      .where(eq(prayerGenerationJobs.id, jobId))
    await setAppointmentStatus(appointmentId, 'CANCELLED')
    // TEETH: cancelled is cancelled — not "preparing", not "locked".
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'UNAVAILABLE',
    )
  }, 240_000)

  it('the appointment page never claims a room is open from the clock alone', () => {
    const page = readFileSync(
      join(process.cwd(), 'src/routes/appointments.$publicId.tsx'),
      'utf8',
    )
    // TEETH: availability depends on the job being READY and its upload
    // still verifying, neither of which this page knows — so it makes no
    // such claim, and it does not duplicate the verifier to find out.
    expect(page).not.toContain('Prayer Room is open')
    expect(page).not.toContain('Enter Prayer Room')
    expect(page).toContain('View Prayer Room status')
    expect(page).not.toContain('verifyCompletedUpload')
    expect(page).not.toContain('getPrayerRoomStatus')
  })
})

// ----------------------------------------------------------------------------
// Step 19 hardening: a generation that ENDED is not a generation that is
// still coming
// ----------------------------------------------------------------------------

/**
 * "Not READY" was one condition too few.
 *
 * Every non-READY job used to be reported as PREPARING, so an owner
 * whose generation had terminally FAILED or been CANCELLED was told
 * their recording was being prepared and asked to check back later —
 * advice they could follow forever. Terminal is now UNAVAILABLE, which
 * is the same neutral answer every other refusal gives: no error code,
 * no stage, no hint about the pipeline.
 */
describe('terminal generation state', () => {
  it('a FAILED generation is UNAVAILABLE, not PREPARING, and serves nothing', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    // It really does play first, so the change below is what closes it.
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'AVAILABLE',
    )
    await setJobStatus(jobId, 'FAILED')
    const status = await getPrayerRoomStatus(ownerId, publicId, now)
    expect(status?.state).toBe('UNAVAILABLE')
    // Nothing about the pipeline reaches the owner.
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('FAILED')
    expect(serialized).not.toMatch(/error|reason|stage|attempt/i)
    const response = await servePrayerRoomMedia({
      userId: ownerId,
      publicId,
      request: mediaRequest(),
      now,
    })
    expect(response.status).toBe(404)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  }, 240_000)

  it('a CANCELLED generation is UNAVAILABLE and serves nothing', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    await setJobStatus(jobId, 'CANCELLED')
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'UNAVAILABLE',
    )
    expect(
      (
        await servePrayerRoomMedia({
          userId: ownerId,
          publicId,
          request: mediaRequest(),
          now,
        })
      ).status,
    ).toBe(404)
  }, 240_000)

  it('RETRYING is still PREPARING — a bounded retry is not a verdict', async () => {
    const { jobId, appointmentId, publicId, ownerId } =
      await makeReadyAppointment()
    const now = new Date()
    await setAppointmentStart(appointmentId, now.getTime() - 60_000)
    await setJobStatus(jobId, 'RETRYING')
    // TEETH: RETRYING sits next to FAILED in the same enum and is the
    // easy one to lump in with it. A job that is going to try again is
    // still on its way.
    expect((await getPrayerRoomStatus(ownerId, publicId, now))?.state).toBe(
      'PREPARING',
    )
    expect(
      (
        await servePrayerRoomMedia({
          userId: ownerId,
          publicId,
          request: mediaRequest(),
          now,
        })
      ).status,
    ).toBe(404)
  }, 240_000)

  it('an ordinary active stage is still PREPARING', async () => {
    // Not set by hand: this job is genuinely mid-pipeline, parked at
    // UPLOADING by the real upstream stages.
    const { jobId } = await makeUploadableJob()
    expect((await jobRow(jobId)).status).toBe('UPLOADING')
    const job = await jobRow(jobId)
    const appointment = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, job.appointmentId))
        .limit(1)
    ).at(0)!
    const now = new Date()
    await setAppointmentStart(appointment.id, now.getTime() - 60_000)
    expect(
      (await getPrayerRoomStatus(appointment.userId, appointment.publicId, now))
        ?.state,
    ).toBe('PREPARING')
  }, 240_000)

  it('every generation status is classified deliberately', () => {
    // TEETH: the in-flight list is what separates "still coming" from
    // "never coming", and the fail-closed default means a NEW status
    // nobody thought about would silently read UNAVAILABLE. Pinning the
    // partition here forces that decision to be made on purpose.
    const terminalOrReady = ['READY', 'FAILED', 'CANCELLED']
    expect(
      [...PRAYER_ROOM_IN_FLIGHT_GENERATION_STATUSES, ...terminalOrReady].sort(),
    ).toEqual([...GENERATION_JOB_STATUSES].sort())
    for (const status of terminalOrReady) {
      expect(PRAYER_ROOM_IN_FLIGHT_GENERATION_STATUSES).not.toContain(status)
    }
  })
})
