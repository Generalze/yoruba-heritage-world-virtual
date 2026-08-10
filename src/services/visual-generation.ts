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
import {
  getVisualGenerationProvider,
  resolveVisualGenerationProvider,
} from '@/providers/visual-generation/registry'
import { VisualGenerationProviderError } from '@/providers/visual-generation/types'
import { MAX_SCENE_MS } from './generation-storyboards'
import { isSacredVersionRuntimeEligible } from './sacred-content'
import { loadPublishedVisualBible } from './visual-bibles'
import type {
  VisualGenerationArtifact,
  VisualGenerationRequest,
} from '@/providers/visual-generation/types'
import type { ManifestVisualTask } from './generation-storyboards'
// Assumed shape of Bravo's Step 14 dependency contract
// (`VisualGenerationDependencies` in generation-jobs.ts) — see the
// report to the team lead. Injected there, not statically imported
// here, so this file has no opinion on job/lease/retry persistence.
import type {
  VisualTaskPollResult,
  VisualTaskSubmissionResult,
} from './generation-jobs'

/**
 * Visual generation EXECUTOR service (Phase One, Step 14).
 *
 * ```text
 * ManifestVisualTask (Step 13, body-free structured intent)
 * → task-level re-verification against CURRENT authority (never trusts
 *   an earlier check — Bravo's job-level loop already revalidated the
 *   WHOLE manifest before calling in here; this re-proves the SPECIFIC
 *   Visual Bible + sacred-content authority this one task depends on)
 * → in-memory request compilation (body-free unless APPROVED_TEXT_CONTEXT)
 * → provider-neutral submit/poll (mock only — no real provider exists yet)
 * → verified artifact (mime/type, bounded duration, non-empty, fresh SHA-256)
 * → private storage (LocalMediaStorageProvider — no S3)
 * → re-verified against that storage before the job is ever allowed to
 *   leave GENERATING_VISUALS (`verifyStoredArtifact`)
 * ```
 *
 * This module owns EXECUTION only — `submitScene`/`pollScene` are pure
 * functions of a `ManifestVisualTask` (plus, for polling, an opaque
 * provider operation id): no DB row for the task itself is read or
 * written here. That lifecycle (PENDING/SUBMITTED/PROCESSING/
 * SUCCEEDED/FAILED/CANCELLED, keyed by job + manifest snapshot + the
 * manifest's own taskId, with lease/retry/finalization) belongs to
 * `runVisualGenerationOnce` in `src/services/generation-jobs.ts`, which
 * injects these two functions as its `VisualGenerationDependencies`.
 *
 * A scene bound to approved media (or holding the previous visual)
 * NEVER reaches this module at all — Step 13's manifest builder only
 * ever emits a `visualTasks` entry for a GENERATION_REQUIRED scene, and
 * Bravo's loop only ever calls these functions for entries already in
 * `manifest.visualTasks` — so "no execution for an approved-media
 * scene" is an architectural invariant, not a runtime check here.
 */

// --- Request compilation ----------------------------------------------------

/** Bounded, safe failure shapes — reasonCode is always a fixed machine
 * code, never a raw error/provider string that could echo content. */
export type CompiledVisualGenerationRequest =
  | { status: 'OK'; request: VisualGenerationRequest }
  | { status: 'FAILED'; reasonCode: string }

/** Columns needed to run the runtime-eligibility formula — deliberately
 * NEVER includes `spiritualContentVersions.body`. Used for the
 * METADATA_ONLY path, where the sacred body must never be retrieved at
 * all, not merely excluded from the outgoing request. */
