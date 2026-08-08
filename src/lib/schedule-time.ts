import { Temporal } from '@js-temporal/polyfill'

/**
 * Deterministic timezone arithmetic for scheduling (Step 5).
 *
 * All conversions go through Temporal (@js-temporal/polyfill — free,
 * local, no external service) so DST and offsets are handled by the
 * IANA database, never hand-rolled and never dependent on the VPS
 * runtime timezone. Authoritative appointment instants are UTC
 * 'YYYY-MM-DD HH:MM:SS' strings written by this module.
 */

/** 'YYYY-MM-DD' + 'HH:MM'(:SS) in an IANA zone → epoch milliseconds. */
export function localToUtcMs(
  timeZone: string,
  localDate: string,
  localTime: string,
): number {
  const [hour, minute] = localTime.split(':').map(Number)
  const date = Temporal.PlainDate.from(localDate)
  const zoned = date
    .toPlainDateTime({ hour, minute })
    .toZonedDateTime(timeZone, { disambiguation: 'compatible' })
  return zoned.epochMilliseconds
}

/** Epoch ms → { date: 'YYYY-MM-DD', time: 'HH:MM' } in an IANA zone. */
export function utcMsToLocal(
  timeZone: string,
  epochMs: number,
): { date: string; time: string } {
  const zoned =
    Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)}`,
    time: `${pad(zoned.hour)}:${pad(zoned.minute)}`,
  }
}

/** Epoch ms → canonical UTC storage string 'YYYY-MM-DD HH:MM:SS'. */
export function utcMsToSql(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 19).replace('T', ' ')
}

/** 'YYYY-MM-DD HH:MM:SS' UTC storage string → epoch ms. */
export function sqlToUtcMs(sqlUtc: string): number {
  return Date.parse(sqlUtc.replace(' ', 'T') + 'Z')
}

/** Today's calendar date in a zone at a given instant. */
export function currentLocalDate(timeZone: string, atMs: number): string {
  return utcMsToLocal(timeZone, atMs).date
}

/** ISO day of week for a local calendar date: 1 = Monday … 7 = Sunday. */
export function isoDayOfWeek(localDate: string): number {
  return Temporal.PlainDate.from(localDate).dayOfWeek
}

export function addDays(localDate: string, days: number): string {
  return Temporal.PlainDate.from(localDate).add({ days }).toString()
}

/** Inclusive difference helpers for range validation. */
export function daysBetween(fromDate: string, toDate: string): number {
  return Temporal.PlainDate.from(fromDate).until(
    Temporal.PlainDate.from(toDate),
  ).days
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone)
    return true
  } catch {
    return false
  }
}

/** 'HH:MM' or 'HH:MM:SS' → minutes since local midnight. */
export function timeToMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  return hour * 60 + minute
}

export function minutesToTime(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}
