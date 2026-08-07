import { pingDatabase } from '@/db'
import { healthResponseSchema } from '@/types/health'
import type { HealthResponse } from '@/types/health'

/**
 * Builds the health-check payload. Reports database connectivity as a
 * simple connected/unavailable flag without exposing hosts, users or
 * credentials.
 */
export async function getHealthStatus(): Promise<HealthResponse> {
  const databaseUp = await pingDatabase()

  return healthResponseSchema.parse({
    status: 'ok',
    service: 'yoruba-heritage-world-virtual',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    database: databaseUp ? 'connected' : 'unavailable',
  })
}
