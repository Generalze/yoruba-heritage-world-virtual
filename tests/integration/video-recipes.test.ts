import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  auditLogs,
  mediaAssetVersions,
  mediaAssets,
  prayerSessionTemplateSlots,
  prayerSessionTemplateVersions,
  prayerSessionTemplates,
  prayerTemplateForbiddenPairs,
  prayerTemplateSlotPins,
  prayerTemplateSlotScopes,
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
import { assignRoleToUser } from '@/auth/rbac'
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
  approveTemplateVersion,
  createPrayerTemplate,
  createTemplateVersion,
  publishTemplateVersion,
  submitTemplateVersion,
} from '@/services/prayer-templates'
import {
  LocalMediaStorageProvider,
  resetMediaStorageForTests,
  setMediaStorageForTests,
} from '@/providers/media/storage'
import {
  approveMediaVersion,
  createMediaAsset,
  createMediaVersion,
  createSacredMediaLink,
  publishMediaVersion,
  removeSacredMediaLink,
  resolveSacredAudioCandidates,
  setMediaRightsStatus,
  setMediaRuntimeEnabled,
  submitMediaVersion,
} from '@/services/media-assets'
import {
  approveVisualBibleVersion,
  createVisualBible,
  createVisualBibleVersion,
  publishVisualBibleVersion,
  submitVisualBibleVersion,
} from '@/services/visual-bibles'
import {
  VideoRecipeError,
  buildValidatedVideoRecipe,
  computeRecipeSha256,
  validateVideoRecipe,
} from '@/services/video-recipes'
import type { SlotInput } from '@/services/prayer-templates'
import type { SacredProfileInput } from '@/services/sacred-content'
import type { MediaVersionMetadataInput } from '@/services/media-assets'

/**
 * Step 11 integration tests: recipe determinism, audio/visual binding,
 * generation descriptors, Visual Bible gating, SILENCE preservation,
 * validator fail-closed behavior, payload privacy and later-phase
 * guards. All fixture text/bytes are synthetic.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `recipe test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const createdItemIds: Array<number> = []
const createdAssetIds: Array<number> = []
const createdTemplateIds: Array<number> = []
const createdBibleIds: Array<number> = []

let adminId: number
let cmId: number
let houseId: number
let house2Id: number
let servicePool: Array<number> = []
let house2ServiceId: number
let storageRoot: string
let storage: LocalMediaStorageProvider
let serviceCursor = 0

const RUN_KEY = crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')
const CODE_PREFIX = `T11_${RUN_KEY}`
let codeCounter = 0
function nextCode(prefix = 'X'): string {
  codeCounter += 1
  return `${CODE_PREFIX}_${prefix}_${codeCounter}`
}

/** Each scenario gets its own service so templates never interfere. */
function nextService(): number {
  const id = servicePool.at(serviceCursor)
  serviceCursor += 1
  if (id == null) throw new Error('service pool exhausted — enlarge fixture')
  return id
}

