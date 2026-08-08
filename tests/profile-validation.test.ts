import { describe, expect, it } from 'bun:test'

import {
  dateOfBirthSchema,
  personalDetailsSchema,
  phoneSchema,
} from '@/services/profile'

const VALID = {
  fullName: 'Adéwálé Olúṣọlá Adébáyọ̀',
  preferredName: 'Adéwálé',
  phone: '+234 801 234 5678',
  countryCode: 'NG',
  timezone: 'Africa/Lagos',
  preferredLanguage: 'en',
  dateOfBirth: '1990-03-21',
}

describe('phoneSchema', () => {
  it('normalizes separators into E.164', () => {
    expect(phoneSchema.parse('+234 801-234(5678)')).toBe('+2348012345678')
    expect(phoneSchema.parse('+44 20 7946 0958')).toBe('+442079460958')
  })

  it('rejects numbers without international prefix or with bad shapes', () => {
    expect(phoneSchema.safeParse('08012345678').success).toBe(false)
    expect(phoneSchema.safeParse('+0123456789').success).toBe(false)
    expect(phoneSchema.safeParse('+123').success).toBe(false)
    expect(phoneSchema.safeParse('not-a-phone').success).toBe(false)
  })
})

describe('dateOfBirthSchema', () => {
  it('rejects future dates', () => {
    const next = new Date()
    next.setFullYear(next.getFullYear() + 1)
    const future = next.toISOString().slice(0, 10)
    expect(dateOfBirthSchema.safeParse(future).success).toBe(false)
  })

  it('rejects impossible and pre-1900 dates', () => {
    expect(dateOfBirthSchema.safeParse('2001-02-30').success).toBe(false)
    expect(dateOfBirthSchema.safeParse('1899-12-31').success).toBe(false)
    expect(dateOfBirthSchema.safeParse('not-a-date').success).toBe(false)
  })

  it('accepts valid past dates', () => {
    expect(dateOfBirthSchema.safeParse('1990-03-21').success).toBe(true)
    expect(dateOfBirthSchema.safeParse('2004-02-29').success).toBe(true)
  })
})

describe('personalDetailsSchema', () => {
  it('accepts a valid profile and preserves Yorùbá diacritics', () => {
    const parsed = personalDetailsSchema.parse(VALID)
    expect(parsed.fullName).toBe('Adéwálé Olúṣọlá Adébáyọ̀')
    expect(parsed.preferredName).toBe('Adéwálé')
    expect(parsed.phone).toBe('+2348012345678')
  })

  it('rejects invalid country codes', () => {
    expect(
      personalDetailsSchema.safeParse({ ...VALID, countryCode: 'XX' }).success,
    ).toBe(false)
    expect(
      personalDetailsSchema.safeParse({ ...VALID, countryCode: 'Nigeria' })
        .success,
    ).toBe(false)
  })

  it('rejects offsets and invalid timezones — IANA identifiers only', () => {
    expect(
      personalDetailsSchema.safeParse({ ...VALID, timezone: 'GMT+1' }).success,
    ).toBe(false)
    expect(
      personalDetailsSchema.safeParse({ ...VALID, timezone: 'WAT' }).success,
    ).toBe(false)
    expect(
      personalDetailsSchema.safeParse({ ...VALID, timezone: 'Europe/London' })
        .success,
    ).toBe(true)
  })

  it('rejects unsupported languages', () => {
    expect(
      personalDetailsSchema.safeParse({ ...VALID, preferredLanguage: 'fr' })
        .success,
    ).toBe(false)
    expect(
      personalDetailsSchema.safeParse({ ...VALID, preferredLanguage: 'yo' })
        .success,
    ).toBe(true)
  })

  it('requires full name and strips a client-supplied userId key', () => {
    expect(
      personalDetailsSchema.safeParse({ ...VALID, fullName: '   ' }).success,
    ).toBe(false)
    const parsed = personalDetailsSchema.parse({ ...VALID, userId: 999 })
    expect('userId' in parsed).toBe(false)
  })
})
