import { createHash } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  prayerGenerationJobEvents,
  prayerGenerationJobs,
  prayerGenerationManifestSnapshots,
  prayerGenerationStoryboardSnapshots,
} from '@/db/schema'
import {
  DEFAULT_LEASE_MS,
  GenerationJobError,
  claimNextStoryboardJob,
  isLegalTransition,
  loadAndValidateGenerationRecipe,
  renewGenerationLease,
  sanitizeErrorMessage,
  scheduleRetryOrFail,
  transitionGenerationJobUnderLease,
} from './generation-jobs'
import { loadPublishedVisualBible } from './visual-bibles'
import type { GenerationClock } from './generation-jobs'
import type { VideoRecipe } from './video-recipes'

/**
 * Deterministic storyboard & provider-neutral generation manifest
 * (Phase One, Step 13).
 *
 *   STORYBOARDING job
 *   → revalidate the immutable Step 12 recipe snapshot (current authority)
 *   → deterministic storyboard (ordered scenes over the recipe timeline)
 *   → provider-neutral generation manifest (future tasks, no provider chosen)
 *   → persist both immutably → GENERATING_VISUALS
 *
 * GENERATING_VISUALS means ONLY: a validated manifest exists, ready for
 * a FUTURE visual executor. Step 13 selects no provider, calls no
 * provider (no Kling/OpenArt/TTS/Remotion/FFmpeg), spends nothing, and
 * NEVER invents spiritual or cultural detail: scenes are derived purely
 * from approved recipe segments, approved media and approved Visual
 * Bible rule references. Sacred bodies never enter a storyboard or
 * manifest under ANY external-AI policy.
 */

export const STORYBOARD_SCHEMA_VERSION = 'storyboard-v2'
export const MANIFEST_SCHEMA_VERSION = 'manifest-v2'

/** Presentational split target for long CONTENT visual windows. */
export const MAX_SCENE_MS = 15_000
/** Loud bounded ceiling — never a silent truncation. */
export const MAX_SCENES = 32
/** Normal (never forced) scene-count target from the canon. */
export const TARGET_SCENE_RANGE = { min: 8, max: 12 } as const

// --- Types ------------------------------------------------------------------

export type SceneSourceMode =
  'APPROVED_MEDIA' | 'GENERATION_REQUIRED' | 'HOLD_PREVIOUS'

export type SceneAudioMode = 'NONE' | 'EXISTING_HUMAN_AUDIO' | 'TTS_PENDING'

export interface StoryboardBibleRuleRef {
  ruleId: number
  category: string
  position: number
}

/** Provider-neutral, body-free generation intent. */
export interface SceneGenerationIntent {
  sacredHouseId: number
  serviceId: number
  contentType: string
  themeCode: string | null
  requestedDurationMs: number
  visualBibleVersionId: number
  visualBibleVersionNumber: number
  visualBibleSha256: string
  ruleRefs: Array<StoryboardBibleRuleRef>
  externalAiPolicy: string
  /** The future provider stage MAY retrieve the approved body
   * server-side after another authority validation — it is never
   * stored here. */
  textContextAllowed: boolean
  contentVersionId: number
  contentSha256: string
}

export interface SceneAudioRequirement {
  mode: SceneAudioMode
  /** EXISTING_HUMAN_AUDIO: the exact approved media Step 11 selected. */
  mediaAssetVersionId: number | null
  fileSha256: string | null
  /** TTS_PENDING: identity + policy only, never any speech text. */
  contentVersionId: number | null
  contentSha256: string | null
  language: string | null
  voicePolicy: string | null
  requirementId: string | null
  /** The WHOLE recipe-segment window this audio covers. A presentational
   * split attaches the requirement to the first sub-scene but never
   * shortens the window. NONE covers nothing. */
  segmentStartMs: number | null
  segmentEndMs: number | null
}

export interface StoryboardScene {
  sceneId: string
  order: number
  recipeSegmentIndex: number
  slotKey: string
  kind: 'CONTENT' | 'SILENCE'
  contentVersionId: number | null
  contentSha256: string | null
  contentType: string | null
  themeCode: string | null
  startMs: number
  endMs: number
  durationMs: number
  /** Presentational sub-scene index within one recipe segment. */
  splitIndex: number
  splitCount: number
  sourceMode: SceneSourceMode
  mediaAssetVersionId: number | null
  mediaAssetId: number | null
  mediaFileSha256: string | null
  mediaAssetKind: string | null
  generationIntent: SceneGenerationIntent | null
  audio: SceneAudioRequirement
  bibleRuleRefs: Array<StoryboardBibleRuleRef>
}

export interface GenerationStoryboard {
  schemaVersion: string
  generationJobId: number
  serviceId: number
  sacredHouseId: number
  language: string
  variationSeed: string
  recipeSnapshotId: number
  recipeSnapshotNumber: number
  recipeSha256: string
  templateVersionId: number
  templateDefinitionSha256: string
  visualBibleVersionId: number | null
  visualBibleVersionNumber: number | null
  visualBibleSha256: string | null
  scenes: Array<StoryboardScene>
  sceneCount: number
  totalDurationMs: number
  storyboardSha256: string
}

export interface ManifestVisualTask {
  taskId: string
  sceneId: string
  taskKind: 'GENERATE_VIDEO_SCENE'
  durationMs: number
  generationIntent: SceneGenerationIntent
  idempotencyKey: string
  requiresAuthorityRevalidation: true
}

export interface ManifestApprovedMediaRef {
  sceneId: string
  mediaAssetVersionId: number
  mediaAssetId: number
  fileSha256: string
  assetKind: string
  startMs: number
  endMs: number
}

export interface ManifestAudioRequirement extends SceneAudioRequirement {
  sceneId: string
  startMs: number
  endMs: number
}

export interface GenerationManifest {
  schemaVersion: string
  generationJobId: number
  storyboardSnapshotId: number
  storyboardSnapshotNumber: number
  storyboardSha256: string
  totalDurationMs: number
  visualTasks: Array<ManifestVisualTask>
  approvedMedia: Array<ManifestApprovedMediaRef>
  audioRequirements: Array<ManifestAudioRequirement>
  manifestSha256: string
}

