/**
 * YORÙBÁ SPEECH MEASUREMENT — one approved block, one provider call.
 *
 *   bun run scripts/measure-yoruba-block.ts <contentVersionId> [--confirm-spend]
 *
 * WHY THIS EXISTS. The prayer templates carry AUTHORED duration budgets
 * — 10, 12, 15, 32, 12, 8 seconds — written before anyone had heard the
 * Yorùbá spoken. This measures what the approved text actually takes in
 * the approved voice, one block at a time, so the question "do the
 * budgets fit real speech?" is answered with a number instead of a
 * guess.
 *
 * IT REFUSES BY DEFAULT. Without --confirm-spend it performs every
 * check and stops at the network boundary. Synthesis costs money and
 * the vendor charges by character; a measurement tool that spends on
 * being run by accident is a tool nobody should trust with a key.
 *
 * ONE CALL. EVER. There is no retry, no loop and no batch mode: a
 * 4xx or 5xx ends the run. The at-most-once discipline that protects a
 * paid appointment protects a measurement too, and a "helpful" retry
 * here is just a second charge for the same answer.
 *
 * WHAT IT WILL NOT SYNTHESIZE:
 *   - anything that is not Yorùbá;
 *   - anything whose approved voice policy is not APPROVED_TTS_ALLOWED
 *     — TEXT_ONLY and HUMAN_RECORDED_REQUIRED are refusals, not
 *     inconveniences;
 *   - anything outside the SACRED_RUNTIME domain;
 *   - anything not PUBLISHED, rights-cleared and runtime-enabled.
 *
 * WHAT IT SENDS: the approved bytes, exactly. The body is read from the
 * database, re-hashed against its own approved profile hash, and handed
 * to the adapter verbatim. No recipient name, no appointment, no
 * private note, no prompt, no instruction — there is nowhere in the
 * request for one, and this script adds nothing.
 *
 * The voice is resolved from the House the content belongs to, through
 * the same rule the executor uses. It is never chosen here.
 *
 * EVIDENCE SURVIVES FAILURE. A refused or failed call still writes a
 * machine-readable report, because a failure nobody can read is a
 * charge nobody can account for.
 */
import { createHash, randomUUID } from 'node:crypto'
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
import { computeBodySha256 } from '@/services/spiritual-content'
import { resolveHouseVoiceProfile } from '@/lib/sacred-voice-routing'
import {
  NAIJALINGO_LANGUAGE,
  createNaijalingoTtsProvider,
} from '@/providers/tts/naijalingo'
import { TtsProviderError } from '@/providers/tts/types'
import {
  measureAudioDurationFromBytes,
  probeAudioTechnicalMetadataFromBytes,
} from '@/providers/render/media-probe'
import {
  NEUTRAL_AUDIO_EXTENSION,
  VARIANCE_BAND_AMBER_MAX_PERCENT,
  VARIANCE_BAND_GREEN_MAX_PERCENT,
  audioFileExtensionFor,
  classifyDurationVariance,
} from '@/lib/speech-measurement'

const versionId = Number(process.argv[2])
const confirmSpend = process.argv.includes('--confirm-spend')
const OUT_DIR = process.env.YORUBA_MEASUREMENT_DIR ?? '/out/yoruba-measurements'

if (!Number.isInteger(versionId) || versionId <= 0) {
  console.error(
    'usage: bun run scripts/measure-yoruba-block.ts <contentVersionId> [--confirm-spend]',
  )
  process.exit(1)
}

const runId = `ya-${new Date()
  .toISOString()
  .replace(/[^0-9]/g, '')
  .slice(0, 14)}-${randomUUID().slice(0, 8)}`

/** A vendor id is not a secret, but a report is a thing people paste.
 * The fingerprint identifies WHICH voice answered without carrying it. */
function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`
}

const report: Record<string, unknown> = {
  runId,
  gitSha: process.env.APP_REVISION ?? null,
  startedAt: new Date().toISOString(),
  mode: confirmSpend ? 'PAID' : 'DRY_RUN',
  contentVersionId: versionId,
  // ALWAYS PRESENT, on every path, including a refusal that never
  // reached the network. 9jaLingo's synthesis endpoint answers
  // synchronously with audio bytes and issues no operation id, so this
  // normally stays 'not_provided' — recorded as an explicit absence,
  // because a missing key reads like an oversight and this one is a
  // finding. It is NEVER filled in from our own runId: a local
  // identifier dressed as a provider's is a fabricated audit trail.
  providerRequestId: 'not_provided',
  // Null until there is both a measured duration and an authored budget
  // to band it against. An unmeasured block is not GREEN.
  classification: null,
}

function writeReport(): void {
  report.finishedAt = new Date().toISOString()
  mkdirSync(OUT_DIR, { recursive: true })
  const path = join(OUT_DIR, `measure-${versionId}-${runId}.json`)
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\nreport written to ${path}`)
}

