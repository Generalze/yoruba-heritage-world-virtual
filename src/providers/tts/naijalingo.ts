import OpenAI from 'openai'
import { env } from '@/lib/env'
import { TtsProviderError } from './types'
import type {
  SpeechArtifact,
  SpeechSynthesisRequest,
  SpeechSynthesisSubmission,
  TtsProvider,
} from './types'

/**
 * 9jaLingo speech synthesis adapter (Phase One, Step 20) — the FIRST
 * approved real TTS vendor, and Yoruba-only by deliberate policy.
 *
 * THE API, from 9jaLingo's official documentation: an OpenAI-compatible
 * `POST /v1/audio/speech` that synthesizes in the request itself and
 * answers with RAW AUDIO BYTES (WAV by default). Parameters are the
 * OpenAI TTS set (`model`, `voice`, `input`, `response_format`) plus
 * 9jaLingo's `lang` extension (`yo` for Yoruba). Because the endpoint
 * is OpenAI-compatible, transport and authentication come from the
 * official `openai` client (`baseURL` + `apiKey` → `Authorization:
 * Bearer`), never from a hand-rolled HTTP layer: auth is the client's
 * documented job, and guessing at it is how header bugs become silent
 * 401 retries against a paid endpoint.
 *
 * SYNCHRONOUS, HONESTLY. One call, one spend, bytes or an error —
 * there is no provider-side job, so `submitSpeech` answers
 * `COMPLETED` with the artifact and there is deliberately NO invented
 * provider job id, NO fake polling protocol and NO in-memory artifact
 * stash for a poll to fish back out. `pollSpeech` fails closed: an
 * operation id under this provider's code cannot exist, so being asked
 * to poll one means the row is lying.
 *
 * GOVERNANCE, IN THE SHAPE OF THE CODE:
 * - the request body is built from a CLOSED five-field allowlist —
 *   `model`, `voice`, `input`, `lang`, `response_format` — so nothing
 *   else (not `targetDurationMs`, not prosody knobs, not a speaker
 *   sample) can ever reach the vendor. Speech takes as long as the
 *   approved text takes; duration is measured from the returned WAV,
 *   never requested of the synthesis.
 * - `input` is the approved text VERBATIM, exactly once — never
 *   rewritten, translated, shortened or padded.
 * - the voice is the operator-configured, server-env-only
 *   NAIJALINGO_YO_VOICE_ID. There is no path from a request, a row or
 *   a user to the voice choice, and no reference-audio field exists
 *   anywhere in the TtsProvider contract to clone from.
 * - Yoruba (`yo`) only: Phase One approves exactly one language for
 *   this vendor. The executor refuses other languages NOT_SENT before
 *   the body is even read; the guard here is the second lock on that
 *   door and fails closed before any network call.
 *
 * PRIVACY: raw client/provider errors are NEVER rethrown — they can
 * echo the request (and with it the approved sacred text) or transport
 * internals. Every failure leaves this file as a TtsProviderError with
 * a fixed machine code and a fixed message.
 */

export const NAIJALINGO_TTS_CODE = '9JALINGO'

/** The ONE language this adapter is approved to speak in Phase One. */
export const NAIJALINGO_LANGUAGE = 'yo'

const NAIJALINGO_RESPONSE_FORMAT = 'wav'
const NAIJALINGO_MIME_TYPE = 'audio/wav'

/**
 * Transport limits for the real client.
 *
 * - `maxRetries: 0` — the openai client RETRIES failed requests by
 *   default (2×). A transport retry of a synchronous synthesis is a
 *   second paid spend the at-most-once executor never authorized, so
 *   retries are off at the client and recovery decisions stay where
 *   the reservation lifecycle makes them.
 * - `timeoutMs` — MUST stay below the executor's reservation staleness
 *   threshold (RESERVATION_STALE_AFTER_MS, two lease windows; see
 *   generation-jobs.ts): a call still in flight when its reservation
 *   is judged stale would race its own quarantine. Enforced by test.
 */
