import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ============================================================================
 * DEPLOYMENT TOPOLOGY — Phase One, Step 20.
 *
 * These are the failures nobody notices until production: a worker that
 * was only ever a commented-out aspiration, a runtime image that cannot
 * execute the worker it ships, a database port published to the whole
 * internet because it was convenient locally.
 *
 * None of them is caught by a type checker or a unit test, so they are
 * asserted here against the actual deployment files.
 * ============================================================================
 */

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), 'utf8')
}

const dockerfile = read('Dockerfile')
const compose = read('docker-compose.yml')
const devCompose = read('docker-compose.dev.yml')
const packageJson = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>
  dependencies: Record<string, string>
}

/** Strips `#` comments so prose about a rule cannot satisfy the rule. */
function withoutComments(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

describe('production compose', () => {
  const active = withoutComments(compose)

  it('runs the generation worker as a REAL service', () => {
    // TEETH: before Step 20 this was a commented-out placeholder, which
    // meant a "complete" deployment shipped with nothing to run the
    // pipeline — appointments would confirm, jobs would queue, and no
    // recording would ever be made.
    expect(active).toContain('worker:')
    expect(active).toContain("command: ['bun', 'run', 'worker:generation']")
    expect(packageJson.scripts['worker:generation']).toBe(
      'bun run src/workers/prayer-generation-worker.ts',
    )
  })

  it('has exactly the three production services', () => {
    for (const service of ['app:', 'worker:', 'db:']) {
      expect(active).toContain(service)
    }
  })

  it('runs app and worker from the SAME image and revision', () => {
    // Two independently-built images are two independently-drifting
    // versions of the pipeline; a worker a commit behind the app is a
    // worker enforcing last week's governance.
    const imageLines = active
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('image: yhwv-app'))
    expect(imageLines).toHaveLength(2)
    expect(new Set(imageLines).size).toBe(1)
    expect(imageLines[0]).toContain('${APP_REVISION')
  })

  it('does NOT publish the database port', () => {
    // On a VPS a published 3306 is found by scanners within minutes.
    const dbSection = active.slice(active.indexOf('\n  db:'))
    expect(dbSection).not.toContain('3306:3306')
    expect(dbSection).not.toMatch(/^\s+ports:/m)
  })

  it('keeps the convenient local port in a development-only override', () => {
    expect(devCompose).toContain('127.0.0.1:${DATABASE_PORT:-3306}:3306')
    // Bound to loopback, so even locally the database is not offered to
    // the network the machine is on.
    expect(devCompose).not.toContain("'0.0.0.0:")
  })

  it('shares ONE media volume between app and worker', () => {
    // The app writes approved media; the worker reads it and writes
    // render artifacts. Two volumes would mean the render stage cannot
    // find its own sources.
    const mounts = active
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line === '- media_data:/app/var/media')
    expect(mounts).toHaveLength(2)
    expect(active).toContain('MEDIA_STORAGE_DIR: /app/var/media')
  })

  it('never selects local final object storage or a mock adapter by default', () => {
    expect(active).toContain('OBJECT_STORAGE_DRIVER: ${OBJECT_STORAGE_DRIVER:-S3}')
    expect(active).toContain('RENDER_DRIVER: ${RENDER_DRIVER:-REMOTION}')
    // The two unapproved vendors default to DISABLED — the honest
    // production setting — never to MOCK.
    expect(active).toContain(
      'VISUAL_GENERATION_DRIVER: ${VISUAL_GENERATION_DRIVER:-DISABLED}',
    )
    expect(active).toContain('TTS_DRIVER: ${TTS_DRIVER:-DISABLED}')
    expect(active).not.toContain('DRIVER:-LOCAL')
    expect(active).not.toContain('DRIVER:-MOCK')
  })

  it('does not guess TRUST_PROXY on an operator’s behalf', () => {
    // Both values are wrong in different ways when guessed; the
    // application preflight requires an explicit decision.
    expect(active).toContain('TRUST_PROXY: ${TRUST_PROXY:-}')
    expect(active).not.toContain('TRUST_PROXY: ${TRUST_PROXY:-false}')
    expect(active).not.toContain('TRUST_PROXY: ${TRUST_PROXY:-true}')
  })

  it('healthchecks READINESS, not liveness', () => {
    // Liveness would keep an instance in rotation while it is
    // misconfigured, and restart-loop it for a fault a restart cannot
    // fix.
    expect(active).toContain('/api/ready')
    expect(active).not.toContain('/api/health')
  })

  it('stops both processes gracefully, and gives the worker longer', () => {
    // A render can be long-running; tearing it out mid-encode wastes
    // the work and consumes a retry.
    expect(active).toContain('stop_grace_period: 30s')
    expect(active).toContain('stop_grace_period: 120s')
  })

  it('adds no queue broker', () => {
    for (const forbidden of ['redis', 'Redis', 'rabbitmq', 'kafka', 'bullmq']) {
      expect(active).not.toContain(forbidden)
    }
  })
})

