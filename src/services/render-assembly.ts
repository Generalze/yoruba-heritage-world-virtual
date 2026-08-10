import { createHash } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  mediaAssetVersions,
  mediaAssets,
  prayerGenerationAudioTasks,
  prayerGenerationJobs,
  prayerGenerationRenderPlans,
  prayerGenerationRenderResults,
  prayerGenerationVisualTasks,
} from '@/db/schema'
import {
  computeFileSha256,
  getMediaStorage,
  isValidStorageKey,
} from '@/providers/media/storage'
import {
  checkRenderEngineAllowed,
  getRenderEngine,
  resolveRenderEngine,
} from '@/providers/render/registry'
import { RenderEngineError } from '@/providers/render/types'
import {
  DEFAULT_LEASE_MS,
  GenerationJobError,
  claimNextRenderJob,
  isLegalTransition,
  renewGenerationLease,
  sanitizeErrorMessage,
  scheduleRetryOrFail,
  transitionGenerationJobUnderLease,
} from './generation-jobs'
import {
  loadAndValidateGenerationManifest,
  loadGenerationManifestSnapshot,
} from './generation-storyboards'
import {
  computeAudioTaskIdempotencyKey,
  verifyExistingHumanAudio,
  verifyStoredAudioArtifact,
} from './audio-generation'
import { verifyStoredArtifact } from './visual-generation'
import { MEDIA_MIME_TYPES, isMediaAssetRuntimeEligible } from './media-assets'
import { isLanguageCompatible, isScopeApplicable } from './video-recipes'
import type { GenerationClock } from './generation-jobs'
import type {
  GenerationManifest,
  GenerationStoryboard,
  ManifestAudioRequirement,
  StoryboardScene,
} from './generation-storyboards'
import type { RenderRequest, RenderSourceRef } from '@/providers/render/types'

/**
 * Render assembly engine (Phase One, Step 16).
 *
 * ```text
 * RENDERING job
 * → revalidate the CURRENT manifest AND every visual/audio source's
 *   present authority and byte integrity
 * → build an immutable, deterministic RENDER PLAN (canonical SHA-256)
 * → execute it through the engine-neutral RenderEngine boundary
 * → verify + store the final artifact in PRIVATE LOCAL storage
 * → UPLOADING
 * ```
 *
 * UPLOADING here means only "a verified local artifact is ready".
 * Step 16 uploads nothing, publishes nothing, and creates no Prayer
 * Room; there is no object store and no public URL anywhere in this
 * file.
 *
 * The plan is derived ONLY from already-approved, already-verified
 * upstream authority: the Step 13 storyboard/manifest, Step 14's
 * verified visual outputs and approved media, and Step 15's verified
 * speech outputs and approved human recordings. It invents nothing —
 * no titles, no subtitles, no names, no music, no ambience, no
 * transitions carrying meaning, no spiritual text of any kind — and it
 * carries no sacred body text, spoken text, Visual Bible rule text,
 * provider payload, credential or personal detail.
 */

// --- Constants --------------------------------------------------------------

export const RENDER_PLAN_SCHEMA_VERSION = 'render-plan-v1'

/** Loud bounded ceiling for ONE assembled prayer video. A timeline that
 * exceeds it FAILS — it is never silently truncated, because the only
 * way to shorten it would be to cut approved content. */
export const MAX_RENDER_MS = 30 * 60 * 1000

/**
 * How far a REAL renderer's output may sit from the plan it rendered.
 *
 * A REAL ENCODER IS NOT SAMPLE-EXACT. Video is a whole number of
 * frames, so a 12 340 ms plan at 30 fps lands on a frame boundary a few
 * milliseconds away, before any container rounding. Demanding
 * millisecond equality of a real compositor would reject correct
 * renders for a reason that is arithmetic, not a defect.
 *
 * THE MOCK KEEPS ITS EXACTNESS. This is an outer envelope for real
 * media only; a mock engine is still held to the millisecond, so Step
 * 16's round-trip proof stays a proof rather than quietly becoming a
 * tolerance test. The real engine independently refuses anything
 * outside a TIGHTER bound derived from the actual frame rate (see
 * frameTimingToleranceMs) before it ever returns, so this is an outer
 * envelope, not the working rule.
 */
export const MAX_RENDER_TIMING_TOLERANCE_MS = 250

/** The ONE duration rule, shared by the write and by both later gates.
 * Three copies that could disagree is how a render passes storage and
 * then fails verification forever. */
export function renderedDurationMatchesPlan(input: {
  actualMs: number
  plannedMs: number
  rendererIsMock: boolean
}): boolean {
  if (input.rendererIsMock) return input.actualMs === input.plannedMs
  return (
    Math.abs(input.actualMs - input.plannedMs) <=
    MAX_RENDER_TIMING_TOLERANCE_MS
  )
}

/** The mock emits exactly one type today; a real engine adds to this
 * allowlist, never bypasses it. */
const RENDER_MIME_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
}

export function isAllowedRenderMimeType(mimeType: string): boolean {
  return Object.hasOwn(RENDER_MIME_EXTENSIONS, mimeType)
}

const HEX64 = /^[0-9a-f]{64}$/

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// --- Plan types -------------------------------------------------------------

export type RenderVisualKind =
  | 'APPROVED_MEDIA'
  | 'GENERATED_ARTIFACT'
  | 'HOLD_PREVIOUS'

/** How the source's own length is reconciled with the scene window.
 * Never "stretch" and never "loop": a visual is trimmed when it is
 * longer than its window and its final frame is held when it is
 * shorter, so no footage is ever invented. */
export type RenderVisualFit =
  | 'EXACT'
  | 'TRIM'
  | 'HOLD_LAST_FRAME'
  | 'STILL_HOLD'

export interface RenderPlanScene {
  sceneId: string
  order: number
  recipeSegmentIndex: number
  splitIndex: number
  splitCount: number
  visualKind: RenderVisualKind
  /** The scene whose visual actually supplies this scene's picture —
   * itself, except for HOLD_PREVIOUS, which names the earlier scene it
   * holds. */
  visualSourceSceneId: string
  /** Identity of the resolved source. Exactly one of these is set. */
  mediaAssetVersionId: number | null
  visualTaskId: string | null
  /** Integrity binding: the hash the render is entitled to consume. */
  visualSha256: string | null
  visualMimeType: string | null
  visualSourceDurationMs: number | null
  visualFit: RenderVisualFit
  /** Reconciled absolute timeline. */
  startMs: number
  endMs: number
  durationMs: number
  /** Planned window before reconciliation — kept so the plan itself
   * shows what audio overrun did to the timeline. */
  plannedDurationMs: number
}

export interface RenderPlanAudioSegment {
  requirementId: string
  /** The scene that carries the requirement (a segment's FIRST split).
   * There is exactly ONE entry per recipe segment: a visual split never
   * duplicates, repeats or re-cuts the audio. */
  sceneId: string
  recipeSegmentIndex: number
  kind: 'TTS' | 'EXISTING_HUMAN_AUDIO'
  mediaAssetVersionId: number | null
  audioSha256: string
  audioMimeType: string
  /** VERIFIED actual length of the approved/generated audio. */
  durationMs: number
  /** The segment window the storyboard planned. */
  plannedWindowMs: number
  /** max(planned, actual) — what the timeline actually reserves. */
  finalWindowMs: number
  startMs: number
  endMs: number
}

export interface RenderPlan {
  schemaVersion: string
  generationJobId: number
  manifestSnapshotId: number
  manifestSha256: string
  storyboardSha256: string
  scenes: Array<RenderPlanScene>
  audio: Array<RenderPlanAudioSegment>
  sceneCount: number
  totalDurationMs: number
  outputMimeType: string
  renderPlanSha256: string
}

// --- Canonical hashing ------------------------------------------------------

