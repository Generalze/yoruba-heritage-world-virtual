import { z } from 'zod'

/**
 * Shared shapes of the health endpoints, validated with Zod on the
 * server before they are returned.
 *
 * WHAT MAY NEVER APPEAR IN EITHER PAYLOAD: a credential, a host, a
 * bucket, an endpoint, a provider response, an object key, a file path,
 * a stack trace, any personal information, any sacred text. The schemas
 * below are closed — an extra field is a parse failure, not a silent
 * addition — so a well-meant future `details` object cannot leak one of
 * those without this file changing first.
 */

/**
 * LIVENESS. "This process is running." Deliberately says nothing about
 * whether it can do useful work: a container that is alive but not
 * ready should be waited for, not killed and restarted into the same
 * misconfiguration.
 */
export const healthResponseSchema = z
  .object({
    status: z.literal('ok'),
    service: z.literal('yoruba-heritage-world-virtual'),
    timestamp: z.iso.datetime(),
    uptimeSeconds: z.number().nonnegative(),
    database: z.enum(['connected', 'unavailable']),
  })
  .strict()

export type HealthResponse = z.infer<typeof healthResponseSchema>

/**
 * READINESS. "This process can serve real traffic."
 *
 * Issues are bounded machine CODES only. The preflight function also
 * knows which ENVIRONMENT VARIABLE an operator must set, and that
 * detail goes to the process log — where the operator already is —
 * rather than to an HTTP response that anyone can request. Codes are
 * not secrets; a list of the variables a deployment is missing is a
 * map of its configuration, and there is no reason to publish one.
 */
export const readinessResponseSchema = z
  .object({
    status: z.enum(['ready', 'not_ready']),
    service: z.literal('yoruba-heritage-world-virtual'),
    timestamp: z.iso.datetime(),
    uptimeSeconds: z.number().nonnegative(),
    checks: z
      .object({
        configuration: z.enum(['ok', 'invalid']),
        database: z.enum(['connected', 'unavailable']),
        /**
         * Can this deployment actually perform a real render?
         *
         * `not_required` when the mock engine is selected (development
         * and test). Otherwise the local tooling the compositor needs —
         * ffprobe and the baked headless browser — must be present, or
         * the worker will confirm appointments, queue jobs and fail
         * every one of them at the render stage on a missing binary.
         * Reported as a capability name only; never a filesystem path.
         */
        renderRuntime: z.enum(['ok', 'unavailable', 'not_required']),
      })
      .strict(),
    /** Stable codes, safe to log and to paste into a support thread. */
    issues: z.array(z.string()),
    /** Capabilities this deployment deliberately does not have (a
     * disabled generation or speech adapter). Not faults — but an
     * operator should be able to see them without reading the
     * environment. */
    unavailable: z.array(z.string()),
  })
  .strict()

export type ReadinessResponse = z.infer<typeof readinessResponseSchema>
