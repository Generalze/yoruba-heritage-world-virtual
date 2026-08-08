import { z } from 'zod'

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

export const envSchema = z
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
    if (
      cfg.NODE_ENV === 'production' &&
      cfg.PAYMENTS_ENABLED &&
      !cfg.APP_BASE_URL.startsWith('https://')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_BASE_URL'],
        message: 'Production payments require an HTTPS APP_BASE_URL',
      })
    }
  })

export type Env = z.infer<typeof envSchema>

export const env: Env = envSchema.parse(process.env)