/** Stable-order canonical serialization of every render decision. */
export function canonicalRenderPlan(
  plan: Omit<RenderPlan, 'renderPlanSha256'>,
): string {
  return JSON.stringify({
    schemaVersion: plan.schemaVersion,
    generationJobId: plan.generationJobId,
    manifestSnapshotId: plan.manifestSnapshotId,
    manifestSha256: plan.manifestSha256,
    storyboardSha256: plan.storyboardSha256,
    sceneCount: plan.sceneCount,
    totalDurationMs: plan.totalDurationMs,
    outputMimeType: plan.outputMimeType,
    scenes: plan.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      order: scene.order,
      recipeSegmentIndex: scene.recipeSegmentIndex,
      splitIndex: scene.splitIndex,
      splitCount: scene.splitCount,
      visualKind: scene.visualKind,
      visualSourceSceneId: scene.visualSourceSceneId,
      mediaAssetVersionId: scene.mediaAssetVersionId,
      visualTaskId: scene.visualTaskId,
      visualSha256: scene.visualSha256,
      visualMimeType: scene.visualMimeType,
      visualSourceDurationMs: scene.visualSourceDurationMs,
      visualFit: scene.visualFit,
      startMs: scene.startMs,
      endMs: scene.endMs,
      durationMs: scene.durationMs,
      plannedDurationMs: scene.plannedDurationMs,
    })),
    audio: plan.audio.map((segment) => ({
      requirementId: segment.requirementId,
      sceneId: segment.sceneId,
      recipeSegmentIndex: segment.recipeSegmentIndex,
      kind: segment.kind,
      mediaAssetVersionId: segment.mediaAssetVersionId,
      audioSha256: segment.audioSha256,
      audioMimeType: segment.audioMimeType,
      durationMs: segment.durationMs,
      plannedWindowMs: segment.plannedWindowMs,
      finalWindowMs: segment.finalWindowMs,
      startMs: segment.startMs,
      endMs: segment.endMs,
    })),
  })
}

export function computeRenderPlanSha256(
  plan: Omit<RenderPlan, 'renderPlanSha256'>,
): string {
  return sha256(canonicalRenderPlan(plan))
}

/** Deterministic render identity: the SAME authority always maps to the
 * SAME render, so a retry can never produce a second accepted output. */
export function computeRenderIdempotencyKey(input: {
  generationJobId: number
  manifestSha256: string
  renderPlanSha256: string
}): string {
  return sha256(
    `render-v1|${input.generationJobId}|${input.manifestSha256}|${input.renderPlanSha256}`,
  )
}

// --- Source verification ----------------------------------------------------

/** What KIND of picture a source is, decided from authoritative asset
 * metadata — never inferred from whether a duration happens to be
 * recorded. A still and a clip are composed differently, and guessing
 * from missing metadata is how a video silently becomes a freeze. */
export type RenderMediaKind = 'IMAGE' | 'VIDEO'

interface VerifiedVisualSource {
  sceneId: string
  kind: 'APPROVED_MEDIA' | 'GENERATED_ARTIFACT'
  mediaKind: RenderMediaKind
  mediaAssetVersionId: number | null
  visualTaskId: string | null
  storageKey: string
  sha256: string
  mimeType: string
  /** ALWAYS null for an IMAGE (a still has no length of its own) and
   * ALWAYS a positive number for a VIDEO — an unknown video length
   * fails closed rather than being planned around. */
  durationMs: number | null
}

interface VerifiedAudioSource {
  requirementId: string
  sceneId: string
  kind: 'TTS' | 'EXISTING_HUMAN_AUDIO'
  mediaAssetVersionId: number | null
  storageKey: string
  sha256: string
  mimeType: string
  durationMs: number
}

export interface RenderContext {
  serviceId: number
  sacredHouseId: number
  language: string
}

export type BuiltRenderPlan =
  | { ok: true; plan: RenderPlan; sources: Array<RenderSourceRef> }
  | { ok: false; reasonCode: string }

/**
 * Re-proves ONE approved media visual against CURRENT authority and its
 * actual private bytes.
 *
 * The manifest froze an identity and a hash; neither is evidence that
 * the asset is still usable today. Rights can be withdrawn, runtime
 * disabled, consent revoked, an asset deactivated, and bytes can go
 * missing or change. So this re-runs the shared eligibility rule
 * (which itself re-reads the object and re-hashes it), re-proves the
 * frozen hash still matches, and re-proves Service/House scope and
 * language applicability.
 */
async function verifyApprovedMediaVisual(
  sceneId: string,
  mediaAssetVersionId: number,
  expectedSha256: string,
  context: RenderContext,
): Promise<{ ok: true; source: VerifiedVisualSource } | { ok: false; reasonCode: string }> {
  const row = (
    await getDb()
      .select({ version: mediaAssetVersions, asset: mediaAssets })
      .from(mediaAssetVersions)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaAssetVersions.assetId))
      .where(eq(mediaAssetVersions.id, mediaAssetVersionId))
      .limit(1)
  ).at(0)
  if (!row) return { ok: false, reasonCode: 'approved_media_missing' }
  const eligible = await isMediaAssetRuntimeEligible({
    asset: row.asset,
    version: row.version,
  })
  if (!eligible.eligible) {
    return { ok: false, reasonCode: 'approved_media_ineligible' }
  }
  if (row.version.fileSha256 !== expectedSha256) {
    return { ok: false, reasonCode: 'approved_media_hash_changed' }
  }
  if (!isScopeApplicable(row.asset, context)) {
    return { ok: false, reasonCode: 'approved_media_scope_inapplicable' }
  }
  if (!isLanguageCompatible(row.version.language, context.language)) {
    return { ok: false, reasonCode: 'approved_media_language_incompatible' }
  }
  if (!isValidStorageKey(row.version.storageKey)) {
    return { ok: false, reasonCode: 'approved_media_storage_ref_invalid' }
  }
  // AUTHORITATIVE kind: the asset's own declared kind, cross-checked
  // against the version's allowlisted mime. Duration metadata is
  // evidence about a video's length, never evidence about what the
  // asset IS — a video with no recorded duration must not quietly
  // become a still, and a still with a stray duration must not quietly
  // become a clip.
  const assetKind = row.asset.assetKind
  if (assetKind !== 'IMAGE' && assetKind !== 'VIDEO') {
    return { ok: false, reasonCode: 'approved_media_not_visual' }
  }
  if (!Object.hasOwn(MEDIA_MIME_TYPES[assetKind], row.version.mimeType)) {
    return { ok: false, reasonCode: 'approved_media_mime_kind_mismatch' }
  }
  let sourceDurationMs: number | null = null
  if (assetKind === 'VIDEO') {
    if (
      row.version.durationSeconds == null ||
      row.version.durationSeconds <= 0
    ) {
      // A clip of unknown length cannot be trimmed or held correctly;
      // planning around a guess would either cut approved footage or
      // freeze on a frame nobody chose.
      return { ok: false, reasonCode: 'approved_video_duration_unknown' }
    }
    sourceDurationMs = row.version.durationSeconds * 1000
  }
  // Independent of the eligibility check: prove the bytes behind the
  // reference hash to the MANIFEST's frozen value, not merely to the
  // row's own copy of it.
  const bytes = await getMediaStorage().get(row.version.storageKey)
  if (!bytes || bytes.length === 0) {
    return { ok: false, reasonCode: 'approved_media_missing_from_storage' }
  }
  if (computeFileSha256(bytes) !== expectedSha256) {
    return { ok: false, reasonCode: 'approved_media_hash_mismatch' }
  }
  return {
    ok: true,
    source: {
      sceneId,
      kind: 'APPROVED_MEDIA',
      mediaKind: assetKind,
      mediaAssetVersionId,
      visualTaskId: null,
      storageKey: row.version.storageKey,
      sha256: expectedSha256,
      mimeType: row.version.mimeType,
      durationMs: sourceDurationMs,
    },
  }
}

/**
 * Re-proves ONE generated visual: the EXACT Step 14 task row for this
 * scene must exist under this manifest snapshot, have SUCCEEDED, and
 * its stored artifact must still verify byte-for-byte.
 */