function fail(code: string, message: string): never {
  console.error(`\nREFUSED (${code}): ${message}`)
  report.passed = false
  report.refusalCode = code
  report.refusalMessage = message
  writeReport()
  process.exit(1)
}

const db = getDb()

// --- Authority, re-proved here rather than assumed ---------------------
const row = (
  await db
    .select({
      versionId: spiritualContentVersions.id,
      body: spiritualContentVersions.body,
      language: spiritualContentVersions.language,
      versionStatus: spiritualContentVersions.status,
      itemId: spiritualContentItems.id,
      itemCode: spiritualContentItems.code,
      contentType: spiritualContentItems.contentType,
      contentDomain: spiritualContentItems.contentDomain,
      itemActive: spiritualContentItems.active,
      houseCode: sacredHouses.code,
      houseVoice: sacredHouses.approvedVoiceProfile,
      voicePolicy: sacredContentVersionProfiles.voicePolicy,
      rightsStatus: sacredContentVersionProfiles.rightsStatus,
      accessPolicy: sacredContentVersionProfiles.accessPolicy,
      runtimeEnabled: sacredContentVersionProfiles.runtimeEnabled,
      storageAuthorized: sacredContentVersionProfiles.digitalStorageAuthorized,
      contentSha256: sacredContentVersionProfiles.contentSha256,
      durationHintSeconds: sacredContentVersionProfiles.durationHintSeconds,
    })
    .from(spiritualContentVersions)
    .innerJoin(
      spiritualContentItems,
      eq(spiritualContentItems.id, spiritualContentVersions.contentItemId),
    )
    .leftJoin(sacredHouses, eq(sacredHouses.id, spiritualContentItems.sacredHouseId))
    .innerJoin(
      sacredContentVersionProfiles,
      eq(sacredContentVersionProfiles.contentVersionId, spiritualContentVersions.id),
    )
    .where(eq(spiritualContentVersions.id, versionId))
    .limit(1)
).at(0)

if (!row) fail('content_not_found', `no content version ${versionId}`)

const bodySha = computeBodySha256(row.body)
report.content = {
  versionId: row.versionId,
  itemId: row.itemId,
  itemCode: row.itemCode,
  contentType: row.contentType,
  language: row.language,
  houseCode: row.houseCode,
  bodySha256: bodySha,
  characters: row.body.length,
  authoredBudgetSeconds: row.durationHintSeconds,
  voicePolicy: row.voicePolicy,
  rightsStatus: row.rightsStatus,
  runtimeEnabled: row.runtimeEnabled,
}

// Each of these is a refusal with its own name, so a report says WHICH
// rule stopped it rather than "not allowed".
if (row.contentDomain !== 'SACRED_RUNTIME') {
  fail('not_sacred_runtime', `domain is ${row.contentDomain}`)
}
if (!row.itemActive) fail('item_inactive', 'the content item is not active')
if (row.versionStatus !== 'PUBLISHED') {
  fail('version_not_published', `version is ${row.versionStatus}`)
}
if (row.language !== NAIJALINGO_LANGUAGE) {
  fail('language_not_yoruba', `language is ${row.language}`)
}
if (row.voicePolicy !== 'APPROVED_TTS_ALLOWED') {
  fail('voice_policy_forbids_tts', `voice policy is ${row.voicePolicy}`)
}
if (row.rightsStatus !== 'CLEARED') fail('rights_not_cleared', String(row.rightsStatus))
if (!row.runtimeEnabled) fail('runtime_disabled', 'runtime is not enabled')
if (!row.storageAuthorized) {
  fail('storage_not_authorized', 'digital storage is not authorized')
}
if (row.contentSha256 !== bodySha) {
  fail('body_hash_mismatch', 'the stored body does not match its approved hash')
}

