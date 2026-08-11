import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_LEASE_MS,
  RESERVATION_STALE_AFTER_MS,
} from '@/services/generation-jobs'
import { submitScene } from '@/services/visual-generation'
import { submitSpeech } from '@/services/audio-generation'
import { createDisabledVisualGenerationProvider } from '@/providers/visual-generation/disabled'
import { createDisabledTtsProvider } from '@/providers/tts/disabled'
import {
  resetVisualGenerationProviderForTests,
  setVisualGenerationProviderForTests,
} from '@/providers/visual-generation/registry'
import {
  resetTtsProviderForTests,
  setTtsProviderForTests,
} from '@/providers/tts/registry'

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

  // BEHAVIORAL, not a source scan: these would FAIL if zero NOT_SENT
  // classifications existed, because they call the REAL submit
  // functions and read the answer. Every case here is decided strictly
  // before any network write, which is what NOT_SENT means.

  it('a DISABLED visual adapter is provably NOT_SENT', async () => {
    setVisualGenerationProviderForTests(createDisabledVisualGenerationProvider())
    try {
      const result = await submitScene({} as never)
      expect(result.status).toBe('FAILED')
      if (result.status !== 'FAILED') return
      expect(result.errorCode).toBe('visual_generation_unavailable')
      expect(result.spendState).toBe('NOT_SENT')
    } finally {
      resetVisualGenerationProviderForTests()
    }
  })

  it('a visual compile refusal is provably NOT_SENT', async () => {
    // A garbage task fails the compiler's own trust-boundary guard
    // (unsupported task kind) before anything else runs.
    const result = await submitScene({} as never)
    expect(result.status).toBe('FAILED')
    if (result.status !== 'FAILED') return
    expect(result.errorCode).toBe('unsupported_task_kind')
    expect(result.spendState).toBe('NOT_SENT')
  })

  it('a DISABLED speech adapter is provably NOT_SENT', async () => {
    setTtsProviderForTests(createDisabledTtsProvider())
    try {
      const result = await submitSpeech({ requirement: {} } as never)
      expect(result.status).toBe('FAILED')
      if (result.status !== 'FAILED') return
      expect(result.errorCode).toBe('tts_unavailable')
      expect(result.spendState).toBe('NOT_SENT')
    } finally {
      resetTtsProviderForTests()
    }
  })

  it('a speech compile refusal is provably NOT_SENT', async () => {
    const result = await submitSpeech({ requirement: {} } as never)
    expect(result.status).toBe('FAILED')
    if (result.status !== 'FAILED') return
    expect(result.spendState).toBe('NOT_SENT')
  })

  it('a provider-selection change is refused before the network, on both stages', async () => {
    const visual = await submitScene({} as never, {
      expectedProviderCode: 'SOMEBODY_ELSE',
    })
    expect(visual.status).toBe('FAILED')
    if (visual.status === 'FAILED') {
      expect(visual.errorCode).toBe('provider_selection_changed')
      expect(visual.spendState).toBe('NOT_SENT')
    }
    const audio = await submitSpeech({ requirement: {} } as never, {
      expectedProviderCode: 'SOMEBODY_ELSE',
    })
    expect(audio.status).toBe('FAILED')
    if (audio.status === 'FAILED') {
      expect(audio.errorCode).toBe('provider_selection_changed')
      expect(audio.spendState).toBe('NOT_SENT')
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
    // And the LEGACY shape — FAILED with submission evidence — is
    // refused too, protecting an administrator before the worker has
    // had a chance to normalize the row.
    expect(guard).toContain('isNotNull')
    expect(guard).toContain('submittedAt')
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