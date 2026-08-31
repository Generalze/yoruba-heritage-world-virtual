import { and, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  VISUAL_BIBLE_REFERENCE_ROLES,
  mediaAssetVersions,
  mediaAssets,
  visualBibleReferenceMedia,
  visualBibleVersions,
  visualBibles,
} from '@/db/schema'
import { MediaError, isMediaAssetRuntimeEligible } from './media-assets'
import { recordAuditEvent } from '@/auth/audit'
import { requirePermission } from '@/auth/guards'
import type { RequestContext } from '@/auth/service'
import type { VisualBibleReferenceRole } from '@/db/schema/media'

/**
 * Approved reference imagery for Visual Bible versions (Step 24,
 * provider-neutral foundation).
 *
 * WHAT THIS MODULE IS FOR. A Visual Bible governs how a Sacred House
 * may be depicted. Written rules do that in words; a bound reference
 * image does it by example. Binding one is therefore an approval
 * decision, not a convenience, and this module exists to make that
 * decision provable rather than incidental.
 *
 * THREE RULES GOVERN EVERYTHING HERE:
 *
 *  1. BINDING IS DRAFT-ONLY. Once a version is submitted its references
 *     are exactly as immutable as its rules. A reference added after
 *     approval would alter the thing that was approved.
 *  2. EXACT VERSION, EXACT BYTES. A reference names one media asset
 *     VERSION and freezes that version's file hash at bind time. An
 *     edited image is a new version and cannot leak into an approved
 *     Bible.
 *  3. GENERIC MEDIA ELIGIBILITY IS NECESSARY BUT NOT SUFFICIENT. The
 *     shared formula proves publication, rights, consent, runtime
 *     enablement and byte integrity, but knows nothing about Sacred
 *     House scope or external-AI policy. Reference use adds both.
 *
 * NOTHING HERE CALLS A PROVIDER, reads image bytes, or decides how a
 * reference is transported to a vendor. It establishes WHICH image is
 * authorised; transport is a provider-bound question deliberately left
 * unanswered until the official contract is verified.
 */

/** Why a bound reference is not usable. Machine codes only — never a
 * path, a storage key or anything about the image itself. */
export type ReferenceIneligibilityCode =
  | 'media_not_runtime_eligible'
  | 'not_an_image'
  | 'scope_not_sacred_house'
  | 'sacred_house_mismatch'
  | 'external_ai_policy_forbids_derivative'
  | 'bound_hash_mismatch'
  | 'media_version_missing'

export interface ReferenceEligibility {
  eligible: boolean
  failures: Array<ReferenceIneligibilityCode | string>
}

/**
 * Is this bound reference usable for image-driven generation RIGHT NOW?
 *
 * Runs the shared media formula first, then the checks that are
 * specific to using an image as generative reference for one House.
 * Computed per call and never cached: a rights withdrawal, a runtime
 * disablement or a policy downgrade removes eligibility immediately.
 */
