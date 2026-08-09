import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { and, eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  auditLogs,
  mediaAssetVersions,
  mediaAssets,
  sacredContentMediaLinks,
  sacredContentVersionProfiles,
  sacredHouses,
  services,
  spiritualContentItems,
  spiritualContentVersions,
  users,
  visualBibleRules,
  visualBibleVersions,
  visualBibles,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { ForbiddenError } from '@/auth/guards'
import { assignRoleToUser, userHasPermission } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
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
import {
  LocalMediaStorageProvider,
  computeFileSha256,
  isValidStorageKey,
  resetMediaStorageForTests,
  setMediaStorageForTests,
} from '@/providers/media/storage'
import {
  MediaError,
  approveMediaVersion,
  archiveMediaVersion,
  createMediaAsset,
  createMediaVersion,
  createSacredMediaLink,
  isMediaAssetRuntimeEligible,
  listAllEligibleMediaAssets,
  loadMediaVersion,
  publishMediaVersion,
  removeSacredMediaLink,
  resolveSacredAudioCandidates,
  returnMediaVersion,
  setMediaAssetActive,
  setMediaConsentStatus,
  setMediaRightsStatus,
  setMediaRuntimeEnabled,
  submitMediaVersion,
  updateDraftMediaVersion,
  updateMediaAsset,
} from '@/services/media-assets'
import {
  approveVisualBibleVersion,
  computeVisualBibleSha256,
  createVisualBible,
  createVisualBibleVersion,
  loadPublishedVisualBible,
  loadVisualBibleVersion,
  publishVisualBibleVersion,
  returnVisualBibleVersion,
  submitVisualBibleVersion,
  updateDraftVisualBibleVersion,
} from '@/services/visual-bibles'
import type {
  MediaAssetInput,
  MediaVersionMetadataInput,
} from '@/services/media-assets'
import type { SacredProfileInput } from '@/services/sacred-content'

/**
 * Step 10 integration tests: media lifecycle/RBAC/immutability,
 * private storage safety (traversal, server-side hashing), fail-closed
 * integrity, rights/consent gates, sacred audio links + voice policy,
 * scope/language filters, >500 pagination, Visual Bible hashing, audit
 * privacy and later-phase guards.
 *
 * ALL media bytes in this file are obviously synthetic strings — never
 * real recordings, never committed anywhere but a temp directory.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `media test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const createdAssetIds: Array<number> = []
const createdItemIds: Array<number> = []
const createdBibleIds: Array<number> = []

let adminId: number
let cmId: number
let plainUserId: number
let houseId: number
let serviceId: number
let storageRoot: string
let storage: LocalMediaStorageProvider

const RUN_KEY = crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')
const CODE_PREFIX = `T10_${RUN_KEY}`
let codeCounter = 0
function nextCode(prefix = 'MA'): string {
  codeCounter += 1
  return `${CODE_PREFIX}_${prefix}_${codeCounter}`
}

function syntheticBytes(marker: string = crypto.randomUUID()): Uint8Array {
  return new TextEncoder().encode(`synthetic-test-media-bytes ${marker}`)
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s10-${crypto.randomUUID()}@test.local`,
      preferredName: 'S10 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role) await assignRoleToUser(result.user.id, role)
  return result.user.id
}

async function makeAsset(
  overrides: Partial<MediaAssetInput> = {},
): Promise<number> {
  const result = await createMediaAsset(cmId, ctx, {
    code: nextCode(),
    assetKind: 'AUDIO',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    contentType: null,
    themeCode: null,
    ...overrides,
  })
  createdAssetIds.push(result.id)
  return result.id
}

function baseMeta(
  overrides: Partial<MediaVersionMetadataInput> = {},
): MediaVersionMetadataInput {
  return {
    sourceType: 'HUMAN_RECORDED',
    language: null,
    durationSeconds: 30,
    width: null,
    height: null,
    containsIdentifiablePerson: false,
    consentStatus: 'NOT_APPLICABLE',
    consentReference: null,
    externalAiPolicy: 'NO_EXTERNAL_AI',
    voiceCloneAuthorized: false,
    ...overrides,
  }
}

const MIME_BY_KIND = {
  AUDIO: 'audio/mpeg',
  IMAGE: 'image/png',
  VIDEO: 'video/mp4',
} as const

async function makeVersion(
  assetId: number,
  overrides: Partial<MediaVersionMetadataInput> = {},
  bytes: Uint8Array = syntheticBytes(),
  mimeType?: string,
) {
  const asset = (
    await getDb()
      .select({ assetKind: mediaAssets.assetKind })
      .from(mediaAssets)
      .where(eq(mediaAssets.id, assetId))
      .limit(1)
  ).at(0)
  return createMediaVersion(
    cmId,
    ctx,
    assetId,
    bytes,
    mimeType ?? MIME_BY_KIND[asset!.assetKind],
    baseMeta(overrides),
  )
}

async function makePublishedMedia(
  assetId: number,
  overrides: Partial<MediaVersionMetadataInput> = {},
  bytes?: Uint8Array,
): Promise<number> {
  const version = await makeVersion(
    assetId,
    overrides,
    bytes ?? syntheticBytes(),
  )
  await submitMediaVersion(cmId, ctx, version.id)
  await approveMediaVersion(adminId, ctx, version.id)
  await publishMediaVersion(adminId, ctx, version.id)
  return version.id
}

async function makeEligibleMedia(
  assetOverrides: Partial<MediaAssetInput> = {},
  metaOverrides: Partial<MediaVersionMetadataInput> = {},
): Promise<{ assetId: number; versionId: number }> {
  const assetId = await makeAsset(assetOverrides)
  const versionId = await makePublishedMedia(assetId, metaOverrides)
  await setMediaRightsStatus(adminId, ctx, versionId, 'PENDING_REVIEW')
  await setMediaRightsStatus(adminId, ctx, versionId, 'CLEARED')
  await setMediaRuntimeEnabled(adminId, ctx, versionId, true)
  return { assetId, versionId }
}

function sacredProfile(
  overrides: Partial<SacredProfileInput> = {},
): SacredProfileInput {
  return {
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
    voicePolicy: 'HUMAN_RECORDED_REQUIRED',
    externalAiPolicy: 'METADATA_ONLY',
    accessPolicy: 'PRAYER_ROOM_PRIVATE',
    ...overrides,
  }
}

/** Published (and runtime-eligible) sacred content version fixture. */
async function makeSacredVersionFixture(options: {
  language?: 'en' | 'yo'
  voicePolicy?: 'HUMAN_RECORDED_REQUIRED' | 'APPROVED_TTS_ALLOWED' | 'TEXT_ONLY'
}): Promise<{ itemId: number; versionId: number }> {
  const item = await createSacredContentItem(cmId, ctx, {
    code: nextCode('SC'),
    contentType: 'PRAYER',
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    sortOrder: 0,
  })
  createdItemIds.push(item.id)
  const version = await createSacredVersion(
    cmId,
    ctx,
    item.id,
    {
      language: options.language ?? 'en',
      title: 'Integration-test sacred block',
      body: `Integration-test prayer block ${crypto.randomUUID()}`,
    },
    sacredProfile(
      options.voicePolicy ? { voicePolicy: options.voicePolicy } : {},
    ),
  )
  await submitVersionForReview(cmId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, version.id, true)
  return { itemId: item.id, versionId: version.id }
}

async function expectError(
  fn: () => Promise<unknown>,
  kind: 'media' | 'forbidden' | 'any' = 'media',
): Promise<Error> {
  let thrown: unknown = null
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  if (kind === 'media') expect(thrown).toBeInstanceOf(MediaError)
  else if (kind === 'forbidden') expect(thrown).toBeInstanceOf(ForbiddenError)
  else expect(thrown).not.toBeNull()
  return thrown as Error
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-media-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'T10\\_%'))
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'T10\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')
  plainUserId = await makeUser()

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T10H_${key}`.toUpperCase(),
    name: `T10 House ${key}`,
    slug: `t10h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  const svcInsert = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T10S_${key}`.toUpperCase(),
    name: `T10 Service ${key}`,
    slug: `t10s-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  serviceId = svcInsert[0].insertId
})

