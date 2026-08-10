import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { env } from '@/lib/env'
import { getMediaStorage } from '@/providers/media/storage'
import {
  checkApprovedAudioFits,
  frameTimingToleranceMs,
  probeMediaWithFfprobe,
} from './media-probe'
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
 *    locally, RE-HASHED against the SHA-256 the plan recorded, and then
 *    PROBED. Database duration metadata is never authority over the
 *    file: an approved recording whose stored duration says 12.0s and
 *    whose bytes say 12.4s is caught here, before any timeline decision
 *    is taken.
 *
 * 2. IT REFUSES RATHER THAN TRIMS. If a probed approved recording is
 *    longer than the slot the plan gave it, the render FAILS. It is not
 *    shortened, sped up, faded out or quietly rewritten — a human
 *    decides what to do about a recording that no longer matches its
 *    plan. Sacred audio is never truncated, stretched, sped, slowed,
 *    looped, rewritten or replaced, and there is no code path in this
 *    file that could do any of those things.
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
export interface CompositionInput {
  fps: number
  width: number
  height: number
  durationInFrames: number
  outputPath: string
  scenes: Array<{
    sceneId: string
    fromFrame: number
    durationInFrames: number
    src: string | null
    kind: 'IMAGE' | 'VIDEO'
    sourceStartFrame: number
  }>
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
    // Pinned so a render result records WHICH compositor produced it.
    // A version bump is a different renderer as far as verification is
    // concerned, exactly as intended.
    version: 'remotion-4',
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

  // --- 2. Approved audio must FIT, or the render is refused -------------
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
    const fit = checkApprovedAudioFits({
      probedDurationMs: source.probedDurationMs ?? 0,
      plannedDurationMs: track.durationMs,
    })
    if (!fit.ok) {
      // NOT trimmed. NOT stretched. Refused.
      throw new RenderEngineError(fit.reasonCode, 'Approved audio does not fit its planned slot.', false)
    }
    audioTracks.push({
      refId: track.refId,
      fromFrame: msToFrames(track.startMs, fps),
      // The frame count follows the MEASURED recording, not the stored
      // metadata, so nothing is cut off at the end.
      durationInFrames: msToFrames(fit.probedDurationMs, fps),
      src: source.url,
    })
  }

  // --- 3. Scenes --------------------------------------------------------
  const scenes: CompositionInput['scenes'] = []
  let heldSource: MaterialisedSource | null = null
  for (const scene of request.scenes) {
    let source: MaterialisedSource | null = null
    if (scene.visualKind === 'HOLD_PREVIOUS') {
      source = heldSource
      if (!source) {
        throw new RenderEngineError(
          'hold_without_previous',
          'A HOLD_PREVIOUS scene has no earlier picture to hold.',
          false,
        )
      }
    } else {
      if (scene.visualRefId == null) {
        throw new RenderEngineError(
          'scene_visual_missing',
          'A scene names no visual source.',
          false,
        )
      }
      source = sources.get(scene.visualRefId) ?? null
      if (!source || source.role !== 'VISUAL') {
        throw new RenderEngineError(
          'scene_visual_missing',
          'The plan references a visual source that was not supplied.',
          false,
        )
      }
      heldSource = source
    }
    // A moving source asked to fill its window EXACTLY must really be
    // long enough. Stretching it to fit would alter approved media.
    if (
      scene.visualFit === 'EXACT' &&
      source.probedDurationMs != null &&
      source.probedDurationMs + frameTimingToleranceMs(fps) < scene.durationMs
    ) {
      throw new RenderEngineError(
        'visual_shorter_than_scene',
        'A visual source is shorter than the scene the plan gave it.',
        false,
      )
    }
    scenes.push({
      sceneId: scene.sceneId,
      fromFrame: msToFrames(scene.startMs, fps),
      durationInFrames: msToFrames(scene.durationMs, fps),
      src: source.url,
      kind: source.hasVideo ? 'VIDEO' : 'IMAGE',
      sourceStartFrame: 0,
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
