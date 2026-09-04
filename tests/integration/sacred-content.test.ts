import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  appointmentGuidanceAssignments,
  appointmentGuidanceSets,
  appointments,
  auditLogs,
  sacredContentVersionProfiles,
  sacredHouseAvailability,
  sacredHouseBookingSettings,
  sacredHouses,
  services,
  prayerSessionTemplateVersions,
  visualBibleVersions,
  spiritualContentItems,
  spiritualContentVersions,
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
import { confirmReservation, createReservation } from '@/services/appointments'
import {
  SpiritualContentError,
  approveVersion,
  createContentItem,
  createVersion,
  getContentItemDetail,
  listContentItems,
  listReviewQueue,
  publishVersion,
  returnVersionToDraft,
  setContentItemActive,
  submitVersionForReview,
  updateContentItem,
  updateDraftVersion,
} from '@/services/spiritual-content'
import {
  createSacredContentItem,
  createSacredVersion,
  getSacredVersionProfiles,
  isSacredVersionRuntimeEligible,
  listEligibleSacredRuntimeContent,
  requireVersionDomain,
  setSacredRightsStatus,
  setSacredRuntimeEnabled,
  updateSacredDraftVersion,
  updateSacredProfile,
  verifySacredVersionHash,
} from '@/services/sacred-content'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type {
  SacredItemInput,
  SacredProfileInput,
  SacredVersionInput,
} from '@/services/sacred-content'

