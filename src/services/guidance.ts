import { and, asc, eq, inArray, or } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  appointmentGuidanceAcknowledgements,
  appointmentGuidanceAssignments,
  appointmentGuidanceSets,
  appointments,
  spiritualContentItems,
  spiritualContentVersions,
  userProfiles,
} from '@/db/schema'
import { recordAuditEvent } from '@/auth/audit'
import type { DbClient } from '@/db'
import type {
  AppointmentStatus,
  ContentScopeType,
  GuidanceSelectionResult,
  VisibilityStage,
} from '@/db/schema'
import type { RequestContext } from '@/auth/service'

/**
 * Appointment guidance selection & display (Step 7).
 *
 * Locked rules:
 * - Selection runs EXACTLY ONCE, inside the same transaction as the
 *   appointment's CONFIRMED transition. The guidance-set row (PK =
 *   appointment id) is the exactly-once boundary — even a
 *   zero-assignment outcome is recorded so newly published content can
 *   never attach to an already-confirmed appointment.
 * - Assigned versions are FROZEN references to immutable content
 *   versions. User display reads assignments — never "current
 *   version". Later edits/publications/archival/deactivation/profile
 *   language changes never rewrite an appointment's guidance.
 * - Deterministic scope priority per content type:
 *   SERVICE → SACRED_HOUSE → PLATFORM, most specific assignable scope
 *   wins and lower scopes of the SAME type are excluded.
 * - Language: the profile language snapshotted at confirmation;
 *   yo → en fallback ONLY when the English version explicitly allows
 *   it; no reverse fallback; missing language records
 *   MISSING_LANGUAGE with zero assignments (never silently English).
 *
 * This module deliberately depends only on the schema and audit
 * helpers — never on the appointments service — so the authoritative
 * confirmation primitive can call it without circular imports.
 */

export class GuidanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuidanceError'
  }
}

export interface GuidanceAssignmentSummary {
  selectionResult: GuidanceSelectionResult
  assignmentCount: number
  contentVersionIds: Array<number>
  alreadyExisted: boolean
}

const SCOPE_PRIORITY: Array<ContentScopeType> = [
  'SERVICE',
  'SACRED_HOUSE',
  'PLATFORM',
]

/**
 * Performs the one-time guidance selection for a just-confirmed
 * appointment. MUST run inside the confirmation transaction (the
 * caller holds the House scheduling lock and the appointment row
 * lock). Idempotent: an existing guidance set returns unchanged.
 * Genuine database failures throw — rolling back the confirmation —
 * while "no content" and "missing language" are recorded outcomes,
 * never errors.
 */
