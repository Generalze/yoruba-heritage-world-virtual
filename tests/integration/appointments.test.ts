import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { and, eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  appointmentRepresentatives,
  appointments,
  auditLogs,
  sacredHouseAvailability,
  sacredHouseAvailabilityExceptions,
  sacredHouseBookingSettings,
  sacredHouseMembers,
  sacredHouses,
  services,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { ForbiddenError } from '@/auth/guards'
import { assignRoleToUser } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import { acceptRequiredConsents, savePersonalDetails } from '@/services/profile'
import {
  addAvailabilityException,
  addAvailabilityWindow,
  availabilityWindowSchema,
  bookingSettingsSchema,
  exceptionSchema,
  getOrCreateBookingSettings,
  updateBookingSettings,
} from '@/services/scheduling'
import {
  AppointmentError,
  assignRepresentative,
  cancelAppointment,
  completeAppointment,
  computeAvailableSlots,
  confirmReservation,
  createReservation,
  expireStaleReservations,
  getUserAppointmentByPublicId,
  getUserAppointments,
  loadBookableService,
  markNoShow,
  removeRepresentative,
  rescheduleAppointment,
} from '@/services/appointments'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  sqlToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `appt test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'

let adminId: number
let cmId: number
let eligibleA: number
let eligibleB: number
let ineligibleId: number
let houseId: number
let bookableServiceId: number
let unpricedServiceId: number
let memberActiveId: number
let memberSupportId: number
let memberInactiveId: number
let otherHouseId: number
let otherHouseMemberId: number

const today = currentLocalDate(HOUSE_TZ, Date.now())
const D = (n: number) => addDays(today, n)
const slotUtc = (date: string, time: string) =>
  utcMsToSql(localToUtcMs(HOUSE_TZ, date, time))

const SETTINGS = {
  schedulingTimezone: HOUSE_TZ,
  bookingEnabled: true,
  slotIncrementMinutes: 30,
  minimumLeadMinutes: 1440,
  maximumAdvanceDays: 90,
  reservationHoldMinutes: 15,
  cancellationCutoffMinutes: 1440,
  rescheduleCutoffMinutes: 1440,
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s5-${crypto.randomUUID()}@test.local`,
      preferredName: 'S5 Fixture',
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

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')
  eligibleA = await makeEligibleUser()
  eligibleB = await makeEligibleUser()
  ineligibleId = await makeUser()

  const db = getDb()
  const houseKey = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T5H_${houseKey}`.toUpperCase(),
    name: `T5 House ${houseKey}`,
    slug: `t5h-${houseKey}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId

  const otherInsert = await db.insert(sacredHouses).values({
    code: `T5O_${houseKey}`.toUpperCase(),
    name: `T5 Other ${houseKey}`,
    slug: `t5o-${houseKey}`,
    status: 'PUBLISHED',
  })
  otherHouseId = otherInsert[0].insertId

  const svcInsert = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T5S_${houseKey}`.toUpperCase(),
    name: `T5 Bookable ${houseKey}`,
    slug: `t5s-${houseKey}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  bookableServiceId = svcInsert[0].insertId

  const unpriced = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T5U_${houseKey}`.toUpperCase(),
    name: `T5 Unpriced ${houseKey}`,
    slug: `t5u-${houseKey}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
  })
  unpricedServiceId = unpriced[0].insertId

  const members = await db.insert(sacredHouseMembers).values([
    {
      sacredHouseId: houseId,
      displayName: 'T5 Rep One',
      memberType: 'PRAYER_WARRIOR',
    },
    {
      sacredHouseId: houseId,
      displayName: 'T5 Rep Two',
      memberType: 'PRAYER_WARRIOR',
    },
    {
      sacredHouseId: houseId,
      displayName: 'T5 Rep Inactive',
      memberType: 'PRAYER_WARRIOR',
      active: false,
    },
  ])
  memberActiveId = members[0].insertId
  memberSupportId = memberActiveId + 1
  memberInactiveId = memberActiveId + 2
  const otherMember = await db.insert(sacredHouseMembers).values({
    sacredHouseId: otherHouseId,
    displayName: 'T5 Other House Rep',
    memberType: 'PRAYER_WARRIOR',
  })
  otherHouseMemberId = otherMember[0].insertId

  await getOrCreateBookingSettings(houseId)
  await updateBookingSettings(adminId, ctx, houseId, SETTINGS)
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
  const houseIds = [houseId, otherHouseId].filter(Boolean)
  if (houseIds.length > 0) {
    const apptRows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(inArray(appointments.sacredHouseId, houseIds))
    const apptIds = apptRows.map((row) => row.id)
    if (apptIds.length > 0) {
      // Step 7 guidance rows are RESTRICT-linked to appointments.
      const schema = await import('@/db/schema')
      await db
        .delete(schema.appointmentGuidanceAcknowledgements)
        .where(
          inArray(
            schema.appointmentGuidanceAcknowledgements.appointmentId,
            apptIds,
          ),
        )
      await db
        .delete(schema.appointmentGuidanceAssignments)
        .where(
          inArray(schema.appointmentGuidanceAssignments.appointmentId, apptIds),
        )
      await db
        .delete(schema.appointmentGuidanceSets)
        .where(inArray(schema.appointmentGuidanceSets.appointmentId, apptIds))
      await db
        .delete(appointmentRepresentatives)
        .where(inArray(appointmentRepresentatives.appointmentId, apptIds))
      await db.delete(auditLogs).where(
        and(
          eq(auditLogs.entityType, 'appointment'),
          inArray(
            auditLogs.entityId,
            apptIds.map((id) => String(id)),
          ),
        ),
      )
      await db.delete(appointments).where(inArray(appointments.id, apptIds))
    }
    await db
      .delete(sacredHouseAvailability)
      .where(inArray(sacredHouseAvailability.sacredHouseId, houseIds))
    await db
      .delete(sacredHouseAvailabilityExceptions)
      .where(inArray(sacredHouseAvailabilityExceptions.sacredHouseId, houseIds))
    await db
      .delete(sacredHouseBookingSettings)
      .where(inArray(sacredHouseBookingSettings.sacredHouseId, houseIds))
    await db
      .delete(sacredHouseMembers)
      .where(inArray(sacredHouseMembers.sacredHouseId, houseIds))
    await db.delete(services).where(inArray(services.sacredHouseId, houseIds))
    await db.delete(sacredHouses).where(inArray(sacredHouses.id, houseIds))
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await closeDb()
})

