import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { and, eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  appointmentGuidanceAssignments,
  appointmentGuidanceSets,
  appointmentPaymentSettlements,
  appointments,
  auditLogs,
  mediaAssetVersions,
  mediaAssets,
  paymentAttempts,
  paymentWebhookEvents,
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
import { createReservation } from '@/services/appointments'
import { initiatePayment, processProviderWebhook } from '@/services/payments'
import { buildMockWebhook, createMockProvider } from '@/providers/payments/mock'
import {
  resetPaymentRegistryForTests,
  setPaymentRegistryForTests,
} from '@/providers/payments/registry'
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
} from '@/services/generation-jobs'
import {
  PIPELINE_STAGE_ORDER,
  runGenerationPipelinePass,
} from '@/services/generation-pipeline'
import { verifyCompletedUpload } from '@/services/render-upload'
import { LocalPrivateObjectStorage } from '@/providers/object-storage/local'
import {
  resetObjectStorageForTests,
  setObjectStorageForTests,
} from '@/providers/object-storage/registry'
import {
  getPrayerRoomStatus,
  servePrayerRoomMedia,
} from '@/services/prayer-room'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  sqlToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { GenerationClock } from '@/services/generation-jobs'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * ============================================================================
 * END-TO-END AUTONOMOUS PIPELINE — Phase One, Step 19.
 *
 * Every earlier step proved its own stage. This suite proves there is a
 * PIPELINE: that a stranger who registers, books and pays gets a
 * finished, private, time-gated recording without any human touching
 * anything in between.
 *
 * THE RULE THIS FILE LIVES BY: after the payment webhook is accepted,
 * the ONLY thing this suite is allowed to call is
 * runGenerationPipelinePass() — the same function the worker calls. No
 * confirm-reservation shortcut, no admin action, no direct status
 * update, no individual stage worker. That rule is not merely observed;
 * it is asserted against this file's own source at the bottom, so it
 * cannot rot.
 *
 * What is deliberately NOT proved here: that any of this is ready for a
 * real provider. Steps 14–17 run on deterministic mocks and a local
 * private-object adapter, all of them fail-closed in production. Step
 * 19 proves AUTONOMY, not production readiness.
 * ============================================================================
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `e2e pipeline test passphrase ${crypto.randomUUID()}`
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
const CODE_PREFIX = `E2E_${RUN_KEY}`
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

/**
 * ONE clock for the whole file, and it only ever moves forward.
 *
 * The pipeline's waits are real (a provider poll delay is a real
 * delay), so time has to move — but a test that actually slept would be
 * slow AND non-deterministic. A single monotonic fake clock gives the
 * pipeline the passage of time it needs while keeping every ordering in
 * this file reproducible. A per-test clock would be worse than useless:
 * the second test's clock would start BEHIND the first's, and jobs left
 * scheduled in the first test's future would silently stop being
 * claimable.
 */
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
const pipelineClock = makeFakeClock(Date.now())
const POLL_STEP_MS = Math.max(VISUAL_TASK_POLL_DELAY_MS, AUDIO_TASK_POLL_DELAY_MS) + 1_000

/** Distinctive markers. Every one of these is a string no generation
 * row has any business containing; §8 asserts their absence. */
const PERSONAL_NAME_MARKER = 'Adéwálé Olúṣọlá Adébáyọ̀ E2EMARKER'
const PERSONAL_PHONE_MARKER = '+2348012345678'
const PRIVATE_NOTE_MARKER = 'E2EPRIVATENOTE please remember my mother by name'
const SACRED_BODY_MARKER = 'E2ESACREDBODY approved prayer block body'

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `e2e-${crypto.randomUUID()}@test.local`,
      preferredName: 'E2E Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role) await assignRoleToUser(result.user.id, role)
  return result.user.id
}

/** A real user completing the real onboarding: personal details, then
 * the required consents. Nothing is inserted behind the services' backs
 * — an ineligible profile genuinely cannot book. */