/**
 * Step 8 integration tests: sacred runtime library, cross-domain
 * isolation from Step 7 guidance, rights workflow, runtime enablement,
 * SHA-256 integrity, candidate query, scope behavior, policy
 * validation, concurrency and privacy.
 *
 * Every fixture body is an obviously synthetic neutral string such as
 * "Integration-test prayer block A" — no sacred wording is ever
 * invented, in fixtures or anywhere else.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `sacred test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const createdItemIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'

let adminId: number
let cmId: number
let plainUserId: number
let houseId: number
let serviceId: number
let otherServiceId: number

const CODE_PREFIX = `T8_${crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')}`
let codeCounter = 0
function nextCode(): string {
  codeCounter += 1
  return `${CODE_PREFIX}_ITEM_${codeCounter}`
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
      email: `s8-${crypto.randomUUID()}@test.local`,
      preferredName: 'S8 Fixture',
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

function baseProfile(
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
    durationHintSeconds: null,
    repeatable: false,
    voicePolicy: 'TEXT_ONLY',
    externalAiPolicy: 'METADATA_ONLY',
    accessPolicy: 'PRAYER_ROOM_PRIVATE',
    ...overrides,
  }
}

function baseVersion(
  overrides: Partial<SacredVersionInput> = {},
): SacredVersionInput {
  return {
    language: 'en',
    title: 'Integration-test sacred block',
    body: 'Integration-test prayer block A',
    ...overrides,
  }
}

async function makeSacredItem(
  overrides: Partial<SacredItemInput> = {},
): Promise<number> {
  const result = await createSacredContentItem(cmId, ctx, {
    code: nextCode(),
    contentType: 'PRAYER',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    sortOrder: 0,
    ...overrides,
  })
  createdItemIds.push(result.id)
  return result.id
}

/** CM drafts + submits; ADMIN approves + publishes. */
async function makePublishedSacred(
  itemId: number,
  versionOverrides: Partial<SacredVersionInput> = {},
  profileOverrides: Partial<SacredProfileInput> = {},
): Promise<number> {
  const version = await createSacredVersion(
    cmId,
    ctx,
    itemId,
    baseVersion(versionOverrides),
    baseProfile(profileOverrides),
  )
  await submitVersionForReview(cmId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  return version.id
}

/** Full upstream human approval chain, ending runtime-enabled. */
async function makeRuntimeEligible(
  itemOverrides: Partial<SacredItemInput> = {},
  versionOverrides: Partial<SacredVersionInput> = {},
  profileOverrides: Partial<SacredProfileInput> = {},
): Promise<{ itemId: number; versionId: number }> {
  const itemId = await makeSacredItem(itemOverrides)
  const versionId = await makePublishedSacred(
    itemId,
    versionOverrides,
    profileOverrides,
  )
  await setSacredRightsStatus(adminId, ctx, versionId, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, versionId, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, versionId, true)
  return { itemId, versionId }
}

async function readVersion(versionId: number) {
  const row = (
    await getDb()
      .select()
      .from(spiritualContentVersions)
      .where(eq(spiritualContentVersions.id, versionId))
      .limit(1)
  ).at(0)
  if (!row) throw new Error('version fixture missing')
  return row
}

async function readProfile(versionId: number) {
  const row = (
    await getDb()
      .select()
      .from(sacredContentVersionProfiles)
      .where(eq(sacredContentVersionProfiles.contentVersionId, versionId))
      .limit(1)
  ).at(0)
  if (!row) throw new Error('profile fixture missing')
  return row
}

async function candidateIds(
  filters: Parameters<typeof listEligibleSacredRuntimeContent>[0],
) {
  const rows = await listEligibleSacredRuntimeContent(filters)
  return rows.map((row) => row.contentVersionId)
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  // Deactivate stale fixtures from previously crashed runs.
  await getDb()
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'T8\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')
  plainUserId = await makeUser()

  const db = getDb()
  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T8H_${key}`.toUpperCase(),
    name: `T8 House ${key}`,
    slug: `t8h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  const svcInsert = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T8S_${key}`.toUpperCase(),
    name: `T8 Service ${key}`,
    slug: `t8s-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  serviceId = svcInsert[0].insertId
  const otherSvc = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T8O_${key}`.toUpperCase(),
    name: `T8 Other Service ${key}`,
    slug: `t8o-${key}`,
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

async function purgeGenerationRowsForAppointments(
  apptIds: Array<number>,
): Promise<void> {
  if (apptIds.length === 0) return
  const db = getDb()
  const { inArray: inArrayOp } = await import('drizzle-orm')
  const {
    prayerGenerationJobEvents,
    prayerGenerationJobs,
    prayerGenerationRecipeSnapshots,
  } = await import('@/db/schema')
  const jobs = await db
    .select({ id: prayerGenerationJobs.id })
    .from(prayerGenerationJobs)
    .where(inArrayOp(prayerGenerationJobs.appointmentId, apptIds))
  const jobIds = jobs.map((row) => row.id)
  if (jobIds.length === 0) return
  await db
    .delete(prayerGenerationJobEvents)
    .where(inArrayOp(prayerGenerationJobEvents.generationJobId, jobIds))
  await db
    .delete(prayerGenerationRecipeSnapshots)
    .where(inArrayOp(prayerGenerationRecipeSnapshots.generationJobId, jobIds))
  await db
    .delete(prayerGenerationJobs)
    .where(inArrayOp(prayerGenerationJobs.id, jobIds))
}

afterAll(async () => {
  const db = getDb()
  if (houseId) {
    const apptRows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.sacredHouseId, houseId))
    const apptIds = apptRows.map((row) => row.id)
    if (apptIds.length > 0) {
      await db
        .delete(appointmentGuidanceAssignments)
        .where(inArray(appointmentGuidanceAssignments.appointmentId, apptIds))
      await db
        .delete(appointmentGuidanceSets)
        .where(inArray(appointmentGuidanceSets.appointmentId, apptIds))
      await purgeGenerationRowsForAppointments(apptIds)
      await db.delete(appointments).where(inArray(appointments.id, apptIds))
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
  await closeDb()
})

async function expectError(
  fn: () => Promise<unknown>,
  kind: 'content' | 'forbidden' | 'any' = 'content',
): Promise<Error> {
  let thrown: unknown = null
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  if (kind === 'content') expect(thrown).toBeInstanceOf(SpiritualContentError)
  else if (kind === 'forbidden') expect(thrown).toBeInstanceOf(ForbiddenError)
  else expect(thrown).not.toBeNull()
  return thrown as Error
}

// --- Cross-domain isolation (§62 mandatory regression) ----------------------

describe('cross-domain isolation', () => {
  it('Step 7 items are GUIDANCE, Step 8 items are SACRED_RUNTIME, lists never mix', async () => {
    const guidanceItem = await createContentItem(cmId, ctx, {
      code: nextCode(),
      contentType: 'PREPARATION',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 0,
    })
    createdItemIds.push(guidanceItem.id)
    const sacredId = await makeSacredItem()

    const guidanceRow = (await getContentItemDetail(guidanceItem.id)).item
    expect(guidanceRow.contentDomain).toBe('GUIDANCE')
    const sacredRow = (await getContentItemDetail(sacredId)).item
    expect(sacredRow.contentDomain).toBe('SACRED_RUNTIME')

    const guidanceList = await listContentItems({}, 'GUIDANCE')
    expect(guidanceList.some((i) => i.id === guidanceItem.id)).toBe(true)
    expect(guidanceList.some((i) => i.id === sacredId)).toBe(false)
    const sacredList = await listContentItems({}, 'SACRED_RUNTIME')
    expect(sacredList.some((i) => i.id === sacredId)).toBe(true)
    expect(sacredList.some((i) => i.id === guidanceItem.id)).toBe(false)

    // Domain-scoped detail refuses the other domain.
    await expectError(() => getContentItemDetail(sacredId, 'GUIDANCE'))
    await expectError(() =>
      getContentItemDetail(guidanceItem.id, 'SACRED_RUNTIME'),
    )
  })

  it('confirmed appointments NEVER receive sacred runtime content as guidance', async () => {
    // A published guidance item and a FULLY runtime-eligible sacred
    // PRAYER at the SAME service scope.
    const guidanceItem = await createContentItem(cmId, ctx, {
      code: nextCode(),
      contentType: 'PREPARATION',
      scopeType: 'SERVICE',
      sacredHouseId: null,
      serviceId,
      sortOrder: 0,
    })
    createdItemIds.push(guidanceItem.id)
    const guidanceVersion = await createVersion(cmId, ctx, guidanceItem.id, {
      language: 'en',
      title: 'Guidance for isolation test',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, guidanceVersion.id)
    await approveVersion(adminId, ctx, guidanceVersion.id)
    await publishVersion(adminId, ctx, guidanceVersion.id)

    const sacred = await makeRuntimeEligible({
      contentType: 'PRAYER',
      scopeType: 'SERVICE',
      serviceId,
    })

    const userId = await makeEligibleUser()
    const reservation = await createReservation(userId, ctx, {
      serviceId,
      startsAtUtc: nextSlot(),
    })
    await confirmReservation(reservation.appointmentId, ctx)

    const assignments = await getDb()
      .select()
      .from(appointmentGuidanceAssignments)
      .where(
        eq(
          appointmentGuidanceAssignments.appointmentId,
          reservation.appointmentId,
        ),
      )
    expect(
      assignments.some((a) => a.contentVersionId === guidanceVersion.id),
    ).toBe(true)
    // MANDATORY: the runtime-eligible sacred PRAYER is NOT assigned.
    expect(assignments.some((a) => a.contentItemId === sacred.itemId)).toBe(
      false,
    )
    expect(
      assignments.some((a) => a.contentVersionId === sacred.versionId),
    ).toBe(false)

    await setContentItemActive(adminId, ctx, guidanceItem.id, false)
    await setContentItemActive(adminId, ctx, sacred.itemId, false)
  })

  it('GUIDANCE content never appears in runtime candidates', async () => {
    const guidanceItem = await createContentItem(cmId, ctx, {
      code: nextCode(),
      contentType: 'PREPARATION',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 0,
    })
    createdItemIds.push(guidanceItem.id)
    const version = await createVersion(cmId, ctx, guidanceItem.id, {
      language: 'en',
      title: 'Published guidance',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, version.id)
    await approveVersion(adminId, ctx, version.id)
    await publishVersion(adminId, ctx, version.id)

    const ids = await candidateIds({ language: 'en' })
    expect(ids).not.toContain(version.id)
    await setContentItemActive(adminId, ctx, guidanceItem.id, false)
  })

  it('cross-domain server authority: each workflow refuses the other domain', async () => {
    const sacredId = await makeSacredItem()
    const sacredVersion = await createSacredVersion(
      cmId,
      ctx,
      sacredId,
      baseVersion(),
      baseProfile(),
    )
    const guidanceItem = await createContentItem(cmId, ctx, {
      code: nextCode(),
      contentType: 'PREPARATION',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 0,
    })
    createdItemIds.push(guidanceItem.id)
    const guidanceVersion = await createVersion(cmId, ctx, guidanceItem.id, {
      language: 'en',
      title: 'Guidance draft',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })

    // Guidance createVersion refuses sacred items (would create a
    // profile-less sacred version).
    await expectError(() =>
      createVersion(cmId, ctx, sacredId, {
        language: 'yo',
        title: 'x',
        body: 'y',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      }),
    )
    // Sacred createSacredVersion refuses guidance items (a GUIDANCE
    // version must never receive a sacred profile).
    await expectError(() =>
      createSacredVersion(
        cmId,
        ctx,
        guidanceItem.id,
        baseVersion({ language: 'yo' }),
        baseProfile(),
      ),
    )
    // Draft editing is domain-scoped in both directions.
    await expectError(() =>
      updateDraftVersion(cmId, ctx, sacredVersion.id, {
        title: 'x',
        body: 'y',
        visibilityStage: 'AFTER_CONFIRMATION',
        acknowledgementRequired: false,
        allowEnglishFallback: false,
      }),
    )
    await expectError(() =>
      updateSacredDraftVersion(cmId, ctx, guidanceVersion.id, {
        title: 'x',
        body: 'y',
      }),
    )
    // Profile mutation refuses guidance versions.
    await expectError(() =>
      updateSacredProfile(cmId, ctx, guidanceVersion.id, baseProfile()),
    )
    // Domain guard used by the action layer.
    await expectError(() => requireVersionDomain(sacredVersion.id, 'GUIDANCE'))
    await expectError(() =>
      requireVersionDomain(guidanceVersion.id, 'SACRED_RUNTIME'),
    )
    // No profile row was ever created for the guidance version.
    const orphanProfiles = await getDb()
      .select()
      .from(sacredContentVersionProfiles)
      .where(eq(sacredContentVersionProfiles.contentItemId, guidanceItem.id))
    expect(orphanProfiles.length).toBe(0)
  })

  it('review queues are domain-separated', async () => {
    const sacredId = await makeSacredItem()
    const version = await createSacredVersion(
      cmId,
      ctx,
      sacredId,
      baseVersion(),
      baseProfile(),
    )
    await submitVersionForReview(cmId, ctx, version.id)
    const sacredQueue = await listReviewQueue('SACRED_RUNTIME')
    expect(sacredQueue.some((row) => row.version.id === version.id)).toBe(true)
    const guidanceQueue = await listReviewQueue('GUIDANCE')
    expect(guidanceQueue.some((row) => row.version.id === version.id)).toBe(
      false,
    )
    await returnVersionToDraft(adminId, ctx, version.id, 'test cleanup')
  })
})

// --- Sacred workflow (§63) --------------------------------------------------

describe('sacred version workflow', () => {
  it('creates version + profile atomically and walks the full human workflow', async () => {
    const itemId = await makeSacredItem({ contentType: 'INVOCATION' })
    const version = await createSacredVersion(
      cmId,
      ctx,
      itemId,
      baseVersion({ body: 'Integration-test prayer block A\nLine two.' }),
      baseProfile({ digitalStorageAuthorized: false }),
    )
    const profile = await readProfile(version.id)
    expect(profile.contentItemId).toBe(itemId)
    expect(profile.rightsStatus).toBe('UNREVIEWED')
    expect(profile.runtimeEnabled).toBe(false)
    expect(profile.contentSha256).toBeNull()

    // DRAFT: body and profile editable.
    await updateSacredDraftVersion(cmId, ctx, version.id, {
      title: 'Edited sacred title',
      body: 'Integration-test prayer block B',
    })
    await updateSacredProfile(
      cmId,
      ctx,
      version.id,
      baseProfile({
        digitalStorageAuthorized: false,
        themeCode: 'TEST_THEME',
        durationHintSeconds: 60,
        repeatable: true,
      }),
    )
    expect((await readProfile(version.id)).themeCode).toBe('TEST_THEME')

    // Storage authorization false → submission refused (spec §19).
    await expectError(() => submitVersionForReview(cmId, ctx, version.id))
    await updateSacredProfile(
      cmId,
      ctx,
      version.id,
      baseProfile({ themeCode: 'TEST_THEME' }),
    )
    await submitVersionForReview(cmId, ctx, version.id)

    // UNDER_REVIEW: body and profile immutable.
    await expectError(() =>
      updateSacredDraftVersion(cmId, ctx, version.id, {
        title: 'x',
        body: 'y',
      }),
    )
    await expectError(() =>
      updateSacredProfile(cmId, ctx, version.id, baseProfile()),
    )

    // Return preserves the permanent structural freeze.
    await returnVersionToDraft(adminId, ctx, version.id, 'clarify wording')
    expect((await getContentItemDetail(itemId)).structureFrozen).toBe(true)
    await submitVersionForReview(cmId, ctx, version.id)

    // CM cannot approve/publish; ADMIN can.
    await expectError(() => approveVersion(cmId, ctx, version.id), 'forbidden')
    await approveVersion(adminId, ctx, version.id)
    await expectError(() => publishVersion(cmId, ctx, version.id), 'forbidden')
    await publishVersion(adminId, ctx, version.id)

    // Published: body and profile immutable forever.
    await expectError(() =>
      updateSacredDraftVersion(cmId, ctx, version.id, {
        title: 'x',
        body: 'y',
      }),
    )
    await expectError(() =>
      updateSacredProfile(cmId, ctx, version.id, baseProfile()),
    )
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('rights permission matrix', async () => {
    expect(
      await userHasPermission(adminId, 'sacred_content.rights_manage'),
    ).toBe(true)
    expect(await userHasPermission(cmId, 'sacred_content.rights_manage')).toBe(
      false,
    )
    expect(
      await userHasPermission(plainUserId, 'sacred_content.rights_manage'),
    ).toBe(false)
    expect(await userHasPermission(plainUserId, 'spiritual_content.view')).toBe(
      false,
    )
  })
})

// --- Rights workflow (§64) --------------------------------------------------

describe('rights workflow', () => {
  it('enforces authority, controlled transitions and the immutable-text rule', async () => {
    const itemId = await makeSacredItem({ contentType: 'BLESSING' })
    const version = await createSacredVersion(
      cmId,
      ctx,
      itemId,
      baseVersion(),
      baseProfile(),
    )

    // USER and CM denied.
    await expectError(
      () =>
        setSacredRightsStatus(plainUserId, ctx, version.id, 'PENDING_REVIEW'),
      'forbidden',
    )
    await expectError(
      () => setSacredRightsStatus(cmId, ctx, version.id, 'PENDING_REVIEW'),
      'forbidden',
    )

    // Invalid direct transition UNREVIEWED → CLEARED.
    await expectError(() =>
      setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED'),
    )
    await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')

    // CLEARED refused while DRAFT (mutable text).
    await expectError(() =>
      setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED'),
    )
    await submitVersionForReview(cmId, ctx, version.id)
    // CLEARED refused while UNDER_REVIEW.
    await expectError(() =>
      setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED'),
    )
    await approveVersion(adminId, ctx, version.id)
    // CLEARED allowed on APPROVED (immutable text).
    await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
    expect((await readProfile(version.id)).rightsStatus).toBe('CLEARED')
    expect((await readProfile(version.id)).rightsReviewedBy).toBe(adminId)

    // RESTRICTED requires a note.
    await expectError(() =>
      setSacredRightsStatus(adminId, ctx, version.id, 'RESTRICTED'),
    )
    await setSacredRightsStatus(
      adminId,
      ctx,
      version.id,
      'RESTRICTED',
      'synthetic test restriction reason',
    )
    // RESTRICTED → PENDING_REVIEW → CLEARED again, then WITHDRAWN.
    await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
    await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
    await expectError(() =>
      setSacredRightsStatus(adminId, ctx, version.id, 'WITHDRAWN'),
    )
    await setSacredRightsStatus(
      adminId,
      ctx,
      version.id,
      'WITHDRAWN',
      'synthetic withdrawal reason',
    )
    // WITHDRAWN can return to PENDING_REVIEW.
    await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('CLEARED is allowed on PUBLISHED text and withdrawal kills future runtime eligibility immediately', async () => {
    const { itemId, versionId } = await makeRuntimeEligible({
      contentType: 'CHANT',
    })
    expect(await candidateIds({ language: 'en' })).toContain(versionId)

    await setSacredRightsStatus(
      adminId,
      ctx,
      versionId,
      'WITHDRAWN',
      'synthetic withdrawal reason',
    )
    // Immediately excluded; nothing deleted or rewritten.
    expect(await candidateIds({ language: 'en' })).not.toContain(versionId)
    const version = await readVersion(versionId)
    expect(version.status).toBe('PUBLISHED')
    expect(version.body).toContain('Integration-test prayer block')
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('rights audit metadata never contains sacred bodies or note text', async () => {
    const rightsAudits = await getDb()
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    const rightsRows = rightsAudits.filter((row) =>
      row.action.startsWith('sacred_content.rights_'),
    )
    expect(rightsRows.length).toBeGreaterThan(0)
    for (const row of rightsAudits.filter((r) =>
      r.action.startsWith('sacred_content.'),
    )) {
      const metadata = JSON.stringify(row.metadataJson ?? {})
      expect(metadata).not.toContain('Integration-test prayer block')
      expect(metadata).not.toContain('synthetic test restriction reason')
      expect(metadata).not.toContain('synthetic withdrawal reason')
    }
  })
})

// --- Runtime enablement (§65) -----------------------------------------------

describe('runtime enablement', () => {
  it('fails closed for every missing prerequisite, then succeeds when all gates hold', async () => {
    const itemId = await makeSacredItem({ contentType: 'OPENING' })
    const version = await createSacredVersion(
      cmId,
      ctx,
      itemId,
      baseVersion(),
      baseProfile({ accessPolicy: 'STAFF_ONLY' }),
    )

    // DRAFT (not published) → refused.
    await expectError(() =>
      setSacredRuntimeEnabled(adminId, ctx, version.id, true),
    )
    await submitVersionForReview(cmId, ctx, version.id)
    await approveVersion(adminId, ctx, version.id)
    // APPROVED but not published → refused.
    await expectError(() =>
      setSacredRuntimeEnabled(adminId, ctx, version.id, true),
    )
    await publishVersion(adminId, ctx, version.id)
    // Published but rights UNREVIEWED → refused.
    await expectError(() =>
      setSacredRuntimeEnabled(adminId, ctx, version.id, true),
    )
    await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
    await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
    // Rights CLEARED but access policy STAFF_ONLY → refused.
    const staffOnlyError = await expectError(() =>
      setSacredRuntimeEnabled(adminId, ctx, version.id, true),
    )
    expect(staffOnlyError.message).toContain('access_policy')

    // A second, fully valid version on another item enables fine, and
    // CM is denied.
    const valid = await makeSacredItem({ contentType: 'CLOSING' })
    const validVersion = await makePublishedSacred(valid)
    await setSacredRightsStatus(adminId, ctx, validVersion, 'PENDING_REVIEW')
    await setSacredRightsStatus(adminId, ctx, validVersion, 'CLEARED')
    await expectError(
      () => setSacredRuntimeEnabled(cmId, ctx, validVersion, true),
      'forbidden',
    )
    await setSacredRuntimeEnabled(adminId, ctx, validVersion, true)
    expect((await readProfile(validVersion)).runtimeEnabled).toBe(true)
    expect(await candidateIds({ language: 'en' })).toContain(validVersion)

    // Disable removes it from candidates immediately.
    await setSacredRuntimeEnabled(adminId, ctx, validVersion, false)
    expect(await candidateIds({ language: 'en' })).not.toContain(validVersion)

    await setContentItemActive(adminId, ctx, itemId, false)
    await setContentItemActive(adminId, ctx, valid, false)
  })

  it('inactive item and corrupted hash block enablement', async () => {
    const { itemId, versionId } = await makeRuntimeEligible({
      contentType: 'GREETING',
    })
    await setSacredRuntimeEnabled(adminId, ctx, versionId, false)

    // Inactive item → enable refused.
    await setContentItemActive(adminId, ctx, itemId, false)
    await expectError(() =>
      setSacredRuntimeEnabled(adminId, ctx, versionId, true),
    )
    await setContentItemActive(adminId, ctx, itemId, true)

    // Corrupted hash → enable refused, fails closed.
    await getDb()
      .update(sacredContentVersionProfiles)
      .set({ contentSha256: 'f'.repeat(64) })
      .where(eq(sacredContentVersionProfiles.contentVersionId, versionId))
    const hashError = await expectError(() =>
      setSacredRuntimeEnabled(adminId, ctx, versionId, true),
    )
    expect(hashError.message).toContain('hash_mismatch')
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('item deactivation removes runtime eligibility immediately', async () => {
    const { itemId, versionId } = await makeRuntimeEligible({
      contentType: 'REFLECTION',
    })
    expect(await candidateIds({ language: 'en' })).toContain(versionId)
    await setContentItemActive(adminId, ctx, itemId, false)
    expect(await candidateIds({ language: 'en' })).not.toContain(versionId)
    // History untouched.
    expect((await readVersion(versionId)).status).toBe('PUBLISHED')
  })
})

// --- Hash integrity (§66) ---------------------------------------------------

describe('content SHA-256', () => {
  it('publication stamps the hash from the authoritative stored body', async () => {
    const itemId = await makeSacredItem({ contentType: 'CALL_RESPONSE' })
    const body = 'Integration-test prayer block A\nÀdúrà ìdánwò — synthetic.'
    const versionId = await makePublishedSacred(itemId, { body })
    const profile = await readProfile(versionId)
    expect(profile.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    const expected = createHash('sha256')
      .update((await readVersion(versionId)).body, 'utf8')
      .digest('hex')
    expect(profile.contentSha256).toBe(expected)
    expect(await verifySacredVersionHash(versionId)).toBe(true)

    // Replacement publication: new hash on v2, old hash retained on v1.
    const v2 = await createSacredVersion(
      cmId,
      ctx,
      itemId,
      baseVersion({ body: 'Integration-test prayer block B' }),
      baseProfile(),
    )
    await submitVersionForReview(cmId, ctx, v2.id)
    await approveVersion(adminId, ctx, v2.id)
    await publishVersion(adminId, ctx, v2.id)
    const v2Profile = await readProfile(v2.id)
    expect(v2Profile.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(v2Profile.contentSha256).not.toBe(profile.contentSha256)
    const archived = await readVersion(versionId)
    expect(archived.status).toBe('ARCHIVED')
    expect((await readProfile(versionId)).contentSha256).toBe(
      profile.contentSha256,
    )
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('a corrupted stored hash fails closed and is never auto-healed', async () => {
    const { itemId, versionId } = await makeRuntimeEligible({
      contentType: 'HOUSE_INTRO',
    })
    expect(await candidateIds({ language: 'en' })).toContain(versionId)

    const corrupted = 'a'.repeat(64)
    await getDb()
      .update(sacredContentVersionProfiles)
      .set({ contentSha256: corrupted })
      .where(eq(sacredContentVersionProfiles.contentVersionId, versionId))

    expect(await verifySacredVersionHash(versionId)).toBe(false)
    expect(await candidateIds({ language: 'en' })).not.toContain(versionId)
    // NOT auto-healed by the eligibility check.
    expect((await readProfile(versionId)).contentSha256).toBe(corrupted)
    await setContentItemActive(adminId, ctx, itemId, false)
  })
})

// --- Candidate query & scope (§67/§68) --------------------------------------

describe('runtime candidate query', () => {
  it('returns only fully-gated content in the exact requested language, with scope but no composition', async () => {
    const theme = `T8_THEME_${crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')}`
    // Eligible: platform en, service-scoped en, house-scoped en, yo platform.
    const platformEn = await makeRuntimeEligible(
      { contentType: 'PRAYER' },
      {},
      { themeCode: theme },
    )
    const serviceEn = await makeRuntimeEligible(
      { contentType: 'PRAYER', scopeType: 'SERVICE', serviceId },
      {},
      { themeCode: theme },
    )
    const houseEn = await makeRuntimeEligible(
      {
        contentType: 'PRAYER',
        scopeType: 'SACRED_HOUSE',
        sacredHouseId: houseId,
      },
      {},
      { themeCode: theme },
    )
    const platformYo = await makeRuntimeEligible(
      { contentType: 'PRAYER' },
      { language: 'yo', body: 'Ìdánwò àkọsílẹ̀ — synthetic test text' },
      { themeCode: theme },
    )
    const otherServiceEn = await makeRuntimeEligible(
      {
        contentType: 'PRAYER',
        scopeType: 'SERVICE',
        serviceId: otherServiceId,
      },
      {},
      { themeCode: theme },
    )

    // Excluded despite various stages: draft, approved-only, published
    // w/o rights, restricted, staff-only, archival, runtime-disabled.
    const draftItem = await makeSacredItem()
    const draft = await createSacredVersion(
      cmId,
      ctx,
      draftItem,
      baseVersion(),
      baseProfile({ themeCode: theme }),
    )
    const approvedOnlyItem = await makeSacredItem()
    const approvedOnly = await createSacredVersion(
      cmId,
      ctx,
      approvedOnlyItem,
      baseVersion(),
      baseProfile({ themeCode: theme }),
    )
    await submitVersionForReview(cmId, ctx, approvedOnly.id)
    await approveVersion(adminId, ctx, approvedOnly.id)
    const unreviewedItem = await makeSacredItem()
    const unreviewedRights = await makePublishedSacred(
      unreviewedItem,
      {},
      { themeCode: theme },
    )
    const staffOnlyItem = await makeSacredItem()
    const staffOnly = await makePublishedSacred(
      staffOnlyItem,
      {},
      { accessPolicy: 'STAFF_ONLY', themeCode: theme },
    )
    const archivalItem = await makeSacredItem()
    const archival = await makePublishedSacred(
      archivalItem,
      {},
      { accessPolicy: 'ARCHIVAL_RESTRICTED', themeCode: theme },
    )
    const disabled = await makeRuntimeEligible(
      { contentType: 'PRAYER' },
      {},
      { themeCode: theme },
    )
    await setSacredRuntimeEnabled(adminId, ctx, disabled.versionId, false)

    const rows = await listEligibleSacredRuntimeContent({
      language: 'en',
      serviceId,
      sacredHouseId: houseId,
      themeCode: theme,
    })
    const ids = rows.map((r) => r.contentVersionId)
    // Included: platform + matching service + matching house, en only.
    expect(ids).toContain(platformEn.versionId)
    expect(ids).toContain(serviceEn.versionId)
    expect(ids).toContain(houseEn.versionId)
    // Exact language only — the yo version is absent (no fallback).
    expect(ids).not.toContain(platformYo.versionId)
    // Wrong service excluded.
    expect(ids).not.toContain(otherServiceEn.versionId)
    // Every governance failure excluded.
    for (const excluded of [
      draft.id,
      approvedOnly.id,
      unreviewedRights,
      staffOnly,
      archival,
      disabled.versionId,
    ]) {
      expect(ids).not.toContain(excluded)
    }
    // Scope is REPORTED, not composed — all three scopes co-exist with
    // no priority collapse (unlike Step 7 highest-specificity-wins).
    const scopes = new Set(rows.map((r) => r.scopeType))
    expect(scopes.has('PLATFORM')).toBe(true)
    expect(scopes.has('SERVICE')).toBe(true)
    expect(scopes.has('SACRED_HOUSE')).toBe(true)

    // The yo candidate appears for a yo query.
    const yoIds = await candidateIds({ language: 'yo', themeCode: theme })
    expect(yoIds).toContain(platformYo.versionId)
    expect(yoIds).not.toContain(platformEn.versionId)

    // Without the service/house filters, scoped rows are absent.
    const platformOnly = await candidateIds({
      language: 'en',
      themeCode: theme,
    })
    expect(platformOnly).toContain(platformEn.versionId)
    expect(platformOnly).not.toContain(serviceEn.versionId)
    expect(platformOnly).not.toContain(houseEn.versionId)

    // Default payload carries machine metadata but NEVER the body.
    for (const row of rows) {
      expect('body' in row).toBe(false)
      expect(row.contentSha256).toMatch(/^[0-9a-f]{64}$/)
    }
    // Internal trusted variant may include the body.
    const withBody = await listEligibleSacredRuntimeContent(
      { language: 'en', themeCode: theme },
      { includeBody: true },
    )
    expect(
      withBody.some(
        (r) =>
          'body' in r &&
          (r as { body: string }).body.includes('Integration-test prayer'),
      ),
    ).toBe(true)

    for (const fixture of [
      platformEn.itemId,
      serviceEn.itemId,
      houseEn.itemId,
      platformYo.itemId,
      otherServiceEn.itemId,
      unreviewedItem,
      staffOnlyItem,
      archivalItem,
      disabled.itemId,
    ]) {
      await setContentItemActive(adminId, ctx, fixture, false)
    }
    // Governance assertions, not a performance budget: this fixture is
    // large and the shared test database accumulates rows across every
    // suite, so it gets the same generous timeout as the other heavy
    // integration tests rather than the 5s default.
  }, 240_000)

  it('candidate query needs no user data and filters by content type', async () => {
    const theme = `T8_TT_${crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')}`
    const blessing = await makeRuntimeEligible(
      { contentType: 'BLESSING' },
      {},
      { themeCode: theme },
    )
    const prayer = await makeRuntimeEligible(
      { contentType: 'PRAYER' },
      {},
      { themeCode: theme },
    )
    const onlyBlessings = await listEligibleSacredRuntimeContent({
      language: 'en',
      contentType: 'BLESSING',
      themeCode: theme,
    })
    expect(onlyBlessings.map((r) => r.contentVersionId)).toContain(
      blessing.versionId,
    )
    expect(onlyBlessings.map((r) => r.contentVersionId)).not.toContain(
      prayer.versionId,
    )
    await setContentItemActive(adminId, ctx, blessing.itemId, false)
    await setContentItemActive(adminId, ctx, prayer.itemId, false)
  })
})

