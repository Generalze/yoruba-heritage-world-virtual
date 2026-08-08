import { z } from 'zod'

/**
 * Server-side environment configuration, validated with Zod.
 *
 * Import this module only from server-side code (database layer, server
 * routes, jobs). Secrets are provided exclusively through environment
 * variables — see .env.example for the expected placeholders.
 *
 * Defaults below are non-secret local-development conveniences; every
 * real deployment must provide its own values via the environment.
 */
export const envSchema = z.object({
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
})

export type Env = z.infer<typeof envSchema>

export const env: Env = envSchema.parse(process.env)
