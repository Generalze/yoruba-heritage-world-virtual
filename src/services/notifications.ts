import { and, asc, count, eq, isNull } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  NOTIFICATION_CATEGORIES,
  notificationDeliveries,
  notificationPreferences,
  notifications,
  users,
} from '@/db/schema'
import { getEmailProvider } from '@/providers/notifications/registry'
import { EmailProviderError } from '@/providers/notifications/types'
import type {
  NotificationCategory,
  NotificationType,
} from '@/db/schema/notifications'

/**
 * Notifications (Phase One, canon §42 item 23; rules in
 * TECHNICAL_CANON.md §48).
 *
 * Three rules govern this module:
 *
 *  1. RAISING A NOTIFICATION NEVER BREAKS THE THING IT DESCRIBES. A
 *     booking, a payment settlement or a completed render must not fail
 *     because we could not tell someone about it. Every raise is
 *     therefore best-effort and swallows its own errors, exactly as
 *     recordAuditEvent does.
 *  2. NOTHING SACRED OR INTERNAL TRAVELS. Titles and bodies are
 *     composed here from safe snapshots only — never prayer or
 *     spiritual text, never a hash, provider code, object key, job id
 *     or pipeline error.
 *  3. PREFERENCES ARE HONOURED AT RAISE TIME. A muted channel is
 *     recorded SUPPRESSED and never becomes queued work, so muting is
 *     not a filter applied while rendering a list.
 */

/** Which category each event belongs to. Exhaustive by construction. */
const CATEGORY_OF: Record<NotificationType, NotificationCategory> = {
  APPOINTMENT_CONFIRMED: 'APPOINTMENT',
  APPOINTMENT_CANCELLED: 'APPOINTMENT',
  APPOINTMENT_RESCHEDULED: 'APPOINTMENT',
  APPOINTMENT_EXPIRED: 'APPOINTMENT',
  PRAYER_ROOM_READY: 'PRAYER_ROOM',
  PAYMENT_SUCCEEDED: 'PAYMENT',
  PAYMENT_UNDER_REVIEW: 'PAYMENT',
}

export interface RaiseNotificationInput {
  userId: number
  type: NotificationType
  title: string
  body: string
  /** A PUBLIC id the member may follow. Never an internal row id. */
  linkPublicId?: string | null
}

/**
 * Records one notification and queues the channels the member allows.
 *
 * Best-effort by contract: this never throws. Callers sit inside
 * booking and payment paths where a failure here must not roll back
 * something that genuinely happened.
 */
export async function raiseNotification(
  input: RaiseNotificationInput,
): Promise<void> {
  try {
    const category = CATEGORY_OF[input.type]
    const prefs = await loadPreference(input.userId, category)

    const publicId = crypto.randomUUID()
    const inserted = await getDb()
      .insert(notifications)
      .values({
        publicId,
        userId: input.userId,
        category,
        type: input.type,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 500),
        linkPublicId: input.linkPublicId ?? null,
      })
      .$returningId()
    const notificationId = inserted[0].id

    // A muted channel is written SUPPRESSED rather than omitted, so the
    // decision not to send stays visible instead of looking like a
    // delivery that never happened.
    await getDb()
      .insert(notificationDeliveries)
      .values([
        {
          notificationId,
          channel: 'IN_APP',
          status: prefs.inAppEnabled ? 'PENDING' : 'SUPPRESSED',
        },
        {
          notificationId,
          channel: 'EMAIL',
          status: prefs.emailEnabled ? 'PENDING' : 'SUPPRESSED',
        },
      ])

    // In-app needs no transport: the row IS the delivery.
    if (prefs.inAppEnabled) {
      await getDb()
        .update(notificationDeliveries)
        .set({ status: 'SENT', sentAt: new Date() })
        .where(
          and(
            eq(notificationDeliveries.notificationId, notificationId),
            eq(notificationDeliveries.channel, 'IN_APP'),
          ),
        )
    }
  } catch {
    // Deliberately swallowed — see rule 1 in the module docblock.
  }
}

/** Absence of a row means "not muted", so no backfill is ever required. */
async function loadPreference(
  userId: number,
  category: NotificationCategory,
): Promise<{ inAppEnabled: boolean; emailEnabled: boolean }> {
  const row = (
    await getDb()
      .select({
        inAppEnabled: notificationPreferences.inAppEnabled,
        emailEnabled: notificationPreferences.emailEnabled,
      })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.category, category),
        ),
      )
      .limit(1)
  ).at(0)
  return row ?? { inAppEnabled: true, emailEnabled: true }
}

// --- Member-facing reads --------------------------------------------------------

/**
 * The member's own notifications, newest first.
 *
 * Only rows whose IN_APP delivery was actually allowed appear: a
 * category muted at raise time is genuinely absent here, not filtered
 * out of a list it still belongs to.
 */
