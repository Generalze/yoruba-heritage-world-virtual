/**
 * Login abuse protection (stage spec §20).
 *
 * PHASE ONE, SINGLE-INSTANCE LIMITER: an in-memory fixed-window counter
 * suitable for the current one-process VPS architecture. State is lost
 * on restart and not shared across processes — that is an accepted
 * trade-off documented here. No Redis by design (canon §3.1); if the
 * platform later runs multiple app processes, replace this module with
 * a database-backed implementation behind the same three functions.
 *
 * Lockouts are always temporary: a key is only blocked until its window
 * expires. Legitimate accounts are never locked permanently, and a
 * successful login clears the counter for that account.
 */

interface AttemptBucket {
  count: number
  windowStartedAt: number
}

export class FixedWindowRateLimiter {
  private buckets = new Map<string, AttemptBucket>()

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private bucketFor(key: string): AttemptBucket | undefined {
    const bucket = this.buckets.get(key)
    if (!bucket) return undefined
    if (this.now() - bucket.windowStartedAt >= this.windowMs) {
      this.buckets.delete(key)
      return undefined
    }
    return bucket
  }

  isBlocked(key: string): boolean {
    const bucket = this.bucketFor(key)
    return bucket !== undefined && bucket.count >= this.maxAttempts
  }

  recordFailure(key: string): void {
    const bucket = this.bucketFor(key)
    if (bucket) {
      bucket.count += 1
    } else {
      if (this.buckets.size >= 10_000) this.prune()
      this.buckets.set(key, { count: 1, windowStartedAt: this.now() })
    }
  }

  clear(key: string): void {
    this.buckets.delete(key)
  }

  /** Drops expired buckets so memory stays bounded. */
  prune(): void {
    const cutoff = this.now() - this.windowMs
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStartedAt < cutoff) this.buckets.delete(key)
    }
  }
}

const WINDOW_MS = 15 * 60 * 1000
/** Per normalized email: protects a single account from targeting. */
export const MAX_ATTEMPTS_PER_EMAIL = 10
/** Per client IP: coarser guard against spraying many accounts. */
export const MAX_ATTEMPTS_PER_IP = 30

const emailLimiter = new FixedWindowRateLimiter(
  MAX_ATTEMPTS_PER_EMAIL,
  WINDOW_MS,
)
const ipLimiter = new FixedWindowRateLimiter(MAX_ATTEMPTS_PER_IP, WINDOW_MS)

export function isLoginBlocked(email: string, ip: string | null): boolean {
  if (emailLimiter.isBlocked(`email:${email}`)) return true
  if (ip && ipLimiter.isBlocked(`ip:${ip}`)) return true
  return false
}

export function recordFailedLogin(email: string, ip: string | null): void {
  emailLimiter.recordFailure(`email:${email}`)
  if (ip) ipLimiter.recordFailure(`ip:${ip}`)
}

export function clearLoginFailures(email: string): void {
  emailLimiter.clear(`email:${email}`)
}
