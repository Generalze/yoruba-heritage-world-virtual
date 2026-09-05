import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  SHOT_ROLES,
  SLOT_SHOT_FAMILIES,
  prayerSessionTemplateSlots,
  VISUAL_BIBLE_REFERENCE_ROLES,
  VISUAL_BIBLE_RULE_CATEGORIES,
  auditLogs,
  mediaAssetVersions,
  mediaAssets,
  sacredContentVersionProfiles,
  prayerSessionTemplateVersions,
  sacredHouses,
  spiritualContentItems,
  spiritualContentVersions,
  users,
  visualBibleReferenceMedia,
  visualBibleRules,
  visualBibleVersions,
  visualBibles,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import {
  assertStoredShotAuthority,
  createPrayerTemplate,
  createTemplateVersion,
} from '@/services/prayer-templates'
import {
  approveVersion,
  publishVersion,
  submitVersionForReview,
} from '@/services/spiritual-content'
import {
  createSacredContentItem,
  createSacredVersion,
  setSacredRightsStatus,
  setSacredRuntimeEnabled,
} from '@/services/sacred-content'
import { assignRoleToUser } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import {
  LocalMediaStorageProvider,
  resetMediaStorageForTests,
  setMediaStorageForTests,
} from '@/providers/media/storage'
import {
  createMediaAsset,
  createMediaVersion,
  approveMediaVersion,
  publishMediaVersion,
  setMediaRightsStatus,
  setMediaRuntimeEnabled,
  submitMediaVersion,
} from '@/services/media-assets'
import { compileVisualGenerationRequest } from '@/services/visual-generation'
import {
  approveVisualBibleVersion,
  computeVisualBibleSha256,
  createVisualBible,
  createVisualBibleVersion,
  loadPublishedVisualBible,
  publishVisualBibleVersion,
  submitVisualBibleVersion,
} from '@/services/visual-bibles'
import {
  assertReferenceSnapshotUnchanged,
  bindVisualBibleReference,
  captureUsableReferenceSnapshot,
  isVisualBibleReferenceEligible,
  listVisualBibleReferences,
  setVisualBibleReferenceMode,
  unbindVisualBibleReference,
} from '@/services/visual-bible-references'

/**
 * Visual Bible reference media (Step 24 foundation).
 *
 * The lines these tests hold: a reference is bound only while DRAFT, is
 * scoped to its own Sacred House, requires DERIVATIVE_GENERATION_ALLOWED
 * because image-to-video creates a derivative, enters the canonical
 * definition hash so imagery cannot change silently, and is re-proved
 * at every lifecycle gate.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = 'Reference-fixture-passphrase-2026'
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
])

const createdUserIds: Array<number> = []
const createdHouseIds: Array<number> = []
const createdBibleIds: Array<number> = []
const createdAssetIds: Array<number> = []
const createdSacredItemIds: Array<number> = []
const createdTemplateIds: Array<number> = []

let adminId = 0
let houseId = 0
let otherHouseId = 0
let storageRoot = ''
let key = ''

async function makeAdmin(): Promise<number> {
  const result = await registerUser(
    {
      email: `s24-${crypto.randomUUID()}@test.local`,
      preferredName: 'S24 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error('fixture user failed')
  createdUserIds.push(result.user.id)
  await assignRoleToUser(result.user.id, 'ADMIN')
  return result.user.id
}

async function makeHouse(suffix: string): Promise<number> {
  const inserted = await getDb()
    .insert(sacredHouses)
    .values({
      code: `S24H_${key}_${suffix}`.toUpperCase().slice(0, 50),
      name: `S24 House ${key} ${suffix}`,
      slug: `s24h-${key}-${suffix}`,
      status: 'PUBLISHED',
    })
  const id = inserted[0].insertId
  createdHouseIds.push(id)
  return id
}

/** A fully published, cleared, runtime-enabled IMAGE for one House. */
async function makeImage(
  suffix: string,
  options: {
    house: number
    externalAiPolicy?:
      'NO_EXTERNAL_AI' | 'REFERENCE_ONLY' | 'DERIVATIVE_GENERATION_ALLOWED'
    assetKind?: 'IMAGE' | 'AUDIO'
    mimeType?: string
    scopePlatform?: boolean
  },
): Promise<{ assetId: number; versionId: number; fileSha256: string }> {
  const asset = await createMediaAsset(adminId, ctx, {
    code: `S24A_${key}_${suffix}`
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 60),
    assetKind: options.assetKind ?? 'IMAGE',
    scopeType: options.scopePlatform ? 'PLATFORM' : 'SACRED_HOUSE',
    sacredHouseId: options.scopePlatform ? null : options.house,
    serviceId: null,
    contentType: null,
    themeCode: null,
  })
  createdAssetIds.push(asset.id)
  const version = await createMediaVersion(
    adminId,
    ctx,
    asset.id,
    PNG,
    options.mimeType ?? 'image/png',
    {
      sourceType: 'AI_GENERATED',
      language: null,
      durationSeconds: null,
      width: null,
      height: null,
      externalAiPolicy:
        options.externalAiPolicy ?? 'DERIVATIVE_GENERATION_ALLOWED',
      containsIdentifiablePerson: false,
      consentStatus: 'NOT_APPLICABLE',
      consentReference: null,
      voiceCloneAuthorized: false,
    },
  )
  // The real workflow order: rights may only be cleared once the
  // version is immutable (approved), and clearance is a reviewed
  // transition rather than a jump.
  await submitMediaVersion(adminId, ctx, version.id)
  await approveMediaVersion(adminId, ctx, version.id)
  await setMediaRightsStatus(
    adminId,
    ctx,
    version.id,
    'PENDING_REVIEW',
    'fixture',
  )
  await setMediaRightsStatus(adminId, ctx, version.id, 'CLEARED', 'fixture')
  await publishMediaVersion(adminId, ctx, version.id)
  await setMediaRuntimeEnabled(adminId, ctx, version.id, true)
  return {
    assetId: asset.id,
    versionId: version.id,
    fileSha256: version.fileSha256,
  }
}

let houseSeq = 0

async function makeBibleDraft(
  referenceMode: 'TEXT_ONLY' | 'IMAGE_REFERENCE_REQUIRED',
): Promise<{ bibleId: number; versionId: number; house: number }> {
  // One Visual Bible per Sacred House is a schema-level rule, so every
  // fixture Bible gets its own House.
  const house = await makeHouse(`b${(houseSeq += 1)}`)
  const bible = await createVisualBible(adminId, ctx, house)
  createdBibleIds.push(bible.id)
  const version = await createVisualBibleVersion(adminId, ctx, bible.id, {
    rules: [
      { category: 'ENVIRONMENT', position: 1, ruleText: 'A quiet room.' },
    ],
  })
  if (referenceMode !== 'TEXT_ONLY') {
    // Through the governed service, never a direct UPDATE.
    await setVisualBibleReferenceMode(adminId, ctx, version.id, referenceMode)
  }
  return { bibleId: bible.id, versionId: version.id, house }
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-s24-'))
  setMediaStorageForTests(new LocalMediaStorageProvider(storageRoot))
  key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  adminId = await makeAdmin()
  houseId = await makeHouse('a')
  otherHouseId = await makeHouse('b')
}, 180_000)

afterAll(async () => {
  const db = getDb()
  if (createdBibleIds.length) {
    const versionIds = (
      await db
        .select({ id: visualBibleVersions.id })
        .from(visualBibleVersions)
        .where(inArray(visualBibleVersions.visualBibleId, createdBibleIds))
    ).map((r) => r.id)
    if (versionIds.length) {
      await db
        .delete(visualBibleReferenceMedia)
        .where(
          inArray(visualBibleReferenceMedia.visualBibleVersionId, versionIds),
        )
      await db
        .delete(visualBibleRules)
        .where(inArray(visualBibleRules.bibleVersionId, versionIds))
      await db
        .delete(visualBibleVersions)
        .where(inArray(visualBibleVersions.id, versionIds))
    }
    await db
      .delete(visualBibles)
      .where(inArray(visualBibles.id, createdBibleIds))
  }
  if (createdSacredItemIds.length) {
    const versionIds = (
      await db
        .select({ id: spiritualContentVersions.id })
        .from(spiritualContentVersions)
        .where(
          inArray(spiritualContentVersions.contentItemId, createdSacredItemIds),
        )
    ).map((r) => r.id)
    if (versionIds.length) {
      await db
        .delete(sacredContentVersionProfiles)
        .where(
          inArray(sacredContentVersionProfiles.contentVersionId, versionIds),
        )
      await db
        .delete(spiritualContentVersions)
        .where(inArray(spiritualContentVersions.id, versionIds))
    }
    await db
      .delete(spiritualContentItems)
      .where(inArray(spiritualContentItems.id, createdSacredItemIds))
  }
  if (createdAssetIds.length) {
    await db
      .delete(mediaAssetVersions)
      .where(inArray(mediaAssetVersions.assetId, createdAssetIds))
    await db.delete(mediaAssets).where(inArray(mediaAssets.id, createdAssetIds))
  }
  if (createdHouseIds.length) {
    await db
      .delete(sacredHouses)
      .where(inArray(sacredHouses.id, createdHouseIds))
  }
  if (createdUserIds.length) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  resetMediaStorageForTests()
  rmSync(storageRoot, { recursive: true, force: true })
  await closeDb()
}, 180_000)

