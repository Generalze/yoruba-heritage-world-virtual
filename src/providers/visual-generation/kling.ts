import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { env } from '@/lib/env'
import { parseHttpsOriginAllowlist } from '@/lib/security-headers'
import { probeMediaWithFfprobe } from '@/providers/render/media-probe'
import { VisualGenerationProviderError } from './types'
import type {
  VisualGenerationArtifact,
  VisualGenerationPollResult,
  VisualGenerationProvider,
  VisualGenerationRequest,
  VisualGenerationRuleText,
  VisualGenerationSubmission,
} from './types'

/**
 * Kling API 2.0 visual generation adapter (Phase One, Step 20) — the
 * approved production text-to-video vendor, implementing the official
 * Kling API 2.0 contract and NOTHING beyond it.
 *
 * THE OFFICIAL CONTRACT, as implemented here:
 * - Auth: `Authorization: Bearer <KLING_API_KEY>` — the new API-Key
 *   scheme only; the legacy AK/SK JWT flow is deliberately absent.
 * - Create: `POST /text-to-video/kling-3.0` against the operator-
 *   configured base URL (official example
 *   `https://api-singapore.klingai.com`). API 2.0 encodes the model in
 *   the endpoint, so there is NO model_name field to invent.
 * - The request body is a CLOSED allowlist:
 *   `{ prompt, settings: { audio: "off", multi_shot: false, duration },
 *      options: { external_task_id } }`
 *   No callback_url. No resolution or aspect_ratio — the repo contract
 *   fixes neither, so Kling's documented defaults apply rather than
 *   invented configuration. No image, element or voice input of any
 *   kind.
 * - Create response: `code` must be 0; `data.id` is the provider
 *   operation id; `data.status` ∈ submitted|processing|succeeded|
 *   failed. Anything else is malformed and treated as an UNKNOWN
 *   outcome by the executor — never resubmitted.
 * - Query: `GET /tasks?task_ids=<URL-encoded id>`; `code` must be 0 and
 *   the answer must contain EXACTLY the task asked about.
 *
 * VISUALS ONLY, STRUCTURALLY. `settings.audio` is the literal "off" on
 * every request — it is not a parameter of this adapter, it is a
 * constant — and a returned artifact that nevertheless CONTAINS an
 * audio stream is rejected outright. Voice, sound and speech belong to
 * the approved TTS/human-recording pipeline, never to a video vendor.
 *
 * `external_task_id` carries the task's deterministic idempotencyKey —
 * identity and reconciliation help on the provider's side, and NOT a
 * substitute for the executor's durable at-most-once reservation,
 * which remains the only thing that prevents a second paid call.
 *
 * PRIVACY: raw provider errors and response bodies are NEVER rethrown
 * or persisted — they can echo the prompt (and under
 * APPROVED_TEXT_CONTEXT, approved sacred text), the API key, or signed
 * artifact URLs. Every failure leaves this file as a
 * VisualGenerationProviderError with a fixed machine code and a fixed
 * message. Artifact URLs (whose query strings are signing secrets) are
 * never logged and never appear in any error.
 */

export const KLING_VISUAL_CODE = 'KLING'

export const KLING_CREATE_PATH = '/text-to-video/kling-3.0'
export const KLING_QUERY_PATH = '/tasks'

/** Official bound: integer seconds, 3 through 15 inclusive. */
export const KLING_MIN_DURATION_S = 3
export const KLING_MAX_DURATION_S = 15

/** Official bound on the prompt. Approved text is NEVER truncated or
 * rewritten to fit — a compiled prompt that cannot fit is a recorded
 * NOT_SENT refusal instead. */
export const KLING_PROMPT_MAX_CHARS = 3072

/**
 * Transport limits.
 * - `maxRetries: 0` — no HTTP-layer retry ever; a retried create is a
 *   second paid generation the at-most-once executor never authorized.
 *   The production client below performs exactly one fetch per call by
 *   construction.
 * - `timeoutMs` — MUST stay below the executor's reservation staleness
 *   threshold (RESERVATION_STALE_AFTER_MS, two lease windows): a call
 *   still in flight when its reservation is judged stale would race
 *   its own quarantine. Enforced by test.
 */
