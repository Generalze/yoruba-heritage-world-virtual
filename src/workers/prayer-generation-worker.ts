import { randomUUID } from 'node:crypto'

import { closeDb } from '@/db'
import {
  recoverExpiredGenerationLeases,
  runAudioGenerationOnce,
  runGenerationPreparationOnce,
  runVisualGenerationOnce,
  systemGenerationClock,
} from '@/services/generation-jobs'
import { runStoryboardPlanningOnce } from '@/services/generation-storyboards'

/**
 * DB-backed prayer generation worker (Phase One, Step 12).
 *
 * Polls the prayer_generation_jobs queue and FAIRLY alternates four
 * stages so none starves the others:
 *   - preparation  (Step 12: recipe build + validate → snapshot →
 *     STORYBOARDING)
 *   - storyboard planning (Step 13: storyboard + provider-neutral
 *     manifest → GENERATING_VISUALS)
 *   - visual generation (Step 14: async submit/poll of every
 *     GENERATION_REQUIRED manifest task via the mock provider only →
 *     GENERATING_AUDIO)
 *   - audio generation (Step 15: approved human recordings re-verified
 *     in place, plus async submit/poll of every TTS_PENDING requirement
 *     via the mock speech provider only → RENDERING)
 * It also recovers expired leases, sleeps when every queue is idle and
 * shuts down gracefully on SIGTERM/SIGINT. It performs NO real
 * provider/paid API calls of any kind (Steps 14 and 15 use their
 * deterministic mocks exclusively), renders nothing (no Remotion, no
 * FFmpeg) and is NOT required for the web server to boot — run it
 * separately:
 *
 *   bun run worker:generation
 */

const WORKER_ID = `gen-${process.pid}-${randomUUID().slice(0, 8)}`
const IDLE_SLEEP_MS = 5_000
const LEASE_SWEEP_INTERVAL_MS = 30_000

let shuttingDown = false

function requestShutdown(signal: string): void {
  console.log(`[${WORKER_ID}] received ${signal} — finishing current cycle…`)
  shuttingDown = true
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'))
process.on('SIGINT', () => requestShutdown('SIGINT'))

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  console.log(`[${WORKER_ID}] prayer generation worker started (DB queue)`)
  let lastSweep = 0
  while (!shuttingDown) {
    // Pacing only — how often the sweep RUNS, never lease/retry
    // authority. Authority for recovery decisions and backoff comes
    // exclusively from systemGenerationClock, read fresh after each
    // candidate row's lock is held (see recoverExpiredGenerationLeases).
    // Drawn from the same clock as everything else in this worker —
    // one time source, not a second one via the global Date.
    const nowMs = systemGenerationClock.now().getTime()
    if (nowMs - lastSweep >= LEASE_SWEEP_INTERVAL_MS) {
      lastSweep = nowMs
      const recovered = await recoverExpiredGenerationLeases(
        systemGenerationClock,
      )
      if (recovered > 0) {
        console.log(`[${WORKER_ID}] recovered ${recovered} expired lease(s)`)
      }
    }
    try {
      // Fair alternation: run one cycle of EACH stage per pass, so a
      // continuous stream of work in one stage can never permanently
      // starve the others.
      const preparation = await runGenerationPreparationOnce(
        WORKER_ID,
        systemGenerationClock,
      )
      if (preparation.status !== 'IDLE') {
        console.log(
          `[${WORKER_ID}] prepare job ${'jobId' in preparation ? preparation.jobId : '?'} → ${preparation.status}`,
        )
      }
      const storyboard = await runStoryboardPlanningOnce(
        WORKER_ID,
        systemGenerationClock,
      )
      if (storyboard.status !== 'IDLE') {
        console.log(
          `[${WORKER_ID}] storyboard job ${'jobId' in storyboard ? storyboard.jobId : '?'} → ${storyboard.status}`,
        )
      }
      // Dependencies default to the real (mock-provider-backed)
      // submitScene/pollScene from src/services/visual-generation.ts,
      // resolved lazily inside runVisualGenerationOnce — this worker
      // never references that module directly.
      const visuals = await runVisualGenerationOnce(WORKER_ID, systemGenerationClock)
      if (visuals.status !== 'IDLE') {
        console.log(
          `[${WORKER_ID}] visual generation job ${'jobId' in visuals ? visuals.jobId : '?'} → ${visuals.status}`,
        )
      }
      // Same discipline as the visual stage: dependencies default to
      // the real (mock-provider-backed) submitSpeech/pollSpeech from
      // src/services/audio-generation.ts, resolved lazily inside
      // runAudioGenerationOnce.
      const audio = await runAudioGenerationOnce(
        WORKER_ID,
        systemGenerationClock,
      )
      if (audio.status !== 'IDLE') {
        console.log(
          `[${WORKER_ID}] audio generation job ${'jobId' in audio ? audio.jobId : '?'} → ${audio.status}`,
        )
      }
      if (
        preparation.status === 'IDLE' &&
        storyboard.status === 'IDLE' &&
        visuals.status === 'IDLE' &&
        audio.status === 'IDLE'
      ) {
        await sleep(IDLE_SLEEP_MS)
      }
    } catch (error) {
      console.error(
        `[${WORKER_ID}] cycle error: ${error instanceof Error ? error.message : String(error)}`,
      )
      await sleep(IDLE_SLEEP_MS)
    }
  }
  console.log(`[${WORKER_ID}] shutting down`)
  await closeDb()
}

void main()
