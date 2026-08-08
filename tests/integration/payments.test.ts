import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { eq, getTableColumns, inArray, like, or } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  appointmentPaymentSettlements,
  appointments,
  auditLogs,
  paymentAttempts,
  paymentWebhookEvents,
  sacredHouseAvailability,
  sacredHouseAvailabilityExceptions,
  sacredHouseBookingSettings,
  sacredHouses,
  services,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { assignRoleToUser, userHasPermission } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import { acceptRequiredConsents, savePersonalDetails } from '@/services/profile'
import {
  addAvailabilityWindow,
  getOrCreateBookingSettings,
  updateBookingSettings,
} from '@/services/scheduling'
import { createReservation, cancelAppointment } from '@/services/appointments'
import {
  PaymentError,
  getUserPaymentHistory,
  initiatePayment,
  processProviderWebhook,
  readBodyWithLimit,
  reconcilePayment,
  settleVerifiedPayment,
  paymentInitLimiter,
} from '@/services/payments'
import { createCryptoProvider } from '@/providers/payments/crypto'
import { buildMockWebhook, createMockProvider } from '@/providers/payments/mock'
import { createPaystackProvider } from '@/providers/payments/paystack'
import {
  resetPaymentRegistryForTests,
  setPaymentRegistryForTests,
} from '@/providers/payments/registry'
import {
  addDays,
  currentLocalDate,
  localToUtcMs,
  sqlToUtcMs,
  utcMsToSql,
} from '@/lib/schedule-time'
import type {
  PaymentProvider,
  ProviderTransport,
  VerifiedPaymentResult,
} from '@/providers/payments/types'
import type { PaymentProviderCode } from '@/db/schema'

/**
 * Step 6 payment integration tests against real MariaDB: ledger
 * invariants, initialization authority, the signed-webhook pipeline,
 * the central settlement matrix (live/late/cancelled/mismatch/
 * duplicate) and genuine concurrency races. No live provider network
 * is reachable — every provider in the injected registry uses a mock
 * transport or HMAC fixtures.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `pay test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const HOUSE_TZ = 'Africa/Lagos'
const PAYSTACK_TEST_SECRET = 'sk_test_paystack_integration'

let adminId: number
let cmId: number
let payerA: number
let payerB: number
let houseId: number
let serviceId: number

const today = currentLocalDate(HOUSE_TZ, Date.now())
const D = (n: number) => addDays(today, n)
const slotUtc = (date: string, time: string) =>
  utcMsToSql(localToUtcMs(HOUSE_TZ, date, time))

// Hour-spaced slot allocator (60-minute service, capacity-1 House):
// each test claims a distinct interval so holds never collide.
let slotCursor = 0
function nextSlot(): { date: string; time: string } {
  const hours = [
    '09:00',
    '10:00',
    '11:00',
    '12:00',
    '13:00',
    '14:00',
    '15:00',
    '16:00',
  ]
  const index = slotCursor++
  return {
    date: D(2 + Math.floor(index / hours.length)),
    time: hours[index % hours.length],
  }
}

const paystackCalls: Array<{ url: string; body: string }> = []
let paystackFailNext = false
const paystackTransport: ProviderTransport = (url, init) => {
  if (paystackFailNext) {
    paystackFailNext = false
    return Promise.reject(new Error('simulated network timeout'))
  }
  const body = String(init.body ?? '')
  paystackCalls.push({ url, body })
  if (url.endsWith('/transaction/initialize')) {
    const parsed = JSON.parse(body) as { reference: string }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          status: true,
          data: {
            authorization_url: `https://checkout.paystack.test/${parsed.reference}`,
            access_code: 'acc',
            reference: parsed.reference,
          },
        }),
        { status: 200 },
      ),
    )
  }
  return Promise.resolve(
    new Response(JSON.stringify({ status: false }), { status: 404 }),
  )
}

function defaultTestRegistry(): Array<PaymentProvider> {
  return [
    createMockProvider({ nodeEnv: 'test', enabled: true }),
    // Fiat allowlist deliberately EXCLUDES the appointment currency
    // (NGN) so provider currency gating is observable at checkout.
    createCryptoProvider({
      nodeEnv: 'test',
      enabled: true,
      providerName: 'mock',
      webhookSecret: '',
      fiatCurrencies: ['USD'],
    }),
    createPaystackProvider({
      enabled: true,
      secretKey: PAYSTACK_TEST_SECRET,
      currencies: ['NGN'],
      transport: paystackTransport,
    }),
  ]
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s6-${crypto.randomUUID()}@test.local`,
      preferredName: 'S6 Fixture',
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

async function reserve(userId: number, nowMs: number = Date.now()) {
  const { date, time } = nextSlot()
  return createReservation(
    userId,
    ctx,
    { serviceId, startsAtUtc: slotUtc(date, time) },
    nowMs,
  )
}

let attemptCounter = 0
/** Direct ledger insert for settlement-matrix tests (bypasses the
 * initiation rate limiter; the initiation path has its own tests). */