describe('runtime image', () => {
  const active = withoutComments(dockerfile)

  it('ships the source the worker actually needs to run', () => {
    // TEETH: the image previously carried src/lib only, so
    // `bun run worker:generation` could not resolve a single service.
    expect(active).toContain('COPY --from=build /app/src ./src')
    expect(active).not.toContain('COPY --from=build /app/src/lib ./src/lib')
    // Path aliases (@/…) resolve through tsconfig at runtime.
    expect(active).toContain('tsconfig.json')
  })

  it('ships migrations with the revision that expects them', () => {
    expect(active).toContain('./migrations')
    expect(active).toContain('drizzle.config.ts')
  })

  it('keeps the hardening earlier steps established', () => {
    expect(active).toContain('USER bun')
    expect(active).toContain('--frozen-lockfile')
    expect(active).toContain('STOPSIGNAL SIGTERM')
  })

  it('bakes in no secret', () => {
    for (const forbidden of [
      'SECRET',
      'PASSWORD',
      'ACCESS_KEY',
      'API_KEY',
      'TOKEN',
    ]) {
      expect(active).not.toContain(forbidden)
    }
  })

  it('builds ONE application image, not two', () => {
    const runtimeStages = active
      .split('\n')
      .filter((line) => line.startsWith('FROM ') && line.includes(' AS runtime'))
    expect(runtimeStages).toHaveLength(1)
  })
})

describe('operations documentation', () => {
  const runbook = read('docs/OPERATIONS.md')

  it('states that migrations are never automatic', () => {
    expect(runbook).toContain('never applied automatically')
    expect(packageJson.scripts['db:migrate']).toBe('drizzle-kit migrate')
    // Nothing in the request path migrates.
    const server = read('server.ts')
    expect(server).not.toContain('migrate')
  })

  it('documents backup, restore and an operator verification step', () => {
    expect(runbook).toContain('./scripts/backup-db.sh')
    expect(runbook).toContain('./scripts/restore-db.sh')
    expect(runbook).toContain('THROWAWAY database')
  })

  it('names the outstanding vendor decisions rather than assuming them', () => {
    expect(runbook).toContain('Visual generation vendor')
    expect(runbook).toContain('Speech synthesis vendor')
    expect(runbook).toContain('None approved')
  })

  it('has scripts that print no credential and refuse to back up into the repo', () => {
    const backup = read('scripts/backup-db.sh')
    const restore = read('scripts/restore-db.sh')
    // Asserted against the COMMANDS, not the comments explaining them.
    const backupCode = withoutComments(backup)
    const restoreCode = withoutComments(restore)
    // MYSQL_PWD rather than --password=, because arguments are visible
    // to every other process on the machine through the process list.
    expect(backupCode).toContain('MYSQL_PWD=')
    expect(backupCode).not.toContain('--password=')
    expect(restoreCode).not.toContain('--password=')
    expect(backupCode).toContain('refusing: BACKUP_DIR is inside the repository')
    // A restore is destructive and says so.
    expect(restoreCode).toContain('CONFIRM_RESTORE')
    expect(restoreCode).toContain('sha256')
    for (const source of [backupCode, restoreCode]) {
      expect(source).not.toContain('echo "$DATABASE_PASSWORD"')
    }
  })
})

describe('no forbidden production dependencies', () => {
  it('adds no queue broker, no Kubernetes, no public-media client', () => {
    const names = Object.keys(packageJson.dependencies)
    for (const forbidden of ['ioredis', 'redis', 'bullmq', 'amqplib', 'kafkajs']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('declares the adapters it actually uses', () => {
    const names = Object.keys(packageJson.dependencies)
    expect(names).toContain('@aws-sdk/client-s3')
    expect(names).toContain('@aws-sdk/s3-request-presigner')
    expect(names).toContain('@remotion/renderer')
  })
})
