import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
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
import { runGenerationPipelinePass } from '@/services/generation-pipeline'
import { resolveApprovedPrayerSession } from '@/services/prayer-session-resolver'
import { LocalPrivateObjectStorage } from '@/providers/object-storage/local'
import {
  resetObjectStorageForTests,
  setObjectStorageForTests,
} from '@/providers/object-storage/registry'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { GenerationClock } from '@/services/generation-jobs'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { SlotInput } from '@/services/prayer-templates'

/**
 * ============================================================================
 * HOUSE-SCOPED VISUAL BEDS — the hybrid recorded-prayer foundation.
 *
 * The arrangement this file proves: a Sacred House's approved imagery
 * is produced ONCE and reused, while the recording built from it stays
 * specific to one appointment. Reusable visuals, per-appointment
 * recording — and no generation provider anywhere in the path.
 *
 * FOUR CLAIMS, and none of them is safe to assume:
 *
 *  1. ONE SHARED TEMPLATE SERVES EVERY HOUSE. Structure, slot order,
 *     silence and the authored camera decision live in a PLATFORM
 *     template. Content is selected per appointment against the
 *     appointment's own House.
 *  2. A HOUSE NEVER BORROWS ANOTHER HOUSE'S ANYTHING. Not its sacred
 *     content, not its imagery. A House with nothing approved yet
 *     resolves nothing rather than reaching next door.
 *  3. THE MANIFEST PINS WHAT IT USED. Exact content version, exact
 *     media version, exact bytes — by hash, per recording.
 *  4. A WITHDRAWAL REACHES THE NEXT RENDER. Runtime-disabling a bed
 *     removes it from the following recording; the one already made is
 *     not retroactively altered.
 *
 * Everything below runs on the deterministic mocks, which is what
 * "proved the governance" means here — not that a vendor works.
 * ============================================================================
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `house beds passphrase ${crypto.randomUUID()}`
const HOUSE_TZ = 'Africa/Lagos'

const RUN_KEY = crypto.randomUUID().slice(0, 6).toUpperCase().replace(/-/g, 'X')
const PREFIX = `HSVB_${RUN_KEY}`
let codeCounter = 0
function nextCode(kind: string): string {
  codeCounter += 1
  return `${PREFIX}_${kind}_${codeCounter}`
}

/** The six roles, in the order the shared template consumes them. */
const SHOT_ORDER = [
  'WIDE_MASTER',
  'MEDIUM_PRAYER',
  'WORKING_DETAIL',
  'DIRECT_CAMERA',
  'SIDE_PRAYER',
  'ENVIRONMENT_INSERT',
] as const

/** One content type per CONTENT slot, matching the shared template. */
const CONTENT_TYPES = [
  'OPENING',
  'INVOCATION',
  'CHANT',
  'PRAYER',
  'BLESSING',
  'CLOSING',
] as const

const createdUserIds: Array<number> = []
const createdItemIds: Array<number> = []
const createdAssetIds: Array<number> = []
const createdTemplateIds: Array<number> = []
const createdHouseIds: Array<number> = []

let adminId: number
let mediaRoot: string
let objectRoot: string

interface HouseFixture {
  houseId: number
  serviceIds: Array<number>
  /** Media VERSION ids of this House's six beds, in SHOT_ORDER. */
  bedVersionIds: Array<number>
  /** Sacred content VERSION ids, one per content type. */
  contentVersionIds: Array<number>
  contentItemIds: Array<number>
}

let housePack: HouseFixture
let otherHouse: HouseFixture
let emptyHouse: HouseFixture
let sharedTemplateCode: string
const serviceCursor = new Map<number, number>()

const today = currentLocalDate(HOUSE_TZ, Date.now())
let slotCursor = 0
function nextSlot(): string {
  const hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00']
  const index = slotCursor++
  const date = addDays(today, 2 + Math.floor(index / hours.length))
  return utcMsToSql(localToUtcMs(HOUSE_TZ, date, hours[index % hours.length]))
}

/** One monotonic clock for the file — see the Step 19 suite for why a
 * per-test clock silently breaks claimability. */
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
const POLL_STEP_MS =
  Math.max(VISUAL_TASK_POLL_DELAY_MS, AUDIO_TASK_POLL_DELAY_MS) + 1_000

// --- Fixtures ---------------------------------------------------------------

