import { describe, expect, it } from 'bun:test'

import { RESERVATION_STALE_AFTER_MS } from '@/services/generation-jobs'
import {
  NAIJALINGO_CLIENT_LIMITS,
  NAIJALINGO_LANGUAGE,
  NAIJALINGO_TTS_CODE,
  createNaijalingoTtsProvider,
  parseWavDurationMs,
} from '@/providers/tts/naijalingo'
import { TtsProviderError } from '@/providers/tts/types'
import type {
  NaijalingoSpeechClient,
  NaijalingoSpeechRequestBody,
  NaijalingoTtsConfig,
} from '@/providers/tts/naijalingo'
import type { SpeechSynthesisRequest } from '@/providers/tts/types'

/**
 * ============================================================================
 * 9JALINGO TTS ADAPTER — Phase One, Step 20.
 *
 * Every test here uses an INJECTED FAKE CLIENT: zero network, zero real
 * API, zero spend. The adapter's whole job is to be boring — a closed
 * five-field request body, the approved text verbatim, WAV bytes back,
 * fixed error codes out — and each test pins one of those properties.
 * ============================================================================
 */

const CONFIG: NaijalingoTtsConfig = {
  apiKey: 'test-secret-key-XyZ',
  baseUrl: 'https://api.example-9jalingo.test/v1',
  model: 'naijalingo-tts-1',
  maleVoiceId: 'adeola_yo_male',
  femaleVoiceId: 'adeola_yo_female',
}

/** A minimal, coherent PCM WAV: 44-byte canonical header + data. */
function buildWav(options: {
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  dataBytes: number
}): Uint8Array {
  const sampleRate = options.sampleRate ?? 16_000
  const channels = options.channels ?? 1
  const bits = options.bitsPerSample ?? 16
  const byteRate = (sampleRate * channels * bits) / 8
  const data = new Uint8Array(options.dataBytes)
  for (let i = 0; i < data.length; i += 1) data[i] = i % 251
  const bytes = new Uint8Array(44 + data.length)
  const view = new DataView(bytes.buffer)
  const writeTag = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      bytes[offset + i] = text.charCodeAt(i)
    }
  }
  writeTag(0, 'RIFF')
  view.setUint32(4, 36 + data.length, true)
  writeTag(8, 'WAVE')
  writeTag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, (channels * bits) / 8, true)
  view.setUint16(34, bits, true)
  writeTag(36, 'data')
  view.setUint32(40, data.length, true)
  bytes.set(data, 44)
  return bytes
}

function fakeClient(
  bytes: Uint8Array,
): NaijalingoSpeechClient & { calls: Array<NaijalingoSpeechRequestBody> } {
  const calls: Array<NaijalingoSpeechRequestBody> = []
  return {
    calls,
    async createSpeech(body) {
      calls.push(body)
      return bytes
    },
  }
}

const APPROVED_TEXT =
  'Àdúrà mímọ́ — gbogbo ọ̀rọ̀ tí a fọwọ́ sí ni a sọ ní pàtó, láì yí padà.'

function request(
  overrides: Partial<SpeechSynthesisRequest> = {},
): SpeechSynthesisRequest {
  return {
    idempotencyKey: 'a'.repeat(64),
    requirementId: 'req-9ja-unit',
    sceneId: 'scene-9ja-unit',
    approvedText: APPROVED_TEXT,
    language: 'yo',
    voiceProfile: 'YO_MALE',
    voicePolicy: 'APPROVED_TTS_ALLOWED',
    targetDurationMs: 10_000,
    ...overrides,
  }
}

async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

