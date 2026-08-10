import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  GUIDANCE_LANGUAGES,
  SACRED_RUNTIME_CONTENT_TYPES,
  sacredContentVersionProfiles,
  spiritualContentItems,
  spiritualContentVersions,
} from '@/db/schema'
import {
  computeFileSha256,
  getMediaStorage,
  isValidStorageKey,
} from '@/providers/media/storage'
import { getTtsProvider, resolveTtsProvider } from '@/providers/tts/registry'
import { TtsProviderError } from '@/providers/tts/types'
import { resolveSacredAudioCandidates } from './media-assets'
import { isSacredVersionRuntimeEligible } from './sacred-content'
import { isLanguageCompatible, isScopeApplicable } from './video-recipes'
import type { SpeechArtifact, SpeechSynthesisRequest } from '@/providers/tts/types'
import type { ManifestAudioRequirement } from './generation-storyboards'
import type {
  AudioTaskPollResult,
  AudioTaskSubmissionResult,
} from './generation-jobs'

/**
 * Audio generation EXECUTOR service (Phase One, Step 15).
 *
 * ```text
 * ManifestAudioRequirement (Step 13, body-free structured intent)
 * → EXISTING_HUMAN_AUDIO: resolved and RE-VERIFIED in place, never
 *   synthesized — the exact media version/hash Step 13 selected, still
 *   currently authorized, still byte-intact in private storage
 * → TTS_PENDING: re-verified against CURRENT authority (runtime
 *   eligibility, content hash currency, language, and an AUTHORITATIVE
 *   APPROVED_TTS_ALLOWED voice policy), then the EXACT approved body is
 *   retrieved server-side and compiled into an in-memory request
 * → provider-neutral submit/poll (mock only — no real provider exists yet)
 * → verified artifact (mime/type, bounded duration, non-empty, fresh SHA-256)
 * → private storage (LocalMediaStorageProvider — no S3)
 * → re-verified against that storage before the job is ever allowed to
 *   leave GENERATING_AUDIO (`verifyStoredAudioArtifact`)
 * ```
 *
 * This module owns EXECUTION only — `submitSpeech`/`pollSpeech` are
 * pure functions of a `ManifestAudioRequirement` (plus, for polling, an
 * opaque provider operation id): no DB row for the task itself is read
 * or written here. That lifecycle (PENDING/SUBMITTED/PROCESSING/
 * SUCCEEDED/FAILED/CANCELLED, keyed by job + manifest snapshot + the
 * manifest's own requirementId, with lease/retry/finalization) belongs
 * to `runAudioGenerationOnce` in `src/services/generation-jobs.ts`,
 * which injects these two functions as its
 * `AudioGenerationDependencies`.
 *
 * PRIVACY: the approved body enters memory ONLY inside
 * `compileSpeechSynthesisRequest` and only for the single submission
 * that immediately follows. It is never returned to the caller, never
 * written to a row or an event, never logged, and never folded into an
 * artifact seed. Failures surface fixed machine codes, never provider
 * strings or content.
 */

// --- Identity ---------------------------------------------------------------

/**
 * Deterministic provider-submission dedup key for ONE audio
 * requirement. Derived from manifest authority alone (job + the
 * manifest's own hash + the requirement id) — no clock, no randomness —
 * so the SAME requirement under the SAME manifest always maps to the
 * SAME provider job, and a re-claimed or re-run job can never pay for a
 * second synthesis of the same speech.
 */
export function computeAudioTaskIdempotencyKey(input: {
  generationJobId: number
  manifestSha256: string
  requirementId: string
}): string {
  return createHash('sha256')
    .update(
      `audio-task-v1|${input.generationJobId}|${input.manifestSha256}|${input.requirementId}`,
      'utf8',
    )
    .digest('hex')
}

// --- Artifact rules ---------------------------------------------------------

/** The mock emits exactly one type today; a future real provider adds
 * to this allowlist, never bypasses it. Kept in step with the AUDIO row
 * of MEDIA_MIME_TYPES — speech artifacts live in the same private
 * store as approved media and obey the same bounded, non-executable
 * type discipline. */
const SPEECH_MIME_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
}

/** The SAME allowlist, re-checkable later against a PERSISTED mime type
 * — an artifact whose type was allowlisted at storage time must still
 * be allowlisted when its result is finally accepted. */
