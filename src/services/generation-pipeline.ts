import {
  runAudioGenerationOnce,
  runGenerationPreparationOnce,
  runVisualGenerationOnce,
} from './generation-jobs'
import { runStoryboardPlanningOnce } from './generation-storyboards'
import { runRenderOnce } from './render-assembly'
import { runUploadOnce } from './render-upload'
import type {
  AudioGenerationDependencies,
  AudioGenerationOutcome,
  GenerationClock,
  PreparationDependencies,
  PreparationOutcome,
  VisualGenerationDependencies,
  VisualGenerationOutcome,
} from './generation-jobs'
import type { StoryboardPlanningOutcome } from './generation-storyboards'
import type { RenderDependencies, RenderOutcome } from './render-assembly'
import type { UploadDependencies, UploadOutcome } from './render-upload'

/**
 * THE autonomous generation pipeline pass (Phase One, Step 19; canon
 * §10.12).
 *
 * ```text
 * verified payment → CONFIRMED appointment → QUEUED job
 *   → [ this pass, run repeatedly, by a worker nobody supervises ]
 *   → READY private upload → time-gated Prayer Room playback
 * ```
 *
 * This module is ORCHESTRATION AND NOTHING ELSE. It contains no
 * generation logic, no state-machine knowledge, no provider choice and
 * no notion of what any stage does — it calls the six existing stage
 * workers, in canonical order, once each, and reports what they said.
 * Every decision that matters still belongs to the stage that owns it:
 *
 *   1. runGenerationPreparationOnce  (Step 12)  QUEUED → STORYBOARDING
 *   2. runStoryboardPlanningOnce     (Step 13)  → GENERATING_VISUALS
 *   3. runVisualGenerationOnce       (Step 14)  → GENERATING_AUDIO
 *   4. runAudioGenerationOnce        (Step 15)  → RENDERING
 *   5. runRenderOnce                 (Step 16)  → UPLOADING
 *   6. runUploadOnce                 (Step 17)  → READY
 *
 * WHY THIS EXISTS AT ALL. Before Step 19 the only place the six stages
 * appeared together was inside the worker executable, where no test
 * could reach it — so every end-to-end test necessarily drove a
 * hand-written imitation of the worker, and "the pipeline works" only
 * ever meant "a test's copy of the pipeline works". Extracting the pass
 * makes production and the tests run THE SAME orchestration. It is not
 * a convenience wrapper; it is the thing being verified.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 * - It never writes to a generation job. Not a status, not a lease, not
 *   an event. Every transition in the system continues to go through
 *   the central Step 12 transition map, under a lease CAS, inside the
 *   stage that owns it.
 * - It is not a second state machine. It does not know which stage
 *   "should" run next; it runs all six and lets each one's claim query
 *   decide whether there is anything for it to do. A stage with no
 *   eligible job answers IDLE, which costs one indexed query.
 * - It does not recover expired leases. Lease sweeping is a WORKER
 *   LIFECYCLE concern with its own cadence (see the worker), not part
 *   of a pass, and folding it in here would make every caller —
 *   including tests reasoning about a single job — silently responsible
 *   for other workers' abandoned work.
 * - It never selects spiritual content, approves anything, bypasses
 *   authority, alters an immutable snapshot, or converts a failure into
 *   a success. It cannot: it has no arguments through which to say any
 *   of those things.
 * - It swallows nothing. A stage that throws propagates, and the caller
 *   (the worker) decides what to do about it.
 *
 * FAIRNESS. Running all six stages every pass — rather than looping on
 * whichever stage has work — is what stops a continuous stream of
 * bookings in one stage from starving the others, and what lets many
 * jobs at different stages progress together. One job's poll wait is
 * another job's render.
 */

export type PipelineStageName =
  | 'PREPARATION'
  | 'STORYBOARD'
  | 'VISUALS'
  | 'AUDIO'
  | 'RENDER'
  | 'UPLOAD'

/** The canonical order, exported so a caller (or a test) can assert the
 * sequence rather than restate it. */
