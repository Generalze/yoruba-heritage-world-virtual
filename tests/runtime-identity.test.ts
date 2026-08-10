import { describe, expect, it } from 'bun:test'

import { envSchema } from '@/lib/env'
import {
  checkRenderRuntimePaths,
  isExecutableFile,
  isResolvableExecutable,
} from '@/lib/executable-probe'
import { validateStorageEndpoint } from '@/lib/security-headers'
import {
  RenderRuntimeUnavailableError,
  assertRenderRuntimeReady,
  checkProductionPreflight,
} from '@/server/production-preflight'
import {
  TRUSTED_RENDERER_IDENTITIES,
  checkTrustedRendererIdentity,
} from '@/providers/render/registry'
import { REMOTION_PINNED_VERSION } from '@/providers/render/remotion'
import { createMockRenderEngine } from '@/providers/render/mock'

/**
 * ============================================================================
 * WORKER READINESS AND DURABLE RUNTIME IDENTITY — Step 20 final hardening.
 *
 * Three properties that only bite in production, and one that only
 * bites the first time somebody upgrades a dependency:
 *
 *   1. the WORKER — not merely the web tier — refuses to touch the
 *      queue when it cannot render;
 *   2. the endpoint a browser is redirected to is a real, plain,
 *      credential-free HTTPS base URL, and the bucket is addressed
 *      path-style so the signed URL stays on that exact origin;
 *   3. a COMPLETED recording is judged against the trusted registry, so
 *      a Remotion upgrade does not silently take every existing
 *      recording away from the people it belongs to.
 * ============================================================================
 */

const PRODUCTION: Record<string, string> = {
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://prayer.example',
  DATABASE_PASSWORD: 'placeholder',
  TRUST_PROXY: 'false',
  OBJECT_STORAGE_DRIVER: 'S3',
  OBJECT_STORAGE_ENDPOINT: 'https://objects.example',
  OBJECT_STORAGE_REGION: 'eu-west-1',
  OBJECT_STORAGE_BUCKET: 'private',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'key-id-placeholder',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-placeholder',
  OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
  RENDER_DRIVER: 'REMOTION',
  VISUAL_GENERATION_DRIVER: 'DISABLED',
  TTS_DRIVER: 'DISABLED',
}

function preflight(overrides: Record<string, string> = {}) {
  const source = { ...PRODUCTION, ...overrides }
  return checkProductionPreflight(source, envSchema.parse(source))
}

// --- 1. The worker gate ------------------------------------------------------

