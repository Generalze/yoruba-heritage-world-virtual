import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { env } from '@/lib/env'
import { getMediaStorage } from '@/providers/media/storage'
import { frameTimingToleranceMs, probeMediaWithFfprobe } from './media-probe'
import { RenderEngineError } from './types'
import type * as RemotionBundlerModule from '@remotion/bundler'
import type * as RemotionRendererModule from '@remotion/renderer'
import type { MediaProbe } from './media-probe'
import type { RenderEngine, RenderOutput, RenderRequest } from './types'

/** Types only — the modules themselves are loaded lazily, on the one
 * code path that renders. */
type RemotionBundler = typeof RemotionBundlerModule
type RemotionRenderer = typeof RemotionRendererModule

/**
 * REAL render engine — Remotion (Phase One, Step 20; canon §23, §10.13).
 *
 * The engine-neutral contract in types.ts is unchanged and remains
 * authoritative: this adapter receives the same RenderRequest the mock
 * does and returns the same RenderOutput. Nothing about the plan, the
 * source verification, the persistence, the lease discipline or the
 * final gate knows Remotion exists.
 *
 * WHAT THIS ADAPTER ACTUALLY GUARANTEES, beyond "it calls a
 * compositor":
 *
 * 1. IT MEASURES INSTEAD OF TRUSTING. Every source is materialised
 *    locally and RE-HASHED against the SHA-256 the plan recorded before
 *    it is used for anything.
 *
 * 2. THE PLAN ALREADY RESERVED THE REAL LENGTH. Audio is measured
 *    BEFORE the immutable plan is built (see buildValidatedRenderPlan),
 *    so a 12.4-second recording whose database row said 12 seconds
 *    already has a 12.4-second window and the later scenes are already
 *    shifted. This adapter therefore NEVER refuses a render for audio
 *    being longer than a planned window — that refusal would contradict
 *    the locked rule `max(planned, actual)`. What it does check is that
 *    the file still agrees with the plan that was built from it: a
 *    disagreement beyond container rounding means the bytes changed
 *    after planning, which is a real fault. Sacred audio is never
 *    truncated, stretched, sped, slowed, looped, rewritten or replaced,
 *    and there is no code path in this file that could do any of those
 *    things.
 *
 * 3. IT VALIDATES ITS OWN OUTPUT. The produced file is probed: it must
 *    be the planned container, must actually contain a video stream,
 *    and must land within a tolerance derived from the ACTUAL frame
 *    rate. Duration is read from the encoded media, never echoed from
 *    the request. The SHA-256 is computed from the real bytes.
 *
 * 4. IT LEAVES NOTHING BEHIND AND PUBLISHES NOTHING. Sources are
 *    materialised into a per-render temporary directory that is removed
 *    on every path, including failure. No file is written anywhere
 *    web-served, no URL is produced, nothing is uploaded.
 *
 * NOT EXERCISED BY AUTOMATED VERIFICATION. Remotion drives a headless
 * browser it must first download; running that in this project's test
 * suite would mean a network fetch and a non-deterministic render, both
 * forbidden. So the compositor call is the ONE injected seam
 * (`compose`), and the suite drives every rule above with a
 * deterministic double while the real path is covered by the operator
 * smoke procedure in the runbook. The mock engine remains the default
 * and the only engine automated verification ever selects.
 */

/**
 * The EXACT Remotion release this build composes with.
 *
 * Kept as a literal rather than read from package.json at runtime: the
 * value is persisted on every render result and compared on every later
 * verification, so it must be a fact about the BUILD, not about
 * whatever file happens to be on disk beside the process. A test pins
 * it to the exact (caret-free) dependency versions.
 */
export const REMOTION_PINNED_VERSION = '4.0.507'
export const REMOTION_ENGINE_VERSION = `remotion-${REMOTION_PINNED_VERSION}`

/** The only container this platform renders to. */
const SUPPORTED_OUTPUT_MIME = 'video/mp4'

const SOURCE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
}

const IMAGE_MIME_PREFIX = 'image/'