async function makeEligibleUser(
  preferredLanguage: 'en' | 'yo' = 'en',
): Promise<number> {
  const id = await makeUser()
  await savePersonalDetails(
    id,
    {
      fullName: PERSONAL_NAME_MARKER,
      preferredName: 'Adéwálé',
      phone: PERSONAL_PHONE_MARKER,
      countryCode: 'NG',
      timezone: 'Africa/Lagos',
      preferredLanguage,
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

/** Human authority spent ONCE, upstream: authored → reviewed →
 * approved → published → rights cleared → runtime enabled. This is the
 * whole of the human involvement in a Step 19 recording. */
async function makeEligibleSacred(options: {
  themeCode: string
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
    {
      language: 'en',
      title: 'End-to-end sacred block',
      body: bodyMarker,
    },
    sacredProfile({
      themeCode: options.themeCode,
      voicePolicy: 'APPROVED_TTS_ALLOWED',
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
    new TextEncoder().encode(`e2e-image ${crypto.randomUUID()}`),
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

// --- Row readers ------------------------------------------------------------

async function jobRow(jobId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
  ).at(0)!
}

async function jobsForAppointment(appointmentId: number) {
  return getDb()
    .select()
    .from(prayerGenerationJobs)
    .where(eq(prayerGenerationJobs.appointmentId, appointmentId))
}

async function jobStatusTrail(jobId: number): Promise<Array<string>> {
  const events = await getDb()
    .select()
    .from(prayerGenerationJobEvents)
    .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
    .orderBy(prayerGenerationJobEvents.id)
  return events.map((row) => row.toStatus)
}

async function uploadRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationUploads)
    .where(eq(prayerGenerationUploads.generationJobId, jobId))
}

async function renderResultRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationRenderResults)
    .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
}

async function renderPlanRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationRenderPlans)
    .where(eq(prayerGenerationRenderPlans.generationJobId, jobId))
}

async function visualTaskRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationVisualTasks)
    .where(eq(prayerGenerationVisualTasks.generationJobId, jobId))
}

async function audioTaskRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationAudioTasks)
    .where(eq(prayerGenerationAudioTasks.generationJobId, jobId))
}

async function recipeSnapshotRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationRecipeSnapshots)
    .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
}

async function storyboardSnapshotRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationStoryboardSnapshots)
    .where(eq(prayerGenerationStoryboardSnapshots.generationJobId, jobId))
}

async function manifestSnapshotRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationManifestSnapshots)
    .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
}

/**
 * Every private object this suite's storage root holds, as relative
 * keys. The root is this suite's own temp directory, so the count IS
 * the number of canonical objects the pipeline created.
 *
 * The local adapter writes a `.meta.json` sidecar beside each object —
 * bookkeeping for a backend with no object metadata of its own, not a
 * second copy of the recording — so sidecars are excluded. A second
 * CANONICAL object would still appear here immediately.
 */
function storedObjectKeys(): Array<string> {
  const found: Array<string> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (!entry.endsWith('.meta.json')) {
        found.push(relative(objectRoot, full).replaceAll('\\', '/'))
      }
    }
  }
  walk(objectRoot)
  return found.sort()
}

// --- Booking and payment (the ONLY human/system input) ----------------------

interface PaidBooking {
  userId: number
  appointmentId: number
  appointmentPublicId: string
  startsAtUtc: string
  attemptReference: string
  serviceId: number
  bodyMarker: string | null
}

/**
 * A complete real booking: register → profile → consents → reserve →
 * check out → provider webhook. The webhook is SIGNED and travels
 * through processProviderWebhook, so this exercises the actual
 * verification, dedupe and settlement code rather than a shortcut into
 * it — and the appointment is confirmed and the job enqueued by
 * settlement itself, in one transaction, exactly as production does.
 */
async function bookAndPay(options: {
  serviceId: number
  userId: number
  eventId?: string
}): Promise<PaidBooking> {
  const startsAtUtc = nextSlot()
  const reservation = await createReservation(options.userId, ctx, {
    serviceId: options.serviceId,
    startsAtUtc,
    privateRequestNote: PRIVATE_NOTE_MARKER,
  })
  const initiated = await initiatePayment(options.userId, ctx, {
    appointmentPublicId: reservation.publicId,
    provider: 'MOCK',
  })
  const attempt = (
    await getDb()
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.publicId, initiated.attemptPublicId))
      .limit(1)
  ).at(0)!
  const reference = attempt.providerReference!
  const settled = await settleByWebhook(reference, options.eventId)
  expect(settled.httpStatus).toBe(200)
  return {
    userId: options.userId,
    appointmentId: reservation.appointmentId,
    appointmentPublicId: reservation.publicId,
    startsAtUtc,
    attemptReference: reference,
    serviceId: options.serviceId,
    bodyMarker: null,
  }
}

async function settleByWebhook(reference: string, eventId?: string) {
  const { rawBody, headers } = buildMockWebhook({
    id: eventId ?? `e2e-evt-${crypto.randomUUID()}`,
    type: 'payment.succeeded',
    reference,
    amountMinor: 500_000,
    currency: 'NGN',
  })
  return processProviderWebhook('MOCK', rawBody, headers)
}

/** One booking on its own freshly approved content, template and
 * service — so each job has an identity of its own to keep separate. */
async function bookFullyApprovedJourney(): Promise<PaidBooking> {
  const serviceId = nextService()
  const theme = `${CODE_PREFIX}_T_${crypto.randomUUID().slice(0, 6).toUpperCase()}`
  const sacred = await makeEligibleSacred({ themeCode: theme })
  await makeEligibleImage(theme)
  await makeServiceTemplate(serviceId, [
    filterSlot({ themeCode: theme, contentType: 'PRAYER' }),
  ])
  const userId = await makeEligibleUser()
  const booking = await bookAndPay({ serviceId, userId })
  return { ...booking, bodyMarker: sacred.bodyMarker }
}

