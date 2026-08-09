import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  CONTENT_SCOPE_TYPES,
  RIGHTS_STATUSES,
  SACRED_RUNTIME_CONTENT_TYPES,
  sacredHouses,
  services,
} from '@/db/schema'
import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import {
  approveVersion,
  archiveVersion,
  getContentItemDetail,
  listContentItems,
  listReviewQueue,
  publishVersion,
  returnVersionToDraft,
  setContentItemActive,
  submitVersionForReview,
  updateContentItem,
} from './spiritual-content'
import {
  createSacredContentItem,
  createSacredVersion,
  getSacredVersionProfiles,
  isSacredVersionRuntimeEligible,
  listSacredProfileSummaries,
  requireVersionDomain,
  sacredItemSchema,
  sacredProfileSchema,
  sacredVersionSchema,
  setSacredRightsStatus,
  setSacredRuntimeEnabled,
  updateSacredDraftVersion,
  updateSacredProfile,
} from './sacred-content'
import type { SafeUser } from '@/auth/session'

/**
 * Sacred runtime content staff server functions (Step 8). The
 * SACRED_RUNTIME domain is established HERE, server-side — browser
 * input never chooses a domain, and every version-targeting function
 * verifies the target actually belongs to this domain. There is NO
 * public sacred content route anywhere: every function requires an
 * authenticated staff actor with spiritual_content.* / rights
 * permissions. NOTHING here calls an AI provider — all sacred text is
 * human-authored.
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

export const listSacredContentFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      contentType: z.enum(SACRED_RUNTIME_CONTENT_TYPES).optional(),
      scopeType: z.enum(CONTENT_SCOPE_TYPES).optional(),
      sacredHouseId: idSchema.optional(),
      serviceId: idSchema.optional(),
      active: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'spiritual_content.view')
    const items = await listContentItems(data, 'SACRED_RUNTIME')
    const profiles = await listSacredProfileSummaries(items.map((i) => i.id))
    const lookups = await catalogueLookups()
    return { items, profiles, ...lookups }
  })

export const getSacredContentItemFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'spiritual_content.view')
    // Sacred surface only — guidance items live in /admin/spiritual-content.
    const detail = await getContentItemDetail(data.id, 'SACRED_RUNTIME')
    const profiles = await getSacredVersionProfiles(data.id)
    const eligibility = detail.versions.map((version) => {
      const profile = profiles.find((p) => p.contentVersionId === version.id)
      return {
        versionId: version.id,
        ...isSacredVersionRuntimeEligible({
          item: detail.item,
          version,
          profile: profile ?? null,
        }),
      }
    })
    const lookups = await catalogueLookups()
    return { ...detail, profiles, eligibility, ...lookups }
  })

export const createSacredContentItemFn = createServerFn({ method: 'POST' })
  .validator(sacredItemSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createSacredContentItem(actor.id, requestContext(), data)
  })

export const updateSacredContentItemFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, item: sacredItemSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    // Domain enforced INSIDE the item row lock — this route must never
    // retarget a guidance item.
    await updateContentItem(
      actor.id,
      requestContext(),
      data.id,
      data.item,
      'SACRED_RUNTIME',
    )
    return { ok: true }
  })

export const setSacredContentActiveFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, active: z.boolean() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setContentItemActive(
      actor.id,
      requestContext(),
      data.id,
      data.active,
      'SACRED_RUNTIME',
    )
    return { ok: true }
  })

// --- Versions & profiles ----------------------------------------------------

export const createSacredVersionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      itemId: idSchema,
      version: sacredVersionSchema,
      profile: sacredProfileSchema,
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createSacredVersion(
      actor.id,
      requestContext(),
      data.itemId,
      data.version,
      data.profile,
    )
  })

export const updateSacredDraftFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      version: z.object({
        title: z.string().trim().min(1).max(200),
        body: z.string().min(1).max(20_000),
      }),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateSacredDraftVersion(
      actor.id,
      requestContext(),
      data.versionId,
      data.version,
    )
    return { ok: true }
  })

export const updateSacredProfileFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema, profile: sacredProfileSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateSacredProfile(
      actor.id,
      requestContext(),
      data.versionId,
      data.profile,
    )
    return { ok: true }
  })

// --- Shared workflow transitions (domain-guarded) ---------------------------

export const submitSacredVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'SACRED_RUNTIME')
    await submitVersionForReview(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const returnSacredVersionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      reason: z.string().trim().min(1).max(500),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'SACRED_RUNTIME')
    await returnVersionToDraft(
      actor.id,
      requestContext(),
      data.versionId,
      data.reason,
    )
    return { ok: true }
  })

export const approveSacredVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'SACRED_RUNTIME')
    await approveVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const publishSacredVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'SACRED_RUNTIME')
    return publishVersion(actor.id, requestContext(), data.versionId)
  })

export const archiveSacredVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'SACRED_RUNTIME')
    await archiveVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

// --- Rights & runtime (ADMIN/SUPER_ADMIN) -----------------------------------

export const setSacredRightsStatusFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      status: z.enum(RIGHTS_STATUSES),
      note: z.string().trim().max(1000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setSacredRightsStatus(
      actor.id,
      requestContext(),
      data.versionId,
      data.status,
      data.note,
    )
    return { ok: true }
  })

export const setSacredRuntimeEnabledFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema, enabled: z.boolean() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setSacredRuntimeEnabled(
      actor.id,
      requestContext(),
      data.versionId,
      data.enabled,
    )
    return { ok: true }
  })

// --- Review queue & runtime overview (staff) --------------------------------

export const listSacredReviewQueueFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  const actor = await requireActor()
  await requirePermission(actor.id, 'spiritual_content.approve')
  return listReviewQueue('SACRED_RUNTIME')
})

/**
 * Staff runtime overview: which sacred versions are runtime-eligible
 * RIGHT NOW, and which published versions are blocked and why. Safe
 * metadata only — NO sacred bodies leave the server here.
 */
export const listSacredRuntimeStateFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  const actor = await requireActor()
  await requirePermission(actor.id, 'spiritual_content.view')
  const items = await listContentItems({}, 'SACRED_RUNTIME')
  const rows: Array<{
    itemId: number
    code: string
    contentType: string
    scopeType: string
    versionId: number
    language: string
    versionNumber: number
    status: string
    rightsStatus: string
    runtimeEnabled: boolean
    accessPolicy: string
    eligible: boolean
    failures: Array<string>
  }> = []
  for (const item of items) {
    const detail = await getContentItemDetail(item.id, 'SACRED_RUNTIME')
    const profiles = await getSacredVersionProfiles(item.id)
    for (const version of detail.versions) {
      if (version.status !== 'PUBLISHED') continue
      const profile = profiles.find((p) => p.contentVersionId === version.id)
      const check = isSacredVersionRuntimeEligible({
        item: detail.item,
        version,
        profile: profile ?? null,
      })
      rows.push({
        itemId: item.id,
        code: item.code,
        contentType: item.contentType,
        scopeType: item.scopeType,
        versionId: version.id,
        language: version.language,
        versionNumber: version.versionNumber,
        status: version.status,
        rightsStatus: profile?.rightsStatus ?? 'UNREVIEWED',
        runtimeEnabled: profile?.runtimeEnabled ?? false,
        accessPolicy: profile?.accessPolicy ?? 'STAFF_ONLY',
        eligible: check.eligible,
        failures: check.failures,
      })
    }
  }
  return rows
})
