import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { env } from '@/lib/env'
import { checkRenderRuntimePaths } from '@/lib/executable-probe'
import type { RenderRuntimeReadiness } from '@/lib/executable-probe'

/**
 * Real media inspection (Phase One, Step 20).
 *
 * WHY THIS EXISTS AT ALL. Up to Step 19 the pipeline reasoned about
 * durations recorded in the database — a number a content manager typed
 * (`media_asset_versions.duration_seconds`, whole SECONDS) or a speech
 * provider claimed about its own output. For the mock renderer that is
 * harmless. For a real composition it is not: if the stored duration of
 * an approved recording is 12 seconds and the file is really 12.4, a
 * timeline built from the stored number leaves the last 0.4 seconds of
 * somebody's recorded prayer with no window to play in.
 *
 * So for the real renderer the FILE is the authority, and it is
 * measured BEFORE the immutable render plan is built — see
 * buildValidatedRenderPlan. The locked Step 16 reconciliation then does
 * what it always did:
 *
 *   finalSegmentDuration = max(plannedSegmentDuration, actualAudioMs)
 *
 * The segment GROWS to fit the recording and later scenes shift. That
 * is the whole point: nothing here refuses a render because a recording
 * is longer than its planned window, and nothing anywhere trims,
 * stretches, speeds, slows, loops, rewrites or replaces sacred audio.
 *
 * ffprobe is pure measurement infrastructure. It reads containers and
 * reports durations. It has no spiritual authority, never decides what
 * may be rendered, and never modifies media.
 */

export interface ProbedMedia {
  durationMs: number
  /** Container/format name as the prober reports it (`mov,mp4,...`). */
  formatName: string
  /** True when the file genuinely contains an audio stream. */
  hasAudio: boolean
  hasVideo: boolean
}

export type MediaProbeResult =
  | { ok: true; media: ProbedMedia }
  | { ok: false; reasonCode: string }

/** Injectable so timeline logic can be tested without a binary, and so
 * a future adapter can supply a different prober without touching the
 * rules that consume it. */
export type MediaProbe = (filePath: string) => Promise<MediaProbeResult>

const PROBE_TIMEOUT_MS = 30_000

function ffprobeBinary(): string {
  return env.FFPROBE_PATH.trim() === '' ? 'ffprobe' : env.FFPROBE_PATH
}

interface FfprobeJson {
  format?: { duration?: string; format_name?: string }
  streams?: Array<{
    codec_type?: string
    duration?: string
    // Read ONLY by probeAudioTechnicalMetadataFromBytes below. Optional,
    // so their presence changes nothing on the renderer path.
    codec_name?: string
    sample_rate?: string
    channels?: number
  }>
}

/**
 * Probes one local file with ffprobe.
 *
 * FAILS CLOSED. A missing binary, a non-zero exit, unparseable output
 * or an absent duration all return a bounded reason code — never a
 * guess, and never a fall back to whatever the database said. A
 * renderer that cannot measure its inputs must refuse to build a
 * timeline from them.
 */
export const probeMediaWithFfprobe: MediaProbe = async (filePath) => {
  let stdout: string
  try {
    stdout = await runFfprobe(filePath)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ENOENT') return { ok: false, reasonCode: 'probe_unavailable' }
    if (code === 'ETIMEDOUT') return { ok: false, reasonCode: 'probe_timeout' }
    return { ok: false, reasonCode: 'probe_failed' }
  }
  let parsed: FfprobeJson
  try {
    parsed = JSON.parse(stdout) as FfprobeJson
  } catch {
    return { ok: false, reasonCode: 'probe_unparseable' }
  }
  const streams = parsed.streams ?? []
  const seconds = Number(parsed.format?.duration)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, reasonCode: 'probe_duration_unknown' }
  }
  return {
    ok: true,
    media: {
      // Rounded to whole milliseconds, the unit every plan and every
      // schema column in this platform already speaks.
      durationMs: Math.round(seconds * 1000),
      formatName: parsed.format?.format_name ?? '',
      hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
      hasVideo: streams.some((stream) => stream.codec_type === 'video'),
    },
  }
}

function runFfprobe(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      ffprobeBinary(),
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(() => {
        reject(
          Object.assign(new Error('ffprobe timed out'), { code: 'ETIMEDOUT' }),
        )
      })
    }, PROBE_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    // stderr is drained and DISCARDED: ffprobe prints absolute file
    // paths there, and those are private storage locations.
    child.stderr.on('data', () => undefined)
    child.on('error', (error) => {
      finish(() => {
        reject(error)
      })
    })
    child.on('close', (code) => {
      finish(() => {
        if (code === 0) resolve(stdout)
        else {
          reject(Object.assign(new Error('ffprobe failed'), { code: 'EEXIT' }))
        }
      })
    })
  })
}