/** Everything the compositor needs, already reconciled to frames. It
 * carries file URLs and numbers — no sacred text, no spoken text, no
 * Visual Bible rule, no provider payload. */
/**
 * EXPLICIT COMPOSITOR SEMANTICS FOR EVERY PLANNED FIT.
 *
 * The plan chooses a fit per scene; this is the exact picture each one
 * must produce. Getting these wrong is not a cosmetic bug — replaying a
 * clip where the plan said to hold its final frame shows the viewer
 * approved footage a second time, in a place nobody approved it for.
 *
 *   STILL           a still image held for the window (STILL_HOLD, and
 *                   any hold of an image — freezing a still IS the
 *                   still)
 *   PLAY            a clip played from `sourceStartFrame` for the whole
 *                   window (EXACT, and TRIM where the surrounding
 *                   Sequence bounds it)
 *   PLAY_THEN_FREEZE a clip played to its end, then FROZEN on its final
 *                   frame for the remainder of the window
 *                   (HOLD_LAST_FRAME on a clip shorter than its window)
 *   FREEZE          a clip shown as ONE frozen frame for the whole
 *                   window (HOLD_PREVIOUS of a clip) — and the frozen
 *                   frame is the LAST FRAME THAT WAS DISPLAYED, never
 *                   frame zero
 */
export type SceneRenderMode = 'STILL' | 'PLAY' | 'PLAY_THEN_FREEZE' | 'FREEZE'

export interface CompositionScene {
  sceneId: string
  fromFrame: number
  durationInFrames: number
  src: string
  mode: SceneRenderMode
  /** Where in the SOURCE this scene starts. Non-zero only when the
   * timeline deliberately continues a clip. */
  sourceStartFrame: number
  /** PLAY_THEN_FREEZE only: how many frames actually play before the
   * freeze takes over. The two spans sum EXACTLY to durationInFrames,
   * so no frame of the window is left unpainted. */
  playFrames: number
  /** FREEZE / PLAY_THEN_FREEZE only: the source frame to hold. */
  freezeFrame: number
}

export interface CompositionInput {
  fps: number
  width: number
  height: number
  durationInFrames: number
  outputPath: string
  scenes: Array<CompositionScene>
  audio: Array<{
    refId: string
    fromFrame: number
    durationInFrames: number
    src: string
  }>
}

/** The compositor seam. Writes an encoded file at `outputPath`. */
export type Compositor = (input: CompositionInput) => Promise<void>

export interface RemotionEngineDependencies {
  probe?: MediaProbe
  compose?: Compositor
  fps?: number
  width?: number
  height?: number
}

function msToFrames(ms: number, fps: number): number {
  return Math.max(1, Math.round((ms / 1000) * fps))
}

function extensionFor(mimeType: string): string {
  const extension = SOURCE_EXTENSIONS[mimeType]
  if (!extension) {
    throw new RenderEngineError(
      'unsupported_source_mime',
      'A render source uses a container this engine cannot compose.',
      false,
    )
  }
  return extension
}

/**
 * The real compositor call, loaded ONLY when a render actually happens.
 *
 * A static import would pull Remotion — and, transitively, its browser
 * provisioning — into every process that touches the render module,
 * including the web server, which never renders anything. The dynamic
 * import keeps that cost on the one code path that needs it and lets a
 * deployment that does not render at all run without the packages
 * present, failing closed with a precise code if it tries.
 */