export async function assignGuidanceForAppointmentUnderTx(
  tx: DbClient,
  appointmentId: number,
): Promise<GuidanceAssignmentSummary> {
  const existing = (
    await tx
      .select()
      .from(appointmentGuidanceSets)
      .where(eq(appointmentGuidanceSets.appointmentId, appointmentId))
      .limit(1)
  ).at(0)
  if (existing) {
    return {
      selectionResult: existing.selectionResult,
      assignmentCount: existing.assignmentCount,
      contentVersionIds: [],
      alreadyExisted: true,
    }
  }

  const appointment = (
    await tx
      .select({
        id: appointments.id,
        userId: appointments.userId,
        serviceId: appointments.serviceId,
        sacredHouseId: appointments.sacredHouseId,
      })
      .from(appointments)
      .where(eq(appointments.id, appointmentId))
      .limit(1)
  ).at(0)
  if (!appointment) throw new GuidanceError('Appointment not found.')

  const profile = (
    await tx
      .select({ preferredLanguage: userProfiles.preferredLanguage })
      .from(userProfiles)
      .where(eq(userProfiles.userId, appointment.userId))
      .limit(1)
  ).at(0)
  const preferredLanguage = profile?.preferredLanguage ?? null

  if (preferredLanguage !== 'en' && preferredLanguage !== 'yo') {
    // Never silently assume English (spec §28). Record the outcome so
    // the appointment is confirmed normally and selection never
    // re-runs or auto-fills from later profile changes.
    await tx.insert(appointmentGuidanceSets).values({
      appointmentId,
      preferredLanguageSnapshot: preferredLanguage,
      selectionResult: 'MISSING_LANGUAGE',
      assignmentCount: 0,
    })
    return {
      selectionResult: 'MISSING_LANGUAGE',
      assignmentCount: 0,
      contentVersionIds: [],
      alreadyExisted: false,
    }
  }

  // All potentially applicable ACTIVE items in one bounded query.
  const candidateItems = await tx
    .select({
      id: spiritualContentItems.id,
      contentType: spiritualContentItems.contentType,
      scopeType: spiritualContentItems.scopeType,
      sortOrder: spiritualContentItems.sortOrder,
    })
    .from(spiritualContentItems)
    .where(
      and(
        eq(spiritualContentItems.active, true),
        or(
          and(
            eq(spiritualContentItems.scopeType, 'SERVICE'),
            eq(spiritualContentItems.serviceId, appointment.serviceId),
          ),
          and(
            eq(spiritualContentItems.scopeType, 'SACRED_HOUSE'),
            eq(spiritualContentItems.sacredHouseId, appointment.sacredHouseId),
          ),
          eq(spiritualContentItems.scopeType, 'PLATFORM'),
        ),
      ),
    )

  interface Resolved {
    itemId: number
    contentType: string
    scopeType: ContentScopeType
    sortOrder: number
    versionId: number
    fallbackUsed: boolean
  }
  const resolved: Array<Resolved> = []

  if (candidateItems.length > 0) {
    const publishedVersions = await tx
      .select({
        id: spiritualContentVersions.id,
        contentItemId: spiritualContentVersions.contentItemId,
        language: spiritualContentVersions.language,
        allowEnglishFallback: spiritualContentVersions.allowEnglishFallback,
      })
      .from(spiritualContentVersions)
      .where(
        and(
          inArray(
            spiritualContentVersions.contentItemId,
            candidateItems.map((item) => item.id),
          ),
          eq(spiritualContentVersions.status, 'PUBLISHED'),
        ),
      )
    for (const item of candidateItems) {
      const versions = publishedVersions.filter(
        (version) => version.contentItemId === item.id,
      )
      const exact = versions.find(
        (version) => version.language === preferredLanguage,
      )
      if (exact) {
        resolved.push({
          itemId: item.id,
          contentType: item.contentType,
          scopeType: item.scopeType,
          sortOrder: item.sortOrder,
          versionId: exact.id,
          fallbackUsed: false,
        })
        continue
      }
      // Explicit fallback ONLY: yo-preferring user, no yo version, and
      // an English version that explicitly allows English fallback.
      // Never en → yo; never silent.
      if (preferredLanguage === 'yo') {
        const englishFallback = versions.find(
          (version) =>
            version.language === 'en' && version.allowEnglishFallback,
        )
        if (englishFallback) {
          resolved.push({
            itemId: item.id,
            contentType: item.contentType,
            scopeType: item.scopeType,
            sortOrder: item.sortOrder,
            versionId: englishFallback.id,
            fallbackUsed: true,
          })
        }
      }
    }
  }

  // Deterministic priority per content type: the most specific scope
  // with at least one assignable item wins; lower scopes of the same
  // type are excluded entirely. Different types may resolve to
  // different scopes simultaneously.
  const selections: Array<Resolved> = []
  const types = [...new Set(resolved.map((entry) => entry.contentType))]
  for (const contentType of types) {
    const ofType = resolved.filter((entry) => entry.contentType === contentType)
    for (const scope of SCOPE_PRIORITY) {
      const atScope = ofType.filter((entry) => entry.scopeType === scope)
      if (atScope.length > 0) {
        atScope.sort((a, b) => a.sortOrder - b.sortOrder || a.itemId - b.itemId)
        selections.push(...atScope)
        break
      }
    }
  }

  for (const selection of selections) {
    await tx.insert(appointmentGuidanceAssignments).values({
      appointmentId,
      contentItemId: selection.itemId,
      contentVersionId: selection.versionId,
      selectedScope: selection.scopeType,
      fallbackUsed: selection.fallbackUsed,
      sortOrderSnapshot: selection.sortOrder,
    })
  }
  const selectionResult: GuidanceSelectionResult =
    selections.length > 0 ? 'ASSIGNED' : 'NO_APPLICABLE_CONTENT'
  await tx.insert(appointmentGuidanceSets).values({
    appointmentId,
    preferredLanguageSnapshot: preferredLanguage,
    selectionResult,
    assignmentCount: selections.length,
  })
  return {
    selectionResult,
    assignmentCount: selections.length,
    contentVersionIds: selections.map((selection) => selection.versionId),
    alreadyExisted: false,
  }
}