const ALL_ROLES = [
  'WIDE_MASTER',
  'MEDIUM_PRAYER',
  'DIRECT_CAMERA',
  'SIDE_PRAYER',
  'WORKING_DETAIL',
  'ENVIRONMENT_INSERT',
] as const

/** Binds the complete canonical pack so a version can legitimately
 * leave DRAFT. */
async function bindFullPack(
  versionId: number,
  house: number,
  tag: string,
): Promise<void> {
  for (const [index, role] of ALL_ROLES.entries()) {
    const image = await makeImage(`${tag}${index}`, { house })
    await bindVisualBibleReference(
      adminId,
      ctx,
      versionId,
      role,
      image.versionId,
    )
  }
}

let sacredSeq = 0

/**
 * A real published, rights-cleared, runtime-enabled SACRED_RUNTIME
 * version, plus the content hash the manifest would have frozen.
 *
 * The compile stage validates sacred-content authority BEFORE it looks
 * at imagery, so a reference tamper test needs genuinely valid content
 * underneath — otherwise it would pass for the wrong reason.
 */
async function makeSacredContent(): Promise<{
  contentVersionId: number
  contentSha256: string
}> {
  const suffix = (sacredSeq += 1)
  const item = await createSacredContentItem(adminId, ctx, {
    code: `S24SC_${key}_${suffix}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
    contentType: 'CHANT',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    sortOrder: 0,
  })
  createdSacredItemIds.push(item.id)
  const version = await createSacredVersion(
    adminId,
    ctx,
    item.id,
    {
      language: 'en',
      title: 'S24 reference fixture block',
      body: `S24 approved body ${crypto.randomUUID()}`,
    },
    {
      variantKind: 'ORIGINAL',
      provenanceType: 'ORIGINAL_AUTHORED',
      sourceCommunity: null,
      sourcePlace: null,
      sourceReference: null,
      publicAttributionText: null,
      internalProvenanceNote: null,
      digitalStorageAuthorized: true,
      themeCode: null,
      durationHintSeconds: 30,
      repeatable: false,
      voicePolicy: 'TEXT_ONLY',
      externalAiPolicy: 'METADATA_ONLY',
      accessPolicy: 'PRAYER_ROOM_PRIVATE',
    },
  )
  await submitVersionForReview(adminId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, version.id, true)

  const profile = (
    await getDb()
      .select({ contentSha256: sacredContentVersionProfiles.contentSha256 })
      .from(sacredContentVersionProfiles)
      .where(eq(sacredContentVersionProfiles.contentVersionId, version.id))
      .limit(1)
  ).at(0)!
  return {
    contentVersionId: version.id,
    contentSha256: profile.contentSha256!,
  }
}

let templateSeq = 0

/** A DRAFT template version with one coherently authored CONTENT slot. */
async function makeTemplateDraft(): Promise<number> {
  const suffix = (templateSeq += 1)
  const template = await createPrayerTemplate(adminId, ctx, {
    code: `S24T_${key}_${suffix}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
  })
  createdTemplateIds.push(template.id)
  const version = await createTemplateVersion(adminId, ctx, template.id, {
    language: 'en',
    priority: 100,
    selectionWeight: 1,
    targetMinSeconds: 60,
    targetMaxSeconds: 120,
    slots: [
      {
        slotKey: 'MAIN_PRAYER',
        position: 1,
        slotKind: 'CONTENT',
        minSelect: 1,
        maxSelect: 1,
        contentType: 'PRAYER',
        selectorMode: 'ELIGIBLE_FILTER',
        themeCode: null,
        variantKind: null,
        silenceDurationSeconds: null,
        shotFamily: 'MEDIUM_PRAYER',
        referenceRequirement: 'OPTIONAL',
        allowedScopes: ['PLATFORM'],
        pinnedContentVersionIds: [],
      },
    ],
    forbiddenPairs: [],
  })
  return version.id
}

