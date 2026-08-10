import { and, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import { appointments, prayerGenerationJobs, sacredHouses } from '@/db/schema'
import { MAX_SIGNED_URL_TTL_SECONDS } from '@/providers/object-storage/types'
import { verifyCompletedUpload } from './render-upload'
import { buildPrivateMediaResponse } from '@/lib/media-range'
import type { RenderContext } from './render-assembly'

/**
 * Recorded Prayer Room runtime (Phase One, Step 18; canon §10.11).
 *
 * ```text
 * authenticated appointment OWNER
 * → appointment-time gate (CURRENT startsAtUtc)
 * → generation job READY
 * → verifyCompletedUpload()  (the SAME Step 17 proof, re-run)
 * → private playback of the recorded prayer
 * ```
 *
 * Step 18 adds NO table and NO new spiritual content. It reads
 * appointment, job and upload state that already exists and proves, on
 * every single request, that this person may hear this recording right
 * now. There is no share link, no public route, no download and no
 * live room.
 *
 * NEUTRAL FAILURE. A request for an appointment that does not exist,
 * belongs to somebody else, or is not yet open answers the same shape
 * as one that is simply not ready. The response never says which — a
 * caller must not be able to probe for other people's appointments, and
 * a legitimate owner never needs the distinction to be drawn in terms
 * of hashes, providers, object keys or job ids.
 */

/** What the OWNER is told. Deliberately four coarse states: enough to
 * explain the page, never enough to diagnose the pipeline. */
export type PrayerRoomState =
  /** The recording is still being prepared. */
  | 'PREPARING'
  /** Ready, but the appointment has not started yet. */
  | 'LOCKED'
  /** Open now. */
  | 'AVAILABLE'
  /** Not available for this appointment (cancelled, expired, unpaid,
   * or a recording that can no longer be verified). */
  | 'UNAVAILABLE'

export interface PrayerRoomStatus {
  state: PrayerRoomState
  /** Safe existing snapshots only — the same facts the appointment
   * page already shows its owner. */
  serviceName: string
  houseName: string
  startsAtUtc: string
  /** The Prayer Room opens exactly at the CURRENT appointment start, so
   * a reschedule moves it automatically. */
  opensAtUtc: string
  userTimezone: string
}

/** Statuses whose owner may reach a recorded Prayer Room at all.
 * PENDING_PAYMENT, CANCELLED, NO_SHOW and EXPIRED are refused: a
 * recording follows a kept appointment, not an intention to book one. */
const PLAYABLE_APPOINTMENT_STATUSES: ReadonlyArray<string> = [
  'CONFIRMED',
  'COMPLETED',
]

function utcSqlToMs(value: string): number {
  return new Date(`${value.replace(' ', 'T')}Z`).getTime()
}

interface OwnedAppointmentRow {
  id: number
  publicId: string
  status: string
  startsAtUtc: string
  userTimezone: string
  serviceNameSnapshot: string
  houseName: string
  serviceId: number
  sacredHouseId: number
  languageSnapshot: string | null
  jobId: number | null
  jobStatus: string | null
}

/**
 * Loads the appointment ONLY when it belongs to this exact user.
 *
 * Ownership is the query, not a check applied afterwards: there is no
 * code path here that reads an appointment first and decides about the
 * owner second. Staff roles get no bypass — an administrator with every
 * permission in the system still cannot open somebody's Prayer Room,
 * because this function never asks about roles at all.
 */
async function loadOwnedAppointment(
  userId: number,
  publicId: string,
): Promise<OwnedAppointmentRow | null> {
  const row = (
    await getDb()
      .select({
        id: appointments.id,
        publicId: appointments.publicId,
        status: appointments.status,
        startsAtUtc: appointments.startsAtUtc,
        userTimezone: appointments.userTimezone,
        serviceNameSnapshot: appointments.serviceNameSnapshot,
        houseName: sacredHouses.name,
        serviceId: appointments.serviceId,
        sacredHouseId: appointments.sacredHouseId,
        jobId: prayerGenerationJobs.id,
        jobStatus: prayerGenerationJobs.status,
        languageSnapshot: prayerGenerationJobs.languageSnapshot,
      })
      .from(appointments)
      .innerJoin(sacredHouses, eq(sacredHouses.id, appointments.sacredHouseId))
      .leftJoin(
        prayerGenerationJobs,
        eq(prayerGenerationJobs.appointmentId, appointments.id),
      )
      .where(
        and(
          eq(appointments.publicId, publicId),
          // OWNERSHIP, in the WHERE clause.
          eq(appointments.userId, userId),
        ),
      )
      .limit(1)
  ).at(0)
  return row ?? null
}

export type PrayerRoomAccess =
  | {
      ok: true
      appointment: OwnedAppointmentRow
      context: RenderContext
      jobId: number
    }
  | { ok: false; state: PrayerRoomState }

/**
 * The complete access proof, in the order that spends the least on a
 * request that is going to be refused anyway: ownership, then status,
 * then the time gate, then job readiness. Only a request that survives
 * all four is allowed to cost a full upload verification.
 */
async function proveAccess(
  userId: number,
  publicId: string,
  now: Date,
): Promise<PrayerRoomAccess> {
  const appointment = await loadOwnedAppointment(userId, publicId)
  // Unknown appointment, or somebody else's: the SAME answer.
  if (!appointment) return { ok: false, state: 'UNAVAILABLE' }
  if (!PLAYABLE_APPOINTMENT_STATUSES.includes(appointment.status)) {
    return { ok: false, state: 'UNAVAILABLE' }
  }
  // THE TIME GATE. Read from the appointment's CURRENT start, so a
  // reschedule moves the room with it and no separate stored gate can
  // drift out of step. There is deliberately no closing time: nothing
  // here expires a recording the owner is entitled to.
  if (now.getTime() < utcSqlToMs(appointment.startsAtUtc)) {
    return { ok: false, state: 'LOCKED' }
  }
  if (appointment.jobId == null || appointment.jobStatus !== 'READY') {
    return { ok: false, state: 'PREPARING' }
  }
  return {
    ok: true,
    appointment,
    jobId: appointment.jobId,
    context: {
      serviceId: appointment.serviceId,
      sacredHouseId: appointment.sacredHouseId,
      language: appointment.languageSnapshot ?? 'en',
    },
  }
}

/**
 * Owner-facing Prayer Room status. Returns null ONLY when there is no
 * such appointment for this user — the page then renders exactly what
 * it renders for any other unknown id.
 *
 * The AVAILABLE state is not a guess: it is granted only after the full
 * Step 17 upload proof succeeds, so the page never invites someone to
 * press play on a recording that would then fail.
 */
export async function getPrayerRoomStatus(
  userId: number,
  publicId: string,
  now: Date = new Date(),
): Promise<PrayerRoomStatus | null> {
  const appointment = await loadOwnedAppointment(userId, publicId)
  if (!appointment) return null
  const base = {
    serviceName: appointment.serviceNameSnapshot,
    houseName: appointment.houseName,
    startsAtUtc: appointment.startsAtUtc,
    opensAtUtc: appointment.startsAtUtc,
    userTimezone: appointment.userTimezone,
  }
  const access = await proveAccess(userId, publicId, now)
  if (!access.ok) return { ...base, state: access.state }
  const verified = await verifyCompletedUpload(access.jobId, access.context)
  // A recording that can no longer be verified is UNAVAILABLE, and the
  // reason stays in the logs: an owner is never shown a hash, a
  // provider code, an object key or a pipeline error.
  return { ...base, state: verified.ok ? 'AVAILABLE' : 'UNAVAILABLE' }
}

export type PrayerRoomMediaAccess =
  | {
      ok: true
      objectKey: string
      byteSize: number
      mimeType: string
      provider: VerifiedProvider
    }
  | { ok: false; state: PrayerRoomState }

type VerifiedProvider = Awaited<
  ReturnType<typeof verifyCompletedUpload>
> extends infer R
  ? R extends { ok: true; verified: { provider: infer P } }
    ? P
    : never
  : never

/**
 * The playback authorization, run in full on EVERY media request —
 * never once at page load and then trusted. A rights withdrawal, a
 * cancellation, a tampered object or a rescheduled appointment takes
 * effect on the very next byte range the browser asks for.
 */
export async function authorizePrayerRoomMedia(
  userId: number,
  publicId: string,
  now: Date = new Date(),
): Promise<PrayerRoomMediaAccess> {
  const access = await proveAccess(userId, publicId, now)
  if (!access.ok) return { ok: false, state: access.state }
  const verified = await verifyCompletedUpload(access.jobId, access.context)
  if (!verified.ok) return { ok: false, state: 'UNAVAILABLE' }
  return {
    ok: true,
    objectKey: verified.verified.objectKey,
    byteSize: verified.verified.byteSize,
    mimeType: verified.verified.mimeType,
    provider: verified.verified.provider,
  }
}

/** How long a signed private GET may live when a remote provider is
 * used. Bounded by Step 17's own ceiling and deliberately shorter: a
 * playback link only has to survive one player session's worth of
 * seeking. */
export const PRAYER_ROOM_SIGNED_URL_TTL_SECONDS = Math.min(
  5 * 60,
  MAX_SIGNED_URL_TTL_SECONDS,
)

/**
 * Serves the recording for ONE request.
 *
 * The browser identifies the media by appointment publicId and nothing
 * else — it cannot name an object key, a provider, an upload or a job,
 * because none of those are parameters. Every request repeats the whole
 * proof before a single byte moves.
 *
 * LOCAL storage is proxied server-side: the bytes are read through the
 * verified provider and streamed back with range support, so no
 * filesystem path or object key is ever visible to a client. A future
 * remote provider instead gets a short-lived PRIVATE signed GET and a
 * redirect — issued only AFTER this same authorization, held in the
 * response alone, and never persisted or logged.
 */
export async function servePrayerRoomMedia(input: {
  userId: number | null
  publicId: string
  request: Request
  now?: Date
}): Promise<Response> {
  // Unauthenticated is answered exactly like unknown: no shape,
  // timing or status distinguishes "you are not signed in" from
  // "that is not your appointment".
  if (input.userId == null) return notAvailable()
  const access = await authorizePrayerRoomMedia(
    input.userId,
    input.publicId,
    input.now ?? new Date(),
  )
  if (!access.ok) return notAvailable()

  if (!access.provider.isLocal) {
    // Remote provider: a short-lived PRIVATE signed GET, created only
    // now that authorization has passed, returned in the redirect and
    // nowhere else. It is never written to a row, an event or a log.
    const signed = await access.provider.createSignedReadUrl({
      objectKey: access.objectKey,
      ttlSeconds: PRAYER_ROOM_SIGNED_URL_TTL_SECONDS,
      now: input.now ?? new Date(),
    })
    return new Response(null, {
      status: 302,
      headers: {
        Location: signed.url,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Cookie',
      },
    })
  }

  const bytes = await access.provider.getPrivateObject(access.objectKey)
  if (!bytes || bytes.length !== access.byteSize) {
    // Verified a moment ago and gone now: refuse rather than serve
    // something that no longer matches what was proved.
    return notAvailable()
  }
  return buildPrivateMediaResponse(
    bytes,
    access.mimeType,
    input.request.headers.get('range'),
  )
}

/** The one refusal shape. No body, no code, no hint. */
function notAvailable(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      Vary: 'Cookie',
    },
  })
}