// --- User display -----------------------------------------------------------

/** Stages visible for an appointment status (spec §7/§8). AFTER_
 * APPOINTMENT unlocks ONLY on COMPLETED — never on elapsed time,
 * never on NO_SHOW. Non-eligible statuses expose nothing (history
 * remains stored untouched). */
export function visibleStagesFor(
  status: AppointmentStatus,
): Array<VisibilityStage> {
  switch (status) {
    case 'CONFIRMED':
      return ['AFTER_CONFIRMATION', 'BEFORE_APPOINTMENT']
    case 'COMPLETED':
      return ['AFTER_CONFIRMATION', 'BEFORE_APPOINTMENT', 'AFTER_APPOINTMENT']
    default:
      return []
  }
}

export interface VisibleGuidance {
  /** 'NONE' = confirmed before Step 7 existed (no selection ran). */
  setState: 'PRESENT' | 'NONE'
  selectionResult: GuidanceSelectionResult | null
  items: Array<{
    contentVersionId: number
    contentType: string
    title: string
    body: string
    language: string
    versionNumber: number
    visibilityStage: VisibilityStage
    acknowledgementRequired: boolean
    acknowledgedAt: Date | null
    fallbackUsed: boolean
  }>
}

/**
 * The user-facing read: FROZEN assignments only — never a "current
 * version" lookup. Archived versions stay readable where status rules
 * permit; statuses outside CONFIRMED/COMPLETED expose nothing.
 */
export async function getVisibleGuidance(
  appointmentId: number,
  status: AppointmentStatus,
): Promise<VisibleGuidance> {
  const db = getDb()
  const set = (
    await db
      .select()
      .from(appointmentGuidanceSets)
      .where(eq(appointmentGuidanceSets.appointmentId, appointmentId))
      .limit(1)
  ).at(0)
  if (!set) return { setState: 'NONE', selectionResult: null, items: [] }
  const stages = visibleStagesFor(status)
  if (stages.length === 0) {
    return {
      setState: 'PRESENT',
      selectionResult: set.selectionResult,
      items: [],
    }
  }
  const rows = await db
    .select({
      contentVersionId: appointmentGuidanceAssignments.contentVersionId,
      fallbackUsed: appointmentGuidanceAssignments.fallbackUsed,
      sortOrderSnapshot: appointmentGuidanceAssignments.sortOrderSnapshot,
      contentType: spiritualContentItems.contentType,
      title: spiritualContentVersions.title,
      body: spiritualContentVersions.body,
      language: spiritualContentVersions.language,
      versionNumber: spiritualContentVersions.versionNumber,
      visibilityStage: spiritualContentVersions.visibilityStage,
      acknowledgementRequired: spiritualContentVersions.acknowledgementRequired,
      acknowledgedAt: appointmentGuidanceAcknowledgements.acknowledgedAt,
    })
    .from(appointmentGuidanceAssignments)
    .innerJoin(
      spiritualContentVersions,
      eq(
        appointmentGuidanceAssignments.contentVersionId,
        spiritualContentVersions.id,
      ),
    )
    .innerJoin(
      spiritualContentItems,
      eq(
        appointmentGuidanceAssignments.contentItemId,
        spiritualContentItems.id,
      ),
    )
    .leftJoin(
      appointmentGuidanceAcknowledgements,
      and(
        eq(
          appointmentGuidanceAcknowledgements.appointmentId,
          appointmentGuidanceAssignments.appointmentId,
        ),
        eq(
          appointmentGuidanceAcknowledgements.contentVersionId,
          appointmentGuidanceAssignments.contentVersionId,
        ),
      ),
    )
    .where(eq(appointmentGuidanceAssignments.appointmentId, appointmentId))
    .orderBy(
      asc(appointmentGuidanceAssignments.sortOrderSnapshot),
      asc(appointmentGuidanceAssignments.id),
    )
  return {
    setState: 'PRESENT',
    selectionResult: set.selectionResult,
    items: rows
      .filter((row) => stages.includes(row.visibilityStage))
      .map((row) => ({
        contentVersionId: row.contentVersionId,
        contentType: row.contentType,
        title: row.title,
        body: row.body,
        language: row.language,
        versionNumber: row.versionNumber,
        visibilityStage: row.visibilityStage,
        acknowledgementRequired: row.acknowledgementRequired,
        acknowledgedAt: row.acknowledgedAt,
        fallbackUsed: row.fallbackUsed,
      })),
  }
}

