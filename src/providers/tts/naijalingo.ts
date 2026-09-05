import OpenAI from 'openai'
import { env } from '@/lib/env'
import { TtsProviderError } from './types'
import type {
  SpeechArtifact,
  SpeechSynthesisRequest,
  SpeechSynthesisSubmission,
  TtsProvider,
  YorubaVoiceProfile,
} from './types'

/**
 * 9jaLingo speech synthesis adapter (Phase One, Step 20) — the FIRST
 * approved real TTS vendor, and Yoruba-only by deliberate policy.
 *
 * THE API: an OpenAI-compatible `POST /v1/audio/speech` that
 * synthesizes in the request itself and answers with RAW AUDIO BYTES
 * (WAV by default). Parameters are the OpenAI TTS set (`model`,
 * `voice`, `input`, `response_format`) plus 9jaLingo's `lang`
 * extension (`yo` for Yoruba). 9jaLingo also ships its own SDKs
 * (Python and Node, `npm install naijalingo`); this adapter
 * DELIBERATELY uses the OpenAI-compatible surface instead, through the
 * official `openai` client — pinned EXACTLY (see package.json), since
 * a paid transport must not shift under a range.
 *
 * COMPATIBLE IN ROUTE AND SHAPE, NOT IN AUTH. That distinction was
 * verified against the live endpoint rather than assumed, after the
 * first real synthesis attempt was refused 401: the vendor
 * authenticates synthesis on `x-api-key`, and ignores the
 * `Authorization: Bearer` header the client sends of its own accord.
 * Transport, TLS and timeouts remain entirely the client's documented
 * job; the one header is supplied through its documented
 * `defaultHeaders`, never through an HTTP layer of ours.
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
 * - the voice is the operator-configured, server-env-only id for the
 *   request's approved PROFILE — NAIJALINGO_YO_MALE_VOICE_ID or
 *   NAIJALINGO_YO_FEMALE_VOICE_ID. The profile itself was decided from
 *   the approved content's own Sacred House, so there is no path from
 *   a request, a row or a user to the voice choice, and no
 *   reference-audio field exists anywhere in the TtsProvider contract
 *   to clone from.
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

/** The header 9jaLingo authenticates synthesis on. Not Bearer — see
 * createOpenAiCompatibleSpeechClient. */
export const NAIJALINGO_AUTH_HEADER = 'x-api-key'

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
  /** Provider catalogue ids, one per approved production profile. This
   * is the ONLY place in the system that knows them. */
  maleVoiceId: string
  femaleVoiceId: string
}

function configFromEnv(): NaijalingoTtsConfig {
  return {
    apiKey: env.NAIJALINGO_API_KEY,
    baseUrl: env.NAIJALINGO_API_BASE_URL,
    model: env.NAIJALINGO_MODEL,
    maleVoiceId: env.NAIJALINGO_YO_MALE_VOICE_ID,
    femaleVoiceId: env.NAIJALINGO_YO_FEMALE_VOICE_ID,
  }
}

/**
 * Profile to catalogue id. Fails CLOSED and BEFORE the network: an
 * unconfigured profile is a configuration fault, and discovering it
 * mid-call would mean a spend whose outcome is unknown.
 *
 * There is no default arm. A profile with no configured voice must stop
 * the synthesis, never borrow the other one.
 */
function resolveVoiceId(
  config: NaijalingoTtsConfig,
  profile: YorubaVoiceProfile,
): string {
  const id = profile === 'YO_MALE' ? config.maleVoiceId : config.femaleVoiceId
  if (id.trim().length === 0) {
    throw new TtsProviderError(
      'voice_profile_unconfigured',
      `No voice is configured for ${profile}.`,
      false,
    )
  }
  return id
}

