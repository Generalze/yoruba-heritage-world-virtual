import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getAuthenticatedUser } from '@/auth/guards'
import { FixedWindowRateLimiter } from '@/auth/rate-limit'
import { env } from '@/lib/env'
import { requestContext } from '@/server/request-context'
import { buildMockCryptoWebhook } from '@/providers/payments/crypto'
import { buildMockWebhook } from '@/providers/payments/mock'
import { listAvailableProviders } from '@/providers/payments/registry'
import {
  cancelAppointment,
  computeAvailableSlots,
  createReservation,
  expireStaleReservations,
  getUserAppointmentByPublicId,
  getUserAppointments,
  loadBookableService,
  rescheduleAppointment,
  AppointmentError,
} from './appointments'
import { getPublishedServiceBySlug } from './catalogue'
import { canUserBookSpiritualService } from './profile'
import { getOrCreateBookingSettings } from './scheduling'
import {
  PaymentError,
  getAttemptsForOwnedAppointment,
  getSettlementForAppointment,
  getLatestAttemptsByAppointment,
  getUserPaymentByPublicId,
  getUserPaymentHistory,
  initiatePayment,
  processProviderWebhook,
  reconcilePayment,
} from './payments'
import { getDb } from '@/db'
import { and, eq } from 'drizzle-orm'
import { appointments, paymentAttempts } from '@/db/schema'
import type { SafeUser } from '@/auth/session'

/**
 * User booking, checkout & payment server functions (Step 6).
 *
 * Authority rules: the browser sends only service identity, a
 * server-issued slot start, an optional note, and public ids. Price,
 * duration, House, currency and provider eligibility are ALWAYS derived
 * server-side (Step 5 revalidates everything under the House lock).
 * There is deliberately NO confirm/mark-paid action here — appointment
 * confirmation happens only inside the central verified-payment
 * settlement.
 */

class UnauthenticatedError extends Error {
  constructor() {
    super('Authentication required')
    this.name = 'UnauthenticatedError'
  }
}

async function requireUser(): Promise<SafeUser> {
  const user = await getAuthenticatedUser()
  if (!user) throw new UnauthenticatedError()
  return user
}

/** Reservation-creation abuse limit (spec §54) — same bounded
 * in-memory architecture as login/payment limiters. */
export const reservationLimiter = new FixedWindowRateLimiter(10, 15 * 60_000)

async function requireOwnedAppointment(userId: number, publicId: string) {
  const appointment = await getUserAppointmentByPublicId(userId, publicId)
  if (!appointment) throw new AppointmentError('Appointment not found.')
  return appointment
}

const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9-]+$/)
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const utcSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'Invalid UTC timestamp.')
const publicIdSchema = z.string().uuid()

// --- Booking page -----------------------------------------------------------

/** Public boolean only (service page Book button, spec §14): discloses
 * whether a genuine server-side booking path exists — never WHY not. */
export const getServiceBookableFn = createServerFn({ method: 'GET' })
  .validator(z.object({ serviceSlug: slugSchema }))
  .handler(async ({ data }) => {
    const service = await getPublishedServiceBySlug(data.serviceSlug)
    if (!service) return { bookable: false }
    try {
      const bookable = await loadBookableService(service.id)
      const settings = await getOrCreateBookingSettings(bookable.sacredHouseId)
      return { bookable: settings.bookingEnabled }
    } catch (error) {
      if (error instanceof AppointmentError) return { bookable: false }
      throw error
    }
  })

export const getBookingContextFn = createServerFn({ method: 'GET' })
  .validator(z.object({ serviceSlug: slugSchema }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const service = await getPublishedServiceBySlug(data.serviceSlug)
    if (!service) throw new AppointmentError('Service not found.')
    const eligibility = await canUserBookSpiritualService(user.id)
    try {
      const bookable = await loadBookableService(service.id)
      const settings = await getOrCreateBookingSettings(bookable.sacredHouseId)
      if (!settings.bookingEnabled) {
        return { bookable: false as const, serviceName: service.name }
      }
      return {
        bookable: true as const,
        serviceId: bookable.serviceId,
        serviceSlug: data.serviceSlug,
        serviceName: bookable.serviceName,
        houseName: bookable.houseName,
        houseTimezone: settings.schedulingTimezone,
        durationMinutes: bookable.durationMinutes,
        priceMinor: bookable.priceMinor,
        currency: bookable.currency,
        maximumAdvanceDays: settings.maximumAdvanceDays,
        eligibility,
      }
    } catch (error) {
      if (error instanceof AppointmentError) {
        // Neutral message only — configuration details stay internal.
        return { bookable: false as const, serviceName: service.name }
      }
      throw error
    }
  })

export const getBookingSlotsFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      serviceSlug: slugSchema,
      fromDate: dateSchema,
      toDate: dateSchema,
    }),
  )
  .handler(async ({ data }) => {
    await requireUser()
    const service = await getPublishedServiceBySlug(data.serviceSlug)
    if (!service) throw new AppointmentError('Service not found.')
    return computeAvailableSlots(service.id, data.fromDate, data.toDate)
  })

