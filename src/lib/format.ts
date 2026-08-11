/**
 * Presentation formatting helpers (Step 21A). Pure functions — no
 * environment reads, no locale guessing beyond the fixed 'en-NG'-style
 * neutral English formatting the UI uses everywhere.
 *
 * PRICES ARE NEVER INVENTED. These helpers only ever format a REAL
 * (priceMinor, currency) pair read from the catalogue; a null price
 * means the caller renders nothing at all, so there is deliberately no
 * placeholder/fallback output here.
 */

/**
 * Formats a minor-unit amount (kobo, cents, …) in its real currency.
 * The minor-unit scale comes from the currency itself via Intl (NGN and
 * USD have 2 fraction digits, JPY has 0), never from an assumption.
 * Returns null — render nothing — for malformed input rather than
 * guessing at a price.
 */
export function formatMinorAmount(
  priceMinor: number,
  currency: string,
): string | null {
  if (!Number.isSafeInteger(priceMinor) || priceMinor < 0) return null
  if (!/^[A-Za-z]{3}$/.test(currency)) return null
  let formatter: Intl.NumberFormat
  try {
    formatter = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
    })
  } catch {
    return null
  }
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2
  return formatter.format(priceMinor / 10 ** fractionDigits)
}

/** "60 minutes" / "1 minute" — for a REAL stored duration only. */
export function formatDurationMinutes(minutes: number): string | null {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return null
  return minutes === 1 ? '1 minute' : `${minutes} minutes`
}
