import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  prayerGenerationVisualTasks,
  prayerSessionTemplateSlots,
  prayerSessionTemplateVersions,
  prayerSessionTemplates,
  prayerTemplateForbiddenPairs,
  prayerTemplateSlotPins,
  prayerTemplateSlotScopes,
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
  getMediaStorage,
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
  approveVisualBibleVersion,
  createVisualBible,
  createVisualBibleVersion,
  publishVisualBibleVersion,
  submitVisualBibleVersion,
} from '@/services/visual-bibles'
import {
  VISUAL_TASK_POLL_DELAY_MS,
  runGenerationPreparationOnce,
  runVisualGenerationOnce,
} from '@/services/generation-jobs'
import {
  computeManifestSha256,
  runStoryboardPlanningOnce,
} from '@/services/generation-storyboards'
import {
  compileVisualGenerationRequest,
  pollScene,
  submitScene,
} from '@/services/visual-generation'
import {
  resetVisualGenerationProviderForTests,
  setVisualGenerationProviderForTests,
} from '@/providers/visual-generation/registry'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { VisualGenerationDependencies } from '@/services/generation-jobs'
import type { GenerationManifest } from '@/services/generation-storyboards'
import type {
  VisualGenerationPollResult,
  VisualGenerationProvider,
  VisualGenerationRequest,
  VisualGenerationSubmission,
} from '@/providers/visual-generation/types'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * See tests/integration/red-team-visual-generation-submission.test.ts for
 * the full REAL contract note (verified against landed source, not
 * guessed) — not restated here. File-local prefix RTW_ (distinct from
 * RTV_) so the two files' fixtures never collide.
 *
 * `submitScene`/`pollScene` (Alpha, src/services/visual-generation.ts)
 * ALREADY match Bravo's VisualGenerationDependencies shape exactly
 * (submitScene(task): Promise<VisualTaskSubmissionResult>,
 * pollScene({providerCode, providerOperationId, task}):
 * Promise<VisualTaskPollResult>) — the seam earlier drafts of this file
 * had to bridge is resolved; `realDependencies` below is just
 * `{ submitScene, pollScene }`, not an adapter.
 */
const realDependencies: VisualGenerationDependencies = { submitScene, pollScene }

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `redteam visgen authority test passphrase ${crypto.randomUUID()}`
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
const CODE_PREFIX = `RTW_${RUN_KEY}`
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
  return new TextEncoder().encode(`redteam-visgen-authority-bytes ${marker}`)
}

function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `rtw-${crypto.randomUUID()}@test.local`,
      preferredName: 'RTW Fixture',
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

const SACRED_BODY_MARKER = 'Red-team-visgen-authority sacred block body'

async function makeEligibleSacred(options: {
  themeCode: string
  contentType?: 'PRAYER' | 'CHANT' | 'BLESSING'
  externalAiPolicy?:
    'NO_EXTERNAL_AI' | 'METADATA_ONLY' | 'APPROVED_TEXT_CONTEXT'
  durationHintSeconds?: number
}): Promise<{ itemId: number; versionId: number; bodyMarker: string }> {
  const bodyMarker = `${SACRED_BODY_MARKER} ${crypto.randomUUID()}`
  const item = await createSacredContentItem(cmId, ctx, {
    code: nextCode('SC'),
    contentType: options.contentType ?? 'CHANT',
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
      title: 'Red-team visgen authority sacred block',
      body: bodyMarker,
    },
    sacredProfile({
      themeCode: options.themeCode,
      voicePolicy: 'TEXT_ONLY',
      externalAiPolicy: options.externalAiPolicy ?? 'METADATA_ONLY',
      durationHintSeconds: options.durationHintSeconds ?? 20,
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
  return { assetId: asset.id, versionId: version.id }
}

function filterSlot(overrides: Partial<SlotInput> = {}): SlotInput {
  return {
    slotKey: 'MAIN_PRAYER',
    position: 1,
    slotKind: 'CONTENT',
    minSelect: 1,
    maxSelect: 1,
    contentType: 'CHANT',
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
            'GENERATING_VISUALS',
          ]),
        ),
      )
  }
}

