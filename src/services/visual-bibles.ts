import { createHash, randomUUID } from 'node:crypto'

import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { getDb } from '@/db'
import {
  VISUAL_BIBLE_RULE_CATEGORIES,
  sacredHouses,
  visualBibleRules,
  visualBibleVersions,
  visualBibles,
} from '@/db/schema'
import {
  assertReferencePackUsable,
  describeReferenceState,
  assertReferenceSnapshotUnchanged,
  captureUsableReferenceSnapshot,
  listVisualBibleReferences,
} from './visual-bible-references'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import { MediaError } from './media-assets'
import type { DbClient } from '@/db'
import type { ContentVersionStatus } from '@/db/schema'
import type { RequestContext } from '@/auth/service'

/**
 * Visual Bibles (Phase One, Step 10; canon §12): one canonical,
 * versioned visual rulebook per Sacred House. Rules are HUMAN-AUTHORED
 * ordered plain text — never AI generated — and become immutable once
 * a version leaves DRAFT. Published versions carry a deterministic
 * definition SHA-256 over the authoritative normalized rules; the
 * runtime loader re-verifies it and fails CLOSED on corruption
 * (never auto-healing).
 */

export const visualBibleRuleSchema = z.object({
  category: z.enum(VISUAL_BIBLE_RULE_CATEGORIES),
  position: z.number().int().min(1).max(500),
  ruleText: z.string().trim().min(1).max(2000),
})
export type VisualBibleRuleInput = z.infer<typeof visualBibleRuleSchema>

export const visualBibleVersionSchema = z.object({
  rules: z.array(visualBibleRuleSchema).min(1).max(500),
})
export type VisualBibleVersionInput = z.infer<typeof visualBibleVersionSchema>

const WORKING_STATUSES: Array<ContentVersionStatus> = [
  'DRAFT',
  'UNDER_REVIEW',
  'APPROVED',
]

function validateRules(rules: Array<VisualBibleRuleInput>): void {
  const positions = new Set<number>()
  for (const rule of rules) {
    if (positions.has(rule.position)) {
      throw new MediaError(`Duplicate rule position ${rule.position}.`)
    }
    positions.add(rule.position)
  }
}

