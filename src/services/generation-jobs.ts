import { createHash, randomUUID } from 'node:crypto'

import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  GUIDANCE_LANGUAGES,
  appointmentGuidanceSets,
  appointments,
  prayerGenerationAudioTasks,
  prayerGenerationJobEvents,
  prayerGenerationJobs,
  prayerGenerationManifestSnapshots,
  prayerGenerationRecipeSnapshots,
  prayerGenerationStoryboardSnapshots,
  prayerGenerationVisualTasks,
  sacredHouses,
  services,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import {
  buildValidatedVideoRecipe,
  computeRecipeSha256,
  validateVideoRecipe,
} from './video-recipes'
import type { VideoRecipe } from './video-recipes'
import type { DbClient } from '@/db'
import type { GenerationJobStatus, GuidanceLanguage } from '@/db/schema'
import type { RequestContext } from '@/auth/service'
// Type-only: erased at compile time, so this does NOT create a runtime
// import cycle (generation-storyboards.ts imports FROM this module).
import type {
  ManifestAudioRequirement,
  ManifestVisualTask,
} from './generation-storyboards'

/**
 * Appointment-bound prayer generation orchestration (Phase One,
 * Step 12).
 *
 *   verified payment → CONFIRMED (authoritative CAS)
 *   → enqueuePrayerGenerationUnderTx (SAME transaction, lightweight)
 *   → DB worker claims via bounded lease
 *   → REAL Step 11 build + validate
 *   → append-only immutable recipe snapshot
 *   → STORYBOARDING (Step 12 stops here)
 *
 * The confirmation transaction NEVER builds recipes, reads media files
 * or calls providers — it inserts one frozen-context row. Recipe work
 * happens asynchronously in the preparation worker. No Redis/BullMQ;
 * the queue is the jobs table with row-locked leases. No human
 * approves an individual generation. Step 12 performs NO external
 * generation/provider calls and can never produce READY.
 */

export class GenerationJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GenerationJobError'
  }
}

// --- State machine ----------------------------------------------------------

/** Central legal-transition map for the WHOLE future pipeline. Step 12
 * only exercises QUEUED/RETRYING → PREPARING → STORYBOARDING plus the
 * retry/failure/cancel edges — but every transition anywhere must be
 * legal here. READY is unreachable in Step 12 (no stage produces it). */
export const GENERATION_TRANSITIONS: Record<
  GenerationJobStatus,
  Array<GenerationJobStatus>
> = {
  QUEUED: ['PREPARING', 'CANCELLED'],
  RETRYING: [
    'PREPARING',
    'STORYBOARDING',
    'GENERATING_VISUALS',
    'GENERATING_AUDIO',
    'RENDERING',
    'UPLOADING',
    'CANCELLED',
    'FAILED',
  ],
  PREPARING: ['STORYBOARDING', 'RETRYING', 'FAILED', 'CANCELLED'],
  STORYBOARDING: ['GENERATING_VISUALS', 'RETRYING', 'FAILED', 'CANCELLED'],
  // Step 14: the self-loop is a DELIBERATE, explicit edge — it is how a
  // worker legitimately awaiting an async provider result releases its
  // lease and becomes due again WITHOUT touching the retry budget. It
  // is granted through the SAME lease-guarded transitionGenerationJobUnderLease
  // as every other edge (see runVisualGenerationOnce), so it carries
  // identical stale-worker protection. It is distinct from RETRYING,
  // which DOES consume budget for a genuine failure or an expired lease.
  GENERATING_VISUALS: [
    'GENERATING_VISUALS',
    'GENERATING_AUDIO',
    'RETRYING',
    'FAILED',
    'CANCELLED',
  ],
  // Step 15: the same DELIBERATE, explicit wait-without-budget
  // self-loop the visual stage uses — how a worker legitimately
  // awaiting an async speech result releases its lease and becomes due
  // again WITHOUT touching the retry budget, granted through the SAME
  // lease-guarded transitionGenerationJobUnderLease (see
  // runAudioGenerationOnce) and therefore carrying identical
  // stale-worker protection.
  GENERATING_AUDIO: [
    'GENERATING_AUDIO',
    'RENDERING',
    'RETRYING',
    'FAILED',
    'CANCELLED',
  ],
  RENDERING: ['UPLOADING', 'RETRYING', 'FAILED', 'CANCELLED'],
  UPLOADING: ['READY', 'RETRYING', 'FAILED', 'CANCELLED'],
  READY: [],
  FAILED: ['RETRYING', 'CANCELLED'],
  CANCELLED: [],
}

export function isLegalTransition(
  from: GenerationJobStatus,
  to: GenerationJobStatus,
): boolean {
  return GENERATION_TRANSITIONS[from].includes(to)
}

/** Deterministic bounded retry schedule (minutes): 1m, 5m, 15m, 60m,
 * then the final bounded attempt. No random jitter. */
export const RETRY_SCHEDULE_MINUTES = [1, 5, 15, 60, 60] as const

export const DEFAULT_LEASE_MS = 2 * 60 * 1000

/** Step 14: how soon a GENERATING_VISUALS job becomes due again after
 * releasing its lease to await an async provider result. Deliberately
 * SHORT and SECONDS-scale, unlike RETRY_SCHEDULE_MINUTES (which is
 * MINUTES-scale and governs genuine bounded retries) — the difference
 * in magnitude is itself part of keeping "waiting" and "failing"
 * visibly distinct. */
export const VISUAL_TASK_POLL_DELAY_MS = 5_000

/** Step 15: the same short, seconds-scale wait for an in-flight speech
 * synthesis. Kept as its own constant rather than reusing the visual
 * one so the two stages can be tuned independently without either
 * silently inheriting the other's pacing. */
export const AUDIO_TASK_POLL_DELAY_MS = 5_000

/** Injectable clock: every lease-sensitive check MUST call now() at
 * the moment of the check — a worker's start time is never authority. */
export interface GenerationClock {
  now: () => Date
}

export const systemGenerationClock: GenerationClock = {
  now: () => new Date(),
}

// --- Enqueue (called INSIDE the confirmation transaction) -------------------

/**
 * Deterministic frozen generation identity. Only the lowercase SHA-256
 * is ever stored or exposed; the inputs never leave the server. The
 * seed freezes at confirmation — later rescheduling must not silently
 * rewrite an already-created generation identity.
 */
export function computeVariationSeed(input: {
  userId: number
  appointmentId: number
  serviceId: number
  startsAtUtc: string
}): string {
  const canonical = `video-v1|${input.userId}|${input.appointmentId}|${input.serviceId}|${input.startsAtUtc}`
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Lightweight, atomic job insertion — called from the SINGLE
 * authoritative confirmReservationUnderLock() AFTER the CONFIRMED CAS
 * and guidance assignment, inside the SAME transaction. It reads only
 * rows already written in this transaction; it never builds recipes,
 * hashes media or calls providers. A genuine failure here rolls back
 * the whole confirmation (all-or-nothing stays intact).
 *
 * The guidance language snapshot established during THIS confirmation
 * is the authoritative language. If it cannot be established, the
 * confirmation FAILS CLOSED — a generation language is never guessed.
 */
export async function enqueuePrayerGenerationUnderTx(
  tx: DbClient,
  appointmentId: number,
): Promise<{ jobId: number; publicId: string }> {
  const row = (
    await tx
      .select({
        id: appointments.id,
        userId: appointments.userId,
        serviceId: appointments.serviceId,
        sacredHouseId: appointments.sacredHouseId,
        startsAtUtc: appointments.startsAtUtc,
        status: appointments.status,
      })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1)
  ).at(0)
  if (!row) throw new GenerationJobError('Appointment not found.')
  if (row.status !== 'CONFIRMED') {
    throw new GenerationJobError(
      'Generation jobs are only created for CONFIRMED appointments.',
    )
  }
  const guidanceSet = (
    await tx
      .select({
        preferredLanguageSnapshot:
          appointmentGuidanceSets.preferredLanguageSnapshot,
      })
      .from(appointmentGuidanceSets)
      .where(eq(appointmentGuidanceSets.appointmentId, appointmentId))
      .limit(1)
  ).at(0)
  const language = guidanceSet?.preferredLanguageSnapshot
  if (
    language == null ||
    !(GUIDANCE_LANGUAGES as ReadonlyArray<string>).includes(language)
  ) {
    // Fail the confirmation closed rather than guessing a language.
    throw new GenerationJobError(
      'Confirmation cannot establish a generation language snapshot.',
    )
  }
  const publicId = randomUUID()
  const variationSeed = computeVariationSeed({
    userId: row.userId,
    appointmentId: row.id,
    serviceId: row.serviceId,
    startsAtUtc: row.startsAtUtc,
  })
  let jobId: number
  try {
    const inserted = await tx.insert(prayerGenerationJobs).values({
      publicId,
      appointmentId: row.id,
      serviceIdSnapshot: row.serviceId,
      sacredHouseIdSnapshot: row.sacredHouseId,
      languageSnapshot: language as GuidanceLanguage,
      variationSeed,
      status: 'QUEUED',
    })
    jobId = inserted[0].insertId
  } catch (error) {
    // The UNIQUE appointment_id makes replays impossible; a duplicate
    // means the job already exists (idempotent no-op).
    if (isDuplicateKeyError(error)) {
      const existing = (
        await tx
          .select({
            id: prayerGenerationJobs.id,
            publicId: prayerGenerationJobs.publicId,
          })
          .from(prayerGenerationJobs)
          .where(eq(prayerGenerationJobs.appointmentId, appointmentId))
          .limit(1)
      ).at(0)
      if (existing) return { jobId: existing.id, publicId: existing.publicId }
    }
    throw error
  }
  await tx.insert(prayerGenerationJobEvents).values({
    generationJobId: jobId,
    fromStatus: null,
    toStatus: 'QUEUED',
    eventCode: 'job_enqueued',
    attemptNumber: 0,
  })
  return { jobId, publicId }
}

