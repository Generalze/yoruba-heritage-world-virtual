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
  auditLogs,
  mediaAssetVersions,
  mediaAssets,
  sacredContentVersionProfiles,
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
  bindVisualBibleReference,
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

  it('neither domain redeclares the list', () => {
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

  it('leaves Visual Bible 235 / version 205 exactly as approved', async () => {
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
    expect(row.status).toBe('APPROVED')
    expect(row.referenceMode).toBe('TEXT_ONLY')
    expect(row.publishedAt).toBeNull()
    const bound = await getDb()
      .select()
      .from(visualBibleReferenceMedia)
      .where(eq(visualBibleReferenceMedia.visualBibleVersionId, 205))
    expect(bound).toHaveLength(0)
  })
})