// --- The voice, from the House, by the same rule the executor uses ----
const voice = resolveHouseVoiceProfile({
  code: row.houseCode,
  approvedVoiceProfile: row.houseVoice,
})
if (!voice.ok) fail(voice.reasonCode, `no approved voice for ${row.houseCode}`)
const configuredVoiceId =
  voice.profile === 'YO_MALE'
    ? env.NAIJALINGO_YO_MALE_VOICE_ID
    : env.NAIJALINGO_YO_FEMALE_VOICE_ID
if (configuredVoiceId.trim().length === 0) {
  fail('voice_not_configured', `no configured voice for ${voice.profile}`)
}

report.voice = {
  logicalKey: voice.profile,
  configuredVoiceFingerprint: fingerprint(configuredVoiceId),
  model: env.NAIJALINGO_MODEL,
  apiBase: env.NAIJALINGO_API_BASE_URL,
}

console.log(`YORÙBÁ BLOCK MEASUREMENT  runId ${runId}`)
console.log(`  content        v${row.versionId} ${row.itemCode} (${row.contentType})`)
console.log(`  house / voice  ${row.houseCode} -> ${voice.profile}`)
console.log(`  voice id       ${fingerprint(configuredVoiceId)}`)
console.log(`  model          ${env.NAIJALINGO_MODEL}`)
console.log(`  body sha256    ${bodySha}`)
console.log(`  characters     ${row.body.length}`)
console.log(`  budget         ${row.durationHintSeconds} s (authored)`)

if (!confirmSpend) {
  report.passed = true
  report.audioProduced = false
  report.note =
    'DRY RUN — every governance check passed. No provider was contacted and nothing was spent.'
  writeReport()
  console.log('\nDRY RUN. No provider contacted, nothing spent.')
  console.log('Re-run with --confirm-spend to make exactly ONE paid call.')
  await closeDb()
  process.exit(0)
}

// --- ONE call. No retry, no loop. --------------------------------------
if (env.TTS_DRIVER !== '9JALINGO') {
  fail('tts_driver_not_selected', `TTS_DRIVER is ${env.TTS_DRIVER}`)
}

const provider = createNaijalingoTtsProvider()
report.requestedAt = new Date().toISOString()
const startedMs = Date.now()
let submission
try {
  submission = await provider.submitSpeech({
    idempotencyKey: createHash('sha256')
      .update(`ya-measure|${row.versionId}|${bodySha}|${runId}`, 'utf8')
      .digest('hex'),
    requirementId: `ya-measure-${row.versionId}`,
    sceneId: `ya-measure-${row.contentType}`,
    // THE APPROVED BYTES, VERBATIM.
    approvedText: row.body,
    language: NAIJALINGO_LANGUAGE,
    voiceProfile: voice.profile,
    voicePolicy: 'APPROVED_TTS_ALLOWED',
    targetDurationMs: (row.durationHintSeconds ?? 0) * 1000,
  })
} catch (caught) {
  const error = caught instanceof TtsProviderError ? caught : null
  report.passed = false
  report.audioProduced = false
  report.providerErrorCode = error?.code ?? 'unknown'
  report.providerRetryable = error?.retryable ?? null
  report.latencyMs = Date.now() - startedMs
  report.note =
    'One call was made and failed. NOT retried — a retry is a second charge for the same answer.'
  writeReport()
  console.error(`\nprovider call failed: ${error?.code ?? 'unknown'}`)
  console.error('NOT retried.')
  await closeDb()
  process.exit(1)
}
const latencyMs = Date.now() - startedMs

if (submission.status !== 'COMPLETED' || !submission.artifact) {
  report.passed = false
  report.audioProduced = false
  report.submissionStatus = submission.status
  // If this provider ever DOES answer asynchronously, the operation id
  // it issued is real, and a real one is preserved. This is the only
  // place the field is ever written to something other than the honest
  // 'not_provided' it starts as.
  if (submission.status === 'PENDING') {
    report.providerRequestId = submission.providerJobId
  }
  report.latencyMs = latencyMs
  writeReport()
  console.error('\nno artifact returned')
  await closeDb()
  process.exit(1)
}

