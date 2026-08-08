import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  CONTENT_SCOPE_TYPES,
  GUIDANCE_LANGUAGES,
  SPIRITUAL_CONTENT_TYPES,
  VISIBILITY_STAGES,
  sacredHouses,
  services,
  spiritualContentItems,
  spiritualContentVersions,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import type { DbClient } from '@/db'
import type {
  ContentScopeType,
  ContentVersionStatus,
  GuidanceLanguage,
  SpiritualContentType,
} from '@/db/schema'
import type { RequestContext } from '@/auth/service'

/**
 * Spiritual guidance content workflow (Step 7).
 *
 * HARD RULE: every word of spiritual content here is HUMAN-AUTHORED.
 * This module never generates, rewrites, translates, summarizes or
 * infers spiritual text, and no AI provider is reachable from it.
 *
 * Workflow (same locked machine as the catalogue):
 *   DRAFT → UNDER_REVIEW → APPROVED → PUBLISHED → ARCHIVED
 * - CONTENT_MANAGER (spiritual_content.manage) authors and submits.
 * - ADMIN/SUPER_ADMIN (approve/publish) return with a reason, approve,
 *   publish, archive, deactivate. manage NEVER implies approval.
 * - Only DRAFT content is editable; published sacred text is immutable
 *   — corrections are NEW versions. Nothing is destructively deleted.
 *
 * Concurrency: version numbering, one-working-version enforcement and
 * publication replacement all serialize on the content ITEM row
 * (SELECT … FOR UPDATE); every status mutation is a guarded CAS.
 */

export class SpiritualContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpiritualContentError'
  }
}

// --- Validation schemas -----------------------------------------------------

export const contentItemSchema = z.object({
  code: z
    .string()
    .regex(
      /^[A-Z][A-Z0-9_]{2,59}$/,
      'Code must be an UPPER_SNAKE_CASE ASCII identifier (3–60 chars).',
    ),
  contentType: z.enum(SPIRITUAL_CONTENT_TYPES),
  scopeType: z.enum(CONTENT_SCOPE_TYPES),
  sacredHouseId: z.number().int().positive().nullable().optional(),
  serviceId: z.number().int().positive().nullable().optional(),
  sortOrder: z.number().int().min(-1000).max(1000).default(0),
})
export type ContentItemInput = z.infer<typeof contentItemSchema>

export const contentVersionSchema = z.object({
  language: z.enum(GUIDANCE_LANGUAGES),
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(20_000),
  visibilityStage: z.enum(VISIBILITY_STAGES),
  acknowledgementRequired: z.boolean().default(false),
  allowEnglishFallback: z.boolean().default(false),
})
export type ContentVersionInput = z.infer<typeof contentVersionSchema>

/** Body: trim only outer blank space while preserving internal line
 * breaks exactly; must remain non-empty. Plain text only — the value
 * is stored verbatim and always rendered through React escaping. */
function normalizeBody(body: string): string {
  const normalized = body.replace(/^\s+$/, '').replace(/\s+$/, '')
  if (normalized.length === 0) {
    throw new SpiritualContentError('Guidance body must not be empty.')
  }
  return normalized
}

// --- Item structure ---------------------------------------------------------

interface ScopeResolution {
  scopeType: ContentScopeType
  sacredHouseId: number | null
  serviceId: number | null
}

/** Validates the exactly-one-scope rule server-side. SERVICE derives
 * its House from the Service — a contradictory client House id is
 * rejected, never trusted. */