async function verifyGeneratedVisual(
  generationJobId: number,
  manifestSnapshotId: number,
  manifest: GenerationManifest,
  sceneId: string,
): Promise<{ ok: true; source: VerifiedVisualSource } | { ok: false; reasonCode: string }> {
  const task = manifest.visualTasks.find((entry) => entry.sceneId === sceneId)
  if (!task) return { ok: false, reasonCode: 'visual_task_not_in_manifest' }
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationVisualTasks)
      .where(
        and(
          eq(prayerGenerationVisualTasks.generationJobId, generationJobId),
          eq(prayerGenerationVisualTasks.manifestSnapshotId, manifestSnapshotId),
          eq(prayerGenerationVisualTasks.taskId, task.taskId),
        ),
      )
      .limit(1)
  ).at(0)
  if (!row) return { ok: false, reasonCode: 'visual_task_row_missing' }
  if (row.sceneId !== task.sceneId || row.idempotencyKey !== task.idempotencyKey) {
    return { ok: false, reasonCode: 'visual_task_identity_mismatch' }
  }
  if (row.status !== 'SUCCEEDED') {
    return { ok: false, reasonCode: 'visual_task_not_succeeded' }
  }
  // The SAME artifact rule Step 14's own finalization applies — never a
  // second, looser re-implementation here.
  const verified = await verifyStoredArtifact(
    {
      artifactStorageRef: row.artifactStorageRef,
      artifactSha256: row.artifactSha256,
      artifactMimeType: row.artifactMimeType,
      artifactDurationMs: row.artifactDurationMs,
    },
    task,
  )
  if (!verified.ok) {
    return { ok: false, reasonCode: `visual_${verified.reasonCode}` }
  }
  return {
    ok: true,
    source: {
      sceneId,
      kind: 'GENERATED_ARTIFACT',
      // A generated scene is always a CLIP, and Step 14's own
      // verification already proved its duration is present and
      // positive — there is no unknown-length case to handle here.
      mediaKind: 'VIDEO',
      mediaAssetVersionId: null,
      visualTaskId: task.taskId,
      storageKey: row.artifactStorageRef!,
      sha256: row.artifactSha256!,
      mimeType: row.artifactMimeType!,
      durationMs: row.artifactDurationMs,
    },
  }
}

/**
 * Re-proves ONE audio requirement. TTS results must trace to the EXACT
 * Step 15 task row (identity + idempotency key + stored bytes); human
 * recordings go back through Step 15's own current-authority
 * verification and must still be byte-intact, with a KNOWN length —
 * unknown-length sacred audio cannot be placed on a timeline without
 * risking truncation, so it fails closed.
 */
async function verifyAudioRequirement(
  generationJobId: number,
  manifestSnapshotId: number,
  manifestSha256: string,
  requirement: ManifestAudioRequirement,
  context: RenderContext,
): Promise<{ ok: true; source: VerifiedAudioSource } | { ok: false; reasonCode: string }> {
  const requirementId = requirement.requirementId
  if (requirementId == null) {
    return { ok: false, reasonCode: 'incomplete_audio_requirement' }
  }
  if (requirement.mode === 'TTS_PENDING') {
    const row = (
      await getDb()
        .select()
        .from(prayerGenerationAudioTasks)
        .where(
          and(
            eq(prayerGenerationAudioTasks.generationJobId, generationJobId),
            eq(
              prayerGenerationAudioTasks.manifestSnapshotId,
              manifestSnapshotId,
            ),
            eq(prayerGenerationAudioTasks.requirementId, requirementId),
          ),
        )
        .limit(1)
    ).at(0)
    if (!row) return { ok: false, reasonCode: 'audio_task_row_missing' }
    if (
      row.sceneId !== requirement.sceneId ||
      row.idempotencyKey !==
        computeAudioTaskIdempotencyKey({
          generationJobId,
          manifestSha256,
          requirementId,
        })
    ) {
      return { ok: false, reasonCode: 'audio_task_identity_mismatch' }
    }
    if (row.status !== 'SUCCEEDED') {
      return { ok: false, reasonCode: 'audio_task_not_succeeded' }
    }
    const verified = await verifyStoredAudioArtifact({
      artifactStorageRef: row.artifactStorageRef,
      artifactSha256: row.artifactSha256,
      artifactMimeType: row.artifactMimeType,
      artifactDurationMs: row.artifactDurationMs,
    })
    if (!verified.ok) {
      return { ok: false, reasonCode: `tts_${verified.reasonCode}` }
    }
    return {
      ok: true,
      source: {
        requirementId,
        sceneId: requirement.sceneId,
        kind: 'TTS',
        mediaAssetVersionId: null,
        storageKey: row.artifactStorageRef!,
        sha256: row.artifactSha256!,
        mimeType: row.artifactMimeType!,
        durationMs: row.artifactDurationMs!,
      },
    }
  }

  // EXISTING_HUMAN_AUDIO — Step 15's rule, unchanged and unduplicated.
  const verified = await verifyExistingHumanAudio(requirement, context)
  if (!verified.ok) {
    return { ok: false, reasonCode: `human_${verified.reasonCode}` }
  }
  const version = (
    await getDb()
      .select({
        storageKey: mediaAssetVersions.storageKey,
        mimeType: mediaAssetVersions.mimeType,
        durationSeconds: mediaAssetVersions.durationSeconds,
      })
      .from(mediaAssetVersions)
      .where(eq(mediaAssetVersions.id, verified.mediaAssetVersionId))
      .limit(1)
  ).at(0)
  if (!version) return { ok: false, reasonCode: 'human_audio_missing' }
  if (version.durationSeconds == null || version.durationSeconds <= 0) {
    // Placing audio of unknown length on a timeline could only be done
    // by guessing — and a guess that is too short truncates a sacred
    // recording. Fail closed instead.
    return { ok: false, reasonCode: 'human_audio_duration_unknown' }
  }
  return {
    ok: true,
    source: {
      requirementId,
      sceneId: requirement.sceneId,
      kind: 'EXISTING_HUMAN_AUDIO',
      mediaAssetVersionId: verified.mediaAssetVersionId,
      storageKey: version.storageKey,
      sha256: verified.fileSha256,
      mimeType: version.mimeType,
      durationMs: version.durationSeconds * 1000,
    },
  }
}

// --- Plan construction ------------------------------------------------------

function visualFitFor(input: {
  visualKind: RenderVisualKind
  mediaKind: RenderMediaKind
  sourceDurationMs: number | null
  windowMs: number
}): RenderVisualFit {
  // HOLD_PREVIOUS means exactly one thing: freeze the frame that was
  // last DISPLAYED. It is never a second chance to play the earlier
  // clip, so it can never resolve to TRIM or to an EXACT replay — the
  // source's own length is irrelevant to a scene that shows no new
  // footage at all.
  if (input.visualKind === 'HOLD_PREVIOUS') return 'HOLD_LAST_FRAME'
  // A still has no length of its own, whatever duration metadata may
  // claim: it is simply held for its window.
  if (input.mediaKind === 'IMAGE') return 'STILL_HOLD'
  // A clip's length is known by construction here (an unknown-length
  // video failed closed during verification), so this is a real
  // comparison rather than a guess.
  if (input.sourceDurationMs == null) return 'HOLD_LAST_FRAME'
  if (input.sourceDurationMs > input.windowMs) return 'TRIM'
  if (input.sourceDurationMs < input.windowMs) return 'HOLD_LAST_FRAME'
  return 'EXACT'
}

