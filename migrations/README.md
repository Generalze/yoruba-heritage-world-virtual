# migrations/

Drizzle Kit migration output directory (see `drizzle.config.ts`).

- `bun run db:generate` — generate SQL migrations from the schema in
  `src/db/schema/`
- `bun run db:migrate` — apply pending migrations to the database

No migrations exist yet: the schema is intentionally empty at the
foundation stage. Domain tables arrive in later approved stages.