describe('booking settings and validation', () => {
  it('defaults are safe: booking disabled, Africa/Lagos, locked values', async () => {
    const settings = await getOrCreateBookingSettings(otherHouseId)
    expect(settings.bookingEnabled).toBe(false)
    expect(settings.schedulingTimezone).toBe('Africa/Lagos')
    expect(settings.slotIncrementMinutes).toBe(30)
    expect(settings.reservationHoldMinutes).toBe(15)
    expect(settings.cancellationCutoffMinutes).toBe(1440)
  })

  it('CONTENT_MANAGER cannot manage scheduling', async () => {
    let thrown: unknown = null
    try {
      await updateBookingSettings(cmId, ctx, houseId, SETTINGS)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ForbiddenError)

    thrown = null
    try {
      await addAvailabilityWindow(cmId, ctx, houseId, {
        dayOfWeek: 1,
        startLocalTime: '08:00',
        endLocalTime: '08:30',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ForbiddenError)
  })

  it('rejects invalid settings values', () => {
    expect(
      bookingSettingsSchema.safeParse({
        ...SETTINGS,
        schedulingTimezone: 'WAT',
      }).success,
    ).toBe(false)
    expect(
      bookingSettingsSchema.safeParse({ ...SETTINGS, slotIncrementMinutes: 0 })
        .success,
    ).toBe(false)
    expect(
      bookingSettingsSchema.safeParse({ ...SETTINGS, maximumAdvanceDays: 0 })
        .success,
    ).toBe(false)
    expect(
      bookingSettingsSchema.safeParse({
        ...SETTINGS,
        reservationHoldMinutes: 1,
      }).success,
    ).toBe(false)
  })

  it('rejects malformed and overlapping windows', async () => {
    expect(
      availabilityWindowSchema.safeParse({
        dayOfWeek: 8,
        startLocalTime: '09:00',
        endLocalTime: '10:00',
      }).success,
    ).toBe(false)
    expect(
      availabilityWindowSchema.safeParse({
        dayOfWeek: 1,
        startLocalTime: '12:00',
        endLocalTime: '09:00',
      }).success,
    ).toBe(false)

    let thrown: unknown = null
    try {
      await addAvailabilityWindow(adminId, ctx, houseId, {
        dayOfWeek: 1,
        startLocalTime: '10:00',
        endLocalTime: '11:00',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).not.toBeNull() // overlaps the 09:00–17:00 window
  })

  it('rejects BLOCK/OPEN exceptions without a valid interval', () => {
    expect(
      exceptionSchema.safeParse({ localDate: D(8), type: 'BLOCK' }).success,
    ).toBe(false)
    expect(
      exceptionSchema.safeParse({
        localDate: D(8),
        type: 'OPEN',
        startLocalTime: '14:00',
        endLocalTime: '12:00',
      }).success,
    ).toBe(false)
    expect(
      exceptionSchema.safeParse({ localDate: D(8), type: 'CLOSED' }).success,
    ).toBe(true)
  })
})

describe('service bookability', () => {
  it('requires explicit duration, price and currency', async () => {
    let thrown: unknown = null
    try {
      await loadBookableService(unpricedServiceId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
  })

  it('requires PUBLISHED + active service and House', async () => {
    const db = getDb()
    await db
      .update(services)
      .set({ active: false })
      .where(eq(services.id, bookableServiceId))
    let thrown: unknown = null
    try {
      await loadBookableService(bookableServiceId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
    await db
      .update(services)
      .set({ active: true })
      .where(eq(services.id, bookableServiceId))

    await db
      .update(sacredHouses)
      .set({ status: 'DRAFT' })
      .where(eq(sacredHouses.id, houseId))
    thrown = null
    try {
      await loadBookableService(bookableServiceId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
    await db
      .update(sacredHouses)
      .set({ status: 'PUBLISHED' })
      .where(eq(sacredHouses.id, houseId))
  })

  it('derives the House from the service server-side', async () => {
    const bookable = await loadBookableService(bookableServiceId)
    expect(bookable.sacredHouseId).toBe(houseId)
  })
})

describe('slot generation', () => {
  it('generates increment-aligned slots that fully fit the duration', async () => {
    const slots = await computeAvailableSlots(bookableServiceId, D(7), D(7))
    // 09:00–17:00, 60-minute service, 30-minute increment:
    // starts 09:00 … 16:00 → 15 slots.
    expect(slots.length).toBe(15)
    expect(slots[0].houseLocalTime).toBe('09:00')
    expect(slots.at(-1)?.houseLocalTime).toBe('16:00')
    // Lagos is UTC+1: 09:00 local = 08:00 UTC.
    expect(slots[0].startsAtUtc).toBe(slotUtc(D(7), '09:00'))
    expect(slots[0].startsAtUtc.endsWith('08:00:00')).toBe(true)
  })

  it('CLOSED exception removes the whole day', async () => {
    await addAvailabilityException(adminId, ctx, houseId, {
      localDate: D(8),
      type: 'CLOSED',
    })
    expect(await computeAvailableSlots(bookableServiceId, D(8), D(8))).toEqual(
      [],
    )
  })

  it('BLOCK removes a partial interval; duration must fully fit', async () => {
    await addAvailabilityException(adminId, ctx, houseId, {
      localDate: D(9),
      type: 'BLOCK',
      startLocalTime: '12:00',
      endLocalTime: '14:00',
    })
    const slots = await computeAvailableSlots(bookableServiceId, D(9), D(9))
    const times = slots.map((slot) => slot.houseLocalTime)
    // Open: 09:00–12:00 and 14:00–17:00. 60-min fits: 09:00–11:00
    // starts (5) + 14:00–16:00 starts (5).
    expect(times).toEqual([
      '09:00',
      '09:30',
      '10:00',
      '10:30',
      '11:00',
      '14:00',
      '14:30',
      '15:00',
      '15:30',
      '16:00',
    ])
  })

  it('OPEN adds an exceptional window', async () => {
    await addAvailabilityException(adminId, ctx, houseId, {
      localDate: D(10),
      type: 'OPEN',
      startLocalTime: '18:00',
      endLocalTime: '20:00',
    })
    const slots = await computeAvailableSlots(bookableServiceId, D(10), D(10))
    const times = slots.map((slot) => slot.houseLocalTime)
    expect(times).toContain('18:00')
    expect(times).toContain('19:00')
    expect(times).not.toContain('19:30') // 60 min would exceed 20:00
  })

  it('respects lead time, advance limit, range cap and booking_enabled', async () => {
    // Today is inside the 1440-minute lead — no slots.
    expect(
      await computeAvailableSlots(bookableServiceId, today, today),
    ).toEqual([])

    // Beyond maximum_advance_days — no slots.
    expect(
      await computeAvailableSlots(bookableServiceId, D(100), D(100)),
    ).toEqual([])

    // Range cap.
    let thrown: unknown = null
    try {
      await computeAvailableSlots(bookableServiceId, D(1), D(40))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // Booking disabled.
    await updateBookingSettings(adminId, ctx, houseId, {
      ...SETTINGS,
      bookingEnabled: false,
    })
    expect(await computeAvailableSlots(bookableServiceId, D(7), D(7))).toEqual(
      [],
    )
    await updateBookingSettings(adminId, ctx, houseId, SETTINGS)
  })
})

describe('reservations', () => {
  it('eligible user reserves: PENDING_PAYMENT, hold expiry, snapshots, note', async () => {
    const start = slotUtc(D(11), '09:00')
    const before = Date.now()
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: start,
      privateRequestNote: '  A private request for guidance.  ',
    })

    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(row.status).toBe('PENDING_PAYMENT')
    expect(row.sacredHouseId).toBe(houseId)
    expect(row.serviceNameSnapshot).toContain('T5 Bookable')
    expect(row.houseNameSnapshot).toContain('T5 House')
    expect(row.durationMinutesSnapshot).toBe(60)
    expect(row.priceMinorSnapshot).toBe(500_000)
    expect(row.currencySnapshot).toBe('NGN')
    expect(row.userTimezone).toBe('Africa/Lagos')
    expect(row.houseTimezone).toBe(HOUSE_TZ)
    expect(row.privateRequestNote).toBe('A private request for guidance.')
    expect(row.publicId).toMatch(/^[0-9a-f-]{36}$/)

    const expiryMs = Date.parse(
      row.reservationExpiresAt!.replace(' ', 'T') + 'Z',
    )
    const drift = Math.abs(expiryMs - (before + 15 * 60_000))
    expect(drift).toBeLessThan(10_000)
  })

  it('ineligible Step 4 user is rejected', async () => {
    let thrown: unknown = null
    try {
      await createReservation(ineligibleId, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: slotUtc(D(11), '11:00'),
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
  })

  it('rejects notes over 1500 characters and unaligned times', async () => {
    let thrown: unknown = null
    try {
      await createReservation(eligibleA, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: slotUtc(D(11), '12:00'),
        privateRequestNote: 'x'.repeat(1501),
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    thrown = null
    try {
      await createReservation(eligibleA, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: slotUtc(D(11), '09:15'), // not increment-aligned
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
  })
})

describe('collision protection', () => {
  it('blocks overlap with live reservations, frees cancelled/expired, allows adjacency', async () => {
    const start = slotUtc(D(12), '09:00')
    const first = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: start,
    })

    // Same slot blocked while the hold is live.
    let thrown: unknown = null
    try {
      await createReservation(eligibleB, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: start,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // Overlapping (09:30 start over a 09:00–10:00 hold) blocked.
    thrown = null
    try {
      await createReservation(eligibleB, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: slotUtc(D(12), '09:30'),
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // Adjacent interval (10:00 start) allowed.
    const adjacent = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(12), '10:00'),
    })
    expect(adjacent.startsAtUtc).toBe(slotUtc(D(12), '10:00'))

    // Cancelled reservations stop blocking.
    await cancelAppointment(
      { userId: eligibleA, isOperator: false },
      ctx,
      first.appointmentId,
      null,
    )
    const rebooked = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: start,
    })

    // Expired holds stop blocking even before cleanup runs.
    await getDb()
      .update(appointments)
      .set({ reservationExpiresAt: utcMsToSql(Date.now() - 60_000) })
      .where(eq(appointments.id, rebooked.appointmentId))
    const again = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: start,
    })
    expect(again.appointmentId).not.toBe(rebooked.appointmentId)

    // Lazy cleanup marks the stale row EXPIRED.
    const expired = await expireStaleReservations()
    expect(expired).toBeGreaterThanOrEqual(1)
    const staleRow = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, rebooked.appointmentId))
    ).at(0)!
    expect(staleRow.status).toBe('EXPIRED')
  })

  it('concurrency: two competing reservations cannot both take one interval', async () => {
    const start = slotUtc(D(15), '09:00')
    const results = await Promise.allSettled([
      createReservation(eligibleA, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: start,
      }),
      createReservation(eligibleB, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: start,
      }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(1)
  })
})

describe('status transitions', () => {
  it('confirm works on live holds, never on expired ones; terminals stay terminal', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(16), '09:00'),
    })
    await confirmReservation(created.appointmentId, ctx)
    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(row.status).toBe('CONFIRMED')
    expect(row.reservationExpiresAt).toBeNull()

    // Expired hold cannot confirm.
    const stale = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(16), '11:00'),
    })
    await getDb()
      .update(appointments)
      .set({ reservationExpiresAt: utcMsToSql(Date.now() - 60_000) })
      .where(eq(appointments.id, stale.appointmentId))
    let thrown: unknown = null
    try {
      await confirmReservation(stale.appointmentId, ctx)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // Terminal: cancelled cannot be confirmed/completed.
    await cancelAppointment(
      { userId: adminId, isOperator: true },
      ctx,
      created.appointmentId,
      'Operational test cancellation',
    )
    thrown = null
    try {
      await confirmReservation(created.appointmentId, ctx)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
    thrown = null
    try {
      await completeAppointment(adminId, ctx, created.appointmentId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
  })

  it('pending reservations cannot be completed', async () => {
    const pending = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(16), '13:00'),
    })
    let thrown: unknown = null
    try {
      await completeAppointment(adminId, ctx, pending.appointmentId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
  })
})

describe('cancellation and rescheduling', () => {
  it('user cancels own confirmed appointment outside the cutoff; admin needs a reason inside it', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(13), '09:00'),
    })
    await confirmReservation(created.appointmentId, ctx)

    // Another user cannot touch it.
    let thrown: unknown = null
    try {
      await cancelAppointment(
        { userId: eligibleB, isOperator: false },
        ctx,
        created.appointmentId,
        null,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // Outside the 24h cutoff (D+13): user cancel succeeds.
    await cancelAppointment(
      { userId: eligibleA, isOperator: false },
      ctx,
      created.appointmentId,
      null,
    )

    // Inside the cutoff: user denied, admin without reason denied,
    // admin with reason succeeds.
    const near = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(13), '11:00'),
    })
    await confirmReservation(near.appointmentId, ctx)
    await getDb()
      .update(appointments)
      .set({
        startsAtUtc: utcMsToSql(Date.now() + 2 * 3_600_000),
        endsAtUtc: utcMsToSql(Date.now() + 3 * 3_600_000),
      })
      .where(eq(appointments.id, near.appointmentId))

    thrown = null
    try {
      await cancelAppointment(
        { userId: eligibleA, isOperator: false },
        ctx,
        near.appointmentId,
        null,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    thrown = null
    try {
      await cancelAppointment(
        { userId: adminId, isOperator: true },
        ctx,
        near.appointmentId,
        '',
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    await cancelAppointment(
      { userId: adminId, isOperator: true },
      ctx,
      near.appointmentId,
      'House unavailable — operational cancellation',
    )
  })

  it('reschedules atomically with the same lock; keeps service/House; increments count', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(14), '09:00'),
    })
    await confirmReservation(created.appointmentId, ctx)

    // Occupy a destination to prove overlap rejection.
    const blockerStart = slotUtc(D(14), '12:00')
    const blocker = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: blockerStart,
    })
    await confirmReservation(blocker.appointmentId, ctx)

    let thrown: unknown = null
    try {
      await rescheduleAppointment(
        { userId: eligibleA, isOperator: false },
        ctx,
        created.appointmentId,
        blockerStart,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // Valid destination succeeds.
    await rescheduleAppointment(
      { userId: eligibleA, isOperator: false },
      ctx,
      created.appointmentId,
      slotUtc(D(14), '15:00'),
    )
    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(row.startsAtUtc).toBe(slotUtc(D(14), '15:00'))
    expect(row.rescheduleCount).toBe(1)
    expect(row.serviceId).toBe(bookableServiceId)
    expect(row.sacredHouseId).toBe(houseId)
    expect(row.status).toBe('CONFIRMED')

    // Inside cutoff: user denied, admin override succeeds.
    await getDb()
      .update(appointments)
      .set({
        startsAtUtc: utcMsToSql(Date.now() + 2 * 3_600_000),
        endsAtUtc: utcMsToSql(Date.now() + 3 * 3_600_000),
      })
      .where(eq(appointments.id, created.appointmentId))
    thrown = null
    try {
      await rescheduleAppointment(
        { userId: eligibleA, isOperator: false },
        ctx,
        created.appointmentId,
        slotUtc(D(14), '16:00'),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    await rescheduleAppointment(
      { userId: adminId, isOperator: true },
      ctx,
      created.appointmentId,
      slotUtc(D(14), '16:00'),
    )
    const after = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(after.rescheduleCount).toBe(2)

    // Pending reservations do not use confirmed-reschedule semantics.
    const pending = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(14), '10:30'),
    })
    thrown = null
    try {
      await rescheduleAppointment(
        { userId: eligibleB, isOperator: false },
        ctx,
        pending.appointmentId,
        slotUtc(D(14), '13:30'),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
  })
})