async function makeUser(role?: 'ADMIN'): Promise<number> {
  const result = await registerUser(
    {
      email: `hsvb-${crypto.randomUUID()}@test.local`,
      preferredName: 'HSVB Fixture',
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
      fullName: 'Hybrid Foundation Recipient',
      preferredName: 'Recipient',
      phone: '+2348012345678',
      countryCode: 'NG',
      timezone: HOUSE_TZ,
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
    // 6 blocks x 15s + 13s of authored silence = 103s, inside the
    // shared template's 90–120 second band.
    durationHintSeconds: 15,
    repeatable: false,
    voicePolicy: 'APPROVED_TTS_ALLOWED',
    externalAiPolicy: 'METADATA_ONLY',
    accessPolicy: 'PRAYER_ROOM_PRIVATE',
    ...overrides,
  }
}

/**
 * A House-scoped sacred block, taken through the whole human path:
 * authored → reviewed → approved → published → rights cleared →
 * runtime enabled. SACRED_HOUSE scope is the point — the shared
 * template admits no other scope.
 */
async function makeHouseContent(
  houseId: number,
  contentType: (typeof CONTENT_TYPES)[number],
): Promise<{ itemId: number; versionId: number }> {
  const item = await createSacredContentItem(adminId, ctx, {
    code: nextCode('SC'),
    contentType,
    scopeType: 'SACRED_HOUSE',
    sacredHouseId: houseId,
    serviceId: null,
    sortOrder: 0,
  })
  createdItemIds.push(item.id)
  const version = await createSacredVersion(
    adminId,
    ctx,
    item.id,
    {
      language: 'en',
      title: `${contentType} block for house ${houseId}`,
      body: `HSVB approved ${contentType} body ${crypto.randomUUID()}`,
    },
    sacredProfile(),
  )
  await submitVersionForReview(adminId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, version.id, true)
  return { itemId: item.id, versionId: version.id }
}

/**
 * One House-scoped visual bed — the shape the six approved Babaláwo
 * stills were registered in: SACRED_HOUSE scope, null contentType so
 * one bed serves any block, AI_GENERATED, no identifiable person.
 */
async function makeHouseBed(houseId: number, role: string): Promise<number> {
  const asset = await createMediaAsset(adminId, ctx, {
    code: nextCode(`BED_${role}`),
    assetKind: 'IMAGE',
    scopeType: 'SACRED_HOUSE',
    sacredHouseId: houseId,
    serviceId: null,
    contentType: null,
    themeCode: null,
  })
  createdAssetIds.push(asset.id)
  const version = await createMediaVersion(
    adminId,
    ctx,
    asset.id,
    // Distinct bytes per bed, so a hash comparison is meaningful.
    new TextEncoder().encode(`hsvb-bed ${houseId} ${role} ${crypto.randomUUID()}`),
    'image/png',
    {
      sourceType: 'AI_GENERATED',
      language: null,
      durationSeconds: null,
      width: 1536,
      height: 1024,
      containsIdentifiablePerson: false,
      consentStatus: 'NOT_APPLICABLE',
      consentReference: null,
      externalAiPolicy: 'DERIVATIVE_GENERATION_ALLOWED',
      voiceCloneAuthorized: false,
    },
  )
  await submitMediaVersion(adminId, ctx, version.id)
  await approveMediaVersion(adminId, ctx, version.id)
  await publishMediaVersion(adminId, ctx, version.id)
  await setMediaRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setMediaRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setMediaRuntimeEnabled(adminId, ctx, version.id, true)
  return version.id
}

async function makeHouse(options: {
  withContent: boolean
  serviceCount: number
}): Promise<HouseFixture> {
  const db = getDb()
  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const inserted = await db.insert(sacredHouses).values({
    code: `${PREFIX}H_${key}`.toUpperCase(),
    name: `HSVB House ${key}`,
    slug: `hsvb-${key}`,
    // Sacred speech is spoken in the voice of the House whose words
    // they are, so a House that renders prayers needs an approved one.
    approvedVoiceProfile: 'YO_MALE',
    status: 'PUBLISHED',
  })
  const houseId = inserted[0].insertId
  createdHouseIds.push(houseId)

  const serviceIds: Array<number> = []
  for (let i = 0; i < options.serviceCount; i += 1) {
    const svc = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `${PREFIX}S${i}_${key}`.toUpperCase(),
      name: `HSVB Service ${i} ${key}`,
      slug: `hsvb-s${i}-${key}`,
      serviceStatus: 'PUBLISHED',
      durationMinutes: 60,
      priceMinor: 500_000,
      currency: 'NGN',
    })
    serviceIds.push(svc[0].insertId)
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
  for (let day = 1; day <= 7; day += 1) {
    await addAvailabilityWindow(adminId, ctx, houseId, {
      dayOfWeek: day,
      startLocalTime: '09:00',
      endLocalTime: '17:00',
    })
  }

  const bedVersionIds: Array<number> = []
  const contentVersionIds: Array<number> = []
  const contentItemIds: Array<number> = []
  if (options.withContent) {
    for (const role of SHOT_ORDER) {
      bedVersionIds.push(await makeHouseBed(houseId, role))
    }
    for (const contentType of CONTENT_TYPES) {
      const made = await makeHouseContent(houseId, contentType)
      contentVersionIds.push(made.versionId)
      contentItemIds.push(made.itemId)
    }
  }
  return { houseId, serviceIds, bedVersionIds, contentVersionIds, contentItemIds }
}

