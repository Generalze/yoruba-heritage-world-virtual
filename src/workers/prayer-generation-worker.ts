import { randomUUID } from 'node:crypto'

import { closeDb } from '@/db'
import {
  recoverExpiredGenerationLeases,
  systemGenerationClock,
} from '@/services/generation-jobs'
import { runGenerationPipelinePass } from '@/services/generation-pipeline'
import { assertProductionPreflight } from '@/server/production-preflight'

/**
 * DB-backed prayer generation worker (Phase One, Step 12; autonomous
 * end-to-end since Step 19).
 *
 * A separate process from the web server, with one job: keep calling
 * runGenerationPipelinePass() until told to stop. Everything about WHAT
 * a pass does — which stages exist, in what order, and who may change a
 * job's status — lives in src/services/generation-pipeline.ts, which is
 * the SAME orchestration the end-to-end tests drive. This file owns
 * only the lifecycle around it: identity, the lease sweep, idle
 * sleeping, error backoff and graceful shutdown.
 *
 * A pass runs one cycle of EACH of the SIX stages, in canonical order,
 * so no stage can starve another:
 *   - preparation        (Step 12: recipe build + validate → snapshot)
 *   - storyboard planning (Step 13: storyboard + provider-neutral
 *     manifest)
 *   - visual generation  (Step 14: async submit/poll of every
 *     GENERATION_REQUIRED manifest task)
 *   - audio generation   (Step 15: approved human recordings re-verified
 *     in place, plus async submit/poll of every TTS_PENDING requirement)
 *   - render assembly    (Step 16: an immutable render plan rendered
 *     through the engine-neutral RenderEngine boundary into a verified
 *     LOCAL artifact)
 *   - private upload     (Step 17: that artifact placed at its canonical
 *     key in PRIVATE object storage, re-proved remotely, then READY)
 *
 * WHICH BACKEND EACH STAGE USES IS CONFIGURATION, NOT A PROPERTY OF
 * THIS FILE (Step 20). Every one of them is chosen by an explicit
 * driver enum, and an unknown value stops the process rather than
 * quietly selecting a mock:
 *
 *   RENDER_DRIVER              MOCK (development/test) | REMOTION
 *   OBJECT_STORAGE_DRIVER      LOCAL (development/test) | S3
 *   VISUAL_GENERATION_DRIVER   MOCK (development/test) | DISABLED
 *   TTS_DRIVER                 MOCK (development/test) | DISABLED
 *
 * PRODUCTION REFUSES EVERY MOCK AND THE LOCAL FINAL STORE. It also
 * refuses to start at all when the configuration is incomplete — see
 * the preflight below. No external visual-generation or speech vendor
 * has been approved, so DISABLED is the honest production setting for
 * those two: work that REQUIRES them fails closed as a recorded task
 * failure and is never silently skipped, while a manifest built from
 * approved media and approved human recordings runs normally.
 *
 * From a confirmed, paid appointment to a READY private recording there
 * is NO human step: no approval, no queue to review, no operator
 * action. Human authority is spent UPSTREAM, on the content, media,
 * templates and rights this pipeline is allowed to draw from; the
 * runtime only assembles what was already approved, and every stage
 * re-proves that authority still holds before it spends anything.
 *
 * In development and test it performs NO paid API call of any kind: the
 * default drivers are the deterministic mocks and the local
 * private-object adapter, and automated verification never selects
 * anything else. In production those exact defaults are refused.
 *
 * A real render needs LOCAL TOOLING — ffprobe to measure approved media
 * and a headless browser for the compositor — both baked into the image
 * and named explicitly. Readiness reports their absence rather than
 * letting a paid appointment discover it.
 *
 * This process is NOT required for the web server to boot — run it
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
  // BEFORE THE FIRST JOB IS CLAIMED, and using the SAME function the
  // web server calls, so the two processes can never disagree about
  // whether this deployment is fit to run. A worker that started
  // anyway would claim somebody's paid appointment and then fail it on
  // configuration — consuming its bounded retry budget for a fault
  // that has nothing to do with the booking.
  assertProductionPreflight('worker')
  console.log(`[${WORKER_ID}] prayer generation worker started (DB queue)`)
  let lastSweep = 0
  while (!shuttingDown) {
    // Pacing only — how often the sweep RUNS, never lease/retry
    // authority. Authority for recovery decisions and backoff comes
    // exclusively from systemGenerationClock, read fresh after each
    // candidate row's lock is held (see recoverExpiredGenerationLeases).
    // Drawn from the same clock as everything else in this worker —
    // one time source, not a second one via the global Date.
    //
    // This stays in the WORKER, not in the pass: recovering another
    // worker's abandoned lease is a lifecycle duty of a long-running
    // process, on its own slow cadence, not part of doing one unit of
    // pipeline work.
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
      const pass = await runGenerationPipelinePass(
        WORKER_ID,
        systemGenerationClock,
      )
      for (const stage of pass.stages) {
        if (stage.status === 'IDLE') continue
        console.log(
          `[${WORKER_ID}] ${stage.stage.toLowerCase()} job ${stage.jobId ?? '?'} → ${stage.status}`,
        )
      }
      if (!pass.workOccurred) await sleep(IDLE_SLEEP_MS)
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

// A refused preflight must EXIT NON-ZERO, so the container restart
// policy and the operator both see a failed process rather than a
// quiet one that stopped doing work.
void main().catch((error: unknown) => {
  console.error(
    `[${WORKER_ID}] fatal: ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
  void closeDb().catch(() => undefined)
})