/** Comments stripped, so prose ABOUT a rule cannot violate the rule. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** expect().rejects.toThrow(Class) hangs under bun test here. */
async function expectRejection(run: () => Promise<unknown>): Promise<Error> {
  let thrown: unknown = null
  try {
    await run()
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(Error)
  return thrown as Error
}

// ----------------------------------------------------------------------------

describe('binding is DRAFT-only', () => {
  it('binds while DRAFT and lists in canonical role order', async () => {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    const wide = await makeImage('order-w', { house })
    const insert = await makeImage('order-i', { house })
    // Bound out of canonical order on purpose.
    await bindVisualBibleReference(
      adminId,
      ctx,
      versionId,
      'ENVIRONMENT_INSERT',
      insert.versionId,
    )
    await bindVisualBibleReference(
      adminId,
      ctx,
      versionId,
      'WIDE_MASTER',
      wide.versionId,
    )
    const listed = await listVisualBibleReferences(versionId)
    expect(listed.map((r) => r.role)).toEqual([
      'WIDE_MASTER',
      'ENVIRONMENT_INSERT',
    ])
    expect(listed[0].mediaFileSha256).toBe(wide.fileSha256)
  }, 120_000)

  it('refuses to bind once the version leaves DRAFT', async () => {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    await bindFullPack(versionId, house, 'frozen')
    const spare = await makeImage('frozenspare', { house })
    await submitVisualBibleVersion(adminId, ctx, versionId)
    const error = await expectRejection(() =>
      bindVisualBibleReference(
        adminId,
        ctx,
        versionId,
        'WIDE_MASTER',
        spare.versionId,
      ),
    )
    expect(error.message).toContain('draft')
  }, 240_000)

  it('refuses to UNBIND once the version leaves DRAFT', async () => {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    await bindFullPack(versionId, house, 'unbind')
    await submitVisualBibleVersion(adminId, ctx, versionId)
    await expectRejection(() =>
      unbindVisualBibleReference(adminId, ctx, versionId, 'WIDE_MASTER'),
    )
    expect(await listVisualBibleReferences(versionId)).toHaveLength(6)
  }, 240_000)
})

describe('reference eligibility is stricter than generic media eligibility', () => {
  it('refuses a REFERENCE_ONLY policy — image-to-video makes a derivative', async () => {
    const image = await makeImage('refonly', {
      house: houseId,
      externalAiPolicy: 'REFERENCE_ONLY',
    })
    const result = await isVisualBibleReferenceEligible({
      mediaAssetVersionId: image.versionId,
      sacredHouseId: houseId,
      boundFileSha256: null,
    })
    expect(result.eligible).toBe(false)
    expect(result.failures).toContain('external_ai_policy_forbids_derivative')
  }, 120_000)

  it('refuses an image scoped to a DIFFERENT Sacred House', async () => {
    const image = await makeImage('otherhouse', { house: otherHouseId })
    const result = await isVisualBibleReferenceEligible({
      mediaAssetVersionId: image.versionId,
      sacredHouseId: houseId,
      boundFileSha256: null,
    })
    expect(result.eligible).toBe(false)
    expect(result.failures).toContain('sacred_house_mismatch')
  }, 120_000)

  it('refuses a PLATFORM-scoped image — a room reference belongs to one House', async () => {
    const image = await makeImage('platform', {
      house: houseId,
      scopePlatform: true,
    })
    const result = await isVisualBibleReferenceEligible({
      mediaAssetVersionId: image.versionId,
      sacredHouseId: houseId,
      boundFileSha256: null,
    })
    expect(result.eligible).toBe(false)
    expect(result.failures).toContain('scope_not_sacred_house')
  }, 120_000)

  it('refuses a bound reference whose file hash has changed', async () => {
    const image = await makeImage('hash', { house: houseId })
    const result = await isVisualBibleReferenceEligible({
      mediaAssetVersionId: image.versionId,
      sacredHouseId: houseId,
      boundFileSha256: 'f'.repeat(64),
    })
    expect(result.eligible).toBe(false)
    expect(result.failures).toContain('bound_hash_mismatch')
  }, 120_000)

  it('refuses a media version that does not exist', async () => {
    const result = await isVisualBibleReferenceEligible({
      mediaAssetVersionId: 2_000_000_000,
      sacredHouseId: houseId,
      boundFileSha256: null,
    })
    expect(result.eligible).toBe(false)
    expect(result.failures).toContain('media_version_missing')
  })

  it('refuses to bind an ineligible image at all', async () => {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    const image = await makeImage('bindrefuse', {
      house,
      externalAiPolicy: 'NO_EXTERNAL_AI',
    })
    await expectRejection(() =>
      bindVisualBibleReference(
        adminId,
        ctx,
        versionId,
        'WIDE_MASTER',
        image.versionId,
      ),
    )
    expect(await listVisualBibleReferences(versionId)).toHaveLength(0)
  }, 120_000)
})

describe('IMAGE_REFERENCE_REQUIRED demands the complete six-role pack', () => {
  it('blocks submission while any canonical role is missing', async () => {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    const image = await makeImage('partial', { house })
    await bindVisualBibleReference(
      adminId,
      ctx,
      versionId,
      'WIDE_MASTER',
      image.versionId,
    )
    const error = await expectRejection(() =>
      submitVisualBibleVersion(adminId, ctx, versionId),
    )
    expect(error.message).toContain('MEDIUM_PRAYER')
  }, 120_000)

  it('advances and publishes once all six roles are bound', async () => {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    const roles = [
      'WIDE_MASTER',
      'MEDIUM_PRAYER',
      'DIRECT_CAMERA',
      'SIDE_PRAYER',
      'WORKING_DETAIL',
      'ENVIRONMENT_INSERT',
    ] as const
    for (const [index, role] of roles.entries()) {
      const image = await makeImage(`pack${index}`, { house })
      await bindVisualBibleReference(
        adminId,
        ctx,
        versionId,
        role,
        image.versionId,
      )
    }
    await submitVisualBibleVersion(adminId, ctx, versionId)
    await approveVisualBibleVersion(adminId, ctx, versionId)
    const published = await publishVisualBibleVersion(adminId, ctx, versionId)
    expect(published.definitionSha256).toMatch(/^[0-9a-f]{64}$/)

    const loaded = await loadPublishedVisualBible(house)
    expect(loaded.status).toBe('OK')
    if (loaded.status === 'OK') {
      expect(loaded.referenceMode).toBe('IMAGE_REFERENCE_REQUIRED')
      expect(loaded.references).toHaveLength(6)
      // The runtime loader recomputes over rules AND references.
      expect(
        computeVisualBibleSha256({
          visualBibleId: loaded.visualBibleId,
          versionNumber: loaded.versionNumber,
          referenceMode: loaded.referenceMode,
          rules: loaded.rules,
          references: loaded.references,
        }),
      ).toBe(loaded.definitionSha256)
    }
  }, 240_000)
})

describe('references are part of what the hash protects', () => {
  it('a different bound reference produces a different definition hash', () => {
    const base = {
      visualBibleId: 1,
      versionNumber: 1,
      referenceMode: 'IMAGE_REFERENCE_REQUIRED',
      rules: [{ category: 'ENVIRONMENT', position: 1, ruleText: 'A room.' }],
    }
    const withA = computeVisualBibleSha256({
      ...base,
      references: [
        {
          role: 'WIDE_MASTER',
          mediaAssetVersionId: 1,
          mediaFileSha256: 'a'.repeat(64),
        },
      ],
    })
    const withB = computeVisualBibleSha256({
      ...base,
      references: [
        {
          role: 'WIDE_MASTER',
          mediaAssetVersionId: 2,
          mediaFileSha256: 'a'.repeat(64),
        },
      ],
    })
    const withChangedBytes = computeVisualBibleSha256({
      ...base,
      references: [
        {
          role: 'WIDE_MASTER',
          mediaAssetVersionId: 1,
          mediaFileSha256: 'b'.repeat(64),
        },
      ],
    })
    expect(withA).not.toBe(withB)
    expect(withA).not.toBe(withChangedBytes)
  })

  it('reference MODE alone changes the hash', () => {
    const base = {
      visualBibleId: 1,
      versionNumber: 1,
      rules: [{ category: 'ENVIRONMENT', position: 1, ruleText: 'A room.' }],
      references: [],
    }
    expect(
      computeVisualBibleSha256({ ...base, referenceMode: 'TEXT_ONLY' }),
    ).not.toBe(
      computeVisualBibleSha256({
        ...base,
        referenceMode: 'IMAGE_REFERENCE_REQUIRED',
      }),
    )
  })
})

describe('the text-to-video adapter never silently drops a reference', () => {
  it('refuses a reference-bearing request before any network contact', async () => {
    const { createKlingVisualGenerationProvider } =
      await import('@/providers/visual-generation/kling')
    const provider = createKlingVisualGenerationProvider(
      {
        apiKey: 'k'.repeat(32),
        baseUrl: 'https://api.example.test',
        artifactOrigins: ['https://cdn.example.test'],
      },
      {
        requestJson: async () => {
          throw new Error('the adapter must not reach the network')
        },
        downloadArtifact: async () => {
          throw new Error('the adapter must not reach the network')
        },
      },
      async () => ({ ok: false, reasonCode: 'not_probed' }),
    )
    const refusal = provider.validateRequest?.({
      idempotencyKey: 'k'.repeat(64),
      sceneId: 's1',
      taskId: 't1',
      durationMs: 5000,
      contentType: 'PRAYER',
      themeCode: null,
      visualBibleVersionId: 1,
      visualBibleVersionNumber: 1,
      visualBibleRules: [
        { category: 'ENVIRONMENT', position: 1, ruleText: 'A room.' },
      ],
      externalAiPolicy: 'METADATA_ONLY',
      approvedTextContext: null,
      visualReference: {
        role: 'WIDE_MASTER',
        mediaAssetVersionId: 1,
        mediaFileSha256: 'a'.repeat(64),
      },
    })
    expect(refusal).toEqual({
      ok: false,
      reasonCode: 'reference_input_unsupported',
    })
  })
})

describe('the two role domains cannot diverge', () => {
  it('template shot families and Bible reference roles are ONE authority', () => {
    // Not "have equal values" — the same array object. Two independent
    // declarations could drift; this proves they cannot.
    expect(SLOT_SHOT_FAMILIES).toBe(SHOT_ROLES)
    expect(VISUAL_BIBLE_REFERENCE_ROLES).toBe(SHOT_ROLES)
    expect([...SHOT_ROLES]).toEqual([
      'WIDE_MASTER',
      'MEDIUM_PRAYER',
      'DIRECT_CAMERA',
      'SIDE_PRAYER',
      'WORKING_DETAIL',
      'ENVIRONMENT_INSERT',
    ])
  })

  it('no consumer redeclares the list — schema, services or admin UI', () => {
    const media = readFileSync(
      join(process.cwd(), 'src/db/schema/media.ts'),
      'utf8',
    )
    const templates = readFileSync(
      join(process.cwd(), 'src/db/schema/prayer-templates.ts'),
      'utf8',
    )
    // A literal array assigned to either name would be a second
    // authority; both must alias the shared one.
    expect(media).toContain('VISUAL_BIBLE_REFERENCE_ROLES = SHOT_ROLES')
    expect(templates).toContain('SLOT_SHOT_FAMILIES = SHOT_ROLES')
    expect(media).not.toMatch(/VISUAL_BIBLE_REFERENCE_ROLES = \[/)
    expect(templates).not.toMatch(/SLOT_SHOT_FAMILIES = \[/)

    // Every other consumer — services, admin authoring, admin review —
    // must IMPORT the vocabulary, never restate it. A second six-role
    // literal anywhere is how the two domains would drift apart again.
    for (const file of [
      'src/routes/admin.visual-bibles.$id.tsx',
      'src/routes/admin.prayer-templates.$id.tsx',
      'src/services/visual-bible-references.ts',
      'src/services/prayer-templates.ts',
      'src/services/generation-storyboards.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      // No local array literal containing the canonical first role.
      expect(source).not.toMatch(/=\s*\[[^\]]*'WIDE_MASTER'/)
    }
  })
})

describe('reference mode is a governed, DRAFT-only decision', () => {
  it('refuses to bind imagery while the version is TEXT_ONLY', async () => {
    const { versionId, house } = await makeBibleDraft('TEXT_ONLY')
    const image = await makeImage('textonlybind', { house })
    const error = await expectRejection(() =>
      bindVisualBibleReference(
        adminId,
        ctx,
        versionId,
        'WIDE_MASTER',
        image.versionId,
      ),
    )
    expect(error.message).toContain('TEXT_ONLY')
    expect(await listVisualBibleReferences(versionId)).toHaveLength(0)
  }, 120_000)

  it('refuses to switch back to TEXT_ONLY while bindings remain', async () => {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    const image = await makeImage('switchback', { house })
    await bindVisualBibleReference(
      adminId,
      ctx,
      versionId,
      'WIDE_MASTER',
      image.versionId,
    )
    const error = await expectRejection(() =>
      setVisualBibleReferenceMode(adminId, ctx, versionId, 'TEXT_ONLY'),
    )
    expect(error.message).toContain('Unbind')
    // Explicit unbind, then the switch is permitted.
    await unbindVisualBibleReference(adminId, ctx, versionId, 'WIDE_MASTER')
    await setVisualBibleReferenceMode(adminId, ctx, versionId, 'TEXT_ONLY')
  }, 180_000)

  it('refuses a mode change once the version leaves DRAFT', async () => {
    const { versionId } = await makeBibleDraft('TEXT_ONLY')
    await submitVisualBibleVersion(adminId, ctx, versionId)
    const error = await expectRejection(() =>
      setVisualBibleReferenceMode(
        adminId,
        ctx,
        versionId,
        'IMAGE_REFERENCE_REQUIRED',
      ),
    )
    expect(error.message).toContain('draft')
  }, 120_000)

  it('a TEXT_ONLY version carrying bindings can never advance', async () => {
    // Bindings written around the service (the tamper case) must not be
    // able to ride through submission on a TEXT_ONLY version.
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    const image = await makeImage('incoherent', { house })
    await bindVisualBibleReference(
      adminId,
      ctx,
      versionId,
      'WIDE_MASTER',
      image.versionId,
    )
    await getDb()
      .update(visualBibleVersions)
      .set({ referenceMode: 'TEXT_ONLY' })
      .where(eq(visualBibleVersions.id, versionId))
    const error = await expectRejection(() =>
      submitVisualBibleVersion(adminId, ctx, versionId),
    )
    expect(error.message).toContain('TEXT_ONLY')
  }, 180_000)
})

describe('the DRAFT freeze is atomic, not a pre-read', () => {
  it('a bind racing a submission cannot land after UNDER_REVIEW', async () => {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    await bindFullPack(versionId, house, 'race')
    const spare = await makeImage('racespare', { house })

    // Fired together: whichever orders second must observe the other's
    // committed effect, because both take the same Bible lock.
    const results = await Promise.allSettled([
      submitVisualBibleVersion(adminId, ctx, versionId),
      bindVisualBibleReference(
        adminId,
        ctx,
        versionId,
        'WIDE_MASTER',
        spare.versionId,
      ),
    ])

    const status = (
      await getDb()
        .select({ status: visualBibleVersions.status })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, versionId))
        .limit(1)
    ).at(0)!
    const bindOutcome = results[1]

    if (status.status === 'UNDER_REVIEW') {
      // If the submission won, the bind must NOT have committed a
      // change to a non-draft version.
      if (bindOutcome.status === 'fulfilled') {
        const bound = await listVisualBibleReferences(versionId)
        const wide = bound.find((r) => r.role === 'WIDE_MASTER')!
        // It may only have won by ordering FIRST, in which case the
        // pack is still complete and coherent — never partial.
        expect(bound).toHaveLength(6)
        expect(wide).toBeDefined()
      }
    }
    // Whatever the interleaving, the version is never left mid-change.
    const finalPack = await listVisualBibleReferences(versionId)
    expect(finalPack).toHaveLength(6)
  }, 240_000)
})

describe('the migration only adds', () => {
  it('creates its own table and alters only its own columns', () => {
    const file = readdirSync(join(process.cwd(), 'migrations'))
      .filter((n) => n.endsWith('.sql') && n.startsWith('0018_'))
      .sort()
      .at(-1)!
    const sql = readFileSync(join(process.cwd(), 'migrations', file), 'utf8')
    expect(sql).not.toMatch(/DROP/)
    // Every ALTER adds a column to a table this step owns.
    const alters = sql.match(/ALTER TABLE `([a-z_]+)` ADD/g) ?? []
    for (const alter of alters) {
      expect(alter).toMatch(
        /visual_bible_reference_media|visual_bible_versions|prayer_session_template_slots/,
      )
    }
    expect(sql).toContain('CREATE TABLE `visual_bible_reference_media`')
  })
})

describe('the text-to-video adapter refuses references at BOTH gates', () => {
  /** Counts every HTTP attempt the adapter could make. */
  function countingClient() {
    const calls: Array<string> = []
    return {
      calls,
      client: {
        requestJson: async () => {
          calls.push('requestJson')
          throw new Error('the adapter must not reach the network')
        },
        downloadArtifact: async () => {
          calls.push('downloadArtifact')
          throw new Error('the adapter must not reach the network')
        },
      },
    }
  }

  function referenceRequest() {
    return {
      idempotencyKey: 'k'.repeat(64),
      sceneId: 's1',
      taskId: 't1',
      durationMs: 5000,
      contentType: 'PRAYER',
      themeCode: null,
      visualBibleVersionId: 1,
      visualBibleVersionNumber: 1,
      visualBibleRules: [
        { category: 'ENVIRONMENT', position: 1, ruleText: 'A room.' },
      ],
      externalAiPolicy: 'METADATA_ONLY' as const,
      approvedTextContext: null,
      visualReference: {
        role: 'WIDE_MASTER',
        mediaAssetVersionId: 1,
        mediaFileSha256: 'a'.repeat(64),
      },
    }
  }

  it('submitScene() refuses directly, with ZERO http requests', async () => {
    const { createKlingVisualGenerationProvider } =
      await import('@/providers/visual-generation/kling')
    const { calls, client } = countingClient()
    const provider = createKlingVisualGenerationProvider(
      {
        apiKey: 'k'.repeat(32),
        baseUrl: 'https://api.example.test',
        artifactOrigins: ['https://cdn.example.test'],
      },
      client,
      async () => ({ ok: false as const, reasonCode: 'not_probed' }),
    )

    // Called DIRECTLY — not behind validateRequest.
    let thrown: unknown = null
    try {
      await provider.submitScene(referenceRequest())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toContain('text-to-video only')
    // The whole point: refused before any socket was opened.
    expect(calls).toHaveLength(0)
  })

  it('validateRequest() also refuses, before submission is attempted', async () => {
    const { createKlingVisualGenerationProvider } =
      await import('@/providers/visual-generation/kling')
    const { calls, client } = countingClient()
    const provider = createKlingVisualGenerationProvider(
      {
        apiKey: 'k'.repeat(32),
        baseUrl: 'https://api.example.test',
        artifactOrigins: ['https://cdn.example.test'],
      },
      client,
      async () => ({ ok: false as const, reasonCode: 'not_probed' }),
    )
    expect(provider.validateRequest?.(referenceRequest())).toEqual({
      ok: false,
      reasonCode: 'reference_input_unsupported',
    })
    expect(calls).toHaveLength(0)
  })

  it('adds no image-to-video contract to the adapter', () => {
    // Comments stripped: prose ABOUT image-to-video (explaining why the
    // adapter refuses it) must not read as an implementation of it.
    const kling = readFileSync(
      join(process.cwd(), 'src/providers/visual-generation/kling.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    // The create path and its closed allowlist are untouched.
    expect(kling).toContain("KLING_CREATE_PATH = '/text-to-video/kling-3.0'")
    expect(kling).toContain("audio: 'off'")
    expect(kling).not.toMatch(
      /image-to-video|image_url|first_frame|start_frame|init_image/i,
    )
  })
})

describe('an unbind cannot slip past a submission', () => {
  it('refuses the submission if the pack changed after validation', async () => {
    // The precise race: assertReferencePackUsable() must read storage
    // and hash bytes, so it cannot hold a row lock. Whatever it proved
    // is therefore stale by the time the lock is taken — unless the
    // submission re-checks it under that lock, which is what the
    // snapshot comparison does.
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    await bindFullPack(versionId, house, 'unbindrace')

    const results = await Promise.allSettled([
      submitVisualBibleVersion(adminId, ctx, versionId),
      unbindVisualBibleReference(adminId, ctx, versionId, 'ENVIRONMENT_INSERT'),
    ])

    const version = (
      await getDb()
        .select({ status: visualBibleVersions.status })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, versionId))
        .limit(1)
    ).at(0)!
    const pack = await listVisualBibleReferences(versionId)

    // THE INVARIANT: an incomplete pack must never sit behind a version
    // that has left DRAFT. Either the submission won and the pack is
    // whole, or the unbind won and the version is still a draft.
    if (version.status !== 'DRAFT') {
      expect(pack).toHaveLength(6)
    } else {
      expect(results.some((r) => r.status === 'rejected')).toBe(true)
    }
  }, 300_000)

  it('a submission validated against a since-changed pack is rejected', async () => {
    // Deterministic form of the same thing: validate, mutate, then let
    // the submission try to freeze what it validated.
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    await bindFullPack(versionId, house, 'staleSnap')
    const snapshot = await captureUsableReferenceSnapshot(versionId)

    // The pack changes AFTER validation.
    const replacement = await makeImage('staleSnapNew', { house })
    await bindVisualBibleReference(
      adminId,
      ctx,
      versionId,
      'WIDE_MASTER',
      replacement.versionId,
    )

    const error = await expectRejection(() =>
      getDb().transaction(async (tx) =>
        assertReferenceSnapshotUnchanged(tx, versionId, snapshot),
      ),
    )
    expect(error.message).toContain('changed while this version was being')
  }, 300_000)
})

describe('validation operates on the captured pack, not a re-read', () => {
  /**
   * The narrow ordering bug this guards against.
   *
   * Validating and THEN re-reading returns a pack that was never
   * validated: an authorised DRAFT rebind landing in the gap would be
   * adopted silently, and the submission would freeze a definition
   * different from the one it reviewed. The under-lock comparison
   * cannot catch that — it faithfully compares against whatever it was
   * given, so the expectation itself has to be the validated thing.
   *
   * The gap is a scheduling window, so a timing test could pass on a
   * lucky run. These assertions are structural instead: they read the
   * service source and require the ordering to be impossible to invert.
   */
  const source = withoutComments(
    readFileSync(
      join(process.cwd(), 'src/services/visual-bible-references.ts'),
      'utf8',
    ),
  )

  /** Source text of one top-level function, brace-matched. */
  function bodyOf(name: string): string {
    const start = source.indexOf(`export async function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    let depth = 0
    for (let i = source.indexOf('{', start); i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) return source.slice(start, i + 1)
      }
    }
    throw new Error(`unterminated function ${name}`)
  }

  it('captures once, validates the captured values, returns that same object', () => {
    const body = bodyOf('captureUsableReferenceSnapshot')

    // Read the world exactly once each. A second read is the bug.
    expect(body.split('loadVersionContext(').length - 1).toBe(1)
    expect(body.split('listVisualBibleReferences(').length - 1).toBe(1)

    // Both reads must land in the snapshot, and the snapshot must be
    // built before anything is checked.
    const captured = body.indexOf('const snapshot: ReferenceSnapshot')
    expect(captured).toBeGreaterThan(-1)
    expect(captured).toBeLessThan(body.indexOf('assertSnapshotStructurallyCoherent'))
    expect(captured).toBeLessThan(body.indexOf('isVisualBibleReferenceEligible'))

    // Eligibility must iterate the captured set, not a fresh query.
    expect(body).toContain('for (const reference of snapshot.references)')

    // And the captured object is what comes back — not a re-read of it.
    const lines = body.trimEnd().split(/\r?\n/)
    expect(lines.at(-1)).toBe('}')
    expect(lines.at(-2)?.trim()).toBe('return snapshot')

    // The inverted order (validate, then capture) must not reappear.
    expect(body).not.toContain('assertReferencePackUsable(')
  })

  it('there is only ONE pack-validation implementation', () => {
    // assertReferencePackUsable exists for callers that do not need to
    // freeze the pack. If it grew its own checks, "usable" could come
    // to mean two different things on the two paths.
    const body = bodyOf('assertReferencePackUsable')
    expect(body).toContain('await captureUsableReferenceSnapshot(versionId)')
    expect(body).not.toContain('isVisualBibleReferenceEligible')
    expect(body).not.toContain('listVisualBibleReferences')
    expect(body).not.toContain('VISUAL_BIBLE_REFERENCE_ROLES')
  })

  it('submission freezes only what it captured', () => {
    // The captured snapshot must travel into the lock unchanged: no
    // re-capture inside the transaction, and the comparison must use
    // the value returned by the capture.
    const submit = withoutComments(
      readFileSync(join(process.cwd(), 'src/services/visual-bibles.ts'), 'utf8'),
    )
    const start = submit.indexOf('export async function submitVisualBibleVersion(')
    expect(start).toBeGreaterThan(-1)
    // Bounded by the next top-level declaration, so nothing from a
    // neighbouring function can satisfy these assertions.
    const region = submit.slice(
      start,
      submit.indexOf('export async function', start + 1),
    )
    const capture = region.indexOf('captureUsableReferenceSnapshot(versionId)')
    const lock = region.indexOf('lockBible(tx,')
    const compare = region.indexOf('assertReferenceSnapshotUnchanged(tx, versionId, validated)')
    const transition = region.indexOf("status: 'UNDER_REVIEW'")

    // capture -> lock -> compare -> transition, in that order.
    expect(capture).toBeGreaterThan(-1)
    expect(capture).toBeLessThan(lock)
    expect(lock).toBeLessThan(compare)
    expect(compare).toBeLessThan(transition)
    expect(region.split('captureUsableReferenceSnapshot(').length - 1).toBe(1)
  })

  it('returns exactly the bound pack, and that value satisfies the lock check', async () => {
    const { versionId, house } = await makeBibleDraft('IMAGE_REFERENCE_REQUIRED')
    await bindFullPack(versionId, house, 'capturedPack')
    const snapshot = await captureUsableReferenceSnapshot(versionId)

    expect(snapshot.referenceMode).toBe('IMAGE_REFERENCE_REQUIRED')
    expect(snapshot.references).toEqual(await listVisualBibleReferences(versionId))
    expect(snapshot.references).toHaveLength(6)
    expect(snapshot.references.map((r) => r.role)).toEqual([...ALL_ROLES])

    // Unchanged in between, so the captured value is by construction a
    // valid expectation for the under-lock comparison.
    await getDb().transaction(async (tx) =>
      assertReferenceSnapshotUnchanged(tx, versionId, snapshot),
    )
  }, 300_000)

  it('a TEXT_ONLY version captures its mode with an empty pack', async () => {
    const { versionId } = await makeBibleDraft('TEXT_ONLY')
    const snapshot = await captureUsableReferenceSnapshot(versionId)
    expect(snapshot).toEqual({ referenceMode: 'TEXT_ONLY', references: [] })
  }, 300_000)
})

describe('the compile stage re-proves the EXACT approved binding', () => {
  /**
   * A published IMAGE_REFERENCE_REQUIRED Bible plus a manifest task
   * pointing at its WIDE_MASTER binding. Every test below tampers with
   * exactly one field and proves the paid call is refused.
   */
  let packSeq = 0

  async function publishedPack() {
    const { versionId, house } = await makeBibleDraft(
      'IMAGE_REFERENCE_REQUIRED',
    )
    // Unique per call: asset codes are globally unique.
    await bindFullPack(versionId, house, `compile${(packSeq += 1)}x`)
    await submitVisualBibleVersion(adminId, ctx, versionId)
    await approveVisualBibleVersion(adminId, ctx, versionId)
    await publishVisualBibleVersion(adminId, ctx, versionId)
    const loaded = await loadPublishedVisualBible(house)
    if (loaded.status !== 'OK') throw new Error('fixture bible not published')
    const wide = loaded.references.find((r) => r.role === 'WIDE_MASTER')!
    // The compile stage validates rule references before it ever looks
    // at imagery, so the task must carry the real ones.
    const ruleRows = await getDb()
      .select({
        ruleId: visualBibleRules.id,
        category: visualBibleRules.category,
        position: visualBibleRules.position,
      })
      .from(visualBibleRules)
      .where(eq(visualBibleRules.bibleVersionId, loaded.versionId))
    const sacred = await makeSacredContent()
    return { house, loaded, wide, ruleRefs: ruleRows, sacred }
  }

  function task(overrides: {
    sacredHouseId: number
    visualBibleVersionId: number
    visualBibleSha256: string
    shotFamily: string | null
    referenceRequirement: string | null
    ruleRefs: Array<{ ruleId: number; category: string; position: number }>
    contentVersionId: number
    contentSha256: string
    visualReference: {
      role: string
      mediaAssetVersionId: number
      mediaFileSha256: string
    } | null
  }) {
    return {
      taskKind: 'GENERATE_VIDEO_SCENE' as const,
      taskId: 'task-ref-1',
      sceneId: 'scene-ref-1',
      idempotencyKey: 'i'.repeat(64),
      durationMs: 5000,
      generationIntent: {
        sacredHouseId: overrides.sacredHouseId,
        serviceId: 1,
        contentType: 'PRAYER',
        themeCode: null,
        requestedDurationMs: 5000,
        visualBibleVersionId: overrides.visualBibleVersionId,
        visualBibleVersionNumber: 1,
        visualBibleSha256: overrides.visualBibleSha256,
        ruleRefs: overrides.ruleRefs,
        externalAiPolicy: 'METADATA_ONLY',
        textContextAllowed: false,
        contentVersionId: overrides.contentVersionId,
        contentSha256: overrides.contentSha256,
        shotFamily: overrides.shotFamily,
        referenceRequirement: overrides.referenceRequirement,
        visualReference: overrides.visualReference,
      },
    }
  }

  it('refuses when the task role does not match its own shot family', async () => {
    const { house, loaded, wide, ruleRefs, sacred } = await publishedPack()
    const result = await compileVisualGenerationRequest(
      task({
        sacredHouseId: house,
        visualBibleVersionId: loaded.versionId,
        visualBibleSha256: loaded.definitionSha256,
        ruleRefs,
        contentVersionId: sacred.contentVersionId,
        contentSha256: sacred.contentSha256,
        // Tampered: claims MEDIUM_PRAYER, carries WIDE_MASTER.
        shotFamily: 'MEDIUM_PRAYER',
        referenceRequirement: 'REQUIRED',
        visualReference: wide,
      }) as never,
    )
    expect(result.status).toBe('FAILED')
    if (result.status === 'FAILED') {
      expect(result.reasonCode).toBe('visual_reference_role_mismatch')
    }
  }, 240_000)

  it('refuses when the reference has been SUPERSEDED in the current Bible', async () => {
    const { house, loaded, wide, ruleRefs, sacred } = await publishedPack()
    const result = await compileVisualGenerationRequest(
      task({
        sacredHouseId: house,
        visualBibleVersionId: loaded.versionId,
        visualBibleSha256: loaded.definitionSha256,
        ruleRefs,
        contentVersionId: sacred.contentVersionId,
        contentSha256: sacred.contentSha256,
        shotFamily: 'WIDE_MASTER',
        referenceRequirement: 'REQUIRED',
        // Tampered: right role, wrong media version.
        visualReference: {
          ...wide,
          mediaAssetVersionId: wide.mediaAssetVersionId + 100_000,
        },
      }) as never,
    )
    expect(result.status).toBe('FAILED')
    if (result.status === 'FAILED') {
      expect(result.reasonCode).toBe('visual_reference_superseded')
    }
  }, 240_000)

  it('refuses when the frozen byte hash no longer matches', async () => {
    const { house, loaded, wide, ruleRefs, sacred } = await publishedPack()
    const result = await compileVisualGenerationRequest(
      task({
        sacredHouseId: house,
        visualBibleVersionId: loaded.versionId,
        visualBibleSha256: loaded.definitionSha256,
        ruleRefs,
        contentVersionId: sacred.contentVersionId,
        contentSha256: sacred.contentSha256,
        shotFamily: 'WIDE_MASTER',
        referenceRequirement: 'REQUIRED',
        visualReference: { ...wide, mediaFileSha256: 'd'.repeat(64) },
      }) as never,
    )
    expect(result.status).toBe('FAILED')
    if (result.status === 'FAILED') {
      expect(result.reasonCode).toBe('visual_reference_superseded')
    }
  }, 240_000)

  it('REQUIRED with no reference at all fails closed — never text-to-video', async () => {
    const { house, loaded, ruleRefs, sacred } = await publishedPack()
    const result = await compileVisualGenerationRequest(
      task({
        sacredHouseId: house,
        visualBibleVersionId: loaded.versionId,
        visualBibleSha256: loaded.definitionSha256,
        ruleRefs,
        contentVersionId: sacred.contentVersionId,
        contentSha256: sacred.contentSha256,
        shotFamily: 'WIDE_MASTER',
        referenceRequirement: 'REQUIRED',
        visualReference: null,
      }) as never,
    )
    expect(result.status).toBe('FAILED')
    if (result.status === 'FAILED') {
      // Fails closed with a reference-specific code. It does NOT
      // silently compile a text-only request.
      expect(result.reasonCode).toBe('visual_reference_missing')
    }
  }, 240_000)

  it('REQUIRED with a now-ineligible reference fails before any paid call', async () => {
    const { house, loaded, wide, ruleRefs, sacred } = await publishedPack()
    // Rights withdrawn AFTER publication — the exact revocation case.
    await setMediaRightsStatus(
      adminId,
      ctx,
      wide.mediaAssetVersionId,
      'WITHDRAWN',
      'revoked for test',
    )
    const result = await compileVisualGenerationRequest(
      task({
        sacredHouseId: house,
        visualBibleVersionId: loaded.versionId,
        visualBibleSha256: loaded.definitionSha256,
        ruleRefs,
        contentVersionId: sacred.contentVersionId,
        contentSha256: sacred.contentSha256,
        shotFamily: 'WIDE_MASTER',
        referenceRequirement: 'REQUIRED',
        visualReference: wide,
      }) as never,
    )
    expect(result.status).toBe('FAILED')
    if (result.status === 'FAILED') {
      expect(result.reasonCode).toBe('visual_reference_ineligible')
    }
  }, 240_000)

  it('explicitly authored OPTIONAL with no reference keeps text-to-video', async () => {
    const { house, loaded, ruleRefs, sacred } = await publishedPack()
    const result = await compileVisualGenerationRequest(
      task({
        sacredHouseId: house,
        visualBibleVersionId: loaded.versionId,
        visualBibleSha256: loaded.definitionSha256,
        ruleRefs,
        contentVersionId: sacred.contentVersionId,
        contentSha256: sacred.contentSha256,
        shotFamily: 'WIDE_MASTER',
        // Authored OPTIONAL: the legacy text-driven path is retained.
        referenceRequirement: 'OPTIONAL',
        visualReference: null,
      }) as never,
    )
    // Not refused for a reference reason; it proceeds as before.
    if (result.status === 'FAILED') {
      expect(result.reasonCode).not.toContain('visual_reference')
    }
  }, 240_000)

  /**
   * THE SIX-ROLE AUTHORITY, proved positively.
   *
   * Every other test in this block tampers with one field and watches
   * the compile stage refuse. These two prove the other half: that with
   * a complete approved pack, a slot's shot family resolves to ITS OWN
   * approved image and to no other — which is precisely what static
   * library selection cannot do, because it never reads shotFamily at
   * all and picks deterministically from whatever the House has.
   */
  it('each of the six roles carries its own distinct approved image', async () => {
    const { loaded } = await publishedPack()
    expect(loaded.references).toHaveLength(6)

    const byRole = new Map(
      loaded.references.map((reference) => [reference.role, reference]),
    )
    expect([...byRole.keys()].sort()).toEqual(
      [...VISUAL_BIBLE_REFERENCE_ROLES].sort(),
    )

    // Six roles, six DIFFERENT media versions. If two roles shared one
    // version the mapping would be satisfied by accident rather than by
    // authority.
    const versionIds = loaded.references.map((r) => r.mediaAssetVersionId)
    expect(new Set(versionIds).size).toBe(6)

    // Deliberately NOT asserted: that the six hashes differ. These
    // fixtures share one byte payload, and byte-distinctness is a
    // property of a real production pack rather than a governance rule
    // — two roles bound to identical images would still be correctly
    // BOUND. What governance does require is that each binding froze
    // the hash of the version it actually names, so that is what is
    // checked.
    for (const reference of loaded.references) {
      const stored = (
        await getDb()
          .select({ fileSha256: mediaAssetVersions.fileSha256 })
          .from(mediaAssetVersions)
          .where(eq(mediaAssetVersions.id, reference.mediaAssetVersionId))
          .limit(1)
      ).at(0)!
      expect(reference.mediaFileSha256).toBe(stored.fileSha256)
      expect(reference.mediaFileSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  }, 300_000)

  it('accepts every role paired with its own image, and refuses every cross pairing', async () => {
    const { house, loaded, ruleRefs, sacred } = await publishedPack()
    const byRole = new Map(
      loaded.references.map((reference) => [reference.role, reference]),
    )

    const base = {
      sacredHouseId: house,
      visualBibleVersionId: loaded.versionId,
      visualBibleSha256: loaded.definitionSha256,
      ruleRefs,
      contentVersionId: sacred.contentVersionId,
      contentSha256: sacred.contentSha256,
      referenceRequirement: 'REQUIRED',
    }

    // MATCHED: every role, carrying its own binding, passes the
    // reference gate.
    for (const role of VISUAL_BIBLE_REFERENCE_ROLES) {
      const result = await compileVisualGenerationRequest(
        task({ ...base, shotFamily: role, visualReference: byRole.get(role)! }) as never,
      )
      if (result.status === 'FAILED') {
        expect(`${role}: ${result.reasonCode}`).not.toContain('visual_reference')
      }
    }

    // CROSSED: the two pairings named in the gate, plus a full sweep so
    // no pair is left untested. A slot may only ever be dressed by the
    // reference bound to its own role.
    const crossings: Array<[string, string]> = []
    for (const slotRole of VISUAL_BIBLE_REFERENCE_ROLES) {
      for (const carried of VISUAL_BIBLE_REFERENCE_ROLES) {
        if (slotRole !== carried) crossings.push([slotRole, carried])
      }
    }
    expect(crossings).toContainEqual(['WIDE_MASTER', 'SIDE_PRAYER'])
    expect(crossings).toContainEqual(['MEDIUM_PRAYER', 'WORKING_DETAIL'])
    expect(crossings).toHaveLength(30)

    for (const [slotRole, carried] of crossings) {
      const result = await compileVisualGenerationRequest(
        task({
          ...base,
          shotFamily: slotRole,
          visualReference: byRole.get(carried)!,
        }) as never,
      )
      expect(`${slotRole}<-${carried}:${result.status}`).toBe(
        `${slotRole}<-${carried}:FAILED`,
      )
      if (result.status === 'FAILED') {
        expect(result.reasonCode).toBe('visual_reference_role_mismatch')
      }
    }
  }, 900_000)
})

describe('OPTIONAL is never injected automatically', () => {
  it('authoring refuses a CONTENT slot with no reference requirement', () => {
    const templates = readFileSync(
      join(process.cwd(), 'src/services/prayer-templates.ts'),
      'utf8',
    )
    // The zod default is null, never OPTIONAL, and CONTENT throws.
    expect(templates).toContain(
      'referenceRequirement: z\n    .enum(SLOT_REFERENCE_REQUIREMENTS)\n    .nullable()\n    .default(null)',
    )
    expect(templates).toContain(
      'CONTENT requires an authored reference requirement',
    )
    expect(templates).not.toMatch(/default\(['"]OPTIONAL['"]\)/)
    expect(templates).not.toMatch(
      /referenceRequirement\s*(\?\?|\|\|)\s*['"]OPTIONAL['"]/,
    )
  })

  it('no service coalesces a missing requirement into OPTIONAL', () => {
    for (const file of [
      'src/services/video-recipes.ts',
      'src/services/generation-storyboards.ts',
      'src/services/visual-generation.ts',
      'src/services/prayer-session-resolver.ts',
    ]) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(
        /referenceRequirement\s*(\?\?|\|\|)\s*['"]OPTIONAL['"]/,
      )
      expect(source).not.toMatch(/shotFamily\s*(\?\?|\|\|)\s*['"][A-Z_]+['"]/)
    }
  })
})

describe('stored template shot authority is re-proved, not trusted', () => {
  it('the check rejects a CONTENT row whose authority was removed', async () => {
    // Direct row tamper: the columns are nullable, so a row written
    // around the service can carry a CONTENT slot with no camera
    // decision. Advancing must refuse it.
    const version = await makeTemplateDraft()
    await getDb()
      .update(prayerSessionTemplateSlots)
      .set({ shotFamily: null, referenceRequirement: null })
      .where(eq(prayerSessionTemplateSlots.templateVersionId, version))
    const error = await expectRejection(() =>
      assertStoredShotAuthority(version),
    )
    expect(error.message).toContain('CONTENT requires an authored shot family')
  }, 180_000)

  it('the check rejects a SILENCE row that acquired a shot family', async () => {
    const version = await makeTemplateDraft()
    await getDb()
      .update(prayerSessionTemplateSlots)
      .set({ slotKind: 'SILENCE', shotFamily: 'WIDE_MASTER' })
      .where(eq(prayerSessionTemplateSlots.templateVersionId, version))
    const error = await expectRejection(() =>
      assertStoredShotAuthority(version),
    )
    expect(error.message).toContain('SILENCE must carry no shot family')
  }, 180_000)

  it('accepts a coherently authored CONTENT row', async () => {
    const version = await makeTemplateDraft()
    await assertStoredShotAuthority(version)
  }, 180_000)
})

describe('existing versions are unchanged in meaning', () => {
  it('defaults to TEXT_ONLY and needs no references', async () => {
    const { versionId } = await makeBibleDraft('TEXT_ONLY')
    const row = (
      await getDb()
        .select({ referenceMode: visualBibleVersions.referenceMode })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, versionId))
        .limit(1)
    ).at(0)!
    expect(row.referenceMode).toBe('TEXT_ONLY')
    await submitVisualBibleVersion(adminId, ctx, versionId)
    await approveVisualBibleVersion(adminId, ctx, versionId)
    const published = await publishVisualBibleVersion(adminId, ctx, versionId)
    expect(published.definitionSha256).toMatch(/^[0-9a-f]{64}$/)
  }, 180_000)

  /**
   * V205 was superseded by an explicitly authorised transition, so this
   * no longer pins it as the working version — it pins what the
   * transition was allowed to do TO it.
   *
   * The point survives the change of state: archiving retires a version,
   * it does not retrofit one. V205 keeps its 78 rules, its TEXT_ONLY
   * mode and its zero bindings forever, as the historical evidence of
   * what was approved before imagery existed. References went to a NEW
   * version, which is the only honest place for them.
   */
  it('leaves archived Visual Bible 235 / version 205 exactly as it was approved', async () => {
    const row = (
      await getDb()
        .select({
          status: visualBibleVersions.status,
          referenceMode: visualBibleVersions.referenceMode,
          publishedAt: visualBibleVersions.publishedAt,
        })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, 205))
        .limit(1)
    ).at(0)
    if (!row) return
    expect(row.status).toBe('ARCHIVED')
    // Never published, and never retrofitted with imagery.
    expect(row.referenceMode).toBe('TEXT_ONLY')
    expect(row.publishedAt).toBeNull()
    const bound = await getDb()
      .select()
      .from(visualBibleReferenceMedia)
      .where(eq(visualBibleReferenceMedia.visualBibleVersionId, 205))
    expect(bound).toHaveLength(0)
    const rules = await getDb()
      .select({ id: visualBibleRules.id })
      .from(visualBibleRules)
      .where(eq(visualBibleRules.bibleVersionId, 205))
    expect(rules).toHaveLength(78)
  })

  it('carries the 78 rules forward to an approved, unpublished V2', async () => {
    const versions = await getDb()
      .select({
        id: visualBibleVersions.id,
        versionNumber: visualBibleVersions.versionNumber,
        status: visualBibleVersions.status,
        referenceMode: visualBibleVersions.referenceMode,
        publishedAt: visualBibleVersions.publishedAt,
      })
      .from(visualBibleVersions)
      .where(eq(visualBibleVersions.visualBibleId, 235))
    if (versions.length < 2) return

    const v2 = versions.find((v) => v.versionNumber === 2)
    if (!v2) return
    expect(v2.status).toBe('APPROVED')
    expect(v2.referenceMode).toBe('IMAGE_REFERENCE_REQUIRED')
    // Approved is not published: visual governance can be settled while
    // the House is still short of the sacred content it needs.
    expect(v2.publishedAt).toBeNull()

    const rules = await getDb()
      .select({ id: visualBibleRules.id })
      .from(visualBibleRules)
      .where(eq(visualBibleRules.bibleVersionId, v2.id))
    expect(rules).toHaveLength(78)

    const bound = await getDb()
      .select({
        role: visualBibleReferenceMedia.role,
        mediaAssetVersionId: visualBibleReferenceMedia.mediaAssetVersionId,
      })
      .from(visualBibleReferenceMedia)
      .where(eq(visualBibleReferenceMedia.visualBibleVersionId, v2.id))
    expect(bound).toHaveLength(6)
    expect(bound.map((b) => b.role).sort()).toEqual(
      [...VISUAL_BIBLE_REFERENCE_ROLES].sort(),
    )
    // Six roles, six different approved images — the real pack, unlike
    // the byte-identical fixtures above.
    expect(new Set(bound.map((b) => b.mediaAssetVersionId)).size).toBe(6)
    // The superseded 3:2 originals were not carried over.
    expect(bound.map((b) => b.mediaAssetVersionId)).not.toContain(38060)
    expect(bound.map((b) => b.mediaAssetVersionId)).not.toContain(38065)
  })
})

describe('the three new House Visual Bibles are scoped to their own Houses', () => {
  /**
   * Registered from SACRED_HOUSES_MASTER_VISUAL_BIBLE_PACK_V1 as
   * TEXT_ONLY drafts. They stay TEXT_ONLY until six House-specific
   * approved references exist: declaring IMAGE_REFERENCE_REQUIRED
   * first would make every House unpublishable for want of images that
   * were never produced, which is a self-inflicted readiness failure
   * rather than a governance guarantee.
   *
   * Production rows, so these skip on a database without them and
   * assert hard where they exist.
   */
  const NEW_BIBLES = [
    { houseId: 1, houseCode: 'ABULE_OSUN', bibleId: 1193, versionId: 1142, rules: 106 },
    { houseId: 2, houseCode: 'ABULE_AJE', bibleId: 1194, versionId: 1143, rules: 106 },
    {
      houseId: 3,
      houseCode: 'ABULE_OSANYIN_AJA',
      bibleId: 1195,
      versionId: 1144,
      rules: 113,
    },
  ]

  async function versionRow(versionId: number) {
    return (
      await getDb()
        .select({
          id: visualBibleVersions.id,
          bibleId: visualBibleVersions.visualBibleId,
          versionNumber: visualBibleVersions.versionNumber,
          status: visualBibleVersions.status,
          referenceMode: visualBibleVersions.referenceMode,
          publishedAt: visualBibleVersions.publishedAt,
          definitionSha256: visualBibleVersions.definitionSha256,
        })
        .from(visualBibleVersions)
        .where(eq(visualBibleVersions.id, versionId))
        .limit(1)
    ).at(0)
  }

  it('belongs to the House its code names, never a document ordinal', async () => {
    for (const bible of NEW_BIBLES) {
      const row = (
        await getDb()
          .select({
            id: visualBibles.id,
            sacredHouseId: visualBibles.sacredHouseId,
          })
          .from(visualBibles)
          .where(eq(visualBibles.id, bible.bibleId))
          .limit(1)
      ).at(0)
      if (!row) return
      expect(row.sacredHouseId).toBe(bible.houseId)
      const house = (
        await getDb()
          .select({ code: sacredHouses.code })
          .from(sacredHouses)
          .where(eq(sacredHouses.id, bible.houseId))
          .limit(1)
      ).at(0)!
      expect(house.code).toBe(bible.houseCode)
    }
    // The source pack letters its Houses A-D with Babaláwo first. In the
    // database Babaláwo is 4, so lettering and id disagree for every
    // House — mapping by position would have given each House another
    // House's visual law.
    const babalawo = (
      await getDb()
        .select({ code: sacredHouses.code })
        .from(sacredHouses)
        .where(eq(sacredHouses.id, 4))
        .limit(1)
    ).at(0)
    if (babalawo) expect(babalawo.code).toBe('ILE_AWON_BABALAWO')
  })

  it('is an APPROVED reference-required version, still unpublished', async () => {
    // These began TEXT_ONLY and empty, deliberately: declaring
    // IMAGE_REFERENCE_REQUIRED before six approved House images existed
    // would have made each House unpublishable for want of pictures
    // nobody had produced. The mode moved only once its own pack was
    // registered and bound.
    for (const bible of NEW_BIBLES) {
      const row = await versionRow(bible.versionId)
      if (!row) return
      expect(row.bibleId).toBe(bible.bibleId)
      expect(row.versionNumber).toBe(1)
      expect(row.status).toBe('APPROVED')
      expect(row.referenceMode).toBe('IMAGE_REFERENCE_REQUIRED')
      // Approved is not published. The definition hash is computed at
      // publication, so a value here would mean one had been published.
      expect(row.publishedAt).toBeNull()
      expect(row.definitionSha256).toBeNull()

      const bound = await getDb()
        .select({
          role: visualBibleReferenceMedia.role,
          mediaAssetVersionId: visualBibleReferenceMedia.mediaAssetVersionId,
          mediaFileSha256: visualBibleReferenceMedia.mediaFileSha256,
        })
        .from(visualBibleReferenceMedia)
        .where(eq(visualBibleReferenceMedia.visualBibleVersionId, bible.versionId))
      expect(bound).toHaveLength(6)
      expect(bound.map((b) => b.role).sort()).toEqual(
        [...VISUAL_BIBLE_REFERENCE_ROLES].sort(),
      )
      // Six roles, six DIFFERENT images. One picture answering two
      // roles would satisfy the count without satisfying the pack.
      expect(new Set(bound.map((b) => b.mediaAssetVersionId)).size).toBe(6)
      expect(new Set(bound.map((b) => b.mediaFileSha256)).size).toBe(6)
      for (const binding of bound) {
        expect(binding.mediaFileSha256).toMatch(/^[0-9a-f]{64}$/)
      }
    }
  })

  it('binds only images that belong to its own House', async () => {
    for (const bible of NEW_BIBLES) {
      const rows = await getDb()
        .select({
          role: visualBibleReferenceMedia.role,
          houseId: mediaAssets.sacredHouseId,
          scopeType: mediaAssets.scopeType,
          assetKind: mediaAssets.assetKind,
          status: mediaAssetVersions.status,
          rightsStatus: mediaAssetVersions.rightsStatus,
          runtimeEnabled: mediaAssetVersions.runtimeEnabled,
          sourceType: mediaAssetVersions.sourceType,
          externalAiPolicy: mediaAssetVersions.externalAiPolicy,
          containsIdentifiablePerson:
            mediaAssetVersions.containsIdentifiablePerson,
        })
        .from(visualBibleReferenceMedia)
        .innerJoin(
          mediaAssetVersions,
          eq(mediaAssetVersions.id, visualBibleReferenceMedia.mediaAssetVersionId),
        )
        .innerJoin(mediaAssets, eq(mediaAssets.id, mediaAssetVersions.assetId))
        .where(eq(visualBibleReferenceMedia.visualBibleVersionId, bible.versionId))
      if (rows.length === 0) return
      for (const row of rows) {
        // The rule the whole scope system exists for: a House is
        // dressed in its own imagery and nobody else's.
        expect(row.houseId).toBe(bible.houseId)
        expect(row.scopeType).toBe('SACRED_HOUSE')
        expect(row.assetKind).toBe('IMAGE')
        expect(row.status).toBe('PUBLISHED')
        expect(row.rightsStatus).toBe('CLEARED')
        expect(row.runtimeEnabled).toBe(true)
        // Synthetic imagery: no real person is depicted, so there is no
        // likeness to have consented.
        expect(row.sourceType).toBe('AI_GENERATED')
        expect(row.containsIdentifiablePerson).toBe(false)
        expect(row.externalAiPolicy).toBe('DERIVATIVE_GENERATION_ALLOWED')
      }
    }
  })

  it('carries all sixteen categories with contiguous positions', async () => {
    for (const bible of NEW_BIBLES) {
      const rules = await getDb()
        .select({
          category: visualBibleRules.category,
          position: visualBibleRules.position,
          ruleText: visualBibleRules.ruleText,
        })
        .from(visualBibleRules)
        .where(eq(visualBibleRules.bibleVersionId, bible.versionId))
        .orderBy(visualBibleRules.position)
      if (rules.length === 0) return
      expect(rules).toHaveLength(bible.rules)
      expect(new Set(rules.map((r) => r.category)).size).toBe(16)
      // Publication requires contiguous positions from 1; proving it now
      // means the later reference-required version cannot fail on it.
      expect(rules.map((r) => r.position)).toEqual(
        rules.map((_, index) => index + 1),
      )
      // Categories appear in one deterministic run each, in the schema's
      // own order — never interleaved.
      const order = [...new Set(rules.map((r) => r.category))]
      expect(order).toEqual(
        VISUAL_BIBLE_RULE_CATEGORIES.filter((c) => order.includes(c)),
      )
    }
  })

  it('states the remote-recipient rule in its own words', async () => {
    for (const bible of NEW_BIBLES) {
      const rules = await getDb()
        .select({ ruleText: visualBibleRules.ruleText })
        .from(visualBibleRules)
        .where(eq(visualBibleRules.bibleVersionId, bible.versionId))
      if (rules.length === 0) return
      const joined = rules.map((r) => r.ruleText).join(' ').toLowerCase()
      // Every House must forbid a visible second person and place the
      // lens at the recipient. A House that omitted it could be rendered
      // with a client in the room.
      expect(joined).toContain('client')
      expect(
        joined.includes('recipient') ||
          joined.includes('lens') ||
          joined.includes('camera'),
      ).toBe(true)
    }
  })

  it('shares no imagery with Babaláwo or with each other', async () => {
    const rows = await getDb()
      .select({
        versionId: visualBibleReferenceMedia.visualBibleVersionId,
        mediaAssetVersionId: visualBibleReferenceMedia.mediaAssetVersionId,
      })
      .from(visualBibleReferenceMedia)
    if (rows.length === 0) return
    // No media version satisfies two Bibles at once. A reference asset
    // is House property, not a shared library item.
    const byAsset = new Map<number, Set<number>>()
    for (const row of rows) {
      const set = byAsset.get(row.mediaAssetVersionId) ?? new Set<number>()
      set.add(row.versionId)
      byAsset.set(row.mediaAssetVersionId, set)
    }
    for (const [, versions] of byAsset) {
      expect(versions.size).toBe(1)
    }
  })

  it('left Babaláwo, the templates and the prayer pack untouched', async () => {
    const v886 = await versionRow(886)
    if (!v886) return
    expect(v886.status).toBe('APPROVED')
    expect(v886.referenceMode).toBe('IMAGE_REFERENCE_REQUIRED')
    expect(v886.publishedAt).toBeNull()
    const bound886 = await getDb()
      .select()
      .from(visualBibleReferenceMedia)
      .where(eq(visualBibleReferenceMedia.visualBibleVersionId, 886))
    expect(bound886).toHaveLength(6)

    const v205 = await versionRow(205)
    if (v205) {
      expect(v205.status).toBe('ARCHIVED')
      expect(v205.referenceMode).toBe('TEXT_ONLY')
    }

    const templates = await getDb()
      .select({
        id: prayerSessionTemplateVersions.id,
        status: prayerSessionTemplateVersions.status,
      })
      .from(prayerSessionTemplateVersions)
      .where(inArray(prayerSessionTemplateVersions.id, [28958, 35343]))
    for (const template of templates) {
      expect(template.status).toBe('APPROVED')
    }
  })
})
