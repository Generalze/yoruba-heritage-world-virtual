import { and, desc, eq, gt, gte, lt, lte, or, sql } from 'drizzle-orm'

import { getDb } from '@/db'
import type { DbClient } from '@/db'
import {
  appointmentRepresentatives,
  appointments,
  sacredHouseAvailability,
  sacredHouseAvailabilityExceptions,
  sacredHouseBookingSettings,
  sacredHouseMembers,
  sacredHouses,
  services,
  userProfiles,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import { canUserBookSpiritualService } from './profile'
import {
  addDays,
  daysBetween,
  isoDayOfWeek,
  localToUtcMs,
  minutesToTime,
  sqlToUtcMs,
  timeToMinutes,
  utcMsToLocal,
  utcMsToSql,
} from '@/lib/schedule-time'
import {
  getOrCreateBookingSettings,
  lockHouseScheduling,
  mergeIntervals,
  subtractInterval,
} from './scheduling'
import { assignGuidanceForAppointmentUnderTx } from './guidance'
import { enqueuePrayerGenerationUnderTx } from './generation-jobs'
import type { GuidanceAssignmentSummary } from './guidance'
import type { MinuteInterval } from './scheduling'
import type { RequestContext } from '@/auth/service'
import type { AssignmentRole } from '@/db/schema'

/**
 * Appointment domain (Phase One, Step 5).
 *
 * Locked rules:
 * - the scheduling resource is the SACRED HOUSE (one concurrent
 *   appointment); members are never bookable and never affect capacity
 * - the House is derived server-side from the selected service
 * - every House-interval allocation (reserve + reschedule) locks the
 *   House's booking-settings row (SELECT … FOR UPDATE) before the
 *   overlap check — the single concurrency discipline
 * - a PENDING_PAYMENT row blocks only while its reservation hold is
 *   unexpired (lazy expiration; no worker or Redis required)
 * - no public path can CONFIRM an appointment; the future payment
 *   layer calls confirmReservation() after verified payment
 * - commercial facts are snapshotted at reservation time
 */

export class AppointmentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppointmentError'
  }
}

const MAX_SLOT_RANGE_DAYS = 31
const BLOCKING = (nowSql: string) =>
  or(
    eq(appointments.status, 'CONFIRMED'),
    and(
      eq(appointments.status, 'PENDING_PAYMENT'),
      gt(appointments.reservationExpiresAt, nowSql),
    ),
  )

// --- Bookable service -------------------------------------------------------

export interface BookableService {
  serviceId: number
  serviceName: string
  serviceCode: string
  sacredHouseId: number
  houseName: string
  durationMinutes: number
  priceMinor: number
  currency: string
}

/**
 * A service participates in booking only when it and its House are
 * PUBLISHED + active AND duration/price/currency are explicitly
 * configured. Nothing is defaulted — a missing price is missing, not 0.
 */
export async function loadBookableService(
  serviceId: number,
  db: DbClient = getDb(),
): Promise<BookableService> {
  const row = (
    await db
      .select({ service: services, house: sacredHouses })
      .from(services)
      .innerJoin(sacredHouses, eq(services.sacredHouseId, sacredHouses.id))
      .where(eq(services.id, serviceId))
      .limit(1)
  ).at(0)
  if (!row) throw new AppointmentError('Service not found.')

  const { service, house } = row
  if (service.serviceStatus !== 'PUBLISHED' || !service.active) {
    throw new AppointmentError('This service is not open for booking.')
  }
  if (house.status !== 'PUBLISHED' || !house.active) {
    throw new AppointmentError('This service is not open for booking.')
  }
  if (
    service.durationMinutes == null ||
    service.durationMinutes <= 0 ||
    service.priceMinor == null ||
    service.currency == null ||
    !/^[A-Z]{3}$/.test(service.currency)
  ) {
    throw new AppointmentError(
      'This service is not yet configured for booking.',
    )
  }
  return {
    serviceId: service.id,
    serviceName: service.name,
    serviceCode: service.code,
    sacredHouseId: house.id,
    houseName: house.name,
    durationMinutes: service.durationMinutes,
    priceMinor: service.priceMinor,
    currency: service.currency,
  }
}

// --- Slot engine ------------------------------------------------------------

export interface AvailableSlot {
  startsAtUtc: string
  endsAtUtc: string
  houseLocalDate: string
  houseLocalTime: string
}

interface HouseScheduleConfig {
  settings: Awaited<ReturnType<typeof getOrCreateBookingSettings>>
  windows: Array<{
    dayOfWeek: number
    startLocalTime: string
    endLocalTime: string
  }>
  exceptions: Array<{
    localDate: string
    type: 'CLOSED' | 'BLOCK' | 'OPEN'
    startLocalTime: string | null
    endLocalTime: string | null
  }>
}