function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current)
    if (
      message.includes('ER_DUP_ENTRY') ||
      message.includes('Duplicate entry')
    ) {
      return true
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

// --- Queue / lease ----------------------------------------------------------

export interface ClaimedJob {
  job: typeof prayerGenerationJobs.$inferSelect
  leaseToken: string
}

function toSqlDate(date: Date): Date {
  return date
}

/**
 * Claims the next due QUEUED/RETRYING job under a bounded lease. Row
 * locking + in-lock recheck guarantee two workers can never own the
 * same live lease. Time is injectable for tests.
 *
 * LOCK-WAIT SAFETY: `clock.now()` is read twice. The FIRST reading
 * (`screeningNow`) happens before the lock and is NON-authoritative —
 * it only narrows the `SELECT ... FOR UPDATE SKIP LOCKED` scan to
 * plausibly-due candidates and can never by itself pass a job as
 * eligible or grant a lease. The SECOND reading (`freshNow`) happens
 * ONLY after that row's lock is held, and is the sole authority for
 * the eligibility RECHECK and for the granted lease. If the locking
 * SELECT takes any time to return (gap-lock contention, connection
 * pool wait, a slow scan), `screeningNow` may already be stale by the
 * time the lock is confirmed — a candidate whose lease was renewed (or
 * that otherwise stopped being due) during that wait is caught by the
 * recheck and released (return null) rather than claimed.
 */
async function claimDueJob(
  workerId: string,
  clock: GenerationClock,
  leaseMs: number,
  claimable: (jobs: typeof prayerGenerationJobs) => ReturnType<typeof and>,
): Promise<ClaimedJob | null> {
  return getDb().transaction(async (tx) => {
    const screeningNow = clock.now()
    const candidate = (
      await tx
        .select()
        .from(prayerGenerationJobs)
        .where(
          and(
            claimable(prayerGenerationJobs),
            or(
              isNull(prayerGenerationJobs.nextAttemptAt),
              lte(prayerGenerationJobs.nextAttemptAt, toSqlDate(screeningNow)),
            ),
            or(
              isNull(prayerGenerationJobs.leaseExpiresAt),
              lte(
                prayerGenerationJobs.leaseExpiresAt,
                toSqlDate(screeningNow),
              ),
            ),
          ),
        )
        .orderBy(asc(prayerGenerationJobs.id))
        .limit(1)
        .for('update', { skipLocked: true })
    ).at(0)
    if (!candidate) return null
    // Authoritative time: read ONLY after the row lock is held.
    const freshNow = clock.now()
    // RECHECK eligibility against freshNow — the screening filter
    // above may have run against an instant that is now stale.
    if (
      (candidate.nextAttemptAt != null &&
        candidate.nextAttemptAt > freshNow) ||
      (candidate.leaseExpiresAt != null && candidate.leaseExpiresAt > freshNow)
    ) {
      return null
    }
    const leaseToken = randomUUID()
    const updated = await tx
      .update(prayerGenerationJobs)
      .set({
        leaseToken,
        leaseOwner: workerId.slice(0, 100),
        leaseAcquiredAt: toSqlDate(freshNow),
        leaseExpiresAt: new Date(freshNow.getTime() + leaseMs),
      })
      .where(
        and(
          eq(prayerGenerationJobs.id, candidate.id),
          eq(prayerGenerationJobs.status, candidate.status),
          or(
            isNull(prayerGenerationJobs.leaseExpiresAt),
            lte(prayerGenerationJobs.leaseExpiresAt, toSqlDate(freshNow)),
          ),
        ),
      )
    if (updated[0].affectedRows !== 1) return null
    return {
      job: { ...candidate, leaseToken },
      leaseToken,
    }
  })
}

/** PREPARATION stage claim: fresh QUEUED work, or a RETRYING job that
 * resumes preparation (never one resuming a later stage). */
export async function claimNextGenerationJob(
  workerId: string,
  clock: GenerationClock,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedJob | null> {
  return claimDueJob(workerId, clock, leaseMs, (jobs) =>
    or(
      eq(jobs.status, 'QUEUED'),
      and(
        eq(jobs.status, 'RETRYING'),
        or(isNull(jobs.resumeStatus), eq(jobs.resumeStatus, 'PREPARING')),
      ),
    ),
  )
}

/** STORYBOARD stage claim (Step 13): a job parked in STORYBOARDING, or
 * a RETRYING job whose resume stage is STORYBOARDING. Claimed from its
 * own queue so continuous preparation work cannot starve it. */
export async function claimNextStoryboardJob(
  workerId: string,
  clock: GenerationClock,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedJob | null> {
  return claimDueJob(workerId, clock, leaseMs, (jobs) =>
    or(
      eq(jobs.status, 'STORYBOARDING'),
      and(eq(jobs.status, 'RETRYING'), eq(jobs.resumeStatus, 'STORYBOARDING')),
    ),
  )
}

/** VISUAL GENERATION stage claim (Step 14): a job parked in
 * GENERATING_VISUALS (fresh arrival, OR released back to itself by the
 * wait-without-budget self-loop — see GENERATION_TRANSITIONS), or a
 * RETRYING job whose resume stage is GENERATING_VISUALS. Claimed from
 * its own queue so continuous preparation/storyboard work cannot starve
 * it, matching claimNextGenerationJob / claimNextStoryboardJob exactly. */
export async function claimNextVisualGenerationJob(
  workerId: string,
  clock: GenerationClock,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedJob | null> {
  return claimDueJob(workerId, clock, leaseMs, (jobs) =>
    or(
      eq(jobs.status, 'GENERATING_VISUALS'),
      and(
        eq(jobs.status, 'RETRYING'),
        eq(jobs.resumeStatus, 'GENERATING_VISUALS'),
      ),
    ),
  )
}

/** AUDIO GENERATION stage claim (Step 15): a job parked in
 * GENERATING_AUDIO (fresh arrival, OR released back to itself by the
 * wait-without-budget self-loop — see GENERATION_TRANSITIONS), or a
 * RETRYING job whose resume stage is GENERATING_AUDIO. Claimed from its
 * own queue so continuous earlier-stage work cannot starve it, matching
 * every other stage claim exactly. */
export async function claimNextAudioGenerationJob(
  workerId: string,
  clock: GenerationClock,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedJob | null> {
  return claimDueJob(workerId, clock, leaseMs, (jobs) =>
    or(
      eq(jobs.status, 'GENERATING_AUDIO'),
      and(
        eq(jobs.status, 'RETRYING'),
        eq(jobs.resumeStatus, 'GENERATING_AUDIO'),
      ),
    ),
  )
}

/** RENDER stage claim (Step 16): a job parked in RENDERING, or a
 * RETRYING job whose resume stage is RENDERING. Claimed from its own
 * queue so continuous earlier-stage work cannot starve it, matching
 * every other stage claim exactly. */
export async function claimNextRenderJob(
  workerId: string,
  clock: GenerationClock,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedJob | null> {
  return claimDueJob(workerId, clock, leaseMs, (jobs) =>
    or(
      eq(jobs.status, 'RENDERING'),
      and(eq(jobs.status, 'RETRYING'), eq(jobs.resumeStatus, 'RENDERING')),
    ),
  )
}

/** UPLOAD stage claim (Step 17): a job parked in UPLOADING, or a
 * RETRYING job whose resume stage is UPLOADING. Claimed from its own
 * queue so continuous earlier-stage work cannot starve it, matching
 * every other stage claim exactly. */
export async function claimNextUploadJob(
  workerId: string,
  clock: GenerationClock,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedJob | null> {
  return claimDueJob(workerId, clock, leaseMs, (jobs) =>
    or(
      eq(jobs.status, 'UPLOADING'),
      and(eq(jobs.status, 'RETRYING'), eq(jobs.resumeStatus, 'UPLOADING')),
    ),
  )
}

/**
 * Renews a live lease. LOCK-WAIT SAFETY: the authoritative clock
 * reading is taken AFTER the job row lock is acquired, so time spent
 * waiting on another transaction's lock can never let an expired lease
 * be renewed with a pre-lock timestamp. The new expiry is derived from
 * that same post-lock reading.
 */
export async function renewGenerationLease(
  jobId: number,
  leaseToken: string,
  clock: GenerationClock,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const job = (
      await tx
        .select({
          id: prayerGenerationJobs.id,
          leaseToken: prayerGenerationJobs.leaseToken,
          leaseExpiresAt: prayerGenerationJobs.leaseExpiresAt,
        })
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
        .for('update')
    ).at(0)
    // Authoritative time: read ONLY after the row lock is held.
    const freshNow = clock.now()
    if (
      !job ||
      job.leaseToken !== leaseToken ||
      job.leaseExpiresAt == null ||
      job.leaseExpiresAt <= freshNow
    ) {
      return false
    }
    const updated = await tx
      .update(prayerGenerationJobs)
      .set({ leaseExpiresAt: new Date(freshNow.getTime() + leaseMs) })
      .where(
        and(
          eq(prayerGenerationJobs.id, jobId),
          eq(prayerGenerationJobs.leaseToken, leaseToken),
        ),
      )
    return updated[0].affectedRows === 1
  })
}

/** A transition patch is either a static object, or a factory invoked
 * with the post-lock `freshNow` — use the factory whenever any field
 * derives from the current instant (e.g. a retry's `nextAttemptAt`) so
 * it is computed from the SAME authoritative time as the transition
 * itself, never from a `clock.now()` evaluated before the lock. */
export type GenerationJobPatch = Partial<
  typeof prayerGenerationJobs.$inferInsert
>
export type LockedGenerationJobPatch =
  | GenerationJobPatch
  | ((freshNow: Date) => GenerationJobPatch)

function resolveLockedPatch(
  patch: LockedGenerationJobPatch | undefined,
  freshNow: Date,
): GenerationJobPatch {
  if (!patch) return {}
  return typeof patch === 'function' ? patch(freshNow) : patch
}

/**
 * Lease-guarded status transition: the transition re-requires the
 * current status AND the caller's live lease token, so a stale worker
 * (lease lost/expired) can never overwrite state. Every transition is
 * checked against the central legal map and recorded as an event.
 *
 * LOCK-WAIT SAFETY: the job row is locked FIRST and the authoritative
 * clock reading taken afterwards — waiting on another transaction's
 * lock can never let an expired lease transition using a pre-lock
 * timestamp. `options.patch` may be a factory over that SAME `freshNow`
 * so every derived timestamp in the patch (retry backoff, etc.) shares
 * the one authoritative instant with the transition it belongs to.
 */
export async function transitionGenerationJobUnderLease(
  jobId: number,
  leaseToken: string,
  from: GenerationJobStatus,
  to: GenerationJobStatus,
  clock: GenerationClock,
  options: {
    eventCode?: string
    detailCode?: string
    attemptNumber?: number
    patch?: LockedGenerationJobPatch
    clearLease?: boolean
  } = {},
): Promise<boolean> {
  if (!isLegalTransition(from, to)) {
    throw new GenerationJobError(`Illegal transition ${from} → ${to}.`)
  }
  return getDb().transaction(async (tx) => {
    const job = (
      await tx
        .select({
          id: prayerGenerationJobs.id,
          status: prayerGenerationJobs.status,
          leaseToken: prayerGenerationJobs.leaseToken,
          leaseExpiresAt: prayerGenerationJobs.leaseExpiresAt,
        })
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
        .for('update')
    ).at(0)
    // Authoritative time: read ONLY after the row lock is held.
    const freshNow = clock.now()
    if (
      !job ||
      job.status !== from ||
      job.leaseToken !== leaseToken ||
      job.leaseExpiresAt == null ||
      job.leaseExpiresAt <= freshNow
    ) {
      return false
    }
    const updated = await tx
      .update(prayerGenerationJobs)
      .set({
        status: to,
        ...(options.clearLease
          ? {
              leaseToken: null,
              leaseOwner: null,
              leaseAcquiredAt: null,
              leaseExpiresAt: null,
            }
          : {}),
        ...resolveLockedPatch(options.patch, freshNow),
      })
      .where(
        and(
          eq(prayerGenerationJobs.id, jobId),
          eq(prayerGenerationJobs.status, from),
          eq(prayerGenerationJobs.leaseToken, leaseToken),
        ),
      )
    if (updated[0].affectedRows !== 1) return false
    await tx.insert(prayerGenerationJobEvents).values({
      generationJobId: jobId,
      fromStatus: from,
      toStatus: to,
      eventCode: options.eventCode ?? 'transition',
      attemptNumber: options.attemptNumber ?? 0,
      detailCode: options.detailCode ?? null,
    })
    return true
  })
}

/** Statuses a worker may hold a lease in (processing states). */
const LEASED_PROCESSING_STATUSES: Array<GenerationJobStatus> = [
  'PREPARING',
  // Step 13: storyboard planning is actively processed under a lease.
  'STORYBOARDING',
  'GENERATING_VISUALS',
  'GENERATING_AUDIO',
  'RENDERING',
  'UPLOADING',
]

/**
 * Safe recovery of expired leases. A crashed processing attempt COUNTS
 * against the bounded retry budget — otherwise a job whose preparation
 * always crashes the worker would loop forever. Atomically (per job,
 * one transaction, guarded by the central transition map):
 *   attempt = attemptCount + 1
 *   attempt >= maxAttempts → FAILED (LEASE_EXPIRED)
 *   otherwise             → RETRYING (resume at the prior stage, due
 *                           on the deterministic bounded schedule)
 * The dead worker's stale token can no longer transition anything.
 *
 * LOCK-WAIT SAFETY: the initial scan uses a screening `clock.now()`
 * purely to find plausibly-expired candidates — it is NEVER used to
 * decide recovery or compute backoff. Each candidate is processed in
 * its OWN transaction, and ONLY AFTER that row's lock is held does the
 * loop take a fresh, authoritative `clock.now()` reading — both the
 * expiry recheck and the retry backoff for THAT job derive from that
 * one post-lock instant. This loop can process many candidates
 * sequentially, so reusing one pre-scan timestamp across all of them
 * would let it go stale by the time later candidates are reached (or
 * while earlier ones wait on their locks); a fresh per-candidate
 * reading closes that gap.
 */
export async function recoverExpiredGenerationLeases(
  clock: GenerationClock,
): Promise<number> {
  const db = getDb()
  const screeningNow = clock.now()
  const stuck = await db
    .select({ id: prayerGenerationJobs.id })
    .from(prayerGenerationJobs)
    .where(
      and(
        inArray(prayerGenerationJobs.status, LEASED_PROCESSING_STATUSES),
        sql`${prayerGenerationJobs.leaseExpiresAt} <= ${toSqlDate(screeningNow)}`,
      ),
    )
    .limit(100)
  let recovered = 0
  for (const candidate of stuck) {
    const changed = await db.transaction(async (tx) => {
      const job = (
        await tx
          .select()
          .from(prayerGenerationJobs)
          .where(eq(prayerGenerationJobs.id, candidate.id))
          .limit(1)
          .for('update')
      ).at(0)
      // Authoritative time: read ONLY after THIS row's lock is held.
      const freshNow = clock.now()
      if (
        !job ||
        !LEASED_PROCESSING_STATUSES.includes(job.status) ||
        job.leaseExpiresAt == null ||
        job.leaseExpiresAt > freshNow
      ) {
        return false
      }
      const attempt = job.attemptCount + 1
      const exhausted = attempt >= job.maxAttempts
      const to: GenerationJobStatus = exhausted ? 'FAILED' : 'RETRYING'
      if (!isLegalTransition(job.status, to)) {
        throw new GenerationJobError(
          `Illegal lease recovery ${job.status} → ${to}.`,
        )
      }
      const delayMinutes =
        RETRY_SCHEDULE_MINUTES[
          Math.min(job.attemptCount, RETRY_SCHEDULE_MINUTES.length - 1)
        ]
      const updated = await tx
        .update(prayerGenerationJobs)
        .set({
          status: to,
          attemptCount: attempt,
          resumeStatus: exhausted ? null : job.status,
          nextAttemptAt: exhausted
            ? null
            : new Date(freshNow.getTime() + delayMinutes * 60_000),
          leaseToken: null,
          leaseOwner: null,
          leaseAcquiredAt: null,
          leaseExpiresAt: null,
          lastErrorCode: 'LEASE_EXPIRED',
          lastErrorMessage: null,
        })
        .where(
          and(
            eq(prayerGenerationJobs.id, job.id),
            eq(prayerGenerationJobs.status, job.status),
            eq(prayerGenerationJobs.leaseToken, job.leaseToken ?? ''),
          ),
        )
      if (updated[0].affectedRows !== 1) return false
      await tx.insert(prayerGenerationJobEvents).values({
        generationJobId: job.id,
        fromStatus: job.status,
        toStatus: to,
        eventCode: exhausted ? 'lease_expired_max_attempts' : 'lease_expired',
        attemptNumber: attempt,
      })
      return true
    })
    if (changed) recovered += 1
  }
  return recovered
}

// --- Atomic snapshot + STORYBOARDING finalization ---------------------------

/**
 * ONE transaction finalizes a prepared recipe: lock + re-read the job,
 * take the authoritative clock reading AFTER the lock, require
 * PREPARING + the exact live lease against it, verify the central
 * transition map, allocate the next snapshot number, insert the
 * immutable snapshot, transition PREPARING → STORYBOARDING, store the
 * attempt count, set prepared_at, clear the lease and record the
 * event. If ANY lease/status check fails, NOTHING is inserted — a
 * stale worker can never append a snapshot or finalize.
 */
export async function persistPreparedRecipeUnderLease(
  jobId: number,
  leaseToken: string,
  attempt: number,
  recipe: Extract<VideoRecipe, { status: 'RECIPE_READY' }>,
  clock: GenerationClock,
): Promise<{ snapshotNumber: number } | null> {
  const recipeJsonText = JSON.stringify(recipe)
  const payloadSha256 = createHash('sha256')
    .update(recipeJsonText, 'utf8')
    .digest('hex')
  // Central state-machine authority: the finalizer may never bypass
  // GENERATION_TRANSITIONS.
  if (!isLegalTransition('PREPARING', 'STORYBOARDING')) {
    throw new GenerationJobError(
      'Illegal transition PREPARING → STORYBOARDING.',
    )
  }
  return getDb().transaction(async (tx) => {
    const job = (
      await tx
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
        .for('update')
    ).at(0)
    // Authoritative time: read ONLY after the row lock is held, so a
    // lock wait cannot let an expired lease finalize.
    const freshNow = clock.now()
    if (
      !job ||
      job.status !== 'PREPARING' ||
      job.leaseToken !== leaseToken ||
      job.leaseExpiresAt == null ||
      job.leaseExpiresAt <= freshNow
    ) {
      return null
    }
    const latest = (
      await tx
        .select({
          snapshotNumber: prayerGenerationRecipeSnapshots.snapshotNumber,
        })
        .from(prayerGenerationRecipeSnapshots)
        .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
        .orderBy(sql`${prayerGenerationRecipeSnapshots.snapshotNumber} DESC`)
        .limit(1)
        .for('update')
    ).at(0)
    const snapshotNumber = (latest?.snapshotNumber ?? 0) + 1
    await tx.insert(prayerGenerationRecipeSnapshots).values({
      generationJobId: jobId,
      snapshotNumber,
      recipeJsonText,
      payloadSha256,
      recipeSha256: recipe.recipeSha256,
      templateVersionId: recipe.templateVersionId,
      templateDefinitionSha256: recipe.templateDefinitionSha256,
      visualBibleVersionId: recipe.visualBible?.versionId ?? null,
      visualBibleDefinitionSha256: recipe.visualBible?.definitionSha256 ?? null,
    })
    const updated = await tx
      .update(prayerGenerationJobs)
      .set({
        status: 'STORYBOARDING',
        attemptCount: attempt,
        preparedAt: toSqlDate(freshNow),
        lastErrorCode: null,
        lastErrorMessage: null,
        nextAttemptAt: null,
        resumeStatus: null,
        leaseToken: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(prayerGenerationJobs.id, jobId),
          eq(prayerGenerationJobs.status, 'PREPARING'),
          eq(prayerGenerationJobs.leaseToken, leaseToken),
        ),
      )
    if (updated[0].affectedRows !== 1) {
      // Roll the WHOLE finalization back — no snapshot without the
      // matching transition.
      throw new GenerationJobError('Finalization conflict.')
    }
    await tx.insert(prayerGenerationJobEvents).values({
      generationJobId: jobId,
      fromStatus: 'PREPARING',
      toStatus: 'STORYBOARDING',
      eventCode: 'recipe_prepared',
      attemptNumber: attempt,
    })
    return { snapshotNumber }
  })
}

// --- Retry / failure helpers ------------------------------------------------

export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // Bounded, single-line, no stack traces or payloads.
  return message.replaceAll('\n', ' ').slice(0, 500)
}

export async function scheduleRetryOrFail(
  job: typeof prayerGenerationJobs.$inferSelect,
  leaseToken: string,
  clock: GenerationClock,
  errorCode: string,
  errorMessage: string | null,
  stage: GenerationJobStatus = 'PREPARING',
): Promise<'RETRYING' | 'FAILED' | 'LOST'> {
  const nextAttempt = job.attemptCount + 1
  if (nextAttempt >= job.maxAttempts) {
    const ok = await transitionGenerationJobUnderLease(
      job.id,
      leaseToken,
      stage,
      'FAILED',
      clock,
      {
        eventCode: 'max_attempts_exhausted',
        detailCode: errorCode,
        attemptNumber: nextAttempt,
        clearLease: true,
        patch: {
          attemptCount: nextAttempt,
          lastErrorCode: errorCode,
          lastErrorMessage: errorMessage,
          nextAttemptAt: null,
          resumeStatus: null,
        },
      },
    )
    return ok ? 'FAILED' : 'LOST'
  }
  const delayMinutes =
    RETRY_SCHEDULE_MINUTES[
      Math.min(job.attemptCount, RETRY_SCHEDULE_MINUTES.length - 1)
    ]
  const ok = await transitionGenerationJobUnderLease(
    job.id,
    leaseToken,
    stage,
    'RETRYING',
    clock,
    {
      eventCode: 'retry_scheduled',
      detailCode: errorCode,
      attemptNumber: nextAttempt,
      clearLease: true,
      // Locked-patch factory: nextAttemptAt derives from the SAME
      // post-lock freshNow the transition itself checks against —
      // never a clock.now() evaluated here, before the row is even
      // locked.
      patch: (freshNow) => ({
        attemptCount: nextAttempt,
        resumeStatus: stage,
        nextAttemptAt: new Date(freshNow.getTime() + delayMinutes * 60_000),
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
      }),
    },
  )
  return ok ? 'RETRYING' : 'LOST'
}

// --- Preparation worker (Step 12 processing) --------------------------------

export interface PreparationDependencies {
  buildRecipe?: typeof buildValidatedVideoRecipe
  validateRecipe?: typeof validateVideoRecipe
}

export type PreparationOutcome =
  | { status: 'IDLE' }
  | { status: 'PREPARED'; jobId: number; snapshotNumber: number }
  | { status: 'RETRY_SCHEDULED'; jobId: number; errorCode: string }
  | { status: 'FAILED'; jobId: number; errorCode: string }
  | { status: 'LEASE_LOST'; jobId: number }

/**
 * One preparation cycle: claim → PREPARING → REAL Step 11 build +
 * validate → append immutable snapshot → STORYBOARDING. Nothing here
 * calls a provider; RECIPE_UNAVAILABLE fails cleanly (no retry storm),
 * INVALID retries on the bounded schedule (authority may have changed
 * between build and validation), transient errors retry, and recipes
 * are never auto-healed. Future stages MUST revalidate the snapshot
 * before any provider/render work.
 */
export async function runGenerationPreparationOnce(
  workerId: string,
  clock: GenerationClock,
  dependencies: PreparationDependencies = {},
): Promise<PreparationOutcome> {
  const build = dependencies.buildRecipe ?? buildValidatedVideoRecipe
  const validate = dependencies.validateRecipe ?? validateVideoRecipe
  const claimed = await claimNextGenerationJob(workerId, clock)
  if (!claimed) return { status: 'IDLE' }
  const { job, leaseToken } = claimed
  const attempt = job.attemptCount + 1

  // Lease heartbeat: every lease-sensitive step reads a FRESH
  // clock.now(); a failed renewal marks this worker STALE — it must
  // not persist or finalize anything afterwards.
  const heartbeat = async (): Promise<boolean> =>
    renewGenerationLease(job.id, leaseToken, clock)
  const heartbeatTimer = setInterval(
    () => {
      void renewGenerationLease(job.id, leaseToken, clock).catch(
        () => undefined,
      )
    },
    Math.max(1_000, Math.floor(DEFAULT_LEASE_MS / 3)),
  )

  const started = await transitionGenerationJobUnderLease(
    job.id,
    leaseToken,
    job.status,
    'PREPARING',
    clock,
    {
      eventCode: 'preparation_started',
      attemptNumber: attempt,
      patch: { resumeStatus: null },
    },
  )
  if (!started) {
    clearInterval(heartbeatTimer)
    return { status: 'LEASE_LOST', jobId: job.id }
  }

  try {
    // Frozen context structural validity.
    if (
      !/^[0-9a-f]{64}$/.test(job.variationSeed) ||
      !(GUIDANCE_LANGUAGES as ReadonlyArray<string>).includes(
        job.languageSnapshot,
      )
    ) {
      const ok = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'PREPARING',
        'FAILED',
        clock,
        {
          eventCode: 'context_invalid',
          detailCode: 'FROZEN_CONTEXT_INVALID',
          attemptNumber: attempt,
          clearLease: true,
          patch: {
            attemptCount: attempt,
            lastErrorCode: 'FROZEN_CONTEXT_INVALID',
            lastErrorMessage: null,
          },
        },
      )
      return ok
        ? {
            status: 'FAILED',
            jobId: job.id,
            errorCode: 'FROZEN_CONTEXT_INVALID',
          }
        : { status: 'LEASE_LOST', jobId: job.id }
    }

    // Keep the lease alive across the potentially expensive Step 11
    // build; a failed renewal makes this worker stale immediately.
    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
    const recipe = await build({
      serviceId: job.serviceIdSnapshot,
      language: job.languageSnapshot,
      variationSeed: job.variationSeed,
    })
    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

    if (recipe.status === 'RECIPE_UNAVAILABLE') {
      // Governance says no valid session exists — retrying would storm.
      const ok = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'PREPARING',
        'FAILED',
        clock,
        {
          eventCode: 'recipe_unavailable',
          detailCode: recipe.reasons[0]?.slice(0, 100) ?? null,
          attemptNumber: attempt,
          clearLease: true,
          patch: {
            attemptCount: attempt,
            lastErrorCode: 'RECIPE_UNAVAILABLE',
            lastErrorMessage: recipe.reasons.join(', ').slice(0, 500),
            nextAttemptAt: null,
          },
        },
      )
      return ok
        ? { status: 'FAILED', jobId: job.id, errorCode: 'RECIPE_UNAVAILABLE' }
        : { status: 'LEASE_LOST', jobId: job.id }
    }

    const validation = await validate(recipe)
    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
    if (validation.status !== 'VALID') {
      // Authority may have shifted between build and validation —
      // bounded retry, never auto-heal.
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'RECIPE_INVALID',
        validation.reasons.join(', ').slice(0, 500),
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? { status: 'FAILED', jobId: job.id, errorCode: 'RECIPE_INVALID' }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'RECIPE_INVALID',
          }
    }

    // ATOMIC finalization: snapshot + PREPARING → STORYBOARDING under
    // a fresh-time lease check in ONE transaction — a stale worker
    // inserts nothing.
    const persisted = await persistPreparedRecipeUnderLease(
      job.id,
      leaseToken,
      attempt,
      recipe,
      clock,
    )
    if (!persisted) return { status: 'LEASE_LOST', jobId: job.id }
    return {
      status: 'PREPARED',
      jobId: job.id,
      snapshotNumber: persisted.snapshotNumber,
    }
  } catch (error) {
    const outcome = await scheduleRetryOrFail(
      job,
      leaseToken,
      clock,
      'PREPARATION_ERROR',
      sanitizeErrorMessage(error),
    )
    if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
    return outcome === 'FAILED'
      ? { status: 'FAILED', jobId: job.id, errorCode: 'PREPARATION_ERROR' }
      : {
          status: 'RETRY_SCHEDULED',
          jobId: job.id,
          errorCode: 'PREPARATION_ERROR',
        }
  } finally {
    clearInterval(heartbeatTimer)
  }
}

// --- Visual generation worker (Step 14 processing) --------------------------

/**
 * Real shape of Alpha's Step 14 executor service
 * (`src/services/visual-generation.ts`). Confirmed by direct
 * cross-check: Alpha's file imports `VisualTaskSubmissionResult` /
 * `VisualTaskPollResult` FROM this module by these exact names and
 * exports `submitScene(task)` / `pollScene(input)` against them — this
 * is a live, converged contract on both sides, not a one-sided
 * assumption. Alpha's own header comment names THIS module's
 * `runVisualGenerationOnce` as the sole owner of the task-row lifecycle
 * (PENDING/SUBMITTED/PROCESSING/SUCCEEDED/FAILED/CANCELLED); Alpha's
 * functions are pure — no DB row for the task itself is read or written
 * over there. Both re-verify authority against the CURRENT manifest
 * task on every call and never receive or return sacred body text, a
 * raw provider payload, or Visual Bible rule text — only ids, hashes
 * and bounded codes.
 */
/**
 * DID THE REQUEST CROSS THE PROVIDER BOUNDARY?
 *
 * The difference between a refusal and an unknown is the difference
 * between a free retry and a second charge for the same work.
 *
 *   NOT_SENT  POSITIVE PROOF that nothing was sent — a disabled
 *             adapter, a compile refusal, a provider-selection
 *             mismatch, a local validation rejection. All of them
 *             decided BEFORE any network write. Retrying is free.
 *   UNKNOWN   the request may have been accepted. A timeout, a
 *             connection reset, a 5xx, a malformed response, a
 *             generic provider exception, an ambiguous failure —
 *             every one of these is UNKNOWN, and none of them is
 *             ever retried automatically.
 *
 * ABSENT IS UNKNOWN. An adapter that forgets to answer must not
 * thereby authorise a second charge.
 */
export type ProviderSpendState = 'NOT_SENT' | 'UNKNOWN'

/** The sentinel a reserved-but-unresolved task carries, and the
 * detail code the job fails with. */
export const PROVIDER_OUTCOME_UNKNOWN = 'provider_outcome_unknown'

/**
 * How long a reservation is protected before it is treated as an
 * unknown outcome.
 *
 * Derived from the lease model rather than invented: a worker that
 * still holds a lease is still alive and may still be inside the
 * provider call, so quarantining its row would destroy a live paid
 * submission. Past a full lease window plus the recovery sweep's
 * own cadence, no worker can still own the job, so nobody is
 * waiting on a response any more.
 *
 * ANY provider submission timeout added later MUST be shorter than
 * this, or a call could still be in flight when its row is
 * quarantined.
 */
export const RESERVATION_STALE_AFTER_MS = DEFAULT_LEASE_MS * 2

export type VisualTaskSubmissionResult =
  | { status: 'SUBMITTED'; providerCode: string; providerOperationId: string }
  | {
      status: 'FAILED'
      providerCode: string
      errorCode: string
      errorMessage: string | null
      /** Absent is read as UNKNOWN — fail closed. */
      spendState?: ProviderSpendState
    }

export type VisualTaskPollResult =
  | { status: 'PROCESSING' }
  | {
      status: 'SUCCEEDED'
      artifactSha256: string
      artifactMimeType: string
      artifactDurationMs: number
      artifactStorageRef: string
    }
  | { status: 'FAILED'; errorCode: string; errorMessage: string | null }

export interface VisualGenerationDependencies {
  /**
   * Submits ONE manifest task.
   *
   * AT MOST ONCE, and that is enforced HERE rather than asked of the
   * adapter: the row is durably reserved before the call and never
   * returns to a submittable state afterwards. An adapter that also
   * happens to be idempotent is welcome to be, but nothing depends
   * on it — real vendors do not document one.
   */
  submitScene?: (
    task: ManifestVisualTask,
    options?: { expectedProviderCode?: string },
  ) => Promise<VisualTaskSubmissionResult>
  /** The ACTIVE provider's code, read BEFORE the call so the
   * reservation records who is about to be paid, and read again
   * immediately before the call so a selection change fails closed
   * without touching the network. */
  activeProviderCode?: () => string
  /** Polls ONE in-flight provider operation. Called with NO open DB
   * transaction and must not itself hold one — this loop persists the
   * result in a separate, subsequent write. */
  pollScene?: (input: {
    providerCode: string
    providerOperationId: string
    task: ManifestVisualTask
  }) => Promise<VisualTaskPollResult>
}

/** Structural governance failures (never worth retrying) vs. everything
 * else (authority may shift; bounded retry). Mirrors Step 13's
 * STRUCTURAL_FAILURES convention: loadAndValidateGenerationManifest
 * surfaces an expectedBuild failure as the FIRST (lowercased) reason. */
const STRUCTURAL_MANIFEST_FAILURES: ReadonlyArray<string> = [
  'context_mismatch',
  'governance_impossible',
  'scene_ceiling_exceeded',
]

const HEX64 = /^[0-9a-f]{64}$/

function isIntegrityValidResult(
  row: typeof prayerGenerationVisualTasks.$inferSelect,
): boolean {
  return (
    row.artifactSha256 != null &&
    HEX64.test(row.artifactSha256) &&
    row.artifactMimeType != null &&
    row.artifactMimeType.length > 0 &&
    row.artifactDurationMs != null &&
    row.artifactDurationMs > 0
  )
}

/**
 * The GENERATING_VISUALS → GENERATING_AUDIO gate, in full.
 *
 * Row metadata alone proves nothing: it says an artifact was produced,
 * not that the artifact still EXISTS, still matches its recorded hash,
 * or even belongs to this manifest. So finalization proves two things
 * the per-task loop cannot:
 *
 *   1. IDENTITY — the persisted rows are EXACTLY the manifest's
 *      visualTasks: same count, same task ids, same scene/idempotency
 *      binding. A missing row, an extra row (a task from a superseded
 *      manifest snapshot, a hand-inserted row) or a re-pointed one is a
 *      failure, never something to work around.
 *   2. ARTIFACT — every SUCCEEDED result is re-verified against PRIVATE
 *      STORAGE by `verify` (bytes re-read, hash recomputed, mime
 *      re-allowlisted, duration re-bounded against the manifest task).
 *
 * Fails CLOSED with a bounded machine code on the FIRST problem. A job
 * whose artifact vanished or was tampered with never advances to
 * GENERATING_AUDIO; it consumes retry budget like any other real
 * failure, and never auto-heals.
 */
async function verifyFinalizedVisualTasks(
  tasks: ReadonlyArray<ManifestVisualTask>,
  rows: ReadonlyArray<typeof prayerGenerationVisualTasks.$inferSelect>,
  verify: (
    claim: {
      artifactStorageRef: string | null
      artifactSha256: string | null
      artifactMimeType: string | null
      artifactDurationMs: number | null
    },
    task: ManifestVisualTask,
  ) => Promise<{ ok: true } | { ok: false; reasonCode: string }>,
): Promise<{ ok: true } | { ok: false; reasonCode: string }> {
  // Count first: with a per-task id lookup below, equal counts + every
  // manifest task found ⇒ no extras, no duplicates, no strays.
  if (rows.length !== tasks.length) {
    return { ok: false, reasonCode: 'task_count_mismatch' }
  }
  const byTaskId = new Map(rows.map((row) => [row.taskId, row]))
  if (byTaskId.size !== rows.length) {
    return { ok: false, reasonCode: 'duplicate_task_row' }
  }
  for (const task of tasks) {
    const row = byTaskId.get(task.taskId)
    if (!row) return { ok: false, reasonCode: 'task_row_missing' }
    if (row.sceneId !== task.sceneId) {
      return { ok: false, reasonCode: 'task_scene_mismatch' }
    }
    if (row.idempotencyKey !== task.idempotencyKey) {
      return { ok: false, reasonCode: 'task_idempotency_mismatch' }
    }
    if (row.status !== 'SUCCEEDED') {
      return { ok: false, reasonCode: 'task_not_succeeded' }
    }
    if (!isIntegrityValidResult(row)) {
      return { ok: false, reasonCode: 'artifact_metadata_invalid' }
    }
    const verified = await verify(
      {
        artifactStorageRef: row.artifactStorageRef,
        artifactSha256: row.artifactSha256,
        artifactMimeType: row.artifactMimeType,
        artifactDurationMs: row.artifactDurationMs,
      },
      task,
    )
    if (!verified.ok) return { ok: false, reasonCode: verified.reasonCode }
  }
  return { ok: true }
}

function isDuplicateVisualTaskError(error: unknown): boolean {
  return isDuplicateKeyError(error)
}

/** Ensures exactly ONE row exists for this manifest task, ever. Reuses
 * the same insert-then-fetch-on-conflict idempotency pattern as
 * enqueuePrayerGenerationUnderTx: the UNIQUE (job, manifest snapshot,
 * task id) constraint is the actual anti-duplicate-submission
 * authority; a conflicting insert just means the row already exists. */
async function ensureVisualTaskRow(
  jobId: number,
  manifestSnapshotId: number,
  task: ManifestVisualTask,
): Promise<typeof prayerGenerationVisualTasks.$inferSelect> {
  const db = getDb()
  const existing = (
    await db
      .select()
      .from(prayerGenerationVisualTasks)
      .where(
        and(
          eq(prayerGenerationVisualTasks.generationJobId, jobId),
          eq(prayerGenerationVisualTasks.manifestSnapshotId, manifestSnapshotId),
          eq(prayerGenerationVisualTasks.taskId, task.taskId),
        ),
      )
      .limit(1)
  ).at(0)
  if (existing) return existing
  try {
    await db.insert(prayerGenerationVisualTasks).values({
      generationJobId: jobId,
      manifestSnapshotId,
      taskId: task.taskId,
      sceneId: task.sceneId,
      idempotencyKey: task.idempotencyKey,
      status: 'PENDING',
    })
  } catch (error) {
    if (!isDuplicateVisualTaskError(error)) throw error
  }
  const row = (
    await db
      .select()
      .from(prayerGenerationVisualTasks)
      .where(
        and(
          eq(prayerGenerationVisualTasks.generationJobId, jobId),
          eq(prayerGenerationVisualTasks.manifestSnapshotId, manifestSnapshotId),
          eq(prayerGenerationVisualTasks.taskId, task.taskId),
        ),
      )
      .limit(1)
  ).at(0)
  if (!row) {
    throw new GenerationJobError('Visual task row vanished after insert.')
  }
  return row
}

export type VisualGenerationOutcome =
  | { status: 'IDLE' }
  | { status: 'WAITING'; jobId: number; pendingTasks: number }
  | { status: 'COMPLETE'; jobId: number }
  | { status: 'RETRY_SCHEDULED'; jobId: number; errorCode: string }
  | { status: 'FAILED'; jobId: number; errorCode: string }
  | { status: 'LEASE_LOST'; jobId: number }

/**
 * One visual-generation cycle: claim a GENERATING_VISUALS (or resuming
 * RETRYING) job, revalidate the CURRENT manifest, submit every
 * not-yet-submitted GENERATION_REQUIRED task and poll every in-flight
 * one — WITHOUT holding a DB transaction or a provider call open across
 * the other — then decide ONE of three outcomes:
 *
 *   - still work outstanding, nothing failed  → WAIT: release the lease
 *     via the GENERATING_VISUALS→GENERATING_VISUALS self-loop, due
 *     again in VISUAL_TASK_POLL_DELAY_MS. Does NOT touch attemptCount —
 *     awaiting a provider is not a failure.
 *   - a task failed for real                  → scheduleRetryOrFail
 *     (bounded RETRYING with resume_status=GENERATING_VISUALS, or
 *     FAILED once the job's attempt budget is exhausted). DOES consume
 *     budget, exactly like an expired lease recovered by
 *     recoverExpiredGenerationLeases (GENERATING_VISUALS is already a
 *     LEASED_PROCESSING_STATUS, so a crashed worker's lease expiring
 *     mid-cycle is caught there, unchanged, and also consumes budget).
 *   - every task SUCCEEDED (or there were none) → re-validate the
 *     manifest ONE MORE TIME against CURRENT authority (never trust the
 *     check from earlier in this same cycle), prove the persisted task
 *     rows are EXACTLY the manifest's visualTasks and re-verify every
 *     artifact against PRIVATE STORAGE (see verifyFinalizedVisualTasks),
 *     then finalize GENERATING_VISUALS → GENERATING_AUDIO under the SAME
 *     lease-CAS as every other transition — a stale worker can never
 *     finalize.
 *
 * Every provider action is fenced by an explicit lease heartbeat on BOTH
 * sides: a worker that has already lost its lease starts no further
 * submit/poll, and a result that came back after the lease went away is
 * never accepted (its stored artifact is removed rather than orphaned).
 */
export async function runVisualGenerationOnce(
  workerId: string,
  clock: GenerationClock,
  dependencies: VisualGenerationDependencies = {},
): Promise<VisualGenerationOutcome> {
  const claimed = await claimNextVisualGenerationJob(workerId, clock)
  if (!claimed) return { status: 'IDLE' }
  const { job, leaseToken } = claimed
  const attempt = job.attemptCount + 1

  const heartbeat = async (): Promise<boolean> =>
    renewGenerationLease(job.id, leaseToken, clock)
  const heartbeatTimer = setInterval(
    () => {
      void renewGenerationLease(job.id, leaseToken, clock).catch(
        () => undefined,
      )
    },
    Math.max(1_000, Math.floor(DEFAULT_LEASE_MS / 3)),
  )

  try {
    if (job.status === 'RETRYING') {
      const resumed = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'RETRYING',
        'GENERATING_VISUALS',
        clock,
        {
          eventCode: 'visual_generation_resumed',
          attemptNumber: attempt,
          patch: { resumeStatus: null },
        },
      )
      if (!resumed) return { status: 'LEASE_LOST', jobId: job.id }
    }

    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

    // Lazy imports: generation-storyboards.ts depends on THIS module
    // (same reason getGenerationJobDetail imports it lazily), and
    // visual-generation.ts depends on generation-storyboards.ts — a
    // static import of either here would create a cycle back to this
    // module. Dependency defaults are resolved from the SAME lazy
    // import, never a separate stale reference.
    const { loadAndValidateGenerationManifest, loadGenerationManifestSnapshot } =
      await import('./generation-storyboards')
    const {
      submitScene,
      pollScene,
      verifyStoredArtifact,
      discardGeneratedArtifact,
    } = await import('./visual-generation')
    const doSubmit = dependencies.submitScene ?? submitScene
    const doPoll = dependencies.pollScene ?? pollScene
    const { getVisualGenerationProvider } = await import(
      '@/providers/visual-generation/registry'
    )
    const activeProviderCode =
      dependencies.activeProviderCode ??
      (() => getVisualGenerationProvider().code)

    const validated = await loadAndValidateGenerationManifest(job.id)
    if (validated.status !== 'VALID') {
      const reason = validated.status === 'INVALID' ? validated.reasons[0] : null
      const structural =
        reason != null && STRUCTURAL_MANIFEST_FAILURES.includes(reason)
      const detail =
        validated.status === 'INVALID'
          ? validated.reasons.join(', ').slice(0, 500)
          : null
      if (structural) {
        const ok = await transitionGenerationJobUnderLease(
          job.id,
          leaseToken,
          'GENERATING_VISUALS',
          'FAILED',
          clock,
          {
            eventCode: 'manifest_impossible',
            // `structural` is only true when `reason != null` (see its
            // definition above), so `reason` is provably non-nullish on
            // every path reaching this block — TS narrows it through
            // that aliased condition, and the old `?.`/`??` fallbacks
            // here were dead code, not a real guard.
            detailCode: reason.slice(0, 100),
            attemptNumber: attempt,
            clearLease: true,
            patch: {
              attemptCount: attempt,
              lastErrorCode: reason.toUpperCase(),
              lastErrorMessage: detail,
              nextAttemptAt: null,
              resumeStatus: null,
            },
          },
        )
        return ok
          ? {
              status: 'FAILED',
              jobId: job.id,
              errorCode: reason.toUpperCase(),
            }
          : { status: 'LEASE_LOST', jobId: job.id }
      }
      // Authority may have shifted (or the row itself is unreadable) —
      // bounded retry, never auto-heal.
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        validated.status === 'INVALID' ? 'MANIFEST_INVALID' : validated.status,
        detail,
        'GENERATING_VISUALS',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? { status: 'FAILED', jobId: job.id, errorCode: 'MANIFEST_INVALID' }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'MANIFEST_INVALID',
          }
    }

    const manifestRow = await loadGenerationManifestSnapshot(job.id)
    if (manifestRow.status !== 'OK') {
      // Vanishingly unlikely immediately after a VALID revalidation
      // above, but never assume — bounded retry, same as any other
      // authority hiccup.
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'MANIFEST_UNREADABLE',
        null,
        'GENERATING_VISUALS',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? { status: 'FAILED', jobId: job.id, errorCode: 'MANIFEST_UNREADABLE' }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'MANIFEST_UNREADABLE',
          }
    }
    const manifestSnapshotId = manifestRow.snapshotId
    const tasks = validated.manifest.visualTasks

    let anyFailed = false
    let anyOutstanding = false
    /** A task whose provider outcome may never be known. TERMINAL for
     * the job: retrying would risk paying twice for one scene, so a
     * person decides what happens next, not a retry loop. */
    let anyOutcomeUnknown = false
    const nowForPoll = clock.now()

    for (const task of tasks) {
      let row = await ensureVisualTaskRow(job.id, manifestSnapshotId, task)

      // A task that failed on a prior attempt gets one more shot each
      // time the JOB ITSELF is freshly (re)claimed — but ONLY when
      // nothing was ever sent.
      //
      // `submittedAt IS NULL` is that proof, and it is why the
      // reservation sets it and a NOT_SENT failure clears it again:
      // the column means 'a request left this machine at this time',
      // so its absence is positive evidence that none did. A FAILED
      // row that still carries a submission time — including any
      // legacy row written before this rule existed — is treated as
      // UNKNOWN and is never resubmitted. Safety over retry
      // convenience, deliberately.
      if (row.status === 'FAILED') {
        if (row.submittedAt != null) {
          // LEGACY / UNRESOLVED: this failure carries submission
          // evidence, so the request may have reached the provider.
          // Older code left such rows as FAILED — a RESETTABLE state,
          // one worker restart away from a second charge. They are
          // NORMALIZED here to the terminal quarantine the rest of the
          // lifecycle already understands, and the job fails closed
          // exactly as if the quarantine had happened at submit time.
          const normalized = await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              completedAt: clock.now(),
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, 'FAILED'),
                isNotNull(prayerGenerationVisualTasks.submittedAt),
              ),
            )
          if (normalized[0].affectedRows === 1) {
            anyOutcomeUnknown = true
          } else {
            // The CAS lost: re-read and fail closed on the row’s
            // ACTUAL state. Never assume it became safely retryable.
            const fresh = (
              await getDb()
                .select()
                .from(prayerGenerationVisualTasks)
                .where(eq(prayerGenerationVisualTasks.id, row.id))
                .limit(1)
            ).at(0)
            if (
              fresh?.status === 'CANCELLED' &&
              fresh.lastErrorCode === PROVIDER_OUTCOME_UNKNOWN
            ) {
              anyOutcomeUnknown = true
            } else {
              anyOutstanding = true
            }
          }
          continue
        }
        // PROVABLY NOT SENT — no submission evidence, so one more
        // shot each time the JOB ITSELF is freshly (re)claimed. The
        // job’s own bounded maxAttempts is what ultimately bounds
        // how many times this can happen.
        const reset = await getDb()
          .update(prayerGenerationVisualTasks)
          .set({
            status: 'PENDING',
            providerCode: null,
            providerOperationId: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            nextPollAt: null,
          })
          .where(
            and(
              eq(prayerGenerationVisualTasks.id, row.id),
              eq(prayerGenerationVisualTasks.status, 'FAILED'),
              isNull(prayerGenerationVisualTasks.submittedAt),
            ),
          )
        if (reset[0].affectedRows !== 1) {
          // Another worker moved this row on since we read it — it is
          // no longer ours to redecide. A later cycle re-reads the
          // truth.
          anyOutstanding = true
          continue
        }
        row = { ...row, status: 'PENDING' }
      }

      if (row.status === 'PENDING') {
        // The exact status this row was in when WE decided to act —
        // 'PENDING' whether we arrived via the reset above or found it
        // PENDING outright. Every write below for THIS task is
        // conditioned on it still being there; captured fresh per
        // branch, never reused across a status change within the same
        // iteration (see the SUBMITTED/PROCESSING branch below, which
        // captures its OWN value separately).
        const statusAtRead = row.status
        // A worker that has ALREADY lost its lease must not start
        // another provider action: the job has moved on without it, and
        // every further submit/poll is work nobody asked for (and, with
        // a real provider, spend nobody authorized). Checked immediately
        // before the call, and again below once it returns.
        if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

        // RESERVE THE SPEND BEFORE MAKING IT.
        //
        // Until Step 20 this row stayed PENDING across the provider
        // call, justified by a provider-side idempotency promise.
        // Real vendors do not make that promise, so the promise has
        // to be ours: the row moves to SUBMITTED with a NULL
        // operation id FIRST, durably, outside any transaction. That
        // state means exactly one thing — 'a submission is reserved or
        // in flight and its outcome is not yet durably known' — and it
        // is NEVER a licence to submit again.
        //
        // The CAS is also what makes two workers safe: only one can
        // move PENDING to SUBMITTED, so only one can ever cross the
        // provider boundary for this task.
        const reservedProvider = activeProviderCode()
        const reserved = await getDb()
          .update(prayerGenerationVisualTasks)
          .set({
            status: 'SUBMITTED',
            providerCode: reservedProvider,
            providerOperationId: null,
            submittedAt: clock.now(),
            attemptCount: row.attemptCount + 1,
            lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
            lastErrorMessage: null,
            nextPollAt: null,
          })
          .where(
            and(
              eq(prayerGenerationVisualTasks.id, row.id),
              eq(prayerGenerationVisualTasks.status, statusAtRead),
            ),
          )
        if (reserved[0].affectedRows !== 1) {
          // Another worker reserved it first. Never call alongside.
          anyOutstanding = true
          continue
        }

        let submission: VisualTaskSubmissionResult
        try {
          submission = await doSubmit(task, {
            expectedProviderCode: reservedProvider,
          })
        } catch {
          // AN EXCEPTION ESCAPING THE SEAM AFTER RESERVATION IS AN
          // UNKNOWN OUTCOME. The reservation is durable and the call
          // was in flight when this threw — a timeout, a ripped
          // socket, a bug in an adapter — so the request may have
          // been accepted. Quarantined HERE, deterministically, not
          // handed to the generic error path where it would burn the
          // job’s budget as a retry and leave the row waiting to go
          // stale. The exception itself is deliberately dropped: raw
          // provider errors never reach rows or events.
          const quarantined = await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              lastErrorMessage: null,
              completedAt: clock.now(),
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, 'SUBMITTED'),
                eq(prayerGenerationVisualTasks.providerCode, reservedProvider),
                isNull(prayerGenerationVisualTasks.providerOperationId),
              ),
            )
          if (quarantined[0].affectedRows === 1) anyOutcomeUnknown = true
          else anyOutstanding = true
          continue
        }
        const freshNow = clock.now()

        // A) PROVABLY UNSENT IS HONORED FIRST — before the provider
        // binding gate. The in-seam selection check reports the NEW
        // provider’s code precisely because a switch was caught, and
        // punishing that honest answer with a quarantine would turn
        // a free, retryable refusal into a dead recording. NOT_SENT
        // requires explicit positive proof; nothing else lands here.
        if (
          submission.status === 'FAILED' &&
          submission.spendState === 'NOT_SENT'
        ) {
          // The CAS targets the RESERVED state — SUBMITTED, our
          // provider, no operation id — because that is what this
          // row IS now. Clearing submittedAt is the durable proof
          // that lets this row, and only rows like it, return to
          // PENDING later.
          const updated = await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'FAILED',
              submittedAt: null,
              providerOperationId: null,
              lastErrorCode: submission.errorCode.slice(0, 60),
              lastErrorMessage: submission.errorMessage?.slice(0, 500) ?? null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, 'SUBMITTED'),
                eq(prayerGenerationVisualTasks.providerCode, reservedProvider),
                isNull(prayerGenerationVisualTasks.providerOperationId),
              ),
            )
          if (updated[0].affectedRows === 1) {
            anyFailed = true
          } else {
            // The reservation is no longer ours. Re-read and fail
            // closed on the row’s ACTUAL state — never assume it
            // became safely retryable.
            const fresh = (
              await getDb()
                .select()
                .from(prayerGenerationVisualTasks)
                .where(eq(prayerGenerationVisualTasks.id, row.id))
                .limit(1)
            ).at(0)
            if (
              fresh?.status === 'CANCELLED' &&
              fresh.lastErrorCode === PROVIDER_OUTCOME_UNKNOWN
            ) {
              anyOutcomeUnknown = true
            } else {
              anyOutstanding = true
            }
          }
          continue
        }

        // B) EVERYTHING ELSE MAY HAVE CROSSED THE BOUNDARY, so the
        // answer must name the provider we reserved. An adapter
        // answering for some other provider is answering a question
        // nobody asked: the operation is never persisted or polled
        // under the other identity, and never retried.
        if (submission.providerCode !== reservedProvider) {
          const quarantined = await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              lastErrorMessage: null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, 'SUBMITTED'),
                eq(prayerGenerationVisualTasks.providerCode, reservedProvider),
                isNull(prayerGenerationVisualTasks.providerOperationId),
              ),
            )
          if (quarantined[0].affectedRows === 1) anyOutcomeUnknown = true
          else anyOutstanding = true
          continue
        }

        if (submission.status === 'SUBMITTED') {
          // AN OPERATION ID IS ONLY USEFUL IF IT IS USABLE — a
          // non-empty string that fits its column. But it is OPAQUE:
          // validated raw and persisted BYTE-FOR-BYTE, never trimmed,
          // lowercased or otherwise normalized, because a provider
          // will be asked for it back verbatim and “helpfully” tidied
          // identifiers are how continuations silently miss. Provider
          // contact HAS happened by now, so an unusable id is an
          // unknown outcome, never a NOT_SENT.
          const rawOperationId: unknown = submission.providerOperationId
          if (
            typeof rawOperationId !== 'string' ||
            rawOperationId.trim() === '' ||
            rawOperationId.length > 200
          ) {
            const quarantined = await getDb()
              .update(prayerGenerationVisualTasks)
              .set({
                status: 'CANCELLED',
                lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
                lastErrorMessage: null,
                completedAt: freshNow,
              })
              .where(
                and(
                  eq(prayerGenerationVisualTasks.id, row.id),
                  eq(prayerGenerationVisualTasks.status, 'SUBMITTED'),
                  eq(prayerGenerationVisualTasks.providerCode, reservedProvider),
                  isNull(prayerGenerationVisualTasks.providerOperationId),
                ),
              )
            if (quarantined[0].affectedRows === 1) anyOutcomeUnknown = true
            else anyOutstanding = true
            continue
          }
          // PROVIDER TRUTH IS PERSISTED EVEN IF THIS WORKER LOST THE
          // JOB LEASE MID-CALL. The operation id is the only thing that
          // lets any later worker CONTINUE this submission instead of
          // paying for a new one, so it is written on the reservation
          // we made — CAS’d on the reserved state and the reserved
          // provider, never on PENDING. If the row was already
          // quarantined, this write simply loses and does not resurrect
          // it.
          await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'SUBMITTED',
              providerCode: submission.providerCode,
              providerOperationId: rawOperationId,
              submittedAt: freshNow,
              lastErrorCode: null,
              nextPollAt: new Date(
                freshNow.getTime() + VISUAL_TASK_POLL_DELAY_MS,
              ),
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, 'SUBMITTED'),
                eq(prayerGenerationVisualTasks.providerCode, reservedProvider),
                isNull(prayerGenerationVisualTasks.providerOperationId),
              ),
            )
          anyOutstanding = true
        } else {
          // A FAILURE WITHOUT PROOF OF NON-SPEND. A timeout, a reset,
          // a 5xx, a malformed response, an adapter that did not say —
          // the request may have crossed the boundary, so this is
          // quarantined exactly like a crashed reservation, never
          // marked FAILED (which would be resettable) and never
          // retried. Absence of spendState lands here BY DESIGN.
          const quarantined = await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              lastErrorMessage: null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, 'SUBMITTED'),
                eq(prayerGenerationVisualTasks.providerCode, reservedProvider),
                isNull(prayerGenerationVisualTasks.providerOperationId),
              ),
            )
          if (quarantined[0].affectedRows === 1) anyOutcomeUnknown = true
          else anyOutstanding = true
          continue
        }
        // The provider round-trip above is unbounded, so the lease may
        // have expired and been recovered WHILE it was in flight. The
        // status-CAS'd write itself is deliberately NOT gated on the
        // lease — it records PROVIDER TRUTH (this operation exists, here
        // is its id), which stays true no matter who owns the job, and
        // dropping it would strand a real provider operation nobody can
        // reach again. What a lost lease DOES forbid is going further:
        // no next task, no other provider action, no job-level decision.
        if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
        continue
      }

      if (row.status === 'SUBMITTED' || row.status === 'PROCESSING') {
        if (row.nextPollAt != null && row.nextPollAt > nowForPoll) {
          // Not due yet this cycle.
          anyOutstanding = true
          continue
        }
        // Captured separately from the PENDING branch's statusAtRead —
        // this row's status at the moment WE decided to poll it, either
        // 'SUBMITTED' or 'PROCESSING', never a broader IN(...) match
        // (which could mask a real conflict, e.g. a legitimate
        // same-worker SUBMITTED→PROCESSING progression from a moment
        // ago satisfying a CAS meant to catch a DIFFERENT worker).
        const statusAtRead = row.status
        if (row.providerCode == null || row.providerOperationId == null) {
          // A LIVE RESERVATION IS NOT AN UNKNOWN OUTCOME.
          //
          // Another worker may have reserved this row moments ago and
          // still be inside the provider call. Quarantining it now
          // would abandon a submission that is about to succeed — and
          // worse, invite a second one. So a fresh reservation is
          // simply OUTSTANDING: this worker waits, and submits
          // nothing.
          const reservedAt = row.submittedAt?.getTime() ?? 0
          if (
            nowForPoll.getTime() - reservedAt <
            RESERVATION_STALE_AFTER_MS
          ) {
            anyOutstanding = true
            continue
          }
          // STALE: no worker can still hold the lease that made this
          // reservation, so nobody is waiting on a response. The
          // outcome is unknowable from here.
          //
          // QUARANTINE, not failure. FAILED is resettable to PENDING
          // a few lines above, and resetting this row would buy the
          // same generation a second time. CANCELLED is terminal for
          // a task and is written nowhere else, so it can never be
          // mistaken for an ordinary failure or resurrected by the
          // retry path — nor overwritten by a late response, because
          // every late write CASes on the reserved state.
          const quarantined = await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              completedAt: clock.now(),
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, statusAtRead),
                isNull(prayerGenerationVisualTasks.providerOperationId),
              ),
            )
          if (quarantined[0].affectedRows === 1) {
            anyOutcomeUnknown = true
          } else {
            anyOutstanding = true
          }
          continue
        }
        // Same rule as the submit branch: no provider action on a lease
        // this worker may already have lost.
        if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
        const poll = await doPoll({
          providerCode: row.providerCode,
          providerOperationId: row.providerOperationId,
          task,
        })
        // Unlike a submission (whose id is unrecoverable once dropped —
        // see the submit branch), a poll result is fully REPEATABLE: the
        // row stays SUBMITTED/PROCESSING and whoever holds the job next
        // polls the SAME operation id for the same answer. So a result
        // that came back after our lease went away is simply not ours to
        // accept. And because a SUCCEEDED poll has ALREADY written
        // artifact bytes to private storage by the time it returns, the
        // object we just created would be referenced by nothing at all —
        // it is removed rather than left behind by a worker that no
        // longer owns this job.
        if (!(await heartbeat())) {
          if (poll.status === 'SUCCEEDED') {
            await discardGeneratedArtifact(poll.artifactStorageRef)
          }
          return { status: 'LEASE_LOST', jobId: job.id }
        }
        const freshNow = clock.now()
        if (poll.status === 'PROCESSING') {
          // Non-terminal either way — same reasoning as the SUBMITTED
          // branch above: whichever write wins, this task is still
          // outstanding from THIS cycle's perspective.
          await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'PROCESSING',
              nextPollAt: new Date(
                freshNow.getTime() + VISUAL_TASK_POLL_DELAY_MS,
              ),
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, statusAtRead),
              ),
            )
          anyOutstanding = true
        } else if (poll.status === 'SUCCEEDED') {
          const updated = await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'SUCCEEDED',
              artifactSha256: poll.artifactSha256,
              artifactMimeType: poll.artifactMimeType,
              artifactDurationMs: poll.artifactDurationMs,
              artifactStorageRef: poll.artifactStorageRef,
              nextPollAt: null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, statusAtRead),
              ),
            )
          if (updated[0].affectedRows !== 1) {
            // Someone else already resolved this row — never overwrite
            // a result we don't own; wait and re-read next cycle. The
            // artifact we stored moments ago lost with it: no row
            // references that key, and none ever can (every put mints a
            // fresh server-generated key), so remove it instead of
            // leaving a stale worker's orphan on disk.
            await discardGeneratedArtifact(poll.artifactStorageRef)
            anyOutstanding = true
          }
        } else {
          const updated = await getDb()
            .update(prayerGenerationVisualTasks)
            .set({
              status: 'FAILED',
              attemptCount: row.attemptCount + 1,
              lastErrorCode: poll.errorCode.slice(0, 60),
              lastErrorMessage: poll.errorMessage?.slice(0, 500) ?? null,
              nextPollAt: null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationVisualTasks.id, row.id),
                eq(prayerGenerationVisualTasks.status, statusAtRead),
              ),
            )
          if (updated[0].affectedRows === 1) {
            anyFailed = true
          } else {
            // Same reasoning throughout: a lost CAS means another
            // worker already recorded this row's true outcome — our
            // stale FAILED verdict is discarded, not asserted.
            anyOutstanding = true
          }
        }
      }
      // A quarantined task keeps failing the job closed for as long
      // as it exists. It must never fall through to the
      // 'every task succeeded' finalization path, and it must never
      // be retried.
      if (
        row.status === 'CANCELLED' &&
        row.lastErrorCode === PROVIDER_OUTCOME_UNKNOWN
      ) {
        anyOutcomeUnknown = true
      }
      // SUCCEEDED: terminal, nothing to do.
    }

    // Stale-worker guard: task writes above are idempotent, provider-
    // truth records safe from any worker — but the JOB-LEVEL decision
    // below (wait / retry / finalize) must never proceed on a lease
    // this worker may have already lost.
    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

    // AN UNKNOWN OUTCOME ENDS THE JOB; it does not retry it. Every
    // other failure here is a KNOWN one, and those are safely
    // retryable within the job's bounded budget. This one is
    // different: a paid execution may exist that we cannot see, and
    // the only safe automatic action is to stop and let a person
    // reconcile it.
    if (anyOutcomeUnknown) {
      const ok = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'GENERATING_VISUALS',
        'FAILED',
        clock,
        {
          eventCode: 'visual_provider_outcome_unknown',
          detailCode: PROVIDER_OUTCOME_UNKNOWN,
          attemptNumber: attempt,
          clearLease: true,
          patch: {
            attemptCount: attempt,
            lastErrorCode: 'VISUAL_PROVIDER_OUTCOME_UNKNOWN',
            lastErrorMessage: null,
            nextAttemptAt: null,
          },
        },
      )
      return ok
        ? {
            status: 'FAILED',
            jobId: job.id,
            errorCode: 'VISUAL_PROVIDER_OUTCOME_UNKNOWN',
          }
        : { status: 'LEASE_LOST', jobId: job.id }
    }

    if (anyFailed) {
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'VISUAL_TASK_FAILED',
        null,
        'GENERATING_VISUALS',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? { status: 'FAILED', jobId: job.id, errorCode: 'VISUAL_TASK_FAILED' }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'VISUAL_TASK_FAILED',
          }
    }

    if (anyOutstanding) {
      // WAIT: release the lease via the explicit self-loop. Authority
      // for the next-due instant comes from freshNow inside the patch
      // factory, taken AFTER the lock — never from clock.now() here.
      const released = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'GENERATING_VISUALS',
        'GENERATING_VISUALS',
        clock,
        {
          eventCode: 'visual_generation_waiting',
          attemptNumber: attempt,
          clearLease: true,
          patch: (freshNow) => ({
            nextAttemptAt: new Date(
              freshNow.getTime() + VISUAL_TASK_POLL_DELAY_MS,
            ),
          }),
        },
      )
      return released
        ? {
            status: 'WAITING',
            jobId: job.id,
            pendingTasks: tasks.length,
          }
        : { status: 'LEASE_LOST', jobId: job.id }
    }

    // Every task SUCCEEDED (or there were none). Re-validate against
    // CURRENT authority ONE MORE TIME — never trust the check from
    // earlier in this same cycle — then prove the persisted results are
    // EXACTLY this manifest's tasks and that every artifact still exists
    // intact in PRIVATE STORAGE, before finalizing.
    const revalidated = await loadAndValidateGenerationManifest(job.id)
    if (revalidated.status !== 'VALID') {
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'MANIFEST_INVALID_AT_COMPLETION',
        revalidated.status === 'INVALID'
          ? revalidated.reasons.join(', ').slice(0, 500)
          : null,
        'GENERATING_VISUALS',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? {
            status: 'FAILED',
            jobId: job.id,
            errorCode: 'MANIFEST_INVALID_AT_COMPLETION',
          }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'MANIFEST_INVALID_AT_COMPLETION',
          }
    }

    const finalRows = await getDb()
      .select()
      .from(prayerGenerationVisualTasks)
      .where(
        and(
          eq(prayerGenerationVisualTasks.generationJobId, job.id),
          eq(prayerGenerationVisualTasks.manifestSnapshotId, manifestSnapshotId),
        ),
      )
    // Against the RE-validated manifest, not the one read at the top of
    // this cycle — the same "never trust the earlier check" discipline
    // the revalidation above exists for.
    const integrity = await verifyFinalizedVisualTasks(
      revalidated.manifest.visualTasks,
      finalRows,
      verifyStoredArtifact,
    )
    if (!integrity.ok) {
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'VISUAL_RESULT_INTEGRITY_FAILURE',
        // A bounded machine code (never a path, hash or provider
        // string) — enough to tell a vanished artifact from a tampered
        // one without echoing anything about content.
        integrity.reasonCode,
        'GENERATING_VISUALS',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? {
            status: 'FAILED',
            jobId: job.id,
            errorCode: 'VISUAL_RESULT_INTEGRITY_FAILURE',
          }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'VISUAL_RESULT_INTEGRITY_FAILURE',
          }
    }

    const finalized = await transitionGenerationJobUnderLease(
      job.id,
      leaseToken,
      'GENERATING_VISUALS',
      'GENERATING_AUDIO',
      clock,
      {
        eventCode: 'visual_generation_complete',
        attemptNumber: attempt,
        clearLease: true,
        patch: {
          attemptCount: attempt,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAttemptAt: null,
          resumeStatus: null,
        },
      },
    )
    return finalized
      ? { status: 'COMPLETE', jobId: job.id }
      : { status: 'LEASE_LOST', jobId: job.id }
  } catch (error) {
    const outcome = await scheduleRetryOrFail(
      job,
      leaseToken,
      clock,
      'VISUAL_GENERATION_ERROR',
      sanitizeErrorMessage(error),
      'GENERATING_VISUALS',
    )
    if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
    return outcome === 'FAILED'
      ? { status: 'FAILED', jobId: job.id, errorCode: 'VISUAL_GENERATION_ERROR' }
      : {
          status: 'RETRY_SCHEDULED',
          jobId: job.id,
          errorCode: 'VISUAL_GENERATION_ERROR',
        }
  } finally {
    clearInterval(heartbeatTimer)
  }
}

