import { describe, expect, it } from 'bun:test'

import { envSchema } from '@/lib/env'
import {
  ProductionPreflightError,
  assertProductionPreflight,
  checkProductionPreflight,
  describeUnavailableCapabilities,
  formatPreflightIssues,
} from '@/server/production-preflight'
import type { Env } from '@/lib/env'

/**
 * ============================================================================
 * PRODUCTION STARTUP GATE — Phase One, Step 20.
 *
 * Two independent locks on the same door, and this suite proves both:
 *
 *   1. the SCHEMA refuses to construct a configuration object at all
 *      when a driver is unknown or a production rule is broken; and
 *   2. the PREFLIGHT refuses to serve traffic or claim a job, reporting
 *      bounded codes and variable NAMES — never values.
 *
 * Neither is the other's backup. The schema catches what a type system
 * can see; the preflight catches what only the raw environment can
 * (a variable that is absent rather than wrong) and is the thing both
 * processes actually call.
 * ============================================================================
 */

/** A complete, valid production environment — the baseline every case
 * below breaks in exactly one way, so a failure names one cause. */
const PRODUCTION_SOURCE: Record<string, string> = {
  NODE_ENV: 'production',
  APP_BASE_URL: 'https://prayer.example',
  DATABASE_PASSWORD: 'not-a-real-password',
  TRUST_PROXY: 'true',
  OBJECT_STORAGE_DRIVER: 'S3',
  OBJECT_STORAGE_ENDPOINT: 'https://s3.example',
  OBJECT_STORAGE_REGION: 'eu-west-1',
  OBJECT_STORAGE_BUCKET: 'yhwv-private',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'AKIA_PLACEHOLDER',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-placeholder',
  RENDER_DRIVER: 'REMOTION',
  VISUAL_GENERATION_DRIVER: 'DISABLED',
  TTS_DRIVER: 'DISABLED',
}

function parse(overrides: Record<string, string | undefined> = {}): Env {
  return envSchema.parse({ ...PRODUCTION_SOURCE, ...overrides })
}

function preflight(overrides: Record<string, string | undefined> = {}) {
  const source = { ...PRODUCTION_SOURCE, ...overrides }
  return checkProductionPreflight(source, parse(overrides))
}

function codes(overrides: Record<string, string | undefined> = {}) {
  return preflight(overrides).issues.map((issue) => issue.code)
}

describe('production configuration schema', () => {
  it('accepts a complete production environment', () => {
    const cfg = parse()
    expect(cfg.NODE_ENV).toBe('production')
    expect(cfg.OBJECT_STORAGE_DRIVER).toBe('S3')
    expect(cfg.RENDER_DRIVER).toBe('REMOTION')
  })

  it('refuses an unknown driver in EVERY environment, never falling back', () => {
    // TEETH: the failure mode this exists to prevent is a typo that
    // quietly selects the local/mock adapter. Development is checked
    // too — a developer who misspells a driver must be told, not handed
    // a directory that looks like it worked.
    for (const nodeEnv of ['development', 'test', 'production']) {
      for (const [name, bad] of [
        ['OBJECT_STORAGE_DRIVER', 'LOCLA'],
        ['RENDER_DRIVER', 'REMOTIN'],
        ['VISUAL_GENERATION_DRIVER', 'KLING'],
        ['TTS_DRIVER', 'ELEVENLABS'],
      ] as const) {
        expect(() =>
          envSchema.parse({ ...PRODUCTION_SOURCE, NODE_ENV: nodeEnv, [name]: bad }),
        ).toThrow()
      }
    }
  })

  it('treats a present-but-empty variable as unset', () => {
    // Compose materialises every referenced variable, so an unset
    // TRUST_PROXY arrives as "" rather than as absent. Parsing that as
    // a VALUE would fail with a type error instead of the preflight's
    // clear, actionable code.
    const cfg = envSchema.parse({ TRUST_PROXY: '', APP_BASE_URL: '' })
    expect(cfg.TRUST_PROXY).toBe(false)
    expect(cfg.APP_BASE_URL).toBe('http://localhost:3000')
  })

  it('refuses mock and local drivers in production', () => {
    for (const [name, value] of [
      ['OBJECT_STORAGE_DRIVER', 'LOCAL'],
      ['RENDER_DRIVER', 'MOCK'],
      ['VISUAL_GENERATION_DRIVER', 'MOCK'],
      ['TTS_DRIVER', 'MOCK'],
    ] as const) {
      expect(() =>
        envSchema.parse({ ...PRODUCTION_SOURCE, [name]: value }),
      ).toThrow()
      // …and the SAME value is perfectly fine in development, which is
      // what makes the production refusal a rule rather than a ban.
      expect(() =>
        envSchema.parse({
          ...PRODUCTION_SOURCE,
          NODE_ENV: 'development',
          [name]: value,
        }),
      ).not.toThrow()
    }
  })

  it('requires an HTTPS base URL and a database password in production', () => {
    expect(() =>
      envSchema.parse({ ...PRODUCTION_SOURCE, APP_BASE_URL: 'http://prayer.example' }),
    ).toThrow()
    expect(() =>
      envSchema.parse({ ...PRODUCTION_SOURCE, DATABASE_PASSWORD: '' }),
    ).toThrow()
  })

  it('requires every S3 setting whenever the S3 driver is selected, in any environment', () => {
    for (const name of [
      'OBJECT_STORAGE_ENDPOINT',
      'OBJECT_STORAGE_REGION',
      'OBJECT_STORAGE_BUCKET',
      'OBJECT_STORAGE_ACCESS_KEY_ID',
      'OBJECT_STORAGE_SECRET_ACCESS_KEY',
    ]) {
      expect(() =>
        envSchema.parse({
          ...PRODUCTION_SOURCE,
          NODE_ENV: 'development',
          [name]: '',
        }),
      ).toThrow()
    }
  })
})

