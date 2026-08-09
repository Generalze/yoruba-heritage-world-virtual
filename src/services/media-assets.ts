import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gt, inArray, isNotNull, ne, or } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  CONTENT_SCOPE_TYPES,
  GUIDANCE_LANGUAGES,
  MEDIA_ASSET_KINDS,
  MEDIA_CONSENT_STATUSES,
  MEDIA_EXTERNAL_AI_POLICIES,
  MEDIA_SOURCE_TYPES,
  RIGHTS_STATUSES,
  SACRED_MEDIA_LINK_ROLES,
  SACRED_RUNTIME_CONTENT_TYPES,
  mediaAssetVersions,
  mediaAssets,
  sacredContentMediaLinks,
  sacredHouses,
  services,
  spiritualContentItems,
  spiritualContentVersions,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { ForbiddenError, requirePermission } from '@/auth/guards'
import { userHasPermission } from '@/auth/rbac'
import { computeFileSha256, getMediaStorage } from '@/providers/media/storage'
import type { MediaStorageProvider } from '@/providers/media/storage'
import type { DbClient } from '@/db'
import type {
  ContentScopeType,
  ContentVersionStatus,
  MediaAssetKind,
  MediaConsentStatus,
  RightsStatus,
  SacredMediaLinkRole,
} from '@/db/schema'
import type { RequestContext } from '@/auth/service'

/**
 * Approved media asset library (Phase One, Step 10).
 *
 * Humans approve UPSTREAM once — editorial publication (the shared
 * DRAFT → UNDER_REVIEW → APPROVED → PUBLISHED → ARCHIVED machine),
 * rights clearance, identifiable-person consent, and the
 * runtime_enabled switch. Runtime eligibility is COMPUTED from those
 * gates plus storage/byte-hash integrity. No per-appointment media
 * approval exists; Step 10 never chooses media for an appointment.
 *
 * Voice/likeness safety: nothing here implies real-person voice
 * cloning or likeness generation. voice_clone_authorized defaults
 * FALSE, is a documented-permission flag only, and
 * DERIVATIVE_GENERATION_ALLOWED never implies it. Step 10 calls no
 * generation/TTS provider of any kind.
 */

export class MediaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaError'
  }
}

// --- Bounded types/sizes ----------------------------------------------------

export const MEDIA_MIME_TYPES: Record<
  MediaAssetKind,
  Record<string, string>
> = {
  AUDIO: {
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
  },
  IMAGE: {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
  },
  VIDEO: {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
  },
}

export const MEDIA_MAX_BYTES: Record<MediaAssetKind, number> = {
  AUDIO: 25 * 1024 * 1024,
  IMAGE: 10 * 1024 * 1024,
  VIDEO: 100 * 1024 * 1024,
}

// --- Validation schemas -----------------------------------------------------

export const mediaAssetSchema = z.object({
  code: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]{2,59}$/,
      'Code must be an UPPER_SNAKE_CASE ASCII identifier (3–60 chars).',
    ),
  assetKind: z.enum(MEDIA_ASSET_KINDS),
  scopeType: z.enum(CONTENT_SCOPE_TYPES),
  sacredHouseId: z.number().int().positive().nullable().optional(),
  serviceId: z.number().int().positive().nullable().optional(),
  contentType: z.enum(SACRED_RUNTIME_CONTENT_TYPES).nullable().default(null),
  themeCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,59}$/)
    .nullable()
    .default(null),
})
export type MediaAssetInput = z.infer<typeof mediaAssetSchema>

/** DRAFT-editable authored metadata. Consent may only be declared as
 * NOT_APPLICABLE or PENDING by authors — GRANTED is an ADMIN
 * confirmation through the dedicated consent transition. */
export const mediaVersionMetadataSchema = z.object({
  sourceType: z.enum(MEDIA_SOURCE_TYPES),
  language: z.enum(GUIDANCE_LANGUAGES).nullable().default(null),
  durationSeconds: z.number().int().min(1).max(36_000).nullable().default(null),
  width: z.number().int().min(1).max(16_000).nullable().default(null),
  height: z.number().int().min(1).max(16_000).nullable().default(null),
  containsIdentifiablePerson: z.boolean().default(false),
  consentStatus: z
    .enum(['NOT_APPLICABLE', 'PENDING'] as const)
    .default('NOT_APPLICABLE'),
  consentReference: z.string().trim().max(500).nullable().default(null),
  externalAiPolicy: z
    .enum(MEDIA_EXTERNAL_AI_POLICIES)
    .default('NO_EXTERNAL_AI'),
  voiceCloneAuthorized: z.boolean().default(false),
})
export type MediaVersionMetadataInput = z.infer<
  typeof mediaVersionMetadataSchema
>

function validateMetadata(
  input: MediaVersionMetadataInput,
): MediaVersionMetadataInput {
  if (
    input.containsIdentifiablePerson &&
    input.consentStatus === 'NOT_APPLICABLE'
  ) {
    throw new MediaError(
      'Media containing an identifiable person requires consent tracking (PENDING until ADMIN confirms).',
    )
  }
  if (!input.containsIdentifiablePerson && input.consentStatus === 'PENDING') {
    throw new MediaError(
      'Consent tracking only applies to media containing an identifiable person.',
    )
  }
  return input
}

// --- Asset structure --------------------------------------------------------

