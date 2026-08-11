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
 * → provider-neutral submit/poll (the deterministic mock, or 9jaLingo's
 *   synchronous /v1/audio/speech, which completes at submit time)
 * → verified artifact (mime/type, bounded duration, non-empty, fresh SHA-256)
 * → private working media storage (the configured MediaStorageProvider;
 *   the finished recording later reaches the private object store at
 *   the upload stage)
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

/**
 * The context every provider action is keyed on. `idempotencyKey` is
 * OPTIONAL and, when present, is treated as a claim to be checked — not
 * as authority. See resolveAuthoritativeIdempotencyKey.
 */
export interface SpeechTaskIdentity {
  generationJobId: number
  manifestSha256: string
  /** What the caller BELIEVES the key is. Recomputed here and rejected
   * on mismatch; omitting it is equally valid (and safer). */
  idempotencyKey?: string
}

/**
 * Derives the authoritative idempotency key and refuses any supplied
 * value that disagrees with it.
 *
 * The key is what stops a second paid synthesis of the same speech, so
 * it can never be whatever a caller passes in: a well-formed but WRONG
 * 64-hex key would silently mint a brand-new provider job for text that
 * has already been synthesized. It is therefore always recomputed from
 * manifest authority (job + manifest hash + requirement id), and a
 * mismatch fails CLOSED here — before any provider is contacted and
 * before the sacred body is anywhere near this code path.
 */