describe('the worker refuses the queue when it cannot render', () => {
  const production = envSchema.parse(PRODUCTION)

  it('throws before any queue contact when tooling is missing', async () => {
    let thrown: unknown
    try {
      await assertRenderRuntimeReady(
        'worker',
        async () => ({ ok: false, missing: ['ffprobe', 'render_browser'] }),
        production,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RenderRuntimeUnavailableError)
    const error = thrown as RenderRuntimeUnavailableError
    expect([...error.missing]).toEqual(['ffprobe', 'render_browser'])
    // Bounded capability names only — no path, no secret.
    const surface = `${error.message}${JSON.stringify(error.missing)}`
    for (const leak of ['/usr/bin', 'chromium', 'ffmpeg', 'placeholder']) {
      expect(surface).not.toContain(leak)
    }
  })

  it('passes when the tooling is present', async () => {
    await expect(
      assertRenderRuntimeReady('worker', async () => ({ ok: true, missing: [] }), production),
    ).resolves.toBeUndefined()
  })

  it('is a no-op for the MOCK renderer, so development is unchanged', async () => {
    let called = false
    await assertRenderRuntimeReady(
      'worker',
      async () => {
        called = true
        return { ok: false, missing: ['ffprobe'] }
      },
      envSchema.parse({ ...PRODUCTION, NODE_ENV: 'development', RENDER_DRIVER: 'MOCK' }),
    )
    expect(called).toBe(false)
  })

  it('gates BEFORE lease recovery and before any pipeline pass', async () => {
    // TEETH: the ordering is the whole point. A worker that swept
    // leases first would mutate rows it cannot possibly finish work
    // for, and a claim would consume a job's bounded retry budget on a
    // missing binary.
    const worker = await Bun.file(
      'src/workers/prayer-generation-worker.ts',
    ).text()
    const gateAt = worker.indexOf('assertRenderRuntimeReady(')
    const sweepAt = worker.lastIndexOf('recoverExpiredGenerationLeases(')
    const passAt = worker.lastIndexOf('runGenerationPipelinePass(')
    expect(gateAt).toBeGreaterThan(-1)
    expect(sweepAt).toBeGreaterThan(gateAt)
    expect(passAt).toBeGreaterThan(gateAt)
    // And it reuses the shared check rather than re-implementing
    // filesystem logic.
    const preflightSource = await Bun.file(
      'src/server/production-preflight.ts',
    ).text()
    expect(preflightSource).toContain('checkRenderRuntimeDependencies')
    expect(preflightSource).not.toContain('node:fs')
  })

  it('shares ONE filesystem implementation across readiness, worker and smoke', async () => {
    const probe = await Bun.file('src/lib/executable-probe.ts').text()
    // The env singleton must not be reachable from it, or the offline
    // smoke check could not use it.
    expect(probe).not.toContain("from '@/lib/env'")
    for (const consumer of [
      'src/providers/render/media-probe.ts',
      'scripts/runtime-smoke.ts',
    ]) {
      const source = await Bun.file(consumer).text()
      expect(source).toContain('executable-probe')
    }
  })

  it('the shared probe answers honestly about real paths', async () => {
    expect(await isExecutableFile('/definitely/not/here')).toBe(false)
    expect(await isExecutableFile('')).toBe(false)
    expect(await isResolvableExecutable('')).toBe(false)
    const missing = await checkRenderRuntimePaths({
      ffprobePath: '/definitely/not/here',
      browserPath: '',
    })
    expect(missing.ok).toBe(false)
    expect([...missing.missing]).toEqual(['ffprobe', 'render_browser'])
  })
})

// --- 2. Signed media origin --------------------------------------------------

describe('the browser-delivery endpoint is locked down', () => {
  it('accepts a plain HTTPS base URL', () => {
    const validated = validateStorageEndpoint('https://objects.example')
    expect(validated.ok).toBe(true)
    if (validated.ok) expect(validated.origin).toBe('https://objects.example')
  })

  it('refuses malformed, credential-bearing, query- or fragment-carrying endpoints', () => {
    const cases: Array<[string, string]> = [
      ['http://objects.example', 'endpoint_not_https'],
      ['https://', 'endpoint_unparseable'],
      ['https:// broken .example', 'endpoint_unparseable'],
      ['https://user:pass@objects.example', 'endpoint_has_credentials'],
      ['https://objects.example?x=1', 'endpoint_has_query'],
      ['https://objects.example#frag', 'endpoint_has_fragment'],
    ]
    for (const [endpoint, reasonCode] of cases) {
      const validated = validateStorageEndpoint(endpoint)
      expect(validated.ok).toBe(false)
      if (!validated.ok) expect(validated.reasonCode).toBe(reasonCode)
    }
  })

  it('production REFUSES virtual-hosted addressing', () => {
    // The signed URL would land on `https://bucket.s3…` — an origin
    // neither the redirect pin nor the CSP knows about — and the only
    // way to permit it would be a wildcard over the provider's whole
    // domain.
    // The schema refuses to BUILD this configuration, so the preflight
    // is exercised against a hand-assembled one — both locks matter.
    const result = checkProductionPreflight(
      { ...PRODUCTION, OBJECT_STORAGE_FORCE_PATH_STYLE: 'false' },
      { ...envSchema.parse(PRODUCTION), OBJECT_STORAGE_FORCE_PATH_STYLE: false },
    )
    expect(result.ok).toBe(false)
    const issue = result.issues.find(
      (candidate) => candidate.code === 'object_storage_path_style_required',
    )
    expect(issue?.envName).toBe('OBJECT_STORAGE_FORCE_PATH_STYLE')
    // The schema refuses to build the configuration at all, too.
    expect(() =>
      envSchema.parse({ ...PRODUCTION, OBJECT_STORAGE_FORCE_PATH_STYLE: 'false' }),
    ).toThrow()
  })

  it('production REFUSES a credential-bearing or malformed endpoint', () => {
    for (const endpoint of [
      'https://user:pass@objects.example',
      'https://objects.example?x=1',
      'https://objects.example#f',
    ]) {
      expect(() =>
        envSchema.parse({ ...PRODUCTION, OBJECT_STORAGE_ENDPOINT: endpoint }),
      ).toThrow()
    }
    const result = checkProductionPreflight(
      { ...PRODUCTION, OBJECT_STORAGE_ENDPOINT: 'https://user:pass@objects.example' },
      { ...envSchema.parse(PRODUCTION), OBJECT_STORAGE_ENDPOINT: 'https://user:pass@objects.example' },
    )
    expect(result.ok).toBe(false)
    expect(
      result.issues.some(
        (issue) => issue.code === 'object_storage_endpoint_has_credentials',
      ),
    ).toBe(true)
    // The reported issue names the VARIABLE and never the value.
    expect(JSON.stringify(result)).not.toContain('pass@')
  })

  it('a complete production configuration still passes', () => {
    expect(preflight().ok).toBe(true)
  })

  it('the redirect is pinned to the configured origin in the service itself', async () => {
    const service = await Bun.file('src/services/prayer-room.ts').text()
    expect(service).toContain('expectedOrigin')
    expect(service).toContain('configuredMediaOrigin')
    // Still a bounded bearer capability, still five minutes.
    expect(service).toContain('PRAYER_ROOM_SIGNED_URL_TTL_SECONDS')
  })
})

// --- 3. Durable renderer identity -------------------------------------------

describe('trusted persisted-renderer identity', () => {
  it('trusts the current real identity, and it matches the pinned package', () => {
    const real = TRUSTED_RENDERER_IDENTITIES.find(
      (identity) => identity.code === 'REMOTION',
    )
    expect(real).toEqual({
      code: 'REMOTION',
      version: `remotion-${REMOTION_PINNED_VERSION}`,
      isMock: false,
    })
    expect(
      checkTrustedRendererIdentity(real!, 'production').ok,
    ).toBe(true)
  })

  it('trusts the mock only outside production', () => {
    const mock = createMockRenderEngine()
    const identity = {
      code: mock.code,
      version: mock.version,
      isMock: mock.isMock,
    }
    expect(checkTrustedRendererIdentity(identity, 'test').ok).toBe(true)
    const inProduction = checkTrustedRendererIdentity(identity, 'production')
    expect(inProduction.ok).toBe(false)
    if (!inProduction.ok) {
      // The prohibition follows the ARTIFACT, not the active engine.
      expect(inProduction.reasonCode).toBe(
        'mock_renderer_forbidden_in_production',
      )
    }
  })

  it('refuses an unknown Remotion version', () => {
    const result = checkTrustedRendererIdentity(
      { code: 'REMOTION', version: 'remotion-9.9.9', isMock: false },
      'production',
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasonCode).toBe('renderer_identity_untrusted')
  })

  it('refuses a tampered mock flag on a trusted code and version', () => {
    for (const identity of [
      { code: 'REMOTION', version: `remotion-${REMOTION_PINNED_VERSION}`, isMock: true },
      { code: 'MOCK_RENDER', version: 'mock-1', isMock: false },
    ]) {
      const result = checkTrustedRendererIdentity(identity, 'test')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.reasonCode).toBe('renderer_identity_untrusted')
      }
    }
  })

  it('a FUTURE active renderer does not invalidate an already-completed trusted artifact', () => {
    // THE POINT OF THE REGISTRY. Simulate the deployment after an
    // upgrade: the active engine is 4.1.0, but a recording made by
    // 4.0.507 belongs to somebody and must still play.
    const futureActive = {
      code: 'REMOTION',
      version: 'remotion-4.1.0',
      isMock: false,
    }
    const historical = {
      code: 'REMOTION',
      version: `remotion-${REMOTION_PINNED_VERSION}`,
      isMock: false,
    }
    expect(historical.version).not.toBe(futureActive.version)
    // Completed verification asks the registry, not the active engine.
    expect(checkTrustedRendererIdentity(historical, 'production').ok).toBe(true)
    // And the future version is NOT trusted until it is added
    // deliberately — an upgrade adds an identity, it does not assume one.
    expect(checkTrustedRendererIdentity(futureActive, 'production').ok).toBe(
      false,
    )
  })

  it('completed verification asks the registry; new spend asks the current engine', async () => {
    const service = await Bun.file('src/services/render-assembly.ts').text()
    // verifyCompletedRender uses the registry…
    expect(service).toContain('checkTrustedRendererIdentity')
    // …and pre-spend still compares against the ACTIVE engine.
    expect(service).toContain('result_renderer_version_mismatch')
    expect(service).toContain('result_renderer_mock_flag_mismatch')
  })

  it('documents that removing a trusted identity is a governance decision', async () => {
    const registry = await Bun.file('src/providers/render/registry.ts').text()
    expect(registry).toContain('governance')
    // The rule that matters: never as a side effect of a dependency bump.
    expect(registry.toLowerCase()).toContain('package.json')
  })
})

// --- 4. Smoke-script independence -------------------------------------------

describe('the runtime smoke check stands alone', () => {
  it('imports no application env, database, provider or service', async () => {
    const smoke = await Bun.file('scripts/runtime-smoke.ts').text()
    for (const forbidden of [
      "from '@/lib/env'",
      "from '@/db'",
      '@/services/',
      '@/providers/payments',
      '@/providers/object-storage',
    ]) {
      expect(smoke).not.toContain(forbidden)
    }
    // It reads only the three raw variables it needs.
    expect(smoke).toContain('process.env.MEDIA_STORAGE_DIR')
    expect(smoke).toContain('process.env.FFPROBE_PATH')
    expect(smoke).toContain('process.env.REMOTION_BROWSER_EXECUTABLE')
  })

  it('reports capabilities, never paths, on failure', async () => {
    const smoke = await Bun.file('scripts/runtime-smoke.ts').text()
    expect(smoke).toContain('media_path_not_writable')
    expect(smoke).toContain('render_tooling_missing_')
    // TEETH: an earlier version printed the media root into the failure
    // line. Output is read in CI logs and pasted into support threads.
    expect(smoke).not.toContain('${mediaRoot}')
    expect(smoke).not.toContain('${root}')
  })
})
