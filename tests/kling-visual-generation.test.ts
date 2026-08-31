import { describe, expect, it } from 'bun:test'

import { RESERVATION_STALE_AFTER_MS } from '@/services/generation-jobs'
import {
  KLING_CLIENT_LIMITS,
  KLING_CREATE_PATH,
  KLING_MAX_ARTIFACT_BYTES,
  KLING_PROMPT_MAX_CHARS,
  KLING_PROMPT_RULES_HEADER,
  KLING_PROMPT_TEXT_HEADER,
  KLING_VISUAL_CODE,
  compileKlingPrompt,
  createKlingVisualGenerationProvider,
  klingDurationSeconds,
} from '@/providers/visual-generation/kling'
import { VisualGenerationProviderError } from '@/providers/visual-generation/types'
import { parseHttpsOriginAllowlist } from '@/lib/security-headers'
import type {
  KlingHttpClient,
  KlingVideoProbe,
  KlingVisualConfig,
} from '@/providers/visual-generation/kling'
import type { VisualGenerationRequest } from '@/providers/visual-generation/types'

/**
 * ============================================================================
 * KLING API 2.0 VISUAL ADAPTER — Phase One, Step 20.
 *
 * Every test uses an INJECTED FAKE CLIENT and FAKE PROBE: zero network,
 * zero real API, zero spend, no ffprobe binary. Each test pins one
 * property of the official contract as implemented: the exact Bearer
 * header, the exact create path and closed body, audio always "off",
 * the whole-second 3–15 duration law, the 3072-char prompt bound, the
 * strict response parsing, and the artifact download's origin pin.
 * ============================================================================
 */

const CONFIG: KlingVisualConfig = {
  apiKey: 'kling-test-secret-key-XyZ',
  baseUrl: 'https://api-singapore.klingai.com',
  artifactOrigins: ['https://cdn.kling-artifacts.test'],
}

const RULES = [
  { category: 'COLOR', position: 2, ruleText: 'Warm dawn light.' },
  { category: 'COLOR', position: 1, ruleText: 'Indigo and gold palette.' },
  { category: 'CAMERA', position: 1, ruleText: 'Slow static shots.' },
]

function request(
  overrides: Partial<VisualGenerationRequest> = {},
): VisualGenerationRequest {
  return {
    idempotencyKey: 'k'.repeat(64),
    sceneId: 'scene-kling-unit',
    taskId: 'task-kling-unit',
    durationMs: 10_000,
    contentType: 'PRAYER',
    themeCode: 'THEME_X',
    visualBibleVersionId: 1,
    visualBibleVersionNumber: 1,
    visualBibleRules: RULES,
    externalAiPolicy: 'METADATA_ONLY',
    approvedTextContext: null,
    visualReference: null,
    ...overrides,
  }
}

interface RecordedRequest {
  method: 'GET' | 'POST'
  url: string
  headers: Readonly<Record<string, string>>
  body?: string
}

interface RecordedDownload {
  url: string
  maxBytes: number
  timeoutMs: number
}

function jsonResponse(value: unknown): { status: number; bodyText: string } {
  return { status: 200, bodyText: JSON.stringify(value) }
}

const CREATE_OK = {
  code: 0,
  data: { id: 'kling-task-001', status: 'submitted' },
}

function succeededQuery(id: string, url: string): unknown {
  return {
    code: 0,
    data: [
      {
        id,
        status: 'succeeded',
        outputs: [{ type: 'video', url }],
      },
    ],
  }
}

const MP4_BYTES = new TextEncoder().encode(
  `kling-unit-mp4-${'x'.repeat(2048)}`,
)

