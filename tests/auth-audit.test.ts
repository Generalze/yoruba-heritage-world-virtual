import { describe, expect, it } from 'bun:test'

import { sanitizeAuditMetadata } from '@/auth/audit'

describe('sanitizeAuditMetadata', () => {
  it('drops password, token, hash, and secret keys at any nesting level', () => {
    const clean = sanitizeAuditMetadata({
      reason: 'invalid_password',
      password: 'super-secret',
      passwordHash: '$argon2id$abc',
      sessionToken: 'raw-token',
      token_hash: 'deadbeef',
      apiKey: 'sk-123',
      SESSION_SECRET: 'nope',
      authorization: 'Bearer x',
      nested: {
        ok: true,
        cookie: 'yhwv_session=abc',
        deeper: { credential: 'x', keep: 'yes' },
      },
    })

    expect(clean).toEqual({
      reason: 'invalid_password',
      nested: { ok: true, deeper: { keep: 'yes' } },
    })
    const serialized = JSON.stringify(clean)
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('argon2id')
    expect(serialized).not.toContain('raw-token')
    expect(serialized).not.toContain('sk-123')
  })

  it('keeps only primitive values and truncates long strings', () => {
    const clean = sanitizeAuditMetadata({
      count: 3,
      flag: false,
      note: 'x'.repeat(1000),
      list: ['dropped'],
      fn: (() => 'dropped') as unknown as string,
    })
    expect(clean).toEqual({ count: 3, flag: false, note: 'x'.repeat(500) })
  })

  it('returns null for missing metadata', () => {
    expect(sanitizeAuditMetadata(undefined)).toBeNull()
  })

  it('caps recursion depth', () => {
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } }
    const clean = sanitizeAuditMetadata(deep)
    expect(JSON.stringify(clean)).not.toContain('too deep')
  })
})
