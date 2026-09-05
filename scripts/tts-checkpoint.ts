/**
 * FIRST REAL SYNTHESIS CHECKPOINT — a governed, auditable paid run.
 *
 *   bun run scripts/tts-checkpoint.ts                 # dry run, no spend
 *   bun run scripts/tts-checkpoint.ts --confirm-spend # TWO paid calls
 *
 * WHY A SCRIPT AND NOT A TEST. This spends real money on a real
 * provider, so it must be reviewable BEFORE it runs and it must refuse
 * by default. The dry run performs every check and stops at the network
 * boundary; the paid run is identical up to that point and then makes
 * exactly one call per clip. Nothing here loops, retries, or falls back.
 *
 * WHAT IT PROVES, per clip, in this order and before any network:
 *
 *   Sacred House code
 *     → approved voice profile        (the real routing rule)
 *     → configured provider voice     (fingerprinted, never printed)
 *     → pinned model 9jalingo-tts-1
 *     → the exact approved Yoruba body, hash-matched three ways
 *
 * WHAT IT REFUSES TO CARRY. There is no recipient, no appointment, no
 * private note, no English companion, no translation, no rewriting, no
 * reference audio and no fallback voice. The allowed content is an
 * explicit two-item list below; anything else is not synthesizable by
 * this script at all.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'

import { closeDb, getDb } from '@/db'
import {
  sacredContentVersionProfiles,
  sacredHouses,
  spiritualContentItems,
  spiritualContentVersions,
} from '@/db/schema'
import { env } from '@/lib/env'
import { V3_LAUNCH_CONTENT } from '@/lib/launch-content-v3'
import { resolveHouseVoiceProfile } from '@/lib/sacred-voice-routing'
import {
  NAIJALINGO_CLIENT_LIMITS,
  NAIJALINGO_LANGUAGE,
  createNaijalingoTtsProvider,
  parseWavDurationMs,
} from '@/providers/tts/naijalingo'
import { computeBodySha256 } from '@/services/spiritual-content'
import { TtsProviderError } from '@/providers/tts/types'
import type { SacredVoiceProfile } from '@/lib/sacred-voice-routing'

/**
 * THE ONLY CONTENT THIS SCRIPT MAY SPEAK. Two clips, one per voice, so
 * both provider voices are proven before anything is spent on complete
 * six-block sessions. Named by House code and content type — never by
 * database id, and never by a document's House numbering.
 */
const AUTHORIZED = [
  { houseCode: 'ILE_AWON_BABALAWO', contentType: 'OPENING', expect: 'YO_MALE' },
  { houseCode: 'ABULE_OSUN', contentType: 'OPENING', expect: 'YO_FEMALE' },
] as const satisfies ReadonlyArray<{
  houseCode: string
  contentType: string
  expect: SacredVoiceProfile
}>

const OUT_DIR = join(process.cwd(), 'var', 'tts-checkpoint')
const PINNED_MODEL = '9jalingo-tts-1'
const spend = process.argv.includes('--confirm-spend')

/** A vendor id is not a secret, but it is not this report's business
 * either. A stable fingerprint proves WHICH voice answered without
 * putting the id in a log somebody later pastes. */
