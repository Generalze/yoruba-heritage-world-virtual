import { randomUUID } from 'node:crypto'

import { and, desc, eq, gte, inArray, lte, or } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  appointmentPaymentSettlements,
  appointments,
  paymentAttempts,
  paymentWebhookEvents,
  users,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { FixedWindowRateLimiter } from '@/auth/rate-limit'
import { env } from '@/lib/env'
import { utcMsToSql } from '@/lib/schedule-time'
import { sha256Hex } from '@/providers/payments/http'
import {
  getPaymentProvider,
  getWebhookProvider,
  listAvailableProviders,
} from '@/providers/payments/registry'
import { PaymentProviderError } from '@/providers/payments/types'
import { AppointmentError, confirmReservationUnderLock } from './appointments'
import type { GuidanceAssignmentSummary } from './guidance'
import { getOrCreateBookingSettings, lockHouseScheduling } from './scheduling'
import type {
  PaymentAttemptStatus,
  PaymentProviderCode,
  PaymentResolutionStatus,
  PaymentReviewReason,
  SettlementResolution,
} from '@/db/schema'
import type {
  AttemptIdentity,
  VerifiedPaymentResult,
} from '@/providers/payments/types'
import type { RequestContext } from '@/auth/service'

/**
 * Central payment domain (Step 6).
 *
 * settleVerifiedPayment() is the ONLY path that converts provider
 * success into appointment confirmation — adapters and webhook routes
 * never implement settlement rules themselves, and the confirmation
 * invariants live solely in the shared Step 5 primitive
 * confirmReservationUnderLock().
 *
 * Locked money rules:
 * - amount/currency truth is the appointment snapshot, compared exactly
 * - one accepted settlement per appointment (settlement PK)
 * - provider success is ALWAYS recorded, even late/duplicate/mismatched
 *   — resolution then becomes PAID_REQUIRES_REVIEW, never a silent
 *   confirmation and never lost money evidence
 * - success is terminal: no failure/cancel event ever overwrites it
 * - there is NO manual mark-paid path for any role
 *
 * Lock order everywhere (matches Step 5, no cycles):
 *   House booking-settings row → appointment row → payment attempt row.
 */

export class PaymentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PaymentError'
  }
}

/** Server-side abuse limits (spec §54): bounded in-memory fixed-window
 * limiters, same architecture as login protection. No Redis. */
export const paymentInitLimiter = new FixedWindowRateLimiter(10, 15 * 60_000)
export const paymentReconcileLimiter = new FixedWindowRateLimiter(
  30,
  15 * 60_000,
)
/** Caps audit rows for UNVERIFIED webhook posts (the 400 response is
 * unaffected): an unauthenticated flood must not grow audit_logs
 * unboundedly. Verified events are audited normally. */
export const webhookFailureAuditLimiter = new FixedWindowRateLimiter(
  30,
  60 * 60_000,
)

function requireNotRateLimited(
  limiter: FixedWindowRateLimiter,
  key: string,
): void {
  if (limiter.isBlocked(key)) {
    throw new PaymentError(
      'Too many payment requests. Please wait a few minutes and try again.',
    )
  }
  limiter.recordFailure(key)
}

// --- Attempt identity -------------------------------------------------------

function toAttemptIdentity(row: {
  publicId: string
  idempotencyKey: string
  amountMinor: number
  currency: string
  providerReference: string | null
  providerPaymentId: string | null
  providerCheckoutId: string | null
}): AttemptIdentity {
  return {
    publicId: row.publicId,
    idempotencyKey: row.idempotencyKey,
    amountMinor: row.amountMinor,
    currency: row.currency,
    providerReference: row.providerReference,
    providerPaymentId: row.providerPaymentId,
    providerCheckoutId: row.providerCheckoutId,
  }
}

async function loadOwnedAppointment(userId: number, publicId: string) {
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
  if (!row) throw new PaymentError('Appointment not found.')
  return row
}

export async function getSettlementForAppointment(appointmentId: number) {
  return (
    await getDb()
      .select()
      .from(appointmentPaymentSettlements)
      .where(eq(appointmentPaymentSettlements.appointmentId, appointmentId))
      .limit(1)
  ).at(0)
}

// --- Payment initialization (spec §17/§18/§19) ------------------------------

export interface InitiatePaymentResult {
  attemptPublicId: string
  provider: PaymentProviderCode
  checkoutUrl: string | null
  cryptoQuote: {
    quotedAsset: string
    quotedAmount: string
    quotedNetwork: string
    quoteExpiresAt: string
  } | null
}

/** In-process per-attempt serialization of provider initialization
 * calls: a double-click awaits the in-flight call instead of racing a
 * second provider request (single-instance architecture). */
const inFlightInitializations = new Map<
  number,
  Promise<InitiatePaymentResult>
>()

