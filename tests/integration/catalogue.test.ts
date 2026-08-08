import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import {
  deities,
  deitySacredHouses,
  sacredHouseFocusAreas,
  sacredHouseMembers,
  sacredHouses,
  services,
  users,
} from '@/db/schema'
import { seedRbac } from '@/db/seed'
import { seedDomain } from '@/db/seed-domain'
import { getUserPermissionCodes, assignRoleToUser } from '@/auth/rbac'
import { registerUser } from '@/auth/service'
import {
  getPublishedDeityBySlug,
  getPublishedSacredHouseBySlug,
  getPublishedServiceBySlug,
  listPublishedDeities,
  listPublishedSacredHouses,
  listPublishedServicesByHouse,
} from '@/services/catalogue'

/**
 * Catalogue integration tests against the local Docker MariaDB.
 * Fixtures created here (temp catalogue rows, temp users) are cleaned
 * up; the approved seeded catalogue itself is meant to persist.
 */

const tempDeityIds: Array<number> = []
const tempHouseIds: Array<number> = []
const tempUserIds: Array<number> = []

async function countRows() {
  const db = getDb()
  return {
    deities: (await db.select({ id: deities.id }).from(deities)).length,
    houses: (await db.select({ id: sacredHouses.id }).from(sacredHouses))
      .length,
    focusAreas: (
      await db
        .select({ id: sacredHouseFocusAreas.id })
        .from(sacredHouseFocusAreas)
    ).length,
    members: (
      await db.select({ id: sacredHouseMembers.id }).from(sacredHouseMembers)
    ).length,
    services: (await db.select({ id: services.id }).from(services)).length,
    deityHouseLinks: (
      await db
        .select({ deityId: deitySacredHouses.deityId })
        .from(deitySacredHouses)
    ).length,
  }
}

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedRbac()
  await seedDomain()
})

afterAll(async () => {
  const db = getDb()
  if (tempDeityIds.length > 0) {
    await db.delete(deities).where(inArray(deities.id, tempDeityIds))
  }
  if (tempHouseIds.length > 0) {
    await db.delete(sacredHouses).where(inArray(sacredHouses.id, tempHouseIds))
  }
  if (tempUserIds.length > 0) {
    const { auditLogs } = await import('@/db/schema')
    await db
      .delete(auditLogs)
      .where(inArray(auditLogs.actorUserId, tempUserIds))
    await db.delete(users).where(inArray(users.id, tempUserIds))
  }
  await closeDb()
})

describe('seed idempotency', () => {
  it('running the domain seed twice creates no duplicates in any table', async () => {
    const before = await countRows()
    await seedDomain()
    await seedDomain()
    const after = await countRows()
    expect(after).toEqual(before)
    expect(after.deities).toBeGreaterThanOrEqual(8)
    expect(after.houses).toBeGreaterThanOrEqual(4)
    expect(after.deityHouseLinks).toBe(3)
  })
})

describe('approved Yorùbá names are preserved exactly', () => {
  const expectations: Array<[string, string]> = [
    ['OBATALA', 'Ọbàtálá'],
    ['OSUN', 'Ọ̀ṣun'],
    ['AJE_SALUGA_OLOKUN', 'Ajé Ṣalúgà / Ajé Olókun'],
    ['OSANYIN', 'Ọ̀sanyìn'],
    ['ORUNMILA', 'Ọ̀rúnmìlà'],
    ['SANGO', 'Ṣàngó'],
    ['OGUN', 'Ògún'],
    ['YEMOJA', 'Yemoja'],
  ]

  it.each(expectations)('deity %s round-trips as %s', async (code, name) => {
    const row = (
      await getDb().select().from(deities).where(eq(deities.code, code))
    ).at(0)
    expect(row?.name).toBe(name)
  })

  it('preserves Sacred House names with full diacritics', async () => {
    const houseExpectations: Array<[string, string]> = [
      ['ABULE_OSUN', 'Abúlé Ọ̀ṣun'],
      ['ABULE_AJE', 'Abúlé Ajé Ṣalúgà / Ajé Olókun'],
      ['ABULE_OSANYIN_AJA', 'Abúlé Ọ̀sanyìn àti Àjà'],
      ['ILE_AWON_BABALAWO', 'Ilé Àwọn Babaláwo'],
    ]
    for (const [code, name] of houseExpectations) {
      const row = (
        await getDb()
          .select()
          .from(sacredHouses)
          .where(eq(sacredHouses.code, code))
      ).at(0)
      expect(row?.name).toBe(name)
    }
  })

  it('preserves member names including Yorùbá characters', async () => {
    const aje = (
      await getDb()
        .select()
        .from(sacredHouses)
        .where(eq(sacredHouses.code, 'ABULE_AJE'))
    ).at(0)!
    const members = await getDb()
      .select()
      .from(sacredHouseMembers)
      .where(eq(sacredHouseMembers.sacredHouseId, aje.id))
    const names = members.map((m) => m.displayName)
    expect(names).toContain('Mama Aṣẹoluwa')
    expect(names).toContain('Baba Aduragba')
    expect(names.length).toBe(7)
  })
})