export const NAIJALINGO_CLIENT_LIMITS = {
  maxRetries: 0,
  timeoutMs: 120_000,
} as const

/**
 * The EXACT request body `POST /v1/audio/speech` receives — a closed
 * allowlist, not a pass-through. Adding a field here is a governance
 * decision, not a convenience.
 */
export interface NaijalingoSpeechRequestBody {
  model: string
  voice: string
  input: string
  lang: typeof NAIJALINGO_LANGUAGE
  response_format: typeof NAIJALINGO_RESPONSE_FORMAT
}

/**
 * The one network seam. Tests inject a fake (ZERO network); production
 * builds one from the official OpenAI-compatible client below.
 */
export interface NaijalingoSpeechClient {
  createSpeech: (body: NaijalingoSpeechRequestBody) => Promise<Uint8Array>
}

export interface NaijalingoTtsConfig {
  apiKey: string
  baseUrl: string
  model: string
  yorubaVoiceId: string
}

function configFromEnv(): NaijalingoTtsConfig {
  return {
    apiKey: env.NAIJALINGO_API_KEY,
    baseUrl: env.NAIJALINGO_API_BASE_URL,
    model: env.NAIJALINGO_MODEL,
    yorubaVoiceId: env.NAIJALINGO_YO_VOICE_ID,
  }
}

/**
 * Production transport: the official `openai` client pointed at the
 * operator-configured 9jaLingo base URL. The client owns auth
 * (Authorization: Bearer <NAIJALINGO_API_KEY>), TLS, and timeout;
 * `.asResponse()` hands back the raw HTTP response so the WAV bytes
 * are read directly, never JSON-parsed.
 */