function buildFakes(options?: {
  createResponse?: { status: number; bodyText: string }
  queryResponse?: { status: number; bodyText: string }
  download?: {
    status?: number
    contentType?: string | null
    bytes?: Uint8Array
  }
  probe?: Parameters<typeof createKlingVisualGenerationProvider>[2]
}): {
  client: KlingHttpClient
  requests: Array<RecordedRequest>
  downloads: Array<RecordedDownload>
  probe: KlingVideoProbe
} {
  const requests: Array<RecordedRequest> = []
  const downloads: Array<RecordedDownload> = []
  const client: KlingHttpClient = {
    async requestJson(input) {
      requests.push(input)
      if (input.method === 'POST') {
        return options?.createResponse ?? jsonResponse(CREATE_OK)
      }
      return (
        options?.queryResponse ??
        jsonResponse(
          succeededQuery(
            'kling-task-001',
            'https://cdn.kling-artifacts.test/v/unit.mp4?sig=UNIT_SIGNATURE',
          ),
        )
      )
    },
    async downloadArtifact(input) {
      downloads.push(input)
      return {
        status: options?.download?.status ?? 200,
        contentType:
          options?.download?.contentType === undefined
            ? 'video/mp4'
            : options.download.contentType,
        bytes: options?.download?.bytes ?? MP4_BYTES,
      }
    },
  }
  const probe: KlingVideoProbe =
    options?.probe ??
    (async () => ({
      ok: true,
      durationMs: 9_640,
      hasAudio: false,
      hasVideo: true,
    }))
  return { client, requests, downloads, probe }
}

async function thrownBy(call: () => Promise<unknown>): Promise<unknown> {
  try {
    await call()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

// --- The create request -------------------------------------------------------

describe('Kling create: the exact official request and nothing else', () => {
  it('POSTs the closed body to /text-to-video/kling-3.0 with the exact Bearer header', async () => {
    const { client, requests, probe } = buildFakes()
    const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)

    const submission = await provider.submitScene(request())

    expect(requests).toHaveLength(1)
    const call = requests[0]
    expect(call.method).toBe('POST')
    expect(call.url).toBe(
      'https://api-singapore.klingai.com/text-to-video/kling-3.0',
    )
    // The NEW API-Key scheme, exactly: the key itself as the bearer.
    expect(call.headers.Authorization).toBe(`Bearer ${CONFIG.apiKey}`)
    expect(call.headers['Content-Type']).toBe('application/json')
    expect(Object.keys(call.headers).sort()).toEqual([
      'Authorization',
      'Content-Type',
    ])

    // THE CLOSED ALLOWLIST at every level: no callback_url, no
    // model_name, no resolution, no aspect_ratio, no image input.
    const body = JSON.parse(call.body!) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['options', 'prompt', 'settings'])
    const settings = body.settings as Record<string, unknown>
    expect(Object.keys(settings).sort()).toEqual([
      'audio',
      'duration',
      'multi_shot',
    ])
    // VISUALS ONLY — the literal "off", always.
    expect(settings.audio).toBe('off')
    expect(settings.multi_shot).toBe(false)
    expect(settings.duration).toBe(10)
    const bodyOptions = body.options as Record<string, unknown>
    expect(Object.keys(bodyOptions)).toEqual(['external_task_id'])
    // Deterministic identity/reconciliation help — the task's own key.
    expect(bodyOptions.external_task_id).toBe('k'.repeat(64))

    expect(submission.status).toBe('PENDING')
    if (submission.status !== 'PENDING') return
    expect(submission.providerJobId).toBe('kling-task-001')
  })

  it('persists a real operation for every accepting status, and reports the provider’s own rejection', async () => {
    for (const status of ['submitted', 'processing', 'succeeded']) {
      const { client, probe } = buildFakes({
        createResponse: jsonResponse({
          code: 0,
          data: { id: `op-${status}`, status },
        }),
      })
      const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
      const submission = await provider.submitScene(request())
      expect(submission).toEqual({
        status: 'PENDING',
        providerJobId: `op-${status}`,
      })
    }
    const { client, probe } = buildFakes({
      createResponse: jsonResponse({
        code: 0,
        data: { id: 'op-failed', status: 'failed' },
      }),
    })
    const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
    expect(await provider.submitScene(request())).toEqual({
      status: 'FAILED',
      failureCode: 'provider_rejected',
    })
  })

  it('treats every malformed create answer as unknown outcome — one fixed code, no echo', async () => {
    const marker = `leak-${crypto.randomUUID()}`
    const malformedResponses = [
      { status: 500, bodyText: `{"code":0,"data":{"${marker}":1}}` },
      jsonResponse({ code: 1, message: marker }),
      jsonResponse({ code: 0 }),
      jsonResponse({ code: 0, data: { id: '', status: 'submitted' } }),
      jsonResponse({ code: 0, data: { id: 'op-x', status: marker } }),
      { status: 200, bodyText: `not json ${marker}` },
    ]
    for (const createResponse of malformedResponses) {
      const { client, probe } = buildFakes({ createResponse })
      const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
      const error = await thrownBy(() => provider.submitScene(request()))
      expect(error).toBeInstanceOf(VisualGenerationProviderError)
      expect((error as VisualGenerationProviderError).code).toBe(
        'provider_response_malformed',
      )
      expect((error as Error).message).not.toContain(marker)
    }
  })

  it('never retries: a thrown transport call is ONE call and a fixed failure', async () => {
    const marker = `leak-${crypto.randomUUID()}`
    let calls = 0
    const provider = createKlingVisualGenerationProvider(
      CONFIG,
      {
        async requestJson() {
          calls += 1
          throw new Error(`socket ripped: ${marker} key=${CONFIG.apiKey}`)
        },
        async downloadArtifact() {
          throw new Error('unused')
        },
      },
      buildFakes().probe,
    )
    const error = await thrownBy(() => provider.submitScene(request()))
    expect(calls).toBe(1)
    expect((error as VisualGenerationProviderError).code).toBe(
      'provider_call_failed',
    )
    const surface = `${(error as Error).message}`
    expect(surface).not.toContain(marker)
    expect(surface).not.toContain(CONFIG.apiKey)
    expect(KLING_CLIENT_LIMITS.maxRetries).toBe(0)
    expect(KLING_CLIENT_LIMITS.timeoutMs).toBeLessThan(
      RESERVATION_STALE_AFTER_MS,
    )
  })
})