/**
 * Plain schedule-config reads against the given client. When called
 * with a transaction that already holds the House scheduling lock,
 * this reads the CURRENT serialized state (the locking read opens the
 * transaction, so later reads see the latest committed data).
 */
async function readScheduleConfig(
  houseId: number,
  db: DbClient,
): Promise<HouseScheduleConfig> {
  const settings = (
    await db
      .select()
      .from(sacredHouseBookingSettings)
      .where(eq(sacredHouseBookingSettings.sacredHouseId, houseId))
      .limit(1)
  ).at(0)
  if (!settings) {
    throw new AppointmentError('Sacred House scheduling is not initialized.')
  }
  const windows = await db
    .select({
      dayOfWeek: sacredHouseAvailability.dayOfWeek,
      startLocalTime: sacredHouseAvailability.startLocalTime,
      endLocalTime: sacredHouseAvailability.endLocalTime,
    })
    .from(sacredHouseAvailability)
    .where(
      and(
        eq(sacredHouseAvailability.sacredHouseId, houseId),
        eq(sacredHouseAvailability.active, true),
      ),
    )
  const exceptions = await db
    .select({
      localDate: sacredHouseAvailabilityExceptions.localDate,
      type: sacredHouseAvailabilityExceptions.type,
      startLocalTime: sacredHouseAvailabilityExceptions.startLocalTime,
      endLocalTime: sacredHouseAvailabilityExceptions.endLocalTime,
    })
    .from(sacredHouseAvailabilityExceptions)
    .where(eq(sacredHouseAvailabilityExceptions.sacredHouseId, houseId))
  return { settings, windows, exceptions }
}

async function loadScheduleConfig(
  houseId: number,
): Promise<HouseScheduleConfig> {
  await getOrCreateBookingSettings(houseId)
  return readScheduleConfig(houseId, getDb())
}

/** Open minute-intervals for one House-local date after exceptions. */
export function openIntervalsForDate(
  config: HouseScheduleConfig,
  localDate: string,
): Array<MinuteInterval> {
  const dayExceptions = config.exceptions.filter(
    (e) => e.localDate === localDate,
  )
  if (dayExceptions.some((e) => e.type === 'CLOSED')) return []

  const day = isoDayOfWeek(localDate)
  let intervals: Array<MinuteInterval> = config.windows
    .filter((w) => w.dayOfWeek === day)
    .map((w) => ({
      start: timeToMinutes(w.startLocalTime),
      end: timeToMinutes(w.endLocalTime),
    }))

  for (const exception of dayExceptions) {
    if (exception.type === 'OPEN') {
      intervals.push({
        start: timeToMinutes(exception.startLocalTime!),
        end: timeToMinutes(exception.endLocalTime!),
      })
    }
  }
  intervals = mergeIntervals(intervals)
  for (const exception of dayExceptions) {
    if (exception.type === 'BLOCK') {
      intervals = subtractInterval(intervals, {
        start: timeToMinutes(exception.startLocalTime!),
        end: timeToMinutes(exception.endLocalTime!),
      })
    }
  }
  return intervals
}

/**
 * Structural candidate slots (windows, exceptions, alignment, full
 * duration fit, lead time, advance limit) — before existing-appointment
 * filtering. Deterministic given `nowMs`.
 */
async function structuralSlots(
  bookable: BookableService,
  config: HouseScheduleConfig,
  fromDate: string,
  toDate: string,
  nowMs: number,
): Promise<Array<AvailableSlot>> {
  const { settings } = config
  const tz = settings.schedulingTimezone
  if (!settings.bookingEnabled) return []

  if (daysBetween(fromDate, toDate) < 0) {
    throw new AppointmentError('Invalid date range.')
  }
  if (daysBetween(fromDate, toDate) + 1 > MAX_SLOT_RANGE_DAYS) {
    throw new AppointmentError(
      `Availability can be requested for at most ${MAX_SLOT_RANGE_DAYS} days.`,
    )
  }

  const earliestStartMs = nowMs + settings.minimumLeadMinutes * 60_000
  const latestStartMs = nowMs + settings.maximumAdvanceDays * 86_400_000

  const slots: Array<AvailableSlot> = []
  for (
    let date = fromDate;
    daysBetween(date, toDate) >= 0;
    date = addDays(date, 1)
  ) {
    for (const interval of openIntervalsForDate(config, date)) {
      for (
        let startMin = interval.start;
        startMin + bookable.durationMinutes <= interval.end;
        startMin += settings.slotIncrementMinutes
      ) {
        const startMs = localToUtcMs(tz, date, minutesToTime(startMin))
        if (startMs < earliestStartMs || startMs > latestStartMs) continue
        const endMs = startMs + bookable.durationMinutes * 60_000
        slots.push({
          startsAtUtc: utcMsToSql(startMs),
          endsAtUtc: utcMsToSql(endMs),
          houseLocalDate: date,
          houseLocalTime: minutesToTime(startMin),
        })
      }
    }
  }
  return slots
}

