import { pingDatabase } from '@/db'
import {
  checkProductionPreflight,
  describeUnavailableCapabilities,
} from '@/server/production-preflight'
import { healthResponseSchema, readinessResponseSchema } from '@/types/health'
import type { HealthResponse, ReadinessResponse } from '@/types/health'

/**
 * LIVENESS versus READINESS (Phase One, Step 20).
 *
 * They answer different questions and must not be conflated:
 *
 * - LIVENESS asks "is this process alive?" A container that is alive
 *   but misconfigured should be LEFT ALONE for an operator to fix.
 *   Killing and restarting it just produces the same misconfiguration
 *   again, more often, with the logs scrolling past.
 *
 * - READINESS asks "can this process serve real traffic?" It runs the
 *   SAME production preflight the worker runs, and additionally proves
 *   the database is actually reachable. A deployment behind a load
 *   balancer should be taken out of rotation on this, never on
 *   liveness.
 *
 * NEITHER PAYLOAD CARRIES A SECRET. No host, credential, bucket,
 * endpoint, provider response, object key, path, personal detail or
 * sacred text — the schemas in src/types/health.ts are strict, so an
 * accidental extra field fails to parse instead of shipping.
 */

/**
 * Builds the liveness payload. Reports database connectivity as a
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

/**
 * Builds the readiness payload: static configuration first (free), then
 * the database probe.
 *
 * Only the CODES travel over HTTP. The preflight result also names the
 * environment variables an operator must set, and those are logged
 * server-side at startup instead — an operator reading `docker logs`
 * gets the actionable form, and a stranger requesting this endpoint
 * gets a map of nothing.
 */
export async function getReadinessStatus(): Promise<ReadinessResponse> {
  const preflight = checkProductionPreflight()
  const databaseUp = await pingDatabase()
  const ready = preflight.ok && databaseUp

  return readinessResponseSchema.parse({
    status: ready ? 'ready' : 'not_ready',
    service: 'yoruba-heritage-world-virtual',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      configuration: preflight.ok ? 'ok' : 'invalid',
      database: databaseUp ? 'connected' : 'unavailable',
    },
    issues: preflight.issues.map((issue) => issue.code),
    unavailable: [...describeUnavailableCapabilities()],
  })
}
