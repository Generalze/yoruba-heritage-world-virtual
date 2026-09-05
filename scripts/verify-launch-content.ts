/**
 * Launch-content verification.
 *
 *   bun run verify:launch-content
 *
 * Proves that THIS database holds the locked V3 launch pack exactly as
 * pinned in src/lib/launch-content-v3.ts.
 *
 * IT FAILS WHEN THE CONTENT IS ABSENT. That is the whole difference
 * between this and the integration suite: a test must stay green on a
 * fresh CI schema that legitimately has no launch content, so it skips
 * the row assertions. A deployment that is supposed to SERVE prayers
 * has no such excuse — missing content there is a broken launch, not an
 * empty fixture, and silence about it would be the worst possible
 * answer.
 *
 * Read-only. Nothing is written, nothing is repaired. A drifted row is
 * reported, never corrected: the fix for a mismatch is a new governed
 * version, not a script that edits sacred text back into shape.
 */
import { createHash } from 'node:crypto'
import { closeDb, getDb } from '@/db'
import { sql } from 'drizzle-orm'
import {
  V3_CONTENT_TYPES,
  V3_HOUSES,
  V3_LAUNCH_CONTENT,
  V3_PROVENANCE_NOTE,
} from '@/lib/launch-content-v3'

const problems: Array<string> = []

function fail(message: string): void {
  problems.push(message)
  console.log(`FAIL  ${message}`)
}

function ok(message: string): void {
  console.log(`OK    ${message}`)
}

async function main(): Promise<void> {
  console.log('Launch content verification — V3 locked pack.')
  console.log(`${V3_LAUNCH_CONTENT.length} versions pinned by manifest.\n`)

  const rows = (
    await getDb().execute(sql`
      SELECT v.id AS versionId, i.code AS itemCode, i.sacred_house_id AS houseId,
             i.scope_type AS scopeType, i.content_type AS contentType,
             i.active AS itemActive, v.language, v.status, v.body,
             p.variant_kind AS variantKind, p.voice_policy AS voicePolicy,
             p.external_ai_policy AS externalAiPolicy,
             p.access_policy AS accessPolicy, p.rights_status AS rightsStatus,
             p.runtime_enabled AS runtimeEnabled,
             p.digital_storage_authorized AS storageOk,
             p.provenance_type AS provenanceType,
             p.internal_provenance_note AS note,
             p.content_sha256 AS contentSha256,
             p.duration_hint_seconds AS durationHintSeconds
      FROM spiritual_content_versions v
      JOIN spiritual_content_items i ON i.id = v.content_item_id
      JOIN sacred_content_version_profiles p ON p.content_version_id = v.id
      WHERE v.id IN (${sql.raw(V3_LAUNCH_CONTENT.map((e) => e.versionId).join(','))})`)
  )[0] as never as Array<Record<string, string | number | null>>

  const byId = new Map(rows.map((row) => [Number(row.versionId), row]))

  if (byId.size === 0) {
    fail(
      'no V3 launch content in this database — the pack has not been registered here',
    )
    summarize()
    return
  }
  ok(`${byId.size} of ${V3_LAUNCH_CONTENT.length} pinned versions present`)

  for (const entry of V3_LAUNCH_CONTENT) {
    const label = `${entry.itemCode}/${entry.language} (v${entry.versionId})`
    const row = byId.get(entry.versionId)
    if (!row) {
      fail(`${label}: missing`)
      continue
    }

    // THE PIN. The manifest hash came from the locked source document,
    // so this compares the database against the document rather than
    // against itself.
    const actual = createHash('sha256')
      .update(String(row.body), 'utf8')
      .digest('hex')
    if (actual !== entry.sha256) {
      fail(`${label}: BODY DIFFERS from the locked V3 text`)
      continue
    }
    if (String(row.contentSha256).toLowerCase() !== entry.sha256) {
      fail(`${label}: recorded content hash differs from the locked V3 text`)
      continue
    }

    const mismatches: Array<string> = []
    if (row.itemCode !== entry.itemCode) mismatches.push('itemCode')
    if (Number(row.houseId) !== entry.houseId) mismatches.push('houseId')
    if (row.contentType !== entry.contentType) mismatches.push('contentType')
    if (row.language !== entry.language) mismatches.push('language')
    if (row.variantKind !== entry.variantKind) mismatches.push('variantKind')
    if (row.voicePolicy !== entry.voicePolicy) mismatches.push('voicePolicy')
    if (Number(row.durationHintSeconds) !== entry.durationHintSeconds) {
      mismatches.push('durationHintSeconds')
    }
    if (row.note !== V3_PROVENANCE_NOTE) mismatches.push('provenanceNote')
    if (row.provenanceType !== 'ORIGINAL_AUTHORED') mismatches.push('provenanceType')
    if (row.externalAiPolicy !== 'METADATA_ONLY') mismatches.push('externalAiPolicy')
    if (row.scopeType !== 'SACRED_HOUSE') mismatches.push('scopeType')
    if (Number(row.itemActive) !== 1) mismatches.push('itemActive')

    // Runtime eligibility, required of the spoken versions only.
    if (entry.language === 'yo') {
      if (row.status !== 'PUBLISHED') mismatches.push('status')
      if (row.rightsStatus !== 'CLEARED') mismatches.push('rightsStatus')
      if (row.accessPolicy !== 'PRAYER_ROOM_PRIVATE') mismatches.push('accessPolicy')
      if (Number(row.runtimeEnabled) !== 1) mismatches.push('runtimeEnabled')
      if (Number(row.storageOk) !== 1) mismatches.push('digitalStorageAuthorized')
    }

    if (mismatches.length > 0) fail(`${label}: ${mismatches.join(', ')}`)
  }

  if (problems.length === 0) {
    ok('every pinned version matches the locked V3 text and its governed state')
  }

  // Per-House readiness, from the manifest's own expectations.
  console.log('')
  for (const house of V3_HOUSES) {
    const spoken = V3_LAUNCH_CONTENT.filter(
      (e) => e.houseId === house.id && e.language === 'yo',
    )
    const present = spoken.filter((e) => {
      const row = byId.get(e.versionId)
      return (
        row &&
        row.status === 'PUBLISHED' &&
        row.rightsStatus === 'CLEARED' &&
        Number(row.runtimeEnabled) === 1
      )
    })
    const missing = V3_CONTENT_TYPES.filter(
      (type) => !present.some((e) => e.contentType === type),
    )
    if (missing.length > 0) {
      fail(`${house.code}: NOT READY — missing ${missing.join(', ')}`)
    } else {
      ok(`${house.code}: all six required positions runtime eligible`)
    }
  }

  summarize()
}

function summarize(): void {
  console.log(
    `\n${problems.length} problem(s) across ${V3_LAUNCH_CONTENT.length} pinned versions.`,
  )
  if (problems.length > 0) {
    console.log(
      'A mismatch is fixed by creating a new governed version, never by editing a row.',
    )
  }
  void closeDb()
  if (problems.length > 0) process.exit(1)
}

await main()
