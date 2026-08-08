import { createHmac, timingSafeEqual } from 'node:crypto'

import { PaymentProviderError } from './types'
import type { ProviderTransport } from './types'

/**
 * Outbound provider HTTP safety (spec §55): every request carries an
 * explicit timeout via AbortController; network failures map to a
 * RETRYABLE PaymentProviderError (the provider may or may not have
 * acted — spec §19); responses are JSON-validated by the adapters.
 * Provider base URLs are constants/configuration — never user input.
 * Secret values are never logged or echoed into errors.
 */

export const DEFAULT_PROVIDER_TIMEOUT_MS = 15_000

export const defaultTransport: ProviderTransport = (url, init) =>
  fetch(url, init)

export async function providerRequest(
  transport: ProviderTransport,
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await transport(url, { ...init, signal: controller.signal })
  } catch {
    // Timeout / DNS / connection reset: AMBIGUOUS — the provider may
    // have created a transaction. Retry only with the same idempotency
    // identity; never assume "timeout = provider did nothing".
    throw new PaymentProviderError(
      'PROVIDER_NETWORK',
      'The payment provider could not be reached.',
      true,
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Parses a JSON body defensively; malformed provider JSON is a
 * retryable transport-level failure, not a crash. */
export async function readProviderJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new PaymentProviderError(
      'PROVIDER_BAD_RESPONSE',
      'The payment provider returned an unreadable response.',
      true,
    )
  }
}

export function hmacHex(
  algorithm: 'sha256' | 'sha512',
  secret: string,
  data: Uint8Array | string,
): string {
  return createHmac(algorithm, secret).update(data).digest('hex')
}

/** Constant-time string comparison (length-guarded) for signature
 * checks — never `===` on attacker-supplied signatures. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length || bufA.length === 0) return false
  return timingSafeEqual(bufA, bufB)
}

export function sha256Hex(data: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

/** Case-insensitive header lookup over a plain record. */
export function getHeader(
  headers: Record<string, string>,
  name: string,
): string | null {
  const target = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value
  }
  return null
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

export function decodeRawBody(rawBody: Uint8Array): string {
  return utf8Decoder.decode(rawBody)
}

export function parseJsonSafely(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