export async function initiatePayment(
  userId: number,
  ctx: RequestContext,
  input: { appointmentPublicId: string; provider: string },
  nowMs: number = Date.now(),
): Promise<InitiatePaymentResult> {
  requireNotRateLimited(paymentInitLimiter, `payinit:${userId}`)

  const appointment = await loadOwnedAppointment(
    userId,
    input.appointmentPublicId,
  )
  const nowSql = utcMsToSql(nowMs)
  if (appointment.status !== 'PENDING_PAYMENT') {
    throw new PaymentError('This appointment is not awaiting payment.')
  }
  if (
    !appointment.reservationExpiresAt ||
    appointment.reservationExpiresAt <= nowSql
  ) {
    throw new PaymentError(
      'This reservation has expired. Please start a new booking.',
    )
  }
  const settlement = await getSettlementForAppointment(appointment.id)
  if (settlement) {
    throw new PaymentError('This appointment already has a completed payment.')
  }

  // Provider availability: global switch + provider switch + credentials
  // + operator currency allowlist — all server-side.
  const available = listAvailableProviders(appointment.currencySnapshot)
  const chosen = available.find((p) => p.code === input.provider)
  if (!chosen) {
    throw new PaymentError(
      'That payment method is not available for this appointment.',
    )
  }
  const provider = getPaymentProvider(chosen.code)
  if (!provider) {
    throw new PaymentError(
      'That payment method is not available for this appointment.',
    )
  }

  // Serialize attempt selection/creation on the appointment row so a
  // double-click cannot create two live attempts for one provider.
  const attemptRow = await getDb().transaction(async (tx) => {
    const lockedAppointment = (
      await tx
        .select()
        .from(appointments)
        .where(eq(appointments.id, appointment.id))
        .limit(1)
        .for('update')
    ).at(0)
    // Fresh in-lock clock (same discipline as confirmation): pre-lock
    // latency behind a long settlement/reschedule transaction must
    // never make an already-expired hold look live. The injected nowMs
    // can only tighten the check, never loosen it.
    const inLockNowSql = utcMsToSql(Math.max(nowMs, Date.now()))
    if (
      !lockedAppointment ||
      lockedAppointment.status !== 'PENDING_PAYMENT' ||
      !lockedAppointment.reservationExpiresAt ||
      lockedAppointment.reservationExpiresAt <= inLockNowSql
    ) {
      throw new PaymentError('This appointment is not awaiting payment.')
    }
    const reusable = (
      await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.appointmentId, appointment.id),
            eq(paymentAttempts.provider, provider.code),
            inArray(paymentAttempts.status, ['CREATED', 'INITIALIZED']),
          ),
        )
        .orderBy(desc(paymentAttempts.id))
        .limit(1)
        .for('update')
    ).at(0)
    if (reusable) return { row: reusable, created: false }

    const publicId = randomUUID()
    // Server-generated stable identity: doubles as the Paystack
    // reference / Stripe Idempotency-Key / PayPal-Request-Id.
    const idempotencyKey = `yhwv_${publicId.replaceAll('-', '')}`
    const inserted = await tx.insert(paymentAttempts).values({
      publicId,
      appointmentId: appointment.id,
      userId,
      provider: provider.code,
      status: 'CREATED',
      amountMinor: lockedAppointment.priceMinorSnapshot,
      currency: lockedAppointment.currencySnapshot,
      idempotencyKey,
      providerReference: idempotencyKey,
      expiresAt: lockedAppointment.reservationExpiresAt,
    })
    const row = (
      await tx
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, inserted[0].insertId))
        .limit(1)
    ).at(0)
    if (!row) throw new PaymentError('Payment could not be started.')
    return { row, created: true }
  })

  if (attemptRow.created) {
    await recordAuditEvent({
      actorUserId: userId,
      action: 'payment.attempt_created',
      entityType: 'payment_attempt',
      entityId: String(attemptRow.row.id),
      metadata: {
        publicId: attemptRow.row.publicId,
        appointmentPublicId: appointment.publicId,
        provider: provider.code,
        amountMinor: attemptRow.row.amountMinor,
        currency: attemptRow.row.currency,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  }

  const attempt = attemptRow.row
  // Idempotent double-click: an already initialized attempt returns its
  // stored checkout details without a second provider call. (INITIALIZED
  // is only ever set after a successful provider initialization, so
  // hosted providers always have their checkout URL here; mock/crypto
  // attempts legitimately have none and use the inline simulator.)
  if (attempt.status === 'INITIALIZED') {
    return {
      attemptPublicId: attempt.publicId,
      provider: attempt.provider,
      checkoutUrl: attempt.checkoutUrl,
      cryptoQuote:
        attempt.quotedAsset &&
        attempt.quotedAmount &&
        attempt.quotedNetwork &&
        attempt.quoteExpiresAt
          ? {
              quotedAsset: attempt.quotedAsset,
              quotedAmount: attempt.quotedAmount,
              quotedNetwork: attempt.quotedNetwork,
              quoteExpiresAt: attempt.quoteExpiresAt,
            }
          : null,
    }
  }

  const inFlight = inFlightInitializations.get(attempt.id)
  if (inFlight) return inFlight

  const initialization = (async (): Promise<InitiatePaymentResult> => {
    const userRow = (
      await getDb()
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    ).at(0)
    if (!userRow) throw new PaymentError('Account not found.')

    // Return/cancel URLs are ALWAYS derived from APP_BASE_URL (spec
    // §56) — never from browser parameters.
    const base = env.APP_BASE_URL.replace(/\/+$/, '')
    const returnUrl = `${base}/payments/return/${provider.code.toLowerCase()}?attempt=${attempt.publicId}`
    const cancelUrl = `${base}/checkout/${appointment.publicId}?cancelled=1`

    let initResult
    try {
      initResult = await provider.initializePayment({
        attempt: toAttemptIdentity(attempt),
        appointmentPublicId: appointment.publicId,
        userEmail: userRow.email,
        returnUrl,
        cancelUrl,
      })
    } catch (error) {
      if (error instanceof PaymentProviderError && !error.retryable) {
        // Explicit provider rejection → the attempt may be FAILED.
        await getDb()
          .update(paymentAttempts)
          .set({
            status: 'FAILED',
            failedAt: utcMsToSql(Date.now()),
            failureCode: error.code.slice(0, 64),
            failureMessage: error.message.slice(0, 255),
          })
          .where(
            and(
              eq(paymentAttempts.id, attempt.id),
              inArray(paymentAttempts.status, ['CREATED', 'INITIALIZED']),
            ),
          )
        await recordAuditEvent({
          actorUserId: userId,
          action: 'payment.failed',
          entityType: 'payment_attempt',
          entityId: String(attempt.id),
          metadata: {
            publicId: attempt.publicId,
            provider: provider.code,
            failureCode: error.code,
            stage: 'initialization',
          },
          ipAddress: ctx.ipAddress,
          userAgent: ctx.userAgent,
        })
        throw new PaymentError(
          'The payment provider declined to start this payment. Please try another method.',
        )
      }
      if (
        error instanceof PaymentProviderError &&
        error.code === 'PAYSTACK_DUPLICATE_REFERENCE'
      ) {
        // An earlier initialize with this same idempotent reference DID
        // reach the provider (its response was lost). Recover the real
        // state instead of guessing: if the transaction was actually
        // paid, settle it through the central path right now.
        try {
          const verified = await provider.verifyPayment(
            toAttemptIdentity(attempt),
          )
          if (verified.outcome === 'SUCCEEDED') {
            await settleVerifiedPayment(verified, ctx)
            throw new PaymentError(
              'This payment was already completed. Check your appointment status.',
            )
          }
        } catch (recoveryError) {
          if (recoveryError instanceof PaymentError) throw recoveryError
          // Verification transport failure: fall through to the generic
          // retry message — the attempt is still CREATED and recoverable.
        }
        throw new PaymentError(
          'This payment is already open with the provider. Use "Check payment status" on your appointment, or contact support.',
        )
      }
      // Ambiguous network failure: the provider may have created a
      // transaction. The attempt stays CREATED with the SAME
      // idempotency identity so a retry can never double-charge.
      throw new PaymentError(
        'The payment provider could not be reached. Please try again — your payment was not lost.',
      )
    }

    const updated = await getDb()
      .update(paymentAttempts)
      .set({
        status: 'INITIALIZED',
        initializedAt: utcMsToSql(Date.now()),
        checkoutUrl: initResult.checkoutUrl,
        providerReference: initResult.providerReference,
        providerPaymentId: initResult.providerPaymentId,
        providerCheckoutId: initResult.providerCheckoutId,
        providerStatus: initResult.providerStatus,
        quotedAsset: initResult.cryptoQuote?.quotedAsset ?? null,
        quotedAmount: initResult.cryptoQuote?.quotedAmount ?? null,
        quotedNetwork: initResult.cryptoQuote?.quotedNetwork ?? null,
        quoteExpiresAt: initResult.cryptoQuote?.quoteExpiresAt ?? null,
      })
      .where(
        and(
          eq(paymentAttempts.id, attempt.id),
          eq(paymentAttempts.status, 'CREATED'),
        ),
      )
    if (updated[0].affectedRows !== 1) {
      // A concurrent settle/expire beat us — re-read and report honestly.
      const fresh = (
        await getDb()
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, attempt.id))
          .limit(1)
      ).at(0)
      if (!fresh || fresh.status !== 'INITIALIZED') {
        throw new PaymentError(
          'This payment attempt is no longer open. Refresh the page to see its status.',
        )
      }
    }
    await recordAuditEvent({
      actorUserId: userId,
      action: 'payment.initialized',
      entityType: 'payment_attempt',
      entityId: String(attempt.id),
      metadata: {
        publicId: attempt.publicId,
        provider: provider.code,
        providerReference: initResult.providerReference,
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
    return {
      attemptPublicId: attempt.publicId,
      provider: provider.code,
      checkoutUrl: initResult.checkoutUrl,
      cryptoQuote: initResult.cryptoQuote,
    }
  })()

  inFlightInitializations.set(attempt.id, initialization)
  try {
    return await initialization
  } finally {
    inFlightInitializations.delete(attempt.id)
  }
}

// --- Central verified-payment settlement (spec §29–§38) ---------------------

export interface SettlementOutcome {
  attemptId: number
  attemptPublicId: string
  status: PaymentAttemptStatus
  resolutionStatus: PaymentResolutionStatus
  reviewReason: PaymentReviewReason | null
  alreadyProcessed: boolean
}

async function locateAttempt(verified: VerifiedPaymentResult) {
  const db = getDb()
  const locators = []
  if (verified.providerReference) {
    locators.push(
      and(
        eq(paymentAttempts.provider, verified.provider),
        eq(paymentAttempts.providerReference, verified.providerReference),
      ),
    )
  }
  if (verified.providerCheckoutId) {
    locators.push(
      and(
        eq(paymentAttempts.provider, verified.provider),
        eq(paymentAttempts.providerCheckoutId, verified.providerCheckoutId),
      ),
    )
  }
  if (verified.attemptPublicId) {
    locators.push(
      and(
        eq(paymentAttempts.provider, verified.provider),
        eq(paymentAttempts.publicId, verified.attemptPublicId),
      ),
    )
  }
  if (locators.length === 0) return undefined
  return (
    await db
      .select()
      .from(paymentAttempts)
      .where(or(...locators))
      .limit(1)
  ).at(0)
}

/**
 * THE single settlement path. Consumes a provider-authenticated
 * VerifiedPaymentResult (from a signed webhook, a server verify call or
 * a PayPal capture) and applies the locked business rules atomically
 * under the Step 5 lock order. Idempotent: replays of an already
 * settled success return the recorded outcome without re-confirming.
 */
const SYSTEM_CONTEXT: RequestContext = { ipAddress: null, userAgent: null }

export async function settleVerifiedPayment(
  verified: VerifiedPaymentResult,
  ctx: RequestContext = SYSTEM_CONTEXT,
  nowMs: number = Date.now(),
): Promise<SettlementOutcome> {
  const attempt = await locateAttempt(verified)
  if (!attempt) {
    throw new PaymentError('No payment attempt matches this provider event.')
  }

  if (verified.outcome !== 'SUCCEEDED') {
    return applyNonSuccessOutcome(attempt.id, verified, ctx)
  }

  // Success settlement. Pre-read ids only for lock ordering.
  const appointment = (
    await getDb()
      .select({
        id: appointments.id,
        sacredHouseId: appointments.sacredHouseId,
      })
      .from(appointments)
      .where(eq(appointments.id, attempt.appointmentId))
      .limit(1)
  ).at(0)
  if (!appointment) {
    throw new PaymentError('The appointment for this payment no longer exists.')
  }
  await getOrCreateBookingSettings(appointment.sacredHouseId)

  const result = await getDb().transaction(
    async (
      tx,
    ): Promise<
      SettlementOutcome & {
        confirmed: boolean
        guidance: GuidanceAssignmentSummary | null
      }
    > => {
      // Lock order: House → appointment → attempt (consistent with
      // every Step 5 path; the attempt row is always last).
      await lockHouseScheduling(tx, appointment.sacredHouseId)
      const apptRow = (
        await tx
          .select()
          .from(appointments)
          .where(eq(appointments.id, appointment.id))
          .limit(1)
          .for('update')
      ).at(0)
      if (!apptRow) throw new PaymentError('Appointment not found.')
      const attemptRow = (
        await tx
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, attempt.id))
          .limit(1)
          .for('update')
      ).at(0)
      if (!attemptRow) throw new PaymentError('Payment attempt not found.')

      // Business idempotency: the same success (webhook retry, webhook +
      // callback race) settles exactly once.
      if (attemptRow.status === 'SUCCEEDED') {
        return {
          attemptId: attemptRow.id,
          attemptPublicId: attemptRow.publicId,
          status: attemptRow.status,
          resolutionStatus: attemptRow.resolutionStatus,
          reviewReason: attemptRow.reviewReason,
          alreadyProcessed: true,
          confirmed: false,
          guidance: null,
        }
      }

      // Settlement reads are serialized by the appointment row lock —
      // every settlement writer holds it.
      const existingSettlement = (
        await tx
          .select()
          .from(appointmentPaymentSettlements)
          .where(eq(appointmentPaymentSettlements.appointmentId, apptRow.id))
          .limit(1)
      ).at(0)

      const inLockNowSql = utcMsToSql(Math.max(nowMs, Date.now()))

      // Exact commercial comparison against the appointment snapshot —
      // never browser input, never the service's current price, never
      // provider metadata alone.
      let resolution: SettlementResolution = 'PAID_REQUIRES_REVIEW'
      let reviewReason: PaymentReviewReason | null = null
      let confirmed = false
      let guidance: GuidanceAssignmentSummary | null = null

      if (existingSettlement) {
        reviewReason = 'DUPLICATE_SUCCESS'
      } else if (
        verified.attemptPublicId != null &&
        verified.attemptPublicId !== attemptRow.publicId
      ) {
        reviewReason = 'PROVIDER_REFERENCE_MISMATCH'
      } else if (
        verified.amountMinor == null ||
        verified.amountMinor !== apptRow.priceMinorSnapshot ||
        attemptRow.amountMinor !== apptRow.priceMinorSnapshot
      ) {
        reviewReason = 'AMOUNT_MISMATCH'
      } else if (
        verified.currency == null ||
        verified.currency !== apptRow.currencySnapshot ||
        attemptRow.currency !== apptRow.currencySnapshot
      ) {
        reviewReason = 'CURRENCY_MISMATCH'
      } else if (apptRow.status === 'PENDING_PAYMENT') {
        const live =
          apptRow.reservationExpiresAt != null &&
          apptRow.reservationExpiresAt > inLockNowSql
        if (live) {
          try {
            // The ONE shared confirmation implementation (Step 5); it
            // also freezes the Step 7 guidance selection in this same
            // transaction.
            guidance = await confirmReservationUnderLock(
              tx,
              apptRow.id,
              inLockNowSql,
            )
            resolution = 'APPOINTMENT_CONFIRMED'
            confirmed = true
          } catch (error) {
            if (!(error instanceof AppointmentError)) throw error
            // Money arrived but confirmation is legally impossible —
            // record, review, never lose evidence.
            reviewReason = 'APPOINTMENT_NOT_CONFIRMABLE'
          }
        } else {
          // LOCKED late-payment rule (spec §34): record the money, do
          // NOT resurrect the appointment or steal a reallocated slot.
          reviewReason = 'RESERVATION_EXPIRED'
          await tx
            .update(appointments)
            .set({ status: 'EXPIRED' })
            .where(
              and(
                eq(appointments.id, apptRow.id),
                eq(appointments.status, 'PENDING_PAYMENT'),
                lte(appointments.reservationExpiresAt, inLockNowSql),
              ),
            )
        }
      } else {
        reviewReason = 'APPOINTMENT_NOT_CONFIRMABLE'
      }

      const resolutionStatus: PaymentResolutionStatus =
        resolution === 'APPOINTMENT_CONFIRMED'
          ? 'APPOINTMENT_CONFIRMED'
          : 'PAID_REQUIRES_REVIEW'

      await tx
        .update(paymentAttempts)
        .set({
          status: 'SUCCEEDED',
          resolutionStatus,
          reviewReason,
          paidAt: verified.paidAtSql ?? inLockNowSql,
          providerStatus: verified.providerStatus,
          providerPaymentId:
            verified.providerPaymentId ?? attemptRow.providerPaymentId,
          failureCode: null,
          failureMessage: null,
        })
        .where(eq(paymentAttempts.id, attemptRow.id))

      // One accepted settlement per appointment. The settlement slot is
      // claimed only when this success is the appointment's FINAL money
      // outcome: a confirmation, or a review-success against an
      // appointment that can no longer be confirmed (expired/cancelled/
      // completed). Commercial mismatches on a still-live reservation
      // deliberately do NOT claim the slot — the money is recorded and
      // queued for review on the attempt, while a subsequent CORRECT
      // payment can still legitimately confirm the appointment.
      // DUPLICATE_SUCCESS never replaces the original settlement. The
      // PK enforces uniqueness even against invariant bugs.
      const claimsSettlement =
        resolution === 'APPOINTMENT_CONFIRMED' ||
        reviewReason === 'RESERVATION_EXPIRED' ||
        reviewReason === 'APPOINTMENT_NOT_CONFIRMABLE'
      if (!existingSettlement && claimsSettlement) {
        await tx.insert(appointmentPaymentSettlements).values({
          appointmentId: apptRow.id,
          paymentAttemptId: attemptRow.id,
          resolution,
        })
      }

      return {
        attemptId: attemptRow.id,
        attemptPublicId: attemptRow.publicId,
        status: 'SUCCEEDED',
        resolutionStatus,
        reviewReason,
        alreadyProcessed: false,
        confirmed,
        guidance,
      }
    },
  )

  if (!result.alreadyProcessed) {
    await recordAuditEvent({
      actorUserId: null,
      action: 'payment.succeeded',
      entityType: 'payment_attempt',
      entityId: String(result.attemptId),
      metadata: {
        publicId: result.attemptPublicId,
        provider: verified.provider,
        providerReference: verified.providerReference,
        amountMinor: verified.amountMinor,
        currency: verified.currency,
        resolution: result.resolutionStatus,
        reason: result.reviewReason,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
    if (result.resolutionStatus === 'PAID_REQUIRES_REVIEW') {
      await recordAuditEvent({
        actorUserId: null,
        action: 'payment.requires_review',
        entityType: 'payment_attempt',
        entityId: String(result.attemptId),
        metadata: {
          publicId: result.attemptPublicId,
          reason: result.reviewReason,
        },
      })
    }
    if (result.confirmed) {
      await recordAuditEvent({
        actorUserId: null,
        action: 'appointment.confirmed',
        entityType: 'appointment',
        entityId: String(attempt.appointmentId),
        metadata: {
          from: 'PENDING_PAYMENT',
          to: 'CONFIRMED',
          paymentAttemptId: result.attemptId,
        },
      })
      if (result.guidance && !result.guidance.alreadyExisted) {
        await recordAuditEvent({
          actorUserId: null,
          action: 'appointment.guidance_assigned',
          entityType: 'appointment',
          entityId: String(attempt.appointmentId),
          metadata: {
            selectionResult: result.guidance.selectionResult,
            assignmentCount: result.guidance.assignmentCount,
            contentVersionIds: result.guidance.contentVersionIds.slice(0, 50),
          },
        })
      }
    }
  }
  const { confirmed: _confirmed, guidance: _guidance, ...outcome } = result
  return outcome
}

const NON_SUCCESS_TARGET: Partial<
  Record<
    string,
    { status: PaymentAttemptStatus; from: Array<PaymentAttemptStatus> }
  >
> = {
  FAILED: { status: 'FAILED', from: ['CREATED', 'INITIALIZED', 'PENDING'] },
  CANCELLED: {
    status: 'CANCELLED',
    from: ['CREATED', 'INITIALIZED', 'PENDING'],
  },
  EXPIRED: { status: 'EXPIRED', from: ['CREATED', 'INITIALIZED', 'PENDING'] },
  // PENDING only ever advances an INITIALIZED attempt. A CREATED
  // attempt must stay CREATED: that state is what keeps it reusable
  // with the SAME idempotency identity after an ambiguous provider
  // failure — moving it to PENDING would strand it (not reusable, not
  // re-initializable) and abandon its identity.
  PENDING: { status: 'PENDING', from: ['INITIALIZED'] },
}

/** Failure/cancel/expiry events use terminal-state-protected CAS: a
 * delayed or reordered provider event can NEVER overwrite SUCCEEDED
 * (spec §38) — zero affected rows is a silent, idempotent no-op. */
async function applyNonSuccessOutcome(
  attemptId: number,
  verified: VerifiedPaymentResult,
  ctx: RequestContext,
): Promise<SettlementOutcome> {
  const target = NON_SUCCESS_TARGET[verified.outcome]
  if (!target) throw new PaymentError('Unsupported payment outcome.')
  const isTerminal = target.status !== 'PENDING'
  const result = await getDb()
    .update(paymentAttempts)
    .set({
      status: target.status,
      providerStatus: verified.providerStatus,
      ...(isTerminal
        ? {
            failedAt: utcMsToSql(Date.now()),
            failureCode: verified.failureCode,
            failureMessage: verified.failureMessage?.slice(0, 255) ?? null,
          }
        : {}),
    })
    .where(
      and(
        eq(paymentAttempts.id, attemptId),
        inArray(paymentAttempts.status, target.from),
      ),
    )
  const transitioned = result[0].affectedRows === 1
  const row = (
    await getDb()
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.id, attemptId))
      .limit(1)
  ).at(0)
  if (!row) throw new PaymentError('Payment attempt not found.')
  if (transitioned && isTerminal) {
    await recordAuditEvent({
      actorUserId: null,
      action:
        target.status === 'FAILED'
          ? 'payment.failed'
          : target.status === 'CANCELLED'
            ? 'payment.cancelled'
            : 'payment.expired',
      entityType: 'payment_attempt',
      entityId: String(attemptId),
      metadata: {
        publicId: row.publicId,
        provider: row.provider,
        providerStatus: verified.providerStatus,
        failureCode: verified.failureCode,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    })
  }
  return {
    attemptId: row.id,
    attemptPublicId: row.publicId,
    status: row.status,
    resolutionStatus: row.resolutionStatus,
    reviewReason: row.reviewReason,
    alreadyProcessed: !transitioned,
  }
}

// --- Webhook pipeline (spec §6/§27–§29/§41–§43) -----------------------------

export const MAX_WEBHOOK_BODY_BYTES = 1_000_000

/**
 * Reads a request body with a REAL streaming cap: Content-Length is
 * client-controlled (absent for chunked bodies, possibly lying), so the
 * limit is enforced while consuming the stream — an oversized or
 * chunked flood is cut off at the cap instead of being buffered whole.
 * Returns null when the limit is exceeded.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number = MAX_WEBHOOK_BODY_BYTES,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  const body = request.body
  if (!body) return new Uint8Array(0)
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const combined = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

export interface WebhookHandlingResult {
  httpStatus: number
  body: string
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

/**
 * One pipeline for every provider webhook route: authenticate on raw
 * bytes → record/dedupe the event → normalize → settle centrally →
 * answer with provider-retry-compatible status codes. Webhook work is
 * deliberately minimal (no video, no email, no rendering — spec §43).
 */
export async function processProviderWebhook(
  providerCode: PaymentProviderCode,
  rawBody: Uint8Array,
  headers: Record<string, string>,
  nowMs: number = Date.now(),
): Promise<WebhookHandlingResult> {
  if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return { httpStatus: 413, body: 'payload too large' }
  }
  const provider = getWebhookProvider(providerCode)
  if (!provider) {
    return { httpStatus: 400, body: 'provider not configured' }
  }
  const parsed = await provider.parseAndVerifyWebhook(rawBody, headers, nowMs)
  if (!parsed.ok || !parsed.eventKey || !parsed.eventType) {
    if (!webhookFailureAuditLimiter.isBlocked(`whfail:${providerCode}`)) {
      webhookFailureAuditLimiter.recordFailure(`whfail:${providerCode}`)
      await recordAuditEvent({
        actorUserId: null,
        action: 'payment.webhook_received',
        entityType: 'payment_webhook',
        metadata: {
          provider: providerCode,
          verified: false,
          reason: parsed.reason ?? 'unverified',
        },
      })
    }
    return { httpStatus: 400, body: 'signature verification failed' }
  }

  // Idempotency record — created only AFTER authentication succeeded.
  const db = getDb()
  let eventRowId: number
  let retryOfFailed = false
  try {
    const inserted = await db.insert(paymentWebhookEvents).values({
      provider: providerCode,
      eventKey: parsed.eventKey.slice(0, 191),
      providerEventId: parsed.providerEventId?.slice(0, 128) ?? null,
      eventType: parsed.eventType.slice(0, 64),
      payloadSha256: sha256Hex(rawBody),
      processingStatus: 'RECEIVED',
    })
    eventRowId = inserted[0].insertId
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error
    const existing = (
      await db
        .select()
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.provider, providerCode),
            eq(paymentWebhookEvents.eventKey, parsed.eventKey.slice(0, 191)),
          ),
        )
        .limit(1)
    ).at(0)
    if (!existing) throw error
    if (
      existing.processingStatus === 'PROCESSED' ||
      existing.processingStatus === 'IGNORED'
    ) {
      // Duplicate delivery of handled events: succeed without work.
      return { httpStatus: 200, body: 'duplicate' }
    }
    // FAILED (or still RECEIVED): safe to retry — settlement is
    // business-level idempotent, and a FAILED event must never be
    // ignored forever (spec §42).
    eventRowId = existing.id
    retryOfFailed = existing.processingStatus === 'FAILED'
  }

  await recordAuditEvent({
    actorUserId: null,
    action: 'payment.webhook_received',
    entityType: 'payment_webhook',
    entityId: String(eventRowId),
    metadata: {
      provider: providerCode,
      eventType: parsed.eventType,
      eventKey: parsed.eventKey,
      verified: true,
      retry: retryOfFailed,
    },
  })

  if (!parsed.relevant || !parsed.verified) {
    await db
      .update(paymentWebhookEvents)
      .set({ processingStatus: 'IGNORED', processedAt: new Date() })
      .where(eq(paymentWebhookEvents.id, eventRowId))
    return { httpStatus: 200, body: 'ignored' }
  }

  try {
    const outcome = await settleVerifiedPayment(
      parsed.verified,
      SYSTEM_CONTEXT,
      nowMs,
    )
    await db
      .update(paymentWebhookEvents)
      .set({
        processingStatus: 'PROCESSED',
        processedAt: new Date(),
        paymentAttemptId: outcome.attemptId,
        errorCode: null,
      })
      .where(eq(paymentWebhookEvents.id, eventRowId))
    await recordAuditEvent({
      actorUserId: null,
      action: 'payment.webhook_processed',
      entityType: 'payment_webhook',
      entityId: String(eventRowId),
      metadata: {
        provider: providerCode,
        eventType: parsed.eventType,
        attemptPublicId: outcome.attemptPublicId,
        status: outcome.status,
        resolution: outcome.resolutionStatus,
      },
    })
    return { httpStatus: 200, body: 'processed' }
  } catch (error) {
    // Transient processing failure: mark FAILED and ask the provider to
    // retry (non-success response) — the unique key does NOT block the
    // retry because FAILED rows are reprocessed above.
    await db
      .update(paymentWebhookEvents)
      .set({
        processingStatus: 'FAILED',
        processedAt: new Date(),
        errorCode:
          error instanceof PaymentError
            ? 'SETTLEMENT_REJECTED'
            : 'PROCESSING_ERROR',
      })
      .where(eq(paymentWebhookEvents.id, eventRowId))
    return { httpStatus: 500, body: 'processing failed' }
  }
}

