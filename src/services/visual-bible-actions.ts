import { createServerFn } from '@tanstack/react-start'
import {
  bindVisualBibleReference,
  listVisualBibleReferences,
  setVisualBibleReferenceMode,
  unbindVisualBibleReference,
} from './visual-bible-references'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  VISUAL_BIBLE_REFERENCE_MODES,
  VISUAL_BIBLE_REFERENCE_ROLES,
  sacredHouses,
} from '@/db/schema'
import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import {
  approveVisualBibleVersion,
  archiveVisualBibleVersion,
  createVisualBible,
  createVisualBibleVersion,
  getVisualBibleDetail,
  listVisualBibles,
  loadPublishedVisualBible,
  publishVisualBibleVersion,
  returnVisualBibleVersion,
  submitVisualBibleVersion,
  updateDraftVisualBibleVersion,
  visualBibleVersionSchema,
} from './visual-bibles'
import type { SafeUser } from '@/auth/session'

/** Visual Bible staff server functions (Step 10) — media.* gated;
 * rules are human-authored plain text, never generated. */

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

export const listVisualBiblesFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'media.view')
    const bibles = await listVisualBibles()
    const houses = await getDb()
      .select({ id: sacredHouses.id, name: sacredHouses.name })
      .from(sacredHouses)
      .orderBy(sacredHouses.sortOrder)
    return { bibles, houses }
  },
)

export const getVisualBibleFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'media.view')
    return getVisualBibleDetail(data.id)
  })

export const createVisualBibleFn = createServerFn({ method: 'POST' })
  .validator(z.object({ sacredHouseId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createVisualBible(actor.id, requestContext(), data.sacredHouseId)
  })

export const createVisualBibleVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ bibleId: idSchema, version: visualBibleVersionSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createVisualBibleVersion(
      actor.id,
      requestContext(),
      data.bibleId,
      data.version,
    )
  })

/**
 * Reference binding surfaces (Step 24). DRAFT-only and permission
 * checked in the service, exactly like every other mutation here — the
 * admin screen showing or hiding a control is never the boundary.
 */
export const bindVisualBibleReferenceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      role: z.enum(VISUAL_BIBLE_REFERENCE_ROLES),
      mediaAssetVersionId: idSchema,
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await bindVisualBibleReference(
      actor.id,
      requestContext(),
      data.versionId,
      data.role,
      data.mediaAssetVersionId,
    )
    return { ok: true as const }
  })

export const unbindVisualBibleReferenceFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      role: z.enum(VISUAL_BIBLE_REFERENCE_ROLES),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await unbindVisualBibleReference(
      actor.id,
      requestContext(),
      data.versionId,
      data.role,
    )
    return { ok: true as const }
  })

export const setVisualBibleReferenceModeFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      referenceMode: z.enum(VISUAL_BIBLE_REFERENCE_MODES),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setVisualBibleReferenceMode(
      actor.id,
      requestContext(),
      data.versionId,
      data.referenceMode,
    )
    return { ok: true as const }
  })

export const listVisualBibleReferencesFn = createServerFn({ method: 'GET' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'media.view')
    return listVisualBibleReferences(data.versionId)
  })

export const updateVisualBibleDraftFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({ versionId: idSchema, version: visualBibleVersionSchema }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateDraftVisualBibleVersion(
      actor.id,
      requestContext(),
      data.versionId,
      data.version,
    )
    return { ok: true }
  })

export const submitVisualBibleVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await submitVisualBibleVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const returnVisualBibleVersionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      reason: z.string().trim().min(1).max(500),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await returnVisualBibleVersion(
      actor.id,
      requestContext(),
      data.versionId,
      data.reason,
    )
    return { ok: true }
  })

export const approveVisualBibleVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await approveVisualBibleVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const publishVisualBibleVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return publishVisualBibleVersion(actor.id, requestContext(), data.versionId)
  })

export const archiveVisualBibleVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await archiveVisualBibleVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

/** Staff-only verified loader (exercises the real integrity check). */
export const loadPublishedVisualBibleFn = createServerFn({ method: 'GET' })
  .validator(z.object({ sacredHouseId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'media.view')
    return loadPublishedVisualBible(data.sacredHouseId)
  })
