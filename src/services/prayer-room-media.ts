import { createHash } from 'node:crypto'

import { and, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import { appointments, appointmentPrayerRoomMedia } from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import {
  checkObjectStorageAllowed,
  getObjectStorage,
  resolveObjectStorage,
} from '@/providers/object-storage/registry'
import {
  OBJECT_ALREADY_EXISTS_CODE,
  ObjectStorageError,
} from '@/providers/object-storage/types'
import { computeFileSha256 } from '@/providers/media/storage'
import { notifyPrayerRoomReady } from './notification-events'
import { PRAYER_ROOM_MEDIA_MAX_BYTES } from '@/lib/prayer-room-media-policy'
import type { RequestContext } from '@/auth/service'
import type { ObjectStorageProvider } from '@/providers/object-storage/types'

/**
 * Admin-prepared Prayer Room media.
 *
 * This is the manual production path: after a member books and pays,
 * staff use the appointment details to produce a video elsewhere, then
 * upload that finished recording into private object storage. The
 * public/member contract remains the same as generated media: owner
 * only, time-gated by the current appointment start, and re-proved on
 * every byte request.
 */

export class PrayerRoomMediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrayerRoomMediaError'
  }
}

const PLAYABLE_APPOINTMENT_STATUSES: ReadonlyArray<string> = [
  'CONFIRMED',
  'COMPLETED',
]
const PRAYER_ROOM_VIDEO_MIME_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

export function buildManualPrayerRoomObjectKey(input: {
  appointmentId: number
  fileSha256: string
  mimeType: string
}): { ok: true; objectKey: string } | { ok: false; reasonCode: string } {
  const extension = PRAYER_ROOM_VIDEO_MIME_EXTENSIONS[input.mimeType]
  if (!extension) return { ok: false, reasonCode: 'mime_type_invalid' }
  if (!/^[0-9a-f]{64}$/.test(input.fileSha256)) {
    return { ok: false, reasonCode: 'sha256_invalid' }
  }
  const identity = createHash('sha256')
    .update(
      `manual-prayer-room-v1|${String(input.appointmentId)}|${input.fileSha256}|${input.mimeType}`,
      'utf8',
    )
    .digest('hex')
  return {
    ok: true,
    // The object-storage adapters accept this canonical private shape.
    // The prefix is intentionally generic: object keys are storage
    // identities, not a public explanation of how the video was made.
    objectKey: `renders/${identity.slice(0, 2)}/${identity}.${extension}`,
  }
}

function assertVideoUpload(bytes: Uint8Array, mimeType: string): string {
  const extension = PRAYER_ROOM_VIDEO_MIME_EXTENSIONS[mimeType]
  if (!extension) {
    throw new PrayerRoomMediaError('Only MP4 and WebM videos are supported.')
  }
  if (bytes.length === 0) {
    throw new PrayerRoomMediaError('The uploaded recording is empty.')
  }
  if (bytes.length > PRAYER_ROOM_MEDIA_MAX_BYTES) {
    throw new PrayerRoomMediaError('The uploaded recording is too large.')
  }
  return extension
}

async function putOrAdoptPrivateObject(input: {
  provider: ObjectStorageProvider
  objectKey: string
  bytes: Uint8Array
  mimeType: string
  sha256: string
}) {
  try {
    return await input.provider.putPrivateObject({
      objectKey: input.objectKey,
      bytes: input.bytes,
      mimeType: input.mimeType,
      sha256: input.sha256,
    })
  } catch (error) {
    if (
      !(error instanceof ObjectStorageError) ||
      error.code !== OBJECT_ALREADY_EXISTS_CODE
    ) {
      throw error
    }
    const existing = await input.provider.verifyPrivateObjectIntegrity({
      objectKey: input.objectKey,
      expectedSha256: input.sha256,
      expectedByteSize: input.bytes.length,
      expectedMimeType: input.mimeType,
    })
    if (!existing.ok) {
      throw new PrayerRoomMediaError(
        `A different private object already exists at the canonical key (${existing.reasonCode}).`,
      )
    }
    return existing.descriptor
  }
}

export type PrayerRoomMediaAdminSummary = {
  id: number
  status: string
  mimeType: string
  byteSize: number
  durationSeconds: number | null
  fileSha256: string
  uploadedBy: number | null
  uploadedAt: Date
  revokedAt: Date | null
  adminNote: string | null
}

