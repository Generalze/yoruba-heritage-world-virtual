import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CONTAINER_ROUNDING_TOLERANCE_MS,
  checkRenderRuntimeDependencies,
  measureAudioDurationFromBytes,
  resetMeasuredAudioCacheForTests,
  frameTimingToleranceMs,
  isWithinFrameTolerance,
  probeMediaWithFfprobe,
} from '@/providers/render/media-probe'
import {
  REMOTION_PINNED_VERSION,
  createRemotionRenderEngine,
} from '@/providers/render/remotion'
import { RenderEngineError } from '@/providers/render/types'
import {
  MAX_RENDER_TIMING_TOLERANCE_MS,
  renderedDurationMatchesPlan,
} from '@/services/render-assembly'
import {
  LocalMediaStorageProvider,
  computeFileSha256,
  resetMediaStorageForTests,
  setMediaStorageForTests,
} from '@/providers/media/storage'
import type { CompositionInput } from '@/providers/render/remotion'
import type { MediaProbeResult } from '@/providers/render/media-probe'
import type { RenderRequest } from '@/providers/render/types'

/**
 * ============================================================================
 * REAL RENDER FOUNDATION — Phase One, Step 20.
 *
 * THE MOCK ARTIFACTS ARE NOT MEDIA, AND THIS SUITE DOES NOT PRETEND
 * OTHERWISE. Step 14's mock visual artifacts are deliberately synthetic
 * bytes; handing them to a real compositor would fail on the container
 * and prove nothing. So the fixtures here are TINY, DETERMINISTIC,
 * NON-SACRED media synthesized in code — a 1.5-second silent WAV built
 * from its own header, and a 1×1 PNG — and the Step 14 mock is left
 * exactly as it is.
 *
 * REMOTION ITSELF IS NEVER INVOKED. It drives a headless browser it
 * must first download; running that here would mean a network fetch and
 * a non-deterministic render, both forbidden. The compositor is the ONE
 * injected seam, so every rule the adapter enforces AROUND the render —
 * re-hashing sources, probing real durations, refusing to trim approved
 * audio, validating the produced container — is exercised for real.
 * ============================================================================
 */

// --- Deterministic, non-sacred fixtures --------------------------------------

/** A silent PCM WAV, built byte by byte so the fixture needs no encoder
 * and no network, and its duration is known exactly by construction. */
function makeSilentWav(durationMs: number, sampleRate = 8000): Uint8Array {
  const samples = Math.round((durationMs / 1000) * sampleRate)
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return new Uint8Array(buffer)
}

/** A 1×1 opaque PNG — the smallest legal still this platform accepts. */
const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

const AUDIO_MS = 1_500
const SCENE_MS = 2_000

let mediaRoot: string
let storage: LocalMediaStorageProvider
let audioKey: string
let imageKey: string
let audioSha: string
let imageSha: string

beforeAll(async () => {
  mediaRoot = mkdtempSync(join(tmpdir(), 'yhw-render-prod-'))
  storage = new LocalMediaStorageProvider(mediaRoot)
  setMediaStorageForTests(storage)
  const wav = makeSilentWav(AUDIO_MS)
  audioSha = computeFileSha256(wav)
  audioKey = (await storage.put(wav, 'wav')).storageKey
  imageSha = computeFileSha256(TINY_PNG)
  imageKey = (await storage.put(TINY_PNG, 'png')).storageKey
})

afterAll(() => {
  resetMediaStorageForTests()
  rmSync(mediaRoot, { recursive: true, force: true })
})

// --- Probing -----------------------------------------------------------------

describe('media probing', () => {
  it('measures a REAL file rather than trusting metadata', async () => {
    const path = join(mediaRoot, 'probe-fixture.wav')
    writeFileSync(path, makeSilentWav(AUDIO_MS))
    const probed = await probeMediaWithFfprobe(path)

    if (probed.ok) {
      // The fixture's duration is known by construction, so this is a
      // genuine round trip through a real prober.
      expect(Math.abs(probed.media.durationMs - AUDIO_MS)).toBeLessThanOrEqual(
        CONTAINER_ROUNDING_TOLERANCE_MS,
      )
      expect(probed.media.hasAudio).toBe(true)
      expect(probed.media.hasVideo).toBe(false)
    } else {
      // No ffprobe on this machine. The wrapper must then FAIL CLOSED
      // with a bounded code — never silently succeed, and never fall
      // back to whatever the database said.
      expect(probed.reasonCode).toBe('probe_unavailable')
      console.warn('[render-production] ffprobe unavailable — probe fail-closed path asserted instead')
    }
  }, 60_000)

  it('fails closed on a file that is not media', async () => {
    const path = join(mediaRoot, 'not-media.wav')
    writeFileSync(path, new TextEncoder().encode('this is not a wav file'))
    const probed = await probeMediaWithFfprobe(path)
    expect(probed.ok).toBe(false)
    if (probed.ok) throw new Error('expected refusal')
    expect(['probe_failed', 'probe_unavailable', 'probe_duration_unknown']).toContain(
      probed.reasonCode,
    )
  }, 60_000)
})

