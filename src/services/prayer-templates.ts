import { createHash, randomUUID } from 'node:crypto'

import { and, asc, desc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  CONTENT_SCOPE_TYPES,
  GUIDANCE_LANGUAGES,
  SACRED_RUNTIME_CONTENT_TYPES,
  SLOT_KINDS,
  SLOT_SELECTOR_MODES,
  VARIANT_KINDS,
  prayerSessionTemplateSlots,
  prayerSessionTemplateVersions,
  prayerSessionTemplates,
  prayerTemplateForbiddenPairs,
  prayerTemplateSlotPins,
  prayerTemplateSlotScopes,
  sacredContentVersionProfiles,
  sacredHouses,
  services,
  spiritualContentItems,
  spiritualContentVersions,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { ForbiddenError, requirePermission } from '@/auth/guards'
import { userHasPermission } from '@/auth/rbac'
import {
  isSacredVersionRuntimeEligible,
  listAllEligibleSacredRuntimeContent,
} from './sacred-content'
import type { DbClient } from '@/db'
import type { ContentScopeType, ContentVersionStatus } from '@/db/schema'
import type { RequestContext } from '@/auth/service'

/**
 * Approved prayer session template workflow (Phase One, Step 9).
 *
 * Human leadership approves the RULES here — structure, allowed
 * content, ordering, forbidden combinations, duration/language
 * boundaries — through the same locked human workflow as Steps 7/8
 * (DRAFT → UNDER_REVIEW → APPROVED → PUBLISHED → ARCHIVED, permanent
 * structure freeze after first review contact, one working version and
 * one current PUBLISHED version per template/language, no destructive
 * delete). The autonomous resolver then executes published rules with
 * NO per-appointment human approval.
 *
 * Templates contain NO sacred text — only references and filters over
 * Step 8 runtime-eligible content. Nothing here calls any AI provider.
 */

export class PrayerTemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrayerTemplateError'
  }
}

// --- Validation schemas -----------------------------------------------------

export const templateSchema = z.object({
  code: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]{2,59}$/,
      'Code must be an UPPER_SNAKE_CASE ASCII identifier (3–60 chars).',
    ),
  scopeType: z.enum(CONTENT_SCOPE_TYPES),
  sacredHouseId: z.number().int().positive().nullable().optional(),
  serviceId: z.number().int().positive().nullable().optional(),
})
export type TemplateInput = z.infer<typeof templateSchema>

export const slotSchema = z.object({
  slotKey: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]{0,59}$/,
      'Slot key must be an UPPER_SNAKE_CASE ASCII identifier (max 60 chars).',
    ),
  position: z.number().int().min(1).max(200),
  slotKind: z.enum(SLOT_KINDS),
  minSelect: z.number().int().min(0).max(20).default(1),
  maxSelect: z.number().int().min(0).max(20).default(1),
  contentType: z.enum(SACRED_RUNTIME_CONTENT_TYPES).nullable().default(null),
  selectorMode: z.enum(SLOT_SELECTOR_MODES).nullable().default(null),
  themeCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,59}$/)
    .nullable()
    .default(null),
  variantKind: z.enum(VARIANT_KINDS).nullable().default(null),
  silenceDurationSeconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .nullable()
    .default(null),
  allowedScopes: z.array(z.enum(CONTENT_SCOPE_TYPES)).default([]),
  pinnedContentVersionIds: z
    .array(z.number().int().positive())
    .max(50)
    .default([]),
})
export type SlotInput = z.infer<typeof slotSchema>

export const forbiddenPairSchema = z.object({
  contentItemIdA: z.number().int().positive(),
  contentItemIdB: z.number().int().positive(),
})

export const templateVersionSchema = z.object({
  language: z.enum(GUIDANCE_LANGUAGES),
  priority: z.number().int().min(-1000).max(1000).default(0),
  selectionWeight: z.number().int().min(1).max(100).default(1),
  targetMinSeconds: z.number().int().min(1).max(7200),
  targetMaxSeconds: z.number().int().min(1).max(7200),
  slots: z.array(slotSchema).max(200).default([]),
  forbiddenPairs: z.array(forbiddenPairSchema).max(200).default([]),
})
export type TemplateVersionInput = z.infer<typeof templateVersionSchema>

const WORKING_STATUSES: Array<ContentVersionStatus> = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
]

/** Per-slot structural coherence — enforced at input AND re-verified
 * against authoritative rows at publication. */
function validateSlotShape(slot: SlotInput): void {
  if (slot.slotKind === 'SILENCE') {
    if (slot.silenceDurationSeconds == null) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: SILENCE requires an explicit duration.`,
      )
    }
    if (
      slot.selectorMode != null ||
      slot.contentType != null ||
      slot.themeCode != null ||
      slot.variantKind != null ||
      slot.allowedScopes.length > 0 ||
      slot.pinnedContentVersionIds.length > 0
    ) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: SILENCE carries no content selector.`,
      )
    }
    if (slot.minSelect !== 0 || slot.maxSelect !== 0) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: SILENCE selects no content (min/max must be 0).`,
      )
    }
    return
  }
  // CONTENT
  if (slot.silenceDurationSeconds != null) {
    throw new PrayerTemplateError(
      `Slot ${slot.slotKey}: CONTENT slots have no silence duration.`,
    )
  }
  if (slot.selectorMode == null) {
    throw new PrayerTemplateError(
      `Slot ${slot.slotKey}: CONTENT requires a selector mode.`,
    )
  }
  if (slot.maxSelect < 1 || slot.minSelect > slot.maxSelect) {
    throw new PrayerTemplateError(
      `Slot ${slot.slotKey}: invalid min/max selection counts.`,
    )
  }
  if (slot.selectorMode === 'PINNED_VERSIONS') {
    if (slot.pinnedContentVersionIds.length === 0) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: PINNED_VERSIONS requires pinned content.`,
      )
    }
    if (slot.contentType != null || slot.themeCode != null) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: pinned slots do not carry filter fields.`,
      )
    }
  } else {
    if (slot.contentType == null) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: ELIGIBLE_FILTER requires a sacred content type.`,
      )
    }
    if (slot.allowedScopes.length === 0) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: ELIGIBLE_FILTER requires explicit allowed scopes.`,
      )
    }
    if (slot.pinnedContentVersionIds.length > 0) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: filter slots cannot also pin versions.`,
      )
    }
  }
}

