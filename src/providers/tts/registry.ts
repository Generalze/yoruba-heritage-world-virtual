import { env } from '@/lib/env'
import { createDisabledTtsProvider } from './disabled'
import { createMockTtsProvider } from './mock'
import { createNaijalingoTtsProvider } from './naijalingo'
import { TtsProviderError } from './types'
import type { TtsProvider } from './types'

/**
 * Speech-synthesis provider access point (Phase One, Step 15/20). The
 * ONLY way the executor service obtains a provider — mirrors the
 * Step 14 visual-generation registry and the
 * `src/providers/media/storage.ts` single-active-provider pattern
 * (there is exactly one real provider slot, swappable for tests,
 * rather than the multi-provider Map registry payments uses for
 * several simultaneously-enabled checkout options).
 *
 * THREE configurations exist, selected by TTS_DRIVER: the
 * deterministic MOCK (development and test only — refused in
 * production), DISABLED (the honest statement that no speech backend
 * is configured), and 9JALINGO — the approved production adapter,
 * synchronous and Yoruba-only, configured entirely from server
 * environment variables. There is no fallback among them: a selected
 * driver either constructs completely or stops the process.
 */

let overrideProvider: TtsProvider | null = null
let defaultProvider: TtsProvider | null = null

/**
 * EXPLICIT SELECTION ONLY. The driver is a validated enum, so an
 * unknown value stops the process at configuration time in EVERY
 * environment; the default branch below throws rather than falling back
 * to the mock, so a value added to the enum and forgotten here cannot
 * silently start speaking approved prayer in a synthetic voice.
 */
export function getTtsProvider(): TtsProvider {
  if (overrideProvider) return overrideProvider
  if (defaultProvider) return defaultProvider
  switch (env.TTS_DRIVER) {
    case 'MOCK':
      defaultProvider = createMockTtsProvider()
      break
    case 'DISABLED':
      defaultProvider = createDisabledTtsProvider()
      break
    case '9JALINGO':
      // Constructed from server env only; an incomplete configuration
      // throws here rather than producing a half-configured paid
      // client. There is NO fallback to MOCK or DISABLED.
      defaultProvider = createNaijalingoTtsProvider()
      break
    default:
      throw new TtsProviderError(
        'tts_driver_unknown',
        'TTS_DRIVER names no implemented adapter; the mock is never a substitute.',
        false,
      )
  }
  return defaultProvider
}

/** Drops the memoized provider so a configuration change (or a test
 * that varies the driver) is observed rather than cached forever. */
export function resetTtsDefaultForTests(): void {
  defaultProvider = null
}

/**
 * Resolves the provider a PERSISTED provider code refers to — the ONLY
 * legitimate way to continue a synthesis some earlier cycle submitted.
 *
 * An opaque provider operation id is meaningless outside the provider
 * that issued it: polling it against whichever provider happens to be
 * active later would ask the wrong backend about someone else's job and
 * accept whatever it answered — for speech, that means accepting an
 * arbitrary recording as the voice of approved sacred text. So this
 * resolves BY CODE and fails CLOSED (null) on any mismatch rather than
 * silently substituting the active provider.
 */
export function resolveTtsProvider(providerCode: string): TtsProvider | null {
  const active = getTtsProvider()
  return active.code === providerCode ? active : null
}

export function setTtsProviderForTests(provider: TtsProvider): void {
  overrideProvider = provider
}

export function resetTtsProviderForTests(): void {
  overrideProvider = null
}