export function isAllowedSpeechMimeType(mimeType: string): boolean {
  return Object.hasOwn(SPEECH_MIME_EXTENSIONS, mimeType)
}

/** Loud bounded ceiling for ONE synthesized segment — never a silent
 * truncation, and never a licence for an unbounded provider result. */
export const MAX_SPEECH_MS = 15 * 60 * 1000

const SPEECH_HEX64 = /^[0-9a-f]{64}$/

// --- Governance: TTS request compilation ------------------------------------

/** Bounded, safe failure shapes — reasonCode is always a fixed machine
 * code, never a raw error/provider string that could echo content. */
export type CompiledSpeechSynthesisRequest =
  | { status: 'OK'; request: SpeechSynthesisRequest }
  | { status: 'FAILED'; reasonCode: string }

/** The ONLY voice policy under which sacred text may ever be spoken by
 * a machine. HUMAN_RECORDED_REQUIRED and TEXT_ONLY are not "not yet
 * supported" — they are refusals, and they fail closed here. */
const TTS_PERMITTED_VOICE_POLICY = 'APPROVED_TTS_ALLOWED'

/**
 * Loads the sacred version WITH its body and its authoritative runtime
 * profile. Used ONLY on the TTS path, immediately before a submission,
 * after which the body either enters the in-memory request or is
 * discarded.
 */
async function loadSacredSpeechSource(contentVersionId: number) {
  return (
    await getDb()
      .select({
        itemContentDomain: spiritualContentItems.contentDomain,
        itemContentType: spiritualContentItems.contentType,
        itemActive: spiritualContentItems.active,
        versionStatus: spiritualContentVersions.status,
        versionLanguage: spiritualContentVersions.language,
        versionBody: spiritualContentVersions.body,
        profileDigitalStorageAuthorized:
          sacredContentVersionProfiles.digitalStorageAuthorized,
        profileRightsStatus: sacredContentVersionProfiles.rightsStatus,
        profileAccessPolicy: sacredContentVersionProfiles.accessPolicy,
        profileRuntimeEnabled: sacredContentVersionProfiles.runtimeEnabled,
        profileContentSha256: sacredContentVersionProfiles.contentSha256,
        profileVoicePolicy: sacredContentVersionProfiles.voicePolicy,
      })
      .from(spiritualContentVersions)
      .innerJoin(
        spiritualContentItems,
        eq(spiritualContentItems.id, spiritualContentVersions.contentItemId),
      )
      .leftJoin(
        sacredContentVersionProfiles,
        eq(
          sacredContentVersionProfiles.contentVersionId,
          spiritualContentVersions.id,
        ),
      )
      .where(eq(spiritualContentVersions.id, contentVersionId))
      .limit(1)
  ).at(0)
}

/**
 * Re-verifies ONE TTS_PENDING requirement against CURRENT authority and
 * compiles the provider request in memory, IMMEDIATELY before the
 * submission it is built for.
 *
 * Everything here is a re-proof, not a lookup of an earlier decision:
 * the manifest froze a plan, but a rights withdrawal, a runtime
 * disable, an edited body or a voice-policy change since then must all
 * stop the synthesis. In particular the voice policy is read from the
 * AUTHORITATIVE Step 8 sacred profile and must BOTH be
 * APPROVED_TTS_ALLOWED right now AND still match what the manifest
 * snapshotted — a caller cannot downgrade HUMAN_RECORDED_REQUIRED or
 * TEXT_ONLY into a synthesis, and a policy that changed under a frozen
 * plan fails closed rather than proceeding on the stale value.
 *
 * The approved body is retrieved only after every one of those checks
 * passes, is placed verbatim into the in-memory request, and is never
 * rewritten, translated, summarized or extended.
 */