// --- Duration law ---------------------------------------------------------------

describe('Kling duration: whole seconds 3..15, never rounded', () => {
  it('converts only exact whole seconds inside the official range', () => {
    expect(klingDurationSeconds(3_000)).toBe(3)
    expect(klingDurationSeconds(10_000)).toBe(10)
    expect(klingDurationSeconds(15_000)).toBe(15)
    for (const invalid of [0, -3_000, 2_000, 16_000, 10_500, 9_999, 3_000.5]) {
      expect(klingDurationSeconds(invalid)).toBeNull()
    }
  })

  it('refuses an unsupported duration BEFORE any network call, as a declared limit', async () => {
    const { client, requests, probe } = buildFakes()
    const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
    for (const durationMs of [2_000, 16_000, 10_500]) {
      // The declared-limit hook the executor turns into NOT_SENT.
      expect(provider.validateRequest!(request({ durationMs }))).toEqual({
        ok: false,
        reasonCode: 'duration_unsupported_by_provider',
      })
      // And the adapter's own second lock refuses too, still pre-network.
      const error = await thrownBy(() =>
        provider.submitScene(request({ durationMs })),
      )
      expect((error as VisualGenerationProviderError).code).toBe(
        'duration_unsupported_by_provider',
      )
    }
    expect(requests).toHaveLength(0)
    expect(provider.validateRequest!(request({ durationMs: 10_000 }))).toEqual({
      ok: true,
    })
  })
})

// --- Prompt compilation ---------------------------------------------------------

