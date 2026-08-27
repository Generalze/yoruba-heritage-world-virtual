import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  auditLogs,
  spiritualContentItems,
  spiritualContentVersions,
  subscriptionContent,
  subscriptionHistory,
  subscriptionPlans,
  subscriptions,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { assignRoleToUser } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import {
  approveVersion,
  createContentItem,
  createVersion,
  publishVersion,
  submitVersionForReview,
} from '@/services/spiritual-content'
import {
  SubscriptionError,
  activateSubscription,
  cancelSubscription,
  createPlan,
  createSubscription,
  expireDueSubscriptions,
  getDailyDelivery,
  listPurchasablePlans,
  scheduleContent,
  setPlanActive,
  unscheduleContent,
  updatePlan,
} from '@/services/subscriptions'

/**
 * Daily spiritual subscriptions (canon §42 item 22; rules in §47).
 *
 * These tests exist to hold three lines that matter more than the
 * feature itself: unapproved content can never reach a subscriber, a
 * price is never invented, and nothing is delivered on a day nobody
 * scheduled.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = 'Subscription-fixture-passphrase-2026'
const TZ = 'Africa/Lagos'

const createdUserIds: Array<number> = []
const createdPlanIds: Array<number> = []
const createdItemIds: Array<number> = []

let adminId = 0
let memberId = 0
let publishedVersionId = 0
let draftVersionId = 0
let key = ''

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s22-${crypto.randomUUID()}@test.local`,
      preferredName: 'S22 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role) await assignRoleToUser(result.user.id, role)
  return result.user.id
}

/** A real approved+published guidance version, through the real workflow. */
async function makePublishedVersion(suffix: string): Promise<number> {
  const item = await createContentItem(adminId, ctx, {
    code: `S22_${key}_${suffix}`.toUpperCase(),
    contentType: 'PREPARATION',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    sortOrder: 0,
  })
  createdItemIds.push(item.id)
  const version = await createVersion(adminId, ctx, item.id, {
    language: 'en',
    title: `S22 Daily ${suffix}`,
    body: 'Approved guidance body used only as a subscription fixture.',
    visibilityStage: 'AFTER_CONFIRMATION',
    acknowledgementRequired: false,
    allowEnglishFallback: false,
  })
  await submitVersionForReview(adminId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  return version.id
}

async function makeDraftVersion(suffix: string): Promise<number> {
  const item = await createContentItem(adminId, ctx, {
    code: `S22_${key}_${suffix}`.toUpperCase(),
    contentType: 'PREPARATION',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    sortOrder: 0,
  })
  createdItemIds.push(item.id)
  const version = await createVersion(adminId, ctx, item.id, {
    language: 'en',
    title: `S22 Draft ${suffix}`,
    body: 'A draft that must never reach a subscriber.',
    visibilityStage: 'AFTER_CONFIRMATION',
    acknowledgementRequired: false,
    allowEnglishFallback: false,
  })
  return version.id
}

async function makePlan(
  termDays: number,
  priced: boolean,
  suffix: string,
): Promise<number> {
  const id = await createPlan(adminId, ctx, {
    code: `s22-${key}-${suffix}`,
    name: `S22 Plan ${suffix}`,
    termDays,
    priceMinor: priced ? 250_000 : null,
    currency: priced ? 'NGN' : null,
  })
  createdPlanIds.push(id)
  return id
}

/**
 * expect().rejects.toThrow(SomeErrorClass) hangs under bun test in this
 * repo — the same trap auth-flow.test.ts documents. Assert the
 * rejection explicitly instead.
 */
async function expectRejection(
  run: () => Promise<unknown>,
  type?: new (...args: never[]) => Error,
): Promise<Error> {
  let thrown: unknown = null
  try {
    await run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(type ?? Error)
  return thrown as Error
}

/** Midday in Lagos on a fixed date, so "today" never straddles midnight. */
function at(date: string): number {
  return Date.parse(`${date}T11:00:00.000Z`)
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  adminId = await makeUser('ADMIN')
  memberId = await makeUser()
  publishedVersionId = await makePublishedVersion('pub')
  draftVersionId = await makeDraftVersion('draft')
}, 120_000)

afterAll(async () => {
  const db = getDb()
  if (createdPlanIds.length) {
    const subIds = (
      await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(inArray(subscriptions.planId, createdPlanIds))
    ).map((r) => r.id)
    if (subIds.length) {
      await db
        .delete(subscriptionHistory)
        .where(inArray(subscriptionHistory.subscriptionId, subIds))
      await db.delete(subscriptions).where(inArray(subscriptions.id, subIds))
    }
    await db
      .delete(subscriptionContent)
      .where(inArray(subscriptionContent.planId, createdPlanIds))
    await db
      .delete(subscriptionPlans)
      .where(inArray(subscriptionPlans.id, createdPlanIds))
  }
  if (createdItemIds.length) {
    await db
      .delete(spiritualContentVersions)
      .where(inArray(spiritualContentVersions.contentItemId, createdItemIds))
    await db
      .delete(spiritualContentItems)
      .where(inArray(spiritualContentItems.id, createdItemIds))
  }
  if (createdUserIds.length) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  await closeDb()
}, 120_000)

// ----------------------------------------------------------------------------
// §47.2 — a price is never invented
// ----------------------------------------------------------------------------

describe('a subscription price is never invented', () => {
  it('creates a plan with NO price rather than defaulting to zero', async () => {
    const planId = await makePlan(30, false, 'unpriced')
    const row = (
      await getDb()
        .select()
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .limit(1)
    ).at(0)!
    expect(row.priceMinor).toBeNull()
    expect(row.currency).toBeNull()
  })

  it('refuses to open an unpriced plan for subscription', async () => {
    const planId = await makePlan(30, false, 'unpriced-open')
    await expectRejection(
      () => setPlanActive(adminId, ctx, planId, true),
      SubscriptionError,
    )
    const row = (
      await getDb()
        .select({ active: subscriptionPlans.active })
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .limit(1)
    ).at(0)!
    expect(row.active).toBe(false)
  })

  it('refuses an amount without a currency, and a currency without an amount', async () => {
    await expectRejection(
      () =>
        createPlan(adminId, ctx, {
          code: `s22-${key}-halfprice`,
          name: 'S22 Half Price',
          termDays: 30,
          priceMinor: 250_000,
          currency: null,
        }),
      SubscriptionError,
    )
    await expectRejection(
      () =>
        createPlan(adminId, ctx, {
          code: `s22-${key}-halfcur`,
          name: 'S22 Half Currency',
          termDays: 30,
          priceMinor: null,
          currency: 'NGN',
        }),
      SubscriptionError,
    )
  })

  it('never lists an unpriced plan as purchasable', async () => {
    const planId = await makePlan(30, false, 'nolist')
    // Force it active behind the service's back to prove the LIST also
    // filters, rather than relying on setPlanActive alone.
    await getDb()
      .update(subscriptionPlans)
      .set({ active: true })
      .where(eq(subscriptionPlans.id, planId))
    const purchasable = await listPurchasablePlans()
    expect(purchasable.some((p) => p.id === planId)).toBe(false)
  })

  it('a plan is never on sale the moment it is created', async () => {
    const planId = await makePlan(30, true, 'fresh')
    const row = (
      await getDb()
        .select({ active: subscriptionPlans.active })
        .from(subscriptionPlans)
        .where(eq(subscriptionPlans.id, planId))
        .limit(1)
    ).at(0)!
    expect(row.active).toBe(false)
  })
})

// ----------------------------------------------------------------------------
// §47.1/§47.3 — only APPROVED content, chosen by a person
// ----------------------------------------------------------------------------

describe('only published content may reach a subscriber', () => {
  it('refuses to schedule a DRAFT version', async () => {
    const planId = await makePlan(30, true, 'draftsched')
    await expectRejection(
      () => scheduleContent(adminId, ctx, planId, '2026-09-01', draftVersionId),
      SubscriptionError,
    )
  })

  it('refuses to schedule a version that does not exist', async () => {
    const planId = await makePlan(30, true, 'ghost')
    await expectRejection(
      () => scheduleContent(adminId, ctx, planId, '2026-09-01', 2_000_000_000),
      SubscriptionError,
    )
  })

  it('accepts a PUBLISHED version, once per plan per date', async () => {
    const planId = await makePlan(30, true, 'once')
    const id = await scheduleContent(
      adminId,
      ctx,
      planId,
      '2026-09-02',
      publishedVersionId,
    )
    expect(id).toBeGreaterThan(0)
    await expectRejection(
      () =>
        scheduleContent(adminId, ctx, planId, '2026-09-02', publishedVersionId),
      SubscriptionError,
    )
  })

  it('a member cannot schedule content', async () => {
    const planId = await makePlan(30, true, 'noperm')
    await expectRejection(() =>
      scheduleContent(memberId, ctx, planId, '2026-09-03', publishedVersionId),
    )
  })

  it('a member cannot create or open a plan', async () => {
    await expectRejection(() =>
      createPlan(memberId, ctx, {
        code: `s22-${key}-hacker`,
        name: 'S22 Unauthorised',
        termDays: 30,
        priceMinor: 100,
        currency: 'NGN',
      }),
    )
  })

  it('records the schedule by IDENTIFIER, never the sacred text', async () => {
    const planId = await makePlan(30, true, 'audit')
    await scheduleContent(
      adminId,
      ctx,
      planId,
      '2026-09-04',
      publishedVersionId,
    )
    const entries = await getDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'subscription.content.scheduled'))
    const mine = entries.filter((e) =>
      JSON.stringify(e.metadataJson ?? {}).includes(String(planId)),
    )
    expect(mine.length).toBeGreaterThan(0)
    for (const entry of mine) {
      const recorded = JSON.stringify(entry.metadataJson ?? {})
      expect(recorded).toContain('contentVersionId')
      expect(recorded).not.toContain('Approved guidance')
    }
  })
})

