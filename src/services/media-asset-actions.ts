import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  MEDIA_ASSET_KINDS,
  MEDIA_CONSENT_STATUSES,
  RIGHTS_STATUSES,
  SACRED_MEDIA_LINK_ROLES,
  sacredHouses,
  services,
} from '@/db/schema'
import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import {
  approveMediaVersion,
  archiveMediaVersion,
  createMediaAsset,
  createMediaVersion,
  createSacredMediaLink,
  getMediaAssetDetail,
  listMediaAssets,
  listMediaReviewQueue,
  mediaAssetSchema,
  mediaVersionMetadataSchema,
  publishMediaVersion,
  removeSacredMediaLink,
  returnMediaVersion,
  setMediaAssetActive,
  setMediaConsentStatus,
  setMediaRightsStatus,
  setMediaRuntimeEnabled,
  submitMediaVersion,
  updateDraftMediaVersion,
  updateMediaAsset,
} from './media-assets'
import type { SafeUser } from '@/auth/session'

/**
 * Media library staff server functions (Step 10). Every function
 * requires an authenticated staff actor with media.* permissions.
 * There is NO public media route anywhere — binaries stay in private
 * storage and are never returned to browsers by these functions.
 * Nothing here calls any AI/TTS/generation provider.
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

const idSchema = z.number().int().positive()

// Upload transport cap: 25 MB binary ≈ 34 MB base64. Larger media can
// arrive through future non-browser ingestion; the service enforces
// per-kind byte limits on the decoded bytes regardless.
const UPLOAD_BASE64_MAX = 35_000_000

async function catalogueLookups() {
  const houses = await getDb()
    .select({ id: sacredHouses.id, name: sacredHouses.name })
    .from(sacredHouses)
    .orderBy(sacredHouses.sortOrder)
  const serviceRows = await getDb()
    .select({
      id: services.id,
      name: services.name,
      sacredHouseId: services.sacredHouseId,
    })
    .from(services)
    .orderBy(services.name)
  return { houses, services: serviceRows }
}

// --- Library ----------------------------------------------------------------

export const listMediaAssetsFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      assetKind: z.enum(MEDIA_ASSET_KINDS).optional(),
      active: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'media.view')
    const assets = await listMediaAssets(data)
    const lookups = await catalogueLookups()
    return { assets, ...lookups }
  })

export const getMediaAssetFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'media.view')
    const detail = await getMediaAssetDetail(data.id)
    const lookups = await catalogueLookups()
    return { ...detail, ...lookups }
  })

export const createMediaAssetFn = createServerFn({ method: 'POST' })
  .validator(mediaAssetSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createMediaAsset(actor.id, requestContext(), data)
  })

export const updateMediaAssetFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, asset: mediaAssetSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateMediaAsset(actor.id, requestContext(), data.id, data.asset)
    return { ok: true }
  })

export const setMediaAssetActiveFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, active: z.boolean() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setMediaAssetActive(actor.id, requestContext(), data.id, data.active)
    return { ok: true }
  })

// --- Versions ---------------------------------------------------------------

export const uploadMediaVersionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      assetId: idSchema,
      mimeType: z.string().min(3).max(100),
      bytesBase64: z.string().min(1).max(UPLOAD_BASE64_MAX),
      metadata: mediaVersionMetadataSchema,
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    // Decode server-side; the SHA-256 and storage key are derived from
    // these exact bytes — never from anything the client claims.
    const bytes = Buffer.from(data.bytesBase64, 'base64')
    return createMediaVersion(
      actor.id,
      requestContext(),
      data.assetId,
      bytes,
      data.mimeType,
      data.metadata,
    )
  })

export const updateMediaDraftFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({ versionId: idSchema, metadata: mediaVersionMetadataSchema }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateDraftMediaVersion(
      actor.id,
      requestContext(),
      data.versionId,
      data.metadata,
    )
    return { ok: true }
  })

export const submitMediaVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await submitMediaVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const returnMediaVersionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      reason: z.string().trim().min(1).max(500),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await returnMediaVersion(
      actor.id,
      requestContext(),
      data.versionId,
      data.reason,
    )
    return { ok: true }
  })

export const approveMediaVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await approveMediaVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const publishMediaVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return publishMediaVersion(actor.id, requestContext(), data.versionId)
  })

export const archiveMediaVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await archiveMediaVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

// --- Rights / consent / runtime (ADMIN) -------------------------------------

export const setMediaRightsStatusFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      status: z.enum(RIGHTS_STATUSES),
      note: z.string().trim().max(1000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setMediaRightsStatus(
      actor.id,
      requestContext(),
      data.versionId,
      data.status,
      data.note,
    )
    return { ok: true }
  })

export const setMediaConsentStatusFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      status: z.enum(MEDIA_CONSENT_STATUSES),
      consentReference: z.string().trim().max(500).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setMediaConsentStatus(
      actor.id,
      requestContext(),
      data.versionId,
      data.status,
      data.consentReference,
    )
    return { ok: true }
  })

export const setMediaRuntimeEnabledFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema, enabled: z.boolean() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setMediaRuntimeEnabled(
      actor.id,
      requestContext(),
      data.versionId,
      data.enabled,
    )
    return { ok: true }
  })

// --- Sacred-content linking (ADMIN) -----------------------------------------

export const createSacredMediaLinkFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      contentVersionId: idSchema,
      mediaAssetVersionId: idSchema,
      role: z.enum(SACRED_MEDIA_LINK_ROLES),
      sortOrder: z.number().int().min(-1000).max(1000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createSacredMediaLink(actor.id, requestContext(), data)
  })

export const removeSacredMediaLinkFn = createServerFn({ method: 'POST' })
  .validator(z.object({ linkId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await removeSacredMediaLink(actor.id, requestContext(), data.linkId)
    return { ok: true }
  })

// --- Review queue -----------------------------------------------------------

export const listMediaReviewQueueFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  const actor = await requireActor()
  await requirePermission(actor.id, 'media.approve')
  return listMediaReviewQueue()
})