describe('timing tolerance', () => {
  it('derives the bound from the ACTUAL frame rate, not a round number', () => {
    // One frame plus container rounding — so a slower frame rate gets a
    // wider bound, because its frames really are further apart.
    expect(frameTimingToleranceMs(30)).toBe(34 + CONTAINER_ROUNDING_TOLERANCE_MS)
    expect(frameTimingToleranceMs(24)).toBe(42 + CONTAINER_ROUNDING_TOLERANCE_MS)
    expect(frameTimingToleranceMs(12)).toBeGreaterThan(frameTimingToleranceMs(30))
    // A nonsensical rate does not widen the bound to infinity.
    expect(frameTimingToleranceMs(0)).toBe(CONTAINER_ROUNDING_TOLERANCE_MS)
  })

  it('accepts a frame-boundary landing and refuses a real drift', () => {
    expect(isWithinFrameTolerance(12_333, 12_340, 30)).toBe(true)
    expect(isWithinFrameTolerance(12_800, 12_340, 30)).toBe(false)
  })

  it('keeps the MOCK exact while giving a real engine a bounded envelope', () => {
    // TEETH: the tolerance must NOT weaken Step 16's round-trip proof.
    // A mock that drifts by one millisecond is a broken mock.
    expect(
      renderedDurationMatchesPlan({
        actualMs: 12_001,
        plannedMs: 12_000,
        rendererIsMock: true,
      }),
    ).toBe(false)
    expect(
      renderedDurationMatchesPlan({
        actualMs: 12_000,
        plannedMs: 12_000,
        rendererIsMock: true,
      }),
    ).toBe(true)
    expect(
      renderedDurationMatchesPlan({
        actualMs: 12_000 + MAX_RENDER_TIMING_TOLERANCE_MS,
        plannedMs: 12_000,
        rendererIsMock: false,
      }),
    ).toBe(true)
    expect(
      renderedDurationMatchesPlan({
        actualMs: 12_000 + MAX_RENDER_TIMING_TOLERANCE_MS + 1,
        plannedMs: 12_000,
        rendererIsMock: false,
      }),
    ).toBe(false)
  })
})

