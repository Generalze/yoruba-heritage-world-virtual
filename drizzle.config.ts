import { defineConfig } from 'drizzle-kit'

import { env } from './src/lib/env'

export default defineConfig({
  dialect: 'mysql',
  schema: './src/db/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
  },
})
