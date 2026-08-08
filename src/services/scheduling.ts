import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import type { DbClient } from '@/db'
import {
  sacredHouseAvailability,
  sacredHouseAvailabilityExceptions,
  sacredHouseBookingSettings,
  sacredHouses,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import { isValidTimeZone, timeToMinutes } from '@/lib/schedule-time'
import type { RequestContext } from '@/auth/service'

/**
 * Sacred House scheduling configuration (Step 5): booking settings,
 * weekly availability windows and date exceptions. Operational config
 * only — never part of the cultural approval workflow. ADMIN /
 * SUPER_ADMIN (availability.manage) only; CONTENT_MANAGER has no
 * scheduling authority. Working hours are never seeded or invented.
 */

export class SchedulingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchedulingError'
  }
}

// --- Validation -------------------------------------------------------------

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24-hour).')

export const bookingSettingsSchema = z.object({
  schedulingTimezone: z
    .string()
    .refine(isValidTimeZone, 'Enter a valid IANA timezone.'),
  bookingEnabled: z.boolean(),
  slotIncrementMinutes: z.number().int().min(5).max(240),
  minimumLeadMinutes: z.number().int().min(0).max(43200),
  maximumAdvanceDays: z.number().int().min(1).max(365),
  reservationHoldMinutes: z.number().int().min(5).max(120),
  cancellationCutoffMinutes: z.number().int().min(0).max(20160),
  rescheduleCutoffMinutes: z.number().int().min(0).max(20160),
})

export type BookingSettingsInput = z.infer<typeof bookingSettingsSchema>

export const availabilityWindowSchema = z
  .object({
    dayOfWeek: z.number().int().min(1).max(7),
    startLocalTime: timeSchema,
    endLocalTime: timeSchema,
  })
  .refine(
    (w) => timeToMinutes(w.startLocalTime) < timeToMinutes(w.endLocalTime),
    'Window start must be before its end.',
  )

export const exceptionSchema = z
  .object({
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.enum(['CLOSED', 'BLOCK', 'OPEN']),
    startLocalTime: timeSchema.nullable().optional(),
    endLocalTime: timeSchema.nullable().optional(),
    label: z.string().trim().max(200).optional(),
  })
  .refine((e) => {
    if (e.type === 'CLOSED') return true
    return (
      e.startLocalTime != null &&
      e.endLocalTime != null &&
      timeToMinutes(e.startLocalTime) < timeToMinutes(e.endLocalTime)
    )
  }, 'BLOCK and OPEN exceptions need a valid start/end interval.')

// --- Interval helpers (pure, unit-tested) -----------------------------------

export interface MinuteInterval {
  start: number
  end: number
}

