import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  RESERVATION_STALE_AFTER_MS,
  GENERATION_TRANSITIONS,
  VISUAL_TASK_POLL_DELAY_MS,
  claimNextVisualGenerationJob,
  isLegalTransition,
  PROVIDER_OUTCOME_UNKNOWN,
  adminRetryGenerationJob,
  recoverExpiredGenerationLeases,
  runGenerationPreparationOnce,
  runVisualGenerationOnce,
} from '@/services/generation-jobs'
import { submitScene } from '@/services/visual-generation'
import { createKlingVisualGenerationProvider } from '@/providers/visual-generation/kling'
import {
  resetVisualGenerationProviderForTests,
  setVisualGenerationProviderForTests,
} from '@/providers/visual-generation/registry'
import type { KlingVisualConfig } from '@/providers/visual-generation/kling'
import { VisualGenerationProviderError } from '@/providers/visual-generation/types'
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
  VisualTaskPollResult,
} from '@/services/generation-jobs'
import type {
  GenerationManifest,
  ManifestVisualTask,
} from '@/services/generation-storyboards'
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

/** Same fixture with TWO GENERATION_REQUIRED tasks — the only way to
 * prove "a worker that lost its lease starts NO FURTHER provider
 * action", which needs a second task the loop must refuse to touch. */
async function makeTwoTaskGeneratingVisualsJob(): Promise<{
  jobId: number
  appointmentId: number
  manifest: GenerationManifest
}> {
  const serviceId = nextService()
  const themeA = `${CODE_PREFIX}_G2A_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  const themeB = `${CODE_PREFIX}_G2B_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  await makeEligibleSacred({
    themeCode: themeA,
    contentType: 'CHANT',
    externalAiPolicy: 'METADATA_ONLY',
    durationHintSeconds: 10,
  })
  await makeEligibleSacred({
    themeCode: themeB,
    contentType: 'PRAYER',
    externalAiPolicy: 'METADATA_ONLY',
    durationHintSeconds: 10,
  })
  await makeServiceTemplate(serviceId, [
    filterSlot({
      slotKey: 'MAIN_PRAYER',
      position: 1,
      themeCode: themeA,
      contentType: 'CHANT',
    }),
    filterSlot({
      slotKey: 'CLOSING_PRAYER',
      position: 2,
      themeCode: themeB,
      contentType: 'PRAYER',
    }),
  ])
  const userId = await makeEligibleUser()
  const reservation = await createReservation(userId, ctx, {
    serviceId,
    startsAtUtc: nextSlot(),
  })
  await confirmReservation(reservation.appointmentId, ctx)
  const job = (await jobForAppointment(reservation.appointmentId))!
  await quiesceOtherJobs(job.id)
  expect(
    (await runGenerationPreparationOnce('rtv-prep2', { now: () => new Date() }))
      .status,
  ).toBe('PREPARED')
  expect(
    (await runStoryboardPlanningOnce('rtv-plan2', { now: () => new Date() }))
      .status,
  ).toBe('PLANNED')
  const manifestRow = (
    await getDb()
      .select()
      .from(prayerGenerationManifestSnapshots)
      .where(eq(prayerGenerationManifestSnapshots.generationJobId, job.id))
  ).at(-1)!
  const manifest = JSON.parse(manifestRow.manifestJsonText) as GenerationManifest
  // Loud, not lenient: the whole point of this fixture is >1 task.
  expect(manifest.visualTasks.length).toBeGreaterThanOrEqual(2)
  return { jobId: job.id, appointmentId: reservation.appointmentId, manifest }
}

async function visualTaskRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationVisualTasks)
    .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
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

type SucceededPoll = Extract<VisualTaskPollResult, { status: 'SUCCEEDED' }>

/**
 * Stores REAL bytes in this suite's private media root and returns the
 * exact SUCCEEDED shape a genuine poll produces.
 *
 * Finalization re-reads the stored object and recomputes its hash, so a
 * test double that invents a storage ref no longer models a successful
 * generation at all — it models a MISSING artifact. Every "this path
 * succeeds" test therefore stores truthful bytes; the tests that prove
 * the gate bites deliberately break exactly one of those properties.
 */
async function storeRealArtifact(task: ManifestVisualTask): Promise<SucceededPoll> {
  const bytes = new TextEncoder().encode(
    `rtv-visual-artifact-${crypto.randomUUID()}`,
  )
  const { storageKey } = await storage.put(bytes, 'mp4')
  return {
    status: 'SUCCEEDED',
    artifactSha256: computeFileSha256(bytes),
    artifactMimeType: 'video/mp4',
    artifactDurationMs: task.durationMs,
    artifactStorageRef: storageKey,
  }
}

const submitOnlyDeps: VisualGenerationDependencies = {
  submitScene: async (task) => ({
    status: 'SUBMITTED',
    providerCode: 'MOCK',
    providerOperationId: `op-${task.taskId}`,
  }),
  pollScene: async () => ({ status: 'PROCESSING' }),
}

function neverCalledDeps(spy: {
  submitCalls: number
  pollCalls: number
}): VisualGenerationDependencies {
  return {
    submitScene: async () => {
      spy.submitCalls += 1
      throw new Error('provider must not be called in this test')
    },
    pollScene: async () => {
      spy.pollCalls += 1
      throw new Error('provider must not be called in this test')
    },
  }
}

/** Writes ONE task row straight to SUCCEEDED with the artifact claim
 * given. The next cycle then has nothing to submit or poll and goes
 * DIRECTLY to the finalization gate — the only way to exercise that gate
 * in isolation, with the provider provably untouched. */
async function forceTaskSucceeded(
  jobId: number,
  claim: {
    artifactSha256: string | null
    artifactMimeType: string | null
    artifactDurationMs: number | null
    artifactStorageRef: string | null
  },
): Promise<void> {
  await getDb()
    .update(prayerGenerationVisualTasks)
    .set({
      status: 'SUCCEEDED',
      artifactSha256: claim.artifactSha256,
      artifactMimeType: claim.artifactMimeType,
      artifactDurationMs: claim.artifactDurationMs,
      artifactStorageRef: claim.artifactStorageRef,
      nextPollAt: null,
      completedAt: new Date(),
    })
    .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
}

/** Seeds ONE job whose single task row is SUCCEEDED with `claim`, then
 * runs the finalize-only cycle and returns its outcome plus the job row.
 * Shared by every finalization-integrity case below so each test differs
 * ONLY in the artifact claim under test. */