function contentSlot(
  slotKey: string,
  position: number,
  contentType: (typeof CONTENT_TYPES)[number],
  shotFamily: (typeof SHOT_ORDER)[number],
): SlotInput {
  return {
    slotKey,
    position,
    slotKind: 'CONTENT',
    minSelect: 1,
    maxSelect: 1,
    contentType,
    selectorMode: 'ELIGIBLE_FILTER',
    themeCode: null,
    variantKind: null,
    silenceDurationSeconds: null,
    shotFamily,
    referenceRequirement: 'REQUIRED',
    // SACRED_HOUSE alone. Admitting PLATFORM here is what would let a
    // House with nothing approved quietly borrow generic content.
    allowedScopes: ['SACRED_HOUSE'],
    pinnedContentVersionIds: [],
  }
}

function silenceSlot(
  slotKey: string,
  position: number,
  seconds: number,
): SlotInput {
  return {
    slotKey,
    position,
    slotKind: 'SILENCE',
    minSelect: 0,
    maxSelect: 0,
    contentType: null,
    selectorMode: null,
    themeCode: null,
    variantKind: null,
    silenceDurationSeconds: seconds,
    shotFamily: null,
    referenceRequirement: null,
    allowedScopes: [],
    pinnedContentVersionIds: [],
  }
}

/** The same eight-slot shape authored for production, rebuilt here so
 * the test proves the arrangement rather than a simplification of it. */
const SHARED_SLOTS: Array<SlotInput> = [
  contentSlot('OPENING', 1, 'OPENING', 'WIDE_MASTER'),
  silenceSlot('SETTLING', 2, 5),
  contentSlot('INVOCATION', 3, 'INVOCATION', 'MEDIUM_PRAYER'),
  contentSlot('CHANT', 4, 'CHANT', 'WORKING_DETAIL'),
  contentSlot('PERSONAL_PRAYER', 5, 'PRAYER', 'DIRECT_CAMERA'),
  silenceSlot('REFLECTION_PAUSE', 6, 8),
  contentSlot('BLESSING', 7, 'BLESSING', 'SIDE_PRAYER'),
  contentSlot('CLOSING', 8, 'CLOSING', 'ENVIRONMENT_INSERT'),
]

/**
 * ONE PLATFORM template, for every House there will ever be.
 *
 * Its CONTENT slots admit only SACRED_HOUSE content, which makes every
 * one of them a CONTEXT-DEFERRED selector: publication proves the
 * selector contract, and which House satisfies it is an appointment
 * fact settled at resolution time. Structure is authored once; a House
 * that receives approved content later needs no new template and no new
 * version.
 *
 * priority 100 puts it first in the PLATFORM attempt order, so when it
 * CAN resolve it is the template that does — which keeps the assertions
 * below deterministic in a development database holding other suites'
 * leftovers.
 */
async function makeSharedTemplate(): Promise<string> {
  const code = nextCode('SHARED')
  const template = await createPrayerTemplate(adminId, ctx, {
    code,
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
  })
  createdTemplateIds.push(template.id)
  const version = await createTemplateVersion(adminId, ctx, template.id, {
    language: 'en',
    priority: 100,
    selectionWeight: 1,
    targetMinSeconds: 90,
    targetMaxSeconds: 120,
    slots: SHARED_SLOTS,
    forbiddenPairs: [],
  })
  await submitTemplateVersion(adminId, ctx, version.id)
  await approveTemplateVersion(adminId, ctx, version.id)
  await publishTemplateVersion(adminId, ctx, version.id)
  return code
}

// --- Booking and the autonomous runtime -------------------------------------

interface Booking {
  userId: number
  appointmentId: number
  publicId: string
  serviceId: number
}

function nextService(house: HouseFixture): number {
  const used = serviceCursor.get(house.houseId) ?? 0
  serviceCursor.set(house.houseId, used + 1)
  const id = house.serviceIds.at(used)
  if (id == null) throw new Error('service pool exhausted — enlarge fixture')
  return id
}

async function bookAndPay(serviceId: number): Promise<Booking> {
  const userId = await makeEligibleUser()
  const reservation = await createReservation(userId, ctx, {
    serviceId,
    startsAtUtc: nextSlot(),
    privateRequestNote: 'HSVB private note',
  })
  const initiated = await initiatePayment(userId, ctx, {
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
  const { rawBody, headers } = buildMockWebhook({
    id: `hsvb-evt-${crypto.randomUUID()}`,
    type: 'payment.succeeded',
    reference: attempt.providerReference!,
    amountMinor: 500_000,
    currency: 'NGN',
  })
  const settled = await processProviderWebhook('MOCK', rawBody, headers)
  expect(settled.httpStatus).toBe(200)
  return {
    userId,
    appointmentId: reservation.appointmentId,
    publicId: reservation.publicId,
    serviceId,
  }
}

async function soleJobFor(appointmentId: number): Promise<number> {
  const jobs = await getDb()
    .select()
    .from(prayerGenerationJobs)
    .where(eq(prayerGenerationJobs.appointmentId, appointmentId))
  expect(jobs).toHaveLength(1)
  return jobs[0].id
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

/** The same pass the production worker runs, and the only thing driven
 * here. No status is ever set by hand. */
async function driveUntil(
  done: () => Promise<boolean>,
  label: string,
  maxPasses = 160,
): Promise<number> {
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (await done()) return pass
    await runGenerationPipelinePass(`${label}-${pass}`, pipelineClock)
    pipelineClock.advance(POLL_STEP_MS)
  }
  return maxPasses
}

async function driveToSettled(jobId: number, label: string): Promise<string> {
  await driveUntil(async () => {
    const status = (await jobRow(jobId)).status
    return status === 'READY' || status === 'FAILED'
  }, label)
  return (await jobRow(jobId)).status
}

async function manifestRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationManifestSnapshots)
    .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
}

