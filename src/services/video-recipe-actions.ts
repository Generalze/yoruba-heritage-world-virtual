import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getDb } from '@/db'
import { GUIDANCE_LANGUAGES, sacredHouses, services } from '@/db/schema'
import { getAuthenticatedUser, requirePermission } from '@/auth/guards'
import { buildValidatedVideoRecipe, validateVideoRecipe } from './video-recipes'
import type { SafeUser } from '@/auth/session'

/**
 * Video recipe staff preview (Step 11) — runs the REAL recipe engine
 * and validator. Nothing is persisted; nothing is generated. The
 * recipe payload itself carries no sacred bodies, storage keys,
 * consent references or rights notes, so the preview is safe to
 * return to staff browsers as-is.
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

export const listRecipePreviewContextFn = createServerFn({
  method: 'GET',
}).handler(async () => {
  const actor = await requireActor()
  await requirePermission(actor.id, 'media.view')
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
})

export const previewVideoRecipeFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      serviceId: z.number().int().positive(),
      language: z.enum(GUIDANCE_LANGUAGES),
      variationSeed: z.string().trim().min(1).max(120),
    }),
  )
  .handler(async ({ data }) => {
    const actor = await requireActor()
    await requirePermission(actor.id, 'media.view')
    const recipe = await buildValidatedVideoRecipe(data)
    const validation =
      recipe.status === 'RECIPE_READY'
        ? await validateVideoRecipe(recipe)
        : null
    return { recipe, validation }
  })
