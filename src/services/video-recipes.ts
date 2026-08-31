import { createHash } from 'node:crypto'

import { and, asc, eq, gt } from 'drizzle-orm'

import { getDb } from '@/db'
import type {
  SlotReferenceRequirement,
  SlotShotFamily,
} from '@/db/schema/prayer-templates'
import {
  mediaAssetVersions,
  mediaAssets,
  sacredContentMediaLinks,
  sacredContentVersionProfiles,
  services,
  spiritualContentItems,
  spiritualContentVersions,
} from '@/db/schema'
import { resolveApprovedPrayerSession } from './prayer-session-resolver'
import {
  computeDefinitionSha256,
  loadTemplateDefinition,
  loadTemplateVersion,
} from './prayer-templates'
import { isSacredVersionRuntimeEligible } from './sacred-content'
import {
  isMediaAssetRuntimeEligible,
  listAllEligibleMediaAssets,
  resolveSacredAudioCandidates,
} from './media-assets'
import { loadPublishedVisualBible } from './visual-bibles'
import type { ContentScopeType, GuidanceLanguage } from '@/db/schema'

/**
 * Validated Video Recipe engine (Phase One, Step 11).
 *
 *   Step 9 resolved session plan
 *   + Step 10 runtime-eligible media
 *   + verified House Visual Bible
 *   → deterministic validated Video Recipe
 *
 * No human approves an individual recipe; every authority was approved
 * UPSTREAM (templates, sacred content, media, rights, consent, Visual
 * Bible). This module calls NO AI/TTS/generation/render provider —
 * GENERATION_ALLOWED segments are safe-metadata descriptors for a
 * FUTURE stage only, and never contain sacred bodies.
 *
 * Determinism: identical service+language+variationSeed against the
 * same committed DB state produces a byte-identical recipe (no
 * Math.random / Date.now anywhere). If any upstream authority later
 * changes — rights/consent withdrawal, runtime disable, hash or Visual
 * Bible corruption — validateVideoRecipe() fails CLOSED, never
 * auto-healing.
 *
 * The recipe carries NO sacred bodies, NO storage keys/paths, NO
 * consent references, NO rights notes and NO user PII.
 */

export class VideoRecipeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoRecipeError'
  }
}

// --- Types ------------------------------------------------------------------

export interface RecipeAudioSnapshot {
  mediaAssetVersionId: number
  mediaAssetId: number
  fileSha256: string
  sourceType: string
  mimeType: string
  durationSeconds: number | null
}

export interface RecipeVisualSnapshot {
  mediaAssetVersionId: number
  mediaAssetId: number
  fileSha256: string
  assetKind: string
  mimeType: string
  scopeType: ContentScopeType
  language: string | null
}

export interface RecipeGenerationDescriptor {
  contentType: string
  themeCode: string | null
  sacredHouseId: number
  serviceId: number
  visualBibleId: number
  visualBibleVersionId: number
  visualBibleVersionNumber: number
  visualBibleSha256: string
  /** APPROVED_TEXT_CONTEXT only: the future generation stage MAY
   * retrieve the approved body server-side — it is NEVER embedded. */
  textContextAllowed: boolean
}

export interface RecipeSegment {
  segmentIndex: number
  slotKey: string
  slotPosition: number
  kind: 'CONTENT' | 'SILENCE'
  durationSeconds: number
  /** The slot's AUTHORED camera decision, carried through unchanged.
   * Null on SILENCE. Dormant unless visualMode is GENERATION_ALLOWED —
   * but present regardless, so a media withdrawal can never promote a
   * slot into generation without approved shot authority behind it. */
  shotFamily: SlotShotFamily | null
  referenceRequirement: SlotReferenceRequirement | null
  // SILENCE
  visualMode:
    | 'LINKED_REFERENCE'
    | 'LIBRARY_MEDIA'
    | 'GENERATION_ALLOWED'
    | 'HOLD_PREVIOUS'
  // CONTENT-only fields (null for SILENCE)
  contentItemId: number | null
  contentVersionId: number | null
  contentSha256: string | null
  contentType: string | null
  themeCode: string | null
  voicePolicy: string | null
  externalAiPolicy: string | null
  audioMode:
    | 'NONE'
    | 'HUMAN_RECORDED'
    | 'LINKED_HUMAN_AUDIO'
    | 'TTS_ALLOWED_PENDING'
    | null
  audio: RecipeAudioSnapshot | null
  visual: RecipeVisualSnapshot | null
  generation: RecipeGenerationDescriptor | null
}