export async function compileSpeechSynthesisRequest(
  requirement: ManifestAudioRequirement,
  idempotencyKey: string,
): Promise<CompiledSpeechSynthesisRequest> {
  // `requirement` ultimately traces back to JSON.parse of a persisted
  // manifest row, asserted to its type with NO field-by-field runtime
  // validation at that boundary — a tampered row with a recomputed
  // checksum can carry any shape here regardless of what the static
  // type claims. These are this function's own trust-boundary guards.
  if (requirement.mode !== 'TTS_PENDING') {
    return { status: 'FAILED', reasonCode: 'not_a_tts_requirement' }
  }
  const contentVersionId = requirement.contentVersionId
  if (
    contentVersionId == null ||
    requirement.contentSha256 == null ||
    requirement.language == null ||
    requirement.voicePolicy == null ||
    requirement.requirementId == null
  ) {
    return { status: 'FAILED', reasonCode: 'incomplete_audio_requirement' }
  }
  // The SNAPSHOTTED policy must itself be the permitted one — a
  // requirement that was never TTS-authorized is never synthesized,
  // whatever the row says today.
  if (requirement.voicePolicy !== TTS_PERMITTED_VOICE_POLICY) {
    return { status: 'FAILED', reasonCode: 'voice_policy_forbids_tts' }
  }

  const row = await loadSacredSpeechSource(contentVersionId)
  if (!row) return { status: 'FAILED', reasonCode: 'sacred_content_missing' }
  if (
    row.itemContentDomain !== 'SACRED_RUNTIME' ||
    !(SACRED_RUNTIME_CONTENT_TYPES as ReadonlyArray<string>).includes(
      row.itemContentType,
    )
  ) {
    return { status: 'FAILED', reasonCode: 'wrong_content_domain' }
  }
  // The canonical Step 8 formula, including its body-vs-hash integrity
  // check — never a second, looser re-implementation here.
  const evaluated = isSacredVersionRuntimeEligible({
    item: {
      contentDomain: row.itemContentDomain,
      contentType: row.itemContentType,
      active: row.itemActive,
    },
    version: {
      status: row.versionStatus,
      language: row.versionLanguage,
      body: row.versionBody,
    },
    profile:
      row.profileRightsStatus == null
        ? null
        : {
            digitalStorageAuthorized:
              row.profileDigitalStorageAuthorized ?? false,
            rightsStatus: row.profileRightsStatus,
            accessPolicy: row.profileAccessPolicy ?? '',
            runtimeEnabled: row.profileRuntimeEnabled ?? false,
            contentSha256: row.profileContentSha256,
          },
  })
  if (!evaluated.eligible) {
    return { status: 'FAILED', reasonCode: 'sacred_content_ineligible' }
  }
  // CURRENT authoritative voice policy — the decisive check.
  if (row.profileVoicePolicy !== TTS_PERMITTED_VOICE_POLICY) {
    return { status: 'FAILED', reasonCode: 'voice_policy_forbids_tts' }
  }
  if (row.profileContentSha256 !== requirement.contentSha256) {
    return { status: 'FAILED', reasonCode: 'sacred_content_hash_changed' }
  }
  // Speak the approved body in ITS OWN language — never a translation.
  if (
    row.versionLanguage !== requirement.language ||
    !(GUIDANCE_LANGUAGES as ReadonlyArray<string>).includes(row.versionLanguage)
  ) {
    return { status: 'FAILED', reasonCode: 'language_changed' }
  }

  const targetDurationMs = requirement.endMs - requirement.startMs
  if (targetDurationMs <= 0 || targetDurationMs > MAX_SPEECH_MS) {
    return { status: 'FAILED', reasonCode: 'audio_window_invalid' }
  }

  return {
    status: 'OK',
    request: {
      idempotencyKey,
      requirementId: requirement.requirementId,
      sceneId: requirement.sceneId,
      // EXACT approved text — verbatim, nothing added, nothing removed.
      approvedText: row.versionBody,
      language: row.versionLanguage,
      voicePolicy: TTS_PERMITTED_VOICE_POLICY,
      targetDurationMs,
    },
  }
}

// --- Governance: existing human audio ---------------------------------------

export type HumanAudioVerification =
  | { ok: true; mediaAssetVersionId: number; fileSha256: string }
  | { ok: false; reasonCode: string }

/**
 * Re-proves ONE EXISTING_HUMAN_AUDIO requirement. NOTHING is
 * synthesized on this path and no provider task is ever created: an
 * approved human recording of sacred text is used exactly as approved
 * or not at all.
 *
 * Proves, against CURRENT authority:
 * - the sacred version still authorizes a human recording (its
 *   authoritative voice policy is still what the manifest snapshotted
 *   and is not TEXT_ONLY);
 * - the EXACT media version Step 13 selected is STILL a current
 *   eligible linked audio candidate for that sacred version — removing
 *   the governing link, withdrawing rights, disabling runtime or
 *   revoking consent all invalidate it immediately (the shared
 *   resolveSacredAudioCandidates rule, never a looser copy);
 * - it is still applicable to THIS Service/House and language;
 * - its frozen hash still matches the version row's hash; and
 * - the private stored object still exists and its bytes still hash to
 *   that same frozen value.
 */
