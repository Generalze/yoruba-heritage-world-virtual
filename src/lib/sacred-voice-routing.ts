/**
 * WHICH VOICE SPEAKS FOR WHICH SACRED HOUSE.
 *
 * A House's approved representative has a gender, and a machine that
 * speaks that House's approved words must speak in that voice. Getting
 * it wrong is not a cosmetic defect — it misrepresents the House to the
 * person praying — so the mapping is deterministic, server-side, and
 * unreachable from any request a user can make.
 *
 * TWO AUTHORITIES, DELIBERATELY.
 *
 *  1. The four launch Houses are PINNED HERE, in source, BY CODE. They
 *     were ruled on by the client and must not be quietly re-gendered
 *     by an UPDATE statement, so for these four the source map wins and
 *     a database row that disagrees is a hard failure rather than a
 *     silent override.
 *
 *  2. Every other House is governed DATA — `sacred_houses`
 *     .approved_voice_profile. A fifth House must not require a code
 *     deploy to be given a voice, and a mapping that lives only in
 *     source cannot be exercised by any test that owns its own House.
 *
 * Both authorities FAIL CLOSED. A House with no pinned entry and no
 * stored profile has no approved voice, and content belonging to it is
 * refused before a single byte reaches a paid provider.
 *
 * Keyed by CODE, never by database id or by any document's House
 * numbering — the V3 prayer pack, the Visual Bible pack and the image
 * pack each number these Houses in a different order, and none of the
 * three matches the schema.
 */

/** The approved production voices. Yoruba only, by policy: the only
 * approved machine-speech language for sacred text. */
export const SACRED_VOICE_PROFILES = ['YO_MALE', 'YO_FEMALE'] as const
export type SacredVoiceProfile = (typeof SACRED_VOICE_PROFILES)[number]

/**
 * The client-ruled launch mapping. Ilé Àwọn Babaláwo and Abúlé Ọ̀sanyìn
 * /Àjà speak with a man's voice; Abúlé Ọ̀ṣun and Abúlé Ajé with a
 * woman's.
 */
export const SACRED_HOUSE_VOICE_PROFILE = {
  ILE_AWON_BABALAWO: 'YO_MALE',
  ABULE_OSUN: 'YO_FEMALE',
  ABULE_AJE: 'YO_FEMALE',
  ABULE_OSANYIN_AJA: 'YO_MALE',
} as const satisfies Record<string, SacredVoiceProfile>

export type PinnedSacredHouseCode = keyof typeof SACRED_HOUSE_VOICE_PROFILE

/** The pinned profile for a House code, or null when the code is not
 * one of the four ruled launch Houses. */
export function pinnedVoiceProfile(
  houseCode: string | null | undefined,
): SacredVoiceProfile | null {
  if (houseCode == null) return null
  return Object.hasOwn(SACRED_HOUSE_VOICE_PROFILE, houseCode)
    ? SACRED_HOUSE_VOICE_PROFILE[houseCode as PinnedSacredHouseCode]
    : null
}

/** Bounded machine reasons — never a raw string, never House content. */
export type VoiceProfileRefusal =
  /** The content is not scoped to a Sacred House at all, so there is no
   * House whose voice it could be spoken in. */
  | 'sacred_house_missing'
  /** A real House with no pinned entry and no governed profile. */
  | 'voice_profile_unassigned'
  /** A pinned House whose stored profile contradicts the ruling. */
  | 'voice_profile_conflict'

export type VoiceProfileResolution =
  | { ok: true; profile: SacredVoiceProfile }
  | { ok: false; reasonCode: VoiceProfileRefusal }

/**
 * Resolves the one approved voice for a House. Pure, total, and with
 * no default arm: everything that is not a proven mapping is a refusal.
 */
export function resolveHouseVoiceProfile(house: {
  code: string | null | undefined
  approvedVoiceProfile: SacredVoiceProfile | null | undefined
}): VoiceProfileResolution {
  if (house.code == null || house.code.trim() === '') {
    return { ok: false, reasonCode: 'sacred_house_missing' }
  }
  const pinned = pinnedVoiceProfile(house.code)
  const stored = house.approvedVoiceProfile ?? null
  if (pinned != null) {
    // Tamper-evident: for a ruled House the source is authority, and a
    // row that says otherwise stops the synthesis rather than winning
    // it. Silence here would be the one failure mode that matters.
    if (stored != null && stored !== pinned) {
      return { ok: false, reasonCode: 'voice_profile_conflict' }
    }
    return { ok: true, profile: pinned }
  }
  if (stored != null) return { ok: true, profile: stored }
  return { ok: false, reasonCode: 'voice_profile_unassigned' }
}