export async function isVisualBibleReferenceEligible(input: {
  mediaAssetVersionId: number
  /** The House the Visual Bible belongs to. */
  sacredHouseId: number
  /** The hash frozen when the reference was bound, when there is one. */
  boundFileSha256: string | null
}): Promise<ReferenceEligibility> {
  const row = (
    await getDb()
      .select({
        assetActive: mediaAssets.active,
        assetKind: mediaAssets.assetKind,
        scopeType: mediaAssets.scopeType,
        assetHouseId: mediaAssets.sacredHouseId,
        status: mediaAssetVersions.status,
        rightsStatus: mediaAssetVersions.rightsStatus,
        runtimeEnabled: mediaAssetVersions.runtimeEnabled,
        mimeType: mediaAssetVersions.mimeType,
        storageKey: mediaAssetVersions.storageKey,
        fileSha256: mediaAssetVersions.fileSha256,
        containsIdentifiablePerson:
          mediaAssetVersions.containsIdentifiablePerson,
        consentStatus: mediaAssetVersions.consentStatus,
        externalAiPolicy: mediaAssetVersions.externalAiPolicy,
      })
      .from(mediaAssetVersions)
      .innerJoin(mediaAssets, eq(mediaAssets.id, mediaAssetVersions.assetId))
      .where(eq(mediaAssetVersions.id, input.mediaAssetVersionId))
      .limit(1)
  ).at(0)

  if (!row) return { eligible: false, failures: ['media_version_missing'] }

  const failures: Array<string> = []

  // The shared formula: publication, rights, consent, runtime, mime,
  // storage presence and a fresh byte-hash comparison.
  const generic = await isMediaAssetRuntimeEligible({
    asset: { active: row.assetActive, assetKind: row.assetKind },
    version: {
      status: row.status,
      rightsStatus: row.rightsStatus,
      runtimeEnabled: row.runtimeEnabled,
      mimeType: row.mimeType,
      storageKey: row.storageKey,
      fileSha256: row.fileSha256,
      containsIdentifiablePerson: row.containsIdentifiablePerson,
      consentStatus: row.consentStatus,
    },
  })
  if (!generic.eligible) failures.push(...generic.failures)

  // A video or an audio clip is not a first frame.
  if (row.assetKind !== 'IMAGE') failures.push('not_an_image')

  // House scope: this is what stops Ọ̀ṣun river imagery reaching the
  // Babaláwo room (rule 71). A PLATFORM-scoped image is deliberately
  // NOT acceptable — a room reference belongs to exactly one House.
  if (row.scopeType !== 'SACRED_HOUSE') failures.push('scope_not_sacred_house')
  else if (row.assetHouseId !== input.sacredHouseId) {
    failures.push('sacred_house_mismatch')
  }

  // Image-to-video DERIVES a video from the image; it does not merely
  // let an operator look at it. REFERENCE_ONLY is therefore not
  // sufficient authority for a paid generative call.
  if (row.externalAiPolicy !== 'DERIVATIVE_GENERATION_ALLOWED') {
    failures.push('external_ai_policy_forbids_derivative')
  }

  // Independent of the shared formula's own integrity check: the bytes
  // must still be the bytes that were approved.
  if (
    input.boundFileSha256 !== null &&
    input.boundFileSha256 !== row.fileSha256
  ) {
    failures.push('bound_hash_mismatch')
  }

  return { eligible: failures.length === 0, failures }
}

/** The Visual Bible version plus the House it governs. */
async function loadVersionContext(versionId: number) {
  const row = (
    await getDb()
      .select({
        versionId: visualBibleVersions.id,
        status: visualBibleVersions.status,
        referenceMode: visualBibleVersions.referenceMode,
        visualBibleId: visualBibleVersions.visualBibleId,
        sacredHouseId: visualBibles.sacredHouseId,
      })
      .from(visualBibleVersions)
      .innerJoin(
        visualBibles,
        eq(visualBibles.id, visualBibleVersions.visualBibleId),
      )
      .where(eq(visualBibleVersions.id, versionId))
      .limit(1)
  ).at(0)
  if (!row) throw new MediaError('Visual Bible version not found.')
  return row
}

export interface BoundReference {
  role: VisualBibleReferenceRole
  mediaAssetVersionId: number
  mediaFileSha256: string
}

/** Bound references in canonical role order — the order the definition
 * hash uses, so it never depends on insertion sequence. */
export async function listVisualBibleReferences(
  versionId: number,
): Promise<Array<BoundReference>> {
  const rows = await getDb()
    .select({
      role: visualBibleReferenceMedia.role,
      mediaAssetVersionId: visualBibleReferenceMedia.mediaAssetVersionId,
      mediaFileSha256: visualBibleReferenceMedia.mediaFileSha256,
    })
    .from(visualBibleReferenceMedia)
    .where(eq(visualBibleReferenceMedia.visualBibleVersionId, versionId))

  const byRole = new Map(rows.map((row) => [row.role, row]))
  return VISUAL_BIBLE_REFERENCE_ROLES.filter((role) => byRole.has(role)).map(
    (role) => byRole.get(role)!,
  )
}

/**
 * Binds one approved media version to one role on a DRAFT version.
 *
 * Refuses anything but DRAFT: after submission a reference is as fixed
 * as a rule. Eligibility is proved here so an unusable image cannot sit
 * in a draft waiting to fail at publication.
 */