export const createReservationFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      serviceSlug: slugSchema,
      startsAtUtc: utcSchema,
      privateRequestNote: z.string().max(1500).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    if (reservationLimiter.isBlocked(`reserve:${user.id}`)) {
      throw new AppointmentError(
        'Too many reservation requests. Please wait a few minutes.',
      )
    }
    reservationLimiter.recordFailure(`reserve:${user.id}`)
    const service = await getPublishedServiceBySlug(data.serviceSlug)
    if (!service) throw new AppointmentError('Service not found.')
    return createReservation(user.id, requestContext(), {
      serviceId: service.id,
      startsAtUtc: data.startsAtUtc,
      privateRequestNote: data.privateRequestNote ?? null,
    })
  })

// --- Checkout ---------------------------------------------------------------

export const getCheckoutFn = createServerFn({ method: 'GET' })
  .validator(z.object({ appointmentPublicId: publicIdSchema }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await expireStaleReservations()
    const appointment = await requireOwnedAppointment(
      user.id,
      data.appointmentPublicId,
    )
    const attempts = await getAttemptsForOwnedAppointment(
      user.id,
      data.appointmentPublicId,
    )
    const settlement = await getSettlementForAppointment(appointment.id)
    return {
      appointment: {
        publicId: appointment.publicId,
        status: appointment.status,
        startsAtUtc: appointment.startsAtUtc,
        endsAtUtc: appointment.endsAtUtc,
        userTimezone: appointment.userTimezone,
        houseTimezone: appointment.houseTimezone,
        reservationExpiresAt: appointment.reservationExpiresAt,
        serviceNameSnapshot: appointment.serviceNameSnapshot,
        houseNameSnapshot: appointment.houseNameSnapshot,
        durationMinutesSnapshot: appointment.durationMinutesSnapshot,
        priceMinorSnapshot: appointment.priceMinorSnapshot,
        currencySnapshot: appointment.currencySnapshot,
      },
      providers: listAvailableProviders(appointment.currencySnapshot),
      attempts,
      settled: settlement != null,
    }
  })

export const initiatePaymentFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      appointmentPublicId: publicIdSchema,
      provider: z.enum(['PAYSTACK', 'PAYPAL', 'STRIPE', 'CRYPTO', 'MOCK']),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    return initiatePayment(user.id, requestContext(), {
      appointmentPublicId: data.appointmentPublicId,
      provider: data.provider,
    })
  })

export const reconcilePaymentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ attemptPublicId: publicIdSchema }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    return reconcilePayment(user.id, requestContext(), data.attemptPublicId)
  })

// --- User appointment pages -------------------------------------------------

export const getMyAppointmentsFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const user = await requireUser()
    await expireStaleReservations()
    const rows = await getUserAppointments(user.id)
    const paymentStates = await getLatestAttemptsByAppointment(user.id)
    return rows.map((row) => ({
      ...row,
      payment: paymentStates.get(row.publicId) ?? null,
    }))
  },
)

export const getMyAppointmentFn = createServerFn({ method: 'GET' })
  .validator(z.object({ publicId: publicIdSchema }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    await expireStaleReservations()
    const appointment = await requireOwnedAppointment(user.id, data.publicId)
    const attempts = await getAttemptsForOwnedAppointment(
      user.id,
      data.publicId,
    )
    const settlement = await getSettlementForAppointment(appointment.id)
    const settings = await getOrCreateBookingSettings(appointment.sacredHouseId)
    // Owner-only view: includes the private request note; internal
    // representative assignments are deliberately NOT exposed.
    return {
      appointment: {
        publicId: appointment.publicId,
        status: appointment.status,
        startsAtUtc: appointment.startsAtUtc,
        endsAtUtc: appointment.endsAtUtc,
        userTimezone: appointment.userTimezone,
        houseTimezone: appointment.houseTimezone,
        reservationExpiresAt: appointment.reservationExpiresAt,
        serviceNameSnapshot: appointment.serviceNameSnapshot,
        houseNameSnapshot: appointment.houseNameSnapshot,
        durationMinutesSnapshot: appointment.durationMinutesSnapshot,
        priceMinorSnapshot: appointment.priceMinorSnapshot,
        currencySnapshot: appointment.currencySnapshot,
        privateRequestNote: appointment.privateRequestNote,
        rescheduleCount: appointment.rescheduleCount,
      },
      attempts,
      settled: settlement != null,
      cutoffs: {
        cancellationCutoffMinutes: settings.cancellationCutoffMinutes,
        rescheduleCutoffMinutes: settings.rescheduleCutoffMinutes,
      },
    }
  })

/** Reschedule slot preview: the service is derived from the OWNED
 * appointment server-side — the browser never names it. */
