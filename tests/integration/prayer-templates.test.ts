import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, inArray, like } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  auditLogs,
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
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { ForbiddenError } from '@/auth/guards'
import { assignRoleToUser } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import {
  approveVersion,
  computeBodySha256,
  createContentItem,
  createVersion,
  publishVersion,
  setContentItemActive,
  submitVersionForReview,
} from '@/services/spiritual-content'
import {
  createSacredContentItem,
  createSacredVersion,
  listAllEligibleSacredRuntimeContent,
  listEligibleSacredRuntimeContent,
  setSacredRightsStatus,
  setSacredRuntimeEnabled,
} from '@/services/sacred-content'
import {
  PrayerTemplateError,
  approveTemplateVersion,
  archiveTemplateVersion,
  computeDefinitionSha256,
  createPrayerTemplate,
  createTemplateVersion,
  loadTemplateDefinition,
  loadTemplateVersion,
  publishTemplateVersion,
  returnTemplateVersion,
  setPrayerTemplateActive,
  submitTemplateVersion,
  updateDraftTemplateVersion,
  updatePrayerTemplate,
} from '@/services/prayer-templates'
import { resolveApprovedPrayerSession } from '@/services/prayer-session-resolver'
import type {
  SlotInput,
  TemplateInput,
  TemplateVersionInput,
} from '@/services/prayer-templates'
import type {
  SacredProfileInput,
  SacredVersionInput,
} from '@/services/sacred-content'

/**
 * Step 9 integration tests: template workflow/RBAC/immutability,
 * publication validation, canonical definition hashing, autonomous
 * resolver applicability/determinism/variation, pinned + filter
 * selection, complete >500 candidate pagination, exclusion of
 * withdrawn/disabled/guidance content, template fallback, forbidden
 * combinations, repeatability, SILENCE, and later-phase guards.
 *
 * All fixture text is synthetic ("Integration-test prayer block…") —
 * no sacred wording is ever invented.
 */

const ctx = { ipAddress: null, userAgent: 'bun-test' }
const PASSPHRASE = `template test passphrase ${crypto.randomUUID()}`
const createdUserIds: Array<number> = []
const createdItemIds: Array<number> = []
const createdTemplateIds: Array<number> = []

let adminId: number
let cmId: number
let plainUserId: number
let houseId: number
let serviceId: number
let otherServiceId: number

const RUN_KEY = crypto.randomUUID().slice(0, 4).toUpperCase().replace(/-/g, 'X')
const CODE_PREFIX = `T9_${RUN_KEY}`
let codeCounter = 0
function nextCode(prefix = 'ITEM'): string {
  codeCounter += 1
  return `${CODE_PREFIX}_${prefix}_${codeCounter}`
}