export const KLING_CLIENT_LIMITS = {
  maxRetries: 0,
  timeoutMs: 120_000,
} as const

/** Bounded artifact download: a 3–15 s scene is tens of megabytes even
 * at generous bitrates; past this bound the download is hostile or
 * broken, never accepted. */
export const KLING_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024

const KLING_ARTIFACT_MIME = 'video/mp4'

/** The EXACT create body — a closed allowlist, not a pass-through.
 * Adding a field here is a governance decision, not a convenience. */
export interface KlingCreateRequestBody {
  prompt: string
  settings: {
    audio: 'off'
    multi_shot: false
    duration: number
  }
  options: {
    external_task_id: string
  }
}

/** The one network seam. Tests inject fakes (ZERO network); production
 * builds the fetch-backed client below. */
export interface KlingHttpClient {
  requestJson: (input: {
    method: 'GET' | 'POST'
    url: string
    headers: Readonly<Record<string, string>>
    body?: string
  }) => Promise<{ status: number; bodyText: string }>
  /** MUST NOT follow redirects; returns whatever status the FIRST
   * response carried. Reads at most maxBytes+1 bytes so the adapter
   * can prove an overflow without buffering an unbounded body. */
  downloadArtifact: (input: {
    url: string
    maxBytes: number
    timeoutMs: number
  }) => Promise<{
    status: number
    contentType: string | null
    bytes: Uint8Array
  }>
}

export interface KlingVisualConfig {
  apiKey: string
  baseUrl: string
  artifactOrigins: ReadonlyArray<string>
}

/** Injectable video measurement — ffprobe in production, a fake in
 * tests. The provider's own duration claims are never consulted. */
export type KlingVideoProbe = (bytes: Uint8Array) => Promise<
  | { ok: true; durationMs: number; hasAudio: boolean; hasVideo: boolean }
  | { ok: false; reasonCode: string }
>

function configFromEnv(): KlingVisualConfig {
  const parsed = parseHttpsOriginAllowlist(env.KLING_ARTIFACT_ORIGINS)
  return {
    apiKey: env.KLING_API_KEY,
    baseUrl: env.KLING_API_BASE_URL,
    artifactOrigins: parsed.ok ? parsed.origins : [],
  }
}

/** Production transport: plain fetch, redirects REFUSED, one attempt
 * per call, bounded read. The adapter deliberately speaks the
 * documented API 2.0 contract directly — bare HTTPS + Bearer,
 * implemented exactly — and makes no claim about SDK availability. */
function createFetchKlingHttpClient(): KlingHttpClient {
  return {
    async requestJson({ method, url, headers, body }) {
      const response = await fetch(url, {
        method,
        headers: { ...headers },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(KLING_CLIENT_LIMITS.timeoutMs),
      })
      return { status: response.status, bodyText: await response.text() }
    },
    async downloadArtifact({ url, maxBytes, timeoutMs }) {
      const response = await fetch(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      })
      const contentType = response.headers.get('content-type')
      const reader = response.body?.getReader()
      if (!reader || response.status !== 200) {
        return { status: response.status, contentType, bytes: new Uint8Array(0) }
      }
      // Bounded accumulation: stop at maxBytes+1 so the caller can SEE
      // the overflow without this process ever buffering past it.
      const chunks: Array<Uint8Array> = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        total += value.length
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined)
          break
        }
      }
      const bytes = new Uint8Array(Math.min(total, maxBytes + 1))
      let offset = 0
      for (const chunk of chunks) {
        const take = Math.min(chunk.length, bytes.length - offset)
        if (take <= 0) break
        bytes.set(chunk.subarray(0, take), offset)
        offset += take
      }
      return { status: response.status, contentType, bytes }
    },
  }
}

/** ffprobe measurement of the EXACT downloaded bytes, via a temp file
 * that never outlives the measurement. */
