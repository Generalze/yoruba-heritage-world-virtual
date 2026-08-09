import { createHash, randomUUID } from 'node:crypto'

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  GUIDANCE_LANGUAGES,
  appointmentGuidanceSets,
  appointments,
  prayerGenerationJobEvents,
  prayerGenerationJobs,
  prayerGenerationManifestSnapshots,
  prayerGenerationRecipeSnapshots,
  prayerGenerationStoryboardSnapshots,
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
  GENERATING_VISUALS: ['GENERATING_AUDIO', 'RETRYING', 'FAILED', 'CANCELLED'],
  GENERATING_AUDIO: ['RENDERING', 'RETRYING', 'FAILED', 'CANCELLED'],
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
 */
async function claimDueJob(
  workerId: string,
  now: Date,
  leaseMs: number,
  claimable: (jobs: typeof prayerGenerationJobs) => ReturnType<typeof and>,
): Promise<ClaimedJob | null> {
  return getDb().transaction(async (tx) => {
    const candidate = (
      await tx
        .select()
        .from(prayerGenerationJobs)
        .where(
          and(
            claimable(prayerGenerationJobs),
            or(
              isNull(prayerGenerationJobs.nextAttemptAt),
              lte(prayerGenerationJobs.nextAttemptAt, toSqlDate(now)),
            ),
            or(
              isNull(prayerGenerationJobs.leaseExpiresAt),
              lte(prayerGenerationJobs.leaseExpiresAt, toSqlDate(now)),
            ),
          ),
        )
        .orderBy(asc(prayerGenerationJobs.id))
        .limit(1)
        .for('update', { skipLocked: true })
    ).at(0)
    if (!candidate) return null
    const leaseToken = randomUUID()
    const updated = await tx
      .update(prayerGenerationJobs)
      .set({
        leaseToken,
        leaseOwner: workerId.slice(0, 100),
        leaseAcquiredAt: toSqlDate(now),
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
      })
      .where(
        and(
          eq(prayerGenerationJobs.id, candidate.id),
          eq(prayerGenerationJobs.status, candidate.status),
          or(
            isNull(prayerGenerationJobs.leaseExpiresAt),
            lte(prayerGenerationJobs.leaseExpiresAt, toSqlDate(now)),
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
  now: Date,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedJob | null> {
  return claimDueJob(workerId, now, leaseMs, (jobs) =>
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
  now: Date,
  leaseMs: number = DEFAULT_LEASE_MS,
): Promise<ClaimedJob | null> {
  return claimDueJob(workerId, now, leaseMs, (jobs) =>
    or(
      eq(jobs.status, 'STORYBOARDING'),
      and(eq(jobs.status, 'RETRYING'), eq(jobs.resumeStatus, 'STORYBOARDING')),
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

/**
 * Lease-guarded status transition: the transition re-requires the
 * current status AND the caller's live lease token, so a stale worker
 * (lease lost/expired) can never overwrite state. Every transition is
 * checked against the central legal map and recorded as an event.
 *
 * LOCK-WAIT SAFETY: the job row is locked FIRST and the authoritative
 * clock reading taken afterwards — waiting on another transaction's
 * lock can never let an expired lease transition using a pre-lock
 * timestamp.
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
    patch?: Partial<typeof prayerGenerationJobs.$inferInsert>
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
        ...(options.patch ?? {}),
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
 */
export async function recoverExpiredGenerationLeases(
  now: Date,
): Promise<number> {
  const db = getDb()
  const stuck = await db
    .select({ id: prayerGenerationJobs.id })
    .from(prayerGenerationJobs)
    .where(
      and(
        inArray(prayerGenerationJobs.status, LEASED_PROCESSING_STATUSES),
        sql`${prayerGenerationJobs.leaseExpiresAt} <= ${toSqlDate(now)}`,
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
      if (
        !job ||
        !LEASED_PROCESSING_STATUSES.includes(job.status) ||
        job.leaseExpiresAt == null ||
        job.leaseExpiresAt > now
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
            : new Date(now.getTime() + delayMinutes * 60_000),
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
      patch: {
        attemptCount: nextAttempt,
        resumeStatus: stage,
        nextAttemptAt: new Date(clock.now().getTime() + delayMinutes * 60_000),
        lastErrorCode: errorCode,
        lastErrorMessage: errorMessage,
      },
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
  const claimed = await claimNextGenerationJob(workerId, clock.now())
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