// ============================================================================
// STEP 15 — AUDIO GENERATION / APPROVED SPEECH SYNTHESIS
//
// Same shape as the Step 14 visual stage, and deliberately so: one
// durable row per unit of work, status-CAS'd writes, provider calls
// outside every transaction and fenced by lease heartbeats on both
// sides, a wait-without-budget self-loop, and a finalization gate that
// re-proves identity AND artifacts against private storage.
//
// What is NOT the same: an EXISTING_HUMAN_AUDIO requirement never
// becomes a task at all. An approved human recording of sacred text is
// resolved and re-verified in place — never synthesized, never
// regenerated, never sent to a provider.
// ============================================================================

export type AudioTaskSubmissionResult =
  | { status: 'SUBMITTED'; providerCode: string; providerOperationId: string }
  | {
      status: 'FAILED'
      providerCode: string
      errorCode: string
      errorMessage: string | null
      /** Absent is read as UNKNOWN — fail closed. */
      spendState?: ProviderSpendState
    }

export type AudioTaskPollResult =
  | { status: 'PROCESSING' }
  | {
      status: 'SUCCEEDED'
      artifactSha256: string
      artifactMimeType: string
      artifactDurationMs: number
      artifactStorageRef: string
    }
  | { status: 'FAILED'; errorCode: string; errorMessage: string | null }