function validateVersionInput(
  input: TemplateVersionInput,
): TemplateVersionInput {
  if (input.targetMaxSeconds < input.targetMinSeconds) {
    throw new PrayerTemplateError(
      'Target maximum duration must be at least the minimum.',
    )
  }
  const keys = new Set<string>()
  const positions = new Set<number>()
  for (const slot of input.slots) {
    validateSlotShape(slot)
    if (keys.has(slot.slotKey)) {
      throw new PrayerTemplateError(`Duplicate slot key ${slot.slotKey}.`)
    }
    keys.add(slot.slotKey)
    if (positions.has(slot.position)) {
      throw new PrayerTemplateError(`Duplicate slot position ${slot.position}.`)
    }
    positions.add(slot.position)
    const uniquePins = new Set(slot.pinnedContentVersionIds)
    if (uniquePins.size !== slot.pinnedContentVersionIds.length) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: duplicate pinned versions.`,
      )
    }
  }
  const pairs = new Set<string>()
  for (const pair of input.forbiddenPairs) {
    if (pair.contentItemIdA === pair.contentItemIdB) {
      throw new PrayerTemplateError(
        'A forbidden pair must reference two different content items.',
      )
    }
    const a = Math.min(pair.contentItemIdA, pair.contentItemIdB)
    const b = Math.max(pair.contentItemIdA, pair.contentItemIdB)
    const key = `${a}:${b}`
    if (pairs.has(key)) {
      throw new PrayerTemplateError('Duplicate forbidden pair.')
    }
    pairs.add(key)
  }
  return input
}

// --- Template structure -----------------------------------------------------

async function resolveTemplateScope(
  input: TemplateInput,
  db: DbClient,
): Promise<{
  scopeType: ContentScopeType
  sacredHouseId: number | null
  serviceId: number | null
}> {
  switch (input.scopeType) {
    case 'PLATFORM': {
      if (input.sacredHouseId != null || input.serviceId != null) {
        throw new PrayerTemplateError(
          'Platform-scoped templates must not reference a Sacred House or Service.',
        )
      }
      return { scopeType: 'PLATFORM', sacredHouseId: null, serviceId: null }
    }
    case 'SACRED_HOUSE': {
      if (input.serviceId != null || input.sacredHouseId == null) {
        throw new PrayerTemplateError(
          'House-scoped templates require exactly a Sacred House.',
        )
      }
      const house = (
        await db
          .select({ id: sacredHouses.id })
          .from(sacredHouses)
          .where(eq(sacredHouses.id, input.sacredHouseId))
          .limit(1)
      ).at(0)
      if (!house) throw new PrayerTemplateError('Sacred House not found.')
      return {
        scopeType: 'SACRED_HOUSE',
        sacredHouseId: house.id,
        serviceId: null,
      }
    }
    case 'SERVICE': {
      if (input.sacredHouseId != null || input.serviceId == null) {
        throw new PrayerTemplateError(
          'Service-scoped templates require exactly a Service.',
        )
      }
      const service = (
        await db
          .select({ id: services.id })
          .from(services)
          .where(eq(services.id, input.serviceId))
          .limit(1)
      ).at(0)
      if (!service) throw new PrayerTemplateError('Service not found.')
      return {
        scopeType: 'SERVICE',
        sacredHouseId: null,
        serviceId: service.id,
      }
    }
  }
}

export async function createPrayerTemplate(
  actorId: number,
  ctx: RequestContext,
  rawInput: TemplateInput,
): Promise<{ id: number; publicId: string }> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const input = templateSchema.parse(rawInput)
  const db = getDb()
  const scope = await resolveTemplateScope(input, db)
  const publicId = randomUUID()
  let templateId: number
  try {
    const inserted = await db.insert(prayerSessionTemplates).values({
      publicId,
      code: input.code,
      scopeType: scope.scopeType,
      sacredHouseId: scope.sacredHouseId,
      serviceId: scope.serviceId,
      createdBy: actorId,
    })
    templateId = inserted[0].insertId
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new PrayerTemplateError('A template with this code already exists.')
    }
    throw error
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.created',
    entityType: 'prayer_session_template',
    entityId: String(templateId),
    metadata: {
      publicId,
      code: input.code,
      scopeType: scope.scopeType,
      sacredHouseId: scope.sacredHouseId,
      serviceId: scope.serviceId,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return { id: templateId, publicId }
}

function isDuplicateKeyError(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const message = current instanceof Error ? current.message : String(current)
    if (
      message.includes('ER_DUP_ENTRY') ||
      message.includes('Duplicate entry')
    ) {
      return true
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}

async function lockTemplate(tx: DbClient, templateId: number) {
  const row = (
    await tx
      .select()
      .from(prayerSessionTemplates)
      .where(eq(prayerSessionTemplates.id, templateId))
      .limit(1)
      .for('update')
  ).at(0)
  if (!row) throw new PrayerTemplateError('Template not found.')
  return row
}

/** Permanent structure freeze: any version that has EVER reached
 * review (durable submitted_at) or left DRAFT freezes code/scope
 * forever, exactly like Steps 7/8. */
async function isTemplateStructureFrozen(
  templateId: number,
  db: DbClient,
): Promise<boolean> {
  const evidence = await db
    .select({ id: prayerSessionTemplateVersions.id })
    .from(prayerSessionTemplateVersions)
    .where(
      and(
        eq(prayerSessionTemplateVersions.templateId, templateId),
        or(
          isNotNull(prayerSessionTemplateVersions.submittedAt),
          ne(prayerSessionTemplateVersions.status, 'DRAFT'),
        ),
      ),
    )
    .limit(1)
  return evidence.length > 0
}

export async function updatePrayerTemplate(
  actorId: number,
  ctx: RequestContext,
  templateId: number,
  rawInput: TemplateInput,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const input = templateSchema.parse(rawInput)
  await getDb().transaction(async (tx) => {
    const row = await lockTemplate(tx, templateId)
    const frozen = await isTemplateStructureFrozen(templateId, tx)
    const structuralChange =
      input.code !== row.code ||
      input.scopeType !== row.scopeType ||
      (input.sacredHouseId ?? null) !== row.sacredHouseId ||
      (input.serviceId ?? null) !== row.serviceId
    if (frozen && structuralChange) {
      throw new PrayerTemplateError(
        'This template has reviewed versions — its code and scope are frozen. Archive it and create a new template instead.',
      )
    }
    if (frozen) return
    const scope = await resolveTemplateScope(input, tx)
    await tx
      .update(prayerSessionTemplates)
      .set({
        code: input.code,
        scopeType: scope.scopeType,
        sacredHouseId: scope.sacredHouseId,
        serviceId: scope.serviceId,
      })
      .where(eq(prayerSessionTemplates.id, templateId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.updated',
    entityType: 'prayer_session_template',
    entityId: String(templateId),
    metadata: { code: input.code },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/** Active toggle with the Steps 7/8 durable-evidence authority rule:
 * after first publication only ADMIN/SUPER_ADMIN may toggle. */
export async function setPrayerTemplateActive(
  actorId: number,
  ctx: RequestContext,
  templateId: number,
  active: boolean,
): Promise<void> {
  const canManage = await userHasPermission(actorId, 'spiritual_content.manage')
  const canPublish = await userHasPermission(
    actorId,
    'spiritual_content.publish',
  )
  await getDb().transaction(async (tx) => {
    await lockTemplate(tx, templateId)
    const hasPublicationEvidence =
      (
        await tx
          .select({ id: prayerSessionTemplateVersions.id })
          .from(prayerSessionTemplateVersions)
          .where(
            and(
              eq(prayerSessionTemplateVersions.templateId, templateId),
              isNotNull(prayerSessionTemplateVersions.publishedAt),
            ),
          )
          .limit(1)
      ).length > 0
    const allowed = hasPublicationEvidence ? canPublish : canManage
    if (!allowed) throw new ForbiddenError()
    await tx
      .update(prayerSessionTemplates)
      .set({ active })
      .where(eq(prayerSessionTemplates.id, templateId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: active ? 'prayer_template.updated' : 'prayer_template.deactivated',
    entityType: 'prayer_session_template',
    entityId: String(templateId),
    metadata: { active },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Versions ---------------------------------------------------------------

async function insertSlotRows(
  tx: DbClient,
  templateVersionId: number,
  slots: Array<SlotInput>,
): Promise<void> {
  for (const slot of slots) {
    const inserted = await tx.insert(prayerSessionTemplateSlots).values({
      templateVersionId,
      slotKey: slot.slotKey,
      position: slot.position,
      slotKind: slot.slotKind,
      minSelect: slot.minSelect,
      maxSelect: slot.maxSelect,
      contentType: slot.contentType,
      selectorMode: slot.selectorMode,
      themeCode: slot.themeCode,
      variantKind: slot.variantKind,
      silenceDurationSeconds: slot.silenceDurationSeconds,
    })
    const slotId = inserted[0].insertId
    for (const scopeType of [...new Set(slot.allowedScopes)]) {
      await tx.insert(prayerTemplateSlotScopes).values({ slotId, scopeType })
    }
    for (const [
      index,
      contentVersionId,
    ] of slot.pinnedContentVersionIds.entries()) {
      // Pins must already reference SACRED_RUNTIME versions at draft
      // time — full eligibility is re-verified at publication and again
      // at every autonomous selection.
      const pinRow = (
        await tx
          .select({ contentDomain: spiritualContentItems.contentDomain })
          .from(spiritualContentVersions)
          .innerJoin(
            spiritualContentItems,
            eq(
              spiritualContentVersions.contentItemId,
              spiritualContentItems.id,
            ),
          )
          .where(eq(spiritualContentVersions.id, contentVersionId))
          .limit(1)
      ).at(0)
      if (!pinRow || pinRow.contentDomain !== 'SACRED_RUNTIME') {
        throw new PrayerTemplateError(
          `Pinned content version ${contentVersionId} is not sacred runtime content.`,
        )
      }
      await tx.insert(prayerTemplateSlotPins).values({
        slotId,
        contentVersionId,
        pinOrder: index,
      })
    }
  }
}

async function insertForbiddenPairRows(
  tx: DbClient,
  templateVersionId: number,
  pairs: TemplateVersionInput['forbiddenPairs'],
): Promise<void> {
  for (const pair of pairs) {
    const a = Math.min(pair.contentItemIdA, pair.contentItemIdB)
    const b = Math.max(pair.contentItemIdA, pair.contentItemIdB)
    const items = await tx
      .select({
        id: spiritualContentItems.id,
        contentDomain: spiritualContentItems.contentDomain,
      })
      .from(spiritualContentItems)
      .where(inArray(spiritualContentItems.id, [a, b]))
    if (
      items.length !== 2 ||
      items.some((item) => item.contentDomain !== 'SACRED_RUNTIME')
    ) {
      throw new PrayerTemplateError(
        'Forbidden pairs must reference existing sacred runtime content items.',
      )
    }
    await tx.insert(prayerTemplateForbiddenPairs).values({
      templateVersionId,
      contentItemIdA: a,
      contentItemIdB: b,
    })
  }
}

export async function createTemplateVersion(
  actorId: number,
  ctx: RequestContext,
  templateId: number,
  rawInput: TemplateVersionInput,
): Promise<{ id: number; versionNumber: number }> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const input = validateVersionInput(templateVersionSchema.parse(rawInput))
  const result = await getDb().transaction(async (tx) => {
    // Template row lock serializes version numbering and the
    // one-working-version rule (lock order: TEMPLATE → VERSION/SLOTS).
    await lockTemplate(tx, templateId)
    const working = await tx
      .select({ id: prayerSessionTemplateVersions.id })
      .from(prayerSessionTemplateVersions)
      .where(
        and(
          eq(prayerSessionTemplateVersions.templateId, templateId),
          eq(prayerSessionTemplateVersions.language, input.language),
          inArray(prayerSessionTemplateVersions.status, WORKING_STATUSES),
        ),
      )
      .limit(1)
    if (working.length > 0) {
      throw new PrayerTemplateError(
        'A working version (draft, under review or approved) already exists for this template and language.',
      )
    }
    const latest = (
      await tx
        .select({
          versionNumber: prayerSessionTemplateVersions.versionNumber,
        })
        .from(prayerSessionTemplateVersions)
        .where(
          and(
            eq(prayerSessionTemplateVersions.templateId, templateId),
            eq(prayerSessionTemplateVersions.language, input.language),
          ),
        )
        .orderBy(desc(prayerSessionTemplateVersions.versionNumber))
        .limit(1)
    ).at(0)
    const versionNumber = (latest?.versionNumber ?? 0) + 1
    const inserted = await tx.insert(prayerSessionTemplateVersions).values({
      templateId,
      language: input.language,
      versionNumber,
      priority: input.priority,
      selectionWeight: input.selectionWeight,
      targetMinSeconds: input.targetMinSeconds,
      targetMaxSeconds: input.targetMaxSeconds,
      status: 'DRAFT',
      createdBy: actorId,
    })
    const versionId = inserted[0].insertId
    await insertSlotRows(tx, versionId, input.slots)
    await insertForbiddenPairRows(tx, versionId, input.forbiddenPairs)
    return { id: versionId, versionNumber }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.version_created',
    entityType: 'prayer_template_version',
    entityId: String(result.id),
    metadata: {
      templateId,
      language: input.language,
      versionNumber: result.versionNumber,
      slotCount: input.slots.length,
      forbiddenPairCount: input.forbiddenPairs.length,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return result
}

export async function loadTemplateVersion(
  versionId: number,
  db: DbClient = getDb(),
) {
  const row = (
    await db
      .select()
      .from(prayerSessionTemplateVersions)
      .where(eq(prayerSessionTemplateVersions.id, versionId))
      .limit(1)
  ).at(0)
  if (!row) throw new PrayerTemplateError('Template version not found.')
  return row
}

/** DRAFT-only editing: replaces the draft's rule rows atomically under
 * the template lock. Published/reviewed definitions are immutable —
 * corrections require a NEW version. */
export async function updateDraftTemplateVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  rawInput: Omit<TemplateVersionInput, 'language'>,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const current = await loadTemplateVersion(versionId)
  const input = validateVersionInput(
    templateVersionSchema.parse({
      ...rawInput,
      language: current.language,
    }),
  )
  await getDb().transaction(async (tx) => {
    await lockTemplate(tx, current.templateId)
    const target = (
      await tx
        .select({ status: prayerSessionTemplateVersions.status })
        .from(prayerSessionTemplateVersions)
        .where(eq(prayerSessionTemplateVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target || target.status !== 'DRAFT') {
      throw new PrayerTemplateError('Only draft versions can be edited.')
    }
    await tx
      .update(prayerSessionTemplateVersions)
      .set({
        priority: input.priority,
        selectionWeight: input.selectionWeight,
        targetMinSeconds: input.targetMinSeconds,
        targetMaxSeconds: input.targetMaxSeconds,
      })
      .where(eq(prayerSessionTemplateVersions.id, versionId))
    // Replace the DRAFT's rule rows (draft authoring only — reviewed
    // definitions are never rewritten).
    const slotRows = await tx
      .select({ id: prayerSessionTemplateSlots.id })
      .from(prayerSessionTemplateSlots)
      .where(eq(prayerSessionTemplateSlots.templateVersionId, versionId))
    const slotIds = slotRows.map((row) => row.id)
    if (slotIds.length > 0) {
      await tx
        .delete(prayerTemplateSlotPins)
        .where(inArray(prayerTemplateSlotPins.slotId, slotIds))
      await tx
        .delete(prayerTemplateSlotScopes)
        .where(inArray(prayerTemplateSlotScopes.slotId, slotIds))
      await tx
        .delete(prayerSessionTemplateSlots)
        .where(eq(prayerSessionTemplateSlots.templateVersionId, versionId))
    }
    await tx
      .delete(prayerTemplateForbiddenPairs)
      .where(eq(prayerTemplateForbiddenPairs.templateVersionId, versionId))
    await insertSlotRows(tx, versionId, input.slots)
    await insertForbiddenPairRows(tx, versionId, input.forbiddenPairs)
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.version_updated',
    entityType: 'prayer_template_version',
    entityId: String(versionId),
    metadata: {
      templateId: current.templateId,
      language: current.language,
      versionNumber: current.versionNumber,
      slotCount: input.slots.length,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function submitTemplateVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const current = await loadTemplateVersion(versionId)
  await getDb().transaction(async (tx) => {
    await lockTemplate(tx, current.templateId)
    const slotCount = (
      await tx
        .select({ id: prayerSessionTemplateSlots.id })
        .from(prayerSessionTemplateSlots)
        .where(eq(prayerSessionTemplateSlots.templateVersionId, versionId))
        .limit(1)
    ).length
    if (slotCount === 0) {
      throw new PrayerTemplateError(
        'A template needs at least one slot before review.',
      )
    }
    const result = await tx
      .update(prayerSessionTemplateVersions)
      .set({
        status: 'UNDER_REVIEW',
        submittedAt: new Date(),
        reviewNote: null,
      })
      .where(
        and(
          eq(prayerSessionTemplateVersions.id, versionId),
          eq(prayerSessionTemplateVersions.status, 'DRAFT'),
        ),
      )
    if (result[0].affectedRows !== 1) {
      throw new PrayerTemplateError(
        'Only draft versions can be submitted for review.',
      )
    }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.version_submitted',
    entityType: 'prayer_template_version',
    entityId: String(versionId),
    metadata: {
      templateId: current.templateId,
      language: current.language,
      versionNumber: current.versionNumber,
      from: 'DRAFT',
      to: 'UNDER_REVIEW',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function returnTemplateVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  reason: string,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.approve')
  const trimmed = reason.trim()
  if (!trimmed) {
    throw new PrayerTemplateError('Returning to draft requires a reason.')
  }
  const current = await loadTemplateVersion(versionId)
  const result = await getDb()
    .update(prayerSessionTemplateVersions)
    .set({
      status: 'DRAFT',
      reviewNote: trimmed.slice(0, 500),
      approvedBy: null,
      approvedAt: null,
    })
    .where(
      and(
        eq(prayerSessionTemplateVersions.id, versionId),
        eq(prayerSessionTemplateVersions.status, 'UNDER_REVIEW'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new PrayerTemplateError(
      'Only versions under review can be returned to draft.',
    )
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.version_returned',
    entityType: 'prayer_template_version',
    entityId: String(versionId),
    metadata: {
      templateId: current.templateId,
      language: current.language,
      versionNumber: current.versionNumber,
      from: 'UNDER_REVIEW',
      to: 'DRAFT',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function approveTemplateVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.approve')
  const current = await loadTemplateVersion(versionId)
  const result = await getDb()
    .update(prayerSessionTemplateVersions)
    .set({ status: 'APPROVED', approvedBy: actorId, approvedAt: new Date() })
    .where(
      and(
        eq(prayerSessionTemplateVersions.id, versionId),
        eq(prayerSessionTemplateVersions.status, 'UNDER_REVIEW'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new PrayerTemplateError('Only versions under review can be approved.')
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.version_approved',
    entityType: 'prayer_template_version',
    entityId: String(versionId),
    metadata: {
      templateId: current.templateId,
      language: current.language,
      versionNumber: current.versionNumber,
      from: 'UNDER_REVIEW',
      to: 'APPROVED',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function archiveTemplateVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.publish')
  const preRead = await loadTemplateVersion(versionId)
  const fromStatus = await getDb().transaction(async (tx) => {
    await lockTemplate(tx, preRead.templateId)
    const target = (
      await tx
        .select({ status: prayerSessionTemplateVersions.status })
        .from(prayerSessionTemplateVersions)
        .where(eq(prayerSessionTemplateVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target) throw new PrayerTemplateError('Template version not found.')
    if (target.status === 'ARCHIVED') {
      throw new PrayerTemplateError('This version is already archived.')
    }
    const result = await tx
      .update(prayerSessionTemplateVersions)
      .set({ status: 'ARCHIVED', archivedAt: new Date() })
      .where(
        and(
          eq(prayerSessionTemplateVersions.id, versionId),
          eq(prayerSessionTemplateVersions.status, target.status),
        ),
      )
    if (result[0].affectedRows !== 1) {
      throw new PrayerTemplateError('Archive conflict — try again.')
    }
    return target.status
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.version_archived',
    entityType: 'prayer_template_version',
    entityId: String(versionId),
    metadata: {
      templateId: preRead.templateId,
      language: preRead.language,
      versionNumber: preRead.versionNumber,
      from: fromStatus,
      to: 'ARCHIVED',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Definition loading & canonical hash ------------------------------------

export interface TemplateDefinition {
  version: Awaited<ReturnType<typeof loadTemplateVersion>>
  slots: Array<{
    id: number
    slotKey: string
    position: number
    slotKind: (typeof SLOT_KINDS)[number]
    minSelect: number
    maxSelect: number
    contentType: string | null
    selectorMode: (typeof SLOT_SELECTOR_MODES)[number] | null
    themeCode: string | null
    variantKind: string | null
    silenceDurationSeconds: number | null
    allowedScopes: Array<ContentScopeType>
    pins: Array<{ contentVersionId: number; pinOrder: number }>
  }>
  forbiddenPairs: Array<{ contentItemIdA: number; contentItemIdB: number }>
}

export async function loadTemplateDefinition(
  versionId: number,
  db: DbClient = getDb(),
): Promise<TemplateDefinition> {
  const version = await loadTemplateVersion(versionId, db)
  const slotRows = await db
    .select()
    .from(prayerSessionTemplateSlots)
    .where(eq(prayerSessionTemplateSlots.templateVersionId, versionId))
    .orderBy(asc(prayerSessionTemplateSlots.position))
  const slotIds = slotRows.map((row) => row.id)
  const scopeRows =
    slotIds.length > 0
      ? await db
          .select()
          .from(prayerTemplateSlotScopes)
          .where(inArray(prayerTemplateSlotScopes.slotId, slotIds))
      : []
  const pinRows =
    slotIds.length > 0
      ? await db
          .select()
          .from(prayerTemplateSlotPins)
          .where(inArray(prayerTemplateSlotPins.slotId, slotIds))
          .orderBy(
            asc(prayerTemplateSlotPins.pinOrder),
            asc(prayerTemplateSlotPins.contentVersionId),
          )
      : []
  const pairRows = await db
    .select()
    .from(prayerTemplateForbiddenPairs)
    .where(eq(prayerTemplateForbiddenPairs.templateVersionId, versionId))
    .orderBy(
      asc(prayerTemplateForbiddenPairs.contentItemIdA),
      asc(prayerTemplateForbiddenPairs.contentItemIdB),
    )
  return {
    version,
    slots: slotRows.map((slot) => ({
      id: slot.id,
      slotKey: slot.slotKey,
      position: slot.position,
      slotKind: slot.slotKind,
      minSelect: slot.minSelect,
      maxSelect: slot.maxSelect,
      contentType: slot.contentType,
      selectorMode: slot.selectorMode,
      themeCode: slot.themeCode,
      variantKind: slot.variantKind,
      silenceDurationSeconds: slot.silenceDurationSeconds,
      allowedScopes: scopeRows
        .filter((row) => row.slotId === slot.id)
        .map((row) => row.scopeType)
        .sort(),
      pins: pinRows
        .filter((row) => row.slotId === slot.id)
        .map((row) => ({
          contentVersionId: row.contentVersionId,
          pinOrder: row.pinOrder,
        })),
    })),
    forbiddenPairs: pairRows.map((row) => ({
      contentItemIdA: row.contentItemIdA,
      contentItemIdB: row.contentItemIdB,
    })),
  }
}

/**
 * Deterministic canonical representation of the AUTHORITATIVE stored
 * definition (never browser JSON). Stable key order, slots by
 * position, scopes sorted, pins by pin order. The SHA-256 of this
 * string is the template's integrity identity for later recipes.
 */
export function canonicalTemplateDefinition(
  definition: TemplateDefinition,
): string {
  const v = definition.version
  const canonical = {
    templateId: v.templateId,
    language: v.language,
    versionNumber: v.versionNumber,
    priority: v.priority,
    selectionWeight: v.selectionWeight,
    targetMinSeconds: v.targetMinSeconds,
    targetMaxSeconds: v.targetMaxSeconds,
    slots: definition.slots.map((slot) => ({
      slotKey: slot.slotKey,
      position: slot.position,
      slotKind: slot.slotKind,
      minSelect: slot.minSelect,
      maxSelect: slot.maxSelect,
      contentType: slot.contentType,
      selectorMode: slot.selectorMode,
      themeCode: slot.themeCode,
      variantKind: slot.variantKind,
      silenceDurationSeconds: slot.silenceDurationSeconds,
      allowedScopes: slot.allowedScopes,
      pins: slot.pins.map((pin) => pin.contentVersionId),
    })),
    forbiddenPairs: definition.forbiddenPairs,
  }
  return JSON.stringify(canonical)
}

export function computeDefinitionSha256(
  definition: TemplateDefinition,
): string {
  return createHash('sha256')
    .update(canonicalTemplateDefinition(definition), 'utf8')
    .digest('hex')
}

// --- Publication ------------------------------------------------------------

/** Publication-time eligibility context: scoped candidate counting
 * uses the template's own scope references. */
async function templateCandidateContext(template: {
  scopeType: ContentScopeType
  sacredHouseId: number | null
  serviceId: number | null
}): Promise<{ serviceId?: number; sacredHouseId?: number }> {
  if (template.scopeType === 'SERVICE' && template.serviceId != null) {
    const service = (
      await getDb()
        .select({ sacredHouseId: services.sacredHouseId })
        .from(services)
        .where(eq(services.id, template.serviceId))
        .limit(1)
    ).at(0)
    return {
      serviceId: template.serviceId,
      sacredHouseId: service?.sacredHouseId,
    }
  }
  if (template.scopeType === 'SACRED_HOUSE' && template.sacredHouseId != null) {
    return { sacredHouseId: template.sacredHouseId }
  }
  return {}
}

/**
 * Full publication validation (spec §4). Runs INSIDE the publication
 * transaction against authoritative rows; the definition hash is
 * computed from the same rows. Filter-slot candidate sufficiency is a
 * point-in-time check — the resolver re-verifies eligibility at every
 * autonomous selection.
 */
export async function validateTemplateForPublication(
  definition: TemplateDefinition,
  template: {
    scopeType: ContentScopeType
    sacredHouseId: number | null
    serviceId: number | null
  },
): Promise<void> {
  const { version, slots, forbiddenPairs } = definition
  if (slots.length === 0) {
    throw new PrayerTemplateError('A template needs at least one slot.')
  }
  const positions = slots.map((slot) => slot.position).sort((a, b) => a - b)
  for (let i = 0; i < positions.length; i += 1) {
    if (positions[i] !== i + 1) {
      throw new PrayerTemplateError(
        'Slot positions must be unique and contiguous starting at 1.',
      )
    }
  }
  if (
    version.targetMinSeconds < 1 ||
    version.targetMaxSeconds < version.targetMinSeconds
  ) {
    throw new PrayerTemplateError('Invalid target duration bounds.')
  }
  if (version.selectionWeight < 1 || version.selectionWeight > 100) {
    throw new PrayerTemplateError('Selection weight must be 1–100.')
  }
  const context = await templateCandidateContext(template)
  const eligible = await listAllEligibleSacredRuntimeContent({
    language: version.language,
    ...context,
  })
  const eligibleByVersionId = new Map(
    eligible.map((row) => [row.contentVersionId, row]),
  )
  for (const slot of slots) {
    if (slot.slotKind === 'SILENCE') {
      if (
        slot.silenceDurationSeconds == null ||
        slot.silenceDurationSeconds < 1 ||
        slot.selectorMode != null ||
        slot.minSelect !== 0 ||
        slot.maxSelect !== 0 ||
        slot.pins.length > 0 ||
        slot.allowedScopes.length > 0
      ) {
        throw new PrayerTemplateError(
          `Slot ${slot.slotKey}: incoherent SILENCE definition.`,
        )
      }
      continue
    }
    if (slot.selectorMode == null || slot.maxSelect < 1) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: incoherent CONTENT selector.`,
      )
    }
    if (slot.minSelect > slot.maxSelect) {
      throw new PrayerTemplateError(
        `Slot ${slot.slotKey}: min_select exceeds max_select.`,
      )
    }
    if (slot.selectorMode === 'PINNED_VERSIONS') {
      if (slot.pins.length === 0) {
        throw new PrayerTemplateError(
          `Slot ${slot.slotKey}: no pinned versions.`,
        )
      }
      let currentlyEligible = 0
      for (const pin of slot.pins) {
        const row = (
          await getDb()
            .select({
              item: spiritualContentItems,
              version: spiritualContentVersions,
              profile: sacredContentVersionProfiles,
            })
            .from(spiritualContentVersions)
            .innerJoin(
              spiritualContentItems,
              eq(
                spiritualContentVersions.contentItemId,
                spiritualContentItems.id,
              ),
            )
            .leftJoin(
              sacredContentVersionProfiles,
              eq(
                sacredContentVersionProfiles.contentVersionId,
                spiritualContentVersions.id,
              ),
            )
            .where(eq(spiritualContentVersions.id, pin.contentVersionId))
            .limit(1)
        ).at(0)
        if (!row || row.item.contentDomain !== 'SACRED_RUNTIME') {
          throw new PrayerTemplateError(
            `Slot ${slot.slotKey}: pinned version ${pin.contentVersionId} is not sacred runtime content.`,
          )
        }
        if (row.version.language !== version.language) {
          throw new PrayerTemplateError(
            `Slot ${slot.slotKey}: pinned version ${pin.contentVersionId} does not match the template language.`,
          )
        }
        const check = isSacredVersionRuntimeEligible({
          item: row.item,
          version: row.version,
          profile: row.profile,
        })
        if (!check.eligible) {
          throw new PrayerTemplateError(
            `Slot ${slot.slotKey}: pinned version ${pin.contentVersionId} is not currently runtime eligible (${check.failures.join(', ')}).`,
          )
        }
        currentlyEligible += 1
      }
      if (currentlyEligible < slot.minSelect) {
        throw new PrayerTemplateError(
          `Slot ${slot.slotKey}: not enough eligible pinned versions for min_select.`,
        )
      }
    } else {
      const matching = eligible.filter(
        (candidate) =>
          candidate.contentType === slot.contentType &&
          (slot.themeCode == null || candidate.themeCode === slot.themeCode) &&
          (slot.variantKind == null ||
            candidate.variantKind === slot.variantKind) &&
          slot.allowedScopes.includes(candidate.scopeType),
      )
      if (matching.length < slot.minSelect) {
        throw new PrayerTemplateError(
          `Slot ${slot.slotKey}: only ${matching.length} currently eligible candidates for min_select ${slot.minSelect}.`,
        )
      }
    }
  }
  // Forbidden pairs already validated as sacred items at insert; keep
  // the publication re-check cheap and authoritative.
  for (const pair of forbiddenPairs) {
    if (pair.contentItemIdA >= pair.contentItemIdB) {
      throw new PrayerTemplateError('Forbidden pairs must be normalized.')
    }
  }
  void eligibleByVersionId
}