/** Structural slots minus intervals taken by blocking appointments. */
export async function computeAvailableSlots(
  serviceId: number,
  fromDate: string,
  toDate: string,
  nowMs: number = Date.now(),
): Promise<Array<AvailableSlot>> {
  const bookable = await loadBookableService(serviceId)
  const config = await loadScheduleConfig(bookable.sacredHouseId)
  const candidates = await structuralSlots(
    bookable,
    config,
    fromDate,
    toDate,
    nowMs,
  )
  if (candidates.length === 0) return []

  const nowSql = utcMsToSql(nowMs)
  const rangeStart = candidates[0].startsAtUtc
  const rangeEnd = candidates[candidates.length - 1].endsAtUtc
  const blocking = await getDb()
    .select({
      startsAtUtc: appointments.startsAtUtc,
      endsAtUtc: appointments.endsAtUtc,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.sacredHouseId, bookable.sacredHouseId),
        lt(appointments.startsAtUtc, rangeEnd),
        gt(appointments.endsAtUtc, rangeStart),
        BLOCKING(nowSql),
      ),
    )

  return candidates.filter(
    (slot) =>
      !blocking.some(
        (b) => b.startsAtUtc < slot.endsAtUtc && b.endsAtUtc > slot.startsAtUtc,
      ),
  )
}

// --- Reservation ------------------------------------------------------------

export interface CreatedReservation {
  appointmentId: number
  publicId: string
  startsAtUtc: string
  endsAtUtc: string
  reservationExpiresAt: string
}

/**
 * Creates a PENDING_PAYMENT reservation for the acting user. Requires
 * Step 4 booking eligibility (active account, complete profile,
 * consents, 18+ in the user's timezone). The requested start must be a
 * structurally valid slot; the overlap check and insert happen under
 * the House lock.
 */
export async function createReservation(
  userId: number,
  ctx: RequestContext,
  input: {
    serviceId: number
    startsAtUtc: string
    privateRequestNote?: string | null
  },
  nowMs: number = Date.now(),
): Promise<CreatedReservation> {
  const eligibility = await canUserBookSpiritualService(userId)
  if (!eligibility.eligible) {
    throw new AppointmentError(
      'Your profile is not yet eligible for booking a spiritual service.',
    )
  }

  // Fast-fail pre-checks; everything structural is re-validated
  // authoritatively under the House lock below.
  const preBookable = await loadBookableService(input.serviceId)
  await getOrCreateBookingSettings(preBookable.sacredHouseId)

  const startMs = sqlToUtcMs(input.startsAtUtc)
  if (Number.isNaN(startMs)) throw new AppointmentError('Invalid start time.')
  const requestedStartSql = utcMsToSql(startMs)
  const nowSql = utcMsToSql(nowMs)

  // Snapshot the user's timezone at reservation time. Eligibility just
  // validated one exists; if a concurrent profile change removed it,
  // FAIL CLOSED — never silently snapshot UTC.
  const profileRow = (
    await getDb()
      .select({ timezone: userProfiles.timezone })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1)
  ).at(0)
  if (!profileRow?.timezone) {
    throw new AppointmentError(
      'Your profile timezone is missing. Update your profile and try again.',
    )
  }
  const userTimezone = profileRow.timezone

  const publicId = crypto.randomUUID()
  const note = input.privateRequestNote?.trim() || null
  if (note && note.length > 1500) {
    throw new AppointmentError('The request note is too long.')
  }

  const { appointmentId, endSql, expiresSql } = await getDb().transaction(
    async (tx) => {
      // House concurrency lock: serializes interval allocation AND
      // schedule-configuration changes for this House.
      await lockHouseScheduling(tx, preBookable.sacredHouseId)

      // Authoritative revalidation under the lock: bookability,
      // booking_enabled, availability windows, exceptions, lead/advance
      // limits and slot alignment against CURRENT serialized state.
      const bookable = await loadBookableService(input.serviceId, tx)
      const config = await readScheduleConfig(bookable.sacredHouseId, tx)
      const tz = config.settings.schedulingTimezone
      const local = utcMsToLocal(tz, startMs)
      const candidates = await structuralSlots(
        bookable,
        config,
        local.date,
        local.date,
        nowMs,
      )
      if (!candidates.some((slot) => slot.startsAtUtc === requestedStartSql)) {
        throw new AppointmentError('That time is not available.')
      }
      const end = utcMsToSql(startMs + bookable.durationMinutes * 60_000)
      const holdExpiresSql = utcMsToSql(
        nowMs + config.settings.reservationHoldMinutes * 60_000,
      )

      const conflicts = await tx
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.sacredHouseId, bookable.sacredHouseId),
            lt(appointments.startsAtUtc, end),
            gt(appointments.endsAtUtc, requestedStartSql),
            BLOCKING(nowSql),
          ),
        )
        .limit(1)
      if (conflicts.length > 0) {
        throw new AppointmentError('That time has just been taken.')
      }
      const inserted = await tx.insert(appointments).values({
        publicId,
        userId,
        serviceId: bookable.serviceId,
        sacredHouseId: bookable.sacredHouseId,
        status: 'PENDING_PAYMENT',
        startsAtUtc: requestedStartSql,
        endsAtUtc: end,
        userTimezone,
        houseTimezone: tz,
        reservationExpiresAt: holdExpiresSql,
        serviceNameSnapshot: bookable.serviceName,
        serviceCodeSnapshot: bookable.serviceCode,
        houseNameSnapshot: bookable.houseName,
        durationMinutesSnapshot: bookable.durationMinutes,
        priceMinorSnapshot: bookable.priceMinor,
        currencySnapshot: bookable.currency,
        privateRequestNote: note,
      })
      return {
        appointmentId: inserted[0].insertId,
        endSql: end,
        expiresSql: holdExpiresSql,
      }
    },
  )

  await recordAuditEvent({
    actorUserId: userId,
    action: 'appointment.reserved',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: {
      publicId,
      sacredHouseId: preBookable.sacredHouseId,
      serviceId: preBookable.serviceId,
      startsAtUtc: requestedStartSql,
      endsAtUtc: endSql,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })

  return {
    appointmentId,
    publicId,
    startsAtUtc: requestedStartSql,
    endsAtUtc: endSql,
    reservationExpiresAt: expiresSql,
  }
}