/** The manifest-derived identity every provider action is keyed on.
 * `idempotencyKey` is a CLAIM, not authority: the executor recomputes
 * it from (generationJobId, manifestSha256, requirementId) and refuses
 * any value that disagrees, before contacting a provider. */
export interface AudioTaskIdentityInput {
  requirement: ManifestAudioRequirement
  generationJobId: number
  manifestSha256: string
  idempotencyKey?: string
}

export interface AudioGenerationDependencies {
  /**
   * Submits ONE TTS requirement.
   *
   * AT MOST ONCE, enforced HERE rather than asked of the adapter:
   * the row is durably reserved before the call and never returns to
   * a submittable state afterwards. Nothing depends on provider-side
   * idempotency — real speech vendors do not document one.
   */
  submitSpeech?: (
    input: AudioTaskIdentityInput,
    options?: { expectedProviderCode?: string },
  ) => Promise<AudioTaskSubmissionResult>
  /** The ACTIVE provider's code, read before the call so the
   * reservation records who is about to be paid. */
  activeProviderCode?: () => string
  /** Polls ONE in-flight synthesis. Called with NO open DB transaction
   * and must not itself hold one — this loop persists the result in a
   * separate, subsequent write. Continues an EXISTING operation: it
   * never recompiles or resends the approved text. */
  pollSpeech?: (
    input: AudioTaskIdentityInput & {
      providerCode: string
      providerOperationId: string
    },
  ) => Promise<AudioTaskPollResult>
}