// --- The autonomous runtime -------------------------------------------------

interface DriveReport {
  passes: number
  workingPasses: number
  stagesSeen: Set<string>
}

/**
 * THE autonomous runtime, and the only thing this suite drives.
 *
 * It calls the same runGenerationPipelinePass() the worker calls, in the
 * same loop shape, and advances the fake clock between passes so the
 * pipeline's real poll waits elapse. It never inspects a job to decide
 * what to run next, never touches a status, and never nudges a stuck
 * job along — if a job does not finish, this returns and the caller's
 * assertion fails, which is the point.
 */
async function drivePipelineUntil(
  done: () => Promise<boolean>,
  options: { maxPasses?: number; label?: string } = {},
): Promise<DriveReport> {
  const maxPasses = options.maxPasses ?? 160
  const label = options.label ?? 'e2e'
  const stagesSeen = new Set<string>()
  let workingPasses = 0
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (await done()) return { passes: pass, workingPasses, stagesSeen }
    const result = await runGenerationPipelinePass(
      `${label}-worker-${pass}`,
      pipelineClock,
    )
    if (result.workOccurred) workingPasses += 1
    for (const stage of result.stages) {
      if (stage.status !== 'IDLE') stagesSeen.add(stage.stage)
    }
    // Time passes between passes exactly as it would for a real worker
    // sleeping between cycles — enough for a poll wait to come due.
    pipelineClock.advance(POLL_STEP_MS)
  }
  return { passes: maxPasses, workingPasses, stagesSeen }
}

async function jobIsReady(jobId: number): Promise<boolean> {
  return (await jobRow(jobId)).status === 'READY'
}

async function soleJobFor(appointmentId: number): Promise<number> {
  const jobs = await jobsForAppointment(appointmentId)
  expect(jobs).toHaveLength(1)
  return jobs[0].id
}

// --- Shared golden run ------------------------------------------------------

interface GoldenRun {
  booking: PaidBooking
  jobId: number
  drive: DriveReport
}
let goldenPromise: Promise<GoldenRun> | null = null

/** The one full journey, computed once and asserted from many angles.
 * Rebuilding it per assertion would multiply a slow fixture for no
 * additional proof — every test below reads the SAME persisted run. */
function golden(): Promise<GoldenRun> {
  goldenPromise ??= (async () => {
    const booking = await bookFullyApprovedJourney()
    const jobId = await soleJobFor(booking.appointmentId)
    const drive = await drivePipelineUntil(() => jobIsReady(jobId), {
      label: 'golden',
    })
    return { booking, jobId, drive }
  })()
  return goldenPromise
}

