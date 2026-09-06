/**
 * CURATED LAUNCH DATA — export.
 *
 *   bun run scripts/export-launch-data.ts <output-directory>
 *
 * A development database is not a launch dataset. This one carries 132
 * fixture users, 126 draft templates, test appointments and years of
 * suite residue alongside the governed content, and a `mysqldump` of it
 * would carry all of that into production as though it had been
 * approved. So this exports an EXPLICIT, ENUMERATED set — the rows a
 * person authorised, and nothing that merely happens to sit beside
 * them.
 *
 * WHAT IS EXPORTED, exactly:
 *   - the 4 canonical Sacred Houses, resolved BY CODE
 *   - the 24 V3 launch content items and their 48 versions (Yorùbá
 *     originals and English companions) with their sacred profiles
 *   - the 4 APPROVED Visual Bible versions, one per House, and their
 *     governed rules — the ARCHIVED V205 is excluded
 *   - the 24 approved reference bindings, their media assets/versions,
 *     and the binary files themselves
 *   - the 2 genuinely approved launch template versions, with slots and
 *     slot scopes, IN THEIR CURRENT PUBLICATION STATE
 *
 * WHAT IS NOT, equally exactly: users, appointments, subscriptions,
 * payments, fixture Houses, the 126 draft templates, archived content,
 * and any media not bound to an approved Visual Bible.
 *
 * PRIMARY KEYS ARE PRESERVED. `src/lib/launch-content-v3.ts` pins the
 * 48 content version ids and the four House ids; the runtime
 * verification (`bun run verify:launch-content`) checks the database
 * against those exact numbers. Re-keying on import would silently break
 * that proof, so ids travel with the rows and the importer writes them
 * explicitly.
 *
 * HOUSES ARE MATCHED BY CODE, NEVER BY ORDINAL. The V3 document, the
 * Visual Bible pack and the image pack each number these four Houses
 * differently and none agrees with the schema. The id is carried so the
 * manifest keeps working; the CODE is what identifies the House, and
 * the importer refuses a database whose codes and ids disagree.
 *
 * NOTHING IS PUBLISHED BY EXPORTING. Statuses travel verbatim: an
 * approved-but-unpublished template arrives approved and unpublished.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'

import { closeDb, getDb } from '@/db'
import { SACRED_HOUSE_VOICE_PROFILE } from '@/lib/sacred-voice-routing'
import { V3_LAUNCH_CONTENT } from '@/lib/launch-content-v3'

const OUT = process.argv[2]
if (!OUT) {
  console.error('usage: bun run scripts/export-launch-data.ts <output-directory>')
  process.exit(1)
}

const HOUSE_CODES = Object.keys(SACRED_HOUSE_VOICE_PROFILE)
const V3_ITEM_CODES = [...new Set(V3_LAUNCH_CONTENT.map((e) => e.itemCode))]
const V3_VERSION_IDS = V3_LAUNCH_CONTENT.map((e) => e.versionId)
const MEDIA_ROOT =
  process.env.MEDIA_STORAGE_DIR ?? join(process.cwd(), 'var', 'media')

const db = await getDb()

/** Raw rows, so every governed column travels without a hand-written
 * projection quietly dropping one. */
async function rows(statement: string): Promise<Array<Record<string, unknown>>> {
  return (await db.execute(sql.raw(statement)))[0] as unknown as Array<
    Record<string, unknown>
  >
}

const list = (values: Array<string | number>): string =>
  values.map((v) => (typeof v === 'number' ? String(v) : `'${v}'`)).join(',')

console.log('CURATED LAUNCH EXPORT\n')

// --- Houses, by code ---------------------------------------------------
const houses = await rows(
  `SELECT * FROM sacred_houses WHERE code IN (${list(HOUSE_CODES)}) ORDER BY id`,
)
if (houses.length !== 4) {
  console.error(`refusing: expected 4 canonical Houses, found ${houses.length}`)
  process.exit(1)
}

// --- Sacred content ----------------------------------------------------
const items = await rows(
  `SELECT * FROM spiritual_content_items WHERE code IN (${list(V3_ITEM_CODES)}) ORDER BY id`,
)
const versions = await rows(
  `SELECT * FROM spiritual_content_versions WHERE id IN (${list(V3_VERSION_IDS)}) ORDER BY id`,
)
const profiles = await rows(
  `SELECT * FROM sacred_content_version_profiles WHERE content_version_id IN (${list(V3_VERSION_IDS)}) ORDER BY content_version_id`,
)