describe('Kling prompt: deterministic, bounded, and only approved content', () => {
  it('compiles the SAME prompt every time: ordered rules, one metadata line, fixed glue', () => {
    const first = compileKlingPrompt(request())
    const second = compileKlingPrompt(request())
    expect(first).toEqual(second)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // Full-string pin: rules ordered by (category, position), nothing
    // invented — no ritual, doctrine, clothing, objects or actions
    // beyond the approved rule text and the safe metadata line.
    expect(first.prompt).toBe(
      [
        KLING_PROMPT_RULES_HEADER,
        '- [CAMERA] Slow static shots.',
        '- [COLOR] Indigo and gold palette.',
        '- [COLOR] Warm dawn light.',
        'Scene: content type PRAYER, theme code THEME_X.',
      ].join('\n'),
    )
  })

  it('METADATA_ONLY never carries a body — and a request claiming otherwise is refused', () => {
    const smuggled = compileKlingPrompt(
      request({ approvedTextContext: 'smuggled sacred text' }),
    )
    expect(smuggled).toEqual({
      ok: false,
      reasonCode: 'policy_context_mismatch',
    })
  })

  it('APPROVED_TEXT_CONTEXT sends the exact authorized body verbatim, once', () => {
    const body = 'Àdúrà ìmọ́lẹ̀ — gbogbo ọ̀rọ̀ tí a fọwọ́ sí.'
    const compiled = compileKlingPrompt(
      request({
        externalAiPolicy: 'APPROVED_TEXT_CONTEXT',
        approvedTextContext: body,
      }),
    )
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    expect(compiled.prompt).toContain(`${KLING_PROMPT_TEXT_HEADER}\n${body}`)
    expect(compiled.prompt.split(body)).toHaveLength(2)
    // …and a policy that promises text but has none fails closed.
    expect(
      compileKlingPrompt(request({ externalAiPolicy: 'APPROVED_TEXT_CONTEXT' })),
    ).toEqual({ ok: false, reasonCode: 'approved_text_missing' })
  })

  it('refuses a prompt that cannot fit 3072 chars — the text is NEVER truncated to fit', async () => {
    const body = 'ọ̀rọ̀ mímọ́ '.repeat(400) // far past the bound
    const oversized = request({
      externalAiPolicy: 'APPROVED_TEXT_CONTEXT',
      approvedTextContext: body,
    })
    expect(compileKlingPrompt(oversized)).toEqual({
      ok: false,
      reasonCode: 'prompt_too_long',
    })
    const { client, requests, probe } = buildFakes()
    const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
    expect(provider.validateRequest!(oversized)).toEqual({
      ok: false,
      reasonCode: 'prompt_too_long',
    })
    const error = await thrownBy(() => provider.submitScene(oversized))
    expect((error as VisualGenerationProviderError).code).toBe(
      'prompt_too_long',
    )
    expect(requests).toHaveLength(0)
    expect(KLING_PROMPT_MAX_CHARS).toBe(3072)
  })
})

// --- Query / poll ---------------------------------------------------------------

