import { describe, expect, it } from 'bun:test'

import {
  getDummyPasswordHash,
  hashPassword,
  verifyPassword,
} from '@/auth/password'

describe('password hashing', () => {
  it('produces an Argon2id hash, never the plaintext', async () => {
    const hash = await hashPassword('a sensible passphrase')
    expect(hash.startsWith('$argon2id$')).toBe(true)
    expect(hash).not.toContain('a sensible passphrase')
  })

  it('produces a different hash per call (unique salts)', async () => {
    const [a, b] = await Promise.all([
      hashPassword('a sensible passphrase'),
      hashPassword('a sensible passphrase'),
    ])
    expect(a).not.toBe(b)
  })

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct passphrase here')
    expect(await verifyPassword('correct passphrase here', hash)).toBe(true)
    expect(await verifyPassword('wrong passphrase here', hash)).toBe(false)
  })

  it('fails closed on malformed hash strings instead of throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-real-hash')).toBe(false)
    expect(await verifyPassword('anything', '')).toBe(false)
  })

  it('provides a stable dummy hash for timing equalization', async () => {
    const dummy = await getDummyPasswordHash()
    expect(dummy.startsWith('$argon2id$')).toBe(true)
    expect(await getDummyPasswordHash()).toBe(dummy)
    expect(await verifyPassword('any password', dummy)).toBe(false)
  })
})
