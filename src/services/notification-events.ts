import { eq } from 'drizzle-orm'

import { getDb } from '@/db'
import { appointments } from '@/db/schema'
import { formatUtcSqlInTimezone } from '@/lib/display-time'
import { raiseNotification } from './notifications'

/**
 * The events that raise a notification (Phase One, Step 23; rules in
 * TECHNICAL_CANON.md §48).
 *
 * Every function here is BEST-EFFORT and never throws: they are called
 * from booking, payment and generation paths where telling someone
 * about an event must never undo the event. raiseNotification already
 * swallows its own errors; the snapshot load below is guarded for the
 * same reason.
 *
 * WHY THESE LIVE HERE rather than inline at each call site: composing a
 * message needs the appointment's safe snapshots, and looking those up
 * inside the payment service would spread appointment queries into a
 * module that has no other reason to hold them. Each call site gets one
 * import and one line.
 *
 * WHAT THEY MAY SAY: service name, Sacred House name and the scheduled
 * time, in the member's own timezone — precisely the snapshots the
 * appointment page already shows its owner. Never prayer or spiritual
 * text, never a hash, provider code, object key, job id or pipeline
 * error, and never the private request note.
 */

interface AppointmentSnapshot {
  userId: number
  publicId: string
  serviceName: string
  houseName: string
  whenLocal: string
}

/** Returns null rather than throwing: a missing row must not break a
 * payment settlement that already succeeded. */
async function loadSnapshot(
  appointmentId: number,
): Promise<AppointmentSnapshot | null> {
  try {
    const row = (
      await getDb()
        .select({
          userId: appointments.userId,
          publicId: appointments.publicId,
          serviceName: appointments.serviceNameSnapshot,
          houseName: appointments.houseNameSnapshot,
          startsAtUtc: appointments.startsAtUtc,
          userTimezone: appointments.userTimezone,
        })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
    ).at(0)
    if (!row) return null
    return {
      userId: row.userId,
      publicId: row.publicId,
      serviceName: row.serviceName,
      houseName: row.houseName,
      whenLocal: formatUtcSqlInTimezone(row.startsAtUtc, row.userTimezone),
    }
  } catch {
    return null
  }
}

export async function notifyAppointmentConfirmed(
  appointmentId: number,
): Promise<void> {
  const snap = await loadSnapshot(appointmentId)
  if (!snap) return
  await raiseNotification({
    userId: snap.userId,
    type: 'APPOINTMENT_CONFIRMED',
    title: 'Your appointment is confirmed',
    body: `${snap.serviceName} with ${snap.houseName} on ${snap.whenLocal}.`,
    linkPublicId: snap.publicId,
  })
}

export async function notifyAppointmentCancelled(
  appointmentId: number,
): Promise<void> {
  const snap = await loadSnapshot(appointmentId)
  if (!snap) return
  await raiseNotification({
    userId: snap.userId,
    type: 'APPOINTMENT_CANCELLED',
    title: 'Your appointment is cancelled',
    body: `${snap.serviceName} with ${snap.houseName} on ${snap.whenLocal} is no longer scheduled.`,
    linkPublicId: snap.publicId,
  })
}

export async function notifyAppointmentRescheduled(
  appointmentId: number,
): Promise<void> {
  const snap = await loadSnapshot(appointmentId)
  if (!snap) return
  await raiseNotification({
    userId: snap.userId,
    type: 'APPOINTMENT_RESCHEDULED',
    title: 'Your appointment has moved',
    body: `${snap.serviceName} with ${snap.houseName} is now on ${snap.whenLocal}.`,
    linkPublicId: snap.publicId,
  })
}

export async function notifyAppointmentExpired(
  appointmentId: number,
): Promise<void> {
  const snap = await loadSnapshot(appointmentId)
  if (!snap) return
  await raiseNotification({
    userId: snap.userId,
    type: 'APPOINTMENT_EXPIRED',
    title: 'Your reservation has expired',
    body: `${snap.serviceName} with ${snap.houseName} was not confirmed in time and the time has been released.`,
    linkPublicId: snap.publicId,
  })
}

export async function notifyPaymentUnderReview(
  appointmentId: number,
): Promise<void> {
  const snap = await loadSnapshot(appointmentId)
  if (!snap) return
  await raiseNotification({
    userId: snap.userId,
    type: 'PAYMENT_UNDER_REVIEW',
    title: 'Your payment is being reviewed',
    // Says what is true and what happens next, and promises nothing
    // about the outcome.
    body: `Your payment for ${snap.serviceName} arrived and has been recorded. Our team will review it and contact you.`,
    linkPublicId: snap.publicId,
  })
}

/**
 * The moment a member most wants to hear about: their recording is
 * ready. Carries nothing about HOW it was made — no job id, no provider,
 * no object key — only that the Prayer Room is now open.
 */
export async function notifyPrayerRoomReady(
  appointmentId: number,
): Promise<void> {
  const snap = await loadSnapshot(appointmentId)
  if (!snap) return
  await raiseNotification({
    userId: snap.userId,
    type: 'PRAYER_ROOM_READY',
    title: 'Your Prayer Room is ready',
    body: `Your recording for ${snap.serviceName} with ${snap.houseName} is now available.`,
    linkPublicId: snap.publicId,
  })
}
