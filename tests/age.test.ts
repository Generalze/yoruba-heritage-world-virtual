import { describe, expect, it } from 'bun:test'

import { calculateAge, isAgeEligible } from '@/lib/age'

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
