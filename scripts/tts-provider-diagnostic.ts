/**
 * Provider-side configuration validation — READ ONLY.
 *
 *   bun run smoke:tts:provider
 *
 * The sibling of `smoke:tts`, deliberately kept apart from it. That one
 * is strictly local: no network, no spend, and it cannot fail merely
 * because 9jaLingo is having a bad day. Folding these checks into it
 * would trade that guarantee away, so they live here instead and a
 * deployment can always answer "is my configuration well-formed?"
 * without asking the internet.
 *
 * WHAT THIS TOUCHES: `GET /models` and `GET /speakers` — metadata
 * only. No synthesis endpoint is called, no audio is generated, and no
 * credits are intentionally consumed. 9jaLingo charges TTS by
 * character; there are no characters here to charge for.
 *
 * WHAT IT MAY NOT DO: choose anything. Discovery VALIDATES the pinned
 * production model and the two configured voices; it never selects,
 * rewrites or substitutes them. If the catalogue disagrees with the
 * configuration, the configuration is reported wrong — the catalogue
 * does not win by default. A provider that could re-point production
 * at a voice of its choosing is a provider that could change whose
 * voice speaks for a Sacred House.
 *
 * WHY THE /models PROBE IS HERE AND NOT IN THE LOCAL PREFLIGHT. An
 * earlier version of `smoke:tts` called it and reported "provider
 * reachable", which was unsound: a 404 from an undocumented path shows
 * only that some host answered, not that credentials were accepted.
 * That reasoning still holds for a LOCAL preflight. What changed is
 * that this endpoint is now known — tested against the live service —
 * to authenticate and to answer with the model catalogue, so in a
 * diagnostic that is honestly labelled as network-touching, it proves
 * something real.
 */
import { env } from '@/lib/env'
import { NAIJALINGO_AUTH_HEADER, NAIJALINGO_LANGUAGE } from '@/providers/tts/naijalingo'

type Level = 'ok' | 'warn' | 'fail'
const results: Array<{ level: Level }> = []

function record(level: Level, label: string, detail = ''): void {
  results.push({ level })
  const tag = level === 'ok' ? 'OK  ' : level === 'warn' ? 'WARN' : 'FAIL'
  console.log(`${tag}  ${label}${detail ? `  — ${detail}` : ''}`)
}

/** A catalogue id is not a secret, but printing one in full invites it
 * into a paste. The fingerprint is enough to tell two apart. */
