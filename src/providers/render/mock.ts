import { createHash } from 'node:crypto'
import type { RenderEngine, RenderOutput, RenderRequest } from './types'

/**
 * MockRenderEngine (Phase One, Step 16): the ONLY engine implementation
 * at this stage — deterministic and reproducible so no real compositor,
 * network call or paid execution is ever needed locally or in tests.
 *
 * WHY A MOCK IS NECESSARY HERE. The Step 14/15 mock providers emit
 * synthetic artifacts that are deliberately NOT decodable media: they
 * exist to prove governance, integrity and lease discipline without
 * paying a provider. A real compositor handed those bytes would fail on
 * the container, not on anything meaningful. So automated verification
 * renders with this engine, and the REAL compositor boundary
 * (RenderEngine, see types.ts) stays untouched and unweakened.
 *
 * WHY IT CANNOT BE MISTAKEN FOR A DELIVERABLE. Three independent
 * signals, none of which depends on remembering to check:
 *   - `isMock` is true and is PERSISTED on every render result;
 *   - the artifact begins with a literal magic header naming itself a
 *     mock, so even a stray file on disk is self-identifying;
 *   - the environment guard (see registry.ts) refuses a mock engine in
 *     production outright.
 *
 * HARD DETERMINISM RULE: same RenderRequest ⇒ byte-identical output,
 * every time, on every process. NO Math.random(), NO Date.now() (or any
 * wall-clock read) anywhere in this file. The output is a SHA-256
 * expansion over the plan hash and the source hashes only — never over
 * source BYTES, and never over anything that could carry sacred
 * content, so the artifact can never encode (even hashed) recoverable
 * approved text or speech.
 */

const MOCK_MIME_TYPE = 'video/mp4'
/** Small, bounded, fast — a real composition is never encoded here. */
const ARTIFACT_BYTE_LENGTH = 8192
/** Self-identifying: a stray artifact is recognisable without a
 * database lookup. */
const MAGIC_HEADER = 'YHW-MOCK-RENDER-NOT-A-DELIVERABLE-v1'

function seedHash(request: RenderRequest): Buffer {
  // Identity and structure only. Source HASHES (not bytes) make the
  // output change when an input changes, which is what makes the
  // determinism tests meaningful.
  const parts = [
    'mock-render-v1',
    request.renderPlanSha256,
    String(request.totalDurationMs),
    request.outputMimeType,
    ...request.scenes.map(
      (scene) =>
        `${scene.sceneId}:${scene.startMs}:${scene.endMs}:${scene.visualKind}:${scene.visualFit}:${scene.visualRefId ?? ''}`,
    ),
    ...request.audio.map(
      (audio) => `${audio.refId}:${audio.startMs}:${audio.endMs}`,
    ),
    ...request.sources.map(
      (source) => `${source.refId}:${source.role}:${source.sha256}`,
    ),
  ]
  return createHash('sha256').update(parts.join('|'), 'utf8').digest()
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

export function createMockRenderEngine(): RenderEngine {
  return {
    code: 'MOCK_RENDER',
    version: 'mock-1',
    isMock: true,

    isEnabled() {
      return true
    },

    async render(request: RenderRequest): Promise<RenderOutput> {
      const header = new TextEncoder().encode(MAGIC_HEADER)
      const filler = deterministicBytes(
        seedHash(request),
        ARTIFACT_BYTE_LENGTH - header.length,
      )
      const bytes = new Uint8Array(ARTIFACT_BYTE_LENGTH)
      bytes.set(header, 0)
      bytes.set(filler, header.length)
      return {
        bytes,
        mimeType: MOCK_MIME_TYPE,
        // Exact echo of the reconciled timeline — the mock never drifts,
        // so the assembly service's duration verification is a
        // meaningful round-trip proof rather than a tautology.
        durationMs: request.totalDurationMs,
      }
    },
  }
}

/** Exported so tests can prove an artifact is self-identifying without
 * duplicating the literal. */
export const MOCK_RENDER_MAGIC_HEADER = MAGIC_HEADER
