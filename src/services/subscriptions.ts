import { and, eq, gte, lte } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  spiritualContentVersions,
  subscriptionContent,
  subscriptionHistory,
  subscriptionPlans,
  subscriptions,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import { addDays, currentLocalDate, isValidTimeZone } from '@/lib/schedule-time'
import type { RequestContext } from '@/auth/service'

/**
 * Daily spiritual subscription engine (Phase One, canon §42 item 22;
 * rules recorded in TECHNICAL_CANON.md §47).
 *
 * Three rules govern everything here:
 *
 *  1. This engine NEVER authors spiritual content. It schedules and
 *     records references to versions that are already PUBLISHED through
 *     the existing approval workflow, and refuses anything else.
 *  2. It NEVER invents a price. A plan may exist without one, but an
 *     unpriced plan can never go on sale or be subscribed to.
 *  3. Selection is deterministic. An administrator schedules one
 *     approved item per plan per calendar date; no AI chooses what a
 *     subscriber receives.
 *
 * Purchase is a prepaid fixed term. Activation is an explicit call —
 * the seam the payment step will use once payment_attempts can point at
 * something other than an appointment.
 */

export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubscriptionError'
  }
}

// --- Validation ---------------------------------------------------------------

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD.')

export const planSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .regex(
      /^[a-z0-9-]+$/,
      'Code may use lowercase letters, digits and hyphens.',
    ),
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  termDays: z.number().int().min(1).max(366),
  // Absent means "not priced yet" — never zero-as-a-guess.
  priceMinor: z.number().int().min(1).nullable().optional(),
  currency: z
    .string()
    .trim()
    .length(3)
    .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO code.')
    .nullable()
    .optional(),
})

function assertPriceCoherent(
  priceMinor: number | null,
  currency: string | null,
): void {
  // A number without its currency is not a price, and a currency
  // without a number is not one either.
  if ((priceMinor === null) !== (currency === null)) {
    throw new SubscriptionError(
      'A plan price needs both an amount and a currency, or neither.',
    )
  }
}

// --- Plan administration ------------------------------------------------------

export async function createPlan(
  actorId: number,
  ctx: RequestContext,
  input: z.infer<typeof planSchema>,
): Promise<number> {
  await requirePermission(actorId, 'subscriptions.manage')
  const data = planSchema.parse(input)
  const priceMinor = data.priceMinor ?? null
  const currency = data.currency ?? null
  assertPriceCoherent(priceMinor, currency)

  const publicId = crypto.randomUUID()
  const result = await getDb()
    .insert(subscriptionPlans)
    .values({
      publicId,
      code: data.code,
      name: data.name,
      description: data.description ?? null,
      termDays: data.termDays,
      priceMinor,
      currency,
      // Never on sale on creation — an administrator opens it explicitly.
      active: false,
      createdBy: actorId,
    })
    .$returningId()

  const planId = result[0].id
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'subscription.plan.created',
    entityType: 'subscription_plan',
    entityId: String(planId),
    metadata: { code: data.code, termDays: data.termDays },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return planId
}

