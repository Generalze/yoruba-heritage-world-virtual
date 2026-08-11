import { pingDatabase } from '@/db'
import { env } from '@/lib/env'
import { checkRenderRuntimeDependencies } from '@/providers/render/media-probe'
import {
  checkProductionPreflight,
  describeUnavailableCapabilities,
} from '@/server/production-preflight'
import { healthResponseSchema, readinessResponseSchema } from '@/types/health'
import type { RenderRuntimeCheck } from '@/providers/render/media-probe'
import type { Env } from '@/lib/env'
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
export interface ReadinessDependencies {
  /** Injectable so a test can model a machine without ffprobe or a
   * browser without installing or removing either. */
  checkRenderRuntime?: RenderRuntimeCheck
  /** Which engine this deployment would render with. */
  renderDriver?: Env['RENDER_DRIVER']
}

export async function getReadinessStatus(
  dependencies: ReadinessDependencies = {},
): Promise<ReadinessResponse> {
  const preflight = checkProductionPreflight()
  const databaseUp = await pingDatabase()

  // THE RENDERER'S LOCAL TOOLING IS PART OF BEING READY. A deployment
  // selecting the real compositor without ffprobe or the baked browser
  // is not merely degraded: it will accept bookings, take money, queue
  // the work and then burn each job's bounded retry budget on a missing
  // binary. The mock needs neither, so this is `not_required` there
  // rather than a fault nobody should see in development.
  const renderDriver = dependencies.renderDriver ?? env.RENDER_DRIVER
  const checkRenderRuntime =
    dependencies.checkRenderRuntime ?? checkRenderRuntimeDependencies
  const issues = preflight.issues.map((issue) => issue.code)
  let renderRuntime: 'ok' | 'unavailable' | 'not_required' = 'not_required'
  if (renderDriver !== 'MOCK') {
    const runtime = await checkRenderRuntime()
    renderRuntime = runtime.ok ? 'ok' : 'unavailable'
    for (const capability of runtime.missing) {
      // A CAPABILITY NAME, never the path it was looked for at.
      issues.push(`render_runtime_missing_${capability}`)
    }
  }

  const ready = preflight.ok && databaseUp && renderRuntime !== 'unavailable'

  return readinessResponseSchema.parse({
    status: ready ? 'ready' : 'not_ready',
    service: 'yoruba-heritage-world-virtual',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    checks: {
      configuration: preflight.ok ? 'ok' : 'invalid',
      database: databaseUp ? 'connected' : 'unavailable',
      renderRuntime,
    },
    issues,
    unavailable: [...describeUnavailableCapabilities()],
  })
}
