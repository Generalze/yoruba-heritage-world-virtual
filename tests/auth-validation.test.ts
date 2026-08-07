import { describe, expect, it } from 'bun:test'

import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  loginInputSchema,
  passwordSchema,
  registerInputSchema,
} from '@/auth/validation'

describe('passwordSchema', () => {
  it('rejects passwords shorter than the minimum', () => {
    expect(
      passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH - 1)).success,
    ).toBe(false)
  })

  it('accepts passphrases at and above the minimum with no composition rules', () => {
    expect(
      passwordSchema.safeParse('correct horse battery staple').success,
    ).toBe(true)
    expect(
      passwordSchema.safeParse('a'.repeat(PASSWORD_MIN_LENGTH)).success,
    ).toBe(true)
  })

  it('bounds the maximum accepted length', () => {
    expect(
      passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH)).success,
    ).toBe(true)
    expect(
      passwordSchema.safeParse('a'.repeat(PASSWORD_MAX_LENGTH + 1)).success,
    ).toBe(false)
  })
})

describe('registerInputSchema', () => {
  const valid = {
    email: '  New.User@Example.COM ',
    preferredName: 'Adétòkunbọ̀',
    password: 'a sensible passphrase',
    passwordConfirmation: 'a sensible passphrase',
  }

  it('accepts valid input and normalizes the email', () => {
    const parsed = registerInputSchema.parse(valid)
    expect(parsed.email).toBe('new.user@example.com')
    expect(parsed.preferredName).toBe('Adétòkunbọ̀')
  })

  it('rejects mismatched password confirmation', () => {
    const result = registerInputSchema.safeParse({
      ...valid,
      passwordConfirmation: 'a different passphrase',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid emails', () => {
    expect(
      registerInputSchema.safeParse({ ...valid, email: 'not-an-email' })
        .success,
    ).toBe(false)
  })

  it('rejects empty preferred names', () => {
    expect(
      registerInputSchema.safeParse({ ...valid, preferredName: '   ' }).success,
    ).toBe(false)
  })

  it('strips unknown keys such as attempted role input', () => {
    const parsed = registerInputSchema.parse({
      ...valid,
      role: 'SUPER_ADMIN',
      isAdmin: true,
    })
    expect('role' in parsed).toBe(false)
    expect('isAdmin' in parsed).toBe(false)
  })
})

describe('loginInputSchema', () => {
  it('normalizes email and requires a password', () => {
    const parsed = loginInputSchema.parse({
      email: ' A@B.CO ',
      password: 'anything',
    })
    expect(parsed.email).toBe('a@b.co')
    expect(
      loginInputSchema.safeParse({ email: 'a@b.co', password: '' }).success,
    ).toBe(false)
  })
})