describe('representatives', () => {
  it('enforces role, house membership, activity and single PRIMARY', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(17), '09:00'),
    })

    // Assignment requires CONFIRMED.
    let thrown: unknown = null
    try {
      await assignRepresentative(
        adminId,
        ctx,
        created.appointmentId,
        memberActiveId,
        'PRIMARY',
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    await confirmReservation(created.appointmentId, ctx)

    // Non-operators cannot assign.
    for (const actor of [eligibleA, cmId]) {
      thrown = null
      try {
        await assignRepresentative(
          actor,
          ctx,
          created.appointmentId,
          memberActiveId,
          'PRIMARY',
        )
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ForbiddenError)
    }

    await assignRepresentative(
      adminId,
      ctx,
      created.appointmentId,
      memberActiveId,
      'PRIMARY',
    )

    // Second PRIMARY rejected.
    thrown = null
    try {
      await assignRepresentative(
        adminId,
        ctx,
        created.appointmentId,
        memberSupportId,
        'PRIMARY',
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // SUPPORT is fine.
    await assignRepresentative(
      adminId,
      ctx,
      created.appointmentId,
      memberSupportId,
      'SUPPORT',
    )

    // Wrong House and inactive members rejected.
    thrown = null
    try {
      await assignRepresentative(
        adminId,
        ctx,
        created.appointmentId,
        otherHouseMemberId,
        'SUPPORT',
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    thrown = null
    try {
      await assignRepresentative(
        adminId,
        ctx,
        created.appointmentId,
        memberInactiveId,
        'SUPPORT',
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // Assignment never affects slot capacity: another slot that day
    // still books normally.
    const other = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(17), '11:00'),
    })
    expect(other.appointmentId).toBeGreaterThan(0)
  })
})

describe('privacy, ownership and audit', () => {
  it('private request note never reaches audit metadata; ownership is enforced', async () => {
    const secret = `deeply private context ${crypto.randomUUID()}`
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(18), '09:00'),
      privateRequestNote: secret,
    })

    const rows = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.entityType, 'appointment'))
    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('deeply private context')

    const actions = rows.map((row) => row.action)
    expect(actions).toContain('appointment.reserved')
    expect(actions).toContain('appointment.cancelled')
    expect(actions).toContain('appointment.rescheduled')
    expect(actions).toContain('appointment.representative_assigned')

    // Ownership primitives.
    const mine = await getUserAppointments(eligibleA)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((row) => typeof row.publicId === 'string')).toBe(true)

    const foreign = await getUserAppointmentByPublicId(
      eligibleB,
      created.publicId,
    )
    expect(foreign).toBeNull()
    const own = await getUserAppointmentByPublicId(eligibleA, created.publicId)
    expect(own?.id).toBe(created.appointmentId)
  })
})

