import { z } from 'zod'

/**
 * Shared shape of the /api/health response, validated with Zod on the
 * server before it is returned. Contains no credentials or secrets.
 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('yoruba-heritage-world-virtual'),
  timestamp: z.iso.datetime(),
  uptimeSeconds: z.number().nonnegative(),
  database: z.enum(['connected', 'unavailable']),
})

export type HealthResponse = z.infer<typeof healthResponseSchema>
