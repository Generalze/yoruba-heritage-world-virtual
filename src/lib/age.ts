/**
 * Calendar-correct age calculation (Step 4, locked minimum age rules).
 *
 * Age is ALWAYS derived from the stored date of birth at evaluation
 * time — never persisted — and respects birthday boundaries instead of
 * naive year subtraction.
 */

export const MINIMUM_BOOKING_AGE = 18

/** dateOfBirth is a calendar date string, YYYY-MM-DD. */
export function calculateAge(
  dateOfBirth: string,
  at: Date = new Date(),
): number {
  const [year, month, day] = dateOfBirth.split('-').map(Number)
  let age = at.getFullYear() - year
  const monthDelta = at.getMonth() + 1 - month
  if (monthDelta < 0 || (monthDelta === 0 && at.getDate() < day)) {
    age -= 1
  }
  return age
}

export function isAgeEligible(
  dateOfBirth: string,
  at: Date = new Date(),
): boolean {
  return calculateAge(dateOfBirth, at) >= MINIMUM_BOOKING_AGE
}