async function recipeRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationRecipeSnapshots)
    .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
}

async function renderResultRows(jobId: number) {
  return getDb()
    .select()
    .from(prayerGenerationRenderResults)
    .where(eq(prayerGenerationRenderResults.generationJobId, jobId))
}

/**
 * Every media / content version id the frozen manifest actually pinned.
 *
 * The snapshot stores its payload as canonical TEXT, which is the point
 * — it is the bytes that were hashed, not a live object graph. Reading
 * it back means parsing that text and walking it.
 */
type ManifestRow = { manifestJsonText: string }

function pinnedIds(rows: Array<ManifestRow>, key: string): Set<number> {
  const found = new Set<number>()
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, value] of Object.entries(node)) {
        if (k === key && typeof value === 'number') found.add(value)
        walk(value)
      }
    }
  }
  for (const row of rows) walk(JSON.parse(row.manifestJsonText))
  return found
}

function pinnedMediaVersionIds(rows: Array<ManifestRow>): Set<number> {
  return pinnedIds(rows, 'mediaAssetVersionId')
}

function pinnedContentVersionIds(rows: Array<ManifestRow>): Set<number> {
  return pinnedIds(rows, 'contentVersionId')
}

// --- The one shared run -----------------------------------------------------

interface GoldenRun {
  booking: Booking
  jobId: number
  status: string
}
let goldenPromise: Promise<GoldenRun> | null = null
function golden(): Promise<GoldenRun> {
  goldenPromise ??= (async () => {
    const booking = await bookAndPay(nextService(housePack))
    const jobId = await soleJobFor(booking.appointmentId)
    const status = await driveToSettled(jobId, 'golden')
    return { booking, jobId, status }
  })()
  return goldenPromise
}

beforeAll(async () => {
  mediaRoot = mkdtempSync(join(tmpdir(), 'yhw-hsvb-media-'))
  objectRoot = mkdtempSync(join(tmpdir(), 'yhw-hsvb-objects-'))
  setMediaStorageForTests(new LocalMediaStorageProvider(mediaRoot))
  setObjectStorageForTests(new LocalPrivateObjectStorage(objectRoot))
  setPaymentRegistryForTests(
    [createMockProvider({ nodeEnv: 'test', enabled: true })],
    true,
  )

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  adminId = await makeUser('ADMIN')

  housePack = await makeHouse({ withContent: true, serviceCount: 6 })
  otherHouse = await makeHouse({ withContent: true, serviceCount: 2 })
  emptyHouse = await makeHouse({ withContent: false, serviceCount: 2 })
  sharedTemplateCode = await makeSharedTemplate()
}, 600_000)