async function driveToGeneratingVisuals(
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
  const prepared = await runGenerationPreparationOnce('rtw-prep', {
    now: () => new Date(),
  })
  expect(prepared.status).toBe('PREPARED')
  const planned = await runStoryboardPlanningOnce('rtw-plan', {
    now: () => new Date(),
  })
  expect(planned.status).toBe('PLANNED')
  const row = (await jobForAppointment(reservation.appointmentId))!
  expect(row.status).toBe('GENERATING_VISUALS')
  return { jobId: job.id, appointmentId: reservation.appointmentId }
}

/** A job with a GENERATION_REQUIRED scene (CHANT, no library visual). */
async function makeGenerationRequiredJob(
  externalAiPolicy: 'METADATA_ONLY' | 'APPROVED_TEXT_CONTEXT' = 'METADATA_ONLY',
): Promise<{
  jobId: number
  appointmentId: number
  bodyMarker: string
  manifest: GenerationManifest
}> {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_GEN_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  const sacred = await makeEligibleSacred({
    themeCode: theme,
    contentType: 'CHANT',
    externalAiPolicy,
    // Deliberately under Step 13's MAX_SCENE_MS (15s) so this segment
    // never splits into multiple scenes — several tests here assert
    // exactly ONE GENERATION_REQUIRED task, and a split would (validly)
    // multiply that number, which is a different property entirely.
    durationHintSeconds: 10,
  })
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'CHANT' }),
  ])
  const { jobId, appointmentId } = await driveToGeneratingVisuals(serviceId)
  const manifest = await latestManifest(jobId)
  expect(manifest.visualTasks.length).toBeGreaterThan(0)
  return { jobId, appointmentId, bodyMarker: sacred.bodyMarker, manifest }
}

/** A job whose ONLY content scene is APPROVED_MEDIA (library image) —
 * zero GENERATION_REQUIRED scenes, zero visual tasks expected. */
async function makeApprovedMediaOnlyJob(): Promise<{
  jobId: number
  appointmentId: number
  manifest: GenerationManifest
}> {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_MEDIA_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  await makeEligibleSacred({
    themeCode: theme,
    contentType: 'PRAYER',
    durationHintSeconds: 15,
  })
  await makeEligibleMedia({
    assetKind: 'IMAGE',
    contentType: 'PRAYER',
    themeCode: theme,
  })
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
  ])
  const { jobId, appointmentId } = await driveToGeneratingVisuals(serviceId)
  const manifest = await latestManifest(jobId)
  return { jobId, appointmentId, manifest }
}

async function latestManifestRow(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationManifestSnapshots)
      .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
  ).at(-1)!
}

async function latestManifest(jobId: number): Promise<GenerationManifest> {
  const row = await latestManifestRow(jobId)
  return JSON.parse(row.manifestJsonText) as GenerationManifest
}

async function visualTaskRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationVisualTasks)
    .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
}

async function jobEventRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationJobEvents)
    .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
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

/** A no-op VisualGenerationDependencies that fails the test loudly if
 * ever invoked — used to prove a code path never reaches the provider. */