export async function listNotifications(userId: number, limit = 50) {
  return getDb()
    .select({
      publicId: notifications.publicId,
      category: notifications.category,
      type: notifications.type,
      title: notifications.title,
      body: notifications.body,
      linkPublicId: notifications.linkPublicId,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
    })
    .from(notifications)
    .innerJoin(
      notificationDeliveries,
      eq(notificationDeliveries.notificationId, notifications.id),
    )
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notificationDeliveries.channel, 'IN_APP'),
        eq(notificationDeliveries.status, 'SENT'),
      ),
    )
    .orderBy(notifications.createdAt)
    .limit(limit)
}

export async function countUnread(userId: number): Promise<number> {
  const rows = await getDb()
    .select({ c: count() })
    .from(notifications)
    .innerJoin(
      notificationDeliveries,
      eq(notificationDeliveries.notificationId, notifications.id),
    )
    .where(
      and(
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        eq(notificationDeliveries.channel, 'IN_APP'),
        eq(notificationDeliveries.status, 'SENT'),
      ),
    )
  return Number(rows[0]?.c ?? 0)
}

/** Owner-scoped: a public id belonging to someone else changes nothing. */
export async function markRead(
  userId: number,
  publicId: string,
): Promise<void> {
  await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.publicId, publicId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
      ),
    )
}

export async function markAllRead(userId: number): Promise<void> {
  await getDb()
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
}

// --- Preferences ------------------------------------------------------------------

export async function listPreferences(userId: number) {
  const rows = await getDb()
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
  // Present every category, defaulting to on, so the caller never has
  // to know that absence means "not muted".
  return NOTIFICATION_CATEGORIES.map((category) => {
    const row = rows.find((r) => r.category === category)
    return {
      category,
      inAppEnabled: row?.inAppEnabled ?? true,
      emailEnabled: row?.emailEnabled ?? true,
    }
  })
}

export async function setPreference(
  userId: number,
  category: NotificationCategory,
  channels: { inAppEnabled: boolean; emailEnabled: boolean },
): Promise<void> {
  const existing = (
    await getDb()
      .select({ id: notificationPreferences.id })
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.userId, userId),
          eq(notificationPreferences.category, category),
        ),
      )
      .limit(1)
  ).at(0)
  if (existing) {
    await getDb()
      .update(notificationPreferences)
      .set(channels)
      .where(eq(notificationPreferences.id, existing.id))
    return
  }
  await getDb()
    .insert(notificationPreferences)
    .values({ userId, category, ...channels })
}

// --- Dispatch (canon §3.1: the MariaDB-backed job table) --------------------------

export interface DispatchOutcome {
  claimed: number
  sent: number
  failed: number
}

/**
 * Sends the queued EMAIL deliveries.
 *
 * PENDING rows in notification_deliveries ARE the job queue canon §3.1
 * calls for — no Redis, no second table. Each row is attempted once per
 * pass; a non-retryable provider refusal (including "no email adapter
 * is configured") marks the row FAILED so it stops consuming attempts,
 * while a retryable one is left PENDING for the next pass.
 *
 * The in-app copy of the same notification was already delivered, so a
 * failure here loses the email, never the notification.
 */
export async function dispatchPendingEmails(
  limit = 50,
): Promise<DispatchOutcome> {
  const pending = await getDb()
    .select({
      deliveryId: notificationDeliveries.id,
      attempts: notificationDeliveries.attempts,
      reference: notifications.publicId,
      title: notifications.title,
      body: notifications.body,
      email: users.email,
    })
    .from(notificationDeliveries)
    .innerJoin(
      notifications,
      eq(notifications.id, notificationDeliveries.notificationId),
    )
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(
      and(
        eq(notificationDeliveries.channel, 'EMAIL'),
        eq(notificationDeliveries.status, 'PENDING'),
      ),
    )
    .orderBy(asc(notificationDeliveries.createdAt))
    .limit(limit)

  const outcome: DispatchOutcome = {
    claimed: pending.length,
    sent: 0,
    failed: 0,
  }
  const provider = getEmailProvider()

  for (const job of pending) {
    try {
      await provider.send({
        to: job.email,
        subject: job.title,
        // The body is already safe: it was composed from snapshots when
        // the notification was raised.
        body: job.body,
        reference: job.reference,
      })
      await getDb()
        .update(notificationDeliveries)
        .set({
          status: 'SENT',
          sentAt: new Date(),
          attempts: job.attempts + 1,
          lastError: null,
        })
        .where(eq(notificationDeliveries.id, job.deliveryId))
      outcome.sent += 1
    } catch (error) {
      const retryable =
        error instanceof EmailProviderError ? error.retryable : true
      const code =
        error instanceof EmailProviderError ? error.code : 'email_send_failed'
      await getDb()
        .update(notificationDeliveries)
        .set({
          // A retryable failure stays queued; a deterministic one stops.
          status: retryable ? 'PENDING' : 'FAILED',
          attempts: job.attempts + 1,
          // An operator-facing code only — never the member's content.
          lastError: code.slice(0, 300),
        })
        .where(eq(notificationDeliveries.id, job.deliveryId))
      outcome.failed += 1
    }
  }
  return outcome
}
