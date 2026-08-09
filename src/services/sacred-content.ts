import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  ACCESS_POLICIES,
  CONTENT_SCOPE_TYPES,
  EXTERNAL_AI_POLICIES,
  GUIDANCE_LANGUAGES,
  PROVENANCE_TYPES,
  RIGHTS_STATUSES,
  SACRED_RUNTIME_CONTENT_TYPES,
  VARIANT_KINDS,
  VOICE_POLICIES,
  sacredContentVersionProfiles,
  spiritualContentItems,
  spiritualContentVersions,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import {
  SpiritualContentError,
  allocateDraftVersionUnderLockedItem,
  computeBodySha256,
  createContentItemInternal,
  domainOfItem,
  loadVersion,
  lockContentItem,
} from './spiritual-content'
import type { DbClient } from '@/db'
import type { ContentVersionInput } from './spiritual-content'
import type { GuidanceLanguage, RightsStatus } from '@/db/schema'
import type { RequestContext } from '@/auth/service'

/**
 * Approved sacred runtime content library (Step 8).
 *
 * Governing principle: HUMANS APPROVE THE KNOWLEDGE AND BOUNDARIES
 * ONCE; the platform operates autonomously inside those approved
 * boundaries. Human approval is UPSTREAM only — cultural publication
 * (the shared Step 7 version machine), rights clearance (independent
 * gate on immutable text) and the runtime_enabled operational switch.
 * Runtime eligibility is COMPUTED from those gates plus a SHA-256
 * integrity hash; NO per-appointment human approval ever exists, and
 * no external legal/cultural service is called at runtime.
 *
 * HARD RULE: every sacred body here is HUMAN-AUTHORED. This module
 * never generates, rewrites, translates, summarizes or infers sacred
 * text, and no AI provider is reachable from it. external_ai_policy is
 * a FUTURE permission boundary only — nothing in Step 8 calls any AI
 * regardless of its value.
 */

// --- Validation schemas -----------------------------------------------------

export const sacredItemSchema = z.object({
  code: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]{2,59}$/,
      'Code must be an UPPER_SNAKE_CASE ASCII identifier (3–60 chars).',
    ),
  contentType: z.enum(SACRED_RUNTIME_CONTENT_TYPES),
  scopeType: z.enum(CONTENT_SCOPE_TYPES),
  sacredHouseId: z.number().int().positive().nullable().optional(),
  serviceId: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().min(-1000).max(1000).default(0),
})
export type SacredItemInput = z.infer<typeof sacredItemSchema>

/** Authored profile fields — editable ONLY while the version is DRAFT.
 * After the version leaves DRAFT they are immutable; corrections
 * require a NEW version. Plain text only, bounded lengths (spec §18). */
export const sacredProfileSchema = z.object({
  variantKind: z.enum(VARIANT_KINDS).default('ORIGINAL'),
  provenanceType: z.enum(PROVENANCE_TYPES),
  sourceCommunity: z.string().trim().max(255).nullable().default(null),
  sourcePlace: z.string().trim().max(255).nullable().default(null),
  sourceReference: z.string().trim().max(1000).nullable().default(null),
  publicAttributionText: z.string().trim().max(500).nullable().default(null),
  internalProvenanceNote: z.string().trim().max(2000).nullable().default(null),
  digitalStorageAuthorized: z.boolean().default(false),
  themeCode: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]{0,59}$/,
      'Theme code must be an UPPER_SNAKE_CASE ASCII identifier (max 60 chars).',
    )
    .nullable()
    .default(null),
  durationHintSeconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .nullable()
    .default(null),
  repeatable: z.boolean().default(false),
  voicePolicy: z.enum(VOICE_POLICIES),
  externalAiPolicy: z.enum(EXTERNAL_AI_POLICIES).default('METADATA_ONLY'),
  accessPolicy: z.enum(ACCESS_POLICIES).default('STAFF_ONLY'),
})
export type SacredProfileInput = z.infer<typeof sacredProfileSchema>

