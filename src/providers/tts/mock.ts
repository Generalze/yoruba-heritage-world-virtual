import { createHash } from 'node:crypto'
import type {
  SpeechArtifact,
  SpeechPollResult,
  SpeechSynthesisRequest,
  SpeechSynthesisSubmission,
  TtsProvider,
} from './types'

/**
 * MockTtsProvider (Phase One, Step 15): the ONLY provider
 * implementation at this stage — deterministic and reproducible so no
 * real ElevenLabs/paid-API call or network egress is ever needed
 * locally or in tests, mirroring the Step 14 mock visual provider and
 * the payments MockProvider discipline.
 *
 * HARD DETERMINISM RULE: same SpeechSynthesisRequest ⇒ byte-identical
 * artifact, every time, on every process. NO Math.random(), NO
 * Date.now() (or any wall-clock read) anywhere in this file — the
 * generation-module guard tests forbid both.
 *
 * THE APPROVED TEXT IS NEVER FOLDED INTO THE ARTIFACT SEED. Bytes are
 * derived ONLY from a SHA-256 expansion of the request's non-sensitive
 * identity fields (idempotencyKey/requirementId/language/
 * targetDurationMs), so the "audio" can never encode — even hashed —
 * recoverable sacred content. The request's approvedText is used for
 * nothing but the length sanity the real provider would consume, and
 * is never stored on the provider job either.
 *
 * submitSpeech() always answers PENDING and records the request's
 * NON-SENSITIVE identity against its deterministic providerJobId
 * (== the idempotencyKey, prefixed). pollSpeech() recomputes the
 * artifact fresh from that identity on every call — polling the SAME
 * providerJobId any number of times yields the SAME bytes — and
 * completes on the very first poll; a real provider's genuine
 * multi-poll latency is out of scope for a deterministic mock.
 *
 * NO VOICE CLONING: there is no speaker sample, reference recording or
 * likeness input in the contract at all (see types.ts), so this mock
 * has nothing to clone and a real adapter would have nothing to pass.
 */

const MOCK_MIME_TYPE = 'audio/mpeg'
/** Small, bounded, fast — real speech is never rendered here. */
const ARTIFACT_BYTE_LENGTH = 2048
const MAGIC_HEADER = 'YHWMOCKTTS1'

/** Everything the mock retains about a submission — deliberately NOT
 * the approved text. A provider job record that cannot echo sacred
 * content is one that cannot leak it. */
interface MockSpeechJob {
  idempotencyKey: string
  requirementId: string
  language: string
  targetDurationMs: number
}

function seedHash(job: MockSpeechJob): Buffer {
  const seed = [
    'mock-tts-v1',
    job.idempotencyKey,
    job.requirementId,
    job.language,
    job.targetDurationMs,
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

function buildDeterministicArtifact(job: MockSpeechJob): SpeechArtifact {
  const seed = seedHash(job)
  const header = new TextEncoder().encode(MAGIC_HEADER)
  const filler = deterministicBytes(seed, ARTIFACT_BYTE_LENGTH - header.length)
  const bytes = new Uint8Array(ARTIFACT_BYTE_LENGTH)
  bytes.set(header, 0)
  bytes.set(filler, header.length)
  return {
    bytes,
    mimeType: MOCK_MIME_TYPE,
    // Exact echo of the planned segment window — the mock never drifts,
    // so the executor's bounded-duration verification is a meaningful,
    // always-satisfiable round-trip proof rather than a tautology.
    durationMs: job.targetDurationMs,
  }
}

function providerJobIdFor(request: SpeechSynthesisRequest): string {
  return `mock-tts-${request.idempotencyKey}`
}

/** Fresh, isolated provider instance — each call gets its own in-memory
 * job registry (no shared module-level state), so tests can create one
 * per case without cross-test bleed. */
export function createMockTtsProvider(): TtsProvider {
  const submitted = new Map<string, MockSpeechJob>()

  return {
    code: 'MOCK_TTS',
    displayName: 'Mock speech synthesis provider (development)',
    // No declared restriction: the mock speaks any GUIDANCE_LANGUAGE the
    // pipeline hands it — determinism, not linguistics, is its contract.
    supportedLanguages: null,

    isEnabled() {
      return true
    },

    async submitSpeech(
      request: SpeechSynthesisRequest,
    ): Promise<SpeechSynthesisSubmission> {
      const providerJobId = providerJobIdFor(request)
      // Idempotent by construction: re-submitting the SAME request
      // (same idempotencyKey) always maps to the SAME providerJobId and
      // simply re-records the identical identity — never a duplicate
      // "synthesis".
      submitted.set(providerJobId, {
        idempotencyKey: request.idempotencyKey,
        requirementId: request.requirementId,
        language: request.language,
        targetDurationMs: request.targetDurationMs,
      })
      return { providerJobId, status: 'PENDING' }
    },

    async pollSpeech(providerJobId: string): Promise<SpeechPollResult> {
      const job = submitted.get(providerJobId)
      if (!job) {
        return {
          status: 'FAILED',
          artifact: null,
          failureCode: 'unknown_provider_job',
        }
      }
      return {
        status: 'COMPLETED',
        artifact: buildDeterministicArtifact(job),
        failureCode: null,
      }
    },
  }
}