describe('unique constraints', () => {
  it('rejects duplicate deity codes and slugs', async () => {
    let thrown = false
    try {
      await getDb()
        .insert(deities)
        .values({ code: 'OSUN', name: 'Duplicate', slug: 'unique-slug-x' })
    } catch {
      thrown = true
    }
    expect(thrown).toBe(true)

    thrown = false
    try {
      await getDb()
        .insert(deities)
        .values({ code: 'UNIQUE_CODE_X', name: 'Duplicate', slug: 'osun' })
    } catch {
      thrown = true
    }
    expect(thrown).toBe(true)
  })

  it('rejects duplicate junction rows', async () => {
    const osun = (
      await getDb().select().from(deities).where(eq(deities.code, 'OSUN'))
    ).at(0)!
    const house = (
      await getDb()
        .select()
        .from(sacredHouses)
        .where(eq(sacredHouses.code, 'ABULE_OSUN'))
    ).at(0)!
    let thrown = false
    try {
      await getDb()
        .insert(deitySacredHouses)
        .values({ deityId: osun.id, sacredHouseId: house.id })
    } catch {
      thrown = true
    }
    expect(thrown).toBe(true)
  })
})

describe('publication filtering', () => {
  it('public deity queries exclude DRAFT, ARCHIVED and inactive records', async () => {
    const db = getDb()
    const inserted = await db.insert(deities).values([
      { code: 'T_DRAFT', name: 'T Draft', slug: 't-draft' },
      {
        code: 'T_ARCHIVED',
        name: 'T Archived',
        slug: 't-archived',
        profileStatus: 'ARCHIVED',
      },
      {
        code: 'T_INACTIVE',
        name: 'T Inactive',
        slug: 't-inactive',
        profileStatus: 'PUBLISHED',
        active: false,
      },
      {
        code: 'T_REVIEW',
        name: 'T Review',
        slug: 't-review',
        profileStatus: 'UNDER_REVIEW',
      },
    ])
    const firstId = inserted[0].insertId
    tempDeityIds.push(firstId, firstId + 1, firstId + 2, firstId + 3)

    const publicList = await listPublishedDeities()
    const names = publicList.map((d) => d.name)
    expect(names).not.toContain('T Draft')
    expect(names).not.toContain('T Archived')
    expect(names).not.toContain('T Inactive')
    expect(names).not.toContain('T Review')

    expect(await getPublishedDeityBySlug('t-draft')).toBeNull()
    expect(await getPublishedDeityBySlug('t-archived')).toBeNull()
    expect(await getPublishedDeityBySlug('t-inactive')).toBeNull()
  })

  it('new deity records default to DRAFT (admin-created rows are not public)', async () => {
    const inserted = await getDb()
      .insert(deities)
      .values({ code: 'T_DEFAULT', name: 'T Default', slug: 't-default' })
    tempDeityIds.push(inserted[0].insertId)
    const row = (
      await getDb().select().from(deities).where(eq(deities.code, 'T_DEFAULT'))
    ).at(0)
    expect(row?.profileStatus).toBe('DRAFT')
  })

  it('services under a non-published Sacred House are hidden even if published', async () => {
    const db = getDb()
    const houseInsert = await db.insert(sacredHouses).values({
      code: 'T_HIDDEN_HOUSE',
      name: 'T Hidden House',
      slug: 't-hidden-house',
      status: 'DRAFT',
    })
    const houseId = houseInsert[0].insertId
    tempHouseIds.push(houseId)
    await db.insert(services).values({
      sacredHouseId: houseId,
      code: 'T_HIDDEN_SERVICE',
      name: 'T Hidden Service',
      slug: 't-hidden-service',
      serviceStatus: 'PUBLISHED',
    })

    expect(await getPublishedServiceBySlug('t-hidden-service')).toBeNull()
    const groups = await listPublishedServicesByHouse()
    expect(groups.some((g) => g.sacredHouse.name === 'T Hidden House')).toBe(
      false,
    )
    // Cleanup service row first (house delete is restricted otherwise).
    await db.delete(services).where(eq(services.code, 'T_HIDDEN_SERVICE'))
  })

  it('deleting a Sacred House with services is restricted, not cascaded', async () => {
    const house = (
      await getDb()
        .select()
        .from(sacredHouses)
        .where(eq(sacredHouses.code, 'ABULE_OSUN'))
    ).at(0)!
    let thrown = false
    try {
      await getDb().delete(sacredHouses).where(eq(sacredHouses.id, house.id))
    } catch {
      thrown = true
    }
    expect(thrown).toBe(true)
  })
})