/** Sacred bodies carry no Step 7 delivery flags: they are never shown
 * as appointment guidance, never acknowledged and NEVER language-
 * fallback-eligible (exact requested language only, spec §16). */
export const sacredVersionSchema = z.object({
  language: z.enum(GUIDANCE_LANGUAGES),
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(20_000),
})
export type SacredVersionInput = z.infer<typeof sacredVersionSchema>

// --- Domain guard -----------------------------------------------------------

/** Cross-domain server authority (spec §49): sacred routes act only on
 * SACRED_RUNTIME items, guidance routes only on GUIDANCE. The domain
 * is immutable, so this pre-check cannot go stale. */
export async function requireVersionDomain(
  versionId: number,
  domain: 'GUIDANCE' | 'SACRED_RUNTIME',
): Promise<void> {
  const version = await loadVersion(versionId)
  if ((await domainOfItem(version.contentItemId)) !== domain) {
    throw new SpiritualContentError('Content version not found.')
  }
}

// --- Item & version creation ------------------------------------------------

export async function createSacredContentItem(
  actorId: number,
  ctx: RequestContext,
  input: SacredItemInput,
): Promise<{ id: number; publicId: string }> {
  return createContentItemInternal(actorId, ctx, input, 'SACRED_RUNTIME')
}

/**
 * Atomic sacred version + profile creation (spec §47): a SACRED_RUNTIME
 * version must never exist without its profile. One transaction: lock
 * item → verify domain → allocate version number (shared one-working-
 * version rule) → insert DRAFT → insert profile. A profile failure
 * rolls the version back.
 */
