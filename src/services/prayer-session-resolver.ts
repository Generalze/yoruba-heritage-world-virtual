import { createHash } from 'node:crypto'

import { and, eq, gt, or } from 'drizzle-orm'

import { getDb } from '@/db'
import type {
  SlotReferenceRequirement,
  SlotShotFamily,
} from '@/db/schema/prayer-templates'
import {
  prayerSessionTemplateVersions,
  prayerSessionTemplates,
  services,
} from '@/db/schema'
import { listAllEligibleSacredRuntimeContent } from './sacred-content'
import {
  PrayerTemplateError,
  computeDefinitionSha256,
  loadTemplateDefinition,
} from './prayer-templates'
import type { ContentScopeType, GuidanceLanguage } from '@/db/schema'

/**
 * Autonomous prayer session resolver (Phase One, Step 9).
 *
 * Executes ONLY human-approved published template rules over ONLY
 * Step 8 runtime-eligible sacred content. No human is consulted per
 * appointment; no user/private data is required; no AI is called; no
 * sacred content is ever invented, substituted or altered. If the
 * approved rules cannot currently be satisfied (content withdrawn,
 * disabled, ineligible), the resolver tries other applicable published
 * templates and otherwise fails CLOSED with NO_VALID_TEMPLATE.
 *
 * Determinism: identical input (context + variationSeed) against the
 * same committed database state produces the identical resolved plan.
 * Different seeds may legitimately produce different APPROVED
 * combinations — variation is drawn from a seeded deterministic PRNG,
 * never from wall-clock time or Math.random.
 */

export interface ResolvePrayerSessionInput {
  serviceId?: number
  sacredHouseId?: number
  language: GuidanceLanguage
  variationSeed: string
}

export interface ResolvedContentSelection {
  contentItemId: number
  contentVersionId: number
  contentSha256: string
  code: string
  contentType: string
  scopeType: ContentScopeType
  language: string
  versionNumber: number
  variantKind: string
  themeCode: string | null
  durationHintSeconds: number | null
  repeatable: boolean
  voicePolicy: string
  externalAiPolicy: string
  body?: string
}

export interface ResolvedSlot {
  slotKey: string
  position: number
  slotKind: 'CONTENT' | 'SILENCE'
  silenceDurationSeconds: number | null
  /** The template's AUTHORED camera decision, carried verbatim from the
   * approved (and hash-verified) definition. Never inferred here. */
  shotFamily: SlotShotFamily | null
  referenceRequirement: SlotReferenceRequirement | null
  selections: Array<ResolvedContentSelection>
}

export type ResolvedPrayerSession =
  | {
      status: 'RESOLVED'
      templateId: number
      templatePublicId: string
      templateCode: string
      templateScopeType: ContentScopeType
      templateVersionId: number
      templateVersionNumber: number
      definitionSha256: string
      language: GuidanceLanguage
      targetMinSeconds: number
      targetMaxSeconds: number
      estimatedSeconds: number
      variationSeed: string
      slots: Array<ResolvedSlot>
    }
  | {
      status: 'NO_VALID_TEMPLATE'
      language: GuidanceLanguage
      variationSeed: string
      consideredTemplates: number
    }

// --- Deterministic PRNG -----------------------------------------------------

/** mulberry32 over a SHA-256-derived seed: pure, deterministic,
 * dependency-free. NEVER uses Date.now or Math.random. */
