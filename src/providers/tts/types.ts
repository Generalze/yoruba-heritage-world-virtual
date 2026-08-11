/**
 * Approved speech-synthesis (TTS) provider abstraction (canon §23;
 * Phase One, Step 15).
 *
 * Provider-specific code lives ONLY in this directory. The Step 15
 * executor service (`src/services/audio-generation.ts`) talks to the
 * TtsProvider interface only — never to ElevenLabs/any paid speech API
 * directly, and never through provider conditionals scattered across
 * the codebase. Only a deterministic MockTtsProvider exists at this
 * stage; a real provider adapter is future work and must implement this
 * exact interface.
 *
 * A SpeechSynthesisRequest is a PURELY IN-MEMORY compiled object. It is
 * built fresh for every submission from CURRENT authority, is never
 * persisted (raw), and is never logged — see
 * `src/services/audio-generation.ts` for the compilation/governance
 * rules that produce one.
 *
 * NO VOICE OR LIKENESS CLONING. There is deliberately no field on this
 * interface for a speaker sample, a reference recording, a voice id
 * derived from a real person, or any other likeness input: a provider
 * adapter has nothing to clone FROM, so "no voice cloning" is enforced
 * by the shape of the contract rather than by discipline. The only
 * voice-related input is the AUTHORITATIVE policy code, and synthesis
 * is permitted only under APPROVED_TTS_ALLOWED.
 */

export interface SpeechSynthesisRequest {
  /** Deterministic — reused verbatim from the Step 15 task row, itself
   * sha256(generationJobId|manifestSha256|requirementId). Same
   * requirement + same manifest authority ⇒ same key, always; no
   * randomness, no clock. */
  idempotencyKey: string
  requirementId: string
  sceneId: string
  /** The exact approved sacred body, retrieved server-side after a
   * fresh eligibility + hash-currency + policy validation. Spoken
   * EXACTLY as approved — never rewritten, translated, summarized or
   * extended (canon §10.1/§10.4). Held in memory for this one
   * submission and never persisted or logged. */
  approvedText: string
  /** Language of the approved body — never a translation target. */
  language: string
  /** AUTHORITATIVE voice policy at submission time. Always
   * 'APPROVED_TTS_ALLOWED' — any other value never reaches a provider. */
  voicePolicy: string
  /** The planned segment window this speech belongs to. Advisory
   * timing metadata only; a provider never pads or truncates approved
   * text to fit it. */
  targetDurationMs: number
}

export type SpeechSynthesisJobStatus = 'PENDING' | 'COMPLETED' | 'FAILED'

export interface SpeechSynthesisSubmission {
  providerJobId: string
  status: SpeechSynthesisJobStatus
}

/** Raw provider artifact bytes — verified by the executor service
 * (mime/type, bounded duration, non-empty, fresh SHA-256) before
 * anything is written to storage. Never persisted or logged as-is. */
export interface SpeechArtifact {
  bytes: Uint8Array
  mimeType: string
  durationMs: number
}

export interface SpeechPollResult {
  status: SpeechSynthesisJobStatus
  artifact: SpeechArtifact | null
  /** Bounded, safe machine code — never a raw provider error string
   * that could echo the request text. */
  failureCode: string | null
}

/**
 * Thrown by adapters for provider-CALL failures (network/transport). A
 * real provider's explicit rejection is NOT retryable; an ambiguous
 * timeout IS — mirrors PaymentProviderError's retryable discipline.
 */
export class TtsProviderError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'TtsProviderError'
    this.code = code
    this.retryable = retryable
  }
}

export interface TtsProvider {
  readonly code: string
  readonly displayName: string
  isEnabled: () => boolean
  /**
   * ONE submission per idempotencyKey.
   *
   * The EXECUTOR now guarantees that, not the adapter: a durable
   * pre-call reservation means this is called at most once per
   * requirement, and an unresolved submission is quarantined rather
   * than repeated. An adapter that is ALSO idempotent is welcome to
   * be, but nothing depends on it — no real speech vendor examined for
   * this platform documents idempotent submission, and a guarantee
   * nobody makes is not a guarantee.
   */
  submitSpeech: (
    request: SpeechSynthesisRequest,
  ) => Promise<SpeechSynthesisSubmission>
  /** Stateless from the CALLER's perspective — real providers hold
   * their own server-side job state keyed by providerJobId. */
  pollSpeech: (providerJobId: string) => Promise<SpeechPollResult>
}
