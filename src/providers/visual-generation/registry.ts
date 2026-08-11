import { env } from '@/lib/env'
import { createDisabledVisualGenerationProvider } from './disabled'
import { createKlingVisualGenerationProvider } from './kling'
import { createMockVisualGenerationProvider } from './mock'
import { VisualGenerationProviderError } from './types'
import type { VisualGenerationProvider } from './types'

/**
 * Visual generation provider access point (Phase One, Step 14/20). The
 * ONLY way the executor service obtains a provider — mirrors the
 * `src/providers/media/storage.ts` single-active-provider pattern
 * (there is exactly one real provider slot, swappable for tests, rather
 * than the multi-provider Map registry payments uses for several
 * simultaneously-enabled checkout options).
 *
 * THREE configurations exist, selected by VISUAL_GENERATION_DRIVER:
 * the deterministic MOCK (development and test only — refused in
 * production), DISABLED (the honest statement that no generation
 * backend is configured), and KLING — the approved production
 * text-to-video adapter (Kling API 2.0), configured entirely from
 * server environment variables. There is no fallback among them: a
 * selected driver either constructs completely or stops the process.
 */

let overrideProvider: VisualGenerationProvider | null = null
let defaultProvider: VisualGenerationProvider | null = null

/**
 * EXPLICIT SELECTION ONLY. The driver is a validated enum, so an
 * unknown value stops the process at configuration time in EVERY
 * environment; the default branch below throws rather than falling back
 * to the mock, so a value added to the enum and forgotten here cannot
 * silently start generating synthetic imagery.
 */
export function getVisualGenerationProvider(): VisualGenerationProvider {
  if (overrideProvider) return overrideProvider
  if (defaultProvider) return defaultProvider
  switch (env.VISUAL_GENERATION_DRIVER) {
    case 'MOCK':
      defaultProvider = createMockVisualGenerationProvider()
      break
    case 'DISABLED':
      defaultProvider = createDisabledVisualGenerationProvider()
      break
    case 'KLING':
      // Constructed from server env only; an incomplete configuration
      // throws here rather than producing a half-configured paid
      // client. There is NO fallback to MOCK or DISABLED.
      defaultProvider = createKlingVisualGenerationProvider()
      break
    default:
      throw new VisualGenerationProviderError(
        'visual_generation_driver_unknown',
        'VISUAL_GENERATION_DRIVER names no implemented adapter; the mock is never a substitute.',
        false,
      )
  }
  return defaultProvider
}

/** Drops the memoized provider so a configuration change (or a test
 * that varies the driver) is observed rather than cached forever. */
export function resetVisualGenerationDefaultForTests(): void {
  defaultProvider = null
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
