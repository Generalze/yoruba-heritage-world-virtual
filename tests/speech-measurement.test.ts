import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  NEUTRAL_AUDIO_EXTENSION,
  VARIANCE_BAND_AMBER_MAX_PERCENT,
  VARIANCE_BAND_GREEN_MAX_PERCENT,
  audioFileExtensionFor,
  classifyDurationVariance,
} from '@/lib/speech-measurement'
import {
  parseAudioTechnicalMetadata,
  probeAudioTechnicalMetadataFromBytes,
} from '@/providers/render/media-probe'

/**
 * ============================================================================
 * SPEECH MEASUREMENT — the report surface of a PAID measurement.
 *
 * Every rule here decides what a two-call, non-repeatable measurement
 * will be understood to have MEANT. The calls cost money and cannot be
 * re-run for free, so the report they produce has to be right the first
 * time: the band it publishes, the technical shape it claims, the
 * absence it admits to, and the name it writes on the audio.
 *
 * Nothing in this file contacts a provider. It measures bytes it builds
 * itself.
 * ============================================================================
 */

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

/** A real, minimal PCM WAV of a known shape — mono, 8 kHz, 16-bit. */
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

// --- Variance banding --------------------------------------------------------

describe('the locked variance bands', () => {
  it('holds the thresholds agreed BEFORE any audio existed to judge', () => {
    // TEETH: these were fixed at YA-0 so the first measurement could not
    // be graded against a threshold chosen after seeing it. Moving them
    // is a governance change, not a code change.
    expect(VARIANCE_BAND_GREEN_MAX_PERCENT).toBe(15)
    expect(VARIANCE_BAND_AMBER_MAX_PERCENT).toBe(40)
  })

  it('bands the GREEN boundary inclusively', () => {
    expect(classifyDurationVariance(0)).toBe('GREEN')
    expect(classifyDurationVariance(14.9)).toBe('GREEN')
    expect(classifyDurationVariance(15)).toBe('GREEN')
    // The first value outside the band is not still GREEN.
    expect(classifyDurationVariance(15.1)).toBe('AMBER')
  })

  it('bands the AMBER boundary inclusively', () => {
    expect(classifyDurationVariance(15.1)).toBe('AMBER')
    expect(classifyDurationVariance(39.9)).toBe('AMBER')
    expect(classifyDurationVariance(40)).toBe('AMBER')
    expect(classifyDurationVariance(40.1)).toBe('RED')
  })

  it('bands RED above the amber ceiling, however far above', () => {
    expect(classifyDurationVariance(41)).toBe('RED')
    expect(classifyDurationVariance(150)).toBe('RED')
    expect(classifyDurationVariance(1_000)).toBe('RED')
  })

  it('judges MAGNITUDE, so a block that comes back short is a finding too', () => {
    // A 32-second budget spoken in 18 seconds is exactly as much of a
    // discovery about the writing as one spoken in 46.
    expect(classifyDurationVariance(-10)).toBe('GREEN')
    expect(classifyDurationVariance(-15)).toBe('GREEN')
    expect(classifyDurationVariance(-20)).toBe('AMBER')
    expect(classifyDurationVariance(-40)).toBe('AMBER')
    expect(classifyDurationVariance(-55)).toBe('RED')
  })

  it('refuses to call an unclassifiable measurement GREEN', () => {
    // No authored budget means no comparison. Silence about that is a
    // report that implies a pass it never established.
    expect(classifyDurationVariance(null)).toBeNull()
    expect(classifyDurationVariance(Number.NaN)).toBeNull()
    expect(classifyDurationVariance(Number.POSITIVE_INFINITY)).toBeNull()
  })
})

// --- Naming the evidence -----------------------------------------------------

describe('naming a returned audio artifact', () => {
  it('derives the extension from what the provider actually returned', () => {
    for (const [mimeType, extension] of [
      ['audio/wav', 'wav'],
      ['audio/x-wav', 'wav'],
      ['audio/wave', 'wav'],
      ['audio/mpeg', 'mp3'],
      ['audio/mp4', 'm4a'],
      ['audio/ogg', 'ogg'],
      ['audio/opus', 'opus'],
      ['audio/webm', 'weba'],
      ['audio/flac', 'flac'],
      ['audio/aac', 'aac'],
    ] as const) {
      const result = audioFileExtensionFor(mimeType)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(`expected ${mimeType} to be named`)
      expect(result.extension).toBe(extension)
    }
  })

  it('reads the type, not the parameters somebody appended to it', () => {
    const withCharset = audioFileExtensionFor('audio/wav; charset=binary')
    expect(withCharset.ok).toBe(true)
    if (!withCharset.ok) throw new Error('expected a name')
    expect(withCharset.extension).toBe('wav')

    const shouty = audioFileExtensionFor('  AUDIO/MPEG  ')
    expect(shouty.ok).toBe(true)
    if (!shouty.ok) throw new Error('expected a name')
    expect(shouty.extension).toBe('mp3')
  })

  it('refuses to guess at an unknown type — and NEVER guesses WAV', () => {
    // TEETH: the provider returns WAV today. The failure this guards is
    // the day it stops, and a file called `.wav` goes on claiming
    // otherwise long after the run that wrote it.
    for (const unknown of [
      'application/octet-stream',
      'audio/basic',
      'text/plain',
      'audio',
      '',
    ]) {
      const result = audioFileExtensionFor(unknown)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`${unknown} should not be named`)
      expect(result.reasonCode).toBe('audio_mime_type_unrecognised')
    }
  })

  it('offers a neutral name rather than a false one', () => {
    // Fail closed on the NAME, not on the bytes: discarding paid audio
    // because it could not be named would be the worse mistake.
    expect(NEUTRAL_AUDIO_EXTENSION).toBe('bin')
    expect(NEUTRAL_AUDIO_EXTENSION).not.toBe('wav')
  })
})