// --- Canonical hashing ------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/** Stable-order canonical serialization of every planning decision. */
export function canonicalStoryboard(
  storyboard: Omit<GenerationStoryboard, 'storyboardSha256'>,
): string {
  return JSON.stringify({
    schemaVersion: storyboard.schemaVersion,
    generationJobId: storyboard.generationJobId,
    serviceId: storyboard.serviceId,
    sacredHouseId: storyboard.sacredHouseId,
    language: storyboard.language,
    variationSeed: storyboard.variationSeed,
    recipeSnapshotId: storyboard.recipeSnapshotId,
    recipeSnapshotNumber: storyboard.recipeSnapshotNumber,
    recipeSha256: storyboard.recipeSha256,
    templateVersionId: storyboard.templateVersionId,
    templateDefinitionSha256: storyboard.templateDefinitionSha256,
    visualBibleVersionId: storyboard.visualBibleVersionId,
    visualBibleVersionNumber: storyboard.visualBibleVersionNumber,
    visualBibleSha256: storyboard.visualBibleSha256,
    sceneCount: storyboard.sceneCount,
    totalDurationMs: storyboard.totalDurationMs,
    scenes: storyboard.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      order: scene.order,
      recipeSegmentIndex: scene.recipeSegmentIndex,
      slotKey: scene.slotKey,
      kind: scene.kind,
      contentVersionId: scene.contentVersionId,
      contentSha256: scene.contentSha256,
      contentType: scene.contentType,
      themeCode: scene.themeCode,
      startMs: scene.startMs,
      endMs: scene.endMs,
      durationMs: scene.durationMs,
      splitIndex: scene.splitIndex,
      splitCount: scene.splitCount,
      sourceMode: scene.sourceMode,
      mediaAssetVersionId: scene.mediaAssetVersionId,
      mediaAssetId: scene.mediaAssetId,
      mediaFileSha256: scene.mediaFileSha256,
      mediaAssetKind: scene.mediaAssetKind,
      generationIntent: scene.generationIntent,
      audio: scene.audio,
      bibleRuleRefs: scene.bibleRuleRefs,
    })),
  })
}

export function computeStoryboardSha256(
  storyboard: Omit<GenerationStoryboard, 'storyboardSha256'>,
): string {
  return sha256(canonicalStoryboard(storyboard))
}

export function canonicalManifest(
  manifest: Omit<GenerationManifest, 'manifestSha256'>,
): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    generationJobId: manifest.generationJobId,
    storyboardSnapshotId: manifest.storyboardSnapshotId,
    storyboardSnapshotNumber: manifest.storyboardSnapshotNumber,
    storyboardSha256: manifest.storyboardSha256,
    totalDurationMs: manifest.totalDurationMs,
    visualTasks: manifest.visualTasks,
    approvedMedia: manifest.approvedMedia,
    audioRequirements: manifest.audioRequirements,
  })
}

export function computeManifestSha256(
  manifest: Omit<GenerationManifest, 'manifestSha256'>,
): string {
  return sha256(canonicalManifest(manifest))
}

/** Deterministic idempotency key over a versioned canonical basis. */
export function computeVisualTaskIdempotencyKey(input: {
  generationJobId: number
  storyboardSha256: string
  sceneId: string
}): string {
  return sha256(
    `visual-task-v1|${input.generationJobId}|${input.storyboardSha256}|${input.sceneId}`,
  )
}

// --- Storyboard construction ------------------------------------------------

export type StoryboardBuildResult =
  | {
      status: 'OK'
      storyboard: GenerationStoryboard
      manifest: GenerationManifest
      recipeSnapshotId: number
    }
  | { status: 'RECIPE_NOT_VALID'; reasons: Array<string> }
  | { status: 'RECIPE_NOT_PREPARED' }
  | { status: 'RECIPE_INTEGRITY_FAILURE' }
  | { status: 'CONTEXT_MISMATCH'; reasons: Array<string> }
  | { status: 'GOVERNANCE_IMPOSSIBLE'; reasons: Array<string> }
  | { status: 'SCENE_CEILING_EXCEEDED'; sceneCount: number }

type ReadyRecipe = Extract<VideoRecipe, { status: 'RECIPE_READY' }>

/**
 * Deterministic scene planning over the approved recipe timeline.
 *
 * Rules (canon §10.6): never pad with invented content, never stretch a
 * prayer to hit a scene count, never add spiritual actions/objects, and
 * preserve total recipe duration exactly. SILENCE is preserved verbatim
 * as HOLD_PREVIOUS. Long CONTENT visual windows may be split into
 * purely PRESENTATIONAL sub-scenes by dividing the existing timeline
 * only — content, audio and meaning are untouched. 8–12 scenes is the
 * normal target where duration naturally supports it; it is never
 * forced.
 */
