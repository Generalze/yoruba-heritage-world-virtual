import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { eq } from 'drizzle-orm'

import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { getUserPermissionCodes } from '@/auth/rbac'
import { requestContext } from '@/server/request-context'
import { getDb } from '@/db'
import {
  MEMBER_TYPES,
  deities,
  deitySacredHouses,
  deityServices,
  sacredHouses,
  services,
} from '@/db/schema'
import {
  addFocusArea,
  addMember,
  availableEvents,
  createDeity,
  createSacredHouse,
  createService,
  deityWorkflow,
  getDeityAdmin,
  getSacredHouseAdmin,
  getServiceAdmin,
  listDeitiesAdmin,
  listSacredHousesAdmin,
  listServicesAdmin,
  sacredHouseWorkflow,
  serviceWorkflow,
  setDeityHouseLink,
  setDeityServiceLink,
  updateDeity,
  updateFocusArea,
  updateMember,
  updateSacredHouse,
  updateService,
} from './admin-catalogue'
import type { SafeUser } from '@/auth/session'

/**
 * Admin server functions. Every handler resolves the acting user from
 * the server-side session and the service layer re-checks permissions —
 * the UI never being shown a button is NOT the security boundary.
 * CSRF/origin validation applies globally (src/start.ts).
 */

export class UnauthenticatedError extends Error {
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

export interface AdminContext {
  user: { preferredName: string; email: string }
  permissions: Array<string>
}

/** Null when unauthenticated or holding no admin-relevant permission. */
export const getAdminContextFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminContext | null> => {
    const user = await getAuthenticatedUser()
    if (!user) return null
    const permissions = await getUserPermissionCodes(user.id)
    const relevant = permissions.some(
      (code) =>
        code.startsWith('deities.') ||
        code.startsWith('sacred_houses.') ||
        code.startsWith('services.') ||
        code.startsWith('catalogue.') ||
        code.startsWith('spiritual_content.') ||
        code === 'admin.access',
    )
    if (!relevant) return null
    return {
      user: { preferredName: user.preferredName, email: user.email },
      permissions,
    }
  },
)

// --- Shared field schemas ---------------------------------------------------

const idSchema = z.number().int().positive()
const codeSchema = z
  .string()
  .regex(
    /^[A-Z][A-Z0-9_]{1,49}$/,
    'Code must be ASCII upper-case letters, digits and underscores.',
  )
const slugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/,
    'Slug must be lower-case ASCII letters, digits and hyphens.',
  )
const nameSchema = z.string().trim().min(1).max(150)
const descriptionSchema = z
  .string()
  .trim()
  .max(1000)
  .transform((value) => (value === '' ? null : value))
  .nullable()

const workflowEventSchema = z.enum([
  'submit',
  'approve',
  'reject',
  'publish',
  'unpublish',
  'archive',
  'restore',
])

const workflowSchema = z.object({
  id: idSchema,
  event: workflowEventSchema,
  note: z.string().trim().max(500).optional(),
})

const createProfileSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  slug: slugSchema,
  shortDescription: descriptionSchema.optional(),
})

const updateProfileSchema = z.object({
  id: idSchema,
  name: nameSchema.optional(),
  slug: slugSchema.optional(),
  shortDescription: descriptionSchema.optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
})

// --- Deities ----------------------------------------------------------------

export const adminListDeitiesFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const actor = await requireActor()
    const rows = await listDeitiesAdmin(actor.id)
    const permissions = await getUserPermissionCodes(actor.id)
    return rows.map((row) => ({
      ...row,
      events: availableEvents(row.profileStatus, permissions, 'deity'),
    }))
  },
)

export const adminGetDeityFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const row = await getDeityAdmin(actor.id, data.id)
    if (!row) return null
    const permissions = await getUserPermissionCodes(actor.id)
    const houseLinks = await getDb()
      .select({ sacredHouseId: deitySacredHouses.sacredHouseId })
      .from(deitySacredHouses)
      .where(eq(deitySacredHouses.deityId, row.id))
    const serviceLinks = await getDb()
      .select({ serviceId: deityServices.serviceId })
      .from(deityServices)
      .where(eq(deityServices.deityId, row.id))
    return {
      ...row,
      linkedHouseIds: houseLinks.map((l) => l.sacredHouseId),
      linkedServiceIds: serviceLinks.map((l) => l.serviceId),
      events: availableEvents(row.profileStatus, permissions, 'deity'),
    }
  })

export const adminSetDeityHouseLinkFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      deityId: idSchema,
      sacredHouseId: idSchema,
      linked: z.boolean(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setDeityHouseLink(
      actor.id,
      requestContext(),
      data.deityId,
      data.sacredHouseId,
      data.linked,
    )
    return { ok: true }
  })

export const adminSetDeityServiceLinkFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({ deityId: idSchema, serviceId: idSchema, linked: z.boolean() }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await setDeityServiceLink(
      actor.id,
      requestContext(),
      data.deityId,
      data.serviceId,
      data.linked,
    )
    return { ok: true }
  })

export const adminCreateDeityFn = createServerFn({ method: 'POST' })
  .validator(createProfileSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const id = await createDeity(actor.id, requestContext(), data)
    return { id }
  })

export const adminUpdateDeityFn = createServerFn({ method: 'POST' })
  .validator(updateProfileSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const { id, ...input } = data
    await updateDeity(actor.id, requestContext(), id, input)
    return { ok: true }
  })

export const adminDeityWorkflowFn = createServerFn({ method: 'POST' })
  .validator(workflowSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await deityWorkflow(
      actor.id,
      requestContext(),
      data.id,
      data.event,
      data.note,
    )
    return { ok: true }
  })

// --- Sacred Houses ----------------------------------------------------------

