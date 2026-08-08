import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  auditLogs,
  deitySacredHouses,
  spiritualInterests,
  userProfiles,
  userSpiritualInterests,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain, seedSpiritualInterests } from '@/db/seed-domain'
import { registerUser } from '@/auth/service'
import {
  InterestSelectionError,
  acceptRequiredConsents,
  canUserBookSpiritualService,
  getConsentStatus,
  getOwnProfile,
  getOwnSpiritualInterestIds,
  getProfileCompletion,
  listActiveSpiritualInterests,
  personalDetailsSchema,
  replaceSpiritualInterests,
  savePersonalDetails,
  setMarketingPreference,
} from '@/services/profile'

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `profile test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []

function adultDob(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 30)
  return d.toISOString().slice(0, 10)
}

function minorDob(): string {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 17)
  return d.toISOString().slice(0, 10)
}

const VALID_DETAILS = {
  fullName: 'Adéwálé Olúṣọlá Adébáyọ̀',
  preferredName: 'Adéwálé',
  phone: '+2348012345678',
  countryCode: 'NG',
  timezone: 'Africa/Lagos',
  preferredLanguage: 'en' as const,
  dateOfBirth: '1990-03-21',
}

async function makeUser(): Promise<number> {
  const result = await registerUser(
    {
      email: `p4-${crypto.randomUUID()}@test.local`,
      preferredName: 'P4 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  return result.user.id
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
})

afterAll(async () => {
  const db = getDb()
  if (createdUserIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    // users cascade-deletes profiles, interests and consents.
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await closeDb()
})

describe('personal profile', () => {
  it('creates and updates the profile with exact Yorùbá round-trip', async () => {
    const userId = await makeUser()
    await savePersonalDetails(userId, VALID_DETAILS, ctx)

    const row = await getOwnProfile(userId)
    expect(row?.fullName).toBe('Adéwálé Olúṣọlá Adébáyọ̀')
    expect(row?.phoneE164).toBe('+2348012345678')
    expect(row?.countryCode).toBe('NG')
    expect(row?.timezone).toBe('Africa/Lagos')
    expect(row?.dateOfBirth).toBe('1990-03-21')

    // Preferred name is canonical on the users row.
    const userRow = (
      await getDb().select().from(users).where(eq(users.id, userId)).limit(1)
    ).at(0)
    expect(userRow?.preferredName).toBe('Adéwálé')

    // Update pass.
    await savePersonalDetails(
      userId,
      { ...VALID_DETAILS, timezone: 'Europe/London' },
      ctx,
    )
    expect((await getOwnProfile(userId))?.timezone).toBe('Europe/London')
  })

  it('stores date of birth, never a calculated age column', async () => {
    const userId = await makeUser()
    await savePersonalDetails(userId, VALID_DETAILS, ctx)
    const row = await getOwnProfile(userId)
    expect(row).not.toBeNull()
    expect(Object.keys(row!)).not.toContain('age')
    expect(row!.dateOfBirth).toBe('1990-03-21')
  })

  it('full name changes never overwrite preferred name automatically', async () => {
    const userId = await makeUser()
    await savePersonalDetails(userId, VALID_DETAILS, ctx)
    await savePersonalDetails(
      userId,
      { ...VALID_DETAILS, fullName: 'Different Full Name Entirely' },
      ctx,
    )
    const userRow = (
      await getDb().select().from(users).where(eq(users.id, userId)).limit(1)
    ).at(0)
    expect(userRow?.preferredName).toBe('Adéwálé')
  })
})

describe('spiritual interests', () => {
  it('seeds the 18 approved interests idempotently', async () => {
    const before = await listActiveSpiritualInterests()
    expect(before.length).toBe(18)
    const codes = before.map((i) => i.code)
    for (const expected of [
      'FERTILITY',
      'CONCEPTION',
      'MOTHERHOOD',
      'FAMILY',
      'PROSPERITY',
      'BUSINESS',
      'EMPLOYMENT',
      'FINANCIAL_STABILITY',
      'WELLBEING',
      'PROTECTION',
      'PURIFICATION_CLEANSING',
      'FORGIVENESS',
      'DIVINATION',
      'ANCESTRAL_REMEMBRANCE',
      'VICTORY_OVER_ADVERSITY',
      'PERSONAL_DIRECTION',
      'GRATITUDE',
      'THANKSGIVING',
    ]) {
      expect(codes).toContain(expected)
    }

    await seedSpiritualInterests()
    await seedSpiritualInterests()
    expect((await listActiveSpiritualInterests()).length).toBe(18)
  })

  it('allows multiple, zero, and replacement; rejects duplicates and unknown ids', async () => {
    const userId = await makeUser()
    const catalogue = await listActiveSpiritualInterests()
    const [a, b, c] = catalogue.map((i) => i.id)

    await replaceSpiritualInterests(userId, [a, b, c], ctx)
    expect((await getOwnSpiritualInterestIds(userId)).sort()).toEqual(
      [a, b, c].sort(),
    )

    // Replacement.
    await replaceSpiritualInterests(userId, [b], ctx)
    expect(await getOwnSpiritualInterestIds(userId)).toEqual([b])

    // Zero is valid.
    await replaceSpiritualInterests(userId, [], ctx)
    expect(await getOwnSpiritualInterestIds(userId)).toEqual([])

    // Duplicates rejected.
    let thrown: unknown = null
    try {
      await replaceSpiritualInterests(userId, [a, a], ctx)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InterestSelectionError)

    // Unknown id rejected.
    thrown = null
    try {
      await replaceSpiritualInterests(userId, [999999], ctx)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InterestSelectionError)
  })

  it('never modifies the master catalogue and never infers deity/House links', async () => {
    const userId = await makeUser()
    const catalogueBefore = await getDb().select().from(spiritualInterests)
    const linksBefore = await getDb().select().from(deitySacredHouses)

    const fertility = catalogueBefore.find((i) => i.code === 'FERTILITY')!
    await replaceSpiritualInterests(userId, [fertility.id], ctx)

    const catalogueAfter = await getDb().select().from(spiritualInterests)
    const linksAfter = await getDb().select().from(deitySacredHouses)
    expect(catalogueAfter).toEqual(catalogueBefore)
    expect(linksAfter.length).toBe(linksBefore.length)

    // Selection stored only in the private junction table.
    const own = await getOwnSpiritualInterestIds(userId)
    expect(own).toEqual([fertility.id])
  })
})

describe('consents', () => {
  it('records required consents with type and version', async () => {
    const userId = await makeUser()
    let status = await getConsentStatus(userId)
    expect(status.required.every((c) => !c.accepted)).toBe(true)

    await acceptRequiredConsents(userId, ctx)
    status = await getConsentStatus(userId)
    expect(status.required.every((c) => c.accepted)).toBe(true)
    expect(status.required.map((c) => c.type).sort()).toEqual([
      'PRIVACY',
      'SPIRITUAL_NOTICE',
      'TERMS',
    ])
    expect(status.required.every((c) => c.currentVersion === '1')).toBe(true)
    // Idempotent re-acceptance.
    await acceptRequiredConsents(userId, ctx)
  })

  it('marketing is optional, reversible, and never blocks anything', async () => {
    const userId = await makeUser()
    expect((await getConsentStatus(userId)).marketingOptIn).toBe(false)

    await setMarketingPreference(userId, true, ctx)
    expect((await getConsentStatus(userId)).marketingOptIn).toBe(true)

    await setMarketingPreference(userId, false, ctx)
    expect((await getConsentStatus(userId)).marketingOptIn).toBe(false)

    // Declined marketing + full profile + required consents => complete.
    await savePersonalDetails(userId, VALID_DETAILS, ctx)
    await acceptRequiredConsents(userId, ctx)
    const completion = await getProfileCompletion(userId)
    expect(completion.complete).toBe(true)
    expect(completion.marketingOptIn).toBe(false)
  })
})

describe('profile completion and future-booking eligibility', () => {
  it('reports missing fields granularly and requires consents', async () => {
    const userId = await makeUser()
    let completion = await getProfileCompletion(userId)
    expect(completion.complete).toBe(false)
    expect(completion.missingFields.sort()).toEqual([
      'country',
      'dateOfBirth',
      'fullName',
      'phone',
      'preferredLanguage',
      'timezone',
    ])

    await savePersonalDetails(userId, VALID_DETAILS, ctx)
    completion = await getProfileCompletion(userId)
    expect(completion.missingFields).toEqual([])
    // Data complete but consents missing => not complete.
    expect(completion.requiredConsentsAccepted).toBe(false)
    expect(completion.complete).toBe(false)

    await acceptRequiredConsents(userId, ctx)
    completion = await getProfileCompletion(userId)
    expect(completion.complete).toBe(true)
    expect(completion.ageEligible).toBe(true)
  })

  it('zero spiritual interests does not block completion or eligibility', async () => {
    const userId = await makeUser()
    await savePersonalDetails(
      userId,
      { ...VALID_DETAILS, dateOfBirth: adultDob() },
      ctx,
    )
    await acceptRequiredConsents(userId, ctx)
    expect(await getOwnSpiritualInterestIds(userId)).toEqual([])

    const eligibility = await canUserBookSpiritualService(userId)
    expect(eligibility).toEqual({ eligible: true, reasons: [] })
  })

  it('a 17-year-old saves data and browses, but is not booking-eligible', async () => {
    const userId = await makeUser()
    await savePersonalDetails(
      userId,
      { ...VALID_DETAILS, dateOfBirth: minorDob() },
      ctx,
    )
    await acceptRequiredConsents(userId, ctx)

    const completion = await getProfileCompletion(userId)
    expect(completion.missingFields).toEqual([])
    expect(completion.ageEligible).toBe(false)

    const eligibility = await canUserBookSpiritualService(userId)
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.reasons).toEqual(['AGE_REQUIREMENT_NOT_MET'])
  })

  it('an exactly-18-year-old is eligible when everything else is complete', async () => {
    const userId = await makeUser()
    const d = new Date()
    d.setFullYear(d.getFullYear() - 18)
    const exactly18 = d.toISOString().slice(0, 10)
    await savePersonalDetails(
      userId,
      { ...VALID_DETAILS, dateOfBirth: exactly18 },
      ctx,
    )
    await acceptRequiredConsents(userId, ctx)
    const eligibility = await canUserBookSpiritualService(userId)
    expect(eligibility.eligible).toBe(true)
  })

  it('suspended accounts are not eligible even with a complete profile', async () => {
    const userId = await makeUser()
    await savePersonalDetails(userId, VALID_DETAILS, ctx)
    await acceptRequiredConsents(userId, ctx)
    await getDb()
      .update(users)
      .set({ accountStatus: 'SUSPENDED' })
      .where(eq(users.id, userId))
    const eligibility = await canUserBookSpiritualService(userId)
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.reasons).toContain('ACCOUNT_NOT_ACTIVE')
  })
})

describe('consent atomicity', () => {
  it('a failing required-consent transaction persists no consent rows at all', async () => {
    // A user id that violates the FK makes the transaction fail; the
    // atomic implementation must leave zero required-consent rows.
    const ghostUserId = 999_999_999
    let thrown: unknown = null
    try {
      await acceptRequiredConsents(ghostUserId, ctx)
    } catch (error) {
      thrown = error
    }
    expect(thrown).not.toBeNull()

    const { userConsents } = await import('@/db/schema')
    const rows = await getDb()
      .select()
      .from(userConsents)
      .where(eq(userConsents.userId, ghostUserId))
    expect(rows.length).toBe(0)
  })

  it('normal acceptance lands all three required rows together and stays idempotent', async () => {
    const userId = await makeUser()
    await acceptRequiredConsents(userId, ctx)
    const status = await getConsentStatus(userId)
    expect(status.required.filter((c) => c.accepted).length).toBe(3)

    await acceptRequiredConsents(userId, ctx)
    const { userConsents } = await import('@/db/schema')
    const rows = await getDb()
      .select()
      .from(userConsents)
      .where(eq(userConsents.userId, userId))
    expect(rows.length).toBe(3) // no duplicates from re-acceptance
  })
})

describe('timezone-aware eligibility wiring', () => {
  it('uses the stored profile timezone and fails closed when it is absent', async () => {
    const userId = await makeUser()
    await savePersonalDetails(
      userId,
      { ...VALID_DETAILS, dateOfBirth: adultDob() },
      ctx,
    )
    await acceptRequiredConsents(userId, ctx)
    expect((await getProfileCompletion(userId)).ageEligible).toBe(true)

    // Remove the timezone directly: no server-timezone fallback exists.
    await getDb()
      .update(userProfiles)
      .set({ timezone: null })
      .where(eq(userProfiles.userId, userId))

    const completion = await getProfileCompletion(userId)
    expect(completion.ageEligible).toBe(false)
    expect(completion.missingFields).toContain('timezone')
    expect(completion.complete).toBe(false)

    const eligibility = await canUserBookSpiritualService(userId)
    expect(eligibility.eligible).toBe(false)
    expect(eligibility.reasons).toContain('PROFILE_INCOMPLETE')
    expect(eligibility.reasons).toContain('AGE_REQUIREMENT_NOT_MET')
  })
})

describe('audit safety', () => {
  it('profile and interest updates audit field names/counts, never values', async () => {
    const userId = await makeUser()
    await savePersonalDetails(userId, VALID_DETAILS, ctx)
    const catalogue = await listActiveSpiritualInterests()
    await replaceSpiritualInterests(userId, [catalogue[0].id], ctx)
    await acceptRequiredConsents(userId, ctx)
    await setMarketingPreference(userId, true, ctx)

    const rows = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.actorUserId, userId))
    const actions = rows.map((r) => r.action)
    expect(actions).toContain('profile.created')
    expect(actions).toContain('spiritual_interests.updated')
    expect(actions).toContain('required_consent.accepted')
    expect(actions).toContain('marketing_consent.updated')

    const serialized = JSON.stringify(rows)
    // No sensitive values copied into audit metadata.
    expect(serialized).not.toContain('+2348012345678')
    expect(serialized).not.toContain('Adébáyọ̀')
    expect(serialized).not.toContain('1990-03-21')
    expect(serialized).not.toContain('FERTILITY')

    const interestsEvent = rows.find(
      (r) => r.action === 'spiritual_interests.updated',
    )!
    const metadata =
      typeof interestsEvent.metadataJson === 'string'
        ? (JSON.parse(interestsEvent.metadataJson) as Record<string, unknown>)
        : (interestsEvent.metadataJson as Record<string, unknown>)
    expect(metadata).toEqual({ selectedCount: 1 })
  })
})

describe('ownership boundary', () => {
  it('input schemas never carry a user id — the session decides the actor', () => {
    const parsed = personalDetailsSchema.parse({
      ...VALID_DETAILS,
      userId: 12345,
      id: 999,
    })
    expect('userId' in parsed).toBe(false)
    expect('id' in parsed).toBe(false)
  })

  it('profile reads are scoped to the requested user only', async () => {
    const a = await makeUser()
    const b = await makeUser()
    await savePersonalDetails(a, VALID_DETAILS, ctx)

    expect(await getOwnProfile(b)).toBeNull()
    const rows = await getDb()
      .select()
      .from(userProfiles)
      .where(eq(userProfiles.userId, a))
    expect(rows.length).toBe(1)

    // Interests are user-scoped too.
    const catalogue = await listActiveSpiritualInterests()
    await replaceSpiritualInterests(a, [catalogue[0].id], ctx)
    expect(await getOwnSpiritualInterestIds(b)).toEqual([])
    const junction = await getDb()
      .select()
      .from(userSpiritualInterests)
      .where(eq(userSpiritualInterests.userId, b))
    expect(junction.length).toBe(0)
  })
})