// --- User reconciliation (return pages / spec §26) --------------------------

export interface ReconcileResult {
  attemptPublicId: string
  provider: PaymentProviderCode
  status: PaymentAttemptStatus
  resolutionStatus: PaymentResolutionStatus
  reviewReason: PaymentReviewReason | null
  appointmentPublicId: string
  appointmentStatus: string
}

/**
 * Authenticated, owner-checked provider reconciliation: reads provider
 * truth via the adapter (capture for PayPal-style flows) and routes it
 * through the SAME central settlement. Query-string values from return
 * URLs are never consulted — a lost session can never capture someone
 * else's attempt because ownership is enforced here.
 */
export async function reconcilePayment(
  userId: number,
  ctx: RequestContext,
  attemptPublicId: string,
  nowMs: number = Date.now(),
): Promise<ReconcileResult> {
  requireNotRateLimited(paymentReconcileLimiter, `payrecon:${userId}`)
  const attempt = (
    await getDb()
      .select()
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.publicId, attemptPublicId),
          eq(paymentAttempts.userId, userId),
        ),
      )
      .limit(1)
  ).at(0)
  if (!attempt) throw new PaymentError('Payment not found.')

  const appointment = (
    await getDb()
      .select({
        publicId: appointments.publicId,
        status: appointments.status,
      })
      .from(appointments)
      .where(eq(appointments.id, attempt.appointmentId))
      .limit(1)
  ).at(0)
  if (!appointment) throw new PaymentError('Appointment not found.')

  const terminal: Array<PaymentAttemptStatus> = [
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
  ]
  if (terminal.includes(attempt.status)) {
    return {
      attemptPublicId: attempt.publicId,
      provider: attempt.provider,
      status: attempt.status,
      resolutionStatus: attempt.resolutionStatus,
      reviewReason: attempt.reviewReason,
      appointmentPublicId: appointment.publicId,
      appointmentStatus: appointment.status,
    }
  }

  const provider = getPaymentProvider(attempt.provider)
  if (!provider) {
    throw new PaymentError('This payment method is not available right now.')
  }
  const identity = toAttemptIdentity(attempt)
  let verified: VerifiedPaymentResult
  try {
    verified = provider.capturePayment
      ? await provider.capturePayment(identity)
      : await provider.verifyPayment(identity)
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new PaymentError(
        'The payment provider could not be reached. Please try again shortly.',
      )
    }
    throw error
  }

  let status = attempt.status
  let resolutionStatus = attempt.resolutionStatus
  let reviewReason = attempt.reviewReason
  // PENDING provider outcomes never transition the ledger here — in
  // particular a CREATED attempt stays CREATED so its idempotency
  // identity remains reusable for a safe re-initialization.
  if (verified.outcome !== 'PENDING') {
    const outcome = await settleVerifiedPayment(verified, ctx, nowMs)
    status = outcome.status
    resolutionStatus = outcome.resolutionStatus
    reviewReason = outcome.reviewReason
  }
  const freshAppointment = (
    await getDb()
      .select({ status: appointments.status })
      .from(appointments)
      .where(eq(appointments.publicId, appointment.publicId))
      .limit(1)
  ).at(0)
  return {
    attemptPublicId: attempt.publicId,
    provider: attempt.provider,
    status,
    resolutionStatus,
    reviewReason,
    appointmentPublicId: appointment.publicId,
    appointmentStatus: freshAppointment?.status ?? appointment.status,
  }
}

