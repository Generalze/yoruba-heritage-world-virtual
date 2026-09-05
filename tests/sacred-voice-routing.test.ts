import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  SACRED_HOUSE_VOICE_PROFILE,
  SACRED_VOICE_PROFILES,
  pinnedVoiceProfile,
  resolveHouseVoiceProfile,
} from '@/lib/sacred-voice-routing'

/**
 * ============================================================================
 * WHICH VOICE SPEAKS FOR WHICH HOUSE
 *
 * A wrong answer here is not a rendering glitch: it puts a man's voice
 * on Abúlé Ọ̀ṣun's approved prayer, or a woman's on Ilé Àwọn Babaláwo's,
 * in front of the person praying. So the mapping is pinned in both
 * directions — the right voice arrives AND the wrong one is provably
 * unreachable — and everything unproven refuses rather than guesses.
 * ============================================================================
 */

const source = readFileSync(
  resolve(import.meta.dir, '../src/lib/sacred-voice-routing.ts'),
  'utf8',
)

const NEWLINE = String.fromCharCode(10)

/** Prose explains the rule; only the CODE enforces it. Scans below run
 * against the executable lines so a comment can neither trip a guard
 * nor satisfy one. */
function withoutComments(text: string): string {
  return text
    .split(NEWLINE)
    .filter((line) => {
      const trimmed = line.trimStart()
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith('//') &&
        !trimmed.startsWith('*') &&
        !trimmed.startsWith('/*')
      )
    })
    .join(NEWLINE)
}

const code = withoutComments(source)

describe('the ruled mapping', () => {
  it('is exactly the four launch Houses the client ruled on', () => {
    expect(Object.keys(SACRED_HOUSE_VOICE_PROFILE).sort()).toEqual([
      'ABULE_AJE',
      'ABULE_OSANYIN_AJA',
      'ABULE_OSUN',
      'ILE_AWON_BABALAWO',
    ])
  })

  it('maps each House to its ruled voice, by code', () => {
    // BY CODE, never by ordinal: the V3 prayer pack, the Visual Bible
    // pack and the image pack each number these Houses differently and
    // none of the three agrees with the database.
    expect(SACRED_HOUSE_VOICE_PROFILE.ILE_AWON_BABALAWO).toBe('YO_MALE')
    expect(SACRED_HOUSE_VOICE_PROFILE.ABULE_OSANYIN_AJA).toBe('YO_MALE')
    expect(SACRED_HOUSE_VOICE_PROFILE.ABULE_OSUN).toBe('YO_FEMALE')
    expect(SACRED_HOUSE_VOICE_PROFILE.ABULE_AJE).toBe('YO_FEMALE')
  })

  it('never lets a woman-voiced House resolve to the male voice', () => {
    for (const code of ['ABULE_OSUN', 'ABULE_AJE']) {
      expect(pinnedVoiceProfile(code)).toBe('YO_FEMALE')
      // Including when a database row says otherwise.
      const forced = resolveHouseVoiceProfile({
        code,
        approvedVoiceProfile: 'YO_MALE',
      })
      expect(forced.ok).toBe(false)
      if (forced.ok) return
      expect(forced.reasonCode).toBe('voice_profile_conflict')
    }
  })

  it('never lets a man-voiced House resolve to the female voice', () => {
    for (const code of ['ILE_AWON_BABALAWO', 'ABULE_OSANYIN_AJA']) {
      expect(pinnedVoiceProfile(code)).toBe('YO_MALE')
      const forced = resolveHouseVoiceProfile({
        code,
        approvedVoiceProfile: 'YO_FEMALE',
      })
      expect(forced.ok).toBe(false)
      if (forced.ok) return
      expect(forced.reasonCode).toBe('voice_profile_conflict')
    }
  })

  it('lets the ruling win over the row, rather than the row over the ruling', () => {
    // A pinned House with an AGREEING row resolves; a disagreeing row
    // stops the synthesis. What it never does is quietly accept the
    // row — an UPDATE must not be able to re-gender a Sacred House.
    const agreeing = resolveHouseVoiceProfile({
      code: 'ABULE_OSUN',
      approvedVoiceProfile: 'YO_FEMALE',
    })
    expect(agreeing).toEqual({ ok: true, profile: 'YO_FEMALE' })
    const silent = resolveHouseVoiceProfile({
      code: 'ABULE_OSUN',
      approvedVoiceProfile: null,
    })
    expect(silent).toEqual({ ok: true, profile: 'YO_FEMALE' })
  })
})

describe('everything unproven refuses', () => {
  it('refuses content that belongs to no House at all', () => {
    for (const code of [null, undefined, '', '   ']) {
      const result = resolveHouseVoiceProfile({
        code,
        approvedVoiceProfile: null,
      })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reasonCode).toBe('sacred_house_missing')
    }
  })

  it('refuses a real House that has never been given a voice', () => {
    // A fifth House exists the moment somebody creates one. It has no
    // approved voice until a person assigns one, and until then its
    // words are not spoken by a machine at all.
    const result = resolveHouseVoiceProfile({
      code: 'ABULE_SOMETHING_NEW',
      approvedVoiceProfile: null,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reasonCode).toBe('voice_profile_unassigned')
  })

  it('honours a governed voice for a House the ruling does not name', () => {
    expect(
      resolveHouseVoiceProfile({
        code: 'ABULE_SOMETHING_NEW',
        approvedVoiceProfile: 'YO_FEMALE',
      }),
    ).toEqual({ ok: true, profile: 'YO_FEMALE' })
  })

  it('cannot be reached through a prototype key', () => {
    // Object.hasOwn, not `in`: 'constructor' and 'toString' are not
    // Sacred Houses and must not resolve to a voice.
    for (const code of ['constructor', 'toString', '__proto__']) {
      expect(pinnedVoiceProfile(code)).toBeNull()
    }
  })
})

describe('the shape of the rule itself', () => {
  it('offers exactly two production voices', () => {
    expect([...SACRED_VOICE_PROFILES]).toEqual(['YO_MALE', 'YO_FEMALE'])
  })

  it('has no default arm anywhere in its source', () => {
    // The failure mode that matters is not "throws" — it is "quietly
    // picks one". So the resolver may not contain a fallback to either
    // named voice.
    const body = code.slice(code.indexOf('export function resolveHouseVoiceProfile'))
    expect(body.length).toBeGreaterThan(0)
    expect(body).not.toContain("?? 'YO_MALE'")
    expect(body).not.toContain("?? 'YO_FEMALE'")
    expect(body).not.toContain("|| 'YO_MALE'")
    expect(body).not.toContain("|| 'YO_FEMALE'")
    expect(body).not.toContain('SACRED_VOICE_PROFILES[0]')
  })

  it('is decided from the House alone — nothing a caller can send', () => {
    // No request, no appointment, no user, no locale, no name. The
    // resolver's whole input surface is a House code and a stored
    // profile, so there is nothing here that a booking could steer.
    for (const forbidden of [
      'userId',
      'appointmentId',
      'recipientName',
      'request',
      'preferred',
      'override',
    ]) {
      expect(code).not.toContain(forbidden)
    }
  })
})
