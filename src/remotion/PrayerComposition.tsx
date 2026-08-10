import {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  useVideoConfig,
} from 'remotion'

/**
 * THE composition, and the whole of what a real render may contain
 * (Phase One, Step 20).
 *
 * Read this file as a list of what is ABSENT. There is no text element,
 * no title, no caption, no subtitle track, no participant name, no
 * watermark, no logo, no lower third, no music bed, no ambient audio,
 * no transition that carries meaning, no filter and no effect. Not
 * because they were forgotten — because a compositor being technically
 * able to draw something is not authority to draw it. Every visible and
 * audible element here was named by the immutable render plan, and the
 * plan only ever names sources that human approval already cleared.
 *
 * It is also deliberately dumb. It makes no timing decisions: every
 * offset and duration arrives as an already-reconciled frame number.
 * Nothing here trims, stretches, loops, speeds or replaces audio — the
 * adapter refuses such a plan before this component is ever bundled.
 */

export interface PrayerCompositionScene {
  sceneId: string
  fromFrame: number
  durationInFrames: number
  /** file:// URL of a verified local source, or null when this scene
   * holds the previous picture. */
  src: string | null
  kind: 'IMAGE' | 'VIDEO'
  /** Where in the source video this scene starts, in frames. Always 0
   * for images and for a fresh video. */
  sourceStartFrame: number
}

export interface PrayerCompositionAudio {
  refId: string
  fromFrame: number
  durationInFrames: number
  src: string
}

export interface PrayerCompositionProps {
  scenes: Array<PrayerCompositionScene>
  audio: Array<PrayerCompositionAudio>
}

export const PRAYER_COMPOSITION_ID = 'prayer-recording'

export function PrayerComposition({ scenes, audio }: PrayerCompositionProps) {
  const { width, height } = useVideoConfig()
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {scenes.map((scene) =>
        scene.src == null ? null : (
          <Sequence
            key={scene.sceneId}
            from={scene.fromFrame}
            durationInFrames={scene.durationInFrames}
          >
            {scene.kind === 'IMAGE' ? (
              <Img
                src={scene.src}
                style={{ width, height, objectFit: 'contain' }}
              />
            ) : (
              <OffthreadVideo
                src={scene.src}
                // The visual track only. Any audio inside a visual
                // source is NOT part of the approved audio timeline and
                // must never be heard.
                muted
                startFrom={scene.sourceStartFrame}
                style={{ width, height, objectFit: 'contain' }}
              />
            )}
          </Sequence>
        ),
      )}
      {audio.map((track) => (
        <Sequence
          key={track.refId}
          from={track.fromFrame}
          durationInFrames={track.durationInFrames}
        >
          {/* Played once, at natural rate, unaltered. No volume ramp,
              no loop, no playbackRate: an approved recording is heard
              exactly as it was approved. */}
          <Audio src={track.src} />
        </Sequence>
      ))}
    </AbsoluteFill>
  )
}