// --- Policy validation (§69) ------------------------------------------------

describe('controlled policy validation', () => {
  it('rejects every out-of-vocabulary policy value and bounds violation', async () => {
    const itemId = await makeSacredItem()
    const badProfiles: Array<Partial<Record<string, unknown>>> = [
      { variantKind: 'REMIX' },
      { provenanceType: 'INTERNET_SOURCE' },
      { voicePolicy: 'VOICE_CLONE' },
      { externalAiPolicy: 'FULL_ACCESS' },
      { accessPolicy: 'PUBLIC' },
      { themeCode: 'lower_case_theme' },
      { themeCode: 'BAD THEME WITH SPACES' },
      { durationHintSeconds: 0 },
      { durationHintSeconds: 601 },
      { durationHintSeconds: -5 },
    ]
    for (const bad of badProfiles) {
      await expectError(
        () =>
          createSacredVersion(cmId, ctx, itemId, baseVersion(), {
            ...baseProfile(),
            ...bad,
          }),
        'any',
      )
    }
    // Sacred item creation refuses guidance types and unknown types.
    for (const badType of [
      'PREPARATION',
      'SILENCE',
      'INSTRUCTION',
      'FOLLOW_UP',
    ]) {
      await expectError(
        () =>
          createSacredContentItem(cmId, ctx, {
            code: nextCode(),
            contentType: badType as never,
            scopeType: 'PLATFORM',
            sacredHouseId: null,
            serviceId: null,
            sortOrder: 0,
          }),
        'any',
      )
    }
    // No version leaked from the failed attempts.
    const versions = await getDb()
      .select()
      .from(spiritualContentVersions)
      .where(eq(spiritualContentVersions.contentItemId, itemId))
    expect(versions.length).toBe(0)
  })

  it('stores hostile plain text safely and preserves Yorùbá diacritics exactly', async () => {
    const itemId = await makeSacredItem({ contentType: 'CHANT' })
    const hostile = '<script>alert(1)</script>\nÀdúrà ìdánwò — ẹ̀kọ́ àṣà.'
    const version = await createSacredVersion(
      cmId,
      ctx,
      itemId,
      baseVersion({ title: '<script>alert(1)</script>', body: hostile }),
      baseProfile(),
    )
    const stored = await readVersion(version.id)
    expect(stored.title).toBe('<script>alert(1)</script>')
    expect(stored.body).toBe(hostile)
  })

  it('no route renders sacred content through dangerouslySetInnerHTML', () => {
    const routesDir = join(process.cwd(), 'src', 'routes')
    for (const entry of readdirSync(routesDir)) {
      if (!/\.tsx?$/.test(entry)) continue
      const source = readFileSync(join(routesDir, entry), 'utf8')
      expect(source).not.toContain('dangerouslySetInnerHTML')
    }
  })

  it('Step 8 modules introduce no AI/TTS/translation/render providers', () => {
    const files = [
      'src/services/sacred-content.ts',
      'src/services/sacred-content-actions.ts',
      'src/services/spiritual-content.ts',
      'src/routes/admin.sacred-content.index.tsx',
      'src/routes/admin.sacred-content.new.tsx',
      'src/routes/admin.sacred-content.$id.tsx',
      'src/routes/admin.sacred-content.review.tsx',
      'src/routes/admin.sacred-content.runtime.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(
        /kling|openart|remotion|ffmpeg|elevenlabs|text-to-speech|\btts\b|openai|anthropic\s*\(|new Anthropic|translate\(|generatePrayer/i,
      )
    }
    const routeTree = readFileSync(
      join(process.cwd(), 'src', 'routeTree.gen.ts'),
      'utf8',
    )
    // Step 18 builds the recorded Prayer Room, so "none exists" is no
    // longer the fence. The fence is now the SHAPE of that surface:
    // exactly one owner-only page and one AUTHENTICATED media endpoint,
    // and nothing else — no public route, no second media path.
    const prayerRoomPaths = [...routeTree.matchAll(/fullPath: '([^']*prayer-room[^']*)'/g)]
      .map((match) => match[1])
      .sort()
    expect(prayerRoomPaths).toEqual([
      '/api/prayer-room/$publicId/media',
      '/prayer-room/$publicId',
    ])
  })
})

// --- Concurrency (§72–§74) --------------------------------------------------

describe('concurrency', () => {
  it('concurrent sacred version creation yields exactly one version WITH its profile', async () => {
    const itemId = await makeSacredItem()
    const results = await Promise.allSettled([
      createSacredVersion(cmId, ctx, itemId, baseVersion(), baseProfile()),
      createSacredVersion(cmId, ctx, itemId, baseVersion(), baseProfile()),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const versions = await getDb()
      .select()
      .from(spiritualContentVersions)
      .where(eq(spiritualContentVersions.contentItemId, itemId))
    expect(versions.length).toBe(1)
    expect(versions[0].versionNumber).toBe(1)
    const profiles = await getSacredVersionProfiles(itemId)
    expect(profiles.length).toBe(1)
    expect(profiles[0].contentVersionId).toBe(versions[0].id)
  })

  it('publish racing runtime-enable never yields an invalid enabled state', async () => {
    const itemId = await makeSacredItem({ contentType: 'PRAYER' })
    const version = await createSacredVersion(
      cmId,
      ctx,
      itemId,
      baseVersion(),
      baseProfile(),
    )
    await submitVersionForReview(cmId, ctx, version.id)
    await approveVersion(adminId, ctx, version.id)
    // Rights cannot be CLEARED yet? APPROVED allows clearing.
    await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
    await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')

    const [publishResult, enableResult] = await Promise.allSettled([
      publishVersion(adminId, ctx, version.id),
      setSacredRuntimeEnabled(adminId, ctx, version.id, true),
    ])
    expect(publishResult.status).toBe('fulfilled')
    const profile = await readProfile(version.id)
    const row = await readVersion(version.id)
    if (enableResult.status === 'fulfilled') {
      // Enable serialized AFTER publication: everything must be valid.
      expect(row.status).toBe('PUBLISHED')
      expect(profile.runtimeEnabled).toBe(true)
      expect(profile.contentSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(
        isSacredVersionRuntimeEligible({
          item: (await getContentItemDetail(itemId)).item,
          version: row,
          profile,
        }).eligible,
      ).toBe(true)
    } else {
      // Enable lost the race (hash/publication not yet visible): the
      // flag stays FALSE — no half-enabled state.
      expect(profile.runtimeEnabled).toBe(false)
      // A serialized retry after publication succeeds.
      await setSacredRuntimeEnabled(adminId, ctx, version.id, true)
      expect((await readProfile(version.id)).runtimeEnabled).toBe(true)
    }
    await setContentItemActive(adminId, ctx, itemId, false)
  })

  it('rights withdrawal racing candidate queries settles to exclusion', async () => {
    const { itemId, versionId } = await makeRuntimeEligible({
      contentType: 'INVOCATION',
    })
    const [withdrawal] = await Promise.allSettled([
      setSacredRightsStatus(
        adminId,
        ctx,
        versionId,
        'WITHDRAWN',
        'synthetic race withdrawal',
      ),
      candidateIds({ language: 'en' }),
      candidateIds({ language: 'en' }),
    ])
    expect(withdrawal.status).toBe('fulfilled')
    // After the withdrawal commit, EVERY subsequent query excludes it.
    expect(await candidateIds({ language: 'en' })).not.toContain(versionId)
    expect(await candidateIds({ language: 'en' })).not.toContain(versionId)
    await setContentItemActive(adminId, ctx, itemId, false)
  })
})

// --- Hardening: cross-domain item authority & domain-aware audits -----------

describe('cross-domain item authority', () => {
  it('a guidance-scoped mutation cannot touch a sacred item (and vice versa) and leaves it unchanged', async () => {
    const sacredId = await makeSacredItem({
      contentType: 'BLESSING',
      sortOrder: 3,
    })
    const guidanceItem = await createContentItem(cmId, ctx, {
      code: nextCode(),
      contentType: 'PREPARATION',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 4,
    })
    createdItemIds.push(guidanceItem.id)
    const sacredBefore = (await getContentItemDetail(sacredId)).item
    const guidanceBefore = (await getContentItemDetail(guidanceItem.id)).item

    // Step 7 (GUIDANCE-scoped) update refused on a sacred item.
    await expectError(() =>
      updateContentItem(
        cmId,
        ctx,
        sacredId,
        {
          code: nextCode(),
          contentType: 'PREPARATION',
          scopeType: 'PLATFORM',
          sacredHouseId: null,
          serviceId: null,
          sortOrder: 99,
        },
        'GUIDANCE',
      ),
    )
    // Step 7 (GUIDANCE-scoped) active toggle refused on a sacred item.
    await expectError(() =>
      setContentItemActive(cmId, ctx, sacredId, false, 'GUIDANCE'),
    )
    const sacredAfter = (await getContentItemDetail(sacredId)).item
    expect(sacredAfter.code).toBe(sacredBefore.code)
    expect(sacredAfter.contentType).toBe('BLESSING')
    expect(sacredAfter.sortOrder).toBe(3)
    expect(sacredAfter.active).toBe(true)

    // Step 8 (SACRED_RUNTIME-scoped) update refused on a guidance item.
    await expectError(() =>
      updateContentItem(
        cmId,
        ctx,
        guidanceItem.id,
        {
          code: nextCode(),
          contentType: 'BLESSING',
          scopeType: 'PLATFORM',
          sacredHouseId: null,
          serviceId: null,
          sortOrder: 99,
        },
        'SACRED_RUNTIME',
      ),
    )
    // Step 8 (SACRED_RUNTIME-scoped) active toggle refused on guidance.
    await expectError(() =>
      setContentItemActive(cmId, ctx, guidanceItem.id, false, 'SACRED_RUNTIME'),
    )
    const guidanceAfter = (await getContentItemDetail(guidanceItem.id)).item
    expect(guidanceAfter.code).toBe(guidanceBefore.code)
    expect(guidanceAfter.contentType).toBe('PREPARATION')
    expect(guidanceAfter.sortOrder).toBe(4)
    expect(guidanceAfter.active).toBe(true)

    // Correctly-scoped mutations still work on their own domain.
    await updateContentItem(
      cmId,
      ctx,
      sacredId,
      {
        code: sacredBefore.code,
        contentType: 'BLESSING',
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
        sortOrder: 5,
      },
      'SACRED_RUNTIME',
    )
    expect((await getContentItemDetail(sacredId)).item.sortOrder).toBe(5)
    await setContentItemActive(cmId, ctx, guidanceItem.id, false, 'GUIDANCE')
    expect((await getContentItemDetail(guidanceItem.id)).item.active).toBe(
      false,
    )
  })

  it('item mutation audits carry the domain prefix without duplication or leakage', async () => {
    const sacredId = await makeSacredItem({ contentType: 'OPENING' })
    const sacredCode = (await getContentItemDetail(sacredId)).item.code
    await updateContentItem(
      cmId,
      ctx,
      sacredId,
      {
        code: sacredCode,
        contentType: 'OPENING',
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
        sortOrder: 7,
      },
      'SACRED_RUNTIME',
    )
    await setContentItemActive(cmId, ctx, sacredId, false, 'SACRED_RUNTIME')

    const guidanceItem = await createContentItem(cmId, ctx, {
      code: nextCode(),
      contentType: 'WHAT_TO_EXPECT',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 0,
    })
    createdItemIds.push(guidanceItem.id)
    const guidanceCode = (await getContentItemDetail(guidanceItem.id)).item.code
    await updateContentItem(
      cmId,
      ctx,
      guidanceItem.id,
      {
        code: guidanceCode,
        contentType: 'WHAT_TO_EXPECT',
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
        sortOrder: 8,
      },
      'GUIDANCE',
    )
    await setContentItemActive(cmId, ctx, guidanceItem.id, false, 'GUIDANCE')

    async function itemAudits(itemId: number) {
      return getDb()
        .select({
          action: auditLogs.action,
          metadataJson: auditLogs.metadataJson,
        })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.entityType, 'spiritual_content_item'),
            eq(auditLogs.entityId, String(itemId)),
          ),
        )
    }
    const sacredAudits = await itemAudits(sacredId)
    const sacredActions = sacredAudits.map((row) => row.action)
    expect(sacredActions).toContain('sacred_content.item_updated')
    expect(sacredActions).toContain('sacred_content.item_deactivated')
    // Exactly one event per mutation — never a duplicated wrong-domain
    // twin.
    expect(sacredActions).not.toContain('spiritual_content.item_updated')
    expect(sacredActions).not.toContain('spiritual_content.item_deactivated')
    expect(
      sacredActions.filter((a) => a === 'sacred_content.item_deactivated')
        .length,
    ).toBe(1)

    const guidanceAudits = await itemAudits(guidanceItem.id)
    const guidanceActions = guidanceAudits.map((row) => row.action)
    expect(guidanceActions).toContain('spiritual_content.item_updated')
    expect(guidanceActions).toContain('spiritual_content.item_deactivated')
    expect(guidanceActions).not.toContain('sacred_content.item_updated')
    expect(guidanceActions).not.toContain('sacred_content.item_deactivated')

    // No bodies/notes in item audit metadata.
    for (const row of [...sacredAudits, ...guidanceAudits]) {
      const metadata = JSON.stringify(row.metadataJson ?? {})
      expect(metadata).not.toContain('Integration-test prayer block')
      expect(metadata).not.toContain('synthetic')
    }
  })
})

describe('the V3 launch pack keeps its governed identity', () => {
  /**
   * The 24-block platform-authored launch pack, registered under client
   * authority on 2026-09-04.
   *
   * These assertions run against production rows, so they return early
   * on a database that has none — a fresh CI schema must not fail for
   * lacking launch content. Where the rows DO exist they are asserted
   * hard, because every property below was a deliberate governance
   * decision rather than a default.
   */
  const REQUIRED = [
    'OPENING',
    'INVOCATION',
    'CHANT',
    'PRAYER',
    'BLESSING',
    'CLOSING',
  ]
  const HOUSES = [
    { id: 1, code: 'ABULE_OSUN' },
    { id: 2, code: 'ABULE_AJE' },
    { id: 3, code: 'ABULE_OSANYIN_AJA' },
    { id: 4, code: 'ILE_AWON_BABALAWO' },
  ]

  async function v3Rows() {
    return getDb()
      .select({
        code: spiritualContentItems.code,
        houseId: spiritualContentItems.sacredHouseId,
        scopeType: spiritualContentItems.scopeType,
        contentType: spiritualContentItems.contentType,
        versionId: spiritualContentVersions.id,
        language: spiritualContentVersions.language,
        status: spiritualContentVersions.status,
        body: spiritualContentVersions.body,
        variantKind: sacredContentVersionProfiles.variantKind,
        voicePolicy: sacredContentVersionProfiles.voicePolicy,
        externalAiPolicy: sacredContentVersionProfiles.externalAiPolicy,
        accessPolicy: sacredContentVersionProfiles.accessPolicy,
        rightsStatus: sacredContentVersionProfiles.rightsStatus,
        runtimeEnabled: sacredContentVersionProfiles.runtimeEnabled,
        storageOk: sacredContentVersionProfiles.digitalStorageAuthorized,
        provenanceType: sacredContentVersionProfiles.provenanceType,
        note: sacredContentVersionProfiles.internalProvenanceNote,
        contentSha256: sacredContentVersionProfiles.contentSha256,
      })
      .from(spiritualContentItems)
      .innerJoin(
        spiritualContentVersions,
        eq(spiritualContentVersions.contentItemId, spiritualContentItems.id),
      )
      .innerJoin(
        sacredContentVersionProfiles,
        eq(
          sacredContentVersionProfiles.contentVersionId,
          spiritualContentVersions.id,
        ),
      )
      .where(like(spiritualContentItems.code, 'V3\\_%'))
  }

  it('is 24 Yoruba production rows and 24 English companions', async () => {
    const rows = await v3Rows()
    if (rows.length === 0) return
    expect(rows).toHaveLength(48)
    expect(rows.filter((r) => r.language === 'yo')).toHaveLength(24)
    expect(rows.filter((r) => r.language === 'en')).toHaveLength(24)
  })

  it('speaks Yoruba and never English', async () => {
    const rows = await v3Rows()
    if (rows.length === 0) return
    for (const row of rows) {
      if (row.language === 'yo') {
        expect(row.voicePolicy).toBe('APPROVED_TTS_ALLOWED')
        expect(row.variantKind).toBe('ORIGINAL')
      } else {
        // TEXT_ONLY is what makes English structurally unspeakable. A
        // Yoruba template would not select it anyway, but the policy is
        // the lock rather than the language filter.
        expect(row.voicePolicy).toBe('TEXT_ONLY')
        expect(row.variantKind).toBe('TRANSLATION')
      }
    }
  })

  it('claims platform authorship and never tradition', async () => {
    const rows = await v3Rows()
    if (rows.length === 0) return
    for (const row of rows) {
      expect(row.provenanceType).toBe('ORIGINAL_AUTHORED')
      // The value that WOULD misrepresent this material.
      expect(row.provenanceType).not.toBe('TRADITIONAL_ORAL')
      expect(row.note).toContain('PLATFORM_AUTHORED_LAUNCH_CONTENT')
    }
  })

  it('carries METADATA_ONLY, which is not a speech permission', async () => {
    const rows = await v3Rows()
    if (rows.length === 0) return
    for (const row of rows) {
      expect(row.externalAiPolicy).toBe('METADATA_ONLY')
    }
    // The distinction that matters: the speech executor never consults
    // externalAiPolicy. voicePolicy is the sole authority over whether
    // approved text may reach a speech vendor, so METADATA_ONLY must
    // never be read as authorising or forbidding synthesis.
    const audio = readFileSync(
      join(process.cwd(), 'src/services/audio-generation.ts'),
      'utf8',
    )
    expect(audio).not.toContain('externalAiPolicy')
  })

  it('stores the exact bytes it hashed, with no normalisation', async () => {
    const rows = await v3Rows()
    if (rows.length === 0) return
    for (const row of rows) {
      const recomputed = createHash('sha256')
        .update(row.body, 'utf8')
        .digest('hex')
      expect(row.contentSha256).toBe(recomputed)
    }
    // Yoruba orthography survives: dot-below letters plus COMBINING
    // tone marks. Normalising to NFD would decompose the dots and
    // change every hash above.
    const yoruba = rows
      .filter((r) => r.language === 'yo')
      .map((r) => r.body)
      .join('')
    expect(yoruba).toContain('ọ̀')
    expect(yoruba.normalize('NFC')).toBe(yoruba)
    expect(yoruba).not.toContain('�')
  })

  it('gives every House its own six and none from a neighbour', async () => {
    const rows = await v3Rows()
    if (rows.length === 0) return
    const yoruba = rows.filter((r) => r.language === 'yo')

    for (const house of HOUSES) {
      const mine = yoruba.filter((r) => r.houseId === house.id)
      expect(mine.map((r) => r.contentType).sort()).toEqual([...REQUIRED].sort())
      for (const row of mine) {
        // Every runtime condition together — any one of them false
        // makes the row ineligible and the House not ready.
        expect(row.scopeType).toBe('SACRED_HOUSE')
        expect(row.status).toBe('PUBLISHED')
        expect(row.rightsStatus).toBe('CLEARED')
        expect(row.accessPolicy).toBe('PRAYER_ROOM_PRIVATE')
        expect(row.runtimeEnabled).toBe(true)
        expect(row.storageOk).toBe(true)
        expect(row.language).toBe('yo')
        // Its code names the House it belongs to. The V3 document
        // numbers its Houses 1-4 in an order matching NONE of the
        // database ids, so a pack mapped by ordinal would have put
        // every set of prayers in the wrong House.
        expect(row.code).toContain(house.code)
      }
    }
  })

  it('leaves the templates and the Visual Bible unpublished', async () => {
    const rows = await v3Rows()
    if (rows.length === 0) return
    // Content publication was authorised because runtime eligibility
    // requires it. Template and Visual Bible publication was not, and
    // content readiness must never be allowed to imply it.
    const templates = await getDb()
      .select({
        id: prayerSessionTemplateVersions.id,
        status: prayerSessionTemplateVersions.status,
      })
      .from(prayerSessionTemplateVersions)
      .where(inArray(prayerSessionTemplateVersions.id, [28958, 35343]))
    for (const template of templates) {
      expect(template.status).toBe('APPROVED')
    }
    const bible = (
      await getDb()
        .select({
          status: visualBibleVersions.status,
          publishedAt: visualBibleVersions.publishedAt,
        })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, 886))
        .limit(1)
    ).at(0)
    if (bible) {
      expect(bible.status).toBe('APPROVED')
      expect(bible.publishedAt).toBeNull()
    }
  })
})
