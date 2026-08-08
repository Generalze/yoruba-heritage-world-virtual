/**
 * Calendar-correct age calculation (Step 4, locked minimum age rules).
 *
 * Age is ALWAYS derived from the stored date of birth at evaluation
 * time — never persisted — and respects birthday boundaries instead of
 * naive year subtraction.
 */

export const MINIMUM_BOOKING_AGE = 18

interface DateParts {
  year: number
  month: number
  day: number
}

function ageAt(dateOfBirth: string, local: DateParts): number {
  const [year, month, day] = dateOfBirth.split('-').map(Number)
  let age = local.year - year
  const monthDelta = local.month - month
  if (monthDelta < 0 || (monthDelta === 0 && local.day < day)) {
    age -= 1
  }
  return age
}

/** dateOfBirth is a calendar date string, YYYY-MM-DD. Uses the runtime
 * timezone of `at` — booking eligibility must use the timezone-aware
 * variants below instead. */
export function calculateAge(
  dateOfBirth: string,
  at: Date = new Date(),
): number {
  return ageAt(dateOfBirth, {
    year: at.getFullYear(),
    month: at.getMonth() + 1,
    day: at.getDate(),
  })
}

export function isAgeEligible(
  dateOfBirth: string,
  at: Date = new Date(),
): boolean {
  return calculateAge(dateOfBirth, at) >= MINIMUM_BOOKING_AGE
}

/**
 * The calendar date currently in effect in an IANA timezone at a given
 * instant. Built-in Intl only — no external timezone service.
 */
export function getLocalDateParts(timeZone: string, at: Date): DateParts {
  // en-CA formats as YYYY-MM-DD.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)
  const [year, month, day] = formatted.split('-').map(Number)
  return { year, month, day }
}

/**
 * Age on the user's OWN current calendar date, derived from their
 * stored IANA timezone — never the server's runtime timezone. Around a
 * birthday, users in different timezones are legitimately different
 * ages at the same UTC instant.
 */
export function calculateAgeInTimeZone(
  dateOfBirth: string,
  timeZone: string,
  at: Date = new Date(),
): number {
  return ageAt(dateOfBirth, getLocalDateParts(timeZone, at))
}

/** Fails closed: an invalid/missing timezone never grants eligibility. */
export function isAgeEligibleInTimeZone(
  dateOfBirth: string,
  timeZone: string,
  at: Date = new Date(),
): boolean {
  try {
    return (
      calculateAgeInTimeZone(dateOfBirth, timeZone, at) >= MINIMUM_BOOKING_AGE
    )
  } catch {
    return false
  }
}