export function mergeIntervals(
  intervals: Array<MinuteInterval>,
): Array<MinuteInterval> {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  const merged: Array<MinuteInterval> = []
  for (const interval of sorted) {
    const last = merged.at(-1)
    if (last && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end)
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

export function subtractInterval(
  intervals: Array<MinuteInterval>,
  block: MinuteInterval,
): Array<MinuteInterval> {
  const result: Array<MinuteInterval> = []
  for (const interval of intervals) {
    if (block.end <= interval.start || block.start >= interval.end) {
      result.push(interval)
      continue
    }
    if (block.start > interval.start) {
      result.push({ start: interval.start, end: block.start })
    }
    if (block.end < interval.end) {
      result.push({ start: block.end, end: interval.end })
    }
  }
  return result
}

// --- Settings ---------------------------------------------------------------

async function assertHouseExists(houseId: number): Promise<void> {
  const row = (
    await getDb()
      .select({ id: sacredHouses.id })
      .from(sacredHouses)
      .where(eq(sacredHouses.id, houseId))
      .limit(1)
  ).at(0)
  if (!row) throw new SchedulingError('Sacred House not found.')
}

/** Creates the settings row with locked safe defaults if absent. */
export async function getOrCreateBookingSettings(houseId: number) {
  await assertHouseExists(houseId)
  const db = getDb()
  const existing = (
    await db
      .select()
      .from(sacredHouseBookingSettings)
      .where(eq(sacredHouseBookingSettings.sacredHouseId, houseId))
      .limit(1)
  ).at(0)
  if (existing) return existing
  await db
    .insert(sacredHouseBookingSettings)
    .values({ sacredHouseId: houseId })
    .onDuplicateKeyUpdate({ set: { sacredHouseId: houseId } })
  return (
    await db
      .select()
      .from(sacredHouseBookingSettings)
      .where(eq(sacredHouseBookingSettings.sacredHouseId, houseId))
      .limit(1)
  ).at(0)!
}

/**
 * THE House scheduling lock. Every mutation of a House's scheduling
 * state (settings, windows, exceptions) and every interval allocation
 * (reserve, reschedule, confirm) acquires this row with
 * SELECT … FOR UPDATE as the FIRST statement of its transaction —
 * one serialization discipline for everything scheduling-related.
 * Callers must ensure the settings row exists (getOrCreateBookingSettings)
 * before locking, because FOR UPDATE on a missing row locks nothing.
 */
export async function lockHouseScheduling(
  tx: DbClient,
  houseId: number,
): Promise<void> {
  const rows = await tx
    .select({ id: sacredHouseBookingSettings.sacredHouseId })
    .from(sacredHouseBookingSettings)
    .where(eq(sacredHouseBookingSettings.sacredHouseId, houseId))
    .for('update')
  if (rows.length === 0) {
    throw new SchedulingError('Sacred House scheduling is not initialized.')
  }
}

export async function updateBookingSettings(
  actorId: number,
  ctx: RequestContext,
  houseId: number,
  input: BookingSettingsInput,
): Promise<void> {
  await requirePermission(actorId, 'availability.manage')
  await getOrCreateBookingSettings(houseId)
  await getDb().transaction(async (tx) => {
    await lockHouseScheduling(tx, houseId)
    await tx
      .update(sacredHouseBookingSettings)
      .set(input)
      .where(eq(sacredHouseBookingSettings.sacredHouseId, houseId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'availability.settings_updated',
    entityType: 'sacred_house',
    entityId: String(houseId),
    metadata: {
      bookingEnabled: input.bookingEnabled,
      schedulingTimezone: input.schedulingTimezone,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Weekly windows ---------------------------------------------------------

async function assertNoWindowOverlap(
  db: DbClient,
  houseId: number,
  dayOfWeek: number,
  start: string,
  end: string,
  ignoreId?: number,
): Promise<void> {
  const rows = await db
    .select()
    .from(sacredHouseAvailability)
    .where(
      and(
        eq(sacredHouseAvailability.sacredHouseId, houseId),
        eq(sacredHouseAvailability.dayOfWeek, dayOfWeek),
        eq(sacredHouseAvailability.active, true),
      ),
    )
  const startMin = timeToMinutes(start)
  const endMin = timeToMinutes(end)
  for (const row of rows) {
    if (ignoreId !== undefined && row.id === ignoreId) continue
    if (
      startMin < timeToMinutes(row.endLocalTime) &&
      endMin > timeToMinutes(row.startLocalTime)
    ) {
      throw new SchedulingError(
        'This window overlaps an existing active window for that day.',
      )
    }
  }
}

export async function addAvailabilityWindow(
  actorId: number,
  ctx: RequestContext,
  houseId: number,
  input: z.infer<typeof availabilityWindowSchema>,
): Promise<number> {
  await requirePermission(actorId, 'availability.manage')
  await getOrCreateBookingSettings(houseId)
  // Overlap check and insert run under the House scheduling lock so
  // two concurrent admins cannot both observe the old state and create
  // overlapping active windows.
  const id = await getDb().transaction(async (tx) => {
    await lockHouseScheduling(tx, houseId)
    await assertNoWindowOverlap(
      tx,
      houseId,
      input.dayOfWeek,
      input.startLocalTime,
      input.endLocalTime,
    )
    const result = await tx.insert(sacredHouseAvailability).values({
      sacredHouseId: houseId,
      dayOfWeek: input.dayOfWeek,
      startLocalTime: input.startLocalTime + ':00',
      endLocalTime: input.endLocalTime + ':00',
    })
    return result[0].insertId
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'availability.window_created',
    entityType: 'sacred_house',
    entityId: String(houseId),
    metadata: {
      windowId: id,
      dayOfWeek: input.dayOfWeek,
      start: input.startLocalTime,
      end: input.endLocalTime,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return id
}

export async function setAvailabilityWindowActive(
  actorId: number,
  ctx: RequestContext,
  windowId: number,
  active: boolean,
): Promise<void> {
  await requirePermission(actorId, 'availability.manage')
  const preRead = (
    await getDb()
      .select()
      .from(sacredHouseAvailability)
      .where(eq(sacredHouseAvailability.id, windowId))
      .limit(1)
  ).at(0)
  if (!preRead) throw new SchedulingError('Availability window not found.')
  await getOrCreateBookingSettings(preRead.sacredHouseId)

  const row = await getDb().transaction(async (tx) => {
    await lockHouseScheduling(tx, preRead.sacredHouseId)
    const current = (
      await tx
        .select()
        .from(sacredHouseAvailability)
        .where(eq(sacredHouseAvailability.id, windowId))
        .limit(1)
    ).at(0)
    if (!current) throw new SchedulingError('Availability window not found.')
    if (active) {
      await assertNoWindowOverlap(
        tx,
        current.sacredHouseId,
        current.dayOfWeek,
        current.startLocalTime,
        current.endLocalTime,
        current.id,
      )
    }
    await tx
      .update(sacredHouseAvailability)
      .set({ active })
      .where(eq(sacredHouseAvailability.id, windowId))
    return current
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: active
      ? 'availability.window_updated'
      : 'availability.window_removed',
    entityType: 'sacred_house',
    entityId: String(row.sacredHouseId),
    metadata: { windowId, active },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Exceptions -------------------------------------------------------------

export async function addAvailabilityException(
  actorId: number,
  ctx: RequestContext,
  houseId: number,
  input: z.infer<typeof exceptionSchema>,
): Promise<number> {
  await requirePermission(actorId, 'availability.manage')
  await getOrCreateBookingSettings(houseId)
  const id = await getDb().transaction(async (tx) => {
    await lockHouseScheduling(tx, houseId)
    const result = await tx.insert(sacredHouseAvailabilityExceptions).values({
      sacredHouseId: houseId,
      localDate: input.localDate,
      type: input.type,
      startLocalTime:
        input.type === 'CLOSED' ? null : `${input.startLocalTime}:00`,
      endLocalTime: input.type === 'CLOSED' ? null : `${input.endLocalTime}:00`,
      label: input.label || null,
    })
    return result[0].insertId
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'availability.exception_created',
    entityType: 'sacred_house',
    entityId: String(houseId),
    metadata: { exceptionId: id, localDate: input.localDate, type: input.type },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return id
}

export async function removeAvailabilityException(
  actorId: number,
  ctx: RequestContext,
  exceptionId: number,
): Promise<void> {
  await requirePermission(actorId, 'availability.manage')
  const row = (
    await getDb()
      .select()
      .from(sacredHouseAvailabilityExceptions)
      .where(eq(sacredHouseAvailabilityExceptions.id, exceptionId))
      .limit(1)
  ).at(0)
  if (!row) throw new SchedulingError('Exception not found.')
  await getOrCreateBookingSettings(row.sacredHouseId)
  await getDb().transaction(async (tx) => {
    await lockHouseScheduling(tx, row.sacredHouseId)
    await tx
      .delete(sacredHouseAvailabilityExceptions)
      .where(eq(sacredHouseAvailabilityExceptions.id, exceptionId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'availability.exception_removed',
    entityType: 'sacred_house',
    entityId: String(row.sacredHouseId),
    metadata: { exceptionId, localDate: row.localDate, type: row.type },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Reads for admin UI -----------------------------------------------------

export async function getSchedulingOverview(actorId: number, houseId: number) {
  await requirePermission(actorId, 'availability.manage')
  const settings = await getOrCreateBookingSettings(houseId)
  const windows = await getDb()
    .select()
    .from(sacredHouseAvailability)
    .where(eq(sacredHouseAvailability.sacredHouseId, houseId))
    .orderBy(
      sacredHouseAvailability.dayOfWeek,
      sacredHouseAvailability.startLocalTime,
    )
  const exceptions = await getDb()
    .select()
    .from(sacredHouseAvailabilityExceptions)
    .where(eq(sacredHouseAvailabilityExceptions.sacredHouseId, houseId))
    .orderBy(sacredHouseAvailabilityExceptions.localDate)
  return { settings, windows, exceptions }
}