beforeAll(async () => {
  mediaRoot = mkdtempSync(join(tmpdir(), 'yhw-e2e-media-'))
  objectRoot = mkdtempSync(join(tmpdir(), 'yhw-e2e-objects-'))
  mediaStorage = new LocalMediaStorageProvider(mediaRoot)
  objectStorage = new LocalPrivateObjectStorage(objectRoot)
  setMediaStorageForTests(mediaStorage)
  setObjectStorageForTests(objectStorage)
  // The mock payment provider only — no live provider is reachable, and
  // the mock refuses to exist in production.
  setPaymentRegistryForTests(
    [createMockProvider({ nodeEnv: 'test', enabled: true })],
    true,
  )

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  // Retire anything a previous run of THIS file left behind.
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'E2E\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'E2E\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'E2E\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `E2EH_${key}`.toUpperCase(),
    name: `E2E House ${key}`,
    slug: `e2eh-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  servicePool = []
  for (let i = 0; i < 12; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `E2ES${i}_${key}`.toUpperCase(),
      name: `E2E Service ${i} ${key}`,
      slug: `e2es${i}-${key}`,
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
      const attemptIds = (
        await db
          .select({ id: paymentAttempts.id })
          .from(paymentAttempts)
          .where(inArray(paymentAttempts.appointmentId, apptIds))
      ).map((row) => row.id)
      if (attemptIds.length > 0) {
        await db
          .delete(paymentWebhookEvents)
          .where(inArray(paymentWebhookEvents.paymentAttemptId, attemptIds))
      }
      await db
        .delete(appointmentPaymentSettlements)
        .where(inArray(appointmentPaymentSettlements.appointmentId, apptIds))
      await db
        .delete(paymentAttempts)
        .where(inArray(paymentAttempts.appointmentId, apptIds))
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
        await db
          .delete(sacredContentVersionProfiles)
          .where(
            inArray(
              sacredContentVersionProfiles.contentVersionId,
              sacredVersionIds,
            ),
          )
        await db
          .delete(spiritualContentVersions)
          .where(inArray(spiritualContentVersions.id, sacredVersionIds))
      }
      await db
        .delete(spiritualContentItems)
        .where(inArray(spiritualContentItems.id, createdItemIds))
    }
    if (createdAssetIds.length > 0) {
      await db
        .delete(mediaAssetVersions)
        .where(inArray(mediaAssetVersions.assetId, createdAssetIds))
      await db.delete(mediaAssets).where(inArray(mediaAssets.id, createdAssetIds))
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
  resetPaymentRegistryForTests()
  rmSync(mediaRoot, { recursive: true, force: true })
  rmSync(objectRoot, { recursive: true, force: true })
  await closeDb()
})

// ----------------------------------------------------------------------------
// §2/§3 — payment to READY, autonomously
// ----------------------------------------------------------------------------

describe('end-to-end autonomous pipeline', () => {
  it('confirms the appointment and queues exactly one job from the verified payment alone', async () => {
    const { booking, jobId } = await golden()
    const appointment = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, booking.appointmentId))
        .limit(1)
    ).at(0)!
    // The webhook did all of this — nothing in this suite confirmed
    // anything by hand.
    expect(appointment.status).toBe('CONFIRMED')
    expect(appointment.reservationExpiresAt).toBeNull()
    const settlement = (
      await getDb()
        .select()
        .from(appointmentPaymentSettlements)
        .where(
          eq(appointmentPaymentSettlements.appointmentId, booking.appointmentId),
        )
    ).at(0)
    expect(settlement).toBeDefined()
    const jobs = await jobsForAppointment(booking.appointmentId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(jobId)
    // Enqueued in the settlement transaction itself: the job's first
    // recorded event is its arrival in the queue, with no prior state.
    const firstEvent = (
      await getDb()
        .select()
        .from(prayerGenerationJobEvents)
        .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
        .orderBy(prayerGenerationJobEvents.id)
        .limit(1)
    ).at(0)!
    expect(firstEvent.fromStatus).toBeNull()
    expect(firstEvent.toStatus).toBe('QUEUED')
  }, 600_000)

  it('reaches READY through the real persisted stage progression', async () => {
    const { jobId, drive } = await golden()
    expect((await jobRow(jobId)).status).toBe('READY')
    const trail = await jobStatusTrail(jobId)
    // Self-loop polling events are legitimate and expected; what must
    // hold is that the DISTINCT run of states is exactly the canonical
    // progression, in order, with nothing skipped and nothing extra.
    const distinct = trail.filter((status, index) => status !== trail[index - 1])
    expect(distinct).toEqual([
      'QUEUED',
      'PREPARING',
      'STORYBOARDING',
      'GENERATING_VISUALS',
      'GENERATING_AUDIO',
      'RENDERING',
      'UPLOADING',
      'READY',
    ])
    // It genuinely took the pipeline several passes and every stage.
    expect(drive.workingPasses).toBeGreaterThan(1)
    expect([...drive.stagesSeen].sort()).toEqual([...PIPELINE_STAGE_ORDER].sort())
    // No retry, no failure: the happy path really was the happy path.
    const job = await jobRow(jobId)
    expect(job.lastErrorCode).toBeNull()
    expect(trail).not.toContain('RETRYING')
    expect(trail).not.toContain('FAILED')
  }, 600_000)

  it('leaves exactly one immutable identity per stage', async () => {
    const { jobId } = await golden()
    const recipes = await recipeSnapshotRows(jobId)
    const storyboards = await storyboardSnapshotRows(jobId)
    const manifests = await manifestSnapshotRows(jobId)
    const plans = await renderPlanRows(jobId)
    const results = await renderResultRows(jobId)
    const uploads = await uploadRows(jobId)
    expect(recipes).toHaveLength(1)
    expect(storyboards).toHaveLength(1)
    expect(manifests).toHaveLength(1)
    expect(plans).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(uploads).toHaveLength(1)
    expect(recipes[0].recipeSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(storyboards[0].storyboardSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifests[0].manifestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(results[0].artifactSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(uploads[0].status).toBe('SUCCEEDED')
    // The upload is bound to THIS job's render result, not to some
    // other render that happened to finish nearby.
    expect(uploads[0].renderResultId).toBe(results[0].id)
    expect(uploads[0].artifactSha256).toBe(results[0].artifactSha256!)
  }, 600_000)

  it('executed exactly the visual and audio work the manifest required', async () => {
    const { jobId } = await golden()
    const manifest = JSON.parse(
      (await manifestSnapshotRows(jobId))[0].manifestJsonText,
    ) as {
      visualTasks: Array<{ taskId: string }>
      audioRequirements: Array<{ requirementId: string; mode: string }>
    }
    const visuals = await visualTaskRows(jobId)
    const audio = await audioTaskRows(jobId)
    expect(visuals.map((row) => row.taskId).sort()).toEqual(
      manifest.visualTasks.map((task) => task.taskId).sort(),
    )
    expect(visuals.every((row) => row.status === 'SUCCEEDED')).toBe(true)
    // Only TTS requirements become speech tasks: an approved human
    // recording is re-verified in place and never synthesized.
    const ttsRequirements = manifest.audioRequirements
      .filter((requirement) => requirement.mode === 'TTS_PENDING')
      .map((requirement) => requirement.requirementId)
      .sort()
    expect(audio.map((row) => row.requirementId).sort()).toEqual(
      ttsRequirements,
    )
    expect(audio.every((row) => row.status === 'SUCCEEDED')).toBe(true)
  }, 600_000)

  it('lands one canonical private object that the shared Step 17 proof accepts', async () => {
    const { jobId } = await golden()
    const job = await jobRow(jobId)
    const verified = await verifyCompletedUpload(jobId, {
      serviceId: job.serviceIdSnapshot,
      sacredHouseId: job.sacredHouseIdSnapshot,
      language: job.languageSnapshot,
    })
    expect(verified.ok).toBe(true)
    if (!verified.ok) throw new Error(verified.errorCode)
    const upload = (await uploadRows(jobId))[0]
    expect(verified.verified.objectKey).toBe(upload.objectKey)
    expect(verified.verified.provider.isLocal).toBe(true)
    // Exactly one object on disk for exactly one job.
    expect(storedObjectKeys()).toEqual([upload.objectKey])
  }, 600_000)
})

// ----------------------------------------------------------------------------
// §3 — the Prayer Room at the end of the pipeline
// ----------------------------------------------------------------------------

describe('prayer room after an autonomous run', () => {
  it('is LOCKED before the appointment starts and AVAILABLE at its start', async () => {
    const { booking } = await golden()
    const startMs = sqlToUtcMs(booking.startsAtUtc)
    const before = await getPrayerRoomStatus(
      booking.userId,
      booking.appointmentPublicId,
      new Date(startMs - 60_000),
    )
    expect(before?.state).toBe('LOCKED')
    const atStart = await getPrayerRoomStatus(
      booking.userId,
      booking.appointmentPublicId,
      new Date(startMs),
    )
    expect(atStart?.state).toBe('AVAILABLE')
  }, 600_000)

  it('serves the owner bytes that pass the integrity proof', async () => {
    const { booking, jobId } = await golden()
    const startMs = sqlToUtcMs(booking.startsAtUtc)
    const response = await servePrayerRoomMedia({
      userId: booking.userId,
      publicId: booking.appointmentPublicId,
      request: new Request('https://test.local/media'),
      now: new Date(startMs),
    })
    expect(response.status).toBe(200)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const result = (await renderResultRows(jobId))[0]
    // The bytes a browser would actually play are the Step 16 artifact,
    // byte for byte.
    expect(computeFileSha256(bytes)).toBe(result.artifactSha256!)
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const ranged = await servePrayerRoomMedia({
      userId: booking.userId,
      publicId: booking.appointmentPublicId,
      request: new Request('https://test.local/media', {
        headers: { range: 'bytes=0-9' },
      }),
      now: new Date(startMs),
    })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-9/${String(bytes.length)}`,
    )
  }, 600_000)

  it('still refuses a different signed-in user', async () => {
    const { booking } = await golden()
    const stranger = await makeEligibleUser()
    const startMs = sqlToUtcMs(booking.startsAtUtc)
    expect(
      await getPrayerRoomStatus(
        stranger,
        booking.appointmentPublicId,
        new Date(startMs),
      ),
    ).toBeNull()
    const response = await servePrayerRoomMedia({
      userId: stranger,
      publicId: booking.appointmentPublicId,
      request: new Request('https://test.local/media'),
      now: new Date(startMs),
    })
    expect(response.status).toBe(404)
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  }, 600_000)
})

