import { env } from '@/lib/env'
import type { Env } from '@/lib/env'

/**
 * THE production readiness gate (Phase One, Step 20; canon §10.13).
 *
 * ONE function, shared by the web server and the generation worker, so
 * the two processes can never disagree about whether this deployment is
 * fit to run. A web server that serves traffic while the worker refuses
 * to start — or worse, a worker that starts claiming real appointments
 * while the app knows the configuration is broken — is exactly the
 * split-brain this exists to prevent.
 *
 * IT FAILS BEFORE ANYTHING HAPPENS. In production both processes call
 * it before the first request is accepted and before the first job is
 * claimed. A misconfigured deployment stops; it does not start and then
 * discover the problem while somebody's paid appointment is halfway
 * through the pipeline.
 *
 * IT REPORTS CODES AND ENVIRONMENT VARIABLE NAMES — NEVER VALUES. Every
 * issue is a stable machine code plus, where an operator has something
 * to set, the NAME of the variable. No value, no secret, no fragment of
 * one, no host, no bucket, no key. That is what makes the result safe
 * to log, safe to return from a readiness endpoint, and safe to paste
 * into a support conversation.
 *
 * IT IS PURE. No database, no network, no filesystem: readiness checks
 * that need I/O live in src/server/health.ts and call this first.
 */

/** A stable, non-secret machine code plus the variable an operator must
 * set. `envName` is a NAME only — never a value. */
export interface PreflightIssue {
  code: string
  envName: string | null
}

export interface PreflightResult {
  ok: boolean
  environment: Env['NODE_ENV']
  issues: ReadonlyArray<PreflightIssue>
}

/**
 * TRUST_PROXY has no safe default in production.
 *
 * Left off, real client IPs collapse to the proxy's and rate limiting
 * protects nobody. Turned on without a proxy that OVERWRITES the
 * header, any client can forge X-Forwarded-For and evade the same rate
 * limiting. Both are wrong in ways an operator must decide about
 * deliberately, so production requires the variable to be PRESENT — its
 * absence is the failure, not either of its values. A schema default
 * cannot see this; only the raw environment can.
 */
function isExplicitlySet(
  source: Record<string, string | undefined>,
  name: string,
): boolean {
  const value = source[name]
  return value != null && value.trim() !== ''
}

/**
 * The static half of production readiness.
 *
 * NON-PRODUCTION IS DELIBERATELY PERMISSIVE. Development and test run
 * on the local adapters by design; reporting that as a fault would
 * train everyone to ignore this function. Structural mistakes — an
 * unknown driver, an S3 driver with no bucket — are refused in EVERY
 * environment, but by the schema in src/lib/env.ts, which throws before
 * this is ever reached.
 */
export function checkProductionPreflight(
  source: Record<string, string | undefined> = process.env,
  cfg: Env = env,
): PreflightResult {
  const issues: Array<PreflightIssue> = []
  const add = (code: string, envName: string | null = null): void => {
    issues.push({ code, envName })
  }

  if (cfg.NODE_ENV !== 'production') {
    return { ok: true, environment: cfg.NODE_ENV, issues: [] }
  }

  if (!cfg.APP_BASE_URL.startsWith('https://')) {
    add('app_base_url_not_https', 'APP_BASE_URL')
  }
  if (cfg.DATABASE_PASSWORD.length === 0) {
    add('database_password_empty', 'DATABASE_PASSWORD')
  }
  if (!isExplicitlySet(source, 'TRUST_PROXY')) {
    add('trust_proxy_not_explicit', 'TRUST_PROXY')
  }

  // --- Private object storage -------------------------------------------
  if (cfg.OBJECT_STORAGE_DRIVER === 'LOCAL') {
    add('local_object_storage_forbidden_in_production', 'OBJECT_STORAGE_DRIVER')
  } else {
    for (const name of [
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_REGION',
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_ACCESS_KEY_ID',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    ] as const) {
      if (cfg[name].trim().length === 0) {
        add('object_storage_config_missing', name)
      }
    }
  }

  // --- Render ------------------------------------------------------------
  if (cfg.RENDER_DRIVER === 'MOCK') {
    add('mock_renderer_forbidden_in_production', 'RENDER_DRIVER')
  }

  // --- The two adapters nobody has approved yet --------------------------
  //
  // These are NOT oversights to be waved through. No external visual
  // generation or speech vendor has been selected, so production has
  // exactly two honest options: DISABLED, meaning a job that requires
  // that work fails closed and says so; or a real adapter, which does
  // not exist yet. MOCK — handing someone synthetic output as their
  // prayer — is not among them.
  if (cfg.VISUAL_GENERATION_DRIVER === 'MOCK') {
    add(
      'mock_visual_generation_forbidden_in_production',
      'VISUAL_GENERATION_DRIVER',
    )
  }
  if (cfg.TTS_DRIVER === 'MOCK') {
    add('mock_tts_forbidden_in_production', 'TTS_DRIVER')
  }

  return { ok: issues.length === 0, environment: cfg.NODE_ENV, issues }
}

/**
 * Capabilities this deployment does NOT have, stated plainly.
 *
 * A DISABLED driver is a valid production configuration — a Sacred
 * House whose approved media covers every scene needs no generation,
 * and a manifest built entirely from approved human recordings needs no
 * synthesis. What must never happen is required work being SKIPPED, so
 * the stages fail closed on a disabled driver, and this list is how an
 * operator learns which jobs will therefore be refused before they take
 * the booking rather than after.
 */
export function describeUnavailableCapabilities(
  cfg: Env = env,
): ReadonlyArray<string> {
  const unavailable: Array<string> = []
  if (cfg.VISUAL_GENERATION_DRIVER === 'DISABLED') {
    unavailable.push('visual_generation_disabled')
  }
  if (cfg.TTS_DRIVER === 'DISABLED') unavailable.push('tts_disabled')
  return unavailable
}

/** One-line, secret-free summary for a startup log. */
export function formatPreflightIssues(
  result: PreflightResult,
): ReadonlyArray<string> {
  return result.issues.map((issue) =>
    issue.envName ? `${issue.code} (set ${issue.envName})` : issue.code,
  )
}

export class ProductionPreflightError extends Error {
  readonly issues: ReadonlyArray<PreflightIssue>

  constructor(processLabel: string, issues: ReadonlyArray<PreflightIssue>) {
    super(
      `${processLabel} refused to start: production configuration is not valid.`,
    )
    this.name = 'ProductionPreflightError'
    this.issues = issues
  }
}

/**
 * The startup gate itself. Logs the codes (and variable NAMES) and
 * throws in production when anything is wrong.
 *
 * Both entry points call this before doing their real work — the server
 * before it binds a port, the worker before its first pipeline pass.
 */
export function assertProductionPreflight(
  processLabel: string,
  source: Record<string, string | undefined> = process.env,
  cfg: Env = env,
): PreflightResult {
  const result = checkProductionPreflight(source, cfg)
  if (!result.ok) {
    for (const line of formatPreflightIssues(result)) {
      console.error(`[preflight] ${processLabel}: ${line}`)
    }
    throw new ProductionPreflightError(processLabel, result.issues)
  }
  const unavailable = describeUnavailableCapabilities(cfg)
  if (unavailable.length > 0) {
    console.warn(
      `[preflight] ${processLabel}: reduced capability — ${unavailable.join(', ')}`,
    )
  }
  return result
}