export const PIPELINE_STAGE_ORDER: ReadonlyArray<PipelineStageName> = [
  'PREPARATION',
  'STORYBOARD',
  'VISUALS',
  'AUDIO',
  'RENDER',
  'UPLOAD',
] as const

/** A uniform, bounded view of one stage's outcome: enough to log and to
 * assert on, and deliberately not enough to act on. Anything richer
 * belongs to the stage that produced it. */
export interface PipelineStageReport {
  stage: PipelineStageName
  status: string
  /** Present on every non-IDLE outcome; null when the stage found
   * nothing to claim. */
  jobId: number | null
}

export interface GenerationPipelinePassResult {
  preparation: PreparationOutcome
  storyboard: StoryboardPlanningOutcome
  visuals: VisualGenerationOutcome
  audio: AudioGenerationOutcome
  render: RenderOutcome
  upload: UploadOutcome
  /** All six, in canonical order. */
  stages: ReadonlyArray<PipelineStageReport>
  /** True when ANY stage claimed a job. False means the whole queue was
   * idle for this pass — the worker's cue to sleep. */
  workOccurred: boolean
}

/**
 * Per-stage dependency injection, forwarded verbatim to the stage that
 * owns it.
 *
 * TEST SEAM ONLY, and a narrow one: every field is already an existing
 * stage's own documented injection point (a mock provider call, a slow
 * engine). It exists so a test that needs to model a failing provider
 * can still drive the REAL pass instead of hand-rolling a private
 * imitation of it — which is exactly the thing this module was created
 * to abolish. Production passes none of it.
 */
export interface GenerationPipelineDependencies {
  preparation?: PreparationDependencies
  visuals?: VisualGenerationDependencies
  audio?: AudioGenerationDependencies
  storyboard?: Parameters<typeof runStoryboardPlanningOnce>[2]
  render?: RenderDependencies
  upload?: UploadDependencies
}

function report(
  stage: PipelineStageName,
  outcome: { status: string; jobId?: number },
): PipelineStageReport {
  return {
    stage,
    status: outcome.status,
    jobId: 'jobId' in outcome && outcome.jobId != null ? outcome.jobId : null,
  }
}

/**
 * One fair pass over the whole pipeline: each of the six stages gets
 * exactly one cycle, in canonical order.
 *
 * Stages run SEQUENTIALLY and are awaited in turn. That is not
 * incidental: it is what lets a single pass carry one job several
 * stages forward (a job prepared by stage 1 is claimable by stage 2 in
 * the same pass), and it keeps one worker from competing with itself
 * for leases.
 *
 * The clock is passed straight through to every stage, so a pass has
 * ONE time source. No stage reads the wall clock behind the others'
 * backs, and a test that advances a fake clock advances it for the
 * whole pipeline at once.
 */
export async function runGenerationPipelinePass(
  workerId: string,
  clock: GenerationClock,
  dependencies: GenerationPipelineDependencies = {},
): Promise<GenerationPipelinePassResult> {
  const preparation = await runGenerationPreparationOnce(
    workerId,
    clock,
    dependencies.preparation,
  )
  const storyboard = await runStoryboardPlanningOnce(
    workerId,
    clock,
    dependencies.storyboard,
  )
  // The visual and audio stages resolve their provider dependencies
  // lazily inside themselves (mock-backed at this stage); passing
  // undefined is what selects the real ones.
  const visuals = await runVisualGenerationOnce(
    workerId,
    clock,
    dependencies.visuals,
  )
  const audio = await runAudioGenerationOnce(
    workerId,
    clock,
    dependencies.audio,
  )
  const render = await runRenderOnce(workerId, clock, dependencies.render)
  const upload = await runUploadOnce(workerId, clock, dependencies.upload)

  const stages: ReadonlyArray<PipelineStageReport> = [
    report('PREPARATION', preparation),
    report('STORYBOARD', storyboard),
    report('VISUALS', visuals),
    report('AUDIO', audio),
    report('RENDER', render),
    report('UPLOAD', upload),
  ]
  return {
    preparation,
    storyboard,
    visuals,
    audio,
    render,
    upload,
    stages,
    workOccurred: stages.some((entry) => entry.status !== 'IDLE'),
  }
}
