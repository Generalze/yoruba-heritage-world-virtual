import { randomUUID } from 'node:crypto'

import { closeDb } from '@/db'
import {
  recoverExpiredGenerationLeases,
  runGenerationPreparationOnce,
  systemGenerationClock,
} from '@/services/generation-jobs'
import { runStoryboardPlanningOnce } from '@/services/generation-storyboards'

/**
 * DB-backed prayer generation worker (Phase One, Step 12).
 *
 * Polls the prayer_generation_jobs queue and FAIRLY alternates two
 * stages so neither starves the other:
 *   - preparation  (Step 12: recipe build + validate → snapshot →
 *     STORYBOARDING)
 *   - storyboard planning (Step 13: storyboard + provider-neutral
 *     manifest → GENERATING_VISUALS)
 * It also recovers expired leases, sleeps when both queues are idle
 * and shuts down gracefully on SIGTERM/SIGINT. It performs NO external
 * generation/provider calls of any kind and is NOT required for the
 * web server to boot — run it separately:
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
    const now = new Date()
    if (now.getTime() - lastSweep >= LEASE_SWEEP_INTERVAL_MS) {
      lastSweep = now.getTime()
      // The live clock (not a pinned instant): the sweep must derive
      // its authoritative time AFTER each job row lock.
      const recovered = await recoverExpiredGenerationLeases(
        systemGenerationClock,
      )
      if (recovered > 0) {
        console.log(`[${WORKER_ID}] recovered ${recovered} expired lease(s)`)
      }
    }
    try {
      // Fair alternation: run one cycle of EACH stage per pass, so a
      // continuous stream of QUEUED jobs can never permanently starve
      // STORYBOARDING work (or vice versa).
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
      if (preparation.status === 'IDLE' && storyboard.status === 'IDLE') {
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
