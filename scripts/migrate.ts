/**
 * THE migration runner — the one that exists where it is needed.
 *
 *   bun run db:migrate
 *
 * WHY THIS EXISTS RATHER THAN `drizzle-kit migrate`. drizzle-kit is a
 * devDependency, and the runtime image installs with
 * `bun install --frozen-lockfile --production`. So the command the
 * runbook told an operator to run in production was a command the
 * production image could not run: it fails at the moment a schema
 * change is due, on a server, with the site down for maintenance.
 *
 * drizzle-orm's own migrator has none of that problem. It is a RUNTIME
 * dependency, already present for every query the application makes,
 * and it reads the same `migrations/` folder the image already carries
 * and the same `__drizzle_migrations` journal drizzle-kit writes — so a
 * database migrated with the kit in development continues cleanly here,
 * and this is the same call the integration tests have always used.
 *
 * ONE COMMAND FOR EVERY ENVIRONMENT. Two would be worse than one that
 * is occasionally inconvenient: an operator under pressure picks the
 * wrong one, and `drizzle-kit generate` remains the only thing the
 * development toolchain is needed for.
 *
 * IT IS NEVER AUTOMATIC. Nothing calls this at boot or on a request.
 * A schema change lands when a person decides it lands, having taken a
 * backup first — see docs/OPERATIONS.md.
 */
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import { env } from '@/lib/env'

const MIGRATIONS_FOLDER = './migrations'

async function main(): Promise<void> {
  // The database NAME is operational context an operator needs to see;
  // the host, user and password are not, and none of them is printed
  // here or anywhere else in this script.
  console.log(`Applying migrations to '${env.DATABASE_NAME}'.`)
  console.log(`Folder: ${MIGRATIONS_FOLDER}`)

  const startedAt = Date.now()
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER })
  console.log(`Migrations applied in ${Date.now() - startedAt} ms.`)

  // What the journal now says, so the operator has something concrete
  // to record and to compare against after a restore. A count, never a
  // dump.
  const applied = (await getDb().execute(
    'SELECT COUNT(*) AS applied FROM `__drizzle_migrations`',
  )) as unknown as Array<Array<{ applied: number }>>
  console.log(`Journal reports ${applied[0][0].applied} applied migration(s).`)
}

try {
  await main()
} catch (error) {
  // A migration failure must be loud and must not be mistaken for
  // success by a shell that only checks the exit code.
  console.error(
    `[migrate] FAILED: ${
      error instanceof Error ? error.message : String(error)
    }`,
  )
  process.exitCode = 1
} finally {
  await closeDb()
}