function resolveAuthoritativeIdempotencyKey(
  requirement: ManifestAudioRequirement,
  input: SpeechTaskIdentity,
): { ok: true; idempotencyKey: string } | { ok: false; reasonCode: string } {
  const requirementId = requirement.requirementId
  if (requirementId == null) {
    return { ok: false, reasonCode: 'incomplete_audio_requirement' }
  }
  if (
    !Number.isInteger(input.generationJobId) ||
    input.generationJobId <= 0 ||
    !SPEECH_HEX64.test(input.manifestSha256)
  ) {
    return { ok: false, reasonCode: 'idempotency_context_invalid' }
  }
  const computed = computeAudioTaskIdempotencyKey({
    generationJobId: input.generationJobId,
    manifestSha256: input.manifestSha256,
    requirementId,
  })
  if (input.idempotencyKey != null && input.idempotencyKey !== computed) {
    return { ok: false, reasonCode: 'idempotency_key_mismatch' }
  }
  return { ok: true, idempotencyKey: computed }
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
 * STAGE ONE of the two-stage authority check: metadata ONLY, with the
 * body column deliberately absent from the projection.
 *
 * "Never retrieve the sacred body unless synthesis is currently
 * authorized" is enforced here by CONSTRUCTION — a forbidden or
 * withdrawn requirement is refused without the body ever having been
 * read out of the database — rather than by fetching it and choosing
 * not to use it. Mirrors the Step 14 METADATA_ONLY discipline.
 */
async function loadSacredSpeechAuthority(contentVersionId: number) {
  return (
    await getDb()
      .select({
        itemContentDomain: spiritualContentItems.contentDomain,
        itemContentType: spiritualContentItems.contentType,
        itemActive: spiritualContentItems.active,
        versionStatus: spiritualContentVersions.status,
        versionLanguage: spiritualContentVersions.language,
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
 * STAGE TWO: the approved body, fetched ONLY after stage one proved the
 * synthesis is currently authorized. Selected on its own so the read is
 * unmistakably a consequence of that proof.
 */
async function loadApprovedSpeechBody(
  contentVersionId: number,
): Promise<string | null> {
  const row = (
    await getDb()
      .select({ body: spiritualContentVersions.body })
      .from(spiritualContentVersions)
      .where(eq(spiritualContentVersions.id, contentVersionId))
      .limit(1)
  ).at(0)
  return row?.body ?? null
}

/** What stage one proved, carried forward so stage two never re-derives
 * (or silently disagrees about) any of it. */
export interface VerifiedTtsAuthority {
  contentVersionId: number
  requirementId: string
  sceneId: string
  language: string
  contentSha256: string
  targetDurationMs: number
  /** The full metadata row, so the canonical eligibility formula can be
   * re-run WITH the body once it is legitimately available. */
  metadata: NonNullable<Awaited<ReturnType<typeof loadSacredSpeechAuthority>>>
}

export type TtsAuthorityVerification =
  | { ok: true; authority: VerifiedTtsAuthority }
  | { ok: false; reasonCode: string }

/**
 * Re-verifies ONE TTS_PENDING requirement against CURRENT authority
 * WITHOUT retrieving the sacred body.
 *
 * Everything here is a re-proof, not a lookup of an earlier decision:
 * the manifest froze a plan, but a rights withdrawal, a runtime
 * disable, a re-published body or a voice-policy change since then must
 * all stop the synthesis. In particular the voice policy is read from
 * the AUTHORITATIVE Step 8 sacred profile and must BOTH be
 * APPROVED_TTS_ALLOWED right now AND still match what the manifest
 * snapshotted — a caller cannot downgrade HUMAN_RECORDED_REQUIRED or
 * TEXT_ONLY into a synthesis, and a policy that changed under a frozen
 * plan fails closed rather than proceeding on the stale value.
 *
 * This is the ONLY authority check polling needs: a poll continues an
 * operation that already exists and must never compile, resend or
 * rewrite text.
 */
export async function verifyTtsAuthority(
  requirement: ManifestAudioRequirement,
): Promise<TtsAuthorityVerification> {
  // `requirement` ultimately traces back to JSON.parse of a persisted
  // manifest row, asserted to its type with NO field-by-field runtime
  // validation at that boundary — a tampered row with a recomputed
  // checksum can carry any shape here regardless of what the static
  // type claims. These are this function's own trust-boundary guards.
  if (requirement.mode !== 'TTS_PENDING') {
    return { ok: false, reasonCode: 'not_a_tts_requirement' }
  }
  const contentVersionId = requirement.contentVersionId
  const requirementId = requirement.requirementId
  if (
    contentVersionId == null ||
    requirement.contentSha256 == null ||
    requirement.language == null ||
    requirement.voicePolicy == null ||
    requirementId == null
  ) {
    return { ok: false, reasonCode: 'incomplete_audio_requirement' }
  }
  // The SNAPSHOTTED policy must itself be the permitted one — a
  // requirement that was never TTS-authorized is never synthesized,
  // whatever the row says today.
  if (requirement.voicePolicy !== TTS_PERMITTED_VOICE_POLICY) {
    return { ok: false, reasonCode: 'voice_policy_forbids_tts' }
  }

  const row = await loadSacredSpeechAuthority(contentVersionId)
  if (!row) return { ok: false, reasonCode: 'sacred_content_missing' }
  if (
    row.itemContentDomain !== 'SACRED_RUNTIME' ||
    !(SACRED_RUNTIME_CONTENT_TYPES as ReadonlyArray<string>).includes(
      row.itemContentType,
    )
  ) {
    return { ok: false, reasonCode: 'wrong_content_domain' }
  }
  // CURRENT authoritative voice policy — the decisive check, and the
  // one that must come before any thought of reading the body.
  if (row.profileVoicePolicy !== TTS_PERMITTED_VOICE_POLICY) {
    return { ok: false, reasonCode: 'voice_policy_forbids_tts' }
  }
  // Every metadata gate of the canonical Step 8 formula. The remaining
  // gate — body vs. hash — is re-run in compileSpeechSynthesisRequest
  // once the body may legitimately be read; it is never skipped, only
  // deferred to the point where it is checkable.
  const failures: Array<string> = []
  if (!row.itemActive) failures.push('item_inactive')
  if (row.versionStatus !== 'PUBLISHED') failures.push('not_published')
  if (
    !(GUIDANCE_LANGUAGES as ReadonlyArray<string>).includes(row.versionLanguage)
  ) {
    failures.push('unsupported_language')
  }
  if (row.profileRightsStatus == null) {
    failures.push('profile_missing')
  } else {
    if (!row.profileDigitalStorageAuthorized) {
      failures.push('storage_not_authorized')
    }
    if (row.profileRightsStatus !== 'CLEARED') failures.push('rights_not_cleared')
    if (row.profileAccessPolicy !== 'PRAYER_ROOM_PRIVATE') {
      failures.push('access_policy_not_prayer_room_private')
    }
    if (!row.profileRuntimeEnabled) failures.push('runtime_not_enabled')
    if (!row.profileContentSha256) failures.push('hash_missing')
  }
  if (failures.length > 0) {
    return { ok: false, reasonCode: 'sacred_content_ineligible' }
  }
  if (row.profileContentSha256 !== requirement.contentSha256) {
    return { ok: false, reasonCode: 'sacred_content_hash_changed' }
  }
  // Speak the approved body in ITS OWN language — never a translation.
  if (row.versionLanguage !== requirement.language) {
    return { ok: false, reasonCode: 'language_changed' }
  }

  const targetDurationMs = requirement.endMs - requirement.startMs
  if (targetDurationMs <= 0 || targetDurationMs > MAX_SPEECH_MS) {
    return { ok: false, reasonCode: 'audio_window_invalid' }
  }

  return {
    ok: true,
    authority: {
      contentVersionId,
      requirementId,
      sceneId: requirement.sceneId,
      language: row.versionLanguage,
      contentSha256: requirement.contentSha256,
      targetDurationMs,
      metadata: row,
    },
  }
}

/**
 * Compiles the in-memory submission request — the ONLY path on which
 * the sacred body is ever retrieved.
 *
 * Order matters and is the point of this function: `verifyTtsAuthority`
 * proves synthesis is currently authorized using metadata alone, and
 * only then is the body fetched. It is then re-validated against the
 * AUTHORITATIVE content hash through the canonical Step 8 formula (the
 * body-vs-hash gate deferred from stage one) before being placed
 * verbatim into the request — never rewritten, translated, summarized
 * or extended.
 *
 * The body is never returned to the caller, never persisted, never
 * logged: it exists only inside the request handed to the provider for
 * this one submission.
 */
export async function compileSpeechSynthesisRequest(
  requirement: ManifestAudioRequirement,
  input: SpeechTaskIdentity,
): Promise<CompiledSpeechSynthesisRequest> {
  const key = resolveAuthoritativeIdempotencyKey(requirement, input)
  if (!key.ok) return { status: 'FAILED', reasonCode: key.reasonCode }
  const verified = await verifyTtsAuthority(requirement)
  if (!verified.ok) {
    return { status: 'FAILED', reasonCode: verified.reasonCode }
  }
  const authority = verified.authority

  // AUTHORIZED — and only now — retrieve the approved body.
  const body = await loadApprovedSpeechBody(authority.contentVersionId)
  if (body == null) {
    return { status: 'FAILED', reasonCode: 'sacred_content_missing' }
  }
  // The canonical Step 8 formula, now WITH the body, so its
  // body-vs-hash integrity check runs against exactly the text that is
  // about to be spoken — never a second, looser re-implementation.
  const evaluated = isSacredVersionRuntimeEligible({
    item: {
      contentDomain: authority.metadata.itemContentDomain,
      contentType: authority.metadata.itemContentType,
      active: authority.metadata.itemActive,
    },
    version: {
      status: authority.metadata.versionStatus,
      language: authority.metadata.versionLanguage,
      body,
    },
    profile:
      authority.metadata.profileRightsStatus == null
        ? null
        : {
            digitalStorageAuthorized:
              authority.metadata.profileDigitalStorageAuthorized ?? false,
            rightsStatus: authority.metadata.profileRightsStatus,
            accessPolicy: authority.metadata.profileAccessPolicy ?? '',
            runtimeEnabled: authority.metadata.profileRuntimeEnabled ?? false,
            contentSha256: authority.metadata.profileContentSha256,
          },
  })
  if (!evaluated.eligible) {
    return { status: 'FAILED', reasonCode: 'sacred_content_ineligible' }
  }

  return {
    status: 'OK',
    request: {
      idempotencyKey: key.idempotencyKey,
      requirementId: authority.requirementId,
      sceneId: authority.sceneId,
      // EXACT approved text — verbatim, nothing added, nothing removed.
      approvedText: body,
      language: authority.language,
      voicePolicy: TTS_PERMITTED_VOICE_POLICY,
      targetDurationMs: authority.targetDurationMs,
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
 * Submits ONE TTS requirement.
 *
 * AT MOST ONCE, and the EXECUTOR enforces that — a durable pre-call
 * reservation in `runAudioGenerationOnce` means this is genuinely
 * called at most once per requirement, and an unresolved submission is
 * quarantined rather than repeated. No claim is made that a provider
 * deduplicates on the idempotency key: no real speech vendor examined
 * for this platform documents idempotent submission, and a guarantee
 * nobody makes is not a guarantee. The key remains the requirement's
 * STABLE IDENTITY, and is what an external request id would bind to
 * for a provider that verifiably supports one.
 *
 * A failed result says WHETHER anything was sent (`spendState`):
 * refusals decided before invocation are NOT_SENT and freely
 * retryable; anything at or after invocation is UNKNOWN and never
 * retried automatically.
 *
 * The key is recomputed here from manifest authority, never taken on
 * trust from the caller, and the approved body exists only for the
 * duration of this call: it is compiled into the request immediately
 * before the provider call and is never returned, persisted or logged.
 */
export async function submitSpeech(
  input: SpeechTaskIdentity & { requirement: ManifestAudioRequirement },
  options: { expectedProviderCode?: string } = {},
): Promise<AudioTaskSubmissionResult> {
  const provider = getTtsProvider()
  // THE RESERVED PROVIDER IS THE ONLY ONE THIS SUBMISSION MAY PAY.
  // Checked HERE, immediately before any work — not merely by the
  // caller's earlier registry reads, which leave a gap a selection
  // change could slip through. Refused at this point, nothing has
  // touched the network, so the failure is PROVABLY NOT_SENT.
  if (
    options.expectedProviderCode != null &&
    provider.code !== options.expectedProviderCode
  ) {
    return {
      status: 'FAILED',
      providerCode: provider.code,
      errorCode: 'provider_selection_changed',
      errorMessage: null,
      spendState: 'NOT_SENT',
    }
  }
  // A DISABLED adapter is refused HERE — before compilation, and
  // therefore before the approved body is read at all. Step 15's rule
  // is that the sacred body is retrieved only when synthesis is
  // currently authorized; a deployment with no speech backend is a
  // deployment where it never is. The refusal is a recorded task
  // failure, never a silent skip: a TTS requirement that goes
  // unsatisfied must stop the recording, not quietly vanish from it.
  // Decided BEFORE any invocation: provably NOT_SENT.
  if (!provider.isEnabled()) {
    return {
      status: 'FAILED',
      providerCode: provider.code,
      errorCode: 'tts_unavailable',
      errorMessage: null,
      spendState: 'NOT_SENT',
    }
  }
  // THE PROVIDER'S DECLARED LANGUAGES GATE THE REQUEST BEFORE IT IS
  // COMPILED — and therefore before the approved body is ever read.
  // Phase One's 9jaLingo adapter is approved for Yoruba (yo) only; a
  // requirement in any other language is refused HERE, provably
  // NOT_SENT, with zero provider contact. The text itself is NEVER
  // translated, rewritten, shortened or padded to fit a provider —
  // this recorded refusal is the correct outcome, exactly as a
  // disabled adapter's is.
  const requirementLanguage = input.requirement.language
  if (
    provider.supportedLanguages != null &&
    (requirementLanguage == null ||
      !provider.supportedLanguages.includes(requirementLanguage))
  ) {
    return {
      status: 'FAILED',
      providerCode: provider.code,
      errorCode: 'language_unsupported_by_provider',
      errorMessage: null,
      spendState: 'NOT_SENT',
    }
  }
  const compiled = await compileSpeechSynthesisRequest(input.requirement, input)
  if (compiled.status !== 'OK') {
    // A compile refusal happens strictly before the provider is
    // invoked — nothing has been sent, and saying so is what lets the
    // executor retry it for free instead of quarantining it.
    return {
      status: 'FAILED',
      providerCode: provider.code,
      errorCode: reasonToErrorCode(compiled),
      errorMessage: null,
      spendState: 'NOT_SENT',
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
    if (submission.status === 'COMPLETED') {
      // SYNCHRONOUS PROVIDER (9jaLingo): the spend has happened and
      // the bytes are HERE. They pass the same verification every
      // asynchronous poll result passes — allowlisted mime, bounded
      // duration, non-empty, fresh server-side SHA-256 — and are
      // stored in private storage BEFORE this returns, so the caller
      // receives a durable claim, never raw bytes. A completed
      // synthesis whose artifact fails verification is paid work we
      // cannot use: an UNKNOWN outcome (no spendState), never a
      // NOT_SENT, and never retried automatically.
      const verified = await verifyAndStoreSpeechArtifact(submission.artifact)
      if (!verified.ok) {
        return {
          status: 'FAILED',
          providerCode: provider.code,
          errorCode: verified.reasonCode,
          errorMessage: null,
        }
      }
      return {
        status: 'COMPLETED',
        providerCode: provider.code,
        artifactSha256: verified.fileSha256,
        artifactMimeType: verified.mimeType,
        artifactDurationMs: verified.durationMs,
        artifactStorageRef: verified.storageKey,
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
 * Polls ONE in-flight synthesis.
 *
 * Polling CONTINUES an operation that already exists. It therefore does
 * NOT compile a submission request and never retrieves, resends or
 * rewrites the approved text — the provider already holds whatever it
 * was given at submission. What it does re-run is the SAME
 * current-authority verification (`verifyTtsAuthority`, metadata only),
 * because a task can sit SUBMITTED/PROCESSING across many worker cycles
 * and a rights change, runtime disable, re-published body or
 * voice-policy change in that window must stop the result being
 * accepted. Holds no DB transaction and persists nothing itself — the
 * caller writes the result in a separate, subsequent write.
 *
 * `providerOperationId` is opaque and only meaningful to the provider
 * that ISSUED it, so the provider is resolved by the `providerCode`
 * persisted at submission — never "whichever provider is active now".
 * A mismatch fails CLOSED without any provider call at all: asking a
 * different backend about an operation id it never issued could only
 * ever return someone else's recording, and accepting that as the voice
 * of approved sacred text would be far worse than retrying.
 */
export async function pollSpeech(
  input: SpeechTaskIdentity & {
    providerCode: string
    providerOperationId: string
    requirement: ManifestAudioRequirement
  },
): Promise<AudioTaskPollResult> {
  const provider = resolveTtsProvider(input.providerCode)
  if (!provider) {
    return {
      status: 'FAILED',
      errorCode: 'provider_code_mismatch',
      errorMessage: null,
    }
  }
  // The key is not used to poll (the operation id is), but a caller
  // whose key disagrees with manifest authority is a caller acting on a
  // task identity we cannot vouch for — refuse before spending.
  const key = resolveAuthoritativeIdempotencyKey(input.requirement, input)
  if (!key.ok) {
    return { status: 'FAILED', errorCode: key.reasonCode, errorMessage: null }
  }
  const verified = await verifyTtsAuthority(input.requirement)
  if (!verified.ok) {
    return {
      status: 'FAILED',
      errorCode: verified.reasonCode,
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
    const verifiedArtifact = await verifyAndStoreSpeechArtifact(poll.artifact)
    if (!verifiedArtifact.ok) {
      return {
        status: 'FAILED',
        errorCode: verifiedArtifact.reasonCode,
        errorMessage: null,
      }
    }
    return {
      status: 'SUCCEEDED',
      artifactSha256: verifiedArtifact.fileSha256,
      artifactMimeType: verifiedArtifact.mimeType,
      artifactDurationMs: verifiedArtifact.durationMs,
      artifactStorageRef: verifiedArtifact.storageKey,
    }
  } catch (error) {
    if (error instanceof TtsProviderError) {
      return { status: 'FAILED', errorCode: error.code, errorMessage: null }
    }
    throw error
  }
}