describe('9jaLingo adapter: the request that leaves this codebase', () => {
  it('sends the EXACT approved text once, as yo, in WAV, under the configured voice and model — and nothing else', async () => {
    // 16000 Hz mono 16-bit → byteRate 32000; 64000 data bytes → 2000 ms.
    const wav = buildWav({ dataBytes: 64_000 })
    const client = fakeClient(wav)
    const provider = createNaijalingoTtsProvider(CONFIG, client)

    const submission = await provider.submitSpeech(request())

    expect(client.calls).toHaveLength(1)
    const body = client.calls[0]
    // VERBATIM: not trimmed, not translated, not shortened, not padded.
    expect(body.input).toBe(APPROVED_TEXT)
    expect(body.lang).toBe('yo')
    expect(body.response_format).toBe('wav')
    // Voice and model come from TRUSTED SERVER CONFIG, never from the
    // request, a row, or a user.
    expect(body.voice).toBe(CONFIG.maleVoiceId)
    expect(body.model).toBe(CONFIG.model)
    // THE CLOSED ALLOWLIST — the structural no-cloning / no-duration-
    // instruction guarantee. No speaker sample, no reference audio, no
    // targetDurationMs, no prosody knobs: five keys, exactly.
    expect(Object.keys(body).sort()).toEqual([
      'input',
      'lang',
      'model',
      'response_format',
      'voice',
    ])

    expect(submission.status).toBe('COMPLETED')
    if (submission.status !== 'COMPLETED') return
    expect(submission.artifact.bytes).toEqual(wav)
    expect(submission.artifact.mimeType).toBe('audio/wav')
    // Duration is MEASURED from the returned WAV, never requested.
    expect(submission.artifact.durationMs).toBe(2_000)
  })

  it('speaks Phase-One Yoruba only, and refuses every other language BEFORE any client call', async () => {
    const client = fakeClient(buildWav({ dataBytes: 3_200 }))
    const provider = createNaijalingoTtsProvider(CONFIG, client)
    expect(provider.supportedLanguages).toEqual([NAIJALINGO_LANGUAGE])
    for (const language of ['en', 'ha', 'ig', 'pcm', '']) {
      const error = await thrownBy(() =>
        provider.submitSpeech(request({ language })),
      )
      expect(error).toBeInstanceOf(TtsProviderError)
      expect((error as TtsProviderError).code).toBe('language_unsupported')
      expect((error as TtsProviderError).retryable).toBe(false)
    }
    expect(client.calls).toHaveLength(0)
  })

  it('refuses any voice policy but APPROVED_TTS_ALLOWED before any client call', async () => {
    const client = fakeClient(buildWav({ dataBytes: 3_200 }))
    const provider = createNaijalingoTtsProvider(CONFIG, client)
    for (const voicePolicy of ['TEXT_ONLY', 'HUMAN_RECORDED_REQUIRED', '']) {
      const error = await thrownBy(() =>
        provider.submitSpeech(request({ voicePolicy })),
      )
      expect((error as TtsProviderError).code).toBe('voice_policy_forbidden')
    }
    expect(client.calls).toHaveLength(0)
  })
})

