import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRemotionRenderEngine } from '@/providers/render/remotion'
import { RenderEngineError } from '@/providers/render/types'
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
 * HOLD MEANS FREEZE — Phase One, Step 20 hardening.
 *
 * The render plan says HOLD_PREVIOUS when a scene shows no new footage:
 * the picture that was last on screen simply stays there. The first
 * Step 20 adapter ignored that and handed every scene `startFrom: 0`,
 * which would have REPLAYED the earlier clip from its beginning — the
 * viewer shown approved footage a second time, in a place nobody
 * approved it for, while the audio carried on underneath.
 *
 * This suite pins the corrected semantics for all four compositor
 * modes, using a deterministic non-sacred stand-in and an INJECTED
 * probe. Step 14's mock artifacts are untouched, and Remotion itself is
 * never invoked.
 * ============================================================================
 */

const VIDEO_SOURCE_MS = 4_000
const FPS = 30

const VIDEO_PROBE: MediaProbeResult = {
  ok: true,
  media: {
    durationMs: VIDEO_SOURCE_MS,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    hasAudio: false,
    hasVideo: true,
  },
}

/** A 1×1 opaque PNG — the smallest legal still this platform accepts. */
const TINY_PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
)

let mediaRoot: string
let storage: LocalMediaStorageProvider
let videoKey: string
let videoSha: string
let imageKey: string
let imageSha: string

beforeAll(async () => {
  mediaRoot = mkdtempSync(join(tmpdir(), 'yhw-hold-'))
  storage = new LocalMediaStorageProvider(mediaRoot)
  setMediaStorageForTests(storage)
  // Deterministic, non-sacred stand-ins. The probe is injected, so
  // these bytes only have to exist and hash stably.
  const fakeClip = new Uint8Array(2048).fill(9)
  videoSha = computeFileSha256(fakeClip)
  videoKey = (await storage.put(fakeClip, 'mp4')).storageKey
  imageSha = computeFileSha256(TINY_PNG)
  imageKey = (await storage.put(TINY_PNG, 'png')).storageKey
})

afterAll(() => {
  resetMediaStorageForTests()
  rmSync(mediaRoot, { recursive: true, force: true })
})

function outputProbe(totalMs: number): MediaProbeResult {
  return {
    ok: true,
    media: {
      durationMs: totalMs,
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      hasAudio: false,
      hasVideo: true,
    },
  }
}

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

/** A plan whose FIRST scene shows a clip and whose SECOND scene HOLDS
 * it — the exact shape that must never restart the clip. */
function makeHoldRequest(options: {
  firstWindowMs: number
  holdWindowMs: number
  image?: boolean
}): RenderRequest {
  const total = options.firstWindowMs + options.holdWindowMs
  return {
    renderPlanSha256: 'c'.repeat(64),
    scenes: [
      {
        sceneId: 'scene-1',
        startMs: 0,
        endMs: options.firstWindowMs,
        durationMs: options.firstWindowMs,
        visualKind: 'APPROVED_MEDIA',
        visualRefId: 'visual-1',
        visualFit: options.image === true ? 'STILL_HOLD' : 'TRIM',
      },
      {
        sceneId: 'scene-2',
        startMs: options.firstWindowMs,
        endMs: total,
        durationMs: options.holdWindowMs,
        visualKind: 'HOLD_PREVIOUS',
        // The plan points a hold at the EARLIER scene's source.
        visualRefId: 'visual-1',
        visualFit: 'HOLD_LAST_FRAME',
      },
    ],
    audio: [],
    sources: [
      options.image === true
        ? {
            refId: 'visual-1',
            role: 'VISUAL',
            storageKey: imageKey,
            sha256: imageSha,
            mimeType: 'image/png',
            durationMs: null,
          }
        : {
            refId: 'visual-1',
            role: 'VISUAL',
            storageKey: videoKey,
            sha256: videoSha,
            mimeType: 'video/mp4',
            durationMs: VIDEO_SOURCE_MS,
          },
    ],
    totalDurationMs: total,
    outputMimeType: 'video/mp4',
  }
}

async function compose(request: RenderRequest): Promise<CompositionInput> {
  let seen: CompositionInput | null = null
  const engine = createRemotionRenderEngine({
    fps: FPS,
    probe: fakeProbe(
      { 'visual-1': VIDEO_PROBE },
      outputProbe(request.totalDurationMs),
    ),
    compose: async (input) => {
      seen = input
      writeFileSync(input.outputPath, Buffer.from('deterministic-render-bytes'))
    },
  })
  await engine.render(request)
  const captured = seen as CompositionInput | null
  if (!captured) throw new Error('compositor was never called')
  return captured
}

