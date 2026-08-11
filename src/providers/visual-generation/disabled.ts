import { VisualGenerationProviderError } from './types'
import type { VisualGenerationProvider } from './types'

/**
 * The HONEST absence of a visual-generation backend (Phase One,
 * Step 20).
 *
 * No external image/video generation vendor has been approved for this
 * platform, and this codebase does not choose one on its own
 * initiative. That leaves production exactly two truthful options, and
 * this is one of them: say so.
 *
 * WHY A PROVIDER OBJECT RATHER THAN A NULL. A null would have to be
 * handled at every call site, and the handling that gets written under
 * deadline is "skip it". Skipping is the one outcome that must be
 * impossible: a manifest task marked GENERATION_REQUIRED means a scene
 * has no approved picture, and a recording assembled without it is
 * missing something a person was promised. So the provider EXISTS, is
 * reported disabled, and refuses every call with a bounded,
 * non-retryable error that flows through the stage's ordinary failure
 * path — visible, recorded, and impossible to mistake for success.
 *
 * A manifest that requires NO generated visuals never reaches this
 * provider at all, so a Sacred House whose approved media covers every
 * scene runs perfectly well with it configured.
 */
export const DISABLED_VISUAL_GENERATION_CODE = 'DISABLED'

function refuse(): never {
  throw new VisualGenerationProviderError(
    'visual_generation_disabled',
    'No approved visual-generation adapter is configured for this deployment.',
    // Deterministic, not transient: retrying cannot install a vendor.
    false,
  )
}

export function createDisabledVisualGenerationProvider(): VisualGenerationProvider {
  return {
    code: DISABLED_VISUAL_GENERATION_CODE,
    displayName: 'Visual generation unavailable',
    isEnabled() {
      return false
    },
    submitScene: refuse,
    pollScene: refuse,
  }
}