async function resolveMediaScope(
  input: MediaAssetInput,
  db: DbClient,
): Promise<{
  scopeType: ContentScopeType
  sacredHouseId: number | null
  serviceId: number | null
}> {
  switch (input.scopeType) {
    case 'PLATFORM': {
      if (input.sacredHouseId != null || input.serviceId != null) {
        throw new MediaError(
          'Platform-scoped media must not reference a Sacred House or Service.',
        )
      }
      return { scopeType: 'PLATFORM', sacredHouseId: null, serviceId: null }
    }
    case 'SACRED_HOUSE': {
      if (input.serviceId != null || input.sacredHouseId == null) {
        throw new MediaError(
          'House-scoped media requires exactly a Sacred House.',
        )
      }
      const house = (
        await db
          .select({ id: sacredHouses.id })
          .from(sacredHouses)
          .where(eq(sacredHouses.id, input.sacredHouseId))
          .limit(1)
      ).at(0)
      if (!house) throw new MediaError('Sacred House not found.')
      return {
        scopeType: 'SACRED_HOUSE',
        sacredHouseId: house.id,
        serviceId: null,
      }
    }
    case 'SERVICE': {
      if (input.sacredHouseId != null || input.serviceId == null) {
        throw new MediaError('Service-scoped media requires exactly a Service.')
      }
      const service = (
        await db
          .select({ id: services.id })
          .from(services)
          .where(eq(services.id, input.serviceId))
          .limit(1)
      ).at(0)
      if (!service) throw new MediaError('Service not found.')
      return {
        scopeType: 'SERVICE',
        sacredHouseId: null,
        serviceId: service.id,
      }
    }
  }
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

export async function createMediaAsset(
  actorId: number,
  ctx: RequestContext,
  rawInput: MediaAssetInput,
): Promise<{ id: number; publicId: string }> {
  await requirePermission(actorId, 'media.manage')
  const input = mediaAssetSchema.parse(rawInput)
  const db = getDb()
  const scope = await resolveMediaScope(input, db)
  const publicId = randomUUID()
  let assetId: number
  try {
    const inserted = await db.insert(mediaAssets).values({
      publicId,
      code: input.code,
      assetKind: input.assetKind,
      scopeType: scope.scopeType,
      sacredHouseId: scope.sacredHouseId,
      serviceId: scope.serviceId,
      contentType: input.contentType,
      themeCode: input.themeCode,
      createdBy: actorId,
    })
    assetId = inserted[0].insertId
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new MediaError('A media asset with this code already exists.')
    }
    throw error
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'media.asset_created',
    entityType: 'media_asset',
    entityId: String(assetId),
    metadata: {
      publicId,
      code: input.code,
      assetKind: input.assetKind,
      scopeType: scope.scopeType,
      sacredHouseId: scope.sacredHouseId,
      serviceId: scope.serviceId,
      contentType: input.contentType,
      themeCode: input.themeCode,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return { id: assetId, publicId }
}

async function lockMediaAsset(tx: DbClient, assetId: number) {
  const row = (
    await tx
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId))
      .limit(1)
      .for('update')
  ).at(0)
  if (!row) throw new MediaError('Media asset not found.')
  return row
}

/** Permanent structure freeze after first review contact (durable
 * submitted_at / non-DRAFT status), matching Steps 7–9. */
async function isAssetStructureFrozen(
  assetId: number,
  db: DbClient,
): Promise<boolean> {
  const evidence = await db
    .select({ id: mediaAssetVersions.id })
    .from(mediaAssetVersions)
    .where(
      and(
        eq(mediaAssetVersions.assetId, assetId),
        or(
          isNotNull(mediaAssetVersions.submittedAt),
          ne(mediaAssetVersions.status, 'DRAFT'),
        ),
      ),
    )
    .limit(1)
  return evidence.length > 0
}

