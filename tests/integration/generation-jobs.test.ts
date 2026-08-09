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
  paymentAttempts,
  prayerGenerationJobEvents,
  prayerGenerationJobs,
  prayerGenerationRecipeSnapshots,
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
  userProfiles,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { ForbiddenError } from '@/auth/guards'
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
  publishMediaVersion,
  setMediaRightsStatus,
  setMediaRuntimeEnabled,
  submitMediaVersion,
} from '@/services/media-assets'
import { settleVerifiedPayment } from '@/services/payments'
import { createMockProvider } from '@/providers/payments/mock'
import {
  resetPaymentRegistryForTests,
  setPaymentRegistryForTests,
} from '@/providers/payments/registry'
import {
  DEFAULT_LEASE_MS,
  GenerationJobError,
  adminCancelGenerationJob,
  adminRetryGenerationJob,
  claimNextGenerationJob,
  computeVariationSeed,
  isLegalTransition,
  loadAndValidateGenerationRecipe,
  loadGenerationRecipeSnapshot,
  persistPreparedRecipeUnderLease,
  recoverExpiredGenerationLeases,
  renewGenerationLease,
  runGenerationPreparationOnce,
  transitionGenerationJobUnderLease,
} from '@/services/generation-jobs'
import { buildValidatedVideoRecipe } from '@/services/video-recipes'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  sqlToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { PreparationDependencies } from '@/services/generation-jobs'
import type { VerifiedPaymentResult } from '@/providers/payments/types'
import type { SacredProfileInput } from '@/services/sacred-content'

/**
 * Step 12 integration tests: atomic confirmation enqueue, frozen job
 * context, DB queue/lease concurrency, preparation via the REAL
 * Step 11 engine, immutable snapshots, fail-closed loaders, bounded
 * retries, admin RBAC and later-phase guards. Synthetic fixtures only.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `generation test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const createdItemIds: Array<number> = []
const createdAssetIds: Array<number> = []
const createdTemplateIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'

let adminId: number
let cmId: number
let houseId: number
let serviceId: number
let noTemplateServiceId: number
let storageRoot: string
let storage: LocalMediaStorageProvider

const RUN_KEY = crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')
const CODE_PREFIX = `T12_${RUN_KEY}`
let codeCounter = 0
function nextCode(prefix = 'X'): string {
  codeCounter += 1
  return `${CODE_PREFIX}_${prefix}_${codeCounter}`
}

const today = currentLocalDate(HOUSE_TZ, Date.now())
let slotCursor = 0
function nextSlot(): string {
  const hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00']
  const index = slotCursor++
  const date = addDays(today, 2 + Math.floor(index / hours.length))
  return utcMsToSql(localToUtcMs(HOUSE_TZ, date, hours[index % hours.length]))
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s12-${crypto.randomUUID()}@test.local`,
      preferredName: 'S12 Fixture',
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

/** Cancels every other live QUEUED/RETRYING job from this suite so a
 * claim race targets exactly the job under test. */
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
          inArray(prayerGenerationJobs.status, ['QUEUED', 'RETRYING']),
        ),
      )
  }
}

async function jobForAppointment(appointmentId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.appointmentId, appointmentId))
  ).at(0)
}

async function reserveAndConfirm(
  userId: number,
  svc = serviceId,
): Promise<{ appointmentId: number }> {
  const reservation = await createReservation(userId, ctx, {
    serviceId: svc,
    startsAtUtc: nextSlot(),
  })
  await confirmReservation(reservation.appointmentId, ctx)
  return { appointmentId: reservation.appointmentId }
}

let mockAttemptCounter = 0
async function insertMockAttempt(appointmentId: number, userId: number) {
  const publicId = crypto.randomUUID()
  const reference = `it12_${publicId.replaceAll('-', '')}`
  await getDb().insert(paymentAttempts).values({
    publicId,
    appointmentId,
    userId,
    provider: 'MOCK',
    status: 'INITIALIZED',
    amountMinor: 500_000,
    currency: 'NGN',
    idempotencyKey: reference,
    providerReference: reference,
  })
  mockAttemptCounter += 1
  return reference
}

