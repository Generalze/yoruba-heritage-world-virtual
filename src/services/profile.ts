import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  spiritualInterests,
  userConsents,
  userProfiles,
  userSpiritualInterests,
  users,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { calculateAge, isAgeEligible } from '@/lib/age'
import { isValidCountryCode } from '@/lib/countries'
import type { RequestContext } from '@/auth/service'
import type { ConsentType } from '@/db/schema'

/**
 * Self-service profile domain (Phase One, Step 4).
 *
 * Ownership rule: every function takes the ACTING user's id, which the
 * server-function layer resolves from the authenticated session — a
 * client-supplied user id is never accepted as authority. Users can
 * only ever read or modify their own profile data.
 *
 * Privacy: spiritual interests are private; no admin browsing exists,
 * nothing here is exposed publicly, and nothing is sent to external
 * providers. Completion and booking eligibility are always computed
 * server-side from actual data — no trusted client flags.
 */

// --- Consent configuration --------------------------------------------------

/**
 * Development version identifiers. The legal text and real version
 * numbers are replaced before production; bumping a version here makes
 * re-acceptance required because consent rows are (type, version)
 * scoped.
 */
export const CONSENT_VERSIONS: Record<ConsentType, string> = {
  TERMS: '1',
  PRIVACY: '1',
  SPIRITUAL_NOTICE: '1',
  MARKETING: '1',
}

/** Marketing is deliberately NOT here — it is optional, never required. */
export const REQUIRED_CONSENT_TYPES: ReadonlyArray<ConsentType> = [
  'TERMS',
  'PRIVACY',
  'SPIRITUAL_NOTICE',
]

// --- Validation -------------------------------------------------------------

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'yo', name: 'Yorùbá' },
] as const

const IANA_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'))

/** Normalizes common separators, then requires E.164 (+ and 8–15 digits). */
export const phoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s\-().]/g, ''))
  .pipe(
    z
      .string()
      .regex(
        /^\+[1-9]\d{7,14}$/,
        'Enter the phone number in international format, e.g. +2348012345678.',
      ),
  )