const remotionCompositor: Compositor = async (input) => {
  let bundler: RemotionBundler
  let renderer: RemotionRenderer
  try {
    ;[bundler, renderer] = await Promise.all([
      import('@remotion/bundler'),
      import('@remotion/renderer'),
    ])
  } catch {
    throw new RenderEngineError(
      'render_engine_dependencies_missing',
      'The Remotion packages are not installed in this image.',
      false,
    )
  }
  const { PRAYER_COMPOSITION_ID } = await import(
    '@/remotion/PrayerComposition'
  )
  const serveUrl = await bundler.bundle({
    entryPoint: join(process.cwd(), 'src', 'remotion', 'index.ts'),
  })
  const inputProps = { scenes: input.scenes, audio: input.audio }
  const composition = await renderer.selectComposition({
    serveUrl,
    id: PRAYER_COMPOSITION_ID,
    inputProps,
  })
  await renderer.renderMedia({
    serveUrl,
    composition: {
      ...composition,
      fps: input.fps,
      width: input.width,
      height: input.height,
      durationInFrames: input.durationInFrames,
    },
    codec: 'h264',
    outputLocation: input.outputPath,
    inputProps,
    concurrency: env.REMOTION_CONCURRENCY,
    timeoutInMilliseconds: env.REMOTION_TIMEOUT_MS,
    // THE BROWSER BAKED INTO THE IMAGE, named explicitly. Left to
    // itself Remotion provisions its own on first use — a download at
    // the moment of somebody's paid render, into a cache directory the
    // container user may not even be able to write. Passing it here
    // rather than relying on an environment variable also means the
    // renderer and the readiness check are gating on the SAME fact.
    browserExecutable:
      env.REMOTION_BROWSER_EXECUTABLE.trim() === ''
        ? null
        : env.REMOTION_BROWSER_EXECUTABLE,
  })
}

export function createRemotionRenderEngine(
  dependencies: RemotionEngineDependencies = {},
): RenderEngine {
  const probe = dependencies.probe ?? probeMediaWithFfprobe
  const compose = dependencies.compose ?? remotionCompositor
  const fps = dependencies.fps ?? 30
  const width = dependencies.width ?? 1280
  const height = dependencies.height ?? 720

  return {
    code: 'REMOTION',
    // THE EXACT COMPOSITOR, not a major-version family. A render result
    // records this string forever, and verifyCompletedRender requires
    // the active engine to match it EXACTLY: a compositor upgrade
    // composes differently, rounds differently and may honour a fit
    // differently, so vouching for `remotion-4.0.507` output while
    // `4.1.0` is installed would be vouching for something this build
    // never produced. The package set is pinned to this same version
    // WITHOUT a caret range (see package.json), and a test proves the
    // two agree.
    version: REMOTION_ENGINE_VERSION,
    /** The whole point: this produces a real, deliverable composition. */
    isMock: false,

    isEnabled() {
      return true
    },

    async render(request: RenderRequest): Promise<RenderOutput> {
      if (request.outputMimeType !== SUPPORTED_OUTPUT_MIME) {
        throw new RenderEngineError(
          'unsupported_output_mime',
          'This engine renders only the planned MP4 container.',
          false,
        )
      }
      const workDir = await mkdtemp(join(tmpdir(), 'yhw-render-'))
      try {
        return await renderInWorkDir({
          request,
          workDir,
          probe,
          compose,
          fps,
          width,
          height,
        })
      } finally {
        // Private source bytes never outlive the render, on any path.
        await rm(workDir, { recursive: true, force: true }).catch(
          () => undefined,
        )
      }
    },
  }
}

interface MaterialisedSource {
  refId: string
  role: 'VISUAL' | 'AUDIO'
  path: string
  url: string
  mimeType: string
  probedDurationMs: number | null
  hasVideo: boolean
}

