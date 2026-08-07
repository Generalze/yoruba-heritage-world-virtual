import { describe, expect, it } from 'bun:test'

import { normalizeEmail } from '@/auth/email'

describe('normalizeEmail', () => {
  it('trims whitespace and lower-cases', () => {
    expect(normalizeEmail('  Ade@Example.COM  ')).toBe('ade@example.com')
  })

  it('treats differently-cased addresses as the same account key', () => {
    expect(normalizeEmail('USER@HOST.NG')).toBe(normalizeEmail('user@host.ng'))
  })

  it('does not rewrite plus-addressing or dots', () => {
    expect(normalizeEmail('a.b+c@example.com')).toBe('a.b+c@example.com')
  })
})
