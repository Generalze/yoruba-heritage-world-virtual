import { and, asc, eq } from 'drizzle-orm'

import { getDb } from '@/db'
import {
  deities,
  deitySacredHouses,
  deityServices,
  sacredHouseFocusAreas,
  sacredHouseMembers,
  sacredHouses,
  services,
} from '@/db/schema'

/**
 * Public catalogue queries (Phase One, Step 3).
 *
 * Publication filtering lives HERE, server-side, in one place: public
 * queries return only PUBLISHED + active rows — DRAFT, UNDER_REVIEW,
 * APPROVED (not yet published) and ARCHIVED records never leak.
 * Services additionally require their Sacred House to be publicly
 * visible. Admin-side any-status queries arrive with the admin CMS in
 * a later approved stage, guarded by *.view/*.manage permissions.
 */

const publicDeityFilter = and(
  eq(deities.profileStatus, 'PUBLISHED'),
  eq(deities.active, true),
)

const publicHouseFilter = and(
  eq(sacredHouses.status, 'PUBLISHED'),
  eq(sacredHouses.active, true),
)

const publicServiceFilter = and(
  eq(services.serviceStatus, 'PUBLISHED'),
  eq(services.active, true),
)

export interface PublicDeity {
  id: number
  name: string
  slug: string
  shortDescription: string | null
}

export interface PublicSacredHouseSummary {
  id: number
  name: string
  slug: string
  shortDescription: string | null
  focusAreas: Array<string>
}

export interface PublicServiceSummary {
  id: number
  name: string
  slug: string
  shortDescription: string | null
  durationMinutes: number | null
  priceMinor: number | null
  currency: string | null
}

export async function listPublishedDeities(): Promise<Array<PublicDeity>> {
  return getDb()
    .select({
      id: deities.id,
      name: deities.name,
      slug: deities.slug,
      shortDescription: deities.shortDescription,
    })
    .from(deities)
    .where(publicDeityFilter)
    .orderBy(asc(deities.sortOrder), asc(deities.name))
}

export interface PublicDeityProfile extends PublicDeity {
  sacredHouses: Array<{ id: number; name: string; slug: string }>
  services: Array<{ id: number; name: string; slug: string }>
}

export async function getPublishedDeityBySlug(
  slug: string,
): Promise<PublicDeityProfile | null> {
  const db = getDb()
  const deity = (
    await db
      .select({
        id: deities.id,
        name: deities.name,
        slug: deities.slug,
        shortDescription: deities.shortDescription,
      })
      .from(deities)
      .where(and(eq(deities.slug, slug), publicDeityFilter))
      .limit(1)
  ).at(0)
  if (!deity) return null

  const houses = await db
    .select({
      id: sacredHouses.id,
      name: sacredHouses.name,
      slug: sacredHouses.slug,
    })
    .from(deitySacredHouses)
    .innerJoin(
      sacredHouses,
      eq(deitySacredHouses.sacredHouseId, sacredHouses.id),
    )
    .where(and(eq(deitySacredHouses.deityId, deity.id), publicHouseFilter))
    .orderBy(asc(deitySacredHouses.sortOrder))

  // Deity ↔ service links exist in the model but none are approved yet;
  // this returns them if/when authorised links are added. The owning
  // Sacred House must itself be publicly visible — a published service
  // under a hidden House must never leak through a deity profile.
  const linkedServices = await db
    .select({ id: services.id, name: services.name, slug: services.slug })
    .from(deityServices)
    .innerJoin(services, eq(deityServices.serviceId, services.id))
    .innerJoin(sacredHouses, eq(services.sacredHouseId, sacredHouses.id))
    .where(
      and(
        eq(deityServices.deityId, deity.id),
        publicServiceFilter,
        publicHouseFilter,
      ),
    )
    .orderBy(asc(deityServices.sortOrder))

  return { ...deity, sacredHouses: houses, services: linkedServices }
}

export async function listPublishedSacredHouses(): Promise<
  Array<PublicSacredHouseSummary>
> {
  const db = getDb()
  const houses = await db
    .select({
      id: sacredHouses.id,
      name: sacredHouses.name,
      slug: sacredHouses.slug,
      shortDescription: sacredHouses.shortDescription,
    })
    .from(sacredHouses)
    .where(publicHouseFilter)
    .orderBy(asc(sacredHouses.sortOrder))

  const result: Array<PublicSacredHouseSummary> = []
  for (const house of houses) {
    const focusAreas = await db
      .select({ label: sacredHouseFocusAreas.label })
      .from(sacredHouseFocusAreas)
      .where(
        and(
          eq(sacredHouseFocusAreas.sacredHouseId, house.id),
          eq(sacredHouseFocusAreas.active, true),
        ),
      )
      .orderBy(asc(sacredHouseFocusAreas.sortOrder))
    result.push({ ...house, focusAreas: focusAreas.map((f) => f.label) })
  }
  return result
}

export interface PublicSacredHouseProfile extends PublicSacredHouseSummary {
  members: Array<{ displayName: string; memberType: string }>
  services: Array<PublicServiceSummary>
  deities: Array<{ id: number; name: string; slug: string }>
}