function planScenes(
  recipe: ReadyRecipe,
  bible: {
    versionId: number
    versionNumber: number
    definitionSha256: string
    rules: Array<{ id: number; category: string; position: number }>
  } | null,
): { scenes: Array<StoryboardScene>; totalDurationMs: number } {
  const scenes: Array<StoryboardScene> = []
  let cursorMs = 0
  const bibleRefs: Array<StoryboardBibleRuleRef> = bible
    ? bible.rules.map((rule) => ({
        ruleId: rule.id,
        category: rule.category,
        position: rule.position,
      }))
    : []

  for (const segment of recipe.segments) {
    const segmentMs = Math.max(0, Math.round(segment.durationSeconds * 1000))
    const segmentStart = cursorMs

    if (segment.kind === 'SILENCE') {
      // Preserved EXACTLY — one scene, holding the previous visual.
      scenes.push({
        sceneId: `s${segment.segmentIndex}-0`,
        order: scenes.length,
        recipeSegmentIndex: segment.segmentIndex,
        slotKey: segment.slotKey,
        kind: 'SILENCE',
        contentVersionId: null,
        contentSha256: null,
        contentType: null,
        themeCode: null,
        startMs: segmentStart,
        endMs: segmentStart + segmentMs,
        durationMs: segmentMs,
        splitIndex: 0,
        splitCount: 1,
        sourceMode: 'HOLD_PREVIOUS',
        mediaAssetVersionId: null,
        mediaAssetId: null,
        mediaFileSha256: null,
        mediaAssetKind: null,
        generationIntent: null,
        audio: {
          mode: 'NONE',
          mediaAssetVersionId: null,
          fileSha256: null,
          contentVersionId: null,
          contentSha256: null,
          language: null,
          voicePolicy: null,
          requirementId: null,
          segmentStartMs: null,
          segmentEndMs: null,
        },
        bibleRuleRefs: [],
      })
      cursorMs = segmentStart + segmentMs
      continue
    }

    // CONTENT: purely presentational split of the EXISTING window.
    const splitCount =
      segmentMs > MAX_SCENE_MS ? Math.ceil(segmentMs / MAX_SCENE_MS) : 1
    const baseMs = Math.floor(segmentMs / splitCount)
    const remainder = segmentMs - baseMs * splitCount

    const sourceMode: SceneSourceMode =
      segment.visual != null
        ? 'APPROVED_MEDIA'
        : segment.generation != null
          ? 'GENERATION_REQUIRED'
          : 'HOLD_PREVIOUS'

    // Audio belongs to the whole recipe segment: the FIRST sub-scene
    // carries the requirement; splitting never duplicates or alters it,
    // and the requirement keeps the FULL segment window it covers.
    const audioForSegment: SceneAudioRequirement =
      segment.audioMode === 'HUMAN_RECORDED' ||
      segment.audioMode === 'LINKED_HUMAN_AUDIO'
        ? {
            mode: 'EXISTING_HUMAN_AUDIO',
            mediaAssetVersionId: segment.audio?.mediaAssetVersionId ?? null,
            fileSha256: segment.audio?.fileSha256 ?? null,
            contentVersionId: segment.contentVersionId,
            contentSha256: segment.contentSha256,
            language: recipe.language,
            voicePolicy: segment.voicePolicy,
            requirementId: `audio-${segment.segmentIndex}`,
            segmentStartMs: segmentStart,
            segmentEndMs: segmentStart + segmentMs,
          }
        : segment.audioMode === 'TTS_ALLOWED_PENDING'
          ? {
              // Identity + policy only — NEVER any speech text.
              mode: 'TTS_PENDING',
              mediaAssetVersionId: null,
              fileSha256: null,
              contentVersionId: segment.contentVersionId,
              contentSha256: segment.contentSha256,
              language: recipe.language,
              voicePolicy: segment.voicePolicy,
              requirementId: `audio-${segment.segmentIndex}`,
              segmentStartMs: segmentStart,
              segmentEndMs: segmentStart + segmentMs,
            }
          : {
              mode: 'NONE',
              mediaAssetVersionId: null,
              fileSha256: null,
              contentVersionId: null,
              contentSha256: null,
              language: null,
              voicePolicy: null,
              requirementId: null,
              segmentStartMs: null,
              segmentEndMs: null,
            }

    for (let split = 0; split < splitCount; split += 1) {
      const durationMs = baseMs + (split < remainder ? 1 : 0)
      const startMs = cursorMs
      const endMs = startMs + durationMs
      scenes.push({
        sceneId: `s${segment.segmentIndex}-${split}`,
        order: scenes.length,
        recipeSegmentIndex: segment.segmentIndex,
        slotKey: segment.slotKey,
        kind: 'CONTENT',
        contentVersionId: segment.contentVersionId,
        contentSha256: segment.contentSha256,
        contentType: segment.contentType,
        themeCode: segment.themeCode,
        startMs,
        endMs,
        durationMs,
        splitIndex: split,
        splitCount,
        sourceMode,
        mediaAssetVersionId: segment.visual?.mediaAssetVersionId ?? null,
        mediaAssetId: segment.visual?.mediaAssetId ?? null,
        mediaFileSha256: segment.visual?.fileSha256 ?? null,
        mediaAssetKind: segment.visual?.assetKind ?? null,
        // Content identity is never invented here: a segment without it
        // is refused by the builder before planning is reached.
        generationIntent:
          sourceMode === 'GENERATION_REQUIRED' &&
          segment.generation &&
          bible &&
          segment.contentVersionId != null &&
          segment.contentSha256 != null
            ? {
                sacredHouseId: recipe.sacredHouseId,
                serviceId: recipe.serviceId,
                contentType: segment.generation.contentType,
                themeCode: segment.generation.themeCode,
                requestedDurationMs: durationMs,
                visualBibleVersionId: bible.versionId,
                visualBibleVersionNumber: bible.versionNumber,
                visualBibleSha256: bible.definitionSha256,
                ruleRefs: bibleRefs,
                externalAiPolicy: segment.externalAiPolicy ?? '',
                textContextAllowed: segment.generation.textContextAllowed,
                contentVersionId: segment.contentVersionId,
                contentSha256: segment.contentSha256,
              }
            : null,
        audio:
          split === 0
            ? audioForSegment
            : {
                mode: 'NONE',
                mediaAssetVersionId: null,
                fileSha256: null,
                contentVersionId: null,
                contentSha256: null,
                language: null,
                voicePolicy: null,
                requirementId: null,
                segmentStartMs: null,
                segmentEndMs: null,
              },
        // Rules are referenced by stable identity/category/order — the
        // sensitive rule TEXT is never copied into a storyboard.
        bibleRuleRefs: sourceMode === 'GENERATION_REQUIRED' ? bibleRefs : [],
      })
      cursorMs = endMs
    }
  }
  return { scenes, totalDurationMs: cursorMs }
}