export async function verifyExistingHumanAudio(
  requirement: ManifestAudioRequirement,
  context: { serviceId: number; sacredHouseId: number; language: string },
): Promise<HumanAudioVerification> {
  if (requirement.mode !== 'EXISTING_HUMAN_AUDIO') {
    return { ok: false, reasonCode: 'not_a_human_audio_requirement' }
  }
  const mediaAssetVersionId = requirement.mediaAssetVersionId
  const fileSha256 = requirement.fileSha256
  const contentVersionId = requirement.contentVersionId
  if (
    mediaAssetVersionId == null ||
    fileSha256 == null ||
    !SPEECH_HEX64.test(fileSha256) ||
    contentVersionId == null ||
    requirement.voicePolicy == null
  ) {
    return { ok: false, reasonCode: 'incomplete_audio_requirement' }
  }

  let resolved
  try {
    resolved = await resolveSacredAudioCandidates(contentVersionId)
  } catch {
    return { ok: false, reasonCode: 'audio_unresolvable' }
  }
  if (resolved.voicePolicy !== requirement.voicePolicy) {
    return { ok: false, reasonCode: 'voice_policy_changed' }
  }
  if (resolved.voicePolicy === 'TEXT_ONLY') {
    return { ok: false, reasonCode: 'voice_policy_forbids_audio' }
  }
  const candidate = resolved.candidates.find(
    (entry) => entry.mediaAssetVersionId === mediaAssetVersionId,
  )
  if (!candidate) return { ok: false, reasonCode: 'audio_no_longer_linked' }
  if (candidate.fileSha256 !== fileSha256) {
    return { ok: false, reasonCode: 'audio_hash_changed' }
  }
  if (
    !isScopeApplicable(
      {
        scopeType: candidate.scopeType,
        serviceId: candidate.scopeServiceId,
        sacredHouseId: candidate.scopeSacredHouseId,
      },
      context,
    )
  ) {
    return { ok: false, reasonCode: 'audio_scope_inapplicable' }
  }
  if (
    !isLanguageCompatible(
      candidate.language,
      requirement.language ?? context.language,
    )
  ) {
    return { ok: false, reasonCode: 'audio_language_incompatible' }
  }
  // Independent of the eligibility check above: prove the object behind
  // the reference is really there and really is the approved recording,
  // against the hash the MANIFEST froze rather than the row's own.
  if (!isValidStorageKey(candidate.storageKey)) {
    return { ok: false, reasonCode: 'audio_storage_ref_invalid' }
  }
  const bytes = await getMediaStorage().get(candidate.storageKey)
  if (!bytes || bytes.length === 0) {
    return { ok: false, reasonCode: 'audio_missing_from_storage' }
  }
  if (computeFileSha256(bytes) !== fileSha256) {
    return { ok: false, reasonCode: 'audio_hash_mismatch' }
  }
  return { ok: true, mediaAssetVersionId, fileSha256 }
}

// --- Artifact verification + storage ----------------------------------------

async function verifyAndStoreSpeechArtifact(
  artifact: SpeechArtifact,
  targetDurationMs: number,
): Promise<
  | {
      ok: true
      storageKey: string
      fileSha256: string
      mimeType: string
      durationMs: number
    }
  | { ok: false; reasonCode: string }
> {
  const extension = SPEECH_MIME_EXTENSIONS[artifact.mimeType]
  if (!extension) return { ok: false, reasonCode: 'artifact_mime_invalid' }
  // `artifact` crosses a provider boundary — the mock always honors the
  // SpeechArtifact type, but a real (or malformed test-double) provider
  // is untrusted external input and can violate a TS type at runtime
  // (e.g. a loosely-deserialized HTTP response with `bytes` missing
  // entirely). `.length` on a missing value would throw rather than
  // fail closed, so the presence check stays despite TS proving it
  // unreachable for the mock.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!artifact.bytes || artifact.bytes.length === 0) {
    return { ok: false, reasonCode: 'artifact_empty' }
  }
  // Bounded duration: positive and never exceeding the segment ceiling,
  // regardless of what a (future real) provider claims. NOT an exact
  // match against the planned window — spoken length legitimately
  // differs from a planned window, and forcing equality would mean
  // padding or truncating approved sacred text, which Step 15 must
  // never do.
  if (artifact.durationMs <= 0 || artifact.durationMs > MAX_SPEECH_MS) {
    return { ok: false, reasonCode: 'artifact_duration_bound' }
  }
  void targetDurationMs
  // Fresh server-side hash from the exact bytes — a provider-reported
  // hash is never part of this contract and would never be trusted if
  // it were, mirroring MediaStorageProvider's own discipline.
  const fileSha256 = computeFileSha256(artifact.bytes)
  const { storageKey } = await getMediaStorage().put(artifact.bytes, extension)
  return {
    ok: true,
    storageKey,
    fileSha256,
    mimeType: artifact.mimeType,
    durationMs: artifact.durationMs,
  }
}