function syntheticBytes(marker: string = crypto.randomUUID()): Uint8Array {
  return new TextEncoder().encode(`synthetic-test-media-bytes ${marker}`)
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s11-${crypto.randomUUID()}@test.local`,
      preferredName: 'S11 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role) await assignRoleToUser(result.user.id, role)
  return result.user.id
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
    voicePolicy: 'TEXT_ONLY',
    externalAiPolicy: 'METADATA_ONLY',
    accessPolicy: 'PRAYER_ROOM_PRIVATE',
    ...overrides,
  }
}

async function makeEligibleSacred(options: {
  themeCode: string
  voicePolicy?: 'HUMAN_RECORDED_REQUIRED' | 'APPROVED_TTS_ALLOWED' | 'TEXT_ONLY'
  externalAiPolicy?:
    'NO_EXTERNAL_AI' | 'METADATA_ONLY' | 'APPROVED_TEXT_CONTEXT'
  language?: 'en' | 'yo'
  contentType?: 'PRAYER' | 'CHANT'
}): Promise<{ itemId: number; versionId: number }> {
  const item = await createSacredContentItem(cmId, ctx, {
    code: nextCode('SC'),
    contentType: options.contentType ?? 'PRAYER',
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
    sacredProfile({
      themeCode: options.themeCode,
      voicePolicy: options.voicePolicy ?? 'TEXT_ONLY',
      externalAiPolicy: options.externalAiPolicy ?? 'METADATA_ONLY',
    }),
  )
  await submitVersionForReview(cmId, ctx, version.id)
  await approveVersion(adminId, ctx, version.id)
  await publishVersion(adminId, ctx, version.id)
  await setSacredRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setSacredRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setSacredRuntimeEnabled(adminId, ctx, version.id, true)
  return { itemId: item.id, versionId: version.id }
}

function filterSlot(overrides: Partial<SlotInput> = {}): SlotInput {
  return {
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
    allowedScopes: ['PLATFORM'],
    pinnedContentVersionIds: [],
    ...overrides,
  }
}

function silenceSlot(position: number, seconds: number): SlotInput {
  return {
    slotKey: `STILL_${position}`,
    position,
    slotKind: 'SILENCE',
    minSelect: 0,
    maxSelect: 0,
    contentType: null,
    selectorMode: null,
    themeCode: null,
    variantKind: null,
    silenceDurationSeconds: seconds,
    allowedScopes: [],
    pinnedContentVersionIds: [],
  }
}

/** SERVICE-scoped published template for a dedicated service. */
async function makeServiceTemplate(
  serviceId: number,
  slots: Array<SlotInput>,
  language: 'en' | 'yo' = 'en',
): Promise<number> {
  const template = await createPrayerTemplate(cmId, ctx, {
    code: nextCode('TPL'),
    scopeType: 'SERVICE',
    sacredHouseId: null,
    serviceId,
  })
  createdTemplateIds.push(template.id)
  const version = await createTemplateVersion(cmId, ctx, template.id, {
    language,
    priority: 0,
    selectionWeight: 1,
    targetMinSeconds: 30,
    targetMaxSeconds: 600,
    slots,
    forbiddenPairs: [],
  })
  await submitTemplateVersion(cmId, ctx, version.id)
  await approveTemplateVersion(adminId, ctx, version.id)
  await publishTemplateVersion(adminId, ctx, version.id)
  return template.id
}

function mediaMeta(
  overrides: Partial<MediaVersionMetadataInput> = {},
): MediaVersionMetadataInput {
  return {
    sourceType: 'HUMAN_RECORDED',
    language: null,
    durationSeconds: 20,
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

async function makeEligibleMedia(options: {
  assetKind?: 'AUDIO' | 'IMAGE' | 'VIDEO'
  scopeType?: 'PLATFORM' | 'SACRED_HOUSE' | 'SERVICE'
  serviceId?: number
  sacredHouseId?: number
  contentType?: 'PRAYER' | 'BLESSING' | null
  themeCode?: string | null
  language?: 'en' | 'yo' | null
  sourceType?: MediaVersionMetadataInput['sourceType']
}): Promise<{ assetId: number; versionId: number }> {
  const assetKind = options.assetKind ?? 'AUDIO'
  const asset = await createMediaAsset(cmId, ctx, {
    code: nextCode('MA'),
    assetKind,
    scopeType: options.scopeType ?? 'PLATFORM',
    sacredHouseId: options.sacredHouseId ?? null,
    serviceId: options.serviceId ?? null,
    contentType: options.contentType ?? null,
    themeCode: options.themeCode ?? null,
  })
  createdAssetIds.push(asset.id)
  const version = await createMediaVersion(
    cmId,
    ctx,
    asset.id,
    syntheticBytes(),
    MIME_BY_KIND[assetKind],
    mediaMeta({
      language: options.language ?? null,
      sourceType: options.sourceType ?? 'HUMAN_RECORDED',
    }),
  )
  await submitMediaVersion(cmId, ctx, version.id)
  await approveMediaVersion(adminId, ctx, version.id)
  await publishMediaVersion(adminId, ctx, version.id)
  await setMediaRightsStatus(adminId, ctx, version.id, 'PENDING_REVIEW')
  await setMediaRightsStatus(adminId, ctx, version.id, 'CLEARED')
  await setMediaRuntimeEnabled(adminId, ctx, version.id, true)
  return { assetId: asset.id, versionId: version.id }
}

async function linkMedia(
  contentVersionId: number,
  mediaAssetVersionId: number,
  role: 'PRIMARY_AUDIO' | 'ALTERNATE_AUDIO' | 'VISUAL_REFERENCE',
): Promise<void> {
  await createSacredMediaLink(adminId, ctx, {
    contentVersionId,
    mediaAssetVersionId,
    role,
  })
}

beforeAll(async () => {
  storageRoot = mkdtempSync(join(tmpdir(), 'yhw-recipe-test-'))
  storage = new LocalMediaStorageProvider(storageRoot)
  setMediaStorageForTests(storage)

  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'T11\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'T11\\_%'))
  await db
    .update(mediaAssets)
    .set({ active: false })
    .where(like(mediaAssets.code, 'T11\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T11H_${key}`.toUpperCase(),
    name: `T11 House ${key}`,
    slug: `t11h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  const house2Insert = await db.insert(sacredHouses).values({
    code: `T11J_${key}`.toUpperCase(),
    name: `T11 Second House ${key}`,
    slug: `t11j-${key}`,
    status: 'PUBLISHED',
  })
  house2Id = house2Insert[0].insertId
  // A pool of dedicated services on the main House (one per scenario)
  // plus one on the second (bible-less) House.
  servicePool = []
  for (let i = 0; i < 22; i += 1) {
    const inserted = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `T11S${i}_${key}`.toUpperCase(),
      name: `T11 Service ${i} ${key}`,
      slug: `t11s${i}-${key}`,
      serviceStatus: 'PUBLISHED',
      durationMinutes: 60,
      priceMinor: 500_000,
      currency: 'NGN',
    })
    servicePool.push(inserted[0].insertId)
  }
  const h2svc = await db.insert(services).values({
    sacredHouseId: house2Id,
    code: `T11Z_${key}`.toUpperCase(),
    name: `T11 H2 Service ${key}`,
    slug: `t11z-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  house2ServiceId = h2svc[0].insertId

  // Published Visual Bible for the MAIN House only.
  const bible = await createVisualBible(cmId, ctx, houseId)
  createdBibleIds.push(bible.id)
  const bibleVersion = await createVisualBibleVersion(cmId, ctx, bible.id, {
    rules: [
      {
        category: 'ENVIRONMENT',
        position: 1,
        ruleText: 'Synthetic test rule: riverside at dawn.',
      },
      {
        category: 'PROHIBITED_IMAGERY',
        position: 2,
        ruleText: 'Synthetic test rule: no modern logos.',
      },
    ],
  })
  await submitVisualBibleVersion(cmId, ctx, bibleVersion.id)
  await approveVisualBibleVersion(adminId, ctx, bibleVersion.id)
  await publishVisualBibleVersion(adminId, ctx, bibleVersion.id)
})