export interface VisualBibleSnapshot {
  visualBibleId: number
  versionId: number
  versionNumber: number
  definitionSha256: string
}

export type VideoRecipe =
  | {
      status: 'RECIPE_READY'
      serviceId: number
      sacredHouseId: number
      language: GuidanceLanguage
      variationSeed: string
      templateId: number
      templateVersionId: number
      templateVersionNumber: number
      templateDefinitionSha256: string
      visualBible: VisualBibleSnapshot | null
      segments: Array<RecipeSegment>
      targetMinSeconds: number
      targetMaxSeconds: number
      totalEstimatedSeconds: number
      recipeSha256: string
    }
  | {
      status: 'RECIPE_UNAVAILABLE'
      serviceId: number
      language: GuidanceLanguage
      variationSeed: string
      reasons: Array<string>
    }

// --- Deterministic helpers --------------------------------------------------

/** mulberry32 over a SHA-256-derived seed — pure and deterministic. */
function seededRng(...parts: Array<string | number>): () => number {
  const digest = createHash('sha256').update(parts.join('|'), 'utf8').digest()
  let state = digest.readUInt32BE(0) ^ digest.readUInt32BE(16)
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickDeterministic<T>(pool: Array<T>, rng: () => number): T {
  return pool[Math.floor(rng() * pool.length)]
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

// --- Canonical hash ---------------------------------------------------------

/** Stable-order canonical serialization of every render-significant
 * decision; the recipe hash is SHA-256 over this exact string. */
export function canonicalRecipeRepresentation(
  recipe: Omit<
    Extract<VideoRecipe, { status: 'RECIPE_READY' }>,
    'recipeSha256'
  >,
): string {
  const canonical = {
    serviceId: recipe.serviceId,
    sacredHouseId: recipe.sacredHouseId,
    language: recipe.language,
    variationSeed: recipe.variationSeed,
    templateId: recipe.templateId,
    templateVersionId: recipe.templateVersionId,
    templateVersionNumber: recipe.templateVersionNumber,
    templateDefinitionSha256: recipe.templateDefinitionSha256,
    visualBible: recipe.visualBible
      ? {
          visualBibleId: recipe.visualBible.visualBibleId,
          versionId: recipe.visualBible.versionId,
          versionNumber: recipe.visualBible.versionNumber,
          definitionSha256: recipe.visualBible.definitionSha256,
        }
      : null,
    targetMinSeconds: recipe.targetMinSeconds,
    targetMaxSeconds: recipe.targetMaxSeconds,
    totalEstimatedSeconds: recipe.totalEstimatedSeconds,
    segments: recipe.segments.map((segment) => ({
      segmentIndex: segment.segmentIndex,
      slotKey: segment.slotKey,
      slotPosition: segment.slotPosition,
      kind: segment.kind,
      durationSeconds: segment.durationSeconds,
      shotFamily: segment.shotFamily,
      referenceRequirement: segment.referenceRequirement,
      visualMode: segment.visualMode,
      contentItemId: segment.contentItemId,
      contentVersionId: segment.contentVersionId,
      contentSha256: segment.contentSha256,
      contentType: segment.contentType,
      themeCode: segment.themeCode,
      voicePolicy: segment.voicePolicy,
      externalAiPolicy: segment.externalAiPolicy,
      audioMode: segment.audioMode,
      audio: segment.audio
        ? {
            mediaAssetVersionId: segment.audio.mediaAssetVersionId,
            mediaAssetId: segment.audio.mediaAssetId,
            fileSha256: segment.audio.fileSha256,
            sourceType: segment.audio.sourceType,
            mimeType: segment.audio.mimeType,
            durationSeconds: segment.audio.durationSeconds,
          }
        : null,
      visual: segment.visual
        ? {
            mediaAssetVersionId: segment.visual.mediaAssetVersionId,
            mediaAssetId: segment.visual.mediaAssetId,
            fileSha256: segment.visual.fileSha256,
            assetKind: segment.visual.assetKind,
            mimeType: segment.visual.mimeType,
            scopeType: segment.visual.scopeType,
            language: segment.visual.language,
          }
        : null,
      generation: segment.generation
        ? {
            contentType: segment.generation.contentType,
            themeCode: segment.generation.themeCode,
            sacredHouseId: segment.generation.sacredHouseId,
            serviceId: segment.generation.serviceId,
            visualBibleId: segment.generation.visualBibleId,
            visualBibleVersionId: segment.generation.visualBibleVersionId,
            visualBibleVersionNumber:
              segment.generation.visualBibleVersionNumber,
            visualBibleSha256: segment.generation.visualBibleSha256,
            textContextAllowed: segment.generation.textContextAllowed,
          }
        : null,
    })),
  }
  return JSON.stringify(canonical)
}

export function computeRecipeSha256(
  recipe: Omit<
    Extract<VideoRecipe, { status: 'RECIPE_READY' }>,
    'recipeSha256'
  >,
): string {
  return createHash('sha256')
    .update(canonicalRecipeRepresentation(recipe), 'utf8')
    .digest('hex')
}

// --- Media applicability ----------------------------------------------------

const SCOPE_PREFERENCE: Array<ContentScopeType> = [
  'SERVICE',
  'SACRED_HOUSE',
  'PLATFORM',
]

/** Exported so later stages re-apply the IDENTICAL context rule when
 * they revalidate a selection (Step 15 re-proves an approved human
 * recording is still applicable to this exact Service/House) — a second
 * private copy of this rule would be a second thing to drift. */
export function isScopeApplicable(
  media: {
    scopeType: ContentScopeType
    serviceId: number | null
    sacredHouseId: number | null
  },
  context: { serviceId: number; sacredHouseId: number },
): boolean {
  if (media.scopeType === 'PLATFORM') return true
  if (media.scopeType === 'SERVICE') {
    return media.serviceId === context.serviceId
  }
  return media.sacredHouseId === context.sacredHouseId
}

/** Exported for the same reason as isScopeApplicable above. */
export function isLanguageCompatible(
  mediaLanguage: string | null,
  language: string,
): boolean {
  // null = language-neutral; otherwise EXACT requested language only.
  return mediaLanguage == null || mediaLanguage === language
}

/** Most-specific-scope-first pool split; the caller picks
 * deterministically inside the first non-empty tier. */
function preferScope<T extends { scopeType: ContentScopeType }>(
  pool: Array<T>,
): Array<T> {
  for (const scope of SCOPE_PREFERENCE) {
    const tier = pool.filter((item) => item.scopeType === scope)
    if (tier.length > 0) {
      // Stable order inside the tier before seeded selection.
      return tier
    }
  }
  return []
}

// --- Recipe builder ---------------------------------------------------------

export interface BuildVideoRecipeInput {
  serviceId: number
  language: GuidanceLanguage
  variationSeed: string
}

export async function buildValidatedVideoRecipe(
  input: BuildVideoRecipeInput,
): Promise<VideoRecipe> {
  const { serviceId, language, variationSeed } = input
  // The Service AUTHORITATIVELY determines the Sacred House.
  const service = (
    await getDb()
      .select({ sacredHouseId: services.sacredHouseId })
      .from(services)
      .where(eq(services.id, serviceId))
      .limit(1)
  ).at(0)
  if (!service) throw new VideoRecipeError('Service not found.')
  const sacredHouseId = service.sacredHouseId

  // 1. The REAL Step 9 resolver.
  const plan = await resolveApprovedPrayerSession({
    serviceId,
    language,
    variationSeed,
  })
  if (plan.status === 'NO_VALID_TEMPLATE') {
    return deepFreeze({
      status: 'RECIPE_UNAVAILABLE' as const,
      serviceId,
      language,
      variationSeed,
      reasons: ['NO_VALID_TEMPLATE'],
    })
  }

  // 2. Context media pool: ALL eligible media for this context (both
  //    language-exact and language-neutral rows), fetched once.
  const mediaPool = (
    await listAllEligibleMediaAssets({ serviceId, sacredHouseId })
  ).filter((row) => isLanguageCompatible(row.language, language))
  const context = { serviceId, sacredHouseId }

  // 3. Visual Bible: loaded lazily, verified (fail-closed) the first
  //    time any generation descriptor needs it.
  let visualBible: VisualBibleSnapshot | null = null
  let bibleResult: VisualBibleSnapshot | { failure: string } | null = null
  async function requireVisualBible(): Promise<
    VisualBibleSnapshot | { failure: string }
  > {
    if (bibleResult == null) {
      const loaded = await loadPublishedVisualBible(sacredHouseId)
      if (loaded.status === 'OK') {
        visualBible = {
          visualBibleId: loaded.visualBibleId,
          versionId: loaded.versionId,
          versionNumber: loaded.versionNumber,
          definitionSha256: loaded.definitionSha256,
        }
        bibleResult = visualBible
      } else {
        bibleResult = {
          failure: `visual_bible_${loaded.status.toLowerCase()}`,
        }
      }
    }
    return bibleResult
  }

  const reasons: Array<string> = []
  const segments: Array<RecipeSegment> = []
  let segmentIndex = 0
  let totalEstimatedSeconds = 0

  for (const slot of plan.slots) {
    if (slot.slotKind === 'SILENCE') {
      // Preserved EXACTLY from the approved template; the visual holds
      // the previous segment (renderer policy resolves a leading
      // silence — nothing is invented here).
      const duration = slot.silenceDurationSeconds ?? 0
      totalEstimatedSeconds += duration
      segments.push({
        segmentIndex: segmentIndex++,
        slotKey: slot.slotKey,
        slotPosition: slot.position,
        kind: 'SILENCE',
        durationSeconds: duration,
        shotFamily: null,
        referenceRequirement: null,
        visualMode: 'HOLD_PREVIOUS',
        contentItemId: null,
        contentVersionId: null,
        contentSha256: null,
        contentType: null,
        themeCode: null,
        voicePolicy: null,
        externalAiPolicy: null,
        audioMode: null,
        audio: null,
        visual: null,
        generation: null,
      })
      continue
    }

    for (const selection of slot.selections) {
      // --- AUDIO BINDING (authoritative Step 10 policy) --------------
      const audioResolution = await resolveSacredAudioCandidates(
        selection.contentVersionId,
      )
      const voicePolicy = audioResolution.voicePolicy
      let audioMode: RecipeSegment['audioMode'] = 'NONE'
      let audio: RecipeAudioSnapshot | null = null
      if (voicePolicy === 'TEXT_ONLY') {
        audioMode = 'NONE'
      } else {
        // CONTEXT AUTHORITY: linked audio must also be applicable to
        // THIS Service/House and the recipe language — out-of-context
        // audio is never selected, so a RECIPE_READY result can never
        // fail its own validator on audio scope.
        const candidates = audioResolution.candidates
          .filter(
            (candidate) =>
              isScopeApplicable(
                {
                  scopeType: candidate.scopeType,
                  serviceId: candidate.scopeServiceId,
                  sacredHouseId: candidate.scopeSacredHouseId,
                },
                context,
              ) && isLanguageCompatible(candidate.language, language),
          )
          .sort((a, b) => a.mediaAssetVersionId - b.mediaAssetVersionId)
        if (candidates.length > 0) {
          const rng = seededRng(
            variationSeed,
            'audio',
            selection.contentVersionId,
          )
          const chosen = pickDeterministic(candidates, rng)
          audioMode =
            voicePolicy === 'HUMAN_RECORDED_REQUIRED'
              ? 'HUMAN_RECORDED'
              : 'LINKED_HUMAN_AUDIO'
          audio = {
            mediaAssetVersionId: chosen.mediaAssetVersionId,
            mediaAssetId: chosen.assetId,
            fileSha256: chosen.fileSha256,
            sourceType: chosen.sourceType,
            mimeType: chosen.mimeType,
            durationSeconds: chosen.durationSeconds,
          }
        } else if (voicePolicy === 'HUMAN_RECORDED_REQUIRED') {
          // Fail CLOSED: sacred text that REQUIRES a human recording
          // cannot be voiced any other way.
          reasons.push(`no_human_audio:${slot.slotKey}`)
          continue
        } else {
          // APPROVED_TTS_ALLOWED with no linked human audio: a future
          // approved TTS stage MAY handle it — nothing here calls one.
          audioMode = 'TTS_ALLOWED_PENDING'
        }
      }

      // --- VISUAL BINDING -------------------------------------------
      let visualMode: RecipeSegment['visualMode'] | null = null
      let visual: RecipeVisualSnapshot | null = null
      let generation: RecipeGenerationDescriptor | null = null

      // A. Eligible linked VISUAL_REFERENCE (scope+language checked).
      // COMPLETE keyset enumeration — no silent candidate 51+ omission.
      const linkedRows: Array<{
        link: typeof sacredContentMediaLinks.$inferSelect
        version: typeof mediaAssetVersions.$inferSelect
        asset: typeof mediaAssets.$inferSelect
      }> = []
      {
        const PAGE_SIZE = 200
        const LINK_CEILING = 10_000
        let afterLinkId = 0
        for (;;) {
          const page = await getDb()
            .select({
              link: sacredContentMediaLinks,
              version: mediaAssetVersions,
              asset: mediaAssets,
            })
            .from(sacredContentMediaLinks)
            .innerJoin(
              mediaAssetVersions,
              eq(
                sacredContentMediaLinks.mediaAssetVersionId,
                mediaAssetVersions.id,
              ),
            )
            .innerJoin(
              mediaAssets,
              eq(mediaAssetVersions.assetId, mediaAssets.id),
            )
            .where(
              and(
                eq(
                  sacredContentMediaLinks.contentVersionId,
                  selection.contentVersionId,
                ),
                eq(sacredContentMediaLinks.role, 'VISUAL_REFERENCE'),
                afterLinkId > 0
                  ? gt(sacredContentMediaLinks.id, afterLinkId)
                  : undefined,
              ),
            )
            .orderBy(asc(sacredContentMediaLinks.id))
            .limit(PAGE_SIZE)
          linkedRows.push(...page)
          if (linkedRows.length > LINK_CEILING) {
            throw new VideoRecipeError(
              'Visual reference link enumeration exceeded the safety ceiling.',
            )
          }
          if (page.length < PAGE_SIZE) break
          afterLinkId = page[page.length - 1].link.id
        }
      }
      const linkedCandidates = []
      for (const row of linkedRows) {
        if (!isScopeApplicable(row.asset, context)) continue
        if (!isLanguageCompatible(row.version.language, language)) continue
        const check = await isMediaAssetRuntimeEligible({
          asset: row.asset,
          version: row.version,
        })
        if (!check.eligible) continue
        linkedCandidates.push({
          scopeType: row.asset.scopeType,
          snapshot: {
            mediaAssetVersionId: row.version.id,
            mediaAssetId: row.asset.id,
            fileSha256: row.version.fileSha256,
            assetKind: row.asset.assetKind,
            mimeType: row.version.mimeType,
            scopeType: row.asset.scopeType,
            language: row.version.language,
          } satisfies RecipeVisualSnapshot,
        })
      }
      if (linkedCandidates.length > 0) {
        const tier = preferScope(linkedCandidates).sort(
          (a, b) =>
            a.snapshot.mediaAssetVersionId - b.snapshot.mediaAssetVersionId,
        )
        const rng = seededRng(
          variationSeed,
          'visual-linked',
          selection.contentVersionId,
        )
        visual = pickDeterministic(tier, rng).snapshot
        visualMode = 'LINKED_REFERENCE'
      }

      // B. Library IMAGE/VIDEO fallback matching content type, theme
      //    (preferred when available) and context scopes.
      if (visual == null) {
        const typed = mediaPool.filter(
          (row) =>
            (row.assetKind === 'IMAGE' || row.assetKind === 'VIDEO') &&
            (row.contentType == null ||
              row.contentType === selection.contentType) &&
            isScopeApplicable(row, context),
        )
        const themed =
          selection.themeCode != null
            ? typed.filter((row) => row.themeCode === selection.themeCode)
            : []
        const pool = themed.length > 0 ? themed : typed
        if (pool.length > 0) {
          const tier = preferScope(pool).sort(
            (a, b) => a.versionId - b.versionId,
          )
          const rng = seededRng(
            variationSeed,
            'visual-library',
            selection.contentVersionId,
          )
          const chosen = pickDeterministic(tier, rng)
          visual = {
            mediaAssetVersionId: chosen.versionId,
            mediaAssetId: chosen.assetId,
            fileSha256: chosen.fileSha256,
            assetKind: chosen.assetKind,
            mimeType: chosen.mimeType,
            scopeType: chosen.scopeType,
            language: chosen.language,
          }
          visualMode = 'LIBRARY_MEDIA'
        }
      }

      // C. Future-generation descriptor — only when the sacred
      //    content's external AI policy allows it, and only with a
      //    VERIFIED published Visual Bible.
      if (visual == null) {
        if (selection.externalAiPolicy === 'NO_EXTERNAL_AI') {
          reasons.push(`no_visual_no_ai:${slot.slotKey}`)
          continue
        }
        const bible = await requireVisualBible()
        if ('failure' in bible) {
          reasons.push(bible.failure)
          continue
        }
        generation = {
          contentType: selection.contentType,
          themeCode: selection.themeCode,
          sacredHouseId,
          serviceId,
          visualBibleId: bible.visualBibleId,
          visualBibleVersionId: bible.versionId,
          visualBibleVersionNumber: bible.versionNumber,
          visualBibleSha256: bible.definitionSha256,
          // APPROVED_TEXT_CONTEXT: the approved immutable body may be
          // retrieved SERVER-SIDE by the future stage — never embedded.
          textContextAllowed:
            selection.externalAiPolicy === 'APPROVED_TEXT_CONTEXT',
        }
        visualMode = 'GENERATION_ALLOWED'
      }

      const durationSeconds =
        audio?.durationSeconds ?? selection.durationHintSeconds ?? 0
      totalEstimatedSeconds += durationSeconds
      segments.push({
        segmentIndex: segmentIndex++,
        slotKey: slot.slotKey,
        slotPosition: slot.position,
        kind: 'CONTENT',
        durationSeconds,
        shotFamily: slot.shotFamily,
        referenceRequirement: slot.referenceRequirement,
        visualMode: visualMode ?? 'HOLD_PREVIOUS',
        contentItemId: selection.contentItemId,
        contentVersionId: selection.contentVersionId,
        contentSha256: selection.contentSha256,
        contentType: selection.contentType,
        themeCode: selection.themeCode,
        voicePolicy,
        externalAiPolicy: selection.externalAiPolicy,
        audioMode,
        audio,
        visual,
        generation,
      })
    }
  }

  if (reasons.length > 0) {
    return deepFreeze({
      status: 'RECIPE_UNAVAILABLE' as const,
      serviceId,
      language,
      variationSeed,
      reasons: reasons.slice(0, 50),
    })
  }

  const body = {
    status: 'RECIPE_READY' as const,
    serviceId,
    sacredHouseId,
    language,
    variationSeed,
    templateId: plan.templateId,
    templateVersionId: plan.templateVersionId,
    templateVersionNumber: plan.templateVersionNumber,
    templateDefinitionSha256: plan.definitionSha256,
    visualBible,
    segments,
    targetMinSeconds: plan.targetMinSeconds,
    targetMaxSeconds: plan.targetMaxSeconds,
    totalEstimatedSeconds,
  }
  return deepFreeze({ ...body, recipeSha256: computeRecipeSha256(body) })
}

// --- Validator ---------------------------------------------------------------

export type RecipeValidation =
  { status: 'VALID' } | { status: 'INVALID'; reasons: Array<string> }

/**
 * Re-checks every CURRENT authority a recipe depends on. Any upstream
 * change — rights/consent withdrawal, runtime disable, content or file
 * hash mismatch, template or Visual Bible corruption, tampered recipe —
 * makes the recipe INVALID immediately. Nothing is ever auto-healed.
 */
export async function validateVideoRecipe(
  recipe: Extract<VideoRecipe, { status: 'RECIPE_READY' }>,
): Promise<RecipeValidation> {
  const reasons: Array<string> = []
  const push = (reason: string) => {
    if (reasons.length < 50) reasons.push(reason)
  }

  // Recipe integrity first: the hash must recompute exactly.
  const { recipeSha256, ...body } = recipe
  if (computeRecipeSha256(body) !== recipeSha256) {
    push('recipe_hash_mismatch')
  }

  // Service → House authority unchanged.
  const service = (
    await getDb()
      .select({ sacredHouseId: services.sacredHouseId })
      .from(services)
      .where(eq(services.id, recipe.serviceId))
      .limit(1)
  ).at(0)
  if (!service) {
    push('service_missing')
  } else if (service.sacredHouseId !== recipe.sacredHouseId) {
    push('service_house_mismatch')
  }

  // Template authority: recorded hash must equal both the stored hash
  // and a fresh recomputation over the authoritative definition.
  try {
    const templateVersion = await loadTemplateVersion(recipe.templateVersionId)
    if (templateVersion.status !== 'PUBLISHED') push('template_not_published')
    if (templateVersion.definitionSha256 !== recipe.templateDefinitionSha256) {
      push('template_hash_changed')
    }
    const definition = await loadTemplateDefinition(recipe.templateVersionId)
    if (
      computeDefinitionSha256(definition) !== recipe.templateDefinitionSha256
    ) {
      push('template_definition_corrupted')
    }
  } catch {
    push('template_missing')
  }

  // Visual Bible authority when referenced.
  const referencesBible =
    recipe.visualBible != null ||
    recipe.segments.some((segment) => segment.generation != null)
  if (referencesBible) {
    const loaded = await loadPublishedVisualBible(recipe.sacredHouseId)
    if (loaded.status !== 'OK') {
      push(`visual_bible_${loaded.status.toLowerCase()}`)
    } else if (
      recipe.visualBible &&
      (loaded.versionId !== recipe.visualBible.versionId ||
        loaded.definitionSha256 !== recipe.visualBible.definitionSha256)
    ) {
      push('visual_bible_changed')
    }
  }

  const context = {
    serviceId: recipe.serviceId,
    sacredHouseId: recipe.sacredHouseId,
  }
  for (const segment of recipe.segments) {
    if (segment.kind !== 'CONTENT' || segment.contentVersionId == null) continue
    const tag = segment.slotKey
    // Sacred content authority.
    const sacred = (
      await getDb()
        .select({
          item: spiritualContentItems,
          version: spiritualContentVersions,
          profile: sacredContentVersionProfiles,
        })
        .from(spiritualContentVersions)
        .innerJoin(
          spiritualContentItems,
          eq(spiritualContentVersions.contentItemId, spiritualContentItems.id),
        )
        .leftJoin(
          sacredContentVersionProfiles,
          eq(
            sacredContentVersionProfiles.contentVersionId,
            spiritualContentVersions.id,
          ),
        )
        .where(eq(spiritualContentVersions.id, segment.contentVersionId))
        .limit(1)
    ).at(0)
    if (!sacred || !sacred.profile) {
      push(`content_missing:${tag}`)
      continue
    }
    const eligibility = isSacredVersionRuntimeEligible({
      item: sacred.item,
      version: sacred.version,
      profile: sacred.profile,
    })
    if (!eligibility.eligible) push(`content_ineligible:${tag}`)
    if (sacred.profile.contentSha256 !== segment.contentSha256) {
      push(`content_hash_changed:${tag}`)
    }
    if (sacred.profile.voicePolicy !== segment.voicePolicy) {
      push(`voice_policy_changed:${tag}`)
    }
    // SEMANTIC authority: the segment must still describe the exact
    // current sacred content identity — item, language, type, theme,
    // scope applicability and external AI policy.
    if (sacred.item.id !== segment.contentItemId) {
      push(`content_item_mismatch:${tag}`)
    }
    if (sacred.version.language !== recipe.language) {
      push(`content_language_mismatch:${tag}`)
    }
    if (sacred.item.contentType !== segment.contentType) {
      push(`content_type_changed:${tag}`)
    }
    if (sacred.profile.themeCode !== segment.themeCode) {
      push(`content_theme_changed:${tag}`)
    }
    if (
      !isScopeApplicable(
        {
          scopeType: sacred.item.scopeType,
          serviceId: sacred.item.serviceId,
          sacredHouseId: sacred.item.sacredHouseId,
        },
        context,
      )
    ) {
      push(`content_scope_inapplicable:${tag}`)
    }
    if (sacred.profile.externalAiPolicy !== segment.externalAiPolicy) {
      push(`ai_policy_changed:${tag}`)
    }

    // GENERATION descriptors: mode/descriptor coherence plus current
    // authoritative semantics — independent of the recipe checksum.
    if (
      (segment.visualMode === 'GENERATION_ALLOWED') !==
      (segment.generation != null)
    ) {
      push(`generation_mode_inconsistent:${tag}`)
    }
    if (segment.generation != null && segment.visual != null) {
      push(`generation_mode_inconsistent:${tag}`)
    }
    if (segment.generation) {
      const descriptor = segment.generation
      if (sacred.profile.externalAiPolicy === 'NO_EXTERNAL_AI') {
        push(`generation_ai_policy_forbidden:${tag}`)
      }
      if (
        descriptor.serviceId !== recipe.serviceId ||
        descriptor.sacredHouseId !== recipe.sacredHouseId
      ) {
        push(`generation_context_mismatch:${tag}`)
      }
      if (
        descriptor.contentType !== sacred.item.contentType ||
        descriptor.themeCode !== sacred.profile.themeCode
      ) {
        push(`generation_content_mismatch:${tag}`)
      }
      if (
        !recipe.visualBible ||
        descriptor.visualBibleId !== recipe.visualBible.visualBibleId ||
        descriptor.visualBibleVersionId !== recipe.visualBible.versionId ||
        descriptor.visualBibleSha256 !== recipe.visualBible.definitionSha256
      ) {
        push(`generation_bible_mismatch:${tag}`)
      }
      if (
        descriptor.textContextAllowed !==
        (sacred.profile.externalAiPolicy === 'APPROVED_TEXT_CONTEXT')
      ) {
        push(`generation_text_context_mismatch:${tag}`)
      }
    }

    // Selected media authority (audio + visual snapshots).
    const mediaChecks: Array<{
      label: string
      versionId: number
      fileSha256: string
    }> = []
    if (segment.audio) {
      mediaChecks.push({
        label: 'audio',
        versionId: segment.audio.mediaAssetVersionId,
        fileSha256: segment.audio.fileSha256,
      })
    }
    if (segment.visual) {
      mediaChecks.push({
        label: 'visual',
        versionId: segment.visual.mediaAssetVersionId,
        fileSha256: segment.visual.fileSha256,
      })
    }
    for (const check of mediaChecks) {
      const media = (
        await getDb()
          .select({ version: mediaAssetVersions, asset: mediaAssets })
          .from(mediaAssetVersions)
          .innerJoin(
            mediaAssets,
            eq(mediaAssetVersions.assetId, mediaAssets.id),
          )
          .where(eq(mediaAssetVersions.id, check.versionId))
          .limit(1)
      ).at(0)
      if (!media) {
        push(`${check.label}_missing:${tag}`)
        continue
      }
      const mediaEligibility = await isMediaAssetRuntimeEligible({
        asset: media.asset,
        version: media.version,
      })
      if (!mediaEligibility.eligible) push(`${check.label}_ineligible:${tag}`)
      if (media.version.fileSha256 !== check.fileSha256) {
        push(`${check.label}_hash_changed:${tag}`)
      }
      if (!isScopeApplicable(media.asset, context)) {
        push(`${check.label}_scope_inapplicable:${tag}`)
      }
      if (!isLanguageCompatible(media.version.language, recipe.language)) {
        push(`${check.label}_language_incompatible:${tag}`)
      }
    }

    // LINK AUTHORITY: any selected linked audio must STILL be a current
    // eligible PRIMARY/ALTERNATE audio candidate for this exact sacred
    // version — removing the governing link invalidates immediately.
    if (
      segment.audioMode === 'HUMAN_RECORDED' ||
      segment.audioMode === 'LINKED_HUMAN_AUDIO'
    ) {
      if (!segment.audio) {
        push(`audio_snapshot_missing:${tag}`)
      } else {
        try {
          const audioNow = await resolveSacredAudioCandidates(
            segment.contentVersionId,
          )
          if (
            !audioNow.candidates.some(
              (candidate) =>
                candidate.mediaAssetVersionId ===
                segment.audio!.mediaAssetVersionId,
            )
          ) {
            push(`audio_no_longer_linked:${tag}`)
          }
        } catch {
          push(`audio_unresolvable:${tag}`)
        }
      }
    }
    if (segment.voicePolicy === 'HUMAN_RECORDED_REQUIRED') {
      if (!segment.audio || segment.audioMode !== 'HUMAN_RECORDED') {
        push(`human_audio_missing:${tag}`)
      }
    }

    // LINKED_REFERENCE visuals must STILL hold the exact link.
    if (segment.visualMode === 'LINKED_REFERENCE') {
      if (!segment.visual) {
        push(`visual_snapshot_missing:${tag}`)
      } else {
        const linkRow = await getDb()
          .select({ id: sacredContentMediaLinks.id })
          .from(sacredContentMediaLinks)
          .where(
            and(
              eq(
                sacredContentMediaLinks.contentVersionId,
                segment.contentVersionId,
              ),
              eq(
                sacredContentMediaLinks.mediaAssetVersionId,
                segment.visual.mediaAssetVersionId,
              ),
              eq(sacredContentMediaLinks.role, 'VISUAL_REFERENCE'),
            ),
          )
          .limit(1)
        if (linkRow.length === 0) {
          push(`visual_link_missing:${tag}`)
        }
      }
    }
  }

  return reasons.length === 0
    ? { status: 'VALID' }
    : { status: 'INVALID', reasons }
}