function buildManifest(
  storyboard: GenerationStoryboard,
  storyboardSnapshotId: number,
  storyboardSnapshotNumber: number,
): GenerationManifest {
  const visualTasks: Array<ManifestVisualTask> = []
  const approvedMedia: Array<ManifestApprovedMediaRef> = []
  const audioRequirements: Array<ManifestAudioRequirement> = []

  for (const scene of storyboard.scenes) {
    if (scene.sourceMode === 'GENERATION_REQUIRED' && scene.generationIntent) {
      visualTasks.push({
        taskId: `task-${scene.sceneId}`,
        sceneId: scene.sceneId,
        taskKind: 'GENERATE_VIDEO_SCENE',
        durationMs: scene.durationMs,
        generationIntent: scene.generationIntent,
        idempotencyKey: computeVisualTaskIdempotencyKey({
          generationJobId: storyboard.generationJobId,
          storyboardSha256: storyboard.storyboardSha256,
          sceneId: scene.sceneId,
        }),
        requiresAuthorityRevalidation: true,
      })
    }
    // Existing approved media creates NO paid-generation task.
    if (
      scene.sourceMode === 'APPROVED_MEDIA' &&
      scene.mediaAssetVersionId != null &&
      scene.mediaAssetId != null &&
      scene.mediaFileSha256 != null
    ) {
      approvedMedia.push({
        sceneId: scene.sceneId,
        mediaAssetVersionId: scene.mediaAssetVersionId,
        mediaAssetId: scene.mediaAssetId,
        fileSha256: scene.mediaFileSha256,
        assetKind: scene.mediaAssetKind ?? '',
        startMs: scene.startMs,
        endMs: scene.endMs,
      })
    }
    if (scene.audio.mode !== 'NONE') {
      // The window is the WHOLE recipe segment the audio covers — never
      // the presentational sub-scene that carries the requirement.
      audioRequirements.push({
        ...scene.audio,
        sceneId: scene.sceneId,
        startMs: scene.audio.segmentStartMs ?? scene.startMs,
        endMs: scene.audio.segmentEndMs ?? scene.endMs,
      })
    }
  }

  const body = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generationJobId: storyboard.generationJobId,
    storyboardSnapshotId,
    storyboardSnapshotNumber,
    storyboardSha256: storyboard.storyboardSha256,
    totalDurationMs: storyboard.totalDurationMs,
    visualTasks,
    approvedMedia,
    audioRequirements,
  }
  return { ...body, manifestSha256: computeManifestSha256(body) }
}

/**
 * Builds the deterministic storyboard for a job from its CURRENT
 * authoritative recipe snapshot. The recipe is revalidated against
 * present authority first and NEVER rebuilt or healed here; the frozen
 * job binding (service/house/language/seed) must match exactly.
 *
 * The manifest is built afterwards (it needs the persisted storyboard
 * snapshot id), so this returns the storyboard plus a manifest builder
 * bound to it.
 */
export async function buildValidatedGenerationStoryboard(
  jobId: number,
): Promise<
  | { status: 'OK'; storyboard: GenerationStoryboard; recipeSnapshotId: number }
  | Exclude<StoryboardBuildResult, { status: 'OK' }>
> {
  const job = (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
  ).at(0)
  if (!job) throw new GenerationJobError('Generation job not found.')

  // CURRENT authority: the real Step 12 loader + validator.
  const validated = await loadAndValidateGenerationRecipe(jobId)
  if (validated.status === 'NOT_PREPARED') {
    return { status: 'RECIPE_NOT_PREPARED' }
  }
  if (validated.status === 'INTEGRITY_FAILURE') {
    return { status: 'RECIPE_INTEGRITY_FAILURE' }
  }
  if (validated.status === 'INVALID') {
    return { status: 'RECIPE_NOT_VALID', reasons: validated.reasons }
  }
  const recipe = validated.recipe

  // Exact frozen job binding.
  const mismatches: Array<string> = []
  if (recipe.serviceId !== job.serviceIdSnapshot) mismatches.push('service')
  if (recipe.sacredHouseId !== job.sacredHouseIdSnapshot) {
    mismatches.push('sacred_house')
  }
  if (recipe.language !== job.languageSnapshot) mismatches.push('language')
  if (recipe.variationSeed !== job.variationSeed) mismatches.push('seed')
  if (mismatches.length > 0) {
    return { status: 'CONTEXT_MISMATCH', reasons: mismatches }
  }

  const needsGeneration = recipe.segments.some(
    (segment) => segment.generation != null,
  )
  // NO_EXTERNAL_AI can never produce a generated scene.
  const illegalGeneration = recipe.segments.some(
    (segment) =>
      segment.generation != null &&
      segment.externalAiPolicy === 'NO_EXTERNAL_AI',
  )
  if (illegalGeneration) {
    return {
      status: 'GOVERNANCE_IMPOSSIBLE',
      reasons: ['generation_under_no_external_ai'],
    }
  }

  // A generated scene must carry its own content identity, and a
  // segment can never be BOTH approved and generated. Both fail closed:
  // an identity is never fabricated and a source is never chosen for
  // an incoherent segment.
  const semanticRefusals: Array<string> = []
  if (
    recipe.segments.some(
      (segment) =>
        segment.visual == null &&
        segment.generation != null &&
        (segment.contentVersionId == null || segment.contentSha256 == null),
    )
  ) {
    semanticRefusals.push('generation_missing_content_identity')
  }
  if (
    recipe.segments.some(
      (segment) => segment.visual != null && segment.generation != null,
    )
  ) {
    semanticRefusals.push('incoherent_scene_source')
  }
  if (semanticRefusals.length > 0) {
    return { status: 'GOVERNANCE_IMPOSSIBLE', reasons: semanticRefusals }
  }

  // Generated scenes require the CURRENT published Visual Bible to
  // still verify (Step 10 authority, never reinterpreted here).
  let bible: {
    versionId: number
    versionNumber: number
    definitionSha256: string
    rules: Array<{ id: number; category: string; position: number }>
  } | null = null
  if (needsGeneration) {
    const loaded = await loadPublishedVisualBible(job.sacredHouseIdSnapshot)
    if (loaded.status !== 'OK') {
      return {
        status: 'GOVERNANCE_IMPOSSIBLE',
        reasons: [`visual_bible_${loaded.status.toLowerCase()}`],
      }
    }
    if (
      recipe.visualBible &&
      (loaded.versionId !== recipe.visualBible.versionId ||
        loaded.definitionSha256 !== recipe.visualBible.definitionSha256)
    ) {
      return {
        status: 'GOVERNANCE_IMPOSSIBLE',
        reasons: ['visual_bible_changed'],
      }
    }
    bible = {
      versionId: loaded.versionId,
      versionNumber: loaded.versionNumber,
      definitionSha256: loaded.definitionSha256,
      rules: await loadBibleRuleIdentities(loaded.versionId),
    }
  }

  const { scenes, totalDurationMs } = planScenes(recipe, bible)
  const leadingScene = scenes.at(0)
  if (
    leadingScene?.kind === 'CONTENT' &&
    leadingScene.sourceMode === 'HOLD_PREVIOUS'
  ) {
    // Nothing exists yet to hold — and nothing may be invented for it.
    return {
      status: 'GOVERNANCE_IMPOSSIBLE',
      reasons: ['leading_hold_previous'],
    }
  }
  if (scenes.length > MAX_SCENES) {
    // Loud ceiling — never a silent truncation.
    return { status: 'SCENE_CEILING_EXCEEDED', sceneCount: scenes.length }
  }

  const body = {
    schemaVersion: STORYBOARD_SCHEMA_VERSION,
    generationJobId: jobId,
    serviceId: job.serviceIdSnapshot,
    sacredHouseId: job.sacredHouseIdSnapshot,
    language: job.languageSnapshot,
    variationSeed: job.variationSeed,
    recipeSnapshotId: validated.snapshotId,
    recipeSnapshotNumber: validated.snapshotNumber,
    recipeSha256: recipe.recipeSha256,
    templateVersionId: recipe.templateVersionId,
    templateDefinitionSha256: recipe.templateDefinitionSha256,
    visualBibleVersionId: bible?.versionId ?? null,
    visualBibleVersionNumber: bible?.versionNumber ?? null,
    visualBibleSha256: bible?.definitionSha256 ?? null,
    scenes,
    sceneCount: scenes.length,
    totalDurationMs,
  }
  const storyboard: GenerationStoryboard = {
    ...body,
    storyboardSha256: computeStoryboardSha256(body),
  }
  return {
    status: 'OK',
    storyboard: deepFreeze(storyboard),
    recipeSnapshotId: validated.snapshotId,
  }
}

