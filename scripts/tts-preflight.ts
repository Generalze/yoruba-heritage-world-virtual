/**
 * Speech-synthesis configuration preflight.
 *
 *   bun run smoke:tts
 *
 * LOCAL ONLY. This script makes NO network call of any kind. It does
 * not synthesize, does not spend, does not contact the provider, and
 * never prints the API key.
 *
 * WHY IT DOES NOT PROBE THE PROVIDER. An earlier version called
 * `GET {baseUrl}/models`, reasoning that the synthesis surface is
 * OpenAI-compatible. That was an inference, not a contract: 9jaLingo's
 * published documentation describes `POST /v1/audio/speech` and its
 * fields, and documents no REST endpoint for listing models or
 * speakers. Compatibility on one endpoint is not compatibility on the
 * whole API, and the adapter itself needs only `/audio/speech`.
 *
 * The probe was also unsound as evidence. A 404 from an undocumented
 * path shows that some host answered; it does not show that the
 * credentials were accepted, because a server may answer 404 before it
 * ever looks at authorization. Reporting "provider reachable" from that
 * would have been a claim the check could not support.
 *
 * So this preflight proves exactly what a machine can prove locally,
 * and states the rest as UNVERIFIED rather than implying otherwise.
 * Remote authentication, model existence and voice existence require
 * the operator's dashboard until 9jaLingo documents a zero-spend
 * validation or discovery endpoint.
 */
import { env } from '@/lib/env'
import {
  NAIJALINGO_LANGUAGE,
  createNaijalingoTtsProvider,
} from '@/providers/tts/naijalingo'

type Level = 'ok' | 'warn' | 'fail'
const results: Array<{ level: Level }> = []

function record(level: Level, label: string, detail = ''): void {
  results.push({ level })
  const tag = level === 'ok' ? 'OK  ' : level === 'warn' ? 'WARN' : 'FAIL'
  console.log(`${tag}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/** Whether a value is configured. Never the value itself for secrets. */
function present(value: string): boolean {
  return value.trim().length > 0
}

/**
 * An unreplaced template string is not a configuration.
 *
 * Presence alone is a weak test, and this script learned that the hard
 * way: it once answered "0 failing" for a deployment whose model was
 * literally YOUR_VERIFIED_MODEL_ID. A preflight that passes a
 * placeholder is worse than no preflight, because it converts an
 * obvious gap into a green tick.
 */
const PLACEHOLDER_PREFIXES = ['YOUR_', 'YOUR-', '<', 'CHANGE', 'REPLACE', 'TODO', 'XXX']

function looksUnset(value: string): boolean {
  const v = value.trim()
  if (v.length === 0) return true
  const upper = v.toUpperCase()
  if (PLACEHOLDER_PREFIXES.some((p) => upper.startsWith(p))) return true
  // Nothing legitimate here contains whitespace or angle brackets.
  return /\s/.test(v) || v.includes('<') || v.includes('>')
}

/** ok / fail for a configured value, rejecting obvious templates. */
function configured(value: string): Level {
  return looksUnset(value) ? 'fail' : 'ok'
}

function main(): void {
  console.log('Speech synthesis preflight — local configuration only.')
  console.log('No network call, no synthesis, no spend.\n')

  record(
    env.TTS_DRIVER === '9JALINGO' ? 'ok' : 'warn',
    `TTS_DRIVER is ${env.TTS_DRIVER}`,
    env.TTS_DRIVER === '9JALINGO'
      ? ''
      : 'checks below describe the 9jaLingo adapter and are informational under this driver',
  )

  const key = env.NAIJALINGO_API_KEY
  const baseUrl = env.NAIJALINGO_API_BASE_URL
  const maleVoice = env.NAIJALINGO_YO_MALE_VOICE_ID
  const femaleVoice = env.NAIJALINGO_YO_FEMALE_VOICE_ID
  const model = env.NAIJALINGO_MODEL

  // Presence only. The key is never echoed, in full or in part.
  record(configured(key), 'NAIJALINGO_API_KEY is set')
  record(
    configured(baseUrl),
    'NAIJALINGO_API_BASE_URL is set',
    present(baseUrl) ? baseUrl : '',
  )
  record(configured(model), 'NAIJALINGO_MODEL is set', model)
  // Both, always. Half a configuration serves half the Houses.
  record(configured(maleVoice), 'NAIJALINGO_YO_MALE_VOICE_ID is set', maleVoice)
  record(
    configured(femaleVoice),
    'NAIJALINGO_YO_FEMALE_VOICE_ID is set',
    femaleVoice,
  )
  record(
    maleVoice.trim() !== '' && maleVoice.trim() === femaleVoice.trim()
      ? 'fail'
      : 'ok',
    'the two voice profiles are different voices',
  )

  if (present(baseUrl)) {
    let parsed: URL | null = null
    try {
      parsed = new URL(baseUrl)
    } catch {
      parsed = null
    }
    record(parsed !== null ? 'ok' : 'fail', 'base URL parses')
    if (parsed) {
      record(
        parsed.protocol === 'https:' ? 'ok' : 'fail',
        'base URL is https',
        parsed.protocol,
      )
    }
  }

  // Constructing the adapter is a LOCAL act: it validates configuration
  // completeness and builds a client. It opens no connection.
  if (![key, baseUrl, model, maleVoice, femaleVoice].some(looksUnset)) {
    try {
      const provider = createNaijalingoTtsProvider()
      record('ok', 'adapter constructs from configuration', provider.code)
      const languages = provider.supportedLanguages ?? []
      record(
        languages.length === 1 && languages[0] === NAIJALINGO_LANGUAGE
          ? 'ok'
          : 'fail',
        `language policy is ${NAIJALINGO_LANGUAGE} only`,
        languages.join(', ') || 'none declared',
      )
      record(
        provider.isEnabled() ? 'ok' : 'fail',
        'adapter reports itself enabled',
      )
    } catch (caught) {
      record(
        'fail',
        'adapter constructs from configuration',
        caught instanceof Error ? caught.message : 'construction failed',
      )
    }
  } else {
    record(
      'warn',
      'adapter construction skipped',
      'configuration incomplete — nothing to construct',
    )
  }

  console.log('\nWhat this preflight CANNOT establish:')
  console.log('  Remote authentication ................ NOT VERIFIED')
  console.log('  Configured model existence ........... NOT VERIFIED')
  console.log('  Both configured voices exist ......... NOT VERIFIED')
  console.log(`  Each is a ${NAIJALINGO_LANGUAGE} speaker of the right voice  NOT VERIFIED`)
  console.log('')
  console.log(
    '  Not because they are unknowable — the provider publishes a model',
  )
  console.log(
    '  and voice catalogue, and `bun run smoke:tts:provider` checks all four',
  )
  console.log(
    '  of them against it: read-only, no synthesis, no characters billed.',
  )
  console.log(
    '  They are unknowable HERE, deliberately: this command makes no network',
  )
  console.log(
    '  call at all, so it can still answer for a configuration when the',
  )
  console.log(
    '  vendor is down. Example ids in vendor documentation are never',
  )
  console.log('  authority for a deployment either way.')

  const fails = results.filter((r) => r.level === 'fail').length
  const warns = results.filter((r) => r.level === 'warn').length
  console.log(
    `\n${fails} failing, ${warns} advisory, ${results.length} local checks.`,
  )
  console.log('No provider was contacted. Nothing was synthesized or spent.')
  if (fails > 0) process.exit(1)
}

main()