export const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date of birth as YYYY-MM-DD.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`)
    if (Number.isNaN(parsed.getTime())) return false
    // Round-trip check rejects impossible dates like 2001-02-30.
    return parsed.toISOString().slice(0, 10) === value
  }, 'Enter a valid calendar date.')
  .refine((value) => value >= '1900-01-01', 'Enter a date of birth after 1900.')
  .refine((value) => {
    const today = new Date()
    const todayStr = [
      today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0'),
    ].join('-')
    return value <= todayStr
  }, 'Date of birth cannot be in the future.')

export const personalDetailsSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, 'Full name is required.')
    .max(200, 'Full name is too long.'),
  preferredName: z
    .string()
    .trim()
    .min(1, 'Preferred name is required.')
    .max(100, 'Preferred name is too long.'),
  phone: phoneSchema,
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .refine(isValidCountryCode, 'Select a valid country.'),
  timezone: z
    .string()
    .trim()
    .refine(
      (value) => IANA_TIMEZONES.has(value),
      'Select a valid timezone (e.g. Africa/Lagos).',
    ),
  preferredLanguage: z.enum(
    SUPPORTED_LANGUAGES.map((l) => l.code) as ['en', 'yo'],
    'Select a supported language.',
  ),
  dateOfBirth: dateOfBirthSchema,
})

export type PersonalDetailsInput = z.infer<typeof personalDetailsSchema>

// --- Personal profile -------------------------------------------------------

export async function getOwnProfile(userId: number) {
  return (
    (
      await getDb()
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.userId, userId))
        .limit(1)
    ).at(0) ?? null
  )
}

/**
 * Creates or updates the acting user's personal details, including the
 * canonical preferred name on the users row, in one transaction. Audit
 * metadata records field NAMES only — never the values.
 */
export async function savePersonalDetails(
  userId: number,
  input: PersonalDetailsInput,
  ctx: RequestContext,
): Promise<void> {
  const db = getDb()
  const existing = await getOwnProfile(userId)

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ preferredName: input.preferredName })
      .where(eq(users.id, userId))
    await tx
      .insert(userProfiles)
      .values({
        userId,
        fullName: input.fullName,
        phoneE164: input.phone,
        countryCode: input.countryCode,
        timezone: input.timezone,
        preferredLanguage: input.preferredLanguage,
        dateOfBirth: input.dateOfBirth,
      })
      .onDuplicateKeyUpdate({
        set: {
          fullName: input.fullName,
          phoneE164: input.phone,
          countryCode: input.countryCode,
          timezone: input.timezone,
          preferredLanguage: input.preferredLanguage,
          dateOfBirth: input.dateOfBirth,
        },
      })
  })

  await recordAuditEvent({
    actorUserId: userId,
    action: existing ? 'profile.updated' : 'profile.created',
    entityType: 'user',
    entityId: String(userId),
    metadata: {
      fields: [
        'fullName',
        'preferredName',
        'phone',
        'countryCode',
        'timezone',
        'preferredLanguage',
        'dateOfBirth',
      ],
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Spiritual interests ----------------------------------------------------

export async function listActiveSpiritualInterests() {
  return getDb()
    .select({
      id: spiritualInterests.id,
      code: spiritualInterests.code,
      name: spiritualInterests.name,
    })
    .from(spiritualInterests)
    .where(eq(spiritualInterests.active, true))
    .orderBy(spiritualInterests.sortOrder)
}

export async function getOwnSpiritualInterestIds(
  userId: number,
): Promise<Array<number>> {
  const rows = await getDb()
    .select({ id: userSpiritualInterests.spiritualInterestId })
    .from(userSpiritualInterests)
    .where(eq(userSpiritualInterests.userId, userId))
  return rows.map((row) => row.id)
}

export class InterestSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InterestSelectionError'
  }
}

/**
 * Replaces the acting user's interest selections transactionally.
 * Zero selections is perfectly valid. Every id must exist and be
 * active; duplicates are rejected. The master catalogue is never
 * touched. No deity, Sacred House, service or doctrine is ever
 * inferred from selections.
 */
export async function replaceSpiritualInterests(
  userId: number,
  interestIds: Array<number>,
  ctx: RequestContext,
): Promise<void> {
  if (new Set(interestIds).size !== interestIds.length) {
    throw new InterestSelectionError('Duplicate interests selected.')
  }
  if (interestIds.length > 0) {
    const valid = await getDb()
      .select({ id: spiritualInterests.id })
      .from(spiritualInterests)
      .where(
        and(
          inArray(spiritualInterests.id, interestIds),
          eq(spiritualInterests.active, true),
        ),
      )
    if (valid.length !== interestIds.length) {
      throw new InterestSelectionError('Unknown spiritual interest selected.')
    }
  }

  await getDb().transaction(async (tx) => {
    await tx
      .delete(userSpiritualInterests)
      .where(eq(userSpiritualInterests.userId, userId))
    if (interestIds.length > 0) {
      await tx
        .insert(userSpiritualInterests)
        .values(interestIds.map((id) => ({ userId, spiritualInterestId: id })))
    }
  })

  // Count only — selections themselves are private and stay out of logs.
  await recordAuditEvent({
    actorUserId: userId,
    action: 'spiritual_interests.updated',
    entityType: 'user',
    entityId: String(userId),
    metadata: { selectedCount: interestIds.length },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Consents ---------------------------------------------------------------

export interface ConsentStatus {
  required: Array<{
    type: ConsentType
    currentVersion: string
    accepted: boolean
    acceptedAt: Date | null
  }>
  marketingOptIn: boolean
}

export async function getConsentStatus(userId: number): Promise<ConsentStatus> {
  const rows = await getDb()
    .select()
    .from(userConsents)
    .where(eq(userConsents.userId, userId))

  const required = REQUIRED_CONSENT_TYPES.map((type) => {
    const row = rows.find(
      (r) =>
        r.consentType === type &&
        r.version === CONSENT_VERSIONS[type] &&
        r.revokedAt === null,
    )
    return {
      type,
      currentVersion: CONSENT_VERSIONS[type],
      accepted: row !== undefined,
      acceptedAt: row?.acceptedAt ?? null,
    }
  })

  const marketing = rows.find(
    (r) =>
      r.consentType === 'MARKETING' &&
      r.version === CONSENT_VERSIONS.MARKETING &&
      r.revokedAt === null,
  )

  return { required, marketingOptIn: marketing !== undefined }
}

/** Records acceptance of the required notices at their current versions. */
export async function acceptRequiredConsents(
  userId: number,
  ctx: RequestContext,
): Promise<void> {
  const db = getDb()
  for (const type of REQUIRED_CONSENT_TYPES) {
    const version = CONSENT_VERSIONS[type]
    const inserted = await db
      .insert(userConsents)
      .values({ userId, consentType: type, version })
      .onDuplicateKeyUpdate({ set: { revokedAt: null } })
    void inserted
    await recordAuditEvent({
      actorUserId: userId,
      action: 'required_consent.accepted',
      entityType: 'user',
      entityId: String(userId),
      metadata: { consentType: type, version },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  }
}

/** Marketing is optional and reversible; never required for anything. */
export async function setMarketingPreference(
  userId: number,
  optIn: boolean,
  ctx: RequestContext,
): Promise<void> {
  const version = CONSENT_VERSIONS.MARKETING
  if (optIn) {
    await getDb()
      .insert(userConsents)
      .values({ userId, consentType: 'MARKETING', version })
      .onDuplicateKeyUpdate({
        set: { revokedAt: null, acceptedAt: new Date() },
      })
  } else {
    await getDb()
      .update(userConsents)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(userConsents.userId, userId),
          eq(userConsents.consentType, 'MARKETING'),
          eq(userConsents.version, version),
          isNull(userConsents.revokedAt),
        ),
      )
  }
  await recordAuditEvent({
    actorUserId: userId,
    action: 'marketing_consent.updated',
    entityType: 'user',
    entityId: String(userId),
    metadata: { optIn, version },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Completion and future-booking eligibility ------------------------------

export interface ProfileCompletion {
  complete: boolean
  missingFields: Array<string>
  ageEligible: boolean
  requiredConsentsAccepted: boolean
  marketingOptIn: boolean
}

/**
 * Computed server-side from actual data — a client-supplied
 * "profile_complete" flag is never trusted. Spiritual-interest
 * selection is deliberately NOT part of completion (zero is valid),
 * and marketing opt-out never blocks anything.
 */
export async function getProfileCompletion(
  userId: number,
): Promise<ProfileCompletion> {
  const profile = await getOwnProfile(userId)
  const consents = await getConsentStatus(userId)

  const missingFields: Array<string> = []
  if (!profile?.fullName) missingFields.push('fullName')
  if (!profile?.phoneE164) missingFields.push('phone')
  if (!profile?.countryCode) missingFields.push('country')
  if (!profile?.timezone) missingFields.push('timezone')
  if (!profile?.preferredLanguage) missingFields.push('preferredLanguage')
  if (!profile?.dateOfBirth) missingFields.push('dateOfBirth')

  const requiredConsentsAccepted = consents.required.every((c) => c.accepted)
  const ageEligible =
    profile?.dateOfBirth !== null && profile?.dateOfBirth !== undefined
      ? isAgeEligible(profile.dateOfBirth)
      : false

  return {
    complete: missingFields.length === 0 && requiredConsentsAccepted,
    missingFields,
    ageEligible,
    requiredConsentsAccepted,
    marketingOptIn: consents.marketingOptIn,
  }
}

export interface BookingEligibility {
  eligible: boolean
  reasons: Array<
    | 'ACCOUNT_NOT_ACTIVE'
    | 'PROFILE_INCOMPLETE'
    | 'REQUIRED_CONSENTS_MISSING'
    | 'AGE_REQUIREMENT_NOT_MET'
  >
}

/**
 * Reusable foundation for the LATER appointment stage — no booking
 * flow exists yet. Requires an active account, complete personal
 * profile, required consents at current versions, and age >= 18
 * calculated from date of birth at evaluation time. Spiritual-interest
 * selection is NOT required.
 */
export async function canUserBookSpiritualService(
  userId: number,
): Promise<BookingEligibility> {
  const reasons: BookingEligibility['reasons'] = []

  const user = (
    await getDb().select().from(users).where(eq(users.id, userId)).limit(1)
  ).at(0)
  if (!user || user.accountStatus !== 'ACTIVE') {
    reasons.push('ACCOUNT_NOT_ACTIVE')
  }

  const completion = await getProfileCompletion(userId)
  if (completion.missingFields.length > 0) reasons.push('PROFILE_INCOMPLETE')
  if (!completion.requiredConsentsAccepted) {
    reasons.push('REQUIRED_CONSENTS_MISSING')
  }
  if (!completion.ageEligible) reasons.push('AGE_REQUIREMENT_NOT_MET')

  return { eligible: reasons.length === 0, reasons }
}

export { calculateAge }