afterAll(async () => {
  const db = getDb()
  if (createdAssetIds.length > 0) {
    const versionRows = await db
      .select({ id: mediaAssetVersions.id })
      .from(mediaAssetVersions)
      .where(inArray(mediaAssetVersions.assetId, createdAssetIds))
    const versionIds = versionRows.map((row) => row.id)
    if (versionIds.length > 0) {
      await db
        .delete(sacredContentMediaLinks)
        .where(inArray(sacredContentMediaLinks.mediaAssetVersionId, versionIds))
      await db
        .delete(mediaAssetVersions)
        .where(inArray(mediaAssetVersions.id, versionIds))
    }
    await db.delete(mediaAssets).where(inArray(mediaAssets.id, createdAssetIds))
  }
  if (createdBibleIds.length > 0) {
    const bibleVersions = await db
      .select({ id: visualBibleVersions.id })
      .from(visualBibleVersions)
      .where(inArray(visualBibleVersions.visualBibleId, createdBibleIds))
    const bibleVersionIds = bibleVersions.map((row) => row.id)
    if (bibleVersionIds.length > 0) {
      await db
        .delete(visualBibleRules)
        .where(inArray(visualBibleRules.bibleVersionId, bibleVersionIds))
      await db
        .delete(visualBibleVersions)
        .where(inArray(visualBibleVersions.id, bibleVersionIds))
    }
    await db
      .delete(visualBibles)
      .where(inArray(visualBibles.id, createdBibleIds))
  }
  if (createdItemIds.length > 0) {
    await db
      .delete(sacredContentVersionProfiles)
      .where(
        inArray(sacredContentVersionProfiles.contentItemId, createdItemIds),
      )
    await db
      .delete(spiritualContentVersions)
      .where(inArray(spiritualContentVersions.contentItemId, createdItemIds))
    await db
      .delete(spiritualContentItems)
      .where(inArray(spiritualContentItems.id, createdItemIds))
  }
  if (houseId) {
    await db.delete(services).where(eq(services.sacredHouseId, houseId))
    await db.delete(sacredHouses).where(eq(sacredHouses.id, houseId))
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, createdUserIds))
    await db.delete(users).where(inArray(users.id, createdUserIds))
  }
  resetMediaStorageForTests()
  try {
    rmSync(storageRoot, { recursive: true, force: true })
  } catch {
    // best-effort temp cleanup
  }
  await closeDb()
})