/**
 * Builds the deterministic render plan from CURRENT authority, after
 * proving every source.
 *
 * TIMELINE RECONCILIATION — the rule that decides everything here:
 *
 *   finalSegmentDuration = max(plannedSegmentDuration, actualAudioMs)
 *
 * Sacred audio is never truncated, time-stretched, sped up, looped,
 * rewritten or replaced by a synthesized substitute. So when a
 * recording runs longer than the window the storyboard planned, the
 * SEGMENT grows by exactly the overrun — the last split of that segment
 * absorbs it by holding its final approved visual — and every later
 * scene shifts deterministically by the accumulated offset. When the
 * audio is shorter, the planned visual window is kept as planned and
 * the remainder is simply silent; nothing is stretched to fill it.
 *
 * Audio belongs to the FULL original recipe segment, so a segment that
 * was split into several visual scenes still has exactly ONE audio
 * entry, placed once at the segment's reconciled start.
 */
export function buildRenderPlan(input: {
  storyboard: GenerationStoryboard
  manifest: GenerationManifest
  manifestSnapshotId: number
  visualBySceneId: Map<string, VerifiedVisualSource>
  audioBySegment: Map<number, VerifiedAudioSource>
  audioRequirementBySegment: Map<number, ManifestAudioRequirement>
}): { ok: true; plan: RenderPlan } | { ok: false; reasonCode: string } {
  const { storyboard, manifest } = input
  const scenes: Array<RenderPlanScene> = []
  const audio: Array<RenderPlanAudioSegment> = []

  const ordered = [...storyboard.scenes].sort((a, b) => a.order - b.order)
  if (ordered.length === 0) return { ok: false, reasonCode: 'empty_storyboard' }

  // Group scenes by their ORIGINAL recipe segment: reconciliation is a
  // per-segment decision, never a per-split one.
  const segments: Array<{ index: number; scenes: Array<StoryboardScene> }> = []
  for (const scene of ordered) {
    const last = segments.at(-1)
    if (last && last.index === scene.recipeSegmentIndex) {
      last.scenes.push(scene)
    } else {
      segments.push({ index: scene.recipeSegmentIndex, scenes: [scene] })
    }
  }

  let cursorMs = 0
  /** The most recent scene that actually carried a picture — what a
   * HOLD_PREVIOUS scene holds. */
  let lastVisualSceneId: string | null = null

  for (const segment of segments) {
    const plannedSegmentMs = segment.scenes.reduce(
      (total, scene) => total + scene.durationMs,
      0,
    )
    const audioSource = input.audioBySegment.get(segment.index)
    const actualAudioMs = audioSource?.durationMs ?? 0
    const finalSegmentMs = Math.max(plannedSegmentMs, actualAudioMs)
    const overrunMs = finalSegmentMs - plannedSegmentMs
    const segmentStartMs = cursorMs

    for (const [position, scene] of segment.scenes.entries()) {
      const isLastSplit = position === segment.scenes.length - 1
      const durationMs = scene.durationMs + (isLastSplit ? overrunMs : 0)

      let visualKind: RenderVisualKind
      let visualSourceSceneId: string
      let source: VerifiedVisualSource | undefined
      if (scene.sourceMode === 'HOLD_PREVIOUS') {
        if (lastVisualSceneId == null) {
          // Nothing to hold: the very first scene cannot inherit a
          // picture that never existed, and inventing one is exactly
          // what Step 16 must never do.
          return { ok: false, reasonCode: 'leading_hold_previous' }
        }
        visualKind = 'HOLD_PREVIOUS'
        visualSourceSceneId = lastVisualSceneId
        source = input.visualBySceneId.get(lastVisualSceneId)
      } else {
        source = input.visualBySceneId.get(scene.sceneId)
        if (!source) return { ok: false, reasonCode: 'unresolved_scene_visual' }
        visualKind =
          source.kind === 'APPROVED_MEDIA'
            ? 'APPROVED_MEDIA'
            : 'GENERATED_ARTIFACT'
        visualSourceSceneId = scene.sceneId
        lastVisualSceneId = scene.sceneId
      }
      if (!source) return { ok: false, reasonCode: 'unresolved_scene_visual' }

      scenes.push({
        sceneId: scene.sceneId,
        order: scenes.length,
        recipeSegmentIndex: scene.recipeSegmentIndex,
        splitIndex: scene.splitIndex,
        splitCount: scene.splitCount,
        visualKind,
        visualSourceSceneId,
        mediaAssetVersionId: source.mediaAssetVersionId,
        visualTaskId: source.visualTaskId,
        visualSha256: source.sha256,
        visualMimeType: source.mimeType,
        visualSourceDurationMs: source.durationMs,
        visualFit: visualFitFor({
          visualKind,
          mediaKind: source.mediaKind,
          sourceDurationMs: source.durationMs,
          windowMs: durationMs,
        }),
        startMs: cursorMs,
        endMs: cursorMs + durationMs,
        durationMs,
        plannedDurationMs: scene.durationMs,
      })
      cursorMs += durationMs
    }

    if (audioSource) {
      const requirement = input.audioRequirementBySegment.get(segment.index)
      if (!requirement) {
        return { ok: false, reasonCode: 'audio_requirement_unresolved' }
      }
      audio.push({
        requirementId: audioSource.requirementId,
        sceneId: audioSource.sceneId,
        recipeSegmentIndex: segment.index,
        kind: audioSource.kind,
        mediaAssetVersionId: audioSource.mediaAssetVersionId,
        audioSha256: audioSource.sha256,
        audioMimeType: audioSource.mimeType,
        durationMs: audioSource.durationMs,
        plannedWindowMs: plannedSegmentMs,
        finalWindowMs: finalSegmentMs,
        startMs: segmentStartMs,
        // Played once, in full, unaltered — never looped to fill a
        // longer window and never cut to fit a shorter one.
        endMs: segmentStartMs + audioSource.durationMs,
      })
    }
  }

  // Every audio requirement in the manifest must have been placed.
  if (audio.length !== manifest.audioRequirements.length) {
    return { ok: false, reasonCode: 'audio_requirement_count_mismatch' }
  }
  if (scenes.length !== storyboard.scenes.length) {
    return { ok: false, reasonCode: 'scene_count_mismatch' }
  }
  if (cursorMs <= 0) return { ok: false, reasonCode: 'empty_timeline' }
  if (cursorMs > MAX_RENDER_MS) {
    // LOUD, never silent: shortening this would mean cutting approved
    // content, which Step 16 has no authority to do.
    return { ok: false, reasonCode: 'render_duration_ceiling_exceeded' }
  }

  const body = {
    schemaVersion: RENDER_PLAN_SCHEMA_VERSION,
    generationJobId: storyboard.generationJobId,
    manifestSnapshotId: input.manifestSnapshotId,
    manifestSha256: manifest.manifestSha256,
    storyboardSha256: storyboard.storyboardSha256,
    scenes,
    audio,
    sceneCount: scenes.length,
    totalDurationMs: cursorMs,
    outputMimeType: 'video/mp4',
  }
  return {
    ok: true,
    plan: { ...body, renderPlanSha256: computeRenderPlanSha256(body) },
  }
}

/**
 * Verifies EVERY source against current authority and builds the plan.
 * A missing, tampered or withdrawn source means NO RENDER — never a
 * partial one, never a substitute.
 */