async function insertAttempt(
  appointmentId: number,
  userId: number,
  overrides: Partial<{
    provider: PaymentProviderCode
    status: 'CREATED' | 'INITIALIZED' | 'PENDING' | 'FAILED'
    amountMinor: number
    currency: string
  }> = {},
) {
  const publicId = crypto.randomUUID()
  const idempotencyKey = `it6_${publicId.replaceAll('-', '')}`
  const inserted = await getDb()
    .insert(paymentAttempts)
    .values({
      publicId,
      appointmentId,
      userId,
      provider: overrides.provider ?? 'MOCK',
      status: overrides.status ?? 'INITIALIZED',
      amountMinor: overrides.amountMinor ?? 500_000,
      currency: overrides.currency ?? 'NGN',
      idempotencyKey,
      providerReference: idempotencyKey,
    })
  attemptCounter += 1
  return { id: inserted[0].insertId, publicId, reference: idempotencyKey }
}

function successFor(
  reference: string,
  overrides: Partial<VerifiedPaymentResult> = {},
): VerifiedPaymentResult {
  return {
    provider: 'MOCK',
    providerReference: reference,
    providerPaymentId: `evt-${attemptCounter}-${crypto.randomUUID().slice(0, 8)}`,
    providerCheckoutId: null,
    attemptPublicId: null,
    outcome: 'SUCCEEDED',
    amountMinor: 500_000,
    currency: 'NGN',
    paidAtSql: null,
    providerStatus: 'payment.succeeded',
    failureCode: null,
    failureMessage: null,
    ...overrides,
  }
}

async function readAttempt(id: number) {
  const row = (
    await getDb()
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, id))
      .limit(1)
  ).at(0)
  if (!row) throw new Error('attempt disappeared')
  return row
}

async function readAppointment(id: number) {
  const row = (
    await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, id))
      .limit(1)
  ).at(0)
  if (!row) throw new Error('appointment disappeared')
  return row
}