// --- Queries (user + admin) -------------------------------------------------

const SAFE_ATTEMPT_COLUMNS = {
  publicId: paymentAttempts.publicId,
  provider: paymentAttempts.provider,
  status: paymentAttempts.status,
  resolutionStatus: paymentAttempts.resolutionStatus,
  reviewReason: paymentAttempts.reviewReason,
  amountMinor: paymentAttempts.amountMinor,
  currency: paymentAttempts.currency,
  providerReference: paymentAttempts.providerReference,
  checkoutUrl: paymentAttempts.checkoutUrl,
  paidAt: paymentAttempts.paidAt,
  failedAt: paymentAttempts.failedAt,
  failureCode: paymentAttempts.failureCode,
  createdAt: paymentAttempts.createdAt,
  quotedAsset: paymentAttempts.quotedAsset,
  quotedAmount: paymentAttempts.quotedAmount,
  quotedNetwork: paymentAttempts.quotedNetwork,
  quoteExpiresAt: paymentAttempts.quoteExpiresAt,
}

/** A user's own payment history (spec §46): safe receipt/support fields
 * only — never provider secrets or raw payloads. */
export async function getUserPaymentHistory(userId: number) {
  return getDb()
    .select({
      ...SAFE_ATTEMPT_COLUMNS,
      appointmentPublicId: appointments.publicId,
      serviceNameSnapshot: appointments.serviceNameSnapshot,
      houseNameSnapshot: appointments.houseNameSnapshot,
    })
    .from(paymentAttempts)
    .innerJoin(appointments, eq(paymentAttempts.appointmentId, appointments.id))
    .where(eq(paymentAttempts.userId, userId))
    .orderBy(desc(paymentAttempts.id))
    .limit(200)
}