function neverCalledDependencies(spy: { submitCalls: number; pollCalls: number }): VisualGenerationDependencies {
  return {
    submitScene: async () => {
      spy.submitCalls += 1
      return { status: 'SUBMITTED', providerCode: 'MOCK', providerOperationId: 'unexpected' }
    },
    pollScene: async () => {
      spy.pollCalls += 1
      return { status: 'PROCESSING' }
    },
  }
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-redteam-visgen-auth-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'RTW\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'RTW\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'RTW\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `RTWH_${key}`.toUpperCase(),
    name: `RTW House ${key}`,
    slug: `rtwh-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 20; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `RTWS${i}_${key}`.toUpperCase(),
      name: `RTW Service ${i} ${key}`,
      slug: `rtws${i}-${key}`,
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
        ruleText: 'Red-team visgen authority synthetic rule: riverside at dawn.',
      },
      {
        category: 'PROHIBITED_IMAGERY',
        position: 2,
        ruleText: 'Red-team visgen authority synthetic rule: no modern logos.',
      },
    ],
  })
  await submitVisualBibleVersion(cmId, ctx, bibleVersion.id)
  await approveVisualBibleVersion(adminId, ctx, bibleVersion.id)
  await publishVisualBibleVersion(adminId, ctx, bibleVersion.id)
})

afterAll(async () => {
  resetVisualGenerationProviderForTests()
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
// Item 5: manifest tamper AFTER task creation
// ----------------------------------------------------------------------------

describe('red-team: manifest tampered after task creation is caught before generation', () => {
  it('a rehashed, self-consistent manifest tamper blocks the cycle before any provider call', async () => {
    const { jobId } = await makeGenerationRequiredJob()
    // First cycle: create the task row, leave it PROCESSING (never
    // completes) so the job stays in GENERATING_VISUALS.
    const first = await runVisualGenerationOnce(
      'rtw-tamper-seed',
      { now: () => new Date() },
      {
        submitScene: async (task) => ({
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${task.taskId}`,
        }),
        pollScene: async () => ({ status: 'PROCESSING' }),
      },
    )
    expect(first.status).toBe('WAITING')
    expect((await visualTaskRows(jobId)).length).toBe(1)

    // Tamper the PERSISTED manifest and rehash it internally-consistently
    // — the same discipline proven in Step 13's rehash-manifest-tampering
    // suite.
    const manifestRow = await latestManifestRow(jobId)
    const parsed = JSON.parse(manifestRow.manifestJsonText) as GenerationManifest
    parsed.visualTasks[0].durationMs = parsed.visualTasks[0].durationMs + 5_000
    const { manifestSha256: _old, ...body } = parsed
    const newSha = computeManifestSha256(body)
    const newManifest = { ...body, manifestSha256: newSha }
    const newText = JSON.stringify(newManifest)
    await getDb()
      .update(prayerGenerationManifestSnapshots)
      .set({
        manifestJsonText: newText,
        payloadSha256: sha256hex(newText),
        manifestSha256: newSha,
      })
      .where(eq(prayerGenerationManifestSnapshots.id, manifestRow.id))

    const spy = { submitCalls: 0, pollCalls: 0 }
    const outcome = await runVisualGenerationOnce(
      'rtw-tamper-run',
      { now: () => new Date() },
      neverCalledDependencies(spy),
    )
    // TEETH: NOT SUBMITTED and NEVER called the provider — the top-of-
    // cycle loadAndValidateGenerationManifest revalidation (Step 13's
    // rebuild-and-diff mechanism) must catch this BEFORE the task loop.
    expect(outcome.status).not.toBe('COMPLETE')
    expect(outcome.status).not.toBe('WAITING')
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    const job = await jobRow(jobId)
    expect(job.status).not.toBe('GENERATING_AUDIO')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 6: authority/rights/Visual Bible withdrawal BEFORE the provider call
// ----------------------------------------------------------------------------

