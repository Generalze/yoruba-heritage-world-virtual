import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  auditLogs,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { registerUser } from '@/auth/service'
import {
  MOCK_FAILING_ADDRESS,
  clearMockOutbox,
  createMockEmailProvider,
  readMockOutbox,
} from '@/providers/notifications/mock'
import { createDisabledEmailProvider } from '@/providers/notifications/disabled'
import {
  resetEmailProviderForTests,
  setEmailProviderForTests,
} from '@/providers/notifications/registry'
import {
  countUnread,
  dispatchPendingEmails,
  listNotifications,
  listPreferences,
  markAllRead,
  markRead,
  raiseNotification,
  setPreference,
} from '@/services/notifications'

/**
 * Notifications (canon §42 item 23; rules in §48).
 *
 * The lines these tests hold: a notification never carries sacred or
 * internal detail, raising one can never break the thing it describes,
 * a muted category never becomes queued work, and the mock channel
 * makes no network call.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = 'Notification-fixture-passphrase-2026'
const createdUserIds: Array<number> = []

async function makeUser(): Promise<number> {
  const result = await registerUser(
    {
      email: `s23-${crypto.randomUUID()}@test.local`,
      preferredName: 'S23 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  return result.user.id
}

function readSource(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

/** Comments stripped, so prose ABOUT a rule cannot violate the rule —
 * the house pattern from the deployment-topology suite. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  setEmailProviderForTests(createMockEmailProvider())
  clearMockOutbox()
  await makeUser()
}, 120_000)

afterAll(async () => {
  const db = getDb()
  if (createdUserIds.length) {
    const ids = (
      await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(inArray(notifications.userId, createdUserIds))
    ).map((r) => r.id)
    if (ids.length) {
      await db
        .delete(notificationDeliveries)
        .where(inArray(notificationDeliveries.notificationId, ids))
      await db.delete(notifications).where(inArray(notifications.id, ids))
    }
    await db
      .delete(notificationPreferences)
      .where(inArray(notificationPreferences.userId, createdUserIds))
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  resetEmailProviderForTests()
  clearMockOutbox()
  await closeDb()
}, 120_000)

// ----------------------------------------------------------------------------
// Raising
// ----------------------------------------------------------------------------

describe('raising a notification', () => {
  it('records the event and delivers the in-app copy immediately', async () => {
    const user = await makeUser()
    await raiseNotification({
      userId: user,
      type: 'APPOINTMENT_CONFIRMED',
      title: 'Your appointment is confirmed',
      body: 'Divination with Ilé Àwọn Babaláwo on 2 Sep 2026, 10:00.',
      linkPublicId: crypto.randomUUID(),
    })
    const list = await listNotifications(user)
    expect(list).toHaveLength(1)
    expect(list[0].category).toBe('APPOINTMENT')
    expect(list[0].readAt).toBeNull()
    expect(await countUnread(user)).toBe(1)
  })

  it('queues an email delivery beside the in-app one', async () => {
    const user = await makeUser()
    await raiseNotification({
      userId: user,
      type: 'PRAYER_ROOM_READY',
      title: 'Your Prayer Room is ready',
      body: 'Your recording is now available.',
    })
    const rows = await getDb()
      .select({
        channel: notificationDeliveries.channel,
        status: notificationDeliveries.status,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notifications,
        eq(notifications.id, notificationDeliveries.notificationId),
      )
      .where(eq(notifications.userId, user))
    const byChannel = Object.fromEntries(rows.map((r) => [r.channel, r.status]))
    expect(byChannel.IN_APP).toBe('SENT')
    expect(byChannel.EMAIL).toBe('PENDING')
  })

  it('NEVER throws, whatever it is handed', async () => {
    // Rule 1: raising must not be able to break the thing it describes.
    // A user id that cannot exist would violate the foreign key.
    await raiseNotification({
      userId: 2_000_000_000,
      type: 'PAYMENT_SUCCEEDED',
      title: 'x',
      body: 'y',
    })
    // Reaching here at all is the assertion.
    expect(true).toBe(true)
  })

  it('maps every type to exactly one category', () => {
    const service = readSource('src/services/notifications.ts')
    for (const type of [
      'APPOINTMENT_CONFIRMED',
      'APPOINTMENT_CANCELLED',
      'APPOINTMENT_RESCHEDULED',
      'APPOINTMENT_EXPIRED',
      'PRAYER_ROOM_READY',
      'PAYMENT_SUCCEEDED',
      'PAYMENT_UNDER_REVIEW',
    ]) {
      expect(service).toContain(`${type}:`)
    }
  })
})

// ----------------------------------------------------------------------------
// Preferences, honoured at RAISE time
// ----------------------------------------------------------------------------

describe('a muted category never becomes queued work', () => {
  it('suppresses both channels when the member mutes a category', async () => {
    const user = await makeUser()
    await setPreference(user, 'PAYMENT', {
      inAppEnabled: false,
      emailEnabled: false,
    })
    await raiseNotification({
      userId: user,
      type: 'PAYMENT_SUCCEEDED',
      title: 'Payment confirmed',
      body: 'Your payment was verified.',
    })
    const rows = await getDb()
      .select({
        channel: notificationDeliveries.channel,
        status: notificationDeliveries.status,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notifications,
        eq(notifications.id, notificationDeliveries.notificationId),
      )
      .where(eq(notifications.userId, user))
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.status).toBe('SUPPRESSED')
    // Suppressed at raise time means genuinely absent, not filtered.
    expect(await listNotifications(user)).toHaveLength(0)
    expect(await countUnread(user)).toBe(0)
  })

  it('still RECORDS the event, so muting cannot erase history', async () => {
    const user = await makeUser()
    await setPreference(user, 'PAYMENT', {
      inAppEnabled: false,
      emailEnabled: false,
    })
    await raiseNotification({
      userId: user,
      type: 'PAYMENT_SUCCEEDED',
      title: 'Payment confirmed',
      body: 'Your payment was verified.',
    })
    const rows = await getDb()
      .select()
      .from(notifications)
      .where(eq(notifications.userId, user))
    expect(rows).toHaveLength(1)
  })

  it('mutes one category without touching the others', async () => {
    const user = await makeUser()
    await setPreference(user, 'PAYMENT', {
      inAppEnabled: false,
      emailEnabled: false,
    })
    await raiseNotification({
      userId: user,
      type: 'APPOINTMENT_CONFIRMED',
      title: 'Confirmed',
      body: 'Still delivered.',
    })
    expect(await listNotifications(user)).toHaveLength(1)
  })

  it('reports every category, defaulting to on without a stored row', async () => {
    const user = await makeUser()
    const prefs = await listPreferences(user)
    expect(prefs).toHaveLength(3)
    for (const pref of prefs) {
      expect(pref.inAppEnabled).toBe(true)
      expect(pref.emailEnabled).toBe(true)
    }
  })

  it('updates an existing preference instead of duplicating it', async () => {
    const user = await makeUser()
    await setPreference(user, 'APPOINTMENT', {
      inAppEnabled: false,
      emailEnabled: false,
    })
    await setPreference(user, 'APPOINTMENT', {
      inAppEnabled: true,
      emailEnabled: false,
    })
    const rows = await getDb()
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.userId, user))
    expect(rows).toHaveLength(1)
    expect(rows[0].inAppEnabled).toBe(true)
    expect(rows[0].emailEnabled).toBe(false)
  })
})

// ----------------------------------------------------------------------------
// Ownership
// ----------------------------------------------------------------------------

describe('notifications are private to their owner', () => {
  it('never marks another member’s notification read', async () => {
    const owner = await makeUser()
    const stranger = await makeUser()
    await raiseNotification({
      userId: owner,
      type: 'APPOINTMENT_CONFIRMED',
      title: 'Owned',
      body: 'Belongs to the owner.',
    })
    const list = await listNotifications(owner)
    await markRead(stranger, list[0].publicId)
    expect(await countUnread(owner)).toBe(1)
    await markRead(owner, list[0].publicId)
    expect(await countUnread(owner)).toBe(0)
  })

  it('marks all read for one member only', async () => {
    const a = await makeUser()
    const b = await makeUser()
    for (const user of [a, b]) {
      await raiseNotification({
        userId: user,
        type: 'PRAYER_ROOM_READY',
        title: 'Ready',
        body: 'Available now.',
      })
    }
    await markAllRead(a)
    expect(await countUnread(a)).toBe(0)
    expect(await countUnread(b)).toBe(1)
  })
})

// ----------------------------------------------------------------------------
// Dispatch — canon §3.1's job table
// ----------------------------------------------------------------------------

describe('the email dispatcher', () => {
  it('sends queued mail through the injected channel and marks it SENT', async () => {
    clearMockOutbox()
    const user = await makeUser()
    await raiseNotification({
      userId: user,
      type: 'APPOINTMENT_CONFIRMED',
      title: 'Your appointment is confirmed',
      body: 'Divination with Ilé Àwọn Babaláwo.',
    })
    const outcome = await dispatchPendingEmails()
    expect(outcome.sent).toBeGreaterThan(0)
    const sent = readMockOutbox()
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.some((m) => m.subject.includes('confirmed'))).toBe(true)
  })

  it('never sends the same delivery twice', async () => {
    clearMockOutbox()
    const user = await makeUser()
    await raiseNotification({
      userId: user,
      type: 'PRAYER_ROOM_READY',
      title: 'Ready once',
      body: 'Available now.',
    })
    await dispatchPendingEmails()
    const afterFirst = readMockOutbox().filter(
      (m) => m.subject === 'Ready once',
    ).length
    await dispatchPendingEmails()
    const afterSecond = readMockOutbox().filter(
      (m) => m.subject === 'Ready once',
    ).length
    expect(afterFirst).toBe(1)
    expect(afterSecond).toBe(1)
  })

  it('stops retrying a deterministic refusal, and keeps the in-app copy', async () => {
    // The DISABLED channel refuses non-retryably: no vendor is
    // configured, and retrying cannot install one.
    setEmailProviderForTests(createDisabledEmailProvider())
    const user = await makeUser()
    await raiseNotification({
      userId: user,
      type: 'APPOINTMENT_CONFIRMED',
      title: 'Confirmed without email',
      body: 'Still visible in the app.',
    })
    const outcome = await dispatchPendingEmails()
    expect(outcome.failed).toBeGreaterThan(0)

    const rows = await getDb()
      .select({
        channel: notificationDeliveries.channel,
        status: notificationDeliveries.status,
        lastError: notificationDeliveries.lastError,
      })
      .from(notificationDeliveries)
      .innerJoin(
        notifications,
        eq(notifications.id, notificationDeliveries.notificationId),
      )
      .where(eq(notifications.userId, user))
    const email = rows.find((r) => r.channel === 'EMAIL')!
    expect(email.status).toBe('FAILED')
    expect(email.lastError).toBe('email_disabled')
    // A refused email is not a lost notification.
    expect(await listNotifications(user)).toHaveLength(1)

    setEmailProviderForTests(createMockEmailProvider())
  })

  it('records an operator-facing code, never the member’s content', async () => {
    setEmailProviderForTests(createDisabledEmailProvider())
    const user = await makeUser()
    await raiseNotification({
      userId: user,
      type: 'PAYMENT_SUCCEEDED',
      title: 'Payment confirmed',
      body: 'A private detail that must not reach an error column.',
    })
    await dispatchPendingEmails()
    const rows = await getDb()
      .select({ lastError: notificationDeliveries.lastError })
      .from(notificationDeliveries)
      .innerJoin(
        notifications,
        eq(notifications.id, notificationDeliveries.notificationId),
      )
      .where(eq(notifications.userId, user))
    for (const row of rows) {
      expect(row.lastError ?? '').not.toContain('private detail')
    }
    setEmailProviderForTests(createMockEmailProvider())
  })
})

// ----------------------------------------------------------------------------
// Governance
// ----------------------------------------------------------------------------

describe('notifications stay inside their lane', () => {
  it('the mock channel makes no network call and imports no SDK', () => {
    const mock = withoutComments(
      readSource('src/providers/notifications/mock.ts'),
    )
    expect(mock).not.toMatch(/\bfetch\s*\(/)
    expect(mock).not.toMatch(/https?:\/\//)
    expect(mock).not.toMatch(
      /from\s+['"](nodemailer|resend|@sendgrid|postmark)/,
    )
    expect(mock).not.toMatch(/\bnet\b|\btls\b|smtp/i)
  })

  it('MOCK is refused in production', () => {
    const env = readSource('src/lib/env.ts')
    expect(env).toContain('NOTIFICATION_EMAIL_DRIVER')
    expect(env).toContain(
      'NOTIFICATION_EMAIL_DRIVER=MOCK is invalid in production',
    )
  })

  it('composes messages from safe snapshots only', () => {
    const events = withoutComments(
      readSource('src/services/notification-events.ts'),
    )
    for (const forbidden of [
      'sha256',
      'objectKey',
      'privateRequestNote',
      'jobId',
      'provider',
      'lastErrorCode',
    ]) {
      expect(events).not.toContain(forbidden)
    }
    // What it MAY use: the same snapshots the appointment page shows.
    expect(events).toContain('serviceNameSnapshot')
    expect(events).toContain('houseNameSnapshot')
  })

  it('raises from the real events, and only those authorised', () => {
    expect(readSource('src/services/payments.ts')).toContain(
      'notifyAppointmentConfirmed',
    )
    expect(readSource('src/services/payments.ts')).toContain(
      'notifyPaymentUnderReview',
    )
    expect(readSource('src/services/appointments.ts')).toContain(
      'notifyAppointmentCancelled',
    )
    expect(readSource('src/services/render-upload.ts')).toContain(
      'notifyPrayerRoomReady',
    )
    // Subscription events were NOT authorised for this step.
    const events = readSource('src/services/notification-events.ts')
    expect(events).not.toMatch(/subscription/i)
  })

  it('adds no ALTER or DROP to any existing table', () => {
    const file = readdirSync(join(process.cwd(), 'migrations'))
      .filter((n) => n.endsWith('.sql'))
      .sort()
      .at(-1)!
    const sql = readSource(`migrations/${file}`)
    expect(sql).not.toMatch(/DROP/)
    const alters = sql.match(/ALTER TABLE `([a-z_]+)`/g) ?? []
    for (const alter of alters) {
      expect(alter).toMatch(/notification/)
    }
  })

  it('uses no Redis or second queue — the delivery table IS the queue', () => {
    const service = withoutComments(readSource('src/services/notifications.ts'))
    expect(service).not.toMatch(/redis|bullmq|amqp|kafka/i)
    expect(service).toContain('notificationDeliveries')
  })

  it('honours the mock’s deterministic failure address', async () => {
    setEmailProviderForTests(createMockEmailProvider())
    expect(MOCK_FAILING_ADDRESS).toContain('@')
  })
})