describe('approved audio is measured, and the plan grows to hold it', () => {
  it('measures a REAL recording from its bytes', async () => {
    resetMeasuredAudioCacheForTests()
    const wav = makeSilentWav(AUDIO_MS)
    const measured = await measureAudioDurationFromBytes({
      bytes: wav,
      sha256: computeFileSha256(wav),
      mimeType: 'audio/wav',
    })
    if (measured.ok) {
      expect(
        Math.abs(measured.durationMs - AUDIO_MS),
      ).toBeLessThanOrEqual(CONTAINER_ROUNDING_TOLERANCE_MS)
    } else {
      // No ffprobe here: FAIL CLOSED, never a guess and never a fall
      // back to whatever the database said.
      expect(measured.reasonCode).toBe('probe_unavailable')
    }
  }, 60_000)

  it('is DETERMINISTIC for identical bytes — the plan hash depends on it', async () => {
    // TEETH: the measured duration goes into renderPlanSha256, and
    // verifyCompletedRender rebuilds that plan and compares the hash
    // byte-for-byte on every playback request. If the same bytes ever
    // measured differently, a finished recording would become
    // permanently unavailable.
    resetMeasuredAudioCacheForTests()
    const wav = makeSilentWav(AUDIO_MS)
    const sha = computeFileSha256(wav)
    const first = await measureAudioDurationFromBytes({
      bytes: wav,
      sha256: sha,
      mimeType: 'audio/wav',
    })
    const second = await measureAudioDurationFromBytes({
      bytes: wav,
      sha256: sha,
      mimeType: 'audio/wav',
    })
    expect(second).toEqual(first)
  }, 60_000)

  it('refuses bytes with no audio stream rather than assuming a length', async () => {
    resetMeasuredAudioCacheForTests()
    const measured = await measureAudioDurationFromBytes({
      bytes: TINY_PNG,
      sha256: computeFileSha256(TINY_PNG),
      mimeType: 'audio/wav',
    })
    expect(measured.ok).toBe(false)
    if (measured.ok) throw new Error('expected refusal')
    expect(measured.reasonCode).not.toBe('')
  }, 60_000)

  it('refuses empty bytes', async () => {
    const measured = await measureAudioDurationFromBytes({
      bytes: new Uint8Array(0),
      sha256: 'a'.repeat(64),
      mimeType: 'audio/wav',
    })
    expect(measured.ok).toBe(false)
    if (measured.ok) throw new Error('expected refusal')
    expect(measured.reasonCode).toBe('audio_bytes_empty')
  })

  it('there is no code path that refuses audio for being longer than its plan', async () => {
    // TEETH: the locked Step 16 rule is max(planned, actual) — the
    // SEGMENT grows. A refusal keyed on 'longer than planned' would
    // contradict it, so the symbol that encoded that refusal is gone
    // and must not come back.
    const probe = await Bun.file('src/providers/render/media-probe.ts').text()
    const adapter = await Bun.file('src/providers/render/remotion.ts').text()
    for (const source of [probe, adapter]) {
      expect(source).not.toContain('checkApprovedAudioFits')
      expect(source).not.toContain('approved_audio_longer_than_plan')
    }
  })
})

describe('local render runtime dependencies', () => {
  it('reports missing CAPABILITIES, never filesystem paths', async () => {
    const runtime = await checkRenderRuntimeDependencies()
    for (const capability of runtime.missing) {
      expect(['ffprobe', 'render_browser']).toContain(capability)
      expect(capability).not.toContain('/')
      expect(capability).not.toContain('\\')
    }
    expect(runtime.ok).toBe(runtime.missing.length === 0)
  }, 60_000)
})
// --- The adapter, with the compositor injected -------------------------------

function makeRequest(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return {
    renderPlanSha256: 'b'.repeat(64),
    scenes: [
      {
        sceneId: 'scene-1',
        startMs: 0,
        endMs: SCENE_MS,
        durationMs: SCENE_MS,
        visualKind: 'APPROVED_MEDIA',
        visualRefId: 'visual-1',
        visualFit: 'STILL_HOLD',
      },
    ],
    audio: [
      {
        refId: 'audio-1',
        startMs: 0,
        endMs: AUDIO_MS,
        durationMs: AUDIO_MS,
      },
    ],
    sources: [
      {
        refId: 'visual-1',
        role: 'VISUAL',
        storageKey: imageKey,
        sha256: imageSha,
        mimeType: 'image/png',
        durationMs: null,
      },
      {
        refId: 'audio-1',
        role: 'AUDIO',
        storageKey: audioKey,
        sha256: audioSha,
        mimeType: 'audio/wav',
        durationMs: AUDIO_MS,
      },
    ],
    totalDurationMs: SCENE_MS,
    outputMimeType: 'video/mp4',
    ...overrides,
  }
}

/** A deterministic stand-in for a prober: real files, known answers. */
function fakeProbe(
  answers: Record<string, MediaProbeResult>,
  fallback: MediaProbeResult,
) {
  return async (filePath: string): Promise<MediaProbeResult> => {
    for (const [needle, answer] of Object.entries(answers)) {
      if (filePath.includes(needle)) return answer
    }
    return fallback
  }
}

const AUDIO_PROBE: MediaProbeResult = {
  ok: true,
  media: {
    durationMs: AUDIO_MS,
    formatName: 'wav',
    hasAudio: true,
    hasVideo: false,
  },
}
const OUTPUT_PROBE: MediaProbeResult = {
  ok: true,
  media: {
    durationMs: SCENE_MS,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    hasAudio: true,
    hasVideo: true,
  },
}

/** Writes a plausible output file so the adapter has real bytes to
 * hash. Never real media — the probe is injected, so the bytes only
 * have to exist and be non-empty. */
function makeCompositor(
  onCall?: (input: CompositionInput) => void,
): (input: CompositionInput) => Promise<void> {
  return async (input) => {
    onCall?.(input)
    writeFileSync(input.outputPath, Buffer.from('deterministic-render-bytes'))
  }
}