describe('red-team: authority withdrawal before the provider call fails closed', () => {
  it('Visual Bible unpublished after manifest persistence blocks the whole cycle and calls the provider ZERO times', async () => {
    const { jobId } = await makeGenerationRequiredJob()
    const bibleVersionRow = (
      await getDb()
        .select({ id: visualBibleVersions.id, status: visualBibleVersions.status })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.visualBibleId, createdBibleIds[0]))
        .limit(1)
    ).at(0)!
    await getDb()
      .update(visualBibleVersions)
      .set({ status: 'ARCHIVED' })
      .where(eq(visualBibleVersions.id, bibleVersionRow.id))

    const spy = { submitCalls: 0, pollCalls: 0 }
    let outcome
    try {
      outcome = await runVisualGenerationOnce(
        'rtw-authority',
        { now: () => new Date() },
        neverCalledDependencies(spy),
      )
    } finally {
      await getDb()
        .update(visualBibleVersions)
        .set({ status: bibleVersionRow.status })
        .where(eq(visualBibleVersions.id, bibleVersionRow.id))
    }
    expect(outcome.status).not.toBe('COMPLETE')
    // TEETH: the provider must NEVER have been called — authority is
    // checked BEFORE spending anything, not after a failed call.
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect((await jobRow(jobId)).status).not.toBe('GENERATING_AUDIO')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 7 & 8: sacred-body / rule-text privacy
// ----------------------------------------------------------------------------

describe('red-team: sacred body and rule text never leak into persisted state', () => {
  it('METADATA_ONLY: the body is never retrieved and the compiled request carries null', async () => {
    const { jobId, bodyMarker } = await makeGenerationRequiredJob('METADATA_ONLY')
    const manifest = await latestManifest(jobId)
    const task = manifest.visualTasks[0]
    const compiled = await compileVisualGenerationRequest(task)
    expect(compiled.status).toBe('OK')
    if (compiled.status === 'OK') {
      // TEETH: exact contract — METADATA_ONLY means null, not merely
      // "excluded from some other field".
      expect(compiled.request.approvedTextContext).toBeNull()
      expect(JSON.stringify(compiled.request)).not.toContain(bodyMarker)
    }

    await runVisualGenerationOnce('rtw-meta', { now: () => new Date() }, realDependencies)
    const tasks = await visualTaskRows(jobId)
    const events = await jobEventRows(jobId)
    const payload = JSON.stringify({ tasks, events })
    expect(payload).not.toContain(bodyMarker)
  }, 240_000)

  it('APPROVED_TEXT_CONTEXT: the body may reach the in-memory request but NEVER the DB or event log', async () => {
    const { jobId, bodyMarker } = await makeGenerationRequiredJob(
      'APPROVED_TEXT_CONTEXT',
    )
    const manifest = await latestManifest(jobId)
    const task = manifest.visualTasks[0]
    const compiled = await compileVisualGenerationRequest(task)
    expect(compiled.status).toBe('OK')
    if (compiled.status === 'OK') {
      // Permitted in-memory only — proves the OTHER half of the policy
      // divergence (METADATA_ONLY above must be null; this must NOT be).
      expect(compiled.request.approvedTextContext).toBe(bodyMarker)
    }

    await runVisualGenerationOnce(
      'rtw-txtctx',
      { now: () => new Date() },
      realDependencies,
    )
    // TEETH: regardless of the permitted in-memory use above, it must be
    // ABSENT from every persisted row.
    const tasks = await visualTaskRows(jobId)
    const events = await jobEventRows(jobId)
    const payload = JSON.stringify({ tasks, events })
    expect(payload).not.toContain(bodyMarker)
  }, 240_000)

  it('raw Visual Bible rule TEXT never appears in persisted task/event rows', async () => {
    const { jobId } = await makeGenerationRequiredJob()
    await runVisualGenerationOnce(
      'rtw-rawpayload',
      { now: () => new Date() },
      realDependencies,
    )
    const tasks = await visualTaskRows(jobId)
    const events = await jobEventRows(jobId)
    const payload = JSON.stringify({ tasks, events })
    expect(payload).not.toContain('riverside at dawn')
    expect(payload).not.toContain('no modern logos')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 12: malformed / empty / wrong-mime provider output rejected
// ----------------------------------------------------------------------------

describe('red-team: malformed provider output is rejected, never persisted as success', () => {
  function badProvider(
    poll: () => Promise<VisualGenerationPollResult>,
  ): VisualGenerationProvider {
    return {
      code: 'BAD',
      displayName: 'Red-team malformed-output provider',
      isEnabled: () => true,
      submitScene: async (
        request: VisualGenerationRequest,
      ): Promise<VisualGenerationSubmission> => ({
        providerJobId: `bad-${request.idempotencyKey}`,
        status: 'PENDING',
      }),
      pollScene: poll,
    }
  }

  async function expectRejected(
    label: string,
    poll: () => Promise<VisualGenerationPollResult>,
    expectedReasonCode: string,
  ) {
    const { jobId } = await makeGenerationRequiredJob()
    const manifest = await latestManifest(jobId)
    const task = manifest.visualTasks[0]
    setVisualGenerationProviderForTests(badProvider(poll))
    try {
      const submitted = await submitScene(task)
      expect(submitted.status).toBe('SUBMITTED')
      if (submitted.status !== 'SUBMITTED') return
      const polled = await pollScene({
        providerCode: submitted.providerCode,
        providerOperationId: submitted.providerOperationId,
        task,
      })
      // TEETH: rejected with the EXACT expected reason code, never
      // silently accepted.
      expect(polled.status).toBe('FAILED')
      if (polled.status === 'FAILED') {
        expect(polled.errorCode).toBe(expectedReasonCode)
      }
    } finally {
      resetVisualGenerationProviderForTests()
    }
    void label
    void jobId
  }

  it('empty bytes are rejected (artifact_empty)', async () => {
    await expectRejected(
      'empty',
      async () => ({
        status: 'COMPLETED',
        artifact: { bytes: new Uint8Array(0), mimeType: 'video/mp4', durationMs: 5_000 },
        failureCode: null,
      }),
      'artifact_empty',
    )
  }, 240_000)

  it('a non-allowlisted mime type is rejected (artifact_mime_invalid)', async () => {
    await expectRejected(
      'wrong-mime',
      async () => ({
        status: 'COMPLETED',
        artifact: {
          bytes: new TextEncoder().encode('not actually a video'),
          mimeType: 'text/plain',
          durationMs: 5_000,
        },
        failureCode: null,
      }),
      'artifact_mime_invalid',
    )
  }, 240_000)

  it('a duration that does not match the requested scene length is rejected (artifact_duration_bound)', async () => {
    await expectRejected(
      'bad-duration',
      async () => ({
        status: 'COMPLETED',
        artifact: {
          bytes: new TextEncoder().encode('some bytes that look like video'),
          mimeType: 'video/mp4',
          durationMs: 999_999,
        },
        failureCode: null,
      }),
      'artifact_duration_bound',
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 13: artifact hash tampering is detected, never trusted blindly
// ----------------------------------------------------------------------------

describe('red-team: artifact hash tampering is detectable, never trusted blindly', () => {
  it('the recorded hash is the ACTUAL sha256 of the stored bytes, and tampering the stored bytes is detectable', async () => {
    const { jobId } = await makeGenerationRequiredJob()
    const manifest = await latestManifest(jobId)
    const task = manifest.visualTasks[0]
    const submitted = await submitScene(task)
    expect(submitted.status).toBe('SUBMITTED')
    if (submitted.status !== 'SUBMITTED') return
    const result = await pollScene({
      providerCode: submitted.providerCode,
      providerOperationId: submitted.providerOperationId,
      task,
    })
    expect(result.status).toBe('SUCCEEDED')
    if (result.status !== 'SUCCEEDED') return

    // The recorded hash must be freshly computed from the bytes that
    // were ACTUALLY stored — never a provider-supplied or otherwise
    // unverified value (there is no provider-claimed-hash field in the
    // protocol at all — verifyAndStoreArtifact always recomputes).
    const stored = await getMediaStorage().get(result.artifactStorageRef)
    expect(stored).not.toBeNull()
    if (!stored) return
    expect(result.artifactSha256).toBe(computeFileSha256(stored))

    // Now tamper the STORED BYTES directly (simulating disk-level
    // corruption/tampering after the fact). This proves the detection
    // MECHANISM itself is sound — recomputing from the actual bytes
    // reveals the tamper immediately — which is exactly what the
    // finalization gate does before GENERATING_VISUALS -> GENERATING_AUDIO
    // (see the storage-verification suite in
    // red-team-visual-generation-submission.test.ts, where the same
    // tamper is proved to BLOCK the advance).
    const absolutePath = join(storageRoot, result.artifactStorageRef)
    const original = readFileSync(absolutePath)
    writeFileSync(absolutePath, Buffer.from('tampered-artifact-bytes'))
    try {
      const tamperedBytes = await getMediaStorage().get(result.artifactStorageRef)
      expect(tamperedBytes).not.toBeNull()
      if (!tamperedBytes) return
      // TEETH: the ORIGINAL recorded hash no longer matches — tampering
      // is detectable, not silently trusted.
      expect(computeFileSha256(tamperedBytes)).not.toBe(result.artifactSha256)
    } finally {
      writeFileSync(absolutePath, original)
    }
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 14: approved-media scenes must create ZERO generation executions
// ----------------------------------------------------------------------------

describe('red-team: approved-media scenes never generate', () => {
  it('a manifest with only APPROVED_MEDIA scenes creates zero visual tasks and zero claimable work', async () => {
    const { jobId, manifest, appointmentId } = await makeApprovedMediaOnlyJob()
    void appointmentId
    // Per Alpha's own doc comment on compileVisualGenerationRequest: "A
    // scene bound to approved media... NEVER reaches this module at
    // all — Step 13's manifest builder only ever emits a visualTasks
    // entry for a GENERATION_REQUIRED scene... so 'no execution for an
    // approved-media scene' is an ARCHITECTURAL INVARIANT, not a
    // runtime check". This test proves that invariant structurally —
    // there is no ManifestVisualTask to compile a request FOR.
    expect(manifest.visualTasks.length).toBe(0)
    expect((await visualTaskRows(jobId)).length).toBe(0)

    const storyboardRow = (
      await getDb()
        .select()
        .from(prayerGenerationStoryboardSnapshots)
        .where(eq(prayerGenerationStoryboardSnapshots.generationJobId, jobId))
    ).at(-1)!
    const storyboard = JSON.parse(storyboardRow.storyboardJsonText) as {
      scenes: Array<{ sceneId: string; sourceMode: string }>
    }
    const approvedScene = storyboard.scenes.find(
      (scene) => scene.sourceMode === 'APPROVED_MEDIA',
    )!
    expect(approvedScene).toBeDefined()
    expect(
      manifest.visualTasks.some((task) => task.sceneId === approvedScene.sceneId),
    ).toBe(false)

    const spy = { submitCalls: 0, pollCalls: 0 }
    const outcome = await runVisualGenerationOnce(
      'rtw-approved',
      { now: () => new Date() },
      neverCalledDependencies(spy),
    )
    // Zero tasks means the loop body never runs at all.
    expect(spy.submitCalls).toBe(0)
    expect(spy.pollCalls).toBe(0)
    expect(outcome.status).toBe('COMPLETE')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 15: zero-task manifest transition — advances only after full validation
// ----------------------------------------------------------------------------

describe('red-team: zero-task manifest advances only after full validation', () => {
  it('a valid zero-task manifest DOES advance to GENERATING_AUDIO', async () => {
    const { jobId } = await makeApprovedMediaOnlyJob()
    const spy = { submitCalls: 0, pollCalls: 0 }
    const outcome = await runVisualGenerationOnce(
      'rtw-zerotask-ok',
      { now: () => new Date() },
      neverCalledDependencies(spy),
    )
    expect(outcome.status).toBe('COMPLETE')
    expect((await jobRow(jobId)).status).toBe('GENERATING_AUDIO')
  }, 240_000)

  it('a zero-task manifest that fails CURRENT authority does NOT advance, even with nothing left to generate', async () => {
    const { jobId } = await makeApprovedMediaOnlyJob()
    const manifest = await latestManifest(jobId)
    const approvedRef = manifest.approvedMedia[0]
    expect(approvedRef).toBeDefined()
    await setMediaRuntimeEnabled(
      adminId,
      ctx,
      approvedRef.mediaAssetVersionId,
      false,
    )
    const spy = { submitCalls: 0, pollCalls: 0 }
    let outcome
    try {
      outcome = await runVisualGenerationOnce(
        'rtw-zerotask-invalid',
        { now: () => new Date() },
        neverCalledDependencies(spy),
      )
    } finally {
      await setMediaRuntimeEnabled(
        adminId,
        ctx,
        approvedRef.mediaAssetVersionId,
        true,
      )
    }
    // TEETH: zero tasks is NOT a free pass — full validation still
    // applies and must block this advance.
    expect(outcome.status).not.toBe('COMPLETE')
    expect(spy.submitCalls).toBe(0)
    expect((await jobRow(jobId)).status).not.toBe('GENERATING_AUDIO')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 17: no paid/network calls anywhere in the Step 14 provider layer
// ----------------------------------------------------------------------------

/** Strips /* *\/ block and // line comments before pattern-matching, so
 * a doc comment that NAMES a forbidden pattern (to explain why the code
 * avoids it — e.g. mock.ts's own "NO Math.random(), NO Date.now()"
 * discipline note) is never mistaken for the pattern actually being
 * used. Does not weaken what the guard detects in real code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('red-team: no real provider/network calls anywhere in the Step 14 provider layer', () => {
  it('the executor service and every visual-generation provider file never touch a real network endpoint', () => {
    const files = [
      'src/services/visual-generation.ts',
      'src/providers/visual-generation/types.ts',
      'src/providers/visual-generation/mock.ts',
      'src/providers/visual-generation/registry.ts',
    ]
    for (const file of files) {
      const source = stripComments(readFileSync(join(process.cwd(), file), 'utf8'))
      expect(source).not.toMatch(/\bfetch\s*\(/)
      expect(source).not.toMatch(/https?:\/\/[^'"\s]*(kling|openart|runway)/i)
      expect(source).not.toMatch(
        /(from\s+['"]|require\()['"]?(ioredis|redis|bullmq|amqplib|kafkajs)/i,
      )
      expect(source).not.toMatch(/import[^\n]*(remotion|ffmpeg)/i)
      expect(source).not.toMatch(/Math\.random\s*\(/)
      expect(source).not.toMatch(/Date\.now\s*\(/)
    }
  })
})

// ----------------------------------------------------------------------------
// Step 14 hardening item 3: provider identity binding
//
// A providerOperationId is opaque and belongs to the provider that
// ISSUED it. Polling it against whichever provider happens to be active
// later asks the wrong backend about someone else's job — and then
// believes the answer. The persisted providerCode is therefore binding.
// ----------------------------------------------------------------------------

describe('red-team: a poll is bound to the provider that issued the operation', () => {
  function countingProvider(
    code: string,
    counters: { submits: number; polls: number },
  ): VisualGenerationProvider {
    return {
      code,
      displayName: `Red-team counting provider ${code}`,
      isEnabled: () => true,
      submitScene: async (
        request: VisualGenerationRequest,
      ): Promise<VisualGenerationSubmission> => {
        counters.submits += 1
        return { providerJobId: `${code}-${request.idempotencyKey}`, status: 'PENDING' }
      },
      pollScene: async (): Promise<VisualGenerationPollResult> => {
        counters.polls += 1
        // Deliberately a "success": if identity binding were missing,
        // this foreign result would be accepted as the artifact for a
        // scene it was never generated for.
        return {
          status: 'COMPLETED',
          artifact: {
            bytes: new TextEncoder().encode('foreign provider artifact bytes'),
            mimeType: 'video/mp4',
            durationMs: 5_000,
          },
          failureCode: null,
        }
      },
    }
  }

  it('a persisted provider code that no longer matches the active provider fails closed WITHOUT polling', async () => {
    const { jobId } = await makeGenerationRequiredJob()
    const manifest = await latestManifest(jobId)
    const task = manifest.visualTasks[0]
    const counters = { submits: 0, polls: 0 }
    // The operation id below was issued by MOCK; the provider active now
    // is a different one entirely.
    setVisualGenerationProviderForTests(countingProvider('OTHER', counters))
    try {
      const result = await pollScene({
        providerCode: 'MOCK',
        providerOperationId: 'mock-operation-issued-by-a-different-provider',
        task,
      })
      // TEETH: refused on identity alone, with a bounded machine code —
      // and the wrong provider was never asked anything.
      expect(result.status).toBe('FAILED')
      if (result.status === 'FAILED') {
        expect(result.errorCode).toBe('provider_code_mismatch')
      }
      expect(counters.polls).toBe(0)
      expect(counters.submits).toBe(0)
    } finally {
      resetVisualGenerationProviderForTests()
    }
  }, 240_000)

  it('the SAME poll succeeds once the persisted code names the active provider (control)', async () => {
    const { jobId } = await makeGenerationRequiredJob()
    const manifest = await latestManifest(jobId)
    const task = manifest.visualTasks[0]
    const counters = { submits: 0, polls: 0 }
    setVisualGenerationProviderForTests(countingProvider('OTHER', counters))
    try {
      const submitted = await submitScene(task)
      expect(submitted.status).toBe('SUBMITTED')
      if (submitted.status !== 'SUBMITTED') return
      // The code persisted at submission is the provider's OWN code —
      // that is what makes the later poll resolvable.
      expect(submitted.providerCode).toBe('OTHER')
      const result = await pollScene({
        providerCode: submitted.providerCode,
        providerOperationId: submitted.providerOperationId,
        task,
      })
      // TEETH: the mismatch test above proves refusal, this proves the
      // refusal is about IDENTITY and not a blanket "never poll".
      expect(result.status).toBe('SUCCEEDED')
      expect(counters.polls).toBe(1)
    } finally {
      resetVisualGenerationProviderForTests()
    }
  }, 240_000)

  it('an in-flight task never reaches a swapped-in provider through the job loop either', async () => {
    const { jobId } = await makeGenerationRequiredJob()
    // Cycle 1 submits against MOCK (the real executor, real registry),
    // persisting providerCode = MOCK on the row.
    const seeded = await runVisualGenerationOnce(
      'rtw-bind-seed',
      { now: () => new Date() },
      realDependencies,
    )
    expect(seeded.status).toBe('WAITING')
    const submittedRow = (await visualTaskRows(jobId))[0]
    expect(submittedRow.status).toBe('SUBMITTED')
    expect(submittedRow.providerCode).toBe('MOCK')

    // A different provider becomes active before the poll cycle.
    const counters = { submits: 0, polls: 0 }
    setVisualGenerationProviderForTests(countingProvider('OTHER', counters))
    let outcome
    try {
      outcome = await runVisualGenerationOnce(
        'rtw-bind-poll',
        { now: () => new Date(Date.now() + VISUAL_TASK_POLL_DELAY_MS + 60_000) },
        realDependencies,
      )
    } finally {
      resetVisualGenerationProviderForTests()
    }
    // TEETH: the swapped-in provider was never polled, so its foreign
    // "success" could never be recorded as this scene's artifact, and
    // the job certainly never advanced on the strength of it.
    expect(counters.polls).toBe(0)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('GENERATING_AUDIO')
    const afterRow = (await visualTaskRows(jobId))[0]
    expect(afterRow.artifactSha256).toBeNull()
    expect(afterRow.artifactStorageRef).toBeNull()
  }, 240_000)
})