async function resolveScope(
  input: ContentItemInput,
  db: DbClient,
): Promise<ScopeResolution> {
  switch (input.scopeType) {
    case 'PLATFORM': {
      if (input.sacredHouseId != null || input.serviceId != null) {
        throw new SpiritualContentError(
          'Platform-scoped content must not reference a Sacred House or Service.',
        )
      }
      return { scopeType: 'PLATFORM', sacredHouseId: null, serviceId: null }
    }
    case 'SACRED_HOUSE': {
      if (input.serviceId != null) {
        throw new SpiritualContentError(
          'House-scoped content must not reference a Service.',
        )
      }
      if (input.sacredHouseId == null) {
        throw new SpiritualContentError(
          'House-scoped content requires a Sacred House.',
        )
      }
      const house = (
        await db
          .select({ id: sacredHouses.id })
          .from(sacredHouses)
          .where(eq(sacredHouses.id, input.sacredHouseId))
          .limit(1)
      ).at(0)
      if (!house) throw new SpiritualContentError('Sacred House not found.')
      return {
        scopeType: 'SACRED_HOUSE',
        sacredHouseId: house.id,
        serviceId: null,
      }
    }
    case 'SERVICE': {
      if (input.sacredHouseId != null) {
        throw new SpiritualContentError(
          'Service-scoped content derives its House from the Service — do not supply a House.',
        )
      }
      if (input.serviceId == null) {
        throw new SpiritualContentError(
          'Service-scoped content requires a Service.',
        )
      }
      const service = (
        await db
          .select({ id: services.id })
          .from(services)
          .where(eq(services.id, input.serviceId))
          .limit(1)
      ).at(0)
      if (!service) throw new SpiritualContentError('Service not found.')
      return {
        scopeType: 'SERVICE',
        sacredHouseId: null,
        serviceId: service.id,
      }
    }
  }
}

