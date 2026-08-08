import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  CONTENT_SCOPE_TYPES,
  GUIDANCE_CONTENT_TYPES,
  sacredHouses,
  services,
} from '@/db/schema'
import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import {
  approveVersion,
  archiveVersion,
  contentItemSchema,
  contentVersionSchema,
  createContentItem,
  createVersion,
  getContentItemDetail,
  listContentItems,
  listReviewQueue,
  publishVersion,
  returnVersionToDraft,
  setContentItemActive,
  submitVersionForReview,
  updateContentItem,
  updateDraftVersion,
} from './spiritual-content'
import { getAppointmentGuidanceAdmin } from './guidance'
import { requireVersionDomain } from './sacred-content'
import type { SafeUser } from '@/auth/session'

/**
 * Spiritual content staff server functions (Step 7). Actor always
 * derives from the authenticated session; the domain layer re-checks
 * spiritual_content.* permissions (manage never implies approval or
 * publication). CONTENT_MANAGER reaches this scoped area without broad
 * admin.access, exactly like catalogue authoring. NOTHING here calls
 * an AI provider — all content is human-authored.
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

// --- Library ----------------------------------------------------------------

export const listSpiritualContentFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      contentType: z.enum(GUIDANCE_CONTENT_TYPES).optional(),
      scopeType: z.enum(CONTENT_SCOPE_TYPES).optional(),
      sacredHouseId: idSchema.optional(),
      serviceId: idSchema.optional(),
      active: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'spiritual_content.view')
    const items = await listContentItems(data)
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
    return { items, houses, services: serviceRows }
  })

export const getSpiritualContentItemFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'spiritual_content.view')
    // Guidance surface only — sacred items live in /admin/sacred-content.
    const detail = await getContentItemDetail(data.id, 'GUIDANCE')
    const houses = await getDb()
      .select({ id: sacredHouses.id, name: sacredHouses.name })
      .from(sacredHouses)
      .orderBy(sacredHouses.sortOrder)
    const serviceRows = await getDb()
      .select({ id: services.id, name: services.name })
      .from(services)
      .orderBy(services.name)
    return { ...detail, houses, services: serviceRows }
  })

export const createSpiritualContentItemFn = createServerFn({ method: 'POST' })
  .validator(contentItemSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createContentItem(actor.id, requestContext(), data)
  })

export const updateSpiritualContentItemFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, item: contentItemSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateContentItem(actor.id, requestContext(), data.id, data.item)
    return { ok: true }
  })

export const setSpiritualContentActiveFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, active: z.boolean() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setContentItemActive(actor.id, requestContext(), data.id, data.active)
    return { ok: true }
  })

// --- Versions ---------------------------------------------------------------

export const createSpiritualVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ itemId: idSchema, version: contentVersionSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createVersion(actor.id, requestContext(), data.itemId, data.version)
  })

export const updateSpiritualDraftFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      version: contentVersionSchema.omit({ language: true }),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateDraftVersion(
      actor.id,
      requestContext(),
      data.versionId,
      data.version,
    )
    return { ok: true }
  })

export const submitSpiritualVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    // Cross-domain server authority: this Step 7 route only drives
    // GUIDANCE versions — sacred versions use /admin/sacred-content.
    await requireVersionDomain(data.versionId, 'GUIDANCE')
    await submitVersionForReview(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const returnSpiritualVersionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      reason: z.string().trim().min(1).max(500),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'GUIDANCE')
    await returnVersionToDraft(
      actor.id,
      requestContext(),
      data.versionId,
      data.reason,
    )
    return { ok: true }
  })

export const approveSpiritualVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'GUIDANCE')
    await approveVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const publishSpiritualVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'GUIDANCE')
    return publishVersion(actor.id, requestContext(), data.versionId)
  })

export const archiveSpiritualVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requireVersionDomain(data.versionId, 'GUIDANCE')
    await archiveVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

// --- Review queue (ADMIN/SUPER_ADMIN) ---------------------------------------

export const listSpiritualReviewQueueFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  const actor = await requireActor()
  await requirePermission(actor.id, 'spiritual_content.approve')
  return listReviewQueue()
})

// --- Appointment guidance (operational admin view) --------------------------

/** ADMIN/SUPER_ADMIN operational inspection — gated on appointment
 * operations, so CONTENT_MANAGER never gains appointment browsing
 * through content permissions. */
export const adminGetAppointmentGuidanceFn = createServerFn({ method: 'GET' })
  .validator(z.object({ appointmentId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'appointments.view')
    return getAppointmentGuidanceAdmin(data.appointmentId)
  })
