import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, inArray, like, sql } from 'drizzle-orm'
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
  loadGenerationRecipeSnapshot,
  runGenerationPreparationOnce,
} from '@/services/generation-jobs'
import {
  MAX_SCENE_MS,
  buildValidatedGenerationStoryboard,
  computeManifestSha256,
  computeStoryboardSha256,
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
import type { SacredProfileInput } from '@/services/sacred-content'
import type {
  GenerationManifest,
  GenerationStoryboard,
} from '@/services/generation-storyboards'
import type { SlotInput } from '@/services/prayer-templates'
import type { VideoRecipe } from '@/services/video-recipes'

/**
 * RED-TEAM regression suite (adversarial), covering contract items 1-4
 * assigned to CHARLIE:
 *   1. METADATA_ONLY tamper (textContextAllowed false -> true, rehashed)
 *   2. Rehash manifest tampering: generationIntent / approvedMedia / an
 *      audio requirement altered, every checksum recomputed consistent
 *   3. Split-visual audio integrity: one audio requirement covering the
 *      COMPLETE original segment, never the shortened first sub-scene
 *   4. Incoherent recipe scene source (declared source with no backing
 *      data) must fail loudly, never silently become HOLD_PREVIOUS
 *
 * Every tamper here recomputes ALL affected checksums so the persisted
 * record is internally self-consistent — these tests exist to prove
 * authority/semantic validation catches what pure hash-matching cannot.
 * NEW FILE ONLY: this suite never imports test helpers from another
 * test file and never modifies production code or existing tests.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `redteam tamper test passphrase ${crypto.randomUUID()}`
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

function syntheticBytes(marker: string = crypto.randomUUID()): Uint8Array {
  return new TextEncoder().encode(`redteam-tamper-media-bytes ${marker}`)
}

function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
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
    durationHintSeconds: 30,
    repeatable: false,
    voicePolicy: 'TEXT_ONLY',
    externalAiPolicy: 'METADATA_ONLY',
    accessPolicy: 'PRAYER_ROOM_PRIVATE',
    ...overrides,
  }
}

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
      title: 'Red-team tamper sacred block',
      body: `Red-team tamper sacred block ${crypto.randomUUID()}`,
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
 * parked in STORYBOARDING, ready for storyboard planning. */
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
  const prepared = await runGenerationPreparationOnce('rta-prep', {
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

async function latestRecipeSnapshotRow(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationRecipeSnapshots)
      .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
      .orderBy(sql`${prayerGenerationRecipeSnapshots.snapshotNumber} DESC`)
      .limit(1)
  ).at(0)!
}

/** Tampers a persisted storyboard snapshot and rehashes it so every
 * checksum (payload sha + canonical storyboard sha) is internally
 * consistent — the ONLY way to isolate a genuine authority/semantic
 * validation gap from a trivial "hash mismatch" catch. */
async function persistTamperedStoryboard(
  rowId: number,
  mutate: (storyboard: GenerationStoryboard) => void,
): Promise<{ storyboard: GenerationStoryboard; storyboardSha256: string }> {
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationStoryboardSnapshots)
      .where(eq(prayerGenerationStoryboardSnapshots.id, rowId))
      .limit(1)
  ).at(0)!
  const parsed = JSON.parse(row.storyboardJsonText) as GenerationStoryboard
  mutate(parsed)
  const { storyboardSha256: _old, ...body } = parsed
  const newSha = computeStoryboardSha256(body)
  const next: GenerationStoryboard = { ...body, storyboardSha256: newSha }
  const text = JSON.stringify(next)
  await getDb()
    .update(prayerGenerationStoryboardSnapshots)
    .set({
      storyboardJsonText: text,
      payloadSha256: sha256hex(text),
      storyboardSha256: newSha,
    })
    .where(eq(prayerGenerationStoryboardSnapshots.id, rowId))
  return { storyboard: next, storyboardSha256: newSha }
}

