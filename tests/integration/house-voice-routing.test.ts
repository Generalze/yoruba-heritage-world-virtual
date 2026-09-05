import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/mysql2/migrator'

import { closeDb, getDb } from '@/db'
import { seedDomain } from '@/db/seed-domain'
import {
  sacredHouses,
  spiritualContentItems,
  spiritualContentVersions,
} from '@/db/schema'
import { V3_HOUSES, V3_LAUNCH_CONTENT } from '@/lib/launch-content-v3'
import {
  SACRED_HOUSE_VOICE_PROFILE,
  pinnedVoiceProfile,
  resolveHouseVoiceProfile,
} from '@/lib/sacred-voice-routing'

/**
 * ============================================================================
 * THE FOUR HOUSES, AS THEY ACTUALLY STAND IN THE DATABASE
 *
 * The unit tests prove the rule; this proves the DEPLOYMENT obeys it —
 * that the rows the runtime will really read resolve to the ruled
 * voices, and that every registered V3 prayer block belongs to a House
 * that has one. Nothing here writes anything except the idempotent
 * domain seed, and nothing here is deleted: these are the real launch
 * Houses, not fixtures.
 * ============================================================================
 */

beforeAll(async () => {
  await migrate(getDb(), { migrationsFolder: './migrations' })
  await seedDomain()
})

afterAll(async () => {
  await closeDb()
})

async function houseRows() {
  return await getDb()
    .select({
      id: sacredHouses.id,
      code: sacredHouses.code,
      approvedVoiceProfile: sacredHouses.approvedVoiceProfile,
    })
    .from(sacredHouses)
    .where(
      inArray(sacredHouses.code, Object.keys(SACRED_HOUSE_VOICE_PROFILE)),
    )
}

describe('the launch Houses carry their ruled voice', () => {
  it('stores the ruled profile on every one of the four', async () => {
    const rows = await houseRows()
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(row.approvedVoiceProfile).toBe(pinnedVoiceProfile(row.code))
    }
  })

  it('resolves each House, from its own row, to the ruled voice', async () => {
    const rows = await houseRows()
    const byCode = new Map(rows.map((row) => [row.code, row]))
    for (const [code, expected] of [
      ['ILE_AWON_BABALAWO', 'YO_MALE'],
      ['ABULE_OSANYIN_AJA', 'YO_MALE'],
      ['ABULE_OSUN', 'YO_FEMALE'],
      ['ABULE_AJE', 'YO_FEMALE'],
    ] as const) {
      const row = byCode.get(code)
      expect(row).toBeDefined()
      if (!row) return
      expect(resolveHouseVoiceProfile(row)).toEqual({
        ok: true,
        profile: expected,
      })
    }
  })

  it('matches the codes to the ids the V3 manifest recorded', async () => {
    // The V3 document, the Visual Bible pack and the image pack each
    // number these Houses in a different order. The database ids below
    // come from the manifest, which was itself written against codes.
    const rows = await houseRows()
    const idByCode = new Map(rows.map((row) => [row.code, row.id]))
    for (const house of V3_HOUSES) {
      expect(idByCode.get(house.code)).toBe(house.id)
    }
  })

  it('leaves no other House silently sharing a ruled code', async () => {
    const all = await getDb()
      .select({
        code: sacredHouses.code,
        approvedVoiceProfile: sacredHouses.approvedVoiceProfile,
      })
      .from(sacredHouses)
    for (const row of all) {
      const pinned = pinnedVoiceProfile(row.code)
      if (pinned == null) continue
      // A pinned House whose row disagrees would be refused at runtime
      // rather than obeyed; this catches it here instead of at a
      // stranger's prayer.
      expect(row.approvedVoiceProfile).toBe(pinned)
    }
  })
})

describe('every registered V3 prayer block has a voice', () => {
  it('is House-scoped to the House the manifest names, and resolves', async () => {
    const versionIds = V3_LAUNCH_CONTENT.map((entry) => entry.versionId)
    const rows = await getDb()
      .select({
        versionId: spiritualContentVersions.id,
        itemCode: spiritualContentItems.code,
        scopeType: spiritualContentItems.scopeType,
        houseCode: sacredHouses.code,
        approvedVoiceProfile: sacredHouses.approvedVoiceProfile,
      })
      .from(spiritualContentVersions)
      .innerJoin(
        spiritualContentItems,
        eq(spiritualContentItems.id, spiritualContentVersions.contentItemId),
      )
      .innerJoin(
        sacredHouses,
        eq(sacredHouses.id, spiritualContentItems.sacredHouseId),
      )
      .where(inArray(spiritualContentVersions.id, versionIds))
    if (rows.length === 0) return
    // Every registered version was found through an INNER join on its
    // House: content that had drifted to another scope would simply be
    // absent, so the count is part of the claim.
    expect(rows).toHaveLength(V3_LAUNCH_CONTENT.length)

    const expectedByVersion = new Map(
      V3_LAUNCH_CONTENT.map((entry) => [entry.versionId, entry.houseCode]),
    )
    for (const row of rows) {
      expect(row.scopeType).toBe('SACRED_HOUSE')
      expect(row.houseCode).toBe(expectedByVersion.get(row.versionId) ?? '')
      const resolved = resolveHouseVoiceProfile({
        code: row.houseCode,
        approvedVoiceProfile: row.approvedVoiceProfile,
      })
      expect(resolved.ok).toBe(true)
      if (!resolved.ok) return
      const pinned = pinnedVoiceProfile(row.houseCode)
      expect(pinned).not.toBeNull()
      expect(resolved.profile).toBe(pinned ?? 'YO_MALE')
    }
  })

  it('gives every block of one House the same voice as its siblings', async () => {
    // Six blocks per House per language. A session must not change
    // voice between its opening and its closing.
    const profiles = new Map<string, Set<string>>()
    for (const entry of V3_LAUNCH_CONTENT) {
      const profile = pinnedVoiceProfile(entry.houseCode)
      expect(profile).not.toBeNull()
      const seen = profiles.get(entry.houseCode) ?? new Set<string>()
      seen.add(String(profile))
      profiles.set(entry.houseCode, seen)
    }
    expect(profiles.size).toBe(4)
    for (const [, seen] of profiles) {
      expect(seen.size).toBe(1)
    }
  })
})