// --- Storage safety ---------------------------------------------------------

describe('private storage', () => {
  it('rejects traversal-shaped keys and computes the SHA-256 server-side', async () => {
    expect(isValidStorageKey('../../etc/passwd')).toBe(false)
    expect(isValidStorageKey('aa/../../secret.mp3')).toBe(false)
    expect(isValidStorageKey('/absolute/path.mp3')).toBe(false)
    expect(isValidStorageKey('aa\\bb.mp3')).toBe(false)
    expect(await storage.get('../../etc/passwd')).toBeNull()
    expect(await storage.exists('aa/../secret.mp3')).toBe(false)
    await expectError(() => storage.put(syntheticBytes(), 'exe'), 'any')

    const bytes = syntheticBytes('sha-check')
    const assetId = await makeAsset()
    const version = await makeVersion(assetId, {}, bytes)
    const row = await loadMediaVersion(version.id)
    // Server-computed hash of the exact uploaded bytes.
    expect(row.fileSha256).toBe(computeFileSha256(bytes))
    expect(isValidStorageKey(row.storageKey)).toBe(true)
    const stored = await storage.get(row.storageKey)
    expect(stored).not.toBeNull()
    expect(computeFileSha256(stored!)).toBe(row.fileSha256)
  }, 60_000)

  it('rejects empty and oversized uploads and wrong mime for the kind', async () => {
    const audioAsset = await makeAsset()
    await expectError(() => makeVersion(audioAsset, {}, new Uint8Array(0)))
    await expectError(() =>
      makeVersion(audioAsset, {}, syntheticBytes(), 'image/png'),
    )
    const imageAsset = await makeAsset({ assetKind: 'IMAGE' })
    await expectError(() =>
      makeVersion(
        imageAsset,
        {},
        new Uint8Array(10 * 1024 * 1024 + 1),
        'image/png',
      ),
    )
  }, 60_000)
})

// --- Lifecycle / RBAC / immutability ----------------------------------------