/** The persisted claim ONE task row makes about its artifact. Every
 * field is nullable exactly as the column is — an absent value is a
 * failure to prove, never an excuse to skip a check. */
export interface StoredSpeechArtifactClaim {
  artifactStorageRef: string | null
  artifactSha256: string | null
  artifactMimeType: string | null
  artifactDurationMs: number | null
}

export type StoredSpeechArtifactVerification =
  | { ok: true }
  | { ok: false; reasonCode: string }

/**
 * Re-proves a PERSISTED speech artifact claim against PRIVATE STORAGE —
 * the bytes themselves, not the row's own metadata.
 *
 * Row metadata is only ever a claim: it was written by some earlier
 * cycle, possibly by another worker, possibly a long time ago, and the
 * stored object can have gone missing or been altered in that window.
 * So this re-reads the object, recomputes its SHA-256 from the exact
 * stored bytes and re-applies the SAME allowlist/bound rules storage
 * time applied. A tampered, truncated, missing or unreferenceable
 * artifact fails CLOSED here.
 */
export async function verifyStoredAudioArtifact(
  claim: StoredSpeechArtifactClaim,
): Promise<StoredSpeechArtifactVerification> {
  const storageRef = claim.artifactStorageRef
  if (storageRef == null || !isValidStorageKey(storageRef)) {
    return { ok: false, reasonCode: 'artifact_storage_ref_invalid' }
  }
  if (claim.artifactSha256 == null || !SPEECH_HEX64.test(claim.artifactSha256)) {
    return { ok: false, reasonCode: 'artifact_hash_invalid' }
  }
  if (
    claim.artifactMimeType == null ||
    !isAllowedSpeechMimeType(claim.artifactMimeType)
  ) {
    return { ok: false, reasonCode: 'artifact_mime_invalid' }
  }
  const durationMs = claim.artifactDurationMs
  if (durationMs == null || durationMs <= 0 || durationMs > MAX_SPEECH_MS) {
    return { ok: false, reasonCode: 'artifact_duration_bound' }
  }
  const storage = getMediaStorage()
  if (!(await storage.exists(storageRef))) {
    return { ok: false, reasonCode: 'artifact_missing_from_storage' }
  }
  const bytes = await storage.get(storageRef)
  if (!bytes || bytes.length === 0) {
    return { ok: false, reasonCode: 'artifact_missing_from_storage' }
  }
  if (computeFileSha256(bytes) !== claim.artifactSha256) {
    return { ok: false, reasonCode: 'artifact_hash_mismatch' }
  }
  return { ok: true }
}

/**
 * Best-effort removal of a speech artifact THIS worker just stored and
 * whose result was then rejected — its persistence lost a status CAS to
 * another worker, or its lease was gone by the time the bytes came
 * back. Nothing references those bytes and nothing ever will, so
 * leaving them on disk is pure accumulation from a stale worker.
 *
 * ONLY ever called with a key `verifyAndStoreSpeechArtifact` returned
 * moments earlier in the SAME poll (every `put` mints a fresh
 * server-generated key, so it can never name another worker's artifact
 * or any approved media object). Never a destructive-delete path for a
 * referenced artifact, and never fatal — an unremovable orphan must not
 * turn a lost race into a job failure.
 */
export async function discardGeneratedSpeechArtifact(
  storageRef: string,
): Promise<void> {
  if (!isValidStorageKey(storageRef)) return
  try {
    await getMediaStorage().remove(storageRef)
  } catch {
    // best-effort by contract — see MediaStorageProvider.remove
  }
}

// --- Execution: the AudioGenerationDependencies contract --------------------

function reasonToErrorCode(
  compiled: Exclude<CompiledSpeechSynthesisRequest, { status: 'OK' }>,
): string {
  return compiled.reasonCode
}