describe('hardening: lifecycle and configuration races', () => {
  it('an expired hold cannot confirm into a reallocated interval', async () => {
    const start = slotUtc(D(19), '09:00')
    const holdA = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: start,
    })
    // Hold A expires without payment...
    await getDb()
      .update(appointments)
      .set({ reservationExpiresAt: utcMsToSql(Date.now() - 60_000) })
      .where(eq(appointments.id, holdA.appointmentId))
    // ...so user B legitimately takes the interval.
    const holdB = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: start,
    })

    // A's late confirmation MUST be refused under the House lock —
    // even when the CALLER'S clock predates the expiry. This is the
    // deterministic regression for the stale-clock defect: an entry
    // clock 60s before the (already past) expiry makes the naive
    // pre-lock check pass; the in-lock fresh-clock check must refuse.
    const rowA = (
      await getDb()
        .select({ expires: appointments.reservationExpiresAt })
        .from(appointments)
        .where(eq(appointments.id, holdA.appointmentId))
    ).at(0)!
    const staleEntryClock = sqlToUtcMs(rowA.expires!) - 60_000
    let thrown: unknown = null
    try {
      await confirmReservation(holdA.appointmentId, ctx, staleEntryClock)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
    const afterA = (
      await getDb()
        .select({ status: appointments.status })
        .from(appointments)
        .where(eq(appointments.id, holdA.appointmentId))
    ).at(0)!
    expect(afterA.status).not.toBe('CONFIRMED')

    // B confirms normally: exactly one CONFIRMED owner of the interval.
    await confirmReservation(holdB.appointmentId, ctx)
    const rows = await getDb()
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.sacredHouseId, houseId),
          eq(appointments.startsAtUtc, start),
          eq(appointments.status, 'CONFIRMED'),
        ),
      )
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(holdB.appointmentId)
  })

  it('stale-expiry cleanup never overwrites a row that became CONFIRMED', async () => {
    // Sequential sanity: a CONFIRMED row with a stale expiry stamp is
    // never selected nor updated by cleanup.
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(19), '11:00'),
    })
    await getDb()
      .update(appointments)
      .set({
        status: 'CONFIRMED',
        reservationExpiresAt: utcMsToSql(Date.now() - 60_000),
      })
      .where(eq(appointments.id, created.appointmentId))

    await expireStaleReservations()
    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(row.status).toBe('CONFIRMED')
  })

  it('confirm racing expiry cleanup: exactly one wins, EXPIRED never overwrites CONFIRMED', async () => {
    // The hold is LIVE on the real clock but STALE from the cleanup
    // caller's injected future clock — so both operations genuinely
    // target the same row and the guarded UPDATE decides the race.
    const created = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(19), '13:00'),
    })
    const futureNow = Date.now() + 60 * 60_000

    const [confirmResult] = await Promise.allSettled([
      confirmReservation(created.appointmentId, ctx),
      expireStaleReservations(futureNow),
    ])

    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    if (confirmResult.status === 'fulfilled') {
      // Confirm won: the guarded expiry UPDATE must have skipped the
      // row (status pin failed) — and no expired audit event exists.
      expect(row.status).toBe('CONFIRMED')
      const expiredAudit = await getDb()
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, 'appointment.expired'),
            eq(auditLogs.entityId, String(created.appointmentId)),
          ),
        )
      expect(expiredAudit.length).toBe(0)
    } else {
      // Cleanup won: the hold is EXPIRED and confirm was refused.
      expect(row.status).toBe('EXPIRED')
    }
  })

  it('cancel racing reschedule: exactly one wins', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(25), '09:00'),
    })
    await confirmReservation(created.appointmentId, ctx)

    const results = await Promise.allSettled([
      cancelAppointment(
        { userId: adminId, isOperator: true },
        ctx,
        created.appointmentId,
        'Race: operational cancellation',
      ),
      rescheduleAppointment(
        { userId: adminId, isOperator: true },
        ctx,
        created.appointmentId,
        slotUtc(D(25), '12:00'),
      ),
    ])
    // Cancel pins (status, startsAtUtc); reschedule re-reads under the
    // lock — whichever commits second must observe the other and lose.
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)

    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    if (results[0].status === 'fulfilled') {
      expect(row.status).toBe('CANCELLED')
      expect(row.startsAtUtc).toBe(slotUtc(D(25), '09:00'))
    } else {
      expect(row.status).toBe('CONFIRMED')
      expect(row.startsAtUtc).toBe(slotUtc(D(25), '12:00'))
    }
  })

  it('cancel vs complete race: exactly one terminal transition wins', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(20), '09:00'),
    })
    await confirmReservation(created.appointmentId, ctx)

    const results = await Promise.allSettled([
      cancelAppointment(
        { userId: adminId, isOperator: true },
        ctx,
        created.appointmentId,
        'Race test operational cancellation',
      ),
      completeAppointment(adminId, ctx, created.appointmentId),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled.length).toBe(1)

    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    const cancelWon = results[0].status === 'fulfilled'
    expect(row.status).toBe(cancelWon ? 'CANCELLED' : 'COMPLETED')
  })

  it('complete vs no-show race: exactly one terminal transition wins', async () => {
    const created = await createReservation(eligibleB, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(20), '11:00'),
    })
    await confirmReservation(created.appointmentId, ctx)

    const results = await Promise.allSettled([
      completeAppointment(adminId, ctx, created.appointmentId),
      markNoShow(adminId, ctx, created.appointmentId),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(['COMPLETED', 'NO_SHOW']).toContain(row.status)
  })

  it('reschedule re-reads state under the lock: terminal records stay untouched', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(20), '13:00'),
    })
    await confirmReservation(created.appointmentId, ctx)
    await cancelAppointment(
      { userId: adminId, isOperator: true },
      ctx,
      created.appointmentId,
      'Cancelled before reschedule attempt',
    )

    let thrown: unknown = null
    try {
      await rescheduleAppointment(
        { userId: adminId, isOperator: true },
        ctx,
        created.appointmentId,
        slotUtc(D(20), '15:00'),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(row.status).toBe('CANCELLED')
    expect(row.startsAtUtc).toBe(slotUtc(D(20), '13:00'))
  })

  it('concurrent reschedules serialize and increment from the current count', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(21), '09:00'),
    })
    await confirmReservation(created.appointmentId, ctx)

    const destinations = [slotUtc(D(21), '12:00'), slotUtc(D(21), '15:00')]
    const results = await Promise.allSettled(
      destinations.map((dest) =>
        rescheduleAppointment(
          { userId: adminId, isOperator: true },
          ctx,
          created.appointmentId,
          dest,
        ),
      ),
    )
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length
    expect(fulfilled).toBeGreaterThanOrEqual(1)

    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(row.rescheduleCount).toBe(fulfilled)
    expect(destinations).toContain(row.startsAtUtc)
  })

  it('a reservation can never land while booking is disabled', async () => {
    const racedSlot = slotUtc(D(22), '09:00')
    const results = await Promise.allSettled([
      updateBookingSettings(adminId, ctx, houseId, {
        ...SETTINGS,
        bookingEnabled: false,
      }),
      createReservation(eligibleA, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: racedSlot,
      }),
    ])
    // Branch-consistent outcome for the raced slot: the reservation
    // exists if and only if it won the serialization race — a rejected
    // reservation must have left no row behind.
    const racedRows = await getDb()
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.sacredHouseId, houseId),
          eq(appointments.startsAtUtc, racedSlot),
        ),
      )
    if (results[1].status === 'fulfilled') {
      expect(racedRows.length).toBe(1)
    } else {
      expect(racedRows.length).toBe(0)
    }

    // Whatever the interleaving above, the in-lock revalidation makes
    // the settled state deterministic: booking is now disabled, so
    // reserving is impossible and leaves no row behind.
    let thrown: unknown = null
    try {
      await createReservation(eligibleB, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: slotUtc(D(22), '11:00'),
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
    const disabledRows = await getDb()
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.sacredHouseId, houseId),
          eq(appointments.startsAtUtc, slotUtc(D(22), '11:00')),
        ),
      )
    expect(disabledRows.length).toBe(0)

    await updateBookingSettings(adminId, ctx, houseId, SETTINGS)
  })

  it('concurrent overlapping availability windows cannot both be created', async () => {
    const results = await Promise.allSettled([
      addAvailabilityWindow(adminId, ctx, otherHouseId, {
        dayOfWeek: 2,
        startLocalTime: '09:00',
        endLocalTime: '12:00',
      }),
      addAvailabilityWindow(adminId, ctx, otherHouseId, {
        dayOfWeek: 2,
        startLocalTime: '10:00',
        endLocalTime: '13:00',
      }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)

    const windows = await getDb()
      .select()
      .from(sacredHouseAvailability)
      .where(
        and(
          eq(sacredHouseAvailability.sacredHouseId, otherHouseId),
          eq(sacredHouseAvailability.dayOfWeek, 2),
          eq(sacredHouseAvailability.active, true),
        ),
      )
    expect(windows.length).toBe(1)
  })

  it('concurrent PRIMARY assignments yield exactly one PRIMARY; terminal locks assignments', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(23), '09:00'),
    })
    await confirmReservation(created.appointmentId, ctx)

    const results = await Promise.allSettled([
      assignRepresentative(
        adminId,
        ctx,
        created.appointmentId,
        memberActiveId,
        'PRIMARY',
      ),
      assignRepresentative(
        adminId,
        ctx,
        created.appointmentId,
        memberSupportId,
        'PRIMARY',
      ),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)

    const primaries = await getDb()
      .select()
      .from(appointmentRepresentatives)
      .where(
        and(
          eq(appointmentRepresentatives.appointmentId, created.appointmentId),
          eq(appointmentRepresentatives.assignmentRole, 'PRIMARY'),
        ),
      )
    expect(primaries.length).toBe(1)

    // Once terminal, representative changes are refused and the
    // historical assignment stays stable.
    await completeAppointment(adminId, ctx, created.appointmentId)
    let thrown: unknown = null
    try {
      await assignRepresentative(
        adminId,
        ctx,
        created.appointmentId,
        memberSupportId,
        'SUPPORT',
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    thrown = null
    try {
      await removeRepresentative(
        adminId,
        ctx,
        created.appointmentId,
        primaries[0].sacredHouseMemberId,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)
    const after = await getDb()
      .select()
      .from(appointmentRepresentatives)
      .where(
        eq(appointmentRepresentatives.appointmentId, created.appointmentId),
      )
    expect(after.length).toBe(1)
  })

  it('admin reschedule bypasses only the cutoff - lead and advance limits still apply', async () => {
    const created = await createReservation(eligibleA, ctx, {
      serviceId: bookableServiceId,
      startsAtUtc: slotUtc(D(24), '09:00'),
    })
    await confirmReservation(created.appointmentId, ctx)

    // Destination inside the minimum lead window: refused even for admin.
    let thrown: unknown = null
    try {
      await rescheduleAppointment(
        { userId: adminId, isOperator: true },
        ctx,
        created.appointmentId,
        slotUtc(today, '09:00'),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    // Destination beyond the maximum advance range: refused for admin.
    thrown = null
    try {
      await rescheduleAppointment(
        { userId: adminId, isOperator: true },
        ctx,
        created.appointmentId,
        slotUtc(D(100), '09:00'),
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    const row = (
      await getDb()
        .select()
        .from(appointments)
        .where(eq(appointments.id, created.appointmentId))
    ).at(0)!
    expect(row.startsAtUtc).toBe(slotUtc(D(24), '09:00'))
  })

  it('a missing profile timezone blocks reservation end to end (eligibility gate; the in-function snapshot guard is unreachable defense-in-depth)', async () => {
    const start = slotUtc(D(24), '11:00')
    const { userProfiles } = await import('@/db/schema')
    await getDb()
      .update(userProfiles)
      .set({ timezone: null })
      .where(eq(userProfiles.userId, eligibleB))

    let thrown: unknown = null
    try {
      await createReservation(eligibleB, ctx, {
        serviceId: bookableServiceId,
        startsAtUtc: start,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppointmentError)

    const rows = await getDb()
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.sacredHouseId, houseId),
          eq(appointments.startsAtUtc, start),
        ),
      )
    expect(rows.length).toBe(0)
    // No appointment anywhere carries a silently-defaulted UTC snapshot
    // for this user.
    const utcSnapshots = await getDb()
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.userId, eligibleB),
          eq(appointments.userTimezone, 'UTC'),
        ),
      )
    expect(utcSnapshots.length).toBe(0)

    await getDb()
      .update(userProfiles)
      .set({ timezone: 'Africa/Lagos' })
      .where(eq(userProfiles.userId, eligibleB))
  })

  it('confirmReservation is unreachable from server functions and routes', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')

    // Recursively collect every source file under a directory so new
    // action modules or nested route folders can never dodge the scan.
    function walk(dir: string): Array<string> {
      const out: Array<string> = []
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (/\.tsx?$/.test(entry)) out.push(full)
      }
      return out
    }

    const root = process.cwd()
    const scanned: Array<string> = [
      // Every server-function module in the codebase (any *-actions.ts
      // anywhere under src) plus the auth actions module explicitly.
      ...walk(join(root, 'src', 'services')).filter((f) =>
        /-actions\.tsx?$/.test(f),
      ),
      join(root, 'src', 'auth', 'actions.ts'),
      ...walk(join(root, 'src', 'routes')),
    ]
    expect(scanned.length).toBeGreaterThan(10)
    for (const file of scanned) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toContain('confirmReservation')
      expect(source).not.toMatch(/mark paid|payment successful/i)
    }
  })
})
