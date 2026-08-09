import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
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
  claimNextGenerationJob,
  claimNextStoryboardJob,
  recoverExpiredGenerationLeases,
  runGenerationPreparationOnce,
  transitionGenerationJobUnderLease,
} from '@/services/generation-jobs'
import {
  MAX_SCENES,
  MAX_SCENE_MS,
  buildValidatedGenerationStoryboard,
  computeVisualTaskIdempotencyKey,
  loadAndValidateGenerationManifest,
  loadGenerationManifestSnapshot,
  loadGenerationStoryboardSnapshot,
  persistStoryboardManifestUnderLease,
  runStoryboardPlanningOnce,
} from '@/services/generation-storyboards'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * Step 13 integration tests: storyboard claim/lease behavior, recipe
 * authority, deterministic scene planning (splitting, SILENCE, no
 * padding, loud ceiling), Visual Bible constraint handling, audio
 * requirements, manifest tasks/idempotency, atomic finalization,
 * fail-closed loaders and later-phase guards. Synthetic fixtures only.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `storyboard test passphrase ${crypto.randomUUID()}`
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
const CODE_PREFIX = `T13_${RUN_KEY}`
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

function syntheticBytes(marker: string = crypto.randomUUID()): Uint8Array {
  return new TextEncoder().encode(`synthetic-test-media-bytes ${marker}`)
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s13-${crypto.randomUUID()}@test.local`,
      preferredName: 'S13 Fixture',
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

function silenceSlot(position: number, seconds: number): SlotInput {
  return {
    slotKey: `STILL_${position}`,
    position,
    slotKind: 'SILENCE',
    minSelect: 0,
    maxSelect: 0,
    contentType: null,
    selectorMode: null,
    themeCode: null,
    variantKind: null,
    silenceDurationSeconds: seconds,
    allowedScopes: [],
    pinnedContentVersionIds: [],
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
  const prepared = await runGenerationPreparationOnce('t13-prep', {
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

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-storyboard-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'T13\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'T13\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'T13\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T13H_${key}`.toUpperCase(),
    name: `T13 House ${key}`,
    slug: `t13h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 20; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `T13S${i}_${key}`.toUpperCase(),
      name: `T13 Service ${i} ${key}`,
      slug: `t13s${i}-${key}`,
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

describe('storyboard planning', () => {
  it('plans deterministic scenes into an immutable storyboard + manifest and GENERATING_VISUALS', async () => {
    const serviceId = nextService()
    const theme = `T13_MAIN_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme, durationHintSeconds: 30 })
    const visual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme }),
      silenceSlot(2, 12),
    ])
    const { jobId, appointmentId } = await makeStoryboardReadyJob(serviceId)

    const outcome = await runStoryboardPlanningOnce('t13-story', {
      now: () => new Date(),
    })
    expect(outcome.status).toBe('PLANNED')
    const job = (await jobForAppointment(appointmentId))!
    expect(job.status).toBe('GENERATING_VISUALS')
    expect(job.leaseToken).toBeNull()

    const loaded = await loadGenerationStoryboardSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    if (loaded.status !== 'OK') return
    const storyboard = loaded.storyboard
    // Approved media → APPROVED_MEDIA; SILENCE preserved exactly.
    const contentScenes = storyboard.scenes.filter((s) => s.kind === 'CONTENT')
    expect(contentScenes.every((s) => s.sourceMode === 'APPROVED_MEDIA')).toBe(
      true,
    )
    expect(
      contentScenes.every((s) => s.mediaAssetVersionId === visual.versionId),
    ).toBe(true)
    const silence = storyboard.scenes.filter((s) => s.kind === 'SILENCE')
    expect(silence.length).toBe(1)
    expect(silence[0].durationMs).toBe(12_000)
    expect(silence[0].sourceMode).toBe('HOLD_PREVIOUS')
    // Timeline preserved: 30s content + 12s silence.
    expect(storyboard.totalDurationMs).toBe(42_000)

    // Manifest: approved media creates NO paid visual task.
    const manifest = await loadGenerationManifestSnapshot(jobId)
    expect(manifest.status).toBe('OK')
    if (manifest.status === 'OK') {
      expect(manifest.manifest.visualTasks.length).toBe(0)
      expect(manifest.manifest.approvedMedia.length).toBe(contentScenes.length)
    }
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )

    // Privacy: no sacred body / PII / storage keys anywhere.
    const rows = await storyboardRows(jobId)
    const manifestRowsData = await manifestRows(jobId)
    const payload = JSON.stringify({ rows, manifestRowsData })
    expect(payload).not.toContain(SACRED_BODY_MARKER)
    expect(payload).not.toContain('@test.local')
    expect(payload).not.toContain('+2348012345678')
    expect(payload).not.toMatch(/[a-f0-9]{2}\/[a-f0-9]{32}\.[a-z0-9]{2,5}/)

    // Nothing else claimable; no duplicate snapshots.
    expect(
      (await runStoryboardPlanningOnce('t13-story', { now: () => new Date() }))
        .status,
    ).toBe('IDLE')
    expect((await storyboardRows(jobId)).length).toBe(1)
    expect((await manifestRows(jobId)).length).toBe(1)
  }, 240_000)

  it('is deterministic, splits long windows without padding, and never forces a scene count', async () => {
    const serviceId = nextService()
    const theme = `T13_SPLIT_${RUN_KEY}`
    // One 100s content window → deterministic 15s-max presentational
    // splits (7 scenes: NOT padded up to 8, NOT stretched).
    await makeEligibleSacred({ themeCode: theme, durationHintSeconds: 100 })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId } = await makeStoryboardReadyJob(serviceId)

    const first = await buildValidatedGenerationStoryboard(jobId)
    const second = await buildValidatedGenerationStoryboard(jobId)
    expect(first.status).toBe('OK')
    expect(second.status).toBe('OK')
    if (first.status !== 'OK' || second.status !== 'OK') return
    // Byte-identical storyboards for the same job + authorities.
    expect(JSON.stringify(second.storyboard)).toBe(
      JSON.stringify(first.storyboard),
    )
    expect(second.storyboard.storyboardSha256).toBe(
      first.storyboard.storyboardSha256,
    )

    const scenes = first.storyboard.scenes
    expect(scenes.length).toBe(Math.ceil(100_000 / MAX_SCENE_MS))
    expect(scenes.length).toBeLessThan(8) // no padding to the 8–12 target
    expect(scenes.every((scene) => scene.durationMs <= MAX_SCENE_MS)).toBe(true)
    // Splitting only divides the EXISTING timeline: contiguous, exact.
    expect(first.storyboard.totalDurationMs).toBe(100_000)
    let cursor = 0
    for (const scene of scenes) {
      expect(scene.startMs).toBe(cursor)
      cursor = scene.endMs
      expect(scene.recipeSegmentIndex).toBe(0)
      expect(scene.splitCount).toBe(scenes.length)
    }
    expect(cursor).toBe(100_000)
    // Audio requirement is carried once, never duplicated by splits.
    expect(scenes.filter((scene) => scene.audio.mode !== 'NONE').length).toBe(0) // TEXT_ONLY fixture
  }, 240_000)

  it('the scene ceiling fails loudly instead of truncating', async () => {
    const serviceId = nextService()
    const theme = `T13_CEIL_${RUN_KEY}`
    // 600s ÷ 15s = 40 scenes > MAX_SCENES (32).
    await makeEligibleSacred({ themeCode: theme, durationHintSeconds: 600 })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId, appointmentId } = await makeStoryboardReadyJob(serviceId)

    const built = await buildValidatedGenerationStoryboard(jobId)
    expect(built.status).toBe('SCENE_CEILING_EXCEEDED')
    if (built.status === 'SCENE_CEILING_EXCEEDED') {
      expect(built.sceneCount).toBeGreaterThan(MAX_SCENES)
    }
    // The worker fails the job closed (structural), no snapshots.
    const outcome = await runStoryboardPlanningOnce('t13-ceiling', {
      now: () => new Date(),
    })
    expect(outcome.status).toBe('FAILED')
    const job = (await jobForAppointment(appointmentId))!
    expect(job.status).toBe('FAILED')
    expect(job.lastErrorCode).toBe('SCENE_CEILING_EXCEEDED')
    expect((await storyboardRows(jobId)).length).toBe(0)
  }, 240_000)

  it('generation descriptors become GENERATION_REQUIRED tasks bound to the current Visual Bible', async () => {
    const serviceId = nextService()
    const theme = `T13_GEN_${RUN_KEY}`
    // CHANT with no matching library visual → recipe emits a
    // generation descriptor (METADATA_ONLY).
    await makeEligibleSacred({
      themeCode: theme,
      contentType: 'CHANT',
      externalAiPolicy: 'METADATA_ONLY',
      durationHintSeconds: 20,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'CHANT' }),
    ])
    const { jobId } = await makeStoryboardReadyJob(serviceId)

    const outcome = await runStoryboardPlanningOnce('t13-gen', {
      now: () => new Date(),
    })
    expect(outcome.status).toBe('PLANNED')
    const loaded = await loadGenerationStoryboardSnapshot(jobId)
    const manifest = await loadGenerationManifestSnapshot(jobId)
    expect(loaded.status).toBe('OK')
    expect(manifest.status).toBe('OK')
    if (loaded.status !== 'OK' || manifest.status !== 'OK') return

    const generated = loaded.storyboard.scenes.filter(
      (scene) => scene.sourceMode === 'GENERATION_REQUIRED',
    )
    expect(generated.length).toBeGreaterThan(0)
    for (const scene of generated) {
      const intent = scene.generationIntent!
      expect(intent.visualBibleSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(loaded.storyboard.visualBibleSha256).toBe(intent.visualBibleSha256)
      expect(intent.textContextAllowed).toBe(false)
      expect(intent.externalAiPolicy).toBe('METADATA_ONLY')
      // Rules referenced by identity only — never rule text.
      expect(scene.bibleRuleRefs.length).toBeGreaterThan(0)
      expect(
        scene.bibleRuleRefs.every(
          (ref) => typeof ref.ruleId === 'number' && ref.category.length > 0,
        ),
      ).toBe(true)
    }
    // No rule text and no sacred body in the persisted payloads.
    const payload = JSON.stringify([
      await storyboardRows(jobId),
      await manifestRows(jobId),
    ])
    expect(payload).not.toContain('riverside at dawn')
    expect(payload).not.toContain('no modern logos')
    expect(payload).not.toContain(SACRED_BODY_MARKER)

    // Deterministic tasks + idempotency keys; no provider chosen.
    expect(manifest.manifest.visualTasks.length).toBe(generated.length)
    for (const task of manifest.manifest.visualTasks) {
      expect(task.taskKind).toBe('GENERATE_VIDEO_SCENE')
      expect(task.requiresAuthorityRevalidation).toBe(true)
      expect(task.idempotencyKey).toBe(
        computeVisualTaskIdempotencyKey({
          generationJobId: jobId,
          storyboardSha256: loaded.storyboard.storyboardSha256,
          sceneId: task.sceneId,
        }),
      )
    }
    expect(JSON.stringify(manifest.manifest)).not.toMatch(/kling|openart/i)
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )
  }, 240_000)

  it('NO_EXTERNAL_AI can never generate; APPROVED_TEXT_CONTEXT still stores no body', async () => {
    // NO_EXTERNAL_AI with no library visual: the RECIPE already fails
    // closed upstream, so the job can never reach a generated scene.
    const noAiService = nextService()
    const noAiTheme = `T13_NOAI_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: noAiTheme,
      contentType: 'CHANT',
      externalAiPolicy: 'NO_EXTERNAL_AI',
    })
    await makeServiceTemplate(noAiService, [
      filterSlot({ themeCode: noAiTheme, contentType: 'CHANT' }),
    ])
    const userId = await makeEligibleUser()
    const reservation = await createReservation(userId, ctx, {
      serviceId: noAiService,
      startsAtUtc: nextSlot(),
    })
    await confirmReservation(reservation.appointmentId, ctx)
    const noAiJob = (await jobForAppointment(reservation.appointmentId))!
    await quiesceOtherJobs(noAiJob.id)
    const prepared = await runGenerationPreparationOnce('t13-noai', {
      now: () => new Date(),
    })
    expect(prepared.status).toBe('FAILED')
    expect((await jobForAppointment(reservation.appointmentId))!.status).toBe(
      'FAILED',
    )
    expect((await storyboardRows(noAiJob.id)).length).toBe(0)

    // APPROVED_TEXT_CONTEXT: descriptor allows future server-side
    // retrieval but the body is NEVER stored.
    const ctxService = nextService()
    const ctxTheme = `T13_TXT_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: ctxTheme,
      contentType: 'CHANT',
      externalAiPolicy: 'APPROVED_TEXT_CONTEXT',
      durationHintSeconds: 20,
    })
    await makeServiceTemplate(ctxService, [
      filterSlot({ themeCode: ctxTheme, contentType: 'CHANT' }),
    ])
    const { jobId } = await makeStoryboardReadyJob(ctxService)
    expect(
      (await runStoryboardPlanningOnce('t13-txt', { now: () => new Date() }))
        .status,
    ).toBe('PLANNED')
    const loaded = await loadGenerationStoryboardSnapshot(jobId)
    if (loaded.status !== 'OK') throw new Error('expected storyboard')
    const generated = loaded.storyboard.scenes.filter(
      (scene) => scene.generationIntent != null,
    )
    expect(generated.length).toBeGreaterThan(0)
    expect(generated[0].generationIntent!.textContextAllowed).toBe(true)
    expect(generated[0].generationIntent!.contentSha256).toMatch(
      /^[0-9a-f]{64}$/,
    )
    const payload = JSON.stringify(await storyboardRows(jobId))
    expect(payload).not.toContain(SACRED_BODY_MARKER)
  }, 240_000)

  it('audio requirements preserve existing human audio and keep TTS_PENDING body-free', async () => {
    // EXISTING_HUMAN_AUDIO: linked human recording chosen by Step 11.
    const humanService = nextService()
    const humanTheme = `T13_AUD_${RUN_KEY}`
    const sacred = await makeEligibleSacred({
      themeCode: humanTheme,
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
      themeCode: humanTheme,
    })
    await makeServiceTemplate(humanService, [
      filterSlot({ themeCode: humanTheme }),
    ])
    const human = await makeStoryboardReadyJob(humanService)
    expect(
      (await runStoryboardPlanningOnce('t13-aud', { now: () => new Date() }))
        .status,
    ).toBe('PLANNED')
    const humanLoaded = await loadGenerationStoryboardSnapshot(human.jobId)
    if (humanLoaded.status !== 'OK') throw new Error('expected storyboard')
    const humanAudioScenes = humanLoaded.storyboard.scenes.filter(
      (scene) => scene.audio.mode === 'EXISTING_HUMAN_AUDIO',
    )
    expect(humanAudioScenes.length).toBe(1)
    expect(humanAudioScenes[0].audio.mediaAssetVersionId).toBe(audio.versionId)
    expect(humanAudioScenes[0].audio.fileSha256).toMatch(/^[0-9a-f]{64}$/)

    // TTS_PENDING: identity + policy only, no speech text.
    const ttsService = nextService()
    const ttsTheme = `T13_TTS_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: ttsTheme,
      voicePolicy: 'APPROVED_TTS_ALLOWED',
      durationHintSeconds: 20,
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: ttsTheme,
    })
    await makeServiceTemplate(ttsService, [filterSlot({ themeCode: ttsTheme })])
    const tts = await makeStoryboardReadyJob(ttsService)
    expect(
      (await runStoryboardPlanningOnce('t13-tts', { now: () => new Date() }))
        .status,
    ).toBe('PLANNED')
    const ttsLoaded = await loadGenerationStoryboardSnapshot(tts.jobId)
    if (ttsLoaded.status !== 'OK') throw new Error('expected storyboard')
    const pending = ttsLoaded.storyboard.scenes.filter(
      (scene) => scene.audio.mode === 'TTS_PENDING',
    )
    expect(pending.length).toBe(1)
    expect(pending[0].audio.voicePolicy).toBe('APPROVED_TTS_ALLOWED')
    expect(pending[0].audio.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(pending[0].audio.requirementId).not.toBeNull()
    expect(JSON.stringify(await storyboardRows(tts.jobId))).not.toContain(
      SACRED_BODY_MARKER,
    )
  }, 240_000)
})

describe('storyboard queue, lease and authority', () => {
  it('only STORYBOARDING/resuming jobs are storyboard-claimable and preparation is not starved', async () => {
    const serviceId = nextService()
    const theme = `T13_CLAIM_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])

    // A QUEUED job is NOT storyboard-claimable.
    const userId = await makeEligibleUser()
    const reservation = await createReservation(userId, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    await confirmReservation(reservation.appointmentId, ctx)
    const queued = (await jobForAppointment(reservation.appointmentId))!
    await quiesceOtherJobs(queued.id)
    expect(queued.status).toBe('QUEUED')
    expect(await claimNextStoryboardJob('t13-c', new Date())).toBeNull()
    // …but IS preparation-claimable (fair, independent queues).
    const prepared = await runGenerationPreparationOnce('t13-c', {
      now: () => new Date(),
    })
    expect(prepared.status).toBe('PREPARED')
    const storyboarding = (await jobForAppointment(reservation.appointmentId))!
    expect(storyboarding.status).toBe('STORYBOARDING')

    // Now it IS storyboard-claimable but NOT preparation-claimable.
    expect(await claimNextGenerationJob('t13-c', new Date())).toBeNull()
    const claim = await claimNextStoryboardJob('t13-c', new Date())
    expect(claim?.job.id).toBe(queued.id)

    // A RETRYING job resuming STORYBOARDING is storyboard-claimable
    // and NOT taken by the preparation queue.
    await getDb()
      .update(prayerGenerationJobs)
      .set({
        status: 'RETRYING',
        resumeStatus: 'STORYBOARDING',
        nextAttemptAt: null,
        leaseToken: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(prayerGenerationJobs.id, queued.id))
    expect(await claimNextGenerationJob('t13-c', new Date())).toBeNull()
    const resumeClaim = await claimNextStoryboardJob('t13-c', new Date())
    expect(resumeClaim?.job.id).toBe(queued.id)
    // Release for later phases.
    await getDb()
      .update(prayerGenerationJobs)
      .set({ leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, queued.id))

    // The worker path resumes it end-to-end.
    const resumed = await runStoryboardPlanningOnce('t13-resume', {
      now: () => new Date(),
    })
    expect(resumed.status).toBe('PLANNED')
    expect((await jobForAppointment(reservation.appointmentId))!.status).toBe(
      'GENERATING_VISUALS',
    )
  }, 240_000)

  it('expired STORYBOARDING leases consume the retry budget and eventually FAIL', async () => {
    const serviceId = nextService()
    const theme = `T13_LEASE_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId, appointmentId } = await makeStoryboardReadyJob(serviceId)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ maxAttempts: 2, attemptCount: 0 })
      .where(eq(prayerGenerationJobs.id, jobId))
    const clock = makeFakeClock(Date.now())

    // Crash 1 → RETRYING (resume STORYBOARDING), attempt 1.
    const claim1 = await claimNextStoryboardJob('crash-1', clock.now())
    expect(claim1?.job.id).toBe(jobId)
    clock.advance(DEFAULT_LEASE_MS + 60_000)
    expect(
      await recoverExpiredGenerationLeases(clock.now()),
    ).toBeGreaterThanOrEqual(1)
    let row = (await jobForAppointment(appointmentId))!
    expect(row.status).toBe('RETRYING')
    expect(row.resumeStatus).toBe('STORYBOARDING')
    expect(row.attemptCount).toBe(1)

    // Crash 2 → FAILED at max attempts, no snapshots, no crash loop.
    clock.advance(2 * 60_000)
    const claim2 = await claimNextStoryboardJob('crash-2', clock.now())
    expect(claim2?.job.id).toBe(jobId)
    expect(
      await transitionGenerationJobUnderLease(
        jobId,
        claim2!.leaseToken,
        'RETRYING',
        'STORYBOARDING',
        clock,
      ),
    ).toBe(true)
    clock.advance(DEFAULT_LEASE_MS + 60_000)
    expect(
      await recoverExpiredGenerationLeases(clock.now()),
    ).toBeGreaterThanOrEqual(1)
    row = (await jobForAppointment(appointmentId))!
    expect(row.status).toBe('FAILED')
    expect(row.attemptCount).toBe(2)
    expect(row.lastErrorCode).toBe('LEASE_EXPIRED')
    expect(await recoverExpiredGenerationLeases(clock.now())).toBe(0)
    expect((await storyboardRows(jobId)).length).toBe(0)
  }, 240_000)

  it('a stale worker finalizes nothing, even with a validly built storyboard', async () => {
    const serviceId = nextService()
    const theme = `T13_STALE_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId, appointmentId } = await makeStoryboardReadyJob(serviceId)
    const clock = makeFakeClock(Date.now())

    const claim = await claimNextStoryboardJob('worker-A', clock.now())
    expect(claim?.job.id).toBe(jobId)
    const built = await buildValidatedGenerationStoryboard(jobId)
    expect(built.status).toBe('OK')
    if (built.status !== 'OK') return

    // Lease lapses and is recovered before finalization.
    clock.advance(DEFAULT_LEASE_MS + 60_000)
    expect(
      await recoverExpiredGenerationLeases(clock.now()),
    ).toBeGreaterThanOrEqual(1)
    const persisted = await persistStoryboardManifestUnderLease(
      jobId,
      claim!.leaseToken,
      1,
      built.storyboard,
      built.recipeSnapshotId,
      clock,
    )
    expect(persisted).toBeNull()
    expect((await storyboardRows(jobId)).length).toBe(0)
    expect((await manifestRows(jobId)).length).toBe(0)
    expect((await jobForAppointment(appointmentId))!.status).toBe('RETRYING')
  }, 240_000)

  it('a job/context mismatch and an INVALID current recipe both block storyboarding', async () => {
    const serviceId = nextService()
    const theme = `T13_AUTH_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    const visual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId } = await makeStoryboardReadyJob(serviceId)

    // Upstream media withdrawal → current recipe INVALID → blocked.
    await setMediaRuntimeEnabled(adminId, ctx, visual.versionId, false)
    const invalid = await buildValidatedGenerationStoryboard(jobId)
    expect(invalid.status).toBe('RECIPE_NOT_VALID')
    await setMediaRuntimeEnabled(adminId, ctx, visual.versionId, true)
    expect((await buildValidatedGenerationStoryboard(jobId)).status).toBe('OK')

    // Frozen-context mismatch → fails closed.
    await getDb()
      .update(prayerGenerationJobs)
      .set({ variationSeed: 'a'.repeat(64) })
      .where(eq(prayerGenerationJobs.id, jobId))
    const mismatch = await buildValidatedGenerationStoryboard(jobId)
    expect(mismatch.status).toBe('CONTEXT_MISMATCH')
    if (mismatch.status === 'CONTEXT_MISMATCH') {
      expect(mismatch.reasons).toContain('seed')
    }
    expect((await storyboardRows(jobId)).length).toBe(0)
  }, 240_000)
})

describe('storyboard/manifest loaders fail closed', () => {
  it('payload tampering → INTEGRITY_FAILURE; upstream withdrawal → INVALID; never healed', async () => {
    const serviceId = nextService()
    const theme = `T13_LOAD_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    const visual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId } = await makeStoryboardReadyJob(serviceId)
    expect(
      (await runStoryboardPlanningOnce('t13-load', { now: () => new Date() }))
        .status,
    ).toBe('PLANNED')
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )

    const storyboardRow = (await storyboardRows(jobId))[0]
    const manifestRow = (await manifestRows(jobId))[0]

    // Storyboard text tamper → payload hash mismatch.
    await getDb()
      .update(prayerGenerationStoryboardSnapshots)
      .set({
        storyboardJsonText: storyboardRow.storyboardJsonText.replace(
          '"scenes"',
          '"scenes" ',
        ),
      })
      .where(eq(prayerGenerationStoryboardSnapshots.id, storyboardRow.id))
    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    await getDb()
      .update(prayerGenerationStoryboardSnapshots)
      .set({ storyboardJsonText: storyboardRow.storyboardJsonText })
      .where(eq(prayerGenerationStoryboardSnapshots.id, storyboardRow.id))
    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe('OK')

    // Manifest hash tamper → INTEGRITY_FAILURE, never auto-healed.
    await getDb()
      .update(prayerGenerationManifestSnapshots)
      .set({ payloadSha256: 'f'.repeat(64) })
      .where(eq(prayerGenerationManifestSnapshots.id, manifestRow.id))
    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    await getDb()
      .update(prayerGenerationManifestSnapshots)
      .set({ payloadSha256: manifestRow.payloadSha256 })
      .where(eq(prayerGenerationManifestSnapshots.id, manifestRow.id))
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )

    // Upstream media withdrawal invalidates the persisted manifest.
    await setMediaRuntimeEnabled(adminId, ctx, visual.versionId, false)
    const invalid = await loadAndValidateGenerationManifest(jobId)
    expect(invalid.status).toBe('INVALID')
    if (invalid.status === 'INVALID') {
      expect(invalid.reasons.some((r) => r.startsWith('recipe_'))).toBe(true)
    }
    await setMediaRuntimeEnabled(adminId, ctx, visual.versionId, true)
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )
  }, 240_000)

  it('a corrupted Visual Bible invalidates a manifest containing generated scenes', async () => {
    const serviceId = nextService()
    const theme = `T13_VB_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: theme,
      contentType: 'CHANT',
      externalAiPolicy: 'METADATA_ONLY',
      durationHintSeconds: 20,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'CHANT' }),
    ])
    const { jobId } = await makeStoryboardReadyJob(serviceId)
    expect(
      (await runStoryboardPlanningOnce('t13-vb', { now: () => new Date() }))
        .status,
    ).toBe('PLANNED')
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )

    const loaded = await loadGenerationStoryboardSnapshot(jobId)
    if (loaded.status !== 'OK') throw new Error('expected storyboard')
    const rule = (
      await getDb()
        .select()
        .from(visualBibleRules)
        .where(
          eq(
            visualBibleRules.bibleVersionId,
            loaded.storyboard.visualBibleVersionId!,
          ),
        )
        .limit(1)
    ).at(0)!
    await getDb()
      .update(visualBibleRules)
      .set({ ruleText: 'tampered rule text' })
      .where(eq(visualBibleRules.id, rule.id))
    const invalid = await loadAndValidateGenerationManifest(jobId)
    expect(invalid.status).toBe('INVALID')
    if (invalid.status === 'INVALID') {
      expect(
        invalid.reasons.some((reason) => reason.startsWith('visual_bible')),
      ).toBe(true)
    }
    await getDb()
      .update(visualBibleRules)
      .set({ ruleText: rule.ruleText })
      .where(eq(visualBibleRules.id, rule.id))
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )
  }, 240_000)
})

describe('guards', () => {
  it('Step 13 modules call no providers, TTS, render tools or queue brokers', () => {
    const files = [
      'src/services/generation-storyboards.ts',
      'src/db/schema/storyboards.ts',
      'src/workers/prayer-generation-worker.ts',
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
      expect(source).not.toMatch(/Math\.random\s*\(/)
      expect(source).not.toMatch(/Date\.now\s*\(/)
    }
    const routeTree = readFileSync(
      join(process.cwd(), 'src', 'routeTree.gen.ts'),
      'utf8',
    )
    expect(routeTree).not.toMatch(/prayer.?room/i)
    expect(routeTree).not.toMatch(/fullPath: '\/storyboard/)
  })

  it('no job reaches READY in Step 13', async () => {
    const ready = await getDb()
      .select({ id: prayerGenerationJobs.id })
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.status, 'READY'))
    expect(ready.length).toBe(0)
    expect(MAX_SCENES).toBeGreaterThan(0)
  })
})