function mockSuccess(reference: string): VerifiedPaymentResult {
  return {
    provider: 'MOCK',
    providerReference: reference,
    providerPaymentId: `it12-evt-${mockAttemptCounter}-${crypto.randomUUID().slice(0, 8)}`,
    providerCheckoutId: null,
    attemptPublicId: null,
    outcome: 'SUCCEEDED',
    amountMinor: 500_000,
    currency: 'NGN',
    paidAtSql: null,
    providerStatus: 'payment.succeeded',
    failureCode: null,
    failureMessage: null,
  }
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

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-genjob-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  setPaymentRegistryForTests(
    [createMockProvider({ nodeEnv: 'test', enabled: true })],
    true,
  )
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'T12\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'T12\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'T12\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T12H_${key}`.toUpperCase(),
    name: `T12 House ${key}`,
    slug: `t12h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  const svcInsert = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T12S_${key}`.toUpperCase(),
    name: `T12 Service ${key}`,
    slug: `t12s-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  serviceId = svcInsert[0].insertId
  const noTpl = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T12N_${key}`.toUpperCase(),
    name: `T12 NoTemplate Service ${key}`,
    slug: `t12n-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  noTemplateServiceId = noTpl[0].insertId

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

  // Governance fixtures so the REAL Step 11 engine resolves for
  // serviceId: TEXT_ONLY sacred PRAYER + SERVICE template + platform
  // visual. noTemplateServiceId deliberately has NO template.
  const theme = `T12_MAIN_${RUN_KEY}`
  const item = await createSacredContentItem(cmId, ctx, {
    code: nextCode('SC'),
    contentType: 'PRAYER',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    sortOrder: 0,
  })
  createdItemIds.push(item.id)
  const sacredVersion = await createSacredVersion(
    cmId,
    ctx,
    item.id,
    {
      language: 'en',
      title: 'Integration-test sacred block',
      body: `Integration-test prayer block ${crypto.randomUUID()}`,
    },
    sacredProfile({ themeCode: theme }),
  )
  await submitVersionForReview(cmId, ctx, sacredVersion.id)
  await approveVersion(adminId, ctx, sacredVersion.id)
  await publishVersion(adminId, ctx, sacredVersion.id)
  await setSacredRightsStatus(adminId, ctx, sacredVersion.id, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, sacredVersion.id, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, sacredVersion.id, true)

  const visualAsset = await createMediaAsset(cmId, ctx, {
    code: nextCode('MA'),
    assetKind: 'IMAGE',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    contentType: 'PRAYER',
    themeCode: theme,
  })
  createdAssetIds.push(visualAsset.id)
  const visualVersion = await createMediaVersion(
    cmId,
    ctx,
    visualAsset.id,
    new TextEncoder().encode(
      `synthetic-test-media-bytes ${crypto.randomUUID()}`,
    ),
    'image/png',
    {
      sourceType: 'IN_HOUSE',
      language: null,
      durationSeconds: null,
      width: 640,
      height: 480,
      containsIdentifiablePerson: false,
      consentStatus: 'NOT_APPLICABLE',
      consentReference: null,
      externalAiPolicy: 'NO_EXTERNAL_AI',
      voiceCloneAuthorized: false,
    },
  )
  await submitMediaVersion(cmId, ctx, visualVersion.id)
  await approveMediaVersion(adminId, ctx, visualVersion.id)
  await publishMediaVersion(adminId, ctx, visualVersion.id)
  await setMediaRightsStatus(adminId, ctx, visualVersion.id, 'PENDING_REVIEW')
  await setMediaRightsStatus(adminId, ctx, visualVersion.id, 'CLEARED')
  await setMediaRuntimeEnabled(adminId, ctx, visualVersion.id, true)

  const template = await createPrayerTemplate(cmId, ctx, {
    code: nextCode('TPL'),
    scopeType: 'SERVICE',
    sacredHouseId: null,
    serviceId,
  })
  createdTemplateIds.push(template.id)
  const templateVersion = await createTemplateVersion(cmId, ctx, template.id, {
    language: 'en',
    priority: 0,
    selectionWeight: 1,
    targetMinSeconds: 30,
    targetMaxSeconds: 600,
    slots: [
      {
        slotKey: 'MAIN_PRAYER',
        position: 1,
        slotKind: 'CONTENT',
        minSelect: 1,
        maxSelect: 1,
        contentType: 'PRAYER',
        selectorMode: 'ELIGIBLE_FILTER',
        themeCode: theme,
        variantKind: null,
        silenceDurationSeconds: null,
        allowedScopes: ['PLATFORM'],
        pinnedContentVersionIds: [],
      },
    ],
    forbiddenPairs: [],
  })
  await submitTemplateVersion(cmId, ctx, templateVersion.id)
  await approveTemplateVersion(adminId, ctx, templateVersion.id)
  await publishTemplateVersion(adminId, ctx, templateVersion.id)
})

afterAll(async () => {
  const db = getDb()
  resetPaymentRegistryForTests()
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
      const { appointmentPaymentSettlements } = await import('@/db/schema')
      await db
        .delete(appointmentPaymentSettlements)
        .where(inArray(appointmentPaymentSettlements.appointmentId, apptIds))
      await db
        .delete(paymentAttempts)
        .where(inArray(paymentAttempts.appointmentId, apptIds))
      await db.delete(appointments).where(inArray(appointments.id, apptIds))
    }
    // Templates
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
    // Media
    if (createdAssetIds.length > 0) {
      await db
        .delete(mediaAssetVersions)
        .where(inArray(mediaAssetVersions.assetId, createdAssetIds))
      await db
        .delete(mediaAssets)
        .where(inArray(mediaAssets.id, createdAssetIds))
    }
    // Sacred content
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

describe('atomic confirmation enqueue', () => {
  it('confirmation creates exactly ONE queued job with frozen deterministic context', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = await jobForAppointment(appointmentId)
    expect(job).toBeDefined()
    expect(job!.status).toBe('QUEUED')
    expect(job!.serviceIdSnapshot).toBe(serviceId)
    expect(job!.sacredHouseIdSnapshot).toBe(houseId)
    // Guidance language snapshot is the authoritative job language.
    expect(job!.languageSnapshot).toBe('en')
    // Deterministic frozen seed: only the hash is stored.
    const appointment = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
    ).at(0)!
    expect(job!.variationSeed).toBe(
      computeVariationSeed({
        userId,
        appointmentId,
        serviceId,
        startsAtUtc: appointment.startsAtUtc,
      }),
    )
    expect(job!.variationSeed).toMatch(/^[0-9a-f]{64}$/)
    // Exactly one job; enqueue event exists.
    const jobs = await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.appointmentId, appointmentId))
    expect(jobs.length).toBe(1)
    const events = await getDb()
      .select()
      .from(prayerGenerationJobEvents)
      .where(eq(prayerGenerationJobEvents.generationJobId, job!.id))
    expect(events.some((event) => event.eventCode === 'job_enqueued')).toBe(
      true,
    )
  }, 120_000)

  it('PENDING_PAYMENT has no job; missing language rolls the whole confirmation back', async () => {
    const userId = await makeEligibleUser()
    const reservation = await createReservation(userId, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    expect(await jobForAppointment(reservation.appointmentId)).toBeUndefined()

    // Break the language source: confirmation must fail closed with
    // NO job, NO guidance set and status still PENDING_PAYMENT —
    // proving the enqueue lives INSIDE the confirmation transaction.
    await getDb()
      .update(userProfiles)
      .set({ preferredLanguage: null })
      .where(eq(userProfiles.userId, userId))
    let thrown: unknown = null
    try {
      await confirmReservation(reservation.appointmentId, ctx)
    } catch (error) {
      thrown = error
    }
    expect(thrown).not.toBeNull()
    expect(await jobForAppointment(reservation.appointmentId)).toBeUndefined()
    const set = (
      await getDb()
        .select()
        .from(appointmentGuidanceSets)
        .where(
          eq(appointmentGuidanceSets.appointmentId, reservation.appointmentId),
        )
    ).at(0)
    expect(set).toBeUndefined()
    const row = (
      await getDb()
        .select({ status: appointments.status })
        .from(appointments)
        .where(eq(appointments.id, reservation.appointmentId))
        .limit(1)
    ).at(0)
    expect(row?.status).toBe('PENDING_PAYMENT')
  }, 120_000)

  it('payment settlement creates the job; webhook replay cannot duplicate it', async () => {
    const userId = await makeEligibleUser()
    const reservation = await createReservation(userId, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    const reference = await insertMockAttempt(reservation.appointmentId, userId)
    const outcome = await settleVerifiedPayment(mockSuccess(reference))
    expect(outcome.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')
    const job = await jobForAppointment(reservation.appointmentId)
    expect(job?.status).toBe('QUEUED')
    // Replay the same settlement (webhook redelivery).
    await settleVerifiedPayment(mockSuccess(reference))
    const jobs = await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.appointmentId, reservation.appointmentId))
    expect(jobs.length).toBe(1)
  }, 120_000)

  it('no automatic backfill for pre-existing CONFIRMED appointments', async () => {
    // Simulate a pre-Step12 CONFIRMED row inserted directly.
    const userId = await makeEligibleUser()
    const start = nextSlot()
    const inserted = await getDb()
      .insert(appointments)
      .values({
        publicId: crypto.randomUUID(),
        userId,
        serviceId,
        sacredHouseId: houseId,
        status: 'CONFIRMED',
        startsAtUtc: start,
        endsAtUtc: utcMsToSql(sqlToUtcMs(start) + 60 * 60_000),
        userTimezone: HOUSE_TZ,
        houseTimezone: HOUSE_TZ,
        serviceNameSnapshot: 'T12 Legacy Service',
        serviceCodeSnapshot: 'T12_LEGACY',
        houseNameSnapshot: 'T12 Legacy House',
        durationMinutesSnapshot: 60,
        priceMinorSnapshot: 500_000,
        currencySnapshot: 'NGN',
      })
    const legacyId = inserted[0].insertId
    // Nothing spontaneously creates a job for it.
    await recoverExpiredGenerationLeases(new Date())
    expect(await jobForAppointment(legacyId)).toBeUndefined()
  })
})

describe('queue, lease and state machine', () => {
  it('concurrent claims yield one owner; stale tokens cannot transition; expired leases recover', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    const t0 = new Date()

    const [claimA, claimB] = await Promise.all([
      claimNextGenerationJob('worker-A', t0),
      claimNextGenerationJob('worker-B', t0),
    ])
    const claims = [claimA, claimB].filter(
      (claim) => claim != null && claim.job.id === job.id,
    )
    expect(claims.length).toBe(1)
    const winner = claims[0]!
    // Renew works with the live token, not with garbage.
    expect(await renewGenerationLease(job.id, winner.leaseToken, t0)).toBe(true)
    expect(await renewGenerationLease(job.id, crypto.randomUUID(), t0)).toBe(
      false,
    )
    // Wrong token cannot transition.
    expect(
      await transitionGenerationJobUnderLease(
        job.id,
        crypto.randomUUID(),
        'QUEUED',
        'PREPARING',
        t0,
      ),
    ).toBe(false)
    // Live token transitions QUEUED → PREPARING.
    expect(
      await transitionGenerationJobUnderLease(
        job.id,
        winner.leaseToken,
        'QUEUED',
        'PREPARING',
        t0,
        { eventCode: 'test_preparing' },
      ),
    ).toBe(true)
    // Illegal transitions refuse loudly.
    let illegal: unknown = null
    try {
      await transitionGenerationJobUnderLease(
        job.id,
        winner.leaseToken,
        'PREPARING',
        'READY',
        t0,
      )
    } catch (error) {
      illegal = error
    }
    expect(illegal).toBeInstanceOf(GenerationJobError)
    expect(isLegalTransition('STORYBOARDING', 'READY')).toBe(false)
    expect(isLegalTransition('UPLOADING', 'READY')).toBe(true)

    // Lease expiry: recovery returns the job to RETRYING and the old
    // token becomes powerless.
    const t1 = new Date(t0.getTime() + 10 * 60_000)
    expect(await recoverExpiredGenerationLeases(t1)).toBeGreaterThanOrEqual(1)
    const recovered = (await jobForAppointment(appointmentId))!
    expect(recovered.status).toBe('RETRYING')
    expect(recovered.resumeStatus).toBe('PREPARING')
    expect(recovered.leaseToken).toBeNull()
    expect(
      await transitionGenerationJobUnderLease(
        job.id,
        winner.leaseToken,
        'RETRYING',
        'PREPARING',
        t1,
      ),
    ).toBe(false)
  }, 120_000)
})

describe('preparation worker', () => {
  it('prepares via the REAL Step 11 engine into an immutable snapshot and STORYBOARDING', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)

    const outcome = await runGenerationPreparationOnce('worker-prep', {
      now: () => new Date(),
    })
    expect(outcome.status).toBe('PREPARED')
    if (outcome.status !== 'PREPARED') return
    expect(outcome.jobId).toBe(job.id)
    const prepared = (await jobForAppointment(appointmentId))!
    expect(prepared.status).toBe('STORYBOARDING')
    expect(prepared.preparedAt).not.toBeNull()
    expect(prepared.leaseToken).toBeNull()

    // Snapshot integrity: payload hash covers the exact stored text.
    const snapshot = (
      await getDb()
        .select()
        .from(prayerGenerationRecipeSnapshots)
        .where(eq(prayerGenerationRecipeSnapshots.generationJobId, job.id))
    ).at(0)!
    expect(snapshot.snapshotNumber).toBe(1)
    const loaded = await loadGenerationRecipeSnapshot(job.id)
    expect(loaded.status).toBe('OK')
    if (loaded.status === 'OK') {
      expect(loaded.recipe.recipeSha256).toBe(snapshot.recipeSha256)
      expect(loaded.recipe.variationSeed).toBe(job.variationSeed)
    }
    const validated = await loadAndValidateGenerationRecipe(job.id)
    expect(validated.status).toBe('VALID')

    // STORYBOARDING is not claimable — no duplicate snapshot, READY
    // unreachable in Step 12.
    const again = await runGenerationPreparationOnce('worker-prep', {
      now: () => new Date(),
    })
    expect(again.status).toBe('IDLE')
    const snapshots = await getDb()
      .select()
      .from(prayerGenerationRecipeSnapshots)
      .where(eq(prayerGenerationRecipeSnapshots.generationJobId, job.id))
    expect(snapshots.length).toBe(1)

    // Privacy: nothing in job/events/snapshot leaks PII or bodies.
    const events = await getDb()
      .select()
      .from(prayerGenerationJobEvents)
      .where(eq(prayerGenerationJobEvents.generationJobId, job.id))
    const payload = JSON.stringify({ prepared, events, snapshot })
    expect(payload).not.toContain('Integration-test prayer block')
    expect(payload).not.toContain('@test.local')
    expect(payload).not.toContain('+2348012345678')
    expect(payload).not.toContain('1990-03-21')
    expect(payload).not.toMatch(/[a-f0-9]{2}\/[a-f0-9]{32}\.[a-z0-9]{2,5}/)
  }, 240_000)

  it('RECIPE_UNAVAILABLE fails cleanly without a retry storm', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(
      userId,
      noTemplateServiceId,
    )
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    const outcome = await runGenerationPreparationOnce('worker-unavail', {
      now: () => new Date(),
    })
    expect(outcome.status).toBe('FAILED')
    if (outcome.status === 'FAILED') {
      expect(outcome.errorCode).toBe('RECIPE_UNAVAILABLE')
    }
    const failed = (await jobForAppointment(appointmentId))!
    expect(failed.status).toBe('FAILED')
    expect(failed.lastErrorCode).toBe('RECIPE_UNAVAILABLE')
    expect(failed.nextAttemptAt).toBeNull()
    // No retry storm: nothing claimable.
    expect(
      (
        await runGenerationPreparationOnce('worker-unavail', {
          now: () => new Date(),
        })
      ).status,
    ).toBe('IDLE')
    void job
  }, 120_000)

  it('INVALID validation retries on the bounded schedule until max attempts fail it', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ maxAttempts: 2 })
      .where(eq(prayerGenerationJobs.id, job.id))

    const alwaysInvalid: PreparationDependencies = {
      validateRecipe: async () => ({
        status: 'INVALID',
        reasons: ['synthetic_reason'],
      }),
    }
    const t0 = new Date()
    const first = await runGenerationPreparationOnce(
      'worker-inv',
      { now: () => t0 },
      alwaysInvalid,
    )
    expect(first.status).toBe('RETRY_SCHEDULED')
    const afterFirst = (await jobForAppointment(appointmentId))!
    expect(afterFirst.status).toBe('RETRYING')
    expect(afterFirst.attemptCount).toBe(1)
    expect(afterFirst.lastErrorCode).toBe('RECIPE_INVALID')
    // Deterministic backoff: first retry due exactly +1 minute.
    expect(afterFirst.nextAttemptAt).not.toBeNull()
    expect(
      Math.abs(
        new Date(afterFirst.nextAttemptAt!).getTime() - (t0.getTime() + 60_000),
      ),
    ).toBeLessThanOrEqual(1_000)
    // Not due yet → idle.
    expect(
      (
        await runGenerationPreparationOnce(
          'worker-inv',
          { now: () => t0 },
          alwaysInvalid,
        )
      ).status,
    ).toBe('IDLE')
    // Due → second (final) attempt exhausts max attempts → FAILED.
    const t1 = new Date(t0.getTime() + 2 * 60_000)
    const second = await runGenerationPreparationOnce(
      'worker-inv',
      { now: () => t1 },
      alwaysInvalid,
    )
    expect(second.status).toBe('FAILED')
    const failed = (await jobForAppointment(appointmentId))!
    expect(failed.status).toBe('FAILED')
    expect(failed.attemptCount).toBe(2)
  }, 120_000)
})

describe('snapshot loaders fail closed', () => {
  it('tampered payload/text → INTEGRITY_FAILURE; upstream change → INVALID; never healed', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    expect(
      (
        await runGenerationPreparationOnce('worker-snap', {
          now: () => new Date(),
        })
      ).status,
    ).toBe('PREPARED')

    const snapshot = (
      await getDb()
        .select()
        .from(prayerGenerationRecipeSnapshots)
        .where(eq(prayerGenerationRecipeSnapshots.generationJobId, job.id))
    ).at(0)!

    // Tamper the stored TEXT → payload hash mismatch.
    await getDb()
      .update(prayerGenerationRecipeSnapshots)
      .set({
        recipeJsonText: snapshot.recipeJsonText.replace(
          '"RECIPE_READY"',
          '"RECIPE_READY" ',
        ),
      })
      .where(eq(prayerGenerationRecipeSnapshots.id, snapshot.id))
    expect((await loadGenerationRecipeSnapshot(job.id)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    // Restore text; tamper the stored payload hash instead.
    await getDb()
      .update(prayerGenerationRecipeSnapshots)
      .set({ recipeJsonText: snapshot.recipeJsonText })
      .where(eq(prayerGenerationRecipeSnapshots.id, snapshot.id))
    await getDb()
      .update(prayerGenerationRecipeSnapshots)
      .set({ payloadSha256: 'f'.repeat(64) })
      .where(eq(prayerGenerationRecipeSnapshots.id, snapshot.id))
    expect((await loadGenerationRecipeSnapshot(job.id)).status).toBe(
      'INTEGRITY_FAILURE',
    )
    // Restore; the loader never auto-healed anything.
    await getDb()
      .update(prayerGenerationRecipeSnapshots)
      .set({ payloadSha256: snapshot.payloadSha256 })
      .where(eq(prayerGenerationRecipeSnapshots.id, snapshot.id))
    expect((await loadGenerationRecipeSnapshot(job.id)).status).toBe('OK')

    // Upstream authority change (visual media disabled) → INVALID.
    const loaded = await loadGenerationRecipeSnapshot(job.id)
    if (loaded.status !== 'OK') throw new Error('expected OK')
    const visualVersionId =
      loaded.recipe.segments[0].visual!.mediaAssetVersionId
    await setMediaRuntimeEnabled(adminId, ctx, visualVersionId, false)
    const invalid = await loadAndValidateGenerationRecipe(job.id)
    expect(invalid.status).toBe('INVALID')
    await setMediaRuntimeEnabled(adminId, ctx, visualVersionId, true)
    expect((await loadAndValidateGenerationRecipe(job.id)).status).toBe('VALID')
  }, 240_000)
})

describe('admin operations', () => {
  it('retry/cancel enforce RBAC, reasons and terminal rules', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(
      userId,
      noTemplateServiceId,
    )
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    // Fail it via RECIPE_UNAVAILABLE.
    await runGenerationPreparationOnce('worker-admin', {
      now: () => new Date(),
    })
    expect((await jobForAppointment(appointmentId))!.status).toBe('FAILED')

    // CM lacks operational authority.
    let denied: unknown = null
    try {
      await adminRetryGenerationJob(cmId, ctx, job.id)
    } catch (error) {
      denied = error
    }
    expect(denied).toBeInstanceOf(ForbiddenError)
    denied = null
    try {
      await adminCancelGenerationJob(cmId, ctx, job.id, 'x')
    } catch (error) {
      denied = error
    }
    expect(denied).toBeInstanceOf(ForbiddenError)

    // ADMIN retry resets the attempt budget and requeues preparation.
    await adminRetryGenerationJob(adminId, ctx, job.id)
    const retried = (await jobForAppointment(appointmentId))!
    expect(retried.status).toBe('RETRYING')
    expect(retried.attemptCount).toBe(0)
    expect(retried.resumeStatus).toBe('PREPARING')

    // Cancellation requires a reason and a non-terminal job.
    let noReason: unknown = null
    try {
      await adminCancelGenerationJob(adminId, ctx, job.id, '   ')
    } catch (error) {
      noReason = error
    }
    expect(noReason).toBeInstanceOf(GenerationJobError)
    await adminCancelGenerationJob(
      adminId,
      ctx,
      job.id,
      'synthetic technical cancellation',
    )
    const cancelled = (await jobForAppointment(appointmentId))!
    expect(cancelled.status).toBe('CANCELLED')
    let terminal: unknown = null
    try {
      await adminCancelGenerationJob(adminId, ctx, job.id, 'again')
    } catch (error) {
      terminal = error
    }
    expect(terminal).toBeInstanceOf(GenerationJobError)
    // Retrying a CANCELLED job is refused (FAILED only).
    let notFailed: unknown = null
    try {
      await adminRetryGenerationJob(adminId, ctx, job.id)
    } catch (error) {
      notFailed = error
    }
    expect(notFailed).toBeInstanceOf(GenerationJobError)
  }, 120_000)
})

describe('guards', () => {
  it('no READY jobs exist; Step 12 modules call no providers, Redis or BullMQ', async () => {
    const readyJobs = await getDb()
      .select({ id: prayerGenerationJobs.id })
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.status, 'READY'))
    expect(readyJobs.length).toBe(0)

    const files = [
      'src/services/generation-jobs.ts',
      'src/services/generation-job-actions.ts',
      'src/workers/prayer-generation-worker.ts',
      'src/db/schema/generation.ts',
      'src/routes/admin.generation-jobs.tsx',
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
    }
    const routeTree = readFileSync(
      join(process.cwd(), 'src', 'routeTree.gen.ts'),
      'utf8',
    )
    expect(routeTree).not.toMatch(/prayer.?room/i)
    expect(routeTree).not.toMatch(/fullPath: '\/generation/)
    expect(routeTree).not.toMatch(/fullPath: '\/video/)
  })
})

// --- Step 12 hardening: fresh lease time, heartbeat, atomic finalize --------

function makeFakeClock(startMs: number) {
  let t = startMs
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms
    },
  }
}

async function snapshotCount(jobId: number): Promise<number> {
  return (
    await getDb()
      .select({ id: prayerGenerationRecipeSnapshots.id })
      .from(prayerGenerationRecipeSnapshots)
      .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
  ).length
}

describe('lease hardening', () => {
  it('a worker whose lease expires mid-build cannot persist; recovery consumes an attempt', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    const clock = makeFakeClock(Date.now())

    // The build takes "longer than the lease": the fake clock jumps
    // past expiry, so the post-build heartbeat fails with a FRESH
    // now() — the worker is stale and persists NOTHING.
    const outcome = await runGenerationPreparationOnce('worker-slow', clock, {
      buildRecipe: async (input) => {
        clock.advance(DEFAULT_LEASE_MS + 60_000)
        return buildValidatedVideoRecipe(input)
      },
    })
    expect(outcome.status).toBe('LEASE_LOST')
    expect(await snapshotCount(job.id)).toBe(0)
    const stuck = (await jobForAppointment(appointmentId))!
    expect(stuck.status).toBe('PREPARING')

    // Recovery counts the crashed attempt against the budget.
    expect(
      await recoverExpiredGenerationLeases(clock.now()),
    ).toBeGreaterThanOrEqual(1)
    const recovered = (await jobForAppointment(appointmentId))!
    expect(recovered.status).toBe('RETRYING')
    expect(recovered.attemptCount).toBe(1)
    expect(recovered.resumeStatus).toBe('PREPARING')
    expect(recovered.lastErrorCode).toBe('LEASE_EXPIRED')
    expect(recovered.leaseToken).toBeNull()
  }, 240_000)

  it('heartbeats keep a legitimately long preparation alive across lease windows', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    const clock = makeFakeClock(Date.now())

    // Build + validate together take 1.5 lease windows; the bounded
    // heartbeats before/after each expensive stage renew with fresh
    // now() readings and keep the lease live to the atomic finalize.
    const outcome = await runGenerationPreparationOnce('worker-long', clock, {
      buildRecipe: async (input) => {
        clock.advance(Math.floor(DEFAULT_LEASE_MS * 0.75))
        return buildValidatedVideoRecipe(input)
      },
      validateRecipe: async () => {
        clock.advance(Math.floor(DEFAULT_LEASE_MS * 0.75))
        return { status: 'VALID' }
      },
    })
    expect(outcome.status).toBe('PREPARED')
    const prepared = (await jobForAppointment(appointmentId))!
    expect(prepared.status).toBe('STORYBOARDING')
    expect(await snapshotCount(job.id)).toBe(1)
  }, 240_000)

  it('a recovered lease makes the old worker stale — atomic finalize inserts nothing', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    const clock = makeFakeClock(Date.now())

    // Worker A claims and moves to PREPARING…
    const claimed = await claimNextGenerationJob('worker-A', clock.now())
    expect(claimed?.job.id).toBe(job.id)
    const leaseToken = claimed!.leaseToken
    expect(
      await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'QUEUED',
        'PREPARING',
        clock.now(),
      ),
    ).toBe(true)
    // …builds a perfectly VALID recipe…
    const recipe = await buildValidatedVideoRecipe({
      serviceId: job.serviceIdSnapshot,
      language: job.languageSnapshot,
      variationSeed: job.variationSeed,
    })
    expect(recipe.status).toBe('RECIPE_READY')
    if (recipe.status !== 'RECIPE_READY') return
    // …but its lease expires and is recovered before finalization.
    clock.advance(DEFAULT_LEASE_MS + 60_000)
    expect(
      await recoverExpiredGenerationLeases(clock.now()),
    ).toBeGreaterThanOrEqual(1)

    // The stale worker's atomic finalize must insert NOTHING.
    const persisted = await persistPreparedRecipeUnderLease(
      job.id,
      leaseToken,
      1,
      recipe,
      clock,
    )
    expect(persisted).toBeNull()
    expect(await snapshotCount(job.id)).toBe(0)
    const after = (await jobForAppointment(appointmentId))!
    expect(after.status).toBe('RETRYING')
    expect(after.attemptCount).toBe(1)
  }, 240_000)

  it('repeatedly expiring processing leases exhaust the retry budget (maxAttempts=2) without a crash loop', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    await getDb()
      .update(prayerGenerationJobs)
      .set({ maxAttempts: 2 })
      .where(eq(prayerGenerationJobs.id, job.id))
    const clock = makeFakeClock(Date.now())

    // Crash 1: claim → PREPARING → lease lapses → RETRYING, attempt 1.
    const claim1 = await claimNextGenerationJob('crash-1', clock.now())
    expect(claim1?.job.id).toBe(job.id)
    expect(
      await transitionGenerationJobUnderLease(
        job.id,
        claim1!.leaseToken,
        'QUEUED',
        'PREPARING',
        clock.now(),
      ),
    ).toBe(true)
    clock.advance(DEFAULT_LEASE_MS + 60_000)
    expect(
      await recoverExpiredGenerationLeases(clock.now()),
    ).toBeGreaterThanOrEqual(1)
    let row = (await jobForAppointment(appointmentId))!
    expect(row.status).toBe('RETRYING')
    expect(row.attemptCount).toBe(1)

    // Crash 2: due again → PREPARING → lease lapses → FAILED, attempt 2.
    clock.advance(2 * 60_000)
    const claim2 = await claimNextGenerationJob('crash-2', clock.now())
    expect(claim2?.job.id).toBe(job.id)
    expect(
      await transitionGenerationJobUnderLease(
        job.id,
        claim2!.leaseToken,
        'RETRYING',
        'PREPARING',
        clock.now(),
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
    const events = await getDb()
      .select()
      .from(prayerGenerationJobEvents)
      .where(eq(prayerGenerationJobEvents.generationJobId, job.id))
    expect(
      events.some((event) => event.eventCode === 'lease_expired_max_attempts'),
    ).toBe(true)
    // No infinite loop: nothing left to recover for this job.
    expect(await recoverExpiredGenerationLeases(clock.now())).toBe(0)

    // FAILED → CANCELLED is an EXPLICIT legal edge (central map).
    expect(isLegalTransition('FAILED', 'CANCELLED')).toBe(true)
    await adminCancelGenerationJob(
      adminId,
      ctx,
      job.id,
      'synthetic close-out of exhausted job',
    )
    expect((await jobForAppointment(appointmentId))!.status).toBe('CANCELLED')
  }, 240_000)
})