/**
 * Production transport: the official `openai` client pointed at the
 * operator-configured 9jaLingo base URL. The client owns TLS, timeout
 * and request plumbing; `.asResponse()` hands back the raw HTTP
 * response so the WAV bytes are read directly, never JSON-parsed.
 *
 * AUTH IS `x-api-key`, NOT BEARER — established against the live
 * endpoint, not assumed. `POST /v1/audio/speech` answers 401 with
 * `{"detail":"Missing API Key"}` to an Authorization: Bearer header
 * carrying a key the same deployment uses successfully elsewhere, and
 * answers a normal validation 422 to the identical request bearing
 * `x-api-key`. So the vendor's synthesis surface is OpenAI-compatible
 * in ROUTE and in REQUEST SHAPE, but not in authentication.
 *
 * This is still the client's documented public surface —
 * `defaultHeaders` — rather than hand-rolled auth: no signing, no
 * header assembly, no TLS handling of our own. The client's own
 * Authorization header rides along and the vendor ignores it.
 *
 * The request SHAPE needed no change, which is worth recording because
 * it was checked rather than hoped: the endpoint's required field is
 * `text`, and it accepts `input` as an alias for it (a request sending
 * only `input` draws a type error on both, never "text is missing").
 * `voice` is a real schema field, mirrored server-side into `voice_id`
 * and `speaker` — so a per-House voice is genuinely honoured and not
 * silently dropped. `lang` mirrors into `language`/`language_code`.
 * `response_format` is an enum of wav, mp3, pcm, flac, opus, aac.
 */