export async function createVisualBible(
  actorId: number,
  ctx: RequestContext,
  sacredHouseId: number,
): Promise<{ id: number; publicId: string }> {
  await requirePermission(actorId, 'media.manage')
  const house = (
    await getDb()
      .select({ id: sacredHouses.id })
      .from(sacredHouses)
      .where(eq(sacredHouses.id, sacredHouseId))
      .limit(1)
  ).at(0)
  if (!house) throw new MediaError('Sacred House not found.')
  const publicId = randomUUID()
  let bibleId: number
  try {
    const inserted = await getDb().insert(visualBibles).values({
      publicId,
      sacredHouseId,
      createdBy: actorId,
    })
    bibleId = inserted[0].insertId
  } catch (error) {
    // Walk the cause chain — drizzle wraps the driver duplicate-key
    // error in a DrizzleQueryError.
    let current: unknown = error
    for (let depth = 0; depth < 4 && current; depth += 1) {
      const message =
        current instanceof Error ? current.message : String(current)
      if (message.includes('Duplicate entry')) {
        throw new MediaError('This Sacred House already has a Visual Bible.')
      }
      current = current instanceof Error ? current.cause : undefined
    }
    throw error
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.created',
    entityType: 'visual_bible',
    entityId: String(bibleId),
    metadata: { publicId, sacredHouseId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return { id: bibleId, publicId }
}

export async function lockBible(tx: DbClient, bibleId: number) {
  const row = (
    await tx
      .select()
      .from(visualBibles)
      .where(eq(visualBibles.id, bibleId))
      .limit(1)
      .for('update')
  ).at(0)
  if (!row) throw new MediaError('Visual Bible not found.')
  return row
}

export async function createVisualBibleVersion(
  actorId: number,
  ctx: RequestContext,
  bibleId: number,
  rawInput: VisualBibleVersionInput,
): Promise<{ id: number; versionNumber: number }> {
  await requirePermission(actorId, 'media.manage')
  const input = visualBibleVersionSchema.parse(rawInput)
  validateRules(input.rules)
  const result = await getDb().transaction(async (tx) => {
    await lockBible(tx, bibleId)
    const working = await tx
      .select({ id: visualBibleVersions.id })
      .from(visualBibleVersions)
      .where(
        and(
          eq(visualBibleVersions.visualBibleId, bibleId),
          inArray(visualBibleVersions.status, WORKING_STATUSES),
        ),
      )
      .limit(1)
    if (working.length > 0) {
      throw new MediaError(
        'A working version (draft, under review or approved) already exists for this Visual Bible.',
      )
    }
    const latest = (
      await tx
        .select({ versionNumber: visualBibleVersions.versionNumber })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.visualBibleId, bibleId))
        .orderBy(desc(visualBibleVersions.versionNumber))
        .limit(1)
    ).at(0)
    const versionNumber = (latest?.versionNumber ?? 0) + 1
    const inserted = await tx.insert(visualBibleVersions).values({
      visualBibleId: bibleId,
      versionNumber,
      status: 'DRAFT',
      createdBy: actorId,
    })
    const versionId = inserted[0].insertId
    for (const rule of input.rules) {
      await tx.insert(visualBibleRules).values({
        bibleVersionId: versionId,
        category: rule.category,
        position: rule.position,
        ruleText: rule.ruleText,
      })
    }
    return { id: versionId, versionNumber }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.version_created',
    entityType: 'visual_bible_version',
    entityId: String(result.id),
    metadata: {
      visualBibleId: bibleId,
      versionNumber: result.versionNumber,
      ruleCount: input.rules.length,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return result
}

export async function loadVisualBibleVersion(
  versionId: number,
  db: DbClient = getDb(),
) {
  const row = (
    await db
      .select()
      .from(visualBibleVersions)
      .where(eq(visualBibleVersions.id, versionId))
      .limit(1)
  ).at(0)
  if (!row) throw new MediaError('Visual Bible version not found.')
  return row
}

/** DRAFT-only rule editing: replaces the draft rule rows atomically. */
export async function updateDraftVisualBibleVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  rawInput: VisualBibleVersionInput,
): Promise<void> {
  await requirePermission(actorId, 'media.manage')
  const input = visualBibleVersionSchema.parse(rawInput)
  validateRules(input.rules)
  const current = await loadVisualBibleVersion(versionId)
  await getDb().transaction(async (tx) => {
    await lockBible(tx, current.visualBibleId)
    const target = (
      await tx
        .select({ status: visualBibleVersions.status })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target || target.status !== 'DRAFT') {
      throw new MediaError('Only draft versions can be edited.')
    }
    await tx
      .delete(visualBibleRules)
      .where(eq(visualBibleRules.bibleVersionId, versionId))
    for (const rule of input.rules) {
      await tx.insert(visualBibleRules).values({
        bibleVersionId: versionId,
        category: rule.category,
        position: rule.position,
        ruleText: rule.ruleText,
      })
    }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.version_updated',
    entityType: 'visual_bible_version',
    entityId: String(versionId),
    metadata: {
      visualBibleId: current.visualBibleId,
      versionNumber: current.versionNumber,
      ruleCount: input.rules.length,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

async function loadRules(versionId: number, db: DbClient = getDb()) {
  return db
    .select()
    .from(visualBibleRules)
    .where(eq(visualBibleRules.bibleVersionId, versionId))
    .orderBy(asc(visualBibleRules.position))
}

/** Deterministic canonical representation of the authoritative rules
 * (stable key order, rules by position). */
/**
 * The canonical definition of a Visual Bible version.
 *
 * Covers the reference MODE and the ordered reference BINDINGS as well
 * as the rules, because a bound image governs depiction exactly as a
 * written rule does — a version whose imagery changed but whose hash
 * did not would be a silently different Visual Bible.
 *
 * References are hashed by role, exact media VERSION id and the file
 * hash frozen at bind time, in canonical role order, so the value never
 * depends on insertion sequence.
 *
 * The publisher and the runtime loader MUST compute this identically;
 * changing one without the other would fail every published Bible
 * closed.
 */
export function computeVisualBibleSha256(definition: {
  visualBibleId: number
  versionNumber: number
  referenceMode: string
  rules: Array<{ category: string; position: number; ruleText: string }>
  references: Array<{
    role: string
    mediaAssetVersionId: number
    mediaFileSha256: string
  }>
}): string {
  const canonical = JSON.stringify({
    visualBibleId: definition.visualBibleId,
    versionNumber: definition.versionNumber,
    referenceMode: definition.referenceMode,
    rules: definition.rules.map((rule) => ({
      category: rule.category,
      position: rule.position,
      ruleText: rule.ruleText,
    })),
    references: definition.references.map((reference) => ({
      role: reference.role,
      mediaAssetVersionId: reference.mediaAssetVersionId,
      mediaFileSha256: reference.mediaFileSha256,
    })),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export async function submitVisualBibleVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'media.manage')
  const current = await loadVisualBibleVersion(versionId)
  // Advancing past DRAFT freezes the references too, so prove they are
  // complete and usable first. That work reads storage and hashes
  // bytes, so it CANNOT hold a row lock — which is exactly why what it
  // proved is captured and re-checked under the lock below. Without
  // that, an unbind landing in between would freeze a pack nobody
  // validated.
  const validated = await captureUsableReferenceSnapshot(versionId)
  await getDb().transaction(async (tx) => {
    await lockBible(tx, current.visualBibleId)
    await assertReferenceSnapshotUnchanged(tx, versionId, validated)
    const result = await tx
      .update(visualBibleVersions)
      .set({
        status: 'UNDER_REVIEW',
        submittedAt: new Date(),
        reviewNote: null,
      })
      .where(
        and(
          eq(visualBibleVersions.id, versionId),
          eq(visualBibleVersions.status, 'DRAFT'),
        ),
      )
    if (result[0].affectedRows !== 1) {
      throw new MediaError('Only draft versions can be submitted for review.')
    }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.version_submitted',
    entityType: 'visual_bible_version',
    entityId: String(versionId),
    metadata: {
      visualBibleId: current.visualBibleId,
      versionNumber: current.versionNumber,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function returnVisualBibleVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  reason: string,
): Promise<void> {
  await requirePermission(actorId, 'media.approve')
  const trimmed = reason.trim()
  if (!trimmed) throw new MediaError('Returning to draft requires a reason.')
  const current = await loadVisualBibleVersion(versionId)
  const result = await getDb()
    .update(visualBibleVersions)
    .set({
      status: 'DRAFT',
      reviewNote: trimmed.slice(0, 500),
      approvedBy: null,
      approvedAt: null,
    })
    .where(
      and(
        eq(visualBibleVersions.id, versionId),
        eq(visualBibleVersions.status, 'UNDER_REVIEW'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new MediaError('Only versions under review can be returned to draft.')
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.version_returned',
    entityType: 'visual_bible_version',
    entityId: String(versionId),
    metadata: {
      visualBibleId: current.visualBibleId,
      versionNumber: current.versionNumber,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function approveVisualBibleVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'media.approve')
  const current = await loadVisualBibleVersion(versionId)
  // Re-proved at approval: rights or runtime state may have changed
  // while the version sat under review.
  await assertReferencePackUsable(versionId)
  const result = await getDb()
    .update(visualBibleVersions)
    .set({ status: 'APPROVED', approvedBy: actorId, approvedAt: new Date() })
    .where(
      and(
        eq(visualBibleVersions.id, versionId),
        eq(visualBibleVersions.status, 'UNDER_REVIEW'),
      ),
    )
  if (result[0].affectedRows !== 1) {
    throw new MediaError('Only versions under review can be approved.')
  }
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.version_approved',
    entityType: 'visual_bible_version',
    entityId: String(versionId),
    metadata: {
      visualBibleId: current.visualBibleId,
      versionNumber: current.versionNumber,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/** Publication: validates contiguous positions, computes the canonical
 * definition SHA-256 from the authoritative rows IN the transaction,
 * and replaces the current PUBLISHED version for the House. */
export async function publishVisualBibleVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<{ definitionSha256: string }> {
  await requirePermission(actorId, 'media.publish')
  const preRead = await loadVisualBibleVersion(versionId)
  const outcome = await getDb().transaction(async (tx) => {
    await lockBible(tx, preRead.visualBibleId)
    const target = (
      await tx
        .select({ status: visualBibleVersions.status })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target || target.status !== 'APPROVED') {
      throw new MediaError('Only approved versions can be published.')
    }
    const rules = await loadRules(versionId, tx)
    if (rules.length === 0) {
      throw new MediaError('A Visual Bible needs at least one rule.')
    }
    const positions = rules.map((rule) => rule.position).sort((a, b) => a - b)
    for (let i = 0; i < positions.length; i += 1) {
      if (positions[i] !== i + 1) {
        throw new MediaError(
          'Rule positions must be unique and contiguous starting at 1.',
        )
      }
    }
    // The complete reference pack (when required) and the current
    // eligibility of every bound reference are publication
    // preconditions, proved before the hash is computed over them.
    await assertReferencePackUsable(versionId)
    const references = await listVisualBibleReferences(versionId)
    const definitionSha256 = computeVisualBibleSha256({
      visualBibleId: preRead.visualBibleId,
      versionNumber: preRead.versionNumber,
      referenceMode: preRead.referenceMode,
      rules,
      references,
    })
    const currentPublished = (
      await tx
        .select({ id: visualBibleVersions.id })
        .from(visualBibleVersions)
        .where(
          and(
            eq(visualBibleVersions.visualBibleId, preRead.visualBibleId),
            eq(visualBibleVersions.status, 'PUBLISHED'),
          ),
        )
        .limit(1)
    ).at(0)
    if (currentPublished) {
      const archived = await tx
        .update(visualBibleVersions)
        .set({ status: 'ARCHIVED', archivedAt: new Date() })
        .where(
          and(
            eq(visualBibleVersions.id, currentPublished.id),
            eq(visualBibleVersions.status, 'PUBLISHED'),
          ),
        )
      if (archived[0].affectedRows !== 1) {
        throw new MediaError('Publication conflict — try again.')
      }
    }
    const published = await tx
      .update(visualBibleVersions)
      .set({
        status: 'PUBLISHED',
        publishedBy: actorId,
        publishedAt: new Date(),
        definitionSha256,
      })
      .where(
        and(
          eq(visualBibleVersions.id, versionId),
          eq(visualBibleVersions.status, 'APPROVED'),
        ),
      )
    if (published[0].affectedRows !== 1) {
      throw new MediaError('Publication conflict — try again.')
    }
    return { definitionSha256 }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.version_published',
    entityType: 'visual_bible_version',
    entityId: String(versionId),
    metadata: {
      visualBibleId: preRead.visualBibleId,
      versionNumber: preRead.versionNumber,
      definitionSha256: outcome.definitionSha256,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return outcome
}

export async function archiveVisualBibleVersion(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
): Promise<void> {
  await requirePermission(actorId, 'media.publish')
  const preRead = await loadVisualBibleVersion(versionId)
  await getDb().transaction(async (tx) => {
    await lockBible(tx, preRead.visualBibleId)
    const target = (
      await tx
        .select({ status: visualBibleVersions.status })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, versionId))
        .limit(1)
    ).at(0)
    if (!target) throw new MediaError('Visual Bible version not found.')
    if (target.status === 'ARCHIVED') {
      throw new MediaError('This version is already archived.')
    }
    const result = await tx
      .update(visualBibleVersions)
      .set({ status: 'ARCHIVED', archivedAt: new Date() })
      .where(
        and(
          eq(visualBibleVersions.id, versionId),
          eq(visualBibleVersions.status, target.status),
        ),
      )
    if (result[0].affectedRows !== 1) {
      throw new MediaError('Archive conflict — try again.')
    }
  })
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.version_archived',
    entityType: 'visual_bible_version',
    entityId: String(versionId),
    metadata: {
      visualBibleId: preRead.visualBibleId,
      versionNumber: preRead.versionNumber,
    },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

// --- Verified runtime loader ------------------------------------------------

export type LoadedVisualBible =
  | {
      status: 'OK'
      visualBibleId: number
      versionId: number
      versionNumber: number
      definitionSha256: string
      rules: Array<{
        category: string
        position: number
        ruleText: string
      }>
      referenceMode: string
      /** Approved reference identity only — never bytes or storage keys. */
      references: Array<{
        role: string
        mediaAssetVersionId: number
        mediaFileSha256: string
      }>
    }
  | { status: 'NOT_FOUND' }
  | { status: 'INTEGRITY_FAILURE' }

/**
 * Runtime loader for a House's published Visual Bible. Recomputes the
 * canonical hash from the authoritative rows and FAILS CLOSED on any
 * mismatch — corrupted rules are never served and never auto-healed.
 */
export async function loadPublishedVisualBible(
  sacredHouseId: number,
): Promise<LoadedVisualBible> {
  const row = (
    await getDb()
      .select({ bible: visualBibles, version: visualBibleVersions })
      .from(visualBibles)
      .innerJoin(
        visualBibleVersions,
        eq(visualBibleVersions.visualBibleId, visualBibles.id),
      )
      .where(
        and(
          eq(visualBibles.sacredHouseId, sacredHouseId),
          eq(visualBibles.active, true),
          eq(visualBibleVersions.status, 'PUBLISHED'),
        ),
      )
      .limit(1)
  ).at(0)
  if (!row) return { status: 'NOT_FOUND' }
  const rules = await loadRules(row.version.id)
  // Recomputed over the SAME inputs the publisher hashed — rules AND
  // reference mode AND bindings. Any divergence fails closed.
  const references = await listVisualBibleReferences(row.version.id)
  const recomputed = computeVisualBibleSha256({
    visualBibleId: row.bible.id,
    versionNumber: row.version.versionNumber,
    referenceMode: row.version.referenceMode,
    rules,
    references,
  })
  if (
    row.version.definitionSha256 == null ||
    row.version.definitionSha256 !== recomputed
  ) {
    return { status: 'INTEGRITY_FAILURE' }
  }
  return {
    status: 'OK',
    visualBibleId: row.bible.id,
    versionId: row.version.id,
    versionNumber: row.version.versionNumber,
    definitionSha256: row.version.definitionSha256,
    rules: rules.map((rule) => ({
      category: rule.category,
      position: rule.position,
      ruleText: rule.ruleText,
    })),
    referenceMode: row.version.referenceMode,
    /** Approved reference IDENTITY only — no bytes, no storage key.
     * Callers that need the image resolve it later, after their own
     * eligibility revalidation. */
    references,
  }
}

export async function listVisualBibles() {
  const bibles = await getDb()
    .select({ bible: visualBibles, houseName: sacredHouses.name })
    .from(visualBibles)
    .innerJoin(sacredHouses, eq(visualBibles.sacredHouseId, sacredHouses.id))
    .orderBy(asc(sacredHouses.sortOrder))
    .limit(200)
  if (bibles.length === 0) return []
  const versions = await getDb()
    .select({
      id: visualBibleVersions.id,
      visualBibleId: visualBibleVersions.visualBibleId,
      versionNumber: visualBibleVersions.versionNumber,
      status: visualBibleVersions.status,
      definitionSha256: visualBibleVersions.definitionSha256,
    })
    .from(visualBibleVersions)
    .where(
      inArray(
        visualBibleVersions.visualBibleId,
        bibles.map((row) => row.bible.id),
      ),
    )
    .orderBy(desc(visualBibleVersions.versionNumber))
  return bibles.map((row) => ({
    ...row.bible,
    houseName: row.houseName,
    versions: versions.filter(
      (version) => version.visualBibleId === row.bible.id,
    ),
  }))
}

export async function getVisualBibleDetail(bibleId: number) {
  const bible = (
    await getDb()
      .select({ bible: visualBibles, houseName: sacredHouses.name })
      .from(visualBibles)
      .innerJoin(sacredHouses, eq(visualBibles.sacredHouseId, sacredHouses.id))
      .where(eq(visualBibles.id, bibleId))
      .limit(1)
  ).at(0)
  if (!bible) throw new MediaError('Visual Bible not found.')
  const versions = await getDb()
    .select()
    .from(visualBibleVersions)
    .where(eq(visualBibleVersions.visualBibleId, bibleId))
    .orderBy(desc(visualBibleVersions.versionNumber))
  const rulesByVersion: Record<
    number,
    Awaited<ReturnType<typeof loadRules>>
  > = {}
  const referencesByVersion: Record<
    number,
    Awaited<ReturnType<typeof listVisualBibleReferences>>
  > = {}
  // Current eligibility per binding, computed from service authority so
  // a reviewer sees whether each reference is usable RIGHT NOW rather
  // than whatever the browser last believed.
  const referenceStateByVersion: Record<
    number,
    Array<{
      role: string
      mediaAssetVersionId: number
      mediaFileSha256: string
      eligible: boolean
      failures: Array<string>
      assetKind: string | null
      rightsStatus: string | null
      runtimeEnabled: boolean | null
      externalAiPolicy: string | null
    }>
  > = {}
  for (const version of versions) {
    rulesByVersion[version.id] = await loadRules(version.id)
    const references = await listVisualBibleReferences(version.id)
    referencesByVersion[version.id] = references
    referenceStateByVersion[version.id] = await Promise.all(
      references.map(async (reference) => {
        const state = await describeReferenceState({
          mediaAssetVersionId: reference.mediaAssetVersionId,
          sacredHouseId: bible.bible.sacredHouseId,
          boundFileSha256: reference.mediaFileSha256,
        })
        return { ...reference, ...state }
      }),
    )
  }
  return {
    bible: bible.bible,
    houseName: bible.houseName,
    versions,
    rulesByVersion,
    referencesByVersion,
    referenceStateByVersion,
  }
}