afterAll(async () => {
  const db = getDb()
  // Templates
  if (createdTemplateIds.length > 0) {
    const versionRows = await db
      .select({ id: prayerSessionTemplateVersions.id })
      .from(prayerSessionTemplateVersions)
      .where(
        inArray(prayerSessionTemplateVersions.templateId, createdTemplateIds),
      )
    const versionIds = versionRows.map((row) => row.id)
    if (versionIds.length > 0) {
      const slotRows = await db
        .select({ id: prayerSessionTemplateSlots.id })
        .from(prayerSessionTemplateSlots)
        .where(
          inArray(prayerSessionTemplateSlots.templateVersionId, versionIds),
        )
      const slotIds = slotRows.map((row) => row.id)
      if (slotIds.length > 0) {
        await db
          .delete(prayerTemplateSlotPins)
          .where(inArray(prayerTemplateSlotPins.slotId, slotIds))
        await db
          .delete(prayerTemplateSlotScopes)
          .where(inArray(prayerTemplateSlotScopes.slotId, slotIds))
        await db
          .delete(prayerSessionTemplateSlots)
          .where(inArray(prayerSessionTemplateSlots.id, slotIds))
      }
      await db
        .delete(prayerTemplateForbiddenPairs)
        .where(
          inArray(prayerTemplateForbiddenPairs.templateVersionId, versionIds),
        )
      await db
        .delete(prayerSessionTemplateVersions)
        .where(inArray(prayerSessionTemplateVersions.id, versionIds))
    }
    await db
      .delete(prayerSessionTemplates)
      .where(inArray(prayerSessionTemplates.id, createdTemplateIds))
  }
  // Media
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
  // Bibles
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
  // Sacred content
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
  for (const house of [houseId, house2Id]) {
    if (!house) continue
    await db.delete(services).where(eq(services.sacredHouseId, house))
    await db.delete(sacredHouses).where(eq(sacredHouses.id, house))
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

// ----------------------------------------------------------------------------

describe('recipe engine', () => {
  it('derives the House from the Service and propagates NO_VALID_TEMPLATE', async () => {
    let thrown: unknown = null
    try {
      await buildValidatedVideoRecipe({
        serviceId: 999_999_999,
        language: 'en',
        variationSeed: 'x',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(VideoRecipeError)

    const emptyService = nextService()
    const unavailable = await buildValidatedVideoRecipe({
      serviceId: emptyService,
      language: 'en',
      variationSeed: 'seed',
    })
    expect(unavailable.status).toBe('RECIPE_UNAVAILABLE')
    if (unavailable.status === 'RECIPE_UNAVAILABLE') {
      expect(unavailable.reasons).toEqual(['NO_VALID_TEMPLATE'])
    }
  }, 120_000)

  it('same seed → byte-identical recipe; different seeds vary media; payload carries no secrets', async () => {
    const serviceId = nextService()
    const theme = `T11_DET_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    // Four platform visuals so seeds can vary the pick.
    const visuals = []
    for (let i = 0; i < 4; i += 1) {
      visuals.push(
        await makeEligibleMedia({
          assetKind: 'IMAGE',
          contentType: 'PRAYER',
          themeCode: theme,
        }),
      )
    }
    const recipe = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 'det-seed',
    })
    expect(recipe.status).toBe('RECIPE_READY')
    if (recipe.status !== 'RECIPE_READY') return
    expect(recipe.sacredHouseId).toBe(houseId)
    expect(recipe.recipeSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(recipe)).toBe(true)
    expect(Object.isFrozen(recipe.segments[0])).toBe(true)

    const again = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 'det-seed',
    })
    expect(JSON.stringify(again)).toBe(JSON.stringify(recipe))

    const seen = new Set<number>()
    for (let seed = 0; seed < 12; seed += 1) {
      const variant = await buildValidatedVideoRecipe({
        serviceId,
        language: 'en',
        variationSeed: `vary-${seed}`,
      })
      if (variant.status === 'RECIPE_READY') {
        const visual = variant.segments[0].visual
        if (visual) seen.add(visual.mediaAssetVersionId)
      }
    }
    expect(seen.size).toBeGreaterThan(1)
    for (const id of seen) {
      expect(visuals.map((v) => v.versionId)).toContain(id)
    }

    // Privacy: no sacred body, storage keys, consent refs, PII.
    const payload = JSON.stringify(recipe)
    expect(payload).not.toContain('Integration-test prayer block')
    expect(payload).not.toContain('storageKey')
    expect(payload).not.toMatch(/[a-f0-9]{2}\/[a-f0-9]{32}\.[a-z0-9]{2,5}/)
    expect(payload).not.toContain('consent')
    expect(payload).not.toContain('@test.local')
  }, 240_000)

  it('binds audio per authoritative voice policy', async () => {
    // TEXT_ONLY → audioMode NONE.
    const svcText = nextService()
    const themeText = `T11_AT_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: themeText, voicePolicy: 'TEXT_ONLY' })
    await makeServiceTemplate(svcText, [filterSlot({ themeCode: themeText })])
    const visual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
    })
    const textOnly = await buildValidatedVideoRecipe({
      serviceId: svcText,
      language: 'en',
      variationSeed: 's',
    })
    expect(textOnly.status).toBe('RECIPE_READY')
    if (textOnly.status === 'RECIPE_READY') {
      expect(textOnly.segments[0].audioMode).toBe('NONE')
      expect(textOnly.segments[0].audio).toBeNull()
    }

    // HUMAN_RECORDED_REQUIRED without audio → fails closed.
    const svcHuman = nextService()
    const themeHuman = `T11_AH_${RUN_KEY}`
    const humanSacred = await makeEligibleSacred({
      themeCode: themeHuman,
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
    })
    await makeServiceTemplate(svcHuman, [filterSlot({ themeCode: themeHuman })])
    const failed = await buildValidatedVideoRecipe({
      serviceId: svcHuman,
      language: 'en',
      variationSeed: 's',
    })
    expect(failed.status).toBe('RECIPE_UNAVAILABLE')
    if (failed.status === 'RECIPE_UNAVAILABLE') {
      expect(
        failed.reasons.some((reason) => reason.startsWith('no_human_audio')),
      ).toBe(true)
    }
    // With linked human audio → succeeds deterministically.
    const humanAudio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      language: 'en',
      sourceType: 'HUMAN_RECORDED',
    })
    await linkMedia(
      humanSacred.versionId,
      humanAudio.versionId,
      'PRIMARY_AUDIO',
    )
    const succeeded = await buildValidatedVideoRecipe({
      serviceId: svcHuman,
      language: 'en',
      variationSeed: 's',
    })
    expect(succeeded.status).toBe('RECIPE_READY')
    if (succeeded.status === 'RECIPE_READY') {
      expect(succeeded.segments[0].audioMode).toBe('HUMAN_RECORDED')
      expect(succeeded.segments[0].audio?.mediaAssetVersionId).toBe(
        humanAudio.versionId,
      )
      // Audio duration drives the estimate.
      expect(succeeded.segments[0].durationSeconds).toBe(20)
    }

    // APPROVED_TTS_ALLOWED: prefers human audio; else TTS_ALLOWED_PENDING.
    const svcTts = nextService()
    const themeTts = `T11_ATT_${RUN_KEY}`
    const ttsSacred = await makeEligibleSacred({
      themeCode: themeTts,
      voicePolicy: 'APPROVED_TTS_ALLOWED',
    })
    await makeServiceTemplate(svcTts, [filterSlot({ themeCode: themeTts })])
    const pending = await buildValidatedVideoRecipe({
      serviceId: svcTts,
      language: 'en',
      variationSeed: 's',
    })
    expect(pending.status).toBe('RECIPE_READY')
    if (pending.status === 'RECIPE_READY') {
      expect(pending.segments[0].audioMode).toBe('TTS_ALLOWED_PENDING')
      expect(pending.segments[0].audio).toBeNull()
    }
    await linkMedia(
      ttsSacred.versionId,
      humanAudio.versionId,
      'ALTERNATE_AUDIO',
    )
    const preferred = await buildValidatedVideoRecipe({
      serviceId: svcTts,
      language: 'en',
      variationSeed: 's',
    })
    if (preferred.status === 'RECIPE_READY') {
      expect(preferred.segments[0].audioMode).toBe('LINKED_HUMAN_AUDIO')
      expect(preferred.segments[0].audio?.mediaAssetVersionId).toBe(
        humanAudio.versionId,
      )
    }
    void visual
  }, 240_000)

  it('prefers linked visuals, then scoped library media; enforces scope and exact language', async () => {
    const serviceId = nextService()
    const theme = `T11_VIS_${RUN_KEY}`
    const sacred = await makeEligibleSacred({ themeCode: theme })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])

    // Library media at three scopes + wrong-language + unrelated service.
    const platformVisual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    const serviceVisual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      scopeType: 'SERVICE',
      serviceId,
      contentType: 'PRAYER',
      themeCode: theme,
    })
    const yoVisual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
      language: 'yo',
    })
    const unrelatedService = nextService()
    const unrelatedVisual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      scopeType: 'SERVICE',
      serviceId: unrelatedService,
      contentType: 'PRAYER',
      themeCode: theme,
    })

    // SERVICE-scoped media beats PLATFORM; wrong-language and
    // unrelated-service media are impossible.
    const scoped = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 'scope-seed',
    })
    expect(scoped.status).toBe('RECIPE_READY')
    if (scoped.status === 'RECIPE_READY') {
      const visual = scoped.segments[0].visual
      expect(visual?.mediaAssetVersionId).toBe(serviceVisual.versionId)
      expect(visual?.scopeType).toBe('SERVICE')
      expect(visual?.mediaAssetVersionId).not.toBe(yoVisual.versionId)
      expect(visual?.mediaAssetVersionId).not.toBe(unrelatedVisual.versionId)
      expect(scoped.segments[0].visualMode).toBe('LIBRARY_MEDIA')
    }

    // A linked VISUAL_REFERENCE outranks every library candidate.
    const linkedVisual = await makeEligibleMedia({
      assetKind: 'VIDEO',
      contentType: 'PRAYER',
    })
    await linkMedia(
      sacred.versionId,
      linkedVisual.versionId,
      'VISUAL_REFERENCE',
    )
    const linked = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 'scope-seed',
    })
    if (linked.status === 'RECIPE_READY') {
      expect(linked.segments[0].visualMode).toBe('LINKED_REFERENCE')
      expect(linked.segments[0].visual?.mediaAssetVersionId).toBe(
        linkedVisual.versionId,
      )
    }
    void platformVisual
  }, 240_000)

  it('emits generation descriptors only with a verified Visual Bible and per external AI policy', async () => {
    // NO_EXTERNAL_AI with no visual → fails closed.
    const svcNoAi = nextService()
    const themeNoAi = `T11_GNA_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: themeNoAi,
      externalAiPolicy: 'NO_EXTERNAL_AI',
      contentType: 'CHANT',
    })
    await makeServiceTemplate(svcNoAi, [
      filterSlot({ themeCode: themeNoAi, contentType: 'CHANT' }),
    ])
    const refused = await buildValidatedVideoRecipe({
      serviceId: svcNoAi,
      language: 'en',
      variationSeed: 's',
    })
    expect(refused.status).toBe('RECIPE_UNAVAILABLE')
    if (refused.status === 'RECIPE_UNAVAILABLE') {
      expect(
        refused.reasons.some((reason) => reason.startsWith('no_visual_no_ai')),
      ).toBe(true)
    }

    // METADATA_ONLY → GENERATION_ALLOWED descriptor with bible hash.
    const svcMeta = nextService()
    const themeMeta = `T11_GMD_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: themeMeta,
      externalAiPolicy: 'METADATA_ONLY',
      contentType: 'CHANT',
    })
    await makeServiceTemplate(svcMeta, [
      filterSlot({ themeCode: themeMeta, contentType: 'CHANT' }),
    ])
    const descriptor = await buildValidatedVideoRecipe({
      serviceId: svcMeta,
      language: 'en',
      variationSeed: 's',
    })
    expect(descriptor.status).toBe('RECIPE_READY')
    if (descriptor.status === 'RECIPE_READY') {
      const segment = descriptor.segments[0]
      expect(segment.visualMode).toBe('GENERATION_ALLOWED')
      expect(segment.generation?.visualBibleSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(segment.generation?.textContextAllowed).toBe(false)
      expect(descriptor.visualBible?.definitionSha256).toBe(
        segment.generation?.visualBibleSha256,
      )
    }

    // APPROVED_TEXT_CONTEXT → allowed flag true, but NO body in recipe.
    const svcTextCtx = nextService()
    const themeTextCtx = `T11_GTC_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: themeTextCtx,
      externalAiPolicy: 'APPROVED_TEXT_CONTEXT',
      contentType: 'CHANT',
    })
    await makeServiceTemplate(svcTextCtx, [
      filterSlot({ themeCode: themeTextCtx, contentType: 'CHANT' }),
    ])
    const textCtx = await buildValidatedVideoRecipe({
      serviceId: svcTextCtx,
      language: 'en',
      variationSeed: 's',
    })
    expect(textCtx.status).toBe('RECIPE_READY')
    if (textCtx.status === 'RECIPE_READY') {
      expect(textCtx.segments[0].generation?.textContextAllowed).toBe(true)
      expect(JSON.stringify(textCtx)).not.toContain(
        'Integration-test prayer block',
      )
    }

    // Second House has NO Visual Bible → descriptor impossible.
    const themeH2 = `T11_GH2_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: themeH2,
      externalAiPolicy: 'METADATA_ONLY',
      contentType: 'CHANT',
    })
    await makeServiceTemplate(house2ServiceId, [
      filterSlot({ themeCode: themeH2, contentType: 'CHANT' }),
    ])
    const noBible = await buildValidatedVideoRecipe({
      serviceId: house2ServiceId,
      language: 'en',
      variationSeed: 's',
    })
    expect(noBible.status).toBe('RECIPE_UNAVAILABLE')
    if (noBible.status === 'RECIPE_UNAVAILABLE') {
      expect(noBible.reasons).toContain('visual_bible_not_found')
    }

    // Corrupted bible → fails closed at build time (restored after).
    const bibleRule = (
      await getDb()
        .select()
        .from(visualBibleRules)
        .where(eq(visualBibleRules.position, 1))
        .orderBy(visualBibleRules.id)
        .limit(50)
    ).find((rule) => rule.ruleText.includes('riverside at dawn'))
    expect(bibleRule).toBeDefined()
    await getDb()
      .update(visualBibleRules)
      .set({ ruleText: 'tampered rule' })
      .where(eq(visualBibleRules.id, bibleRule!.id))
    const corrupted = await buildValidatedVideoRecipe({
      serviceId: svcMeta,
      language: 'en',
      variationSeed: 's',
    })
    expect(corrupted.status).toBe('RECIPE_UNAVAILABLE')
    if (corrupted.status === 'RECIPE_UNAVAILABLE') {
      expect(corrupted.reasons).toContain('visual_bible_integrity_failure')
    }
    await getDb()
      .update(visualBibleRules)
      .set({ ruleText: bibleRule!.ruleText })
      .where(eq(visualBibleRules.id, bibleRule!.id))
  }, 240_000)

  it('preserves SILENCE segments exactly with HOLD_PREVIOUS', async () => {
    const serviceId = nextService()
    const theme = `T11_SIL_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme }),
      silenceSlot(2, 17),
    ])
    const recipe = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 's',
    })
    expect(recipe.status).toBe('RECIPE_READY')
    if (recipe.status === 'RECIPE_READY') {
      const silence = recipe.segments.find((s) => s.kind === 'SILENCE')
      expect(silence).toBeDefined()
      expect(silence!.durationSeconds).toBe(17)
      expect(silence!.visualMode).toBe('HOLD_PREVIOUS')
      expect(silence!.contentVersionId).toBeNull()
      expect(silence!.audio).toBeNull()
      expect(recipe.totalEstimatedSeconds).toBeGreaterThanOrEqual(17)
    }
  }, 120_000)
})

describe('recipe validator', () => {
  it('fails closed on every upstream authority change and on tampering', async () => {
    const serviceId = nextService()
    const theme = `T11_VAL_${RUN_KEY}`
    const sacred = await makeEligibleSacred({
      themeCode: theme,
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
    })
    const audio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      language: 'en',
      sourceType: 'HUMAN_RECORDED',
    })
    await linkMedia(sacred.versionId, audio.versionId, 'PRIMARY_AUDIO')
    const visual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const recipe = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 'validate-seed',
    })
    expect(recipe.status).toBe('RECIPE_READY')
    if (recipe.status !== 'RECIPE_READY') return
    expect(recipe.segments[0].visual?.mediaAssetVersionId).toBe(
      visual.versionId,
    )
    expect((await validateVideoRecipe(recipe)).status).toBe('VALID')

    // Tampered copy → recipe_hash_mismatch.
    const tampered = JSON.parse(JSON.stringify(recipe)) as typeof recipe
    ;(tampered.segments[0] as { durationSeconds: number }).durationSeconds = 99
    const tamperResult = await validateVideoRecipe(tampered)
    expect(tamperResult.status).toBe('INVALID')
    if (tamperResult.status === 'INVALID') {
      expect(tamperResult.reasons).toContain('recipe_hash_mismatch')
    }

    // Media runtime disable → invalid immediately; restore.
    await setMediaRuntimeEnabled(adminId, ctx, visual.versionId, false)
    let result = await validateVideoRecipe(recipe)
    expect(result.status).toBe('INVALID')
    if (result.status === 'INVALID') {
      expect(
        result.reasons.some((reason) => reason.startsWith('visual_ineligible')),
      ).toBe(true)
    }
    await setMediaRuntimeEnabled(adminId, ctx, visual.versionId, true)

    // Media rights withdrawal → invalid; then back to cleared.
    await setMediaRightsStatus(
      adminId,
      ctx,
      audio.versionId,
      'WITHDRAWN',
      'synthetic media withdrawal',
    )
    result = await validateVideoRecipe(recipe)
    expect(result.status).toBe('INVALID')
    if (result.status === 'INVALID') {
      expect(
        result.reasons.some((reason) => reason.startsWith('audio_ineligible')),
      ).toBe(true)
    }
    await setMediaRightsStatus(adminId, ctx, audio.versionId, 'PENDING_REVIEW')
    await setMediaRightsStatus(adminId, ctx, audio.versionId, 'CLEARED')

    // Media file corruption → invalid (hash mismatch inside eligibility).
    const audioRow = (
      await getDb()
        .select()
        .from(mediaAssetVersions)
        .where(eq(mediaAssetVersions.id, audio.versionId))
        .limit(1)
    ).at(0)!
    const originalBytes = await storage.get(audioRow.storageKey)
    await writeFile(
      join(storageRoot, audioRow.storageKey),
      syntheticBytes('corrupted'),
    )
    result = await validateVideoRecipe(recipe)
    expect(result.status).toBe('INVALID')
    await writeFile(join(storageRoot, audioRow.storageKey), originalBytes!)

    // Sacred content rights withdrawal → invalid.
    await setSacredRightsStatus(
      adminId,
      ctx,
      sacred.versionId,
      'WITHDRAWN',
      'synthetic sacred withdrawal',
    )
    result = await validateVideoRecipe(recipe)
    expect(result.status).toBe('INVALID')
    if (result.status === 'INVALID') {
      expect(
        result.reasons.some((reason) =>
          reason.startsWith('content_ineligible'),
        ),
      ).toBe(true)
    }
    await setSacredRightsStatus(
      adminId,
      ctx,
      sacred.versionId,
      'PENDING_REVIEW',
    )
    await setSacredRightsStatus(adminId, ctx, sacred.versionId, 'CLEARED')
    expect((await validateVideoRecipe(recipe)).status).toBe('VALID')

    // Template definition corruption → invalid, never healed.
    await getDb()
      .update(prayerSessionTemplateSlots)
      .set({ minSelect: 0 })
      .where(
        eq(
          prayerSessionTemplateSlots.templateVersionId,
          recipe.templateVersionId,
        ),
      )
    result = await validateVideoRecipe(recipe)
    expect(result.status).toBe('INVALID')
    if (result.status === 'INVALID') {
      expect(result.reasons).toContain('template_definition_corrupted')
    }
  }, 240_000)

  it('a generation-descriptor recipe is invalidated by Visual Bible corruption', async () => {
    const serviceId = nextService()
    const theme = `T11_VBV_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: theme,
      externalAiPolicy: 'METADATA_ONLY',
      contentType: 'CHANT',
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'CHANT' }),
    ])
    const recipe = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 's',
    })
    expect(recipe.status).toBe('RECIPE_READY')
    if (recipe.status !== 'RECIPE_READY') return
    expect(recipe.visualBible).not.toBeNull()
    expect((await validateVideoRecipe(recipe)).status).toBe('VALID')

    const bibleRule = (
      await getDb()
        .select()
        .from(visualBibleRules)
        .where(
          eq(visualBibleRules.bibleVersionId, recipe.visualBible!.versionId),
        )
        .orderBy(visualBibleRules.position)
        .limit(1)
    ).at(0)!
    await getDb()
      .update(visualBibleRules)
      .set({ ruleText: 'tampered again' })
      .where(eq(visualBibleRules.id, bibleRule.id))
    const result = await validateVideoRecipe(recipe)
    expect(result.status).toBe('INVALID')
    if (result.status === 'INVALID') {
      expect(result.reasons).toContain('visual_bible_integrity_failure')
    }
    await getDb()
      .update(visualBibleRules)
      .set({ ruleText: bibleRule.ruleText })
      .where(eq(visualBibleRules.id, bibleRule.id))
    expect((await validateVideoRecipe(recipe)).status).toBe('VALID')
  }, 120_000)
})

