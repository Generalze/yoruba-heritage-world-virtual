/**
 * REMOTION TECHNICAL QUALIFICATION — does this image actually render?
 *
 *   docker compose run --rm app bun run scripts/qualify-remotion.ts
 *
 * WHAT THIS PROVES, and nothing more: that inside the production image,
 * under the production resource limits, Chromium and ffprobe and
 * Remotion together turn frames into a real MP4 with a measurable
 * duration. That is a TECHNICAL fact about the runtime.
 *
 * WHAT IT DOES NOT PROVE. It is not the prayer pipeline. It does not
 * exercise recipe selection, storyboard planning, governed content,
 * approved media, the Visual Bible rules, the at-most-once reservation
 * or the private upload. Nobody may conclude from a green run here
 * that a personalised prayer recording can be produced end to end —
 * that is a separate qualification, and it needs governed inputs this
 * script deliberately refuses to touch.
 *
 * WHY FIXTURES. Publishing a governed template merely to make a
 * technical render possible would be publishing for the convenience of
 * a test, which is exactly backwards: publication is a human decision
 * about sacred content, not a step in a smoke test. So the inputs here
 * are synthetic — a generated image and generated silence — written to
 * a THROWAWAY media root. No approved media is read, no sacred text is
 * loaded, no database row is touched, and no paid provider exists in
 * this path at all.
 */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { setMediaStorageForTests } from '@/providers/media/storage'
import { LocalMediaStorageProvider } from '@/providers/media/storage'
import { createRemotionRenderEngine } from '@/providers/render/remotion'
import type { RenderRequest } from '@/providers/render/types'

// --- A real PNG, built here so nothing is fetched or committed --------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  const crcInput = new Uint8Array(4 + body.length)
  for (let i = 0; i < 4; i += 1) crcInput[i] = type.charCodeAt(i)
  crcInput.set(body, 4)
  view.setUint32(8 + body.length, crc32(crcInput))
  return out
}

/** A solid-colour RGB PNG. Deliberately unremarkable: this is a test
 * card, not imagery, and it depicts nothing. */
function buildPng(width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height)
  let offset = 0
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0
    offset += 1
    for (let x = 0; x < width; x += 1) {
      raw[offset] = 32
      raw[offset + 1] = 24
      raw[offset + 2] = 48
      offset += 3
    }
  }
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width)
  ihdrView.setUint32(4, height)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const png = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    png.set(part, at)
    at += part.length
  }
  return png
}

/** Silence. 16 kHz mono 16-bit, so the header arithmetic is the same
 * one the speech path already measures. */
function buildSilentWav(ms: number): Uint8Array {
  const sampleRate = 16_000
  const samples = Math.round((sampleRate * ms) / 1000)
  const dataBytes = samples * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i)
  }
  tag(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  tag(36, 'data')
  view.setUint32(40, dataBytes, true)
  return out
}

async function main(): Promise<void> {
  console.log('REMOTION TECHNICAL QUALIFICATION')
  console.log('Fixture inputs only. No governed content, no vendor, no database.\n')

  const root = mkdtempSync(join(tmpdir(), 'yhw-remotion-qual-'))
  mkdirSync(join(root, 'fixtures'), { recursive: true })
  setMediaStorageForTests(new LocalMediaStorageProvider(root))

  const png = buildPng(1280, 720)
  const wav = buildSilentWav(3000)
  const imageKey = 'fixtures/qualification-card.png'
  const audioKey = 'fixtures/qualification-silence.wav'
  writeFileSync(join(root, imageKey), png)
  writeFileSync(join(root, audioKey), wav)
  const imageSha = createHash('sha256').update(png).digest('hex')
  const audioSha = createHash('sha256').update(wav).digest('hex')
  console.log(`  fixture image  ${png.length} bytes`)
  console.log(`  fixture audio  ${wav.length} bytes (3000 ms of silence)`)
  console.log(`  throwaway media root: ${root}\n`)

  const request: RenderRequest = {
    renderPlanSha256: createHash('sha256')
      .update('remotion-technical-qualification', 'utf8')
      .digest('hex'),
    totalDurationMs: 3000,
    outputMimeType: 'video/mp4',
    scenes: [
      {
        sceneId: 'qualification-scene',
        startMs: 0,
        endMs: 3000,
        durationMs: 3000,
        visualKind: 'APPROVED_MEDIA',
        visualRefId: 'qualification-scene',
        visualFit: 'STILL_HOLD',
      },
    ],
    audio: [
      { refId: 'qualification-audio', startMs: 0, endMs: 3000, durationMs: 3000 },
    ],
    sources: [
      {
        refId: 'qualification-scene',
        role: 'VISUAL',
        storageKey: imageKey,
        sha256: imageSha,
        mimeType: 'image/png',
        durationMs: null,
      },
      {
        refId: 'qualification-audio',
        role: 'AUDIO',
        storageKey: audioKey,
        sha256: audioSha,
        mimeType: 'audio/wav',
        durationMs: 3000,
      },
    ],
  }

  const engine = createRemotionRenderEngine()
  console.log(`  engine: ${engine.code} ${engine.version} (isMock=${engine.isMock})`)
  if (engine.isMock) {
    console.error('refusing: this is the mock engine — nothing would be proved')
    process.exit(1)
  }

  const startedAt = Date.now()
  const output = await engine.render(request)
  const elapsed = Date.now() - startedAt

  const digest = createHash('sha256').update(output.bytes).digest('hex')
  const outPath = join(root, 'qualification.mp4')
  writeFileSync(outPath, output.bytes)

  console.log('\nRESULT')
  console.log(`  mime type        ${output.mimeType}`)
  console.log(`  bytes            ${output.bytes.length}`)
  console.log(`  measured duration ${output.durationMs} ms (ffprobe, from the file)`)
  console.log(`  sha256           ${digest}`)
  console.log(`  wall clock       ${elapsed} ms`)
  console.log(`  written          ${outPath}`)

  const problems: Array<string> = []
  if (output.mimeType !== 'video/mp4') problems.push('mime type is not video/mp4')
  if (output.bytes.length < 1000) problems.push('output is implausibly small')
  if (output.durationMs <= 0) problems.push('no measurable duration')
  // The renderer measures the file it produced; a wildly different
  // length would mean the timeline and the media disagree.
  if (Math.abs(output.durationMs - 3000) > 750) {
    problems.push(`duration ${output.durationMs} ms is far from the planned 3000 ms`)
  }

  if (problems.length > 0) {
    console.error('\nFAILED:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }

  console.log('\nPASS — Chromium, ffprobe and Remotion produced a real MP4 in this image.')
  console.log('This is a RUNTIME proof only. The prayer pipeline is NOT qualified by it:')
  console.log('no governed content, no approved media, no reservation, no upload.')
}

await main()