async function makeUser(role?: 'ADMIN' | 'CONTENT_MANAGER'): Promise<number> {
  const result = await registerUser(
    {
      email: `s9-${crypto.randomUUID()}@test.local`,
      preferredName: 'S9 Fixture',
      password: PASSPHRASE,
    },
    ctx,
  )
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`)
  createdUserIds.push(result.user.id)
  if (role) await assignRoleToUser(result.user.id, role)
  return result.user.id
}

function baseProfile(
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

/** Full Step 8 upstream approval chain ending runtime-eligible. */
async function makeEligibleSacred(options: {
  contentType?: 'PRAYER' | 'BLESSING' | 'INVOCATION' | 'CHANT'
  scopeType?: 'PLATFORM' | 'SACRED_HOUSE' | 'SERVICE'
  serviceId?: number
  sacredHouseId?: number
  language?: 'en' | 'yo'
  themeCode?: string | null
  repeatable?: boolean
  durationHintSeconds?: number
  body?: string
}): Promise<{ itemId: number; versionId: number }> {
  const item = await createSacredContentItem(cmId, ctx, {
    code: nextCode('SC'),
    contentType: options.contentType ?? 'PRAYER',
    scopeType: options.scopeType ?? 'PLATFORM',
    sacredHouseId: options.sacredHouseId ?? null,
    serviceId: options.serviceId ?? null,
    sortOrder: 0,
  })
  createdItemIds.push(item.id)
  const sacredVersionInput: SacredVersionInput = {
    language: options.language ?? 'en',
    title: 'Integration-test sacred block',
    body:
      options.body ?? `Integration-test prayer block ${crypto.randomUUID()}`,
  }
  const version = await createSacredVersion(
    cmId,
    ctx,
    item.id,
    sacredVersionInput,
    baseProfile({
      themeCode: options.themeCode ?? null,
      repeatable: options.repeatable ?? false,
      durationHintSeconds: options.durationHintSeconds ?? 30,
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

async function makeTemplate(
  overrides: Partial<TemplateInput> = {},
): Promise<number> {
  const result = await createPrayerTemplate(cmId, ctx, {
    code: nextCode('TPL'),
    scopeType: 'PLATFORM',
    sacredHouseId: null,
    serviceId: null,
    ...overrides,
  })
  createdTemplateIds.push(result.id)
  return result.id
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

function versionInput(
  overrides: Partial<TemplateVersionInput> = {},
): TemplateVersionInput {
  return {
    language: 'en',
    priority: 0,
    selectionWeight: 1,
    targetMinSeconds: 60,
    targetMaxSeconds: 180,
    slots: [filterSlot()],
    forbiddenPairs: [],
    ...overrides,
  }
}

/** CM drafts + submits; ADMIN approves + publishes. */
async function publishTemplate(
  templateId: number,
  input: TemplateVersionInput,
): Promise<number> {
  const version = await createTemplateVersion(cmId, ctx, templateId, input)
  await submitTemplateVersion(cmId, ctx, version.id)
  await approveTemplateVersion(adminId, ctx, version.id)
  await publishTemplateVersion(adminId, ctx, version.id)
  return version.id
}

async function expectError(
  fn: () => Promise<unknown>,
  kind: 'template' | 'forbidden' | 'any' = 'template',
): Promise<Error> {
  let thrown: unknown = null
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  if (kind === 'template') expect(thrown).toBeInstanceOf(PrayerTemplateError)
  else if (kind === 'forbidden') expect(thrown).toBeInstanceOf(ForbiddenError)
  else expect(thrown).not.toBeNull()
  return thrown as Error
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
  const db = getDb()
  // Neutralize fixtures a previously crashed run left behind.
  await db
    .update(spiritualContentItems)
    .set({ active: false })
    .where(like(spiritualContentItems.code, 'T9\\_%'))
  await db
    .update(prayerSessionTemplates)
    .set({ active: false })
    .where(like(prayerSessionTemplates.code, 'T9\\_%'))

  adminId = await makeUser('ADMIN')
  cmId = await makeUser('CONTENT_MANAGER')
  plainUserId = await makeUser()

  const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
  const houseInsert = await db.insert(sacredHouses).values({
    code: `T9H_${key}`.toUpperCase(),
    name: `T9 House ${key}`,
    slug: `t9h-${key}`,
    status: 'PUBLISHED',
  })
  houseId = houseInsert[0].insertId
  const svcInsert = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T9S_${key}`.toUpperCase(),
    name: `T9 Service ${key}`,
    slug: `t9s-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  serviceId = svcInsert[0].insertId
  const otherSvc = await db.insert(services).values({
    sacredHouseId: houseId,
    code: `T9O_${key}`.toUpperCase(),
    name: `T9 Other Service ${key}`,
    slug: `t9o-${key}`,
    serviceStatus: 'PUBLISHED',
    durationMinutes: 60,
    priceMinor: 500_000,
    currency: 'NGN',
  })
  otherServiceId = otherSvc[0].insertId
})

afterAll(async () => {
  const db = getDb()
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
  await closeDb()
})

// --- Workflow / RBAC / immutability -----------------------------------------

describe('template workflow', () => {
  it('walks the full human workflow with RBAC and permanent freeze', async () => {
    await expectError(
      () =>
        createPrayerTemplate(plainUserId, ctx, {
          code: nextCode('TPL'),
          scopeType: 'PLATFORM',
          sacredHouseId: null,
          serviceId: null,
        }),
      'forbidden',
    )
    const templateId = await makeTemplate()
    await makeEligibleSacred({}) // ensure at least one PRAYER candidate
    const version = await createTemplateVersion(
      cmId,
      ctx,
      templateId,
      versionInput(),
    )

    // Pre-review structural edit allowed; draft rules editable.
    await updatePrayerTemplate(cmId, ctx, templateId, {
      code: nextCode('TPL'),
      scopeType: 'SERVICE',
      sacredHouseId: null,
      serviceId,
    })
    await updateDraftTemplateVersion(cmId, ctx, version.id, {
      priority: 5,
      selectionWeight: 10,
      targetMinSeconds: 90,
      targetMaxSeconds: 240,
      slots: [
        filterSlot({ allowedScopes: ['PLATFORM', 'SERVICE'] }),
        {
          ...filterSlot({ slotKey: 'QUIET_MOMENT', position: 2 }),
          slotKind: 'SILENCE',
          selectorMode: null,
          contentType: null,
          minSelect: 0,
          maxSelect: 0,
          allowedScopes: [],
          silenceDurationSeconds: 20,
        },
      ],
      forbiddenPairs: [],
    })

    await submitTemplateVersion(cmId, ctx, version.id)
    // Frozen after first review contact — forever.
    await expectError(() =>
      updatePrayerTemplate(cmId, ctx, templateId, {
        code: nextCode('TPL'),
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
      }),
    )
    // UNDER_REVIEW: rules immutable.
    await expectError(() =>
      updateDraftTemplateVersion(cmId, ctx, version.id, {
        priority: 0,
        selectionWeight: 1,
        targetMinSeconds: 60,
        targetMaxSeconds: 120,
        slots: [filterSlot()],
        forbiddenPairs: [],
      }),
    )
    // Return requires a reason and keeps the freeze.
    await expectError(() =>
      returnTemplateVersion(adminId, ctx, version.id, '   '),
    )
    await returnTemplateVersion(adminId, ctx, version.id, 'adjust weighting')
    await expectError(() =>
      updatePrayerTemplate(cmId, ctx, templateId, {
        code: nextCode('TPL'),
        scopeType: 'PLATFORM',
        sacredHouseId: null,
        serviceId: null,
      }),
    )
    await submitTemplateVersion(cmId, ctx, version.id)

    // CM cannot approve/publish; ADMIN can.
    await expectError(
      () => approveTemplateVersion(cmId, ctx, version.id),
      'forbidden',
    )
    await approveTemplateVersion(adminId, ctx, version.id)
    await expectError(
      () => publishTemplateVersion(cmId, ctx, version.id),
      'forbidden',
    )
    const outcome = await publishTemplateVersion(adminId, ctx, version.id)
    expect(outcome.definitionSha256).toMatch(/^[0-9a-f]{64}$/)

    // Published version immutable.
    await expectError(() =>
      updateDraftTemplateVersion(cmId, ctx, version.id, {
        priority: 0,
        selectionWeight: 1,
        targetMinSeconds: 60,
        targetMaxSeconds: 120,
        slots: [filterSlot()],
        forbiddenPairs: [],
      }),
    )
    await setPrayerTemplateActive(adminId, ctx, templateId, false)
  }, 120_000)

  it('enforces one working version and races version creation safely', async () => {
    const templateId = await makeTemplate()
    const results = await Promise.allSettled([
      createTemplateVersion(cmId, ctx, templateId, versionInput()),
      createTemplateVersion(cmId, ctx, templateId, versionInput()),
    ])
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1)
    const rows = await getDb()
      .select()
      .from(prayerSessionTemplateVersions)
      .where(eq(prayerSessionTemplateVersions.templateId, templateId))
    expect(rows.length).toBe(1)
    expect(rows[0].versionNumber).toBe(1)
    // A different language is independent.
    const yo = await createTemplateVersion(
      cmId,
      ctx,
      templateId,
      versionInput({ language: 'yo' }),
    )
    expect(yo.versionNumber).toBe(1)
  }, 120_000)

  it('publication replaces the previous published version and archives it', async () => {
    const theme = `T9_REP_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    const templateId = await makeTemplate()
    const v1 = await publishTemplate(
      templateId,
      versionInput({ slots: [filterSlot({ themeCode: theme })] }),
    )
    const v2 = await createTemplateVersion(
      cmId,
      ctx,
      templateId,
      versionInput({
        priority: 3,
        slots: [filterSlot({ themeCode: theme })],
      }),
    )
    await submitTemplateVersion(cmId, ctx, v2.id)
    await approveTemplateVersion(adminId, ctx, v2.id)
    await publishTemplateVersion(adminId, ctx, v2.id)
    expect((await loadTemplateVersion(v1)).status).toBe('ARCHIVED')
    expect((await loadTemplateVersion(v2.id)).status).toBe('PUBLISHED')
    // Old version keeps its own definition hash.
    expect((await loadTemplateVersion(v1)).definitionSha256).toMatch(
      /^[0-9a-f]{64}$/,
    )
    await setPrayerTemplateActive(adminId, ctx, templateId, false)
  }, 120_000)

  it('archives abandoned versions; ARCHIVED is terminal', async () => {
    const templateId = await makeTemplate()
    const version = await createTemplateVersion(
      cmId,
      ctx,
      templateId,
      versionInput(),
    )
    await archiveTemplateVersion(adminId, ctx, version.id)
    await expectError(() => archiveTemplateVersion(adminId, ctx, version.id))
    await expectError(() => submitTemplateVersion(cmId, ctx, version.id))
  }, 120_000)
})

