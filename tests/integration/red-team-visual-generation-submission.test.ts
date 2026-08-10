import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
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
  resetMediaStorageForTests,
  setMediaStorageForTests,
} from '@/providers/media/storage'
import {
  approveVisualBibleVersion,
  createVisualBible,
  createVisualBibleVersion,
  publishVisualBibleVersion,
  submitVisualBibleVersion,
} from '@/services/visual-bibles'
import {
  DEFAULT_LEASE_MS,
  GENERATION_TRANSITIONS,
  VISUAL_TASK_POLL_DELAY_MS,
  claimNextVisualGenerationJob,
  isLegalTransition,
  recoverExpiredGenerationLeases,
  runGenerationPreparationOnce,
  runVisualGenerationOnce,
} from '@/services/generation-jobs'
import { runStoryboardPlanningOnce } from '@/services/generation-storyboards'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type {
  GenerationClock,
  VisualGenerationDependencies,
} from '@/services/generation-jobs'
import type { GenerationManifest } from '@/services/generation-storyboards'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * ============================================================================
 * REAL CONTRACT — Phase One, Step 14 (verified against landed source, not
 * guessed): src/db/schema/visual-generation.ts, src/services/visual-
 * generation.ts, src/providers/visual-generation/{types,mock,registry}.ts,
 * and the Step-14 section of src/services/generation-jobs.ts. Every import
 * above this block is REAL and read directly from those files — nothing
 * here is speculative.
 *
 * Architecture (JOB-level lease, not per-task): claimNextVisualGenerationJob
 * mirrors claimNextStoryboardJob exactly. runVisualGenerationOnce(workerId,
 * clock, dependencies) claims ONE job, iterates every
 * manifest.visualTasks entry, calls dependencies.submitScene(task) for a
 * PENDING row and dependencies.pollScene({providerCode,
 * providerOperationId, task}) for a SUBMITTED/PROCESSING one, persists each
 * result, then decides ONE outcome: WAITING (self-loop, no budget spent),
 * RETRY_SCHEDULED/FAILED (a real failure, budget spent), or COMPLETE
 * (GENERATING_VISUALS -> GENERATING_AUDIO under the same lease-CAS as every
 * other transition). Task rows carry NO per-task lease — the row-level
 * UNIQUE(job, manifestSnapshot, taskId) + UNIQUE(idempotencyKey) pair IS
 * the anti-duplicate-submission guard.
 *
 * dependencies.submitScene/pollScene are the ONE open seam Bravo's own
 * code comments flag as unresolved for team lead ("this module never
 * depends on [visual-generation.ts]'s existence... See the report to the
 * team lead for the exact assumption and the seam this creates"): how the
 * REAL worker wires Alpha's compile+submit+poll-in-one
 * executeVisualGenerationTask/pollVisualGenerationTask into Bravo's
 * split submit-only/poll-only shape is not yet decided in production
 * either. This file supplies its OWN custom test-double dependencies per
 * test (never a guess at prayer-generation-worker.ts's actual wiring) —
 * see red-team-visual-generation-authority.test.ts for a TEST-ONLY bridge
 * to Alpha's real executor, used where a genuine success path matters.
 * ============================================================================
 */

// NOTE: this file only needs CUSTOM test-double dependencies (counting,
// hanging, waiting, etc. — see each test below) to exercise concurrency
// and lease safety; it never needs a "real success" end-to-end path, so
// the executeVisualGenerationTask/pollVisualGenerationTask bridge lives
// in red-team-visual-generation-authority.test.ts instead, where items
// 12/13 actually need real provider output to inspect.

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `redteam visgen test passphrase ${crypto.randomUUID()}`
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
const CODE_PREFIX = `RTV_${RUN_KEY}`
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

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `rtv-${crypto.randomUUID()}@test.local`,
      preferredName: 'RTV Fixture',
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
  externalAiPolicy?:
    'NO_EXTERNAL_AI' | 'METADATA_ONLY' | 'APPROVED_TEXT_CONTEXT'
  durationHintSeconds?: number
}): Promise<{ itemId: number; versionId: number }> {
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
      title: 'Red-team visgen sacred block',
      body: `Red-team-visgen sacred block body ${crypto.randomUUID()}`,
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
  return { itemId: item.id, versionId: version.id }
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

/** Drives a job to GENERATING_VISUALS with a REAL manifest containing at
 * least one GENERATION_REQUIRED scene (CHANT + METADATA_ONLY, no library
 * visual — the exact shape Step 13's own suite proved produces one). */
async function makeGeneratingVisualsJob(): Promise<{
  jobId: number
  appointmentId: number
  manifest: GenerationManifest
}> {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_GEN_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  await makeEligibleSacred({
    themeCode: theme,
    contentType: 'CHANT',
    externalAiPolicy: 'METADATA_ONLY',
    // Deliberately under Step 13's MAX_SCENE_MS (15s) so this segment
    // never splits into multiple scenes — several tests here assert
    // exactly ONE GENERATION_REQUIRED task, and a split would (validly)
    // multiply that number, which is a different property entirely.
    durationHintSeconds: 10,
  })
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'CHANT' }),
  ])
  const userId = await makeEligibleUser()
  const reservation = await createReservation(userId, ctx, {
    serviceId,
    startsAtUtc: nextSlot(),
  })
  await confirmReservation(reservation.appointmentId, ctx)
  const job = (await jobForAppointment(reservation.appointmentId))!
  await quiesceOtherJobs(job.id)
  const prepared = await runGenerationPreparationOnce('rtv-prep', {
    now: () => new Date(),
  })
  expect(prepared.status).toBe('PREPARED')
  const planned = await runStoryboardPlanningOnce('rtv-plan', {
    now: () => new Date(),
  })
  expect(planned.status).toBe('PLANNED')
  const row = (await jobForAppointment(reservation.appointmentId))!
  expect(row.status).toBe('GENERATING_VISUALS')
  const manifestRow = (
    await getDb()
      .select()
      .from(prayerGenerationManifestSnapshots)
      .where(eq(prayerGenerationManifestSnapshots.generationJobId, job.id))
  ).at(-1)!
  const manifest = JSON.parse(manifestRow.manifestJsonText) as GenerationManifest
  expect(manifest.visualTasks.length).toBeGreaterThan(0)
  return { jobId: job.id, appointmentId: reservation.appointmentId, manifest }
}

