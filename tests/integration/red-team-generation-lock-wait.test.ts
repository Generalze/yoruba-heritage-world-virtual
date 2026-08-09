import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  appointmentGuidanceAssignments,
  appointmentGuidanceSets,
  appointments,
  auditLogs,
  prayerGenerationJobEvents,
  prayerGenerationJobs,
  prayerGenerationRecipeSnapshots,
  sacredHouseAvailability,
  sacredHouseBookingSettings,
  sacredHouses,
  services,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { assignRoleToUser } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import { acceptRequiredConsents, savePersonalDetails } from '@/services/profile'
import {
  addAvailabilityWindow,
  getOrCreateBookingSettings,
  updateBookingSettings,
} from '@/services/scheduling'
import { confirmReservation, createReservation } from '@/services/appointments'
import {
  LocalMediaStorageProvider,
  resetMediaStorageForTests,
  setMediaStorageForTests,
} from '@/providers/media/storage'
import {
  claimNextGenerationJob,
  recoverExpiredGenerationLeases,
  scheduleRetryOrFail,
} from '@/services/generation-jobs'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type { GenerationJobStatus } from '@/db/schema'

/**
 * RED-TEAM regression suite (adversarial), covering contract items 5-7
 * assigned to CHARLIE — LOCK-WAIT LEASE AUTHORITY for the CLAIM, RETRY
 * and EXPIRED-LEASE-RECOVERY paths, mirroring the existing "lock-wait
 * lease authority" coverage in tests/integration/generation-jobs.test.ts
 * for renewGenerationLease / transitionGenerationJobUnderLease /
 * persistPreparedRecipeUnderLease (which this file does NOT duplicate
 * or modify — this is a NEW file only).
 *
 * All three targeted functions (claimNextGenerationJob, scheduleRetryOrFail,
 * recoverExpiredGenerationLeases) now take a GenerationClock, confirmed
 * against landed production code — no signature assumptions remain.
 *
 * Item 5 (claim) deliberately does NOT use real row-lock contention:
 * claimDueJob's candidate SELECT uses `.for('update', { skipLocked: true })`,
 * so holding an external lock on the sole candidate row makes it get
 * SKIPPED (the call returns null instantly) rather than blocked-then-
 * granted — verified empirically, accepted by Team Lead as the correct
 * read of the contract. That test instead uses a sequenced GenerationClock
 * stub to deterministically prove the granted lease derives from the
 * SECOND clock.now() reading (post-candidate-check `freshNow`) and never
 * the FIRST (`screeningNow`, WHERE-filter only) — the same property, a
 * different (and here, the only viable) verification mechanism. Items 6
 * and 7 use genuine external row-lock contention (runDuringLockWait
 * below) because their underlying queries do NOT skip-lock.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `redteam lockwait test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'

let adminId: number
let houseId: number
let serviceId: number
let storageRoot: string
let storage: LocalMediaStorageProvider

const today = currentLocalDate(HOUSE_TZ, Date.now())
let slotCursor = 0
function nextSlot(): string {
  const hours = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00']
  const index = slotCursor++
  const date = addDays(today, 2 + Math.floor(index / hours.length))
  return utcMsToSql(localToUtcMs(HOUSE_TZ, date, hours[index % hours.length]))
}

async function makeUser(role?: 'ADMIN'): Promise<number> {
  const result = await registerUser(
    {
      email: `rtb-${crypto.randomUUID()}@test.local`,
      preferredName: 'RTB Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role) await assignRoleToUser(result.user.id, role)
  return result.user.id
}

async function makeEligibleUser(): Promise<number> {
  const id = await makeUser()
  await savePersonalDetails(
    id,
    {
      fullName: 'Adéwálé Olúṣọlá Adébáyọ̀',
      preferredName: 'Adéwálé',
      phone: '+2348012345678',
      countryCode: 'NG',
      timezone: 'Africa/Lagos',
      preferredLanguage: 'en',
      dateOfBirth: '1990-03-21',
    },
    ctx,
  )
  await acceptRequiredConsents(id, ctx)
  return id
}

async function jobForAppointment(appointmentId: number) {
  return (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.appointmentId, appointmentId))
  ).at(0)
}

/** Cancels other live jobs so a claim/recovery pass targets exactly the
 * job under test. */