// --- Publication validation & definition hash --------------------------------

describe('publication validation', () => {
  it('rejects incoherent definitions at input time', async () => {
    const templateId = await makeTemplate()
    // SILENCE with a selector.
    await expectError(() =>
      createTemplateVersion(
        cmId,
        ctx,
        templateId,
        versionInput({
          slots: [
            {
              ...filterSlot(),
              slotKind: 'SILENCE',
              silenceDurationSeconds: 10,
            },
          ],
        }),
      ),
    )
    // CONTENT without selector mode.
    await expectError(() =>
      createTemplateVersion(
        cmId,
        ctx,
        templateId,
        versionInput({ slots: [filterSlot({ selectorMode: null })] }),
      ),
    )
    // Filter without allowed scopes.
    await expectError(() =>
      createTemplateVersion(
        cmId,
        ctx,
        templateId,
        versionInput({ slots: [filterSlot({ allowedScopes: [] })] }),
      ),
    )
    // min > max.
    await expectError(() =>
      createTemplateVersion(
        cmId,
        ctx,
        templateId,
        versionInput({
          slots: [filterSlot({ minSelect: 3, maxSelect: 1 })],
        }),
      ),
    )
    // Duplicate keys / positions.
    await expectError(() =>
      createTemplateVersion(
        cmId,
        ctx,
        templateId,
        versionInput({
          slots: [filterSlot(), filterSlot({ position: 2 })],
        }),
      ),
    )
    // Invalid duration bounds.
    await expectError(() =>
      createTemplateVersion(
        cmId,
        ctx,
        templateId,
        versionInput({ targetMinSeconds: 200, targetMaxSeconds: 100 }),
      ),
    )
    // Forbidden pair referencing a guidance item.
    const guidance = await createContentItem(cmId, ctx, {
      code: nextCode('G'),
      contentType: 'PREPARATION',
      scopeType: 'PLATFORM',
      sacredHouseId: null,
      serviceId: null,
      sortOrder: 0,
    })
    createdItemIds.push(guidance.id)
    const sacred = await makeEligibleSacred({})
    await expectError(() =>
      createTemplateVersion(
        cmId,
        ctx,
        templateId,
        versionInput({
          forbiddenPairs: [
            { contentItemIdA: guidance.id, contentItemIdB: sacred.itemId },
          ],
        }),
      ),
    )
    // Pinning a GUIDANCE version is refused at draft time.
    const guidanceVersion = await createVersion(cmId, ctx, guidance.id, {
      language: 'en',
      title: 'Guidance body',
      body: 'Test preparation content A',
      visibilityStage: 'AFTER_CONFIRMATION',
      acknowledgementRequired: false,
      allowEnglishFallback: false,
    })
    await expectError(() =>
      createTemplateVersion(
        cmId,
        ctx,
        templateId,
        versionInput({
          slots: [
            filterSlot({
              selectorMode: 'PINNED_VERSIONS',
              contentType: null,
              allowedScopes: [],
              pinnedContentVersionIds: [guidanceVersion.id],
            }),
          ],
        }),
      ),
    )
  }, 120_000)

  it('publication fails closed on positions, missing candidates, ineligible or wrong-language pins', async () => {
    const templateId = await makeTemplate()
    // Non-contiguous positions.
    const gappy = await createTemplateVersion(
      cmId,
      ctx,
      templateId,
      versionInput({
        slots: [filterSlot(), filterSlot({ slotKey: 'SECOND', position: 3 })],
      }),
    )
    await submitTemplateVersion(cmId, ctx, gappy.id)
    await approveTemplateVersion(adminId, ctx, gappy.id)
    await expectError(() => publishTemplateVersion(adminId, ctx, gappy.id))
    await archiveTemplateVersion(adminId, ctx, gappy.id)

    // Filter with zero currently eligible candidates for min_select.
    const emptyTheme = `T9_EMPTY_${RUN_KEY}`
    const starving = await createTemplateVersion(
      cmId,
      ctx,
      templateId,
      versionInput({ slots: [filterSlot({ themeCode: emptyTheme })] }),
    )
    await submitTemplateVersion(cmId, ctx, starving.id)
    await approveTemplateVersion(adminId, ctx, starving.id)
    const starved = await expectError(() =>
      publishTemplateVersion(adminId, ctx, starving.id),
    )
    expect(starved.message).toContain('currently eligible candidates')
    await archiveTemplateVersion(adminId, ctx, starving.id)

    // Pinned version that is not currently runtime eligible.
    const disabledContent = await makeEligibleSacred({})
    await setSacredRuntimeEnabled(
      adminId,
      ctx,
      disabledContent.versionId,
      false,
    )
    const pinnedDead = await createTemplateVersion(
      cmId,
      ctx,
      templateId,
      versionInput({
        slots: [
          filterSlot({
            selectorMode: 'PINNED_VERSIONS',
            contentType: null,
            allowedScopes: [],
            pinnedContentVersionIds: [disabledContent.versionId],
          }),
        ],
      }),
    )
    await submitTemplateVersion(cmId, ctx, pinnedDead.id)
    await approveTemplateVersion(adminId, ctx, pinnedDead.id)
    await expectError(() => publishTemplateVersion(adminId, ctx, pinnedDead.id))
    await archiveTemplateVersion(adminId, ctx, pinnedDead.id)

    // Pinned version in the wrong language.
    const yoContent = await makeEligibleSacred({
      language: 'yo',
      body: 'Ìdánwò àkọsílẹ̀ — synthetic test text',
    })
    const wrongLang = await createTemplateVersion(
      cmId,
      ctx,
      templateId,
      versionInput({
        slots: [
          filterSlot({
            selectorMode: 'PINNED_VERSIONS',
            contentType: null,
            allowedScopes: [],
            pinnedContentVersionIds: [yoContent.versionId],
          }),
        ],
      }),
    )
    await submitTemplateVersion(cmId, ctx, wrongLang.id)
    await approveTemplateVersion(adminId, ctx, wrongLang.id)
    const langError = await expectError(() =>
      publishTemplateVersion(adminId, ctx, wrongLang.id),
    )
    expect(langError.message).toContain('language')
    await archiveTemplateVersion(adminId, ctx, wrongLang.id)
  }, 120_000)

  it('stamps a canonical definition hash matching an independent recomputation', async () => {
    const theme = `T9_HASH_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    const templateId = await makeTemplate()
    const versionId = await publishTemplate(
      templateId,
      versionInput({
        slots: [
          filterSlot({ themeCode: theme }),
          {
            ...filterSlot({ slotKey: 'STILLNESS', position: 2 }),
            slotKind: 'SILENCE',
            selectorMode: null,
            contentType: null,
            minSelect: 0,
            maxSelect: 0,
            allowedScopes: [],
            silenceDurationSeconds: 15,
          },
        ],
      }),
    )
    const stored = await loadTemplateVersion(versionId)
    expect(stored.definitionSha256).toMatch(/^[0-9a-f]{64}$/)
    const definition = await loadTemplateDefinition(versionId)
    expect(stored.definitionSha256).toBe(computeDefinitionSha256(definition))
    await setPrayerTemplateActive(adminId, ctx, templateId, false)
  }, 120_000)
})

// --- Autonomous resolver ------------------------------------------------------

describe('autonomous resolver', () => {
  it('prefers the most specific applicable scope, resolves deterministically per seed, varies across seeds', async () => {
    const theme = `T9_VAR_${RUN_KEY}`
    // Four platform candidates so seeds can vary the pick.
    const candidates = []
    for (let i = 0; i < 4; i += 1) {
      candidates.push(await makeEligibleSacred({ themeCode: theme }))
    }
    const platformTemplate = await makeTemplate()
    await publishTemplate(
      platformTemplate,
      versionInput({ slots: [filterSlot({ themeCode: theme })] }),
    )
    const serviceTemplate = await makeTemplate({
      scopeType: 'SERVICE',
      serviceId,
    })
    await publishTemplate(
      serviceTemplate,
      versionInput({
        slots: [filterSlot({ themeCode: theme, allowedScopes: ['PLATFORM'] })],
      }),
    )

    // SERVICE beats PLATFORM for a service context.
    const resolved = await resolveApprovedPrayerSession({
      serviceId,
      language: 'en',
      variationSeed: 'seed-A',
    })
    expect(resolved.status).toBe('RESOLVED')
    if (resolved.status === 'RESOLVED') {
      expect(resolved.templateId).toBe(serviceTemplate)
      expect(resolved.definitionSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(Object.isFrozen(resolved)).toBe(true)
      expect(Object.isFrozen(resolved.slots[0])).toBe(true)
      // No sacred bodies in the default plan.
      for (const slot of resolved.slots) {
        for (const selection of slot.selections) {
          expect('body' in selection).toBe(false)
          expect(selection.contentSha256).toMatch(/^[0-9a-f]{64}$/)
        }
      }
    }

    // Same seed + same state → byte-identical plan.
    const again = await resolveApprovedPrayerSession({
      serviceId,
      language: 'en',
      variationSeed: 'seed-A',
    })
    expect(JSON.stringify(again)).toBe(JSON.stringify(resolved))

    // Different seeds reach different APPROVED selections.
    const seen = new Set<number>()
    for (let seed = 0; seed < 12; seed += 1) {
      const variant = await resolveApprovedPrayerSession({
        serviceId,
        language: 'en',
        variationSeed: `vary-${seed}`,
      })
      if (variant.status === 'RESOLVED') {
        seen.add(variant.slots[0].selections[0].contentVersionId)
      }
    }
    expect(seen.size).toBeGreaterThan(1)
    // Every selection came from the approved candidate set.
    for (const versionId of seen) {
      expect(candidates.map((c) => c.versionId)).toContain(versionId)
    }

    // Platform context (no service): the platform template resolves.
    const platformResolved = await resolveApprovedPrayerSession({
      language: 'en',
      variationSeed: 'seed-A',
    })
    expect(platformResolved.status).toBe('RESOLVED')
    if (platformResolved.status === 'RESOLVED') {
      expect(platformResolved.templateId).toBe(platformTemplate)
    }

    await setPrayerTemplateActive(adminId, ctx, platformTemplate, false)
    await setPrayerTemplateActive(adminId, ctx, serviceTemplate, false)
  }, 120_000)

  it('pinned slots select only pinned content; SILENCE and durations flow into the plan', async () => {
    const pinned = await makeEligibleSacred({
      contentType: 'BLESSING',
      durationHintSeconds: 45,
    })
    const templateId = await makeTemplate({
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    await publishTemplate(
      templateId,
      versionInput({
        slots: [
          filterSlot({
            slotKey: 'OPENING_BLESSING',
            selectorMode: 'PINNED_VERSIONS',
            contentType: null,
            allowedScopes: [],
            pinnedContentVersionIds: [pinned.versionId],
          }),
          {
            ...filterSlot({ slotKey: 'STILL', position: 2 }),
            slotKind: 'SILENCE',
            selectorMode: null,
            contentType: null,
            minSelect: 0,
            maxSelect: 0,
            allowedScopes: [],
            silenceDurationSeconds: 25,
          },
        ],
      }),
    )
    const resolved = await resolveApprovedPrayerSession({
      serviceId: otherServiceId,
      language: 'en',
      variationSeed: 'pin-seed',
    })
    expect(resolved.status).toBe('RESOLVED')
    if (resolved.status === 'RESOLVED') {
      expect(resolved.slots.length).toBe(2)
      expect(resolved.slots[0].selections.length).toBe(1)
      expect(resolved.slots[0].selections[0].contentVersionId).toBe(
        pinned.versionId,
      )
      expect(resolved.slots[0].selections[0].voicePolicy).toBe('TEXT_ONLY')
      expect(resolved.slots[0].selections[0].externalAiPolicy).toBe(
        'METADATA_ONLY',
      )
      expect(resolved.slots[1].slotKind).toBe('SILENCE')
      expect(resolved.slots[1].silenceDurationSeconds).toBe(25)
      expect(resolved.slots[1].selections.length).toBe(0)
      expect(resolved.estimatedSeconds).toBe(45 + 25)
    }
    // Internal trusted variant may carry bodies.
    const withBodies = await resolveApprovedPrayerSession(
      {
        serviceId: otherServiceId,
        language: 'en',
        variationSeed: 'pin-seed',
      },
      { includeBodies: true },
    )
    if (withBodies.status === 'RESOLVED') {
      expect(withBodies.slots[0].selections[0].body).toContain(
        'Integration-test prayer block',
      )
    }
    await setPrayerTemplateActive(adminId, ctx, templateId, false)
  }, 120_000)

  it('falls back to another approved template when content becomes ineligible, then fails closed', async () => {
    const themeA = `T9_FBA_${RUN_KEY}`
    const themeB = `T9_FBB_${RUN_KEY}`
    const contentA = await makeEligibleSacred({
      language: 'yo',
      body: 'Ìdánwò àkọsílẹ̀ A — synthetic',
      themeCode: themeA,
    })
    const contentB = await makeEligibleSacred({
      language: 'yo',
      body: 'Ìdánwò àkọsílẹ̀ B — synthetic',
      themeCode: themeB,
    })
    // Two SERVICE templates on a dedicated context; A outranks B.
    const templateA = await makeTemplate({
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    await publishTemplate(
      templateA,
      versionInput({
        language: 'yo',
        priority: 10,
        slots: [filterSlot({ themeCode: themeA })],
      }),
    )
    const templateB = await makeTemplate({
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    await publishTemplate(
      templateB,
      versionInput({
        language: 'yo',
        priority: 5,
        slots: [filterSlot({ themeCode: themeB })],
      }),
    )

    // Healthy state: A (higher priority) wins.
    const healthy = await resolveApprovedPrayerSession({
      serviceId: otherServiceId,
      language: 'yo',
      variationSeed: 'fb-seed',
    })
    expect(healthy.status).toBe('RESOLVED')
    if (healthy.status === 'RESOLVED') {
      expect(healthy.templateId).toBe(templateA)
    }

    // Withdraw A's only content: the resolver AUTOMATICALLY falls back
    // to template B — never inventing substitutes.
    await setSacredRightsStatus(
      adminId,
      ctx,
      contentA.versionId,
      'WITHDRAWN',
      'synthetic withdrawal for fallback test',
    )
    const fallback = await resolveApprovedPrayerSession({
      serviceId: otherServiceId,
      language: 'yo',
      variationSeed: 'fb-seed',
    })
    expect(fallback.status).toBe('RESOLVED')
    if (fallback.status === 'RESOLVED') {
      expect(fallback.templateId).toBe(templateB)
    }

    // Disable B's content too: NO applicable template can resolve.
    await setSacredRuntimeEnabled(adminId, ctx, contentB.versionId, false)
    const failed = await resolveApprovedPrayerSession({
      serviceId: otherServiceId,
      language: 'yo',
      variationSeed: 'fb-seed',
    })
    expect(failed.status).toBe('NO_VALID_TEMPLATE')

    // Exact language: an en context never uses these yo templates
    // (and no other en template is applicable here).
    const enResolved = await resolveApprovedPrayerSession({
      serviceId: otherServiceId,
      language: 'en',
      variationSeed: 'other-seed',
    })
    expect(enResolved.status).toBe('NO_VALID_TEMPLATE')

    await setPrayerTemplateActive(adminId, ctx, templateA, false)
    await setPrayerTemplateActive(adminId, ctx, templateB, false)
  }, 120_000)

  it('enforces forbidden combinations and non-repeatable vs repeatable selection', async () => {
    const themeX = `T9_FX_${RUN_KEY}`
    const themeYZ = `T9_YZ_${RUN_KEY}`
    const itemX = await makeEligibleSacred({
      contentType: 'INVOCATION',
      themeCode: themeX,
    })
    const itemY = await makeEligibleSacred({ themeCode: themeYZ })
    const itemZ = await makeEligibleSacred({ themeCode: themeYZ })
    const templateId = await makeTemplate({
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    await publishTemplate(
      templateId,
      versionInput({
        slots: [
          filterSlot({
            slotKey: 'INVOKE',
            position: 1,
            selectorMode: 'PINNED_VERSIONS',
            contentType: null,
            allowedScopes: [],
            pinnedContentVersionIds: [itemX.versionId],
          }),
          filterSlot({
            slotKey: 'MAIN',
            position: 2,
            themeCode: themeYZ,
          }),
        ],
        forbiddenPairs: [
          { contentItemIdA: itemX.itemId, contentItemIdB: itemY.itemId },
        ],
      }),
    )
    // Across many seeds the forbidden partner Y is NEVER selected next
    // to X — the resolver always picks the allowed candidate Z.
    for (let seed = 0; seed < 10; seed += 1) {
      const resolved = await resolveApprovedPrayerSession({
        serviceId: otherServiceId,
        language: 'en',
        variationSeed: `forbid-${seed}`,
      })
      expect(resolved.status).toBe('RESOLVED')
      if (resolved.status === 'RESOLVED') {
        const mainSelections = resolved.slots[1].selections
        expect(mainSelections.length).toBe(1)
        expect(mainSelections[0].contentItemId).toBe(itemZ.itemId)
      }
    }
    await setPrayerTemplateActive(adminId, ctx, templateId, false)

    // Non-repeatable content cannot fill two mandatory slots → the
    // template fails; a repeatable candidate resolves both.
    const soloTheme = `T9_SOLO_${RUN_KEY}`
    const solo = await makeEligibleSacred({ themeCode: soloTheme })
    const repeatTemplate = await makeTemplate({
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    await publishTemplate(
      repeatTemplate,
      versionInput({
        slots: [
          filterSlot({ slotKey: 'FIRST', position: 1, themeCode: soloTheme }),
          filterSlot({ slotKey: 'SECOND', position: 2, themeCode: soloTheme }),
        ],
      }),
    )
    const blocked = await resolveApprovedPrayerSession({
      serviceId: otherServiceId,
      language: 'en',
      variationSeed: 'repeat-seed',
    })
    expect(blocked.status).toBe('NO_VALID_TEMPLATE')

    const repeatableTheme = `T9_RPT_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: repeatableTheme, repeatable: true })
    const okTemplate = await makeTemplate({
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    await publishTemplate(
      okTemplate,
      versionInput({
        priority: 20,
        slots: [
          filterSlot({
            slotKey: 'FIRST',
            position: 1,
            themeCode: repeatableTheme,
          }),
          filterSlot({
            slotKey: 'SECOND',
            position: 2,
            themeCode: repeatableTheme,
          }),
        ],
      }),
    )
    const repeated = await resolveApprovedPrayerSession({
      serviceId: otherServiceId,
      language: 'en',
      variationSeed: 'repeat-seed',
    })
    expect(repeated.status).toBe('RESOLVED')
    if (repeated.status === 'RESOLVED') {
      expect(repeated.templateId).toBe(okTemplate)
      expect(repeated.slots[0].selections[0].contentItemId).toBe(
        repeated.slots[1].selections[0].contentItemId,
      )
    }
    void solo
    await setPrayerTemplateActive(adminId, ctx, repeatTemplate, false)
    await setPrayerTemplateActive(adminId, ctx, okTemplate, false)
  }, 120_000)

  it('never selects GUIDANCE content and respects allowed scopes', async () => {
    const scopedTheme = `T9_SCP_${RUN_KEY}`
    // Guidance item published with the SAME body marker.
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

    // A service-scoped candidate on service A and a platform one.
    const serviceContent = await makeEligibleSacred({
      scopeType: 'SERVICE',
      serviceId,
      themeCode: scopedTheme,
    })
    const platformContent = await makeEligibleSacred({
      themeCode: scopedTheme,
    })
    const templateId = await makeTemplate({ scopeType: 'SERVICE', serviceId })
    await publishTemplate(
      templateId,
      versionInput({
        slots: [
          filterSlot({
            themeCode: scopedTheme,
            minSelect: 1,
            maxSelect: 2,
            allowedScopes: ['SERVICE'],
          }),
        ],
      }),
    )
    const resolved = await resolveApprovedPrayerSession({
      serviceId,
      language: 'en',
      variationSeed: 'scope-seed',
    })
    expect(resolved.status).toBe('RESOLVED')
    if (resolved.status === 'RESOLVED') {
      const selections = resolved.slots[0].selections
      // Only the SERVICE-scoped candidate is allowed — the platform
      // candidate and the guidance decoy are impossible.
      expect(selections.length).toBe(1)
      expect(selections[0].contentVersionId).toBe(serviceContent.versionId)
      expect(
        selections.some((s) => s.contentVersionId === guidanceVersion.id),
      ).toBe(false)
      expect(
        selections.some(
          (s) => s.contentVersionId === platformContent.versionId,
        ),
      ).toBe(false)
    }
    await setContentItemActive(adminId, ctx, guidance.id, false)
    await setPrayerTemplateActive(adminId, ctx, templateId, false)
  }, 120_000)
})

