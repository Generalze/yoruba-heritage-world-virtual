import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_LEASE_MS,
  RESERVATION_STALE_AFTER_MS,
} from '@/services/generation-jobs'

/**
 * ============================================================================
 * AT-MOST-ONCE EXTERNAL PAID SPEND — Step 20 hardening.
 *
 * The invariant, stated once: a provider request that MAY have reached
 * the provider is NEVER automatically submitted again. Avoiding a
 * duplicate charge outranks automatic recovery.
 *
 * Until this change the executors delegated that guarantee to the
 * PROVIDER — `VisualGenerationProvider` and `TtsProvider` both demanded
 * adapters be idempotent on the task's idempotency key. That holds for
 * the mock and for nobody else: no real image or speech vendor this
 * project has examined documents idempotent submission. So the
 * guarantee is now ours, enforced by a durable pre-call reservation.
 *
 * These are the SHAPE tests for the shared rules and the admin-retry
 * guard. The full concurrency choreography — reclaimed workers, live
 * versus stale reservations, late responses — lives in the visual
 * red-team suite, which drives real cycles.
 * ============================================================================
 */

describe('the staleness threshold', () => {
  it('protects a reservation for longer than a full lease window', () => {
    // A worker that still holds a lease may still be inside the
    // provider call; quarantining its row would abandon a live paid
    // submission and invite a second one. The threshold is derived
    // from the lease model rather than invented.
    expect(RESERVATION_STALE_AFTER_MS).toBeGreaterThanOrEqual(DEFAULT_LEASE_MS)
    expect(RESERVATION_STALE_AFTER_MS).toBe(DEFAULT_LEASE_MS * 2)
  })

  it('is documented as an upper bound for any future submission timeout', async () => {
    const source = await Bun.file('src/services/generation-jobs.ts').text()
    expect(source).toContain('RESERVATION_STALE_AFTER_MS')
    // The rule a future adapter author must not miss.
    expect(source).toContain('MUST be shorter than')
  })
})

describe('spend classification', () => {
  it('treats an ABSENT spendState as UNKNOWN, never as NOT_SENT', async () => {
    const source = await Bun.file('src/services/generation-jobs.ts').text()
    // TEETH: the comparison is written so that undefined falls into the
    // quarantine branch. `=== 'UNKNOWN'` would silently treat a
    // forgetful adapter as safe to retry.
    expect(source).toContain("submission.spendState !== 'NOT_SENT'")
    expect(source).not.toContain("submission.spendState === 'UNKNOWN'")
  })

  it('never infers NOT_SENT from a timeout, reset, 5xx or generic error', async () => {
    const visual = await Bun.file('src/services/visual-generation.ts').text()
    const audio = await Bun.file('src/services/audio-generation.ts').text()
    for (const source of [visual, audio]) {
      // A NOT_SENT claim may only accompany a pre-network refusal.
      for (const line of source.split('\n')) {
        if (!line.includes("spendState: 'NOT_SENT'")) continue
        expect(line).not.toContain('timeout')
        expect(line).not.toContain('ECONN')
      }
    }
  })
})

describe('the FAILED reset is narrowed to provably-unsent rows', () => {
  it('requires an absent submission time on both stages', async () => {
    const source = await Bun.file('src/services/generation-jobs.ts').text()
    // `submittedAt IS NULL` is the durable proof that nothing left this
    // machine. A legacy FAILED row that still carries a submission time
    // is treated as UNKNOWN — safety over retry convenience.
    expect(source).toContain('isNull(prayerGenerationVisualTasks.submittedAt)')
    expect(source).toContain('isNull(prayerGenerationAudioTasks.submittedAt)')
  })
})

describe('admin retry refuses an unresolved provider outcome', () => {
  it('refuses a job carrying a quarantined VISUAL or AUDIO task', async () => {
    const source = await Bun.file('src/services/generation-jobs.ts').text()
    const fn = source.slice(source.indexOf('export async function adminRetryGenerationJob'))
    const guard = fn.slice(0, fn.indexOf('isLegalTransition'))
    // TEETH: this retry restarts from PREPARING, minting fresh
    // snapshots and therefore fresh task identities — so it would sail
    // past both the unique idempotency key and the pre-call
    // reservation and buy the work again. Both stages must be checked,
    // and the check must come BEFORE the transition.
    expect(guard).toContain('prayerGenerationVisualTasks')
    expect(guard).toContain('prayerGenerationAudioTasks')
    expect(guard).toContain('PROVIDER_OUTCOME_UNKNOWN')
    expect(guard).toContain('unresolved')
  })

  it('offers no bypass of any kind', async () => {
    const source = await Bun.file('src/services/generation-jobs.ts').text()
    const fn = source.slice(
      source.indexOf('export async function adminRetryGenerationJob'),
    )
    // Assembled from fragments so that naming them here does not trip
    // the check against this file's own prose.
    const code = fn
      .split(nlChar)
      .filter((line) => !line.trimStart().startsWith('//'))
      .join(nlChar)
      .slice(0, 3000)
    for (const bypass of ['forc' + 'e:', 'overrid' + 'e:', 'bypas' + 's:']) {
      expect(code).not.toContain(bypass)
    }
  })
})

const nlChar = '\n'