import { createServerFn } from '@tanstack/react-start'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import { APPOINTMENT_STATUSES, sacredHouses } from '@/db/schema'
import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import {
  availabilityWindowSchema,
  addAvailabilityException,
  addAvailabilityWindow,
  bookingSettingsSchema,
  exceptionSchema,
  getOrCreateBookingSettings,
  getSchedulingOverview,
  removeAvailabilityException,
  setAvailabilityWindowActive,
  updateBookingSettings,
} from './scheduling'
import {
  assignRepresentative,
  cancelAppointment,
  completeAppointment,
  computeAvailableSlots,
  expireStaleReservations,
  getAppointmentAdmin,
  listAppointmentsAdmin,
  markNoShow,
  removeRepresentative,
  rescheduleAppointment,
} from './appointments'
import type { SafeUser } from '@/auth/session'

/**
 * Admin scheduling & appointment server functions. Actor always comes
 * from the authenticated session; the domain layer re-checks
 * appointments.* / availability.manage permissions (ADMIN/SUPER_ADMIN
 * only). No payment controls, no refund controls, no confirm action —
 * confirmation belongs to the future verified-payment layer only.
 */

class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required')
    this.name = 'UnauthenticatedError'
  }
}

async function requireActor(): Promise<SafeUser> {
  const user = await getAuthenticatedUser()
  if (!user) throw new UnauthenticatedError()
  return user
}

const idSchema = z.number().int().positive()
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const utcSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'Invalid UTC timestamp.')

// --- Scheduling -------------------------------------------------------------

export const adminListHousesSchedulingFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  const actor = await requireActor()
  await requirePermission(actor.id, 'availability.manage')
  const houses = await getDb()
    .select({ id: sacredHouses.id, name: sacredHouses.name })
    .from(sacredHouses)
    .orderBy(sacredHouses.sortOrder)
  const result = []
  for (const house of houses) {
    const settings = await getOrCreateBookingSettings(house.id)
    result.push({ ...house, settings })
  }
  return result
})

export const adminGetSchedulingFn = createServerFn({ method: 'GET' })
  .validator(z.object({ houseId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const overview = await getSchedulingOverview(actor.id, data.houseId)
    const house = (
      await getDb()
        .select({ id: sacredHouses.id, name: sacredHouses.name })
        .from(sacredHouses)
        .where(eq(sacredHouses.id, data.houseId))
        .limit(1)
    ).at(0)
    return { house, ...overview }
  })

export const adminUpdateBookingSettingsFn = createServerFn({ method: 'POST' })
  .validator(z.object({ houseId: idSchema, settings: bookingSettingsSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateBookingSettings(
      actor.id,
      requestContext(),
      data.houseId,
      data.settings,
    )
    return { ok: true }
  })

export const adminAddWindowFn = createServerFn({ method: 'POST' })
  .validator(z.object({ houseId: idSchema, window: availabilityWindowSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const id = await addAvailabilityWindow(
      actor.id,
      requestContext(),
      data.houseId,
      data.window,
    )
    return { id }
  })

export const adminSetWindowActiveFn = createServerFn({ method: 'POST' })
  .validator(z.object({ windowId: idSchema, active: z.boolean() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setAvailabilityWindowActive(
      actor.id,
      requestContext(),
      data.windowId,
      data.active,
    )
    return { ok: true }
  })

export const adminAddExceptionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ houseId: idSchema, exception: exceptionSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const id = await addAvailabilityException(
      actor.id,
      requestContext(),
      data.houseId,
      data.exception,
    )
    return { id }
  })

export const adminRemoveExceptionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ exceptionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await removeAvailabilityException(
      actor.id,
      requestContext(),
      data.exceptionId,
    )
    return { ok: true }
  })

/** Admin slot preview for verifying configuration (bounded range). */
export const adminPreviewSlotsFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      serviceId: idSchema,
      fromDate: dateSchema,
      toDate: dateSchema,
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'availability.manage')
    return computeAvailableSlots(data.serviceId, data.fromDate, data.toDate)
  })

// --- Appointments -----------------------------------------------------------

export const adminListAppointmentsFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      status: z.enum(APPOINTMENT_STATUSES).optional(),
      sacredHouseId: idSchema.optional(),
      fromDate: dateSchema.optional(),
      toDate: dateSchema.optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await expireStaleReservations()
    const rows = await listAppointmentsAdmin(actor.id, data)
    const houses = await getDb()
      .select({ id: sacredHouses.id, name: sacredHouses.name })
      .from(sacredHouses)
      .orderBy(sacredHouses.sortOrder)
    return { rows, houses }
  })

export const adminGetAppointmentFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return getAppointmentAdmin(actor.id, data.id)
  })

export const adminCancelAppointmentFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({ id: idSchema, reason: z.string().trim().min(1).max(500) }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await cancelAppointment(
      { userId: actor.id, isOperator: true },
      requestContext(),
      data.id,
      data.reason,
    )
    return { ok: true }
  })

export const adminRescheduleAppointmentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, newStartsAtUtc: utcSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await rescheduleAppointment(
      { userId: actor.id, isOperator: true },
      requestContext(),
      data.id,
      data.newStartsAtUtc,
    )
    return { ok: true }
  })

export const adminCompleteAppointmentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await completeAppointment(actor.id, requestContext(), data.id)
    return { ok: true }
  })

export const adminMarkNoShowFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await markNoShow(actor.id, requestContext(), data.id)
    return { ok: true }
  })

export const adminAssignRepresentativeFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: idSchema,
      memberId: idSchema,
      role: z.enum(['PRIMARY', 'SUPPORT']),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await assignRepresentative(
      actor.id,
      requestContext(),
      data.id,
      data.memberId,
      data.role,
    )
    return { ok: true }
  })

export const adminRemoveRepresentativeFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, memberId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await removeRepresentative(
      actor.id,
      requestContext(),
      data.id,
      data.memberId,
    )
    return { ok: true }
  })
