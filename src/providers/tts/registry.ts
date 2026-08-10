import { createMockTtsProvider } from './mock'
import type { TtsProvider } from './types'

/**
 * Speech-synthesis provider access point (Phase One, Step 15). The ONLY
 * way the executor service obtains a provider — mirrors the Step 14
 * visual-generation registry and the `src/providers/media/storage.ts`
 * single-active-provider pattern (there is exactly one real provider
 * slot, swappable for tests, rather than the multi-provider Map
 * registry payments uses for several simultaneously-enabled checkout
 * options).
 *
 * Only the mock exists at this stage; a future real adapter plugs in
 * here behind the SAME TtsProvider interface with no change to the
 * executor service.
 */

let overrideProvider: TtsProvider | null = null
let defaultProvider: TtsProvider | null = null

export function getTtsProvider(): TtsProvider {
  if (overrideProvider) return overrideProvider
  defaultProvider ??= createMockTtsProvider()
  return defaultProvider
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
