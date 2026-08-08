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

  it('enforces a hard bucket cap by evicting the oldest window', () => {
    const clock = makeClock(1_000)
    const limiter = new FixedWindowRateLimiter(1, 60_000, clock.now, 3)

    limiter.recordFailure('a')
    clock.advance(1_000)
    limiter.recordFailure('b')
    clock.advance(1_000)
    limiter.recordFailure('c')
    expect(limiter.size).toBe(3)
    expect(limiter.isBlocked('a')).toBe(true)

    // Cap reached with no expired buckets: the oldest ('a') is evicted
    // so the newest failure is still tracked and size never grows.
    clock.advance(1_000)
    limiter.recordFailure('d')
    expect(limiter.size).toBe(3)
    expect(limiter.isBlocked('d')).toBe(true)
    expect(limiter.isBlocked('a')).toBe(false)
    expect(limiter.isBlocked('b')).toBe(true)
  })

  it('never exceeds the cap under sustained many-key flooding', () => {
    const clock = makeClock(1_000)
    const limiter = new FixedWindowRateLimiter(1, 60_000, clock.now, 3)

    for (let i = 0; i < 50; i++) {
      limiter.recordFailure(`flood-${i}`)
      clock.advance(10)
    }
    expect(limiter.size).toBe(3)
    // The newest keys are the ones still tracked.
    expect(limiter.isBlocked('flood-49')).toBe(true)
  })

  it('existing buckets keep counting at the cap without eviction', () => {
    const clock = makeClock(1_000)
    const limiter = new FixedWindowRateLimiter(3, 60_000, clock.now, 2)

    limiter.recordFailure('a')
    limiter.recordFailure('b')
    limiter.recordFailure('a')
    limiter.recordFailure('a')
    expect(limiter.size).toBe(2)
    expect(limiter.isBlocked('a')).toBe(true)
    expect(limiter.isBlocked('b')).toBe(false)
  })
})