// ----------------------------------------------------------------------------
// §47.2 — prepaid fixed term
// ----------------------------------------------------------------------------

describe('a prepaid term is fixed, snapshotted, and inert until activated', () => {
  it('computes an INCLUSIVE window from the term length', async () => {
    const planId = await makePlan(30, true, 'window')
    await setPlanActive(adminId, ctx, planId, true)
    const { id } = await createSubscription(
      memberId,
      ctx,
      planId,
      TZ,
      at('2026-09-10'),
    )
    const row = (
      await getDb()
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, id))
        .limit(1)
    ).at(0)!
    expect(row.startDate).toBe('2026-09-10')
    // 30 days INCLUSIVE of the start date.
    expect(row.endDate).toBe('2026-10-09')
    expect(row.status).toBe('PENDING_PAYMENT')
  })

  it('snapshots the commercial terms so a later plan edit cannot rewrite them', async () => {
    const planId = await makePlan(30, true, 'snap')
    await setPlanActive(adminId, ctx, planId, true)
    const { id } = await createSubscription(
      memberId,
      ctx,
      planId,
      TZ,
      at('2026-09-10'),
    )
    await updatePlan(adminId, ctx, planId, {
      code: `s22-${key}-snap`,
      name: 'S22 Plan RENAMED',
      termDays: 90,
      priceMinor: 999_999,
      currency: 'USD',
    })
    const row = (
      await getDb()
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, id))
        .limit(1)
    ).at(0)!
    expect(row.planNameSnapshot).not.toContain('RENAMED')
    expect(row.termDaysSnapshot).toBe(30)
    expect(row.priceMinorSnapshot).toBe(250_000)
    expect(row.currencySnapshot).toBe('NGN')
  })

  it('refuses a subscription to a plan that is not open', async () => {
    const planId = await makePlan(30, true, 'closed')
    await expectRejection(
      () => createSubscription(memberId, ctx, planId, TZ, at('2026-09-10')),
      SubscriptionError,
    )
  })

  it('delivers NOTHING while the term is still pending payment', async () => {
    const planId = await makePlan(30, true, 'pending')
    await setPlanActive(adminId, ctx, planId, true)
    await createSubscription(memberId, ctx, planId, TZ, at('2026-09-10'))
    await scheduleContent(
      adminId,
      ctx,
      planId,
      '2026-09-10',
      publishedVersionId,
    )
    expect(await getDailyDelivery(memberId, at('2026-09-10'))).toBeNull()
  })
})