// ----------------------------------------------------------------------------
// §4 — idempotence
// ----------------------------------------------------------------------------

describe('idempotence after READY', () => {
  it('does nothing at all on further pipeline passes', async () => {
    const { jobId } = await golden()
    const before = {
      job: await jobRow(jobId),
      recipes: (await recipeSnapshotRows(jobId)).length,
      storyboards: (await storyboardSnapshotRows(jobId)).length,
      manifests: (await manifestSnapshotRows(jobId)).length,
      visuals: (await visualTaskRows(jobId)).length,
      audio: (await audioTaskRows(jobId)).length,
      plans: (await renderPlanRows(jobId)).length,
      results: (await renderResultRows(jobId)).length,
      uploads: (await uploadRows(jobId)).length,
      events: (await jobStatusTrail(jobId)).length,
      objects: storedObjectKeys(),
    }
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await runGenerationPipelinePass(
        `idempotence-${pass}`,
        pipelineClock,
      )
      // Every stage must find nothing to do for a completed job. Other
      // suites' rows cannot interfere: this asserts on THIS job's id.
      for (const stage of result.stages) {
        expect(stage.jobId).not.toBe(jobId)
      }
      pipelineClock.advance(POLL_STEP_MS)
    }
    const after = await jobRow(jobId)
    expect(after.status).toBe('READY')
    expect(after.attemptCount).toBe(before.job.attemptCount)
    expect((await recipeSnapshotRows(jobId)).length).toBe(before.recipes)
    expect((await storyboardSnapshotRows(jobId)).length).toBe(before.storyboards)
    expect((await manifestSnapshotRows(jobId)).length).toBe(before.manifests)
    expect((await visualTaskRows(jobId)).length).toBe(before.visuals)
    expect((await audioTaskRows(jobId)).length).toBe(before.audio)
    expect((await renderPlanRows(jobId)).length).toBe(before.plans)
    expect((await renderResultRows(jobId)).length).toBe(before.results)
    expect((await uploadRows(jobId)).length).toBe(before.uploads)
    expect((await jobStatusTrail(jobId)).length).toBe(before.events)
    expect(storedObjectKeys()).toEqual(before.objects)
  }, 600_000)

  it('survives a replayed payment webhook without a second job', async () => {
    const { booking, jobId } = await golden()
    const objectsBefore = storedObjectKeys()
    // Same event id: the webhook layer's own dedupe answers without
    // reaching settlement at all.
    const duplicate = await settleByWebhook(
      booking.attemptReference,
      `e2e-replay-fixed-${booking.appointmentId}`,
    )
    expect(duplicate.httpStatus).toBe(200)
    const replayOfSameEvent = await settleByWebhook(
      booking.attemptReference,
      `e2e-replay-fixed-${booking.appointmentId}`,
    )
    expect(replayOfSameEvent.body).toBe('duplicate')
    // A genuinely NEW event for an already-settled attempt: settlement
    // itself must absorb it.
    const freshEvent = await settleByWebhook(booking.attemptReference)
    expect(freshEvent.httpStatus).toBe(200)

    const jobs = await jobsForAppointment(booking.appointmentId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe(jobId)
    expect(jobs[0].status).toBe('READY')
    const settlements = await getDb()
      .select()
      .from(appointmentPaymentSettlements)
      .where(
        eq(appointmentPaymentSettlements.appointmentId, booking.appointmentId),
      )
    expect(settlements).toHaveLength(1)
    // And a further run of the pipeline still produces nothing new.
    await drivePipelineUntil(async () => false, {
      maxPasses: 3,
      label: 'replay',
    })
    expect((await uploadRows(jobId))).toHaveLength(1)
    expect(storedObjectKeys()).toEqual(objectsBefore)
  }, 600_000)
})