afterAll(async () => {
  const db = getDb()

  /**
   * DELETE, never deactivate.
   *
   * An earlier version of this teardown retired templates, content and
   * media with active:false and left the Houses, Services, booking
   * settings and availability windows standing. Nine runs later the
   * development database held 27 orphan Houses and 90 orphan Services,
   * this suite had slowed from 7s to 74s, and OTHER suites were failing
   * on foreign keys and lock waits against the bloated shared tables.
   *
   * A suite that creates a Sacred House owns every row hanging off it.
   * Order below is child-to-parent, which is the only order the foreign
   * keys allow.
   */
  if (createdHouseIds.length > 0) {
    const apptIds = (
      await db
        .select({ id: appointments.id })
        .from(appointments)
        .where(inArray(appointments.sacredHouseId, createdHouseIds))
    ).map((row) => row.id)

    if (apptIds.length > 0) {
      const jobIds = (
        await db
          .select({ id: prayerGenerationJobs.id })
          .from(prayerGenerationJobs)
          .where(inArray(prayerGenerationJobs.appointmentId, apptIds))
      ).map((row) => row.id)
      if (jobIds.length > 0) {
        for (const table of [
          prayerGenerationUploads,
          prayerGenerationRenderResults,
          prayerGenerationRenderPlans,
          prayerGenerationAudioTasks,
          prayerGenerationVisualTasks,
          prayerGenerationManifestSnapshots,
          prayerGenerationStoryboardSnapshots,
          prayerGenerationJobEvents,
          prayerGenerationRecipeSnapshots,
        ]) {
          await db.delete(table).where(inArray(table.generationJobId, jobIds))
        }
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
  }

  if (createdTemplateIds.length > 0) {
    const versionIds = (
      await db
        .select({ id: prayerSessionTemplateVersions.id })
        .from(prayerSessionTemplateVersions)
        .where(
          inArray(prayerSessionTemplateVersions.templateId, createdTemplateIds),
        )
    ).map((row) => row.id)
    if (versionIds.length > 0) {
      const slotIds = (
        await db
          .select({ id: prayerSessionTemplateSlots.id })
          .from(prayerSessionTemplateSlots)
          .where(
            inArray(prayerSessionTemplateSlots.templateVersionId, versionIds),
          )
      ).map((row) => row.id)
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
        .where(inArray(prayerTemplateForbiddenPairs.templateVersionId, versionIds))
      await db
        .delete(prayerSessionTemplateVersions)
        .where(inArray(prayerSessionTemplateVersions.id, versionIds))
    }
    await db
      .delete(prayerSessionTemplates)
      .where(inArray(prayerSessionTemplates.id, createdTemplateIds))
  }

  if (createdItemIds.length > 0) {
    const versionIds = (
      await db
        .select({ id: spiritualContentVersions.id })
        .from(spiritualContentVersions)
        .where(inArray(spiritualContentVersions.contentItemId, createdItemIds))
    ).map((row) => row.id)
    if (versionIds.length > 0) {
      await db
        .delete(sacredContentMediaLinks)
        .where(inArray(sacredContentMediaLinks.contentVersionId, versionIds))
      await db
        .delete(sacredContentVersionProfiles)
        .where(
          inArray(sacredContentVersionProfiles.contentVersionId, versionIds),
        )
      await db
        .delete(spiritualContentVersions)
        .where(inArray(spiritualContentVersions.id, versionIds))
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

  // THE ROWS THE OLD TEARDOWN FORGOT.
  if (createdHouseIds.length > 0) {
    await db
      .delete(sacredHouseAvailability)
      .where(inArray(sacredHouseAvailability.sacredHouseId, createdHouseIds))
    await db
      .delete(sacredHouseBookingSettings)
      .where(inArray(sacredHouseBookingSettings.sacredHouseId, createdHouseIds))
    await db
      .delete(services)
      .where(inArray(services.sacredHouseId, createdHouseIds))
    await db
      .delete(sacredHouses)
      .where(inArray(sacredHouses.id, createdHouseIds))
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
}, 300_000)

// --- 1. One shared template, resolving per House ----------------------------

describe('one shared PLATFORM template serves every House', () => {
  it('resolves a House against that House’s own approved content', async () => {
    const resolved = await resolveApprovedPrayerSession({
      serviceId: housePack.serviceIds[0],
      language: 'en',
      variationSeed: 'a'.repeat(64),
    })
    expect(resolved.status).toBe('RESOLVED')
    if (resolved.status !== 'RESOLVED') return

    expect(resolved.templateCode).toBe(sharedTemplateCode)
    expect(resolved.templateScopeType).toBe('PLATFORM')
    expect(resolved.slots).toHaveLength(8)

    // Every selection is this House's, by scope AND by identity.
    const own = new Set(housePack.contentVersionIds)
    const foreign = new Set(otherHouse.contentVersionIds)
    for (const slot of resolved.slots) {
      for (const selection of slot.selections) {
        expect(selection.scopeType).toBe('SACRED_HOUSE')
        expect(own.has(selection.contentVersionId)).toBe(true)
        expect(foreign.has(selection.contentVersionId)).toBe(false)
      }
    }
  }, 300_000)

  it('carries the authored camera decision verbatim, and none on silence', async () => {
    const resolved = await resolveApprovedPrayerSession({
      serviceId: housePack.serviceIds[0],
      language: 'en',
      variationSeed: 'b'.repeat(64),
    })
    expect(resolved.status).toBe('RESOLVED')
    if (resolved.status !== 'RESOLVED') return

    const content = resolved.slots.filter((slot) => slot.slotKind === 'CONTENT')
    const silence = resolved.slots.filter((slot) => slot.slotKind === 'SILENCE')
    expect(content.map((slot) => slot.shotFamily)).toEqual([
      'WIDE_MASTER',
      'MEDIUM_PRAYER',
      'WORKING_DETAIL',
      'DIRECT_CAMERA',
      'SIDE_PRAYER',
      'ENVIRONMENT_INSERT',
    ])
    for (const slot of content) {
      expect(slot.referenceRequirement).toBe('REQUIRED')
    }
    for (const slot of silence) {
      // A held frame is not a camera decision.
      expect(slot.shotFamily).toBeNull()
      expect(slot.referenceRequirement).toBeNull()
      expect(slot.selections).toHaveLength(0)
    }
  }, 300_000)

  it('serves a DIFFERENT House from that House’s own content, same template', async () => {
    const resolved = await resolveApprovedPrayerSession({
      serviceId: otherHouse.serviceIds[0],
      language: 'en',
      variationSeed: 'c'.repeat(64),
    })
    expect(resolved.status).toBe('RESOLVED')
    if (resolved.status !== 'RESOLVED') return

    // THE SAME ROW. Not a copy, not a sibling — one published
    // definition serving two Houses from two different content pools.
    expect(resolved.templateCode).toBe(sharedTemplateCode)
    expect(resolved.templateScopeType).toBe('PLATFORM')
    expect(resolved.slots.map((slot) => slot.slotKey)).toEqual(
      SHARED_SLOTS.map((slot) => slot.slotKey),
    )

    const own = new Set(otherHouse.contentVersionIds)
    const neighbour = new Set(housePack.contentVersionIds)
    const selected = resolved.slots.flatMap((slot) => slot.selections)
    expect(selected.length).toBeGreaterThan(0)
    for (const selection of selected) {
      expect(own.has(selection.contentVersionId)).toBe(true)
      expect(neighbour.has(selection.contentVersionId)).toBe(false)
    }
  }, 300_000)
})

// --- 2. A contentless House fails closed ------------------------------------

describe('a House with nothing approved borrows nothing', () => {
  it('does not resolve the shared template, and reaches for no other House', async () => {
    const resolved = await resolveApprovedPrayerSession({
      serviceId: emptyHouse.serviceIds[0],
      language: 'en',
      variationSeed: 'd'.repeat(64),
    })

    // The shared template CANNOT be the answer: its slots admit only
    // SACRED_HOUSE content and this House has none.
    if (resolved.status === 'RESOLVED') {
      expect(resolved.templateCode).not.toBe(sharedTemplateCode)
      // Whatever a leftover template in the development database might
      // resolve, it can never be another House's material: any
      // SACRED_HOUSE-scoped selection here would BE a borrowed one,
      // because this House owns none.
      for (const slot of resolved.slots) {
        for (const selection of slot.selections) {
          expect(selection.scopeType).not.toBe('SACRED_HOUSE')
        }
      }
    } else {
      expect(resolved.status).toBe('NO_VALID_TEMPLATE')
    }
  }, 300_000)

  it('never offers another House’s visual beds to this one', async () => {
    // The bed pool is scope-filtered the same way content is. Asking
    // for this House returns nothing that belongs to the other two.
    const { listAllEligibleMediaAssets } = await import('@/services/media-assets')
    const pool = await listAllEligibleMediaAssets({
      assetKind: 'IMAGE',
      sacredHouseId: emptyHouse.houseId,
    })
    const foreign = new Set([
      ...housePack.bedVersionIds,
      ...otherHouse.bedVersionIds,
    ])
    for (const row of pool) {
      expect(foreign.has(row.versionId)).toBe(false)
    }
  }, 300_000)
})

// --- 3. A complete recording, on mocks --------------------------------------

describe('one appointment becomes one private recording', () => {
  it('reaches READY through the same pass the worker runs', async () => {
    const run = await golden()
    expect(run.status).toBe('READY')
  }, 600_000)

  it('produces exactly one render result with a real duration', async () => {
    const run = await golden()
    const results = await renderResultRows(run.jobId)
    expect(results).toHaveLength(1)
    const durationMs = Number(results[0].artifactDurationMs ?? 0)
    expect(durationMs).toBeGreaterThan(0)
    // The plan GROWS to fit measured audio, so this is a floor, not an
    // equality: the authored silence alone is 13 seconds.
    expect(durationMs).toBeGreaterThanOrEqual(13_000)
  }, 600_000)

  it('dressed the recording in THIS House’s beds and no other’s', async () => {
    const run = await golden()
    const pinned = pinnedMediaVersionIds(await manifestRows(run.jobId))
    expect(pinned.size).toBeGreaterThan(0)

    const own = new Set(housePack.bedVersionIds)
    const foreign = new Set(otherHouse.bedVersionIds)
    for (const versionId of pinned) {
      expect(own.has(versionId)).toBe(true)
      expect(foreign.has(versionId)).toBe(false)
    }
  }, 600_000)
})

// --- 4. The manifest pins what it used --------------------------------------

describe('the manifest pins exact identities and exact bytes', () => {
  it('names the content versions it selected, by id', async () => {
    const run = await golden()
    const pinned = pinnedContentVersionIds(await manifestRows(run.jobId))
    expect(pinned.size).toBeGreaterThan(0)
    const own = new Set(housePack.contentVersionIds)
    for (const versionId of pinned) {
      expect(own.has(versionId)).toBe(true)
    }
  }, 600_000)

  it('pins the bytes, not merely the row', async () => {
    const run = await golden()
    const rows = await manifestRows(run.jobId)
    const pinned = pinnedMediaVersionIds(rows)
    const stored = await getDb()
      .select({
        id: mediaAssetVersions.id,
        fileSha256: mediaAssetVersions.fileSha256,
      })
      .from(mediaAssetVersions)
      .where(inArray(mediaAssetVersions.id, [...pinned]))

    // Every pinned media version's CURRENT hash appears in the frozen
    // manifest payload. A swapped file would break this immediately.
    const serialized = rows.map((row) => row.manifestJsonText).join(' ')
    for (const row of stored) {
      expect(serialized).toContain(row.fileSha256)
    }
    expect(stored.length).toBe(pinned.size)
  }, 600_000)

  it('is one immutable snapshot, not a live view', async () => {
    const run = await golden()
    const rows = await manifestRows(run.jobId)
    expect(rows).toHaveLength(1)
    const recipes = await recipeRows(run.jobId)
    expect(recipes).toHaveLength(1)
  }, 600_000)
})

// --- 5. Reusable beds, appointment-specific recording -----------------------

describe('reusable beds still make an appointment-specific recording', () => {
  it('gives two appointments different seeds off the SAME six beds', async () => {
    const first = await golden()
    const second = await bookAndPay(nextService(housePack))
    const secondJobId = await soleJobFor(second.appointmentId)
    const status = await driveToSettled(secondJobId, 'second')
    expect(status).toBe('READY')

    const firstJob = await jobRow(first.jobId)
    const secondJob = await jobRow(secondJobId)

    // The seed is derived from user, appointment, service and start
    // time — so two recordings are never the same composition by
    // accident, however reusable their imagery is.
    expect(firstJob.variationSeed).not.toBe(secondJob.variationSeed)
    expect(firstJob.variationSeed).toMatch(/^[0-9a-f]{64}$/)

    // And both drew only from this House's six.
    const own = new Set(housePack.bedVersionIds)
    for (const versionId of pinnedMediaVersionIds(
      await manifestRows(secondJobId),
    )) {
      expect(own.has(versionId)).toBe(true)
    }
  }, 900_000)
})

// --- 6. A withdrawal reaches the NEXT render --------------------------------

describe('disabling a bed reaches the next recording, not the last one', () => {
  it('re-plans without the withdrawn bed and leaves the finished one alone', async () => {
    const run = await golden()
    const before = await manifestRows(run.jobId)
    const beforePinned = [...pinnedMediaVersionIds(before)]
    expect(beforePinned.length).toBeGreaterThan(0)

    // Withdraw one bed that the finished recording actually used.
    const withdrawn = beforePinned[0]
    await setMediaRuntimeEnabled(adminId, ctx, withdrawn, false)

    const next = await bookAndPay(nextService(housePack))
    const nextJobId = await soleJobFor(next.appointmentId)
    const status = await driveToSettled(nextJobId, 'withdrawn')

    if (status === 'READY') {
      // Re-planned: the withdrawn bed is gone, and what replaced it is
      // still this House's.
      const pinned = pinnedMediaVersionIds(await manifestRows(nextJobId))
      expect(pinned.has(withdrawn)).toBe(false)
      const own = new Set(housePack.bedVersionIds)
      for (const versionId of pinned) expect(own.has(versionId)).toBe(true)
    } else {
      // Or failed closed. What it must never do is use it anyway.
      expect(status).toBe('FAILED')
      const pinned = pinnedMediaVersionIds(await manifestRows(nextJobId))
      expect(pinned.has(withdrawn)).toBe(false)
    }

    // The recording already made is untouched: a withdrawal governs
    // what happens next, and never rewrites what was already approved
    // and delivered.
    const after = await manifestRows(run.jobId)
    expect(after.map((row) => row.manifestJsonText)).toEqual(
      before.map((row) => row.manifestJsonText),
    )
    expect((await jobRow(run.jobId)).status).toBe('READY')

    // Put it back so later assertions see the full pack.
    await setMediaRuntimeEnabled(adminId, ctx, withdrawn, true)
  }, 900_000)
})

// --- 7. No generation provider is involved ----------------------------------

describe('the static path reaches no generation provider', () => {
  it('recorded no visual generation task at all', async () => {
    const run = await golden()
    const visual = await getDb()
      .select()
      .from(prayerGenerationVisualTasks)
      .where(eq(prayerGenerationVisualTasks.generationJobId, run.jobId))

    // A visual task row exists ONLY for a GENERATION_REQUIRED manifest
    // task. Zero rows is therefore not "the provider was disabled" — it
    // is "nothing in this recording ever needed one". That is the whole
    // point of the static-bed arrangement: governed end to end with no
    // provider reachable at all.
    expect(visual).toHaveLength(0)
  }, 600_000)
})


// --- 8. Context-deferred selector semantics ---------------------------------

describe('publication proves the selector contract, not a House', () => {
  /**
   * The shared template above already published with SACRED_HOUSE-only
   * slots and zero PLATFORM candidates — that IS the deferral working.
   * These pin the boundaries around it.
   */
  async function publishAttempt(
    slots: Array<SlotInput>,
    scope: {
      scopeType: 'PLATFORM' | 'SACRED_HOUSE'
      sacredHouseId: number | null
    },
  ): Promise<Error | null> {
    const template = await createPrayerTemplate(adminId, ctx, {
      code: nextCode('SEM'),
      scopeType: scope.scopeType,
      sacredHouseId: scope.sacredHouseId,
      serviceId: null,
    })
    createdTemplateIds.push(template.id)
    const version = await createTemplateVersion(adminId, ctx, template.id, {
      language: 'en',
      priority: 1,
      selectionWeight: 1,
      targetMinSeconds: 90,
      targetMaxSeconds: 120,
      slots,
      forbiddenPairs: [],
    })
    await submitTemplateVersion(adminId, ctx, version.id)
    await approveTemplateVersion(adminId, ctx, version.id)
    try {
      await publishTemplateVersion(adminId, ctx, version.id)
      return null
    } catch (caught) {
      return caught as Error
    }
  }

  it('publishes a PLATFORM template whose slots defer to a House', async () => {
    // No House content is visible from a PLATFORM context — that is the
    // whole point, and it must no longer read as unsatisfiable.
    const error = await publishAttempt(SHARED_SLOTS, {
      scopeType: 'PLATFORM',
      sacredHouseId: null,
    })
    expect(error).toBeNull()
  }, 300_000)

  it('still counts candidates when the context CAN see the scope', async () => {
    // A slot admitting PLATFORM on a PLATFORM template is not deferred:
    // the context can observe that scope, so the old satisfiability
    // check applies unchanged. A selector never widens its own reach by
    // being harder to check.
    const error = await publishAttempt(
      [
        {
          ...contentSlot('OPENING', 1, 'OPENING', 'WIDE_MASTER'),
          allowedScopes: ['SACRED_HOUSE', 'PLATFORM'],
        },
      ],
      { scopeType: 'PLATFORM', sacredHouseId: null },
    )
    expect(error).not.toBeNull()
    expect(error?.message ?? '').toContain('currently eligible candidates')
  }, 300_000)

  it('leaves House-scoped templates counting exactly as before', async () => {
    // A SACRED_HOUSE template CAN see House content, so nothing defers.
    // It publishes for the House that has content...
    const ok = await publishAttempt(SHARED_SLOTS, {
      scopeType: 'SACRED_HOUSE',
      sacredHouseId: housePack.houseId,
    })
    expect(ok).toBeNull()

    // ...and is still refused for the House that has none.
    const refused = await publishAttempt(SHARED_SLOTS, {
      scopeType: 'SACRED_HOUSE',
      sacredHouseId: emptyHouse.houseId,
    })
    expect(refused).not.toBeNull()
    expect(refused?.message ?? '').toContain('currently eligible candidates')
  }, 300_000)

  it('leaves PINNED_VERSIONS untouched', async () => {
    // Pins name exact versions, so there is nothing to defer: whether a
    // named version is eligible is knowable without a House.
    const pinned: SlotInput = {
      slotKey: 'PINNED_OPENING',
      position: 1,
      slotKind: 'CONTENT',
      minSelect: 1,
      maxSelect: 1,
      contentType: null,
      selectorMode: 'PINNED_VERSIONS',
      themeCode: null,
      variantKind: null,
      silenceDurationSeconds: null,
      shotFamily: 'WIDE_MASTER',
      referenceRequirement: 'REQUIRED',
      allowedScopes: [],
      pinnedContentVersionIds: [housePack.contentVersionIds[0]],
    }
    const error = await publishAttempt([pinned], {
      scopeType: 'PLATFORM',
      sacredHouseId: null,
    })
    expect(error).toBeNull()
  }, 300_000)

  it('relaxes satisfiability, never authorship', async () => {
    // A slot with no allowed scopes is not deferred — it is incomplete,
    // and is refused before it can ever reach publication.
    let authoringError: Error | null = null
    const template = await createPrayerTemplate(adminId, ctx, {
      code: nextCode('SEMBAD'),
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
    })
    createdTemplateIds.push(template.id)
    try {
      await createTemplateVersion(adminId, ctx, template.id, {
        language: 'en',
        priority: 1,
        selectionWeight: 1,
        targetMinSeconds: 90,
        targetMaxSeconds: 120,
        slots: [
          {
            ...contentSlot('OPENING', 1, 'OPENING', 'WIDE_MASTER'),
            allowedScopes: [],
          },
        ],
        forbiddenPairs: [],
      })
    } catch (caught) {
      authoringError = caught as Error
    }
    expect(authoringError).not.toBeNull()
    expect(authoringError?.message ?? '').toContain('explicit allowed scopes')
  }, 300_000)
})

// --- 9. Shot family is Visual Bible authority, not library authority --------

describe('shotFamily governs references, and library media is agnostic', () => {
  it('is never consulted by static library-media selection', () => {
    const recipes = readFileSync(
      join(process.cwd(), 'src/services/video-recipes.ts'),
      'utf8',
    )
    // The library fallback filters on asset kind, content type, theme
    // and scope. shotFamily appearing there would be a SECOND role
    // authority competing with the Visual Bible's, so the block that
    // picks a library bed must not mention it.
    const start = recipes.indexOf('// B. Library IMAGE/VIDEO fallback')
    expect(start).toBeGreaterThan(-1)
    const end = recipes.indexOf('visualMode = ', start)
    expect(end).toBeGreaterThan(start)
    expect(recipes.slice(start, end)).not.toContain('shotFamily')
  })

  it('IS the key the Visual Bible reference path matches on', () => {
    const storyboards = readFileSync(
      join(process.cwd(), 'src/services/generation-storyboards.ts'),
      'utf8',
    )
    const visual = readFileSync(
      join(process.cwd(), 'src/services/visual-generation.ts'),
      'utf8',
    )
    // ONE authority for the six roles: a slot's shot family selects the
    // Visual Bible reference carrying that exact role. Both the compile
    // stage and the submission gate match on it.
    expect(storyboards).toContain('reference.role === segment.shotFamily')
    expect(visual).toContain('intent.shotFamily !== reference.role')
  })
})