async function loadSacredEligibilityWithoutBody(contentVersionId: number) {
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

/** Same join, WITH the body — used ONLY by the APPROVED_TEXT_CONTEXT
 * path, immediately after which the body either enters the in-memory
 * request or is discarded; it is never selected for METADATA_ONLY. */
async function loadSacredEligibilityWithBody(contentVersionId: number) {
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
 * METADATA_ONLY governance path: proves the sacred version is STILL
 * runtime-eligible and its approved-content hash still matches the
 * manifest's frozen snapshot — WITHOUT ever selecting the body column.
 * "Never retrieve the sacred body" is enforced by construction here,
 * not by discipline alone.
 */
async function verifyMetadataOnlyEligibility(
  contentVersionId: number,
  expectedContentSha256: string,
): Promise<{ ok: true } | { ok: false; reasonCode: string }> {
  const row = await loadSacredEligibilityWithoutBody(contentVersionId)
  if (!row) return { ok: false, reasonCode: 'sacred_content_missing' }
  const failures: Array<string> = []
  if (row.itemContentDomain !== 'SACRED_RUNTIME') {
    failures.push('wrong_content_domain')
  }
  if (!row.itemActive) failures.push('item_inactive')
  if (
    !(SACRED_RUNTIME_CONTENT_TYPES as ReadonlyArray<string>).includes(
      row.itemContentType,
    )
  ) {
    failures.push('invalid_sacred_content_type')
  }
  if (row.versionStatus !== 'PUBLISHED') failures.push('not_published')
  if (
    !(GUIDANCE_LANGUAGES as ReadonlyArray<string>).includes(
      row.versionLanguage,
    )
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
  if (row.profileContentSha256 !== expectedContentSha256) {
    return { ok: false, reasonCode: 'sacred_content_hash_changed' }
  }
  return { ok: true }
}

/**
 * APPROVED_TEXT_CONTEXT governance path: runs the SAME canonical
 * eligibility formula Step 8 defines (`isSacredVersionRuntimeEligible`,
 * including its body-vs-hash integrity check), THEN proves the current
 * hash still matches the manifest's frozen snapshot, and ONLY THEN
 * returns the body — which the caller places directly into the
 * in-memory request and never stores or logs.
 */
async function loadApprovedSacredBody(
  contentVersionId: number,
  expectedContentSha256: string,
): Promise<{ ok: true; body: string } | { ok: false; reasonCode: string }> {
  const row = await loadSacredEligibilityWithBody(contentVersionId)
  if (!row) return { ok: false, reasonCode: 'sacred_content_missing' }
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
    return { ok: false, reasonCode: 'sacred_content_ineligible' }
  }
  if (row.profileContentSha256 !== expectedContentSha256) {
    return { ok: false, reasonCode: 'sacred_content_hash_changed' }
  }
  return { ok: true, body: row.versionBody }
}

/**
 * Re-verifies ONE manifest task against CURRENT authority and compiles
 * the provider request in memory. Nothing here is ever persisted or
 * logged raw — only the eventual verified ARTIFACT (bytes → storage key
 * + fresh SHA-256) downstream in `submitScene`/`pollScene` is meant to
 * reach a database row (written by Bravo's persistence layer, not by
 * this function).
 *
 * `task` is exactly `GenerationManifest.visualTasks[number]` (Step 13)
 * — body-free, provider-neutral structured intent. There is no jobId
 * here by design: everything this function needs to re-verify authority
 * (House, Service, content identity + hash, Visual Bible identity +
 * hash, policy) already lives in `task.generationIntent`, which is
 * itself only ever handed out by an ALREADY-validated manifest.
 */
export async function compileVisualGenerationRequest(
  task: ManifestVisualTask,
): Promise<CompiledVisualGenerationRequest> {
  // `task` ultimately traces back to `JSON.parse(row.manifestJsonText)`
  // in loadGenerationManifestSnapshot, asserted `as GenerationManifest`
  // with NO field-by-field runtime validation at that boundary — a
  // persisted row tampered with a recomputed checksum can carry any
  // shape here regardless of what the static type claims. These two
  // checks are this function's own trust-boundary guard: they do not
  // rely on loadAndValidateGenerationManifest's structural diff having
  // already caught it (that diff protects the ONE call path through
  // runVisualGenerationOnce today, but submitScene/pollScene are public
  // exports reachable from any future caller).
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (task.taskKind !== 'GENERATE_VIDEO_SCENE') {
    return { status: 'FAILED', reasonCode: 'unsupported_task_kind' }
  }
  const intent = task.generationIntent
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!intent) {
    return { status: 'FAILED', reasonCode: 'missing_generation_intent' }
  }

  // Visual Bible: CURRENT text for in-memory compilation only, re-
  // verified against the task's own snapshotted version/hash — defense
  // in depth beyond whatever job-level revalidation already ran before
  // this task was handed to us.
  const bible = await loadPublishedVisualBible(intent.sacredHouseId)
  if (bible.status !== 'OK') {
    return {
      status: 'FAILED',
      reasonCode: `visual_bible_${bible.status.toLowerCase()}`,
    }
  }
  if (
    bible.versionId !== intent.visualBibleVersionId ||
    bible.definitionSha256 !== intent.visualBibleSha256
  ) {
    return { status: 'FAILED', reasonCode: 'visual_bible_changed' }
  }
  if (bible.rules.length !== intent.ruleRefs.length) {
    return { status: 'FAILED', reasonCode: 'visual_bible_rule_mismatch' }
  }

  // Privacy divergence point (item 3): METADATA_ONLY never retrieves
  // the body; APPROVED_TEXT_CONTEXT retrieves the CURRENT approved body
  // only after its own fresh validation. NO_EXTERNAL_AI (or anything
  // else) can never legitimately reach a generation task — Step 13
  // already blocks it at build time — so it fails CLOSED here too
  // rather than trust a stale or corrupted policy value.
  let approvedTextContext: string | null = null
  if (intent.externalAiPolicy === 'METADATA_ONLY') {
    const check = await verifyMetadataOnlyEligibility(
      intent.contentVersionId,
      intent.contentSha256,
    )
    if (!check.ok) return { status: 'FAILED', reasonCode: check.reasonCode }
  } else if (intent.externalAiPolicy === 'APPROVED_TEXT_CONTEXT') {
    const loaded = await loadApprovedSacredBody(
      intent.contentVersionId,
      intent.contentSha256,
    )
    if (!loaded.ok) return { status: 'FAILED', reasonCode: loaded.reasonCode }
    approvedTextContext = loaded.body
  } else {
    return { status: 'FAILED', reasonCode: 'external_ai_policy_forbidden' }
  }

  const request: VisualGenerationRequest = {
    // Reused verbatim from the ALREADY-validated manifest task — Step
    // 13 proved this is exactly
    // sha256(`visual-task-v1|${jobId}|${storyboardSha256}|${sceneId}`),
    // deterministic over manifest authority alone.
    idempotencyKey: task.idempotencyKey,
    sceneId: task.sceneId,
    taskId: task.taskId,
    durationMs: task.durationMs,
    contentType: intent.contentType,
    themeCode: intent.themeCode,
    visualBibleVersionId: intent.visualBibleVersionId,
    visualBibleVersionNumber: intent.visualBibleVersionNumber,
    visualBibleRules: bible.rules,
    externalAiPolicy: intent.externalAiPolicy,
    approvedTextContext,
  }
  return { status: 'OK', request }
}

// --- Artifact verification + storage ----------------------------------------

/** The mock emits exactly one type today; a future real provider adds
 * to this allowlist, never bypasses it. */
const ARTIFACT_MIME_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
}

