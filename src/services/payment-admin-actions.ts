import { createServerFn } from '@tanstack/react-start'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_PROVIDERS,
  PAYMENT_RESOLUTION_STATUSES,
  paymentAttempts,
} from '@/db/schema'
import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import { getPaymentProvider } from '@/providers/payments/registry'
import { PaymentProviderError } from '@/providers/payments/types'
import {
  PaymentError,
  getPaymentAdmin,
  listPaymentsAdmin,
  settleVerifiedPayment,
} from './payments'
import type { SafeUser } from '@/auth/session'

/**
 * Admin payment visibility & operational review (spec §48–§50).
 *
 * STRICTLY OBSERVATIONAL + provider-truth re-verification. There is NO
 * mark-paid / confirm-payment / force-success action for any role —
 * SUPER_ADMIN included. The only mutation here asks the PROVIDER for
 * the authoritative payment state and routes it through the same
 * central settlement as webhooks.
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

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()

export const adminListPaymentsFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      provider: z.enum(PAYMENT_PROVIDERS).optional(),
      status: z.enum(PAYMENT_ATTEMPT_STATUSES).optional(),
      resolutionStatus: z.enum(PAYMENT_RESOLUTION_STATUSES).optional(),
      requiresReview: z.boolean().optional(),
      appointmentPublicId: z.string().uuid().optional(),
      fromDate: dateSchema,
      toDate: dateSchema,
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'payments.view')
    return listPaymentsAdmin(data)
  })

export const adminGetPaymentFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.number().int().positive() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'payments.view')
    return getPaymentAdmin(data.id)
  })

/** Re-verify with the provider (payments.manage). Provider truth only:
 * this can surface a missed success/failure, never fabricate one. */
export const adminReverifyPaymentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.number().int().positive() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'payments.manage')
    const attempt = (
      await getDb()
        .select()
        .from(paymentAttempts)
        .where(and(eq(paymentAttempts.id, data.id)))
        .limit(1)
    ).at(0)
    if (!attempt) throw new PaymentError('Payment not found.')
    const provider = getPaymentProvider(attempt.provider)
    if (!provider) {
      throw new PaymentError('This payment provider is not configured.')
    }
    let verified
    try {
      verified = await provider.verifyPayment({
        publicId: attempt.publicId,
        idempotencyKey: attempt.idempotencyKey,
        amountMinor: attempt.amountMinor,
        currency: attempt.currency,
        providerReference: attempt.providerReference,
        providerPaymentId: attempt.providerPaymentId,
        providerCheckoutId: attempt.providerCheckoutId,
      })
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        throw new PaymentError(
          'The payment provider could not be reached. Try again shortly.',
        )
      }
      throw error
    }
    if (verified.outcome === 'PENDING') {
      return { changed: false, providerStatus: verified.providerStatus }
    }
    const outcome = await settleVerifiedPayment(verified, requestContext())
    return {
      changed: !outcome.alreadyProcessed,
      status: outcome.status,
      resolutionStatus: outcome.resolutionStatus,
      reviewReason: outcome.reviewReason,
    }
  })