async function renderInWorkDir(input: {
  request: RenderRequest
  workDir: string
  probe: MediaProbe
  compose: Compositor
  fps: number
  width: number
  height: number
}): Promise<RenderOutput> {
  const { request, workDir, probe, compose, fps } = input

  // --- 1. Materialise and RE-PROVE every source -------------------------
  const storage = getMediaStorage()
  const sources = new Map<string, MaterialisedSource>()
  for (const ref of request.sources) {
    const bytes = await storage.get(ref.storageKey)
    if (!bytes || bytes.length === 0) {
      throw new RenderEngineError(
        'source_unreadable',
        'A verified render source could not be read.',
        true,
      )
    }
    // The plan's hash is the authority. Reading the right key is not
    // the same as reading the right bytes.
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
      throw new RenderEngineError(
        'source_checksum_mismatch',
        'A render source no longer matches the hash the plan recorded.',
        false,
      )
    }
    const path = join(workDir, `${ref.refId}.${extensionFor(ref.mimeType)}`)
    await writeFile(path, bytes)

    // A still image legitimately has no duration; everything else must
    // be measurable, and an unmeasurable source is refused rather than
    // assumed.
    let probedDurationMs: number | null = null
    let hasVideo = false
    if (!ref.mimeType.startsWith(IMAGE_MIME_PREFIX)) {
      const probed = await probe(path)
      if (!probed.ok) {
        throw new RenderEngineError(
          `source_${probed.reasonCode}`,
          'A render source could not be measured.',
          probed.reasonCode === 'probe_timeout',
        )
      }
      probedDurationMs = probed.media.durationMs
      hasVideo = probed.media.hasVideo
      if (ref.role === 'AUDIO' && !probed.media.hasAudio) {
        throw new RenderEngineError(
          'source_audio_missing',
          'An audio source contains no audio stream.',
          false,
        )
      }
    }
    sources.set(ref.refId, {
      refId: ref.refId,
      role: ref.role,
      path,
      url: pathToFileURL(path).href,
      mimeType: ref.mimeType,
      probedDurationMs,
      hasVideo,
    })
  }

  // --- 2. Audio: the plan already reserved the REAL length ------------
  //
  // Measurement happened BEFORE the plan was built, so track.durationMs
  // IS the measured recording. Nothing here refuses a render for a
  // recording being longer than a planned window — that window was
  // already grown to hold it. What is checked is that the file still
  // agrees with the plan built from it; a disagreement beyond container
  // rounding means the bytes changed after planning.
  const audioTracks: CompositionInput['audio'] = []
  for (const track of request.audio) {
    const source = sources.get(track.refId)
    if (!source || source.role !== 'AUDIO') {
      throw new RenderEngineError(
        'audio_source_missing',
        'The plan references an audio source that was not supplied.',
        false,
      )
    }
    const probedMs = source.probedDurationMs
    if (probedMs == null || probedMs <= 0) {
      throw new RenderEngineError(
        'audio_duration_unknown',
        'An audio source could not be measured.',
        false,
      )
    }
    if (Math.abs(probedMs - track.durationMs) > frameTimingToleranceMs(fps)) {
      throw new RenderEngineError(
        'audio_source_changed_since_plan',
        'An audio source no longer matches the length the plan reserved for it.',
        false,
      )
    }
    audioTracks.push({
      refId: track.refId,
      fromFrame: msToFrames(track.startMs, fps),
      // Played ONCE, in full, at natural rate. The plan's window is at
      // least this long by construction.
      durationInFrames: msToFrames(track.durationMs, fps),
      src: source.url,
    })
  }

  // --- 3. Scenes, with explicit semantics for every planned fit --------
  const scenes: Array<CompositionScene> = []
  /** The clip most recently DISPLAYED, and how far into it the timeline
   * had got. This is what a HOLD_PREVIOUS scene freezes — never frame
   * zero, which would replay approved footage the plan did not place. */
  let lastDisplayed: { source: MaterialisedSource; endedAtSourceMs: number } | null =
    null
  for (const scene of request.scenes) {
    const windowMs = scene.durationMs
    const durationInFrames = msToFrames(windowMs, fps)
    let source: MaterialisedSource
    let mode: SceneRenderMode
    const sourceStartFrame = 0
    let playFrames = durationInFrames
    let freezeFrame = 0

    if (scene.visualKind === 'HOLD_PREVIOUS') {
      if (!lastDisplayed) {
        throw new RenderEngineError(
          'hold_without_previous',
          'A HOLD_PREVIOUS scene has no earlier picture to hold.',
          false,
        )
      }
      source = lastDisplayed.source
      if (source.hasVideo) {
        // FREEZE THE FRAME THAT WAS LAST ON SCREEN. Its index is where
        // the previous scene left the clip, minus one frame; clamped so
        // a zero-length predecessor cannot produce a negative index.
        mode = 'FREEZE'
        freezeFrame = Math.max(
          0,
          msToFrames(lastDisplayed.endedAtSourceMs, fps) - 1,
        )
        playFrames = 0
      } else {
        // Freezing a still IS the still.
        mode = 'STILL'
      }
      // A hold displays no NEW footage, so the clip's position is
      // unchanged for whatever holds it next.
    } else {
      if (scene.visualRefId == null) {
        throw new RenderEngineError(
          'scene_visual_missing',
          'A scene names no visual source.',
          false,
        )
      }
      const resolved = sources.get(scene.visualRefId)
      if (!resolved || resolved.role !== 'VISUAL') {
        throw new RenderEngineError(
          'scene_visual_missing',
          'The plan references a visual source that was not supplied.',
          false,
        )
      }
      source = resolved
      if (!source.hasVideo) {
        mode = 'STILL'
        lastDisplayed = { source, endedAtSourceMs: 0 }
      } else {
        const sourceMs = source.probedDurationMs ?? 0
        if (sourceMs <= 0) {
          throw new RenderEngineError(
            'visual_duration_unknown',
            'A moving visual source could not be measured.',
            false,
          )
        }
        if (sourceMs + frameTimingToleranceMs(fps) < windowMs) {
          // The clip is genuinely shorter than its window: play it out
          // and HOLD its final frame. Stretching it to fit would alter
          // approved media; leaving black would be a gap nobody chose.
          mode = 'PLAY_THEN_FREEZE'
          playFrames = Math.min(
            durationInFrames,
            Math.max(1, msToFrames(sourceMs, fps)),
          )
          freezeFrame = playFrames - 1
          lastDisplayed = { source, endedAtSourceMs: sourceMs }
        } else {
          // EXACT or TRIM: play from the start; the Sequence bounds it.
          mode = 'PLAY'
          lastDisplayed = {
            source,
            endedAtSourceMs: Math.min(sourceMs, windowMs),
          }
        }
      }
    }

    scenes.push({
      sceneId: scene.sceneId,
      fromFrame: msToFrames(scene.startMs, fps),
      durationInFrames,
      src: source.url,
      mode,
      sourceStartFrame,
      playFrames,
      freezeFrame,
    })
  }
  // --- 4. Compose -------------------------------------------------------
  const outputPath = join(workDir, 'render.mp4')
  await compose({
    fps,
    width: input.width,
    height: input.height,
    durationInFrames: msToFrames(request.totalDurationMs, fps),
    outputPath,
    scenes,
    audio: audioTracks,
  })

  // --- 5. Prove what actually came out ----------------------------------
  let bytes: Uint8Array
  try {
    bytes = await readFile(outputPath)
  } catch {
    throw new RenderEngineError(
      'output_missing',
      'The compositor produced no output file.',
      true,
    )
  }
  if (bytes.length === 0) {
    throw new RenderEngineError(
      'output_empty',
      'The compositor produced an empty file.',
      true,
    )
  }
  const probedOutput = await probe(outputPath)
  if (!probedOutput.ok) {
    throw new RenderEngineError(
      `output_${probedOutput.reasonCode}`,
      'The rendered file could not be measured.',
      false,
    )
  }
  if (!probedOutput.media.hasVideo) {
    throw new RenderEngineError(
      'output_not_video',
      'The rendered file contains no video stream.',
      false,
    )
  }
  if (!probedOutput.media.formatName.includes('mp4')) {
    throw new RenderEngineError(
      'output_container_mismatch',
      'The rendered file is not the planned container.',
      false,
    )
  }
  const tolerance = frameTimingToleranceMs(fps)
  if (
    Math.abs(probedOutput.media.durationMs - request.totalDurationMs) > tolerance
  ) {
    throw new RenderEngineError(
      'output_duration_out_of_tolerance',
      'The rendered length is not the length the plan reconciled to.',
      false,
    )
  }
  return {
    bytes,
    mimeType: SUPPORTED_OUTPUT_MIME,
    // MEASURED, never echoed from the request.
    durationMs: probedOutput.media.durationMs,
  }
}
