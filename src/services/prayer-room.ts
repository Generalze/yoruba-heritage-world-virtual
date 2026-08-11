import { and, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import { appointments, prayerGenerationJobs } from '@/db/schema'
import { MAX_SIGNED_URL_TTL_SECONDS } from '@/providers/object-storage/types'
import { computeFileSha256 } from '@/providers/media/storage'
import { verifyCompletedUpload } from './render-upload'
import { buildPrivateMediaResponse } from '@/lib/media-range'
import { mediaOriginFromEndpoint } from '@/lib/security-headers'
import { env } from '@/lib/env'
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
  /** Not available for this appointment: cancelled, expired or unpaid;
   * a recording that can no longer be verified; or a generation that
   * ended in terminal failure and will not arrive. */
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

/**
 * Generation statuses from which a recording can STILL arrive.
 *
 * "Not READY" is not one condition but two, and they deserve different
 * answers. A job still moving through the pipeline — including RETRYING,
 * which is a bounded retry and not a verdict — is genuinely being
 * prepared. A job in terminal FAILED or CANCELLED is not: telling that
 * owner their recording is "being prepared" and inviting them to check
 * back later would be a plain untruth, and one they could keep acting
 * on forever.
 *
 * Anything NOT listed here is treated as terminal, which is the
 * fail-closed direction: a future status that nobody classified would
 * show UNAVAILABLE rather than promise a recording that may never come.
 * A test pins this list against the schema enum, so adding a status
 * forces a deliberate decision instead of an accidental one.
 */
export const PRAYER_ROOM_IN_FLIGHT_GENERATION_STATUSES: ReadonlyArray<string> =
  [
    'QUEUED',
    'PREPARING',
    'STORYBOARDING',
    'GENERATING_VISUALS',
    'GENERATING_AUDIO',
    'RENDERING',
    'UPLOADING',
    'RETRYING',
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
        // The HISTORICAL snapshot taken when the appointment was
        // created, never the current catalogue name: a Sacred House
        // renaming itself must not silently rewrite what somebody
        // was shown when they booked.
        houseName: appointments.houseNameSnapshot,
        serviceId: appointments.serviceId,
        sacredHouseId: appointments.sacredHouseId,
        jobId: prayerGenerationJobs.id,
        jobStatus: prayerGenerationJobs.status,
        languageSnapshot: prayerGenerationJobs.languageSnapshot,
      })
      .from(appointments)
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
 * The complete access proof, cheapest refusal first: ownership, then
 * appointment status, then job READINESS, and only then the time gate.
 * Only a request that survives all four is allowed to cost a full
 * upload verification.
 *
 * Readiness deliberately precedes the clock — see the comment at that
 * check for why an unmade recording is PREPARING rather than LOCKED,
 * and why a terminally failed one is UNAVAILABLE rather than either.
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
  // READINESS FIRST, THEN THE CLOCK. A recording that does not exist
  // yet is PREPARING whether or not the appointment has started —
  // telling an owner their room is merely "locked" when nothing has
  // been made would be the wrong thing to say.
  //
  // A job that has not been enqueued yet is legitimately PREPARING: the
  // enqueue happens inside the confirmation transaction, so this is a
  // momentary gap, not an absence.
  if (appointment.jobId == null) return { ok: false, state: 'PREPARING' }
  if (appointment.jobStatus !== 'READY') {
    // STILL COMING versus NEVER COMING. Only a job that can still
    // produce a recording is described as being prepared; a terminal
    // one is UNAVAILABLE — the same neutral answer as every other
    // refusal, carrying no error code, no stage and no hint about why.
    return {
      ok: false,
      state: PRAYER_ROOM_IN_FLIGHT_GENERATION_STATUSES.includes(
        appointment.jobStatus ?? '',
      )
        ? 'PREPARING'
        : 'UNAVAILABLE',
    }
  }
  // THE TIME GATE. Read from the appointment’s CURRENT start, so a
  // reschedule moves the room with it and no separate stored gate can
  // drift out of step. There is deliberately no closing time: nothing
  // here expires a recording the owner is entitled to.
  if (now.getTime() < utcSqlToMs(appointment.startsAtUtc)) {
    return { ok: false, state: 'LOCKED' }
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
      /** The AUTHORITATIVE Step 16 hash. Carried through so the bytes
       * actually served can be re-proved against it, not merely the
       * object that was verified a moment earlier. */
      sha256: string
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
    sha256: verified.verified.sha256,
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
 * verified provider, re-hashed, and streamed back with range support,
 * so every range request passes through this proof and no filesystem
 * path or object key is ever visible to a client.
 *
 * A remote provider instead gets a short-lived PRIVATE signed GET and
 * a redirect, issued only AFTER this same authorization and held in
 * that response alone — never persisted, never logged. BE PRECISE
 * ABOUT WHAT THAT MEANS: a signed URL is a bounded BEARER CAPABILITY.
 * Once issued, subsequent range requests go straight to the provider
 * and do NOT re-run this application proof; the expiry is what bounds
 * it. That is why the returned capability is validated below rather
 * than trusted, and why the TTL is short. No real remote adapter
 * exists yet, so the production choice between signed redirects and
 * full server-side proxying (with whatever revocation that implies)
 * is deliberately left open for a later approved stage.
 */
export async function servePrayerRoomMedia(input: {
  userId: number | null
  publicId: string
  request: Request
  now?: Date
  /** Test seam ONLY. Production reads the configured endpoint. */
  expectedMediaOrigin?: string | null
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
    const issuedAt = input.now ?? new Date()
    const signed = await access.provider.createSignedReadUrl({
      objectKey: access.objectKey,
      ttlSeconds: PRAYER_ROOM_SIGNED_URL_TTL_SECONDS,
      now: issuedAt,
    })
    // WHAT THE PROVIDER RETURNED, not what we asked for. An adapter
    // that ignores the requested TTL, hands back an already-dead link,
    // or answers over plain HTTP is refused here rather than
    // redirected to — the request we made is not evidence about the
    // capability we were given.
    if (
      !isAcceptableSignedRead(signed, issuedAt, {
        expectedOrigin: input.expectedMediaOrigin ?? configuredMediaOrigin(),
      })
    ) {
      return notAvailable()
    }
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
  // THE BYTES ACTUALLY ABOUT TO BE SERVED are re-proved here, not just
  // the object that verified a moment ago. Verification and reading are
  // two separate reads of the same key, and only this check covers what
  // happens between them — including a same-length substitution, which
  // a size check alone would wave through.
  if (
    !bytes ||
    bytes.length !== access.byteSize ||
    computeFileSha256(bytes) !== access.sha256
  ) {
    return notAvailable()
  }
  return buildPrivateMediaResponse(
    bytes,
    access.mimeType,
    input.request.headers.get('range'),
  )
}

/**
 * Proves a signed read capability is safe to hand out.
 *
 * A signed URL is a BEARER CAPABILITY: once issued, anyone holding it
 * can read the object directly from the provider until it expires,
 * WITHOUT passing back through this application. That is precisely why
 * its shape is checked rather than assumed — the bound we asked for is
 * only a request, and the expiry we were handed is the thing that will
 * actually govern the capability.
 */
function isAcceptableSignedRead(
  signed: { url: string; expiresAt: Date },
  now: Date,
  options: { expectedOrigin: string | null } = { expectedOrigin: null },
): boolean {
  let parsed: URL
  try {
    parsed = new URL(signed.url)
  } catch {
    return false
  }
  // A private recording is never fetched over a channel that can be
  // read in transit.
  if (parsed.protocol !== 'https:') return false
  // THE EXACT CONFIGURED ORIGIN, when one is configured. Phase One
  // delivers by redirecting to the private object-storage endpoint,
  // and the production CSP allows only that origin — so a signed URL
  // pointing anywhere else is either a misconfigured adapter or a
  // redirect to somebody else’s host, and neither is followed. With
  // no endpoint configured (local development, where storage is
  // proxied rather than redirected) there is nothing to pin to.
  if (options.expectedOrigin != null && parsed.origin !== options.expectedOrigin) {
    return false
  }
  const expiresMs = signed.expiresAt.getTime()
  if (!Number.isFinite(expiresMs)) return false
  // Already dead, or longer-lived than the ceiling this stage promises
  // (and therefore than Step 17's own maximum).
  if (expiresMs <= now.getTime()) return false
  if (
    expiresMs >
    now.getTime() + PRAYER_ROOM_SIGNED_URL_TTL_SECONDS * 1000
  ) {
    return false
  }
  return true
}
/** The origin the browser may be redirected to, derived from the
 * configured endpoint and validated as a plain HTTPS base URL. Null
 * in development, where local storage is proxied instead. */
function configuredMediaOrigin(): string | null {
  return mediaOriginFromEndpoint(env.OBJECT_STORAGE_ENDPOINT)
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