describe('Kling query: the exact task, strictly parsed', () => {
  it('GETs /tasks?task_ids=<URL-encoded exact id> with the Bearer header alone', async () => {
    const trickyId = 'kling op/001+x'
    const { requests, probe } = buildFakes()
    const client: KlingHttpClient = {
      async requestJson(input) {
        requests.push(input)
        return jsonResponse(
          succeededQuery(
            trickyId,
            'https://cdn.kling-artifacts.test/v/unit.mp4',
          ),
        )
      },
      async downloadArtifact() {
        return { status: 200, contentType: 'video/mp4', bytes: MP4_BYTES }
      },
    }
    const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
    const poll = await provider.pollScene(trickyId)
    expect(poll.status).toBe('COMPLETED')
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe(
      `https://api-singapore.klingai.com/tasks?task_ids=${encodeURIComponent(trickyId)}`,
    )
    expect(Object.keys(requests[0].headers)).toEqual(['Authorization'])
    expect(requests[0].headers.Authorization).toBe(`Bearer ${CONFIG.apiKey}`)
  })

  it('maps submitted/processing to PENDING and failed to a fixed safe code', async () => {
    for (const status of ['submitted', 'processing']) {
      const { client, probe } = buildFakes({
        queryResponse: jsonResponse({
          code: 0,
          data: [{ id: 'op-1', status }],
        }),
      })
      const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
      expect(await provider.pollScene('op-1')).toEqual({
        status: 'PENDING',
        artifact: null,
        failureCode: null,
      })
    }
    const { client, probe } = buildFakes({
      queryResponse: jsonResponse({
        code: 0,
        data: [{ id: 'op-1', status: 'failed' }],
      }),
    })
    const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
    expect(await provider.pollScene('op-1')).toEqual({
      status: 'FAILED',
      artifact: null,
      failureCode: 'provider_failed',
    })
  })

  it('requires EXACTLY the matching task — wrong ids, duplicates and non-arrays are malformed', async () => {
    const badAnswers = [
      jsonResponse({ code: 0, data: [{ id: 'somebody-else', status: 'succeeded' }] }),
      jsonResponse({
        code: 0,
        data: [
          { id: 'op-1', status: 'processing' },
          { id: 'op-1', status: 'succeeded' },
        ],
      }),
      jsonResponse({ code: 0, data: { id: 'op-1', status: 'succeeded' } }),
      jsonResponse({ code: 0, data: [] }),
    ]
    for (const queryResponse of badAnswers) {
      const { client, probe } = buildFakes({ queryResponse })
      const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
      const error = await thrownBy(() => provider.pollScene('op-1'))
      expect((error as VisualGenerationProviderError).code).toBe(
        'provider_response_malformed',
      )
    }
  })

  it('accepts ONLY a video output on success, and downloads exactly that URL', async () => {
    const videoUrl = 'https://cdn.kling-artifacts.test/v/real.mp4?sig=SIG'
    const { downloads, probe } = buildFakes()
    const client: KlingHttpClient = {
      async requestJson() {
        return jsonResponse({
          code: 0,
          data: [
            {
              id: 'op-1',
              status: 'succeeded',
              outputs: [
                { type: 'thumbnail', url: 'https://cdn.kling-artifacts.test/t.jpg' },
                { type: 'video', url: videoUrl },
              ],
            },
          ],
        })
      },
      async downloadArtifact(input) {
        downloads.push(input)
        return { status: 200, contentType: 'video/mp4', bytes: MP4_BYTES }
      },
    }
    const provider = createKlingVisualGenerationProvider(CONFIG, client, probe)
    const poll = await provider.pollScene('op-1')
    expect(poll.status).toBe('COMPLETED')
    expect(downloads).toHaveLength(1)
    expect(downloads[0].url).toBe(videoUrl)
    expect(downloads[0].maxBytes).toBe(KLING_MAX_ARTIFACT_BYTES)
    // …and a success with NO video output is a malformed success.
    const { client: noVideo, probe: probe2 } = buildFakes({
      queryResponse: jsonResponse({
        code: 0,
        data: [
          {
            id: 'op-1',
            status: 'succeeded',
            outputs: [{ type: 'thumbnail', url: 'https://cdn.kling-artifacts.test/t.jpg' }],
          },
        ],
      }),
    })
    const provider2 = createKlingVisualGenerationProvider(CONFIG, noVideo, probe2)
    const error = await thrownBy(() => provider2.pollScene('op-1'))
    expect((error as VisualGenerationProviderError).code).toBe(
      'provider_response_malformed',
    )
  })
})

// --- Artifact download security -------------------------------------------------

function providerForArtifactUrl(
  url: string,
  download?: {
    status?: number
    contentType?: string | null
    bytes?: Uint8Array
  },
  probe?: KlingVideoProbe,
): {
  provider: ReturnType<typeof createKlingVisualGenerationProvider>
  downloads: Array<RecordedDownload>
} {
  const downloads: Array<RecordedDownload> = []
  const client: KlingHttpClient = {
    async requestJson() {
      return jsonResponse(succeededQuery('op-1', url))
    },
    async downloadArtifact(input) {
      downloads.push(input)
      return {
        status: download?.status ?? 200,
        contentType:
          download?.contentType === undefined
            ? 'video/mp4'
            : download.contentType,
        bytes: download?.bytes ?? MP4_BYTES,
      }
    },
  }
  return {
    provider: createKlingVisualGenerationProvider(
      CONFIG,
      client,
      probe ?? buildFakes().probe,
    ),
    downloads,
  }
}