function isIntegrityValidAudioResult(
  row: typeof prayerGenerationAudioTasks.$inferSelect,
): boolean {
  return (
    row.artifactSha256 != null &&
    HEX64.test(row.artifactSha256) &&
    row.artifactMimeType != null &&
    row.artifactMimeType.length > 0 &&
    row.artifactDurationMs != null &&
    row.artifactDurationMs > 0
  )
}

/** Ensures exactly ONE row exists for this audio requirement, ever.
 * Reuses the same insert-then-fetch-on-conflict idempotency pattern as
 * the visual stage: the UNIQUE (job, manifest snapshot, requirement id)
 * constraint is the actual anti-duplicate-submission authority; a
 * conflicting insert just means the row already exists. */
async function ensureAudioTaskRow(
  jobId: number,
  manifestSnapshotId: number,
  requirementId: string,
  sceneId: string,
  idempotencyKey: string,
): Promise<typeof prayerGenerationAudioTasks.$inferSelect> {
  const db = getDb()
  const existing = (
    await db
      .select()
      .from(prayerGenerationAudioTasks)
      .where(
        and(
          eq(prayerGenerationAudioTasks.generationJobId, jobId),
          eq(prayerGenerationAudioTasks.manifestSnapshotId, manifestSnapshotId),
          eq(prayerGenerationAudioTasks.requirementId, requirementId),
        ),
      )
      .limit(1)
  ).at(0)
  if (existing) return existing
  try {
    await db.insert(prayerGenerationAudioTasks).values({
      generationJobId: jobId,
      manifestSnapshotId,
      requirementId,
      sceneId,
      idempotencyKey,
      status: 'PENDING',
    })
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error
  }
  const row = (
    await db
      .select()
      .from(prayerGenerationAudioTasks)
      .where(
        and(
          eq(prayerGenerationAudioTasks.generationJobId, jobId),
          eq(prayerGenerationAudioTasks.manifestSnapshotId, manifestSnapshotId),
          eq(prayerGenerationAudioTasks.requirementId, requirementId),
        ),
      )
      .limit(1)
  ).at(0)
  if (!row) {
    throw new GenerationJobError('Audio task row vanished after insert.')
  }
  return row
}

