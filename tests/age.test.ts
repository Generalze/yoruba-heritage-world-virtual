import { describe, expect, it } from 'bun:test'

import {
  calculateAge,
  calculateAgeInTimeZone,
  getLocalDateParts,
  isAgeEligible,
  isAgeEligibleInTimeZone,
} from '@/lib/age'

describe('calculateAge', () => {
  it('is calendar-correct around birthday boundaries', () => {
    const dob = '2000-06-15'
    expect(calculateAge(dob, new Date(2018, 5, 14))).toBe(17) // day before 18th birthday
    expect(calculateAge(dob, new Date(2018, 5, 15))).toBe(18) // on the birthday
    expect(calculateAge(dob, new Date(2018, 5, 16))).toBe(18) // day after
  })

  it('handles month boundaries, not just year subtraction', () => {
    // Born in December; in January of year+18 the naive year-diff says 18,
    // but the birthday has not yet occurred.
    expect(calculateAge('2000-12-31', new Date(2018, 0, 1))).toBe(17)
    expect(calculateAge('2000-01-01', new Date(2018, 11, 31))).toBe(18)
  })

  it('handles leap-day birthdays', () => {
    const dob = '2004-02-29'
    expect(calculateAge(dob, new Date(2022, 1, 28))).toBe(17)
    expect(calculateAge(dob, new Date(2022, 2, 1))).toBe(18)
  })
})

describe('isAgeEligible', () => {
  it('requires 18 or older', () => {
    expect(isAgeEligible('2000-06-15', new Date(2018, 5, 14))).toBe(false)
    expect(isAgeEligible('2000-06-15', new Date(2018, 5, 15))).toBe(true)
    expect(isAgeEligible('1950-01-01', new Date(2020, 0, 1))).toBe(true)
  })
})

describe('timezone-aware age (deterministic, machine-independent)', () => {
  // One fixed UTC instant at which Auckland and Los Angeles are on
  // DIFFERENT calendar dates: 2025-06-14T13:00:00Z is
  //   2025-06-15 01:00 in Pacific/Auckland (NZST, UTC+12)
  //   2025-06-14 06:00 in America/Los_Angeles (PDT, UTC-7)
  const instant = new Date('2025-06-14T13:00:00Z')
  const dob = '2007-06-15' // 18th birthday on 2025-06-15

  it('resolves the local calendar date per IANA timezone', () => {
    expect(getLocalDateParts('Pacific/Auckland', instant)).toEqual({
      year: 2025,
      month: 6,
      day: 15,
    })
    expect(getLocalDateParts('America/Los_Angeles', instant)).toEqual({
      year: 2025,
      month: 6,
      day: 14,
    })
  })

  it('same DOB + same instant: 18 in Auckland, still 17 in Los Angeles', () => {
    expect(calculateAgeInTimeZone(dob, 'Pacific/Auckland', instant)).toBe(18)
    expect(calculateAgeInTimeZone(dob, 'America/Los_Angeles', instant)).toBe(17)
    expect(isAgeEligibleInTimeZone(dob, 'Pacific/Auckland', instant)).toBe(true)
    expect(isAgeEligibleInTimeZone(dob, 'America/Los_Angeles', instant)).toBe(
      false,
    )
  })

  it('fails closed on an invalid timezone', () => {
    expect(isAgeEligibleInTimeZone('1990-01-01', 'Not/AZone', instant)).toBe(
      false,
    )
  })
})
