import { Composition } from 'remotion'

import {
  PRAYER_COMPOSITION_ID,
  PrayerComposition,
} from './PrayerComposition'
import type { PrayerCompositionProps } from './PrayerComposition'

/**
 * Remotion entry point (Phase One, Step 20).
 *
 * @remotion/bundler compiles THIS file at render time. It registers
 * exactly one composition and nothing else — there is no gallery of
 * templates to pick from, because the render plan is the only thing
 * that decides what a recording contains.
 *
 * The dimensions and frame rate here are placeholders overridden per
 * render by the adapter; the durationInFrames placeholder is likewise
 * replaced with the reconciled timeline length.
 */
export const REMOTION_FPS = 30
export const REMOTION_WIDTH = 1280
export const REMOTION_HEIGHT = 720

export function RemotionRoot() {
  return (
    <Composition
      id={PRAYER_COMPOSITION_ID}
      // Remotion types a registered component against a loose props
      // record; the composition's real props are the typed interface
      // the adapter builds, and defaultProps below is checked against
      // it with `satisfies`.
      component={
        PrayerComposition as unknown as React.FC<Record<string, unknown>>
      }
      durationInFrames={REMOTION_FPS}
      fps={REMOTION_FPS}
      width={REMOTION_WIDTH}
      height={REMOTION_HEIGHT}
      defaultProps={{ scenes: [], audio: [] } satisfies PrayerCompositionProps}
    />
  )
}
