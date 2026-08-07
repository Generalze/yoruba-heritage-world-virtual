import { drizzle } from 'drizzle-orm/mysql2'
import mysql from 'mysql2/promise'

import { env } from '@/lib/env'
import * as schema from '@/db/schema'

/**
 * MySQL / MariaDB connection foundation (TECHNICAL_CANON.md §25).
 *
 * The pool is created lazily so the application can boot (and the
 * health check can report an unavailable database) without a running
 * database server. utf8mb4 is required for full Yorùbá text support.
 */

let pool: mysql.Pool | undefined
let db: ReturnType<typeof createDb> | undefined

function createDb(p: mysql.Pool) {
  return drizzle(p, { schema, mode: 'default' })
}

export function getPool(): mysql.Pool {
  pool ??= mysql.createPool({
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    database: env.DATABASE_NAME,
    charset: 'utf8mb4_unicode_ci',
    // Cost-conscious VPS start (canon §2): 5 pooled connections are
    // sufficient for the foundation; raise only when load justifies it.
    connectionLimit: 5,
    connectTimeout: 5_000,
  })
  return pool
}

export function getDb() {
  db ??= createDb(getPool())
  return db
}

/**
 * Lightweight connectivity probe used by the health-check endpoint.
 * Never throws and never exposes credentials.
 */
export async function pingDatabase(): Promise<boolean> {
  try {
    const connection = await getPool().getConnection()
    try {
      await connection.ping()
    } finally {
      connection.release()
    }
    return true
  } catch {
    return false
  }
}