async function readSettlement(appointmentId: number) {
  return (
    await getDb()
      .select()
      .from(appointmentPaymentSettlements)
      .where(eq(appointmentPaymentSettlements.appointmentId, appointmentId))
      .limit(1)
  ).at(0)
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  setPaymentRegistryForTests(defaultTestRegistry(), true)

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')
  payerA = await makeEligibleUser()
  payerB = await makeEligibleUser()

  const db = getDb()
  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T6H_${key}`.toUpperCase(),
    name: `T6 House ${key}`,
    slug: `t6h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  const svcInsert = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T6S_${key}`.toUpperCase(),
    name: `T6 Payable ${key}`,
    slug: `t6s-${key}`,
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
  resetPaymentRegistryForTests()
  if (houseId) {
    const apptRows = await db
      .select({ id: appointments.id })
      .from(appointments)
      .where(eq(appointments.sacredHouseId, houseId))
    const apptIds = apptRows.map((row) => row.id)
    if (apptIds.length > 0) {
      const attemptRows = await db
        .select({ id: paymentAttempts.id })
        .from(paymentAttempts)
        .where(inArray(paymentAttempts.appointmentId, apptIds))
      const attemptIds = attemptRows.map((row) => row.id)
      await db
        .delete(paymentWebhookEvents)
        .where(
          or(
            attemptIds.length > 0
              ? inArray(paymentWebhookEvents.paymentAttemptId, attemptIds)
              : undefined,
            like(paymentWebhookEvents.eventKey, 'it6-%'),
            like(paymentWebhookEvents.eventKey, 'subscription.create:%'),
          ),
        )
      await db
        .delete(appointmentPaymentSettlements)
        .where(inArray(appointmentPaymentSettlements.appointmentId, apptIds))
      if (attemptIds.length > 0) {
        await db
          .delete(paymentAttempts)
          .where(inArray(paymentAttempts.id, attemptIds))
      }
      await db.delete(appointments).where(inArray(appointments.id, apptIds))
    }
    await db
      .delete(sacredHouseAvailability)
      .where(eq(sacredHouseAvailability.sacredHouseId, houseId))
    await db
      .delete(sacredHouseAvailabilityExceptions)
      .where(eq(sacredHouseAvailabilityExceptions.sacredHouseId, houseId))
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
  await closeDb()
})

// --- Ledger invariants (§65) ------------------------------------------------

describe('payment ledger', () => {
  it('stores no raw card, wallet-key or seed material anywhere', () => {
    const columns = Object.keys(getTableColumns(paymentAttempts))
      .concat(Object.keys(getTableColumns(appointmentPaymentSettlements)))
      .concat(Object.keys(getTableColumns(paymentWebhookEvents)))
    for (const column of columns) {
      expect(column).not.toMatch(
        /card|cvv|cvc|pan$|seed|privatekey|private_key|mnemonic/i,
      )
    }
  })

  it('creates attempts owned by user+appointment with snapshot money facts', async () => {
    const reservation = await reserve(payerA)
    const result = await initiatePayment(payerA, ctx, {
      appointmentPublicId: reservation.publicId,
      provider: 'MOCK',
    })
    const row = (
      await getDb()
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.publicId, result.attemptPublicId))
        .limit(1)
    ).at(0)
    expect(row).toBeDefined()
    expect(row!.userId).toBe(payerA)
    expect(row!.appointmentId).toBe(reservation.appointmentId)
    // Amount/currency come from the appointment snapshot — the browser
    // never sent money facts.
    expect(row!.amountMinor).toBe(500_000)
    expect(row!.currency).toBe('NGN')
    expect(row!.status).toBe('INITIALIZED')
  })

  it('allows many attempts per appointment; only distinct identities', async () => {
    const reservation = await reserve(payerA)
    const first = await insertAttempt(reservation.appointmentId, payerA)
    // First attempt fails via provider event…
    await settleVerifiedPayment(
      successFor(first.reference, {
        outcome: 'FAILED',
        failureCode: 'declined',
      }),
    )
    expect((await readAttempt(first.id)).status).toBe('FAILED')
    // …then a second attempt with a different identity is fine.
    const second = await insertAttempt(reservation.appointmentId, payerA)
    expect(second.publicId).not.toBe(first.publicId)
    const rows = await getDb()
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.appointmentId, reservation.appointmentId))
    expect(rows.length).toBe(2)
  })

  it('enforces one accepted settlement per appointment at the database level', async () => {
    const reservation = await reserve(payerA)
    const attempt1 = await insertAttempt(reservation.appointmentId, payerA)
    const attempt2 = await insertAttempt(reservation.appointmentId, payerA)
    await getDb().insert(appointmentPaymentSettlements).values({
      appointmentId: reservation.appointmentId,
      paymentAttemptId: attempt1.id,
      resolution: 'APPOINTMENT_CONFIRMED',
    })
    let thrown: unknown = null
    try {
      await getDb().insert(appointmentPaymentSettlements).values({
        appointmentId: reservation.appointmentId,
        paymentAttemptId: attempt2.id,
        resolution: 'PAID_REQUIRES_REVIEW',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).not.toBeNull()
  })
})

// --- Payment initialization (§66) -------------------------------------------

describe('payment initialization', () => {
  it('denies the wrong user', async () => {
    const reservation = await reserve(payerA)
    let thrown: unknown = null
    try {
      await initiatePayment(payerB, ctx, {
        appointmentPublicId: reservation.publicId,
        provider: 'MOCK',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentError)
  })

  it('denies expired reservations and cancelled appointments', async () => {
    const reservation = await reserve(payerA)
    const pastExpiry = sqlToUtcMs(reservation.reservationExpiresAt) + 1000
    let thrown: unknown = null
    try {
      await initiatePayment(
        payerA,
        ctx,
        { appointmentPublicId: reservation.publicId, provider: 'MOCK' },
        pastExpiry,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentError)
    expect((thrown as PaymentError).message).toContain('expired')

    const second = await reserve(payerA)
    await cancelAppointment(
      { userId: payerA, isOperator: false },
      ctx,
      second.appointmentId,
      null,
    )
    let thrownCancelled: unknown = null
    try {
      await initiatePayment(payerA, ctx, {
        appointmentPublicId: second.publicId,
        provider: 'MOCK',
      })
    } catch (error) {
      thrownCancelled = error
    }
    expect(thrownCancelled).toBeInstanceOf(PaymentError)
  })

  it('denies unknown/disabled providers and unsupported currencies', async () => {
    const reservation = await reserve(payerA)
    // STRIPE is not in the test registry at all (disabled provider).
    let thrownStripe: unknown = null
    try {
      await initiatePayment(payerA, ctx, {
        appointmentPublicId: reservation.publicId,
        provider: 'STRIPE',
      })
    } catch (error) {
      thrownStripe = error
    }
    expect(thrownStripe).toBeInstanceOf(PaymentError)
    // CRYPTO is enabled but its fiat allowlist is USD-only — the NGN
    // appointment must not see it (no automatic FX, spec §9/§10).
    let thrownCrypto: unknown = null
    try {
      await initiatePayment(payerA, ctx, {
        appointmentPublicId: reservation.publicId,
        provider: 'CRYPTO',
      })
    } catch (error) {
      thrownCrypto = error
    }
    expect(thrownCrypto).toBeInstanceOf(PaymentError)
  })

  it('a confirmed (settled) appointment cannot start another ordinary attempt', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    const outcome = await settleVerifiedPayment(successFor(attempt.reference))
    expect(outcome.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')
    let thrown: unknown = null
    try {
      await initiatePayment(payerA, ctx, {
        appointmentPublicId: reservation.publicId,
        provider: 'MOCK',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentError)
  })

  it('double-click yields one attempt and one provider identity', async () => {
    const reservation = await reserve(payerB)
    const [first, second] = await Promise.all([
      initiatePayment(payerB, ctx, {
        appointmentPublicId: reservation.publicId,
        provider: 'MOCK',
      }),
      initiatePayment(payerB, ctx, {
        appointmentPublicId: reservation.publicId,
        provider: 'MOCK',
      }),
    ])
    expect(first.attemptPublicId).toBe(second.attemptPublicId)
    const rows = await getDb()
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.appointmentId, reservation.appointmentId))
    expect(rows.length).toBe(1)
  })

  it('ambiguous network failure keeps the attempt retryable with the SAME identity', async () => {
    const reservation = await reserve(payerB)
    paystackFailNext = true
    let thrown: unknown = null
    try {
      await initiatePayment(payerB, ctx, {
        appointmentPublicId: reservation.publicId,
        provider: 'PAYSTACK',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentError)
    const afterFailure = (
      await getDb()
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.appointmentId, reservation.appointmentId))
    ).at(0)
    // NOT failed — the provider may have acted; identity is preserved.
    expect(afterFailure!.status).toBe('CREATED')
    const identityBefore = afterFailure!.idempotencyKey

    const retried = await initiatePayment(payerB, ctx, {
      appointmentPublicId: reservation.publicId,
      provider: 'PAYSTACK',
    })
    expect(retried.checkoutUrl).toContain(identityBefore)
    const afterRetry = await readAttempt(afterFailure!.id)
    expect(afterRetry.status).toBe('INITIALIZED')
    expect(afterRetry.idempotencyKey).toBe(identityBefore)
    // The reference sent to the provider was the same stable identity.
    const initCall = paystackCalls.at(-1)
    expect(initCall!.body).toContain(identityBefore)
  })

  it('sends only minimal metadata to the provider — never notes or spiritual data', async () => {
    const { date, time } = nextSlot()
    const reservation = await createReservation(payerB, ctx, {
      serviceId,
      startsAtUtc: slotUtc(date, time),
      privateRequestNote:
        'Very private family request that must never reach a payment company',
    })
    await initiatePayment(payerB, ctx, {
      appointmentPublicId: reservation.publicId,
      provider: 'PAYSTACK',
    })
    const call = paystackCalls.at(-1)!
    expect(call.body).not.toContain('Very private family request')
    expect(call.body).not.toContain('spiritual')
    expect(call.body).not.toContain('dateOfBirth')
    const metadata = (JSON.parse(call.body) as { metadata: object }).metadata
    expect(Object.keys(metadata).sort()).toEqual([
      'appointmentPublicId',
      'paymentAttemptPublicId',
    ])
  })

  it('rate limits repeated initialization attempts per user', async () => {
    const syntheticUser = 999_999_871
    let blocked: unknown = null
    for (let i = 0; i < 11; i++) {
      try {
        await initiatePayment(syntheticUser, ctx, {
          appointmentPublicId: crypto.randomUUID(),
          provider: 'MOCK',
        })
      } catch (error) {
        blocked = error
      }
    }
    expect(blocked).toBeInstanceOf(PaymentError)
    expect((blocked as PaymentError).message).toContain('Too many')
    expect(paymentInitLimiter.isBlocked(`payinit:${syntheticUser}`)).toBe(true)
  })
})

// --- Webhook pipeline (§6/§28/§41–§43) --------------------------------------

describe('webhook pipeline', () => {
  it('rejects unverifiable requests and records nothing', async () => {
    const attempt = {
      reference: `it6_${crypto.randomUUID().replaceAll('-', '')}`,
    }
    const { rawBody } = buildMockWebhook({
      id: `it6-nosig-${crypto.randomUUID().slice(0, 8)}`,
      type: 'payment.succeeded',
      reference: attempt.reference,
      amountMinor: 500_000,
      currency: 'NGN',
    })
    const noSig = await processProviderWebhook('MOCK', rawBody, {})
    expect(noSig.httpStatus).toBe(400)

    const { rawBody: signed, headers } = buildMockWebhook({
      id: `it6-tamper-${crypto.randomUUID().slice(0, 8)}`,
      type: 'payment.succeeded',
      reference: attempt.reference,
      amountMinor: 500_000,
      currency: 'NGN',
    })
    const mutated = new Uint8Array(signed)
    mutated[mutated.length - 2] = 32
    const tampered = await processProviderWebhook('MOCK', mutated, headers)
    expect(tampered.httpStatus).toBe(400)

    const events = await getDb()
      .select()
      .from(paymentWebhookEvents)
      .where(like(paymentWebhookEvents.eventKey, 'it6-tamper-%'))
    expect(events.length).toBe(0)
  })

  it('refuses oversized payloads', async () => {
    const huge = new Uint8Array(1_000_001)
    const result = await processProviderWebhook('MOCK', huge, {})
    expect(result.httpStatus).toBe(413)
  })

  it('enforces the size cap while STREAMING — chunked bodies with no Content-Length cannot bypass it', async () => {
    const chunk = new Uint8Array(64 * 1024)
    const oversized = new Request('http://localhost/api/webhooks/paystack', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 20; i++) controller.enqueue(chunk)
          controller.close()
        },
      }),
    })
    // 20 × 64KiB ≈ 1.25MB streamed without a Content-Length header.
    expect(await readBodyWithLimit(oversized, 1_000_000)).toBeNull()

    const small = new Request('http://localhost/api/webhooks/paystack', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'))
          controller.close()
        },
      }),
    })
    const bytes = await readBodyWithLimit(small, 1_000_000)
    expect(bytes).not.toBeNull()
    expect(new TextDecoder().decode(bytes!)).toBe('{"ok":true}')

    // A lying Content-Length header is rejected up front.
    const lying = new Request('http://localhost/api/webhooks/paystack', {
      method: 'POST',
      headers: { 'content-length': '5000000' },
      body: 'tiny',
    })
    expect(await readBodyWithLimit(lying, 1_000_000)).toBeNull()
  })

  it('processes a valid success end-to-end: verify → dedupe → settle → confirm', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    const eventId = `it6-ok-${crypto.randomUUID().slice(0, 8)}`
    const { rawBody, headers } = buildMockWebhook({
      id: eventId,
      type: 'payment.succeeded',
      reference: attempt.reference,
      amountMinor: 500_000,
      currency: 'NGN',
      paidAtMs: Date.now(),
    })
    const result = await processProviderWebhook('MOCK', rawBody, headers)
    expect(result.httpStatus).toBe(200)

    expect((await readAttempt(attempt.id)).status).toBe('SUCCEEDED')
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'CONFIRMED',
    )
    const settlement = await readSettlement(reservation.appointmentId)
    expect(settlement?.resolution).toBe('APPOINTMENT_CONFIRMED')
    const event = (
      await getDb()
        .select()
        .from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.eventKey, eventId))
        .limit(1)
    ).at(0)
    expect(event?.processingStatus).toBe('PROCESSED')
    expect(event?.paymentAttemptId).toBe(attempt.id)

    // Exact duplicate delivery: acknowledged without reprocessing.
    const duplicate = await processProviderWebhook('MOCK', rawBody, headers)
    expect(duplicate.httpStatus).toBe(200)
    expect(duplicate.body).toBe('duplicate')

    // Same success under a NEW event id (callback + webhook both
    // verifying): business idempotency yields one settlement.
    const { rawBody: retryBody, headers: retryHeaders } = buildMockWebhook({
      id: `it6-ok2-${crypto.randomUUID().slice(0, 8)}`,
      type: 'payment.succeeded',
      reference: attempt.reference,
      amountMinor: 500_000,
      currency: 'NGN',
    })
    const replay = await processProviderWebhook('MOCK', retryBody, retryHeaders)
    expect(replay.httpStatus).toBe(200)
    const settlements = await getDb()
      .select()
      .from(appointmentPaymentSettlements)
      .where(
        eq(
          appointmentPaymentSettlements.appointmentId,
          reservation.appointmentId,
        ),
      )
    expect(settlements.length).toBe(1)
  })

  it('marks unmatched events FAILED and retries them safely on redelivery', async () => {
    const reference = `it6_${crypto.randomUUID().replaceAll('-', '')}`
    const eventId = `it6-late-attempt-${crypto.randomUUID().slice(0, 8)}`
    const { rawBody, headers } = buildMockWebhook({
      id: eventId,
      type: 'payment.succeeded',
      reference,
      amountMinor: 500_000,
      currency: 'NGN',
    })
    const first = await processProviderWebhook('MOCK', rawBody, headers)
    expect(first.httpStatus).toBe(500)
    const failedEvent = (
      await getDb()
        .select()
        .from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.eventKey, eventId))
        .limit(1)
    ).at(0)
    expect(failedEvent?.processingStatus).toBe('FAILED')

    // The attempt appears (e.g. replica lag resolved / attempt created)
    // and the provider redelivers the SAME event: it must process now —
    // the unique key must not make FAILED events ignored forever.
    const reservation = await reserve(payerA)
    const db = getDb()
    const publicId = crypto.randomUUID()
    await db.insert(paymentAttempts).values({
      publicId,
      appointmentId: reservation.appointmentId,
      userId: payerA,
      provider: 'MOCK',
      status: 'INITIALIZED',
      amountMinor: 500_000,
      currency: 'NGN',
      idempotencyKey: reference,
      providerReference: reference,
    })
    const redelivered = await processProviderWebhook('MOCK', rawBody, headers)
    expect(redelivered.httpStatus).toBe(200)
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'CONFIRMED',
    )
  })

  it('records authenticated-but-irrelevant provider events as IGNORED', async () => {
    const payload = { event: 'subscription.create', data: { id: 5 } }
    const rawBody = new TextEncoder().encode(JSON.stringify(payload))
    const { createHmac } = await import('node:crypto')
    const sig = createHmac('sha512', PAYSTACK_TEST_SECRET)
      .update(rawBody)
      .digest('hex')
    const result = await processProviderWebhook('PAYSTACK', rawBody, {
      'x-paystack-signature': sig,
    })
    expect(result.httpStatus).toBe(200)
    expect(result.body).toBe('ignored')
    const event = (
      await getDb()
        .select()
        .from(paymentWebhookEvents)
        .where(eq(paymentWebhookEvents.eventKey, 'subscription.create:5'))
        .limit(1)
    ).at(0)
    expect(event?.processingStatus).toBe('IGNORED')
  })
})

// --- Central settlement matrix (§33–§38, §71) -------------------------------

describe('verified payment settlement', () => {
  it('live reservation + exact payment → SUCCEEDED / settlement / CONFIRMED', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    const outcome = await settleVerifiedPayment(successFor(attempt.reference))
    expect(outcome.status).toBe('SUCCEEDED')
    expect(outcome.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')
    expect(outcome.reviewReason).toBeNull()
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'CONFIRMED',
    )
    const settlement = await readSettlement(reservation.appointmentId)
    expect(settlement?.paymentAttemptId).toBe(attempt.id)
  })

  it('LOCKED late-payment rule: money recorded, appointment NOT resurrected', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    const lateNow = sqlToUtcMs(reservation.reservationExpiresAt) + 60_000
    const outcome = await settleVerifiedPayment(
      successFor(attempt.reference),
      ctx,
      lateNow,
    )
    expect(outcome.status).toBe('SUCCEEDED')
    expect(outcome.resolutionStatus).toBe('PAID_REQUIRES_REVIEW')
    expect(outcome.reviewReason).toBe('RESERVATION_EXPIRED')
    const appointment = await readAppointment(reservation.appointmentId)
    expect(appointment.status).toBe('EXPIRED')
    // The single accepted settlement records the review resolution.
    const settlement = await readSettlement(reservation.appointmentId)
    expect(settlement?.resolution).toBe('PAID_REQUIRES_REVIEW')
  })

  it('expiry boundary is deterministic: expiry instant is expired, one second earlier is live', async () => {
    const first = await reserve(payerA)
    const attemptExact = await insertAttempt(first.appointmentId, payerA)
    const boundary = sqlToUtcMs(first.reservationExpiresAt)
    const exact = await settleVerifiedPayment(
      successFor(attemptExact.reference),
      ctx,
      boundary,
    )
    expect(exact.reviewReason).toBe('RESERVATION_EXPIRED')

    const second = await reserve(payerA)
    const attemptLive = await insertAttempt(second.appointmentId, payerA)
    const justBefore = sqlToUtcMs(second.reservationExpiresAt) - 1000
    const live = await settleVerifiedPayment(
      successFor(attemptLive.reference),
      ctx,
      justBefore,
    )
    expect(live.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')
  })

  it('payment after cancellation → review, appointment untouched', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    await cancelAppointment(
      { userId: payerA, isOperator: false },
      ctx,
      reservation.appointmentId,
      null,
    )
    const outcome = await settleVerifiedPayment(successFor(attempt.reference))
    expect(outcome.resolutionStatus).toBe('PAID_REQUIRES_REVIEW')
    expect(outcome.reviewReason).toBe('APPOINTMENT_NOT_CONFIRMABLE')
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'CANCELLED',
    )
  })

  it('amount/currency mismatches are recorded but never confirm', async () => {
    const reservation = await reserve(payerA)
    const attemptAmount = await insertAttempt(reservation.appointmentId, payerA)
    const amountOutcome = await settleVerifiedPayment(
      successFor(attemptAmount.reference, { amountMinor: 499_900 }),
    )
    expect(amountOutcome.status).toBe('SUCCEEDED')
    expect(amountOutcome.reviewReason).toBe('AMOUNT_MISMATCH')
    // Not confirmed; the hold remains payable until it expires.
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'PENDING_PAYMENT',
    )

    const attemptCurrency = await insertAttempt(
      reservation.appointmentId,
      payerA,
    )
    const currencyOutcome = await settleVerifiedPayment(
      successFor(attemptCurrency.reference, { currency: 'USD' }),
    )
    expect(currencyOutcome.reviewReason).toBe('CURRENCY_MISMATCH')
    // Appointment price was never silently altered.
    const appointment = await readAppointment(reservation.appointmentId)
    expect(appointment.priceMinorSnapshot).toBe(500_000)
    expect(appointment.currencySnapshot).toBe('NGN')

    // Mismatched money never claims the settlement slot: a subsequent
    // CORRECT payment on the still-live hold must still confirm.
    expect(await readSettlement(reservation.appointmentId)).toBeUndefined()
    const attemptCorrect = await insertAttempt(
      reservation.appointmentId,
      payerA,
    )
    const correctOutcome = await settleVerifiedPayment(
      successFor(attemptCorrect.reference),
    )
    expect(correctOutcome.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'CONFIRMED',
    )
    // The mismatched attempts remain SUCCEEDED/review — evidence kept.
    expect((await readAttempt(attemptAmount.id)).resolutionStatus).toBe(
      'PAID_REQUIRES_REVIEW',
    )
  })

  it('provider reference/identity mismatch goes to review', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    const outcome = await settleVerifiedPayment(
      successFor(attempt.reference, {
        attemptPublicId: crypto.randomUUID(),
      }),
    )
    expect(outcome.reviewReason).toBe('PROVIDER_REFERENCE_MISMATCH')
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'PENDING_PAYMENT',
    )
  })

  it('duplicate success on a settled appointment preserves the original settlement', async () => {
    const reservation = await reserve(payerA)
    const original = await insertAttempt(reservation.appointmentId, payerA)
    await settleVerifiedPayment(successFor(original.reference))

    const duplicate = await insertAttempt(reservation.appointmentId, payerA, {
      provider: 'CRYPTO',
    })
    const outcome = await settleVerifiedPayment(
      successFor(duplicate.reference, { provider: 'CRYPTO' }),
    )
    expect(outcome.status).toBe('SUCCEEDED')
    expect(outcome.reviewReason).toBe('DUPLICATE_SUCCESS')
    const settlement = await readSettlement(reservation.appointmentId)
    expect(settlement?.paymentAttemptId).toBe(original.id)
    expect(settlement?.resolution).toBe('APPOINTMENT_CONFIRMED')
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'CONFIRMED',
    )
  })

  it('settling the same success twice is a no-op the second time', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    const first = await settleVerifiedPayment(successFor(attempt.reference))
    expect(first.alreadyProcessed).toBe(false)
    const second = await settleVerifiedPayment(successFor(attempt.reference))
    expect(second.alreadyProcessed).toBe(true)
    expect(second.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')
  })

  it('failure/cancel events never overwrite SUCCEEDED (§38)', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    await settleVerifiedPayment(successFor(attempt.reference))
    const lateFailure = await settleVerifiedPayment(
      successFor(attempt.reference, {
        outcome: 'FAILED',
        failureCode: 'delayed_event',
      }),
    )
    expect(lateFailure.status).toBe('SUCCEEDED')
    expect(lateFailure.alreadyProcessed).toBe(true)
    expect((await readAttempt(attempt.id)).status).toBe('SUCCEEDED')
  })

  it('an out-of-order success after a failure event still wins (money truth)', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA)
    await settleVerifiedPayment(
      successFor(attempt.reference, { outcome: 'FAILED' }),
    )
    expect((await readAttempt(attempt.id)).status).toBe('FAILED')
    const success = await settleVerifiedPayment(successFor(attempt.reference))
    expect(success.status).toBe('SUCCEEDED')
    expect(success.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')
  })
})

// --- Concurrency (§72) ------------------------------------------------------

describe('settlement concurrency', () => {
  it('two providers succeeding concurrently → exactly one accepted confirmation', async () => {
    const reservation = await reserve(payerB)
    const mockAttempt = await insertAttempt(reservation.appointmentId, payerB)
    const cryptoAttempt = await insertAttempt(
      reservation.appointmentId,
      payerB,
      {
        provider: 'CRYPTO',
      },
    )
    const results = await Promise.allSettled([
      settleVerifiedPayment(successFor(mockAttempt.reference)),
      settleVerifiedPayment(
        successFor(cryptoAttempt.reference, { provider: 'CRYPTO' }),
      ),
    ])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const outcomes = results.map(
      (r) => (r as PromiseFulfilledResult<{ resolutionStatus: string }>).value,
    )
    const confirmedCount = outcomes.filter(
      (o) => o.resolutionStatus === 'APPOINTMENT_CONFIRMED',
    ).length
    const reviewCount = outcomes.filter(
      (o) => o.resolutionStatus === 'PAID_REQUIRES_REVIEW',
    ).length
    expect(confirmedCount).toBe(1)
    expect(reviewCount).toBe(1)
    const settlements = await getDb()
      .select()
      .from(appointmentPaymentSettlements)
      .where(
        eq(
          appointmentPaymentSettlements.appointmentId,
          reservation.appointmentId,
        ),
      )
    expect(settlements.length).toBe(1)
    expect(settlements[0].resolution).toBe('APPOINTMENT_CONFIRMED')
    expect((await readAppointment(reservation.appointmentId)).status).toBe(
      'CONFIRMED',
    )
    // Both attempts recorded as SUCCEEDED — no money evidence lost.
    expect((await readAttempt(mockAttempt.id)).status).toBe('SUCCEEDED')
    expect((await readAttempt(cryptoAttempt.id)).status).toBe('SUCCEEDED')
  })

  it('webhook + callback processing the same success concurrently → one transition', async () => {
    const reservation = await reserve(payerB)
    const attempt = await insertAttempt(reservation.appointmentId, payerB)
    const verified = successFor(attempt.reference)
    const results = await Promise.allSettled([
      settleVerifiedPayment(verified),
      settleVerifiedPayment(verified),
    ])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const outcomes = results.map(
      (r) => (r as PromiseFulfilledResult<{ alreadyProcessed: boolean }>).value,
    )
    expect(outcomes.filter((o) => !o.alreadyProcessed).length).toBe(1)
    const settlements = await getDb()
      .select()
      .from(appointmentPaymentSettlements)
      .where(
        eq(
          appointmentPaymentSettlements.appointmentId,
          reservation.appointmentId,
        ),
      )
    expect(settlements.length).toBe(1)
  })

  it('a late success can never steal a slot already reallocated and confirmed', async () => {
    // A reserves a slot and lets it expire; B reserves the SAME slot
    // after expiry and pays. A's money then arrives late.
    const { date, time } = nextSlot()
    const startsAtUtc = slotUtc(date, time)
    const reservationA = await createReservation(payerA, ctx, {
      serviceId,
      startsAtUtc,
    })
    const attemptA = await insertAttempt(reservationA.appointmentId, payerA)
    const afterExpiry = sqlToUtcMs(reservationA.reservationExpiresAt) + 60_000

    const reservationB = await createReservation(
      payerB,
      ctx,
      { serviceId, startsAtUtc },
      afterExpiry,
    )
    const attemptB = await insertAttempt(reservationB.appointmentId, payerB)
    const confirmB = await settleVerifiedPayment(
      successFor(attemptB.reference),
      ctx,
      afterExpiry,
    )
    expect(confirmB.resolutionStatus).toBe('APPOINTMENT_CONFIRMED')

    const lateA = await settleVerifiedPayment(
      successFor(attemptA.reference),
      ctx,
      afterExpiry + 1000,
    )
    expect(lateA.status).toBe('SUCCEEDED')
    expect(lateA.reviewReason).toBe('RESERVATION_EXPIRED')
    expect((await readAppointment(reservationA.appointmentId)).status).toBe(
      'EXPIRED',
    )
    expect((await readAppointment(reservationB.appointmentId)).status).toBe(
      'CONFIRMED',
    )
  })
})

// --- Reconciliation & security (§26, §73) -----------------------------------

describe('reconciliation and security boundaries', () => {
  it('a user cannot reconcile (or capture) another user’s attempt', async () => {
    const reservation = await reserve(payerA)
    const result = await initiatePayment(payerA, ctx, {
      appointmentPublicId: reservation.publicId,
      provider: 'MOCK',
    })
    let thrown: unknown = null
    try {
      await reconcilePayment(payerB, ctx, result.attemptPublicId)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PaymentError)
  })

  it('reconciling a CREATED attempt never strands it — identity stays reusable', async () => {
    const reservation = await reserve(payerA)
    const attempt = await insertAttempt(reservation.appointmentId, payerA, {
      status: 'CREATED',
    })
    const attemptRow = await readAttempt(attempt.id)
    const reconciled = await reconcilePayment(payerA, ctx, attemptRow.publicId)
    // Mock verify reports PENDING; the CREATED attempt must remain
    // CREATED (not PENDING) so a re-initialization can reuse the SAME
    // idempotency identity after an ambiguous provider failure.
    expect(reconciled.status).toBe('CREATED')
    expect((await readAttempt(attempt.id)).status).toBe('CREATED')
  })

  it('returning from a provider (callback alone) never confirms anything', async () => {
    const reservation = await reserve(payerA)
    const result = await initiatePayment(payerA, ctx, {
      appointmentPublicId: reservation.publicId,
      provider: 'MOCK',
    })
    // Mock verify reports PENDING — exactly what a query-string-only
    // "success" return amounts to without provider truth.
    const reconciled = await reconcilePayment(
      payerA,
      ctx,
      result.attemptPublicId,
    )
    expect(reconciled.status).toBe('INITIALIZED')
    expect(reconciled.appointmentStatus).toBe('PENDING_PAYMENT')
    expect(await readSettlement(reservation.appointmentId)).toBeUndefined()
  })

  it('payments permissions: ADMIN/SUPER_ADMIN only', async () => {
    expect(await userHasPermission(adminId, 'payments.view')).toBe(true)
    expect(await userHasPermission(adminId, 'payments.manage')).toBe(true)
    expect(await userHasPermission(cmId, 'payments.view')).toBe(false)
    expect(await userHasPermission(cmId, 'payments.manage')).toBe(false)
    expect(await userHasPermission(payerA, 'payments.view')).toBe(false)
  })

  it('users see only their own payment history', async () => {
    const historyA = await getUserPaymentHistory(payerA)
    expect(historyA.length).toBeGreaterThan(0)
    const historyB = await getUserPaymentHistory(payerB)
    const publicIdsB = new Set(historyB.map((row) => row.publicId))
    for (const row of historyA) {
      expect(publicIdsB.has(row.publicId)).toBe(false)
    }
  })

  it('no manual mark-paid / force-success path exists anywhere', () => {
    const root = process.cwd()
    const targets: Array<string> = []
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) collect(full)
        else if (/\.(ts|tsx)$/.test(entry)) targets.push(full)
      }
    }
    collect(join(root, 'src', 'services'))
    collect(join(root, 'src', 'routes'))
    for (const file of targets) {
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(
        /markPaid|mark_paid|forcePayment|forceSuccess|markAsPaid/i,
      )
      // No UI or action ever offers a manual payment-success control.
      expect(source).not.toMatch(
        /Mark Paid|Force Success|Override Payment|Payment Received/,
      )
    }
  })

  it('webhook CSRF exemption is exact-path only with signature enforcement instead', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'start.ts'), 'utf8')
    for (const path of [
      '/api/webhooks/paystack',
      '/api/webhooks/stripe',
      '/api/webhooks/paypal',
      '/api/webhooks/crypto',
    ]) {
      expect(source).toContain(`'${path}'`)
    }
    // Exact-set membership — no prefix/wildcard trust.
    expect(source).toContain('WEBHOOK_EXEMPT_PATHS.has(')
    expect(source).not.toContain("startsWith('/api/webhooks")
  })
})
