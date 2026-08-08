import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  appointmentGuidanceAcknowledgements,
  appointmentGuidanceAssignments,
  appointmentGuidanceSets,
  appointments,
  auditLogs,
  paymentAttempts,
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
import { assignRoleToUser, userHasPermission } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import { acceptRequiredConsents, savePersonalDetails } from '@/services/profile'
import {
  addAvailabilityWindow,
  getOrCreateBookingSettings,
  updateBookingSettings,
} from '@/services/scheduling'
import {
  cancelAppointment,
  completeAppointment,
  confirmReservation,
  createReservation,
  markNoShow,
} from '@/services/appointments'
import {
  SpiritualContentError,
  approveVersion,
  archiveVersion,
  createContentItem,
  createVersion,
  getContentItemDetail,
  publishVersion,
  returnVersionToDraft,
  setContentItemActive,
  submitVersionForReview,
  updateContentItem,
  updateDraftVersion,
} from '@/services/spiritual-content'
import {
  acknowledgeGuidance,
  assignGuidanceForAppointmentUnderTx,
  getVisibleGuidance,
  GuidanceError,
} from '@/services/guidance'
import { settleVerifiedPayment } from '@/services/payments'
import { createMockProvider } from '@/providers/payments/mock'
import {
  resetPaymentRegistryForTests,
  setPaymentRegistryForTests,
} from '@/providers/payments/registry'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  sqlToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type {
  ContentItemInput,
  ContentVersionInput,
} from '@/services/spiritual-content'
import type { VerifiedPaymentResult } from '@/providers/payments/types'

/**
 * Step 7 integration tests: content workflow concurrency, deterministic
 * assignment priority, explicit language fallback, historical version
 * freeze, exactly-once zero-content behavior, confirmation atomicity,
 * visibility stages, acknowledgements, RBAC and audit privacy.
 *
 * Every fixture body is an obviously synthetic neutral string — no
 * cultural instructions are ever invented, in fixtures or anywhere.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `guidance test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'
const DISTINCTIVE_BODY_MARKER = `DISTINCTIVE_TEST_BODY_${crypto.randomUUID().slice(0, 8)}`

let adminId: number
let cmId: number
let userEn: number
let userYo: number
let houseId: number
let serviceId: number
let otherServiceId: number

const createdItemIds: Array<number> = []
const CODE_PREFIX = `T7_${crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')}`
let codeCounter = 0
function nextCode(): string {
  codeCounter += 1
  return `${CODE_PREFIX}_ITEM_${codeCounter}`
}

const today = currentLocalDate(HOUSE_TZ, Date.now())
const D = (n: number) => addDays(today, n)
let slotCursor = 0
function nextSlot(): string {
  const hours = [
    '09:00',
    '10:00',
    '11:00',
    '12:00',
    '13:00',
    '14:00',
    '15:00',
    '16:00',
  ]
  const index = slotCursor++
  const date = D(2 + Math.floor(index / hours.length))
  return utcMsToSql(localToUtcMs(HOUSE_TZ, date, hours[index % hours.length]))
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s7-${crypto.randomUUID()}@test.local`,
      preferredName: 'S7 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role) await assignRoleToUser(result.user.id, role)
  return result.user.id
}

async function makeEligibleUser(language: 'en' | 'yo'): Promise<number> {
  const id = await makeUser()
  await savePersonalDetails(
    id,
    {
      fullName: 'Adéwálé Olúṣọlá Adébáyọ̀',
      preferredName: 'Adéwálé',
      phone: '+2348012345678',
      countryCode: 'NG',
      timezone: 'Africa/Lagos',
      preferredLanguage: language,
      dateOfBirth: '1990-03-21',
    },
    ctx,
  )
  await acceptRequiredConsents(id, ctx)
  return id
}

async function makeItem(
  overrides: Partial<ContentItemInput> = {},
): Promise<number> {
  const result = await createContentItem(cmId, ctx, {
    code: nextCode(),
    contentType: 'PREPARATION',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    sortOrder: 0,
    ...overrides,
  })
  createdItemIds.push(result.id)
  return result.id
}

/** Full human workflow: CM drafts+submits, ADMIN approves+publishes. */
async function makePublished(
  itemId: number,
  overrides: Partial<ContentVersionInput> = {},
): Promise<number> {
  const version = await createVersion(cmId, ctx, itemId, {
    language: 'en',
    title: 'Test guidance title',
    body: `Integration-test guidance text. ${DISTINCTIVE_BODY_MARKER}`,
    visibilityStage: 'AFTER_CONFIRMATION',
    acknowledgementRequired: false,
    allowEnglishFallback: false,
    ...overrides,
  })
  await submitVersionForReview(cmId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  return version.id
}

async function reserveAndConfirm(
  userId: number,
): Promise<{ appointmentId: number; publicId: string }> {
  const reservation = await createReservation(userId, ctx, {
    serviceId,
    startsAtUtc: nextSlot(),
  })
  await confirmReservation(reservation.appointmentId, ctx)
  return {
    appointmentId: reservation.appointmentId,
    publicId: reservation.publicId,
  }
}

async function readSet(appointmentId: number) {
  return (
    await getDb()
      .select()
      .from(appointmentGuidanceSets)
      .where(eq(appointmentGuidanceSets.appointmentId, appointmentId))
      .limit(1)
  ).at(0)
}

async function readAssignments(appointmentId: number) {
  return getDb()
    .select()
    .from(appointmentGuidanceAssignments)
    .where(eq(appointmentGuidanceAssignments.appointmentId, appointmentId))
    .orderBy(appointmentGuidanceAssignments.sortOrderSnapshot)
}

let mockAttemptCounter = 0
async function insertMockAttempt(appointmentId: number, userId: number) {
  const publicId = crypto.randomUUID()
  const reference = `it7_${publicId.replaceAll('-', '')}`
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
    providerPaymentId: `it7-evt-${mockAttemptCounter}-${crypto.randomUUID().slice(0, 8)}`,
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

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  setPaymentRegistryForTests(
    [createMockProvider({ nodeEnv: 'test', enabled: true })],
    true,
  )
  // Deactivate any stale fixtures a previously crashed run left behind
  // (platform-scoped leftovers would poison the zero-content test).
  await getDb()
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'T7\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')
  userEn = await makeEligibleUser('en')
  userYo = await makeEligibleUser('yo')

  const db = getDb()
  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T7H_${key}`.toUpperCase(),
    name: `T7 House ${key}`,
    slug: `t7h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  const svcInsert = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T7S_${key}`.toUpperCase(),
    name: `T7 Service ${key}`,
    slug: `t7s-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  serviceId = svcInsert[0].insertId
  const otherSvc = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T7O_${key}`.toUpperCase(),
    name: `T7 Other Service ${key}`,
    slug: `t7o-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  otherServiceId = otherSvc[0].insertId

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
  resetPaymentRegistryForTests()
  if (houseId) {
    const apptRows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.sacredHouseId, houseId))
    const apptIds = apptRows.map((row) => row.id)
    if (createdItemIds.length > 0) {
      const versionRows = await db
        .select({ id: spiritualContentVersions.id })
        .from(spiritualContentVersions)
        .where(inArray(spiritualContentVersions.contentItemId, createdItemIds))
      const versionIds = versionRows.map((row) => row.id)
      if (versionIds.length > 0) {
        await db
          .delete(appointmentGuidanceAcknowledgements)
          .where(
            inArray(
              appointmentGuidanceAcknowledgements.contentVersionId,
              versionIds,
            ),
          )
      }
      await db
        .delete(appointmentGuidanceAssignments)
        .where(
          inArray(appointmentGuidanceAssignments.contentItemId, createdItemIds),
        )
    }
    if (apptIds.length > 0) {
      await db
        .delete(appointmentGuidanceAcknowledgements)
        .where(
          inArray(appointmentGuidanceAcknowledgements.appointmentId, apptIds),
        )
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
    if (createdItemIds.length > 0) {
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
  await closeDb()
})