describe('media workflow', () => {
  it('walks the full human workflow with RBAC, freeze and replacement', async () => {
    await expectError(
      () =>
        createMediaAsset(plainUserId, ctx, {
          code: nextCode(),
          assetKind: 'AUDIO',
          scopeType: 'PLATFORM',
          sacredHouseId: null,
          serviceId: null,
          contentType: null,
          themeCode: null,
        }),
      'forbidden',
    )
    const assetId = await makeAsset()
    const version = await makeVersion(assetId, { language: 'en' })
    // voice_clone_authorized defaults FALSE.
    expect((await loadMediaVersion(version.id)).voiceCloneAuthorized).toBe(
      false,
    )
    // DRAFT metadata editable.
    await updateDraftMediaVersion(
      cmId,
      ctx,
      version.id,
      baseMeta({
        language: 'yo',
        sourceType: 'IN_HOUSE',
      }),
    )
    expect((await loadMediaVersion(version.id)).sourceType).toBe('IN_HOUSE')

    await submitMediaVersion(cmId, ctx, version.id)
    // UNDER_REVIEW immutable; structural asset edit frozen forever.
    await expectError(() =>
      updateDraftMediaVersion(cmId, ctx, version.id, baseMeta()),
    )
    await expectError(() =>
      updateMediaAsset(cmId, ctx, assetId, {
        code: nextCode(),
        assetKind: 'IMAGE',
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
        contentType: null,
        themeCode: null,
      }),
    )
    // Return requires reason; CM cannot approve/publish.
    await expectError(() => returnMediaVersion(adminId, ctx, version.id, ' '))
    await expectError(
      () => approveMediaVersion(cmId, ctx, version.id),
      'forbidden',
    )
    await returnMediaVersion(adminId, ctx, version.id, 'check the levels')
    await submitMediaVersion(cmId, ctx, version.id)
    await approveMediaVersion(adminId, ctx, version.id)
    await expectError(
      () => publishMediaVersion(cmId, ctx, version.id),
      'forbidden',
    )
    await publishMediaVersion(adminId, ctx, version.id)
    expect((await loadMediaVersion(version.id)).status).toBe('PUBLISHED')

    // Replacement publication archives the previous one.
    const v2 = await makeVersion(assetId, { language: 'yo' })
    await submitMediaVersion(cmId, ctx, v2.id)
    await approveMediaVersion(adminId, ctx, v2.id)
    await publishMediaVersion(adminId, ctx, v2.id)
    expect((await loadMediaVersion(version.id)).status).toBe('ARCHIVED')
    // Archived is terminal.
    await expectError(() => archiveMediaVersion(adminId, ctx, version.id))
    await setMediaAssetActive(adminId, ctx, assetId, false)
  }, 120_000)

  it('permission matrix and version-creation concurrency', async () => {
    expect(await userHasPermission(cmId, 'media.manage')).toBe(true)
    expect(await userHasPermission(cmId, 'media.approve')).toBe(false)
    expect(await userHasPermission(cmId, 'media.publish')).toBe(false)
    expect(await userHasPermission(cmId, 'media.rights_manage')).toBe(false)
    expect(await userHasPermission(adminId, 'media.rights_manage')).toBe(true)
    expect(await userHasPermission(plainUserId, 'media.view')).toBe(false)

    const assetId = await makeAsset()
    const results = await Promise.allSettled([
      makeVersion(assetId),
      makeVersion(assetId),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const rows = await getDb()
      .select()
      .from(mediaAssetVersions)
      .where(eq(mediaAssetVersions.assetId, assetId))
    expect(rows.length).toBe(1)
    expect(rows[0].versionNumber).toBe(1)
  }, 60_000)
})

// --- Runtime eligibility & integrity ----------------------------------------

describe('runtime eligibility', () => {
  it('requires every gate; corrupt or missing files fail closed and are never healed', async () => {
    const { assetId, versionId } = await makeEligibleMedia()
    const version = await loadMediaVersion(versionId)
    const asset = (
      await getDb()
        .select()
        .from(mediaAssets)
        .where(eq(mediaAssets.id, assetId))
        .limit(1)
    ).at(0)!
    expect(
      (await isMediaAssetRuntimeEligible({ asset, version })).eligible,
    ).toBe(true)
    let ids = (await listAllEligibleMediaAssets({})).map((r) => r.versionId)
    expect(ids).toContain(versionId)

    // Corrupt the stored bytes directly on disk.
    await writeFile(
      join(storageRoot, version.storageKey),
      syntheticBytes('corrupted'),
    )
    const corrupt = await isMediaAssetRuntimeEligible({ asset, version })
    expect(corrupt.eligible).toBe(false)
    expect(corrupt.failures).toContain('file_hash_mismatch')
    ids = (await listAllEligibleMediaAssets({})).map((r) => r.versionId)
    expect(ids).not.toContain(versionId)
    // The stored hash was NOT rewritten to match the corruption.
    expect((await loadMediaVersion(versionId)).fileSha256).toBe(
      version.fileSha256,
    )
    // Enable also refuses (disable first, then attempt re-enable).
    await setMediaRuntimeEnabled(adminId, ctx, versionId, false)
    await expectError(() =>
      setMediaRuntimeEnabled(adminId, ctx, versionId, true),
    )

    // Missing object entirely.
    await rm(join(storageRoot, version.storageKey))
    const missing = await isMediaAssetRuntimeEligible({ asset, version })
    expect(missing.eligible).toBe(false)
    expect(missing.failures).toContain('storage_object_missing')
    await setMediaAssetActive(adminId, ctx, assetId, false)
  }, 120_000)

  it('rights withdrawal and asset deactivation remove eligibility immediately', async () => {
    const { assetId, versionId } = await makeEligibleMedia()
    expect(
      (await listAllEligibleMediaAssets({})).map((r) => r.versionId),
    ).toContain(versionId)
    await setMediaRightsStatus(
      adminId,
      ctx,
      versionId,
      'WITHDRAWN',
      'synthetic withdrawal reason',
    )
    expect(
      (await listAllEligibleMediaAssets({})).map((r) => r.versionId),
    ).not.toContain(versionId)
    // Nothing destroyed.
    expect((await loadMediaVersion(versionId)).status).toBe('PUBLISHED')
    await setMediaAssetActive(adminId, ctx, assetId, false)

    const second = await makeEligibleMedia()
    await setMediaAssetActive(adminId, ctx, second.assetId, false)
    expect(
      (await listAllEligibleMediaAssets({})).map((r) => r.versionId),
    ).not.toContain(second.versionId)
  }, 120_000)

  it('identifiable-person media is gated on ADMIN-confirmed consent; withdrawal revokes', async () => {
    const assetId = await makeAsset({ assetKind: 'IMAGE' })
    // Identifiable + NOT_APPLICABLE refused at authoring time.
    await expectError(() =>
      makeVersion(assetId, {
        containsIdentifiablePerson: true,
        consentStatus: 'NOT_APPLICABLE',
      }),
    )
    const versionId = await makePublishedMedia(assetId, {
      containsIdentifiablePerson: true,
      consentStatus: 'PENDING',
    })
    await setMediaRightsStatus(adminId, ctx, versionId, 'PENDING_REVIEW')
    await setMediaRightsStatus(adminId, ctx, versionId, 'CLEARED')
    // Consent still PENDING → enable refused.
    const denied = await expectError(() =>
      setMediaRuntimeEnabled(adminId, ctx, versionId, true),
    )
    expect(denied.message).toContain('consent_not_granted')
    // CM cannot confirm consent; GRANTED needs a documented reference.
    await expectError(
      () => setMediaConsentStatus(cmId, ctx, versionId, 'GRANTED', 'x'),
      'forbidden',
    )
    await expectError(() =>
      setMediaConsentStatus(adminId, ctx, versionId, 'GRANTED'),
    )
    await setMediaConsentStatus(
      adminId,
      ctx,
      versionId,
      'GRANTED',
      'synthetic consent dossier reference',
    )
    await setMediaRuntimeEnabled(adminId, ctx, versionId, true)
    expect(
      (await listAllEligibleMediaAssets({})).map((r) => r.versionId),
    ).toContain(versionId)
    // Consent withdrawal revokes immediately.
    await setMediaConsentStatus(adminId, ctx, versionId, 'WITHDRAWN')
    expect(
      (await listAllEligibleMediaAssets({})).map((r) => r.versionId),
    ).not.toContain(versionId)
    await setMediaAssetActive(adminId, ctx, assetId, false)
  }, 120_000)

  it('scope and language filters behave like the sacred candidate query', async () => {
    const theme = `T10_SCP_${RUN_KEY}`
    const platformEn = await makeEligibleMedia(
      { themeCode: theme },
      { language: 'en' },
    )
    const serviceEn = await makeEligibleMedia(
      { scopeType: 'SERVICE', serviceId, themeCode: theme },
      { language: 'en' },
    )
    const platformYo = await makeEligibleMedia(
      { themeCode: theme },
      { language: 'yo' },
    )
    const withService = (
      await listAllEligibleMediaAssets({
        themeCode: theme,
        language: 'en',
        serviceId,
      })
    ).map((r) => r.versionId)
    expect(withService).toContain(platformEn.versionId)
    expect(withService).toContain(serviceEn.versionId)
    expect(withService).not.toContain(platformYo.versionId)
    const platformOnly = (
      await listAllEligibleMediaAssets({ themeCode: theme, language: 'en' })
    ).map((r) => r.versionId)
    expect(platformOnly).toContain(platformEn.versionId)
    expect(platformOnly).not.toContain(serviceEn.versionId)
    for (const fixture of [platformEn, serviceEn, platformYo]) {
      await setMediaAssetActive(adminId, ctx, fixture.assetId, false)
    }
  }, 120_000)
})

// --- Sacred audio links -----------------------------------------------------

describe('sacred media links', () => {
  it('validates domain, publication, kind, language; voice policy filters candidates', async () => {
    const sacred = await makeSacredVersionFixture({
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
    })
    const humanAudio = await makeEligibleMedia(
      {},
      { language: 'en', sourceType: 'HUMAN_RECORDED' },
    )
    const licensedAudio = await makeEligibleMedia(
      {},
      { language: 'en', sourceType: 'LICENSED' },
    )
    const image = await makeEligibleMedia({ assetKind: 'IMAGE' }, {})
    const yoAudio = await makeEligibleMedia({}, { language: 'yo' })

    // Audio roles reject non-audio; visual reference rejects audio.
    await expectError(() =>
      createSacredMediaLink(adminId, ctx, {
        contentVersionId: sacred.versionId,
        mediaAssetVersionId: image.versionId,
        role: 'PRIMARY_AUDIO',
      }),
    )
    await expectError(() =>
      createSacredMediaLink(adminId, ctx, {
        contentVersionId: sacred.versionId,
        mediaAssetVersionId: humanAudio.versionId,
        role: 'VISUAL_REFERENCE',
      }),
    )
    // Language mismatch rejected.
    await expectError(() =>
      createSacredMediaLink(adminId, ctx, {
        contentVersionId: sacred.versionId,
        mediaAssetVersionId: yoAudio.versionId,
        role: 'PRIMARY_AUDIO',
      }),
    )
    // CM cannot link.
    await expectError(
      () =>
        createSacredMediaLink(cmId, ctx, {
          contentVersionId: sacred.versionId,
          mediaAssetVersionId: humanAudio.versionId,
          role: 'PRIMARY_AUDIO',
        }),
      'forbidden',
    )
    await createSacredMediaLink(adminId, ctx, {
      contentVersionId: sacred.versionId,
      mediaAssetVersionId: humanAudio.versionId,
      role: 'PRIMARY_AUDIO',
    })
    await createSacredMediaLink(adminId, ctx, {
      contentVersionId: sacred.versionId,
      mediaAssetVersionId: licensedAudio.versionId,
      role: 'ALTERNATE_AUDIO',
    })
    // Duplicate refused.
    await expectError(() =>
      createSacredMediaLink(adminId, ctx, {
        contentVersionId: sacred.versionId,
        mediaAssetVersionId: humanAudio.versionId,
        role: 'PRIMARY_AUDIO',
      }),
    )

    // HUMAN_RECORDED_REQUIRED → only the human-recorded candidate.
    const strict = await resolveSacredAudioCandidates(
      sacred.versionId,
      'HUMAN_RECORDED_REQUIRED',
    )
    expect(strict.candidates.length).toBe(1)
    expect(strict.candidates[0].sourceType).toBe('HUMAN_RECORDED')
    // APPROVED_TTS_ALLOWED → any eligible linked human audio.
    const relaxed = await resolveSacredAudioCandidates(
      sacred.versionId,
      'APPROVED_TTS_ALLOWED',
    )
    expect(relaxed.candidates.length).toBe(2)
    // TEXT_ONLY → none required.
    const none = await resolveSacredAudioCandidates(
      sacred.versionId,
      'TEXT_ONLY',
    )
    expect(none.candidates.length).toBe(0)

    // Runtime-disabled linked audio drops out of candidates.
    await setMediaRuntimeEnabled(adminId, ctx, humanAudio.versionId, false)
    const afterDisable = await resolveSacredAudioCandidates(
      sacred.versionId,
      'HUMAN_RECORDED_REQUIRED',
    )
    expect(afterDisable.candidates.length).toBe(0)

    for (const fixture of [humanAudio, licensedAudio, image, yoAudio]) {
      await setMediaAssetActive(adminId, ctx, fixture.assetId, false)
    }
  }, 240_000)

  it('GUIDANCE content and unpublished versions can never be linked', async () => {
    const { createContentItem, createVersion } =
      await import('@/services/spiritual-content')
    const guidance = await createContentItem(cmId, ctx, {
      code: nextCode('G'),
      contentType: 'PREPARATION',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 0,
    })
    createdItemIds.push(guidance.id)
    const guidanceVersion = await createVersion(cmId, ctx, guidance.id, {
      language: 'en',
      title: 'Guidance decoy',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await submitVersionForReview(cmId, ctx, guidanceVersion.id)
    await approveVersion(adminId, ctx, guidanceVersion.id)
    await publishVersion(adminId, ctx, guidanceVersion.id)
    const audio = await makeEligibleMedia({}, { language: 'en' })
    // Published GUIDANCE is still refused — wrong domain.
    const domainError = await expectError(() =>
      createSacredMediaLink(adminId, ctx, {
        contentVersionId: guidanceVersion.id,
        mediaAssetVersionId: audio.versionId,
        role: 'PRIMARY_AUDIO',
      }),
    )
    expect(domainError.message).toContain('sacred runtime')

    // Unpublished (draft) media refused.
    const sacred = await makeSacredVersionFixture({})
    const draftAsset = await makeAsset()
    const draft = await makeVersion(draftAsset, { language: 'en' })
    await expectError(() =>
      createSacredMediaLink(adminId, ctx, {
        contentVersionId: sacred.versionId,
        mediaAssetVersionId: draft.id,
        role: 'PRIMARY_AUDIO',
      }),
    )
    // Unlink works and is audited.
    const link = await createSacredMediaLink(adminId, ctx, {
      contentVersionId: sacred.versionId,
      mediaAssetVersionId: audio.versionId,
      role: 'PRIMARY_AUDIO',
    })
    await removeSacredMediaLink(adminId, ctx, link.id)
    await setMediaAssetActive(adminId, ctx, audio.assetId, false)
  }, 240_000)
})

// --- >500 pagination --------------------------------------------------------

describe('eligible media pagination', () => {
  it('complete enumeration paginates past the 500-row bound with real files', async () => {
    const db = getDb()
    const theme = `T10_BULK_${RUN_KEY}`
    const TOTAL = 520
    // Real (tiny) synthetic files so the per-row byte-hash gate passes.
    const files: Array<{ storageKey: string; sha: string }> = []
    for (let i = 0; i < TOTAL; i += 1) {
      const bytes = syntheticBytes(`bulk-${i}`)
      const { storageKey } = await storage.put(bytes, 'mp3')
      files.push({ storageKey, sha: computeFileSha256(bytes) })
    }
    for (let start = 0; start < TOTAL; start += 130) {
      await db.insert(mediaAssets).values(
        Array.from({ length: Math.min(130, TOTAL - start) }, (_, i) => ({
          publicId: crypto.randomUUID(),
          code: `${CODE_PREFIX}_BLK_${start + i}`,
          assetKind: 'AUDIO' as const,
          scopeType: 'PLATFORM' as const,
          themeCode: theme,
          createdBy: cmId,
        })),
      )
    }
    const assetRows = await db
      .select({ id: mediaAssets.id })
      .from(mediaAssets)
      .where(like(mediaAssets.code, `${CODE_PREFIX}\\_BLK\\_%`))
    expect(assetRows.length).toBe(TOTAL)
    createdAssetIds.push(...assetRows.map((row) => row.id))
    const ordered = [...assetRows].sort((a, b) => a.id - b.id)
    for (let start = 0; start < ordered.length; start += 130) {
      await db.insert(mediaAssetVersions).values(
        ordered.slice(start, start + 130).map((row, i) => ({
          assetId: row.id,
          versionNumber: 1,
          status: 'PUBLISHED' as const,
          sourceType: 'IN_HOUSE' as const,
          mimeType: 'audio/mpeg',
          byteSize: 64,
          storageKey: files[start + i].storageKey,
          fileSha256: files[start + i].sha,
          rightsStatus: 'CLEARED' as const,
          consentStatus: 'NOT_APPLICABLE' as const,
          runtimeEnabled: true,
          publishedAt: new Date(),
          createdBy: cmId,
        })),
      )
    }
    const complete = await listAllEligibleMediaAssets({ themeCode: theme })
    expect(complete.length).toBe(TOTAL)
    const maxVersionId = Math.max(...complete.map((row) => row.versionId))
    expect(complete.some((row) => row.versionId === maxVersionId)).toBe(true)
    // Deactivate the fleet.
    await db
      .update(mediaAssets)
      .set({ active: false })
      .where(
        inArray(
          mediaAssets.id,
          assetRows.map((row) => row.id),
        ),
      )
  }, 240_000)
})

// --- Visual Bibles ----------------------------------------------------------

describe('visual bibles', () => {
  it('full workflow, deterministic hash, and fail-closed corrupted load', async () => {
    // One bible per House.
    const bible = await createVisualBible(cmId, ctx, houseId)
    createdBibleIds.push(bible.id)
    await expectError(() => createVisualBible(cmId, ctx, houseId))

    const rules = [
      {
        category: 'ENVIRONMENT' as const,
        position: 1,
        ruleText: 'Synthetic test rule: riverbank at dawn.',
      },
      {
        category: 'PROHIBITED_IMAGERY' as const,
        position: 2,
        ruleText: 'Synthetic test rule: no modern logos.',
      },
    ]
    const version = await createVisualBibleVersion(cmId, ctx, bible.id, {
      rules,
    })
    // DRAFT editable; duplicate positions refused.
    await expectError(() =>
      updateDraftVisualBibleVersion(cmId, ctx, version.id, {
        rules: [rules[0], { ...rules[1], position: 1 }],
      }),
    )
    await updateDraftVisualBibleVersion(cmId, ctx, version.id, { rules })
    await submitVisualBibleVersion(cmId, ctx, version.id)
    await expectError(() =>
      updateDraftVisualBibleVersion(cmId, ctx, version.id, { rules }),
    )
    await expectError(
      () => approveVisualBibleVersion(cmId, ctx, version.id),
      'forbidden',
    )
    await returnVisualBibleVersion(adminId, ctx, version.id, 'tighten rules')
    await submitVisualBibleVersion(cmId, ctx, version.id)
    await approveVisualBibleVersion(adminId, ctx, version.id)
    const published = await publishVisualBibleVersion(adminId, ctx, version.id)
    expect(published.definitionSha256).toMatch(/^[0-9a-f]{64}$/)

    // Verified loader OK + hash recomputation matches.
    const loaded = await loadPublishedVisualBible(houseId)
    expect(loaded.status).toBe('OK')
    if (loaded.status === 'OK') {
      expect(loaded.rules.length).toBe(2)
      expect(
        computeVisualBibleSha256({
          visualBibleId: bible.id,
          versionNumber: 1,
          rules: loaded.rules,
        }),
      ).toBe(loaded.definitionSha256)
    }

    // Corrupt a published rule directly → loader FAILS CLOSED.
    await getDb()
      .update(visualBibleRules)
      .set({ ruleText: 'tampered rule text' })
      .where(eq(visualBibleRules.bibleVersionId, version.id))
    const corrupted = await loadPublishedVisualBible(houseId)
    expect(corrupted.status).toBe('INTEGRITY_FAILURE')
    // Stored hash unchanged (never auto-healed).
    expect((await loadVisualBibleVersion(version.id)).definitionSha256).toBe(
      published.definitionSha256,
    )
  }, 120_000)
})

// --- Guards & privacy -------------------------------------------------------

describe('guards', () => {
  it('no public media route exists and no route dumps raw HTML', () => {
    const routesDir = join(process.cwd(), 'src', 'routes')
    for (const entry of readdirSync(routesDir)) {
      if (!/\.tsx?$/.test(entry)) continue
      const source = readFileSync(join(routesDir, entry), 'utf8')
      expect(source).not.toContain('dangerouslySetInnerHTML')
      // Media admin pages exist only under /admin; no public media
      // download/serving route is allowed.
      if (!entry.startsWith('admin.')) {
        expect(source).not.toMatch(/storageKey|media_asset|mediaAsset/)
      }
    }
    const routeTree = readFileSync(
      join(process.cwd(), 'src', 'routeTree.gen.ts'),
      'utf8',
    )
    // Every media route lives under /admin — no public /media(...)
    // fullPath may exist.
    expect(routeTree).not.toMatch(/fullPath: '\/media/)
    expect(routeTree).not.toMatch(/fullPath: '\/uploads/)
    expect(routeTree).not.toMatch(/prayer.?room/i)
  })

  it('audit metadata never contains media bytes, consent references or notes', async () => {
    const rows = await getDb()
      .select()
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.actorUserId, createdUserIds),
          like(auditLogs.action, 'media.%'),
        ),
      )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const metadata = JSON.stringify(row.metadataJson ?? {})
      expect(metadata).not.toContain('synthetic-test-media-bytes')
      expect(metadata).not.toContain('synthetic consent dossier reference')
      expect(metadata).not.toContain('synthetic withdrawal reason')
      expect(metadata).not.toContain('base64')
    }
  })

  it('Step 10 modules call no AI/TTS/generation/render providers', () => {
    const files = [
      'src/services/media-assets.ts',
      'src/services/media-asset-actions.ts',
      'src/services/visual-bibles.ts',
      'src/services/visual-bible-actions.ts',
      'src/providers/media/storage.ts',
      'src/db/schema/media.ts',
      'src/routes/admin.media-assets.index.tsx',
      'src/routes/admin.media-assets.$id.tsx',
      'src/routes/admin.visual-bibles.index.tsx',
      'src/routes/admin.visual-bibles.$id.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      // Provenance ENUM VALUES may name external origins; actual SDK
      // imports, API hosts or generation calls are forbidden.
      expect(source).not.toMatch(
        /https?:\/\/[^'"\s]*(kling|openart|elevenlabs|openai|anthropic)/i,
      )
      expect(source).not.toMatch(
        /import[^\n]*(remotion|ffmpeg|elevenlabs|openai|@anthropic)/i,
      )
      expect(source).not.toMatch(
        /texttospeech|speechSynthesis|generateImage|generateVideo|cloneVoice/i,
      )
    }
  })
})