describe('9jaLingo adapter: failures stay bounded and secret-free', () => {
  it('maps a thrown client error to a FIXED code — the raw error (and anything it echoes) is dropped', async () => {
    const marker = `leak-${crypto.randomUUID()}`
    const provider = createNaijalingoTtsProvider(CONFIG, {
      async createSpeech() {
        // A hostile worst case: the transport error echoes the request
        // text AND the credential.
        throw new Error(
          `boom ${marker} input=${APPROVED_TEXT} key=${CONFIG.apiKey}`,
        )
      },
    })
    const error = await thrownBy(() => provider.submitSpeech(request()))
    expect(error).toBeInstanceOf(TtsProviderError)
    const providerError = error as TtsProviderError
    expect(providerError.code).toBe('provider_call_failed')
    expect(providerError.retryable).toBe(false)
    const surface = `${providerError.message} ${providerError.code} ${providerError.name}`
    expect(surface).not.toContain(marker)
    expect(surface).not.toContain(APPROVED_TEXT)
    expect(surface).not.toContain(CONFIG.apiKey)
  })

  it('treats empty bytes and non-WAV bytes as failed synthesis, never as artifacts', async () => {
    const empty = createNaijalingoTtsProvider(CONFIG, {
      async createSpeech() {
        return new Uint8Array(0)
      },
    })
    expect(
      ((await thrownBy(() => empty.submitSpeech(request()))) as TtsProviderError)
        .code,
    ).toBe('artifact_empty')

    const garbage = createNaijalingoTtsProvider(CONFIG, {
      async createSpeech() {
        return new TextEncoder().encode('<html>502 Bad Gateway</html>')
      },
    })
    expect(
      (
        (await thrownBy(() =>
          garbage.submitSpeech(request()),
        )) as TtsProviderError
      ).code,
    ).toBe('artifact_wav_invalid')
  })

  it('cannot be polled — synthesis is synchronous and no operation id ever exists', async () => {
    const provider = createNaijalingoTtsProvider(
      CONFIG,
      fakeClient(buildWav({ dataBytes: 3_200 })),
    )
    const error = await thrownBy(() => provider.pollSpeech('op-imaginary'))
    expect((error as TtsProviderError).code).toBe(
      'synchronous_provider_not_pollable',
    )
    expect((error as TtsProviderError).retryable).toBe(false)
  })

  it('refuses to construct at all from an incomplete configuration', () => {
    // BOTH voices are required. A deployment holding only the male
    // voice would serve two Houses and discover the other two at
    // somebody's paid render, so a half-configuration is refused at
    // construction rather than at the first Ọ̀ṣun prayer.
    const gaps: Array<NaijalingoTtsConfig> = [
      { ...CONFIG, apiKey: '' },
      { ...CONFIG, baseUrl: '   ' },
      { ...CONFIG, model: '' },
      { ...CONFIG, maleVoiceId: '' },
      { ...CONFIG, femaleVoiceId: '' },
    ]
    for (const gap of gaps) {
      let thrown: unknown
      try {
        createNaijalingoTtsProvider(gap, fakeClient(new Uint8Array(1)))
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(TtsProviderError)
      expect((thrown as TtsProviderError).code).toBe(
        'naijalingo_config_incomplete',
      )
      // Names only — the message may say WHICH variable, never a value.
      expect((thrown as TtsProviderError).message).not.toContain(CONFIG.apiKey)
    }
  })
})

describe('9jaLingo adapter: transport limits', () => {
  it('never lets the HTTP client retry a paid synthesis', () => {
    // The openai client defaults to 2 transport retries; a retried
    // synthesis is a second spend the at-most-once executor never
    // authorized.
    expect(NAIJALINGO_CLIENT_LIMITS.maxRetries).toBe(0)
  })

  it('times out well inside the reservation staleness threshold', () => {
    // A call still in flight when its reservation is judged stale would
    // race its own quarantine (canon §10.13).
    expect(NAIJALINGO_CLIENT_LIMITS.timeoutMs).toBeLessThan(
      RESERVATION_STALE_AFTER_MS,
    )
    expect(NAIJALINGO_CLIENT_LIMITS.timeoutMs).toBeGreaterThan(0)
  })

  it('is the provider the registry knows by its driver name', () => {
    const provider = createNaijalingoTtsProvider(
      CONFIG,
      fakeClient(new Uint8Array(1)),
    )
    expect(provider.code).toBe(NAIJALINGO_TTS_CODE)
    expect(NAIJALINGO_TTS_CODE).toBe('9JALINGO')
    expect(provider.isEnabled()).toBe(true)
  })
})

describe('the WAV duration reader', () => {
  it('measures duration from byte rate and data size exactly', () => {
    // byteRate 32000; 16000 data bytes → 500 ms.
    expect(parseWavDurationMs(buildWav({ dataBytes: 16_000 }))).toBe(500)
    // 8000 Hz mono 8-bit → byteRate 8000; 8000 bytes → 1000 ms.
    expect(
      parseWavDurationMs(
        buildWav({ sampleRate: 8_000, bitsPerSample: 8, dataBytes: 8_000 }),
      ),
    ).toBe(1_000)
  })

  it('REJECTS a truncated stream outright — a partial prayer is never shortened into a "valid" one', () => {
    // The data chunk DECLARES 32,000 bytes; only half arrived. The old
    // behavior clamped to what arrived and produced a shorter, wrong
    // duration — for approved prayer audio that is unacceptable, so
    // truncation now fails CLOSED.
    const wav = buildWav({ dataBytes: 32_000 }) // declares 1000 ms
    const truncated = wav.subarray(0, 44 + 16_000) // half the data arrived
    expect(parseWavDurationMs(truncated)).toBeNull()
    // A stream cut mid-chunk-header is the same truncation.
    const midHeader = wav.subarray(0, 41)
    expect(parseWavDurationMs(midHeader)).toBeNull()
  })

  it('REJECTS a chunk whose declared size exceeds the buffer, before any offset advances', () => {
    // A hostile or corrupt header claiming a near-4GB data chunk must
    // be refused at the bounds check — never used to size a duration
    // and never allowed to walk the cursor.
    const oversized = buildWav({ dataBytes: 16_000 })
    new DataView(oversized.buffer).setUint32(40, 0xfffffff0, true)
    expect(parseWavDurationMs(oversized)).toBeNull()
    // Same rule applied to a non-data chunk: an fmt chunk that cannot
    // fit is an incoherent stream, not something to skip past.
    const badFmt = buildWav({ dataBytes: 16_000 })
    new DataView(badFmt.buffer).setUint32(16, 0x7fffffff, true)
    expect(parseWavDurationMs(badFmt)).toBeNull()
  })

  it('still ACCEPTS a complete, coherent WAV exactly', () => {
    // The control for the two refusals above: completeness is the only
    // thing being demanded, not some stricter dialect of WAV.
    expect(parseWavDurationMs(buildWav({ dataBytes: 32_000 }))).toBe(1_000)
  })

  it('returns null for anything that is not a coherent WAV', () => {
    expect(parseWavDurationMs(new Uint8Array(0))).toBeNull()
    expect(parseWavDurationMs(new TextEncoder().encode('not audio'))).toBeNull()
    // Right magic, no chunks.
    const bare = buildWav({ dataBytes: 16 }).subarray(0, 12)
    expect(parseWavDurationMs(new Uint8Array(bare))).toBeNull()
    // Zero byte rate must never divide.
    const zeroRate = buildWav({ dataBytes: 16 })
    new DataView(zeroRate.buffer).setUint32(28, 0, true)
    expect(parseWavDurationMs(zeroRate)).toBeNull()
  })
})

describe('the production transport stays on the documented surface', () => {
  it('uses only documented client API — no internal or undocumented request flags', async () => {
    const source = await Bun.file('src/providers/tts/naijalingo.ts').text()
    // Assembled from fragments so this file's own prose cannot trip it.
    const undocumentedFlag = '__binary' + 'Response'
    expect(source).not.toContain(undocumentedFlag)
    // The documented pair that replaces it.
    expect(source).toContain(".post('/audio/speech', { body })")
    expect(source).toContain('.asResponse()')
  })

  it('pins the openai dependency EXACTLY — a paid transport must not shift under a semver range', async () => {
    const pkg = JSON.parse(await Bun.file('package.json').text()) as {
      dependencies: Record<string, string>
    }
    const pinned = pkg.dependencies.openai
    // An exact version: digits and dots only — no ^, ~, x, ranges.
    expect(pinned).toBe('7.4.0')
    expect(/^\d+\.\d+\.\d+$/.test(pinned)).toBe(true)
  })
})

describe('structurally incapable of cloning', () => {
  it('has no field anywhere in the TTS contract or adapter for a voice sample or likeness', async () => {
    // The no-cloning rule is enforced by SHAPE: nothing exists to pass.
    // The runtime teeth are the exact-allowlist assertion above; this
    // pins the source so a field cannot quietly grow back. Comments are
    // stripped first — the CODE must be clean; the documentation is
    // allowed (required, even) to talk about what is forbidden.
    for (const file of [
      'src/providers/tts/types.ts',
      'src/providers/tts/naijalingo.ts',
    ]) {
      const source = await Bun.file(file).text()
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .toLowerCase()
      for (const forbidden of [
        'referenceaudio',
        'reference_audio',
        'speakersample',
        'speaker_sample',
        'voicesample',
        'voice_sample',
        'clonevoice',
        'voice_clone',
        'likeness',
      ]) {
        expect(code).not.toContain(forbidden)
      }
    }
  })

  it('never sends the planned duration as a synthesis instruction', async () => {
    const source = await Bun.file('src/providers/tts/naijalingo.ts').text()
    // The request body type is the allowlist; targetDurationMs must not
    // appear in any client-bound construction.
    const bodySection = source.slice(
      source.indexOf('interface NaijalingoSpeechRequestBody'),
      source.indexOf('export interface NaijalingoSpeechClient'),
    )
    expect(bodySection).toContain('model: string')
    expect(bodySection).not.toContain('targetDurationMs')
    expect(bodySection).not.toContain('duration')
  })
})

describe('9jaLingo adapter: one profile, one voice, no borrowing', () => {
  it('sends the MALE catalogue id for the male profile and the FEMALE id for the female one', async () => {
    const wav = buildWav({ dataBytes: 32_000 })
    for (const [profile, expected] of [
      ['YO_MALE', CONFIG.maleVoiceId],
      ['YO_FEMALE', CONFIG.femaleVoiceId],
    ] as const) {
      const client = fakeClient(wav)
      const provider = createNaijalingoTtsProvider(CONFIG, client)
      await provider.submitSpeech(request({ voiceProfile: profile }))
      expect(client.calls).toHaveLength(1)
      expect(client.calls[0].voice).toBe(expected)
    }
  })

  it('never resolves one profile to the other profile’s voice', async () => {
    // The failure that would matter is not an error — it is Abúlé Ọ̀ṣun
    // spoken by a man because the male id was the one lying around.
    const client = fakeClient(buildWav({ dataBytes: 32_000 }))
    const provider = createNaijalingoTtsProvider(CONFIG, client)
    await provider.submitSpeech(request({ voiceProfile: 'YO_FEMALE' }))
    expect(client.calls[0].voice).not.toBe(CONFIG.maleVoiceId)
  })

  it('refuses a profile this deployment has no voice for — with ZERO client calls', async () => {
    // Reaching the vendor to be told "unknown voice" would be a paid
    // call whose outcome is UNKNOWN. The refusal happens first.
    const half: NaijalingoTtsConfig = { ...CONFIG, femaleVoiceId: '   ' }
    const client = fakeClient(buildWav({ dataBytes: 32_000 }))
    // Construction itself already refuses a half-configuration, which
    // is the earliest possible moment; this pins that the resolver
    // would refuse too, rather than silently substituting.
    let thrown: unknown
    try {
      createNaijalingoTtsProvider(half, client)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TtsProviderError)
    expect((thrown as TtsProviderError).code).toBe('naijalingo_config_incomplete')
    expect((thrown as TtsProviderError).retryable).toBe(false)
    expect((thrown as TtsProviderError).message).toContain(
      'NAIJALINGO_YO_FEMALE_VOICE_ID',
    )
    expect(client.calls).toHaveLength(0)
  })

  it('names the missing variable and never a value', async () => {
    let thrown: unknown
    try {
      createNaijalingoTtsProvider(
        { ...CONFIG, maleVoiceId: '' },
        fakeClient(new Uint8Array(1)),
      )
    } catch (error) {
      thrown = error
    }
    const message = (thrown as TtsProviderError).message
    expect(message).toContain('NAIJALINGO_YO_MALE_VOICE_ID')
    expect(message).not.toContain(CONFIG.femaleVoiceId)
    expect(message).not.toContain(CONFIG.apiKey)
  })
})