// --- Lifecycle --------------------------------------------------------------

async function loadAppointment(id: number) {
  const row = (
    await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, id))
      .limit(1)
  ).at(0)
  if (!row) throw new AppointmentError('Appointment not found.')
  return row
}

/**
 * THE single authoritative confirmation implementation (Step 5 + Step 6
 * share it — there are deliberately no diverging copies of these
 * invariants). Caller contract:
 *
 * - MUST already hold the House scheduling lock for the appointment's
 *   Sacred House (lockHouseScheduling as the transaction's first lock)
 * - MUST pass a fresh in-lock clock (never a pre-lock timestamp)
 *
 * Enforces: PENDING_PAYMENT requirement, live (unexpired) reservation,
 * defensive overlap protection, and the guarded CONFIRMED transition —
 * the CAS re-requires status + unexpired hold so a concurrent
 * transition yields zero affected rows and a refusal.
 *
 * Step 7: after the guarded transition succeeds, the appointment's
 * spiritual guidance selection runs in this SAME transaction (exactly
 * once, idempotent via the guidance-set primary key). Every trusted
 * confirmation caller therefore gets the frozen-guidance invariant; a
 * genuine failure while writing the guidance set rolls back the
 * confirmation itself — never a half-confirmed state.
 */
export async function confirmReservationUnderLock(
  tx: DbClient,
  appointmentId: number,
  inLockNowSql: string,
): Promise<GuidanceAssignmentSummary> {
  const row = (
    await tx
      .select()
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1)
      .for('update')
  ).at(0)
  if (!row) throw new AppointmentError('Appointment not found.')
  if (row.status !== 'PENDING_PAYMENT') {
    throw new AppointmentError('Only pending reservations can be confirmed.')
  }
  if (!row.reservationExpiresAt || row.reservationExpiresAt <= inLockNowSql) {
    throw new AppointmentError('This reservation has expired.')
  }
  // Defensive overlap re-check: an unexpired hold's interval cannot
  // have been reallocated, so a conflict here means invariants broke
  // upstream — refuse rather than double-book.
  const conflicts = await tx
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.sacredHouseId, row.sacredHouseId),
        lt(appointments.startsAtUtc, row.endsAtUtc),
        gt(appointments.endsAtUtc, row.startsAtUtc),
        BLOCKING(inLockNowSql),
        sql`${appointments.id} != ${appointmentId}`,
      ),
    )
    .limit(1)
  if (conflicts.length > 0) {
    throw new AppointmentError(
      'This reservation can no longer be confirmed — its time has been reallocated.',
    )
  }
  const result = await tx
    .update(appointments)
    .set({ status: 'CONFIRMED', reservationExpiresAt: null })
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.status, 'PENDING_PAYMENT'),
        gt(appointments.reservationExpiresAt, inLockNowSql),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new AppointmentError('Only pending reservations can be confirmed.')
  }
  const guidance = await assignGuidanceForAppointmentUnderTx(tx, appointmentId)
  // Step 12: atomically enqueue the prayer generation job in the SAME
  // transaction (lightweight row insert only — recipe building, media
  // hashing and any provider work happen asynchronously in the DB
  // worker). A genuine failure here rolls back the confirmation,
  // preserving the all-or-nothing invariant; the UNIQUE appointment_id
  // makes payment/webhook replays incapable of a second job.
  await enqueuePrayerGenerationUnderTx(tx, appointmentId)
  return guidance
}