async function visualTaskRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationVisualTasks)
    .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-redteam-visgen-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'RTV\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'RTV\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'RTV\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `RTVH_${key}`.toUpperCase(),
    name: `RTV House ${key}`,
    slug: `rtvh-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 20; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `RTVS${i}_${key}`.toUpperCase(),
      name: `RTV Service ${i} ${key}`,
      slug: `rtvs${i}-${key}`,
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
        ruleText: 'Red-team visgen synthetic rule: riverside at dawn.',
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
// Item 1: duplicate worker/provider submission
// ----------------------------------------------------------------------------

describe('red-team: duplicate submission', () => {
  it('two workers racing the same GENERATING_VISUALS job never both process it', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock: GenerationClock = { now: () => new Date() }
    const [claimA, claimB] = await Promise.all([
      claimNextVisualGenerationJob('rtv-worker-A', clock),
      claimNextVisualGenerationJob('rtv-worker-B', clock),
    ])
    const claims = [claimA, claimB].filter(
      (claim) => claim != null && claim.job.id === jobId,
    )
    // TEETH: exactly ONE winner — the row-locked claim is the SAME
    // mechanism already proven for claimNextGenerationJob/
    // claimNextStoryboardJob; this just proves it holds for Step 14 too.
    expect(claims.length).toBe(1)
  }, 240_000)

  it('two full runVisualGenerationOnce cycles never both submit the same task to the provider', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    let submitCalls = 0
    const countingDeps = (): VisualGenerationDependencies => ({
      submitScene: async (task) => {
        submitCalls += 1
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${task.taskId}`,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    const clock: GenerationClock = { now: () => new Date() }
    const [a, b] = await Promise.all([
      runVisualGenerationOnce('rtv-race-A', clock, countingDeps()),
      runVisualGenerationOnce('rtv-race-B', clock, countingDeps()),
    ])
    const outcomes = [a, b].filter(
      (o) => 'jobId' in o && o.jobId === jobId,
    )
    // TEETH: only ONE of the two racing cycles actually claimed and
    // processed this job — the other got IDLE (nothing else claimable).
    expect(outcomes.length).toBe(1)
    expect(submitCalls).toBe(1)
    expect((await visualTaskRows(jobId)).length).toBe(1)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 2: crash AFTER submit but BEFORE persistence
// ----------------------------------------------------------------------------

