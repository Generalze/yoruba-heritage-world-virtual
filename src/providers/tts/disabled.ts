import { TtsProviderError } from './types'
import type { TtsProvider } from './types'

/**
 * The HONEST absence of a speech-synthesis backend (Phase One,
 * Step 20).
 *
 * No external TTS vendor has been approved for this platform, and this
 * codebase does not choose one on its own initiative. This provider is
 * the truthful production configuration in the meantime: synthesis is
 * unavailable, and every request for it is refused loudly rather than
 * skipped quietly.
 *
 * WHY THIS MATTERS MORE HERE THAN ANYWHERE ELSE. A skipped TTS
 * requirement does not produce a shorter video; it produces a
 * recording in which an approved prayer is silently missing its voice.
 * So the refusal is deterministic and non-retryable, and it travels
 * through the audio stage's ordinary bounded-failure path where it is
 * recorded and visible.
 *
 * HUMAN RECORDINGS ARE UNAFFECTED. EXISTING_HUMAN_AUDIO requirements
 * are re-verified in place and never synthesized, so a manifest built
 * entirely from approved human recordings never touches this provider
 * and runs exactly as before.
 */
export const DISABLED_TTS_CODE = 'DISABLED'

function refuse(): never {
  throw new TtsProviderError(
    'tts_disabled',
    'No approved speech-synthesis adapter is configured for this deployment.',
    // Deterministic, not transient: retrying cannot install a vendor.
    false,
  )
}

export function createDisabledTtsProvider(): TtsProvider {
  return {
    code: DISABLED_TTS_CODE,
    displayName: 'Speech synthesis unavailable',
    // No language is "supported" here, but null is still correct: the
    // isEnabled() refusal fires first and is the honest reason.
    supportedLanguages: null,
    isEnabled() {
      return false
    },
    submitSpeech: refuse,
    pollSpeech: refuse,
  }
}