// ----------------------------------------------------------------------------
// §5 — multi-job autonomy
// ----------------------------------------------------------------------------

describe('multi-job autonomy', () => {
  it('drives two independent confirmed appointments to READY without either starving or borrowing from the other', async () => {
    await golden()
    const first = await bookFullyApprovedJourney()
    const second = await bookFullyApprovedJourney()
    const firstJob = await soleJobFor(first.appointmentId)
    const secondJob = await soleJobFor(second.appointmentId)
    expect(firstJob).not.toBe(secondJob)

    const drive = await drivePipelineUntil(
      async () => (await jobIsReady(firstJob)) && (await jobIsReady(secondJob)),
      { label: 'multi', maxPasses: 240 },
    )
    expect((await jobRow(firstJob)).status).toBe('READY')
    expect((await jobRow(secondJob)).status).toBe('READY')
    expect(drive.passes).toBeLessThan(240)

    // Separate identities the whole way down.
    const [firstUpload] = await uploadRows(firstJob)
    const [secondUpload] = await uploadRows(secondJob)
    expect(firstUpload.objectKey).not.toBe(secondUpload.objectKey)
    expect(firstUpload.idempotencyKey).not.toBe(secondUpload.idempotencyKey)
    expect(firstUpload.artifactSha256).not.toBe(secondUpload.artifactSha256)
    const firstJobRow = await jobRow(firstJob)
    const secondJobRow = await jobRow(secondJob)
    expect(firstJobRow.variationSeed).not.toBe(secondJobRow.variationSeed)

    // No adoption: every task, plan and result names its own job, and
    // one job's row count never leaks into the other's.
    for (const [jobId, otherJob] of [
      [firstJob, secondJob],
      [secondJob, firstJob],
    ] as const) {
      const owned = [
        ...(await visualTaskRows(jobId)),
        ...(await audioTaskRows(jobId)),
        ...(await renderPlanRows(jobId)),
        ...(await renderResultRows(jobId)),
        ...(await uploadRows(jobId)),
      ]
      expect(owned.length).toBeGreaterThan(0)
      expect(owned.every((row) => row.generationJobId === jobId)).toBe(true)
      expect(owned.some((row) => row.generationJobId === otherJob)).toBe(false)
    }
    // Three complete runs so far (the golden one plus these two), three
    // canonical objects, no sharing and no duplicates.
    const keys = storedObjectKeys()
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toContain(firstUpload.objectKey)
    expect(keys).toContain(secondUpload.objectKey)
  }, 900_000)
})

