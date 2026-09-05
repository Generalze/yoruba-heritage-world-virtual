import { eq } from 'drizzle-orm'

import { getDb, getPool } from '@/db'
import {
  deities,
  deitySacredHouses,
  sacredHouseFocusAreas,
  sacredHouseMembers,
  sacredHouses,
  sacredHouseBookingSettings,
  services,
  spiritualInterests,
} from '@/db/schema'
import { SACRED_HOUSE_VOICE_PROFILE } from '@/lib/sacred-voice-routing'
import type { MemberType } from '@/db/schema'

/**
 * Idempotent spiritual-domain catalogue seed (Phase One, Step 3).
 *
 * EVERY display string below is copied verbatim from the approved
 * Yorùbá Heritage Sacred House specification. Nothing here is
 * invented: no descriptions, prices, durations, symbols, histories or
 * theological content — such fields stay null until authorised
 * cultural/spiritual leadership approves content (canon §1, §44).
 *
 * Olódùmárè is deliberately NOT seeded here: the approved
 * specification requires Olódùmárè to be presented separately, never
 * as one deity record among equivalents (see /olodumare route).
 *
 * Re-running updates approved identity fields (name, slug, ordering)
 * but never overrides status/active/description — those belong to
 * future authorised administrators. The database, not this file, is
 * the source of truth; admins can add further records later.
 *
 * Run with: bun run db:seed:domain
 */

const APPROVED_DEITIES = [
  { code: 'OBATALA', name: 'Ọbàtálá', slug: 'obatala' },
  { code: 'OSUN', name: 'Ọ̀ṣun', slug: 'osun' },
  {
    code: 'AJE_SALUGA_OLOKUN',
    name: 'Ajé Ṣalúgà / Ajé Olókun',
    slug: 'aje-saluga-olokun',
  },
  { code: 'OSANYIN', name: 'Ọ̀sanyìn', slug: 'osanyin' },
  { code: 'ORUNMILA', name: 'Ọ̀rúnmìlà', slug: 'orunmila' },
  { code: 'SANGO', name: 'Ṣàngó', slug: 'sango' },
  { code: 'OGUN', name: 'Ògún', slug: 'ogun' },
  { code: 'YEMOJA', name: 'Yemoja', slug: 'yemoja' },
] as const

const APPROVED_SACRED_HOUSES = [
  { code: 'ABULE_OSUN', name: 'Abúlé Ọ̀ṣun', slug: 'abule-osun' },
  {
    code: 'ABULE_AJE',
    name: 'Abúlé Ajé Ṣalúgà / Ajé Olókun',
    slug: 'abule-aje',
  },
  {
    code: 'ABULE_OSANYIN_AJA',
    name: 'Abúlé Ọ̀sanyìn àti Àjà',
    slug: 'abule-osanyin-aja',
  },
  {
    code: 'ILE_AWON_BABALAWO',
    name: 'Ilé Àwọn Babaláwo',
    slug: 'ile-awon-babalawo',
  },
] as const

const APPROVED_FOCUS_AREAS: Record<string, ReadonlyArray<string>> = {
  ABULE_OSUN: [
    'Fertility prayers',
    'Conception',
    'Motherhood',
    'Pregnancy',
    'Children and descendants',
    'Family growth',
    'Family unity',
    'Emotional encouragement',
    'Spiritual preparation for motherhood',
  ],
  ABULE_AJE: [
    'Prosperity',
    'Financial progress',
    'Business growth',
    'Employment opportunities',
    'Open doors',
    'Financial discipline',
    'Protection against financial waste',
    'Fruitfulness in work',
    'Responsible stewardship',
    'Deliverance from repeated financial hardship',
  ],
  ABULE_OSANYIN_AJA: [
    'Total wellbeing',
    'Peace of mind',
    'Strength during illness',
    'Longevity',
    'Spiritual cleansing',
    'Protection',
    'Personal renewal',
    'Stability',
    'Harmony of body, mind and spirit',
    'Support during difficult periods',
  ],
  ILE_AWON_BABALAWO: [
    'Cleansing of the mind',
    'Divination',
    'Fortune telling',
    'Vindication by Olódùmárè',
    'Victory over enemies and adversity',
    'Deliverance from harmful spiritual influences',
    'Longevity',
    'Seeking power for good',
    'Ancestral communication',
    'Ancestral remembrance',
    'Spiritual reflection concerning deceased loved ones',
    'Visions concerning purpose and prosperity',
    'Cleansing of sins',
    'Forgiveness',
    'Reconciliation',
    'Personal direction',
    'Spiritual protection',
  ],
}

