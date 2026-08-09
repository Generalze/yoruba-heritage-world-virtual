import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getDb } from '@/db'
import { GUIDANCE_LANGUAGES, sacredHouses, services } from '@/db/schema'
import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import {
  approveTemplateVersion,
  archiveTemplateVersion,
  createPrayerTemplate,
  createTemplateVersion,
  getPrayerTemplateDetail,
  listPrayerTemplates,
  listTemplateReviewQueue,
  publishTemplateVersion,
  returnTemplateVersion,
  setPrayerTemplateActive,
  submitTemplateVersion,
  templateSchema,
  templateVersionSchema,
  updateDraftTemplateVersion,
  updatePrayerTemplate,
} from './prayer-templates'
import { resolveApprovedPrayerSession } from './prayer-session-resolver'
import type { SafeUser } from '@/auth/session'

/**
 * Prayer session template staff server functions (Step 9). Reuses the
 * existing spiritual_content.* permission model — no new roles, no new
 * permissions. Templates carry no sacred bodies; the staff preview
 * runs the REAL autonomous resolver but never returns sacred text to
 * the browser. Nothing here calls an AI provider.
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

export const listPrayerTemplatesFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'spiritual_content.view')
    const templates = await listPrayerTemplates()
    const lookups = await catalogueLookups()
    return { templates, ...lookups }
  },
)

export const getPrayerTemplateFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'spiritual_content.view')
    const detail = await getPrayerTemplateDetail(data.id)
    const lookups = await catalogueLookups()
    return { ...detail, ...lookups }
  })

export const createPrayerTemplateFn = createServerFn({ method: 'POST' })
  .validator(templateSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createPrayerTemplate(actor.id, requestContext(), data)
  })

export const updatePrayerTemplateFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, template: templateSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updatePrayerTemplate(
      actor.id,
      requestContext(),
      data.id,
      data.template,
    )
    return { ok: true }
  })

export const setPrayerTemplateActiveFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema, active: z.boolean() }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setPrayerTemplateActive(
      actor.id,
      requestContext(),
      data.id,
      data.active,
    )
    return { ok: true }
  })

// --- Versions ---------------------------------------------------------------

export const createPrayerTemplateVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ templateId: idSchema, version: templateVersionSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return createTemplateVersion(
      actor.id,
      requestContext(),
      data.templateId,
      data.version,
    )
  })

export const updatePrayerTemplateDraftFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      version: templateVersionSchema.omit({ language: true }),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await updateDraftTemplateVersion(
      actor.id,
      requestContext(),
      data.versionId,
      data.version,
    )
    return { ok: true }
  })

export const submitPrayerTemplateVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await submitTemplateVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const returnPrayerTemplateVersionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      versionId: idSchema,
      reason: z.string().trim().min(1).max(500),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await returnTemplateVersion(
      actor.id,
      requestContext(),
      data.versionId,
      data.reason,
    )
    return { ok: true }
  })

export const approvePrayerTemplateVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await approveTemplateVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

export const publishPrayerTemplateVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    return publishTemplateVersion(actor.id, requestContext(), data.versionId)
  })

export const archivePrayerTemplateVersionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ versionId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await archiveTemplateVersion(actor.id, requestContext(), data.versionId)
    return { ok: true }
  })

// --- Review queue -----------------------------------------------------------

export const listPrayerTemplateReviewQueueFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  const actor = await requireActor()
  await requirePermission(actor.id, 'spiritual_content.approve')
  return listTemplateReviewQueue()
})

// --- Staff validation preview (runs the REAL resolver) ----------------------

export const previewPrayerSessionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      serviceId: idSchema.optional(),
      sacredHouseId: idSchema.optional(),
      language: z.enum(GUIDANCE_LANGUAGES),
      variationSeed: z.string().trim().min(1).max(120),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'spiritual_content.view')
    // Bodies are NEVER included in the staff preview payload.
    return resolveApprovedPrayerSession(data)
  })