// --- Technical metadata ------------------------------------------------------

describe('reading the technical shape of returned audio', () => {
  const FFPROBE_OUTPUT = JSON.stringify({
    streams: [
      {
        codec_type: 'audio',
        codec_name: 'pcm_s16le',
        sample_rate: '24000',
        channels: 1,
        duration: '32.140000',
      },
    ],
    format: { duration: '32.140000', format_name: 'wav' },
  })

  it('extracts codec, sample rate and channels', () => {
    const parsed = parseAudioTechnicalMetadata(FFPROBE_OUTPUT)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected metadata')
    expect(parsed.metadata.codec).toBe('pcm_s16le')
    expect(parsed.metadata.sampleRate).toBe(24_000)
    expect(parsed.metadata.channels).toBe(1)
  })

  it('reads the AUDIO stream, not whichever stream came first', () => {
    const withVideo = JSON.stringify({
      streams: [
        { codec_type: 'video', codec_name: 'h264', duration: '32.0' },
        {
          codec_type: 'audio',
          codec_name: 'aac',
          sample_rate: '44100',
          channels: 2,
        },
      ],
      format: { duration: '32.0', format_name: 'mov,mp4' },
    })
    const parsed = parseAudioTechnicalMetadata(withVideo)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected metadata')
    expect(parsed.metadata.codec).toBe('aac')
    expect(parsed.metadata.sampleRate).toBe(44_100)
    expect(parsed.metadata.channels).toBe(2)
  })

  it('reports an absent value as absent rather than inventing a plausible one', () => {
    // A report that says 44100 Hz because 44100 is common is worse than
    // one that admits it does not know.
    const sparse = JSON.stringify({
      streams: [{ codec_type: 'audio', codec_name: 'mp3' }],
      format: { duration: '10.0' },
    })
    const parsed = parseAudioTechnicalMetadata(sparse)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error('expected metadata')
    expect(parsed.metadata.codec).toBe('mp3')
    expect(parsed.metadata.sampleRate).toBeNull()
    expect(parsed.metadata.channels).toBeNull()
  })

  it('fails closed with a bounded code on output it cannot use', () => {
    const unparseable = parseAudioTechnicalMetadata('not json at all')
    expect(unparseable.ok).toBe(false)
    if (unparseable.ok) throw new Error('expected refusal')
    expect(unparseable.reasonCode).toBe('probe_unparseable')

    const silent = parseAudioTechnicalMetadata(
      JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }] }),
    )
    expect(silent.ok).toBe(false)
    if (silent.ok) throw new Error('expected refusal')
    expect(silent.reasonCode).toBe('audio_stream_missing')
  })

  it('reads a REAL file through a real prober', async () => {
    const wav = makeSilentWav(1_500)
    const probed = await probeAudioTechnicalMetadataFromBytes({
      bytes: wav,
      mimeType: 'audio/wav',
    })
    if (probed.ok) {
      // The fixture's shape is known by construction, so this is a
      // genuine round trip rather than a restatement of the parser.
      expect(probed.metadata.codec).toBe('pcm_s16le')
      expect(probed.metadata.sampleRate).toBe(8_000)
      expect(probed.metadata.channels).toBe(1)
    } else {
      // No ffprobe on this machine: FAIL CLOSED with a bounded code,
      // never a silent success and never a guessed shape.
      expect(probed.reasonCode).toBe('probe_unavailable')
      console.warn(
        '[speech-measurement] ffprobe unavailable — fail-closed path asserted instead',
      )
    }
  }, 60_000)

  it('refuses empty bytes and bytes that are not audio', async () => {
    const empty = await probeAudioTechnicalMetadataFromBytes({
      bytes: new Uint8Array(0),
      mimeType: 'audio/wav',
    })
    expect(empty.ok).toBe(false)
    if (empty.ok) throw new Error('expected refusal')
    expect(empty.reasonCode).toBe('audio_bytes_empty')

    const notAudio = await probeAudioTechnicalMetadataFromBytes({
      bytes: new TextEncoder().encode('this is not a wav file'),
      mimeType: 'audio/wav',
    })
    expect(notAudio.ok).toBe(false)
    if (notAudio.ok) throw new Error('expected refusal')
    expect(notAudio.reasonCode).not.toBe('')
  }, 60_000)
})

// --- What these modules are NOT allowed to be --------------------------------

describe('the measurement report surface stays offline and additive', () => {
  it('reaches no provider, and cannot be made to', () => {
    // TEETH: the whole point of a pure report surface is that the bands
    // and names can be proved without spending anything.
    const pure = read('src/lib/speech-measurement.ts')
    for (const forbidden of [
      'fetch(',
      'naijalingo',
      'NAIJALINGO',
      'openai',
      'submitSpeech',
      'node:child_process',
      'node:fs',
    ]) {
      expect(pure).not.toContain(forbidden)
    }
  })

  it('leaves the renderer path untouched', () => {
    // The new probe is ADDITIVE. `ProbedMedia` feeds the structure whose
    // hash decides whether a finished recording stays playable, so it
    // must not grow a field to serve a report.
    const probe = read('src/providers/render/media-probe.ts')
    const probedMedia = probe.slice(
      probe.indexOf('export interface ProbedMedia'),
      probe.indexOf('export type MediaProbeResult'),
    )
    expect(probedMedia).not.toContain('codec:')
    expect(probedMedia).not.toContain('sampleRate')
    expect(probedMedia).not.toContain('channels')
    // And the duration measurement still returns exactly what it did.
    expect(probe).toContain('return { ok: true, durationMs: probed.media.durationMs }')
  })
})