/** Broad service families only — not priced commercial packages. */
const APPROVED_SERVICE_FAMILIES: Record<
  string,
  ReadonlyArray<{ code: string; name: string; slug: string }>
> = {
  ABULE_OSUN: [
    { code: 'OSUN_FERTILITY', name: 'Fertility', slug: 'osun-fertility' },
    { code: 'OSUN_FAMILY', name: 'Family', slug: 'osun-family' },
    { code: 'OSUN_MOTHERHOOD', name: 'Motherhood', slug: 'osun-motherhood' },
  ],
  ABULE_AJE: [
    { code: 'AJE_PROSPERITY', name: 'Prosperity', slug: 'aje-prosperity' },
    {
      code: 'AJE_FINANCIAL_DOMINION',
      name: 'Financial Dominion',
      slug: 'aje-financial-dominion',
    },
  ],
  ABULE_OSANYIN_AJA: [
    { code: 'OSANYIN_WELLBEING', name: 'Wellbeing', slug: 'osanyin-wellbeing' },
    { code: 'OSANYIN_CLEANSING', name: 'Cleansing', slug: 'osanyin-cleansing' },
    {
      code: 'OSANYIN_PROTECTION',
      name: 'Protection',
      slug: 'osanyin-protection',
    },
  ],
  ILE_AWON_BABALAWO: [
    {
      code: 'BABALAWO_DIVINATION',
      name: 'Divination',
      slug: 'babalawo-divination',
    },
    {
      code: 'BABALAWO_CLEANSING',
      name: 'Cleansing',
      slug: 'babalawo-cleansing',
    },
    {
      code: 'BABALAWO_ANCESTRAL_GUIDANCE',
      name: 'Ancestral Guidance',
      slug: 'babalawo-ancestral-guidance',
    },
  ],
}

/**
 * The specification lists these people under "Prayer Warriors", so all
 * carry PRAYER_WARRIOR. No member list is provided for Ilé Àwọn
 * Babaláwo — none is invented. No accounts, contacts, or booking.
 */
const APPROVED_MEMBERS: Record<
  string,
  ReadonlyArray<{ name: string; type: MemberType }>