function createOpenAiCompatibleSpeechClient(
  config: NaijalingoTtsConfig,
): NaijalingoSpeechClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: NAIJALINGO_CLIENT_LIMITS.maxRetries,
    timeout: NAIJALINGO_CLIENT_LIMITS.timeoutMs,
  })
  return {
    async createSpeech(body: NaijalingoSpeechRequestBody): Promise<Uint8Array> {
      // `client.post` is the client's documented surface for an
      // OpenAI-compatible endpoint carrying a vendor extension (`lang`)
      // the upstream types do not know about.
      const response = await client
        .post('/audio/speech', { body, __binaryResponse: true })
        .asResponse()
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

/**
 * Strict RIFF/WAVE duration reader: data-chunk bytes over the fmt
 * chunk's byte rate. Returns null for anything that is not a coherent
 * WAV stream — the caller treats null as a failed synthesis, never
 * guesses. Duration is MEASURED from the returned media (the Step 20
 * "real media timing" rule); it is never requested of, or reported by,
 * the provider.
 */
export function parseWavDurationMs(bytes: Uint8Array): number | null {
  const HEADER_BYTES = 12
  const CHUNK_HEADER_BYTES = 8
  if (bytes.length < HEADER_BYTES + CHUNK_HEADER_BYTES) return null
  const tag = (offset: number): string =>
    String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    )
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = HEADER_BYTES
  let byteRate: number | null = null
  let dataBytes: number | null = null
  while (offset + CHUNK_HEADER_BYTES <= bytes.length) {
    const chunkId = tag(offset)
    const chunkSize = view.getUint32(offset + 4, true)
    const body = offset + CHUNK_HEADER_BYTES
    if (chunkId === 'fmt ') {
      // Byte rate lives at fmt+8 in every PCM/extensible layout.
      if (body + 12 > bytes.length) return null
      byteRate = view.getUint32(body + 8, true)
    } else if (chunkId === 'data') {
      // Honor the declared size, bounded by what actually arrived — a
      // truncated stream must not claim its declared length.
      dataBytes = Math.min(chunkSize, bytes.length - body)
    }
    // RIFF chunks are word-aligned; odd sizes carry a pad byte.
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (byteRate == null || byteRate <= 0) return null
  if (dataBytes == null || dataBytes <= 0) return null
  return Math.round((dataBytes / byteRate) * 1000)
}

function assertCompleteConfig(config: NaijalingoTtsConfig): void {
  // Names only — never values. A half-configured paid client must not
  // exist at all, in any environment.
  const missing: Array<string> = []
  if (config.apiKey.trim() === '') missing.push('NAIJALINGO_API_KEY')
  if (config.baseUrl.trim() === '') missing.push('NAIJALINGO_API_BASE_URL')
  if (config.model.trim() === '') missing.push('NAIJALINGO_MODEL')
  if (config.yorubaVoiceId.trim() === '') missing.push('NAIJALINGO_YO_VOICE_ID')
  if (missing.length > 0) {
    throw new TtsProviderError(
      'naijalingo_config_incomplete',
      `9jaLingo TTS is selected but not fully configured (set ${missing.join(', ')}).`,
      false,
    )
  }
}

export function createNaijalingoTtsProvider(
  configOverride?: NaijalingoTtsConfig,
  clientOverride?: NaijalingoSpeechClient,
): TtsProvider {
  const config = configOverride ?? configFromEnv()
  assertCompleteConfig(config)
  const client = clientOverride ?? createOpenAiCompatibleSpeechClient(config)

  return {
    code: NAIJALINGO_TTS_CODE,
    displayName: '9jaLingo speech synthesis (Yoruba)',
    supportedLanguages: [NAIJALINGO_LANGUAGE],

    isEnabled() {
      return true
    },

    async submitSpeech(
      request: SpeechSynthesisRequest,
    ): Promise<SpeechSynthesisSubmission> {
      // Second lock on the executor's own pre-compile gates. Both fire
      // BEFORE any network contact, so nothing is spent — but unlike
      // the executor's checks these surface as quarantines, which is
      // the correct failure direction for a gate that should have been
      // unreachable.
      if (request.language !== NAIJALINGO_LANGUAGE) {
        throw new TtsProviderError(
          'language_unsupported',
          'The 9jaLingo adapter is approved for Yoruba (yo) only.',
          false,
        )
      }
      if (request.voicePolicy !== 'APPROVED_TTS_ALLOWED') {
        throw new TtsProviderError(
          'voice_policy_forbidden',
          'Synthesis is permitted only under APPROVED_TTS_ALLOWED.',
          false,
        )
      }

      let bytes: Uint8Array
      try {
        bytes = await client.createSpeech({
          model: config.model,
          voice: config.yorubaVoiceId,
          // The approved text VERBATIM — sent exactly once, never
          // rewritten, translated, shortened or padded.
          input: request.approvedText,
          lang: NAIJALINGO_LANGUAGE,
          response_format: NAIJALINGO_RESPONSE_FORMAT,
        })
      } catch {
        // The raw error is deliberately dropped: it can echo the
        // request body (the approved sacred text) or credentials-
        // adjacent transport detail. The call was in flight, so the
        // spend outcome is unknown — the executor quarantines.
        throw new TtsProviderError(
          'provider_call_failed',
          'The 9jaLingo synthesis call failed.',
          false,
        )
      }

      if (bytes.length === 0) {
        throw new TtsProviderError(
          'artifact_empty',
          'The 9jaLingo synthesis returned no audio bytes.',
          false,
        )
      }
      const durationMs = parseWavDurationMs(bytes)
      if (durationMs == null || durationMs <= 0) {
        throw new TtsProviderError(
          'artifact_wav_invalid',
          'The 9jaLingo synthesis did not return a coherent WAV stream.',
          false,
        )
      }
      const artifact: SpeechArtifact = {
        bytes,
        mimeType: NAIJALINGO_MIME_TYPE,
        durationMs,
      }
      return { status: 'COMPLETED', artifact }
    },

    async pollSpeech(): Promise<never> {
      // Nothing this provider ever answered carries an operation id, so
      // there is nothing a poll could truthfully continue.
      throw new TtsProviderError(
        'synchronous_provider_not_pollable',
        '9jaLingo synthesis is synchronous; no provider operation exists to poll.',
        false,
      )
    },
  }
}