function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`
}

interface Speaker {
  id?: string
  voice_code?: string
  name?: string
  language?: string
  gender?: string
  database_id?: string
}

async function read(path: string): Promise<{ status: number; body: unknown }> {
  const base = env.NAIJALINGO_API_BASE_URL.replace(/\/+$/, '')
  const response = await fetch(`${base}${path}`, {
    // The same header the adapter authenticates synthesis with, so a
    // pass here is evidence about the credential production uses.
    headers: { [NAIJALINGO_AUTH_HEADER]: env.NAIJALINGO_API_KEY },
    signal: AbortSignal.timeout(30_000),
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

function findSpeaker(
  speakers: Array<Speaker>,
  configured: string,
): { speaker: Speaker; matchedOn: string } | null {
  const trimmed = configured.trim()
  if (trimmed.length === 0) return null
  for (const [field, matched] of [
    ['voice_code', speakers.find((s) => s.voice_code === trimmed)],
    ['id', speakers.find((s) => s.id === trimmed)],
    ['database_id', speakers.find((s) => s.database_id === trimmed)],
  ] as const) {
    if (matched) return { speaker: matched, matchedOn: field }
  }
  return null
}

async function main(): Promise<void> {
  console.log('9jaLingo provider diagnostic — read-only metadata checks.')
  console.log('No synthesis endpoint is called. No audio. No characters billed.\n')

  for (const [name, value] of [
    ['NAIJALINGO_API_KEY', env.NAIJALINGO_API_KEY],
    ['NAIJALINGO_API_BASE_URL', env.NAIJALINGO_API_BASE_URL],
    ['NAIJALINGO_MODEL', env.NAIJALINGO_MODEL],
    ['NAIJALINGO_YO_MALE_VOICE_ID', env.NAIJALINGO_YO_MALE_VOICE_ID],
    ['NAIJALINGO_YO_FEMALE_VOICE_ID', env.NAIJALINGO_YO_FEMALE_VOICE_ID],
  ] as const) {
    if (value.trim().length === 0) {
      record('fail', `${name} is set`)
      console.log('\nNothing to validate against the provider. Stopping.')
      process.exit(1)
    }
  }

  // --- Authentication, against the real credential --------------------------
  const models = await read('/models')
  record(
    models.status === 200 ? 'ok' : 'fail',
    'API authentication succeeds',
    `GET /models → ${models.status}`,
  )
  if (models.status !== 200) {
    console.log('\nThe credential was refused, so nothing below can be trusted.')
    process.exit(1)
  }

  // --- The PINNED model is real. The catalogue does not get to pick. --------
  const modelIds = (
    (models.body as { data?: Array<{ id?: string }> } | null)?.data ?? []
  ).map((entry) => entry.id ?? '')
  record(
    modelIds.includes(env.NAIJALINGO_MODEL) ? 'ok' : 'fail',
    `pinned model ${env.NAIJALINGO_MODEL} is reported by the provider`,
    `${modelIds.length} model(s) published`,
  )

  // --- The two configured voices are real, Yoruba, and the right sex --------
  const catalogue = await read('/speakers')
  record(
    catalogue.status === 200 ? 'ok' : 'fail',
    'voice catalogue is readable',
    `GET /speakers → ${catalogue.status}`,
  )
  const speakers =
    (catalogue.body as { speakers?: Array<Speaker> } | null)?.speakers ?? []
  record(speakers.length > 0 ? 'ok' : 'fail', 'catalogue is non-empty', `${speakers.length} voices`)

  for (const [profile, configured, expectedGender] of [
    ['YO_MALE', env.NAIJALINGO_YO_MALE_VOICE_ID, 'male'],
    ['YO_FEMALE', env.NAIJALINGO_YO_FEMALE_VOICE_ID, 'female'],
  ] as const) {
    const hit = findSpeaker(speakers, configured)
    if (!hit) {
      record('fail', `${profile} names a voice in the catalogue`, short(configured))
      continue
    }
    const { speaker, matchedOn } = hit
    record('ok', `${profile} names a voice in the catalogue`, `${speaker.name ?? '?'} (matched on ${matchedOn})`)
    record(
      speaker.language === NAIJALINGO_LANGUAGE ? 'ok' : 'fail',
      `${profile} speaks ${NAIJALINGO_LANGUAGE}`,
      speaker.language ?? 'no language published',
    )
    // The check this whole routing rule exists for. A House whose
    // approved representative is a woman must not be given a man's
    // voice, and a technical pass that never compared these would let
    // exactly that through.
    record(
      speaker.gender === expectedGender ? 'ok' : 'fail',
      `${profile} is published as ${expectedGender}`,
      speaker.gender ?? 'no gender published',
    )
    if (matchedOn === 'database_id') {
      record(
        'warn',
        `${profile} is configured by database_id, not voice_code`,
        `the catalogue's own identifier for this voice is ${speaker.voice_code ?? '?'}`,
      )
    }
  }

  record(
    env.NAIJALINGO_YO_MALE_VOICE_ID.trim() !==
      env.NAIJALINGO_YO_FEMALE_VOICE_ID.trim()
      ? 'ok'
      : 'fail',
    'the two configured voices are distinct',
  )

  console.log('\nWhat this diagnostic did NOT do:')
  console.log('  Call any synthesis endpoint ......... no')
  console.log('  Generate any audio .................. no')
  console.log('  Intentionally consume credits ....... no')
  console.log('  Change any production configuration . no — it validates pins only')

  const fails = results.filter((r) => r.level === 'fail').length
  const warns = results.filter((r) => r.level === 'warn').length
  console.log(`\n${fails} failing, ${warns} advisory, ${results.length} checks.`)
  if (fails > 0) process.exit(1)
}

await main()
