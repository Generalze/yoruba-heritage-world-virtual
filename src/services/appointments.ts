import { and, desc, eq, gt, gte, inArray, lt, lte, or, sql } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  appointmentRepresentatives,
  appointments,
  sacredHouseAvailability,
  sacredHouseAvailabilityExceptions,
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
  mergeIntervals,
  subtractInterval,
} from './scheduling'
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
): Promise<BookableService> {
  const row = (
    await getDb()
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

async function loadScheduleConfig(
  houseId: number,
): Promise<HouseScheduleConfig> {
  const settings = await getOrCreateBookingSettings(houseId)
  const windows = await getDb()
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
  const exceptions = await getDb()
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

  const bookable = await loadBookableService(input.serviceId)
  const config = await loadScheduleConfig(bookable.sacredHouseId)
  const tz = config.settings.schedulingTimezone

  const startMs = sqlToUtcMs(input.startsAtUtc)
  if (Number.isNaN(startMs)) throw new AppointmentError('Invalid start time.')
  const local = utcMsToLocal(tz, startMs)
  const candidates = await structuralSlots(
    bookable,
    config,
    local.date,
    local.date,
    nowMs,
  )
  const requestedStartSql = utcMsToSql(startMs)
  if (!candidates.some((slot) => slot.startsAtUtc === requestedStartSql)) {
    throw new AppointmentError('That time is not available.')
  }
  const endSql = utcMsToSql(startMs + bookable.durationMinutes * 60_000)
  const nowSql = utcMsToSql(nowMs)
  const expiresSql = utcMsToSql(
    nowMs + config.settings.reservationHoldMinutes * 60_000,
  )

  // Snapshot the user's timezone at reservation time. Eligibility
  // guarantees a stored timezone exists; 'UTC' is a defensive fallback.
  const profileRow = (
    await getDb()
      .select({ timezone: userProfiles.timezone })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1)
  ).at(0)
  const userTimezone = profileRow?.timezone ?? 'UTC'

  const publicId = crypto.randomUUID()
  const note = input.privateRequestNote?.trim() || null
  if (note && note.length > 1500) {
    throw new AppointmentError('The request note is too long.')
  }

  const appointmentId = await getDb().transaction(async (tx) => {
    // House concurrency lock: serializes all interval allocation.
    await tx.execute(
      sql`SELECT sacred_house_id FROM sacred_house_booking_settings WHERE sacred_house_id = ${bookable.sacredHouseId} FOR UPDATE`,
    )
    const conflicts = await tx
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.sacredHouseId, bookable.sacredHouseId),
          lt(appointments.startsAtUtc, endSql),
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
      endsAtUtc: endSql,
      userTimezone,
      houseTimezone: tz,
      reservationExpiresAt: expiresSql,
      serviceNameSnapshot: bookable.serviceName,
      serviceCodeSnapshot: bookable.serviceCode,
      houseNameSnapshot: bookable.houseName,
      durationMinutesSnapshot: bookable.durationMinutes,
      priceMinorSnapshot: bookable.priceMinor,
      currencySnapshot: bookable.currency,
      privateRequestNote: note,
    })
    return inserted[0].insertId
  })

  await recordAuditEvent({
    actorUserId: userId,
    action: 'appointment.reserved',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: {
      publicId,
      sacredHouseId: bookable.sacredHouseId,
      serviceId: bookable.serviceId,
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
 * Future payment layer calls this after VERIFIED payment. It is never
 * exposed through any public server function — no user or admin action
 * can confirm an appointment in Step 5.
 */
export async function confirmReservation(
  appointmentId: number,
  ctx: RequestContext,
  nowMs: number = Date.now(),
): Promise<void> {
  const row = await loadAppointment(appointmentId)
  if (row.status !== 'PENDING_PAYMENT') {
    throw new AppointmentError('Only pending reservations can be confirmed.')
  }
  if (
    !row.reservationExpiresAt ||
    row.reservationExpiresAt <= utcMsToSql(nowMs)
  ) {
    throw new AppointmentError('This reservation has expired.')
  }
  await getDb()
    .update(appointments)
    .set({ status: 'CONFIRMED', reservationExpiresAt: null })
    .where(eq(appointments.id, appointmentId))
  await recordAuditEvent({
    actorUserId: null,
    action: 'appointment.confirmed',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: { from: 'PENDING_PAYMENT', to: 'CONFIRMED' },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/** Marks stale PENDING_PAYMENT rows EXPIRED (lazy cleanup helper). */
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
  if (stale.length === 0) return 0
  await getDb()
    .update(appointments)
    .set({ status: 'EXPIRED' })
    .where(
      inArray(
        appointments.id,
        stale.map((row) => row.id),
      ),
    )
  for (const row of stale) {
    await recordAuditEvent({
      actorUserId: null,
      action: 'appointment.expired',
      entityType: 'appointment',
      entityId: String(row.id),
      metadata: { from: 'PENDING_PAYMENT', to: 'EXPIRED' },
    })
  }
  return stale.length
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

  await getDb()
    .update(appointments)
    .set({
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledByUserId: actor.userId,
      cancellationReason: reason?.trim().slice(0, 500) || null,
    })
    .where(eq(appointments.id, appointmentId))

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

export async function rescheduleAppointment(
  actor: CancelActor,
  ctx: RequestContext,
  appointmentId: number,
  newStartsAtUtc: string,
  nowMs: number = Date.now(),
): Promise<void> {
  const row = await loadAppointment(appointmentId)

  if (actor.isOperator) {
    await requirePermission(actor.userId, 'appointments.manage')
  } else if (row.userId !== actor.userId) {
    throw new AppointmentError('Appointment not found.')
  }

  if (row.status !== 'CONFIRMED') {
    throw new AppointmentError(
      'Only confirmed appointments can be rescheduled. Release and rebook a pending reservation instead.',
    )
  }

  const settings = await getOrCreateBookingSettings(row.sacredHouseId)
  if (!actor.isOperator) {
    const cutoffMs =
      sqlToUtcMs(row.startsAtUtc) - settings.rescheduleCutoffMinutes * 60_000
    if (nowMs > cutoffMs) {
      throw new AppointmentError(
        'This appointment is too close to its start time to reschedule online. Please contact support.',
      )
    }
  }

  const bookable = await loadBookableService(row.serviceId)
  const config = await loadScheduleConfig(row.sacredHouseId)
  const startMs = sqlToUtcMs(newStartsAtUtc)
  if (Number.isNaN(startMs)) throw new AppointmentError('Invalid start time.')
  const newStartSql = utcMsToSql(startMs)
  const newEndSql = utcMsToSql(startMs + row.durationMinutesSnapshot * 60_000)

  // Users must pick a fully valid structural slot; operators may place
  // inside lead/advance limits but still within open availability.
  const local = utcMsToLocal(config.settings.schedulingTimezone, startMs)
  const candidates = await structuralSlots(
    bookable,
    config,
    local.date,
    local.date,
    actor.isOperator ? startMs - 86_400_000 : nowMs,
  )
  if (!candidates.some((slot) => slot.startsAtUtc === newStartSql)) {
    throw new AppointmentError('That time is not available.')
  }

  const nowSql = utcMsToSql(nowMs)
  await getDb().transaction(async (tx) => {
    await tx.execute(
      sql`SELECT sacred_house_id FROM sacred_house_booking_settings WHERE sacred_house_id = ${row.sacredHouseId} FOR UPDATE`,
    )
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
    await tx
      .update(appointments)
      .set({
        startsAtUtc: newStartSql,
        endsAtUtc: newEndSql,
        rescheduleCount: row.rescheduleCount + 1,
      })
      .where(eq(appointments.id, appointmentId))
  })

  await recordAuditEvent({
    actorUserId: actor.userId,
    action: 'appointment.rescheduled',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: {
      oldStartsAtUtc: row.startsAtUtc,
      newStartsAtUtc: newStartSql,
      operator: actor.isOperator,
      rescheduleCount: row.rescheduleCount + 1,
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
  await getDb()
    .update(appointments)
    .set({ status: 'COMPLETED', completedAt: new Date() })
    .where(eq(appointments.id, appointmentId))
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
  await getDb()
    .update(appointments)
    .set({ status: 'NO_SHOW', noShowAt: new Date() })
    .where(eq(appointments.id, appointmentId))
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

export async function assignRepresentative(
  actorId: number,
  ctx: RequestContext,
  appointmentId: number,
  memberId: number,
  role: AssignmentRole,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')
  const row = await loadAppointment(appointmentId)
  if (row.status !== 'CONFIRMED') {
    throw new AppointmentError(
      'Representatives are assigned to confirmed appointments only.',
    )
  }
  const member = (
    await getDb()
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
    const existingPrimary = await getDb()
      .select({ memberId: appointmentRepresentatives.sacredHouseMemberId })
      .from(appointmentRepresentatives)
      .where(
        and(
          eq(appointmentRepresentatives.appointmentId, appointmentId),
          eq(appointmentRepresentatives.assignmentRole, 'PRIMARY'),
        ),
      )
      .limit(1)
    if (existingPrimary.length > 0) {
      throw new AppointmentError(
        'This appointment already has a primary representative.',
      )
    }
  }
  await getDb()
    .insert(appointmentRepresentatives)
    .values({
      appointmentId,
      sacredHouseMemberId: memberId,
      assignmentRole: role,
      assignedBy: actorId,
    })
    .onDuplicateKeyUpdate({ set: { assignmentRole: role } })
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

export async function removeRepresentative(
  actorId: number,
  ctx: RequestContext,
  appointmentId: number,
  memberId: number,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')
  await getDb()
    .delete(appointmentRepresentatives)
    .where(
      and(
        eq(appointmentRepresentatives.appointmentId, appointmentId),
        eq(appointmentRepresentatives.sacredHouseMemberId, memberId),
      ),
    )
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