export const adminListSacredHousesFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  const actor = await requireActor()
  const rows = await listSacredHousesAdmin(actor.id)
  const permissions = await getUserPermissionCodes(actor.id)
  return rows.map((row) => ({
    ...row,
    events: availableEvents(row.status, permissions, 'sacred_house'),
  }))
})

export const adminGetSacredHouseFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const row = await getSacredHouseAdmin(actor.id, data.id)
    if (!row) return null
    const permissions = await getUserPermissionCodes(actor.id)
    return {
      ...row,
      events: availableEvents(row.status, permissions, 'sacred_house'),
    }
  })

export const adminCreateSacredHouseFn = createServerFn({ method: 'POST' })
  .validator(createProfileSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const id = await createSacredHouse(actor.id, requestContext(), data)
    return { id }
  })

export const adminUpdateSacredHouseFn = createServerFn({ method: 'POST' })
  .validator(updateProfileSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const { id, ...input } = data
    await updateSacredHouse(actor.id, requestContext(), id, input)
    return { ok: true }
  })

export const adminSacredHouseWorkflowFn = createServerFn({ method: 'POST' })
  .validator(workflowSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await sacredHouseWorkflow(
      actor.id,
      requestContext(),
      data.id,
      data.event,
      data.note,
    )
    return { ok: true }
  })

export const adminAddFocusAreaFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      sacredHouseId: idSchema,
      label: z.string().trim().min(1).max(200),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const id = await addFocusArea(
      actor.id,
      requestContext(),
      data.sacredHouseId,
      data.label,
    )
    return { id }
  })

export const adminUpdateFocusAreaFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: idSchema,
      label: z.string().trim().min(1).max(200).optional(),
      sortOrder: z.number().int().min(0).max(100000).optional(),
      active: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const { id, ...input } = data
    await updateFocusArea(actor.id, requestContext(), id, input)
    return { ok: true }
  })

export const adminAddMemberFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      sacredHouseId: idSchema,
      displayName: z.string().trim().min(1).max(150),
      memberType: z.enum(MEMBER_TYPES),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const id = await addMember(actor.id, requestContext(), data.sacredHouseId, {
      displayName: data.displayName,
      memberType: data.memberType,
    })
    return { id }
  })

export const adminUpdateMemberFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      id: idSchema,
      displayName: z.string().trim().min(1).max(150).optional(),
      memberType: z.enum(MEMBER_TYPES).optional(),
      sortOrder: z.number().int().min(0).max(100000).optional(),
      active: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const { id, ...input } = data
    await updateMember(actor.id, requestContext(), id, input)
    return { ok: true }
  })

// --- Services ---------------------------------------------------------------

export const adminListServicesFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const actor = await requireActor()
    const rows = await listServicesAdmin(actor.id)
    const permissions = await getUserPermissionCodes(actor.id)
    return rows.map((row) => ({
      ...row,
      events: availableEvents(
        row.service.serviceStatus,
        permissions,
        'service',
      ),
    }))
  },
)

export const adminGetServiceFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const row = await getServiceAdmin(actor.id, data.id)
    if (!row) return null
    const permissions = await getUserPermissionCodes(actor.id)
    return {
      ...row,
      events: availableEvents(row.serviceStatus, permissions, 'service'),
    }
  })

export const adminCreateServiceFn = createServerFn({ method: 'POST' })
  .validator(createProfileSchema.extend({ sacredHouseId: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const id = await createService(actor.id, requestContext(), data)
    return { id }
  })

export const adminUpdateServiceFn = createServerFn({ method: 'POST' })
  .validator(
    updateProfileSchema.extend({
      sacredHouseId: idSchema.optional(),
      durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
      priceMinor: z.number().int().min(0).nullable().optional(),
      currency: z
        .string()
        .regex(/^[A-Z]{3}$/)
        .nullable()
        .optional(),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    const { id, ...input } = data
    await updateService(actor.id, requestContext(), id, input)
    return { ok: true }
  })

export const adminServiceWorkflowFn = createServerFn({ method: 'POST' })
  .validator(workflowSchema)
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await serviceWorkflow(
      actor.id,
      requestContext(),
      data.id,
      data.event,
      data.note,
    )
    return { ok: true }
  })

// --- Review queue (Admin only) ----------------------------------------------

export interface ReviewQueueItem {
  kind: 'deity' | 'sacred_house' | 'service'
  id: number
  name: string
  updatedAt: Date
}

/**
 * UNDER_REVIEW records across the catalogue. Requires the approval
 * authority — the queue and its controls are an Admin experience.
 */
export const adminReviewQueueFn = createServerFn({ method: 'GET' }).handler(
  async (): Promise<Array<ReviewQueueItem>> => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'catalogue.approve')

    const db = getDb()
    const [deityRows, houseRows, serviceRows] = [
      await db
        .select({
          id: deities.id,
          name: deities.name,
          updatedAt: deities.updatedAt,
        })
        .from(deities)
        .where(eq(deities.profileStatus, 'UNDER_REVIEW')),
      await db
        .select({
          id: sacredHouses.id,
          name: sacredHouses.name,
          updatedAt: sacredHouses.updatedAt,
        })
        .from(sacredHouses)
        .where(eq(sacredHouses.status, 'UNDER_REVIEW')),
      await db
        .select({
          id: services.id,
          name: services.name,
          updatedAt: services.updatedAt,
        })
        .from(services)
        .where(eq(services.serviceStatus, 'UNDER_REVIEW')),
    ]

    return [
      ...deityRows.map((row) => ({ kind: 'deity' as const, ...row })),
      ...houseRows.map((row) => ({ kind: 'sacred_house' as const, ...row })),
      ...serviceRows.map((row) => ({ kind: 'service' as const, ...row })),
    ].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
  },
)
