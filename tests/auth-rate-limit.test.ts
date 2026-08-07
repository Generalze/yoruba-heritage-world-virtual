import { describe, expect, it } from 'bun:test'

import { FixedWindowRateLimiter } from '@/auth/rate-limit'

function makeClock(start = 0) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('FixedWindowRateLimiter', () => {
  it('blocks a key only after the attempt limit is reached', () => {
    const clock = makeClock()
    const limiter = new FixedWindowRateLimiter(3, 60_000, clock.now)

    expect(limiter.isBlocked('k')).toBe(false)
    limiter.recordFailure('k')
    limiter.recordFailure('k')
    expect(limiter.isBlocked('k')).toBe(false)
    limiter.recordFailure('k')
    expect(limiter.isBlocked('k')).toBe(true)
  })

  it('never blocks permanently — the window expiring unblocks the key', () => {
    const clock = makeClock()
    const limiter = new FixedWindowRateLimiter(2, 60_000, clock.now)

    limiter.recordFailure('k')
    limiter.recordFailure('k')
    expect(limiter.isBlocked('k')).toBe(true)

    clock.advance(60_000)
    expect(limiter.isBlocked('k')).toBe(false)
  })

  it('clears a key on demand (successful login)', () => {
    const clock = makeClock()
    const limiter = new FixedWindowRateLimiter(1, 60_000, clock.now)

    limiter.recordFailure('k')
    expect(limiter.isBlocked('k')).toBe(true)
    limiter.clear('k')
    expect(limiter.isBlocked('k')).toBe(false)
  })

  it('tracks keys independently', () => {
    const clock = makeClock()
    const limiter = new FixedWindowRateLimiter(1, 60_000, clock.now)

    limiter.recordFailure('a')
    expect(limiter.isBlocked('a')).toBe(true)
    expect(limiter.isBlocked('b')).toBe(false)
  })

  it('prunes expired buckets to bound memory', () => {
    const clock = makeClock()
    const limiter = new FixedWindowRateLimiter(5, 60_000, clock.now)

    limiter.recordFailure('old')
    clock.advance(120_000)
    limiter.recordFailure('new')
    limiter.prune()
    expect(limiter.isBlocked('old')).toBe(false)
    expect(limiter.isBlocked('new')).toBe(false)
  })
})