// --- Authoritative audio duration -------------------------------------------

export type AudioDurationMeasurement =
  | { ok: true; durationMs: number }
  | { ok: false; reasonCode: string }

/**
 * Measures ONE audio source from its exact, already-hash-verified
 * bytes.
 *
 * Injectable, because the plan builder must be drivable deterministically
 * in tests and because the mock path must never spawn anything.
 */
export type AudioDurationProbe = (input: {
  bytes: Uint8Array
  /** The verified content hash. This is the memo key — see below. */
  sha256: string
  mimeType: string
}) => Promise<AudioDurationMeasurement>

/**
 * DETERMINISM IS LOAD-BEARING HERE, not a nicety.
 *
 * The measured duration goes into the immutable render plan, and
 * therefore into `renderPlanSha256`. `verifyCompletedRender` REBUILDS
 * that plan and compares the hash byte-for-byte — on the worker's final
 * gate, on every upload verification, and on every Prayer Room request.
 * If the same bytes ever measured differently, a finished recording
 * would become permanently unavailable.
 *
 * Two things make that safe:
 *
 *  1. The measurement is a pure function of FILE CONTENT. The bytes are
 *     re-hashed against the plan's frozen SHA-256 before they are ever
 *     measured, so identical input is guaranteed.
 *  2. The web server and the worker run the SAME image at the SAME
 *     revision (see the Dockerfile), so they run the same ffprobe.
 *
 * The memo is keyed on that content hash for exactly the same reason it
 * is safe: same bytes, same answer. It also keeps the hot path cheap —
 * a Prayer Room status load and every media request re-prove the whole
 * chain, and none of them should pay for a subprocess twice.
 */
const measuredByContentHash = new Map<string, number>()
/** Bounded so a long-lived worker cannot grow it without limit. */
const MEASURE_CACHE_LIMIT = 512

export function resetMeasuredAudioCacheForTests(): void {
  measuredByContentHash.clear()
}

