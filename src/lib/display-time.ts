import { currencyExponent } from '@/providers/payments/money'

/**
 * Display-only helpers for user-facing pages. All appointment/payment
 * instants are stored as UTC 'YYYY-MM-DD HH:MM:SS' strings; rendering
 * converts them to a target IANA timezone with Intl. Never used for
 * domain logic — the server remains the only scheduling authority.
 */

export function formatUtcSqlInTimezone(
  utcSql: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium',
    timeStyle: 'short',
  },
): string {
  const date = new Date(`${utcSql.replace(' ', 'T')}Z`)
  if (Number.isNaN(date.getTime())) return utcSql
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...options,
      timeZone,
    }).format(date)
  } catch {
    return date.toISOString()
  }
}

/** Minor units → display amount (integer math + padStart; display only). */
export function formatAmountMinor(
  amountMinor: number,
  currency: string,
): string {
  const exponent = currencyExponent(currency)
  if (exponent === 0) return `${amountMinor.toLocaleString()} ${currency}`
  const divisor = 10 ** exponent
  const units = Math.floor(amountMinor / divisor)
  const fraction = String(amountMinor % divisor).padStart(exponent, '0')
  return `${units.toLocaleString()}.${fraction} ${currency}`
}

/** Milliseconds remaining until a UTC sql instant (client countdowns —
 * informational only; the server stays authoritative). */
export function msUntilUtcSql(utcSql: string, nowMs: number): number {
  return new Date(`${utcSql.replace(' ', 'T')}Z`).getTime() - nowMs
}