const probeKlingVideoFromBytes: KlingVideoProbe = async (bytes) => {
  const workDir = await mkdtemp(join(tmpdir(), 'yhw-kling-probe-'))
  try {
    const path = join(workDir, 'artifact.mp4')
    await writeFile(path, bytes)
    const probed = await probeMediaWithFfprobe(path)
    if (!probed.ok) return { ok: false, reasonCode: probed.reasonCode }
    return {
      ok: true,
      durationMs: probed.media.durationMs,
      hasAudio: probed.media.hasAudio,
      hasVideo: probed.media.hasVideo,
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// --- Deterministic prompt compilation ----------------------------------------

/** Fixed glue text — named constants so tests can pin that the prompt
 * contains ONLY approved rules, safe metadata, this glue, and (under
 * APPROVED_TEXT_CONTEXT) the exact authorized body. Nothing here names
 * ritual, doctrine, clothing, objects, actions or prayer content. */
export const KLING_PROMPT_RULES_HEADER =
  'Approved visual style rules. Follow every rule exactly; add nothing that the rules and scene line below do not name:'
export const KLING_PROMPT_TEXT_HEADER =
  'Authorized text context (exact, verbatim, for context only):'

function orderedRules(
  rules: ReadonlyArray<VisualGenerationRuleText>,
): ReadonlyArray<VisualGenerationRuleText> {
  return [...rules].sort((a, b) =>
    a.category === b.category
      ? a.position - b.position
      : a.category < b.category
        ? -1
        : 1,
  )
}

export type CompiledKlingPrompt =
  | { ok: true; prompt: string }
  | { ok: false; reasonCode: string }

/**
 * Builds the ONE deterministic prompt a request may send: the approved
 * Visual Bible rules in a stable order, one safe metadata line
 * (content type + theme code — never a person, never contact detail,
 * never private notes, none of which even reach this layer), and —
 * ONLY under APPROVED_TEXT_CONTEXT — the exact authorized body,
 * verbatim. Under METADATA_ONLY the body was never retrieved and can
 * never appear; a request that claims otherwise is refused outright.
 * A prompt that cannot fit the official 3072-char bound is refused,
 * never truncated: shortening approved text to please a vendor is the
 * exact rewrite canon §10.1/§10.4 forbids.
 */
export function compileKlingPrompt(
  request: VisualGenerationRequest,
): CompiledKlingPrompt {
  if (
    request.externalAiPolicy === 'METADATA_ONLY' &&
    request.approvedTextContext != null
  ) {
    return { ok: false, reasonCode: 'policy_context_mismatch' }
  }
  if (
    request.externalAiPolicy === 'APPROVED_TEXT_CONTEXT' &&
    request.approvedTextContext == null
  ) {
    return { ok: false, reasonCode: 'approved_text_missing' }
  }
  const lines: Array<string> = []
  lines.push(KLING_PROMPT_RULES_HEADER)
  for (const rule of orderedRules(request.visualBibleRules)) {
    lines.push(`- [${rule.category}] ${rule.ruleText}`)
  }
  lines.push(
    `Scene: content type ${request.contentType}${
      request.themeCode == null ? '' : `, theme code ${request.themeCode}`
    }.`,
  )
  if (request.approvedTextContext != null) {
    lines.push(KLING_PROMPT_TEXT_HEADER)
    lines.push(request.approvedTextContext)
  }
  const prompt = lines.join('\n')
  if (prompt.length > KLING_PROMPT_MAX_CHARS) {
    return { ok: false, reasonCode: 'prompt_too_long' }
  }
  return { ok: true, prompt }
}

/** Whole seconds 3..15, or null. NEVER rounds: a scene that is not an
 * exact whole second inside the official range is unsupportable, and
 * silently rounding would generate a video for a different scene. */
export function klingDurationSeconds(durationMs: number): number | null {
  if (!Number.isInteger(durationMs) || durationMs % 1000 !== 0) return null
  const seconds = durationMs / 1000
  if (seconds < KLING_MIN_DURATION_S || seconds > KLING_MAX_DURATION_S) {
    return null
  }
  return seconds
}

// --- Response parsing (strict, secret-free) ----------------------------------

const KLING_TASK_STATUSES = [
  'submitted',
  'processing',
  'succeeded',
  'failed',
] as const
type KlingTaskStatus = (typeof KLING_TASK_STATUSES)[number]

function malformed(): never {
  // ONE fixed shape for every parse refusal: no status codes, no body
  // fragments, no field paths — a response echo is a leak vector.
  throw new VisualGenerationProviderError(
    'provider_response_malformed',
    'The Kling response did not match the documented contract.',
    false,
  )
}

function parseJsonEnvelope(response: {
  status: number
  bodyText: string
}): Record<string, unknown> {
  if (response.status !== 200) malformed()
  let parsed: unknown
  try {
    parsed = JSON.parse(response.bodyText)
  } catch {
    malformed()
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    malformed()
  }
  const envelope = parsed as Record<string, unknown>
  if (envelope.code !== 0) malformed()
  return envelope
}

function isKlingTaskStatus(value: unknown): value is KlingTaskStatus {
  return (
    typeof value === 'string' &&
    (KLING_TASK_STATUSES as ReadonlyArray<string>).includes(value)
  )
}

interface ParsedKlingTask {
  id: string
  status: KlingTaskStatus
  outputs: ReadonlyArray<Record<string, unknown>>
}

function parseTaskObject(value: unknown): ParsedKlingTask {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    malformed()
  }
  const task = value as Record<string, unknown>
  if (typeof task.id !== 'string' || task.id.trim() === '') malformed()
  if (!isKlingTaskStatus(task.status)) malformed()
  const rawOutputs = task.outputs
  const outputs: Array<Record<string, unknown>> = []
  if (rawOutputs != null) {
    if (!Array.isArray(rawOutputs)) malformed()
    for (const entry of rawOutputs) {
      if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
        malformed()
      }
      outputs.push(entry as Record<string, unknown>)
    }
  }
  return { id: task.id, status: task.status, outputs }
}

// --- The adapter --------------------------------------------------------------

function assertCompleteConfig(config: KlingVisualConfig): void {
  // Names only — never values.
  const missing: Array<string> = []
  if (config.apiKey.trim() === '') missing.push('KLING_API_KEY')
  if (config.baseUrl.trim() === '') missing.push('KLING_API_BASE_URL')
  if (config.artifactOrigins.length === 0) missing.push('KLING_ARTIFACT_ORIGINS')
  if (missing.length > 0) {
    throw new VisualGenerationProviderError(
      'kling_config_incomplete',
      `Kling visual generation is selected but not fully configured (set ${missing.join(', ')}).`,
      false,
    )
  }
}

export function createKlingVisualGenerationProvider(
  configOverride?: KlingVisualConfig,
  clientOverride?: KlingHttpClient,
  probeOverride?: KlingVideoProbe,
): VisualGenerationProvider {
  const config = configOverride ?? configFromEnv()
  assertCompleteConfig(config)
  const client = clientOverride ?? createFetchKlingHttpClient()
  const probe = probeOverride ?? probeKlingVideoFromBytes
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '')
  const authHeaders: Readonly<Record<string, string>> = {
    Authorization: `Bearer ${config.apiKey}`,
  }

  async function downloadVerifiedArtifact(
    url: string,
  ): Promise<VisualGenerationArtifact> {
    // SSRF / exfiltration gates, BEFORE any network contact. The URL
    // (and especially its signed query string) never appears in any
    // error or log — every refusal is a fixed code.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new VisualGenerationProviderError(
        'artifact_url_invalid',
        'The Kling artifact URL is not a valid URL.',
        false,
      )
    }
    if (parsed.protocol !== 'https:') {
      throw new VisualGenerationProviderError(
        'artifact_url_not_https',
        'The Kling artifact URL is not HTTPS.',
        false,
      )
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new VisualGenerationProviderError(
        'artifact_url_has_credentials',
        'The Kling artifact URL embeds credentials.',
        false,
      )
    }
    if (!config.artifactOrigins.includes(parsed.origin)) {
      throw new VisualGenerationProviderError(
        'artifact_origin_forbidden',
        'The Kling artifact URL is outside the configured origin allowlist.',
        false,
      )
    }
    let downloaded: Awaited<ReturnType<KlingHttpClient['downloadArtifact']>>
    try {
      downloaded = await client.downloadArtifact({
        url,
        maxBytes: KLING_MAX_ARTIFACT_BYTES,
        timeoutMs: KLING_CLIENT_LIMITS.timeoutMs,
      })
    } catch {
      throw new VisualGenerationProviderError(
        'artifact_download_failed',
        'The Kling artifact download failed.',
        false,
      )
    }
    if (downloaded.status >= 300 && downloaded.status < 400) {
      // The client never follows redirects; a redirect ANSWER is a
      // refusal, not a hop — following one could land on an origin the
      // allowlist never approved.
      throw new VisualGenerationProviderError(
        'artifact_redirect_refused',
        'The Kling artifact URL answered with a redirect.',
        false,
      )
    }
    if (downloaded.status !== 200) {
      throw new VisualGenerationProviderError(
        'artifact_download_failed',
        'The Kling artifact download failed.',
        false,
      )
    }
    const mime = (downloaded.contentType ?? '').split(';')[0].trim().toLowerCase()
    if (mime !== KLING_ARTIFACT_MIME) {
      throw new VisualGenerationProviderError(
        'artifact_mime_invalid',
        'The Kling artifact is not video/mp4.',
        false,
      )
    }
    if (downloaded.bytes.length === 0) {
      throw new VisualGenerationProviderError(
        'artifact_empty',
        'The Kling artifact download produced no bytes.',
        false,
      )
    }
    if (downloaded.bytes.length > KLING_MAX_ARTIFACT_BYTES) {
      throw new VisualGenerationProviderError(
        'artifact_too_large',
        'The Kling artifact exceeds the bounded download size.',
        false,
      )
    }
    // REAL duration, measured locally from the exact bytes. The
    // provider's own duration claims are never consulted.
    const measured = await probe(downloaded.bytes)
    if (!measured.ok) {
      throw new VisualGenerationProviderError(
        'artifact_unmeasurable',
        'The Kling artifact could not be measured.',
        false,
      )
    }
    if (!measured.hasVideo || measured.durationMs <= 0) {
      throw new VisualGenerationProviderError(
        'artifact_video_stream_missing',
        'The Kling artifact carries no measurable video stream.',
        false,
      )
    }
    if (measured.hasAudio) {
      // VISUALS ONLY: audio was requested "off"; an artifact that
      // carries sound anyway is refused rather than shipped.
      throw new VisualGenerationProviderError(
        'artifact_audio_unexpected',
        'The Kling artifact unexpectedly contains an audio stream.',
        false,
      )
    }
    return {
      bytes: downloaded.bytes,
      mimeType: KLING_ARTIFACT_MIME,
      durationMs: measured.durationMs,
    }
  }

  return {
    code: KLING_VISUAL_CODE,
    displayName: 'Kling AI text-to-video (API 2.0, Kling 3.0)',

    isEnabled() {
      return true
    },

    validateRequest(request: VisualGenerationRequest) {
      // PURE and network-free: the executor turns a refusal here into
      // a provably NOT_SENT task failure with zero provider contact.
      //
      // THIS ADAPTER IS TEXT-TO-VIDEO ONLY. Its create body is a closed
      // allowlist with no image input of any kind (canon §10.13), so a
      // request carrying an approved visual reference is REFUSED rather
      // than silently generated without it — quietly dropping the
      // reference would spend money producing a shot the Visual Bible
      // did not authorise. Image-to-video needs a verified official
      // contract and a separate adapter capability.
      if (request.visualReference !== null) {
        return { ok: false, reasonCode: 'reference_input_unsupported' }
      }
      if (klingDurationSeconds(request.durationMs) == null) {
        return { ok: false, reasonCode: 'duration_unsupported_by_provider' }
      }
      const prompt = compileKlingPrompt(request)
      if (!prompt.ok) return { ok: false, reasonCode: prompt.reasonCode }
      return { ok: true }
    },

    async submitScene(
      request: VisualGenerationRequest,
    ): Promise<VisualGenerationSubmission> {
      // Second lock behind validateRequest — these gates fire BEFORE
      // any network contact, so nothing is spent; unlike the
      // executor's NOT_SENT path they surface as quarantines, which is
      // the correct failure direction for gates that should have been
      // unreachable.
      const duration = klingDurationSeconds(request.durationMs)
      if (duration == null) {
        throw new VisualGenerationProviderError(
          'duration_unsupported_by_provider',
          'Kling accepts whole seconds from 3 to 15 only.',
          false,
        )
      }
      const compiledPrompt = compileKlingPrompt(request)
      if (!compiledPrompt.ok) {
        throw new VisualGenerationProviderError(
          compiledPrompt.reasonCode,
          'The Kling prompt could not be compiled within the documented bounds.',
          false,
        )
      }
      const body: KlingCreateRequestBody = {
        prompt: compiledPrompt.prompt,
        settings: {
          audio: 'off',
          multi_shot: false,
          duration,
        },
        options: {
          external_task_id: request.idempotencyKey,
        },
      }
      let response: { status: number; bodyText: string }
      try {
        response = await client.requestJson({
          method: 'POST',
          url: `${baseUrl}${KLING_CREATE_PATH}`,
          headers: {
            ...authHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        })
      } catch {
        // The raw error is deliberately dropped: it can echo the
        // request (prompt, key) or transport detail. The call was in
        // flight — the executor quarantines the unknown outcome.
        throw new VisualGenerationProviderError(
          'provider_call_failed',
          'The Kling create call failed.',
          false,
        )
      }
      const envelope = parseJsonEnvelope(response)
      const task = parseTaskObject(envelope.data)
      if (task.status === 'failed') {
        // The provider's own explicit rejection, at create time.
        return { status: 'FAILED', failureCode: 'provider_rejected' }
      }
      // submitted | processing | succeeded — a real operation exists;
      // its EXACT id is persisted by the executor and polling continues
      // it. Even an immediate `succeeded` goes through the same poll
      // path: one result-acceptance flow, not two.
      return { status: 'PENDING', providerJobId: task.id }
    },

    async pollScene(
      providerJobId: string,
    ): Promise<VisualGenerationPollResult> {
      let response: { status: number; bodyText: string }
      try {
        response = await client.requestJson({
          method: 'GET',
          url: `${baseUrl}${KLING_QUERY_PATH}?task_ids=${encodeURIComponent(providerJobId)}`,
          headers: authHeaders,
        })
      } catch {
        throw new VisualGenerationProviderError(
          'provider_call_failed',
          'The Kling query call failed.',
          false,
        )
      }
      const envelope = parseJsonEnvelope(response)
      // The answer must contain EXACTLY the task asked about — a
      // response about some other task (or about two tasks claiming
      // the same id) is an answer to a question nobody asked.
      if (!Array.isArray(envelope.data)) malformed()
      const matches = envelope.data
        .map((entry) => parseTaskObject(entry))
        .filter((task) => task.id === providerJobId)
      if (matches.length !== 1) malformed()
      const task = matches[0]

      if (task.status === 'submitted' || task.status === 'processing') {
        return { status: 'PENDING', artifact: null, failureCode: null }
      }
      if (task.status === 'failed') {
        return {
          status: 'FAILED',
          artifact: null,
          failureCode: 'provider_failed',
        }
      }
      // succeeded: accept ONLY a video output with a URL; everything
      // else in outputs is ignored, and having no video output at all
      // is a malformed success.
      const video = task.outputs.find(
        (output) =>
          output.type === 'video' &&
          typeof output.url === 'string' &&
          output.url !== '',
      )
      if (!video) malformed()
      const artifact = await downloadVerifiedArtifact(video.url as string)
      return { status: 'COMPLETED', artifact, failureCode: null }
    },
  }
}