/** Same rehashing discipline for a persisted manifest snapshot. */
async function persistTamperedManifest(
  rowId: number,
  mutate: (manifest: GenerationManifest) => void,
): Promise<GenerationManifest> {
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationManifestSnapshots)
      .where(eq(prayerGenerationManifestSnapshots.id, rowId))
      .limit(1)
  ).at(0)!
  const parsed = JSON.parse(row.manifestJsonText) as GenerationManifest
  mutate(parsed)
  const { manifestSha256: _old, ...body } = parsed
  const newSha = computeManifestSha256(body)
  const next: GenerationManifest = { ...body, manifestSha256: newSha }
  const text = JSON.stringify(next)
  await getDb()
    .update(prayerGenerationManifestSnapshots)
    .set({
      manifestJsonText: text,
      payloadSha256: sha256hex(text),
      manifestSha256: newSha,
    })
    .where(eq(prayerGenerationManifestSnapshots.id, rowId))
  return next
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-redteam-tamper-test-'))
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
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 20; i += 1) {
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

  const bible = await createVisualBible(cmId, ctx, houseId)
  createdBibleIds.push(bible.id)
  const bibleVersion = await createVisualBibleVersion(cmId, ctx, bible.id, {
    rules: [
      {
        category: 'ENVIRONMENT',
        position: 1,
        ruleText: 'Red-team synthetic rule: riverside at dawn.',
      },
      {
        category: 'PROHIBITED_IMAGERY',
        position: 2,
        ruleText: 'Red-team synthetic rule: no modern logos.',
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
// Item 1: METADATA_ONLY tamper — textContextAllowed false -> true
// ----------------------------------------------------------------------------

describe('red-team: METADATA_ONLY textContextAllowed tamper', () => {
  it('flipping textContextAllowed false->true with rehashed checksums must still be INVALID', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_META_${RUN_KEY}`
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
      (await runStoryboardPlanningOnce('rta-meta', { now: () => new Date() }))
        .status,
    ).toBe('PLANNED')
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'VALID',
    )

    const storyboardRow = (await storyboardRows(jobId))[0]
    const manifestRow = (await manifestRows(jobId))[0]

    let targetSceneId = ''
    const { storyboardSha256: newSha } = await persistTamperedStoryboard(
      storyboardRow.id,
      (sb) => {
        const scene = sb.scenes.find(
          (s) =>
            s.sourceMode === 'GENERATION_REQUIRED' &&
            s.generationIntent?.textContextAllowed === false,
        )
        if (!scene?.generationIntent) {
          throw new Error('fixture must contain a METADATA_ONLY generation scene')
        }
        // Flip the AI-body-retrieval policy flag METADATA_ONLY -> effectively
        // APPROVED_TEXT_CONTEXT, without ever touching the recipe authority.
        scene.generationIntent.textContextAllowed = true
        targetSceneId = scene.sceneId
      },
    )

    await persistTamperedManifest(manifestRow.id, (manifest) => {
      // Keep the manifest<->storyboard binding and its own copy of the
      // intent internally consistent — the tamper's ONLY effect must be
      // the semantic policy flip, never a stray hash mismatch.
      manifest.storyboardSha256 = newSha
      const task = manifest.visualTasks.find(
        (t) => t.sceneId === targetSceneId,
      )
      if (task) task.generationIntent.textContextAllowed = true
    })

    // Sanity: every checksum recomputes cleanly — the tamper is
    // internally consistent, so any INVALID verdict below can only come
    // from authority/semantic validation, never from a hash mismatch.
    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe('OK')
    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe('OK')

    // TEETH: current recipe authority never granted textContextAllowed
    // for this METADATA_ONLY content — validation must fail CLOSED.
    const validated = await loadAndValidateGenerationManifest(jobId)
    expect(validated.status).toBe('INVALID')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 2: rehash manifest tampering (3 cases)
// ----------------------------------------------------------------------------

describe('red-team: rehash manifest tampering', () => {
  it('generationIntent field altered (themeCode) must still be INVALID', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_GENALT_${RUN_KEY}`
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
      (
        await runStoryboardPlanningOnce('rta-genalt', {
          now: () => new Date(),
        })
      ).status,
    ).toBe('PLANNED')

    const storyboardRow = (await storyboardRows(jobId))[0]
    const manifestRow = (await manifestRows(jobId))[0]
    let targetSceneId = ''
    const { storyboardSha256: newSha } = await persistTamperedStoryboard(
      storyboardRow.id,
      (sb) => {
        const scene = sb.scenes.find(
          (s) => s.sourceMode === 'GENERATION_REQUIRED' && s.generationIntent,
        )
        if (!scene?.generationIntent) {
          throw new Error('fixture must contain a generation scene')
        }
        scene.generationIntent.themeCode = `${theme}_SWAPPED`
        targetSceneId = scene.sceneId
      },
    )
    await persistTamperedManifest(manifestRow.id, (manifest) => {
      manifest.storyboardSha256 = newSha
      const task = manifest.visualTasks.find(
        (t) => t.sceneId === targetSceneId,
      )
      if (task) task.generationIntent.themeCode = `${theme}_SWAPPED`
    })

    expect((await loadGenerationStoryboardSnapshot(jobId)).status).toBe('OK')
    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe('OK')
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'INVALID',
    )
  }, 240_000)

  it('an approvedMedia entry altered (swapped media identity) must still be INVALID', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_MEDALT_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme, durationHintSeconds: 20 })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId } = await makeStoryboardReadyJob(serviceId)
    expect(
      (
        await runStoryboardPlanningOnce('rta-medalt', {
          now: () => new Date(),
        })
      ).status,
    ).toBe('PLANNED')
    const manifestRow = (await manifestRows(jobId))[0]

    await persistTamperedManifest(manifestRow.id, (manifest) => {
      if (manifest.approvedMedia.length === 0) {
        throw new Error('fixture must contain an approved-media entry')
      }
      // Swap in a bogus (but well-formed) media identity — the
      // storyboard's OWN scene record is left untouched on purpose, so
      // this isolates whether the manifest's approvedMedia array is
      // itself cross-checked against anything.
      manifest.approvedMedia[0].mediaAssetVersionId = 999_999_999
      manifest.approvedMedia[0].fileSha256 = 'a'.repeat(64)
    })

    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe('OK')
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'INVALID',
    )
  }, 240_000)

  it('an audio requirement altered (swapped media identity) must still be INVALID', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_AUDALT_${RUN_KEY}`
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
    const { jobId } = await makeStoryboardReadyJob(serviceId)
    expect(
      (
        await runStoryboardPlanningOnce('rta-audalt', {
          now: () => new Date(),
        })
      ).status,
    ).toBe('PLANNED')
    const manifestRow = (await manifestRows(jobId))[0]

    await persistTamperedManifest(manifestRow.id, (manifest) => {
      if (manifest.audioRequirements.length === 0) {
        throw new Error('fixture must contain an audio requirement')
      }
      manifest.audioRequirements[0].mediaAssetVersionId = 999_999_998
      manifest.audioRequirements[0].fileSha256 = 'b'.repeat(64)
    })

    expect((await loadGenerationManifestSnapshot(jobId)).status).toBe('OK')
    expect((await loadAndValidateGenerationManifest(jobId)).status).toBe(
      'INVALID',
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 3: split-visual audio integrity
// ----------------------------------------------------------------------------

describe('red-team: split-visual audio integrity', () => {
  it('a 40s+ segment split into 15s scenes yields exactly ONE audio requirement covering the FULL original segment', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_SPLITAUD_${RUN_KEY}`
    const SEGMENT_SECONDS = 46 // > 40s, and > 3x MAX_SCENE_MS (15s)
    const sacred = await makeEligibleSacred({
      themeCode: theme,
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
      durationHintSeconds: SEGMENT_SECONDS,
    })
    const audio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      language: 'en',
      sourceType: 'HUMAN_RECORDED',
      durationSeconds: SEGMENT_SECONDS,
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
    const { jobId } = await makeStoryboardReadyJob(serviceId)

    const built = await buildValidatedGenerationStoryboard(jobId)
    expect(built.status).toBe('OK')
    if (built.status !== 'OK') return
    const scenes = built.storyboard.scenes.filter((s) => s.kind === 'CONTENT')
    expect(scenes.length).toBeGreaterThan(1) // confirms an actual split happened
    expect(scenes.every((s) => s.durationMs <= MAX_SCENE_MS)).toBe(true)
    const originalSegmentDurationMs = scenes.reduce(
      (sum, s) => sum + s.durationMs,
      0,
    )
    expect(originalSegmentDurationMs).toBe(SEGMENT_SECONDS * 1000)
    const originalSegmentStartMs = Math.min(...scenes.map((s) => s.startMs))

    expect(
      (
        await runStoryboardPlanningOnce('rta-splitaud', {
          now: () => new Date(),
        })
      ).status,
    ).toBe('PLANNED')
    const manifest = await loadGenerationManifestSnapshot(jobId)
    expect(manifest.status).toBe('OK')
    if (manifest.status !== 'OK') return

    // TEETH: exactly one requirement, spanning the WHOLE original
    // segment — not the (shorter) first split sub-scene's own window,
    // and not one duplicated requirement per split sub-scene.
    expect(manifest.manifest.audioRequirements.length).toBe(1)
    const requirement = manifest.manifest.audioRequirements[0]
    expect(requirement.startMs).toBe(originalSegmentStartMs)
    expect(requirement.endMs - requirement.startMs).toBe(
      originalSegmentDurationMs,
    )
    expect(requirement.endMs).not.toBe(scenes[0].endMs) // not the first sub-scene's own end
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 4: incoherent recipe scene source
// ----------------------------------------------------------------------------

describe('red-team: incoherent recipe scene source', () => {
  it('LIBRARY_MEDIA declared with NO approved visual must fail loudly, never silently HOLD_PREVIOUS', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_INCOH1_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme, durationHintSeconds: 20 })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const { jobId } = await makeStoryboardReadyJob(serviceId)

    const snapshotRow = await latestRecipeSnapshotRow(jobId)
    const recipe = JSON.parse(snapshotRow.recipeJsonText) as Extract<
      VideoRecipe,
      { status: 'RECIPE_READY' }
    >
    const contentSegment = recipe.segments.find((s) => s.kind === 'CONTENT')
    if (!contentSegment) throw new Error('fixture must contain a CONTENT segment')
    expect(contentSegment.visual).not.toBeNull()
    // Force an incoherent declaration: LIBRARY_MEDIA claimed but NO
    // approved visual actually backs it.
    contentSegment.visualMode = 'LIBRARY_MEDIA'
    contentSegment.visual = null

    const { recipeSha256: _old, ...body } = recipe
    const newRecipeSha = computeRecipeSha256(body)
    const newRecipe = { ...body, recipeSha256: newRecipeSha }
    const newText = JSON.stringify(newRecipe)
    await getDb()
      .update(prayerGenerationRecipeSnapshots)
      .set({
        recipeJsonText: newText,
        payloadSha256: sha256hex(newText),
        recipeSha256: newRecipeSha,
      })
      .where(eq(prayerGenerationRecipeSnapshots.id, snapshotRow.id))

    // Sanity: the tampered recipe snapshot loads cleanly (self-consistent).
    expect((await loadGenerationRecipeSnapshot(jobId)).status).toBe('OK')

    // TEETH: the storyboard builder must fail CLOSED with the exact
    // reason code, never silently planning a HOLD_PREVIOUS scene.
    const built = await buildValidatedGenerationStoryboard(jobId)
    expect(built.status).not.toBe('OK')
    if ('reasons' in built) {
      expect(built.reasons).toContain('incoherent_scene_source')
    } else {
      throw new Error(
        `expected a reasons-bearing failure status, got ${built.status}`,
      )
    }

    // No partial/silent writes anywhere in the worker path either.
    expect((await storyboardRows(jobId)).length).toBe(0)
    const outcome = await runStoryboardPlanningOnce('rta-incoh1', {
      now: () => new Date(),
    })
    expect(outcome.status).toBe('FAILED')
    expect((await storyboardRows(jobId)).length).toBe(0)
  }, 240_000)

  it('GENERATION_ALLOWED declared with NO generation descriptor must fail loudly, never silently HOLD_PREVIOUS', async () => {
    const serviceId = nextService()
    const theme = `${CODE_PREFIX}_INCOH2_${RUN_KEY}`
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

    const snapshotRow = await latestRecipeSnapshotRow(jobId)
    const recipe = JSON.parse(snapshotRow.recipeJsonText) as Extract<
      VideoRecipe,
      { status: 'RECIPE_READY' }
    >
    const contentSegment = recipe.segments.find((s) => s.kind === 'CONTENT')
    if (!contentSegment) throw new Error('fixture must contain a CONTENT segment')
    expect(contentSegment.visualMode).toBe('GENERATION_ALLOWED')
    expect(contentSegment.generation).not.toBeNull()
    // Force an incoherent declaration: GENERATION_ALLOWED claimed but NO
    // generation descriptor actually backs it.
    contentSegment.generation = null

    const { recipeSha256: _old, ...body } = recipe
    const newRecipeSha = computeRecipeSha256(body)
    const newRecipe = { ...body, recipeSha256: newRecipeSha }
    const newText = JSON.stringify(newRecipe)
    await getDb()
      .update(prayerGenerationRecipeSnapshots)
      .set({
        recipeJsonText: newText,
        payloadSha256: sha256hex(newText),
        recipeSha256: newRecipeSha,
      })
      .where(eq(prayerGenerationRecipeSnapshots.id, snapshotRow.id))

    // Sanity: the tampered recipe snapshot loads cleanly (self-consistent).
    expect((await loadGenerationRecipeSnapshot(jobId)).status).toBe('OK')

    const built = await buildValidatedGenerationStoryboard(jobId)
    expect(built.status).not.toBe('OK')
    // USER-RATIFIED (via Team Lead): Step 11's validateVideoRecipe
    // (video-recipes.ts:867-874) already covers this exact incoherence —
    // `(visualMode==='GENERATION_ALLOWED') !== (generation!=null)` — and
    // emits the slot-tagged `generation_mode_inconsistent:<slot>`, which
    // is strictly MORE diagnostic than a bare `incoherent_scene_source`.
    // That check runs inside loadAndValidateGenerationRecipe at the very
    // top of buildValidatedGenerationStoryboard, so it legitimately
    // short-circuits before Step 13's own incoherent-source guard is
    // ever reached — the result is RECIPE_NOT_VALID, not
    // GOVERNANCE_IMPOSSIBLE. This is accepted as correct: do NOT "fix"
    // this assertion back to incoherent_scene_source. The genuine hole
    // was LIBRARY_MEDIA/LINKED_REFERENCE with visual==null (Step 11 had
    // no equivalent check) — that case, above, still asserts exactly
    // incoherent_scene_source and stays green.
    expect(built.status).toBe('RECIPE_NOT_VALID')
    if (built.status === 'RECIPE_NOT_VALID') {
      expect(built.reasons).toContain('generation_mode_inconsistent:MAIN_PRAYER')
    } else {
      throw new Error(`expected RECIPE_NOT_VALID, got ${built.status}`)
    }
    expect((await storyboardRows(jobId)).length).toBe(0)
    // RECIPE_NOT_VALID (unlike GOVERNANCE_IMPOSSIBLE) is not in
    // STRUCTURAL_FAILURES, so the worker treats it as a
    // possibly-recoverable authority state and schedules a bounded
    // retry rather than failing immediately — consistent with every
    // other RECIPE_NOT_VALID case in this codebase. The safety property
    // that matters here is unchanged: still no silent success, still no
    // partial/silent snapshot writes.
    const outcome = await runStoryboardPlanningOnce('rta-incoh2', {
      now: () => new Date(),
    })
    expect(outcome.status).toBe('RETRY_SCHEDULED')
    expect((await storyboardRows(jobId)).length).toBe(0)
  }, 240_000)
})
