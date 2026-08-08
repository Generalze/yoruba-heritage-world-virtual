import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  getPublishedDeityBySlug,
  getPublishedSacredHouseBySlug,
  getPublishedServiceBySlug,
  listPublishedDeities,
  listPublishedSacredHouses,
  listPublishedServicesByHouse,
} from './catalogue'

/**
 * Read-only server functions backing the public catalogue routes.
 * All publication filtering happens in the query layer; these expose
 * nothing beyond published/active records.
 */

const slugSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9-]+$/, 'Invalid slug'),
})

export const listDeitiesFn = createServerFn({ method: 'GET' }).handler(() =>
  listPublishedDeities(),
)

export const getDeityFn = createServerFn({ method: 'GET' })
  .validator(slugSchema)
  .handler(({ data }) => getPublishedDeityBySlug(data.slug))

export const listSacredHousesFn = createServerFn({ method: 'GET' }).handler(
  () => listPublishedSacredHouses(),
)

export const getSacredHouseFn = createServerFn({ method: 'GET' })
  .validator(slugSchema)
  .handler(({ data }) => getPublishedSacredHouseBySlug(data.slug))

export const listServicesFn = createServerFn({ method: 'GET' }).handler(() =>
  listPublishedServicesByHouse(),
)

export const getServiceFn = createServerFn({ method: 'GET' })
  .validator(slugSchema)
  .handler(({ data }) => getPublishedServiceBySlug(data.slug))