/** Owner-scoped single attempt (receipt page, spec §47). */
export async function getUserPaymentByPublicId(
  userId: number,
  publicId: string,
) {
  const row = (
    await getDb()
      .select({
        ...SAFE_ATTEMPT_COLUMNS,
        appointmentPublicId: appointments.publicId,
        appointmentStartsAtUtc: appointments.startsAtUtc,
        userTimezone: appointments.userTimezone,
        serviceNameSnapshot: appointments.serviceNameSnapshot,
        houseNameSnapshot: appointments.houseNameSnapshot,
        durationMinutesSnapshot: appointments.durationMinutesSnapshot,
      })
      .from(paymentAttempts)
      .innerJoin(
        appointments,
        eq(paymentAttempts.appointmentId, appointments.id),
      )
      .where(
        and(
          eq(paymentAttempts.publicId, publicId),
          eq(paymentAttempts.userId, userId),
        ),
      )
      .limit(1)
  ).at(0)
  if (!row) throw new PaymentError('Payment not found.')
  return row
}

/** Attempts for one owned appointment (checkout retry UX). */
export async function getAttemptsForOwnedAppointment(
  userId: number,
  appointmentPublicId: string,
) {
  const appointment = await loadOwnedAppointment(userId, appointmentPublicId)
  return getDb()
    .select(SAFE_ATTEMPT_COLUMNS)
    .from(paymentAttempts)
    .where(eq(paymentAttempts.appointmentId, appointment.id))
    .orderBy(desc(paymentAttempts.id))
}