function makeEngine(
  options: {
    probe?: (path: string) => Promise<MediaProbeResult>
    onCompose?: (input: CompositionInput) => void
  } = {},
) {
  return createRemotionRenderEngine({
    probe:
      options.probe ??
      fakeProbe({ 'audio-1': AUDIO_PROBE }, OUTPUT_PROBE),
    compose: makeCompositor(options.onCompose),
  })
}

describe('remotion adapter', () => {
  it('is a real engine, and says so', () => {
    const engine = makeEngine()
    expect(engine.isMock).toBe(false)
    expect(engine.code).toBe('REMOTION')
    // The EXACT compositor, not a major-version family: a render result
    // records this forever and later verification requires it to match.
    expect(engine.version).toBe(`remotion-${REMOTION_PINNED_VERSION}`)
    expect(engine.version).toMatch(/^remotion-\d+\.\d+\.\d+$/)
  })

  it('pins the package set to that EXACT version, with no caret range', async () => {
    const pkg = (await Bun.file('package.json').json()) as {
      dependencies: Record<string, string>
    }
    for (const name of ['remotion', '@remotion/renderer', '@remotion/bundler']) {
      // TEETH: a caret would let an install float to a different
      // compositor while every persisted row still claimed this one.
      expect(pkg.dependencies[name]).toBe(REMOTION_PINNED_VERSION)
    }
  })

  it('renders, measures its own output and hashes the ACTUAL bytes', async () => {
    let seen: CompositionInput | null = null
    const engine = makeEngine({ onCompose: (input) => (seen = input) })
    const output = await engine.render(makeRequest())

    expect(output.mimeType).toBe('video/mp4')
    // MEASURED from the produced file, never echoed from the request.
    expect(output.durationMs).toBe(SCENE_MS)
    expect(createHash('sha256').update(output.bytes).digest('hex')).toBe(
      computeFileSha256(output.bytes),
    )
    expect(output.bytes.length).toBeGreaterThan(0)

    const composition = seen as unknown as CompositionInput
    expect(composition.durationInFrames).toBe(60) // 2 000 ms at 30 fps
    expect(composition.scenes).toHaveLength(1)
    expect(composition.scenes[0].mode).toBe('STILL')
    // A BARE NAME, not a file:// URL. The compositor's page is served
    // over http by Remotion, and Chromium refuses to load a local file
    // into an http origin — so the materialised sources are bundled as
    // the public directory and resolved with staticFile(), which is the
    // only thing that knows the hashed base they are served under.
    const src = composition.scenes[0].src
    expect(src).not.toContain('://')
    expect(src).not.toContain('/')
    expect(src.length).toBeGreaterThan(0)
    // The audio slot follows the MEASURED recording, so nothing is cut
    // off at the end.
    expect(composition.audio[0].durationInFrames).toBe(45) // 1 500 ms
  }, 60_000)

  it('re-proves every source against the plan’s hash before composing', async () => {
    // TEETH: reading the right key is not the same as reading the right
    // bytes. A source swapped after the plan was written must not be
    // composed into somebody's recording.
    const request = makeRequest()
    const tampered: RenderRequest = {
      ...request,
      sources: request.sources.map((source) =>
        source.refId === 'visual-1' ? { ...source, sha256: 'c'.repeat(64) } : source,
      ),
    }
    let composed = false
    const engine = makeEngine({ onCompose: () => (composed = true) })
    await expect(engine.render(tampered)).rejects.toThrow(RenderEngineError)
    expect(composed).toBe(false)
  }, 60_000)

  it('refuses audio whose FILE no longer matches the plan built from it', async () => {
    // NOT the old "longer than its planned slot" refusal — that
    // contradicted the locked rule `max(planned, actual)`, under which
    // the window was already grown to hold the recording. What is
    // caught here is the bytes CHANGING after planning: the plan
    // reserved 1.5s because the file measured 1.5s, and the file now
    // says 2.4s.
    const engine = makeEngine({
      probe: fakeProbe(
        {
          'audio-1': {
            ok: true,
            media: {
              durationMs: 2_400,
              formatName: 'wav',
              hasAudio: true,
              hasVideo: false,
            },
          },
        },
        OUTPUT_PROBE,
      ),
    })
    let thrown: unknown
    try {
      await engine.render(makeRequest())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(RenderEngineError)
    expect((thrown as RenderEngineError).code).toBe(
      'audio_source_changed_since_plan',
    )
    expect((thrown as RenderEngineError).retryable).toBe(false)
  }, 60_000)

  it('composes happily when the plan already reserved the LONGER real length', async () => {
    // TEETH for the corrected contract: a 12.4s recording in a 12.4s
    // planned window — which is what the reconciliation produces from a
    // 12.0s database row — must render, not be refused.
    const grown = 2_400
    const request = makeRequest({
      audio: [{ refId: 'audio-1', startMs: 0, endMs: grown, durationMs: grown }],
      scenes: [
        {
          sceneId: 'scene-1',
          startMs: 0,
          endMs: grown,
          durationMs: grown,
          visualKind: 'APPROVED_MEDIA',
          visualRefId: 'visual-1',
          visualFit: 'STILL_HOLD',
        },
      ],
      totalDurationMs: grown,
    })
    const engine = makeEngine({
      probe: fakeProbe(
        {
          'audio-1': {
            ok: true,
            media: {
              durationMs: grown,
              formatName: 'wav',
              hasAudio: true,
              hasVideo: false,
            },
          },
        },
        {
          ok: true,
          media: {
            durationMs: grown,
            formatName: 'mov,mp4',
            hasAudio: true,
            hasVideo: true,
          },
        },
      ),
    })
    const output = await engine.render(request)
    expect(output.durationMs).toBe(grown)
  }, 60_000)

  it('refuses an unmeasurable source rather than trusting stored metadata', async () => {
    const engine = makeEngine({
      probe: fakeProbe(
        { 'audio-1': { ok: false, reasonCode: 'probe_unavailable' } },
        OUTPUT_PROBE,
      ),
    })
    await expect(engine.render(makeRequest())).rejects.toThrow(RenderEngineError)
  }, 60_000)

  it('refuses an output that is not the planned container', async () => {
    for (const badOutput of [
      {
        ok: true as const,
        media: {
          durationMs: SCENE_MS,
          formatName: 'matroska,webm',
          hasAudio: true,
          hasVideo: true,
        },
      },
      {
        ok: true as const,
        media: {
          durationMs: SCENE_MS,
          formatName: 'mov,mp4',
          hasAudio: true,
          hasVideo: false,
        },
      },
      {
        ok: true as const,
        media: {
          durationMs: SCENE_MS + 5_000,
          formatName: 'mov,mp4',
          hasAudio: true,
          hasVideo: true,
        },
      },
    ]) {
      const engine = makeEngine({
        probe: fakeProbe({ 'audio-1': AUDIO_PROBE }, badOutput),
      })
      await expect(engine.render(makeRequest())).rejects.toThrow(RenderEngineError)
    }
  }, 60_000)

  it('renders only the planned container', async () => {
    const engine = makeEngine()
    await expect(
      engine.render(makeRequest({ outputMimeType: 'video/webm' })),
    ).rejects.toThrow(RenderEngineError)
  }, 60_000)

  it('refuses an empty output', async () => {
    const engine = createRemotionRenderEngine({
      probe: fakeProbe({ 'audio-1': AUDIO_PROBE }, OUTPUT_PROBE),
      compose: async (input) => {
        writeFileSync(input.outputPath, Buffer.alloc(0))
      },
    })
    let thrown: unknown
    try {
      await engine.render(makeRequest())
    } catch (error) {
      thrown = error
    }
    expect((thrown as RenderEngineError).code).toBe('output_empty')
  }, 60_000)
})

describe('the composition contains only what the plan named', () => {
  it('has no text, title, watermark, caption or music of any kind', async () => {
    // A compositor being technically able to draw something is not
    // authority to draw it. Every element must have been approved
    // upstream and named in the plan.
    const composition = await Bun.file(
      'src/remotion/PrayerComposition.tsx',
    ).text()
    // Comments are stripped properly — including JSX `{/* … */}` — so
    // this asserts on what the component DOES, not on prose about what
    // it deliberately does not do.
    const code = composition
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    for (const forbidden of [
      'watermark',
      'Watermark',
      'subtitle',
      'Subtitle',
      'caption',
      'Caption',
      'overlay',
      'Overlay',
      '<h1',
      '<p>',
      'fontFamily',
      'playbackRate',
      'loop',
      'volume',
    ]) {
      expect(code).not.toContain(forbidden)
    }
    // The visual track of a source is used; its audio never is.
    expect(code).toContain('muted')
  })
})