// --- Complete >500 candidate enumeration -------------------------------------

describe('candidate pagination beyond 500', () => {
  it('the complete query paginates past the 500-row bound; selection can reach candidate 501+', async () => {
    const bulkTheme = `T9_BULK_${RUN_KEY}`
    const db = getDb()
    const TOTAL = 520
    // Bulk-insert synthetic, fully-gated sacred rows directly (the
    // service workflow is exercised elsewhere; this test targets query
    // completeness at scale).
    const itemIds: Array<number> = []
    for (let start = 0; start < TOTAL; start += 130) {
      const chunk = Array.from(
        { length: Math.min(130, TOTAL - start) },
        (_, i) => ({
          publicId: crypto.randomUUID(),
          code: `${CODE_PREFIX}_BULK_${start + i}`,
          contentDomain: 'SACRED_RUNTIME' as const,
          contentType: 'CHANT',
          scopeType: 'PLATFORM' as const,
          sortOrder: 0,
          createdBy: cmId,
        }),
      )
      await db.insert(spiritualContentItems).values(chunk)
    }
    const itemRows = await db
      .select({
        id: spiritualContentItems.id,
        code: spiritualContentItems.code,
      })
      .from(spiritualContentItems)
      .where(like(spiritualContentItems.code, `${CODE_PREFIX}\\_BULK\\_%`))
    expect(itemRows.length).toBe(TOTAL)
    itemIds.push(...itemRows.map((row) => row.id))
    createdItemIds.push(...itemIds)
    for (let start = 0; start < itemRows.length; start += 130) {
      await db.insert(spiritualContentVersions).values(
        itemRows.slice(start, start + 130).map((row) => ({
          contentItemId: row.id,
          language: 'en' as const,
          versionNumber: 1,
          title: 'Bulk synthetic block',
          body: `Integration-test bulk block ${row.code}`,
          visibilityStage: 'AFTER_CONFIRMATION' as const,
          acknowledgementRequired: false,
          allowEnglishFallback: false,
          status: 'PUBLISHED' as const,
          publishedAt: new Date(),
          createdBy: cmId,
        })),
      )
    }
    const versionRows = await db
      .select({
        id: spiritualContentVersions.id,
        contentItemId: spiritualContentVersions.contentItemId,
        body: spiritualContentVersions.body,
      })
      .from(spiritualContentVersions)
      .where(inArray(spiritualContentVersions.contentItemId, itemIds))
    expect(versionRows.length).toBe(TOTAL)
    for (let start = 0; start < versionRows.length; start += 130) {
      await db.insert(sacredContentVersionProfiles).values(
        versionRows.slice(start, start + 130).map((row) => ({
          contentVersionId: row.id,
          contentItemId: row.contentItemId,
          provenanceType: 'ORIGINAL_AUTHORED' as const,
          digitalStorageAuthorized: true,
          themeCode: bulkTheme,
          repeatable: false,
          voicePolicy: 'TEXT_ONLY' as const,
          externalAiPolicy: 'METADATA_ONLY' as const,
          accessPolicy: 'PRAYER_ROOM_PRIVATE' as const,
          rightsStatus: 'CLEARED' as const,
          runtimeEnabled: true,
          contentSha256: computeBodySha256(row.body),
        })),
      )
    }

    // The bounded single page stops at 500…
    const singlePage = await listEligibleSacredRuntimeContent({
      language: 'en',
      themeCode: bulkTheme,
    })
    expect(singlePage.length).toBe(500)
    // …while the complete enumeration reaches every candidate.
    const complete = await listAllEligibleSacredRuntimeContent({
      language: 'en',
      themeCode: bulkTheme,
    })
    expect(complete.length).toBe(TOTAL)
    const maxVersionId = Math.max(...versionRows.map((row) => row.id))
    expect(complete.some((row) => row.contentVersionId === maxVersionId)).toBe(
      true,
    )

    // The resolver's selection universe includes candidate 501+: a
    // pinned slot on the HIGHEST bulk version id resolves.
    const templateId = await makeTemplate({
      scopeType: 'SERVICE',
      serviceId: otherServiceId,
    })
    await publishTemplate(
      templateId,
      versionInput({
        slots: [
          filterSlot({
            selectorMode: 'PINNED_VERSIONS',
            contentType: null,
            allowedScopes: [],
            pinnedContentVersionIds: [maxVersionId],
          }),
        ],
      }),
    )
    const resolved = await resolveApprovedPrayerSession({
      serviceId: otherServiceId,
      language: 'en',
      variationSeed: 'bulk-seed',
    })
    expect(resolved.status).toBe('RESOLVED')
    if (resolved.status === 'RESOLVED') {
      expect(resolved.slots[0].selections[0].contentVersionId).toBe(
        maxVersionId,
      )
    }
    await setPrayerTemplateActive(adminId, ctx, templateId, false)
    // Deactivate the bulk fixtures so other candidate queries stay lean.
    await db
      .update(spiritualContentItems)
      .set({ active: false })
      .where(inArray(spiritualContentItems.id, itemIds))
  }, 120_000)
})