/** Stable rule identities (never the sensitive rule text). */
async function loadBibleRuleIdentities(
  bibleVersionId: number,
): Promise<Array<{ id: number; category: string; position: number }>> {
  const { visualBibleRules } = await import('@/db/schema')
  return getDb()
    .select({
      id: visualBibleRules.id,
      category: visualBibleRules.category,
      position: visualBibleRules.position,
    })
    .from(visualBibleRules)
    .where(eq(visualBibleRules.bibleVersionId, bibleVersionId))
    .orderBy(visualBibleRules.position)
}

// --- Atomic finalization ----------------------------------------------------

/**
 * ONE transaction persists storyboard + manifest and transitions
 * STORYBOARDING → GENERATING_VISUALS. Lock first, read the
 * authoritative clock AFTER the lock, require the exact live lease and
 * the central transition map, allocate both snapshot numbers, insert
 * both immutable snapshots, update the job and record the event. Any
 * failure inserts NOTHING — a stale worker can never persist.
 */
export async function persistStoryboardManifestUnderLease(
  jobId: number,
  leaseToken: string,
  attempt: number,
  storyboard: GenerationStoryboard,
  recipeSnapshotId: number,
  clock: GenerationClock,
): Promise<{
  storyboardSnapshotNumber: number
  manifestSnapshotNumber: number
  manifestSha256: string
} | null> {
  if (!isLegalTransition('STORYBOARDING', 'GENERATING_VISUALS')) {
    throw new GenerationJobError(
      'Illegal transition STORYBOARDING → GENERATING_VISUALS.',
    )
  }
  const storyboardJsonText = JSON.stringify(storyboard)
  const storyboardPayloadSha256 = sha256(storyboardJsonText)
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
      job.status !== 'STORYBOARDING' ||
      job.leaseToken !== leaseToken ||
      job.leaseExpiresAt == null ||
      job.leaseExpiresAt <= freshNow
    ) {
      return null
    }
    const latestStoryboard = (
      await tx
        .select({
          snapshotNumber: prayerGenerationStoryboardSnapshots.snapshotNumber,
        })
        .from(prayerGenerationStoryboardSnapshots)
        .where(eq(prayerGenerationStoryboardSnapshots.generationJobId, jobId))
        .orderBy(
          sql`${prayerGenerationStoryboardSnapshots.snapshotNumber} DESC`,
        )
        .limit(1)
        .for('update')
    ).at(0)
    const storyboardSnapshotNumber = (latestStoryboard?.snapshotNumber ?? 0) + 1
    const insertedStoryboard = await tx
      .insert(prayerGenerationStoryboardSnapshots)
      .values({
        generationJobId: jobId,
        recipeSnapshotId,
        snapshotNumber: storyboardSnapshotNumber,
        storyboardJsonText,
        payloadSha256: storyboardPayloadSha256,
        storyboardSha256: storyboard.storyboardSha256,
        sceneCount: storyboard.sceneCount,
        totalDurationMs: storyboard.totalDurationMs,
        visualBibleVersionId: storyboard.visualBibleVersionId,
        visualBibleDefinitionSha256: storyboard.visualBibleSha256,
      })
    const storyboardSnapshotId = insertedStoryboard[0].insertId

    const manifest = buildManifest(
      storyboard,
      storyboardSnapshotId,
      storyboardSnapshotNumber,
    )
    const manifestJsonText = JSON.stringify(manifest)
    const latestManifest = (
      await tx
        .select({
          snapshotNumber: prayerGenerationManifestSnapshots.snapshotNumber,
        })
        .from(prayerGenerationManifestSnapshots)
        .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
        .orderBy(sql`${prayerGenerationManifestSnapshots.snapshotNumber} DESC`)
        .limit(1)
        .for('update')
    ).at(0)
    const manifestSnapshotNumber = (latestManifest?.snapshotNumber ?? 0) + 1
    await tx.insert(prayerGenerationManifestSnapshots).values({
      generationJobId: jobId,
      storyboardSnapshotId,
      snapshotNumber: manifestSnapshotNumber,
      manifestJsonText,
      payloadSha256: sha256(manifestJsonText),
      manifestSha256: manifest.manifestSha256,
      visualTaskCount: manifest.visualTasks.length,
      audioRequirementCount: manifest.audioRequirements.length,
    })

    const updated = await tx
      .update(prayerGenerationJobs)
      .set({
        status: 'GENERATING_VISUALS',
        attemptCount: attempt,
        lastErrorCode: null,
        lastErrorMessage: null,
        nextAttemptAt: null,
        resumeStatus: null,
        leaseToken: null,
        leaseOwner: null,
        leaseAcquiredAt: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(prayerGenerationJobs.id, jobId),
          eq(prayerGenerationJobs.status, 'STORYBOARDING'),
          eq(prayerGenerationJobs.leaseToken, leaseToken),
        ),
      )
    if (updated[0].affectedRows !== 1) {
      throw new GenerationJobError('Storyboard finalization conflict.')
    }
    await tx.insert(prayerGenerationJobEvents).values({
      generationJobId: jobId,
      fromStatus: 'STORYBOARDING',
      toStatus: 'GENERATING_VISUALS',
      eventCode: 'storyboard_prepared',
      attemptNumber: attempt,
    })
    return {
      storyboardSnapshotNumber,
      manifestSnapshotNumber,
      manifestSha256: manifest.manifestSha256,
    }
  })
}