/** The SAME allowlist, re-checkable later against a PERSISTED mime type
 * — an artifact whose type was allowlisted at storage time must still be
 * allowlisted when its result is finally accepted. */
export function isAllowedArtifactMimeType(mimeType: string): boolean {
  return Object.hasOwn(ARTIFACT_MIME_EXTENSIONS, mimeType)
}

const ARTIFACT_HEX64 = /^[0-9a-f]{64}$/

/**
 * A provider may legitimately return a slightly different ENCODED length
 * than the exact scene duration asked for; it may never return something
 * materially different, which would mean the artifact belongs to another
 * scene (or another task entirely).
 */
export const ARTIFACT_DURATION_TOLERANCE_MS = 1_000

async function verifyAndStoreArtifact(
  artifact: VisualGenerationArtifact,
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
  const extension = ARTIFACT_MIME_EXTENSIONS[artifact.mimeType]
  if (!extension) return { ok: false, reasonCode: 'artifact_mime_invalid' }
  // `artifact` crosses a provider boundary — the mock always honors the
  // VisualGenerationArtifact type, but a real (or malformed test-double)
  // provider is untrusted external input and can violate a TS type at
  // runtime (e.g. a loosely-deserialized HTTP response with `bytes`
  // missing entirely). `.length` on a missing value would throw rather
  // than fail closed, so the presence check stays despite TS proving it
  // unreachable for the mock.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!artifact.bytes || artifact.bytes.length === 0) {
    return { ok: false, reasonCode: 'artifact_empty' }
  }
  // Bounded duration (item 4): positive and never exceeding the Step 13
  // scene ceiling, regardless of what a (future real) provider claims.
  // NOT an exact match against the requested duration — a provider is
  // free to return a slightly different encoded length; the bound is
  // what protects against a zero/negative or wildly-oversized result.
  if (artifact.durationMs <= 0 || artifact.durationMs > MAX_SCENE_MS) {
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
export interface StoredArtifactClaim {
  artifactStorageRef: string | null
  artifactSha256: string | null
  artifactMimeType: string | null
  artifactDurationMs: number | null
}

export type StoredArtifactVerification =
  | { ok: true }
  | { ok: false; reasonCode: string }

/**
 * Re-proves a PERSISTED artifact claim against PRIVATE STORAGE — the
 * bytes themselves, not the row's own metadata.
 *
 * Row metadata is only ever a claim: it was written by some earlier
 * cycle, possibly by another worker, possibly a long time ago, and the
 * stored object can have gone missing or been altered in that window.
 * So this re-reads the object, recomputes its SHA-256 from the exact
 * stored bytes and re-applies the SAME allowlist/bound rules storage
 * time applied. A tampered, truncated, missing or unreferenceable
 * artifact fails CLOSED here.
 *
 * `task` is the manifest task this artifact is supposed to satisfy — the
 * duration is checked against THAT scene, so an artifact that is
 * internally valid but belongs to a different scene is still rejected.
 */
export async function verifyStoredArtifact(
  claim: StoredArtifactClaim,
  task: ManifestVisualTask,
): Promise<StoredArtifactVerification> {
  const storageRef = claim.artifactStorageRef
  if (storageRef == null || !isValidStorageKey(storageRef)) {
    return { ok: false, reasonCode: 'artifact_storage_ref_invalid' }
  }
  if (claim.artifactSha256 == null || !ARTIFACT_HEX64.test(claim.artifactSha256)) {
    return { ok: false, reasonCode: 'artifact_hash_invalid' }
  }
  if (
    claim.artifactMimeType == null ||
    !isAllowedArtifactMimeType(claim.artifactMimeType)
  ) {
    return { ok: false, reasonCode: 'artifact_mime_invalid' }
  }
  const durationMs = claim.artifactDurationMs
  if (durationMs == null || durationMs <= 0 || durationMs > MAX_SCENE_MS) {
    return { ok: false, reasonCode: 'artifact_duration_bound' }
  }
  if (Math.abs(durationMs - task.durationMs) > ARTIFACT_DURATION_TOLERANCE_MS) {
    return { ok: false, reasonCode: 'artifact_duration_mismatch' }
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
 * Best-effort removal of an artifact THIS worker just stored and whose
 * result was then rejected — its persistence lost a status CAS to
 * another worker, or its lease was gone by the time the bytes came back.
 * Nothing references those bytes and nothing ever will, so leaving them
 * on disk is pure accumulation from a stale worker.
 *
 * ONLY ever called with a key `verifyAndStoreArtifact` returned moments
 * earlier in the SAME poll (every `put` mints a fresh server-generated
 * key, so it can never name another worker's artifact). Never a
 * destructive-delete path for a referenced artifact, and never fatal —
 * an unremovable orphan must not turn a lost race into a job failure.
 */
export async function discardGeneratedArtifact(
  storageRef: string,
): Promise<void> {
  if (!isValidStorageKey(storageRef)) return
  try {
    await getMediaStorage().remove(storageRef)
  } catch {
    // best-effort by contract — see MediaStorageProvider.remove
  }
}

// --- Execution: Bravo's VisualGenerationDependencies contract ---------------

function reasonToErrorCode(
  compiled: Exclude<CompiledVisualGenerationRequest, { status: 'OK' }>,
): string {
  return compiled.reasonCode
}

/**
 * Submits ONE manifest task. Called by `runVisualGenerationOnce` at
 * most once per PENDING row (a task that already SUCCEEDED never comes
 * back through here) — but is itself idempotent regardless, since the
 * provider is keyed on `task.idempotencyKey` and a re-submission of the
 * SAME task/request is a no-op at the provider layer, never a second
 * paid execution.
 */
export async function submitScene(
  task: ManifestVisualTask,
): Promise<VisualTaskSubmissionResult> {
  const provider = getVisualGenerationProvider()
  const compiled = await compileVisualGenerationRequest(task)
  if (compiled.status !== 'OK') {
    return {
      status: 'FAILED',
      providerCode: provider.code,
      errorCode: reasonToErrorCode(compiled),
      errorMessage: null,
    }
  }
  try {
    const submission = await provider.submitScene(compiled.request)
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
    if (error instanceof VisualGenerationProviderError) {
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
 * Polls ONE in-flight provider operation. Re-runs the SAME task-level
 * authority re-verification as `submitScene` before ever calling the
 * provider — a task can sit SUBMITTED/PROCESSING across many worker
 * cycles, and authority (media withdrawal, a Visual Bible edit, a
 * sacred-content rights change) can shift in that window. Holds no DB
 * transaction and persists nothing itself — the caller (Bravo's loop)
 * writes the result in a separate, subsequent write.
 *
 * `providerOperationId` is opaque and only meaningful to the provider
 * that ISSUED it, so the provider is resolved by the `providerCode`
 * persisted at submission — never "whichever provider is active now".
 * A mismatch fails CLOSED without any provider call at all: asking a
 * different backend about an operation id it never issued could only
 * ever return someone else's result or a meaningless failure, and
 * accepting either would be worse than retrying.
 */
export async function pollScene(input: {
  providerCode: string
  providerOperationId: string
  task: ManifestVisualTask
}): Promise<VisualTaskPollResult> {
  const provider = resolveVisualGenerationProvider(input.providerCode)
  if (!provider) {
    return {
      status: 'FAILED',
      errorCode: 'provider_code_mismatch',
      errorMessage: null,
    }
  }
  const compiled = await compileVisualGenerationRequest(input.task)
  if (compiled.status !== 'OK') {
    return { status: 'FAILED', errorCode: reasonToErrorCode(compiled), errorMessage: null }
  }
  try {
    const poll = await provider.pollScene(input.providerOperationId)
    if (poll.status === 'PENDING') return { status: 'PROCESSING' }
    if (poll.status === 'FAILED' || !poll.artifact) {
      return {
        status: 'FAILED',
        errorCode: poll.failureCode ?? 'provider_failed',
        errorMessage: null,
      }
    }
    const verified = await verifyAndStoreArtifact(poll.artifact)
    if (!verified.ok) {
      return { status: 'FAILED', errorCode: verified.reasonCode, errorMessage: null }
    }
    return {
      status: 'SUCCEEDED',
      artifactSha256: verified.fileSha256,
      artifactMimeType: verified.mimeType,
      artifactDurationMs: verified.durationMs,
      artifactStorageRef: verified.storageKey,
    }
  } catch (error) {
    if (error instanceof VisualGenerationProviderError) {
      return { status: 'FAILED', errorCode: error.code, errorMessage: null }
    }
    throw error
  }
}