function createOpenAiCompatibleSpeechClient(
  config: NaijalingoTtsConfig,
): NaijalingoSpeechClient {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    maxRetries: NAIJALINGO_CLIENT_LIMITS.maxRetries,
    timeout: NAIJALINGO_CLIENT_LIMITS.timeoutMs,
    // The header the vendor actually authenticates on. Without it the
    // synthesis is refused 401 before any work — which is how this was
    // found, and is at least a safe way to fail.
    defaultHeaders: { [NAIJALINGO_AUTH_HEADER]: config.apiKey },
  })
  return {
    async createSpeech(body: NaijalingoSpeechRequestBody): Promise<Uint8Array> {
      // Both halves of this call are the client's DOCUMENTED public
      // surface, and nothing else is used: generic `client.post` for an
      // OpenAI-compatible endpoint carrying a vendor extension (`lang`)
      // the upstream types do not know about, and `.asResponse()` for
      // the raw, unconsumed HTTP response — which is already the WAV
      // bytes, so no undocumented flag is needed to skip JSON parsing.
      const response = await client.post('/audio/speech', { body }).asResponse()
      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

/**
 * WHAT WENT WRONG, said in the only vocabulary that is safe to say.
 *
 * The raw transport error must never leave this file: it can echo the
 * request body — and the request body is the approved sacred text —
 * along with headers and credentials-adjacent detail. But "the call
 * failed" alone is not operable either. An operator staring at a
 * rejected synthesis cannot tell a wrong API key from a wrong voice id
 * from an unreachable host, and neither could this checkpoint.
 *
 * So exactly one machine-safe fact is carried out: the HTTP status the
 * vendor answered with, or the fact that no status was ever reached.
 * A status is a number. It cannot contain a prayer.
 *
 * TWO CLASSES, BECAUSE THEY NEED DIFFERENT HUMAN ANSWERS.
 *
 * - 5xx is PROVIDER UNAVAILABLE: the vendor accepted the request and
 *   then failed to serve it. Nothing about this deployment is wrong,
 *   and it may well succeed later — but "later" is an operator's
 *   decision, taken with the billing question settled, never an
 *   automatic one.
 * - 4xx is REJECTED: the vendor understood the request and declined
 *   it. That is a configuration or credential fault, and it will keep
 *   failing identically until a person changes something.
 *
 * BOTH STAY `retryable: false`. That flag is machine-readable, and
 * "an operator may decide to retry" is not a thing a machine may act
 * on: a retried synthesis is a second paid spend. Nothing in the audio
 * path reads this flag today, but a future caller that did must not be
 * able to find permission here for an automatic second charge. The
 * distinction lives in the CODE, which humans read, not in the flag,
 * which programs obey.
 *
 * None of this changes the SPEND verdict either. A 4xx looks like a
 * request refused before any work was done, but "looks like" is not
 * evidence, and inferring NOT_SENT from a status code is precisely the
 * kind of guess that turns into a double charge. Every failure here
 * remains an UNKNOWN outcome for the executor to quarantine.
 */

/** 5xx: accepted, then not served. An operator may retry; no machine
 * may. */
export const PROVIDER_UNAVAILABLE_PREFIX = 'provider_unavailable_http_'

/** 4xx: understood and declined. Will fail identically until a person
 * changes the configuration or the credential. */
export const PROVIDER_REJECTED_PREFIX = 'provider_rejected_http_'

function transportFailureCode(error: unknown): string {
  if (error instanceof OpenAI.APIError && typeof error.status === 'number') {
    const status = error.status
    if (status >= 500) return `${PROVIDER_UNAVAILABLE_PREFIX}${status}`
    if (status >= 400) return `${PROVIDER_REJECTED_PREFIX}${status}`
    return `provider_call_failed_http_${status}`
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return 'provider_call_timeout'
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return 'provider_unreachable'
  }
  return 'provider_call_failed'
}

/**
 * Strict RIFF/WAVE duration reader: data-chunk bytes over the fmt
 * chunk's byte rate. Returns null for anything that is not a coherent,
 * COMPLETE WAV stream — the caller treats null as a failed synthesis,
 * never guesses. Duration is MEASURED from the returned media (the
 * Step 20 "real media timing" rule); it is never requested of, or
 * reported by, the provider.
 *
 * TRUNCATION FAILS CLOSED. Every chunk's DECLARED size must fully fit
 * inside the bytes that actually arrived — a data chunk announcing
 * 100,000 bytes of prayer audio of which only 40,000 came back is a
 * partial download, and a partial download must be rejected outright,
 * never shortened into a smaller "valid" prayer. Bounds are proven
 * BEFORE any offset advances, so a hostile chunk size can neither
 * truncate silently nor walk the cursor out of the buffer.
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
    // THE INTEGRITY GATE: the declared chunk must fit, completely, in
    // what arrived. Checked before the chunk is interpreted and before
    // the cursor moves — a declared size beyond the buffer is either a
    // truncated download or a malformed header, and both are refusals.
    if (chunkSize > bytes.length - body) return null
    if (chunkId === 'fmt ') {
      // One fmt chunk, at least the 16-byte PCM layout, byte rate at
      // fmt+8. Anything else is not a WAV this pipeline should trust.
      if (byteRate != null) return null
      if (chunkSize < 16) return null
      byteRate = view.getUint32(body + 8, true)
    } else if (chunkId === 'data') {
      // Exactly one data chunk, taken at its DECLARED size — which the
      // gate above has already proven is fully present.
      if (dataBytes != null) return null
      dataBytes = chunkSize
    }
    // RIFF chunks are word-aligned; odd sizes carry a pad byte.
    offset = body + chunkSize + (chunkSize % 2)
  }
  // Leftover bytes too short to be a chunk header mean the stream was
  // cut mid-header: also a truncation, also refused. (A single missing
  // final pad byte can leave offset one past the end; that is the only
  // overshoot the alignment rule itself can produce.)
  if (offset < bytes.length) return null
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
  // BOTH profiles are required. A deployment configured with only one
  // voice can serve only half its Houses, and would discover which half
  // at somebody's paid render.
  if (config.maleVoiceId.trim() === '') {
    missing.push('NAIJALINGO_YO_MALE_VOICE_ID')
  }
  if (config.femaleVoiceId.trim() === '') {
    missing.push('NAIJALINGO_YO_FEMALE_VOICE_ID')
  }
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
          // Resolved from the approved profile, not from anything the
          // caller supplied.
          voice: resolveVoiceId(config, request.voiceProfile),
          // The approved text VERBATIM — sent exactly once, never
          // rewritten, translated, shortened or padded.
          input: request.approvedText,
          lang: NAIJALINGO_LANGUAGE,
          response_format: NAIJALINGO_RESPONSE_FORMAT,
        })
      } catch (caught) {
        // The raw error is deliberately dropped; only a bounded status
        // classification survives (see transportFailureCode). The call
        // was in flight, so the spend outcome is unknown — the
        // executor quarantines.
        throw new TtsProviderError(
          transportFailureCode(caught),
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