async function quiesceOtherJobs(exceptJobId: number): Promise<void> {
  const db = getDb()
  const apptRows = await db
    .select({ id: appointments.id })
    .from(appointments)
    .where(eq(appointments.sacredHouseId, houseId))
  const apptIds = apptRows.map((row) => row.id)
  if (apptIds.length === 0) return
  const live = await db
    .select({ id: prayerGenerationJobs.id })
    .from(prayerGenerationJobs)
    .where(inArray(prayerGenerationJobs.appointmentId, apptIds))
  for (const row of live) {
    if (row.id === exceptJobId) continue
    await db
      .update(prayerGenerationJobs)
      .set({ status: 'CANCELLED', leaseToken: null, leaseExpiresAt: null })
      .where(eq(prayerGenerationJobs.id, row.id))
  }
}

async function reserveAndConfirm(
  userId: number,
): Promise<{ appointmentId: number }> {
  const reservation = await createReservation(userId, ctx, {
    serviceId,
    startsAtUtc: nextSlot(),
  })
  await confirmReservation(reservation.appointmentId, ctx)
  return { appointmentId: reservation.appointmentId }
}

function makeFakeClock(startMs: number) {
  let t = startMs
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms
    },
  }
}

/** A clock whose now() returns each `readings` value once, in order,
 * then repeats the last one. Used to deterministically prove WHICH of
 * several clock.now() calls a function's persisted output derives
 * from, independent of real DB lock-wait timing. */
function makeSequencedClock(readings: Array<Date>) {
  let index = 0
  return {
    now: () => {
      const value = readings[Math.min(index, readings.length - 1)]
      index += 1
      return value
    },
  }
}

/** Arms a job row directly into `status` with a live lease for
 * `leaseToken`, bypassing the real claim/preparation flow — these tests
 * exercise lock-wait timing, not recipe building. */
async function armLease(
  jobId: number,
  leaseToken: string,
  clockNow: Date,
  status: GenerationJobStatus,
  leaseExpiresAt: Date,
): Promise<void> {
  await getDb()
    .update(prayerGenerationJobs)
    .set({
      status,
      leaseToken,
      leaseOwner: 'lockwait-worker',
      leaseAcquiredAt: clockNow,
      leaseExpiresAt,
    })
    .where(eq(prayerGenerationJobs.id, jobId))
}

/**
 * Holds an exclusive row lock on the job, starts a lease-sensitive
 * operation (which — under a correct implementation — blocks on that
 * lock), advances the fake clock past whatever timing boundary matters
 * WHILE it waits, then releases the lock. The operation's authoritative
 * time must be read AFTER it acquires the lock. Mirrors the identically
 * named helper already proven out in
 * tests/integration/generation-jobs.test.ts (not imported from there —
 * this is a fresh, self-contained copy in a NEW file).
 */
async function runDuringLockWait<T>(
  jobId: number,
  start: () => Promise<T>,
  whileWaiting: () => void,
): Promise<T> {
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let signalLocked: (() => void) | undefined
  const lockAcquired = new Promise<void>((resolve) => {
    signalLocked = resolve
  })
  const blocker = getDb().transaction(async (tx) => {
    await tx
      .select({ id: prayerGenerationJobs.id })
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
      .for('update')
    signalLocked?.()
    await held
  })
  await lockAcquired
  const pending = start()
  // Give the operation time to reach the row lock, then perturb the
  // clock while it is still (or should still be) waiting.
  await new Promise((resolve) => setTimeout(resolve, 200))
  whileWaiting()
  release?.()
  await blocker
  return pending
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-redteam-lockwait-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()

  adminId = await makeUser('ADMIN')

  const db = getDb()
  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `RTBH_${key}`.toUpperCase(),
    name: `RTB House ${key}`,
    slug: `rtbh-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  const svcInsert = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `RTBS_${key}`.toUpperCase(),
    name: `RTB Service ${key}`,
    slug: `rtbs-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  serviceId = svcInsert[0].insertId

  await getOrCreateBookingSettings(houseId)
  await updateBookingSettings(adminId, ctx, houseId, {
    schedulingTimezone: HOUSE_TZ,
    bookingEnabled: true,
    slotIncrementMinutes: 30,
    minimumLeadMinutes: 1440,
    maximumAdvanceDays: 90,
    reservationHoldMinutes: 15,
    cancellationCutoffMinutes: 1440,
    rescheduleCutoffMinutes: 1440,
  })
  for (let day = 1; day <= 7; day++) {
    await addAvailabilityWindow(adminId, ctx, houseId, {
      dayOfWeek: day,
      startLocalTime: '09:00',
      endLocalTime: '17:00',
    })
  }
})

