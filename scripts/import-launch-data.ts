/**
 * CURATED LAUNCH DATA — import.
 *
 *   docker compose run --rm -v /opt/yhw/launch-export:/launch:ro \
 *     app bun run scripts/import-launch-data.ts /launch
 *
 * Runs INSIDE the application container, which is the only place that
 * can reach all three things it needs at once: the private database on
 * the Compose network, the media volume at /app/var/media, and the
 * export mounted read-only. No host port is opened to do it.
 *
 * WHAT IT GUARANTEES
 *
 * - HOUSES ARE MATCHED BY CODE. The id travels with the row because
 *   `launch-content-v3.ts` pins it, but the CODE decides which House a
 *   row belongs to. If a target database already holds a House whose
 *   code and id disagree with the export, the import stops: silently
 *   re-pointing 24 prayers at the wrong House is the one mistake here
 *   that would be invisible afterwards.
 * - PRIMARY KEYS ARE PRESERVED, because the V3 manifest verifies
 *   against exact version ids.
 * - EVERY BINARY IS HASHED TWICE — once as read from the export, once
 *   as written into the media volume. A transfer that corrupts a file
 *   fails here, not at somebody's render.
 * - NO FIXTURE USER TRAVELS. Columns that reference `users` are
 *   discovered from the target's own foreign keys and set to NULL, so
 *   an approval trail never points at a test account that does not
 *   exist in production.
 * - NOTHING IS PUBLISHED. Statuses are written exactly as exported: an
 *   approved-but-unpublished template stays approved and unpublished.
 * - IT REFUSES TO RUN TWICE. A partial second import is how duplicate
 *   governed content happens; the check is per-table and explicit.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { sql } from 'drizzle-orm'

import { closeDb, getDb } from '@/db'

const SOURCE = process.argv[2]
if (!SOURCE) {
  console.error('usage: bun run scripts/import-launch-data.ts <export-directory>')
  process.exit(1)
}
const DRY_RUN = process.argv.includes('--dry-run')
const MEDIA_ROOT =
  process.env.MEDIA_STORAGE_DIR ?? join(process.cwd(), 'var', 'media')

/** Insert order is foreign-key order. Nothing here is alphabetical. */
const TABLE_ORDER = [
  'sacred_houses',
  'spiritual_content_items',
  'spiritual_content_versions',
  'sacred_content_version_profiles',
  'visual_bibles',
  'visual_bible_versions',
  'visual_bible_rules',
  'media_assets',
  'media_asset_versions',
  'visual_bible_reference_media',
  'prayer_session_templates',
  'prayer_session_template_versions',
  'prayer_session_template_slots',
  'prayer_template_slot_scopes',
  'prayer_template_slot_pins',
] as const

interface Payload {
  houseCodes: Array<string>
  tables: Record<string, Array<Record<string, unknown>>>
  binaries: Array<{ storageKey: string; sha256: string; bytes: number }>
}

const raw = readFileSync(join(SOURCE, 'launch-data.json'), 'utf8')
const expectedDigest = readFileSync(join(SOURCE, 'launch-data.json.sha256'), 'utf8')
  .trim()
  .split(/\s+/)[0]
const actualDigest = createHash('sha256').update(raw, 'utf8').digest('hex')
if (expectedDigest !== actualDigest) {
  console.error('refusing: launch-data.json does not match its .sha256 sidecar')
  process.exit(1)
}
const payload = JSON.parse(raw) as Payload
console.log(`Export digest verified: ${actualDigest.slice(0, 16)}…`)

const db = await getDb()

async function query(statement: string): Promise<Array<Record<string, unknown>>> {
  return (await db.execute(sql.raw(statement)))[0] as unknown as Array<
    Record<string, unknown>
  >
}

// --- Which columns point at `users`? Ask the target, don't guess. -------
const userFks = await query(`
  SELECT table_name, column_name
    FROM information_schema.key_column_usage
   WHERE table_schema = DATABASE() AND referenced_table_name = 'users'`)
const userColumns = new Map<string, Set<string>>()
for (const fk of userFks) {
  const table = String(fk.table_name ?? fk.TABLE_NAME)
  const column = String(fk.column_name ?? fk.COLUMN_NAME)
  const set = userColumns.get(table) ?? new Set<string>()
  set.add(column)
  userColumns.set(table, set)
}

