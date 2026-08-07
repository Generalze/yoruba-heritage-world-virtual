import { describe, expect, it } from 'bun:test'

import { envSchema } from '@/lib/env'

describe('envSchema', () => {
  it('applies development defaults when variables are absent', () => {
    const env = envSchema.parse({})

    expect(env.NODE_ENV).toBe('development')
    expect(env.APP_PORT).toBe(3000)
    expect(env.DATABASE_HOST).toBe('127.0.0.1')
    expect(env.DATABASE_PORT).toBe(3306)
    expect(env.DATABASE_NAME).toBe('yoruba_heritage_world')
  })

  it('coerces numeric strings from the environment', () => {
    const env = envSchema.parse({ APP_PORT: '8080', DATABASE_PORT: '3307' })

    expect(env.APP_PORT).toBe(8080)
    expect(env.DATABASE_PORT).toBe(3307)
  })

  it('rejects invalid values', () => {
    expect(() => envSchema.parse({ NODE_ENV: 'staging' })).toThrow()
    expect(() => envSchema.parse({ DATABASE_PORT: 'not-a-port' })).toThrow()
    expect(() => envSchema.parse({ DATABASE_NAME: '' })).toThrow()
  })
})