function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`
}

function fail(message: string): never {
  console.error(`\nREFUSED — ${message}`)
  console.error('Nothing was synthesized and nothing was spent.')
  process.exit(1)
}

interface Prepared {
  houseCode: string
  houseId: number
  itemCode: string
  itemId: number
  versionId: number
  contentType: string
  language: string
  body: string
  bodySha256: string
  storedSha256: string
  manifestSha256: string
  voiceProfile: SacredVoiceProfile
  voiceId: string
  targetDurationMs: number
}

async function prepare(
  authorized: (typeof AUTHORIZED)[number],
): Promise<Prepared> {
  const manifest = V3_LAUNCH_CONTENT.find(
    (entry) =>
      entry.houseCode === authorized.houseCode &&
      entry.contentType === authorized.contentType &&
      entry.language === 'yo',
  )
  if (!manifest) {
    fail(`no locked V3 Yoruba ${authorized.contentType} for ${authorized.houseCode}`)
  }

  const row = (
    await getDb()
      .select({
        itemId: spiritualContentItems.id,
        itemCode: spiritualContentItems.code,
        itemDomain: spiritualContentItems.contentDomain,
        itemType: spiritualContentItems.contentType,
        itemActive: spiritualContentItems.active,
        itemScope: spiritualContentItems.scopeType,
        houseId: sacredHouses.id,
        houseCode: sacredHouses.code,
        houseVoice: sacredHouses.approvedVoiceProfile,
        versionId: spiritualContentVersions.id,
        versionStatus: spiritualContentVersions.status,
        versionLanguage: spiritualContentVersions.language,
        body: spiritualContentVersions.body,
        storedSha256: sacredContentVersionProfiles.contentSha256,
        voicePolicy: sacredContentVersionProfiles.voicePolicy,
        rightsStatus: sacredContentVersionProfiles.rightsStatus,
        accessPolicy: sacredContentVersionProfiles.accessPolicy,
        runtimeEnabled: sacredContentVersionProfiles.runtimeEnabled,
        storageAuthorized: sacredContentVersionProfiles.digitalStorageAuthorized,
        durationHintSeconds: sacredContentVersionProfiles.durationHintSeconds,
      })
      .from(spiritualContentVersions)
      .innerJoin(
        spiritualContentItems,
        eq(spiritualContentItems.id, spiritualContentVersions.contentItemId),
      )
      .innerJoin(sacredHouses, eq(sacredHouses.id, spiritualContentItems.sacredHouseId))
      .innerJoin(
        sacredContentVersionProfiles,
        eq(sacredContentVersionProfiles.contentVersionId, spiritualContentVersions.id),
      )
      .where(eq(spiritualContentVersions.id, manifest.versionId))
      .limit(1)
  ).at(0)
  if (!row) fail(`version ${manifest.versionId} is not in this database`)

  // Governance, re-proved here rather than assumed from the manifest.
  const checks: Array<[string, boolean]> = [
    ['content domain is SACRED_RUNTIME', row.itemDomain === 'SACRED_RUNTIME'],
    ['item is active', row.itemActive],
    ['item is House-scoped', row.itemScope === 'SACRED_HOUSE'],
    ['House code matches the manifest', row.houseCode === manifest.houseCode],
    ['content type matches the manifest', row.itemType === manifest.contentType],
    ['version is PUBLISHED', row.versionStatus === 'PUBLISHED'],
    ['language is Yoruba', row.versionLanguage === NAIJALINGO_LANGUAGE],
    ['voice policy is APPROVED_TTS_ALLOWED', row.voicePolicy === 'APPROVED_TTS_ALLOWED'],
    ['rights are CLEARED', row.rightsStatus === 'CLEARED'],
    ['access is PRAYER_ROOM_PRIVATE', row.accessPolicy === 'PRAYER_ROOM_PRIVATE'],
    ['runtime enabled', row.runtimeEnabled],
    ['digital storage authorized', row.storageAuthorized],
  ]
  for (const [label, ok] of checks) {
    if (!ok) fail(`${manifest.houseCode} ${manifest.contentType}: ${label} — not true`)
  }

  // THE TEXT IS THE TEXT. Three independent authorities must agree:
  // the body as stored, the hash recorded on its approved profile, and
  // the hash computed from the locked V3 source document.
  const bodySha256 = computeBodySha256(row.body)
  if (row.storedSha256 !== bodySha256) {
    fail(`${manifest.houseCode} ${manifest.contentType}: stored body does not match its approved hash`)
  }
  if (manifest.sha256 !== bodySha256) {
    fail(`${manifest.houseCode} ${manifest.contentType}: body does not match the locked V3 document`)
  }

  // The real routing rule — the same function the executor calls.
  const voice = resolveHouseVoiceProfile({
    code: row.houseCode,
    approvedVoiceProfile: row.houseVoice,
  })
  if (!voice.ok) fail(`${row.houseCode}: ${voice.reasonCode}`)
  if (voice.profile !== authorized.expect) {
    fail(`${row.houseCode}: routed ${voice.profile}, this checkpoint expects ${authorized.expect}`)
  }

  const voiceId =
    voice.profile === 'YO_MALE'
      ? env.NAIJALINGO_YO_MALE_VOICE_ID
      : env.NAIJALINGO_YO_FEMALE_VOICE_ID
  if (voiceId.trim().length === 0) fail(`no configured voice for ${voice.profile}`)

  return {
    houseCode: row.houseCode,
    houseId: row.houseId,
    itemCode: row.itemCode,
    itemId: row.itemId,
    versionId: row.versionId,
    contentType: row.itemType,
    language: row.versionLanguage,
    body: row.body,
    bodySha256,
    storedSha256: row.storedSha256 ?? '',
    manifestSha256: manifest.sha256,
    voiceProfile: voice.profile,
    voiceId,
    targetDurationMs: (row.durationHintSeconds ?? manifest.durationHintSeconds) * 1000,
  }
}

function report(prepared: Prepared): void {
  console.log(`\n── ${prepared.houseCode} · ${prepared.contentType} ──`)
  console.log(`  House code ................ ${prepared.houseCode} (id ${prepared.houseId})`)
  console.log(`  Content item .............. ${prepared.itemCode} (id ${prepared.itemId})`)
  console.log(`  Content version ........... ${prepared.versionId}`)
  console.log(`  Language .................. ${prepared.language}`)
  console.log(`  Voice profile ............. ${prepared.voiceProfile}`)
  console.log(`  Provider voice ............ ${fingerprint(prepared.voiceId)}`)
  console.log(`  Model ..................... ${env.NAIJALINGO_MODEL}`)
  console.log(`  Body SHA-256 (submitted) .. ${prepared.bodySha256}`)
  console.log(`  Body SHA-256 (stored) ..... ${prepared.storedSha256}`)
  console.log(`  Body SHA-256 (V3 locked) .. ${prepared.manifestSha256}`)
  console.log(`  Characters ................ ${prepared.body.length}`)
  console.log(`  Duration budget ........... ${prepared.targetDurationMs} ms (a BUDGET, not a measurement)`)
}

async function main(): Promise<void> {
  console.log('First real synthesis checkpoint — two clips, one per approved voice.')
  console.log(spend ? 'MODE: PAID RUN (--confirm-spend)' : 'MODE: DRY RUN — stops at the network boundary')

  if (env.NAIJALINGO_MODEL !== PINNED_MODEL) {
    fail(`model is ${env.NAIJALINGO_MODEL || '(unset)'}, this checkpoint is pinned to ${PINNED_MODEL}`)
  }
  if (spend && env.TTS_DRIVER !== '9JALINGO') {
    fail('TTS_DRIVER is not 9JALINGO in this process — a paid run must be deliberate')
  }
  console.log(`  TTS_DRIVER (this process) . ${env.TTS_DRIVER}`)
  console.log(`  Transport retries .......... ${NAIJALINGO_CLIENT_LIMITS.maxRetries}`)
  if (NAIJALINGO_CLIENT_LIMITS.maxRetries !== 0) {
    fail('transport retries are not zero — a retried synthesis is a second spend')
  }

  const prepared: Array<Prepared> = []
  for (const authorized of AUTHORIZED) {
    const one = await prepare(authorized)
    report(one)
    prepared.push(one)
  }

  // Two clips, two DIFFERENT voices. If the deployment had the same id
  // configured twice, both prayers would arrive in one voice and the
  // report above would still look correct.
  const voices = new Set(prepared.map((p) => p.voiceId))
  if (voices.size !== prepared.length) {
    fail('the two profiles resolve to the SAME provider voice')
  }

  if (!spend) {
    console.log('\nDry run complete. Every check above passed.')
    console.log('No provider was contacted. Nothing was synthesized or spent.')
    console.log('Re-run with --confirm-spend to make exactly two paid calls.')
    return
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const provider = createNaijalingoTtsProvider()
  console.log(`\nProvider: ${provider.code} — ${provider.displayName}`)

  for (const one of prepared) {
    // ONE call. No loop, no retry, no catch-and-try-again.
    const startedAt = Date.now()
    let submission
    try {
      submission = await provider.submitSpeech({
        idempotencyKey: createHash('sha256')
          .update(`checkpoint|${one.versionId}|${one.bodySha256}`, 'utf8')
          .digest('hex'),
        requirementId: `checkpoint-${one.houseCode}-${one.contentType}`,
        sceneId: `checkpoint-${one.contentType}`,
        approvedText: one.body,
        language: one.language,
        voiceProfile: one.voiceProfile,
        voicePolicy: 'APPROVED_TTS_ALLOWED',
        targetDurationMs: one.targetDurationMs,
      })
    } catch (caught) {
      const error = caught instanceof TtsProviderError ? caught : null
      console.log(`\n── ${one.houseCode} · ${one.contentType} — FAILED`)
      console.log(`  Error code ................ ${error?.code ?? 'unknown'}`)
      console.log(`  Retryable ................. ${error?.retryable ?? 'unknown'}`)
      console.log(`  Adapter submissions ....... 1`)
      console.log('  NOT retried. The remaining clip is skipped.')
      process.exitCode = 1
      return
    }
    const elapsedMs = Date.now() - startedAt

    console.log(`\n── ${one.houseCode} · ${one.contentType} — RESULT`)
    console.log(`  Submission status ......... ${submission.status}`)
    // 9jaLingo is synchronous: bytes come back in the response, so no
    // provider job id or operation id exists to record. The adapter
    // never invents one.
    console.log(
      `  Provider job id ........... ${
        'providerJobId' in submission
          ? submission.providerJobId
          : '(synchronous — none issued)'
      }`,
    )
    console.log(`  Wall clock ................ ${elapsedMs} ms`)
    console.log(`  Adapter submissions ....... 1`)
    console.log(`  Transport retries ......... ${NAIJALINGO_CLIENT_LIMITS.maxRetries}`)

    if (submission.status !== 'COMPLETED' || !submission.artifact) {
      console.log('  No artifact returned — nothing written.')
      process.exitCode = 1
      continue
    }
    const artifact = submission.artifact
    const bytes = artifact.bytes
    const artifactSha256 = createHash('sha256').update(bytes).digest('hex')
    const measuredMs = parseWavDurationMs(bytes)
    const file = join(
      OUT_DIR,
      `${one.houseCode.toLowerCase()}-${one.contentType.toLowerCase()}-${one.voiceProfile.toLowerCase()}.wav`,
    )
    writeFileSync(file, bytes)

    console.log(`  Audio format .............. ${artifact.mimeType}`)
    console.log(`  Artifact bytes ............ ${bytes.length}`)
    console.log(`  Artifact SHA-256 .......... ${artifactSha256}`)
    console.log(`  Measured duration ......... ${artifact.durationMs} ms (adapter)`)
    console.log(`  Measured duration ......... ${measuredMs ?? 'unreadable'} ms (re-read from the bytes)`)
    console.log(`  Against budget ............ ${one.targetDurationMs} ms`)
    console.log(`  Written ................... ${file}`)
  }

  console.log('\nTwo clips only. Nothing else was synthesized.')
  console.log('Listen to both before anything further is authorized.')
}

try {
  await main()
} finally {
  await closeDb()
}
