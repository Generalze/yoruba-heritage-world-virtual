import { createHash } from 'node:crypto'
import type {
  VisualGenerationArtifact,
  VisualGenerationPollResult,
  VisualGenerationProvider,
  VisualGenerationRequest,
  VisualGenerationSubmission,
} from './types'

/**
 * MockVisualGenerationProvider (Phase One, Step 14): the development
 * and test provider — deterministic and reproducible so no real
 * Kling/paid-API call or network egress is ever needed locally or in
 * tests, mirroring the payments MockProvider discipline. Production
 * uses the approved Kling adapter (or DISABLED); the mock is refused
 * there outright.
 *
 * HARD DETERMINISM RULE: same VisualGenerationRequest ⇒ byte-identical
 * artifact, every time, on every process. NO Math.random(), NO
 * Date.now() (or any wall-clock read) anywhere in this file — Step 13's
 * generation-module guard test forbids both, and Step 14 preserves the
 * same discipline. Artifact bytes are derived ONLY from a SHA-256
 * expansion of the request's non-sensitive identity fields
 * (idempotencyKey/sceneId/durationMs/contentType/themeCode) — the
 * approved sacred body and Visual Bible rule text are NEVER folded into
 * the seed, so the artifact can never encode (even hashed) recoverable
 * sensitive content.
 *
 * submitScene() always answers PENDING and records the request against
 * its deterministic providerJobId (== the idempotencyKey, prefixed).
 * pollScene() recomputes the artifact fresh from the stored request on
 * every call — polling the SAME providerJobId any number of times
 * yields the SAME bytes — and completes on the very first poll; a real
 * provider's genuine multi-poll latency is out of scope for a
 * deterministic mock.
 */

const MOCK_MIME_TYPE = 'video/mp4'
/** Small, bounded, fast — a real "video" is never rendered here. */
const ARTIFACT_BYTE_LENGTH = 4096
const MAGIC_HEADER = 'YHWMOCKVIS1'

function seedHash(request: VisualGenerationRequest): Buffer {
  const seed = [
    'mock-visual-generation-v1',
    request.idempotencyKey,
    request.sceneId,
    request.durationMs,
    request.contentType,
    request.themeCode ?? '',
  ].join('|')
  return createHash('sha256').update(seed, 'utf8').digest()
}

/** Deterministic byte expansion (SHA-256 counter mode) — no randomness,
 * no external entropy, no wall-clock. */
function deterministicBytes(seed: Buffer, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let offset = 0
  let counter = 0
  while (offset < length) {
    const block = createHash('sha256')
      .update(seed)
      .update(Buffer.from(String(counter), 'utf8'))
      .digest()
    const take = Math.min(block.length, length - offset)
    out.set(block.subarray(0, take), offset)
    offset += take
    counter += 1
  }
  return out
}

function buildDeterministicArtifact(
  request: VisualGenerationRequest,
): VisualGenerationArtifact {
  const seed = seedHash(request)
  const header = new TextEncoder().encode(MAGIC_HEADER)
  const filler = deterministicBytes(seed, ARTIFACT_BYTE_LENGTH - header.length)
  const bytes = new Uint8Array(ARTIFACT_BYTE_LENGTH)
  bytes.set(header, 0)
  bytes.set(filler, header.length)
  return {
    bytes,
    mimeType: MOCK_MIME_TYPE,
    // Exact echo of the requested duration — the mock never drifts, so
    // the executor's bounded-duration verification is a meaningful,
    // always-satisfiable round-trip proof rather than a tautology.
    durationMs: request.durationMs,
  }
}

function providerJobIdFor(request: VisualGenerationRequest): string {
  return `mock-${request.idempotencyKey}`
}

/** Fresh, isolated provider instance — each call gets its own in-memory
 * job registry (no shared module-level state), so tests can create one
 * per case without cross-test bleed. */
export function createMockVisualGenerationProvider(): VisualGenerationProvider {
  const submitted = new Map<string, VisualGenerationRequest>()

  return {
    code: 'MOCK',
    displayName: 'Mock visual generation provider (development)',

    isEnabled() {
      return true
    },

    async submitScene(
      request: VisualGenerationRequest,
    ): Promise<VisualGenerationSubmission> {
      const providerJobId = providerJobIdFor(request)
      // Idempotent by construction: re-submitting the SAME request
      // (same idempotencyKey) always maps to the SAME providerJobId and
      // simply re-records the identical request — never a duplicate
      // "execution".
      submitted.set(providerJobId, request)
      return { providerJobId, status: 'PENDING' }
    },

    async pollScene(providerJobId: string): Promise<VisualGenerationPollResult> {
      const request = submitted.get(providerJobId)
      if (!request) {
        return {
          status: 'FAILED',
          artifact: null,
          failureCode: 'unknown_provider_job',
        }
      }
      return {
        status: 'COMPLETED',
        artifact: buildDeterministicArtifact(request),
        failureCode: null,
      }
    },
  }
}
