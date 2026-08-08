/**
 * Integer-only minor-unit ↔ decimal-string conversion for providers
 * whose APIs take decimal amounts (PayPal). Floating point is NEVER
 * used for money. Exponents cover the currencies this platform can be
 * configured for; anything unknown defaults to the ISO-4217 common
 * exponent of 2.
 */

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
])

export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.toUpperCase()) ? 0 : 2
}

export function minorToDecimalString(
  amountMinor: number,
  currency: string,
): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error('Amount must be a non-negative integer of minor units.')
  }
  const exponent = currencyExponent(currency)
  if (exponent === 0) return String(amountMinor)
  const divisor = 10 ** exponent
  const units = Math.floor(amountMinor / divisor)
  const fraction = String(amountMinor % divisor).padStart(exponent, '0')
  return `${units}.${fraction}`
}

/** Strict parse of a provider decimal amount back to minor units.
 * Returns null (never a guess) when the string is not an exact plain
 * decimal for the currency's exponent. */
export function decimalStringToMinor(
  value: string,
  currency: string,
): number | null {
  const exponent = currencyExponent(currency)
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return null
  const units = match.at(1) ?? ''
  const fraction = match.at(2) ?? ''
  if (fraction.length > exponent) return null
  const paddedFraction = fraction.padEnd(exponent, '0')
  const combined = `${units}${paddedFraction}`
  const minor = Number(combined)
  return Number.isSafeInteger(minor) ? minor : null
}