export async function createContentItem(
  actorId: number,
  ctx: RequestContext,
  input: ContentItemInput,
): Promise<{ id: number; publicId: string }> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const db = getDb()
  const scope = await resolveScope(input, db)
  const publicId = randomUUID()
  let itemId: number
  try {
    const inserted = await db.insert(spiritualContentItems).values({
      publicId,
      code: input.code,
      contentType: input.contentType,
      scopeType: scope.scopeType,
      sacredHouseId: scope.sacredHouseId,
      serviceId: scope.serviceId,
      sortOrder: input.sortOrder,
      createdBy: actorId,
    })
    itemId = inserted[0].insertId
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw new SpiritualContentError(
        'A content item with this code already exists.',
      )
    }
    throw error
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'spiritual_content.item_created',
    entityType: 'spiritual_content_item',
    entityId: String(itemId),
    metadata: {
      publicId,
      code: input.code,
      contentType: input.contentType,
      scopeType: scope.scopeType,
      sacredHouseId: scope.sacredHouseId,
      serviceId: scope.serviceId,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return { id: itemId, publicId }
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

async function loadItem(itemId: number, db: DbClient = getDb()) {
  const row = (
    await db
      .select()
      .from(spiritualContentItems)
      .where(eq(spiritualContentItems.id, itemId))
      .limit(1)
  ).at(0)
  if (!row) throw new SpiritualContentError('Content item not found.')
  return row
}

/** Structure is frozen once ANY version has progressed beyond DRAFT —
 * reviewed sacred guidance is never silently retargeted. */
async function isStructureFrozen(
  itemId: number,
  db: DbClient,
): Promise<boolean> {
  const beyondDraft = await db
    .select({ id: spiritualContentVersions.id })
    .from(spiritualContentVersions)
    .where(
      and(
        eq(spiritualContentVersions.contentItemId, itemId),
        ne(spiritualContentVersions.status, 'DRAFT'),
      ),
    )
    .limit(1)
  return beyondDraft.length > 0
}

export async function updateContentItem(
  actorId: number,
  ctx: RequestContext,
  itemId: number,
  input: ContentItemInput,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.manage')
  await getDb().transaction(async (tx) => {
    const row = (
      await tx
        .select()
        .from(spiritualContentItems)
        .where(eq(spiritualContentItems.id, itemId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!row) throw new SpiritualContentError('Content item not found.')
    const frozen = await isStructureFrozen(itemId, tx)
    const structuralChange =
      input.code !== row.code ||
      input.contentType !== row.contentType ||
      input.scopeType !== row.scopeType ||
      (input.sacredHouseId ?? null) !== row.sacredHouseId ||
      (input.serviceId ?? null) !== row.serviceId
    if (frozen && structuralChange) {
      throw new SpiritualContentError(
        'This item has reviewed versions — its code, type and scope are frozen. Archive it and create a new item instead.',
      )
    }
    const scope = frozen
      ? {
          scopeType: row.scopeType,
          sacredHouseId: row.sacredHouseId,
          serviceId: row.serviceId,
        }
      : await resolveScope(input, tx)
    await tx
      .update(spiritualContentItems)
      .set({
        code: frozen ? row.code : input.code,
        contentType: frozen ? row.contentType : input.contentType,
        scopeType: scope.scopeType,
        sacredHouseId: scope.sacredHouseId,
        serviceId: scope.serviceId,
        sortOrder: input.sortOrder,
      })
      .where(eq(spiritualContentItems.id, itemId))
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'spiritual_content.item_updated',
    entityType: 'spiritual_content_item',
    entityId: String(itemId),
    metadata: { sortOrder: input.sortOrder },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/** Operational active toggle. After publication this is an
 * ADMIN/SUPER_ADMIN control (spiritual_content.publish); it affects
 * FUTURE assignment only — historical assignments never change. */
export async function setContentItemActive(
  actorId: number,
  ctx: RequestContext,
  itemId: number,
  active: boolean,
): Promise<void> {
  const db = getDb()
  const hasPublishedHistory =
    (
      await db
        .select({ id: spiritualContentVersions.id })
        .from(spiritualContentVersions)
        .where(
          and(
            eq(spiritualContentVersions.contentItemId, itemId),
            inArray(spiritualContentVersions.status, ['PUBLISHED', 'ARCHIVED']),
          ),
        )
        .limit(1)
    ).length > 0
  await requirePermission(
    actorId,
    hasPublishedHistory
      ? 'spiritual_content.publish'
      : 'spiritual_content.manage',
  )
  await loadItem(itemId)
  await db
    .update(spiritualContentItems)
    .set({ active })
    .where(eq(spiritualContentItems.id, itemId))
  await recordAuditEvent({
    actorUserId: actorId,
    action: active
      ? 'spiritual_content.item_updated'
      : 'spiritual_content.item_deactivated',
    entityType: 'spiritual_content_item',
    entityId: String(itemId),
    metadata: { active },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Versions ---------------------------------------------------------------

const WORKING_STATUSES: Array<ContentVersionStatus> = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
]

function validateVersionInput(input: ContentVersionInput): ContentVersionInput {
  if (input.allowEnglishFallback && input.language !== 'en') {
    throw new SpiritualContentError(
      'allow_english_fallback may only be enabled on an English version.',
    )
  }
  return { ...input, body: normalizeBody(input.body) }
}

export async function createVersion(
  actorId: number,
  ctx: RequestContext,
  itemId: number,
  rawInput: ContentVersionInput,
): Promise<{ id: number; versionNumber: number }> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const input = validateVersionInput(rawInput)
  const result = await getDb().transaction(async (tx) => {
    // The item row lock serializes version-number allocation AND the
    // one-working-version rule against concurrent requests.
    const item = (
      await tx
        .select()
        .from(spiritualContentItems)
        .where(eq(spiritualContentItems.id, itemId))
        .limit(1)
        .for('update')
    ).at(0)
    if (!item) throw new SpiritualContentError('Content item not found.')

    const working = await tx
      .select({ id: spiritualContentVersions.id })
      .from(spiritualContentVersions)
      .where(
        and(
          eq(spiritualContentVersions.contentItemId, itemId),
          eq(spiritualContentVersions.language, input.language),
          inArray(spiritualContentVersions.status, WORKING_STATUSES),
        ),
      )
      .limit(1)
    if (working.length > 0) {
      throw new SpiritualContentError(
        'A working version (draft, under review or approved) already exists for this item and language.',
      )
    }
    const latest = (
      await tx
        .select({ versionNumber: spiritualContentVersions.versionNumber })
        .from(spiritualContentVersions)
        .where(
          and(
            eq(spiritualContentVersions.contentItemId, itemId),
            eq(spiritualContentVersions.language, input.language),
          ),
        )
        .orderBy(desc(spiritualContentVersions.versionNumber))
        .limit(1)
    ).at(0)
    const versionNumber = (latest?.versionNumber ?? 0) + 1
    const inserted = await tx.insert(spiritualContentVersions).values({
      contentItemId: itemId,
      language: input.language,
      versionNumber,
      title: input.title,
      body: input.body,
      visibilityStage: input.visibilityStage,
      acknowledgementRequired: input.acknowledgementRequired,
      allowEnglishFallback: input.allowEnglishFallback,
      status: 'DRAFT',
      createdBy: actorId,
    })
    return { id: inserted[0].insertId, versionNumber }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'spiritual_content.version_created',
    entityType: 'spiritual_content_version',
    entityId: String(result.id),
    metadata: {
      contentItemId: itemId,
      language: input.language,
      versionNumber: result.versionNumber,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return result
}

async function loadVersion(versionId: number, db: DbClient = getDb()) {
  const row = (
    await db
      .select()
      .from(spiritualContentVersions)
      .where(eq(spiritualContentVersions.id, versionId))
      .limit(1)
  ).at(0)
  if (!row) throw new SpiritualContentError('Content version not found.')
  return row
}

/** Only DRAFT content is editable, and only its content fields. */
export async function updateDraftVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  rawInput: Omit<ContentVersionInput, 'language'>,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const current = await loadVersion(versionId)
  const input = validateVersionInput({
    ...rawInput,
    language: current.language as GuidanceLanguage,
  })
  const result = await getDb()
    .update(spiritualContentVersions)
    .set({
      title: input.title,
      body: input.body,
      visibilityStage: input.visibilityStage,
      acknowledgementRequired: input.acknowledgementRequired,
      allowEnglishFallback: input.allowEnglishFallback,
    })
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
    action: 'spiritual_content.version_updated',
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

export async function submitVersionForReview(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.manage')
  const current = await loadVersion(versionId)
  const result = await getDb()
    .update(spiritualContentVersions)
    .set({ status: 'UNDER_REVIEW', submittedAt: new Date(), reviewNote: null })
    .where(
      and(
        eq(spiritualContentVersions.id, versionId),
        eq(spiritualContentVersions.status, 'DRAFT'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new SpiritualContentError(
      'Only draft versions can be submitted for review.',
    )
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'spiritual_content.version_submitted',
    entityType: 'spiritual_content_version',
    entityId: String(versionId),
    metadata: {
      contentItemId: current.contentItemId,
      language: current.language,
      versionNumber: current.versionNumber,
      from: 'DRAFT',
      to: 'UNDER_REVIEW',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function returnVersionToDraft(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  reason: string,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.approve')
  const trimmed = reason.trim()
  if (!trimmed) {
    throw new SpiritualContentError('Returning to draft requires a reason.')
  }
  const current = await loadVersion(versionId)
  const result = await getDb()
    .update(spiritualContentVersions)
    .set({
      status: 'DRAFT',
      reviewNote: trimmed.slice(0, 500),
      approvedBy: null,
      approvedAt: null,
    })
    .where(
      and(
        eq(spiritualContentVersions.id, versionId),
        eq(spiritualContentVersions.status, 'UNDER_REVIEW'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new SpiritualContentError(
      'Only versions under review can be returned to draft.',
    )
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'spiritual_content.version_returned',
    entityType: 'spiritual_content_version',
    entityId: String(versionId),
    metadata: {
      contentItemId: current.contentItemId,
      language: current.language,
      versionNumber: current.versionNumber,
      from: 'UNDER_REVIEW',
      to: 'DRAFT',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function approveVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.approve')
  const current = await loadVersion(versionId)
  const result = await getDb()
    .update(spiritualContentVersions)
    .set({ status: 'APPROVED', approvedBy: actorId, approvedAt: new Date() })
    .where(
      and(
        eq(spiritualContentVersions.id, versionId),
        eq(spiritualContentVersions.status, 'UNDER_REVIEW'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new SpiritualContentError(
      'Only versions under review can be approved.',
    )
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'spiritual_content.version_approved',
    entityType: 'spiritual_content_version',
    entityId: String(versionId),
    metadata: {
      contentItemId: current.contentItemId,
      language: current.language,
      versionNumber: current.versionNumber,
      from: 'UNDER_REVIEW',
      to: 'APPROVED',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/**
 * Publication replacement (spec §22): serialized on the content item
 * row so there is never more than one CURRENT PUBLISHED version per
 * item/language and never a half-published state visible outside the
 * transaction. The replaced version's body stays immutable; only its
 * status becomes ARCHIVED. Historical appointment assignments pointing
 * at it remain valid and are never rewritten.
 */
export async function publishVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<{ archivedVersionId: number | null }> {
  await requirePermission(actorId, 'spiritual_content.publish')
  const preRead = await loadVersion(versionId)
  const outcome = await getDb().transaction(async (tx) => {
    await tx
      .select({ id: spiritualContentItems.id })
      .from(spiritualContentItems)
      .where(eq(spiritualContentItems.id, preRead.contentItemId))
      .limit(1)
      .for('update')
    const target = (
      await tx
        .select()
        .from(spiritualContentVersions)
        .where(eq(spiritualContentVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target || target.status !== 'APPROVED') {
      throw new SpiritualContentError(
        'Only approved versions can be published.',
      )
    }
    const currentPublished = (
      await tx
        .select({ id: spiritualContentVersions.id })
        .from(spiritualContentVersions)
        .where(
          and(
            eq(spiritualContentVersions.contentItemId, target.contentItemId),
            eq(spiritualContentVersions.language, target.language),
            eq(spiritualContentVersions.status, 'PUBLISHED'),
          ),
        )
        .limit(1)
    ).at(0)
    if (currentPublished) {
      const archived = await tx
        .update(spiritualContentVersions)
        .set({ status: 'ARCHIVED', archivedAt: new Date() })
        .where(
          and(
            eq(spiritualContentVersions.id, currentPublished.id),
            eq(spiritualContentVersions.status, 'PUBLISHED'),
          ),
        )
      if (archived[0].affectedRows !== 1) {
        throw new SpiritualContentError('Publication conflict — try again.')
      }
    }
    const published = await tx
      .update(spiritualContentVersions)
      .set({
        status: 'PUBLISHED',
        publishedBy: actorId,
        publishedAt: new Date(),
      })
      .where(
        and(
          eq(spiritualContentVersions.id, versionId),
          eq(spiritualContentVersions.status, 'APPROVED'),
        ),
      )
    if (published[0].affectedRows !== 1) {
      throw new SpiritualContentError('Publication conflict — try again.')
    }
    return { archivedVersionId: currentPublished?.id ?? null }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'spiritual_content.version_published',
    entityType: 'spiritual_content_version',
    entityId: String(versionId),
    metadata: {
      contentItemId: preRead.contentItemId,
      language: preRead.language,
      versionNumber: preRead.versionNumber,
      replacedVersionId: outcome.archivedVersionId,
      from: 'APPROVED',
      to: 'PUBLISHED',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  if (outcome.archivedVersionId != null) {
    await recordAuditEvent({
      actorUserId: actorId,
      action: 'spiritual_content.version_archived',
      entityType: 'spiritual_content_version',
      entityId: String(outcome.archivedVersionId),
      metadata: {
        contentItemId: preRead.contentItemId,
        language: preRead.language,
        reason: 'replaced_by_new_publication',
        replacedByVersionId: versionId,
      },
    })
  }
  return outcome
}

/** ADMIN archival of an abandoned DRAFT/UNDER_REVIEW/APPROVED version
 * or retirement of a PUBLISHED one. ARCHIVED is terminal in Step 7. */
export async function archiveVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'spiritual_content.publish')
  const current = await loadVersion(versionId)
  if (current.status === 'ARCHIVED') {
    throw new SpiritualContentError('This version is already archived.')
  }
  const result = await getDb()
    .update(spiritualContentVersions)
    .set({ status: 'ARCHIVED', archivedAt: new Date() })
    .where(
      and(
        eq(spiritualContentVersions.id, versionId),
        eq(
          spiritualContentVersions.status,
          current.status as ContentVersionStatus,
        ),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new SpiritualContentError('Archive conflict — try again.')
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'spiritual_content.version_archived',
    entityType: 'spiritual_content_version',
    entityId: String(versionId),
    metadata: {
      contentItemId: current.contentItemId,
      language: current.language,
      versionNumber: current.versionNumber,
      from: current.status,
      to: 'ARCHIVED',
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Library queries (staff) ------------------------------------------------

export interface ContentLibraryFilters {
  contentType?: SpiritualContentType
  scopeType?: ContentScopeType
  sacredHouseId?: number
  serviceId?: number
  active?: boolean
}

/** Library list: safe metadata only — no bodies in list views. */
export async function listContentItems(filters: ContentLibraryFilters) {
  const conditions = []
  if (filters.contentType) {
    conditions.push(eq(spiritualContentItems.contentType, filters.contentType))
  }
  if (filters.scopeType) {
    conditions.push(eq(spiritualContentItems.scopeType, filters.scopeType))
  }
  if (filters.sacredHouseId != null) {
    conditions.push(
      eq(spiritualContentItems.sacredHouseId, filters.sacredHouseId),
    )
  }
  if (filters.serviceId != null) {
    conditions.push(eq(spiritualContentItems.serviceId, filters.serviceId))
  }
  if (filters.active != null) {
    conditions.push(eq(spiritualContentItems.active, filters.active))
  }
  const db = getDb()
  const items = await db
    .select({
      id: spiritualContentItems.id,
      publicId: spiritualContentItems.publicId,
      code: spiritualContentItems.code,
      contentType: spiritualContentItems.contentType,
      scopeType: spiritualContentItems.scopeType,
      sacredHouseId: spiritualContentItems.sacredHouseId,
      serviceId: spiritualContentItems.serviceId,
      sortOrder: spiritualContentItems.sortOrder,
      active: spiritualContentItems.active,
    })
    .from(spiritualContentItems)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(
      asc(spiritualContentItems.contentType),
      asc(spiritualContentItems.sortOrder),
      asc(spiritualContentItems.id),
    )
    .limit(500)
  if (items.length === 0) return []
  const versionSummaries = await db
    .select({
      id: spiritualContentVersions.id,
      contentItemId: spiritualContentVersions.contentItemId,
      language: spiritualContentVersions.language,
      versionNumber: spiritualContentVersions.versionNumber,
      status: spiritualContentVersions.status,
    })
    .from(spiritualContentVersions)
    .where(
      inArray(
        spiritualContentVersions.contentItemId,
        items.map((item) => item.id),
      ),
    )
    .orderBy(desc(spiritualContentVersions.versionNumber))
  return items.map((item) => {
    const forItem = versionSummaries.filter(
      (version) => version.contentItemId === item.id,
    )
    const summarize = (language: string) => {
      const versions = forItem.filter((v) => v.language === language)
      const published = versions.find((v) => v.status === 'PUBLISHED')
      const working = versions.find((v) => WORKING_STATUSES.includes(v.status))
      return {
        publishedVersion: published?.versionNumber ?? null,
        workingStatus: working?.status ?? null,
        workingVersion: working?.versionNumber ?? null,
      }
    }
    return { ...item, en: summarize('en'), yo: summarize('yo') }
  })
}

export async function getContentItemDetail(itemId: number) {
  const item = await loadItem(itemId)
  const versions = await getDb()
    .select()
    .from(spiritualContentVersions)
    .where(eq(spiritualContentVersions.contentItemId, itemId))
    .orderBy(
      asc(spiritualContentVersions.language),
      desc(spiritualContentVersions.versionNumber),
    )
  const frozen = await isStructureFrozen(itemId, getDb())
  return { item, versions, structureFrozen: frozen }
}

/** Review queue: everything UNDER_REVIEW, oldest submission first. */
export async function listReviewQueue() {
  return getDb()
    .select({
      version: spiritualContentVersions,
      item: {
        id: spiritualContentItems.id,
        code: spiritualContentItems.code,
        contentType: spiritualContentItems.contentType,
        scopeType: spiritualContentItems.scopeType,
        sacredHouseId: spiritualContentItems.sacredHouseId,
        serviceId: spiritualContentItems.serviceId,
      },
    })
    .from(spiritualContentVersions)
    .innerJoin(
      spiritualContentItems,
      eq(spiritualContentVersions.contentItemId, spiritualContentItems.id),
    )
    .where(eq(spiritualContentVersions.status, 'UNDER_REVIEW'))
    .orderBy(asc(spiritualContentVersions.submittedAt))
    .limit(200)
}
