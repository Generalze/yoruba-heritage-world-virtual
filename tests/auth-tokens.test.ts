import { describe, expect, it } from 'bun:test'

import { generateSessionToken, hashSessionToken } from '@/auth/tokens'

describe('session tokens', () => {
  it('generates unique high-entropy tokens', () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateSessionToken()),
    )
    expect(tokens.size).toBe(100)
    // 32 bytes base64url-encoded = 43 characters
    for (const token of tokens) expect(token.length).toBe(43)
  })

  it('hashes deterministically to 64 lowercase hex characters', () => {
    const token = generateSessionToken()
    const hash = hashSessionToken(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSessionToken(token)).toBe(hash)
  })

  it('never stores anything containing the raw token', () => {
    const token = generateSessionToken()
    expect(hashSessionToken(token)).not.toContain(token)
  })

  it('produces different hashes for different tokens', () => {
    expect(hashSessionToken(generateSessionToken())).not.toBe(
      hashSessionToken(generateSessionToken()),
    )
  })
})