describe('guards', () => {
  it('Step 11 modules call no AI/TTS/generation/render providers and no job system', () => {
    const files = [
      'src/services/video-recipes.ts',
      'src/services/video-recipe-actions.ts',
      'src/routes/admin.video-recipes.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(
        /https?:\/\/[^'"\s]*(kling|openart|elevenlabs|openai|anthropic)/i,
      )
      expect(source).not.toMatch(
        /import[^\n]*(remotion|ffmpeg|elevenlabs|openai|@anthropic|bullmq|worker_threads)/i,
      )
      expect(source).not.toMatch(
        /texttospeech|speechSynthesis|generateImage|generateVideo|cloneVoice|renderVideo/i,
      )
      expect(source).not.toMatch(/Math\.random\s*\(/)
      expect(source).not.toMatch(/Date\.now\s*\(/)
    }
    const routesDir = join(process.cwd(), 'src', 'routes')
    for (const entry of readdirSync(routesDir)) {
      if (!/\.tsx?$/.test(entry)) continue
      const source = readFileSync(join(routesDir, entry), 'utf8')
      expect(source).not.toContain('dangerouslySetInnerHTML')
    }
    const routeTree = readFileSync(
      join(process.cwd(), 'src', 'routeTree.gen.ts'),
      'utf8',
    )
    expect(routeTree).not.toMatch(/prayer.?room/i)
    expect(routeTree).not.toMatch(/fullPath: '\/video/)
  })
})

// --- Step 11 hardening regressions ------------------------------------------

describe('recipe hardening', () => {
  it('linked audio must be applicable to the context and language', async () => {
    const serviceId = nextService()
    const unrelatedService = nextService()
    const theme = `T11_HAC_${RUN_KEY}`
    const sacred = await makeEligibleSacred({
      themeCode: theme,
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
    })
    await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
      themeCode: theme,
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])

    // Only audio scoped to an UNRELATED service + a yo-language audio:
    // HUMAN_RECORDED_REQUIRED must fail closed.
    const unrelatedAudio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      scopeType: 'SERVICE',
      serviceId: unrelatedService,
      language: 'en',
      sourceType: 'HUMAN_RECORDED',
    })
    await linkMedia(sacred.versionId, unrelatedAudio.versionId, 'PRIMARY_AUDIO')
    const failed = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 's',
    })
    expect(failed.status).toBe('RECIPE_UNAVAILABLE')
    if (failed.status === 'RECIPE_UNAVAILABLE') {
      expect(
        failed.reasons.some((reason) => reason.startsWith('no_human_audio')),
      ).toBe(true)
    }

    // A House-scoped applicable audio resolves — and the READY recipe
    // passes its own validator (no out-of-context self-invalidation).
    const houseAudio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      scopeType: 'SACRED_HOUSE',
      sacredHouseId: houseId,
      language: 'en',
      sourceType: 'HUMAN_RECORDED',
    })
    await linkMedia(sacred.versionId, houseAudio.versionId, 'ALTERNATE_AUDIO')
    const ready = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 's',
    })
    expect(ready.status).toBe('RECIPE_READY')
    if (ready.status === 'RECIPE_READY') {
      expect(ready.segments[0].audio?.mediaAssetVersionId).toBe(
        houseAudio.versionId,
      )
      expect((await validateVideoRecipe(ready)).status).toBe('VALID')
    }

    // APPROVED_TTS_ALLOWED with only out-of-context audio → PENDING.
    const svcTts = nextService()
    const themeTts = `T11_HTC_${RUN_KEY}`
    const ttsSacred = await makeEligibleSacred({
      themeCode: themeTts,
      voicePolicy: 'APPROVED_TTS_ALLOWED',
    })
    await linkMedia(
      ttsSacred.versionId,
      unrelatedAudio.versionId,
      'PRIMARY_AUDIO',
    )
    await makeServiceTemplate(svcTts, [filterSlot({ themeCode: themeTts })])
    const pending = await buildValidatedVideoRecipe({
      serviceId: svcTts,
      language: 'en',
      variationSeed: 's',
    })
    expect(pending.status).toBe('RECIPE_READY')
    if (pending.status === 'RECIPE_READY') {
      expect(pending.segments[0].audioMode).toBe('TTS_ALLOWED_PENDING')
    }
  }, 240_000)

  it('link enumeration reaches audio candidate 201+ and visual candidate 51+', async () => {
    const db = getDb()
    const serviceId = nextService()
    const theme = `T11_LNK_${RUN_KEY}`
    const sacred = await makeEligibleSacred({
      themeCode: theme,
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
    })
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])

    // Bulk INELIGIBLE published media (runtime disabled) to pad the
    // link lists past the old truncation points.
    async function bulkDisabledMedia(
      kind: 'AUDIO' | 'IMAGE',
      count: number,
      codeTag: string,
    ): Promise<Array<number>> {
      for (let start = 0; start < count; start += 100) {
        await db.insert(mediaAssets).values(
          Array.from({ length: Math.min(100, count - start) }, (_, i) => ({
            publicId: crypto.randomUUID(),
            code: `${CODE_PREFIX}_${codeTag}_${start + i}`,
            assetKind: kind,
            scopeType: 'PLATFORM' as const,
            createdBy: cmId,
          })),
        )
      }
      const assetRows = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(like(mediaAssets.code, `${CODE_PREFIX}\\_${codeTag}\\_%`))
      createdAssetIds.push(...assetRows.map((row) => row.id))
      const ordered = [...assetRows].sort((a, b) => a.id - b.id)
      for (let start = 0; start < ordered.length; start += 100) {
        await db.insert(mediaAssetVersions).values(
          ordered.slice(start, start + 100).map((row) => ({
            assetId: row.id,
            versionNumber: 1,
            status: 'PUBLISHED' as const,
            sourceType: 'HUMAN_RECORDED' as const,
            mimeType: kind === 'AUDIO' ? 'audio/mpeg' : 'image/png',
            byteSize: 64,
            storageKey: `zz/${crypto.randomUUID().replaceAll('-', '')}.${
              kind === 'AUDIO' ? 'mp3' : 'png'
            }`,
            fileSha256: 'e'.repeat(64),
            rightsStatus: 'CLEARED' as const,
            consentStatus: 'NOT_APPLICABLE' as const,
            runtimeEnabled: false,
            publishedAt: new Date(),
            createdBy: cmId,
          })),
        )
      }
      const versionRows = await db
        .select({ id: mediaAssetVersions.id })
        .from(mediaAssetVersions)
        .where(
          inArray(
            mediaAssetVersions.assetId,
            ordered.map((row) => row.id),
          ),
        )
      return versionRows.map((row) => row.id).sort((a, b) => a - b)
    }

    // 205 ineligible audio links, THEN one eligible (highest link id).
    const deadAudio = await bulkDisabledMedia('AUDIO', 205, 'DA')
    for (let start = 0; start < deadAudio.length; start += 100) {
      await db.insert(sacredContentMediaLinks).values(
        deadAudio.slice(start, start + 100).map((versionId) => ({
          contentVersionId: sacred.versionId,
          mediaAssetVersionId: versionId,
          role: 'ALTERNATE_AUDIO' as const,
          sortOrder: 0,
          createdBy: adminId,
        })),
      )
    }
    const liveAudio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      language: 'en',
      sourceType: 'HUMAN_RECORDED',
    })
    await linkMedia(sacred.versionId, liveAudio.versionId, 'ALTERNATE_AUDIO')
    const audioNow = await resolveSacredAudioCandidates(sacred.versionId)
    // The single eligible candidate sits BEYOND the old 200-link cut.
    expect(audioNow.candidates.length).toBe(1)
    expect(audioNow.candidates[0].mediaAssetVersionId).toBe(liveAudio.versionId)

    // 59 ineligible visual links, THEN one eligible (highest link id).
    const deadVisuals = await bulkDisabledMedia('IMAGE', 59, 'DV')
    await db.insert(sacredContentMediaLinks).values(
      deadVisuals.map((versionId) => ({
        contentVersionId: sacred.versionId,
        mediaAssetVersionId: versionId,
        role: 'VISUAL_REFERENCE' as const,
        sortOrder: 0,
        createdBy: adminId,
      })),
    )
    const liveVisual = await makeEligibleMedia({
      assetKind: 'IMAGE',
      contentType: 'PRAYER',
    })
    await linkMedia(sacred.versionId, liveVisual.versionId, 'VISUAL_REFERENCE')

    const recipe = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 's',
    })
    expect(recipe.status).toBe('RECIPE_READY')
    if (recipe.status === 'RECIPE_READY') {
      expect(recipe.segments[0].audio?.mediaAssetVersionId).toBe(
        liveAudio.versionId,
      )
      expect(recipe.segments[0].visualMode).toBe('LINKED_REFERENCE')
      expect(recipe.segments[0].visual?.mediaAssetVersionId).toBe(
        liveVisual.versionId,
      )
    }
  }, 240_000)

  it('removing the governing link invalidates the recipe immediately', async () => {
    const serviceId = nextService()
    const theme = `T11_LRM_${RUN_KEY}`
    const sacred = await makeEligibleSacred({
      themeCode: theme,
      voicePolicy: 'HUMAN_RECORDED_REQUIRED',
    })
    const audio = await makeEligibleMedia({
      assetKind: 'AUDIO',
      language: 'en',
      sourceType: 'HUMAN_RECORDED',
    })
    await linkMedia(sacred.versionId, audio.versionId, 'PRIMARY_AUDIO')
    const visual = await makeEligibleMedia({
      assetKind: 'VIDEO',
      contentType: 'PRAYER',
    })
    await linkMedia(sacred.versionId, visual.versionId, 'VISUAL_REFERENCE')
    await makeServiceTemplate(serviceId, [filterSlot({ themeCode: theme })])
    const recipe = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 's',
    })
    expect(recipe.status).toBe('RECIPE_READY')
    if (recipe.status !== 'RECIPE_READY') return
    expect(recipe.segments[0].visualMode).toBe('LINKED_REFERENCE')
    expect((await validateVideoRecipe(recipe)).status).toBe('VALID')

    // Remove the AUDIO link → invalid; restore → valid.
    const audioLink = (
      await getDb()
        .select({ id: sacredContentMediaLinks.id })
        .from(sacredContentMediaLinks)
        .where(eq(sacredContentMediaLinks.mediaAssetVersionId, audio.versionId))
        .limit(1)
    ).at(0)!
    await removeSacredMediaLink(adminId, ctx, audioLink.id)
    let result = await validateVideoRecipe(recipe)
    expect(result.status).toBe('INVALID')
    if (result.status === 'INVALID') {
      expect(
        result.reasons.some((reason) =>
          reason.startsWith('audio_no_longer_linked'),
        ),
      ).toBe(true)
    }
    await linkMedia(sacred.versionId, audio.versionId, 'PRIMARY_AUDIO')
    expect((await validateVideoRecipe(recipe)).status).toBe('VALID')

    // Remove the VISUAL_REFERENCE link → invalid.
    const visualLink = (
      await getDb()
        .select({ id: sacredContentMediaLinks.id })
        .from(sacredContentMediaLinks)
        .where(
          eq(sacredContentMediaLinks.mediaAssetVersionId, visual.versionId),
        )
        .limit(1)
    ).at(0)!
    await removeSacredMediaLink(adminId, ctx, visualLink.id)
    result = await validateVideoRecipe(recipe)
    expect(result.status).toBe('INVALID')
    if (result.status === 'INVALID') {
      expect(
        result.reasons.some((reason) =>
          reason.startsWith('visual_link_missing'),
        ),
      ).toBe(true)
    }
  }, 240_000)

  it('semantic validation catches mutated descriptors even with a recomputed hash', async () => {
    const serviceId = nextService()
    const theme = `T11_SEM_${RUN_KEY}`
    await makeEligibleSacred({
      themeCode: theme,
      externalAiPolicy: 'METADATA_ONLY',
      contentType: 'CHANT',
    })
    await makeServiceTemplate(serviceId, [
      filterSlot({ themeCode: theme, contentType: 'CHANT' }),
    ])
    const recipe = await buildValidatedVideoRecipe({
      serviceId,
      language: 'en',
      variationSeed: 's',
    })
    expect(recipe.status).toBe('RECIPE_READY')
    if (recipe.status !== 'RECIPE_READY') return
    expect(recipe.segments[0].generation).not.toBeNull()
    expect((await validateVideoRecipe(recipe)).status).toBe('VALID')

    // Mutate descriptor semantics AND recompute a matching checksum:
    // semantic validation must STILL reject it.
    const mutated = JSON.parse(JSON.stringify(recipe)) as typeof recipe
    ;(
      mutated.segments[0].generation as { textContextAllowed: boolean }
    ).textContextAllowed = true
    const { recipeSha256: _drop, ...mutatedBody } = mutated
    ;(mutated as { recipeSha256: string }).recipeSha256 =
      computeRecipeSha256(mutatedBody)
    const result = await validateVideoRecipe(mutated)
    expect(result.status).toBe('INVALID')
    if (result.status === 'INVALID') {
      expect(result.reasons).not.toContain('recipe_hash_mismatch')
      expect(
        result.reasons.some((reason) =>
          reason.startsWith('generation_text_context_mismatch'),
        ),
      ).toBe(true)
    }

    // Mutating the recorded AI policy (again with recomputed hash) is
    // also caught against the current authoritative profile.
    const mutatedPolicy = JSON.parse(JSON.stringify(recipe)) as typeof recipe
    ;(
      mutatedPolicy.segments[0] as { externalAiPolicy: string }
    ).externalAiPolicy = 'APPROVED_TEXT_CONTEXT'
    const { recipeSha256: _drop2, ...mutatedPolicyBody } = mutatedPolicy
    ;(mutatedPolicy as { recipeSha256: string }).recipeSha256 =
      computeRecipeSha256(mutatedPolicyBody)
    const policyResult = await validateVideoRecipe(mutatedPolicy)
    expect(policyResult.status).toBe('INVALID')
    if (policyResult.status === 'INVALID') {
      expect(
        policyResult.reasons.some((reason) =>
          reason.startsWith('ai_policy_changed'),
        ),
      ).toBe(true)
    }
  }, 240_000)
})