// --- Measure the BYTES, not the provider's claim about them ------------
const bytes = submission.artifact.bytes
const audioSha = createHash('sha256').update(bytes).digest('hex')
// ffprobe on the ACTUAL bytes. The provider's own claim about its own
// output is not evidence about what is in the file.
const measured = await measureAudioDurationFromBytes({
  bytes,
  sha256: audioSha,
  mimeType: submission.artifact.mimeType,
})
if (!measured.ok) {
  report.passed = false
  report.audioProduced = true
  report.audio = {
    sha256: audioSha,
    byteSize: bytes.length,
    mimeType: submission.artifact.mimeType,
    providerReportedDurationMs: submission.artifact.durationMs,
  }
  report.measurementFailure = measured.reasonCode
  report.latencyMs = latencyMs
  writeReport()
  console.error(`
audio could not be measured: ${measured.reasonCode}`)
  await closeDb()
  process.exit(1)
}
const measuredMs = measured.durationMs
const budgetMs = (row.durationHintSeconds ?? 0) * 1000
const deltaMs = measuredMs - budgetMs
// Rounded ONCE, here, and the band below is derived from this exact
// value. If the classifier judged a raw number while the report printed
// a rounded one, a report could read "15.0% — AMBER" and look like a
// defect to the person holding it.
const deltaPercent =
  budgetMs > 0 ? Number(((deltaMs / budgetMs) * 100).toFixed(1)) : null
const classification = classifyDurationVariance(deltaPercent)

// --- The technical shape of what actually came back --------------------
// A second read of the same bytes, for codec, sample rate and channel
// count. It is NOT permitted to fail the measurement: the duration is
// the finding, and discarding a paid answer because a codec name would
// not parse is a poor trade. A failure is recorded by name instead.
const technical = await probeAudioTechnicalMetadataFromBytes({
  bytes,
  mimeType: submission.artifact.mimeType,
})

// --- Name the evidence after what it IS, not what we expected ----------
// The provider returns WAV today. Hard-coding `.wav` would make that
// expectation permanent and, on the day it stopped being true, would
// write a false claim about the bytes into the filename.
const extension = audioFileExtensionFor(submission.artifact.mimeType)
const audioExtension = extension.ok ? extension.extension : NEUTRAL_AUDIO_EXTENSION
mkdirSync(OUT_DIR, { recursive: true })
const audioPath = join(
  OUT_DIR,
  `block-${row.versionId}-${runId}.${audioExtension}`,
)
writeFileSync(audioPath, bytes)

report.passed = true
report.audioProduced = true
report.latencyMs = latencyMs
report.classification = classification
// The report carries the thresholds it was judged by, so it can be
// re-checked by hand without anyone having to find the document that
// locked them.
report.classificationThresholds = {
  greenMaxAbsolutePercent: VARIANCE_BAND_GREEN_MAX_PERCENT,
  amberMaxAbsolutePercent: VARIANCE_BAND_AMBER_MAX_PERCENT,
}
report.audio = {
  sha256: audioSha,
  byteSize: bytes.length,
  mimeType: submission.artifact.mimeType,
  fileExtension: audioExtension,
  fileExtensionReasonCode: extension.ok ? null : extension.reasonCode,
  codec: technical.ok ? technical.metadata.codec : null,
  sampleRate: technical.ok ? technical.metadata.sampleRate : null,
  channels: technical.ok ? technical.metadata.channels : null,
  technicalProbeFailure: technical.ok ? null : technical.reasonCode,
  providerReportedDurationMs: submission.artifact.durationMs,
  measuredDurationMs: measuredMs,
  path: audioPath,
}
report.timing = {
  authoredBudgetMs: budgetMs,
  measuredMs,
  deltaMs,
  deltaPercent,
  charactersPerSecond:
    measuredMs > 0 ? Number((row.body.length / (measuredMs / 1000)).toFixed(2)) : null,
}
writeReport()

console.log(`\n  measured duration  ${measuredMs} ms`)
console.log(`  authored budget    ${budgetMs} ms`)
console.log(
  `  delta              ${deltaMs >= 0 ? '+' : ''}${deltaMs} ms (${deltaPercent === null ? 'n/a' : `${deltaPercent}%`})`,
)
console.log(`  classification     ${classification ?? 'UNCLASSIFIED (no authored budget)'}`)
console.log(`  audio sha256       ${audioSha}`)
console.log(`  bytes              ${bytes.length}`)
console.log(
  `  codec / rate / ch  ${technical.ok ? `${technical.metadata.codec} / ${technical.metadata.sampleRate ?? 'unknown'} Hz / ${technical.metadata.channels ?? 'unknown'}` : `unavailable (${technical.reasonCode})`}`,
)
console.log(`  provider requestId ${String(report.providerRequestId)}`)
console.log(`  latency            ${latencyMs} ms`)
console.log(`  audio written      ${audioPath}`)
console.log('\nONE call was made. Nothing was retried.')

await closeDb()
process.exit(0)