export async function createSacredVersion(
  actorId: number,
  ctx: RequestContext,
  itemId: number,
  rawVersion: SacredVersionInput,
  rawProfile: SacredProfileInput,
): Promise<{ id: number; versionNumber: number }> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const version = sacredVersionSchema.parse(rawVersion)
  const profile = sacredProfileSchema.parse(rawProfile)
  const body = normalizeSacredBody(version.body)
  const result = await getDb().transaction(async (tx) => {
    const item = await lockContentItem(tx, itemId)
    if (item.contentDomain !== 'SACRED_RUNTIME') {
      throw new SpiritualContentError(
        'Guidance versions are created through the guidance workflow.',
      )
    }
    const versionInput: ContentVersionInput = {
      language: version.language,
      title: version.title,
      body,
      // Fixed neutral values — sacred content never participates in
      // Step 7 visibility/acknowledgement/fallback delivery.
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    }
    const allocated = await allocateDraftVersionUnderLockedItem(
      tx,
      itemId,
      versionInput,
      actorId,
    )
    await tx.insert(sacredContentVersionProfiles).values({
      contentVersionId: allocated.id,
      contentItemId: itemId,
      variantKind: profile.variantKind,
      provenanceType: profile.provenanceType,
      sourceCommunity: profile.sourceCommunity,
      sourcePlace: profile.sourcePlace,
      sourceReference: profile.sourceReference,
      publicAttributionText: profile.publicAttributionText,
      internalProvenanceNote: profile.internalProvenanceNote,
      digitalStorageAuthorized: profile.digitalStorageAuthorized,
      themeCode: profile.themeCode,
      durationHintSeconds: profile.durationHintSeconds,
      repeatable: profile.repeatable,
      voicePolicy: profile.voicePolicy,
      externalAiPolicy: profile.externalAiPolicy,
      accessPolicy: profile.accessPolicy,
    })
    return allocated
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'sacred_content.version_created',
    entityType: 'spiritual_content_version',
    entityId: String(result.id),
    metadata: {
      contentItemId: itemId,
      language: version.language,
      versionNumber: result.versionNumber,
      variantKind: profile.variantKind,
      provenanceType: profile.provenanceType,
      voicePolicy: profile.voicePolicy,
      externalAiPolicy: profile.externalAiPolicy,
      accessPolicy: profile.accessPolicy,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return result
}

function normalizeSacredBody(body: string): string {
  const normalized = body.replace(/^\s+$/, '').replace(/\s+$/, '')
  if (normalized.length === 0) {
    throw new SpiritualContentError('Sacred body must not be empty.')
  }
  return normalized
}

/** DRAFT-only sacred body/title editing (shared immutability rules). */
export async function updateSacredDraftVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  rawInput: { title: string; body: string },
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.manage')
  await requireVersionDomain(versionId, 'SACRED_RUNTIME')
  const current = await loadVersion(versionId)
  const title = z.string().trim().min(1).max(200).parse(rawInput.title)
  const body = normalizeSacredBody(
    z.string().min(1).max(20_000).parse(rawInput.body),
  )
  const result = await getDb()
    .update(spiritualContentVersions)
    .set({ title, body })
    .where(
      and(
        eq(spiritualContentVersions.id, versionId),
        eq(spiritualContentVersions.status, 'DRAFT'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new SpiritualContentError('Only draft versions can be edited.')
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'sacred_content.version_updated',
    entityType: 'spiritual_content_version',
    entityId: String(versionId),
    metadata: {
      contentItemId: current.contentItemId,
      language: current.language,
      versionNumber: current.versionNumber,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/**
 * DRAFT-only profile editing (spec §21). Once the version leaves DRAFT
 * the authored/runtime-policy fields are immutable — emergency blocking
 * uses rights_status / runtime_enabled, never in-place edits. Lock
 * order: CONTENT ITEM → VERSION/PROFILE (same as everywhere).
 */
export async function updateSacredProfile(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  rawProfile: SacredProfileInput,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.manage')
  await requireVersionDomain(versionId, 'SACRED_RUNTIME')
  const profile = sacredProfileSchema.parse(rawProfile)
  const current = await loadVersion(versionId)
  await getDb().transaction(async (tx) => {
    await lockContentItem(tx, current.contentItemId)
    const target = (
      await tx
        .select({ status: spiritualContentVersions.status })
        .from(spiritualContentVersions)
        .where(eq(spiritualContentVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target || target.status !== 'DRAFT') {
      throw new SpiritualContentError(
        'Profile fields are immutable once the version leaves draft — create a new version instead.',
      )
    }
    const result = await tx
      .update(sacredContentVersionProfiles)
      .set({
        variantKind: profile.variantKind,
        provenanceType: profile.provenanceType,
        sourceCommunity: profile.sourceCommunity,
        sourcePlace: profile.sourcePlace,
        sourceReference: profile.sourceReference,
        publicAttributionText: profile.publicAttributionText,
        internalProvenanceNote: profile.internalProvenanceNote,
        digitalStorageAuthorized: profile.digitalStorageAuthorized,
        themeCode: profile.themeCode,
        durationHintSeconds: profile.durationHintSeconds,
        repeatable: profile.repeatable,
        voicePolicy: profile.voicePolicy,
        externalAiPolicy: profile.externalAiPolicy,
        accessPolicy: profile.accessPolicy,
      })
      .where(eq(sacredContentVersionProfiles.contentVersionId, versionId))
    if (result[0].affectedRows !== 1) {
      throw new SpiritualContentError(
        'This sacred version has no runtime profile.',
      )
    }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'sacred_content.profile_updated',
    entityType: 'sacred_content_version_profile',
    entityId: String(versionId),
    // Safe machine metadata only — never provenance/rights note text.
    metadata: {
      contentItemId: current.contentItemId,
      versionNumber: current.versionNumber,
      variantKind: profile.variantKind,
      provenanceType: profile.provenanceType,
      voicePolicy: profile.voicePolicy,
      externalAiPolicy: profile.externalAiPolicy,
      accessPolicy: profile.accessPolicy,
      digitalStorageAuthorized: profile.digitalStorageAuthorized,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Rights workflow (independent gate, spec §22–§24) -----------------------

const RIGHTS_TRANSITIONS: Record<RightsStatus, Array<RightsStatus>> = {
  UNREVIEWED: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['CLEARED', 'RESTRICTED'],
  CLEARED: ['RESTRICTED', 'WITHDRAWN'],
  RESTRICTED: ['PENDING_REVIEW'],
  WITHDRAWN: ['PENDING_REVIEW'],
}

const RIGHTS_AUDIT_ACTION: Record<RightsStatus, string> = {
  UNREVIEWED: 'sacred_content.rights_unreviewed',
  PENDING_REVIEW: 'sacred_content.rights_pending',
  CLEARED: 'sacred_content.rights_cleared',
  RESTRICTED: 'sacred_content.rights_restricted',
  WITHDRAWN: 'sacred_content.rights_withdrawn',
}

/**
 * Rights status transition — ADMIN/SUPER_ADMIN only, via the dedicated
 * sacred_content.rights_manage permission (CONTENT_MANAGER can never
 * clear rights). CLEARED is only reachable while the version text is
 * IMMUTABLE (APPROVED/PUBLISHED) so a rights review can never clear one
 * body and have an author silently edit it afterward. Rights and
 * cultural publication remain independent gates; runtime eligibility
 * requires both simultaneously.
 */
export async function setSacredRightsStatus(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  next: RightsStatus,
  note?: string,
): Promise<void> {
  await requirePermission(actorId, 'sacred_content.rights_manage')
  await requireVersionDomain(versionId, 'SACRED_RUNTIME')
  if (!RIGHTS_STATUSES.includes(next)) {
    throw new SpiritualContentError('Unknown rights status.')
  }
  const trimmedNote = note?.trim() ?? ''
  if ((next === 'RESTRICTED' || next === 'WITHDRAWN') && !trimmedNote) {
    throw new SpiritualContentError(
      'Restricting or withdrawing rights requires a reason note.',
    )
  }
  if (trimmedNote.length > 1000) {
    throw new SpiritualContentError(
      'Rights note must be at most 1000 characters.',
    )
  }
  const current = await loadVersion(versionId)
  const previous = await getDb().transaction(async (tx) => {
    // Lock order: CONTENT ITEM → VERSION/PROFILE, same as publication —
    // rights mutations can never deadlock against publish.
    await lockContentItem(tx, current.contentItemId)
    const row = (
      await tx
        .select({
          rightsStatus: sacredContentVersionProfiles.rightsStatus,
        })
        .from(sacredContentVersionProfiles)
        .where(eq(sacredContentVersionProfiles.contentVersionId, versionId))
        .limit(1)
    ).at(0)
    if (!row) {
      throw new SpiritualContentError(
        'This sacred version has no runtime profile.',
      )
    }
    if (!RIGHTS_TRANSITIONS[row.rightsStatus].includes(next)) {
      throw new SpiritualContentError(
        `Rights cannot move from ${row.rightsStatus} to ${next}.`,
      )
    }
    if (next === 'CLEARED') {
      const version = (
        await tx
          .select({ status: spiritualContentVersions.status })
          .from(spiritualContentVersions)
          .where(eq(spiritualContentVersions.id, versionId))
          .limit(1)
      ).at(0)
      if (
        !version ||
        (version.status !== 'APPROVED' && version.status !== 'PUBLISHED')
      ) {
        throw new SpiritualContentError(
          'Rights can only be cleared on immutable (approved or published) text.',
        )
      }
    }
    const updated = await tx
      .update(sacredContentVersionProfiles)
      .set({
        rightsStatus: next,
        rightsReviewedBy: actorId,
        rightsReviewedAt: new Date(),
        rightsNote: trimmedNote || null,
      })
      .where(
        and(
          eq(sacredContentVersionProfiles.contentVersionId, versionId),
          eq(sacredContentVersionProfiles.rightsStatus, row.rightsStatus),
        ),
      )
    if (updated[0].affectedRows !== 1) {
      throw new SpiritualContentError('Rights transition conflict — try again.')
    }
    return row.rightsStatus
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: RIGHTS_AUDIT_ACTION[next],
    entityType: 'sacred_content_version_profile',
    entityId: String(versionId),
    // Old/new state only — the rights note text is staff operational
    // data and never enters audit metadata.
    metadata: {
      contentItemId: current.contentItemId,
      language: current.language,
      versionNumber: current.versionNumber,
      from: previous,
      to: next,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Runtime eligibility (computed — never a stored status) ------------------

export interface SacredEligibilityInput {
  item: {
    contentDomain: string
    contentType: string
    active: boolean
  }
  version: {
    status: string
    language: string
    body: string
  }
  profile: {
    digitalStorageAuthorized: boolean
    rightsStatus: string
    accessPolicy: string
    runtimeEnabled: boolean
    contentSha256: string | null
  } | null
}

/**
 * THE central runtime eligibility formula (spec §36). Every gate must
 * hold simultaneously; the answer is computed, never stored. A hash
 * mismatch fails CLOSED and is never auto-healed.
 */
export function isSacredVersionRuntimeEligible(input: SacredEligibilityInput): {
  eligible: boolean
  failures: Array<string>
} {
  const failures: Array<string> = []
  if (input.item.contentDomain !== 'SACRED_RUNTIME') {
    failures.push('wrong_content_domain')
  }
  if (!input.item.active) failures.push('item_inactive')
  if (
    !(SACRED_RUNTIME_CONTENT_TYPES as ReadonlyArray<string>).includes(
      input.item.contentType,
    )
  ) {
    failures.push('invalid_sacred_content_type')
  }
  if (input.version.status !== 'PUBLISHED') failures.push('not_published')
  if (
    !(GUIDANCE_LANGUAGES as ReadonlyArray<string>).includes(
      input.version.language,
    )
  ) {
    failures.push('unsupported_language')
  }
  if (!input.profile) {
    failures.push('profile_missing')
    return { eligible: false, failures }
  }
  if (!input.profile.digitalStorageAuthorized) {
    failures.push('storage_not_authorized')
  }
  if (input.profile.rightsStatus !== 'CLEARED') {
    failures.push('rights_not_cleared')
  }
  if (input.profile.accessPolicy !== 'PRAYER_ROOM_PRIVATE') {
    failures.push('access_policy_not_prayer_room_private')
  }
  if (!input.profile.runtimeEnabled) failures.push('runtime_not_enabled')
  if (!input.profile.contentSha256) {
    failures.push('hash_missing')
  } else if (
    input.profile.contentSha256 !== computeBodySha256(input.version.body)
  ) {
    failures.push('hash_mismatch')
  }
  return { eligible: failures.length === 0, failures }
}

/** Integrity helper: does the stored hash match the stored body? */
export async function verifySacredVersionHash(
  versionId: number,
  db: DbClient = getDb(),
): Promise<boolean> {
  const row = (
    await db
      .select({
        body: spiritualContentVersions.body,
        contentSha256: sacredContentVersionProfiles.contentSha256,
      })
      .from(spiritualContentVersions)
      .innerJoin(
        sacredContentVersionProfiles,
        eq(
          sacredContentVersionProfiles.contentVersionId,
          spiritualContentVersions.id,
        ),
      )
      .where(eq(spiritualContentVersions.id, versionId))
      .limit(1)
  ).at(0)
  if (!row || !row.contentSha256) return false
  return row.contentSha256 === computeBodySha256(row.body)
}

/**
 * The ADMIN operational runtime switch (spec §34/§35/§38). Enabling
 * validates EVERY other eligibility gate inside the item lock and fails
 * closed — a technically "enabled" but invalid version cannot exist.
 * Racing publish vs enable is serialized on the same item row: if
 * enable wins before publication it fails; after a successful publish a
 * serialized enable may succeed. Disabling affects FUTURE selections
 * only — nothing historical is destroyed.
 */
export async function setSacredRuntimeEnabled(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  enabled: boolean,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.publish')
  await requireVersionDomain(versionId, 'SACRED_RUNTIME')
  const current = await loadVersion(versionId)
  await getDb().transaction(async (tx) => {
    const item = await lockContentItem(tx, current.contentItemId)
    const version = (
      await tx
        .select()
        .from(spiritualContentVersions)
        .where(eq(spiritualContentVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!version) throw new SpiritualContentError('Content version not found.')
    const profile = (
      await tx
        .select()
        .from(sacredContentVersionProfiles)
        .where(eq(sacredContentVersionProfiles.contentVersionId, versionId))
        .limit(1)
    ).at(0)
    if (enabled) {
      const check = isSacredVersionRuntimeEligible({
        item,
        version,
        profile: profile
          ? { ...profile, runtimeEnabled: true } // validate everything EXCEPT the flag itself
          : null,
      })
      if (!check.eligible) {
        throw new SpiritualContentError(
          `Runtime cannot be enabled: ${check.failures.join(', ')}.`,
        )
      }
    } else if (!profile) {
      throw new SpiritualContentError(
        'This sacred version has no runtime profile.',
      )
    }
    await tx
      .update(sacredContentVersionProfiles)
      .set({ runtimeEnabled: enabled })
      .where(eq(sacredContentVersionProfiles.contentVersionId, versionId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: enabled
      ? 'sacred_content.runtime_enabled'
      : 'sacred_content.runtime_disabled',
    entityType: 'sacred_content_version_profile',
    entityId: String(versionId),
    metadata: {
      contentItemId: current.contentItemId,
      language: current.language,
      versionNumber: current.versionNumber,
      runtimeEnabled: enabled,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Runtime candidate query (INTERNAL — never a public API) ----------------

export interface SacredRuntimeCandidateFilters {
  contentType?: (typeof SACRED_RUNTIME_CONTENT_TYPES)[number]
  language: GuidanceLanguage
  serviceId?: number
  sacredHouseId?: number
  themeCode?: string
}

/**
 * "What sacred content is valid for autonomous use right now?" —
 * answered without any human. Returns ONLY runtime-eligible versions in
 * the EXACT requested language (no yo→en fallback, spec §16), each with
 * its scope. Scope semantics (spec §42): PLATFORM rows are globally
 * eligible; SERVICE/SACRED_HOUSE rows only when the matching id filter
 * is supplied. NO composition, priority or highest-specificity logic —
 * Step 9 approved templates decide combination rules.
 *
 * Bodies are EXCLUDED from the default payload; the trusted internal
 * variant may include them (never exposed to browsers/public APIs).
 */
export async function listEligibleSacredRuntimeContent(
  filters: SacredRuntimeCandidateFilters,
  options: { includeBody?: boolean } = {},
) {
  if (!GUIDANCE_LANGUAGES.includes(filters.language)) {
    throw new SpiritualContentError('Unsupported language.')
  }
  const scopeConditions = [eq(spiritualContentItems.scopeType, 'PLATFORM')]
  if (filters.serviceId != null) {
    scopeConditions.push(
      and(
        eq(spiritualContentItems.scopeType, 'SERVICE'),
        eq(spiritualContentItems.serviceId, filters.serviceId),
      )!,
    )
  }
  if (filters.sacredHouseId != null) {
    scopeConditions.push(
      and(
        eq(spiritualContentItems.scopeType, 'SACRED_HOUSE'),
        eq(spiritualContentItems.sacredHouseId, filters.sacredHouseId),
      )!,
    )
  }
  const conditions = [
    eq(spiritualContentItems.contentDomain, 'SACRED_RUNTIME'),
    eq(spiritualContentItems.active, true),
    inArray(spiritualContentItems.contentType, [
      ...SACRED_RUNTIME_CONTENT_TYPES,
    ]),
    eq(spiritualContentVersions.status, 'PUBLISHED'),
    eq(spiritualContentVersions.language, filters.language),
    eq(sacredContentVersionProfiles.digitalStorageAuthorized, true),
    eq(sacredContentVersionProfiles.rightsStatus, 'CLEARED'),
    eq(sacredContentVersionProfiles.accessPolicy, 'PRAYER_ROOM_PRIVATE'),
    eq(sacredContentVersionProfiles.runtimeEnabled, true),
    or(...scopeConditions),
  ]
  if (filters.contentType) {
    conditions.push(eq(spiritualContentItems.contentType, filters.contentType))
  }
  if (filters.themeCode) {
    conditions.push(
      eq(sacredContentVersionProfiles.themeCode, filters.themeCode),
    )
  }
  const rows = await getDb()
    .select({
      contentItemId: spiritualContentItems.id,
      itemPublicId: spiritualContentItems.publicId,
      contentVersionId: spiritualContentVersions.id,
      code: spiritualContentItems.code,
      contentType: spiritualContentItems.contentType,
      scopeType: spiritualContentItems.scopeType,
      sacredHouseId: spiritualContentItems.sacredHouseId,
      serviceId: spiritualContentItems.serviceId,
      language: spiritualContentVersions.language,
      versionNumber: spiritualContentVersions.versionNumber,
      variantKind: sacredContentVersionProfiles.variantKind,
      themeCode: sacredContentVersionProfiles.themeCode,
      durationHintSeconds: sacredContentVersionProfiles.durationHintSeconds,
      repeatable: sacredContentVersionProfiles.repeatable,
      voicePolicy: sacredContentVersionProfiles.voicePolicy,
      externalAiPolicy: sacredContentVersionProfiles.externalAiPolicy,
      contentSha256: sacredContentVersionProfiles.contentSha256,
      body: spiritualContentVersions.body,
    })
    .from(spiritualContentItems)
    .innerJoin(
      spiritualContentVersions,
      eq(spiritualContentVersions.contentItemId, spiritualContentItems.id),
    )
    .innerJoin(
      sacredContentVersionProfiles,
      eq(
        sacredContentVersionProfiles.contentVersionId,
        spiritualContentVersions.id,
      ),
    )
    .where(and(...conditions))
    .orderBy(
      asc(spiritualContentItems.contentType),
      asc(spiritualContentItems.sortOrder),
      asc(spiritualContentItems.id),
    )
    .limit(500)
  // Integrity gate: the stored hash must match the exact stored body.
  // A mismatch excludes the row (fails closed) and is NEVER rewritten.
  return rows
    .filter(
      (row) =>
        row.contentSha256 != null &&
        row.contentSha256 === computeBodySha256(row.body),
    )
    .map((row) => {
      const { body, ...safe } = row
      return options.includeBody ? { ...safe, body } : safe
    })
}

// --- Staff library queries --------------------------------------------------

/** Sacred library list annotations: per-item rights/runtime summary
 * for current versions. Never includes bodies or notes. */
export async function listSacredProfileSummaries(itemIds: Array<number>) {
  if (itemIds.length === 0) return []
  return getDb()
    .select({
      contentVersionId: sacredContentVersionProfiles.contentVersionId,
      contentItemId: sacredContentVersionProfiles.contentItemId,
      variantKind: sacredContentVersionProfiles.variantKind,
      rightsStatus: sacredContentVersionProfiles.rightsStatus,
      runtimeEnabled: sacredContentVersionProfiles.runtimeEnabled,
      accessPolicy: sacredContentVersionProfiles.accessPolicy,
      themeCode: sacredContentVersionProfiles.themeCode,
      repeatable: sacredContentVersionProfiles.repeatable,
      voicePolicy: sacredContentVersionProfiles.voicePolicy,
      digitalStorageAuthorized:
        sacredContentVersionProfiles.digitalStorageAuthorized,
      contentSha256: sacredContentVersionProfiles.contentSha256,
    })
    .from(sacredContentVersionProfiles)
    .where(inArray(sacredContentVersionProfiles.contentItemId, itemIds))
}

/** Detail payload: versions + full profiles + computed eligibility per
 * version. Staff-only (the server functions gate on permissions); the
 * internal provenance/rights notes stay staff-side and are rendered
 * escaped only. */
export async function getSacredVersionProfiles(itemId: number) {
  return getDb()
    .select()
    .from(sacredContentVersionProfiles)
    .where(eq(sacredContentVersionProfiles.contentItemId, itemId))
}