export const getRescheduleSlotsFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      publicId: publicIdSchema,
      fromDate: dateSchema,
      toDate: dateSchema,
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const appointment = await requireOwnedAppointment(user.id, data.publicId)
    return computeAvailableSlots(
      appointment.serviceId,
      data.fromDate,
      data.toDate,
    )
  })

export const cancelMyAppointmentFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      publicId: publicIdSchema,
      reason: z.string().max(500).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const user = await requireUser()
    const appointment = await requireOwnedAppointment(user.id, data.publicId)
    await cancelAppointment(
      { userId: user.id, isOperator: false },
      requestContext(),
      appointment.id,
      data.reason ?? null,
    )
    return { ok: true }
  })

export const rescheduleMyAppointmentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ publicId: publicIdSchema, newStartsAtUtc: utcSchema }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const appointment = await requireOwnedAppointment(user.id, data.publicId)
    await rescheduleAppointment(
      { userId: user.id, isOperator: false },
      requestContext(),
      appointment.id,
      data.newStartsAtUtc,
    )
    return { ok: true }
  })

// --- Payment history & receipt ----------------------------------------------

export const getMyPaymentsFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const user = await requireUser()
    return getUserPaymentHistory(user.id)
  },
)

export const getMyReceiptFn = createServerFn({ method: 'GET' })
  .validator(z.object({ attemptPublicId: publicIdSchema }))
  .handler(async ({ data }) => {
    const user = await requireUser()
    const payment = await getUserPaymentByPublicId(
      user.id,
      data.attemptPublicId,
    )
    if (payment.status !== 'SUCCEEDED') {
      throw new PaymentError('A receipt exists only for successful payments.')
    }
    return payment
  })

// --- Development-only mock payment simulation -------------------------------

const MOCK_SCENARIOS = [
  'success',
  'duplicate_success',
  'failure',
  'cancel',
  'amount_mismatch',
  'currency_mismatch',
] as const

/**
 * Dev/test-only simulator: builds a SIGNED mock event and pushes it
 * through the exact same webhook pipeline as real providers (signature
 * check → event dedupe → central settlement). Hard-blocked in
 * production; owner-checked; MOCK/CRYPTO-mock attempts only. This is
 * NOT a mark-paid button — it exists so development spends no money.
 */
export const simulateMockPaymentFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      attemptPublicId: publicIdSchema,
      scenario: z.enum(MOCK_SCENARIOS),
    }),
  )
  .handler(async ({ data }) => {
    if (env.NODE_ENV === 'production') {
      throw new PaymentError('Not available.')
    }
    const user = await requireUser()
    const attempt = (
      await getDb()
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.publicId, data.attemptPublicId),
            eq(paymentAttempts.userId, user.id),
          ),
        )
        .limit(1)
    ).at(0)
    if (!attempt) throw new PaymentError('Payment not found.')
    if (attempt.provider !== 'MOCK' && attempt.provider !== 'CRYPTO') {
      throw new PaymentError('Simulation is only available for mock attempts.')
    }
    const appointment = (
      await getDb()
        .select({ publicId: appointments.publicId })
        .from(appointments)
        .where(eq(appointments.id, attempt.appointmentId))
        .limit(1)
    ).at(0)
    if (!appointment) throw new PaymentError('Appointment not found.')

    const reference = attempt.providerReference ?? attempt.idempotencyKey
    const scenario = data.scenario
    const amount =
      scenario === 'amount_mismatch'
        ? attempt.amountMinor + 100
        : attempt.amountMinor
    const currency = scenario === 'currency_mismatch' ? 'XTS' : attempt.currency
    const eventId =
      scenario === 'duplicate_success'
        ? `mock-evt-${attempt.publicId}-success`
        : `mock-evt-${attempt.publicId}-${scenario}`

    let webhook
    if (attempt.provider === 'CRYPTO') {
      webhook = buildMockCryptoWebhook(
        {
          id: eventId,
          type:
            scenario === 'failure' || scenario === 'cancel'
              ? 'invoice.expired'
              : 'invoice.paid',
          reference,
          fiatAmountMinor: amount,
          fiatCurrency: currency,
          asset: 'USDC',
          network: 'MOCK-TESTNET',
          paidAtMs: Date.now(),
        },
        // Sign with whatever secret the verifier will actually use —
        // an operator-configured CRYPTO_WEBHOOK_SECRET must not break
        // the dev simulator.
        env.CRYPTO_WEBHOOK_SECRET || undefined,
      )
    } else {
      webhook = buildMockWebhook({
        id: eventId,
        type:
          scenario === 'failure'
            ? 'payment.failed'
            : scenario === 'cancel'
              ? 'payment.cancelled'
              : 'payment.succeeded',
        reference,
        amountMinor: amount,
        currency,
        paidAtMs: Date.now(),
      })
    }
    const result = await processProviderWebhook(
      attempt.provider,
      webhook.rawBody,
      webhook.headers,
    )
    return { httpStatus: result.httpStatus, body: result.body }
  })