export interface AdminPaymentFilters {
  provider?: PaymentProviderCode
  status?: PaymentAttemptStatus
  resolutionStatus?: PaymentResolutionStatus
  requiresReview?: boolean
  appointmentPublicId?: string
  fromDate?: string
  toDate?: string
}

/** Admin payment listing (spec §49) — operational data only. */
export async function listPaymentsAdmin(filters: AdminPaymentFilters) {
  const conditions = []
  if (filters.provider) {
    conditions.push(eq(paymentAttempts.provider, filters.provider))
  }
  if (filters.status) {
    conditions.push(eq(paymentAttempts.status, filters.status))
  }
  if (filters.resolutionStatus) {
    conditions.push(
      eq(paymentAttempts.resolutionStatus, filters.resolutionStatus),
    )
  }
  if (filters.requiresReview) {
    conditions.push(
      eq(paymentAttempts.resolutionStatus, 'PAID_REQUIRES_REVIEW'),
    )
  }
  if (filters.appointmentPublicId) {
    conditions.push(eq(appointments.publicId, filters.appointmentPublicId))
  }
  if (filters.fromDate && /^\d{4}-\d{2}-\d{2}$/.test(filters.fromDate)) {
    conditions.push(
      gte(paymentAttempts.createdAt, new Date(`${filters.fromDate}T00:00:00Z`)),
    )
  }
  if (filters.toDate && /^\d{4}-\d{2}-\d{2}$/.test(filters.toDate)) {
    conditions.push(
      lte(paymentAttempts.createdAt, new Date(`${filters.toDate}T23:59:59Z`)),
    )
  }
  return getDb()
    .select({
      id: paymentAttempts.id,
      publicId: paymentAttempts.publicId,
      provider: paymentAttempts.provider,
      status: paymentAttempts.status,
      resolutionStatus: paymentAttempts.resolutionStatus,
      reviewReason: paymentAttempts.reviewReason,
      amountMinor: paymentAttempts.amountMinor,
      currency: paymentAttempts.currency,
      providerReference: paymentAttempts.providerReference,
      paidAt: paymentAttempts.paidAt,
      createdAt: paymentAttempts.createdAt,
      appointmentPublicId: appointments.publicId,
      appointmentStatus: appointments.status,
      userEmail: users.email,
    })
    .from(paymentAttempts)
    .innerJoin(appointments, eq(paymentAttempts.appointmentId, appointments.id))
    .innerJoin(users, eq(paymentAttempts.userId, users.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(paymentAttempts.id))
    .limit(200)
}

/** Admin single-payment detail with webhook/reconciliation history.
 * Never exposes secrets, raw payloads or spiritual data. */
export async function getPaymentAdmin(id: number) {
  const row = (
    await getDb()
      .select({
        id: paymentAttempts.id,
        publicId: paymentAttempts.publicId,
        provider: paymentAttempts.provider,
        status: paymentAttempts.status,
        resolutionStatus: paymentAttempts.resolutionStatus,
        reviewReason: paymentAttempts.reviewReason,
        amountMinor: paymentAttempts.amountMinor,
        currency: paymentAttempts.currency,
        providerReference: paymentAttempts.providerReference,
        providerPaymentId: paymentAttempts.providerPaymentId,
        providerCheckoutId: paymentAttempts.providerCheckoutId,
        idempotencyKey: paymentAttempts.idempotencyKey,
        providerStatus: paymentAttempts.providerStatus,
        initializedAt: paymentAttempts.initializedAt,
        paidAt: paymentAttempts.paidAt,
        failedAt: paymentAttempts.failedAt,
        expiresAt: paymentAttempts.expiresAt,
        failureCode: paymentAttempts.failureCode,
        failureMessage: paymentAttempts.failureMessage,
        quotedAsset: paymentAttempts.quotedAsset,
        quotedAmount: paymentAttempts.quotedAmount,
        quotedNetwork: paymentAttempts.quotedNetwork,
        quoteExpiresAt: paymentAttempts.quoteExpiresAt,
        createdAt: paymentAttempts.createdAt,
        appointmentId: paymentAttempts.appointmentId,
        appointmentPublicId: appointments.publicId,
        appointmentStatus: appointments.status,
        appointmentStartsAtUtc: appointments.startsAtUtc,
        serviceNameSnapshot: appointments.serviceNameSnapshot,
        houseNameSnapshot: appointments.houseNameSnapshot,
        userEmail: users.email,
        userId: users.id,
      })
      .from(paymentAttempts)
      .innerJoin(
        appointments,
        eq(paymentAttempts.appointmentId, appointments.id),
      )
      .innerJoin(users, eq(paymentAttempts.userId, users.id))
      .where(eq(paymentAttempts.id, id))
      .limit(1)
  ).at(0)
  if (!row) throw new PaymentError('Payment not found.')
  const events = await getDb()
    .select({
      id: paymentWebhookEvents.id,
      eventKey: paymentWebhookEvents.eventKey,
      eventType: paymentWebhookEvents.eventType,
      processingStatus: paymentWebhookEvents.processingStatus,
      receivedAt: paymentWebhookEvents.receivedAt,
      processedAt: paymentWebhookEvents.processedAt,
      errorCode: paymentWebhookEvents.errorCode,
    })
    .from(paymentWebhookEvents)
    .where(eq(paymentWebhookEvents.paymentAttemptId, id))
    .orderBy(desc(paymentWebhookEvents.id))
  const settlement = await getSettlementForAppointment(row.appointmentId)
  return { ...row, webhookEvents: events, settlement: settlement ?? null }
}

/** Latest payment state per appointment for the user's appointment
 * list — safe summary only. */
export async function getLatestAttemptsByAppointment(
  userId: number,
): Promise<Map<string, { status: PaymentAttemptStatus; provider: string }>> {
  const rows = await getDb()
    .select({
      appointmentPublicId: appointments.publicId,
      status: paymentAttempts.status,
      provider: paymentAttempts.provider,
      id: paymentAttempts.id,
    })
    .from(paymentAttempts)
    .innerJoin(appointments, eq(paymentAttempts.appointmentId, appointments.id))
    .where(eq(paymentAttempts.userId, userId))
    .orderBy(desc(paymentAttempts.id))
  const latest = new Map<
    string,
    { status: PaymentAttemptStatus; provider: string }
  >()
  for (const row of rows) {
    if (!latest.has(row.appointmentPublicId)) {
      latest.set(row.appointmentPublicId, {
        status: row.status,
        provider: row.provider,
      })
    }
  }
  return latest
}