// ----------------------------------------------------------------------------
// §6 — failure isolation
// ----------------------------------------------------------------------------

describe('failure isolation', () => {
  it('fails a job that governance cannot satisfy without holding up a valid one', async () => {
    await golden()
    const db = getDb()
    // PRECONDITION, PROVED NOT ASSUMED: nothing in this database can
    // currently satisfy a Yorùbá-language session, so the refusal below
    // is a real governance outcome rather than an accident of fixture
    // ordering. Template applicability requires a PUBLISHED version in
    // the EXACT language, with no fallback.
    const yorubaTemplates = await db
      .select({ id: prayerSessionTemplateVersions.id })
      .from(prayerSessionTemplateVersions)
      .innerJoin(
        prayerSessionTemplates,
        eq(prayerSessionTemplateVersions.templateId, prayerSessionTemplates.id),
      )
      .where(
        and(
          eq(prayerSessionTemplates.active, true),
          eq(prayerSessionTemplateVersions.language, 'yo'),
          eq(prayerSessionTemplateVersions.status, 'PUBLISHED'),
        ),
      )
    expect(yorubaTemplates).toEqual([])

    // The doomed booking: a real paid appointment whose language no
    // approved template covers. Its service also has no template of its
    // own, so there is nothing anywhere for it to resolve.
    const doomedUser = await makeEligibleUser('yo')
    const doomed = await bookAndPay({
      serviceId: nextService(),
      userId: doomedUser,
    })
    const doomedJob = await soleJobFor(doomed.appointmentId)

    // The healthy booking, made AFTER it, so it is genuinely behind the
    // broken one in the queue.
    const healthy = await bookFullyApprovedJourney()
    const healthyJob = await soleJobFor(healthy.appointmentId)

    const drive = await drivePipelineUntil(() => jobIsReady(healthyJob), {
      label: 'isolation',
      maxPasses: 200,
    })
    expect(drive.passes).toBeLessThan(200)
    expect((await jobRow(healthyJob)).status).toBe('READY')
    expect((await uploadRows(healthyJob))[0].status).toBe('SUCCEEDED')

    // The doomed job followed the EXISTING rules: a structural
    // impossibility fails closed rather than storming the retry budget,
    // and nothing was invented to make it look successful.
    const failed = await jobRow(doomedJob)
    expect(failed.status).toBe('FAILED')
    expect(failed.lastErrorCode).toBe('RECIPE_UNAVAILABLE')
    expect(failed.nextAttemptAt).toBeNull()
    expect(await recipeSnapshotRows(doomedJob)).toHaveLength(0)
    expect(await storyboardSnapshotRows(doomedJob)).toHaveLength(0)
    expect(await renderResultRows(doomedJob)).toHaveLength(0)
    expect(await uploadRows(doomedJob)).toHaveLength(0)
    // Its Prayer Room says PREPARING, never AVAILABLE — a failure is
    // never dressed up as a recording.
    const room = await getPrayerRoomStatus(
      doomedUser,
      doomed.appointmentPublicId,
      new Date(sqlToUtcMs(doomed.startsAtUtc)),
    )
    expect(room?.state).toBe('PREPARING')
  }, 900_000)
})

// ----------------------------------------------------------------------------
// §8 — privacy and governance
// ----------------------------------------------------------------------------