/**
 * The payment layer's settlement transaction (Step 6) and this trusted
 * wrapper are the ONLY callers of confirmReservationUnderLock. It is
 * never exposed through any public server function — no user or admin
 * action can confirm an appointment directly.
 *
 * Confirmation solidifies the interval as a blocking appointment, so
 * it participates in the SAME per-House lock discipline as reservation
 * allocation: lock the House, re-read the appointment under the lock,
 * and only then transition. A hold whose expiry has passed can never
 * confirm — its interval may already have been reallocated to someone
 * else, and confirming it would create two confirmed overlaps.
 */
export async function confirmReservation(
  appointmentId: number,
  ctx: RequestContext,
  nowMs: number = Date.now(),
): Promise<void> {
  // Pre-read only to learn the House for lock ordering; authoritative
  // state is re-read under the lock — never the stale object.
  const preRead = await loadAppointment(appointmentId)
  await getOrCreateBookingSettings(preRead.sacredHouseId)

  const guidance = await getDb().transaction(async (tx) => {
    await lockHouseScheduling(tx, preRead.sacredHouseId)
    // Re-sample the clock AFTER acquiring the lock: pre-lock latency
    // (pool waits, lock queues) must never make an already-expired
    // hold look live. The caller-injected nowMs can only tighten the
    // check (max), never loosen it.
    const inLockNowSql = utcMsToSql(Math.max(nowMs, Date.now()))
    return confirmReservationUnderLock(tx, appointmentId, inLockNowSql)
  })

  await recordAuditEvent({
    actorUserId: null,
    action: 'appointment.confirmed',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: { from: 'PENDING_PAYMENT', to: 'CONFIRMED' },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  if (!guidance.alreadyExisted) {
    await recordAuditEvent({
      actorUserId: null,
      action: 'appointment.guidance_assigned',
      entityType: 'appointment',
      entityId: String(appointmentId),
      metadata: {
        selectionResult: guidance.selectionResult,
        assignmentCount: guidance.assignmentCount,
        contentVersionIds: guidance.contentVersionIds.slice(0, 50),
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  }
}

/**
 * Marks stale PENDING_PAYMENT rows EXPIRED (lazy cleanup helper). The
 * UPDATE itself is a guarded compare-and-set re-requiring the
 * stale-pending condition, so a row that meanwhile became CONFIRMED
 * (or reached any other state) is never overwritten. Audits only rows
 * that actually transitioned.
 */
export async function expireStaleReservations(
  nowMs: number = Date.now(),
): Promise<number> {
  const nowSql = utcMsToSql(nowMs)
  const stale = await getDb()
    .select({ id: appointments.id })
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'PENDING_PAYMENT'),
        lte(appointments.reservationExpiresAt, nowSql),
      ),
    )
  let expired = 0
  for (const candidate of stale) {
    const result = await getDb()
      .update(appointments)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          eq(appointments.id, candidate.id),
          eq(appointments.status, 'PENDING_PAYMENT'),
          lte(appointments.reservationExpiresAt, nowSql),
        ),
      )
    if (result[0].affectedRows === 1) {
      expired += 1
      await recordAuditEvent({
        actorUserId: null,
        action: 'appointment.expired',
        entityType: 'appointment',
        entityId: String(candidate.id),
        metadata: { from: 'PENDING_PAYMENT', to: 'EXPIRED' },
      })
    }
  }
  return expired
}

export interface CancelActor {
  userId: number
  isOperator: boolean
}