/**
 * The GENERATING_AUDIO → RENDERING gate, in full.
 *
 * Proves three things the per-task loop cannot:
 *
 *   1. IDENTITY — the persisted rows are EXACTLY the manifest's
 *      TTS_PENDING requirements: same count, same requirement ids, same
 *      scene/idempotency binding. A missing row, an extra row (a
 *      requirement from a superseded manifest snapshot, a hand-inserted
 *      row, or — worst — a row for a requirement that was supposed to
 *      be an untouched human recording) or a re-pointed one is a
 *      failure, never something to work around.
 *   2. ARTIFACT — every SUCCEEDED result is re-verified against PRIVATE
 *      STORAGE by `verifyArtifact` (bytes re-read, hash recomputed,
 *      mime re-allowlisted, duration re-bounded).
 *   3. HUMAN AUDIO — every EXISTING_HUMAN_AUDIO requirement is STILL
 *      currently authorized and still byte-intact, re-proved by
 *      `verifyHumanAudio` against present authority. Nothing was
 *      generated for these, so nothing but a fresh re-proof can tell us
 *      they are still usable.
 *
 * Fails CLOSED with a bounded machine code on the FIRST problem. NONE
 * requirements create no work and no proof obligation beyond being
 * counted; a manifest with no audio at all is legitimately finalizable
 * once everything else validates.
 */
async function verifyFinalizedAudioRequirements(
  requirements: ReadonlyArray<ManifestAudioRequirement>,
  rows: ReadonlyArray<typeof prayerGenerationAudioTasks.$inferSelect>,
  manifestSha256: string,
  generationJobId: number,
  context: { serviceId: number; sacredHouseId: number; language: string },
  verifyArtifact: (claim: {
    artifactStorageRef: string | null
    artifactSha256: string | null
    artifactMimeType: string | null
    artifactDurationMs: number | null
  }) => Promise<{ ok: true } | { ok: false; reasonCode: string }>,
  verifyHumanAudio: (
    requirement: ManifestAudioRequirement,
    context: { serviceId: number; sacredHouseId: number; language: string },
  ) => Promise<{ ok: true } | { ok: false; reasonCode: string }>,
  computeKey: (input: {
    generationJobId: number
    manifestSha256: string
    requirementId: string
  }) => string,
): Promise<{ ok: true } | { ok: false; reasonCode: string }> {
  const ttsRequirements = requirements.filter(
    (requirement) => requirement.mode === 'TTS_PENDING',
  )
  // Count first: with a per-requirement lookup below, equal counts +
  // every TTS requirement found ⇒ no extras, no duplicates, no strays —
  // and in particular no task row standing in for a human recording.
  if (rows.length !== ttsRequirements.length) {
    return { ok: false, reasonCode: 'task_count_mismatch' }
  }
  const byRequirementId = new Map(rows.map((row) => [row.requirementId, row]))
  if (byRequirementId.size !== rows.length) {
    return { ok: false, reasonCode: 'duplicate_task_row' }
  }
  for (const requirement of ttsRequirements) {
    const requirementId = requirement.requirementId
    if (requirementId == null) {
      return { ok: false, reasonCode: 'incomplete_audio_requirement' }
    }
    const row = byRequirementId.get(requirementId)
    if (!row) return { ok: false, reasonCode: 'task_row_missing' }
    if (row.sceneId !== requirement.sceneId) {
      return { ok: false, reasonCode: 'task_scene_mismatch' }
    }
    if (
      row.idempotencyKey !==
      computeKey({ generationJobId, manifestSha256, requirementId })
    ) {
      return { ok: false, reasonCode: 'task_idempotency_mismatch' }
    }
    if (row.status !== 'SUCCEEDED') {
      return { ok: false, reasonCode: 'task_not_succeeded' }
    }
    if (!isIntegrityValidAudioResult(row)) {
      return { ok: false, reasonCode: 'artifact_metadata_invalid' }
    }
    const verified = await verifyArtifact({
      artifactStorageRef: row.artifactStorageRef,
      artifactSha256: row.artifactSha256,
      artifactMimeType: row.artifactMimeType,
      artifactDurationMs: row.artifactDurationMs,
    })
    if (!verified.ok) return { ok: false, reasonCode: verified.reasonCode }
  }
  for (const requirement of requirements) {
    if (requirement.mode !== 'EXISTING_HUMAN_AUDIO') continue
    const verified = await verifyHumanAudio(requirement, context)
    if (!verified.ok) return { ok: false, reasonCode: verified.reasonCode }
  }
  return { ok: true }
}

export type AudioGenerationOutcome =
  | { status: 'IDLE' }
  | { status: 'WAITING'; jobId: number; pendingTasks: number }
  | { status: 'COMPLETE'; jobId: number }
  | { status: 'RETRY_SCHEDULED'; jobId: number; errorCode: string }
  | { status: 'FAILED'; jobId: number; errorCode: string }
  | { status: 'LEASE_LOST'; jobId: number }

/**
 * One audio-generation cycle: claim a GENERATING_AUDIO (or resuming
 * RETRYING) job, revalidate the CURRENT manifest, submit every
 * not-yet-submitted TTS_PENDING requirement and poll every in-flight
 * one — WITHOUT holding a DB transaction or a provider call open across
 * the other — then decide ONE of three outcomes, exactly as the visual
 * stage does:
 *
 *   - still work outstanding, nothing failed  → WAIT: release the lease
 *     via the GENERATING_AUDIO→GENERATING_AUDIO self-loop, due again in
 *     AUDIO_TASK_POLL_DELAY_MS. Does NOT touch attemptCount — awaiting
 *     a provider is not a failure.
 *   - a task failed for real                  → scheduleRetryOrFail
 *     (bounded RETRYING with resume_status=GENERATING_AUDIO, or FAILED
 *     once the job's attempt budget is exhausted). DOES consume budget,
 *     exactly like an expired lease recovered by
 *     recoverExpiredGenerationLeases.
 *   - every TTS task SUCCEEDED (or there were none) → re-validate the
 *     manifest ONE MORE TIME against CURRENT authority, prove the
 *     persisted rows are EXACTLY the manifest's TTS requirements,
 *     re-verify every artifact against PRIVATE STORAGE and re-prove
 *     every EXISTING_HUMAN_AUDIO requirement is still authorized and
 *     intact (see verifyFinalizedAudioRequirements), then finalize
 *     GENERATING_AUDIO → RENDERING under the SAME lease-CAS as every
 *     other transition — a stale worker can never finalize.
 *
 * Every provider action is fenced by an explicit lease heartbeat on
 * BOTH sides: a worker that has already lost its lease starts no
 * further submit/poll, and a speech result that came back after the
 * lease went away is never accepted (its stored artifact is removed
 * rather than orphaned).
 *
 * NOTHING IS RENDERED HERE. This stage produces per-segment speech
 * artifacts and a proof that every audio requirement is satisfiable; it
 * never composes, mixes or muxes anything (no Remotion, no FFmpeg) and
 * never produces a deliverable video.
 */