/**
 * Submits ONE TTS requirement. Called by `runAudioGenerationOnce` at
 * most once per PENDING row (a task that already SUCCEEDED never comes
 * back through here) — but is itself idempotent regardless, since the
 * provider is keyed on the requirement's idempotency key and a
 * re-submission of the SAME request is a no-op at the provider layer,
 * never a second paid synthesis.
 *
 * The approved body exists only for the duration of this call: it is
 * compiled into the request immediately before the provider call and is
 * never returned, persisted or logged.
 */
export async function submitSpeech(input: {
  requirement: ManifestAudioRequirement
  idempotencyKey: string
}): Promise<AudioTaskSubmissionResult> {
  const provider = getTtsProvider()
  const compiled = await compileSpeechSynthesisRequest(
    input.requirement,
    input.idempotencyKey,
  )
  if (compiled.status !== 'OK') {
    return {
      status: 'FAILED',
      providerCode: provider.code,
      errorCode: reasonToErrorCode(compiled),
      errorMessage: null,
    }
  }
  try {
    const submission = await provider.submitSpeech(compiled.request)
    if (submission.status === 'FAILED') {
      return {
        status: 'FAILED',
        providerCode: provider.code,
        errorCode: 'provider_submit_failed',
        errorMessage: null,
      }
    }
    return {
      status: 'SUBMITTED',
      providerCode: provider.code,
      providerOperationId: submission.providerJobId,
    }
  } catch (error) {
    if (error instanceof TtsProviderError) {
      return {
        status: 'FAILED',
        providerCode: provider.code,
        errorCode: error.code,
        errorMessage: null,
      }
    }
    throw error
  }
}

/**
 * Polls ONE in-flight synthesis. Re-runs the SAME authority
 * re-verification as `submitSpeech` before ever calling the provider —
 * a task can sit SUBMITTED/PROCESSING across many worker cycles, and
 * authority (a rights change, a runtime disable, an edited body, a
 * voice-policy change) can shift in that window; a result whose
 * authority has since been withdrawn is never accepted. Holds no DB
 * transaction and persists nothing itself — the caller writes the
 * result in a separate, subsequent write.
 *
 * `providerOperationId` is opaque and only meaningful to the provider
 * that ISSUED it, so the provider is resolved by the `providerCode`
 * persisted at submission — never "whichever provider is active now".
 * A mismatch fails CLOSED without any provider call at all: asking a
 * different backend about an operation id it never issued could only
 * ever return someone else's recording, and accepting that as the voice
 * of approved sacred text would be far worse than retrying.
 */
export async function pollSpeech(input: {
  providerCode: string
  providerOperationId: string
  requirement: ManifestAudioRequirement
  idempotencyKey: string
}): Promise<AudioTaskPollResult> {
  const provider = resolveTtsProvider(input.providerCode)
  if (!provider) {
    return {
      status: 'FAILED',
      errorCode: 'provider_code_mismatch',
      errorMessage: null,
    }
  }
  const compiled = await compileSpeechSynthesisRequest(
    input.requirement,
    input.idempotencyKey,
  )
  if (compiled.status !== 'OK') {
    return {
      status: 'FAILED',
      errorCode: reasonToErrorCode(compiled),
      errorMessage: null,
    }
  }
  try {
    const poll = await provider.pollSpeech(input.providerOperationId)
    if (poll.status === 'PENDING') return { status: 'PROCESSING' }
    if (poll.status === 'FAILED' || !poll.artifact) {
      return {
        status: 'FAILED',
        errorCode: poll.failureCode ?? 'provider_failed',
        errorMessage: null,
      }
    }
    const verified = await verifyAndStoreSpeechArtifact(
      poll.artifact,
      compiled.request.targetDurationMs,
    )
    if (!verified.ok) {
      return {
        status: 'FAILED',
        errorCode: verified.reasonCode,
        errorMessage: null,
      }
    }
    return {
      status: 'SUCCEEDED',
      artifactSha256: verified.fileSha256,
      artifactMimeType: verified.mimeType,
      artifactDurationMs: verified.durationMs,
      artifactStorageRef: verified.storageKey,
    }
  } catch (error) {
    if (error instanceof TtsProviderError) {
      return { status: 'FAILED', errorCode: error.code, errorMessage: null }
    }
    throw error
  }
}
