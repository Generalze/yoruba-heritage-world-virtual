/**
 * Visual generation provider abstraction (canon §23; Phase One, Step 14).
 *
 * Provider-specific code lives ONLY in this directory. The Step 14
 * executor service (`src/services/visual-generation.ts`) talks to the
 * VisualGenerationProvider interface only — never to Kling/OpenArt/any
 * paid API directly, and never through provider conditionals scattered
 * across the codebase. Only a deterministic MockVisualGenerationProvider
 * exists at this stage; a real provider adapter is future work and must
 * implement this exact interface.
 *
 * A VisualGenerationRequest is a PURELY IN-MEMORY compiled object. It is
 * built fresh for every submission from CURRENT authority, is never
 * persisted (raw), and is never logged — see
 * `src/services/visual-generation.ts` for the compilation/governance
 * rules that produce one.
 */

/** Ordered Visual Bible rule, resolved to its CURRENT text for one
 * in-memory compilation only — never stored raw (canon §10.3/§10.6). */
export interface VisualGenerationRuleText {
  category: string
  position: number
  ruleText: string
}

export interface VisualGenerationRequest {
  /** Deterministic — reused verbatim from the Step 13 validated
   * manifest's task.idempotencyKey (sha256 over
   * generationJobId|storyboardSha256|sceneId). Same scene + same
   * manifest authority ⇒ same key, always; no randomness, no clock. */
  idempotencyKey: string
  sceneId: string
  taskId: string
  durationMs: number
  contentType: string
  themeCode: string | null
  visualBibleVersionId: number
  visualBibleVersionNumber: number
  visualBibleRules: Array<VisualGenerationRuleText>
  externalAiPolicy: 'METADATA_ONLY' | 'APPROVED_TEXT_CONTEXT'
  /** APPROVED_TEXT_CONTEXT only — the CURRENT approved sacred body,
   * retrieved server-side after eligibility + hash-currency validation.
   * ALWAYS null under METADATA_ONLY, where the body is never even
   * retrieved. Exact approved text only — never rewritten, translated
   * or extended (canon §10.1/§10.4). */
  approvedTextContext: string | null
}

export type VisualGenerationJobStatus = 'PENDING' | 'COMPLETED' | 'FAILED'

export interface VisualGenerationSubmission {
  providerJobId: string
  status: VisualGenerationJobStatus
}

/** Raw provider artifact bytes — verified by the executor service
 * (mime/type, bounded duration, non-empty, fresh SHA-256) before
 * anything is written to storage. Never persisted or logged as-is. */
export interface VisualGenerationArtifact {
  bytes: Uint8Array
  mimeType: string
  durationMs: number
}

export interface VisualGenerationPollResult {
  status: VisualGenerationJobStatus
  artifact: VisualGenerationArtifact | null
  /** Bounded, safe machine code — never a raw provider error string
   * that could echo request content. */
  failureCode: string | null
}

/**
 * Thrown by adapters for provider-CALL failures (network/transport). A
 * real provider's explicit rejection is NOT retryable; an ambiguous
 * timeout IS — mirrors PaymentProviderError's retryable discipline.
 */
export class VisualGenerationProviderError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'VisualGenerationProviderError'
    this.code = code
    this.retryable = retryable
  }
}

export interface VisualGenerationProvider {
  readonly code: string
  readonly displayName: string
  isEnabled: () => boolean
  /** ONE submission per idempotencyKey — a provider MUST treat a
   * repeated submitScene() for the same idempotencyKey as the SAME
   * job, never a duplicate paid execution. */
  submitScene: (
    request: VisualGenerationRequest,
  ) => Promise<VisualGenerationSubmission>
  /** Stateless from the CALLER's perspective — real providers hold
   * their own server-side job state keyed by providerJobId. */
  pollScene: (providerJobId: string) => Promise<VisualGenerationPollResult>
}