export async function runAudioGenerationOnce(
  workerId: string,
  clock: GenerationClock,
  dependencies: AudioGenerationDependencies = {},
): Promise<AudioGenerationOutcome> {
  const claimed = await claimNextAudioGenerationJob(workerId, clock)
  if (!claimed) return { status: 'IDLE' }
  const { job, leaseToken } = claimed
  const attempt = job.attemptCount + 1

  const heartbeat = async (): Promise<boolean> =>
    renewGenerationLease(job.id, leaseToken, clock)
  const heartbeatTimer = setInterval(
    () => {
      void renewGenerationLease(job.id, leaseToken, clock).catch(
        () => undefined,
      )
    },
    Math.max(1_000, Math.floor(DEFAULT_LEASE_MS / 3)),
  )

  try {
    if (job.status === 'RETRYING') {
      const resumed = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'RETRYING',
        'GENERATING_AUDIO',
        clock,
        {
          eventCode: 'audio_generation_resumed',
          attemptNumber: attempt,
          patch: { resumeStatus: null },
        },
      )
      if (!resumed) return { status: 'LEASE_LOST', jobId: job.id }
    }

    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

    // Lazy imports for the same reason the visual stage uses them:
    // generation-storyboards.ts depends on THIS module, and
    // audio-generation.ts depends on generation-storyboards.ts, so a
    // static import of either here would create a cycle back to this
    // module. Dependency defaults are resolved from the SAME lazy
    // import, never a separate stale reference.
    const { loadAndValidateGenerationManifest, loadGenerationManifestSnapshot } =
      await import('./generation-storyboards')
    const {
      submitSpeech,
      pollSpeech,
      computeAudioTaskIdempotencyKey,
      verifyStoredAudioArtifact,
      verifyExistingHumanAudio,
      discardGeneratedSpeechArtifact,
    } = await import('./audio-generation')
    const doSubmit = dependencies.submitSpeech ?? submitSpeech
    const doPoll = dependencies.pollSpeech ?? pollSpeech
    const { getTtsProvider } = await import('@/providers/tts/registry')
    const activeProviderCode =
      dependencies.activeProviderCode ?? (() => getTtsProvider().code)

    const context = {
      serviceId: job.serviceIdSnapshot,
      sacredHouseId: job.sacredHouseIdSnapshot,
      language: job.languageSnapshot,
    }

    const validated = await loadAndValidateGenerationManifest(job.id)
    if (validated.status !== 'VALID') {
      const reason = validated.status === 'INVALID' ? validated.reasons[0] : null
      const structural =
        reason != null && STRUCTURAL_MANIFEST_FAILURES.includes(reason)
      const detail =
        validated.status === 'INVALID'
          ? validated.reasons.join(', ').slice(0, 500)
          : null
      if (structural) {
        const ok = await transitionGenerationJobUnderLease(
          job.id,
          leaseToken,
          'GENERATING_AUDIO',
          'FAILED',
          clock,
          {
            eventCode: 'manifest_impossible',
            detailCode: reason.slice(0, 100),
            attemptNumber: attempt,
            clearLease: true,
            patch: {
              attemptCount: attempt,
              lastErrorCode: reason.toUpperCase(),
              lastErrorMessage: detail,
              nextAttemptAt: null,
              resumeStatus: null,
            },
          },
        )
        return ok
          ? { status: 'FAILED', jobId: job.id, errorCode: reason.toUpperCase() }
          : { status: 'LEASE_LOST', jobId: job.id }
      }
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        validated.status === 'INVALID' ? 'MANIFEST_INVALID' : validated.status,
        detail,
        'GENERATING_AUDIO',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? { status: 'FAILED', jobId: job.id, errorCode: 'MANIFEST_INVALID' }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'MANIFEST_INVALID',
          }
    }

    const manifestRow = await loadGenerationManifestSnapshot(job.id)
    if (manifestRow.status !== 'OK') {
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'MANIFEST_UNREADABLE',
        null,
        'GENERATING_AUDIO',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? { status: 'FAILED', jobId: job.id, errorCode: 'MANIFEST_UNREADABLE' }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'MANIFEST_UNREADABLE',
          }
    }
    const manifestSnapshotId = manifestRow.snapshotId
    const manifestSha256 = validated.manifest.manifestSha256
    // ONLY TTS requirements become tasks. EXISTING_HUMAN_AUDIO is
    // resolved and re-verified at the gate below; NONE creates nothing.
    const ttsRequirements = validated.manifest.audioRequirements.filter(
      (requirement) => requirement.mode === 'TTS_PENDING',
    )

    let anyFailed = false
    let anyOutstanding = false
    /** A requirement whose provider outcome may never be known.
     * TERMINAL for the job: retrying risks paying twice for one
     * prayer's voice. */
    let anyOutcomeUnknown = false
    /** Set by the identity-before-spend guard below; reported as its own
     * bounded failure so a tampered task row is never mistaken for a
     * provider failure. */
    let taskIdentityFailure: string | null = null
    const nowForPoll = clock.now()

    for (const requirement of ttsRequirements) {
      const requirementId = requirement.requirementId
      if (requirementId == null) {
        // Structurally impossible for a manifest that just validated —
        // treat as a real failure rather than silently skipping a
        // requirement that would then never be satisfied.
        anyFailed = true
        continue
      }
      const idempotencyKey = computeAudioTaskIdempotencyKey({
        generationJobId: job.id,
        manifestSha256,
        requirementId,
      })
      let row = await ensureAudioTaskRow(
        job.id,
        manifestSnapshotId,
        requirementId,
        requirement.sceneId,
        idempotencyKey,
      )

      // IDENTITY BEFORE SPEND. The row we are about to act on must BE
      // this manifest requirement — same requirement id, same scene,
      // same authoritative idempotency key, same manifest snapshot.
      // ensureAudioTaskRow looks a row up by (job, snapshot,
      // requirement), so a disagreement here means the row was altered
      // after it was created; acting on it would submit (and pay for)
      // speech against an identity we cannot vouch for. Discovering
      // that at finalization would be far too late — the provider call
      // would already have happened.
      if (
        row.requirementId !== requirementId ||
        row.sceneId !== requirement.sceneId ||
        row.idempotencyKey !== idempotencyKey ||
        row.manifestSnapshotId !== manifestSnapshotId
      ) {
        taskIdentityFailure =
          row.idempotencyKey !== idempotencyKey
            ? 'task_idempotency_mismatch'
            : row.sceneId !== requirement.sceneId
              ? 'task_scene_mismatch'
              : 'task_identity_mismatch'
        continue
      }

      // A task that failed on a prior attempt gets one more shot each
      // time the JOB ITSELF is freshly (re)claimed — but ONLY when
      // nothing was ever sent. `submittedAt IS NULL` is that proof:
      // the column means 'a request left this machine at this time',
      // so its absence is positive evidence that none did. A FAILED
      // row that still carries a submission time — including a legacy
      // row written before this rule — is UNKNOWN and never resent.
      if (row.status === 'FAILED') {
        if (row.submittedAt != null) {
          // LEGACY / UNRESOLVED: this failure carries submission
          // evidence, so the request may have reached the provider.
          // Older code left such rows as FAILED — a RESETTABLE state,
          // one worker restart away from a second charge. They are
          // NORMALIZED here to the terminal quarantine the rest of the
          // lifecycle already understands, and the job fails closed
          // exactly as if the quarantine had happened at submit time.
          const normalized = await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              completedAt: clock.now(),
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, 'FAILED'),
                isNotNull(prayerGenerationAudioTasks.submittedAt),
              ),
            )
          if (normalized[0].affectedRows === 1) {
            anyOutcomeUnknown = true
          } else {
            // The CAS lost: re-read and fail closed on the row’s
            // ACTUAL state. Never assume it became safely retryable.
            const fresh = (
              await getDb()
                .select()
                .from(prayerGenerationAudioTasks)
                .where(eq(prayerGenerationAudioTasks.id, row.id))
                .limit(1)
            ).at(0)
            if (
              fresh?.status === 'CANCELLED' &&
              fresh.lastErrorCode === PROVIDER_OUTCOME_UNKNOWN
            ) {
              anyOutcomeUnknown = true
            } else {
              anyOutstanding = true
            }
          }
          continue
        }
        // PROVABLY NOT SENT — no submission evidence, so one more
        // shot each time the JOB ITSELF is freshly (re)claimed. The
        // job’s own bounded maxAttempts is what ultimately bounds
        // how many times this can happen.
        const reset = await getDb()
          .update(prayerGenerationAudioTasks)
          .set({
            status: 'PENDING',
            providerCode: null,
            providerOperationId: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            nextPollAt: null,
          })
          .where(
            and(
              eq(prayerGenerationAudioTasks.id, row.id),
              eq(prayerGenerationAudioTasks.status, 'FAILED'),
              isNull(prayerGenerationAudioTasks.submittedAt),
            ),
          )
        if (reset[0].affectedRows !== 1) {
          // Another worker moved this row on since we read it — it is
          // no longer ours to redecide. A later cycle re-reads the
          // truth.
          anyOutstanding = true
          continue
        }
        row = { ...row, status: 'PENDING' }
      }

      if (row.status === 'PENDING') {
        const statusAtRead = row.status
        // A worker that has ALREADY lost its lease must not start
        // another provider action — the job has moved on without it,
        // and every further submit/poll is work nobody asked for (and,
        // with a real provider, spend nobody authorized).
        if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

        // RESERVE THE SPEND BEFORE MAKING IT. Same rule as the visual
        // stage, and for the same reason: no speech vendor documents
        // idempotent submission, so at-most-once has to be ours. Only
        // the worker that wins this CAS may cross the boundary.
        const reservedProvider = activeProviderCode()
        const reserved = await getDb()
          .update(prayerGenerationAudioTasks)
          .set({
            status: 'SUBMITTED',
            providerCode: reservedProvider,
            providerOperationId: null,
            submittedAt: clock.now(),
            attemptCount: row.attemptCount + 1,
            lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
            lastErrorMessage: null,
            nextPollAt: null,
          })
          .where(
            and(
              eq(prayerGenerationAudioTasks.id, row.id),
              eq(prayerGenerationAudioTasks.status, statusAtRead),
            ),
          )
        if (reserved[0].affectedRows !== 1) {
          anyOutstanding = true
          continue
        }

        let submission: AudioTaskSubmissionResult
        try {
          submission = await doSubmit(
            {
              requirement,
              generationJobId: job.id,
              manifestSha256,
              idempotencyKey,
            },
            { expectedProviderCode: reservedProvider },
          )
        } catch {
          // AN EXCEPTION ESCAPING THE SEAM AFTER RESERVATION IS AN
          // UNKNOWN OUTCOME. The reservation is durable and the call
          // was in flight when this threw — a timeout, a ripped
          // socket, a bug in an adapter — so the request may have
          // been accepted. Quarantined HERE, deterministically, not
          // handed to the generic error path where it would burn the
          // job’s budget as a retry and leave the row waiting to go
          // stale. The exception itself is deliberately dropped: raw
          // provider errors never reach rows or events.
          const quarantined = await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              lastErrorMessage: null,
              completedAt: clock.now(),
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, 'SUBMITTED'),
                eq(prayerGenerationAudioTasks.providerCode, reservedProvider),
                isNull(prayerGenerationAudioTasks.providerOperationId),
              ),
            )
          if (quarantined[0].affectedRows === 1) anyOutcomeUnknown = true
          else anyOutstanding = true
          continue
        }
        const freshNow = clock.now()

        // A) PROVABLY UNSENT IS HONORED FIRST — before the provider
        // binding gate. The in-seam selection check reports the NEW
        // provider’s code precisely because a switch was caught, and
        // punishing that honest answer with a quarantine would turn
        // a free, retryable refusal into a dead recording. NOT_SENT
        // requires explicit positive proof; nothing else lands here.
        if (
          submission.status === 'FAILED' &&
          submission.spendState === 'NOT_SENT'
        ) {
          // The CAS targets the RESERVED state — SUBMITTED, our
          // provider, no operation id — because that is what this
          // row IS now. Clearing submittedAt is the durable proof
          // that lets this row, and only rows like it, return to
          // PENDING later.
          const updated = await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'FAILED',
              submittedAt: null,
              providerOperationId: null,
              lastErrorCode: submission.errorCode.slice(0, 60),
              lastErrorMessage: submission.errorMessage?.slice(0, 500) ?? null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, 'SUBMITTED'),
                eq(prayerGenerationAudioTasks.providerCode, reservedProvider),
                isNull(prayerGenerationAudioTasks.providerOperationId),
              ),
            )
          if (updated[0].affectedRows === 1) {
            anyFailed = true
          } else {
            // The reservation is no longer ours. Re-read and fail
            // closed on the row’s ACTUAL state — never assume it
            // became safely retryable.
            const fresh = (
              await getDb()
                .select()
                .from(prayerGenerationAudioTasks)
                .where(eq(prayerGenerationAudioTasks.id, row.id))
                .limit(1)
            ).at(0)
            if (
              fresh?.status === 'CANCELLED' &&
              fresh.lastErrorCode === PROVIDER_OUTCOME_UNKNOWN
            ) {
              anyOutcomeUnknown = true
            } else {
              anyOutstanding = true
            }
          }
          continue
        }

        // B) EVERYTHING ELSE MAY HAVE CROSSED THE BOUNDARY, so the
        // answer must name the provider we reserved. An adapter
        // answering for some other provider is answering a question
        // nobody asked: the operation is never persisted or polled
        // under the other identity, and never retried.
        if (submission.providerCode !== reservedProvider) {
          const quarantined = await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              lastErrorMessage: null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, 'SUBMITTED'),
                eq(prayerGenerationAudioTasks.providerCode, reservedProvider),
                isNull(prayerGenerationAudioTasks.providerOperationId),
              ),
            )
          if (quarantined[0].affectedRows === 1) anyOutcomeUnknown = true
          else anyOutstanding = true
          continue
        }

        if (submission.status === 'SUBMITTED') {
          // AN OPERATION ID IS ONLY USEFUL IF IT IS USABLE — a
          // non-empty string that fits its column. But it is OPAQUE:
          // validated raw and persisted BYTE-FOR-BYTE, never trimmed,
          // lowercased or otherwise normalized, because a provider
          // will be asked for it back verbatim and “helpfully” tidied
          // identifiers are how continuations silently miss. Provider
          // contact HAS happened by now, so an unusable id is an
          // unknown outcome, never a NOT_SENT.
          const rawOperationId: unknown = submission.providerOperationId
          if (
            typeof rawOperationId !== 'string' ||
            rawOperationId.trim() === '' ||
            rawOperationId.length > 200
          ) {
            const quarantined = await getDb()
              .update(prayerGenerationAudioTasks)
              .set({
                status: 'CANCELLED',
                lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
                lastErrorMessage: null,
                completedAt: freshNow,
              })
              .where(
                and(
                  eq(prayerGenerationAudioTasks.id, row.id),
                  eq(prayerGenerationAudioTasks.status, 'SUBMITTED'),
                  eq(prayerGenerationAudioTasks.providerCode, reservedProvider),
                  isNull(prayerGenerationAudioTasks.providerOperationId),
                ),
              )
            if (quarantined[0].affectedRows === 1) anyOutcomeUnknown = true
            else anyOutstanding = true
            continue
          }
          // PROVIDER TRUTH IS PERSISTED EVEN IF THIS WORKER LOST THE
          // JOB LEASE MID-CALL. The operation id is the only thing that
          // lets any later worker CONTINUE this submission instead of
          // paying for a new one, so it is written on the reservation
          // we made — CAS’d on the reserved state and the reserved
          // provider, never on PENDING. If the row was already
          // quarantined, this write simply loses and does not resurrect
          // it.
          await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'SUBMITTED',
              providerCode: submission.providerCode,
              providerOperationId: rawOperationId,
              submittedAt: freshNow,
              lastErrorCode: null,
              nextPollAt: new Date(
                freshNow.getTime() + AUDIO_TASK_POLL_DELAY_MS,
              ),
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, 'SUBMITTED'),
                eq(prayerGenerationAudioTasks.providerCode, reservedProvider),
                isNull(prayerGenerationAudioTasks.providerOperationId),
              ),
            )
          anyOutstanding = true
        } else {
          // A FAILURE WITHOUT PROOF OF NON-SPEND. A timeout, a reset,
          // a 5xx, a malformed response, an adapter that did not say —
          // the request may have crossed the boundary, so this is
          // quarantined exactly like a crashed reservation, never
          // marked FAILED (which would be resettable) and never
          // retried. Absence of spendState lands here BY DESIGN.
          const quarantined = await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              lastErrorMessage: null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, 'SUBMITTED'),
                eq(prayerGenerationAudioTasks.providerCode, reservedProvider),
                isNull(prayerGenerationAudioTasks.providerOperationId),
              ),
            )
          if (quarantined[0].affectedRows === 1) anyOutcomeUnknown = true
          else anyOutstanding = true
          continue
        }
        // Same reasoning as the visual stage: the status-CAS'd write is
        // deliberately NOT gated on the lease — it records PROVIDER
        // TRUTH (this synthesis exists, here is its id), which stays
        // true no matter who owns the job, and dropping it would strand
        // a real provider operation nobody can reach again. What a lost
        // lease DOES forbid is going further.
        if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
        continue
      }

      if (row.status === 'SUBMITTED' || row.status === 'PROCESSING') {
        if (row.nextPollAt != null && row.nextPollAt > nowForPoll) {
          anyOutstanding = true
          continue
        }
        const statusAtRead = row.status
        if (row.providerCode == null || row.providerOperationId == null) {
          // A LIVE RESERVATION IS NOT AN UNKNOWN OUTCOME — another
          // worker may still be inside the provider call.
          const reservedAt = row.submittedAt?.getTime() ?? 0
          if (
            nowForPoll.getTime() - reservedAt <
            RESERVATION_STALE_AFTER_MS
          ) {
            anyOutstanding = true
            continue
          }
          // STALE: nobody holds the lease that made this reservation.
          // QUARANTINE, never fail — FAILED is resettable and would
          // buy the same synthesis twice.
          const quarantined = await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'CANCELLED',
              lastErrorCode: PROVIDER_OUTCOME_UNKNOWN,
              completedAt: clock.now(),
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, statusAtRead),
                isNull(prayerGenerationAudioTasks.providerOperationId),
              ),
            )
          if (quarantined[0].affectedRows === 1) {
            anyOutcomeUnknown = true
          } else {
            anyOutstanding = true
          }
          continue
        }
        if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
        const poll = await doPoll({
          providerCode: row.providerCode,
          providerOperationId: row.providerOperationId,
          requirement,
          generationJobId: job.id,
          manifestSha256,
          idempotencyKey,
        })
        // Unlike a submission (whose id is unrecoverable once dropped),
        // a poll result is fully REPEATABLE: the row stays SUBMITTED/
        // PROCESSING and whoever holds the job next polls the SAME
        // operation id for the same answer. So a result that came back
        // after our lease went away is simply not ours to accept — and
        // because a SUCCEEDED poll has ALREADY written artifact bytes to
        // private storage by the time it returns, the object we just
        // created would be referenced by nothing at all.
        if (!(await heartbeat())) {
          if (poll.status === 'SUCCEEDED') {
            await discardGeneratedSpeechArtifact(poll.artifactStorageRef)
          }
          return { status: 'LEASE_LOST', jobId: job.id }
        }
        const freshNow = clock.now()
        if (poll.status === 'PROCESSING') {
          await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'PROCESSING',
              nextPollAt: new Date(
                freshNow.getTime() + AUDIO_TASK_POLL_DELAY_MS,
              ),
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, statusAtRead),
              ),
            )
          anyOutstanding = true
        } else if (poll.status === 'SUCCEEDED') {
          const updated = await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'SUCCEEDED',
              artifactSha256: poll.artifactSha256,
              artifactMimeType: poll.artifactMimeType,
              artifactDurationMs: poll.artifactDurationMs,
              artifactStorageRef: poll.artifactStorageRef,
              nextPollAt: null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, statusAtRead),
              ),
            )
          if (updated[0].affectedRows !== 1) {
            // Someone else already resolved this row — never overwrite
            // a result we don't own. The artifact we stored moments ago
            // lost with it: no row references that key, and none ever
            // can (every put mints a fresh server-generated key), so
            // remove it instead of leaving a stale worker's orphan.
            await discardGeneratedSpeechArtifact(poll.artifactStorageRef)
            anyOutstanding = true
          }
        } else {
          const updated = await getDb()
            .update(prayerGenerationAudioTasks)
            .set({
              status: 'FAILED',
              attemptCount: row.attemptCount + 1,
              lastErrorCode: poll.errorCode.slice(0, 60),
              lastErrorMessage: poll.errorMessage?.slice(0, 500) ?? null,
              nextPollAt: null,
              completedAt: freshNow,
            })
            .where(
              and(
                eq(prayerGenerationAudioTasks.id, row.id),
                eq(prayerGenerationAudioTasks.status, statusAtRead),
              ),
            )
          if (updated[0].affectedRows === 1) {
            anyFailed = true
          } else {
            anyOutstanding = true
          }
        }
      }
      // A quarantined requirement keeps failing the job closed. It
      // must never reach the 'every task succeeded' finalization
      // path, and must never be retried.
      if (
        row.status === 'CANCELLED' &&
        row.lastErrorCode === PROVIDER_OUTCOME_UNKNOWN
      ) {
        anyOutcomeUnknown = true
      }
      // SUCCEEDED: terminal, nothing to do.
    }

    // Stale-worker guard: task writes above are idempotent,
    // provider-truth records safe from any worker — but the JOB-LEVEL
    // decision below (wait / retry / finalize) must never proceed on a
    // lease this worker may have already lost.
    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

    // A tampered task row is decided FIRST and on its own code: no
    // provider call happened for it, so calling it a provider failure
    // would misreport what actually went wrong.
    if (taskIdentityFailure != null) {
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'AUDIO_TASK_IDENTITY_MISMATCH',
        taskIdentityFailure,
        'GENERATING_AUDIO',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? {
            status: 'FAILED',
            jobId: job.id,
            errorCode: 'AUDIO_TASK_IDENTITY_MISMATCH',
          }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'AUDIO_TASK_IDENTITY_MISMATCH',
          }
    }

    // AN UNKNOWN OUTCOME ENDS THE JOB. A paid synthesis may exist
    // that we cannot see; the only safe automatic action is to stop
    // and let a person reconcile it.
    if (anyOutcomeUnknown) {
      const ok = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'GENERATING_AUDIO',
        'FAILED',
        clock,
        {
          eventCode: 'tts_provider_outcome_unknown',
          detailCode: PROVIDER_OUTCOME_UNKNOWN,
          attemptNumber: attempt,
          clearLease: true,
          patch: {
            attemptCount: attempt,
            lastErrorCode: 'TTS_PROVIDER_OUTCOME_UNKNOWN',
            lastErrorMessage: null,
            nextAttemptAt: null,
            resumeStatus: null,
          },
        },
      )
      return ok
        ? {
            status: 'FAILED',
            jobId: job.id,
            errorCode: 'TTS_PROVIDER_OUTCOME_UNKNOWN',
          }
        : { status: 'LEASE_LOST', jobId: job.id }
    }

    if (anyFailed) {
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'AUDIO_TASK_FAILED',
        null,
        'GENERATING_AUDIO',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? { status: 'FAILED', jobId: job.id, errorCode: 'AUDIO_TASK_FAILED' }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'AUDIO_TASK_FAILED',
          }
    }

    if (anyOutstanding) {
      // WAIT: release the lease via the explicit self-loop. Authority
      // for the next-due instant comes from freshNow inside the patch
      // factory, taken AFTER the lock — never from clock.now() here.
      const released = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'GENERATING_AUDIO',
        'GENERATING_AUDIO',
        clock,
        {
          eventCode: 'audio_generation_waiting',
          attemptNumber: attempt,
          clearLease: true,
          patch: (freshNow) => ({
            nextAttemptAt: new Date(
              freshNow.getTime() + AUDIO_TASK_POLL_DELAY_MS,
            ),
          }),
        },
      )
      return released
        ? {
            status: 'WAITING',
            jobId: job.id,
            pendingTasks: ttsRequirements.length,
          }
        : { status: 'LEASE_LOST', jobId: job.id }
    }

    // Every TTS task SUCCEEDED (or there were none). Re-validate against
    // CURRENT authority ONE MORE TIME — never trust the check from
    // earlier in this same cycle — then prove the persisted rows are
    // EXACTLY this manifest's TTS requirements, that every artifact
    // still exists intact in PRIVATE STORAGE, and that every approved
    // human recording is still authorized and intact.
    const revalidated = await loadAndValidateGenerationManifest(job.id)
    if (revalidated.status !== 'VALID') {
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'MANIFEST_INVALID_AT_COMPLETION',
        revalidated.status === 'INVALID'
          ? revalidated.reasons.join(', ').slice(0, 500)
          : null,
        'GENERATING_AUDIO',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? {
            status: 'FAILED',
            jobId: job.id,
            errorCode: 'MANIFEST_INVALID_AT_COMPLETION',
          }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'MANIFEST_INVALID_AT_COMPLETION',
          }
    }

    const finalRows = await getDb()
      .select()
      .from(prayerGenerationAudioTasks)
      .where(
        and(
          eq(prayerGenerationAudioTasks.generationJobId, job.id),
          eq(prayerGenerationAudioTasks.manifestSnapshotId, manifestSnapshotId),
        ),
      )
    const integrity = await verifyFinalizedAudioRequirements(
      revalidated.manifest.audioRequirements,
      finalRows,
      revalidated.manifest.manifestSha256,
      job.id,
      context,
      verifyStoredAudioArtifact,
      verifyExistingHumanAudio,
      computeAudioTaskIdempotencyKey,
    )
    if (!integrity.ok) {
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        'AUDIO_RESULT_INTEGRITY_FAILURE',
        // A bounded machine code (never a path, hash, provider string
        // or anything derived from content).
        integrity.reasonCode,
        'GENERATING_AUDIO',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? {
            status: 'FAILED',
            jobId: job.id,
            errorCode: 'AUDIO_RESULT_INTEGRITY_FAILURE',
          }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: 'AUDIO_RESULT_INTEGRITY_FAILURE',
          }
    }

    const finalized = await transitionGenerationJobUnderLease(
      job.id,
      leaseToken,
      'GENERATING_AUDIO',
      'RENDERING',
      clock,
      {
        eventCode: 'audio_generation_complete',
        attemptNumber: attempt,
        clearLease: true,
        patch: {
          attemptCount: attempt,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAttemptAt: null,
          resumeStatus: null,
        },
      },
    )
    return finalized
      ? { status: 'COMPLETE', jobId: job.id }
      : { status: 'LEASE_LOST', jobId: job.id }
  } catch (error) {
    const outcome = await scheduleRetryOrFail(
      job,
      leaseToken,
      clock,
      'AUDIO_GENERATION_ERROR',
      sanitizeErrorMessage(error),
      'GENERATING_AUDIO',
    )
    if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
    return outcome === 'FAILED'
      ? { status: 'FAILED', jobId: job.id, errorCode: 'AUDIO_GENERATION_ERROR' }
      : {
          status: 'RETRY_SCHEDULED',
          jobId: job.id,
          errorCode: 'AUDIO_GENERATION_ERROR',
        }
  } finally {
    clearInterval(heartbeatTimer)
  }
}

