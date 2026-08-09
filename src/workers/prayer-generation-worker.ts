import { randomUUID } from 'node:crypto'

import { closeDb } from '@/db'
import {
  recoverExpiredGenerationLeases,
  runGenerationPreparationOnce,
} from '@/services/generation-jobs'

/**
 * DB-backed prayer generation worker (Phase One, Step 12).
 *
 * Polls the prayer_generation_jobs queue, runs preparation cycles
 * (REAL Step 11 recipe build + validate → immutable snapshot →
 * STORYBOARDING), recovers expired leases, sleeps when idle and shuts
 * down gracefully on SIGTERM/SIGINT. It performs NO external
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
      const recovered = await recoverExpiredGenerationLeases(now)
      if (recovered > 0) {
        console.log(`[${WORKER_ID}] recovered ${recovered} expired lease(s)`)
      }
    }
    try {
      const outcome = await runGenerationPreparationOnce(WORKER_ID, new Date())
      if (outcome.status === 'IDLE') {
        await sleep(IDLE_SLEEP_MS)
      } else {
        console.log(
          `[${WORKER_ID}] job ${'jobId' in outcome ? outcome.jobId : '?'} → ${outcome.status}`,
        )
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