// --- Item structure (§75) ---------------------------------------------------

describe('content item structure', () => {
  it('rejects contradictory scope combinations', async () => {
    const cases: Array<Partial<ContentItemInput>> = [
      { scopeType: 'PLATFORM', sacredHouseId: 1 },
      { scopeType: 'PLATFORM', serviceId: 1 },
      { scopeType: 'SACRED_HOUSE', sacredHouseId: null },
      { scopeType: 'SACRED_HOUSE', sacredHouseId: 1, serviceId: 1 },
      { scopeType: 'SERVICE', serviceId: null },
      { scopeType: 'SERVICE', serviceId: 1, sacredHouseId: 1 },
    ]
    for (const bad of cases) {
      let thrown: unknown = null
      try {
        await createContentItem(cmId, ctx, {
          code: nextCode(),
          contentType: 'PREPARATION',
          scopeType: 'PLATFORM',
          sacredHouseId: null,
          serviceId: null,
          sortOrder: 0,
          ...bad,
        })
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(SpiritualContentError)
    }
  })

  it('rejects duplicate codes', async () => {
    const code = nextCode()
    const first = await createContentItem(cmId, ctx, {
      code,
      contentType: 'PREPARATION',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 0,
    })
    createdItemIds.push(first.id)
    let thrown: unknown = null
    try {
      await createContentItem(cmId, ctx, {
        code,
        contentType: 'PREPARATION',
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
        sortOrder: 0,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SpiritualContentError)
  })

  it('freezes structural identity once a version progresses beyond DRAFT', async () => {
    const itemId = await makeItem({ contentType: 'ARRIVAL_GUIDANCE' })
    const version = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Structure freeze test',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    // Pre-freeze: structural correction is allowed.
    await updateContentItem(cmId, ctx, itemId, {
      code: nextCode(),
      contentType: 'WHAT_TO_EXPECT',
      scopeType: 'SACRED_HOUSE',
      sacredHouseId: houseId,
      serviceId: null,
      sortOrder: 5,
    })
    await submitVersionForReview(cmId, ctx, version.id)
    // Post-submission: structure is frozen…
    const frozenDetail = await getContentItemDetail(itemId)
    let thrown: unknown = null
    try {
      await updateContentItem(cmId, ctx, itemId, {
        code: nextCode(),
        contentType: 'PREPARATION',
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
        sortOrder: 5,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SpiritualContentError)
    // …but operational sort order stays editable.
    await updateContentItem(cmId, ctx, itemId, {
      code: frozenDetail.item.code,
      contentType: frozenDetail.item.contentType as never,
      scopeType: frozenDetail.item.scopeType,
      sacredHouseId: frozenDetail.item.sacredHouseId,
      serviceId: frozenDetail.item.serviceId,
      sortOrder: 9,
    })
    const after = await getContentItemDetail(itemId)
    expect(after.item.sortOrder).toBe(9)
    expect(after.structureFrozen).toBe(true)
  })
})

// --- Version workflow (§74/§62/§63) -----------------------------------------

describe('version workflow', () => {
  it('walks the full human workflow with metadata and immutability at each stage', async () => {
    const itemId = await makeItem()
    const version = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Workflow test',
      body: 'Test preparation content A\n\nSecond line preserved.',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: true,
      allowEnglishFallback: false,
    })
    // DRAFT editable, line breaks preserved.
    await updateDraftVersion(cmId, ctx, version.id, {
      title: 'Workflow test edited',
      body: 'Line one\n\nLine three after a blank line.',
      visibilityStage: 'BEFORE_APPOINTMENT',
      acknowledgementRequired: true,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, version.id)

    // UNDER_REVIEW: immutable.
    let editUnderReview: unknown = null
    try {
      await updateDraftVersion(cmId, ctx, version.id, {
        title: 'x',
        body: 'y',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      })
    } catch (error) {
      editUnderReview = error
    }
    expect(editUnderReview).toBeInstanceOf(SpiritualContentError)

    // Return requires a reason.
    let noReason: unknown = null
    try {
      await returnVersionToDraft(adminId, ctx, version.id, '   ')
    } catch (error) {
      noReason = error
    }
    expect(noReason).toBeInstanceOf(SpiritualContentError)
    await returnVersionToDraft(
      adminId,
      ctx,
      version.id,
      'Please clarify wording',
    )
    let returned = (await getContentItemDetail(itemId)).versions.find(
      (v) => v.id === version.id,
    )
    expect(returned?.status).toBe('DRAFT')
    expect(returned?.reviewNote).toBe('Please clarify wording')

    // Resubmission clears the review note.
    await submitVersionForReview(cmId, ctx, version.id)
    returned = (await getContentItemDetail(itemId)).versions.find(
      (v) => v.id === version.id,
    )
    expect(returned?.reviewNote).toBeNull()
    expect(returned?.submittedAt).not.toBeNull()

    await approveVersion(adminId, ctx, version.id)
    const approved = (await getContentItemDetail(itemId)).versions.find(
      (v) => v.id === version.id,
    )
    expect(approved?.status).toBe('APPROVED')
    expect(approved?.approvedBy).toBe(adminId)

    // APPROVED immutable.
    let editApproved: unknown = null
    try {
      await updateDraftVersion(cmId, ctx, version.id, {
        title: 'x',
        body: 'y',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      })
    } catch (error) {
      editApproved = error
    }
    expect(editApproved).toBeInstanceOf(SpiritualContentError)

    await publishVersion(adminId, ctx, version.id)
    const published = (await getContentItemDetail(itemId)).versions.find(
      (v) => v.id === version.id,
    )
    expect(published?.status).toBe('PUBLISHED')
    expect(published?.publishedBy).toBe(adminId)

    // PUBLISHED immutable; publishing a non-approved version refused.
    let editPublished: unknown = null
    try {
      await updateDraftVersion(cmId, ctx, version.id, {
        title: 'x',
        body: 'y',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      })
    } catch (error) {
      editPublished = error
    }
    expect(editPublished).toBeInstanceOf(SpiritualContentError)
    // Keep later assignment tests deterministic: this platform-scoped
    // fixture must not leak into their selections.
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('CONTENT_MANAGER can author and submit but never approve or publish', async () => {
    const itemId = await makeItem()
    const version = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'RBAC test',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, version.id)
    let approveDenied: unknown = null
    try {
      await approveVersion(cmId, ctx, version.id)
    } catch (error) {
      approveDenied = error
    }
    expect(approveDenied).toBeInstanceOf(ForbiddenError)
    await approveVersion(adminId, ctx, version.id)
    let publishDenied: unknown = null
    try {
      await publishVersion(cmId, ctx, version.id)
    } catch (error) {
      publishDenied = error
    }
    expect(publishDenied).toBeInstanceOf(ForbiddenError)
  })

  it('permissions matrix: authoring vs approval vs none', async () => {
    expect(await userHasPermission(cmId, 'spiritual_content.view')).toBe(true)
    expect(await userHasPermission(cmId, 'spiritual_content.manage')).toBe(true)
    expect(await userHasPermission(cmId, 'spiritual_content.approve')).toBe(
      false,
    )
    expect(await userHasPermission(cmId, 'spiritual_content.publish')).toBe(
      false,
    )
    expect(await userHasPermission(adminId, 'spiritual_content.approve')).toBe(
      true,
    )
    expect(await userHasPermission(adminId, 'spiritual_content.publish')).toBe(
      true,
    )
    expect(await userHasPermission(userEn, 'spiritual_content.view')).toBe(
      false,
    )
    // Content permissions never grant appointment operations.
    expect(await userHasPermission(cmId, 'appointments.view')).toBe(false)
  })

  it('enforces one working version per item/language and races safely', async () => {
    const itemId = await makeItem()
    await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'First working',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    let second: unknown = null
    try {
      await createVersion(cmId, ctx, itemId, {
        language: 'en',
        title: 'Second working',
        body: 'Test preparation content B',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      })
    } catch (error) {
      second = error
    }
    expect(second).toBeInstanceOf(SpiritualContentError)
    // A different language is independent.
    const yoVersion = await createVersion(cmId, ctx, itemId, {
      language: 'yo',
      title: 'Yorùbá working',
      body: 'Ìdánwò àkọsílẹ̀ — synthetic test text',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    expect(yoVersion.versionNumber).toBe(1)

    // Concurrent creation race on a fresh item: exactly one wins.
    const raceItem = await makeItem()
    const results = await Promise.allSettled([
      createVersion(cmId, ctx, raceItem, {
        language: 'en',
        title: 'Race A',
        body: 'Test preparation content A',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      }),
      createVersion(cmId, ctx, raceItem, {
        language: 'en',
        title: 'Race B',
        body: 'Test preparation content B',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBe(1)
    const rows = await getDb()
      .select()
      .from(spiritualContentVersions)
      .where(eq(spiritualContentVersions.contentItemId, raceItem))
    expect(rows.length).toBe(1)
    expect(rows[0].versionNumber).toBe(1)
  })

  it('publication replaces the previous published version atomically; races stay deterministic', async () => {
    const itemId = await makeItem()
    const v1 = await makePublished(itemId, { title: 'Version one' })
    // New version → full workflow → approved.
    const v2 = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Version two',
      body: 'Test preparation content B',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    expect(v2.versionNumber).toBe(2)
    await submitVersionForReview(cmId, ctx, v2.id)
    await approveVersion(adminId, ctx, v2.id)

    // Race the same publication twice: serialized on the item row,
    // exactly one wins, exactly one current PUBLISHED remains.
    const race = await Promise.allSettled([
      publishVersion(adminId, ctx, v2.id),
      publishVersion(adminId, ctx, v2.id),
    ])
    expect(race.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const published = await getDb()
      .select()
      .from(spiritualContentVersions)
      .where(
        and(
          eq(spiritualContentVersions.contentItemId, itemId),
          eq(spiritualContentVersions.language, 'en'),
          eq(spiritualContentVersions.status, 'PUBLISHED'),
        ),
      )
    expect(published.length).toBe(1)
    expect(published[0].id).toBe(v2.id)
    const archived = (await getContentItemDetail(itemId)).versions.find(
      (v) => v.id === v1,
    )
    expect(archived?.status).toBe('ARCHIVED')
    // The archived body is untouched.
    expect(archived?.title).toBe('Version one')
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('structural freeze is PERMANENT: review-return to DRAFT never unfreezes (§13)', async () => {
    const itemId = await makeItem({ contentType: 'ARRIVAL_GUIDANCE' })
    const version = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Permanent freeze test',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    // Pre-submission: structural edit succeeds.
    const newCode = nextCode()
    await updateContentItem(cmId, ctx, itemId, {
      code: newCode,
      contentType: 'WHAT_TO_EXPECT',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 0,
    })
    // Submit, then Admin returns it to DRAFT — the item has now been
    // reviewed once and must stay frozen FOREVER.
    await submitVersionForReview(cmId, ctx, version.id)
    await returnVersionToDraft(adminId, ctx, version.id, 'needs wording work')
    const detail = await getContentItemDetail(itemId)
    expect(detail.structureFrozen).toBe(true)
    let thrown: unknown = null
    try {
      await updateContentItem(cmId, ctx, itemId, {
        code: nextCode(),
        contentType: 'PREPARATION',
        scopeType: 'SACRED_HOUSE',
        sacredHouseId: houseId,
        serviceId: null,
        sortOrder: 0,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SpiritualContentError)
    // Structure unchanged; sort_order remains operationally editable.
    await updateContentItem(cmId, ctx, itemId, {
      code: newCode,
      contentType: 'WHAT_TO_EXPECT',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 7,
    })
    const after = await getContentItemDetail(itemId)
    expect(after.item.code).toBe(newCode)
    expect(after.item.contentType).toBe('WHAT_TO_EXPECT')
    expect(after.item.scopeType).toBe('PLATFORM')
    expect(after.item.sortOrder).toBe(7)
  })

  it('archiving a never-submitted DRAFT also freezes structure permanently (§4)', async () => {
    const itemId = await makeItem()
    const version = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Archive-from-draft freeze',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await archiveVersion(adminId, ctx, version.id)
    expect((await getContentItemDetail(itemId)).structureFrozen).toBe(true)
    let thrown: unknown = null
    try {
      await updateContentItem(cmId, ctx, itemId, {
        code: nextCode(),
        contentType: 'WHAT_TO_EXPECT',
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
        sortOrder: 0,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(SpiritualContentError)
  })

  it('active-toggle authority follows durable publication evidence (§5/§6)', async () => {
    // Unpublished item: CONTENT_MANAGER may toggle active.
    const unpublished = await makeItem()
    await setContentItemActive(cmId, ctx, unpublished, false)
    await setContentItemActive(cmId, ctx, unpublished, true)

    // An archived NEVER-published draft is not publication evidence:
    // CONTENT_MANAGER must still be allowed.
    const abandoned = await makeItem()
    const abandonedDraft = await createVersion(cmId, ctx, abandoned, {
      language: 'en',
      title: 'Abandoned before publication',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await archiveVersion(adminId, ctx, abandonedDraft.id)
    await setContentItemActive(cmId, ctx, abandoned, false)
    await setContentItemActive(cmId, ctx, abandoned, true)

    // After first REAL publication: CM denied, ADMIN allowed.
    const published = await makeItem()
    await makePublished(published, { title: 'Authority test' })
    let cmDenied: unknown = null
    try {
      await setContentItemActive(cmId, ctx, published, false)
    } catch (error) {
      cmDenied = error
    }
    expect(cmDenied).toBeInstanceOf(ForbiddenError)
    await setContentItemActive(adminId, ctx, published, false)
    await setContentItemActive(adminId, ctx, published, true)
    await setContentItemActive(adminId, ctx, published, false)
  })

  it('first publication racing a CM active toggle resolves to a valid serialized order (§6)', async () => {
    const itemId = await makeItem()
    const version = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Race authority',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, version.id)
    await approveVersion(adminId, ctx, version.id)

    const [publishResult, toggleResult] = await Promise.allSettled([
      publishVersion(adminId, ctx, version.id),
      setContentItemActive(cmId, ctx, itemId, false),
    ])
    // Publication itself always succeeds.
    expect(publishResult.status).toBe('fulfilled')
    const item = (await getContentItemDetail(itemId)).item
    if (toggleResult.status === 'fulfilled') {
      // Toggle serialized BEFORE publication: it took effect.
      expect(item.active).toBe(false)
    } else {
      // Publication won the lock first: the stale CM decision was
      // refused and the item stays active.
      expect(toggleResult.reason).toBeInstanceOf(ForbiddenError)
      expect(item.active).toBe(true)
    }
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('publication requires APPROVED — no approval bypass from DRAFT or UNDER_REVIEW', async () => {
    const itemId = await makeItem()
    const draft = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Bypass attempt',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    let draftPublish: unknown = null
    try {
      await publishVersion(adminId, ctx, draft.id)
    } catch (error) {
      draftPublish = error
    }
    expect(draftPublish).toBeInstanceOf(SpiritualContentError)
    await submitVersionForReview(cmId, ctx, draft.id)
    let reviewPublish: unknown = null
    try {
      await publishVersion(adminId, ctx, draft.id)
    } catch (error) {
      reviewPublish = error
    }
    expect(reviewPublish).toBeInstanceOf(SpiritualContentError)
    const row = (await getContentItemDetail(itemId)).versions.find(
      (v) => v.id === draft.id,
    )
    expect(row?.status).toBe('UNDER_REVIEW')
  })

  it('ARCHIVED is terminal and abandoned working versions can be archived', async () => {
    const itemId = await makeItem()
    const version = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Abandoned draft',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await archiveVersion(adminId, ctx, version.id)
    let again: unknown = null
    try {
      await archiveVersion(adminId, ctx, version.id)
    } catch (error) {
      again = error
    }
    expect(again).toBeInstanceOf(SpiritualContentError)
    let submitArchived: unknown = null
    try {
      await submitVersionForReview(cmId, ctx, version.id)
    } catch (error) {
      submitArchived = error
    }
    expect(submitArchived).toBeInstanceOf(SpiritualContentError)
  })

  it('rejects allow_english_fallback on non-English versions and enforces plain-text rules', async () => {
    const itemId = await makeItem()
    let yoFallback: unknown = null
    try {
      await createVersion(cmId, ctx, itemId, {
        language: 'yo',
        title: 'Bad fallback',
        body: 'Synthetic test text',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: true,
      })
    } catch (error) {
      yoFallback = error
    }
    expect(yoFallback).toBeInstanceOf(SpiritualContentError)

    // Script tags are stored as harmless literal text (React escaping
    // renders them inert; no HTML is ever interpreted).
    const xss = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: '<script>alert(1)</script>',
      body: '<script>alert(1)</script>\nSecond line stays.',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    const stored = (await getContentItemDetail(itemId)).versions.find(
      (v) => v.id === xss.id,
    )
    expect(stored?.title).toBe('<script>alert(1)</script>')
    expect(stored?.body).toBe('<script>alert(1)</script>\nSecond line stays.')

    // Empty body rejected.
    let empty: unknown = null
    try {
      await updateDraftVersion(cmId, ctx, xss.id, {
        title: 'ok',
        body: '   \n  ',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      })
    } catch (error) {
      empty = error
    }
    expect(empty).toBeInstanceOf(SpiritualContentError)
  })

  it('no route renders guidance through dangerouslySetInnerHTML or raw HTML', () => {
    const routesDir = join(process.cwd(), 'src', 'routes')
    for (const entry of readdirSync(routesDir)) {
      if (!/\.tsx?$/.test(entry)) continue
      const source = readFileSync(join(routesDir, entry), 'utf8')
      expect(source).not.toContain('dangerouslySetInnerHTML')
    }
  })

  it('Step 7 modules introduce no AI/generation/later-phase providers', () => {
    const files = [
      'src/services/spiritual-content.ts',
      'src/services/guidance.ts',
      'src/services/spiritual-content-actions.ts',
      'src/routes/admin.spiritual-content.index.tsx',
      'src/routes/admin.spiritual-content.new.tsx',
      'src/routes/admin.spiritual-content.$id.tsx',
      'src/routes/admin.spiritual-content.review.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(
        /kling|openart|remotion|ffmpeg|elevenlabs|text-to-speech|\btts\b|openai|anthropic|translate\(/i,
      )
    }
    const routeTree = readFileSync(
      join(process.cwd(), 'src', 'routeTree.gen.ts'),
      'utf8',
    )
    expect(routeTree).not.toMatch(/prayer.?room/i)
  })
})

// --- Assignment priority & language (§64/§65) -------------------------------

describe('guidance assignment', () => {
  it('applies deterministic scope priority per content type', async () => {
    // PREPARATION exists at all three scopes → SERVICE wins alone.
    const svcItemA = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      serviceId,
      sortOrder: 2,
    })
    const svcItemB = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      serviceId,
      sortOrder: 1,
    })
    const houseItemPrep = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SACRED_HOUSE',
      sacredHouseId: houseId,
    })
    const platformPrep = await makeItem({ contentType: 'PREPARATION' })
    // WHAT_TO_EXPECT only at House scope.
    const houseItemExpect = await makeItem({
      contentType: 'WHAT_TO_EXPECT',
      scopeType: 'SACRED_HOUSE',
      sacredHouseId: houseId,
    })
    // GENERAL_SPIRITUAL_NOTICE only at Platform scope.
    const platformNotice = await makeItem({
      contentType: 'GENERAL_SPIRITUAL_NOTICE',
    })
    const vSvcA = await makePublished(svcItemA, { title: 'Service item A' })
    const vSvcB = await makePublished(svcItemB, { title: 'Service item B' })
    await makePublished(houseItemPrep, { title: 'House preparation' })
    await makePublished(platformPrep, { title: 'Platform preparation' })
    const vHouseExpect = await makePublished(houseItemExpect, {
      title: 'House expectations',
    })
    const vNotice = await makePublished(platformNotice, {
      title: 'Platform notice',
    })

    const { appointmentId } = await reserveAndConfirm(userEn)
    const assignments = await readAssignments(appointmentId)
    const set = await readSet(appointmentId)
    expect(set?.selectionResult).toBe('ASSIGNED')
    expect(set?.preferredLanguageSnapshot).toBe('en')

    const prep = assignments.filter((a) =>
      [svcItemA, svcItemB, houseItemPrep, platformPrep].includes(
        a.contentItemId,
      ),
    )
    // SERVICE scope wins for PREPARATION: both service items, house and
    // platform preparation EXCLUDED.
    expect(prep.map((a) => a.contentVersionId).sort()).toEqual(
      [vSvcA, vSvcB].sort(),
    )
    expect(prep.every((a) => a.selectedScope === 'SERVICE')).toBe(true)
    // sortOrder determinism: B (1) before A (2).
    expect(prep[0].contentVersionId).toBe(vSvcB)

    // Different types resolve to different scopes simultaneously.
    expect(
      assignments.some(
        (a) =>
          a.contentVersionId === vHouseExpect &&
          a.selectedScope === 'SACRED_HOUSE',
      ),
    ).toBe(true)
    expect(
      assignments.some(
        (a) => a.contentVersionId === vNotice && a.selectedScope === 'PLATFORM',
      ),
    ).toBe(true)

    // Deactivate the fixtures so later tests are unaffected.
    for (const id of [
      svcItemA,
      svcItemB,
      houseItemPrep,
      platformPrep,
      houseItemExpect,
      platformNotice,
    ]) {
      await setContentItemActive(adminId, ctx, id, false)
    }
  })

  it('applies the explicit language rules with no silent fallback', async () => {
    // Item 1: en + yo published → yo user gets yo.
    const both = await makeItem({
      contentType: 'ARRIVAL_GUIDANCE',
      scopeType: 'SERVICE',
      serviceId,
    })
    await makePublished(both, { title: 'English arrival' })
    const yoVersion = await createVersion(cmId, ctx, both, {
      language: 'yo',
      title: 'Yorùbá arrival',
      body: 'Ìdánwò àkọsílẹ̀ — synthetic test text',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, yoVersion.id)
    await approveVersion(adminId, ctx, yoVersion.id)
    await publishVersion(adminId, ctx, yoVersion.id)

    // Item 2: en only, fallback ALLOWED.
    const fallbackAllowed = await makeItem({
      contentType: 'PRAYER_PREPARATION',
      scopeType: 'SERVICE',
      serviceId,
    })
    const vFallback = await makePublished(fallbackAllowed, {
      title: 'English with fallback',
      allowEnglishFallback: true,
    })

    // Item 3: en only, fallback NOT allowed.
    const fallbackDenied = await makeItem({
      contentType: 'POST_SESSION_GUIDANCE',
      scopeType: 'SERVICE',
      serviceId,
    })
    await makePublished(fallbackDenied, {
      title: 'English without fallback',
      visibilityStage: 'AFTER_APPOINTMENT',
    })

    // Item 4: yo only → en user must NOT receive it.
    const yoOnly = await makeItem({
      contentType: 'THANKSGIVING_GUIDANCE',
      scopeType: 'SERVICE',
      serviceId,
    })
    const yoOnlyVersion = await createVersion(cmId, ctx, yoOnly, {
      language: 'yo',
      title: 'Yorùbá only',
      body: 'Ìdánwò àkọsílẹ̀ — synthetic test text',
      visibilityStage: 'AFTER_APPOINTMENT',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, yoOnlyVersion.id)
    await approveVersion(adminId, ctx, yoOnlyVersion.id)
    await publishVersion(adminId, ctx, yoOnlyVersion.id)

    // Yorùbá-preferring user:
    const yoAppt = await reserveAndConfirm(userYo)
    const yoAssignments = await readAssignments(yoAppt.appointmentId)
    const yoByVersion = new Map(
      yoAssignments.map((a) => [a.contentVersionId, a]),
    )
    expect(yoByVersion.get(yoVersion.id)?.fallbackUsed).toBe(false)
    expect(yoByVersion.get(vFallback)?.fallbackUsed).toBe(true)
    // fallback-denied item is simply not assignable for yo.
    expect(yoAssignments.some((a) => a.contentItemId === fallbackDenied)).toBe(
      false,
    )
    expect(yoByVersion.get(yoOnlyVersion.id)).toBeDefined()

    // English-preferring user: yo-only item NEVER assigned in reverse.
    const enAppt = await reserveAndConfirm(userEn)
    const enAssignments = await readAssignments(enAppt.appointmentId)
    expect(enAssignments.some((a) => a.contentItemId === yoOnly)).toBe(false)
    expect(enAssignments.some((a) => a.fallbackUsed)).toBe(false)

    // Changing the profile language afterwards rewrites nothing.
    await getDb()
      .update(userProfiles)
      .set({ preferredLanguage: 'en' })
      .where(eq(userProfiles.userId, userYo))
    const after = await readAssignments(yoAppt.appointmentId)
    expect(after.map((a) => a.contentVersionId).sort()).toEqual(
      yoAssignments.map((a) => a.contentVersionId).sort(),
    )
    const setAfter = await readSet(yoAppt.appointmentId)
    expect(setAfter?.preferredLanguageSnapshot).toBe('yo')
    await getDb()
      .update(userProfiles)
      .set({ preferredLanguage: 'yo' })
      .where(eq(userProfiles.userId, userYo))

    for (const id of [both, fallbackAllowed, fallbackDenied, yoOnly]) {
      await setContentItemActive(adminId, ctx, id, false)
    }
  })

  it('freezes exact versions historically (§66) and zero-assignment sets stay frozen (§67)', async () => {
    const itemId = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    const v1 = await makePublished(itemId, { title: 'Historical v1' })

    // otherService appointment → v1 frozen.
    const reservationA = await createReservation(userEn, ctx, {
      serviceId: otherServiceId,
      startsAtUtc: nextSlot(),
    })
    await confirmReservation(reservationA.appointmentId, ctx)
    const assignmentsA = await readAssignments(reservationA.appointmentId)
    expect(assignmentsA.length).toBe(1)
    expect(assignmentsA[0].contentVersionId).toBe(v1)

    // Publish v2; appointment A must keep v1, new appointment gets v2.
    const v2 = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Historical v2',
      body: 'Test preparation content B',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, v2.id)
    await approveVersion(adminId, ctx, v2.id)
    await publishVersion(adminId, ctx, v2.id)

    const stillA = await readAssignments(reservationA.appointmentId)
    expect(stillA[0].contentVersionId).toBe(v1)
    const visibleA = await getVisibleGuidance(
      reservationA.appointmentId,
      'CONFIRMED',
    )
    expect(visibleA.items[0]?.versionNumber).toBe(1)
    expect(visibleA.items[0]?.title).toBe('Historical v1')

    const reservationB = await createReservation(userEn, ctx, {
      serviceId: otherServiceId,
      startsAtUtc: nextSlot(),
    })
    await confirmReservation(reservationB.appointmentId, ctx)
    const assignmentsB = await readAssignments(reservationB.appointmentId)
    expect(assignmentsB[0].contentVersionId).toBe(v2.id)

    // Deactivate the item: history still resolves for both.
    await setContentItemActive(adminId, ctx, itemId, false)
    const archivedVisible = await getVisibleGuidance(
      reservationA.appointmentId,
      'CONFIRMED',
    )
    expect(archivedVisible.items[0]?.title).toBe('Historical v1')

    // §67 zero-content: with the item inactive, a fresh appointment
    // gets a NO_APPLICABLE_CONTENT marker…
    const reservationZero = await createReservation(userEn, ctx, {
      serviceId: otherServiceId,
      startsAtUtc: nextSlot(),
    })
    await confirmReservation(reservationZero.appointmentId, ctx)
    let zeroSet = await readSet(reservationZero.appointmentId)
    expect(zeroSet?.selectionResult).toBe('NO_APPLICABLE_CONTENT')
    expect(zeroSet?.assignmentCount).toBe(0)

    // …then content becomes available again, and every idempotent
    // retry path must leave the zero-assignment set untouched.
    await setContentItemActive(adminId, ctx, itemId, true)
    await getDb().transaction(async (tx) => {
      const retry = await assignGuidanceForAppointmentUnderTx(
        tx,
        reservationZero.appointmentId,
      )
      expect(retry.alreadyExisted).toBe(true)
      expect(retry.assignmentCount).toBe(0)
    })
    zeroSet = await readSet(reservationZero.appointmentId)
    expect(zeroSet?.selectionResult).toBe('NO_APPLICABLE_CONTENT')
    expect(zeroSet?.assignmentCount).toBe(0)
    expect((await readAssignments(reservationZero.appointmentId)).length).toBe(
      0,
    )
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('records MISSING_LANGUAGE without blocking confirmation (§28)', async () => {
    const brokenUser = await makeEligibleUser('en')
    const reservation = await createReservation(brokenUser, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    // Simulate a profile-integrity anomaly AFTER eligibility passed.
    await getDb()
      .update(userProfiles)
      .set({ preferredLanguage: null })
      .where(eq(userProfiles.userId, brokenUser))
    await confirmReservation(reservation.appointmentId, ctx)
    const set = await readSet(reservation.appointmentId)
    expect(set?.selectionResult).toBe('MISSING_LANGUAGE')
    expect(set?.assignmentCount).toBe(0)
    const appointment = (
      await getDb()
        .select({ status: appointments.status })
        .from(appointments)
        .where(eq(appointments.id, reservation.appointmentId))
        .limit(1)
    ).at(0)
    expect(appointment?.status).toBe('CONFIRMED')
  })
})

// --- Confirmation/payment integration (§68–§70, §34) ------------------------

describe('confirmation integration', () => {
  it('verified payment confirms and assigns atomically; forced failure rolls back everything (§68)', async () => {
    const itemId = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      serviceId,
    })
    const versionId = await makePublished(itemId, { title: 'Atomic test' })

    const reservation = await createReservation(userEn, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    const reference = await insertMockAttempt(reservation.appointmentId, userEn)

    // Force a genuine integrity failure inside guidance assignment: a
    // conflicting assignment row (without a set row) makes the insert
    // violate the unique key mid-transaction.
    await getDb().insert(appointmentGuidanceAssignments).values({
      appointmentId: reservation.appointmentId,
      contentItemId: itemId,
      contentVersionId: versionId,
      selectedScope: 'SERVICE',
      fallbackUsed: false,
      sortOrderSnapshot: 0,
    })
    let thrown: unknown = null
    try {
      await settleVerifiedPayment(mockSuccess(reference))
    } catch (error) {
      thrown = error
    }
    expect(thrown).not.toBeNull()
    // The WHOLE transaction rolled back: not confirmed, no set row,
    // attempt not settled — the provider webhook would safely retry.
    const afterFailure = (
      await getDb()
        .select({ status: appointments.status })
        .from(appointments)
        .where(eq(appointments.id, reservation.appointmentId))
        .limit(1)
    ).at(0)
    expect(afterFailure?.status).toBe('PENDING_PAYMENT')
    expect(await readSet(reservation.appointmentId)).toBeUndefined()

    // Remove the sabotage; the retry settles atomically.
    await getDb()
      .delete(appointmentGuidanceAssignments)
      .where(
        eq(
          appointmentGuidanceAssignments.appointmentId,
          reservation.appointmentId,
        ),
      )
    const outcome = await settleVerifiedPayment(mockSuccess(reference))
    expect(outcome.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')
    const set = await readSet(reservation.appointmentId)
    expect(set?.selectionResult).toBe('ASSIGNED')
    expect(set?.assignmentCount).toBe(1)
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('late payment never assigns guidance (§69)', async () => {
    const itemId = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      serviceId,
    })
    await makePublished(itemId, { title: 'Late payment test' })
    const reservation = await createReservation(userEn, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    const reference = await insertMockAttempt(reservation.appointmentId, userEn)
    const lateNow = sqlToUtcMs(reservation.reservationExpiresAt) + 60_000
    const outcome = await settleVerifiedPayment(
      mockSuccess(reference),
      ctx,
      lateNow,
    )
    expect(outcome.reviewReason).toBe('RESERVATION_EXPIRED')
    expect(await readSet(reservation.appointmentId)).toBeUndefined()
    expect((await readAssignments(reservation.appointmentId)).length).toBe(0)
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('duplicate payment never reruns assignment (§70)', async () => {
    const itemId = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      serviceId,
    })
    const v1 = await makePublished(itemId, { title: 'Duplicate payment v1' })
    const reservation = await createReservation(userEn, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    const reference1 = await insertMockAttempt(
      reservation.appointmentId,
      userEn,
    )
    await settleVerifiedPayment(mockSuccess(reference1))
    const original = await readAssignments(reservation.appointmentId)
    expect(original.map((a) => a.contentVersionId)).toEqual([v1])

    // Publish v2, then a duplicate payment arrives.
    const v2 = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Duplicate payment v2',
      body: 'Test preparation content B',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, v2.id)
    await approveVersion(adminId, ctx, v2.id)
    await publishVersion(adminId, ctx, v2.id)

    const reference2 = await insertMockAttempt(
      reservation.appointmentId,
      userEn,
    )
    const duplicate = await settleVerifiedPayment(mockSuccess(reference2))
    expect(duplicate.reviewReason).toBe('DUPLICATE_SUCCESS')
    const after = await readAssignments(reservation.appointmentId)
    expect(after.map((a) => a.contentVersionId)).toEqual([v1])
    const set = await readSet(reservation.appointmentId)
    expect(set?.assignmentCount).toBe(1)
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('confirmation racing publication freezes exactly one coherent published version (§34)', async () => {
    const itemId = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      serviceId,
    })
    const v1 = await makePublished(itemId, { title: 'Race v1' })
    const v2 = await createVersion(cmId, ctx, itemId, {
      language: 'en',
      title: 'Race v2',
      body: 'Test preparation content B',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, v2.id)
    await approveVersion(adminId, ctx, v2.id)

    const reservation = await createReservation(userEn, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    const [confirmResult, publishResult] = await Promise.allSettled([
      confirmReservation(reservation.appointmentId, ctx),
      publishVersion(adminId, ctx, v2.id),
    ])
    expect(confirmResult.status).toBe('fulfilled')
    expect(publishResult.status).toBe('fulfilled')

    const assignments = await readAssignments(reservation.appointmentId)
    expect(assignments.length).toBe(1)
    // Either committed publication state is legitimate — but never
    // both, never a draft/approved version, never a half state.
    expect([v1, v2.id]).toContain(assignments[0].contentVersionId)
    const assignedVersion = (
      await getDb()
        .select({ status: spiritualContentVersions.status })
        .from(spiritualContentVersions)
        .where(eq(spiritualContentVersions.id, assignments[0].contentVersionId))
        .limit(1)
    ).at(0)
    expect(['PUBLISHED', 'ARCHIVED']).toContain(assignedVersion?.status ?? '')
    await setContentItemActive(adminId, ctx, itemId, false)
  })
})

// --- Visibility & acknowledgements (§71/§72) --------------------------------

describe('visibility and acknowledgements', () => {
  let stageItemConfirm: number
  let stageItemAfter: number
  let vConfirm: number
  let vAfter: number

  it('sets up staged content and enforces status-based visibility', async () => {
    stageItemConfirm = await makeItem({
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      serviceId,
    })
    vConfirm = await makePublished(stageItemConfirm, {
      title: 'Stage: after confirmation',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: true,
    })
    stageItemAfter = await makeItem({
      contentType: 'POST_SESSION_GUIDANCE',
      scopeType: 'SERVICE',
      serviceId,
    })
    vAfter = await makePublished(stageItemAfter, {
      title: 'Stage: after appointment',
      visibilityStage: 'AFTER_APPOINTMENT',
      acknowledgementRequired: true,
    })

    // PENDING_PAYMENT: no guidance (selection has not even run).
    const pending = await createReservation(userEn, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    const beforeConfirm = await getVisibleGuidance(
      pending.appointmentId,
      'PENDING_PAYMENT',
    )
    expect(beforeConfirm.setState).toBe('NONE')
    expect(beforeConfirm.items.length).toBe(0)

    // CONFIRMED: AFTER_CONFIRMATION visible, AFTER_APPOINTMENT hidden.
    await confirmReservation(pending.appointmentId, ctx)
    const confirmed = await getVisibleGuidance(
      pending.appointmentId,
      'CONFIRMED',
    )
    expect(confirmed.items.some((i) => i.contentVersionId === vConfirm)).toBe(
      true,
    )
    expect(confirmed.items.some((i) => i.contentVersionId === vAfter)).toBe(
      false,
    )

    // Hidden stage cannot be acknowledged before completion.
    const appointment = { id: pending.appointmentId, userId: userEn }
    let hiddenAck: unknown = null
    try {
      await acknowledgeGuidance(
        ctx,
        { ...appointment, status: 'CONFIRMED' },
        vAfter,
      )
    } catch (error) {
      hiddenAck = error
    }
    expect(hiddenAck).toBeInstanceOf(GuidanceError)

    // Owner acknowledges visible required guidance; idempotent.
    const first = await acknowledgeGuidance(
      ctx,
      { ...appointment, status: 'CONFIRMED' },
      vConfirm,
    )
    expect(first.acknowledged).toBe(true)
    const again = await acknowledgeGuidance(
      ctx,
      { ...appointment, status: 'CONFIRMED' },
      vConfirm,
    )
    expect(again.acknowledged).toBe(true)
    const ackRows = await getDb()
      .select()
      .from(appointmentGuidanceAcknowledgements)
      .where(
        and(
          eq(
            appointmentGuidanceAcknowledgements.appointmentId,
            pending.appointmentId,
          ),
          eq(appointmentGuidanceAcknowledgements.contentVersionId, vConfirm),
        ),
      )
    expect(ackRows.length).toBe(1)

    // Unassigned version denied.
    const unrelatedItem = await makeItem({
      contentType: 'WHAT_TO_EXPECT',
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    const unrelatedVersion = await makePublished(unrelatedItem, {
      title: 'Unrelated',
    })
    let unassigned: unknown = null
    try {
      await acknowledgeGuidance(
        ctx,
        { ...appointment, status: 'CONFIRMED' },
        unrelatedVersion,
      )
    } catch (error) {
      unassigned = error
    }
    expect(unassigned).toBeInstanceOf(GuidanceError)
    await setContentItemActive(adminId, ctx, unrelatedItem, false)

    // Missing acknowledgement never blocks completion; COMPLETED
    // unlocks AFTER_APPOINTMENT content and its acknowledgement.
    await completeAppointment(adminId, ctx, pending.appointmentId)
    const completed = await getVisibleGuidance(
      pending.appointmentId,
      'COMPLETED',
    )
    expect(completed.items.some((i) => i.contentVersionId === vAfter)).toBe(
      true,
    )
    const ackAfter = await acknowledgeGuidance(
      ctx,
      { ...appointment, status: 'COMPLETED' },
      vAfter,
    )
    expect(ackAfter.acknowledged).toBe(true)

    // NO_SHOW and CANCELLED never expose active guidance.
    const noShowReservation = await reserveAndConfirm(userEn)
    await markNoShow(adminId, ctx, noShowReservation.appointmentId)
    const noShowVisible = await getVisibleGuidance(
      noShowReservation.appointmentId,
      'NO_SHOW',
    )
    expect(noShowVisible.items.length).toBe(0)
    // Assignments remain historically (never deleted).
    expect(
      (await readAssignments(noShowReservation.appointmentId)).length,
    ).toBeGreaterThan(0)

    const cancelled = await reserveAndConfirm(userEn)
    await cancelAppointment(
      { userId: adminId, isOperator: true },
      ctx,
      cancelled.appointmentId,
      'operational test cancellation',
    )
    const cancelledVisible = await getVisibleGuidance(
      cancelled.appointmentId,
      'CANCELLED',
    )
    expect(cancelledVisible.items.length).toBe(0)
  })

  it('acknowledgement_required=false is refused server-side (§7/§8)', async () => {
    const optionalItem = await makeItem({
      contentType: 'WHAT_TO_EXPECT',
      scopeType: 'SERVICE',
      serviceId,
    })
    const optionalVersion = await makePublished(optionalItem, {
      title: 'Optional reading',
      acknowledgementRequired: false,
    })
    const reservation = await reserveAndConfirm(userEn)
    const visible = await getVisibleGuidance(
      reservation.appointmentId,
      'CONFIRMED',
    )
    const optional = visible.items.find(
      (i) => i.contentVersionId === optionalVersion,
    )
    expect(optional?.acknowledgementRequired).toBe(false)

    // The domain path itself must refuse — a hidden checkbox is not
    // enforcement.
    let refused: unknown = null
    try {
      await acknowledgeGuidance(
        ctx,
        { id: reservation.appointmentId, userId: userEn, status: 'CONFIRMED' },
        optionalVersion,
      )
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(GuidanceError)
    const rows = await getDb()
      .select()
      .from(appointmentGuidanceAcknowledgements)
      .where(
        and(
          eq(
            appointmentGuidanceAcknowledgements.appointmentId,
            reservation.appointmentId,
          ),
          eq(
            appointmentGuidanceAcknowledgements.contentVersionId,
            optionalVersion,
          ),
        ),
      )
    expect(rows.length).toBe(0)
    await setContentItemActive(adminId, ctx, optionalItem, false)
  })

  it('wrong-user isolation and audit privacy hold', async () => {
    // Wrong user cannot resolve the appointment at all (ownership is
    // the gate to guidance).
    const { getUserAppointmentByPublicId } =
      await import('@/services/appointments')
    const own = await reserveAndConfirm(userEn)
    expect(await getUserAppointmentByPublicId(userYo, own.publicId)).toBeNull()

    // The distinctive body text and private notes never reach audit
    // metadata; assignment audits carry ids/counts only.
    const audits = await getDb()
      .select({ metadataJson: auditLogs.metadataJson })
      .from(auditLogs)
      .where(like(auditLogs.action, '%guidance%'))
    for (const row of audits) {
      const metadata = JSON.stringify(row.metadataJson ?? '')
      expect(metadata).not.toContain(DISTINCTIVE_BODY_MARKER)
      expect(metadata).not.toContain('<script>')
    }
    const allAudits = await getDb()
      .select({ metadataJson: auditLogs.metadataJson })
      .from(auditLogs)
      .where(like(auditLogs.action, 'spiritual_content%'))
    for (const row of allAudits) {
      const metadata = JSON.stringify(row.metadataJson ?? '')
      expect(metadata).not.toContain(DISTINCTIVE_BODY_MARKER)
    }
    // Cleanup stage fixtures for later suites.
    await setContentItemActive(adminId, ctx, stageItemConfirm, false)
    await setContentItemActive(adminId, ctx, stageItemAfter, false)
  })
})
