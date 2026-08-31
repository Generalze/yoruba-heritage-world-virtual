import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  auditLogs,
  mediaAssetVersions,
  mediaAssets,
  sacredHouses,
  users,
  visualBibleReferenceMedia,
  visualBibleRules,
  visualBibleVersions,
  visualBibles,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
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
    await getDb()
      .update(visualBibleVersions)
      .set({ referenceMode })
      .where(eq(visualBibleVersions.id, version.id))
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
    const { versionId, house } = await makeBibleDraft('TEXT_ONLY')
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
    const { versionId, house } = await makeBibleDraft('TEXT_ONLY')
    const image = await makeImage('frozen', { house })
    await submitVisualBibleVersion(adminId, ctx, versionId)
    const error = await expectRejection(() =>
      bindVisualBibleReference(
        adminId,
        ctx,
        versionId,
        'WIDE_MASTER',
        image.versionId,
      ),
    )
    expect(error.message).toContain('draft')
  }, 120_000)

  it('refuses to UNBIND once the version leaves DRAFT', async () => {
    const { versionId, house } = await makeBibleDraft('TEXT_ONLY')
    const image = await makeImage('unbind', { house })
    await bindVisualBibleReference(
      adminId,
      ctx,
      versionId,
      'WIDE_MASTER',
      image.versionId,
    )
    await submitVisualBibleVersion(adminId, ctx, versionId)
    await expectRejection(() =>
      unbindVisualBibleReference(adminId, ctx, versionId, 'WIDE_MASTER'),
    )
    expect(await listVisualBibleReferences(versionId)).toHaveLength(1)
  }, 120_000)
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
    const { versionId, house } = await makeBibleDraft('TEXT_ONLY')
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