describe('privacy through the autonomous pipeline', () => {
  it('keeps personal details, the private note and the sacred body out of every generation row', async () => {
    const { jobId, booking } = await golden()
    const markers = [
      PERSONAL_NAME_MARKER,
      PERSONAL_PHONE_MARKER,
      PRIVATE_NOTE_MARKER,
      SACRED_BODY_MARKER,
    ]
    // The markers really are present where they belong, so their
    // absence below means something.
    const appointment = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, booking.appointmentId))
        .limit(1)
    ).at(0)!
    expect(appointment.privateRequestNote).toBe(PRIVATE_NOTE_MARKER)
    expect(booking.bodyMarker).toContain(SACRED_BODY_MARKER)

    const surfaces: Array<{ label: string; rows: Array<unknown> }> = [
      { label: 'job', rows: [await jobRow(jobId)] },
      {
        label: 'job events',
        rows: await getDb()
          .select()
          .from(prayerGenerationJobEvents)
          .where(eq(prayerGenerationJobEvents.generationJobId, jobId)),
      },
      { label: 'recipe snapshots', rows: await recipeSnapshotRows(jobId) },
      {
        label: 'storyboard snapshots',
        rows: await storyboardSnapshotRows(jobId),
      },
      { label: 'manifest snapshots', rows: await manifestSnapshotRows(jobId) },
      { label: 'visual tasks', rows: await visualTaskRows(jobId) },
      { label: 'audio tasks', rows: await audioTaskRows(jobId) },
      { label: 'render plans', rows: await renderPlanRows(jobId) },
      { label: 'render results', rows: await renderResultRows(jobId) },
      { label: 'uploads', rows: await uploadRows(jobId) },
    ]
    for (const surface of surfaces) {
      const serialized = JSON.stringify(surface.rows)
      for (const marker of markers) {
        if (serialized.includes(marker)) {
          throw new Error(`${surface.label} leaked marker: ${marker}`)
        }
      }
    }
    // The object key is server-generated from hashes alone.
    const upload = (await uploadRows(jobId))[0]
    for (const marker of markers) {
      expect(upload.objectKey).not.toContain(marker)
    }
    // Nothing but hex: the key is derived from hashes alone, so it
    // cannot carry an identifier even accidentally. (Deliberately NOT
    // asserted as "does not contain the user id" — a two-digit id
    // appears in a 64-character hex digest by pure chance.)
    expect(upload.objectKey).toMatch(/^renders\/[0-9a-f]{2}\/[0-9a-f]{64}\./)

    // The approved body stays where human authority put it, and only
    // there.
    const stored = await getDb()
      .select({ body: spiritualContentVersions.body })
      .from(spiritualContentVersions)
      .where(inArray(spiritualContentVersions.contentItemId, createdItemIds))
    expect(stored.some((row) => row.body.includes(SACRED_BODY_MARKER))).toBe(
      true,
    )
  }, 600_000)
})

// ----------------------------------------------------------------------------
// §1/§7 — the orchestration contract itself
// ----------------------------------------------------------------------------

describe('orchestration contract', () => {
  it('is the same pass the production worker runs', () => {
    const worker = readFileSync(
      join(process.cwd(), 'src/workers/prayer-generation-worker.ts'),
      'utf8',
    )
    expect(worker).toContain('runGenerationPipelinePass')
    // The worker delegates: it must not reach past the pass into an
    // individual stage, or production and this suite would diverge.
    for (const stage of [
      'runGenerationPreparation' + 'Once',
      'runStoryboardPlanning' + 'Once',
      'runVisualGeneration' + 'Once',
      'runAudioGeneration' + 'Once',
      'runRender' + 'Once',
      'runUpload' + 'Once',
    ]) {
      expect(worker).not.toContain(stage)
    }
    // Lease recovery stays a worker lifecycle duty, per §1.
    expect(worker).toContain('recoverExpiredGenerationLeases')
    // Still one executable.
    const workers = readdirSync(join(process.cwd(), 'src/workers'))
    expect(workers).toEqual(['prayer-generation-worker.ts'])
  })

  it('never touches a generation status itself', () => {
    const pipeline = readFileSync(
      join(process.cwd(), 'src/services/generation-pipeline.ts'),
      'utf8',
    )
    // No writes, no transition authority, no second state machine.
    for (const forbidden of [
      'GENERATION_TRANSITIONS',
      'transitionGenerationJobUnderLease',
      '.update(',
      '.insert(',
      '.delete(',
      'getDb(',
      'prayerGenerationJobs',
    ]) {
      expect(pipeline).not.toContain(forbidden)
    }
  })

  it('drove everything above through the shared pass and nothing else', () => {
    // The rule this file lives by, asserted against this file. The
    // forbidden names are assembled from fragments so that stating them
    // here does not itself trip the check.
    const source = readFileSync(
      join(process.cwd(), 'tests/integration/end-to-end-pipeline.test.ts'),
      'utf8',
    )
    expect(source).toContain('runGenerationPipelinePass')
    for (const forbidden of [
      'runGenerationPreparation' + 'Once',
      'runStoryboardPlanning' + 'Once',
      'runVisualGeneration' + 'Once',
      'runAudioGeneration' + 'Once',
      'runRender' + 'Once',
      'runUpload' + 'Once',
      'confirmReservation' + '(',
      'recoverExpiredGenerationLeases' + '(',
    ]) {
      expect(source).not.toContain(forbidden)
    }
    // No direct generation-status writes anywhere in this file — the
    // only writes it performs are the fixture's own approvals, and
    // every one of those happens BEFORE the first booking. Assembled
    // from fragments for the same reason as above.
    expect(source).not.toContain('.update(' + 'prayerGenerationJobs)')
    expect(source).not.toContain('.set({ ' + 'status:')
  })

  it('adds no table and no migration: the schema is still the Step 18 shape', async () => {
    const rows = (await getDb().execute(
      'SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = DATABASE()',
    )) as unknown as Array<Array<{ c: number }>>
    expect(Number(rows[0][0].c)).toBe(55)
    const migrations = readdirSync(join(process.cwd(), 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort()
    expect(migrations).toHaveLength(16)
    expect(migrations.at(-1)).toMatch(/^0015_/)
  }, 240_000)
})