function seededRng(...parts: Array<string | number>): () => number {
  const digest = createHash('sha256')
    .update(parts.join('\u0000'), 'utf8')
    .digest()
  let state = digest.readUInt32BE(0) ^ digest.readUInt32BE(16)
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic Fisher–Yates shuffle (does not mutate the input). */
function seededShuffle<T>(items: Array<T>, rng: () => number): Array<T> {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** Deterministic weighted pick; returns the chosen index. */
function weightedPick(weights: Array<number>, rng: () => number): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  let roll = rng() * total
  for (let i = 0; i < weights.length; i += 1) {
    roll -= weights[i]
    if (roll < 0) return i
  }
  return weights.length - 1
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

// --- Resolver ---------------------------------------------------------------

type Candidate = Awaited<
  ReturnType<typeof listAllEligibleSacredRuntimeContent>
>[number] & { body?: string }

const SCOPE_SPECIFICITY: Array<ContentScopeType> = [
  'SERVICE',
  'SACRED_HOUSE',
  'PLATFORM',
]

export async function resolveApprovedPrayerSession(
  input: ResolvePrayerSessionInput,
  options: { includeBodies?: boolean } = {},
): Promise<ResolvedPrayerSession> {
  const { language, variationSeed } = input
  // Server-side context derivation: the Service AUTHORITATIVELY
  // determines its Sacred House. A caller-supplied House that
  // contradicts the Service's House is rejected — a Service context is
  // never combined with an unrelated House.
  const serviceId = input.serviceId
  let sacredHouseId = input.sacredHouseId
  if (serviceId != null) {
    const service = (
      await getDb()
        .select({ sacredHouseId: services.sacredHouseId })
        .from(services)
        .where(eq(services.id, serviceId))
        .limit(1)
    ).at(0)
    if (!service) throw new PrayerTemplateError('Service not found.')
    if (sacredHouseId != null && sacredHouseId !== service.sacredHouseId) {
      throw new PrayerTemplateError(
        'The supplied Sacred House does not match the Service’s House.',
      )
    }
    sacredHouseId = service.sacredHouseId
  }

  // Applicable ACTIVE templates with a PUBLISHED version in this exact
  // language (no fallback), grouped by scope specificity.
  const scopeConditions = [eq(prayerSessionTemplates.scopeType, 'PLATFORM')]
  if (serviceId != null) {
    scopeConditions.push(
      and(
        eq(prayerSessionTemplates.scopeType, 'SERVICE'),
        eq(prayerSessionTemplates.serviceId, serviceId),
      )!,
    )
  }
  if (sacredHouseId != null) {
    scopeConditions.push(
      and(
        eq(prayerSessionTemplates.scopeType, 'SACRED_HOUSE'),
        eq(prayerSessionTemplates.sacredHouseId, sacredHouseId),
      )!,
    )
  }
  // COMPLETE applicable-template enumeration: keyset pagination on the
  // version id (bounded pages, no silent truncation) with an explicit
  // safety ceiling that errors loudly instead of dropping templates.
  const PAGE_SIZE = 500
  const TEMPLATE_CEILING = 100_000
  const applicable: Array<{
    template: typeof prayerSessionTemplates.$inferSelect
    version: typeof prayerSessionTemplateVersions.$inferSelect
  }> = []
  let afterVersionId = 0
  for (;;) {
    const page = await getDb()
      .select({
        template: prayerSessionTemplates,
        version: prayerSessionTemplateVersions,
      })
      .from(prayerSessionTemplates)
      .innerJoin(
        prayerSessionTemplateVersions,
        eq(prayerSessionTemplateVersions.templateId, prayerSessionTemplates.id),
      )
      .where(
        and(
          eq(prayerSessionTemplates.active, true),
          eq(prayerSessionTemplateVersions.status, 'PUBLISHED'),
          eq(prayerSessionTemplateVersions.language, language),
          or(...scopeConditions),
          afterVersionId > 0
            ? gt(prayerSessionTemplateVersions.id, afterVersionId)
            : undefined,
        ),
      )
      .orderBy(prayerSessionTemplateVersions.id)
      .limit(PAGE_SIZE)
    applicable.push(...page)
    if (applicable.length > TEMPLATE_CEILING) {
      throw new PrayerTemplateError(
        'Applicable-template enumeration exceeded the safety ceiling.',
      )
    }
    if (page.length < PAGE_SIZE) break
    afterVersionId = page[page.length - 1].version.id
  }

  // Candidate pool fetched ONCE per resolution: the COMPLETE
  // runtime-eligible set for this context (keyset-paginated past the
  // 500-row per-query bound).
  const candidates: Array<Candidate> =
    await listAllEligibleSacredRuntimeContent(
      {
        language,
        ...(serviceId != null ? { serviceId } : {}),
        ...(sacredHouseId != null ? { sacredHouseId } : {}),
      },
      { includeBody: options.includeBodies === true },
    )

  // Deterministic template attempt order: specificity first, then
  // priority (desc); ties broken by seeded selection_weight variation.
  const attemptOrder: Array<(typeof applicable)[number]> = []
  for (const scope of SCOPE_SPECIFICITY) {
    const inScope = applicable.filter((row) => row.template.scopeType === scope)
    const priorities = [
      ...new Set(inScope.map((row) => row.version.priority)),
    ].sort((a, b) => b - a)
    for (const priority of priorities) {
      const tier = inScope
        .filter((row) => row.version.priority === priority)
        // Stable base order before seeded weighting.
        .sort((a, b) => a.version.id - b.version.id)
      const rng = seededRng(variationSeed, 'template-order', scope, priority)
      const remaining = [...tier]
      while (remaining.length > 0) {
        const index = weightedPick(
          remaining.map((row) => row.version.selectionWeight),
          rng,
        )
        attemptOrder.push(remaining[index])
        remaining.splice(index, 1)
      }
    }
  }

  for (const attempt of attemptOrder) {
    const resolved = await tryResolveTemplate(
      attempt.template,
      attempt.version,
      candidates,
      variationSeed,
    )
    if (resolved) {
      return deepFreeze(resolved)
    }
  }
  return deepFreeze({
    status: 'NO_VALID_TEMPLATE' as const,
    language,
    variationSeed,
    consideredTemplates: attemptOrder.length,
  })
}

async function tryResolveTemplate(
  template: typeof prayerSessionTemplates.$inferSelect,
  version: typeof prayerSessionTemplateVersions.$inferSelect,
  candidates: Array<Candidate>,
  variationSeed: string,
): Promise<Extract<ResolvedPrayerSession, { status: 'RESOLVED' }> | null> {
  const definition = await loadTemplateDefinition(version.id)
  // Runtime integrity gate: the stored definition hash must exactly
  // match a fresh recomputation over the authoritative normalized
  // rows. Missing/mismatched → this template fails CLOSED (the caller
  // tries the next applicable one); the hash is NEVER auto-healed.
  const verifiedDefinitionSha256 = version.definitionSha256
  if (
    verifiedDefinitionSha256 == null ||
    verifiedDefinitionSha256 !== computeDefinitionSha256(definition)
  ) {
    return null
  }
  const forbidden = new Set(
    definition.forbiddenPairs.map(
      (pair) => `${pair.contentItemIdA}:${pair.contentItemIdB}`,
    ),
  )
  const isForbiddenWith = (itemId: number, usedItemIds: Set<number>) => {
    for (const used of usedItemIds) {
      const a = Math.min(itemId, used)
      const b = Math.max(itemId, used)
      if (forbidden.has(`${a}:${b}`)) return true
    }
    return false
  }
  const candidateByVersionId = new Map(
    candidates.map((candidate) => [candidate.contentVersionId, candidate]),
  )
  const usedItemIds = new Set<number>()
  const repeatableByItem = new Map<number, boolean>()
  const slots: Array<ResolvedSlot> = []
  let estimatedSeconds = 0

  for (const slot of definition.slots) {
    if (slot.slotKind === 'SILENCE') {
      estimatedSeconds += slot.silenceDurationSeconds ?? 0
      slots.push({
        slotKey: slot.slotKey,
        position: slot.position,
        slotKind: 'SILENCE',
        silenceDurationSeconds: slot.silenceDurationSeconds,
        shotFamily: null,
        referenceRequirement: null,
        selections: [],
      })
      continue
    }
    // Candidate pool for this slot — every entry is ALREADY verified
    // runtime-eligible at selection time by the Step 8 authority query.
    let pool: Array<Candidate>
    if (slot.selectorMode === 'PINNED_VERSIONS') {
      pool = slot.pins
        .map((pin) => candidateByVersionId.get(pin.contentVersionId))
        .filter((candidate): candidate is Candidate => candidate != null)
    } else {
      pool = candidates.filter(
        (candidate) =>
          candidate.contentType === slot.contentType &&
          (slot.themeCode == null || candidate.themeCode === slot.themeCode) &&
          (slot.variantKind == null ||
            candidate.variantKind === slot.variantKind) &&
          slot.allowedScopes.includes(candidate.scopeType),
      )
    }
    const rng = seededRng(variationSeed, 'slot', version.id, slot.slotKey)
    const shuffled = seededShuffle(pool, rng)
    const selections: Array<ResolvedContentSelection> = []
    const selectedVersionIds = new Set<number>()
    for (const candidate of shuffled) {
      if (selections.length >= slot.maxSelect) break
      if (selectedVersionIds.has(candidate.contentVersionId)) continue
      const priorUse = usedItemIds.has(candidate.contentItemId)
      if (priorUse) {
        // A non-repeatable item never appears twice in one session;
        // repeatable items may recur across slots (leadership's flag).
        const repeatable =
          repeatableByItem.get(candidate.contentItemId) ?? candidate.repeatable
        if (!repeatable) continue
      }
      if (isForbiddenWith(candidate.contentItemId, usedItemIds)) continue
      if (candidate.contentSha256 == null) continue
      selections.push({
        contentItemId: candidate.contentItemId,
        contentVersionId: candidate.contentVersionId,
        contentSha256: candidate.contentSha256,
        code: candidate.code,
        contentType: candidate.contentType,
        scopeType: candidate.scopeType,
        language: candidate.language,
        versionNumber: candidate.versionNumber,
        variantKind: candidate.variantKind,
        themeCode: candidate.themeCode,
        durationHintSeconds: candidate.durationHintSeconds,
        repeatable: candidate.repeatable,
        voicePolicy: candidate.voicePolicy,
        externalAiPolicy: candidate.externalAiPolicy,
        ...(candidate.body != null ? { body: candidate.body } : {}),
      })
      selectedVersionIds.add(candidate.contentVersionId)
      usedItemIds.add(candidate.contentItemId)
      repeatableByItem.set(candidate.contentItemId, candidate.repeatable)
    }
    if (selections.length < slot.minSelect) {
      // Mandatory selection unsatisfiable — the WHOLE template fails;
      // the caller tries the next applicable published template. No
      // substitute content is ever invented.
      return null
    }
    estimatedSeconds += selections.reduce(
      (sum, selection) => sum + (selection.durationHintSeconds ?? 0),
      0,
    )
    slots.push({
      slotKey: slot.slotKey,
      position: slot.position,
      slotKind: 'CONTENT',
      silenceDurationSeconds: null,
      shotFamily: slot.shotFamily,
      referenceRequirement: slot.referenceRequirement,
      selections,
    })
  }

  return {
    status: 'RESOLVED',
    templateId: template.id,
    templatePublicId: template.publicId,
    templateCode: template.code,
    templateScopeType: template.scopeType,
    templateVersionId: version.id,
    templateVersionNumber: version.versionNumber,
    definitionSha256: verifiedDefinitionSha256,
    language: version.language,
    targetMinSeconds: version.targetMinSeconds,
    targetMaxSeconds: version.targetMaxSeconds,
    estimatedSeconds,
    variationSeed,
    slots,
  }
}