export async function buildValidatedRenderPlan(
  generationJobId: number,
  manifestSnapshotId: number,
  storyboard: GenerationStoryboard,
  manifest: GenerationManifest,
  context: RenderContext,
): Promise<BuiltRenderPlan> {
  const visualBySceneId = new Map<string, VerifiedVisualSource>()
  const approvedBySceneId = new Map(
    manifest.approvedMedia.map((entry) => [entry.sceneId, entry]),
  )

  for (const scene of storyboard.scenes) {
    if (scene.sourceMode === 'HOLD_PREVIOUS') continue
    if (scene.sourceMode === 'APPROVED_MEDIA') {
      const ref = approvedBySceneId.get(scene.sceneId)
      if (!ref) return { ok: false, reasonCode: 'approved_media_not_in_manifest' }
      const verified = await verifyApprovedMediaVisual(
        scene.sceneId,
        ref.mediaAssetVersionId,
        ref.fileSha256,
        context,
      )
      if (!verified.ok) return { ok: false, reasonCode: verified.reasonCode }
      visualBySceneId.set(scene.sceneId, verified.source)
      continue
    }
    const verified = await verifyGeneratedVisual(
      generationJobId,
      manifestSnapshotId,
      manifest,
      scene.sceneId,
    )
    if (!verified.ok) return { ok: false, reasonCode: verified.reasonCode }
    visualBySceneId.set(scene.sceneId, verified.source)
  }

  // Audio requirements are keyed to the scene that carries them; map
  // each back to its ORIGINAL recipe segment so the plan can place one
  // entry per segment regardless of how the visual was split.
  const segmentBySceneId = new Map(
    storyboard.scenes.map((scene) => [scene.sceneId, scene.recipeSegmentIndex]),
  )
  const audioBySegment = new Map<number, VerifiedAudioSource>()
  const audioRequirementBySegment = new Map<number, ManifestAudioRequirement>()
  for (const requirement of manifest.audioRequirements) {
    const segmentIndex = segmentBySceneId.get(requirement.sceneId)
    if (segmentIndex == null) {
      return { ok: false, reasonCode: 'audio_scene_not_in_storyboard' }
    }
    if (audioBySegment.has(segmentIndex)) {
      // Two audio entries for one segment would mean the same sacred
      // recording played twice; the manifest builder never emits that.
      return { ok: false, reasonCode: 'duplicate_audio_for_segment' }
    }
    const verified = await verifyAudioRequirement(
      generationJobId,
      manifestSnapshotId,
      manifest.manifestSha256,
      requirement,
      context,
    )
    if (!verified.ok) return { ok: false, reasonCode: verified.reasonCode }
    audioBySegment.set(segmentIndex, verified.source)
    audioRequirementBySegment.set(segmentIndex, requirement)
  }

  const built = buildRenderPlan({
    storyboard,
    manifest,
    manifestSnapshotId,
    visualBySceneId,
    audioBySegment,
    audioRequirementBySegment,
  })
  if (!built.ok) return { ok: false, reasonCode: built.reasonCode }

  const sources: Array<RenderSourceRef> = []
  for (const [sceneId, source] of visualBySceneId) {
    sources.push({
      refId: sceneId,
      role: 'VISUAL',
      storageKey: source.storageKey,
      sha256: source.sha256,
      mimeType: source.mimeType,
      durationMs: source.durationMs,
    })
  }
  for (const source of audioBySegment.values()) {
    sources.push({
      refId: source.requirementId,
      role: 'AUDIO',
      storageKey: source.storageKey,
      sha256: source.sha256,
      mimeType: source.mimeType,
      durationMs: source.durationMs,
    })
  }
  sources.sort((a, b) => (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0))
  return { ok: true, plan: built.plan, sources }
}

/** Compiles the in-memory render request. Adds NOTHING the plan does
 * not already say — the engine composes the plan, it does not
 * interpret it. */
export function compileRenderRequest(
  plan: RenderPlan,
  sources: Array<RenderSourceRef>,
): RenderRequest {
  return {
    renderPlanSha256: plan.renderPlanSha256,
    scenes: plan.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      startMs: scene.startMs,
      endMs: scene.endMs,
      durationMs: scene.durationMs,
      visualKind: scene.visualKind,
      visualRefId: scene.visualSourceSceneId,
      visualFit: scene.visualFit,
    })),
    audio: plan.audio.map((segment) => ({
      refId: segment.requirementId,
      startMs: segment.startMs,
      endMs: segment.endMs,
      durationMs: segment.durationMs,
    })),
    sources,
    totalDurationMs: plan.totalDurationMs,
    outputMimeType: plan.outputMimeType,
  }
}

// --- Render artifact --------------------------------------------------------

export type StoredRenderArtifactClaim = {
  artifactStorageRef: string | null
  artifactSha256: string | null
  artifactMimeType: string | null
  artifactDurationMs: number | null
}

export type StoredRenderArtifactVerification =
  | { ok: true }
  | { ok: false; reasonCode: string }

/** Re-proves a PERSISTED render artifact against PRIVATE storage: the
 * object exists, the bytes are non-empty, their fresh SHA-256 matches
 * the recorded hash, the mime is still allowlisted and the duration is
 * still bounded. Row metadata alone is only ever a claim. */