describe('a hold freezes the last displayed frame', () => {
  it('HOLD_PREVIOUS FREEZES and never replays from frame zero', async () => {
    // The clip is 4 000 ms; the first scene shows 2 000 ms of it, and
    // the second holds. The held frame must be the one that was on
    // screen at 2 000 ms.
    const composition = await compose(
      makeHoldRequest({ firstWindowMs: 2_000, holdWindowMs: 1_000 }),
    )
    const [first, hold] = composition.scenes
    expect(first.mode).toBe('PLAY')
    expect(hold.mode).toBe('FREEZE')
    // TEETH: frame zero is precisely the wrong answer, and the one the
    // first implementation would have given.
    expect(hold.freezeFrame).toBeGreaterThan(0)
    expect(hold.freezeFrame).toBe(Math.round((2_000 / 1000) * FPS) - 1)
    // A freeze plays nothing.
    expect(hold.playFrames).toBe(0)
    expect(hold.sourceStartFrame).toBe(0)
    // A hold shows the PREVIOUS picture, never a different source.
    expect(hold.src).toBe(first.src)
  }, 60_000)

  it('holds the END of a clip that was played out in full', async () => {
    // The first window is LONGER than the clip: it plays out, its final
    // frame is held for the remainder, and the following hold freezes
    // that same final frame.
    const composition = await compose(
      makeHoldRequest({ firstWindowMs: 6_000, holdWindowMs: 1_000 }),
    )
    const [first, hold] = composition.scenes
    expect(first.mode).toBe('PLAY_THEN_FREEZE')
    expect(first.playFrames).toBeGreaterThan(0)
    expect(first.playFrames).toBeLessThanOrEqual(first.durationInFrames)
    expect(first.freezeFrame).toBe(first.playFrames - 1)
    // TEETH: the two spans cover the window EXACTLY. A gap would paint
    // black over approved footage; an overlap would double-draw.
    expect(first.durationInFrames - first.playFrames).toBeGreaterThan(0)
    expect(hold.mode).toBe('FREEZE')
    expect(hold.freezeFrame).toBe(
      Math.round((VIDEO_SOURCE_MS / 1000) * FPS) - 1,
    )
  }, 60_000)

  it('holding a STILL is simply the still', async () => {
    const composition = await compose(
      makeHoldRequest({
        firstWindowMs: 2_000,
        holdWindowMs: 1_000,
        image: true,
      }),
    )
    expect(composition.scenes[0].mode).toBe('STILL')
    expect(composition.scenes[1].mode).toBe('STILL')
    // No freeze arithmetic is invented for a picture that never moved.
    expect(composition.scenes[1].freezeFrame).toBe(0)
  }, 60_000)

  it('refuses a leading HOLD_PREVIOUS — there is no picture to hold', async () => {
    const request = makeHoldRequest({
      firstWindowMs: 2_000,
      holdWindowMs: 1_000,
    })
    const leadingHold: RenderRequest = {
      ...request,
      scenes: [request.scenes[1]],
      totalDurationMs: 1_000,
    }
    const engine = createRemotionRenderEngine({
      fps: FPS,
      probe: fakeProbe({ 'visual-1': VIDEO_PROBE }, outputProbe(1_000)),
      compose: async (input) => {
        writeFileSync(input.outputPath, Buffer.from('x'))
      },
    })
    await expect(engine.render(leadingHold)).rejects.toThrow(RenderEngineError)
  }, 60_000)
})

describe('the composition implements the modes, rather than guessing', () => {
  it('uses Remotion Freeze and never a bare replay for a hold', async () => {
    const source = await Bun.file('src/remotion/PrayerComposition.tsx').text()
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).toContain('Freeze')
    expect(code).toContain('freezeFrame')
    for (const mode of ['STILL', 'FREEZE', 'PLAY_THEN_FREEZE']) {
      expect(code).toContain(mode)
    }
    // A visual source's own audio is never heard — the approved audio
    // timeline is the only audio.
    expect(code.split('muted').length - 1).toBeGreaterThanOrEqual(3)
  })

  it('the adapter tracks what was last displayed, not merely the last source', async () => {
    const adapter = await Bun.file('src/providers/render/remotion.ts').text()
    expect(adapter).toContain('lastDisplayed')
    expect(adapter).toContain('endedAtSourceMs')
    // TEETH: the old implementation hard-coded a zero start for every
    // scene, which is exactly the replay bug.
    expect(adapter).not.toContain('sourceStartFrame: 0,\n    })')
  })
})