// --- Visual Bibles: APPROVED only, archived V205 excluded --------------
const bibleVersions = await rows(
  `SELECT vv.* FROM visual_bible_versions vv
     JOIN visual_bibles b ON b.id = vv.visual_bible_id
    WHERE vv.status = 'APPROVED'
      AND b.sacred_house_id IN (SELECT id FROM sacred_houses WHERE code IN (${list(HOUSE_CODES)}))
    ORDER BY vv.id`,
)
const bibleVersionIds = bibleVersions.map((v) => Number(v.id))
const bibles = await rows(
  `SELECT * FROM visual_bibles
    WHERE id IN (${list(bibleVersions.map((v) => Number(v.visual_bible_id)))}) ORDER BY id`,
)
const rules = await rows(
  `SELECT * FROM visual_bible_rules WHERE bible_version_id IN (${list(bibleVersionIds)}) ORDER BY id`,
)
const bindings = await rows(
  `SELECT * FROM visual_bible_reference_media
    WHERE visual_bible_version_id IN (${list(bibleVersionIds)}) ORDER BY id`,
)

// --- The media those bindings point at ---------------------------------
const mediaVersionIds = bindings.map((b) => Number(b.media_asset_version_id))
const mediaVersions = await rows(
  `SELECT * FROM media_asset_versions WHERE id IN (${list(mediaVersionIds)}) ORDER BY id`,
)
const mediaAssetIds = [...new Set(mediaVersions.map((v) => Number(v.asset_id)))]
const mediaAssetRows = await rows(
  `SELECT * FROM media_assets WHERE id IN (${list(mediaAssetIds)}) ORDER BY id`,
)

// --- The two approved launch templates, in their current state ---------
const templateVersions = await rows(
  `SELECT * FROM prayer_session_template_versions WHERE status = 'APPROVED' ORDER BY id`,
)
const templateIds = [...new Set(templateVersions.map((v) => Number(v.template_id)))]
const templates = await rows(
  `SELECT * FROM prayer_session_templates WHERE id IN (${list(templateIds)}) ORDER BY id`,
)
const templateVersionIds = templateVersions.map((v) => Number(v.id))
const slots = await rows(
  `SELECT * FROM prayer_session_template_slots
    WHERE template_version_id IN (${list(templateVersionIds)}) ORDER BY id`,
)
const slotScopes = slots.length
  ? await rows(
      `SELECT * FROM prayer_template_slot_scopes
        WHERE slot_id IN (${list(slots.map((s) => Number(s.id)))})
        ORDER BY slot_id, scope_type`,
    )
  : []
const slotPins = slots.length
  ? await rows(
      `SELECT * FROM prayer_template_slot_pins
        WHERE slot_id IN (${list(slots.map((s) => Number(s.id)))})
        ORDER BY slot_id, content_version_id`,
    )
  : []

// --- Binaries, hashed on the way out -----------------------------------
mkdirSync(join(OUT, 'media'), { recursive: true })
const binaries: Array<{ storageKey: string; sha256: string; bytes: number }> = []
for (const version of mediaVersions) {
  const key = String(version.storage_key ?? '')
  const source = join(MEDIA_ROOT, key)
  const bytes = readFileSync(source)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== version.file_sha256) {
    console.error(`refusing: ${key} does not match its recorded hash`)
    process.exit(1)
  }
  const target = join(OUT, 'media', digest)
  copyFileSync(source, target)
  binaries.push({ storageKey: key, sha256: digest, bytes: bytes.length })
}

const payload = {
  exportedAt: new Date().toISOString(),
  sourceRevision: process.env.APP_REVISION ?? null,
  houseCodes: HOUSE_CODES,
  tables: {
    sacred_houses: houses,
    spiritual_content_items: items,
    spiritual_content_versions: versions,
    sacred_content_version_profiles: profiles,
    visual_bibles: bibles,
    visual_bible_versions: bibleVersions,
    visual_bible_rules: rules,
    media_assets: mediaAssetRows,
    media_asset_versions: mediaVersions,
    visual_bible_reference_media: bindings,
    prayer_session_templates: templates,
    prayer_session_template_versions: templateVersions,
    prayer_session_template_slots: slots,
    prayer_template_slot_scopes: slotScopes,
    prayer_template_slot_pins: slotPins,
  },
  binaries,
}

mkdirSync(OUT, { recursive: true })
const json = JSON.stringify(payload, null, 2)
writeFileSync(join(OUT, 'launch-data.json'), json, 'utf8')
writeFileSync(
  join(OUT, 'launch-data.json.sha256'),
  `${createHash('sha256').update(json, 'utf8').digest('hex')}  launch-data.json\n`,
  'utf8',
)

for (const [table, list_] of Object.entries(payload.tables)) {
  console.log(`  ${table.padEnd(38)} ${list_.length}`)
}
console.log(`  ${'binaries'.padEnd(38)} ${binaries.length}`)
console.log(`\nWritten to ${OUT}`)

await closeDb()
