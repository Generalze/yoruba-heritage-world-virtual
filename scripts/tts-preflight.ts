/**
 * Speech-synthesis configuration preflight.
 *
 *   bun run smoke:tts
 *
 * Answers one question — "is this deployment configured to speak?" —
 * and answers it WITHOUT SYNTHESIZING ANYTHING. It never calls
 * /audio/speech, never sends approved sacred text anywhere, and never
 * spends. A configuration check that costs money is not a check, it is
 * a purchase.
 *
 * It also never prints the API key, in full or in part.
 *
 * WHAT IT CANNOT PROVE, and says so rather than implying otherwise:
 * 9jaLingo's published API documentation describes the synthesis
 * endpoint and its fields, but documents NO endpoint for listing models
 * or speakers. This probe therefore tries the OpenAI-compatible
 * `GET /models` convention that the adapter's transport already relies
 * on, and treats a 404 as "this vendor does not offer discovery" rather
 * than as a failure. Where discovery is unavailable, the configured
 * model and voice cannot be machine-verified at all — they must be read
 * from the operator's dashboard and confirmed by a human. Absence of a
 * discovery endpoint is never a licence to hardcode a value found in an
 * example.
 */
import { env } from '@/lib/env'
import { NAIJALINGO_LANGUAGE } from '@/providers/tts/naijalingo'

const TIMEOUT_MS = 15_000

type Level = 'ok' | 'warn' | 'fail'
const results: Array<{ level: Level; label: string; detail: string }> = []

function record(level: Level, label: string, detail = ''): void {
  results.push({ level, label, detail })
  const tag = level === 'ok' ? 'OK  ' : level === 'warn' ? 'WARN' : 'FAIL'
  console.log(`${tag}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/** Never the value, never a prefix of it — only whether it is set. */
function present(value: string): boolean {
  return value.trim().length > 0
}

async function main(): Promise<void> {
  console.log('Speech synthesis preflight — no synthesis is performed.\n')

  record(
    env.TTS_DRIVER === '9JALINGO' ? 'ok' : 'warn',
    `TTS_DRIVER is ${env.TTS_DRIVER}`,
    env.TTS_DRIVER === '9JALINGO'
      ? ''
      : 'the checks below describe the 9jaLingo adapter and are informational under this driver',
  )

  const key = env.NAIJALINGO_API_KEY
  const baseUrl = env.NAIJALINGO_API_BASE_URL
  const voice = env.NAIJALINGO_YO_VOICE_ID
  const model = env.NAIJALINGO_MODEL

  record(present(key) ? 'ok' : 'fail', 'NAIJALINGO_API_KEY is set')
  record(
    present(baseUrl) ? 'ok' : 'fail',
    'NAIJALINGO_API_BASE_URL is set',
    present(baseUrl) ? baseUrl : '',
  )
  record(present(model) ? 'ok' : 'fail', 'NAIJALINGO_MODEL is set', model)
  record(
    present(voice) ? 'ok' : 'fail',
    'NAIJALINGO_YO_VOICE_ID is set',
    voice,
  )

  if (!present(key) || !present(baseUrl)) {
    console.log('\nCannot probe the provider without a key and a base URL.')
    summarize()
    return
  }

  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    record('fail', 'base URL parses', 'not a URL')
    summarize()
    return
  }
  record(
    parsed.protocol === 'https:' ? 'ok' : 'fail',
    'base URL is https',
    parsed.protocol,
  )

  // The ONLY network call this script makes. Read-only, unpriced, and
  // not the synthesis endpoint.
  const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`
  let response: Response | null = null
  try {
    response = await fetch(modelsUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (caught) {
    record(
      'fail',
      'provider reachable',
      caught instanceof Error ? caught.name : 'network error',
    )
    summarize()
    return
  }

  if (response.status === 401 || response.status === 403) {
    record('fail', 'API key accepted', `HTTP ${response.status}`)
    summarize()
    return
  }
  if (response.status === 404) {
    record('ok', 'provider reachable', 'host answered')
    record(
      'warn',
      'model/voice discovery unavailable',
      'no /models endpoint; confirm both from the dashboard by hand',
    )
    summarize()
    return
  }
  if (!response.ok) {
    record('fail', 'discovery probe', `HTTP ${response.status}`)
    summarize()
    return
  }

  record('ok', 'provider reachable and key accepted', `HTTP ${response.status}`)

  let ids: Array<string> = []
  try {
    const payload = (await response.json()) as {
      data?: Array<{ id?: unknown }>
    }
    ids = (payload.data ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === 'string')
  } catch {
    record('warn', 'discovery response parsed', 'unrecognised shape')
    summarize()
    return
  }

  record('ok', 'models discovered', `${ids.length} listed`)
  if (ids.length > 0) console.log(`      ${ids.join(', ')}`)
  if (present(model)) {
    record(
      ids.includes(model) ? 'ok' : 'fail',
      'configured NAIJALINGO_MODEL exists at the provider',
      ids.includes(model) ? model : `${model} not among the listed models`,
    )
  }

  // Voices are a different question, and this endpoint does not answer
  // it. Saying "model verified" while the VOICE is unverified would be
  // the more dangerous half-truth, so it is stated outright.
  record(
    'warn',
    'voice NOT machine-verified',
    `confirm ${voice || '(unset)'} is a ${NAIJALINGO_LANGUAGE} speaker in the dashboard, and have a human review it before production`,
  )

  summarize()
}

function summarize(): void {
  const fails = results.filter((r) => r.level === 'fail').length
  const warns = results.filter((r) => r.level === 'warn').length
  console.log(
    `\n${fails} failing, ${warns} needing human confirmation, ${results.length} checks.`,
  )
  console.log('No audio was synthesized and nothing was spent.')
  if (fails > 0) process.exit(1)
}

await main()