// ----------------------------------------------------------------------------
// §47.1/§47.4 — delivery
// ----------------------------------------------------------------------------

describe('daily delivery', () => {
  let planId = 0
  let subscriber = 0

  beforeAll(async () => {
    planId = await makePlan(5, true, 'deliver')
    await setPlanActive(adminId, ctx, planId, true)
    subscriber = await makeUser()
    const { id } = await createSubscription(
      subscriber,
      ctx,
      planId,
      TZ,
      at('2026-10-01'),
    )
    await activateSubscription(id, ctx, adminId)
    await scheduleContent(
      adminId,
      ctx,
      planId,
      '2026-10-01',
      publishedVersionId,
    )
    await scheduleContent(
      adminId,
      ctx,
      planId,
      '2026-10-03',
      publishedVersionId,
    )
  }, 60_000)

  it('serves the scheduled approved item on a scheduled day', async () => {
    const delivery = await getDailyDelivery(subscriber, at('2026-10-01'))
    expect(delivery).not.toBeNull()
    expect(delivery!.date).toBe('2026-10-01')
    expect(delivery!.contentVersionId).toBe(publishedVersionId)
    expect(delivery!.title).toContain('S22 Daily')
  })

  it('serves NOTHING on a day nobody scheduled — an empty day is a real answer', async () => {
    expect(await getDailyDelivery(subscriber, at('2026-10-02'))).toBeNull()
  })

  it('serves nothing after the term ends', async () => {
    // Term is 5 days from 2026-10-01, so 10-06 is past the end.
    expect(await getDailyDelivery(subscriber, at('2026-10-06'))).toBeNull()
  })

  it('records each delivered day exactly once, however often it is read', async () => {
    await getDailyDelivery(subscriber, at('2026-10-03'))
    await getDailyDelivery(subscriber, at('2026-10-03'))
    await getDailyDelivery(subscriber, at('2026-10-03'))
    const sub = (
      await getDb()
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.userId, subscriber))
        .limit(1)
    ).at(0)!
    const rows = await getDb()
      .select()
      .from(subscriptionHistory)
      .where(eq(subscriptionHistory.subscriptionId, sub.id))
    const forDay = rows.filter((r) => r.deliveredDate === '2026-10-03')
    expect(forDay).toHaveLength(1)
  })

  it('stops delivering a version that has since been UNSCHEDULED', async () => {
    await unscheduleContent(adminId, ctx, planId, '2026-10-03')
    expect(await getDailyDelivery(subscriber, at('2026-10-03'))).toBeNull()
  })

  it('delivers nothing at all once cancelled', async () => {
    const sub = (
      await getDb()
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.userId, subscriber))
        .limit(1)
    ).at(0)!
    await cancelSubscription(subscriber, ctx, sub.id)
    expect(await getDailyDelivery(subscriber, at('2026-10-01'))).toBeNull()
  })

  it('never lets one member cancel another member’s term', async () => {
    const otherPlan = await makePlan(5, true, 'foreign')
    await setPlanActive(adminId, ctx, otherPlan, true)
    const victim = await makeUser()
    const { id } = await createSubscription(
      victim,
      ctx,
      otherPlan,
      TZ,
      at('2026-10-01'),
    )
    await expectRejection(
      () => cancelSubscription(memberId, ctx, id),
      SubscriptionError,
    )
  })
})