// --- Houses: by CODE, and the ids must agree ---------------------------
const exportedHouses = payload.tables.sacred_houses
const existingHouses = await query(
  `SELECT id, code FROM sacred_houses WHERE code IN (${payload.houseCodes
    .map((c) => `'${c}'`)
    .join(',')})`,
)
for (const existing of existingHouses) {
  const match = exportedHouses.find((h) => h.code === existing.code)
  if (!match) continue
  if (Number(match.id) !== Number(existing.id)) {
    console.error(
      `refusing: House ${existing.code} is id ${existing.id} here and ${match.id} in the export.`,
    )
    console.error('  The V3 manifest pins ids; importing would mis-attribute content.')
    process.exit(1)
  }
}
console.log(
  `Houses already present, by code: ${existingHouses.length} of ${exportedHouses.length}`,
)

// --- Refuse a second pass ----------------------------------------------
let alreadyPopulated = false
for (const table of TABLE_ORDER) {
  const rows = payload.tables[table] ?? []
  if (rows.length === 0) continue
  const count = await query(`SELECT COUNT(*) AS n FROM \`${table}\``)
  const present = Number(count[0].n)
  if (table === 'sacred_houses') continue
  if (present > 0) {
    console.error(`refusing: ${table} already holds ${present} row(s).`)
    alreadyPopulated = true
  }
}
if (alreadyPopulated) {
  console.error('\nThis import is not a merge. Restore from backup, or start clean.')
  process.exit(1)
}

function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (value instanceof Date) return `'${value.toISOString().slice(0, 19).replace('T', ' ')}'`
  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  }
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// --- The rows ----------------------------------------------------------
let written = 0
for (const table of TABLE_ORDER) {
  const rows = payload.tables[table] ?? []
  if (rows.length === 0) {
    console.log(`  ${table.padEnd(38)} 0 (nothing to import)`)
    continue
  }
  const nullify = userColumns.get(table) ?? new Set<string>()
  const columns = Object.keys(rows[0])
  const values = rows.map((row) => {
    const cells = columns.map((column) =>
      nullify.has(column) ? 'NULL' : literal(row[column]),
    )
    return `(${cells.join(',')})`
  })
  const statement = `INSERT INTO \`${table}\` (${columns
    .map((c) => `\`${c}\``)
    .join(',')}) VALUES ${values.join(',')}`
  if (table === 'sacred_houses' && existingHouses.length === rows.length) {
    console.log(`  ${table.padEnd(38)} ${rows.length} (already present, left alone)`)
    continue
  }
  if (!DRY_RUN) await query(statement)
  written += rows.length
  const dropped = [...nullify].join(', ')
  console.log(
    `  ${table.padEnd(38)} ${rows.length}${dropped ? `  (user refs nulled: ${dropped})` : ''}`,
  )
}

// --- The binaries, hashed on the way in AND after landing --------------
console.log('\nBinaries:')
let intact = 0
for (const binary of payload.binaries) {
  const source = join(SOURCE, 'media', binary.sha256)
  const bytes = readFileSync(source)
  const beforeDigest = createHash('sha256').update(bytes).digest('hex')
  if (beforeDigest !== binary.sha256) {
    console.error(`  refusing: ${binary.storageKey} corrupt in the export`)
    process.exit(1)
  }
  const target = join(MEDIA_ROOT, binary.storageKey)
  if (!DRY_RUN) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, bytes)
    const afterDigest = createHash('sha256')
      .update(readFileSync(target))
      .digest('hex')
    if (afterDigest !== binary.sha256) {
      console.error(`  refusing: ${binary.storageKey} corrupt AFTER writing`)
      process.exit(1)
    }
  }
  intact += 1
}
console.log(`  ${intact} of ${payload.binaries.length} verified before and after transfer`)
console.log(`  media root: ${MEDIA_ROOT}`)

console.log(
  DRY_RUN
    ? '\nDRY RUN — nothing was written.'
    : `\nImported ${written} row(s) and ${intact} binaries. Nothing was published.`,
)

await closeDb()