describe('relationships', () => {
  it('Abúlé Ọ̀ṣun returns its focus areas, members, services and deity', async () => {
    const house = await getPublishedSacredHouseBySlug('abule-osun')
    expect(house).not.toBeNull()
    expect(house!.name).toBe('Abúlé Ọ̀ṣun')
    expect(house!.focusAreas.length).toBe(9)
    expect(house!.focusAreas).toContain('Fertility prayers')
    expect(house!.members.length).toBe(7)
    expect(house!.members.every((m) => m.memberType === 'PRAYER_WARRIOR')).toBe(
      true,
    )
    expect(house!.services.map((s) => s.name).sort()).toEqual([
      'Family',
      'Fertility',
      'Motherhood',
    ])
    expect(house!.deities.map((d) => d.name)).toEqual(['Ọ̀ṣun'])
  })

  it('Ilé Àwọn Babaláwo has services and focus areas but no members and no deity link', async () => {
    const house = await getPublishedSacredHouseBySlug('ile-awon-babalawo')
    expect(house).not.toBeNull()
    expect(house!.focusAreas.length).toBe(17)
    expect(house!.members.length).toBe(0)
    expect(house!.deities.length).toBe(0)
    expect(house!.services.map((s) => s.name).sort()).toEqual([
      'Ancestral Guidance',
      'Cleansing',
      'Divination',
    ])
  })

  it('deity profiles never leak services whose Sacred House is not public', async () => {
    const db = getDb()
    const { deityServices } = await import('@/db/schema')

    // PUBLISHED + active deity…
    const deityInsert = await db.insert(deities).values({
      code: 'T_LEAK_DEITY',
      name: 'T Leak Deity',
      slug: 't-leak-deity',
      profileStatus: 'PUBLISHED',
    })
    const deityId = deityInsert[0].insertId
    tempDeityIds.push(deityId)

    // …linked to a PUBLISHED + active service under a DRAFT House.
    const houseInsert = await db.insert(sacredHouses).values({
      code: 'T_LEAK_HOUSE',
      name: 'T Leak House',
      slug: 't-leak-house',
      status: 'DRAFT',
    })
    const houseId = houseInsert[0].insertId
    tempHouseIds.push(houseId)
    const serviceInsert = await db.insert(services).values({
      sacredHouseId: houseId,
      code: 'T_LEAK_SERVICE',
      name: 'T Leak Service',
      slug: 't-leak-service',
      serviceStatus: 'PUBLISHED',
    })
    const serviceId = serviceInsert[0].insertId
    await db.insert(deityServices).values({ deityId, serviceId })

    try {
      // DRAFT House: deity is public, its service must not be.
      let profile = await getPublishedDeityBySlug('t-leak-deity')
      expect(profile).not.toBeNull()
      expect(profile!.services).toEqual([])

      // PUBLISHED but inactive House: still hidden.
      await db
        .update(sacredHouses)
        .set({ status: 'PUBLISHED', active: false })
        .where(eq(sacredHouses.id, houseId))
      profile = await getPublishedDeityBySlug('t-leak-deity')
      expect(profile!.services).toEqual([])

      // Positive control: once the House is publicly visible, the
      // linked service appears — proving the join itself works.
      await db
        .update(sacredHouses)
        .set({ status: 'PUBLISHED', active: true })
        .where(eq(sacredHouses.id, houseId))
      profile = await getPublishedDeityBySlug('t-leak-deity')
      expect(profile!.services.map((s) => s.name)).toEqual(['T Leak Service'])
    } finally {
      // Service first: House deletion is RESTRICT while it exists.
      await db.delete(services).where(eq(services.id, serviceId))
      await db.delete(sacredHouses).where(eq(sacredHouses.id, houseId))
      await db.delete(deities).where(eq(deities.id, deityId))
    }
  })

  it('deity profile connects Ọ̀ṣun to Abúlé Ọ̀ṣun and no unapproved houses', async () => {
    const osun = await getPublishedDeityBySlug('osun')
    expect(osun).not.toBeNull()
    expect(osun!.sacredHouses.map((h) => h.name)).toEqual(['Abúlé Ọ̀ṣun'])
    expect(osun!.services).toEqual([])

    // Deities the specification does not link stay unlinked.
    const sango = await getPublishedDeityBySlug('sango')
    expect(sango).not.toBeNull()
    expect(sango!.sacredHouses).toEqual([])
  })

  it('services list groups 11 service families under the 4 Sacred Houses', async () => {
    const groups = await listPublishedServicesByHouse()
    const seededGroups = groups.filter((g) =>
      [
        'Abúlé Ọ̀ṣun',
        'Abúlé Ajé Ṣalúgà / Ajé Olókun',
        'Abúlé Ọ̀sanyìn àti Àjà',
        'Ilé Àwọn Babaláwo',
      ].includes(g.sacredHouse.name),
    )
    expect(seededGroups.length).toBe(4)
    const total = seededGroups.reduce((n, g) => n + g.services.length, 0)
    expect(total).toBe(11)
    // No invented prices or durations anywhere.
    for (const group of seededGroups) {
      for (const service of group.services) {
        expect(service.priceMinor).toBeNull()
        expect(service.durationMinutes).toBeNull()
        expect(service.currency).toBeNull()
      }
    }
  })

  it('sacred house list returns the four approved houses', async () => {
    const houses = await listPublishedSacredHouses()
    const names = houses.map((h) => h.name)
    for (const expected of [
      'Abúlé Ọ̀ṣun',
      'Abúlé Ajé Ṣalúgà / Ajé Olókun',
      'Abúlé Ọ̀sanyìn àti Àjà',
      'Ilé Àwọn Babaláwo',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('unknown slugs resolve to null (routes render not-found)', async () => {
    expect(await getPublishedDeityBySlug('no-such-deity')).toBeNull()
    expect(await getPublishedSacredHouseBySlug('no-such-house')).toBeNull()
    expect(await getPublishedServiceBySlug('no-such-service')).toBeNull()
  })
})

describe('catalogue RBAC', () => {
  it('USER receives no catalogue-management permissions', async () => {
    const email = `cat-${crypto.randomUUID()}@test.local`
    const result = await registerUser(
      {
        email,
        preferredName: 'Catalogue Tester',
        password: 'a test passphrase',
      },
      { ipAddress: null, userAgent: 'bun-test' },
    )
    if (!result.ok) throw new Error(result.error)
    tempUserIds.push(result.user.id)

    const perms = await getUserPermissionCodes(result.user.id)
    expect(perms.sort()).toEqual(['account.self.read', 'account.self.update'])
  })

  it('CONTENT_MANAGER and ADMIN receive catalogue permissions', async () => {
    const email = `cat-${crypto.randomUUID()}@test.local`
    const result = await registerUser(
      {
        email,
        preferredName: 'Catalogue Manager',
        password: 'a test passphrase',
      },
      { ipAddress: null, userAgent: 'bun-test' },
    )
    if (!result.ok) throw new Error(result.error)
    tempUserIds.push(result.user.id)

    await assignRoleToUser(result.user.id, 'CONTENT_MANAGER')
    const perms = await getUserPermissionCodes(result.user.id)
    for (const code of [
      'deities.view',
      'deities.manage',
      'sacred_houses.view',
      'sacred_houses.manage',
      'services.view',
      'services.manage',
    ]) {
      expect(perms).toContain(code)
    }
    // Catalogue management does not imply general admin access.
    expect(perms).not.toContain('admin.access')
  })
})

describe('no public member booking', () => {
  it('defines no member or booking routes in the route tree', () => {
    const routeTree = readFileSync(
      join(process.cwd(), 'src', 'routeTree.gen.ts'),
      'utf8',
    )
    expect(routeTree).not.toMatch(/book/i)
    expect(routeTree).not.toMatch(/member/i)
    expect(routeTree).not.toMatch(/appointment/i)
  })

  it('exposes members as plain name/type data with no identifiers or booking fields', async () => {
    const house = await getPublishedSacredHouseBySlug('abule-osun')
    for (const member of house!.members) {
      expect(Object.keys(member).sort()).toEqual(['displayName', 'memberType'])
    }
  })
})