> = {
  ABULE_OSUN: [
    { name: 'Mama Iyanuoluwa', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Abike', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Morenike', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Oreofeoluwa', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Odusina', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Oluwapanilerin', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Atinuke', type: 'PRAYER_WARRIOR' },
  ],
  ABULE_AJE: [
    { name: 'Mama Aṣẹoluwa', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Aduragba', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Ibukunoluwa', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Itunu', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Abusiolodumare', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Ayomikun', type: 'PRAYER_WARRIOR' },
    { name: 'Baba Aduragba', type: 'PRAYER_WARRIOR' },
  ],
  ABULE_OSANYIN_AJA: [
    { name: 'Mama Obanifemi', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Modupeobami', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Afokonbale', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Kadaradun', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Ayanmo Ire', type: 'PRAYER_WARRIOR' },
    { name: 'Mama Ori Ire', type: 'PRAYER_WARRIOR' },
    { name: 'Baba Aduragba', type: 'PRAYER_WARRIOR' },
  ],
  ILE_AWON_BABALAWO: [],
}

/**
 * Only relationships the approved specification makes structurally
 * explicit. Ọbàtálá, Ọ̀rúnmìlà, Ṣàngó, Ògún and Yemoja are left
 * unlinked, and Ilé Àwọn Babaláwo is not linked to any deity — those
 * links require explicit approval, not inference.
 */
const APPROVED_DEITY_HOUSE_LINKS: ReadonlyArray<{
  deityCode: string
  houseCode: string
}> = [
  { deityCode: 'OSUN', houseCode: 'ABULE_OSUN' },
  { deityCode: 'AJE_SALUGA_OLOKUN', houseCode: 'ABULE_AJE' },
  { deityCode: 'OSANYIN', houseCode: 'ABULE_OSANYIN_AJA' },
]

/**
 * Deity ↔ service links: the specification establishes none
 * unambiguously, so none are seeded (the table exists for future
 * approved links).
 */

/**
 * Approved spiritual-interest catalogue (Step 4 §11 — explicitly
 * approved product structure). System-controlled: never AI-generated,
 * never user-editable, expanded only by deliberate product decision.
 */
const APPROVED_SPIRITUAL_INTERESTS: ReadonlyArray<{
  code: string
  name: string
}> = [
  { code: 'FERTILITY', name: 'Fertility' },
  { code: 'CONCEPTION', name: 'Conception' },
  { code: 'MOTHERHOOD', name: 'Motherhood' },
  { code: 'FAMILY', name: 'Family' },
  { code: 'PROSPERITY', name: 'Prosperity' },
  { code: 'BUSINESS', name: 'Business' },
  { code: 'EMPLOYMENT', name: 'Employment' },
  { code: 'FINANCIAL_STABILITY', name: 'Financial Stability' },
  { code: 'WELLBEING', name: 'Wellbeing' },
  { code: 'PROTECTION', name: 'Protection' },
  { code: 'PURIFICATION_CLEANSING', name: 'Purification / Cleansing' },
  { code: 'FORGIVENESS', name: 'Forgiveness' },
  { code: 'DIVINATION', name: 'Divination' },
  { code: 'ANCESTRAL_REMEMBRANCE', name: 'Ancestral Remembrance' },
  { code: 'VICTORY_OVER_ADVERSITY', name: 'Victory Over Adversity' },
  { code: 'PERSONAL_DIRECTION', name: 'Personal Direction' },
  { code: 'GRATITUDE', name: 'Gratitude' },
  { code: 'THANKSGIVING', name: 'Thanksgiving' },
]

export async function seedSpiritualInterests(): Promise<void> {
  const db = getDb()
  for (const [i, interest] of APPROVED_SPIRITUAL_INTERESTS.entries()) {
    await db
      .insert(spiritualInterests)
      .values({
        code: interest.code,
        name: interest.name,
        sortOrder: (i + 1) * 10,
      })
      .onDuplicateKeyUpdate({
        set: { name: interest.name, sortOrder: (i + 1) * 10 },
      })
  }
}

export async function seedDomain(): Promise<void> {
  const db = getDb()
  await seedSpiritualInterests()

  for (const [i, deity] of APPROVED_DEITIES.entries()) {
    await db
      .insert(deities)
      .values({
        code: deity.code,
        name: deity.name,
        slug: deity.slug,
        profileStatus: 'PUBLISHED',
        sortOrder: (i + 1) * 10,
      })
      .onDuplicateKeyUpdate({
        // Keep approved identity fields canonical; never touch
        // status/active/description of existing rows.
        set: { name: deity.name, slug: deity.slug, sortOrder: (i + 1) * 10 },
      })
  }

  for (const [i, house] of APPROVED_SACRED_HOUSES.entries()) {
    // The approved speaking voice is written from the pinned ruling, so
    // the row describes itself; it is never invented here, and for
    // these four the source map remains the authority at runtime.
    const approvedVoiceProfile = SACRED_HOUSE_VOICE_PROFILE[house.code]
    await db
      .insert(sacredHouses)
      .values({
        code: house.code,
        name: house.name,
        slug: house.slug,
        approvedVoiceProfile,
        status: 'PUBLISHED',
        sortOrder: (i + 1) * 10,
      })
      .onDuplicateKeyUpdate({
        set: {
          name: house.name,
          slug: house.slug,
          approvedVoiceProfile,
          sortOrder: (i + 1) * 10,
        },
      })
  }

  const houseIdByCode = new Map<string, number>()
  for (const house of APPROVED_SACRED_HOUSES) {
    const row = (
      await db
        .select({ id: sacredHouses.id })
        .from(sacredHouses)
        .where(eq(sacredHouses.code, house.code))
        .limit(1)
    ).at(0)
    if (!row) throw new Error(`Sacred House ${house.code} missing after seed`)
    houseIdByCode.set(house.code, row.id)
  }

  const deityIdByCode = new Map<string, number>()
  for (const deity of APPROVED_DEITIES) {
    const row = (
      await db
        .select({ id: deities.id })
        .from(deities)
        .where(eq(deities.code, deity.code))
        .limit(1)
    ).at(0)
    if (!row) throw new Error(`Deity ${deity.code} missing after seed`)
    deityIdByCode.set(deity.code, row.id)
  }

  for (const [houseCode, labels] of Object.entries(APPROVED_FOCUS_AREAS)) {
    const sacredHouseId = houseIdByCode.get(houseCode)!
    for (const [i, label] of labels.entries()) {
      await db
        .insert(sacredHouseFocusAreas)
        .values({ sacredHouseId, label, sortOrder: (i + 1) * 10 })
        .onDuplicateKeyUpdate({ set: { sortOrder: (i + 1) * 10 } })
    }
  }

  for (const [houseCode, families] of Object.entries(
    APPROVED_SERVICE_FAMILIES,
  )) {
    const sacredHouseId = houseIdByCode.get(houseCode)!
    for (const [i, family] of families.entries()) {
      await db
        .insert(services)
        .values({
          sacredHouseId,
          code: family.code,
          name: family.name,
          slug: family.slug,
          serviceStatus: 'PUBLISHED',
          sortOrder: (i + 1) * 10,
          // No price, duration or currency: not yet approved.
        })
        .onDuplicateKeyUpdate({
          set: {
            name: family.name,
            slug: family.slug,
            sortOrder: (i + 1) * 10,
          },
        })
    }
  }

  for (const [houseCode, members] of Object.entries(APPROVED_MEMBERS)) {
    const sacredHouseId = houseIdByCode.get(houseCode)!
    for (const [i, member] of members.entries()) {
      await db
        .insert(sacredHouseMembers)
        .values({
          sacredHouseId,
          displayName: member.name,
          memberType: member.type,
          sortOrder: (i + 1) * 10,
        })
        .onDuplicateKeyUpdate({ set: { sortOrder: (i + 1) * 10 } })
    }
  }

  // Default booking settings for each House: booking_enabled stays
  // FALSE — seeding never opens a House for appointments, and no
  // working hours are ever seeded. Admins configure real values.
  for (const houseId of houseIdByCode.values()) {
    await db
      .insert(sacredHouseBookingSettings)
      .values({ sacredHouseId: houseId })
      .onDuplicateKeyUpdate({ set: { sacredHouseId: houseId } })
  }

  for (const [i, link] of APPROVED_DEITY_HOUSE_LINKS.entries()) {
    await db
      .insert(deitySacredHouses)
      .values({
        deityId: deityIdByCode.get(link.deityCode)!,
        sacredHouseId: houseIdByCode.get(link.houseCode)!,
        sortOrder: (i + 1) * 10,
      })
      .onDuplicateKeyUpdate({ set: { sortOrder: (i + 1) * 10 } })
  }
}

if (import.meta.main) {
  await seedDomain()
  console.log(
    'Domain catalogue seeded (idempotent): 8 deities, 4 Sacred Houses, focus areas, service families, members, explicit deity-house links, and 18 spiritual interests.',
  )
  await getPool().end()
}