// --- Guards & audit privacy ---------------------------------------------------

describe('guards', () => {
  it('no template audit metadata contains sacred bodies', async () => {
    const rows = await getDb()
      .select()
      .from(auditLogs)
      .where(
        and(
          inArray(auditLogs.actorUserId, createdUserIds),
          like(auditLogs.action, 'prayer_template.%'),
        ),
      )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const metadata = JSON.stringify(row.metadataJson ?? {})
      expect(metadata).not.toContain('Integration-test prayer block')
      expect(metadata).not.toContain('Ìdánwò àkọsílẹ̀')
    }
  })

  it('no route uses dangerouslySetInnerHTML; no Prayer Room routes exist', () => {
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
    // Step 18 builds the recorded Prayer Room, so "none exists" is no
    // longer the fence. The fence is now the SHAPE of that surface:
    // exactly one owner-only page and one AUTHENTICATED media endpoint,
    // and nothing else — no public route, no second media path.
    const prayerRoomPaths = [...routeTree.matchAll(/fullPath: '([^']*prayer-room[^']*)'/g)]
      .map((match) => match[1])
      .sort()
    expect(prayerRoomPaths).toEqual([
      '/api/prayer-room/$publicId/media',
      '/prayer-room/$publicId',
    ])
  })

  it('Step 9 modules introduce no AI/TTS/video providers and never use wall-clock randomness for selection', () => {
    const files = [
      'src/services/prayer-templates.ts',
      'src/services/prayer-session-resolver.ts',
      'src/services/prayer-template-actions.ts',
      'src/db/schema/prayer-templates.ts',
      'src/routes/admin.prayer-templates.index.tsx',
      'src/routes/admin.prayer-templates.new.tsx',
      'src/routes/admin.prayer-templates.$id.tsx',
      'src/routes/admin.prayer-templates.review.tsx',
    ]
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      expect(source).not.toMatch(
        /kling|openart|remotion|ffmpeg|elevenlabs|text-to-speech|\btts\b|openai|new Anthropic|anthropic\s*\(|generatePrayer|translate\(/i,
      )
    }
    // The resolver itself must be free of nondeterministic sources.
    const resolver = readFileSync(
      join(process.cwd(), 'src/services/prayer-session-resolver.ts'),
      'utf8',
    )
    expect(resolver).not.toMatch(/Math\.random\s*\(/)
    expect(resolver).not.toMatch(/Date\.now\s*\(/)
  }, 120_000)
})

// --- Step 9 hardening: authority, runtime hash gate, >500 templates ---------

describe('resolver hardening', () => {
  it('a Service context authoritatively determines the House and rejects a contradicting one', async () => {
    const db = getDb()
    const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
    const otherHouse = await db.insert(sacredHouses).values({
      code: `T9X_${key}`.toUpperCase(),
      name: `T9 Other House ${key}`,
      slug: `t9x-${key}`,
      status: 'PUBLISHED',
    })
    const otherHouseId = otherHouse[0].insertId

    const theme = `T9_AUTH_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: theme })
    const templateId = await makeTemplate({ scopeType: 'SERVICE', serviceId })
    await publishTemplate(
      templateId,
      versionInput({ slots: [filterSlot({ themeCode: theme })] }),
    )

    // Matching House (the Service's own) is fine.
    const matching = await resolveApprovedPrayerSession({
      serviceId,
      sacredHouseId: houseId,
      language: 'en',
      variationSeed: 'auth-seed',
    })
    expect(matching.status).toBe('RESOLVED')

    // A contradicting House is rejected outright.
    let thrown: unknown = null
    try {
      await resolveApprovedPrayerSession({
        serviceId,
        sacredHouseId: otherHouseId,
        language: 'en',
        variationSeed: 'auth-seed',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PrayerTemplateError)

    await setPrayerTemplateActive(adminId, ctx, templateId, false)
    await db.delete(sacredHouses).where(eq(sacredHouses.id, otherHouseId))
  }, 120_000)

  it('a corrupted published definition fails closed at runtime, falls back, and is never auto-healed', async () => {
    const themeA = `T9_HCA_${RUN_KEY}`
    const themeB = `T9_HCB_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: themeA })
    await makeEligibleSacred({ themeCode: themeB })
    const templateA = await makeTemplate({ scopeType: 'SERVICE', serviceId })
    const versionA = await publishTemplate(
      templateA,
      versionInput({
        priority: 10,
        slots: [filterSlot({ themeCode: themeA })],
      }),
    )
    const templateB = await makeTemplate({ scopeType: 'SERVICE', serviceId })
    await publishTemplate(
      templateB,
      versionInput({
        priority: 5,
        slots: [filterSlot({ themeCode: themeB })],
      }),
    )

    // Healthy: A (higher priority) resolves with a verified hash.
    const healthy = await resolveApprovedPrayerSession({
      serviceId,
      language: 'en',
      variationSeed: 'hash-seed',
    })
    expect(healthy.status).toBe('RESOLVED')
    if (healthy.status === 'RESOLVED') {
      expect(healthy.templateId).toBe(templateA)
    }

    // Corrupt A's published slot rules directly in the DB: the stored
    // definition hash no longer matches the authoritative rows.
    const storedShaBefore = (await loadTemplateVersion(versionA))
      .definitionSha256
    await getDb()
      .update(prayerSessionTemplateSlots)
      .set({ minSelect: 0 })
      .where(eq(prayerSessionTemplateSlots.templateVersionId, versionA))

    const fallback = await resolveApprovedPrayerSession({
      serviceId,
      language: 'en',
      variationSeed: 'hash-seed',
    })
    expect(fallback.status).toBe('RESOLVED')
    if (fallback.status === 'RESOLVED') {
      expect(fallback.templateId).toBe(templateB)
    }
    // The stored hash was NOT rewritten to match the corruption.
    expect((await loadTemplateVersion(versionA)).definitionSha256).toBe(
      storedShaBefore,
    )

    // With the fallback deactivated, resolution fails CLOSED.
    await setPrayerTemplateActive(adminId, ctx, templateB, false)
    const failed = await resolveApprovedPrayerSession({
      serviceId,
      language: 'en',
      variationSeed: 'hash-seed',
    })
    expect(failed.status).toBe('NO_VALID_TEMPLATE')

    await setPrayerTemplateActive(adminId, ctx, templateA, false)
  }, 120_000)

  it('applicable-template discovery paginates past 500 — template 501+ is resolvable', async () => {
    const db = getDb()
    const key = crypto.randomUUID().slice(0, 6).replace(/-/g, 'x')
    // Dedicated service so this fleet cannot collide with other tests.
    const bulkSvc = await db.insert(services).values({
      sacredHouseId: houseId,
      code: `T9B_${key}`.toUpperCase(),
      name: `T9 Bulk Service ${key}`,
      slug: `t9b-${key}`,
      serviceStatus: 'PUBLISHED',
      durationMinutes: 60,
      priceMinor: 500_000,
      currency: 'NGN',
    })
    const bulkServiceId = bulkSvc[0].insertId
    const winnerTheme = `T9_WIN_${RUN_KEY}`
    const emptyTheme = `T9_NONE_${RUN_KEY}`
    await makeEligibleSacred({ themeCode: winnerTheme })

    const TOTAL = 520
    // Bulk-insert published SERVICE templates directly. The first 519
    // filter on a theme with NO candidates (and carry a deliberately
    // wrong hash — both make them fail closed); the LAST inserted
    // (highest version id, beyond any 500-row truncation) is the only
    // resolvable one and gets its true canonical hash below.
    for (let start = 0; start < TOTAL; start += 130) {
      const chunk = Array.from(
        { length: Math.min(130, TOTAL - start) },
        (_, i) => ({
          publicId: crypto.randomUUID(),
          code: `${CODE_PREFIX}_BT_${start + i}`,
          scopeType: 'SERVICE' as const,
          serviceId: bulkServiceId,
          createdBy: cmId,
        }),
      )
      await db.insert(prayerSessionTemplates).values(chunk)
    }
    const templateRows = await db
      .select({
        id: prayerSessionTemplates.id,
        code: prayerSessionTemplates.code,
      })
      .from(prayerSessionTemplates)
      .where(like(prayerSessionTemplates.code, `${CODE_PREFIX}\\_BT\\_%`))
    expect(templateRows.length).toBe(TOTAL)
    createdTemplateIds.push(...templateRows.map((row) => row.id))
    const orderedTemplates = [...templateRows].sort((a, b) => a.id - b.id)
    for (let start = 0; start < orderedTemplates.length; start += 130) {
      await db.insert(prayerSessionTemplateVersions).values(
        orderedTemplates.slice(start, start + 130).map((row) => ({
          templateId: row.id,
          language: 'en' as const,
          versionNumber: 1,
          status: 'PUBLISHED' as const,
          priority: 0,
          selectionWeight: 1,
          targetMinSeconds: 60,
          targetMaxSeconds: 180,
          definitionSha256: 'e'.repeat(64),
          publishedAt: new Date(),
          createdBy: cmId,
        })),
      )
    }
    const versionRows = await db
      .select({
        id: prayerSessionTemplateVersions.id,
        templateId: prayerSessionTemplateVersions.templateId,
      })
      .from(prayerSessionTemplateVersions)
      .where(
        inArray(
          prayerSessionTemplateVersions.templateId,
          templateRows.map((row) => row.id),
        ),
      )
    expect(versionRows.length).toBe(TOTAL)
    const winnerVersion = versionRows.reduce((max, row) =>
      row.id > max.id ? row : max,
    )
    for (let start = 0; start < versionRows.length; start += 130) {
      await db.insert(prayerSessionTemplateSlots).values(
        versionRows.slice(start, start + 130).map((row) => ({
          templateVersionId: row.id,
          slotKey: 'MAIN_PRAYER',
          position: 1,
          slotKind: 'CONTENT' as const,
          minSelect: 1,
          maxSelect: 1,
          contentType: 'PRAYER',
          selectorMode: 'ELIGIBLE_FILTER' as const,
          themeCode: row.id === winnerVersion.id ? winnerTheme : emptyTheme,
        })),
      )
    }
    const slotRows = await db
      .select({
        id: prayerSessionTemplateSlots.id,
        templateVersionId: prayerSessionTemplateSlots.templateVersionId,
      })
      .from(prayerSessionTemplateSlots)
      .where(
        inArray(
          prayerSessionTemplateSlots.templateVersionId,
          versionRows.map((row) => row.id),
        ),
      )
    for (let start = 0; start < slotRows.length; start += 130) {
      await db.insert(prayerTemplateSlotScopes).values(
        slotRows.slice(start, start + 130).map((row) => ({
          slotId: row.id,
          scopeType: 'PLATFORM' as const,
        })),
      )
    }
    // Give ONLY the winner its true canonical hash.
    const winnerDefinition = await loadTemplateDefinition(winnerVersion.id)
    await db
      .update(prayerSessionTemplateVersions)
      .set({ definitionSha256: computeDefinitionSha256(winnerDefinition) })
      .where(eq(prayerSessionTemplateVersions.id, winnerVersion.id))

    // The winner sits beyond position 500 of the discovery scan —
    // complete enumeration must still find and resolve it.
    const resolved = await resolveApprovedPrayerSession({
      serviceId: bulkServiceId,
      language: 'en',
      variationSeed: 'bulk-tpl-seed',
    })
    expect(resolved.status).toBe('RESOLVED')
    if (resolved.status === 'RESOLVED') {
      expect(resolved.templateId).toBe(winnerVersion.templateId)
      expect(resolved.slots[0].selections.length).toBe(1)
    }

    // Deactivate the fleet so later resolutions stay lean.
    await db
      .update(prayerSessionTemplates)
      .set({ active: false })
      .where(
        inArray(
          prayerSessionTemplates.id,
          templateRows.map((row) => row.id),
        ),
      )
  }, 240_000)
})