describe('production preflight', () => {
  it('passes a complete production environment', () => {
    const result = preflight()
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
  })

  it('is deliberately permissive outside production', () => {
    // Development and test run on the local adapters BY DESIGN.
    // Reporting that as a fault would train everyone to ignore this
    // function, which is the only thing standing between a broken
    // production config and a running one.
    for (const nodeEnv of ['development', 'test'] as const) {
      const result = checkProductionPreflight(
        { NODE_ENV: nodeEnv },
        envSchema.parse({ NODE_ENV: nodeEnv }),
      )
      expect(result.ok).toBe(true)
      expect(result.issues).toEqual([])
    }
  })

  it('requires TRUST_PROXY to be set EXPLICITLY, which no schema default can see', () => {
    // TEETH: absence is the failure, not either value. A default would
    // silently choose — and both choices are wrong in different ways.
    expect(codes({ TRUST_PROXY: undefined })).toContain('trust_proxy_not_explicit')
    expect(codes({ TRUST_PROXY: '' })).toContain('trust_proxy_not_explicit')
    expect(codes({ TRUST_PROXY: 'false' })).not.toContain(
      'trust_proxy_not_explicit',
    )
    expect(codes({ TRUST_PROXY: 'true' })).not.toContain(
      'trust_proxy_not_explicit',
    )
  })

  it('names the environment variable an operator must set — and never a value', () => {
    const result = checkProductionPreflight(
      { ...PRODUCTION_SOURCE, TRUST_PROXY: '' },
      parse(),
    )
    const issue = result.issues.find(
      (candidate) => candidate.code === 'trust_proxy_not_explicit',
    )
    expect(issue?.envName).toBe('TRUST_PROXY')
    // Nothing anywhere in the reported result quotes a secret.
    const serialized = JSON.stringify(result) + formatPreflightIssues(result).join('|')
    for (const secret of [
      PRODUCTION_SOURCE.DATABASE_PASSWORD,
      PRODUCTION_SOURCE.OBJECT_STORAGE_SECRET_ACCESS_KEY,
      PRODUCTION_SOURCE.OBJECT_STORAGE_ACCESS_KEY_ID,
      PRODUCTION_SOURCE.OBJECT_STORAGE_ENDPOINT,
      PRODUCTION_SOURCE.OBJECT_STORAGE_BUCKET,
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('reports the two unapproved adapters as reduced capability, not as faults', () => {
    // DISABLED is a VALID production configuration and must not block
    // startup — a House whose approved media covers every scene needs
    // no generation. What it must do is say so.
    const result = preflight()
    expect(result.ok).toBe(true)
    expect(describeUnavailableCapabilities(parse())).toEqual([
      'visual_generation_disabled',
      'tts_disabled',
    ])
  })

  it('throws for the app and the worker alike, through the SAME function', () => {
    const broken = { ...PRODUCTION_SOURCE, TRUST_PROXY: '' }
    const cfg = parse()
    for (const label of ['web', 'worker']) {
      let thrown: unknown
      try {
        assertProductionPreflight(label, broken, cfg)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ProductionPreflightError)
      expect((thrown as ProductionPreflightError).issues.length).toBeGreaterThan(0)
      expect((thrown as Error).message).toContain(label)
      // The message an operator sees names no secret.
      expect((thrown as Error).message).not.toContain(
        PRODUCTION_SOURCE.DATABASE_PASSWORD,
      )
    }
  })

  it('does not throw on a valid environment', () => {
    expect(() =>
      assertProductionPreflight('web', PRODUCTION_SOURCE, parse()),
    ).not.toThrow()
  })
})

describe('9jaLingo TTS selection (Step 20)', () => {
  /** The complete, valid 9jaLingo overlay — each case below breaks it
   * in exactly one way. */
  const NAIJALINGO_SOURCE: Record<string, string> = {
    TTS_DRIVER: '9JALINGO',
    NAIJALINGO_API_KEY: 'test-key-placeholder',
    NAIJALINGO_API_BASE_URL: 'https://api.example-9jalingo.test/v1',
    NAIJALINGO_YO_VOICE_ID: 'adeola_yo',
    NAIJALINGO_MODEL: 'naijalingo-tts-1',
  }

  it('accepts a completely configured 9JALINGO production environment', () => {
    const cfg = parse(NAIJALINGO_SOURCE)
    expect(cfg.TTS_DRIVER).toBe('9JALINGO')
    const result = preflight(NAIJALINGO_SOURCE)
    expect(result.ok).toBe(true)
    expect(result.issues).toEqual([])
    // A REAL adapter is not reduced capability: only the visual stage
    // remains disabled.
    expect(describeUnavailableCapabilities(parse(NAIJALINGO_SOURCE))).toEqual([
      'visual_generation_disabled',
    ])
  })

  it('requires every NAIJALINGO variable whenever the driver is selected, in ANY environment', () => {
    // Same discipline as the S3 driver: a paid client with a missing
    // credential must stop a developer's process too, not only prod.
    for (const name of [
      'NAIJALINGO_API_KEY',
      'NAIJALINGO_API_BASE_URL',
      'NAIJALINGO_YO_VOICE_ID',
      'NAIJALINGO_MODEL',
    ]) {
      for (const nodeEnv of ['development', 'test', 'production']) {
        expect(() =>
          envSchema.parse({
            ...PRODUCTION_SOURCE,
            ...NAIJALINGO_SOURCE,
            NODE_ENV: nodeEnv,
            [name]: '',
          }),
        ).toThrow()
      }
    }
  })

  it('requires a plain HTTPS base URL: no http, no credentials, no query, no fragment', () => {
    for (const badUrl of [
      'http://api.example-9jalingo.test/v1',
      'https://user:pass@api.example-9jalingo.test/v1',
      'https://api.example-9jalingo.test/v1?key=abc',
      'https://api.example-9jalingo.test/v1#frag',
      'not a url',
    ]) {
      expect(() =>
        envSchema.parse({
          ...PRODUCTION_SOURCE,
          ...NAIJALINGO_SOURCE,
          NAIJALINGO_API_BASE_URL: badUrl,
        }),
      ).toThrow()
    }
  })

  it('reports preflight codes and variable NAMES for a broken 9jaLingo config — never values', () => {
    // The preflight is exercised directly with a hand-built cfg (the
    // schema would refuse to construct one) — exactly the split-lock
    // design: either lock alone must hold.
    const cfg = {
      ...parse(),
      TTS_DRIVER: '9JALINGO' as const,
      NAIJALINGO_API_KEY: '',
      NAIJALINGO_API_BASE_URL: 'http://insecure.example',
      NAIJALINGO_YO_VOICE_ID: '',
      NAIJALINGO_MODEL: 'naijalingo-tts-1',
    }
    const result = checkProductionPreflight(
      { ...PRODUCTION_SOURCE, ...NAIJALINGO_SOURCE },
      cfg,
    )
    expect(result.ok).toBe(false)
    const byCode = new Map(
      result.issues.map((issue) => [`${issue.code}|${issue.envName}`, issue]),
    )
    expect(byCode.has('naijalingo_config_missing|NAIJALINGO_API_KEY')).toBe(true)
    expect(byCode.has('naijalingo_config_missing|NAIJALINGO_YO_VOICE_ID')).toBe(
      true,
    )
    expect(byCode.has('naijalingo_endpoint_not_https|NAIJALINGO_API_BASE_URL')).toBe(
      true,
    )
    // No value — and in particular no key — anywhere in the output.
    const serialized =
      JSON.stringify(result) + formatPreflightIssues(result).join('|')
    expect(serialized).not.toContain(NAIJALINGO_SOURCE.NAIJALINGO_API_KEY)
    expect(serialized).not.toContain('insecure.example')
  })

  it('never falls back: the registry wires 9JALINGO to the real adapter and unknown drivers still throw', async () => {
    const source = await Bun.file('src/providers/tts/registry.ts').text()
    expect(source).toContain("case '9JALINGO':")
    expect(source).toContain('createNaijalingoTtsProvider()')
    // The default branch still throws — a driver name that resolves to
    // MOCK or DISABLED silently is the failure this registry exists to
    // prevent.
    expect(source).toContain('default:')
    expect(source).toContain('throw new')
  })
})

describe('the two processes share one gate', () => {
  it('the web entry and the worker both call assertProductionPreflight', async () => {
    // A worker that started while the app knew the configuration was
    // broken would claim somebody's paid appointment and fail it on
    // configuration, consuming its bounded retry budget for a fault
    // that has nothing to do with the booking.
    const server = await Bun.file('server.ts').text()
    const worker = await Bun.file(
      'src/workers/prayer-generation-worker.ts',
    ).text()
    for (const source of [server, worker]) {
      expect(source).toContain('assertProductionPreflight')
      expect(source).toContain('production-preflight')
    }
    // And the worker gate sits BEFORE any pipeline work. Compared
    // against the CALL, not the import at the top of the file — hence
    // lastIndexOf.
    const gateAt = worker.indexOf('assertProductionPreflight(')
    const workAt = worker.lastIndexOf('runGenerationPipelinePass(')
    expect(gateAt).toBeGreaterThan(-1)
    expect(workAt).toBeGreaterThan(gateAt)
  })
})
