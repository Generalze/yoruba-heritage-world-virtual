import { z } from 'zod'

import { validateStorageEndpoint } from '@/lib/security-headers'

/**
 * Server-side environment configuration, validated with Zod.
 *
 * Import this module only from server-side code (database layer, server
 * routes, jobs). Secrets are provided exclusively through environment
 * variables — see .env.example for the expected placeholders. Secret
 * values must never reach client bundles or logs.
 *
 * Defaults below are non-secret local-development conveniences; every
 * real deployment must provide its own values via the environment.
 */

/**
 * Comma-separated ISO-4217 currency allowlist. These are OPERATOR
 * configuration, not provider capabilities: a provider is only offered
 * for an appointment currency the operator has explicitly listed for
 * their actual merchant account. Empty list = provider supports no
 * currency (and is therefore never offered).
 */
const currencyList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((code) => code.trim().toUpperCase())
      .filter((code) => /^[A-Z]{3}$/.test(code)),
  )

/**
 * Variables for which PRESENT BUT EMPTY means NOT SET.
 *
 * Docker Compose materialises every referenced variable, so an unset
 * `TRUST_PROXY` arrives in the container as `""` rather than as absent.
 * For a switch or an enum that is meaningless: `""` is not `false` and
 * not a driver name, and parsing it as a VALUE produces a type error
 * instead of the preflight's clear, actionable message.
 *
 * The list is EXPLICIT rather than a blanket rule, because for other
 * variables an empty string is genuinely meaningful and must keep
 * failing validation. `DATABASE_NAME=""` is a misconfiguration, not an
 * omission, and `PAYSTACK_SECRET_KEY=""` is exactly what the
 * enabled-without-credentials check exists to catch — stripping either
 * would turn a caught error into a silent default.
 */
const EMPTY_MEANS_UNSET: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'APP_PORT',
  'APP_BASE_URL',
  'TRUST_PROXY',
  'DATABASE_PORT',
  'PAYMENTS_ENABLED',
  'PAYSTACK_ENABLED',
  'PAYPAL_ENABLED',
  'PAYPAL_ENV',
  'STRIPE_ENABLED',
  'CRYPTO_ENABLED',
  'CRYPTO_PROVIDER',
  'OBJECT_STORAGE_DRIVER',
  'OBJECT_STORAGE_FORCE_PATH_STYLE',
  'RENDER_DRIVER',
  'VISUAL_GENERATION_DRIVER',
  'TTS_DRIVER',
  'REMOTION_CONCURRENCY',
  'REMOTION_TIMEOUT_MS',
])

function stripEmptyValues(source: unknown): unknown {
  if (source == null || typeof source !== 'object') return source
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(
    source as Record<string, unknown>,
  )) {
    if (
      typeof value === 'string' &&
      value.trim() === '' &&
      EMPTY_MEANS_UNSET.has(key)
    ) {
      continue
    }
    out[key] = value
  }
  return out
}

const envObjectSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    APP_PORT: z.coerce.number().int().positive().default(3000),
    /**
     * Explicit proxy trust. X-Forwarded-For is client-controlled unless a
     * trusted reverse proxy sets it, so it is IGNORED by default — an
     * attacker must not be able to spoof their IP to evade rate limiting
     * or pollute audit logs. Set to true only when the app runs behind
     * the VPS reverse proxy that overwrites the header.
     */
    TRUST_PROXY: z.stringbool().default(false),
    DATABASE_HOST: z.string().min(1).default('127.0.0.1'),
    DATABASE_PORT: z.coerce.number().int().positive().default(3306),
    DATABASE_USER: z.string().min(1).default('yhwv'),
    DATABASE_PASSWORD: z.string().default(''),
    DATABASE_NAME: z.string().min(1).default('yoruba_heritage_world'),
    /**
     * Application origin for payment callback/return URLs. ALWAYS
     * server-generated — callback/success/cancel URLs are never accepted
     * from browser parameters (open-redirect protection).
     */
    APP_BASE_URL: z.url().default('http://localhost:3000'),
    /**
     * Global payment kill-switch. Everything payment defaults to
     * DISABLED: a fresh migration/deployment must never accidentally
     * start accepting money.
     */
    PAYMENTS_ENABLED: z.stringbool().default(false),
    PAYSTACK_ENABLED: z.stringbool().default(false),
    PAYSTACK_SECRET_KEY: z.string().default(''),
    PAYSTACK_CURRENCIES: currencyList,
    PAYPAL_ENABLED: z.stringbool().default(false),
    PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
    PAYPAL_CLIENT_ID: z.string().default(''),
    PAYPAL_CLIENT_SECRET: z.string().default(''),
    PAYPAL_WEBHOOK_ID: z.string().default(''),
    PAYPAL_CURRENCIES: currencyList,
    STRIPE_ENABLED: z.stringbool().default(false),
    STRIPE_SECRET_KEY: z.string().default(''),
    STRIPE_WEBHOOK_SECRET: z.string().default(''),
    STRIPE_CURRENCIES: currencyList,
    CRYPTO_ENABLED: z.stringbool().default(false),
    CRYPTO_PROVIDER: z.string().default('mock'),
    CRYPTO_API_KEY: z.string().default(''),
    CRYPTO_WEBHOOK_SECRET: z.string().default(''),
    CRYPTO_FIAT_CURRENCIES: currencyList,

    // --- Runtime drivers (Phase One, Step 20) -----------------------------
    //
    // Every driver is an EXPLICIT ENUM, so an unknown or misspelt value
    // is a startup failure in EVERY environment rather than a silent
    // fall back to the local/mock adapter. "It quietly used the mock"
    // is the exact production failure these enums exist to make
    // impossible; a typo must stop the process, not downgrade it.
    /** LOCAL = a directory on one machine (development/test only).
     * S3 = any S3-compatible PRIVATE bucket. */
    OBJECT_STORAGE_DRIVER: z.enum(['LOCAL', 'S3']).default('LOCAL'),
    OBJECT_STORAGE_ROOT: z.string().default(''),
    OBJECT_STORAGE_ENDPOINT: z.string().default(''),
    OBJECT_STORAGE_REGION: z.string().default(''),
    OBJECT_STORAGE_BUCKET: z.string().default(''),
    OBJECT_STORAGE_ACCESS_KEY_ID: z.string().default(''),
    OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().default(''),
    /** Most non-AWS S3-compatible services need path-style addressing. */
    OBJECT_STORAGE_FORCE_PATH_STYLE: z.stringbool().default(true),

    /** MOCK = the deterministic synthetic renderer (development/test
     * only). REMOTION = the real compositor. */
    RENDER_DRIVER: z.enum(['MOCK', 'REMOTION']).default('MOCK'),
    /** Absolute path to `ffprobe`. Empty means "resolve from PATH".
     * Probing is how a real duration is learned; it is never optional
     * for the real renderer. */
    FFPROBE_PATH: z.string().default(''),
    /**
     * Absolute path to the headless browser the real compositor drives.
     *
     * Set explicitly so the browser is the one BAKED INTO THE IMAGE.
     * Left unset, Remotion provisions its own on first use — a download
     * at the moment of somebody's paid render, on a container whose
     * cache directory may not even be writable. Readiness reports an
     * unset or non-executable value as a missing capability.
     */
    REMOTION_BROWSER_EXECUTABLE: z.string().default(''),
    /** Bounded concurrency for the real compositor on a small VPS. */
    REMOTION_CONCURRENCY: z.coerce.number().int().positive().max(16).default(1),
    REMOTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 60 * 1000),

    /**
     * MOCK = the deterministic synthetic provider (development/test
     * only). DISABLED = no synthesis backend is configured, so a
     * manifest that REQUIRES generation fails closed rather than being
     * silently skipped, and a manifest that requires none proceeds
     * normally.
     *
     * There is deliberately no third value: no external visual
     * generation or speech vendor has been approved, and this codebase
     * does not name one on its own initiative.
     */
    VISUAL_GENERATION_DRIVER: z.enum(['MOCK', 'DISABLED']).default('MOCK'),
    TTS_DRIVER: z.enum(['MOCK', 'DISABLED']).default('MOCK'),
  })
  .superRefine((cfg, ctx) => {
    // A provider switched on without its credentials is a configuration
    // error, surfaced at startup — not a silent runtime failure.
    if (cfg.PAYSTACK_ENABLED && cfg.PAYSTACK_SECRET_KEY.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['PAYSTACK_SECRET_KEY'],
        message: 'PAYSTACK_ENABLED=true requires PAYSTACK_SECRET_KEY',
      })
    }
    if (cfg.PAYPAL_ENABLED) {
      for (const key of [
        'PAYPAL_CLIENT_ID',
        'PAYPAL_CLIENT_SECRET',
        'PAYPAL_WEBHOOK_ID',
      ] as const) {
        if (cfg[key].length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `PAYPAL_ENABLED=true requires ${key}`,
          })
        }
      }
    }
    if (cfg.STRIPE_ENABLED) {
      for (const key of [
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
      ] as const) {
        if (cfg[key].length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `STRIPE_ENABLED=true requires ${key}`,
          })
        }
      }
    }
    // Crypto fails SAFE: no concrete processor has been approved or
    // implemented, so the only valid adapter is the mock — and the mock
    // must be impossible to run in production. Do NOT invent a vendor.
    if (cfg.CRYPTO_ENABLED) {
      if (cfg.CRYPTO_PROVIDER !== 'mock') {
        ctx.addIssue({
          code: 'custom',
          path: ['CRYPTO_PROVIDER'],
          message: `No approved crypto processor is implemented; CRYPTO_PROVIDER=${cfg.CRYPTO_PROVIDER} is not available`,
        })
      } else if (cfg.NODE_ENV === 'production') {
        ctx.addIssue({
          code: 'custom',
          path: ['CRYPTO_PROVIDER'],
          message:
            'CRYPTO_PROVIDER=mock is invalid in production while CRYPTO_ENABLED=true',
        })
      }
    }
    // An S3 driver without complete credentials is a configuration
    // error EVERYWHERE, not only in production: a developer who sets
    // the driver and forgets the bucket must be told so, not handed a
    // local directory that looks like it worked.
    if (cfg.OBJECT_STORAGE_DRIVER === 'S3') {
      for (const key of [
        'OBJECT_STORAGE_ENDPOINT',
        'OBJECT_STORAGE_REGION',
        'OBJECT_STORAGE_BUCKET',
        'OBJECT_STORAGE_ACCESS_KEY_ID',
        'OBJECT_STORAGE_SECRET_ACCESS_KEY',
      ] as const) {
        if (cfg[key].trim().length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: `OBJECT_STORAGE_DRIVER=S3 requires ${key}`,
          })
        }
      }
    }

    if (cfg.NODE_ENV !== 'production') return

    // --- Production-only requirements -------------------------------------
    //
    // These are duplicated by the startup preflight on purpose. This
    // one refuses to construct a configuration object at all; the
    // preflight refuses to serve traffic or claim a job, and reports
    // the same codes for an operator. Neither is the other's backup.
    if (!cfg.APP_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_BASE_URL'],
        // Not only for payments: every cookie, redirect and signed URL
        // in production assumes a channel that cannot be read in
        // transit.
        message: 'Production requires an HTTPS APP_BASE_URL',
      })
    }
    if (cfg.DATABASE_PASSWORD.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_PASSWORD'],
        message: 'Production requires a non-empty DATABASE_PASSWORD',
      })
    }
    if (cfg.OBJECT_STORAGE_DRIVER === 'LOCAL') {
      ctx.addIssue({
        code: 'custom',
        path: ['OBJECT_STORAGE_DRIVER'],
        message:
          'OBJECT_STORAGE_DRIVER=LOCAL is invalid in production — a directory on one machine is not durable private object storage',
      })
    } else {
      // A recorded prayer is delivered to a browser by redirecting it
      // to a signed URL at this endpoint, and the CSP names its origin
      // as the one external source allowed to play media. It must
      // therefore be a real, credential-free HTTPS base URL.
      const endpoint = validateStorageEndpoint(cfg.OBJECT_STORAGE_ENDPOINT)
      if (!endpoint.ok) {
        ctx.addIssue({
          code: 'custom',
          path: ['OBJECT_STORAGE_ENDPOINT'],
          message: `Production requires a plain HTTPS OBJECT_STORAGE_ENDPOINT (${endpoint.reasonCode})`,
        })
      }
      if (!cfg.OBJECT_STORAGE_FORCE_PATH_STYLE) {
        // Virtual-hosted addressing puts the bucket in the HOST, so the
        // signed URL would land on an origin the Prayer Room's pin and
        // the CSP do not know about — and every playback would be
        // refused. See the preflight for the full reasoning.
        ctx.addIssue({
          code: 'custom',
          path: ['OBJECT_STORAGE_FORCE_PATH_STYLE'],
          message:
            'Production requires OBJECT_STORAGE_FORCE_PATH_STYLE=true — signed media is delivered from the configured endpoint origin',
        })
      }
    }
    if (cfg.RENDER_DRIVER === 'MOCK') {
      ctx.addIssue({
        code: 'custom',
        path: ['RENDER_DRIVER'],
        message:
          'RENDER_DRIVER=MOCK is invalid in production — the mock produces a synthetic artifact, not a real composition',
      })
    }
    if (cfg.VISUAL_GENERATION_DRIVER === 'MOCK') {
      ctx.addIssue({
        code: 'custom',
        path: ['VISUAL_GENERATION_DRIVER'],
        message:
          'VISUAL_GENERATION_DRIVER=MOCK is invalid in production; set DISABLED until an approved adapter is selected',
      })
    }
    if (cfg.TTS_DRIVER === 'MOCK') {
      ctx.addIssue({
        code: 'custom',
        path: ['TTS_DRIVER'],
        message:
          'TTS_DRIVER=MOCK is invalid in production; set DISABLED until an approved adapter is selected',
      })
    }
  })

export const envSchema = z.preprocess(stripEmptyValues, envObjectSchema)

export type Env = z.infer<typeof envSchema>

export const env: Env = envSchema.parse(process.env)
