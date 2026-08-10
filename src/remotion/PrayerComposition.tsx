import {
  AbsoluteFill,
  Audio,
  Freeze,
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
 * It is also deliberately dumb. It makes NO timing decisions and NO fit
 * decisions: the adapter has already resolved every scene to one of
 * four explicit modes and to exact frame numbers. Nothing here trims,
 * stretches, loops, speeds or replaces audio, and nothing decides for
 * itself whether a clip should play or hold.
 */

export type SceneRenderMode = 'STILL' | 'PLAY' | 'PLAY_THEN_FREEZE' | 'FREEZE'

export interface PrayerCompositionScene {
  sceneId: string
  fromFrame: number
  durationInFrames: number
  /** file:// URL of a verified local source. */
  src: string
  mode: SceneRenderMode
  sourceStartFrame: number
  playFrames: number
  freezeFrame: number
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

function SceneVisual({
  scene,
  width,
  height,
}: {
  scene: PrayerCompositionScene
  width: number
  height: number
}) {
  const fill = { width, height, objectFit: 'contain' } as const

  if (scene.mode === 'STILL') {
    return <Img src={scene.src} style={fill} />
  }

  if (scene.mode === 'FREEZE') {
    // ONE frame, held for the whole window. `freezeFrame` is the last
    // frame that was actually DISPLAYED by the preceding scene — never
    // zero, which would replay approved footage from the top in a place
    // the plan said to hold still.
    return (
      <Freeze frame={scene.freezeFrame}>
        <OffthreadVideo src={scene.src} muted style={fill} />
      </Freeze>
    )
  }

  if (scene.mode === 'PLAY_THEN_FREEZE') {
    // Two spans that sum EXACTLY to the window, so no frame is left
    // unpainted: the clip plays out, then its final frame is held.
    return (
      <>
        <Sequence durationInFrames={scene.playFrames}>
          <OffthreadVideo
            src={scene.src}
            muted
            trimBefore={scene.sourceStartFrame}
            style={fill}
          />
        </Sequence>
        <Sequence
          from={scene.playFrames}
          durationInFrames={scene.durationInFrames - scene.playFrames}
        >
          <Freeze frame={scene.freezeFrame}>
            <OffthreadVideo src={scene.src} muted style={fill} />
          </Freeze>
        </Sequence>
      </>
    )
  }

  // PLAY — the clip runs for the window; the enclosing Sequence bounds
  // it, which is what TRIM means. Any audio inside a visual source is
  // NOT part of the approved audio timeline and must never be heard.
  return (
    <OffthreadVideo
      src={scene.src}
      muted
      trimBefore={scene.sourceStartFrame}
      style={fill}
    />
  )
}

export function PrayerComposition({ scenes, audio }: PrayerCompositionProps) {
  const { width, height } = useVideoConfig()
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {scenes.map((scene) => (
        <Sequence
          key={scene.sceneId}
          from={scene.fromFrame}
          durationInFrames={scene.durationInFrames}
        >
          <SceneVisual scene={scene} width={width} height={height} />
        </Sequence>
      ))}
      {audio.map((track) => (
        <Sequence
          key={track.refId}
          from={track.fromFrame}
          durationInFrames={track.durationInFrames}
        >
          {/* Played once, at natural rate, unaltered. An approved
              recording is heard exactly as it was approved. */}
          <Audio src={track.src} />
        </Sequence>
      ))}
    </AbsoluteFill>
  )
}