/**
 * "I have read this guidance" — nothing more. Idempotent per
 * (appointment, version); requires the version to be assigned to THIS
 * appointment and currently visible under the status/stage rules.
 * Never blocks completion or representative work; no un-acknowledge.
 */
export async function acknowledgeGuidance(
  ctx: RequestContext,
  appointment: { id: number; userId: number; status: AppointmentStatus },
  contentVersionId: number,
): Promise<{ acknowledged: boolean }> {
  const db = getDb()
  const assignment = (
    await db
      .select({
        contentVersionId: appointmentGuidanceAssignments.contentVersionId,
        visibilityStage: spiritualContentVersions.visibilityStage,
        acknowledgementRequired:
          spiritualContentVersions.acknowledgementRequired,
      })
      .from(appointmentGuidanceAssignments)
      .innerJoin(
        spiritualContentVersions,
        eq(
          appointmentGuidanceAssignments.contentVersionId,
          spiritualContentVersions.id,
        ),
      )
      .where(
        and(
          eq(appointmentGuidanceAssignments.appointmentId, appointment.id),
          eq(appointmentGuidanceAssignments.contentVersionId, contentVersionId),
        ),
      )
      .limit(1)
  ).at(0)
  if (!assignment) {
    throw new GuidanceError('This guidance is not assigned to the appointment.')
  }
  const stages = visibleStagesFor(appointment.status)
  if (!stages.includes(assignment.visibilityStage)) {
    throw new GuidanceError('This guidance is not currently available.')
  }
  try {
    await db.insert(appointmentGuidanceAcknowledgements).values({
      appointmentId: appointment.id,
      contentVersionId,
    })
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Idempotent: already acknowledged.
      return { acknowledged: true }
    }
    throw error
  }
  await recordAuditEvent({
    actorUserId: appointment.userId,
    action: 'appointment.guidance_acknowledged',
    entityType: 'appointment',
    entityId: String(appointment.id),
    metadata: { contentVersionId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
  return { acknowledged: true }
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

// --- Admin operational view -------------------------------------------------

/** Operational inspection of one appointment's frozen guidance set
 * (titles/type/language/version/stage/ack state — no unrelated
 * spiritual profile data). Caller enforces admin permissions. */
export async function getAppointmentGuidanceAdmin(appointmentId: number) {
  const db = getDb()
  const set = (
    await db
      .select()
      .from(appointmentGuidanceSets)
      .where(eq(appointmentGuidanceSets.appointmentId, appointmentId))
      .limit(1)
  ).at(0)
  if (!set) return null
  const assignments = await db
    .select({
      contentVersionId: appointmentGuidanceAssignments.contentVersionId,
      selectedScope: appointmentGuidanceAssignments.selectedScope,
      fallbackUsed: appointmentGuidanceAssignments.fallbackUsed,
      code: spiritualContentItems.code,
      contentType: spiritualContentItems.contentType,
      title: spiritualContentVersions.title,
      language: spiritualContentVersions.language,
      versionNumber: spiritualContentVersions.versionNumber,
      visibilityStage: spiritualContentVersions.visibilityStage,
      acknowledgementRequired: spiritualContentVersions.acknowledgementRequired,
      acknowledgedAt: appointmentGuidanceAcknowledgements.acknowledgedAt,
    })
    .from(appointmentGuidanceAssignments)
    .innerJoin(
      spiritualContentVersions,
      eq(
        appointmentGuidanceAssignments.contentVersionId,
        spiritualContentVersions.id,
      ),
    )
    .innerJoin(
      spiritualContentItems,
      eq(
        appointmentGuidanceAssignments.contentItemId,
        spiritualContentItems.id,
      ),
    )
    .leftJoin(
      appointmentGuidanceAcknowledgements,
      and(
        eq(
          appointmentGuidanceAcknowledgements.appointmentId,
          appointmentGuidanceAssignments.appointmentId,
        ),
        eq(
          appointmentGuidanceAcknowledgements.contentVersionId,
          appointmentGuidanceAssignments.contentVersionId,
        ),
      ),
    )
    .where(eq(appointmentGuidanceAssignments.appointmentId, appointmentId))
    .orderBy(
      asc(appointmentGuidanceAssignments.sortOrderSnapshot),
      asc(appointmentGuidanceAssignments.id),
    )
  return { set, assignments }
}