export async function cancelAppointment(
  actor: CancelActor,
  ctx: RequestContext,
  appointmentId: number,
  reason: string | null,
  nowMs: number = Date.now(),
): Promise<void> {
  const row = await loadAppointment(appointmentId)

  if (actor.isOperator) {
    await requirePermission(actor.userId, 'appointments.manage')
    if (!reason?.trim()) {
      throw new AppointmentError(
        'An operational cancellation requires a reason.',
      )
    }
  } else if (row.userId !== actor.userId) {
    throw new AppointmentError('Appointment not found.')
  }

  if (row.status !== 'PENDING_PAYMENT' && row.status !== 'CONFIRMED') {
    throw new AppointmentError('This appointment can no longer be cancelled.')
  }

  if (!actor.isOperator && row.status === 'CONFIRMED') {
    const settings = await getOrCreateBookingSettings(row.sacredHouseId)
    const cutoffMs =
      sqlToUtcMs(row.startsAtUtc) - settings.cancellationCutoffMinutes * 60_000
    if (nowMs > cutoffMs) {
      throw new AppointmentError(
        'This appointment is too close to its start time to cancel online. Please contact support.',
      )
    }
  }

  // Atomic compare-and-set pinned to the exact validated basis
  // (status AND start time): if a concurrent transition or reschedule
  // intervened after the read above, zero rows match and the
  // cancellation is refused instead of overwriting the newer state.
  const result = await getDb()
    .update(appointments)
    .set({
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledByUserId: actor.userId,
      cancellationReason: reason?.trim().slice(0, 500) || null,
    })
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.status, row.status),
        eq(appointments.startsAtUtc, row.startsAtUtc),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new AppointmentError(
      'This appointment changed while cancelling. Please refresh and try again.',
    )
  }

  await recordAuditEvent({
    actorUserId: actor.userId,
    action: 'appointment.cancelled',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: {
      from: row.status,
      to: 'CANCELLED',
      operator: actor.isOperator,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/**
 * Reschedules a CONFIRMED appointment. The authoritative appointment
 * state, ownership, cutoff, destination validity and reschedule_count
 * are all re-read and validated UNDER the House lock — a stale
 * pre-lock read can never modify a record that meanwhile became
 * CANCELLED/COMPLETED/NO_SHOW.
 *
 * Admin override applies to the reschedule CUTOFF only. Admin does NOT
 * bypass booking_enabled, availability windows, exceptions, alignment,
 * duration fit, minimum lead or maximum advance — structural
 * validation always uses the real `nowMs`.
 */
export async function rescheduleAppointment(
  actor: CancelActor,
  ctx: RequestContext,
  appointmentId: number,
  newStartsAtUtc: string,
  nowMs: number = Date.now(),
): Promise<void> {
  // Pre-read only for lock ordering (House id); authoritative state is
  // re-read under the lock.
  const preRead = await loadAppointment(appointmentId)
  if (actor.isOperator) {
    await requirePermission(actor.userId, 'appointments.manage')
  }
  await getOrCreateBookingSettings(preRead.sacredHouseId)

  const startMs = sqlToUtcMs(newStartsAtUtc)
  if (Number.isNaN(startMs)) throw new AppointmentError('Invalid start time.')
  const newStartSql = utcMsToSql(startMs)
  const nowSql = utcMsToSql(nowMs)

  const audit = await getDb().transaction(async (tx) => {
    await lockHouseScheduling(tx, preRead.sacredHouseId)

    const row = (
      await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!row) throw new AppointmentError('Appointment not found.')
    if (!actor.isOperator && row.userId !== actor.userId) {
      throw new AppointmentError('Appointment not found.')
    }
    if (row.status !== 'CONFIRMED') {
      throw new AppointmentError(
        'Only confirmed appointments can be rescheduled. Release and rebook a pending reservation instead.',
      )
    }

    const config = await readScheduleConfig(row.sacredHouseId, tx)
    if (!actor.isOperator) {
      const cutoffMs =
        sqlToUtcMs(row.startsAtUtc) -
        config.settings.rescheduleCutoffMinutes * 60_000
      if (nowMs > cutoffMs) {
        throw new AppointmentError(
          'This appointment is too close to its start time to reschedule online. Please contact support.',
        )
      }
    }

    // Destination validity uses the BOOKED duration snapshot and the
    // real clock — no admin lead/advance bypass.
    const bookable = await loadBookableService(row.serviceId, tx)
    const local = utcMsToLocal(config.settings.schedulingTimezone, startMs)
    const candidates = await structuralSlots(
      { ...bookable, durationMinutes: row.durationMinutesSnapshot },
      config,
      local.date,
      local.date,
      nowMs,
    )
    if (!candidates.some((slot) => slot.startsAtUtc === newStartSql)) {
      throw new AppointmentError('That time is not available.')
    }
    const newEndSql = utcMsToSql(startMs + row.durationMinutesSnapshot * 60_000)

    const conflicts = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.sacredHouseId, row.sacredHouseId),
          lt(appointments.startsAtUtc, newEndSql),
          gt(appointments.endsAtUtc, newStartSql),
          BLOCKING(nowSql),
          sql`${appointments.id} != ${appointmentId}`,
        ),
      )
      .limit(1)
    if (conflicts.length > 0) {
      throw new AppointmentError('That time has just been taken.')
    }

    const result = await tx
      .update(appointments)
      .set({
        startsAtUtc: newStartSql,
        endsAtUtc: newEndSql,
        rescheduleCount: row.rescheduleCount + 1,
      })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.status, 'CONFIRMED'),
        ),
      )
    if (result[0].affectedRows !== 1) {
      throw new AppointmentError(
        'This appointment changed while rescheduling. Please retry.',
      )
    }
    return {
      oldStartsAtUtc: row.startsAtUtc,
      rescheduleCount: row.rescheduleCount + 1,
    }
  })

  await recordAuditEvent({
    actorUserId: actor.userId,
    action: 'appointment.rescheduled',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: {
      oldStartsAtUtc: audit.oldStartsAtUtc,
      newStartsAtUtc: newStartSql,
      operator: actor.isOperator,
      rescheduleCount: audit.rescheduleCount,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function completeAppointment(
  actorId: number,
  ctx: RequestContext,
  appointmentId: number,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')
  const row = await loadAppointment(appointmentId)
  if (row.status !== 'CONFIRMED') {
    throw new AppointmentError('Only confirmed appointments can be completed.')
  }
  // Atomic compare-and-set pinned to the validated basis (status AND
  // start time, matching cancelAppointment): cannot overwrite a
  // simultaneous CANCELLED/NO_SHOW, and cannot land on an occurrence a
  // concurrent reschedule just moved.
  const result = await getDb()
    .update(appointments)
    .set({ status: 'COMPLETED', completedAt: new Date() })
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.status, 'CONFIRMED'),
        eq(appointments.startsAtUtc, row.startsAtUtc),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new AppointmentError('Only confirmed appointments can be completed.')
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'appointment.completed',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: { from: 'CONFIRMED', to: 'COMPLETED' },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function markNoShow(
  actorId: number,
  ctx: RequestContext,
  appointmentId: number,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')
  const row = await loadAppointment(appointmentId)
  if (row.status !== 'CONFIRMED') {
    throw new AppointmentError(
      'Only confirmed appointments can be marked as no-show.',
    )
  }
  // Atomic compare-and-set pinned to the validated basis (status AND
  // start time): COMPLETED and NO_SHOW can never overwrite each other,
  // and the transition never lands on a concurrently-moved occurrence.
  const result = await getDb()
    .update(appointments)
    .set({ status: 'NO_SHOW', noShowAt: new Date() })
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.status, 'CONFIRMED'),
        eq(appointments.startsAtUtc, row.startsAtUtc),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new AppointmentError(
      'Only confirmed appointments can be marked as no-show.',
    )
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'appointment.no_show',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: { from: 'CONFIRMED', to: 'NO_SHOW' },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Representatives --------------------------------------------------------

/**
 * Assigns a representative. The appointment row (SELECT … FOR UPDATE)
 * is the serialization resource for representative changes: the
 * CONFIRMED requirement, member validity and the one-PRIMARY rule are
 * all re-checked under that lock, so two concurrent PRIMARY
 * assignments can never both succeed, and an assignment can never land
 * on an appointment that just became terminal.
 */
export async function assignRepresentative(
  actorId: number,
  ctx: RequestContext,
  appointmentId: number,
  memberId: number,
  role: AssignmentRole,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')

  await getDb().transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!row) throw new AppointmentError('Appointment not found.')
    if (row.status !== 'CONFIRMED') {
      throw new AppointmentError(
        'Representatives are assigned to confirmed appointments only.',
      )
    }
    const member = (
      await tx
        .select()
        .from(sacredHouseMembers)
        .where(eq(sacredHouseMembers.id, memberId))
        .limit(1)
    ).at(0)
    if (!member) throw new AppointmentError('Member not found.')
    if (member.sacredHouseId !== row.sacredHouseId) {
      throw new AppointmentError(
        "Members can only serve their own Sacred House's appointments.",
      )
    }
    if (!member.active) {
      throw new AppointmentError('This member is not active.')
    }
    if (role === 'PRIMARY') {
      // Re-checked under the appointment lock; re-assigning the same
      // member as PRIMARY stays an idempotent update.
      const existingPrimary = await tx
        .select({ memberId: appointmentRepresentatives.sacredHouseMemberId })
        .from(appointmentRepresentatives)
        .where(
          and(
            eq(appointmentRepresentatives.appointmentId, appointmentId),
            eq(appointmentRepresentatives.assignmentRole, 'PRIMARY'),
          ),
        )
        .limit(1)
      if (
        existingPrimary.length > 0 &&
        existingPrimary[0].memberId !== memberId
      ) {
        throw new AppointmentError(
          'This appointment already has a primary representative.',
        )
      }
    }
    await tx
      .insert(appointmentRepresentatives)
      .values({
        appointmentId,
        sacredHouseMemberId: memberId,
        assignmentRole: role,
        assignedBy: actorId,
      })
      .onDuplicateKeyUpdate({ set: { assignmentRole: role } })
  })

  await recordAuditEvent({
    actorUserId: actorId,
    action: 'appointment.representative_assigned',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: { memberId, role },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/**
 * Removes a representative. Allowed only while the appointment is
 * CONFIRMED (re-checked under the appointment row lock): terminal
 * historical appointments keep their assignment record stable.
 */
export async function removeRepresentative(
  actorId: number,
  ctx: RequestContext,
  appointmentId: number,
  memberId: number,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')

  const removed = await getDb().transaction(async (tx) => {
    const row = (
      await tx
        .select({ status: appointments.status })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!row) throw new AppointmentError('Appointment not found.')
    if (row.status !== 'CONFIRMED') {
      throw new AppointmentError(
        'Representatives can only be changed while the appointment is confirmed.',
      )
    }
    const result = await tx
      .delete(appointmentRepresentatives)
      .where(
        and(
          eq(appointmentRepresentatives.appointmentId, appointmentId),
          eq(appointmentRepresentatives.sacredHouseMemberId, memberId),
        ),
      )
    return result[0].affectedRows > 0
  })

  if (removed) {
    await recordAuditEvent({
      actorUserId: actorId,
      action: 'appointment.representative_removed',
      entityType: 'appointment',
      entityId: String(appointmentId),
      metadata: { memberId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  }
}

// --- Reads ------------------------------------------------------------------

/** Admin list with filters. Requires appointments.view. */
export async function listAppointmentsAdmin(
  actorId: number,
  filters: {
    status?: (typeof appointments.status.enumValues)[number]
    sacredHouseId?: number
    fromDate?: string
    toDate?: string
  },
) {
  await requirePermission(actorId, 'appointments.view')
  const conditions = []
  if (filters.status) conditions.push(eq(appointments.status, filters.status))
  if (filters.sacredHouseId) {
    conditions.push(eq(appointments.sacredHouseId, filters.sacredHouseId))
  }
  if (filters.fromDate) {
    conditions.push(
      gte(appointments.startsAtUtc, `${filters.fromDate} 00:00:00`),
    )
  }
  if (filters.toDate) {
    conditions.push(lte(appointments.startsAtUtc, `${filters.toDate} 23:59:59`))
  }
  return getDb()
    .select()
    .from(appointments)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(appointments.startsAtUtc))
    .limit(200)
}

export async function getAppointmentAdmin(actorId: number, id: number) {
  await requirePermission(actorId, 'appointments.view')
  const row = (
    await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, id))
      .limit(1)
  ).at(0)
  if (!row) return null
  const representatives = await getDb()
    .select({
      memberId: appointmentRepresentatives.sacredHouseMemberId,
      role: appointmentRepresentatives.assignmentRole,
      displayName: sacredHouseMembers.displayName,
      memberType: sacredHouseMembers.memberType,
    })
    .from(appointmentRepresentatives)
    .innerJoin(
      sacredHouseMembers,
      eq(appointmentRepresentatives.sacredHouseMemberId, sacredHouseMembers.id),
    )
    .where(eq(appointmentRepresentatives.appointmentId, id))
  const houseMembers = await getDb()
    .select()
    .from(sacredHouseMembers)
    .where(
      and(
        eq(sacredHouseMembers.sacredHouseId, row.sacredHouseId),
        eq(sacredHouseMembers.active, true),
      ),
    )
  return { ...row, representatives, houseMembers }
}

/**
 * Ownership primitive for future user pages: only the acting user's
 * appointments, never addressed by sequential id from clients —
 * user-facing references use public_id.
 */
export async function getUserAppointments(userId: number) {
  return getDb()
    .select({
      publicId: appointments.publicId,
      status: appointments.status,
      startsAtUtc: appointments.startsAtUtc,
      endsAtUtc: appointments.endsAtUtc,
      userTimezone: appointments.userTimezone,
      serviceNameSnapshot: appointments.serviceNameSnapshot,
      houseNameSnapshot: appointments.houseNameSnapshot,
      priceMinorSnapshot: appointments.priceMinorSnapshot,
      currencySnapshot: appointments.currencySnapshot,
      reservationExpiresAt: appointments.reservationExpiresAt,
    })
    .from(appointments)
    .where(eq(appointments.userId, userId))
    .orderBy(desc(appointments.startsAtUtc))
}

export async function getUserAppointmentByPublicId(
  userId: number,
  publicId: string,
) {
  const row = (
    await getDb()
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.publicId, publicId),
          eq(appointments.userId, userId),
        ),
      )
      .limit(1)
  ).at(0)
  return row ?? null
}
