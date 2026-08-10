/**
 * Render engine abstraction (canon §23; Phase One, Step 16).
 *
 * Compositor-specific code lives ONLY in this directory. The Step 16
 * assembly service (`src/services/render-assembly.ts`) talks to the
 * RenderEngine interface only — never to Remotion, FFmpeg or any other
 * compositor directly, and never through engine conditionals scattered
 * across the codebase.
 *
 * THE REMOTION BOUNDARY. Remotion remains the canonical REAL compositor
 * for this platform; this interface is the seam it plugs into. A
 * Remotion adapter implements `render()` by driving a Remotion
 * composition over the SAME RenderRequest — the render plan plus
 * already-verified local source files — and returns the encoded bytes.
 * Nothing else about the platform changes when it lands: the plan, the
 * source verification, the persistence, the lease discipline and the
 * final gate are all engine-neutral by construction. Such an adapter
 * MUST be opt-in (selected explicitly, never defaulted), must pin every
 * `@remotion/*` package to one compatible version, and must never be
 * invoked by automated verification. FFmpeg may serve an adapter as
 * helper/probing infrastructure (container inspection, encoding) — it
 * is never spiritual authority and never decides what may be rendered.
 *
 * WHAT AN ENGINE MAY NOT DO. An engine composes exactly what the plan
 * says and nothing else. It never adds subtitles, participant-name
 * overlays, titles, watermarks, music, ambient audio, transitions
 * carrying meaning, or any text at all: every visible or audible
 * element must already have been authorized upstream and named in the
 * plan. "The compositor can display it" is not authority.
 */

/** What ONE plan entry points at, resolved to a verified local object.
 * The bytes are never inlined here — an engine reads them from private
 * storage through the reference, and the SHA-256 is the caller's proof
 * that it read the right thing. */
export interface RenderSourceRef {
  /** Stable identity within the plan (scene id or audio requirement id). */
  refId: string
  role: 'VISUAL' | 'AUDIO'
  storageKey: string
  sha256: string
  mimeType: string
  /** Source media length where known; null for a still image. */
  durationMs: number | null
}

/**
 * A PURELY IN-MEMORY compiled render request. Built fresh from the
 * persisted plan plus freshly verified sources, never persisted raw and
 * never logged. It carries NO sacred body text, no spoken text, no
 * Visual Bible rule text and no provider payloads — the plan is
 * body-free by construction and this request adds nothing to it.
 */
export interface RenderRequest {
  /** Canonical hash of the immutable plan being rendered — an engine
   * may fold it into a deterministic result but must never reinterpret
   * the plan's decisions. */
  renderPlanSha256: string
  /** The plan's reconciled scene timeline, already absolute. */
  scenes: ReadonlyArray<{
    sceneId: string
    startMs: number
    endMs: number
    durationMs: number
    visualKind: 'APPROVED_MEDIA' | 'GENERATED_ARTIFACT' | 'HOLD_PREVIOUS'
    /** Which source ref supplies this scene's picture; for
     * HOLD_PREVIOUS it is the earlier scene's ref, held. */
    visualRefId: string | null
    visualFit: 'EXACT' | 'TRIM' | 'HOLD_LAST_FRAME' | 'STILL_HOLD'
  }>
  /** ONE entry per recipe segment that has audio — never one per visual
   * split. Placed at an absolute offset and played once, unaltered. */
  audio: ReadonlyArray<{
    refId: string
    startMs: number
    endMs: number
    durationMs: number
  }>
  sources: ReadonlyArray<RenderSourceRef>
  totalDurationMs: number
  outputMimeType: string
}

export interface RenderOutput {
  bytes: Uint8Array
  mimeType: string
  durationMs: number
}

/**
 * Thrown by adapters for render-EXECUTION failures. A deterministic
 * refusal (unsupported input, invalid plan) is NOT retryable; a
 * transient resource failure IS — mirrors the provider-error discipline
 * used by payments, visual generation and speech synthesis.
 */
export class RenderEngineError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(code: string, message: string, retryable: boolean) {
    super(message)
    this.name = 'RenderEngineError'
    this.code = code
    this.retryable = retryable
  }
}

export interface RenderEngine {
  readonly code: string
  readonly version: string
  /**
   * TRUE for any engine that does not produce a real, deliverable
   * composition. This is not a hint: it is recorded on the render
   * result forever and is what the production guard refuses on, so a
   * mock output can never be mistaken downstream for something a person
   * could be shown.
   */
  readonly isMock: boolean
  isEnabled: () => boolean
  render: (request: RenderRequest) => Promise<RenderOutput>
}