export const measureAudioDurationFromBytes: AudioDurationProbe = async (
  input,
) => {
  const cached = measuredByContentHash.get(input.sha256)
  if (cached != null) return { ok: true, durationMs: cached }
  if (input.bytes.length === 0) {
    return { ok: false, reasonCode: 'audio_bytes_empty' }
  }

  // ffprobe reads a FILE, so the verified bytes are materialised into a
  // per-measurement temporary directory that is removed on every path.
  // Private audio never outlives the measurement.
  const workDir = await mkdtemp(join(tmpdir(), 'yhw-audio-probe-'))
  try {
    const path = join(workDir, `source.${audioExtensionFor(input.mimeType)}`)
    await writeFile(path, input.bytes)
    const probed = await probeMediaWithFfprobe(path)
    if (!probed.ok) return { ok: false, reasonCode: probed.reasonCode }
    if (!probed.media.hasAudio) {
      return { ok: false, reasonCode: 'audio_stream_missing' }
    }
    if (probed.media.durationMs <= 0) {
      return { ok: false, reasonCode: 'probe_duration_unknown' }
    }
    if (measuredByContentHash.size >= MEASURE_CACHE_LIMIT) {
      measuredByContentHash.clear()
    }
    measuredByContentHash.set(input.sha256, probed.media.durationMs)
    return { ok: true, durationMs: probed.media.durationMs }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
}

function audioExtensionFor(mimeType: string): string {
  return AUDIO_EXTENSIONS[mimeType] ?? 'bin'
}

// --- Audio technical metadata ------------------------------------------------

/**
 * Codec, sample rate and channel count, exactly as ffprobe reports them.
 *
 * DELIBERATELY NOT PART OF ProbedMedia. The renderer measures durations
 * because a timeline needs them; it has never needed a codec name, and
 * `ProbedMedia` feeds a structure whose hash decides whether a finished
 * recording stays playable. Widening it to serve a report would put a
 * field nothing renders inside something everything verifies. This is a
 * separate, additive read, used by the measurement harness only.
 */
export interface AudioTechnicalMetadata {
  /** Codec name as the prober reports it (`pcm_s16le`, `mp3`, ...). */
  codec: string
  /** Hertz, or null when the prober did not report a usable value. */
  sampleRate: number | null
  channels: number | null
}

export type AudioTechnicalProbeResult =
  | { ok: true; metadata: AudioTechnicalMetadata }
  | { ok: false; reasonCode: string }

/**
 * The parse half, split out so it is provable without a binary present.
 *
 * Reports absence as absence: a stream that carries no sample rate
 * yields null rather than a plausible-looking default, because a report
 * that invents 44100 Hz is worse than one that admits it does not know.
 */
export function parseAudioTechnicalMetadata(
  stdout: string,
): AudioTechnicalProbeResult {
  let parsed: FfprobeJson
  try {
    parsed = JSON.parse(stdout) as FfprobeJson
  } catch {
    return { ok: false, reasonCode: 'probe_unparseable' }
  }
  const audio = (parsed.streams ?? []).find(
    (stream) => stream.codec_type === 'audio',
  )
  if (!audio) return { ok: false, reasonCode: 'audio_stream_missing' }
  const sampleRate = Number(audio.sample_rate)
  const channels = Number(audio.channels)
  return {
    ok: true,
    metadata: {
      codec: audio.codec_name ?? '',
      sampleRate:
        Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : null,
      channels: Number.isFinite(channels) && channels > 0 ? channels : null,
    },
  }
}

/**
 * Reads the technical shape of ONE audio artifact from its exact bytes.
 *
 * Same discipline as the duration measurement above: the bytes are
 * materialised into a per-call temporary directory that is removed on
 * every path, so private audio never outlives the read. Not memoized —
 * it runs twice in the life of a measurement, and a cache would only be
 * a way for one artifact's answer to be reported about another's.
 */
export async function probeAudioTechnicalMetadataFromBytes(input: {
  bytes: Uint8Array
  mimeType: string
}): Promise<AudioTechnicalProbeResult> {
  if (input.bytes.length === 0) {
    return { ok: false, reasonCode: 'audio_bytes_empty' }
  }
  const workDir = await mkdtemp(join(tmpdir(), 'yhw-audio-tech-'))
  try {
    const path = join(workDir, `source.${audioExtensionFor(input.mimeType)}`)
    await writeFile(path, input.bytes)
    let stdout: string
    try {
      stdout = await runFfprobe(path)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') return { ok: false, reasonCode: 'probe_unavailable' }
      if (code === 'ETIMEDOUT') return { ok: false, reasonCode: 'probe_timeout' }
      return { ok: false, reasonCode: 'probe_failed' }
    }
    return parseAudioTechnicalMetadata(stdout)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// --- Timing tolerance --------------------------------------------------------

/**
 * How far a produced file's real duration may differ from the plan.
 *
 * REAL ENCODERS ARE NOT SAMPLE-EXACT. A video is a whole number of
 * frames, so a 12 340 ms plan at 30 fps becomes 12 333 ms or 12 367 ms
 * — off by up to one frame, before any container rounding. Demanding
 * millisecond equality of a real encoder would fail every render for a
 * reason that is arithmetic rather than a defect.
 *
 * The tolerance is derived from the ACTUAL frame rate plus a small
 * container allowance, not invented as a round number, and it is never
 * applied to the mock, whose exactness stays exact.
 */
export const CONTAINER_ROUNDING_TOLERANCE_MS = 100

export function frameTimingToleranceMs(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return CONTAINER_ROUNDING_TOLERANCE_MS
  return Math.ceil(1000 / fps) + CONTAINER_ROUNDING_TOLERANCE_MS
}

export function isWithinFrameTolerance(
  actualMs: number,
  expectedMs: number,
  fps: number,
): boolean {
  return Math.abs(actualMs - expectedMs) <= frameTimingToleranceMs(fps)
}

// --- Local render runtime dependencies --------------------------------------

/**
 * Can this machine actually perform a real render?
 *
 * Readiness must not answer READY when the answer to that is no: a
 * deployment whose renderer cannot start will confirm appointments,
 * queue jobs and then fail every one of them at the render stage,
 * spending each job's bounded retry budget on a missing binary.
 *
 * DELIBERATELY CHEAP AND SILENT. It resolves two executables and asks
 * the filesystem whether they are executable. It spawns nothing, reads
 * no media, makes no network call, and is NOT memoized — an operator
 * who installs the missing tooling into a running container must see
 * readiness recover on the next probe rather than after a restart.
 */
export type RenderRuntimeCheck = () => Promise<RenderRuntimeReadiness>

/** The application-configured form of the shared check: the same
 * filesystem logic the worker gate and the offline smoke check use,
 * with the paths this deployment was configured with. */
export const checkRenderRuntimeDependencies: RenderRuntimeCheck = () =>
  checkRenderRuntimePaths({
    ffprobePath: ffprobeBinary(),
    browserPath: env.REMOTION_BROWSER_EXECUTABLE,
  })