// ----------------------------------------------------------------------------
// Term expiry
// ----------------------------------------------------------------------------

describe('terms close when their last day has passed', () => {
  it('expires an ACTIVE term whose end date has gone by, and only that one', async () => {
    const planId = await makePlan(2, true, 'expiry')
    await setPlanActive(adminId, ctx, planId, true)
    const endingUser = await makeUser()
    const runningUser = await makeUser()
    const ending = await createSubscription(
      endingUser,
      ctx,
      planId,
      TZ,
      at('2026-11-01'),
    )
    await activateSubscription(ending.id, ctx, adminId)
    const running = await createSubscription(
      runningUser,
      ctx,
      planId,
      TZ,
      at('2026-12-01'),
    )
    await activateSubscription(running.id, ctx, adminId)

    await expireDueSubscriptions('2026-11-15')

    const endingRow = (
      await getDb()
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.id, ending.id))
        .limit(1)
    ).at(0)!
    const runningRow = (
      await getDb()
        .select({ status: subscriptions.status })
        .from(subscriptions)
        .where(eq(subscriptions.id, running.id))
        .limit(1)
    ).at(0)!
    expect(endingRow.status).toBe('EXPIRED')
    expect(runningRow.status).toBe('ACTIVE')
  })

  it('refuses to activate a term that was already cancelled', async () => {
    const planId = await makePlan(5, true, 'reactivate')
    await setPlanActive(adminId, ctx, planId, true)
    const person = await makeUser()
    const { id } = await createSubscription(
      person,
      ctx,
      planId,
      TZ,
      at('2026-11-01'),
    )
    await cancelSubscription(person, ctx, id)
    await expectRejection(
      () => activateSubscription(id, ctx, adminId),
      SubscriptionError,
    )
  })
})

// ----------------------------------------------------------------------------
// The engine keeps its distance from the rest of the platform
// ----------------------------------------------------------------------------

describe('the subscription engine stays in its lane', () => {
  it('stores no spiritual text of its own', () => {
    const schema = readSource('src/db/schema/subscriptions.ts')
    // Content is referenced by id, never copied into these tables.
    expect(schema).toContain('contentVersionId')
    expect(schema).not.toMatch(/body:\s*text\(/)
  })

  it('does not touch the appointment payment path', () => {
    const service = readSource('src/services/subscriptions.ts')
    expect(service).not.toContain('paymentAttempts')
    expect(service).not.toContain('appointments')
    expect(service).not.toContain('initiatePayment')
  })

  it('never selects content by anything but the admin schedule', () => {
    const service = readSource('src/services/subscriptions.ts')
    for (const forbidden of [
      /personalis/i,
      /Math\.random/,
      /\bshuffle\b/i,
      /ORDER BY RAND/i,
      /\brand\(\)/i,
    ]) {
      expect(service).not.toMatch(forbidden)
    }
  })

  it('leaves the existing payment tables untouched in this migration', () => {
    const sql = readSource('migrations/0016_regular_blonde_phantom.sql')
    expect(sql).not.toMatch(/ALTER TABLE `payment_attempts`/)
    expect(sql).not.toMatch(/ALTER TABLE `appointments`/)
    expect(sql).not.toMatch(/DROP/)
  })
})

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}