// --- Fail-closed loaders ----------------------------------------------------

export type LoadedStoryboard =
  | {
      status: 'OK'
      snapshotId: number
      snapshotNumber: number
      recipeSnapshotId: number
      storyboard: GenerationStoryboard
    }
  | { status: 'NOT_PREPARED' }
  | { status: 'INTEGRITY_FAILURE' }

export async function loadGenerationStoryboardSnapshot(
  jobId: number,
): Promise<LoadedStoryboard> {
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationStoryboardSnapshots)
      .where(eq(prayerGenerationStoryboardSnapshots.generationJobId, jobId))
      .orderBy(sql`${prayerGenerationStoryboardSnapshots.snapshotNumber} DESC`)
      .limit(1)
  ).at(0)
  if (!row) return { status: 'NOT_PREPARED' }
  if (sha256(row.storyboardJsonText) !== row.payloadSha256) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.storyboardJsonText)
  } catch {
    return { status: 'INTEGRITY_FAILURE' }
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !==
      STORYBOARD_SCHEMA_VERSION
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  const storyboard = parsed as GenerationStoryboard
  const { storyboardSha256, ...body } = storyboard
  if (
    computeStoryboardSha256(body) !== storyboardSha256 ||
    storyboardSha256 !== row.storyboardSha256
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  return {
    status: 'OK',
    snapshotId: row.id,
    snapshotNumber: row.snapshotNumber,
    recipeSnapshotId: row.recipeSnapshotId,
    storyboard,
  }
}

export type LoadedManifest =
  | {
      status: 'OK'
      snapshotId: number
      snapshotNumber: number
      storyboardSnapshotId: number
      manifest: GenerationManifest
    }
  | { status: 'NOT_PREPARED' }
  | { status: 'INTEGRITY_FAILURE' }

export async function loadGenerationManifestSnapshot(
  jobId: number,
): Promise<LoadedManifest> {
  const row = (
    await getDb()
      .select()
      .from(prayerGenerationManifestSnapshots)
      .where(eq(prayerGenerationManifestSnapshots.generationJobId, jobId))
      .orderBy(sql`${prayerGenerationManifestSnapshots.snapshotNumber} DESC`)
      .limit(1)
  ).at(0)
  if (!row) return { status: 'NOT_PREPARED' }
  if (sha256(row.manifestJsonText) !== row.payloadSha256) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(row.manifestJsonText)
  } catch {
    return { status: 'INTEGRITY_FAILURE' }
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !==
      MANIFEST_SCHEMA_VERSION
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  const manifest = parsed as GenerationManifest
  const { manifestSha256, ...body } = manifest
  if (
    computeManifestSha256(body) !== manifestSha256 ||
    manifestSha256 !== row.manifestSha256
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  return {
    status: 'OK',
    snapshotId: row.id,
    snapshotNumber: row.snapshotNumber,
    storyboardSnapshotId: row.storyboardSnapshotId,
    manifest,
  }
}

export type ValidatedManifest =
  | {
      status: 'VALID'
      storyboard: GenerationStoryboard
      manifest: GenerationManifest
    }
  | { status: 'INVALID'; reasons: Array<string> }
  | { status: 'INTEGRITY_FAILURE' }
  | { status: 'NOT_PREPARED' }

/**
 * Full current-authority validation of a persisted manifest. Step 14
 * MUST call this again immediately before ANY provider call — nothing
 * is ever silently rebuilt or healed.
 */
export async function loadAndValidateGenerationManifest(
  jobId: number,
): Promise<ValidatedManifest> {
  const loadedStoryboard = await loadGenerationStoryboardSnapshot(jobId)
  if (loadedStoryboard.status !== 'OK') {
    return { status: loadedStoryboard.status }
  }
  const loadedManifest = await loadGenerationManifestSnapshot(jobId)
  if (loadedManifest.status !== 'OK') return { status: loadedManifest.status }

  const reasons: Array<string> = []
  const push = (reason: string) => {
    if (reasons.length < 50) reasons.push(reason)
  }
  const storyboard = loadedStoryboard.storyboard
  const manifest = loadedManifest.manifest

  // manifest ↔ storyboard binding
  if (
    loadedManifest.storyboardSnapshotId !== loadedStoryboard.snapshotId ||
    manifest.storyboardSha256 !== storyboard.storyboardSha256 ||
    manifest.generationJobId !== jobId
  ) {
    push('manifest_storyboard_binding')
  }

  // job frozen-context binding
  const job = (
    await getDb()
      .select()
      .from(prayerGenerationJobs)
      .where(eq(prayerGenerationJobs.id, jobId))
      .limit(1)
  ).at(0)
  if (!job) {
    push('job_missing')
  } else if (
    storyboard.serviceId !== job.serviceIdSnapshot ||
    storyboard.sacredHouseId !== job.sacredHouseIdSnapshot ||
    storyboard.language !== job.languageSnapshot ||
    storyboard.variationSeed !== job.variationSeed
  ) {
    push('job_context_binding')
  }

  // storyboard ↔ recipe snapshot binding + CURRENT recipe authority
  const recipeNow = await loadAndValidateGenerationRecipe(jobId)
  if (recipeNow.status === 'NOT_PREPARED') push('recipe_not_prepared')
  else if (recipeNow.status === 'INTEGRITY_FAILURE') {
    push('recipe_integrity_failure')
  } else if (recipeNow.status === 'INVALID') {
    push('recipe_invalid')
  } else {
    if (recipeNow.snapshotId !== loadedStoryboard.recipeSnapshotId) {
      push('recipe_snapshot_changed')
    }
    if (recipeNow.recipe.recipeSha256 !== storyboard.recipeSha256) {
      push('recipe_hash_changed')
    }
    // Media ids/hashes must still correspond to the recipe.
    const recipeVisuals = new Map(
      recipeNow.recipe.segments
        .filter((segment) => segment.visual != null)
        .map((segment) => [
          segment.segmentIndex,
          segment.visual!.mediaAssetVersionId +
            ':' +
            segment.visual!.fileSha256,
        ]),
    )
    for (const scene of storyboard.scenes) {
      if (scene.sourceMode !== 'APPROVED_MEDIA') continue
      const expected = recipeVisuals.get(scene.recipeSegmentIndex)
      if (
        expected == null ||
        expected !== `${scene.mediaAssetVersionId}:${scene.mediaFileSha256}`
      ) {
        push(`media_binding:${scene.sceneId}`)
      }
    }
    // No illegal generated scene under NO_EXTERNAL_AI.
    const policyBySegment = new Map(
      recipeNow.recipe.segments.map((segment) => [
        segment.segmentIndex,
        segment.externalAiPolicy,
      ]),
    )
    for (const scene of storyboard.scenes) {
      if (scene.sourceMode !== 'GENERATION_REQUIRED') continue
      if (policyBySegment.get(scene.recipeSegmentIndex) === 'NO_EXTERNAL_AI') {
        push(`generation_under_no_external_ai:${scene.sceneId}`)
      }
    }
    // Voice and text identities must match the CURRENT recipe segment,
    // not merely a self-consistent payload: recomputed hashes can never
    // smuggle a different recording or a different approved text.
    const segmentByIndex = new Map(
      recipeNow.recipe.segments.map((segment) => [
        segment.segmentIndex,
        segment,
      ]),
    )
    for (const scene of storyboard.scenes) {
      const segment = segmentByIndex.get(scene.recipeSegmentIndex)
      if (scene.audio.mode === 'EXISTING_HUMAN_AUDIO') {
        if (
          segment?.audio == null ||
          scene.audio.mediaAssetVersionId !==
            segment.audio.mediaAssetVersionId ||
          scene.audio.fileSha256 !== segment.audio.fileSha256
        ) {
          push(`audio_binding:${scene.sceneId}`)
        }
      } else if (scene.audio.mode === 'TTS_PENDING') {
        if (
          segment == null ||
          scene.audio.contentVersionId !== segment.contentVersionId ||
          scene.audio.contentSha256 !== segment.contentSha256
        ) {
          push(`audio_binding:${scene.sceneId}`)
        }
      }
      const intent = scene.generationIntent
      if (
        intent != null &&
        (segment == null ||
          intent.contentVersionId !== segment.contentVersionId ||
          intent.contentSha256 !== segment.contentSha256)
      ) {
        push(`intent_content_binding:${scene.sceneId}`)
      }
    }
  }

  // Nothing exists yet to hold before the first scene.
  const leadingScene = storyboard.scenes.at(0)
  if (
    leadingScene?.kind === 'CONTENT' &&
    leadingScene.sourceMode === 'HOLD_PREVIOUS'
  ) {
    push('leading_hold_previous')
  }

  // Scene order / timeline / duration integrity.
  let cursor = 0
  let expectedOrder = 0
  for (const scene of storyboard.scenes) {
    if (scene.order !== expectedOrder) push(`scene_order:${scene.sceneId}`)
    expectedOrder += 1
    if (scene.startMs !== cursor) push(`scene_start:${scene.sceneId}`)
    if (scene.endMs - scene.startMs !== scene.durationMs) {
      push(`scene_duration:${scene.sceneId}`)
    }
    cursor = scene.endMs
    if (scene.sourceMode === 'GENERATION_REQUIRED') {
      if (!scene.generationIntent) push(`missing_intent:${scene.sceneId}`)
      else if (
        storyboard.visualBibleSha256 == null ||
        scene.generationIntent.visualBibleSha256 !==
          storyboard.visualBibleSha256 ||
        scene.generationIntent.visualBibleVersionId !==
          storyboard.visualBibleVersionId
      ) {
        push(`intent_bible_binding:${scene.sceneId}`)
      }
    }
  }
  if (cursor !== storyboard.totalDurationMs) push('total_duration')
  if (storyboard.sceneCount !== storyboard.scenes.length) push('scene_count')
  if (storyboard.scenes.length > MAX_SCENES) push('scene_ceiling')

  // Visual Bible must STILL verify when generated scenes exist.
  if (storyboard.scenes.some((scene) => scene.generationIntent != null)) {
    const bibleNow = await loadPublishedVisualBible(storyboard.sacredHouseId)
    if (bibleNow.status !== 'OK') {
      push(`visual_bible_${bibleNow.status.toLowerCase()}`)
    } else if (
      bibleNow.versionId !== storyboard.visualBibleVersionId ||
      bibleNow.definitionSha256 !== storyboard.visualBibleSha256
    ) {
      push('visual_bible_changed')
    }
  }

  // Deterministic task ids / idempotency keys + task↔scene coherence.
  const generatedScenes = storyboard.scenes.filter(
    (scene) => scene.sourceMode === 'GENERATION_REQUIRED',
  )
  if (manifest.visualTasks.length !== generatedScenes.length) {
    push('visual_task_count')
  }
  for (const task of manifest.visualTasks) {
    const scene = storyboard.scenes.find(
      (candidate) => candidate.sceneId === task.sceneId,
    )
    if (!scene || scene.sourceMode !== 'GENERATION_REQUIRED') {
      push(`task_scene_binding:${task.taskId}`)
      continue
    }
    if (task.taskId !== `task-${scene.sceneId}`) push(`task_id:${task.taskId}`)
    if (task.durationMs !== scene.durationMs)
      push(`task_duration:${task.taskId}`)
    // Loaded JSON is UNTRUSTED — read the raw value rather than
    // trusting the declared literal type.
    if (
      (task as { requiresAuthorityRevalidation?: unknown })
        .requiresAuthorityRevalidation !== true
    ) {
      push(`task_revalidation_flag:${task.taskId}`)
    }
    const expectedKey = computeVisualTaskIdempotencyKey({
      generationJobId: storyboard.generationJobId,
      storyboardSha256: storyboard.storyboardSha256,
      sceneId: scene.sceneId,
    })
    if (task.idempotencyKey !== expectedKey) {
      push(`task_idempotency:${task.taskId}`)
    }
  }
  // Approved media scenes must create NO paid-generation task.
  for (const scene of storyboard.scenes) {
    if (scene.sourceMode !== 'APPROVED_MEDIA') continue
    if (manifest.visualTasks.some((task) => task.sceneId === scene.sceneId)) {
      push(`unexpected_task:${scene.sceneId}`)
    }
  }
  // An audio window covers the WHOLE recipe segment; a split may never
  // narrow it to the sub-scene carrying the requirement.
  for (const requirement of manifest.audioRequirements) {
    const scene = storyboard.scenes.find(
      (candidate) => candidate.sceneId === requirement.sceneId,
    )
    if (
      !scene ||
      requirement.startMs !== scene.audio.segmentStartMs ||
      requirement.endMs !== scene.audio.segmentEndMs
    ) {
      push(`audio_window:${requirement.sceneId}`)
    }
  }

  return reasons.length === 0
    ? { status: 'VALID', storyboard, manifest }
    : { status: 'INVALID', reasons }
}

// --- Storyboard planning worker (Step 13 processing) ------------------------

export type StoryboardPlanningOutcome =
  | { status: 'IDLE' }
  | {
      status: 'PLANNED'
      jobId: number
      storyboardSnapshotNumber: number
      manifestSnapshotNumber: number
    }
  | { status: 'RETRY_SCHEDULED'; jobId: number; errorCode: string }
  | { status: 'FAILED'; jobId: number; errorCode: string }
  | { status: 'LEASE_LOST'; jobId: number }

/** Structural/governance impossibilities fail closed (no retry storm);
 * everything else retries on the bounded Step 12 schedule. */
const STRUCTURAL_FAILURES: ReadonlyArray<string> = [
  'CONTEXT_MISMATCH',
  'GOVERNANCE_IMPOSSIBLE',
  'SCENE_CEILING_EXCEEDED',
]

/**
 * One storyboard planning cycle: claim a STORYBOARDING (or resuming
 * RETRYING) job under a bounded lease, revalidate the recipe against
 * CURRENT authority, plan deterministic scenes, build the
 * provider-neutral manifest and finalize both atomically into
 * GENERATING_VISUALS. Reuses Step 12 lease authority throughout:
 * post-row-lock clock readings, heartbeat renewal, stale-worker
 * rejection, bounded retries and the central transition map. No
 * provider is chosen or called.
 */
export async function runStoryboardPlanningOnce(
  workerId: string,
  clock: GenerationClock,
  dependencies: {
    buildStoryboard?: typeof buildValidatedGenerationStoryboard
  } = {},
): Promise<StoryboardPlanningOutcome> {
  const buildStoryboard =
    dependencies.buildStoryboard ?? buildValidatedGenerationStoryboard
  // The claim receives the CLOCK, not a reading: the granted lease
  // window must derive from the claim's own post-lock time.
  const claimed = await claimNextStoryboardJob(workerId, clock)
  if (!claimed) return { status: 'IDLE' }
  const { job, leaseToken } = claimed
  const attempt = job.attemptCount + 1

  const heartbeat = async (): Promise<boolean> =>
    renewGenerationLease(job.id, leaseToken, clock)
  const heartbeatTimer = setInterval(
    () => {
      void renewGenerationLease(job.id, leaseToken, clock).catch(
        () => undefined,
      )
    },
    Math.max(1_000, Math.floor(DEFAULT_LEASE_MS / 3)),
  )

  try {
    // A resuming RETRYING job re-enters STORYBOARDING through the
    // central map; a job already parked in STORYBOARDING stays put.
    if (job.status === 'RETRYING') {
      const resumed = await transitionGenerationJobUnderLease(
        job.id,
        leaseToken,
        'RETRYING',
        'STORYBOARDING',
        clock,
        {
          eventCode: 'storyboard_resumed',
          attemptNumber: attempt,
          patch: { resumeStatus: null },
        },
      )
      if (!resumed) return { status: 'LEASE_LOST', jobId: job.id }
    }

    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }
    const built = await buildStoryboard(job.id)
    if (!(await heartbeat())) return { status: 'LEASE_LOST', jobId: job.id }

    if (built.status !== 'OK') {
      const structural = STRUCTURAL_FAILURES.includes(built.status)
      const detail =
        'reasons' in built
          ? built.reasons.join(', ').slice(0, 500)
          : 'sceneCount' in built
            ? `scene_count=${built.sceneCount}`
            : null
      if (structural) {
        const ok = await transitionGenerationJobUnderLease(
          job.id,
          leaseToken,
          'STORYBOARDING',
          'FAILED',
          clock,
          {
            eventCode: 'storyboard_impossible',
            detailCode: built.status.slice(0, 100),
            attemptNumber: attempt,
            clearLease: true,
            patch: {
              attemptCount: attempt,
              lastErrorCode: built.status,
              lastErrorMessage: detail,
              nextAttemptAt: null,
              resumeStatus: null,
            },
          },
        )
        return ok
          ? { status: 'FAILED', jobId: job.id, errorCode: built.status }
          : { status: 'LEASE_LOST', jobId: job.id }
      }
      // Recipe authority may recover (or be repaired upstream) —
      // bounded retry, never auto-heal.
      const outcome = await scheduleRetryOrFail(
        job,
        leaseToken,
        clock,
        built.status,
        detail,
        'STORYBOARDING',
      )
      if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
      return outcome === 'FAILED'
        ? { status: 'FAILED', jobId: job.id, errorCode: built.status }
        : {
            status: 'RETRY_SCHEDULED',
            jobId: job.id,
            errorCode: built.status,
          }
    }

    const persisted = await persistStoryboardManifestUnderLease(
      job.id,
      leaseToken,
      attempt,
      built.storyboard,
      built.recipeSnapshotId,
      clock,
    )
    if (!persisted) return { status: 'LEASE_LOST', jobId: job.id }
    return {
      status: 'PLANNED',
      jobId: job.id,
      storyboardSnapshotNumber: persisted.storyboardSnapshotNumber,
      manifestSnapshotNumber: persisted.manifestSnapshotNumber,
    }
  } catch (error) {
    const outcome = await scheduleRetryOrFail(
      job,
      leaseToken,
      clock,
      'STORYBOARD_ERROR',
      sanitizeErrorMessage(error),
      'STORYBOARDING',
    )
    if (outcome === 'LOST') return { status: 'LEASE_LOST', jobId: job.id }
    return outcome === 'FAILED'
      ? { status: 'FAILED', jobId: job.id, errorCode: 'STORYBOARD_ERROR' }
      : {
          status: 'RETRY_SCHEDULED',
          jobId: job.id,
          errorCode: 'STORYBOARD_ERROR',
        }
  } finally {
    clearInterval(heartbeatTimer)
  }
}