describe('Kling artifact: origin-pinned, redirect-free, bounded, measured', () => {
  it('refuses HTTP, foreign origins and embedded credentials BEFORE any download', async () => {
    const secret = `sig=${crypto.randomUUID()}`
    const cases: Array<[string, string]> = [
      [`http://cdn.kling-artifacts.test/v.mp4?${secret}`, 'artifact_url_not_https'],
      [`https://evil.example/v.mp4?${secret}`, 'artifact_origin_forbidden'],
      [
        `https://cdn.kling-artifacts.test.evil.example/v.mp4?${secret}`,
        'artifact_origin_forbidden',
      ],
      [
        `https://user:pass@cdn.kling-artifacts.test/v.mp4?${secret}`,
        'artifact_url_has_credentials',
      ],
      ['not a url at all', 'artifact_url_invalid'],
    ]
    for (const [url, expectedCode] of cases) {
      const { provider, downloads } = providerForArtifactUrl(url)
      const error = await thrownBy(() => provider.pollScene('op-1'))
      expect((error as VisualGenerationProviderError).code).toBe(expectedCode)
      // The signed query never appears in what surfaces.
      expect((error as Error).message).not.toContain(secret)
      expect(downloads).toHaveLength(0)
    }
  })

  it('refuses a redirect answer outright — a hop can leave the allowlisted origin', async () => {
    const { provider, downloads } = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      { status: 302, contentType: null, bytes: new Uint8Array(0) },
    )
    const error = await thrownBy(() => provider.pollScene('op-1'))
    expect((error as VisualGenerationProviderError).code).toBe(
      'artifact_redirect_refused',
    )
    expect(downloads).toHaveLength(1)
  })

  it('rejects a wrong MIME, an empty body and an oversized body', async () => {
    const wrongMime = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      { contentType: 'text/html' },
    )
    expect(
      (
        (await thrownBy(() =>
          wrongMime.provider.pollScene('op-1'),
        )) as VisualGenerationProviderError
      ).code,
    ).toBe('artifact_mime_invalid')

    const empty = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      { bytes: new Uint8Array(0) },
    )
    expect(
      (
        (await thrownBy(() =>
          empty.provider.pollScene('op-1'),
        )) as VisualGenerationProviderError
      ).code,
    ).toBe('artifact_empty')

    const oversized = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      { bytes: new Uint8Array(KLING_MAX_ARTIFACT_BYTES + 1) },
    )
    expect(
      (
        (await thrownBy(() =>
          oversized.provider.pollScene('op-1'),
        )) as VisualGenerationProviderError
      ).code,
    ).toBe('artifact_too_large')

    // Parameters on the correct MIME are fine.
    const withParams = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      { contentType: 'video/mp4; codecs="avc1"' },
    )
    expect((await withParams.provider.pollScene('op-1')).status).toBe(
      'COMPLETED',
    )
  })

  it('takes the duration from LOCAL measurement and refuses what cannot be measured', async () => {
    const measured = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      undefined,
      async () => ({ ok: true, durationMs: 9_640, hasAudio: false, hasVideo: true }),
    )
    const poll = await measured.provider.pollScene('op-1')
    expect(poll.status).toBe('COMPLETED')
    if (poll.status !== 'COMPLETED' || !poll.artifact) return
    // ffprobe's answer, not any provider claim.
    expect(poll.artifact.durationMs).toBe(9_640)
    expect(poll.artifact.mimeType).toBe('video/mp4')
    expect(poll.artifact.bytes).toEqual(MP4_BYTES)

    const unmeasurable = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      undefined,
      async () => ({ ok: false, reasonCode: 'probe_failed' }),
    )
    expect(
      (
        (await thrownBy(() =>
          unmeasurable.provider.pollScene('op-1'),
        )) as VisualGenerationProviderError
      ).code,
    ).toBe('artifact_unmeasurable')

    const noVideoStream = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      undefined,
      async () => ({ ok: true, durationMs: 9_640, hasAudio: false, hasVideo: false }),
    )
    expect(
      (
        (await thrownBy(() =>
          noVideoStream.provider.pollScene('op-1'),
        )) as VisualGenerationProviderError
      ).code,
    ).toBe('artifact_video_stream_missing')
  })

  it('refuses an artifact that carries audio — visuals only, audio was requested off', async () => {
    const withAudio = providerForArtifactUrl(
      'https://cdn.kling-artifacts.test/v.mp4',
      undefined,
      async () => ({ ok: true, durationMs: 9_640, hasAudio: true, hasVideo: true }),
    )
    expect(
      (
        (await thrownBy(() =>
          withAudio.provider.pollScene('op-1'),
        )) as VisualGenerationProviderError
      ).code,
    ).toBe('artifact_audio_unexpected')
  })
})

