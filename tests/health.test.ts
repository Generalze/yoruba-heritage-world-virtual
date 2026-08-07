import { describe, expect, it } from 'bun:test'

import { healthResponseSchema } from '@/types/health'

describe('healthResponseSchema', () => {
  it('accepts a valid health payload', () => {
    const payload = {
      status: 'ok',
      service: 'yoruba-heritage-world-virtual',
      timestamp: new Date().toISOString(),
      uptimeSeconds: 12,
      database: 'connected',
    } as const

    expect(healthResponseSchema.parse(payload)).toEqual(payload)
  })

  it('accepts an unavailable database state', () => {
    const payload = {
      status: 'ok',
      service: 'yoruba-heritage-world-virtual',
      timestamp: new Date().toISOString(),
      uptimeSeconds: 0,
      database: 'unavailable',
    }

    expect(healthResponseSchema.parse(payload).database).toBe('unavailable')
  })

  it('rejects unknown database states and foreign services', () => {
    expect(() =>
      healthResponseSchema.parse({
        status: 'ok',
        service: 'yoruba-heritage-world-virtual',
        timestamp: new Date().toISOString(),
        uptimeSeconds: 1,
        database: 'degraded',
      }),
    ).toThrow()

    expect(() =>
      healthResponseSchema.parse({
        status: 'ok',
        service: 'another-service',
        timestamp: new Date().toISOString(),
        uptimeSeconds: 1,
        database: 'connected',
      }),
    ).toThrow()
  })
})
