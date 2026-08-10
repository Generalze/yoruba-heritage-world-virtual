import { spawn } from 'node:child_process'

import { env } from '@/lib/env'

/**
 * Real media inspection (Phase One, Step 20).
 *
 * WHY THIS EXISTS AT ALL. Up to Step 19 the pipeline reasoned about
 * durations recorded in the database — a number a content manager typed
 * or an upload tool reported. For the mock renderer that is harmless.
 * For a real composition it is not: if the stored duration of an
 * approved human recording is 12.0s and the file is really 12.4s, a
 * timeline built from the stored number either truncates the last 0.4
 * seconds of somebody's recorded prayer or leaves a gap of silence.
 * Neither is acceptable, and neither is detectable without asking the
 * FILE.
 *
 * So: before the real renderer makes any timeline decision about
 * approved audio, it PROBES the actual media. Database metadata is
 * useful for planning and search; it is never authority over what is
 * in the file.
 *
 * ffprobe is used as pure measurement infrastructure. It reads
 * containers and reports durations. It has no spiritual authority, it
 * never decides what may be rendered, and it never modifies media.
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
  streams?: Array<{ codec_type?: string; duration?: string }>
}

/**
 * Probes one local file with ffprobe.
 *
 * FAILS CLOSED. A missing binary, a non-zero exit, unparseable output
 * or an absent duration all return a bounded reason code — never a
 * guess, never a fallback to whatever the database said. A renderer
 * that cannot measure its inputs must refuse to build a timeline from
 * them.
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
        reject(Object.assign(new Error('ffprobe timed out'), {
          code: 'ETIMEDOUT',
        }))
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
        else reject(Object.assign(new Error('ffprobe failed'), { code: 'EEXIT' }))
      })
    })
  })
}

/**
 * How far a produced file's real duration may differ from the plan.
 *
 * REAL ENCODERS ARE NOT SAMPLE-EXACT. A video is a whole number of
 * frames, so a 12 340 ms plan at 30 fps becomes 12 333 ms or 12 367 ms
 * — off by up to one frame, before any container rounding. Demanding
 * millisecond equality of a real encoder would fail every render for a
 * reason that is arithmetic rather than a defect.
 *
 * The tolerance is therefore derived from the ACTUAL frame rate plus a
 * small container allowance, not invented as a round number and not
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

/**
 * The rule that protects approved recordings.
 *
 * Sacred audio is never truncated, stretched, sped, slowed, looped,
 * rewritten or replaced. So a segment's slot must be able to hold the
 * WHOLE of what is really in the file: if the probed duration exceeds
 * the planned slot by more than container rounding, the render is
 * refused. It is not shortened to fit, and the plan is not quietly
 * rewritten — a human decides what to do about a recording that no
 * longer matches its plan.
 *
 * A slot LONGER than the audio is fine: the remainder is silence, which
 * alters nothing about the recording itself.
 */
export type AudioFitVerdict =
  | { ok: true; probedDurationMs: number }
  | { ok: false; reasonCode: string }

export function checkApprovedAudioFits(input: {
  probedDurationMs: number
  plannedDurationMs: number
}): AudioFitVerdict {
  if (input.probedDurationMs <= 0) {
    return { ok: false, reasonCode: 'audio_duration_unknown' }
  }
  if (
    input.probedDurationMs >
    input.plannedDurationMs + CONTAINER_ROUNDING_TOLERANCE_MS
  ) {
    // REFUSE, never trim. Trimming here would silently cut the end off
    // somebody's recorded prayer.
    return { ok: false, reasonCode: 'approved_audio_longer_than_plan' }
  }
  return { ok: true, probedDurationMs: input.probedDurationMs }
}