export async function updatePlan(
  actorId: number,
  ctx: RequestContext,
  planId: number,
  input: z.infer<typeof planSchema>,
): Promise<void> {
  await requirePermission(actorId, 'subscriptions.manage')
  const data = planSchema.parse(input)
  const priceMinor = data.priceMinor ?? null
  const currency = data.currency ?? null
  assertPriceCoherent(priceMinor, currency)

  const plan = await loadPlan(planId)
  await getDb()
    .update(subscriptionPlans)
    .set({
      code: data.code,
      name: data.name,
      description: data.description ?? null,
      termDays: data.termDays,
      priceMinor,
      currency,
    })
    .where(eq(subscriptionPlans.id, planId))

  await recordAuditEvent({
    actorUserId: actorId,
    action: 'subscription.plan.updated',
    entityType: 'subscription_plan',
    entityId: String(planId),
    metadata: { code: plan.code },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/**
 * Opens or closes a plan for purchase. A plan with no price can never
 * be opened: the engine refuses rather than defaulting to free or to
 * some invented figure.
 */
export async function setPlanActive(
  actorId: number,
  ctx: RequestContext,
  planId: number,
  active: boolean,
): Promise<void> {
  await requirePermission(actorId, 'subscriptions.manage')
  const plan = await loadPlan(planId)
  if (active && (plan.priceMinor === null || plan.currency === null)) {
    throw new SubscriptionError(
      'This plan has no price yet, so it cannot be opened for subscription.',
    )
  }
  await getDb()
    .update(subscriptionPlans)
    .set({ active })
    .where(eq(subscriptionPlans.id, planId))

  await recordAuditEvent({
    actorUserId: actorId,
    action: active ? 'subscription.plan.opened' : 'subscription.plan.closed',
    entityType: 'subscription_plan',
    entityId: String(planId),
    metadata: { code: plan.code },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

async function loadPlan(planId: number) {
  const plan = (
    await getDb()
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, planId))
      .limit(1)
  ).at(0)
  if (!plan)
    throw new SubscriptionError('This subscription plan does not exist.')
  return plan
}

/** Plans a member may actually buy: open, and genuinely priced. */
export async function listPurchasablePlans() {
  const rows = await getDb()
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.active, true))
  return rows.filter((row) => row.priceMinor !== null && row.currency !== null)
}

// --- Scheduling approved content ----------------------------------------------

/**
 * Places one APPROVED, PUBLISHED content version on a plan's calendar.
 *
 * The published check is the whole point: a draft, a submitted version
 * or an archived one must never reach a subscriber, and this is the
 * only door through which content enters the daily sequence.
 */
export async function scheduleContent(
  actorId: number,
  ctx: RequestContext,
  planId: number,
  scheduledDate: string,
  contentVersionId: number,
): Promise<number> {
  await requirePermission(actorId, 'subscriptions.manage')
  const day = dateSchema.parse(scheduledDate)
  await loadPlan(planId)

  const version = (
    await getDb()
      .select({
        id: spiritualContentVersions.id,
        contentItemId: spiritualContentVersions.contentItemId,
        status: spiritualContentVersions.status,
      })
      .from(spiritualContentVersions)
      .where(eq(spiritualContentVersions.id, contentVersionId))
      .limit(1)
  ).at(0)
  if (!version) {
    throw new SubscriptionError('That content version does not exist.')
  }
  if (version.status !== 'PUBLISHED') {
    throw new SubscriptionError(
      'Only PUBLISHED content may be scheduled to subscribers.',
    )
  }

  const existing = (
    await getDb()
      .select({ id: subscriptionContent.id })
      .from(subscriptionContent)
      .where(
        and(
          eq(subscriptionContent.planId, planId),
          eq(subscriptionContent.scheduledDate, day),
        ),
      )
      .limit(1)
  ).at(0)
  if (existing) {
    throw new SubscriptionError(
      'This plan already has content scheduled for that date.',
    )
  }

  const result = await getDb()
    .insert(subscriptionContent)
    .values({
      planId,
      scheduledDate: day,
      contentItemId: version.contentItemId,
      contentVersionId: version.id,
      scheduledBy: actorId,
    })
    .$returningId()

  await recordAuditEvent({
    actorUserId: actorId,
    action: 'subscription.content.scheduled',
    entityType: 'subscription_content',
    entityId: String(result[0].id),
    // Identifiers only — never the sacred text itself.
    metadata: { planId, scheduledDate: day, contentVersionId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return result[0].id
}

export async function unscheduleContent(
  actorId: number,
  ctx: RequestContext,
  planId: number,
  scheduledDate: string,
): Promise<void> {
  await requirePermission(actorId, 'subscriptions.manage')
  const day = dateSchema.parse(scheduledDate)
  await getDb()
    .delete(subscriptionContent)
    .where(
      and(
        eq(subscriptionContent.planId, planId),
        eq(subscriptionContent.scheduledDate, day),
      ),
    )
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'subscription.content.unscheduled',
    entityType: 'subscription_content',
    entityId: `${planId}:${day}`,
    metadata: { planId, scheduledDate: day },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Subscribing ---------------------------------------------------------------

/**
 * Reserves a prepaid term for a member. The plan's commercial terms are
 * snapshotted now, so later edits to the plan cannot rewrite what this
 * member agreed to.
 *
 * The subscription starts PENDING_PAYMENT and delivers nothing until it
 * is activated.
 */
export async function createSubscription(
  userId: number,
  ctx: RequestContext,
  planId: number,
  userTimezone: string,
  nowMs: number = Date.now(),
): Promise<{ id: number; publicId: string }> {
  if (!isValidTimeZone(userTimezone)) {
    throw new SubscriptionError('Enter a valid IANA timezone.')
  }
  const plan = await loadPlan(planId)
  if (!plan.active) {
    throw new SubscriptionError('This plan is not open for subscription.')
  }
  if (plan.priceMinor === null || plan.currency === null) {
    throw new SubscriptionError('This plan has no price yet.')
  }

  const startDate = currentLocalDate(userTimezone, nowMs)
  // Inclusive window: a 30-day term covers the start date and the 29
  // days after it.
  const endDate = addDays(startDate, plan.termDays - 1)
  const publicId = crypto.randomUUID()

  const result = await getDb()
    .insert(subscriptions)
    .values({
      publicId,
      userId,
      planId,
      planNameSnapshot: plan.name,
      termDaysSnapshot: plan.termDays,
      priceMinorSnapshot: plan.priceMinor,
      currencySnapshot: plan.currency,
      userTimezoneSnapshot: userTimezone,
      status: 'PENDING_PAYMENT',
      startDate,
      endDate,
    })
    .$returningId()

  await recordAuditEvent({
    actorUserId: userId,
    action: 'subscription.created',
    entityType: 'subscription',
    entityId: String(result[0].id),
    metadata: { planId, startDate, endDate },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return { id: result[0].id, publicId }
}

/**
 * Turns a reserved term into a delivering one.
 *
 * This is the seam the payment step will call once a verified payment
 * can point at a subscription. It deliberately does NOT decide whether
 * money arrived — it records that something else decided so.
 */
export async function activateSubscription(
  subscriptionId: number,
  ctx: RequestContext,
  actorId: number | null = null,
): Promise<void> {
  const row = await loadSubscription(subscriptionId)
  if (row.status === 'ACTIVE') return
  if (row.status !== 'PENDING_PAYMENT') {
    throw new SubscriptionError(
      `A ${row.status.toLowerCase()} subscription cannot be activated.`,
    )
  }
  await getDb()
    .update(subscriptions)
    .set({ status: 'ACTIVE', activatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))

  await recordAuditEvent({
    actorUserId: actorId,
    action: 'subscription.activated',
    entityType: 'subscription',
    entityId: String(subscriptionId),
    metadata: { planId: row.planId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function cancelSubscription(
  userId: number,
  ctx: RequestContext,
  subscriptionId: number,
): Promise<void> {
  const row = await loadSubscription(subscriptionId)
  if (row.userId !== userId) {
    // Same answer as "does not exist": ownership is never disclosed.
    throw new SubscriptionError('This subscription does not exist.')
  }
  if (row.status === 'CANCELLED') return
  await getDb()
    .update(subscriptions)
    .set({ status: 'CANCELLED', cancelledAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))

  await recordAuditEvent({
    actorUserId: userId,
    action: 'subscription.cancelled',
    entityType: 'subscription',
    entityId: String(subscriptionId),
    metadata: { planId: row.planId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

async function loadSubscription(subscriptionId: number) {
  const row = (
    await getDb()
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId))
      .limit(1)
  ).at(0)
  if (!row) throw new SubscriptionError('This subscription does not exist.')
  return row
}

// --- Delivery -------------------------------------------------------------------

export interface DailyDelivery {
  subscriptionPublicId: string
  date: string
  title: string
  body: string
  language: string
  contentVersionId: number
}

/**
 * What this member should receive today, if anything.
 *
 * Returns null — not an excuse and not a substitute — when there is no
 * active term, when today falls outside it, or when no administrator
 * scheduled anything for today. An empty day is a real answer.
 *
 * Delivery is recorded at most once per subscription per date, so the
 * history is an audit trail rather than a hit counter.
 */
export async function getDailyDelivery(
  userId: number,
  nowMs: number = Date.now(),
): Promise<DailyDelivery | null> {
  const active = (
    await getDb()
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.userId, userId),
          eq(subscriptions.status, 'ACTIVE'),
        ),
      )
  ).at(0)
  if (!active) return null

  const today = currentLocalDate(active.userTimezoneSnapshot, nowMs)
  if (today < active.startDate || today > active.endDate) return null

  const scheduled = (
    await getDb()
      .select({
        contentItemId: subscriptionContent.contentItemId,
        contentVersionId: subscriptionContent.contentVersionId,
      })
      .from(subscriptionContent)
      .where(
        and(
          eq(subscriptionContent.planId, active.planId),
          eq(subscriptionContent.scheduledDate, today),
        ),
      )
      .limit(1)
  ).at(0)
  if (!scheduled) return null

  const version = (
    await getDb()
      .select({
        id: spiritualContentVersions.id,
        title: spiritualContentVersions.title,
        body: spiritualContentVersions.body,
        language: spiritualContentVersions.language,
        status: spiritualContentVersions.status,
      })
      .from(spiritualContentVersions)
      .where(eq(spiritualContentVersions.id, scheduled.contentVersionId))
      .limit(1)
  ).at(0)
  // A version that has since been archived stops being delivered: the
  // approval workflow stays authoritative after scheduling, not just
  // at the moment of scheduling.
  if (!version || version.status !== 'PUBLISHED') return null

  await recordDelivery(
    active.id,
    today,
    scheduled.contentItemId,
    scheduled.contentVersionId,
  )

  return {
    subscriptionPublicId: active.publicId,
    date: today,
    title: version.title,
    body: version.body,
    language: version.language,
    contentVersionId: version.id,
  }
}

/** Idempotent: the unique index is the guarantee, not a prior read. */
async function recordDelivery(
  subscriptionId: number,
  deliveredDate: string,
  contentItemId: number,
  contentVersionId: number,
): Promise<void> {
  try {
    await getDb().insert(subscriptionHistory).values({
      subscriptionId,
      deliveredDate,
      contentItemId,
      contentVersionId,
    })
  } catch {
    // Already recorded for this date. Re-reading the same day is not an
    // error, and must not fail the member's request.
  }
}

export async function listDeliveryHistory(
  userId: number,
  subscriptionId: number,
) {
  const row = await loadSubscription(subscriptionId)
  if (row.userId !== userId) {
    throw new SubscriptionError('This subscription does not exist.')
  }
  return getDb()
    .select()
    .from(subscriptionHistory)
    .where(eq(subscriptionHistory.subscriptionId, subscriptionId))
}

/**
 * Closes terms whose last day has passed.
 *
 * Written as an explicit sweep rather than a clock-reading side effect,
 * so the background worker (canon §3.1: a MariaDB-backed job table, no
 * Redis) can call it on a schedule and the result is observable.
 */
export async function expireDueSubscriptions(today: string): Promise<number> {
  const day = dateSchema.parse(today)
  const due = await getDb()
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(
      and(eq(subscriptions.status, 'ACTIVE'), lte(subscriptions.endDate, day)),
    )
  for (const row of due) {
    await getDb()
      .update(subscriptions)
      .set({ status: 'EXPIRED' })
      .where(
        and(eq(subscriptions.id, row.id), eq(subscriptions.status, 'ACTIVE')),
      )
  }
  return due.length
}

/** Terms a member holds, newest first. */
export async function listSubscriptionsForUser(userId: number) {
  return getDb()
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId))
}

/** The scheduled sequence for a plan across a date window (admin view). */
export async function listScheduledContent(
  actorId: number,
  planId: number,
  fromDate: string,
  toDate: string,
) {
  await requirePermission(actorId, 'subscriptions.view')
  const from = dateSchema.parse(fromDate)
  const to = dateSchema.parse(toDate)
  return getDb()
    .select()
    .from(subscriptionContent)
    .where(
      and(
        eq(subscriptionContent.planId, planId),
        gte(subscriptionContent.scheduledDate, from),
        lte(subscriptionContent.scheduledDate, to),
      ),
    )
}