export function summarizePrayerRoomMediaForAdmin(
  row: typeof appointmentPrayerRoomMedia.$inferSelect | null | undefined,
): PrayerRoomMediaAdminSummary | null {
  if (!row) return null
  return {
    id: row.id,
    status: row.status,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    durationSeconds: row.durationSeconds,
    fileSha256: row.fileSha256,
    uploadedBy: row.uploadedBy,
    uploadedAt: row.uploadedAt,
    revokedAt: row.revokedAt,
    adminNote: row.adminNote,
  }
}

export async function getPrayerRoomMediaForAdmin(appointmentId: number) {
  const row = (
    await getDb()
      .select()
      .from(appointmentPrayerRoomMedia)
      .where(eq(appointmentPrayerRoomMedia.appointmentId, appointmentId))
      .limit(1)
  ).at(0)
  return summarizePrayerRoomMediaForAdmin(row)
}

export async function uploadPrayerRoomMediaForAppointment(
  actorId: number,
  ctx: RequestContext,
  appointmentId: number,
  bytes: Uint8Array,
  mimeType: string,
  metadata: {
    durationSeconds?: number | null
    adminNote?: string | null
  } = {},
): Promise<PrayerRoomMediaAdminSummary> {
  await requirePermission(actorId, 'appointments.manage')
  assertVideoUpload(bytes, mimeType)
  const fileSha256 = computeFileSha256(bytes)
  const provider = getObjectStorage()
  const allowed = checkObjectStorageAllowed(provider)
  if (!allowed.ok) {
    throw new PrayerRoomMediaError(
      `Private object storage is not available (${allowed.reasonCode}).`,
    )
  }

  const appointment = (
    await getDb()
      .select({
        id: appointments.id,
        status: appointments.status,
      })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1)
  ).at(0)
  if (!appointment) throw new PrayerRoomMediaError('Appointment not found.')
  if (!PLAYABLE_APPOINTMENT_STATUSES.includes(appointment.status)) {
    throw new PrayerRoomMediaError(
      'Prayer Room media can only be attached to confirmed or completed appointments.',
    )
  }

  const canonical = buildManualPrayerRoomObjectKey({
    appointmentId,
    fileSha256,
    mimeType,
  })
  if (!canonical.ok) {
    throw new PrayerRoomMediaError(
      `The recording could not be identified (${canonical.reasonCode}).`,
    )
  }
  const descriptor = await putOrAdoptPrivateObject({
    provider,
    objectKey: canonical.objectKey,
    bytes,
    mimeType,
    sha256: fileSha256,
  })

  const durationSeconds =
    metadata.durationSeconds != null
      ? Math.max(1, Math.min(36_000, Math.round(metadata.durationSeconds)))
      : null
  const adminNote = metadata.adminNote?.trim().slice(0, 500) || null

  const media = await getDb().transaction(async (tx) => {
    const locked = (
      await tx
        .select({ id: appointments.id, status: appointments.status })
        .from(appointments)
        .where(eq(appointments.id, appointmentId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!locked) throw new PrayerRoomMediaError('Appointment not found.')
    if (!PLAYABLE_APPOINTMENT_STATUSES.includes(locked.status)) {
      throw new PrayerRoomMediaError(
        'Prayer Room media can only be attached to confirmed or completed appointments.',
      )
    }

    const existing = (
      await tx
        .select()
        .from(appointmentPrayerRoomMedia)
        .where(eq(appointmentPrayerRoomMedia.appointmentId, appointmentId))
        .limit(1)
        .for('update')
    ).at(0)
    const values = {
      uploadedBy: actorId,
      status: 'ACTIVE' as const,
      providerCode: provider.code,
      providerIsLocal: provider.isLocal ? 1 : 0,
      objectKey: descriptor.objectKey,
      fileSha256,
      mimeType,
      byteSize: bytes.length,
      durationSeconds,
      providerEtag: descriptor.providerEtag?.slice(0, 200) ?? null,
      providerVersionId: descriptor.providerVersionId?.slice(0, 200) ?? null,
      adminNote,
      uploadedAt: new Date(),
      revokedAt: null,
    }
    if (existing) {
      await tx
        .update(appointmentPrayerRoomMedia)
        .set(values)
        .where(
          and(
            eq(appointmentPrayerRoomMedia.id, existing.id),
            eq(appointmentPrayerRoomMedia.appointmentId, appointmentId),
          ),
        )
    } else {
      await tx.insert(appointmentPrayerRoomMedia).values({
        appointmentId,
        ...values,
      })
    }
    const row = (
      await tx
        .select()
        .from(appointmentPrayerRoomMedia)
        .where(eq(appointmentPrayerRoomMedia.appointmentId, appointmentId))
        .limit(1)
    ).at(0)
    if (!row) throw new PrayerRoomMediaError('Prayer Room media row vanished.')
    return row
  })

  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_room_media.uploaded',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: {
      mediaId: media.id,
      mimeType,
      byteSize: bytes.length,
      sha256: fileSha256,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  await notifyPrayerRoomReady(appointmentId)
  return summarizePrayerRoomMediaForAdmin(media)!
}

export async function revokePrayerRoomMediaForAppointment(
  actorId: number,
  ctx: RequestContext,
  appointmentId: number,
  reason: string,
): Promise<void> {
  await requirePermission(actorId, 'appointments.manage')
  const trimmed = reason.trim()
  if (!trimmed) {
    throw new PrayerRoomMediaError('A revocation reason is required.')
  }
  const changed = await getDb().transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(appointmentPrayerRoomMedia)
        .where(eq(appointmentPrayerRoomMedia.appointmentId, appointmentId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!row || row.status !== 'ACTIVE') return null
    await tx
      .update(appointmentPrayerRoomMedia)
      .set({
        status: 'REVOKED',
        revokedAt: new Date(),
        adminNote: trimmed.slice(0, 500),
      })
      .where(eq(appointmentPrayerRoomMedia.id, row.id))
    return row
  })
  if (!changed) return
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_room_media.revoked',
    entityType: 'appointment',
    entityId: String(appointmentId),
    metadata: { mediaId: changed.id },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export type VerifiedManualPrayerRoomMedia = {
  objectKey: string
  byteSize: number
  mimeType: string
  sha256: string
  provider: ObjectStorageProvider
}

export type ManualPrayerRoomMediaVerification =
  | { ok: true; verified: VerifiedManualPrayerRoomMedia }
  | { ok: false; errorCode: string; detail: string | null }

export async function verifyManualPrayerRoomMedia(
  media: Pick<
    typeof appointmentPrayerRoomMedia.$inferSelect,
    | 'status'
    | 'providerCode'
    | 'providerIsLocal'
    | 'objectKey'
    | 'fileSha256'
    | 'byteSize'
    | 'mimeType'
  >,
): Promise<ManualPrayerRoomMediaVerification> {
  if (media.status !== 'ACTIVE') {
    return { ok: false, errorCode: 'MANUAL_MEDIA_NOT_ACTIVE', detail: null }
  }
  const provider = resolveObjectStorage(media.providerCode)
  if (!provider) {
    return {
      ok: false,
      errorCode: 'OBJECT_STORAGE_NOT_PERMITTED',
      detail: 'provider_code_mismatch',
    }
  }
  const allowed = checkObjectStorageAllowed(provider)
  if (!allowed.ok) {
    return {
      ok: false,
      errorCode: 'OBJECT_STORAGE_NOT_PERMITTED',
      detail: allowed.reasonCode,
    }
  }
  if (media.providerIsLocal !== (provider.isLocal ? 1 : 0)) {
    return {
      ok: false,
      errorCode: 'MANUAL_MEDIA_PROVIDER_MISMATCH',
      detail: 'provider_locality_changed',
    }
  }
  const verified = await provider.verifyPrivateObjectIntegrity({
    objectKey: media.objectKey,
    expectedSha256: media.fileSha256,
    expectedByteSize: media.byteSize,
    expectedMimeType: media.mimeType,
  })
  if (!verified.ok) {
    return {
      ok: false,
      errorCode: 'MANUAL_MEDIA_INTEGRITY_FAILURE',
      detail: verified.reasonCode,
    }
  }
  return {
    ok: true,
    verified: {
      objectKey: media.objectKey,
      byteSize: media.byteSize,
      mimeType: media.mimeType,
      sha256: media.fileSha256,
      provider,
    },
  }
}