export async function verifyStoredRenderArtifact(
  claim: StoredRenderArtifactClaim,
): Promise<StoredRenderArtifactVerification> {
  const storageRef = claim.artifactStorageRef
  if (storageRef == null || !isValidStorageKey(storageRef)) {
    return { ok: false, reasonCode: 'artifact_storage_ref_invalid' }
  }
  if (claim.artifactSha256 == null || !HEX64.test(claim.artifactSha256)) {
    return { ok: false, reasonCode: 'artifact_hash_invalid' }
  }
  if (
    claim.artifactMimeType == null ||
    !isAllowedRenderMimeType(claim.artifactMimeType)
  ) {
    return { ok: false, reasonCode: 'artifact_mime_invalid' }
  }
  const durationMs = claim.artifactDurationMs
  if (durationMs == null || durationMs <= 0 || durationMs > MAX_RENDER_MS) {
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

/** Best-effort removal of a render artifact THIS worker just produced
 * and whose result was then rejected — lease lost, or the status CAS
 * lost to another worker. Nothing references those bytes and nothing
 * ever will. Never fatal. */
export async function discardRenderArtifact(storageRef: string): Promise<void> {
  if (!isValidStorageKey(storageRef)) return
  try {
    await getMediaStorage().remove(storageRef)
  } catch {
    // best-effort by contract — see MediaStorageProvider.remove
  }
}

async function verifyAndStoreRenderOutput(
  output: { bytes: Uint8Array; mimeType: string; durationMs: number },
  plan: RenderPlan,
  rendererIsMock: boolean,
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
  const extension = RENDER_MIME_EXTENSIONS[output.mimeType]
  if (!extension) return { ok: false, reasonCode: 'artifact_mime_invalid' }
  // Allowlisted is necessary but NOT sufficient: the plan committed to
  // one output type, and an engine that returned a different (even
  // perfectly legal) container did not render the plan that was
  // approved.
  if (output.mimeType !== plan.outputMimeType) {
    return { ok: false, reasonCode: 'artifact_mime_mismatch' }
  }
  // An engine crosses a trust boundary exactly like a provider does.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (!output.bytes || output.bytes.length === 0) {
    return { ok: false, reasonCode: 'artifact_empty' }
  }
  if (output.durationMs <= 0 || output.durationMs > MAX_RENDER_MS) {
    return { ok: false, reasonCode: 'artifact_duration_bound' }
  }
  // The rendered length must be the length the plan reconciled to. An
  // engine that returned something shorter would have cut approved
  // content; something longer would have invented time. A real
  // compositor gets the bounded frame/container envelope above and
  // nothing more; the mock is still held to the millisecond.
  if (
    !renderedDurationMatchesPlan({
      actualMs: output.durationMs,
      plannedMs: plan.totalDurationMs,
      rendererIsMock,
    })
  ) {
    return { ok: false, reasonCode: 'artifact_duration_mismatch' }
  }
  const fileSha256 = computeFileSha256(output.bytes)
  const { storageKey } = await getMediaStorage().put(output.bytes, extension)
  return {
    ok: true,
    storageKey,
    fileSha256,
    mimeType: output.mimeType,
    durationMs: output.durationMs,
  }
}

// --- Persistence ------------------------------------------------------------

export type LoadedRenderPlan =
  | {
      status: 'OK'
      snapshotId: number
      snapshotNumber: number
      manifestSnapshotId: number
      plan: RenderPlan
    }
  | { status: 'NOT_PLANNED' }
  | { status: 'INTEGRITY_FAILURE' }

/** Fail-closed loader: never rebuilds, never heals. */
export async function loadRenderPlanSnapshot(
  jobId: number,
): Promise<LoadedRenderPlan> {
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationRenderPlans)
      .where(eq(prayerGenerationRenderPlans.generationJobId, jobId))
      .orderBy(sql`${prayerGenerationRenderPlans.snapshotNumber} DESC`)
      .limit(1)
  ).at(0)
  if (!row) return { status: 'NOT_PLANNED' }
  if (sha256(row.planJsonText) !== row.payloadSha256) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.planJsonText)
  } catch {
    return { status: 'INTEGRITY_FAILURE' }
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !==
      RENDER_PLAN_SCHEMA_VERSION
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  const plan = parsed as RenderPlan
  // The plan's OWN canonical hash, recomputed — a row whose JSON was
  // edited and whose payload hash was recomputed still fails here.
  const { renderPlanSha256: _stored, ...body } = plan
  if (
    computeRenderPlanSha256(body) !== plan.renderPlanSha256 ||
    plan.renderPlanSha256 !== row.renderPlanSha256
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  return {
    status: 'OK',
    snapshotId: row.id,
    snapshotNumber: row.snapshotNumber,
    manifestSnapshotId: row.manifestSnapshotId,
    plan,
  }
}

/**
 * Appends the immutable render-plan snapshot under the SAME lease
 * discipline every other stage uses — or, when an identical plan
 * already exists for this job and manifest, reuses it. Determinism is
 * what makes that reuse safe: the same authority always produces the
 * same hash, so a retry re-plans to the same row instead of appending a
 * near-duplicate.
 */
export async function persistRenderPlanUnderLease(
  jobId: number,
  leaseToken: string,
  plan: RenderPlan,
  manifestSnapshotId: number,
  clock: GenerationClock,
): Promise<{ snapshotId: number; snapshotNumber: number } | null> {
  const planJsonText = JSON.stringify(plan)
  const payloadSha256 = sha256(planJsonText)
  return getDb().transaction(async (tx) => {
    const job = (
      await tx
        .select()
        .from(prayerGenerationJobs)
        .where(eq(prayerGenerationJobs.id, jobId))
        .limit(1)
        .for('update')
    ).at(0)
    // Authoritative time: read ONLY after the row lock is held.
    const freshNow = clock.now()
    if (
      !job ||
      job.status !== 'RENDERING' ||
      job.leaseToken !== leaseToken ||
      job.leaseExpiresAt == null ||
      job.leaseExpiresAt <= freshNow
    ) {
      return null
    }
    const existing = (
      await tx
        .select({
          id: prayerGenerationRenderPlans.id,
          snapshotNumber: prayerGenerationRenderPlans.snapshotNumber,
        })
        .from(prayerGenerationRenderPlans)
        .where(
          and(
            eq(prayerGenerationRenderPlans.generationJobId, jobId),
            eq(
              prayerGenerationRenderPlans.manifestSnapshotId,
              manifestSnapshotId,
            ),
            eq(
              prayerGenerationRenderPlans.renderPlanSha256,
              plan.renderPlanSha256,
            ),
          ),
        )
        .limit(1)
    ).at(0)
    if (existing) {
      return { snapshotId: existing.id, snapshotNumber: existing.snapshotNumber }
    }
    const latest = (
      await tx
        .select({ snapshotNumber: prayerGenerationRenderPlans.snapshotNumber })
        .from(prayerGenerationRenderPlans)
        .where(eq(prayerGenerationRenderPlans.generationJobId, jobId))
        .orderBy(sql`${prayerGenerationRenderPlans.snapshotNumber} DESC`)
        .limit(1)
        .for('update')
    ).at(0)
    const snapshotNumber = (latest?.snapshotNumber ?? 0) + 1
    const inserted = await tx.insert(prayerGenerationRenderPlans).values({
      generationJobId: jobId,
      manifestSnapshotId,
      snapshotNumber,
      planJsonText,
      payloadSha256,
      renderPlanSha256: plan.renderPlanSha256,
      manifestSha256: plan.manifestSha256,
      sceneCount: plan.sceneCount,
      audioSegmentCount: plan.audio.length,
      totalDurationMs: plan.totalDurationMs,
    })
    return { snapshotId: inserted[0].insertId, snapshotNumber }
  })
}

async function ensureRenderResultRow(
  jobId: number,
  manifestSnapshotId: number,
  renderPlanSnapshotId: number,
  idempotencyKey: string,
  renderPlanSha256: string,
  engine: { code: string; version: string; isMock: boolean },
): Promise<typeof prayerGenerationRenderResults.$inferSelect> {
  const db = getDb()
  const find = async () =>
    (
      await db
        .select()
        .from(prayerGenerationRenderResults)
        .where(
          and(
            eq(prayerGenerationRenderResults.generationJobId, jobId),
            eq(
              prayerGenerationRenderResults.manifestSnapshotId,
              manifestSnapshotId,
            ),
            eq(
              prayerGenerationRenderResults.renderPlanSnapshotId,
              renderPlanSnapshotId,
            ),
          ),
        )
        .limit(1)
    ).at(0)
  const existing = await find()
  if (existing) return existing
  try {
    await db.insert(prayerGenerationRenderResults).values({
      generationJobId: jobId,
      manifestSnapshotId,
      renderPlanSnapshotId,
      idempotencyKey,
      rendererCode: engine.code,
      rendererVersion: engine.version,
      rendererIsMock: engine.isMock ? 1 : 0,
      renderPlanSha256,
      status: 'PENDING',
    })
  } catch {
    // A duplicate insert just means another worker created it first.
  }
  const row = await find()
  if (!row) throw new GenerationJobError('Render result row vanished.')
  return row
}

/** Everything a downstream stage needs about a completed render, and
 * nothing it does not: identities, the immutable plan, and the result
 * row. No bytes, no signed URLs, no provider payloads. */
export interface VerifiedCompletedRender {
  manifestSnapshotId: number
  planSnapshotId: number
  plan: RenderPlan
  result: typeof prayerGenerationRenderResults.$inferSelect
}

export type CompletedRenderVerification =
  | { ok: true; verified: VerifiedCompletedRender }
  | { ok: false; errorCode: string; detail: string | null }

/**
 * THE completed-render proof, in one place.
 *
 * This is what Step 16's own final gate runs before RENDERING →
 * UPLOADING, and it is the SAME function Step 17 re-runs before it
 * uploads anything — deliberately shared rather than reimplemented,
 * because a second, slightly-weaker copy of a governance check is how
 * two stages come to disagree about what "verified" means.
 *
 * Proves, against CURRENT authority:
 * - the manifest still validates;
 * - the persisted render plan still passes its own integrity check AND
 *   is still the plan current authority produces (rebuilt and compared
 *   by hash, which also re-verifies every visual/audio source);
 * - the render result belongs to exactly this job, manifest snapshot,
 *   plan snapshot, plan hash and idempotency key;
 * - it SUCCEEDED, and its stored local artifact still exists with
 *   matching bytes, hash, mime and duration; and
 * - the renderer that produced it is still resolvable and still
 *   permitted in this environment (so a mock artifact can never be
 *   walked forward in production).
 *
 * `expected` lets a caller that already holds in-cycle identities
 * cross-check them, catching a snapshot that moved underneath it.
 */
export async function verifyCompletedRender(
  generationJobId: number,
  context: RenderContext,
  expected: {
    manifestSnapshotId?: number
    planSnapshotId?: number
    renderResultId?: number
  } = {},
): Promise<CompletedRenderVerification> {
  const revalidated = await loadAndValidateGenerationManifest(generationJobId)
  if (revalidated.status !== 'VALID') {
    return {
      ok: false,
      errorCode: 'MANIFEST_INVALID_AT_COMPLETION',
      detail:
        revalidated.status === 'INVALID'
          ? revalidated.reasons.join(', ').slice(0, 500)
          : revalidated.status,
    }
  }
  const manifestRow = await loadGenerationManifestSnapshot(generationJobId)
  if (manifestRow.status !== 'OK') {
    return { ok: false, errorCode: 'MANIFEST_UNREADABLE', detail: null }
  }
  const manifestSnapshotId = manifestRow.snapshotId
  if (
    expected.manifestSnapshotId != null &&
    expected.manifestSnapshotId !== manifestSnapshotId
  ) {
    return {
      ok: false,
      errorCode: 'RENDER_PLAN_STALE',
      detail: 'manifest_snapshot_moved',
    }
  }

  const loadedPlan = await loadRenderPlanSnapshot(generationJobId)
  if (loadedPlan.status !== 'OK') {
    return {
      ok: false,
      errorCode: 'RENDER_PLAN_UNREADABLE',
      detail: loadedPlan.status,
    }
  }
  const rebuilt = await buildValidatedRenderPlan(
    generationJobId,
    manifestSnapshotId,
    revalidated.storyboard,
    revalidated.manifest,
    context,
  )
  if (!rebuilt.ok) {
    return {
      ok: false,
      errorCode: 'RENDER_SOURCE_INVALID',
      detail: rebuilt.reasonCode,
    }
  }
  if (
    rebuilt.plan.renderPlanSha256 !== loadedPlan.plan.renderPlanSha256 ||
    loadedPlan.manifestSnapshotId !== manifestSnapshotId ||
    (expected.planSnapshotId != null &&
      expected.planSnapshotId !== loadedPlan.snapshotId)
  ) {
    return {
      ok: false,
      errorCode: 'RENDER_PLAN_STALE',
      detail: 'plan_no_longer_current',
    }
  }

  const result = (
    await getDb()
      .select()
      .from(prayerGenerationRenderResults)
      .where(
        and(
          eq(prayerGenerationRenderResults.generationJobId, generationJobId),
          eq(
            prayerGenerationRenderResults.manifestSnapshotId,
            manifestSnapshotId,
          ),
          eq(
            prayerGenerationRenderResults.renderPlanSnapshotId,
            loadedPlan.snapshotId,
          ),
        ),
      )
      .limit(1)
  ).at(0)
  if (!result) {
    return { ok: false, errorCode: 'RENDER_RESULT_MISSING', detail: null }
  }
  if (
    (expected.renderResultId != null && expected.renderResultId !== result.id) ||
    result.generationJobId !== generationJobId ||
    result.manifestSnapshotId !== manifestSnapshotId ||
    result.renderPlanSnapshotId !== loadedPlan.snapshotId ||
    result.renderPlanSha256 !== loadedPlan.plan.renderPlanSha256 ||
    result.idempotencyKey !==
      computeRenderIdempotencyKey({
        generationJobId,
        manifestSha256: loadedPlan.plan.manifestSha256,
        renderPlanSha256: loadedPlan.plan.renderPlanSha256,
      })
  ) {
    return {
      ok: false,
      errorCode: 'RENDER_RESULT_IDENTITY_MISMATCH',
      detail: null,
    }
  }
  if (result.status !== 'SUCCEEDED') {
    return {
      ok: false,
      errorCode: 'RENDER_RESULT_NOT_SUCCEEDED',
      detail: result.status,
    }
  }
  const artifact = await verifyStoredRenderArtifact(result)
  if (!artifact.ok) {
    return {
      ok: false,
      errorCode: 'RENDER_ARTIFACT_INVALID',
      detail: artifact.reasonCode,
    }
  }
  if (
    result.artifactDurationMs == null ||
    !renderedDurationMatchesPlan({
      actualMs: result.artifactDurationMs,
      plannedMs: loadedPlan.plan.totalDurationMs,
      // The renderer that ACTUALLY produced this artifact, read from
      // the row — never the engine that happens to be active now.
      rendererIsMock: result.rendererIsMock === 1,
    })
  ) {
    return {
      ok: false,
      errorCode: 'RENDER_ARTIFACT_INVALID',
      detail: 'artifact_duration_mismatch',
    }
  }
  if (result.artifactMimeType !== loadedPlan.plan.outputMimeType) {
    return {
      ok: false,
      errorCode: 'RENDER_ARTIFACT_INVALID',
      detail: 'artifact_mime_mismatch',
    }
  }
  const producingEngine = resolveRenderEngine(result.rendererCode)
  if (!producingEngine) {
    return {
      ok: false,
      errorCode: 'RENDERER_NOT_PERMITTED',
      detail: 'renderer_code_mismatch',
    }
  }
  const stillAllowed = checkRenderEngineAllowed(producingEngine)
  if (!stillAllowed.ok) {
    return {
      ok: false,
      errorCode: 'RENDERER_NOT_PERMITTED',
      detail: stillAllowed.reasonCode,
    }
  }
  return {
    ok: true,
    verified: {
      manifestSnapshotId,
      planSnapshotId: loadedPlan.snapshotId,
      plan: loadedPlan.plan,
      result,
    },
  }
}

// --- Execution --------------------------------------------------------------

export type RenderOutcome =
  | { status: 'IDLE' }
  | { status: 'COMPLETE'; jobId: number }
  | { status: 'RETRY_SCHEDULED'; jobId: number; errorCode: string }
  | { status: 'FAILED'; jobId: number; errorCode: string }
  | { status: 'LEASE_LOST'; jobId: number }

export interface RenderDependencies {
  /** Injectable ONLY so a test can model a slow/failing engine; the
   * default is the registry's active engine. */
  render?: (
    request: RenderRequest,
  ) => Promise<{ bytes: Uint8Array; mimeType: string; durationMs: number }>
}

/**
 * One render cycle: claim a RENDERING (or resuming RETRYING) job,
 * revalidate the manifest AND every source, build and persist the
 * immutable plan, render it through the engine boundary, verify and
 * store the artifact, then finalize RENDERING → UPLOADING behind a
 * full re-proof.
 *
 * Rendering can be long-running, so the periodic lease renewal stays
 * active throughout and explicit heartbeats fence the render call on
 * both sides: a worker that has lost its lease never starts a render,
 * and a render that finished after the lease went away is never
 * accepted (its artifact is removed rather than orphaned).
 *
 * NOTHING IS UPLOADED. UPLOADING means only that a verified LOCAL
 * artifact exists for Step 17 to take up.
 */
export async function runRenderOnce(
  workerId: string,
  clock: GenerationClock,
  dependencies: RenderDependencies = {},
): Promise<RenderOutcome> {
  const claimed = await claimNextRenderJob(workerId, clock)
  if (!claimed) return { status: 'IDLE' }
  const { job, leaseToken } = claimed
  const attempt = job.attemptCount + 1

  const heartbeat = async (): Promise<boolean> =>
    renewGenerationLease(job.id, leaseToken, clock)
  // Rendering is the longest-running stage: keep renewing throughout.
  const heartbeatTimer = setInterval(
    () => {
      void renewGenerationLease(job.id, leaseToken, clock).catch(
        () => undefined,
      )
    },
    Math.max(1_000, Math.floor(DEFAULT_LEASE_MS / 3)),
  )

  const fail = async (
    code: string,
    detail: string | null,
  ): Promise<RenderOutcome> => {
    const outcome = await scheduleRetryOrFail(
      job,
      leaseToken,
      clock,
      code,
      detail,
      'RENDERING',
    )
    if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
    return outcome === 'FAILED'
      ? { status: 'FAILED', jobId: job.id, errorCode: code }
      : { status: 'RETRY_SCHEDULED', jobId: job.id, errorCode: code }
  }

  try {
    if (job.status === 'RETRYING') {
      const resumed = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'RETRYING',
        'RENDERING',
        clock,
        {
          eventCode: 'render_resumed',
          attemptNumber: attempt,
          patch: { resumeStatus: null },
        },
      )
      if (!resumed) return { status: 'LEASE_LOST', jobId: job.id }
    }
    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

    const context: RenderContext = {
      serviceId: job.serviceIdSnapshot,
      sacredHouseId: job.sacredHouseIdSnapshot,
      language: job.languageSnapshot,
    }

    const validated = await loadAndValidateGenerationManifest(job.id)
    if (validated.status !== 'VALID') {
      return fail(
        'MANIFEST_INVALID',
        validated.status === 'INVALID'
          ? validated.reasons.join(', ').slice(0, 500)
          : validated.status,
      )
    }
    const manifestRow = await loadGenerationManifestSnapshot(job.id)
    if (manifestRow.status !== 'OK') {
      return fail('MANIFEST_UNREADABLE', null)
    }
    const manifestSnapshotId = manifestRow.snapshotId

    const built = await buildValidatedRenderPlan(
      job.id,
      manifestSnapshotId,
      validated.storyboard,
      validated.manifest,
      context,
    )
    if (!built.ok) return fail('RENDER_SOURCE_INVALID', built.reasonCode)

    const planSnapshot = await persistRenderPlanUnderLease(
      job.id,
      leaseToken,
      built.plan,
      manifestSnapshotId,
      clock,
    )
    if (!planSnapshot) return { status: 'LEASE_LOST', jobId: job.id }

    const engine = getRenderEngine()
    const allowed = checkRenderEngineAllowed(engine)
    if (!allowed.ok) return fail('RENDERER_NOT_PERMITTED', allowed.reasonCode)

    const idempotencyKey = computeRenderIdempotencyKey({
      generationJobId: job.id,
      manifestSha256: built.plan.manifestSha256,
      renderPlanSha256: built.plan.renderPlanSha256,
    })
    const row = await ensureRenderResultRow(
      job.id,
      manifestSnapshotId,
      planSnapshot.snapshotId,
      idempotencyKey,
      built.plan.renderPlanSha256,
      engine,
    )
    // IDENTITY BEFORE SPEND. The row we are about to render into must
    // BE this job's result for this manifest snapshot and this exact
    // plan. ensureRenderResultRow looks a row up by that triple, so a
    // disagreement here means the row was altered after it was
    // created; rendering into it would attach an artifact to an
    // identity we cannot vouch for. Discovering that at finalization
    // would be far too late — the render would already have happened.
    const identityFailure =
      row.generationJobId !== job.id
        ? 'result_job_mismatch'
        : row.manifestSnapshotId !== manifestSnapshotId
          ? 'result_manifest_mismatch'
          : row.renderPlanSnapshotId !== planSnapshot.snapshotId
            ? 'result_plan_snapshot_mismatch'
            : row.renderPlanSha256 !== built.plan.renderPlanSha256
              ? 'result_plan_hash_mismatch'
              : row.idempotencyKey !== idempotencyKey
                ? 'result_idempotency_mismatch'
                : null
    if (identityFailure != null) {
      return fail('RENDER_RESULT_IDENTITY_MISMATCH', identityFailure)
    }

    // IDEMPOTENCY: an already-SUCCEEDED result for this exact authority
    // is never re-rendered. A deterministic retry converges on the SAME
    // row and the SAME artifact instead of producing a second one.
    if (row.status !== 'SUCCEEDED') {
      const statusAtRead = row.status
      const doRender = dependencies.render ?? engine.render.bind(engine)
      const request = compileRenderRequest(built.plan, built.sources)

      const started = await getDb()
        .update(prayerGenerationRenderResults)
        .set({
          status: 'RUNNING',
          attemptCount: row.attemptCount + 1,
          startedAt: clock.now(),
          lastErrorCode: null,
          lastErrorMessage: null,
        })
        .where(
          and(
            eq(prayerGenerationRenderResults.id, row.id),
            eq(prayerGenerationRenderResults.status, statusAtRead),
          ),
        )
      if (started[0].affectedRows !== 1) {
        // Another worker owns this render right now — never race it.
        return fail('RENDER_ALREADY_RUNNING', null)
      }

      if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
      let output
      try {
        output = await doRender(request)
      } catch (error) {
        const code =
          error instanceof RenderEngineError ? error.code : 'render_failed'
        // STALE FAILURE FENCE. A render that threw may have taken long
        // enough for this worker to lose the job. Recording OUR verdict
        // then would overwrite whatever the newer owner has since done
        // with this row — a stale worker's failure is not news, it is
        // corruption. The status CAS on RUNNING alone is not enough:
        // the newer worker may legitimately have moved the row back to
        // RUNNING for its own attempt.
        if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
        await getDb()
          .update(prayerGenerationRenderResults)
          .set({
            status: 'FAILED',
            lastErrorCode: code.slice(0, 60),
            lastErrorMessage: sanitizeErrorMessage(error),
            completedAt: clock.now(),
          })
          .where(
            and(
              eq(prayerGenerationRenderResults.id, row.id),
              eq(prayerGenerationRenderResults.status, 'RUNNING'),
            ),
          )
        return fail('RENDER_FAILED', code.slice(0, 500))
      }
      // The render may have taken longer than the lease window.
      if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

      const stored = await verifyAndStoreRenderOutput(
        output,
        built.plan,
        engine.isMock,
      )
      if (!stored.ok) {
        // Same fence as the throw path above: a rejected result from a
        // worker that no longer owns the job is not a verdict anyone
        // should record.
        if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
        await getDb()
          .update(prayerGenerationRenderResults)
          .set({
            status: 'FAILED',
            lastErrorCode: stored.reasonCode.slice(0, 60),
            completedAt: clock.now(),
          })
          .where(
            and(
              eq(prayerGenerationRenderResults.id, row.id),
              eq(prayerGenerationRenderResults.status, 'RUNNING'),
            ),
          )
        return fail('RENDER_ARTIFACT_INVALID', stored.reasonCode)
      }

      // The bytes are on disk now, so from here every rejection must
      // clean up after itself.
      if (!(await heartbeat())) {
        await discardRenderArtifact(stored.storageKey)
        return { status: 'LEASE_LOST', jobId: job.id }
      }
      const accepted = await getDb()
        .update(prayerGenerationRenderResults)
        .set({
          status: 'SUCCEEDED',
          rendererCode: engine.code,
          rendererVersion: engine.version,
          rendererIsMock: engine.isMock ? 1 : 0,
          artifactSha256: stored.fileSha256,
          artifactMimeType: stored.mimeType,
          artifactDurationMs: stored.durationMs,
          artifactStorageRef: stored.storageKey,
          lastErrorCode: null,
          lastErrorMessage: null,
          completedAt: clock.now(),
        })
        .where(
          and(
            eq(prayerGenerationRenderResults.id, row.id),
            eq(prayerGenerationRenderResults.status, 'RUNNING'),
          ),
        )
      if (accepted[0].affectedRows !== 1) {
        // Someone else resolved this row while we rendered: our output
        // is referenced by nothing and never will be.
        await discardRenderArtifact(stored.storageKey)
        return fail('RENDER_RESULT_SUPERSEDED', null)
      }
    }

    // --- FINAL GATE ---------------------------------------------------
    // Never trust the checks from earlier in this same cycle.
    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

    // ONE shared proof, run again from scratch — the same function
    // Step 17 re-runs before it uploads anything.
    const verified = await verifyCompletedRender(job.id, context, {
      manifestSnapshotId,
      planSnapshotId: planSnapshot.snapshotId,
      renderResultId: row.id,
    })
    if (!verified.ok) return fail(verified.errorCode, verified.detail)

    if (!isLegalTransition('RENDERING', 'UPLOADING')) {
      throw new GenerationJobError('Illegal transition RENDERING → UPLOADING.')
    }
    const finalized = await transitionGenerationJobUnderLease(
      job.id,
      leaseToken,
      'RENDERING',
      'UPLOADING',
      clock,
      {
        eventCode: 'render_complete',
        attemptNumber: attempt,
        clearLease: true,
        patch: {
          attemptCount: attempt,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAttemptAt: null,
          resumeStatus: null,
        },
      },
    )
    return finalized
      ? { status: 'COMPLETE', jobId: job.id }
      : { status: 'LEASE_LOST', jobId: job.id }
  } catch (error) {
    return fail('RENDER_ERROR', sanitizeErrorMessage(error))
  } finally {
    clearInterval(heartbeatTimer)
  }
}
