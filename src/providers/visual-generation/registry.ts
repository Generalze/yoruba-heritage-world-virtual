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

export function setVisualGenerationProviderForTests(
  provider: VisualGenerationProvider,
): void {
  overrideProvider = provider
}

export function resetVisualGenerationProviderForTests(): void {
  overrideProvider = null
}