export async function getPublishedSacredHouseBySlug(
  slug: string,
): Promise<PublicSacredHouseProfile | null> {
  const db = getDb()
  const house = (
    await db
      .select({
        id: sacredHouses.id,
        name: sacredHouses.name,
        slug: sacredHouses.slug,
        shortDescription: sacredHouses.shortDescription,
      })
      .from(sacredHouses)
      .where(and(eq(sacredHouses.slug, slug), publicHouseFilter))
      .limit(1)
  ).at(0)
  if (!house) return null

  const focusAreas = await db
    .select({ label: sacredHouseFocusAreas.label })
    .from(sacredHouseFocusAreas)
    .where(
      and(
        eq(sacredHouseFocusAreas.sacredHouseId, house.id),
        eq(sacredHouseFocusAreas.active, true),
      ),
    )
    .orderBy(asc(sacredHouseFocusAreas.sortOrder))

  // Public list only — names and member type. No accounts, no contact
  // details, no booking: appointments belong to the House itself.
  const members = await db
    .select({
      displayName: sacredHouseMembers.displayName,
      memberType: sacredHouseMembers.memberType,
    })
    .from(sacredHouseMembers)
    .where(
      and(
        eq(sacredHouseMembers.sacredHouseId, house.id),
        eq(sacredHouseMembers.active, true),
      ),
    )
    .orderBy(asc(sacredHouseMembers.sortOrder))

  const houseServices = await db
    .select({
      id: services.id,
      name: services.name,
      slug: services.slug,
      shortDescription: services.shortDescription,
      durationMinutes: services.durationMinutes,
      priceMinor: services.priceMinor,
      currency: services.currency,
    })
    .from(services)
    .where(and(eq(services.sacredHouseId, house.id), publicServiceFilter))
    .orderBy(asc(services.sortOrder))

  const linkedDeities = await db
    .select({ id: deities.id, name: deities.name, slug: deities.slug })
    .from(deitySacredHouses)
    .innerJoin(deities, eq(deitySacredHouses.deityId, deities.id))
    .where(
      and(eq(deitySacredHouses.sacredHouseId, house.id), publicDeityFilter),
    )
    .orderBy(asc(deitySacredHouses.sortOrder))

  return {
    ...house,
    focusAreas: focusAreas.map((f) => f.label),
    members,
    services: houseServices,
    deities: linkedDeities,
  }
}

export interface PublicServiceGroup {
  sacredHouse: { id: number; name: string; slug: string }
  services: Array<PublicServiceSummary>
}

export async function listPublishedServicesByHouse(): Promise<
  Array<PublicServiceGroup>
> {
  const db = getDb()
  const rows = await db
    .select({
      houseId: sacredHouses.id,
      houseName: sacredHouses.name,
      houseSlug: sacredHouses.slug,
      id: services.id,
      name: services.name,
      slug: services.slug,
      shortDescription: services.shortDescription,
      durationMinutes: services.durationMinutes,
      priceMinor: services.priceMinor,
      currency: services.currency,
    })
    .from(services)
    .innerJoin(sacredHouses, eq(services.sacredHouseId, sacredHouses.id))
    .where(and(publicServiceFilter, publicHouseFilter))
    .orderBy(
      asc(sacredHouses.sortOrder),
      asc(services.sortOrder),
      asc(services.name),
    )

  const groups = new Map<number, PublicServiceGroup>()
  for (const row of rows) {
    let group = groups.get(row.houseId)
    if (!group) {
      group = {
        sacredHouse: {
          id: row.houseId,
          name: row.houseName,
          slug: row.houseSlug,
        },
        services: [],
      }
      groups.set(row.houseId, group)
    }
    group.services.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      shortDescription: row.shortDescription,
      durationMinutes: row.durationMinutes,
      priceMinor: row.priceMinor,
      currency: row.currency,
    })
  }
  return Array.from(groups.values())
}

export interface PublicServiceDetail extends PublicServiceSummary {
  sacredHouse: { id: number; name: string; slug: string }
}

export async function getPublishedServiceBySlug(
  slug: string,
): Promise<PublicServiceDetail | null> {
  const row = (
    await getDb()
      .select({
        id: services.id,
        name: services.name,
        slug: services.slug,
        shortDescription: services.shortDescription,
        durationMinutes: services.durationMinutes,
        priceMinor: services.priceMinor,
        currency: services.currency,
        houseId: sacredHouses.id,
        houseName: sacredHouses.name,
        houseSlug: sacredHouses.slug,
      })
      .from(services)
      .innerJoin(sacredHouses, eq(services.sacredHouseId, sacredHouses.id))
      .where(
        and(eq(services.slug, slug), publicServiceFilter, publicHouseFilter),
      )
      .limit(1)
  ).at(0)
  if (!row) return null

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    shortDescription: row.shortDescription,
    durationMinutes: row.durationMinutes,
    priceMinor: row.priceMinor,
    currency: row.currency,
    sacredHouse: { id: row.houseId, name: row.houseName, slug: row.houseSlug },
  }
}