// --- Snapshot loaders (fail closed, never rebuild) --------------------------

export type LoadedSnapshot =
  | {
      status: 'OK'
      snapshotId: number
      snapshotNumber: number
      recipe: Extract<VideoRecipe, { status: 'RECIPE_READY' }>
      payloadSha256: string
    }
  | { status: 'NOT_PREPARED' }
  | { status: 'INTEGRITY_FAILURE' }

export async function loadGenerationRecipeSnapshot(
  jobId: number,
): Promise<LoadedSnapshot> {
  const snapshot = (
    await getDb()
      .select()
      .from(prayerGenerationRecipeSnapshots)
      .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
      .orderBy(sql`${prayerGenerationRecipeSnapshots.snapshotNumber} DESC`)
      .limit(1)
  ).at(0)
  if (!snapshot) return { status: 'NOT_PREPARED' }
  const recomputedPayload = createHash('sha256')
    .update(snapshot.recipeJsonText, 'utf8')
    .digest('hex')
  if (recomputedPayload !== snapshot.payloadSha256) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot.recipeJsonText)
  } catch {
    return { status: 'INTEGRITY_FAILURE' }
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    (parsed as { status?: unknown }).status !== 'RECIPE_READY' ||
    typeof (parsed as { recipeSha256?: unknown }).recipeSha256 !== 'string'
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  const recipe = parsed as Extract<VideoRecipe, { status: 'RECIPE_READY' }>
  const { recipeSha256, ...body } = recipe
  if (
    computeRecipeSha256(body) !== recipeSha256 ||
    recipeSha256 !== snapshot.recipeSha256
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  return {
    status: 'OK',
    snapshotId: snapshot.id,
    snapshotNumber: snapshot.snapshotNumber,
    recipe,
    payloadSha256: snapshot.payloadSha256,
  }
}

export type ValidatedSnapshot =
  | {
      status: 'VALID'
      snapshotId: number
      snapshotNumber: number
      recipe: Extract<VideoRecipe, { status: 'RECIPE_READY' }>
    }
  | { status: 'INVALID'; reasons: Array<string> }
  | { status: 'INTEGRITY_FAILURE' }
  | { status: 'NOT_PREPARED' }

/** Loads the snapshot AND re-runs the CURRENT Step 11 validator —
 * later stages must call this before any provider/render work. */
export async function loadAndValidateGenerationRecipe(
  jobId: number,
): Promise<ValidatedSnapshot> {
  const loaded = await loadGenerationRecipeSnapshot(jobId)
  if (loaded.status !== 'OK') return { status: loaded.status }
  const validation = await validateVideoRecipe(loaded.recipe)
  if (validation.status === 'INVALID') {
    return { status: 'INVALID', reasons: validation.reasons }
  }
  return {
    status: 'VALID',
    snapshotId: loaded.snapshotId,
    snapshotNumber: loaded.snapshotNumber,
    recipe: loaded.recipe,
  }
}

// --- Admin operations (technical retry/cancel) ------------------------------

const TERMINAL_STATUSES: Array<GenerationJobStatus> = ['READY', 'CANCELLED']

/** Technical ADMIN cancellation of a non-terminal job. Never triggered
 * automatically by appointment changes — that business rule is decided
 * before paid generation begins. History/snapshots stay untouched. */
export async function adminCancelGenerationJob(
  actorId: number,
  ctx: RequestContext,
  jobId: number,
  reason: string,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')
  const trimmed = reason.trim()
  if (!trimmed) {
    throw new GenerationJobError('Cancellation requires a reason.')
  }
  const from = await getDb().transaction(async (tx) => {
    const job = (
      await tx
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!job) throw new GenerationJobError('Generation job not found.')
    if (TERMINAL_STATUSES.includes(job.status)) {
      throw new GenerationJobError('This job is already terminal.')
    }
    // Central state-machine authority — never bypass the map.
    if (!isLegalTransition(job.status, 'CANCELLED')) {
      throw new GenerationJobError(
        `Illegal transition ${job.status} → CANCELLED.`,
      )
    }
    const updated = await tx
      .update(prayerGenerationJobs)
      .set({
        status: 'CANCELLED',
        leaseToken: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
        lastErrorCode: 'ADMIN_CANCELLED',
        lastErrorMessage: trimmed.slice(0, 500),
      })
      .where(
        and(
          eq(prayerGenerationJobs.id, jobId),
          eq(prayerGenerationJobs.status, job.status),
        ),
      )
    if (updated[0].affectedRows !== 1) {
      throw new GenerationJobError('Cancellation conflict — try again.')
    }
    await tx.insert(prayerGenerationJobEvents).values({
      generationJobId: jobId,
      fromStatus: job.status,
      toStatus: 'CANCELLED',
      eventCode: 'admin_cancelled',
      attemptNumber: job.attemptCount,
    })
    return job.status
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'generation_job.cancelled',
    entityType: 'prayer_generation_job',
    entityId: String(jobId),
    metadata: { from, to: 'CANCELLED' },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/** Technical ADMIN retry of a FAILED job: preparation restarts from
 * the beginning with a fresh bounded attempt budget. */
export async function adminRetryGenerationJob(
  actorId: number,
  ctx: RequestContext,
  jobId: number,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')
  await getDb().transaction(async (tx) => {
    const job = (
      await tx
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!job) throw new GenerationJobError('Generation job not found.')
    if (job.status !== 'FAILED') {
      throw new GenerationJobError('Only FAILED jobs can be retried.')
    }
    // AN UNKNOWN PROVIDER OUTCOME BLOCKS THE GENERIC RETRY.
    //
    // This retry restarts from PREPARING, which mints fresh snapshots
    // and therefore fresh task identities — so it would sail past both
    // the unique idempotency key and the pre-call reservation and buy
    // the work a second time. That is exactly what must not happen
    // while a paid execution may already exist somewhere we cannot see.
    //
    // There is deliberately no override flag, no bypass button and no
    // extra role: an operator must reconcile the outcome with the
    // provider first. A future deliberate re-spend, if it is ever
    // needed, has to be its own designed and audited action.
    // ONE RULE, deliberately blunt: any task showing EXTERNAL PROVIDER
    // INTERACTION EVIDENCE — a non-null submittedAt — blocks the
    // generic restart. That covers a live reservation, a known
    // operation mid-poll, a quarantined unknown, a legacy FAILED row
    // the worker has not yet normalized, and even a SUCCEEDED task
    // whose paid output a restart-from-PREPARING would abandon and
    // re-buy under fresh snapshots and fresh task identities.
    //
    // A NOT_SENT failure explicitly CLEARS submittedAt, so provably
    // free failures remain retryable; a job with no provider tasks at
    // all (a preparation-stage failure) passes untouched. Avoiding
    // duplicate or repeated paid work outranks generic recovery
    // convenience — a provider-aware reconciliation, if ever built, is
    // a separate designed and audited action.
    const quarantined = await tx
      .select({ id: prayerGenerationVisualTasks.id })
      .from(prayerGenerationVisualTasks)
      .where(
        and(
          eq(prayerGenerationVisualTasks.generationJobId, jobId),
          isNotNull(prayerGenerationVisualTasks.submittedAt),
        ),
      )
      .limit(1)
    const quarantinedAudio = await tx
      .select({ id: prayerGenerationAudioTasks.id })
      .from(prayerGenerationAudioTasks)
      .where(
        and(
          eq(prayerGenerationAudioTasks.generationJobId, jobId),
          isNotNull(prayerGenerationAudioTasks.submittedAt),
        ),
      )
      .limit(1)
    if (quarantined.length > 0 || quarantinedAudio.length > 0) {
      // Neutral and technical: an administrator learns that this job
      // needs reconciliation, not what a provider was or was not paid.
      throw new GenerationJobError(
        'This generation cannot be retried automatically: a provider outcome is unresolved.',
      )
    }
    // Central state-machine authority — never bypass the map.
    if (!isLegalTransition(job.status, 'RETRYING')) {
      throw new GenerationJobError(
        `Illegal transition ${job.status} → RETRYING.`,
      )
    }
    const updated = await tx
      .update(prayerGenerationJobs)
      .set({
        status: 'RETRYING',
        resumeStatus: 'PREPARING',
        attemptCount: 0,
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      })
      .where(
        and(
          eq(prayerGenerationJobs.id, jobId),
          eq(prayerGenerationJobs.status, 'FAILED'),
        ),
      )
    if (updated[0].affectedRows !== 1) {
      throw new GenerationJobError('Retry conflict — try again.')
    }
    await tx.insert(prayerGenerationJobEvents).values({
      generationJobId: jobId,
      fromStatus: 'FAILED',
      toStatus: 'RETRYING',
      eventCode: 'admin_retry',
      attemptNumber: 0,
    })
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'generation_job.retried',
    entityType: 'prayer_generation_job',
    entityId: String(jobId),
    metadata: { from: 'FAILED', to: 'RETRYING' },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Staff queries ----------------------------------------------------------

export async function listGenerationJobs() {
  return getDb()
    .select({
      job: prayerGenerationJobs,
      appointmentPublicId: appointments.publicId,
      serviceName: services.name,
      houseName: sacredHouses.name,
    })
    .from(prayerGenerationJobs)
    .innerJoin(
      appointments,
      eq(prayerGenerationJobs.appointmentId, appointments.id),
    )
    .innerJoin(
      services,
      eq(prayerGenerationJobs.serviceIdSnapshot, services.id),
    )
    .innerJoin(
      sacredHouses,
      eq(prayerGenerationJobs.sacredHouseIdSnapshot, sacredHouses.id),
    )
    .orderBy(sql`${prayerGenerationJobs.id} DESC`)
    .limit(200)
}

export async function getGenerationJobDetail(jobId: number) {
  const row = (
    await getDb()
      .select({
        job: prayerGenerationJobs,
        appointmentPublicId: appointments.publicId,
        serviceName: services.name,
        houseName: sacredHouses.name,
      })
      .from(prayerGenerationJobs)
      .innerJoin(
        appointments,
        eq(prayerGenerationJobs.appointmentId, appointments.id),
      )
      .innerJoin(
        services,
        eq(prayerGenerationJobs.serviceIdSnapshot, services.id),
      )
      .innerJoin(
        sacredHouses,
        eq(prayerGenerationJobs.sacredHouseIdSnapshot, sacredHouses.id),
      )
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
  ).at(0)
  if (!row) throw new GenerationJobError('Generation job not found.')
  const events = await getDb()
    .select()
    .from(prayerGenerationJobEvents)
    .where(eq(prayerGenerationJobEvents.generationJobId, jobId))
    .orderBy(asc(prayerGenerationJobEvents.id))
    .limit(200)
  const snapshots = await getDb()
    .select({
      id: prayerGenerationRecipeSnapshots.id,
      snapshotNumber: prayerGenerationRecipeSnapshots.snapshotNumber,
      payloadSha256: prayerGenerationRecipeSnapshots.payloadSha256,
      recipeSha256: prayerGenerationRecipeSnapshots.recipeSha256,
      templateVersionId: prayerGenerationRecipeSnapshots.templateVersionId,
      createdAt: prayerGenerationRecipeSnapshots.createdAt,
    })
    .from(prayerGenerationRecipeSnapshots)
    .where(eq(prayerGenerationRecipeSnapshots.generationJobId, jobId))
    .orderBy(asc(prayerGenerationRecipeSnapshots.snapshotNumber))
  // Step 13 planning metadata — safe hashes/counts only (never sacred
  // text, storage keys, consent references or future provider prompts).
  const storyboards = await getDb()
    .select({
      id: prayerGenerationStoryboardSnapshots.id,
      snapshotNumber: prayerGenerationStoryboardSnapshots.snapshotNumber,
      storyboardSha256: prayerGenerationStoryboardSnapshots.storyboardSha256,
      payloadSha256: prayerGenerationStoryboardSnapshots.payloadSha256,
      sceneCount: prayerGenerationStoryboardSnapshots.sceneCount,
      totalDurationMs: prayerGenerationStoryboardSnapshots.totalDurationMs,
      createdAt: prayerGenerationStoryboardSnapshots.createdAt,
    })
    .from(prayerGenerationStoryboardSnapshots)
    .where(eq(prayerGenerationStoryboardSnapshots.generationJobId, jobId))
    .orderBy(asc(prayerGenerationStoryboardSnapshots.snapshotNumber))
  const manifests = await getDb()
    .select({
      id: prayerGenerationManifestSnapshots.id,
      snapshotNumber: prayerGenerationManifestSnapshots.snapshotNumber,
      manifestSha256: prayerGenerationManifestSnapshots.manifestSha256,
      payloadSha256: prayerGenerationManifestSnapshots.payloadSha256,
      visualTaskCount: prayerGenerationManifestSnapshots.visualTaskCount,
      audioRequirementCount:
        prayerGenerationManifestSnapshots.audioRequirementCount,
      createdAt: prayerGenerationManifestSnapshots.createdAt,
    })
    .from(prayerGenerationManifestSnapshots)
    .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
    .orderBy(asc(prayerGenerationManifestSnapshots.snapshotNumber))
  // Scene/audio mode tallies come from the verified storyboard payload
  // (fail-closed loader), never from re-planning.
  // Lazily imported: Step 13 depends on this module, so a static
  // import here would create a cycle.
  const { loadGenerationStoryboardSnapshot } =
    await import('./generation-storyboards')
  const loadedStoryboard = await loadGenerationStoryboardSnapshot(jobId)
  const sceneModes: Record<string, number> = {}
  const audioModes: Record<string, number> = {}
  if (loadedStoryboard.status === 'OK') {
    for (const scene of loadedStoryboard.storyboard.scenes) {
      sceneModes[scene.sourceMode] = (sceneModes[scene.sourceMode] ?? 0) + 1
      audioModes[scene.audio.mode] = (audioModes[scene.audio.mode] ?? 0) + 1
    }
  }
  return {
    ...row,
    events,
    snapshots,
    storyboards,
    manifests,
    storyboardIntegrity: loadedStoryboard.status,
    sceneModes,
    audioModes,
  }
}