/**
 * Publication: serialized on the template row; replaces the current
 * PUBLISHED version for the same template/language; stamps the
 * canonical definition SHA-256 in the SAME transaction.
 */
export async function publishTemplateVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<{ archivedVersionId: number | null; definitionSha256: string }> {
  await requirePermission(actorId, 'spiritual_content.publish')
  const preRead = await loadTemplateVersion(versionId)
  const outcome = await getDb().transaction(async (tx) => {
    const template = await lockTemplate(tx, preRead.templateId)
    const target = (
      await tx
        .select()
        .from(prayerSessionTemplateVersions)
        .where(eq(prayerSessionTemplateVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target || target.status !== 'APPROVED') {
      throw new PrayerTemplateError('Only approved versions can be published.')
    }
    const definition = await loadTemplateDefinition(versionId, tx)
    await validateTemplateForPublication(definition, template)
    const definitionSha256 = computeDefinitionSha256(definition)
    const currentPublished = (
      await tx
        .select({ id: prayerSessionTemplateVersions.id })
        .from(prayerSessionTemplateVersions)
        .where(
          and(
            eq(prayerSessionTemplateVersions.templateId, target.templateId),
            eq(prayerSessionTemplateVersions.language, target.language),
            eq(prayerSessionTemplateVersions.status, 'PUBLISHED'),
          ),
        )
        .limit(1)
    ).at(0)
    if (currentPublished) {
      const archived = await tx
        .update(prayerSessionTemplateVersions)
        .set({ status: 'ARCHIVED', archivedAt: new Date() })
        .where(
          and(
            eq(prayerSessionTemplateVersions.id, currentPublished.id),
            eq(prayerSessionTemplateVersions.status, 'PUBLISHED'),
          ),
        )
      if (archived[0].affectedRows !== 1) {
        throw new PrayerTemplateError('Publication conflict — try again.')
      }
    }
    const published = await tx
      .update(prayerSessionTemplateVersions)
      .set({
        status: 'PUBLISHED',
        publishedBy: actorId,
        publishedAt: new Date(),
        definitionSha256,
      })
      .where(
        and(
          eq(prayerSessionTemplateVersions.id, versionId),
          eq(prayerSessionTemplateVersions.status, 'APPROVED'),
        ),
      )
    if (published[0].affectedRows !== 1) {
      throw new PrayerTemplateError('Publication conflict — try again.')
    }
    return {
      archivedVersionId: currentPublished?.id ?? null,
      definitionSha256,
    }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'prayer_template.version_published',
    entityType: 'prayer_template_version',
    entityId: String(versionId),
    metadata: {
      templateId: preRead.templateId,
      language: preRead.language,
      versionNumber: preRead.versionNumber,
      definitionSha256: outcome.definitionSha256,
      replacedVersionId: outcome.archivedVersionId,
      from: 'APPROVED',
      to: 'PUBLISHED',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return outcome
}

// --- Staff library queries --------------------------------------------------

export async function listPrayerTemplates() {
  const templates = await getDb()
    .select()
    .from(prayerSessionTemplates)
    .orderBy(
      asc(prayerSessionTemplates.scopeType),
      asc(prayerSessionTemplates.code),
    )
    .limit(500)
  if (templates.length === 0) {
    return []
  }
  const versions = await getDb()
    .select({
      id: prayerSessionTemplateVersions.id,
      templateId: prayerSessionTemplateVersions.templateId,
      language: prayerSessionTemplateVersions.language,
      versionNumber: prayerSessionTemplateVersions.versionNumber,
      status: prayerSessionTemplateVersions.status,
    })
    .from(prayerSessionTemplateVersions)
    .where(
      inArray(
        prayerSessionTemplateVersions.templateId,
        templates.map((template) => template.id),
      ),
    )
    .orderBy(desc(prayerSessionTemplateVersions.versionNumber))
  return templates.map((template) => {
    const forTemplate = versions.filter(
      (version) => version.templateId === template.id,
    )
    const summarize = (language: string) => {
      const rows = forTemplate.filter((v) => v.language === language)
      const published = rows.find((v) => v.status === 'PUBLISHED')
      const working = rows.find((v) => WORKING_STATUSES.includes(v.status))
      return {
        publishedVersion: published?.versionNumber ?? null,
        workingStatus: working?.status ?? null,
        workingVersion: working?.versionNumber ?? null,
      }
    }
    return { ...template, en: summarize('en'), yo: summarize('yo') }
  })
}

export async function getPrayerTemplateDetail(templateId: number) {
  const template = (
    await getDb()
      .select()
      .from(prayerSessionTemplates)
      .where(eq(prayerSessionTemplates.id, templateId))
      .limit(1)
  ).at(0)
  if (!template) throw new PrayerTemplateError('Template not found.')
  const versions = await getDb()
    .select()
    .from(prayerSessionTemplateVersions)
    .where(eq(prayerSessionTemplateVersions.templateId, templateId))
    .orderBy(
      asc(prayerSessionTemplateVersions.language),
      desc(prayerSessionTemplateVersions.versionNumber),
    )
  const definitions = []
  for (const version of versions) {
    definitions.push(await loadTemplateDefinition(version.id))
  }
  const frozen = await isTemplateStructureFrozen(templateId, getDb())
  return { template, versions, definitions, structureFrozen: frozen }
}

export async function listTemplateReviewQueue() {
  return getDb()
    .select({
      version: prayerSessionTemplateVersions,
      template: {
        id: prayerSessionTemplates.id,
        code: prayerSessionTemplates.code,
        scopeType: prayerSessionTemplates.scopeType,
        sacredHouseId: prayerSessionTemplates.sacredHouseId,
        serviceId: prayerSessionTemplates.serviceId,
      },
    })
    .from(prayerSessionTemplateVersions)
    .innerJoin(
      prayerSessionTemplates,
      eq(prayerSessionTemplateVersions.templateId, prayerSessionTemplates.id),
    )
    .where(eq(prayerSessionTemplateVersions.status, 'UNDER_REVIEW'))
    .orderBy(asc(prayerSessionTemplateVersions.submittedAt))
    .limit(200)
}
