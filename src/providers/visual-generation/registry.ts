import { createMockVisualGenerationProvider } from './mock'
import type { VisualGenerationProvider } from './types'

/**
 * Visual generation provider access point (Phase One, Step 14). The
 * ONLY way the executor service obtains a provider — mirrors the
 * `src/providers/media/storage.ts` single-active-provider pattern
 * (there is exactly one real provider slot, swappable for tests, rather
 * than the multi-provider Map registry payments uses for several
 * simultaneously-enabled checkout options).
 *
 * Only the mock exists at this stage; a future real adapter (Kling/
 * OpenArt) plugs in here behind the SAME VisualGenerationProvider
 * interface with no change to the executor service.
 */

let overrideProvider: VisualGenerationProvider | null = null
let defaultProvider: VisualGenerationProvider | null = null

export function getVisualGenerationProvider(): VisualGenerationProvider {
  if (overrideProvider) return overrideProvider
  defaultProvider ??= createMockVisualGenerationProvider()
  return defaultProvider
}

/**
 * Resolves the provider a PERSISTED provider code refers to — the ONLY
 * legitimate way to continue an operation that some earlier cycle
 * submitted.
 *
 * An opaque provider operation id is meaningless outside the provider
 * that issued it: polling it against whichever provider happens to be
 * active later would ask the wrong backend about someone else's job and
 * accept whatever it answered. So this resolves BY CODE and fails
 * CLOSED (null) on any mismatch rather than silently substituting the
 * active provider.
 *
 * With MOCK the only implementation, "resolution" is a code equality
 * check against the single active slot; when a second real adapter
 * lands, this becomes the lookup and every caller is already binding
 * correctly.
 */
export function resolveVisualGenerationProvider(
  providerCode: string,
): VisualGenerationProvider | null {
  const active = getVisualGenerationProvider()
  return active.code === providerCode ? active : null
}

export function setVisualGenerationProviderForTests(
  provider: VisualGenerationProvider,
): void {
  overrideProvider = provider
}

export function resetVisualGenerationProviderForTests(): void {
  overrideProvider = null
}