afterAll(async () => {
  const db = getDb()
  if (houseId) {
    const apptRows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.sacredHouseId, houseId))
    const apptIds = apptRows.map((row) => row.id)
    if (apptIds.length > 0) {
      const jobs = await db
        .select({ id: prayerGenerationJobs.id })
        .from(prayerGenerationJobs)
        .where(inArray(prayerGenerationJobs.appointmentId, apptIds))
      const jobIds = jobs.map((row) => row.id)
      if (jobIds.length > 0) {
        await db
          .delete(prayerGenerationJobEvents)
          .where(inArray(prayerGenerationJobEvents.generationJobId, jobIds))
        await db
          .delete(prayerGenerationRecipeSnapshots)
          .where(
            inArray(prayerGenerationRecipeSnapshots.generationJobId, jobIds),
          )
        await db
          .delete(prayerGenerationJobs)
          .where(inArray(prayerGenerationJobs.id, jobIds))
      }
      await db
        .delete(appointmentGuidanceAssignments)
        .where(inArray(appointmentGuidanceAssignments.appointmentId, apptIds))
      await db
        .delete(appointmentGuidanceSets)
        .where(inArray(appointmentGuidanceSets.appointmentId, apptIds))
      await db.delete(appointments).where(inArray(appointments.id, apptIds))
    }
    await db
      .delete(sacredHouseAvailability)
      .where(eq(sacredHouseAvailability.sacredHouseId, houseId))
    await db
      .delete(sacredHouseBookingSettings)
      .where(eq(sacredHouseBookingSettings.sacredHouseId, houseId))
    await db.delete(services).where(eq(services.sacredHouseId, houseId))
    await db.delete(sacredHouses).where(eq(sacredHouses.id, houseId))
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  resetMediaStorageForTests()
  try {
    rmSync(storageRoot, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
  await closeDb()
})

// ----------------------------------------------------------------------------
// Item 5: CLAIM row-lock wait
// ----------------------------------------------------------------------------

describe('red-team: claim row-lock wait uses post-lock time', () => {
  it('a granted lease derives from the SECOND (post-lock) clock reading, never the first (screening) one', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    expect(job.status).toBe('QUEUED')

    // NOTE on method (see report to Team Lead): claimDueJob's candidate
    // SELECT uses `.for('update', { skipLocked: true })`. Holding an
    // external lock on the sole candidate row (the technique items 6
    // and 7 below use, and the one this test originally used) does NOT
    // make the claim block-then-grant — SKIP LOCKED makes it skip that
    // row instantly and return null, so a genuine external-row-lock
    // test cannot observe "granted after the lock released" for THIS
    // function. Verified empirically: it does. Production code already
    // implements the intended contract via a two-phase read instead —
    // `screeningNow = clock.now()` selects candidates, then (only once
    // a not-currently-locked candidate is found) `freshNow = clock.now()`
    // is what actually gets persisted as leaseAcquiredAt/leaseExpiresAt
    // and re-validated against. A sequenced clock proves that directly
    // and deterministically, without depending on real lock timing.
    const screeningTime = new Date()
    const postLockTime = new Date(screeningTime.getTime() + 5 * 60_000)
    const clock = makeSequencedClock([screeningTime, postLockTime])
    const claimed = await claimNextGenerationJob('rtb-claim-seq', clock)
    expect(claimed?.job.id).toBe(job.id)
    if (!claimed) return
    // NOTE: claimed.job itself is the PRE-update row read (only its
    // leaseToken field is overridden), so its leaseAcquiredAt is stale
    // and unreliable for this assertion — nothing downstream reads it
    // either (every later lease check re-queries the row fresh under
    // its own lock). Re-querying the persisted row is the correct way
    // to observe what was actually written.
    const persisted = (await jobForAppointment(appointmentId))!
    const leaseAcquiredMs = new Date(persisted.leaseAcquiredAt!).getTime()
    // TEETH: must be the SECOND reading, never the first (allowing only
    // sub-second tolerance for the DATETIME column's storage precision
    // — the two readings are 5 minutes apart, so this cannot mask a
    // real pre-lock/post-lock mixup).
    expect(Math.abs(leaseAcquiredMs - postLockTime.getTime())).toBeLessThanOrEqual(
      1_000,
    )
    expect(Math.abs(leaseAcquiredMs - screeningTime.getTime())).toBeGreaterThan(
      60_000,
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 6: RETRY row-lock wait (testable against current, real code —
// scheduleRetryOrFail already takes a GenerationClock)
// ----------------------------------------------------------------------------

describe('red-team: retry row-lock wait uses post-lock time', () => {
  it('nextAttemptAt is computed from the time AFTER the row lock is acquired, not before', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    const clock = makeFakeClock(Date.now())
    const leaseToken = crypto.randomUUID()
    // Lease must stay LIVE across the clock advance below — this test
    // is about which time is used to compute the backoff, not about
    // the (already separately covered) case of a lease that itself
    // expires during the wait.
    await armLease(
      job.id,
      leaseToken,
      clock.now(),
      'PREPARING',
      new Date(clock.now().getTime() + 30 * 60_000),
    )

    const preLockTime = clock.now()
    let postLockTime: Date = preLockTime
    const outcome = await runDuringLockWait(
      job.id,
      () =>
        scheduleRetryOrFail(
          job,
          leaseToken,
          clock,
          'SYNTHETIC_LOCKWAIT_ERROR',
          'synthetic red-team error',
          'PREPARING',
        ),
      () => {
        clock.advance(5 * 60_000)
        postLockTime = clock.now()
      },
    )
    expect(outcome).toBe('RETRYING')
    const after = (await jobForAppointment(appointmentId))!
    expect(after.status).toBe('RETRYING')
    expect(after.nextAttemptAt).not.toBeNull()
    const nextAttemptMs = new Date(after.nextAttemptAt!).getTime()
    const delayMs = 60_000 // attemptCount 0 -> RETRY_SCHEDULE_MINUTES[0] = 1 minute

    // TEETH: must reflect the POST-lock reading (pre-lock + 5min
    // advance + delay), never a pre-lock instant (pre-lock + delay).
    expect(nextAttemptMs).toBeGreaterThanOrEqual(
      postLockTime.getTime() + delayMs - 2_000,
    )
    expect(nextAttemptMs).toBeGreaterThan(
      preLockTime.getTime() + delayMs + 2 * 60_000,
    )
  }, 240_000)
})

// ----------------------------------------------------------------------------
// Item 7: EXPIRED-LEASE RECOVERY row-lock wait
// ----------------------------------------------------------------------------

describe('red-team: expired-lease recovery lock wait uses post-lock time', () => {
  it('recovery backoff reflects the time AFTER the row lock is acquired, not before', async () => {
    const userId = await makeEligibleUser()
    const { appointmentId } = await reserveAndConfirm(userId)
    const job = (await jobForAppointment(appointmentId))!
    await quiesceOtherJobs(job.id)
    const clock = makeFakeClock(Date.now())
    const leaseToken = crypto.randomUUID()
    // Arm an ALREADY-EXPIRED PREPARING lease so it is immediately due
    // for recovery the moment the sweep runs.
    await armLease(
      job.id,
      leaseToken,
      clock.now(),
      'PREPARING',
      new Date(clock.now().getTime() - 60_000),
    )

    const preLockTime = clock.now()
    let postLockTime: Date = preLockTime
    // recoverExpiredGenerationLeases takes a GenerationClock and re-reads
    // authoritative time per-row AFTER each row lock is acquired — this
    // exercises that real, landed behavior directly.
    const recovered = await runDuringLockWait(
      job.id,
      () => recoverExpiredGenerationLeases(clock),
      () => {
        clock.advance(5 * 60_000)
        postLockTime = clock.now()
      },
    )
    expect(recovered).toBeGreaterThanOrEqual(1)
    const after = (await jobForAppointment(appointmentId))!
    expect(after.status).toBe('RETRYING')
    expect(after.nextAttemptAt).not.toBeNull()
    const nextAttemptMs = new Date(after.nextAttemptAt!).getTime()
    const delayMs = 60_000 // attemptCount 0 -> RETRY_SCHEDULE_MINUTES[0] = 1 minute

    // TEETH: must reflect the POST-lock reading, never the pre-lock one.
    expect(nextAttemptMs).toBeGreaterThanOrEqual(
      postLockTime.getTime() + delayMs - 2_000,
    )
    expect(nextAttemptMs).toBeGreaterThan(
      preLockTime.getTime() + delayMs + 2 * 60_000,
    )
  }, 240_000)
})