export async function updateMediaAsset(
  actorId: number,
  ctx: RequestContext,
  assetId: number,
  rawInput: MediaAssetInput,
): Promise<void> {
  await requirePermission(actorId, 'media.manage')
  const input = mediaAssetSchema.parse(rawInput)
  await getDb().transaction(async (tx) => {
    const row = await lockMediaAsset(tx, assetId)
    const frozen = await isAssetStructureFrozen(assetId, tx)
    const structuralChange =
      input.code !== row.code ||
      input.assetKind !== row.assetKind ||
      input.scopeType !== row.scopeType ||
      (input.sacredHouseId ?? null) !== row.sacredHouseId ||
      (input.serviceId ?? null) !== row.serviceId
    if (frozen && structuralChange) {
      throw new MediaError(
        'This asset has reviewed versions — its code, kind and scope are frozen. Create a new asset instead.',
      )
    }
    const scope = frozen
      ? {
          scopeType: row.scopeType,
          sacredHouseId: row.sacredHouseId,
          serviceId: row.serviceId,
        }
      : await resolveMediaScope(input, tx)
    await tx
      .update(mediaAssets)
      .set({
        code: frozen ? row.code : input.code,
        assetKind: frozen ? row.assetKind : input.assetKind,
        scopeType: scope.scopeType,
        sacredHouseId: scope.sacredHouseId,
        serviceId: scope.serviceId,
        contentType: input.contentType,
        themeCode: input.themeCode,
      })
      .where(eq(mediaAssets.id, assetId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'media.asset_updated',
    entityType: 'media_asset',
    entityId: String(assetId),
    metadata: { contentType: input.contentType, themeCode: input.themeCode },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/** Active toggle with the durable publication-evidence authority rule. */
export async function setMediaAssetActive(
  actorId: number,
  ctx: RequestContext,
  assetId: number,
  active: boolean,
): Promise<void> {
  const canManage = await userHasPermission(actorId, 'media.manage')
  const canPublish = await userHasPermission(actorId, 'media.publish')
  await getDb().transaction(async (tx) => {
    await lockMediaAsset(tx, assetId)
    const hasPublicationEvidence =
      (
        await tx
          .select({ id: mediaAssetVersions.id })
          .from(mediaAssetVersions)
          .where(
            and(
              eq(mediaAssetVersions.assetId, assetId),
              isNotNull(mediaAssetVersions.publishedAt),
            ),
          )
          .limit(1)
      ).length > 0
    const allowed = hasPublicationEvidence ? canPublish : canManage
    if (!allowed) throw new ForbiddenError()
    await tx
      .update(mediaAssets)
      .set({ active })
      .where(eq(mediaAssets.id, assetId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: active ? 'media.asset_updated' : 'media.asset_deactivated',
    entityType: 'media_asset',
    entityId: String(assetId),
    metadata: { active },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Versions (binary + metadata) -------------------------------------------

const WORKING_STATUSES: Array<ContentVersionStatus> = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
]

/**
 * Uploads a DRAFT media version. The binary is stored under a
 * SERVER-GENERATED private key; the SHA-256 integrity hash is computed
 * here from the exact uploaded bytes — never accepted from a client.
 * The binary is immutable from creation; replacement means a NEW
 * version. Metadata stays editable only while DRAFT.
 */
export async function createMediaVersion(
  actorId: number,
  ctx: RequestContext,
  assetId: number,
  bytes: Uint8Array,
  mimeType: string,
  rawMetadata: MediaVersionMetadataInput,
): Promise<{ id: number; versionNumber: number; fileSha256: string }> {
  await requirePermission(actorId, 'media.manage')
  const metadata = validateMetadata(
    mediaVersionMetadataSchema.parse(rawMetadata),
  )
  const storage = getMediaStorage()
  const preAsset = (
    await getDb()
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId))
      .limit(1)
  ).at(0)
  if (!preAsset) throw new MediaError('Media asset not found.')
  const extension = MEDIA_MIME_TYPES[preAsset.assetKind][mimeType]
  if (!extension) {
    throw new MediaError(
      `Unsupported ${preAsset.assetKind} media type: ${mimeType}.`,
    )
  }
  if (bytes.length === 0) throw new MediaError('Empty media upload.')
  if (bytes.length > MEDIA_MAX_BYTES[preAsset.assetKind]) {
    throw new MediaError('Media upload exceeds the size limit for this kind.')
  }
  const fileSha256 = computeFileSha256(bytes)
  const { storageKey } = await storage.put(bytes, extension)
  const result = await getDb().transaction(async (tx) => {
    const asset = await lockMediaAsset(tx, assetId)
    const working = await tx
      .select({ id: mediaAssetVersions.id })
      .from(mediaAssetVersions)
      .where(
        and(
          eq(mediaAssetVersions.assetId, assetId),
          inArray(mediaAssetVersions.status, WORKING_STATUSES),
        ),
      )
      .limit(1)
    if (working.length > 0) {
      throw new MediaError(
        'A working version (draft, under review or approved) already exists for this asset.',
      )
    }
    const latest = (
      await tx
        .select({ versionNumber: mediaAssetVersions.versionNumber })
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.assetId, assetId))
        .orderBy(desc(mediaAssetVersions.versionNumber))
        .limit(1)
    ).at(0)
    const versionNumber = (latest?.versionNumber ?? 0) + 1
    const inserted = await tx.insert(mediaAssetVersions).values({
      assetId: asset.id,
      versionNumber,
      sourceType: metadata.sourceType,
      language: metadata.language,
      mimeType,
      byteSize: bytes.length,
      durationSeconds: metadata.durationSeconds,
      width: metadata.width,
      height: metadata.height,
      storageKey,
      fileSha256,
      containsIdentifiablePerson: metadata.containsIdentifiablePerson,
      consentStatus: metadata.consentStatus,
      consentReference: metadata.consentReference,
      externalAiPolicy: metadata.externalAiPolicy,
      voiceCloneAuthorized: metadata.voiceCloneAuthorized,
      status: 'DRAFT',
      createdBy: actorId,
    })
    return { id: inserted[0].insertId, versionNumber, fileSha256 }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'media.version_created',
    entityType: 'media_asset_version',
    entityId: String(result.id),
    // ids/technical facts only — NEVER file bytes or consent reference.
    metadata: {
      assetId,
      versionNumber: result.versionNumber,
      sourceType: metadata.sourceType,
      mimeType,
      byteSize: bytes.length,
      fileSha256,
      containsIdentifiablePerson: metadata.containsIdentifiablePerson,
      externalAiPolicy: metadata.externalAiPolicy,
      voiceCloneAuthorized: metadata.voiceCloneAuthorized,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return result
}

export async function loadMediaVersion(
  versionId: number,
  db: DbClient = getDb(),
) {
  const row = (
    await db
      .select()
      .from(mediaAssetVersions)
      .where(eq(mediaAssetVersions.id, versionId))
      .limit(1)
  ).at(0)
  if (!row) throw new MediaError('Media version not found.')
  return row
}

export async function loadMediaAsset(assetId: number, db: DbClient = getDb()) {
  const row = (
    await db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId))
      .limit(1)
  ).at(0)
  if (!row) throw new MediaError('Media asset not found.')
  return row
}

/** DRAFT-only metadata editing (binary is immutable from creation). */
export async function updateDraftMediaVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  rawMetadata: MediaVersionMetadataInput,
): Promise<void> {
  await requirePermission(actorId, 'media.manage')
  const metadata = validateMetadata(
    mediaVersionMetadataSchema.parse(rawMetadata),
  )
  const current = await loadMediaVersion(versionId)
  await getDb().transaction(async (tx) => {
    await lockMediaAsset(tx, current.assetId)
    const target = (
      await tx
        .select({ status: mediaAssetVersions.status })
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target || target.status !== 'DRAFT') {
      throw new MediaError('Only draft versions can be edited.')
    }
    await tx
      .update(mediaAssetVersions)
      .set({
        sourceType: metadata.sourceType,
        language: metadata.language,
        durationSeconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        containsIdentifiablePerson: metadata.containsIdentifiablePerson,
        consentStatus: metadata.consentStatus,
        consentReference: metadata.consentReference,
        externalAiPolicy: metadata.externalAiPolicy,
        voiceCloneAuthorized: metadata.voiceCloneAuthorized,
      })
      .where(eq(mediaAssetVersions.id, versionId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'media.version_updated',
    entityType: 'media_asset_version',
    entityId: String(versionId),
    metadata: {
      assetId: current.assetId,
      versionNumber: current.versionNumber,
      sourceType: metadata.sourceType,
      externalAiPolicy: metadata.externalAiPolicy,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Workflow transitions ---------------------------------------------------

async function transitionAudit(
  actorId: number,
  ctx: RequestContext,
  action: string,
  versionId: number,
  current: { assetId: number; versionNumber: number },
  from: string,
  to: string,
): Promise<void> {
  await recordAuditEvent({
    actorUserId: actorId,
    action,
    entityType: 'media_asset_version',
    entityId: String(versionId),
    metadata: {
      assetId: current.assetId,
      versionNumber: current.versionNumber,
      from,
      to,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function submitMediaVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'media.manage')
  const current = await loadMediaVersion(versionId)
  await getDb().transaction(async (tx) => {
    await lockMediaAsset(tx, current.assetId)
    const result = await tx
      .update(mediaAssetVersions)
      .set({
        status: 'UNDER_REVIEW',
        submittedAt: new Date(),
        reviewNote: null,
      })
      .where(
        and(
          eq(mediaAssetVersions.id, versionId),
          eq(mediaAssetVersions.status, 'DRAFT'),
        ),
      )
    if (result[0].affectedRows !== 1) {
      throw new MediaError('Only draft versions can be submitted for review.')
    }
  })
  await transitionAudit(
    actorId,
    ctx,
    'media.version_submitted',
    versionId,
    current,
    'DRAFT',
    'UNDER_REVIEW',
  )
}

export async function returnMediaVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  reason: string,
): Promise<void> {
  await requirePermission(actorId, 'media.approve')
  const trimmed = reason.trim()
  if (!trimmed) throw new MediaError('Returning to draft requires a reason.')
  const current = await loadMediaVersion(versionId)
  const result = await getDb()
    .update(mediaAssetVersions)
    .set({
      status: 'DRAFT',
      reviewNote: trimmed.slice(0, 500),
      approvedBy: null,
      approvedAt: null,
    })
    .where(
      and(
        eq(mediaAssetVersions.id, versionId),
        eq(mediaAssetVersions.status, 'UNDER_REVIEW'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new MediaError('Only versions under review can be returned to draft.')
  }
  await transitionAudit(
    actorId,
    ctx,
    'media.version_returned',
    versionId,
    current,
    'UNDER_REVIEW',
    'DRAFT',
  )
}

export async function approveMediaVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'media.approve')
  const current = await loadMediaVersion(versionId)
  const result = await getDb()
    .update(mediaAssetVersions)
    .set({ status: 'APPROVED', approvedBy: actorId, approvedAt: new Date() })
    .where(
      and(
        eq(mediaAssetVersions.id, versionId),
        eq(mediaAssetVersions.status, 'UNDER_REVIEW'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new MediaError('Only versions under review can be approved.')
  }
  await transitionAudit(
    actorId,
    ctx,
    'media.version_approved',
    versionId,
    current,
    'UNDER_REVIEW',
    'APPROVED',
  )
}

export async function publishMediaVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<{ archivedVersionId: number | null }> {
  await requirePermission(actorId, 'media.publish')
  const preRead = await loadMediaVersion(versionId)
  const outcome = await getDb().transaction(async (tx) => {
    await lockMediaAsset(tx, preRead.assetId)
    const target = (
      await tx
        .select({ status: mediaAssetVersions.status })
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target || target.status !== 'APPROVED') {
      throw new MediaError('Only approved versions can be published.')
    }
    const currentPublished = (
      await tx
        .select({ id: mediaAssetVersions.id })
        .from(mediaAssetVersions)
        .where(
          and(
            eq(mediaAssetVersions.assetId, preRead.assetId),
            eq(mediaAssetVersions.status, 'PUBLISHED'),
          ),
        )
        .limit(1)
    ).at(0)
    if (currentPublished) {
      const archived = await tx
        .update(mediaAssetVersions)
        .set({ status: 'ARCHIVED', archivedAt: new Date() })
        .where(
          and(
            eq(mediaAssetVersions.id, currentPublished.id),
            eq(mediaAssetVersions.status, 'PUBLISHED'),
          ),
        )
      if (archived[0].affectedRows !== 1) {
        throw new MediaError('Publication conflict — try again.')
      }
    }
    const published = await tx
      .update(mediaAssetVersions)
      .set({
        status: 'PUBLISHED',
        publishedBy: actorId,
        publishedAt: new Date(),
      })
      .where(
        and(
          eq(mediaAssetVersions.id, versionId),
          eq(mediaAssetVersions.status, 'APPROVED'),
        ),
      )
    if (published[0].affectedRows !== 1) {
      throw new MediaError('Publication conflict — try again.')
    }
    return { archivedVersionId: currentPublished?.id ?? null }
  })
  await transitionAudit(
    actorId,
    ctx,
    'media.version_published',
    versionId,
    preRead,
    'APPROVED',
    'PUBLISHED',
  )
  return outcome
}

export async function archiveMediaVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'media.publish')
  const preRead = await loadMediaVersion(versionId)
  const fromStatus = await getDb().transaction(async (tx) => {
    await lockMediaAsset(tx, preRead.assetId)
    const target = (
      await tx
        .select({ status: mediaAssetVersions.status })
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target) throw new MediaError('Media version not found.')
    if (target.status === 'ARCHIVED') {
      throw new MediaError('This version is already archived.')
    }
    const result = await tx
      .update(mediaAssetVersions)
      .set({ status: 'ARCHIVED', archivedAt: new Date() })
      .where(
        and(
          eq(mediaAssetVersions.id, versionId),
          eq(mediaAssetVersions.status, target.status),
        ),
      )
    if (result[0].affectedRows !== 1) {
      throw new MediaError('Archive conflict — try again.')
    }
    return target.status
  })
  await transitionAudit(
    actorId,
    ctx,
    'media.version_archived',
    versionId,
    preRead,
    fromStatus,
    'ARCHIVED',
  )
}

// --- Rights & consent (independent ADMIN gates) -----------------------------

const RIGHTS_TRANSITIONS: Record<RightsStatus, Array<RightsStatus>> = {
  UNREVIEWED: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['CLEARED', 'RESTRICTED'],
  CLEARED: ['RESTRICTED', 'WITHDRAWN'],
  RESTRICTED: ['PENDING_REVIEW'],
  WITHDRAWN: ['PENDING_REVIEW'],
}

export async function setMediaRightsStatus(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  next: RightsStatus,
  note?: string,
): Promise<void> {
  await requirePermission(actorId, 'media.rights_manage')
  if (!RIGHTS_STATUSES.includes(next)) {
    throw new MediaError('Unknown rights status.')
  }
  const trimmedNote = note?.trim() ?? ''
  if ((next === 'RESTRICTED' || next === 'WITHDRAWN') && !trimmedNote) {
    throw new MediaError(
      'Restricting or withdrawing rights requires a reason note.',
    )
  }
  const current = await loadMediaVersion(versionId)
  const previous = await getDb().transaction(async (tx) => {
    await lockMediaAsset(tx, current.assetId)
    const row = (
      await tx
        .select({
          rightsStatus: mediaAssetVersions.rightsStatus,
          status: mediaAssetVersions.status,
        })
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!row) throw new MediaError('Media version not found.')
    if (!RIGHTS_TRANSITIONS[row.rightsStatus].includes(next)) {
      throw new MediaError(
        `Rights cannot move from ${row.rightsStatus} to ${next}.`,
      )
    }
    if (
      next === 'CLEARED' &&
      row.status !== 'APPROVED' &&
      row.status !== 'PUBLISHED'
    ) {
      throw new MediaError(
        'Rights can only be cleared on immutable (approved or published) media.',
      )
    }
    const updated = await tx
      .update(mediaAssetVersions)
      .set({
        rightsStatus: next,
        rightsReviewedBy: actorId,
        rightsReviewedAt: new Date(),
        rightsNote: trimmedNote.slice(0, 1000) || null,
      })
      .where(
        and(
          eq(mediaAssetVersions.id, versionId),
          eq(mediaAssetVersions.rightsStatus, row.rightsStatus),
        ),
      )
    if (updated[0].affectedRows !== 1) {
      throw new MediaError('Rights transition conflict — try again.')
    }
    return row.rightsStatus
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: `media.rights_${next.toLowerCase()}`,
    entityType: 'media_asset_version',
    entityId: String(versionId),
    metadata: {
      assetId: current.assetId,
      versionNumber: current.versionNumber,
      from: previous,
      to: next,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

const CONSENT_TRANSITIONS: Record<
  MediaConsentStatus,
  Array<MediaConsentStatus>
> = {
  NOT_APPLICABLE: ['PENDING'],
  PENDING: ['GRANTED', 'WITHDRAWN'],
  GRANTED: ['WITHDRAWN'],
  WITHDRAWN: ['PENDING'],
}

/** ADMIN consent confirmation for identifiable-person media. GRANTED
 * requires a documented consent reference (staff-only text, never in
 * audit metadata or any public payload). */
export async function setMediaConsentStatus(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  next: MediaConsentStatus,
  consentReference?: string,
): Promise<void> {
  await requirePermission(actorId, 'media.rights_manage')
  if (!MEDIA_CONSENT_STATUSES.includes(next)) {
    throw new MediaError('Unknown consent status.')
  }
  const reference = consentReference?.trim() ?? ''
  if (next === 'GRANTED' && !reference) {
    throw new MediaError(
      'Granting consent requires a documented consent reference.',
    )
  }
  const current = await loadMediaVersion(versionId)
  const previous = await getDb().transaction(async (tx) => {
    await lockMediaAsset(tx, current.assetId)
    const row = (
      await tx
        .select({
          consentStatus: mediaAssetVersions.consentStatus,
          containsIdentifiablePerson:
            mediaAssetVersions.containsIdentifiablePerson,
        })
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!row) throw new MediaError('Media version not found.')
    if (!row.containsIdentifiablePerson) {
      throw new MediaError(
        'Consent transitions only apply to media containing an identifiable person.',
      )
    }
    if (!CONSENT_TRANSITIONS[row.consentStatus].includes(next)) {
      throw new MediaError(
        `Consent cannot move from ${row.consentStatus} to ${next}.`,
      )
    }
    const updated = await tx
      .update(mediaAssetVersions)
      .set({
        consentStatus: next,
        consentReference: reference.slice(0, 500) || null,
      })
      .where(
        and(
          eq(mediaAssetVersions.id, versionId),
          eq(mediaAssetVersions.consentStatus, row.consentStatus),
        ),
      )
    if (updated[0].affectedRows !== 1) {
      throw new MediaError('Consent transition conflict — try again.')
    }
    return row.consentStatus
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: `media.consent_${next.toLowerCase()}`,
    entityType: 'media_asset_version',
    entityId: String(versionId),
    // Old/new state only — the consent reference NEVER enters audit.
    metadata: {
      assetId: current.assetId,
      versionNumber: current.versionNumber,
      from: previous,
      to: next,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Runtime eligibility (computed, fail-closed) ----------------------------

export interface MediaEligibilityInput {
  asset: { active: boolean; assetKind: MediaAssetKind }
  version: {
    status: string
    rightsStatus: string
    runtimeEnabled: boolean
    mimeType: string
    storageKey: string
    fileSha256: string
    containsIdentifiablePerson: boolean
    consentStatus: string
  }
}

/**
 * THE central media runtime eligibility formula. Every gate must hold
 * simultaneously; storage/byte-hash integrity fails CLOSED and is
 * never auto-healed. Rights or consent withdrawal removes future
 * eligibility immediately (this is computed per call, never cached).
 */
export async function isMediaAssetRuntimeEligible(
  input: MediaEligibilityInput,
  storage: MediaStorageProvider = getMediaStorage(),
): Promise<{ eligible: boolean; failures: Array<string> }> {
  const failures: Array<string> = []
  if (!input.asset.active) failures.push('asset_inactive')
  if (input.version.status !== 'PUBLISHED') failures.push('not_published')
  if (input.version.rightsStatus !== 'CLEARED') {
    failures.push('rights_not_cleared')
  }
  if (!input.version.runtimeEnabled) failures.push('runtime_not_enabled')
  if (!MEDIA_MIME_TYPES[input.asset.assetKind][input.version.mimeType]) {
    failures.push('unsupported_media_type')
  }
  if (input.version.containsIdentifiablePerson) {
    if (input.version.consentStatus !== 'GRANTED') {
      failures.push('consent_not_granted')
    }
  } else if (
    input.version.consentStatus !== 'NOT_APPLICABLE' &&
    input.version.consentStatus !== 'GRANTED'
  ) {
    failures.push('consent_invalid')
  }
  const bytes = await storage.get(input.version.storageKey)
  if (bytes == null) {
    failures.push('storage_object_missing')
  } else if (computeFileSha256(bytes) !== input.version.fileSha256) {
    failures.push('file_hash_mismatch')
  }
  return { eligible: failures.length === 0, failures }
}

export async function setMediaRuntimeEnabled(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  enabled: boolean,
): Promise<void> {
  await requirePermission(actorId, 'media.publish')
  const current = await loadMediaVersion(versionId)
  await getDb().transaction(async (tx) => {
    const asset = await lockMediaAsset(tx, current.assetId)
    const version = (
      await tx
        .select()
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!version) throw new MediaError('Media version not found.')
    if (enabled) {
      const check = await isMediaAssetRuntimeEligible({
        asset,
        version: { ...version, runtimeEnabled: true },
      })
      if (!check.eligible) {
        throw new MediaError(
          `Runtime cannot be enabled: ${check.failures.join(', ')}.`,
        )
      }
    }
    await tx
      .update(mediaAssetVersions)
      .set({ runtimeEnabled: enabled })
      .where(eq(mediaAssetVersions.id, versionId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: enabled ? 'media.runtime_enabled' : 'media.runtime_disabled',
    entityType: 'media_asset_version',
    entityId: String(versionId),
    metadata: {
      assetId: current.assetId,
      versionNumber: current.versionNumber,
      runtimeEnabled: enabled,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Complete eligible-media enumeration (internal) -------------------------

export interface EligibleMediaFilters {
  assetKind?: MediaAssetKind
  language?: (typeof GUIDANCE_LANGUAGES)[number]
  sacredHouseId?: number
  serviceId?: number
  contentType?: (typeof SACRED_RUNTIME_CONTENT_TYPES)[number]
  themeCode?: string
}

/**
 * "What approved media is valid for autonomous use right now?" —
 * complete keyset pagination (bounded pages, loud ceiling, no silent
 * truncation), every returned row re-verified against private storage
 * bytes. Scope semantics mirror Step 8: PLATFORM always; SERVICE/
 * SACRED_HOUSE rows only when the matching id filter is supplied.
 */
export async function listAllEligibleMediaAssets(
  filters: EligibleMediaFilters = {},
  storage: MediaStorageProvider = getMediaStorage(),
) {
  const PAGE_SIZE = 500
  const CEILING = 100_000
  const scopeConditions = [eq(mediaAssets.scopeType, 'PLATFORM')]
  if (filters.serviceId != null) {
    scopeConditions.push(
      and(
        eq(mediaAssets.scopeType, 'SERVICE'),
        eq(mediaAssets.serviceId, filters.serviceId),
      )!,
    )
  }
  if (filters.sacredHouseId != null) {
    scopeConditions.push(
      and(
        eq(mediaAssets.scopeType, 'SACRED_HOUSE'),
        eq(mediaAssets.sacredHouseId, filters.sacredHouseId),
      )!,
    )
  }
  const results = []
  let afterVersionId = 0
  for (;;) {
    const conditions = [
      eq(mediaAssets.active, true),
      eq(mediaAssetVersions.status, 'PUBLISHED'),
      eq(mediaAssetVersions.rightsStatus, 'CLEARED'),
      eq(mediaAssetVersions.runtimeEnabled, true),
      inArray(mediaAssetVersions.consentStatus, ['NOT_APPLICABLE', 'GRANTED']),
      or(
        eq(mediaAssetVersions.containsIdentifiablePerson, false),
        eq(mediaAssetVersions.consentStatus, 'GRANTED'),
      ),
      or(...scopeConditions),
    ]
    if (filters.assetKind) {
      conditions.push(eq(mediaAssets.assetKind, filters.assetKind))
    }
    if (filters.language) {
      conditions.push(eq(mediaAssetVersions.language, filters.language))
    }
    if (filters.contentType) {
      conditions.push(eq(mediaAssets.contentType, filters.contentType))
    }
    if (filters.themeCode) {
      conditions.push(eq(mediaAssets.themeCode, filters.themeCode))
    }
    if (afterVersionId > 0) {
      conditions.push(gt(mediaAssetVersions.id, afterVersionId))
    }
    const page = await getDb()
      .select({
        assetId: mediaAssets.id,
        assetPublicId: mediaAssets.publicId,
        code: mediaAssets.code,
        assetKind: mediaAssets.assetKind,
        scopeType: mediaAssets.scopeType,
        sacredHouseId: mediaAssets.sacredHouseId,
        serviceId: mediaAssets.serviceId,
        contentType: mediaAssets.contentType,
        themeCode: mediaAssets.themeCode,
        active: mediaAssets.active,
        versionId: mediaAssetVersions.id,
        versionNumber: mediaAssetVersions.versionNumber,
        status: mediaAssetVersions.status,
        sourceType: mediaAssetVersions.sourceType,
        language: mediaAssetVersions.language,
        mimeType: mediaAssetVersions.mimeType,
        byteSize: mediaAssetVersions.byteSize,
        durationSeconds: mediaAssetVersions.durationSeconds,
        width: mediaAssetVersions.width,
        height: mediaAssetVersions.height,
        storageKey: mediaAssetVersions.storageKey,
        fileSha256: mediaAssetVersions.fileSha256,
        rightsStatus: mediaAssetVersions.rightsStatus,
        runtimeEnabled: mediaAssetVersions.runtimeEnabled,
        containsIdentifiablePerson:
          mediaAssetVersions.containsIdentifiablePerson,
        consentStatus: mediaAssetVersions.consentStatus,
        externalAiPolicy: mediaAssetVersions.externalAiPolicy,
        voiceCloneAuthorized: mediaAssetVersions.voiceCloneAuthorized,
      })
      .from(mediaAssetVersions)
      .innerJoin(mediaAssets, eq(mediaAssetVersions.assetId, mediaAssets.id))
      .where(and(...conditions))
      .orderBy(asc(mediaAssetVersions.id))
      .limit(PAGE_SIZE)
    // Integrity gate per row: object must exist and bytes must hash to
    // the stored SHA-256 — a failure EXCLUDES the row (fails closed)
    // and is never repaired here.
    for (const row of page) {
      const bytes = await storage.get(row.storageKey)
      if (bytes != null && computeFileSha256(bytes) === row.fileSha256) {
        results.push(row)
      }
    }
    if (results.length > CEILING) {
      throw new MediaError(
        'Eligible-media enumeration exceeded the safety ceiling.',
      )
    }
    if (page.length < PAGE_SIZE) break
    afterVersionId = page[page.length - 1].versionId
  }
  return results
}

// --- Sacred content ↔ media links -------------------------------------------

export async function createSacredMediaLink(
  actorId: number,
  ctx: RequestContext,
  input: {
    contentVersionId: number
    mediaAssetVersionId: number
    role: SacredMediaLinkRole
    sortOrder?: number
  },
): Promise<{ id: number }> {
  await requirePermission(actorId, 'media.publish')
  if (!SACRED_MEDIA_LINK_ROLES.includes(input.role)) {
    throw new MediaError('Unknown link role.')
  }
  const db = getDb()
  const sacred = (
    await db
      .select({
        version: spiritualContentVersions,
        item: spiritualContentItems,
      })
      .from(spiritualContentVersions)
      .innerJoin(
        spiritualContentItems,
        eq(spiritualContentVersions.contentItemId, spiritualContentItems.id),
      )
      .where(eq(spiritualContentVersions.id, input.contentVersionId))
      .limit(1)
  ).at(0)
  if (!sacred || sacred.item.contentDomain !== 'SACRED_RUNTIME') {
    throw new MediaError(
      'Media links may only reference sacred runtime content.',
    )
  }
  if (sacred.version.status !== 'PUBLISHED') {
    throw new MediaError('Media links require a PUBLISHED sacred version.')
  }
  const media = (
    await db
      .select({ version: mediaAssetVersions, asset: mediaAssets })
      .from(mediaAssetVersions)
      .innerJoin(mediaAssets, eq(mediaAssetVersions.assetId, mediaAssets.id))
      .where(eq(mediaAssetVersions.id, input.mediaAssetVersionId))
      .limit(1)
  ).at(0)
  if (!media) throw new MediaError('Media version not found.')
  if (media.version.status !== 'PUBLISHED') {
    throw new MediaError('Media links require a PUBLISHED media version.')
  }
  if (
    (input.role === 'PRIMARY_AUDIO' || input.role === 'ALTERNATE_AUDIO') &&
    media.asset.assetKind !== 'AUDIO'
  ) {
    throw new MediaError('Audio link roles require an AUDIO asset.')
  }
  if (input.role === 'VISUAL_REFERENCE' && media.asset.assetKind === 'AUDIO') {
    throw new MediaError('Visual references require an IMAGE or VIDEO asset.')
  }
  if (
    media.version.language != null &&
    media.version.language !== sacred.version.language
  ) {
    throw new MediaError(
      'Linked media language must match the sacred version language.',
    )
  }
  let linkId: number
  try {
    const inserted = await db.insert(sacredContentMediaLinks).values({
      contentVersionId: input.contentVersionId,
      mediaAssetVersionId: input.mediaAssetVersionId,
      role: input.role,
      sortOrder: input.sortOrder ?? 0,
      createdBy: actorId,
    })
    linkId = inserted[0].insertId
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new MediaError('This link already exists.')
    }
    throw error
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'media.sacred_link_created',
    entityType: 'sacred_content_media_link',
    entityId: String(linkId),
    metadata: {
      contentVersionId: input.contentVersionId,
      mediaAssetVersionId: input.mediaAssetVersionId,
      role: input.role,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return { id: linkId }
}

/** ADMIN unlink — an association change, audited; nothing sacred or
 * binary is destroyed. */
export async function removeSacredMediaLink(
  actorId: number,
  ctx: RequestContext,
  linkId: number,
): Promise<void> {
  await requirePermission(actorId, 'media.publish')
  const link = (
    await getDb()
      .select()
      .from(sacredContentMediaLinks)
      .where(eq(sacredContentMediaLinks.id, linkId))
      .limit(1)
  ).at(0)
  if (!link) throw new MediaError('Link not found.')
  await getDb()
    .delete(sacredContentMediaLinks)
    .where(eq(sacredContentMediaLinks.id, linkId))
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'media.sacred_link_removed',
    entityType: 'sacred_content_media_link',
    entityId: String(linkId),
    metadata: {
      contentVersionId: link.contentVersionId,
      mediaAssetVersionId: link.mediaAssetVersionId,
      role: link.role,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/**
 * Sacred-audio candidates for one sacred content version, honoring the
 * Step 8 voice policy:
 * - HUMAN_RECORDED_REQUIRED → only eligible linked HUMAN_RECORDED audio
 * - APPROVED_TTS_ALLOWED    → any eligible linked human audio (future
 *   approved TTS is a LATER stage; nothing here calls one)
 * - TEXT_ONLY               → no sacred audio required (empty list)
 * Every candidate passes full runtime eligibility (incl. byte hash).
 */
export async function resolveSacredAudioCandidates(
  contentVersionId: number,
  voicePolicy: string,
  storage: MediaStorageProvider = getMediaStorage(),
) {
  // TEXT_ONLY sacred content requires no audio — empty candidate list.
  const rows =
    voicePolicy === 'TEXT_ONLY'
      ? []
      : await getDb()
          .select({
            link: sacredContentMediaLinks,
            version: mediaAssetVersions,
            asset: mediaAssets,
          })
          .from(sacredContentMediaLinks)
          .innerJoin(
            mediaAssetVersions,
            eq(
              sacredContentMediaLinks.mediaAssetVersionId,
              mediaAssetVersions.id,
            ),
          )
          .innerJoin(
            mediaAssets,
            eq(mediaAssetVersions.assetId, mediaAssets.id),
          )
          .where(
            and(
              eq(sacredContentMediaLinks.contentVersionId, contentVersionId),
              inArray(sacredContentMediaLinks.role, [
                'PRIMARY_AUDIO',
                'ALTERNATE_AUDIO',
              ]),
            ),
          )
          .orderBy(
            asc(sacredContentMediaLinks.role),
            asc(sacredContentMediaLinks.sortOrder),
            asc(sacredContentMediaLinks.id),
          )
          .limit(200)
  const candidates = []
  for (const row of rows) {
    if (
      voicePolicy === 'HUMAN_RECORDED_REQUIRED' &&
      row.version.sourceType !== 'HUMAN_RECORDED'
    ) {
      continue
    }
    const check = await isMediaAssetRuntimeEligible(
      { asset: row.asset, version: row.version },
      storage,
    )
    if (!check.eligible) continue
    candidates.push({
      linkId: row.link.id,
      role: row.link.role,
      sortOrder: row.link.sortOrder,
      mediaAssetVersionId: row.version.id,
      assetId: row.asset.id,
      code: row.asset.code,
      sourceType: row.version.sourceType,
      language: row.version.language,
      mimeType: row.version.mimeType,
      durationSeconds: row.version.durationSeconds,
      storageKey: row.version.storageKey,
      fileSha256: row.version.fileSha256,
    })
  }
  return { voicePolicy, candidates }
}

// --- Staff library queries --------------------------------------------------

export async function listMediaAssets(filters: {
  assetKind?: MediaAssetKind
  scopeType?: ContentScopeType
  active?: boolean
}) {
  const conditions = []
  if (filters.assetKind) {
    conditions.push(eq(mediaAssets.assetKind, filters.assetKind))
  }
  if (filters.scopeType) {
    conditions.push(eq(mediaAssets.scopeType, filters.scopeType))
  }
  if (filters.active != null) {
    conditions.push(eq(mediaAssets.active, filters.active))
  }
  const assets = await getDb()
    .select()
    .from(mediaAssets)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(mediaAssets.assetKind), asc(mediaAssets.code))
    .limit(500)
  if (assets.length === 0) return []
  const versions = await getDb()
    .select({
      id: mediaAssetVersions.id,
      assetId: mediaAssetVersions.assetId,
      versionNumber: mediaAssetVersions.versionNumber,
      status: mediaAssetVersions.status,
      rightsStatus: mediaAssetVersions.rightsStatus,
      runtimeEnabled: mediaAssetVersions.runtimeEnabled,
      consentStatus: mediaAssetVersions.consentStatus,
    })
    .from(mediaAssetVersions)
    .where(
      inArray(
        mediaAssetVersions.assetId,
        assets.map((asset) => asset.id),
      ),
    )
    .orderBy(desc(mediaAssetVersions.versionNumber))
  return assets.map((asset) => ({
    ...asset,
    versions: versions.filter((version) => version.assetId === asset.id),
  }))
}

export async function getMediaAssetDetail(assetId: number) {
  const asset = await loadMediaAsset(assetId)
  const versions = await getDb()
    .select()
    .from(mediaAssetVersions)
    .where(eq(mediaAssetVersions.assetId, assetId))
    .orderBy(desc(mediaAssetVersions.versionNumber))
  const eligibility = []
  for (const version of versions) {
    eligibility.push({
      versionId: version.id,
      ...(await isMediaAssetRuntimeEligible({ asset, version })),
    })
  }
  const frozen = await isAssetStructureFrozen(assetId, getDb())
  const versionIds = versions.map((version) => version.id)
  const links =
    versionIds.length > 0
      ? await getDb()
          .select({
            link: sacredContentMediaLinks,
            sacredVersion: {
              id: spiritualContentVersions.id,
              language: spiritualContentVersions.language,
              versionNumber: spiritualContentVersions.versionNumber,
              title: spiritualContentVersions.title,
            },
          })
          .from(sacredContentMediaLinks)
          .innerJoin(
            spiritualContentVersions,
            eq(
              sacredContentMediaLinks.contentVersionId,
              spiritualContentVersions.id,
            ),
          )
          .where(
            inArray(sacredContentMediaLinks.mediaAssetVersionId, versionIds),
          )
      : []
  return { asset, versions, eligibility, links, structureFrozen: frozen }
}

export async function listMediaReviewQueue() {
  return getDb()
    .select({
      version: mediaAssetVersions,
      asset: {
        id: mediaAssets.id,
        code: mediaAssets.code,
        assetKind: mediaAssets.assetKind,
        scopeType: mediaAssets.scopeType,
      },
    })
    .from(mediaAssetVersions)
    .innerJoin(mediaAssets, eq(mediaAssetVersions.assetId, mediaAssets.id))
    .where(eq(mediaAssetVersions.status, 'UNDER_REVIEW'))
    .orderBy(asc(mediaAssetVersions.submittedAt))
    .limit(200)
}