export async function bindVisualBibleReference(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  role: VisualBibleReferenceRole,
  mediaAssetVersionId: number,
): Promise<void> {
  await requirePermission(actorId, 'media.manage')
  const version = await loadVersionContext(versionId)
  if (version.status !== 'DRAFT') {
    throw new MediaError(
      'References can only be bound while the Visual Bible version is a draft.',
    )
  }

  const eligibility = await isVisualBibleReferenceEligible({
    mediaAssetVersionId,
    sacredHouseId: version.sacredHouseId,
    // Nothing is frozen yet; this call establishes what will be.
    boundFileSha256: null,
  })
  if (!eligibility.eligible) {
    throw new MediaError(
      `This media version cannot be used as a Visual Bible reference (${eligibility.failures.join(', ')}).`,
    )
  }

  const media = (
    await getDb()
      .select({ fileSha256: mediaAssetVersions.fileSha256 })
      .from(mediaAssetVersions)
      .where(eq(mediaAssetVersions.id, mediaAssetVersionId))
      .limit(1)
  ).at(0)
  if (!media) throw new MediaError('Media version not found.')

  await getDb()
    .delete(visualBibleReferenceMedia)
    .where(
      and(
        eq(visualBibleReferenceMedia.visualBibleVersionId, versionId),
        eq(visualBibleReferenceMedia.role, role),
      ),
    )
  await getDb().insert(visualBibleReferenceMedia).values({
    visualBibleVersionId: versionId,
    mediaAssetVersionId,
    role,
    mediaFileSha256: media.fileSha256,
    boundBy: actorId,
  })

  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.reference_bound',
    entityType: 'visual_bible_version',
    entityId: String(versionId),
    // Identifiers only — never a storage key or anything about content.
    metadata: { role, mediaAssetVersionId },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

export async function unbindVisualBibleReference(
  actorId: number,
  ctx: RequestContext,
  versionId: number,
  role: VisualBibleReferenceRole,
): Promise<void> {
  await requirePermission(actorId, 'media.manage')
  const version = await loadVersionContext(versionId)
  if (version.status !== 'DRAFT') {
    throw new MediaError(
      'References can only be unbound while the Visual Bible version is a draft.',
    )
  }
  await getDb()
    .delete(visualBibleReferenceMedia)
    .where(
      and(
        eq(visualBibleReferenceMedia.visualBibleVersionId, versionId),
        eq(visualBibleReferenceMedia.role, role),
      ),
    )
  await recordAuditEvent({
    actorUserId: actorId,
    action: 'visual_bible.reference_unbound',
    entityType: 'visual_bible_version',
    entityId: String(versionId),
    metadata: { role },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  })
}

/**
 * Every gate past DRAFT calls this: submission, approval, publication.
 *
 * For IMAGE_REFERENCE_REQUIRED the complete canonical six-role pack
 * must be present AND every member currently eligible. Validating only
 * "the references that happen to exist" would let a version advance
 * with none at all, which is exactly the hole this closes.
 *
 * TEXT_ONLY versions still validate whatever they have bound: a bound
 * reference is an approval statement even when it is not mandatory.
 */
export async function assertReferencePackUsable(
  versionId: number,
): Promise<void> {
  const version = await loadVersionContext(versionId)
  const bound = await listVisualBibleReferences(versionId)

  if (version.referenceMode === 'IMAGE_REFERENCE_REQUIRED') {
    const present = new Set(bound.map((reference) => reference.role))
    const missing = VISUAL_BIBLE_REFERENCE_ROLES.filter(
      (role) => !present.has(role),
    )
    if (missing.length > 0) {
      throw new MediaError(
        `This Visual Bible requires the complete reference pack; missing: ${missing.join(', ')}.`,
      )
    }
  }

  for (const reference of bound) {
    const eligibility = await isVisualBibleReferenceEligible({
      mediaAssetVersionId: reference.mediaAssetVersionId,
      sacredHouseId: version.sacredHouseId,
      boundFileSha256: reference.mediaFileSha256,
    })
    if (!eligibility.eligible) {
      throw new MediaError(
        `The ${reference.role} reference is not usable (${eligibility.failures.join(', ')}).`,
      )
    }
  }
}