describe('red-team: crash after submit, before the job-level decision persists', () => {
  it('a SUBMITTED task row survives a lease-expiry recovery and is resumed, never re-submitted from scratch', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    let submitCalls = 0
    // Simulates "the provider call succeeded, but the worker crashed
    // before this cycle's job-level decision (WAIT/RETRY/COMPLETE) ever
    // ran" — the lease expires and is recovered WHILE this row is
    // already SUBMITTED.
    const crashingDeps: VisualGenerationDependencies = {
      submitScene: async (task) => {
        submitCalls += 1
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${task.taskId}`,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    }
    const first = await runVisualGenerationOnce(
      'rtv-crash',
      clock,
      crashingDeps,
    )
    // The heartbeat after the loop observes the lease is already gone.
    expect(first.status).toBe('LEASE_LOST')
    expect(submitCalls).toBe(1)
    expect((await visualTaskRows(jobId)).length).toBe(1)
    expect((await visualTaskRows(jobId))[0].status).toBe('SUBMITTED')

    expect(
      await recoverExpiredGenerationLeases(clock),
    ).toBeGreaterThanOrEqual(1)
    // Recovery schedules a bounded retry (RETRY_SCHEDULE_MINUTES[0] = 1
    // minute) — advance past it so the job is actually DUE for the next
    // claim, exactly like a real worker polling later would see.
    // attemptCount is a RUNNING total across the WHOLE job lifecycle
    // (PREPARING and STORYBOARDING each already succeeded once before
    // this job ever reached GENERATING_VISUALS), so the bounded retry
    // delay here is whichever RETRY_SCHEDULE_MINUTES bucket that total
    // lands in — not necessarily the first one. Read the ACTUAL
    // nextAttemptAt this recovery scheduled and advance exactly past
    // it, rather than assuming which bucket applies.
    const afterRecovery = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    expect(afterRecovery.nextAttemptAt).not.toBeNull()
    clock.advance(
      new Date(afterRecovery.nextAttemptAt!).getTime() -
        clock.now().getTime() +
        1_000,
    )

    // A fresh cycle resumes: the row is already SUBMITTED, so it is
    // POLLED, never re-submitted.
    let secondSubmitCalls = 0
    let pollCalls = 0
    const resumeDeps: VisualGenerationDependencies = {
      submitScene: async () => {
        secondSubmitCalls += 1
        return { status: 'SUBMITTED', providerCode: 'MOCK', providerOperationId: 'x' }
      },
      pollScene: async () => {
        pollCalls += 1
        return { status: 'PROCESSING' }
      },
    }
    const second = await runVisualGenerationOnce(
      'rtv-resume',
      clock,
      resumeDeps,
    )
    expect(second.status).toBe('WAITING')
    // TEETH: never re-submitted after recovery, and never orphaned into
    // a second row.
    expect(secondSubmitCalls).toBe(0)
    expect(pollCalls).toBe(1)
    expect((await visualTaskRows(jobId)).length).toBe(1)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 3: repeated idempotency key rejected/deduped at the DB level
// ----------------------------------------------------------------------------

describe('red-team: idempotency key uniqueness at the DB level', () => {
  it('a raw duplicate row for the same idempotencyKey (even under a different taskId) is rejected by the UNIQUE index', async () => {
    const { jobId, manifest } = await makeGeneratingVisualsJob()
    // Task rows are created lazily inside runVisualGenerationOnce's loop
    // (ensureVisualTaskRow) — seed one first with a cycle that never
    // completes, so there is a real row to attack.
    await runVisualGenerationOnce(
      'rtv-idem-seed',
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
    const existing = (await visualTaskRows(jobId))[0]
    const task = manifest.visualTasks.find((t) => t.taskId === existing.taskId)!
    let duplicateError: unknown = null
    try {
      await getDb().insert(prayerGenerationVisualTasks).values({
        generationJobId: jobId,
        manifestSnapshotId: existing.manifestSnapshotId,
        // A DIFFERENT taskId/sceneId — only the idempotencyKey collides.
        taskId: `${task.taskId}-attacker-copy`,
        sceneId: `${task.sceneId}-attacker-copy`,
        idempotencyKey: task.idempotencyKey,
        status: 'PENDING',
      })
    } catch (error) {
      duplicateError = error
    }
    expect(duplicateError).not.toBeNull()

    let duplicateIdentityError: unknown = null
    try {
      await getDb().insert(prayerGenerationVisualTasks).values({
        generationJobId: jobId,
        manifestSnapshotId: existing.manifestSnapshotId,
        taskId: task.taskId,
        sceneId: task.sceneId,
        // Same (job, manifest snapshot, taskId) identity, different key.
        idempotencyKey: 'f'.repeat(64),
        status: 'PENDING',
      })
    } catch (error) {
      duplicateIdentityError = error
    }
    expect(duplicateIdentityError).not.toBeNull()
    expect((await visualTaskRows(jobId)).length).toBe(1)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 4: stale worker result persistence
// ----------------------------------------------------------------------------

describe('red-team: a job whose lease is reclaimed mid-cycle never finalizes for the stale worker', () => {
  it('a worker whose lease is stolen while it is mid-cycle never reaches COMPLETE, and no other worker sees a duplicate finalize', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    // Simulates a concurrent process reclaiming this exact job (e.g. an
    // operator-triggered lease sweep) WHILE this worker is mid-cycle,
    // talking to the provider.
    const staleDeps: VisualGenerationDependencies = {
      submitScene: async (task) => {
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        await recoverExpiredGenerationLeases(clock)
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${task.taskId}`,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    }
    const outcome = await runVisualGenerationOnce(
      'rtv-stolen',
      clock,
      staleDeps,
    )
    // TEETH: the stale worker's final job-level decision must be
    // refused — it can never finalize (WAIT/COMPLETE/RETRY) once its
    // lease is gone.
    expect(outcome.status).toBe('LEASE_LOST')
    const job = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.status).toBe('RETRYING')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Regression (user-ratified, Bravo's task-row status-CAS fix): a zombie
// worker's late write must never clobber a NEWER worker's terminal
// result. Task-row UPDATEs previously had no status/lease predicate
// (`WHERE id = ?` only) — a worker whose heartbeat stalls, whose job
// lease is reclaimed by recoverExpiredGenerationLeases, and whose
// provider call only THEN resolves could overwrite a fresher SUCCEEDED
// with its own stale FAILED. The fix is a status CAS: every task-row
// UPDATE becomes `WHERE id = ? AND status = <status read at the start
// of that row's iteration>`. Constructed deterministically below by
// nesting a full second worker's claim+submit+poll cycle INSIDE the
// first worker's own (suspended) dependency call — no sleeps, no real
// concurrency, no timing luck.
// ----------------------------------------------------------------------------

describe('red-team: task-row status-CAS prevents a zombie worker from clobbering a newer SUCCEEDED result', () => {
  it('a late write from a reclaimed worker cannot overwrite a fresher SUCCEEDED result with a stale FAILED', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    const KNOWN_SHA = 'b'.repeat(64)
    const KNOWN_MIME = 'video/mp4'
    const KNOWN_DURATION = 5_000

    let jobAttemptCountAfterGenuineSuccess = -1

    // Worker A's submitScene is called by runVisualGenerationOnce's loop
    // AFTER it has already read this task row as PENDING. Everything
    // below happens WHILE A is still "inside" that one call — exactly
    // modeling a worker whose provider round-trip is slow enough that
    // its lease gets reclaimed and a second worker fully completes the
    // SAME task before A's own (stale) result ever comes back.
    const zombieDeps: VisualGenerationDependencies = {
      submitScene: async () => {
        // A's heartbeat stalls: reclaim the job-level lease out from
        // under it, exactly like item 4 above.
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)

        // Worker B claims the reclaimed job and drives the SAME task
        // row all the way to a genuine SUCCEEDED with KNOWN artifact
        // values — two cycles: submit, then (after the poll delay)
        // poll-to-success, exactly like the real async lifecycle.
        const afterRecovery = (
          await getDb()
            .select()
            .from(prayerGenerationJobs)
            .where(eq(prayerGenerationJobs.id, jobId))
            .limit(1)
        ).at(0)!
        expect(afterRecovery.nextAttemptAt).not.toBeNull()
        clock.advance(
          new Date(afterRecovery.nextAttemptAt!).getTime() -
            clock.now().getTime() +
            1_000,
        )
        const bSubmitOutcome = await runVisualGenerationOnce(
          'worker-B-submit',
          clock,
          {
            submitScene: async (t) => ({
              status: 'SUBMITTED',
              providerCode: 'MOCK',
              providerOperationId: `op-${t.taskId}`,
            }),
            pollScene: async () => ({ status: 'PROCESSING' }),
          },
        )
        expect(bSubmitOutcome.status).toBe('WAITING')
        clock.advance(VISUAL_TASK_POLL_DELAY_MS + 1_000)
        const bPollOutcome = await runVisualGenerationOnce(
          'worker-B-poll',
          clock,
          {
            submitScene: async (t) => ({
              status: 'SUBMITTED',
              providerCode: 'MOCK',
              providerOperationId: `op-${t.taskId}`,
            }),
            pollScene: async () => ({
              status: 'SUCCEEDED',
              artifactSha256: KNOWN_SHA,
              artifactMimeType: KNOWN_MIME,
              artifactDurationMs: KNOWN_DURATION,
              artifactStorageRef: 'worker-b-storage-ref',
            }),
          },
        )
        expect(bPollOutcome.status).toBe('COMPLETE')

        const succeededByB = (await visualTaskRows(jobId))[0]
        expect(succeededByB.status).toBe('SUCCEEDED')
        expect(succeededByB.artifactSha256).toBe(KNOWN_SHA)

        const jobAfterB = (
          await getDb()
            .select()
            .from(prayerGenerationJobs)
            .where(eq(prayerGenerationJobs.id, jobId))
            .limit(1)
        ).at(0)!
        jobAttemptCountAfterGenuineSuccess = jobAfterB.attemptCount

        // ONLY NOW does worker A's own (stale) verdict finally land.
        return {
          status: 'FAILED',
          providerCode: 'MOCK',
          errorCode: 'stale_zombie_failure',
          errorMessage: 'worker A late write after being reclaimed',
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    }

    const aOutcome = await runVisualGenerationOnce('worker-A', clock, zombieDeps)
    // A's own job-level lease was reclaimed while it was stuck — its
    // cycle can never finalize anything at the job level either (the
    // pre-existing job-level lease CAS, proven in item 4, still holds).
    expect(aOutcome.status).toBe('LEASE_LOST')

    // TEETH: the row must STILL hold B's EXACT SUCCEEDED values — none
    // of A's stale verdict in ANY field. Checked immediately after A's
    // write lands, before any further cycle could run and mask a real
    // clobber (a FAILED row resets to PENDING and gets resubmitted on
    // the next cycle, which would hide this bug behind a redundant
    // provider call and an eventual, misleadingly-green "SUCCEEDED").
    const final = (await visualTaskRows(jobId))[0]
    expect(final.status).toBe('SUCCEEDED')
    expect(final.artifactSha256).toBe(KNOWN_SHA)
    expect(final.artifactMimeType).toBe(KNOWN_MIME)
    expect(final.artifactDurationMs).toBe(KNOWN_DURATION)
    expect(final.lastErrorCode).toBeNull()
    expect(final.lastErrorMessage).toBeNull()

    // A's no-op must not corrupt job-level state either.
    const finalJob = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    expect(finalJob.attemptCount).toBe(jobAttemptCountAfterGenuineSuccess)
    expect(finalJob.status).not.toBe('FAILED')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 10: async poll WITHOUT retry-budget consumption
// ----------------------------------------------------------------------------

describe('red-team: an outstanding async poll never consumes retry budget', () => {
  it('WAITING releases the lease and schedules VISUAL_TASK_POLL_DELAY_MS later WITHOUT incrementing attemptCount', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const before = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    const t0 = new Date()
    const waitingDeps: VisualGenerationDependencies = {
      submitScene: async (task) => ({
        status: 'SUBMITTED',
        providerCode: 'MOCK',
        providerOperationId: `op-${task.taskId}`,
      }),
      pollScene: async () => ({ status: 'PROCESSING' }),
    }
    const outcome = await runVisualGenerationOnce('rtv-wait', {
      now: () => t0,
    }, waitingDeps)
    expect(outcome.status).toBe('WAITING')
    const after = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    // TEETH: attemptCount UNCHANGED — a legitimate async wait is never
    // an attempt.
    expect(after.attemptCount).toBe(before.attemptCount)
    expect(after.status).toBe('GENERATING_VISUALS')
    expect(after.leaseToken).toBeNull()
    expect(after.nextAttemptAt).not.toBeNull()
    expect(
      Math.abs(
        new Date(after.nextAttemptAt!).getTime() -
          (t0.getTime() + VISUAL_TASK_POLL_DELAY_MS),
      ),
    ).toBeLessThanOrEqual(1_000)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 11: expired lease (a real crash, not a legitimate wait) consumes budget
// ----------------------------------------------------------------------------

describe('red-team: an expired GENERATING_VISUALS lease (worker crash) consumes retry budget', () => {
  it('recovery after a genuinely expired lease increments attemptCount — distinct from item 10', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const before = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    const clock = makeFakeClock(Date.now())
    // The provider call itself "hangs" past the lease window — a real
    // crash/stall, not a legitimate async-wait release.
    const hangingDeps: VisualGenerationDependencies = {
      submitScene: async (task) => {
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${task.taskId}`,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    }
    const outcome = await runVisualGenerationOnce(
      'rtv-hang',
      clock,
      hangingDeps,
    )
    expect(outcome.status).toBe('LEASE_LOST')
    expect(
      await recoverExpiredGenerationLeases(clock),
    ).toBeGreaterThanOrEqual(1)
    const after = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    // TEETH: unlike item 10's legitimate WAIT, a crashed/expired lease
    // DOES burn an attempt.
    expect(after.attemptCount).toBe(before.attemptCount + 1)
    expect(after.status).toBe('RETRYING')
    expect(after.resumeStatus).toBe('GENERATING_VISUALS')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 16: central transition bypass
// ----------------------------------------------------------------------------

describe('red-team: every Step 14 status change goes through the central transition map', () => {
  it('GENERATING_VISUALS -> GENERATING_AUDIO is only reachable via GENERATION_TRANSITIONS', async () => {
    expect(isLegalTransition('GENERATING_VISUALS', 'GENERATING_AUDIO')).toBe(
      true,
    )
    // The self-loop (WAIT) is also a real, explicit, central-map edge —
    // never a hardcoded bypass.
    expect(isLegalTransition('GENERATING_VISUALS', 'GENERATING_VISUALS')).toBe(
      true,
    )

    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    // First cycle: submit (never completes this cycle — a task that was
    // just SUBMITTED is polled on a LATER cycle, not the same one), so
    // the job legitimately WAITs.
    const firstCycle = await runVisualGenerationOnce('rtv-bypass-seed', clock, {
      submitScene: async (task) => ({
        status: 'SUBMITTED',
        providerCode: 'MOCK',
        providerOperationId: `op-${task.taskId}`,
      }),
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(firstCycle.status).toBe('WAITING')
    clock.advance(VISUAL_TASK_POLL_DELAY_MS + 1_000)

    const original = [...GENERATION_TRANSITIONS.GENERATING_VISUALS]
    GENERATION_TRANSITIONS.GENERATING_VISUALS = original.filter(
      (status) => status !== 'GENERATING_AUDIO',
    )
    // Second cycle: the task is now SUBMITTED and due — polling it
    // SUCCEEDED drives the job all the way to the finalize decision,
    // which is where the tampered map must bite.
    const succeedingDeps: VisualGenerationDependencies = {
      submitScene: async (task) => ({
        status: 'SUBMITTED',
        providerCode: 'MOCK',
        providerOperationId: `op-${task.taskId}`,
      }),
      pollScene: async () => ({
        status: 'SUCCEEDED',
        artifactSha256: 'a'.repeat(64),
        artifactMimeType: 'video/mp4',
        artifactDurationMs: 5_000,
        artifactStorageRef: 'unused-in-this-guard-test',
      }),
    }
    // runVisualGenerationOnce wraps its whole cycle body in a catch that
    // converts ANY thrown error (including isLegalTransition's
    // GenerationJobError) into a bounded retry outcome — it never lets
    // the exception itself escape to the caller. So the observable
    // proof here is the OUTCOME/job status, not a thrown exception.
    let outcome
    try {
      outcome = await runVisualGenerationOnce('rtv-bypass', clock, succeedingDeps)
    } finally {
      GENERATION_TRANSITIONS.GENERATING_VISUALS = original
    }
    // TEETH: with the edge removed from the CENTRAL map, the finalize
    // step must refuse — proving it consults the map at runtime rather
    // than hardcoding the transition.
    expect(outcome.status).not.toBe('COMPLETE')
    expect(outcome.status).toBe('RETRY_SCHEDULED')
    if (outcome.status === 'RETRY_SCHEDULED') {
      expect(outcome.errorCode).toBe('VISUAL_GENERATION_ERROR')
    }
    const job = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    expect(job.status).not.toBe('GENERATING_AUDIO')
  }, 240_000)
})