// --- Config and posture ---------------------------------------------------------

describe('Kling configuration and posture', () => {
  it('refuses to construct from an incomplete configuration, naming variables only', () => {
    for (const gap of [
      { ...CONFIG, apiKey: '' },
      { ...CONFIG, baseUrl: '   ' },
      { ...CONFIG, artifactOrigins: [] as ReadonlyArray<string> },
    ]) {
      let thrown: unknown
      try {
        createKlingVisualGenerationProvider(gap, buildFakes().client)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(VisualGenerationProviderError)
      expect((thrown as VisualGenerationProviderError).code).toBe(
        'kling_config_incomplete',
      )
      expect((thrown as Error).message).not.toContain(CONFIG.apiKey)
    }
  })

  it('parses artifact origins strictly: bare HTTPS origins only', () => {
    expect(
      parseHttpsOriginAllowlist(
        'https://cdn-a.example, https://cdn-b.example:8443',
      ),
    ).toEqual({
      ok: true,
      origins: ['https://cdn-a.example', 'https://cdn-b.example:8443'],
    })
    for (const [raw, reasonCode] of [
      ['', 'origin_allowlist_empty'],
      ['   ,  ', 'origin_allowlist_empty'],
      ['http://cdn.example', 'origin_not_https'],
      ['https://user:pw@cdn.example', 'origin_has_credentials'],
      ['https://cdn.example/path', 'origin_not_bare'],
      ['https://cdn.example/', 'origin_not_bare'],
      ['https://cdn.example?q=1', 'origin_not_bare'],
      ['not-an-origin', 'origin_unparseable'],
    ] as const) {
      expect(parseHttpsOriginAllowlist(raw)).toEqual({ ok: false, reasonCode })
    }
  })

  it('is the provider the registry knows, on the documented surface only', async () => {
    const provider = createKlingVisualGenerationProvider(
      CONFIG,
      buildFakes().client,
      buildFakes().probe,
    )
    expect(provider.code).toBe(KLING_VISUAL_CODE)
    expect(KLING_VISUAL_CODE).toBe('KLING')
    expect(provider.isEnabled()).toBe(true)
    expect(KLING_CREATE_PATH).toBe('/text-to-video/kling-3.0')

    const source = await Bun.file(
      'src/providers/visual-generation/kling.ts',
    ).text()
    // No callbacks, no invented model selector, no legacy JWT scheme,
    // and redirects refused at the transport. Comments are stripped —
    // the CODE must be clean; the documentation is allowed (required,
    // even) to name what is forbidden.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code).not.toContain('callback_url')
    expect(code).not.toContain('model_name')
    expect(code).not.toContain('jsonwebtoken')
    expect(code).toContain("redirect: 'error'")
    const registry = await Bun.file(
      'src/providers/visual-generation/registry.ts',
    ).text()
    expect(registry).toContain("case 'KLING':")
    expect(registry).toContain('createKlingVisualGenerationProvider()')
  })
})
