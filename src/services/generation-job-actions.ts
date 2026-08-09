import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { requestContext } from '@/server/request-context'
import {
  adminCancelGenerationJob,
  adminRetryGenerationJob,
  getGenerationJobDetail,
  listGenerationJobs,
} from './generation-jobs'
import type { SafeUser } from '@/auth/session'

/**
 * Generation job staff operations (Step 12) — ADMIN/SUPER_ADMIN
 * appointment-operational authority only. Payloads carry ids,
 * statuses, hashes and bounded machine codes — never private
 * spiritual requests, sacred bodies, phone/DOB, payment details,
 * consent references, media storage keys or recipe sacred text.
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

export const listGenerationJobsFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'appointments.view')
    return listGenerationJobs()
  },
)

export const getGenerationJobFn = createServerFn({ method: 'GET' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'appointments.view')
    return getGenerationJobDetail(data.id)
  })

export const retryGenerationJobFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: idSchema }))
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await adminRetryGenerationJob(actor.id, requestContext(), data.id)
    return { ok: true }
  })

export const cancelGenerationJobFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({ id: idSchema, reason: z.string().trim().min(1).max(500) }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await adminCancelGenerationJob(
      actor.id,
      requestContext(),
      data.id,
      data.reason,
    )
    return { ok: true }
  })
