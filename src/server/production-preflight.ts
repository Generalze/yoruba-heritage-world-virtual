import { env } from '@/lib/env'
import { validateStorageEndpoint } from '@/lib/security-headers'
import { checkRenderRuntimeDependencies } from '@/providers/render/media-probe'
import type { RenderRuntimeCheck } from '@/providers/render/media-probe'
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
    // A browser is REDIRECTED to this endpoint to play somebody's
    // recorded prayer, and the CSP names its origin as the one external
    // source allowed to play media. Both depend on it being a real,
    // credential-free HTTPS base URL — so it is parsed, not
    // string-matched.
    if (cfg.OBJECT_STORAGE_ENDPOINT.trim().length > 0) {
      const endpoint = validateStorageEndpoint(cfg.OBJECT_STORAGE_ENDPOINT)
      if (!endpoint.ok) {
        add(
          endpoint.reasonCode === 'endpoint_not_https'
            ? 'object_storage_endpoint_not_https'
            : `object_storage_${endpoint.reasonCode}`,
          'OBJECT_STORAGE_ENDPOINT',
        )
      }
    }
    // PATH-STYLE IS REQUIRED WHILE PHASE ONE DELIVERS BY REDIRECT.
    //
    // The Prayer Room pins the signed URL to the configured endpoint's
    // exact origin, and the CSP allows only that origin. Virtual-hosted
    // addressing moves the bucket into the HOST — `https://bucket.s3…`
    // instead of `https://s3…/bucket` — so the signed URL would land on
    // an origin neither the pin nor the policy knows about, and every
    // playback would be refused. Allowing it would mean widening the
    // CSP to a wildcard over the provider's whole domain, which is not
    // a policy. A separate browser-delivery origin contract is a later,
    // explicit stage.
    if (!cfg.OBJECT_STORAGE_FORCE_PATH_STYLE) {
      add(
        'object_storage_path_style_required',
        'OBJECT_STORAGE_FORCE_PATH_STYLE',
      )
    }
  }

  // --- Render ------------------------------------------------------------
  if (cfg.RENDER_DRIVER === 'MOCK') {
    add('mock_renderer_forbidden_in_production', 'RENDER_DRIVER')
  }

  // --- Generation adapters ------------------------------------------------
  //
  // These are NOT oversights to be waved through. No external VISUAL
  // generation vendor has been selected, so that stage has exactly two
  // honest options: DISABLED, meaning a job that requires the work
  // fails closed and says so; or a real adapter, which does not exist
  // yet. Speech now HAS an approved adapter — 9JALINGO — but MOCK,
  // handing someone synthetic output as their prayer, remains
  // forbidden for both stages.
  if (cfg.VISUAL_GENERATION_DRIVER === 'MOCK') {
    add(
      'mock_visual_generation_forbidden_in_production',
      'VISUAL_GENERATION_DRIVER',
    )
  }
  if (cfg.TTS_DRIVER === 'MOCK') {
    add('mock_tts_forbidden_in_production', 'TTS_DRIVER')
  }
  // The 9jaLingo adapter is a PAID client: selected, it must be
  // completely configured — there is no fallback to MOCK or DISABLED,
  // and a partially configured deployment refuses to start rather than
  // discovering the gap when a reservation is already durable. The
  // schema enforces the same rules in every environment; this repeats
  // them as readiness codes an operator can act on.
  if (cfg.TTS_DRIVER === '9JALINGO') {
    for (const name of [
      'NAIJALINGO_API_KEY',
      'NAIJALINGO_API_BASE_URL',
      'NAIJALINGO_YO_VOICE_ID',
      'NAIJALINGO_MODEL',
    ] as const) {
      if (cfg[name].trim().length === 0) {
        add('naijalingo_config_missing', name)
      }
    }
    if (cfg.NAIJALINGO_API_BASE_URL.trim().length > 0) {
      // The API key travels as a bearer header to this URL: plain
      // HTTPS, no credentials, no query, no fragment — the same
      // parsed-not-string-matched discipline as the storage endpoint.
      const endpoint = validateStorageEndpoint(cfg.NAIJALINGO_API_BASE_URL)
      if (!endpoint.ok) {
        add(`naijalingo_${endpoint.reasonCode}`, 'NAIJALINGO_API_BASE_URL')
      }
    }
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

/**
 * The LOCAL RENDER TOOLING gate, for a process that renders.
 *
 * Readiness already reports this over HTTP, which is what a proxy needs
 * — but the worker takes its work from a queue, not from a load
 * balancer, and it is the process that actually renders. Nothing about
 * the web tier answering 503 stops a worker from sweeping leases and
 * claiming jobs it cannot finish, so it proves the same capabilities,
 * through the SAME check, before it touches a single row.
 *
 * ZERO DATABASE CONTACT. It runs before lease recovery and before any
 * pipeline pass, so a refusal mutates no job, consumes no retry budget
 * and leaves no lease held.
 */
export class RenderRuntimeUnavailableError extends Error {
  readonly missing: ReadonlyArray<string>

  constructor(processLabel: string, missing: ReadonlyArray<string>) {
    super(
      `${processLabel} refused to start: local render tooling is unavailable.`,
    )
    this.name = 'RenderRuntimeUnavailableError'
    this.missing = missing
  }
}

export async function assertRenderRuntimeReady(
  processLabel: string,
  check: RenderRuntimeCheck = checkRenderRuntimeDependencies,
  cfg: Env = env,
): Promise<void> {
  // The mock renderer needs neither binary. Development and test are
  // unaffected, exactly as they are for every other production gate.
  if (cfg.RENDER_DRIVER === 'MOCK') return
  const runtime = await check()
  if (runtime.ok) return
  for (const capability of runtime.missing) {
    // A CAPABILITY NAME. Never the path it was looked for at, and never
    // anything read from configuration.
    console.error(
      `[preflight] ${processLabel}: render_runtime_missing_${capability}`,
    )
  }
  throw new RenderRuntimeUnavailableError(processLabel, runtime.missing)
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