async function runFinalizeOnlyCycle(
  label: string,
  buildClaim: (task: ManifestVisualTask) => Promise<{
    artifactSha256: string | null
    artifactMimeType: string | null
    artifactDurationMs: number | null
    artifactStorageRef: string | null
  }>,
  mutate?: (jobId: number, manifest: GenerationManifest) => Promise<void>,
) {
  const { jobId, manifest } = await makeGeneratingVisualsJob()
  const task = manifest.visualTasks[0]
  const clock = makeFakeClock(Date.now())
  const seeded = await runVisualGenerationOnce(
    `${label}-seed`,
    clock,
    submitOnlyDeps,
  )
  expect(seeded.status).toBe('WAITING')
  await forceTaskSucceeded(jobId, await buildClaim(task))
  if (mutate) await mutate(jobId, manifest)
  clock.advance(VISUAL_TASK_POLL_DELAY_MS + 60_000)
  const spy = { submitCalls: 0, pollCalls: 0 }
  const outcome = await runVisualGenerationOnce(
    `${label}-final`,
    clock,
    neverCalledDeps(spy),
  )
  // The finalize-only cycle must never call the provider: a terminal
  // SUCCEEDED row is not re-submitted or re-polled.
  expect(spy.submitCalls).toBe(0)
  expect(spy.pollCalls).toBe(0)
  return { jobId, manifest, task, outcome, job: await jobRow(jobId) }
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
  for (let i = 0; i < 44; i += 1) {
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
  it('a reclaimed worker NEVER submits a second time, and a stale reservation is quarantined', async () => {
    // THIS TEST REPLACES AN OBSOLETE ONE. Its predecessor asserted
    // that worker B should RESUBMIT a task whose first worker lost its
    // lease mid-call. Against a real paid provider that is a second
    // charge for one scene, so the contract is now stronger:
    //
    //   A reserves and enters the provider call.
    //   A loses the job lease.
    //   B reclaims the job.
    //     - while the reservation is FRESH, B submits NOTHING.
    //     - once it is genuinely STALE, B quarantines it and still
    //       submits NOTHING.
    //   A late response can neither resurrect nor overwrite it.
    //
    // Both original safety properties are preserved: stale workers
    // cannot overwrite newer truth, AND a reclaimed worker cannot
    // cause duplicate spend.
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())

    let submitCalls = 0
    let bSubmitCallsWhileFresh = 0
    let bSubmitCallsWhenStale = 0

    const zombieDeps: VisualGenerationDependencies = {
      submitScene: async () => {
        submitCalls += 1
        // A's heartbeat stalls: its job lease is reclaimed out from
        // under it while it waits on the provider.
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)

        // --- B, while the reservation is still FRESH ---------------
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
        const bFresh = await runVisualGenerationOnce(
          'worker-B-fresh',
          clock,
          {
            submitScene: async () => {
              bSubmitCallsWhileFresh += 1
              throw new Error(
                'worker B must not submit while a reservation is live',
              )
            },
            pollScene: async () => ({ status: 'PROCESSING' }),
          },
        )
        // TEETH: B waits. It does not submit, and it does not
        // quarantine a reservation that may still be in flight.
        expect(bFresh.status).toBe('WAITING')
        expect(bSubmitCallsWhileFresh).toBe(0)
        const stillReserved = (await visualTaskRows(jobId))[0]
        expect(stillReserved.status).toBe('SUBMITTED')
        expect(stillReserved.providerOperationId).toBeNull()

        // --- B, once the reservation is genuinely STALE ------------
        clock.advance(RESERVATION_STALE_AFTER_MS + 60_000)
        await recoverExpiredGenerationLeases(clock)
        const staleJob = (
          await getDb()
            .select()
            .from(prayerGenerationJobs)
            .where(eq(prayerGenerationJobs.id, jobId))
            .limit(1)
        ).at(0)!
        if (staleJob.nextAttemptAt != null) {
          clock.advance(
            new Date(staleJob.nextAttemptAt).getTime() -
              clock.now().getTime() +
              1_000,
          )
        }
        const bStale = await runVisualGenerationOnce(
          'worker-B-stale',
          clock,
          {
            submitScene: async () => {
              bSubmitCallsWhenStale += 1
              throw new Error('worker B must never resubmit')
            },
            pollScene: async () => ({ status: 'PROCESSING' }),
          },
        )
        // TEETH: the job fails CLOSED on an unknown outcome, and B
        // still never crossed the provider boundary.
        expect(bStale.status).toBe('FAILED')
        expect(bSubmitCallsWhenStale).toBe(0)
        const quarantined = (await visualTaskRows(jobId))[0]
        expect(quarantined.status).toBe('CANCELLED')
        expect(quarantined.lastErrorCode).toBe('provider_outcome_unknown')

        // ONLY NOW does A's own late verdict come back.
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
    expect(aOutcome.status).toBe('LEASE_LOST')

    // TEETH: A's late FAILED cannot replace the quarantine, and the
    // whole episode cost exactly ONE provider submission.
    const final = (await visualTaskRows(jobId))[0]
    expect(final.status).toBe('CANCELLED')
    expect(final.lastErrorCode).toBe('provider_outcome_unknown')
    expect(submitCalls).toBe(1)

    // And the job is terminally FAILED with the bounded stage code —
    // never scheduled for an automatic retry that would re-spend.
    const finalJob = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    expect(finalJob.status).toBe('FAILED')
    expect(finalJob.lastErrorCode).toBe('VISUAL_PROVIDER_OUTCOME_UNKNOWN')
    expect(finalJob.nextAttemptAt).toBeNull()
  }, 240_000)

  it('a durably recorded operation id is POLLED by the next worker, never resubmitted', async () => {
    // The other half of the contract: when the operation id DID land
    // before the lease was lost, the work is recoverable — a later
    // worker continues that exact operation instead of paying again.
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    let submitCalls = 0
    const first = await runVisualGenerationOnce(`w1`, clock, {
      submitScene: async (t) => {
        submitCalls += 1
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${t.taskId}`,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(first.status).toBe('WAITING')
    expect(submitCalls).toBe(1)

    // Lose the lease and let a different worker take over, well past
    // the staleness threshold.
    clock.advance(RESERVATION_STALE_AFTER_MS + 60_000)
    await recoverExpiredGenerationLeases(clock)
    const resumed = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    if (resumed.nextAttemptAt != null) {
      clock.advance(
        new Date(resumed.nextAttemptAt).getTime() - clock.now().getTime() + 1_000,
      )
    }

    let polledOperationId: string | null = null
    const second = await runVisualGenerationOnce(`w2`, clock, {
      submitScene: async () => {
        submitCalls += 1
        throw new Error('a known operation must be polled, never resubmitted')
      },
      pollScene: async (input) => {
        polledOperationId = input.providerOperationId
        return { status: 'PROCESSING' }
      },
    })
    expect(second.status).toBe('WAITING')
    // TEETH: the SAME operation, and still exactly one submission.
    expect(polledOperationId).toMatch(/^op-/)
    expect(submitCalls).toBe(1)
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

    const { jobId, manifest } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    // A GENUINE artifact (real stored bytes, real hash): the tampered
    // transition map must be what blocks this job, so every OTHER gate
    // — including finalization's storage re-verification — has to be
    // legitimately satisfiable first.
    const artifact = await storeRealArtifact(manifest.visualTasks[0])
    // First cycle: submit (never completes this cycle — a task that was
    // just SUBMITTED is polled on a LATER cycle, not the same one), so
    // the job legitimately WAITs.
    const firstCycle = await runVisualGenerationOnce(
      'rtv-bypass-seed',
      clock,
      submitOnlyDeps,
    )
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
      pollScene: async () => artifact,
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

// ----------------------------------------------------------------------------
// Step 14 hardening item 1: artifact finalization integrity
//
// A SUCCEEDED task row is a CLAIM, not proof. Before
// GENERATING_VISUALS -> GENERATING_AUDIO, every claim is re-proved
// against PRIVATE STORAGE (the object exists, the bytes are non-empty,
// their fresh SHA-256 matches the recorded hash, the mime is still
// allowlisted, the duration still fits the manifest task) and the set of
// rows is proved to be EXACTLY manifest.visualTasks.
//
// Each case below drives the SAME finalize-only cycle (task row already
// terminal, provider provably untouched) and differs ONLY in the one
// property it breaks — so a green result can never come from the gate
// being skipped, and the first case proves the gate is passable at all.
// ----------------------------------------------------------------------------

describe('red-team: finalization verifies artifacts against private storage', () => {
  it('a truthful stored artifact DOES finalize to GENERATING_AUDIO (control)', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-ok',
      async (task) => await storeRealArtifact(task),
    )
    expect(outcome.status).toBe('COMPLETE')
    expect(job.status).toBe('GENERATING_AUDIO')
  }, 240_000)

  it('a SUCCEEDED row whose stored object is GONE never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-missing',
      async (task) => {
        const artifact = await storeRealArtifact(task)
        // Everything the row records is well-formed — the object behind
        // it simply is not there any more. Metadata alone would happily
        // call this a success.
        await storage.remove(artifact.artifactStorageRef)
        expect(await storage.exists(artifact.artifactStorageRef)).toBe(false)
        return artifact
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.lastErrorCode).toBe('VISUAL_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('artifact_missing_from_storage')
  }, 240_000)

  it('a SUCCEEDED row whose stored BYTES were tampered with never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-tamper',
      async (task) => {
        const artifact = await storeRealArtifact(task)
        // The object still exists and the row still carries the hash of
        // the ORIGINAL bytes — only the bytes on disk changed. Only a
        // fresh recomputation from the stored object catches this.
        writeFileSync(
          join(storageRoot, artifact.artifactStorageRef),
          Buffer.from('tampered-artifact-bytes-not-the-generated-ones'),
        )
        return artifact
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.lastErrorCode).toBe('VISUAL_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('artifact_hash_mismatch')
  }, 240_000)

  it('a SUCCEEDED row with NO storage reference never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-noref',
      async (task) => ({
        ...(await storeRealArtifact(task)),
        // Real bytes exist somewhere; this row just does not say where.
        // An unreferenceable artifact is not a finalizable result.
        artifactStorageRef: null,
      }),
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.lastErrorCode).toBe('VISUAL_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('artifact_storage_ref_invalid')
  }, 240_000)

  it('a SUCCEEDED row whose stored bytes are EMPTY never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-empty',
      async (task) => {
        const artifact = await storeRealArtifact(task)
        writeFileSync(
          join(storageRoot, artifact.artifactStorageRef),
          Buffer.alloc(0),
        )
        return artifact
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.lastErrorCode).toBe('VISUAL_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('artifact_missing_from_storage')
  }, 240_000)

  it('a SUCCEEDED row whose duration does not fit its manifest task never advances', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-duration',
      async (task) => ({
        ...(await storeRealArtifact(task)),
        // Inside the global scene ceiling, but nowhere near the length
        // THIS scene asked for — an artifact for a different scene.
        artifactDurationMs: Math.max(1, task.durationMs - 5_000),
      }),
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.lastErrorCode).toBe('VISUAL_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('artifact_duration_mismatch')
  }, 240_000)
})

describe('red-team: finalization requires the task rows to BE the manifest tasks', () => {
  it('an EXTRA task row for the same job blocks finalization', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-extra',
      async (task) => await storeRealArtifact(task),
      async (jobId) => {
        const existing = (await visualTaskRows(jobId))[0]
        // A row nobody planned: a leftover from a superseded manifest, a
        // hand-inserted row, a bug. Its ARTIFACT is irrelevant — its
        // existence alone means the rows are no longer the manifest.
        await getDb()
          .insert(prayerGenerationVisualTasks)
          .values({
            generationJobId: jobId,
            manifestSnapshotId: existing.manifestSnapshotId,
            taskId: `${existing.taskId}-EXTRA`,
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
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.lastErrorCode).toBe('VISUAL_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('task_count_mismatch')
  }, 240_000)

  it('a task row re-pointed at a DIFFERENT task id blocks finalization', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-identity',
      async (task) => await storeRealArtifact(task),
      async (jobId) => {
        // Right count, right task id, valid artifact — but bound to a
        // scene the manifest never assigned it to. The task-row lookup
        // the submit/poll loop uses (task id only) sails straight past
        // this; only the finalization gate compares the FULL binding.
        await getDb()
          .update(prayerGenerationVisualTasks)
          .set({ sceneId: 'NOT-A-MANIFEST-SCENE' })
          .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.lastErrorCode).toBe('VISUAL_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('task_scene_mismatch')
  }, 240_000)

  it('a task row whose idempotency key is not the manifest key blocks finalization', async () => {
    const { outcome, job } = await runFinalizeOnlyCycle(
      'rtv-fin-idem',
      async (task) => await storeRealArtifact(task),
      async (jobId) => {
        // The idempotency key IS the anti-duplicate-submission identity.
        // A row carrying a different one cannot be proved to be the
        // single submission this manifest task authorized.
        await getDb()
          .update(prayerGenerationVisualTasks)
          .set({ idempotencyKey: crypto.randomUUID().replace(/-/g, '').repeat(2) })
          .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
      },
    )
    expect(outcome.status).not.toBe('COMPLETE')
    expect(job.status).not.toBe('GENERATING_AUDIO')
    expect(job.lastErrorCode).toBe('VISUAL_RESULT_INTEGRITY_FAILURE')
    expect(job.lastErrorMessage).toBe('task_idempotency_mismatch')
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 14 hardening item 2: orphan artifact cleanup + lease-fenced provider
// actions
// ----------------------------------------------------------------------------

describe('red-team: a poll result that loses its CAS never leaves its artifact behind', () => {
  it('a losing SUCCEEDED poll removes the artifact it just stored and keeps the winner intact', async () => {
    const { jobId, manifest } = await makeGeneratingVisualsJob()
    const task = manifest.visualTasks[0]
    const clock = makeFakeClock(Date.now())
    expect(
      (await runVisualGenerationOnce('rtv-orphan-seed', clock, submitOnlyDeps))
        .status,
    ).toBe('WAITING')
    clock.advance(VISUAL_TASK_POLL_DELAY_MS + 60_000)

    // Two genuine artifacts: the one another worker's result references
    // (the winner) and the one THIS cycle stores before discovering it
    // lost the race (the loser).
    const winner = await storeRealArtifact(task)
    const loser = await storeRealArtifact(task)
    expect(loser.artifactStorageRef).not.toBe(winner.artifactStorageRef)

    const outcome = await runVisualGenerationOnce('rtv-orphan', clock, {
      submitScene: async () => {
        throw new Error('no submit expected in this cycle')
      },
      pollScene: async () => {
        // WHILE our poll is in flight, another worker resolves the row.
        // Our lease is untouched — this is purely a lost row-status CAS,
        // so the cleanup under test cannot be confused with the
        // lease-loss path.
        await getDb()
          .update(prayerGenerationVisualTasks)
          .set({
            status: 'SUCCEEDED',
            artifactSha256: winner.artifactSha256,
            artifactMimeType: winner.artifactMimeType,
            artifactDurationMs: winner.artifactDurationMs,
            artifactStorageRef: winner.artifactStorageRef,
            nextPollAt: null,
            completedAt: new Date(),
          })
          .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
        return loser
      },
    })

    // Our verdict was discarded, so the cycle simply waits.
    expect(outcome.status).toBe('WAITING')
    const row = (await visualTaskRows(jobId))[0]
    // TEETH 1: the newer result is untouched, in every field.
    expect(row.status).toBe('SUCCEEDED')
    expect(row.artifactSha256).toBe(winner.artifactSha256)
    expect(row.artifactStorageRef).toBe(winner.artifactStorageRef)
    // TEETH 2: our unreferenced artifact is GONE from private storage —
    // a stale worker never leaves generated bytes lying around.
    expect(await storage.exists(loser.artifactStorageRef)).toBe(false)
    // TEETH 3: cleanup removed OUR key only, never the referenced one.
    expect(await storage.exists(winner.artifactStorageRef)).toBe(true)
  }, 240_000)

  it('a late poll SUCCEEDED cannot clobber a newer FAILED row', async () => {
    const { jobId, manifest } = await makeGeneratingVisualsJob()
    const task = manifest.visualTasks[0]
    const clock = makeFakeClock(Date.now())
    expect(
      (
        await runVisualGenerationOnce(
          'rtv-late-succ-seed',
          clock,
          submitOnlyDeps,
        )
      ).status,
    ).toBe('WAITING')
    clock.advance(VISUAL_TASK_POLL_DELAY_MS + 60_000)
    const late = await storeRealArtifact(task)

    const outcome = await runVisualGenerationOnce('rtv-late-succ', clock, {
      submitScene: async () => {
        throw new Error('no submit expected in this cycle')
      },
      pollScene: async () => {
        await getDb()
          .update(prayerGenerationVisualTasks)
          .set({
            status: 'FAILED',
            lastErrorCode: 'other_worker_verdict',
            lastErrorMessage: 'recorded by the worker that owns this row',
            completedAt: new Date(),
          })
          .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
        return late
      },
    })

    const row = (await visualTaskRows(jobId))[0]
    // TEETH: a SUCCEEDED verdict is not privileged — it loses the CAS
    // exactly like a FAILED one, and writes NOTHING into the row.
    expect(row.status).toBe('FAILED')
    expect(row.lastErrorCode).toBe('other_worker_verdict')
    expect(row.artifactSha256).toBeNull()
    expect(row.artifactStorageRef).toBeNull()
    expect(await storage.exists(late.artifactStorageRef)).toBe(false)
    expect(outcome.status).not.toBe('COMPLETE')
    expect((await jobRow(jobId)).status).not.toBe('GENERATING_AUDIO')
  }, 240_000)

  it('a late poll FAILED cannot clobber a newer SUCCEEDED row', async () => {
    const { jobId, manifest } = await makeGeneratingVisualsJob()
    const task = manifest.visualTasks[0]
    const clock = makeFakeClock(Date.now())
    expect(
      (
        await runVisualGenerationOnce(
          'rtv-late-fail-seed',
          clock,
          submitOnlyDeps,
        )
      ).status,
    ).toBe('WAITING')
    clock.advance(VISUAL_TASK_POLL_DELAY_MS + 60_000)
    const winner = await storeRealArtifact(task)

    const outcome = await runVisualGenerationOnce('rtv-late-fail', clock, {
      submitScene: async () => {
        throw new Error('no submit expected in this cycle')
      },
      pollScene: async () => {
        await getDb()
          .update(prayerGenerationVisualTasks)
          .set({
            status: 'SUCCEEDED',
            artifactSha256: winner.artifactSha256,
            artifactMimeType: winner.artifactMimeType,
            artifactDurationMs: winner.artifactDurationMs,
            artifactStorageRef: winner.artifactStorageRef,
            nextPollAt: null,
            completedAt: new Date(),
          })
          .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
        return {
          status: 'FAILED',
          errorCode: 'stale_late_poll_failure',
          errorMessage: 'a verdict from a cycle that no longer owns this row',
        }
      },
    })

    const row = (await visualTaskRows(jobId))[0]
    // TEETH: the genuine result survives in EVERY field, and the stale
    // failure is nowhere in the row.
    expect(row.status).toBe('SUCCEEDED')
    expect(row.artifactSha256).toBe(winner.artifactSha256)
    expect(row.artifactStorageRef).toBe(winner.artifactStorageRef)
    expect(row.lastErrorCode).toBeNull()
    expect(row.lastErrorMessage).toBeNull()
    expect(await storage.exists(winner.artifactStorageRef)).toBe(true)
    // A discarded verdict is not a job failure.
    expect(outcome.status).not.toBe('FAILED')
    expect((await jobRow(jobId)).status).not.toBe('FAILED')
  }, 240_000)
})

describe('red-team: a worker that has lost its lease starts no further provider action', () => {
  it('losing the lease during the first task means ZERO further submits or polls', async () => {
    const { jobId, manifest } = await makeTwoTaskGeneratingVisualsJob()
    expect(manifest.visualTasks.length).toBeGreaterThanOrEqual(2)
    const clock = makeFakeClock(Date.now())
    let submitCalls = 0
    let pollCalls = 0

    const outcome = await runVisualGenerationOnce('rtv-fence', clock, {
      submitScene: async (task) => {
        submitCalls += 1
        // The FIRST provider call stalls past the lease window and the
        // job is recovered out from under this worker — exactly a
        // crashed/hung worker whose lease expires mid-cycle.
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${task.taskId}`,
        }
      },
      pollScene: async () => {
        pollCalls += 1
        return { status: 'PROCESSING' }
      },
    })

    expect(outcome.status).toBe('LEASE_LOST')
    // TEETH 1: exactly ONE provider call — the loop stopped at the
    // heartbeat instead of walking on to the second task.
    expect(submitCalls).toBe(1)
    expect(pollCalls).toBe(0)
    const rows = await visualTaskRows(jobId)
    // TEETH 2: the second task was never even reached — its row does not
    // exist at all, because ensureVisualTaskRow runs at the top of the
    // loop body this worker refused to enter again.
    expect(rows.length).toBe(1)
    // The FIRST task's provider truth IS still recorded: that operation
    // really was submitted, and losing the lease does not un-submit it.
    // The fence is about starting nothing FURTHER, not about discarding
    // a provider fact the next worker needs in order to resume rather
    // than re-submit.
    expect(rows[0].status).toBe('SUBMITTED')
    expect(rows[0].providerOperationId).not.toBeNull()
  }, 240_000)

  it('losing the lease during a POLL discards that poll and its artifact, and polls nothing else', async () => {
    const { jobId, manifest } = await makeTwoTaskGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runVisualGenerationOnce('rtv-pfence-seed', clock, submitOnlyDeps))
        .status,
    ).toBe('WAITING')
    clock.advance(VISUAL_TASK_POLL_DELAY_MS + 60_000)
    // The bytes the stalled poll "produced" — already in private storage
    // by the time the executor hands the result back, exactly like a
    // real SUCCEEDED poll.
    const stranded = await storeRealArtifact(manifest.visualTasks[0])
    let pollCalls = 0

    const outcome = await runVisualGenerationOnce('rtv-pfence', clock, {
      submitScene: async () => {
        throw new Error('no submit expected in this cycle')
      },
      pollScene: async () => {
        pollCalls += 1
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
        return stranded
      },
    })

    expect(outcome.status).toBe('LEASE_LOST')
    // TEETH 1: the second task was never polled.
    expect(pollCalls).toBe(1)
    // TEETH 2: the result was NOT accepted onto a lease we no longer
    // hold — the row is untouched and still resumable by whoever
    // recovers the job.
    const rows = await visualTaskRows(jobId)
    for (const row of rows) {
      expect(row.status).toBe('SUBMITTED')
      expect(row.artifactSha256).toBeNull()
      expect(row.artifactStorageRef).toBeNull()
    }
    // TEETH 3: and the bytes that result had already written are gone —
    // no row references them and none ever will.
    expect(await storage.exists(stranded.artifactStorageRef)).toBe(false)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 20 follow-up: spend classification, reservation persistence and the
// admin gate — every property proven against the DATABASE, not source text.
// ----------------------------------------------------------------------------

describe('red-team: spend classification decides retry or quarantine', () => {
  it('a NOT_SENT refusal lands on the RESERVED row and is retryable', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    const first = await runVisualGenerationOnce('w-ns-1', clock, {
      submitScene: async () => {
        submits += 1
        return {
          status: 'FAILED',
          providerCode: 'MOCK',
          errorCode: 'synthetic_pre_network_refusal',
          errorMessage: null,
          spendState: 'NOT_SENT',
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    // A refusal proved free of spend is a KNOWN failure: budgeted
    // retry, not quarantine.
    expect(first.status).toBe('RETRY_SCHEDULED')
    const afterFirst = (await visualTaskRows(jobId))[0]
    // TEETH for the CAS itself. The row was SUBMITTED (reserved) when
    // this refusal came back; the first implementation CASed on
    // PENDING, which could never match, so the refusal never landed.
    // These assertions are about the DATABASE having changed.
    expect(afterFirst.status).toBe('FAILED')
    expect(afterFirst.submittedAt).toBeNull()
    expect(afterFirst.providerOperationId).toBeNull()
    expect(afterFirst.lastErrorCode).toBe('synthetic_pre_network_refusal')

    const job = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    expect(job.status).toBe('RETRYING')
    clock.advance(
      new Date(job.nextAttemptAt!).getTime() - clock.now().getTime() + 1_000,
    )
    const second = await runVisualGenerationOnce('w-ns-2', clock, {
      submitScene: async (t) => {
        submits += 1
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${t.taskId}`,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(second.status).toBe('WAITING')
    expect(submits).toBe(2)
    const afterSecond = (await visualTaskRows(jobId))[0]
    expect(afterSecond.status).toBe('SUBMITTED')
    expect(afterSecond.providerOperationId).toMatch(/^op-/)
  }, 240_000)

  it('an UNKNOWN failure quarantines the task and can NEVER take the retry path', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    const outcome = await runVisualGenerationOnce('w-unk-1', clock, {
      submitScene: async () => {
        submits += 1
        // NO spendState: an adapter that does not say is treated as
        // UNKNOWN — absence must never authorise a second charge.
        return {
          status: 'FAILED',
          providerCode: 'MOCK',
          errorCode: 'ambiguous_transport_failure',
          errorMessage: null,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') {
      expect(outcome.errorCode).toBe('VISUAL_PROVIDER_OUTCOME_UNKNOWN')
    }
    const row = (await visualTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    // The submission evidence is RETAINED — precisely what bars the
    // NOT_SENT retry path forever.
    expect(row.submittedAt).not.toBeNull()
    const job = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    expect(job.status).toBe('FAILED')
    expect(job.lastErrorCode).toBe('VISUAL_PROVIDER_OUTCOME_UNKNOWN')
    expect(job.nextAttemptAt).toBeNull()
    // And nothing ever submits again: the job is terminal.
    const again = await runVisualGenerationOnce('w-unk-2', clock, {
      submitScene: async () => {
        submits += 1
        throw new Error('a quarantined job must never resubmit')
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(again.status).toBe('IDLE')
    expect(submits).toBe(1)
  }, 240_000)

  it('an answer naming a DIFFERENT provider is quarantined, never polled', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    const outcome = await runVisualGenerationOnce('w-impostor', clock, {
      submitScene: async () => ({
        status: 'SUBMITTED',
        providerCode: 'IMPOSTOR',
        providerOperationId: 'op-under-the-wrong-roof',
      }),
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(outcome.status).toBe('FAILED')
    const row = (await visualTaskRows(jobId))[0]
    // External contact may already have happened, under an identity
    // nothing downstream can vouch for — so the operation is never
    // recorded, never polled under the other provider, never retried.
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    expect(row.providerOperationId).toBeNull()
    expect(row.providerCode).toBe('MOCK')
  }, 240_000)

  it('an unusable operation id after provider contact is quarantined', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    const outcome = await runVisualGenerationOnce('w-blank-op', clock, {
      submitScene: async () => ({
        status: 'SUBMITTED',
        providerCode: 'MOCK',
        // Whitespace-only: empty after trimming, unusable forever.
        providerOperationId: '   ',
      }),
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(outcome.status).toBe('FAILED')
    const row = (await visualTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    expect(row.providerOperationId).toBeNull()
  }, 240_000)

  it('the reservation hands the reserved provider to the submission seam', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    let seen: string | undefined
    const outcome = await runVisualGenerationOnce('w-seam', clock, {
      submitScene: async (t, options) => {
        seen = options?.expectedProviderCode
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${t.taskId}`,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(outcome.status).toBe('WAITING')
    // The seam receives the code recorded in the durable reservation,
    // so the check happens immediately before invocation — not only
    // in outer registry reads with a gap between them.
    expect(seen).toBe('MOCK')
    void jobId
  }, 240_000)

  it('a provider-boundary failure in the real submitScene is never NOT_SENT', async () => {
    const { manifest } = await makeGeneratingVisualsJob()
    const task = manifest.visualTasks[0]
    setVisualGenerationProviderForTests({
      code: 'MOCK',
      displayName: 'throwing test provider',
      isEnabled: () => true,
      submitScene: async () => {
        throw new VisualGenerationProviderError(
          'provider_unreachable',
          'synthetic transport failure',
          true,
        )
      },
      pollScene: async () => {
        throw new VisualGenerationProviderError('unused', 'unused', false)
      },
    })
    try {
      const result = await submitScene(task, { expectedProviderCode: 'MOCK' })
      expect(result.status).toBe('FAILED')
      if (result.status !== 'FAILED') return
      expect(result.errorCode).toBe('provider_unreachable')
      // The request may have crossed the boundary before the throw —
      // the adapter must NOT claim otherwise.
      expect(result.spendState).toBeUndefined()
    } finally {
      resetVisualGenerationProviderForTests()
    }
  }, 240_000)

  it('a legacy FAILED row carrying submission evidence is normalized to quarantine', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    // Seed a genuinely submitted row, then rewrite it to the LEGACY
    // shape older code produced: FAILED, but with submission evidence.
    expect(
      (await runVisualGenerationOnce('w-legacy-seed', clock, {
        submitScene: async (t) => ({
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${t.taskId}`,
        }),
        pollScene: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('WAITING')
    await getDb()
      .update(prayerGenerationVisualTasks)
      .set({
        status: 'FAILED',
        providerOperationId: null,
        lastErrorCode: 'legacy_provider_error',
      })
      .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
    await getDb()
      .update(prayerGenerationJobs)
      .set({
        status: 'GENERATING_VISUALS',
        leaseToken: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      })
      .where(eq(prayerGenerationJobs.id, jobId))

    let submits = 0
    const outcome = await runVisualGenerationOnce('w-legacy', clock, {
      submitScene: async () => {
        submits += 1
        throw new Error('a legacy unresolved row must never resubmit')
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') {
      expect(outcome.errorCode).toBe('VISUAL_PROVIDER_OUTCOME_UNKNOWN')
    }
    expect(submits).toBe(0)
    const row = (await visualTaskRows(jobId))[0]
    // Normalized, not merely tolerated: the resettable FAILED shape is
    // gone, replaced by the terminal quarantine the whole lifecycle
    // already understands.
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
  }, 240_000)

  it('an in-seam provider SWITCH refusal — NOT_SENT under the NEW code — stays retryable', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    let submits = 0
    const first = await runVisualGenerationOnce('w-switch-1', clock, {
      submitScene: async () => {
        submits += 1
        // The seam's own selection check caught a provider switch and
        // refused BEFORE the network — reporting the NEW provider's
        // code, because that is who it honestly saw. NOT_SENT must be
        // honored BEFORE the provider-binding gate: gating first would
        // quarantine this free refusal into a dead recording.
        return {
          status: 'FAILED',
          providerCode: 'SWITCHED_MID_FLIGHT',
          errorCode: 'provider_selection_changed',
          errorMessage: null,
          spendState: 'NOT_SENT',
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(first.status).toBe('RETRY_SCHEDULED')
    const afterFirst = (await visualTaskRows(jobId))[0]
    // TEETH: retryable, not quarantined — the DATABASE says so.
    expect(afterFirst.status).toBe('FAILED')
    expect(afterFirst.submittedAt).toBeNull()
    expect(afterFirst.providerOperationId).toBeNull()
    expect(afterFirst.lastErrorCode).toBe('provider_selection_changed')

    const job = await jobRow(jobId)
    expect(job.status).toBe('RETRYING')
    clock.advance(
      new Date(job.nextAttemptAt!).getTime() - clock.now().getTime() + 1_000,
    )
    const second = await runVisualGenerationOnce('w-switch-2', clock, {
      submitScene: async (t) => {
        submits += 1
        return {
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${t.taskId}`,
        }
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    // The refusal cost nothing: the SAME task submits cleanly under
    // the provider actually reserved.
    expect(second.status).toBe('WAITING')
    expect(submits).toBe(2)
    expect((await visualTaskRows(jobId))[0].status).toBe('SUBMITTED')
  }, 240_000)

  it('a submitScene that THROWS after the reservation is quarantined, raw error dropped', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    const marker = `boom-${crypto.randomUUID()}`
    let submits = 0
    const outcome = await runVisualGenerationOnce('w-throw-1', clock, {
      submitScene: async () => {
        submits += 1
        // The reservation is durable and the call was in flight when
        // this escaped — the request may already have been accepted.
        throw new Error(marker)
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    // Quarantined DETERMINISTICALLY — never handed to the generic
    // error path, which would burn the budget as a retry and leave
    // the row waiting to go stale.
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') {
      expect(outcome.errorCode).toBe('VISUAL_PROVIDER_OUTCOME_UNKNOWN')
    }
    const row = (await visualTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    // Submission evidence retained — the NOT_SENT reset can never
    // touch this row.
    expect(row.submittedAt).not.toBeNull()
    // The exception itself was DROPPED, not recorded: raw provider
    // errors reach neither rows nor events.
    const events = await getDb()
      .select()
      .from(prayerGenerationJobEvents)
      .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
    expect(
      JSON.stringify({ rows: await visualTaskRows(jobId), events }),
    ).not.toContain(marker)
    const job = await jobRow(jobId)
    expect(job.status).toBe('FAILED')
    expect(job.lastErrorCode).toBe('VISUAL_PROVIDER_OUTCOME_UNKNOWN')
    expect(job.nextAttemptAt).toBeNull()
    const again = await runVisualGenerationOnce('w-throw-2', clock, {
      submitScene: async () => {
        submits += 1
        throw new Error('a quarantined job must never resubmit')
      },
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    expect(again.status).toBe('IDLE')
    expect(submits).toBe(1)
  }, 240_000)
})

describe('red-team: admin retry refuses unresolved provider spend (DB-driven)', () => {
  it('a quarantined visual task blocks the generic admin retry', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runVisualGenerationOnce('w-adm-1', clock, {
        submitScene: async () => ({
          status: 'FAILED',
          providerCode: 'MOCK',
          errorCode: 'ambiguous',
          errorMessage: null,
        }),
        pollScene: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('FAILED')
    let refused: unknown
    try {
      await adminRetryGenerationJob(adminId, ctx, jobId)
    } catch (error) {
      refused = error
    }
    expect(String((refused as Error).message)).toContain('unresolved')
    const job = (
      await getDb()
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
    ).at(0)!
    expect(job.status).toBe('FAILED')
  }, 240_000)

  it('a LEGACY failed-with-evidence row blocks it too, before normalization', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runVisualGenerationOnce('w-adm-2', clock, {
        submitScene: async (t) => ({
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          providerOperationId: `op-${t.taskId}`,
        }),
        pollScene: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('WAITING')
    // The legacy shape, still un-normalized (no worker has run), with
    // the job already FAILED — the administrator must be protected
    // even before the worker gets a chance to normalize.
    await getDb()
      .update(prayerGenerationVisualTasks)
      .set({
        status: 'FAILED',
        providerOperationId: null,
        lastErrorCode: 'legacy_provider_error',
      })
      .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
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
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    // Spend the whole budget beforehand, so the next lease recovery is
    // the LAST: the job dies with its reservation still open, and no
    // later worker cycle ever exists to normalize the row.
    const fresh = await jobRow(jobId)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ attemptCount: fresh.maxAttempts - 1 })
      .where(eq(prayerGenerationJobs.id, jobId))

    let refusedWhileStranded: unknown
    const outcome = await runVisualGenerationOnce('w-adm-strand', clock, {
      submitScene: async () => {
        // The durable reservation exists NOW. This worker "dies": its
        // lease expires and recovery — budget exhausted — fails the
        // job terminally, stranding the reservation.
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        expect(
          await recoverExpiredGenerationLeases(clock),
        ).toBeGreaterThanOrEqual(1)
        const dead = await jobRow(jobId)
        expect(dead.status).toBe('FAILED')
        expect(dead.lastErrorCode).toBe('LEASE_EXPIRED')
        expect(dead.nextAttemptAt).toBeNull()
        const stranded = (await visualTaskRows(jobId))[0]
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
      pollScene: async () => ({ status: 'PROCESSING' }),
    })
    // Refused AT THE MOMENT the row was still a bare reservation.
    expect(String((refusedWhileStranded as Error).message)).toContain(
      'unresolved',
    )
    expect(outcome.status).toBe('LEASE_LOST')
    // The dying worker's own throw then sealed the reservation, and
    // the refusal holds for the sealed shape too.
    const row = (await visualTaskRows(jobId))[0]
    expect(row.status).toBe('CANCELLED')
    expect(row.lastErrorCode).toBe(PROVIDER_OUTCOME_UNKNOWN)
    expect(row.submittedAt).not.toBeNull()
    expect((await jobRow(jobId)).status).toBe('FAILED')
    let refusedAfter: unknown
    try {
      await adminRetryGenerationJob(adminId, ctx, jobId)
    } catch (error) {
      refusedAfter = error
    }
    expect(String((refusedAfter as Error).message)).toContain('unresolved')
  }, 240_000)

  it('a KNOWN OPERATION mid-poll — SUBMITTED with an operation id — blocks it', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runVisualGenerationOnce('w-adm-op', clock, {
        submitScene: async () => ({
          status: 'SUBMITTED',
          providerCode: 'MOCK',
          // Deliberately unnormalized: interior caps and surrounding
          // whitespace, valid because it is non-empty after trimming.
          providerOperationId: '  Op-Verbatim-001  ',
        }),
        pollScene: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('WAITING')
    // BYTE-FOR-BYTE: the id was validated raw and persisted verbatim —
    // never trimmed, lowercased or otherwise "tidied" — because the
    // provider will be asked for it back exactly as issued.
    const submitted = (await visualTaskRows(jobId))[0]
    expect(submitted.providerOperationId).toBe('  Op-Verbatim-001  ')
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
    const row = (await visualTaskRows(jobId))[0]
    expect(row.status).toBe('SUBMITTED')
    expect(row.providerOperationId).toBe('  Op-Verbatim-001  ')
  }, 240_000)

  it('even a SUCCEEDED task blocks it — paid output a restart would abandon and re-buy', async () => {
    const { jobId, outcome, job } = await runFinalizeOnlyCycle(
      'w-adm-succ',
      async (task) => storeRealArtifact(task),
    )
    expect(outcome.status).toBe('COMPLETE')
    expect(job.status).toBe('GENERATING_AUDIO')
    // A LATER stage then fails the job; the visual spend is real and
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
    const row = (await visualTaskRows(jobId))[0]
    expect(row.status).toBe('SUCCEEDED')
    expect(row.submittedAt).not.toBeNull()
    let refused: unknown
    try {
      await adminRetryGenerationJob(adminId, ctx, jobId)
    } catch (error) {
      refused = error
    }
    // Restart-from-PREPARING would mint fresh task identities and buy
    // this scene a second time while abandoning the artifact already
    // paid for.
    expect(String((refused as Error).message)).toContain('unresolved')
  }, 240_000)

  it('a provably-unsent failure (submittedAt NULL) remains retryable — the control', async () => {
    const { jobId } = await makeGeneratingVisualsJob()
    const clock = makeFakeClock(Date.now())
    expect(
      (await runVisualGenerationOnce('w-adm-free', clock, {
        submitScene: async () => ({
          status: 'FAILED',
          providerCode: 'MOCK',
          errorCode: 'synthetic_pre_network_refusal',
          errorMessage: null,
          spendState: 'NOT_SENT',
        }),
        pollScene: async () => ({ status: 'PROCESSING' }),
      })).status,
    ).toBe('RETRY_SCHEDULED')
    const row = (await visualTaskRows(jobId))[0]
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
    const retried = await jobRow(jobId)
    expect(retried.status).toBe('RETRYING')
    expect(retried.resumeStatus).toBe('PREPARING')
    expect(retried.attemptCount).toBe(0)
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Step 20: Kling API 2.0 — the production text-to-video provider
// ----------------------------------------------------------------------------

/** Test doubles ONLY: zero network, zero real API, zero spend. */
const KLING_TEST_CONFIG: KlingVisualConfig = {
  apiKey: 'rt-kling-secret-key',
  baseUrl: 'https://api-singapore.klingai.com',
  artifactOrigins: ['https://cdn.kling-artifacts.test'],
}

describe('red-team: Kling through the REAL executor (fake HTTP, ZERO network)', () => {
  it('reserves, submits ONCE, persists the EXACT provider id, polls the same id, and completes with locally measured bytes', async () => {
    const { jobId, manifest } = await makeGeneratingVisualsJob()
    const task = manifest.visualTasks[0]
    // The fixture scene is a whole number of seconds inside Kling's
    // official 3–15 s window — the pipeline's own scene ceiling
    // (MAX_SCENE_MS = 15 s) matches the vendor bound exactly.
    expect(task.durationMs % 1000).toBe(0)
    expect(task.durationMs).toBeGreaterThanOrEqual(3_000)
    expect(task.durationMs).toBeLessThanOrEqual(15_000)

    const clock = makeFakeClock(Date.now())
    const mp4Bytes = new TextEncoder().encode(
      `rt-kling-mp4-${'y'.repeat(4096)}`,
    )
    const providerOperationId = 'kling-op-e2e-001'
    const artifactUrl =
      'https://cdn.kling-artifacts.test/v/e2e.mp4?sig=E2E_SECRET_SIG'
    const requests: Array<{
      method: string
      url: string
      headers: Readonly<Record<string, string>>
      body?: string
    }> = []
    const downloads: Array<string> = []
    setVisualGenerationProviderForTests(
      createKlingVisualGenerationProvider(
        KLING_TEST_CONFIG,
        {
          async requestJson(input) {
            requests.push(input)
            if (input.method === 'POST') {
              return {
                status: 200,
                bodyText: JSON.stringify({
                  code: 0,
                  data: { id: providerOperationId, status: 'submitted' },
                }),
              }
            }
            return {
              status: 200,
              bodyText: JSON.stringify({
                code: 0,
                data: [
                  {
                    id: providerOperationId,
                    status: 'succeeded',
                    outputs: [{ type: 'video', url: artifactUrl }],
                  },
                ],
              }),
            }
          },
          async downloadArtifact(input) {
            downloads.push(input.url)
            return { status: 200, contentType: 'video/mp4', bytes: mp4Bytes }
          },
        },
        // ffprobe stand-in: the LOCAL measurement is what the row gets.
        async () => ({
          ok: true,
          durationMs: task.durationMs,
          hasAudio: false,
          hasVideo: true,
        }),
      ),
    )
    try {
      // Cycle 1: durable reservation → create → WAITING. No injected
      // deps: this drives the REAL submitScene/pollScene seam.
      const first = await runVisualGenerationOnce('w-kling-1', clock)
      expect(first.status).toBe('WAITING')
      const afterSubmit = (await visualTaskRows(jobId))[0]
      expect(afterSubmit.status).toBe('SUBMITTED')
      expect(afterSubmit.providerCode).toBe('KLING')
      // The provider's OWN id, byte-for-byte — polling continues it.
      expect(afterSubmit.providerOperationId).toBe(providerOperationId)
      expect(afterSubmit.submittedAt).not.toBeNull()

      // Exactly ONE create call, carrying the exact official contract.
      expect(requests).toHaveLength(1)
      const createCall = requests[0]
      expect(createCall.method).toBe('POST')
      expect(createCall.url).toBe(
        'https://api-singapore.klingai.com/text-to-video/kling-3.0',
      )
      expect(createCall.headers.Authorization).toBe(
        `Bearer ${KLING_TEST_CONFIG.apiKey}`,
      )
      const body = JSON.parse(createCall.body!) as {
        prompt: string
        settings: Record<string, unknown>
        options: Record<string, unknown>
      }
      expect(body.settings.audio).toBe('off')
      expect(body.settings.multi_shot).toBe(false)
      expect(body.settings.duration).toBe(task.durationMs / 1000)
      expect(body.options.external_task_id).toBe(task.idempotencyKey)
      // METADATA_ONLY: the compiled prompt carries the approved rule
      // text and safe metadata — never a sacred body.
      expect(body.prompt).toContain('riverside at dawn')

      // Cycle 2: poll the SAME operation, download from the allowlisted
      // origin, measure locally, store, finalize.
      clock.advance(VISUAL_TASK_POLL_DELAY_MS + 60_000)
      const second = await runVisualGenerationOnce('w-kling-2', clock)
      expect(second.status).toBe('COMPLETE')
      expect(requests).toHaveLength(2)
      expect(requests[1].method).toBe('GET')
      expect(requests[1].url).toBe(
        `https://api-singapore.klingai.com/tasks?task_ids=${encodeURIComponent(providerOperationId)}`,
      )
      expect(downloads).toEqual([artifactUrl])

      const row = (await visualTaskRows(jobId))[0]
      expect(row.status).toBe('SUCCEEDED')
      expect(row.artifactSha256).toBe(computeFileSha256(mp4Bytes))
      expect(row.artifactMimeType).toBe('video/mp4')
      expect(row.artifactDurationMs).toBe(task.durationMs)
      const stored = await storage.get(row.artifactStorageRef!)
      expect(stored).not.toBeNull()
      expect(computeFileSha256(stored!)).toBe(computeFileSha256(mp4Bytes))
      expect((await jobRow(jobId)).status).toBe('GENERATING_AUDIO')

      // NOTHING SECRET PERSISTED: not the key, not the bearer header,
      // not the signed artifact URL, not the compiled prompt.
      const events = await getDb()
        .select()
        .from(prayerGenerationJobEvents)
        .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
      const payload = JSON.stringify({
        rows: await visualTaskRows(jobId),
        events,
        job: await jobRow(jobId),
      })
      expect(payload).not.toContain(KLING_TEST_CONFIG.apiKey)
      expect(payload).not.toContain('Bearer')
      expect(payload).not.toContain('E2E_SECRET_SIG')
      expect(payload).not.toContain('kling-artifacts.test')
      expect(payload).not.toContain('riverside at dawn')
    } finally {
      resetVisualGenerationProviderForTests()
    }
  }, 240_000)

  it('an unsupported scene duration is refused NOT_SENT with ZERO provider contact', async () => {
    const { manifest } = await makeGeneratingVisualsJob()
    const task = manifest.visualTasks[0]
    let networkCalls = 0
    setVisualGenerationProviderForTests(
      createKlingVisualGenerationProvider(
        KLING_TEST_CONFIG,
        {
          async requestJson() {
            networkCalls += 1
            throw new Error('the network must never be reached')
          },
          async downloadArtifact() {
            networkCalls += 1
            throw new Error('the network must never be reached')
          },
        },
        async () => ({
          ok: true,
          durationMs: 1,
          hasAudio: false,
          hasVideo: true,
        }),
      ),
    )
    try {
      // Kling takes whole seconds 3–15; nothing is EVER rounded to
      // fit, so each of these is a recorded, freely-retryable refusal
      // decided before the network.
      for (const durationMs of [2_000, 16_000, 10_500]) {
        const result = await submitScene(
          { ...task, durationMs },
          { expectedProviderCode: 'KLING' },
        )
        expect(result.status).toBe('FAILED')
        if (result.status !== 'FAILED') continue
        expect(result.errorCode).toBe('duration_unsupported_by_provider')
        expect(result.spendState).toBe('NOT_SENT')
      }
      expect(networkCalls).toBe(0)
    } finally {
      resetVisualGenerationProviderForTests()
    }
  }, 240_000)
})
