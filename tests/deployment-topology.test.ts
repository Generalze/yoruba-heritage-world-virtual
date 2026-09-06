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

const NEWLINE = String.fromCharCode(10)

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

  it('has exactly the five production services', () => {
    for (const service of ['app:', 'worker:', 'db:', 'caddy:', 'minio:']) {
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

  /** One service's block, ending where the next service begins. */
  function serviceBlock(name: string): string {
    const start = active.indexOf(`${NEWLINE}  ${name}:`)
    expect(start).toBeGreaterThan(-1)
    const rest = active.slice(start + 1)
    const next = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n/)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('publishes host ports from CADDY AND NOTHING ELSE', () => {
    // The rule the whole topology rests on. A published port on a VPS
    // is an open port: 3306 and 9000 are found by scanners within
    // minutes, and a published 3000 bypasses TLS, the proxy's
    // overwritten X-Forwarded-For, and the rate limiting that depends
    // on it. Caddy terminates HTTPS and is the only way in.
    for (const service of ['app', 'worker', 'db', 'minio']) {
      expect(serviceBlock(service)).not.toMatch(/^\s+ports:/m)
    }
    const caddy = serviceBlock('caddy')
    expect(caddy).toMatch(/^\s+ports:/m)
    expect(caddy).toContain("'80:80'")
    expect(caddy).toContain("'443:443'")
    // 3306, 3000, 9000 and 9001 are never published, by any service.
    for (const port of ['3306:3306', '3000:3000', '9000:9000', '9001:9001']) {
      expect(active).not.toContain(port)
    }
  })

  it('caps the render worker so a bad render is not an outage', () => {
    // Remotion is the only part of this system that can take a whole
    // machine with it — and if it does, it takes the web server and
    // the database with it.
    const worker = serviceBlock('worker')
    expect(worker).toContain('limits:')
    expect(worker).toMatch(/cpus:/)
    expect(worker).toMatch(/memory:/)
    expect(active).toContain('REMOTION_CONCURRENCY: ${REMOTION_CONCURRENCY:-1}')
  })

  it('keeps the convenient local ports in a development-only override', () => {
    expect(devCompose).toContain('127.0.0.1:${DATABASE_PORT:-3306}:3306')
    // The app port too, since production now serves it through Caddy
    // and publishes nothing of its own.
    expect(devCompose).toContain('127.0.0.1:${APP_PORT:-3000}:3000')
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

  it('points both processes at the tooling baked into the image', () => {
    expect(active).toContain('FFPROBE_PATH: ${FFPROBE_PATH:-/usr/bin/ffprobe}')
    expect(active).toContain(
      'REMOTION_BROWSER_EXECUTABLE: ${REMOTION_BROWSER_EXECUTABLE:-/usr/bin/chromium}',
    )
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

  it('bakes in the tooling a REAL render needs, rather than downloading it later', () => {
    // TEETH: a browser fetched on first use is a download at the moment
    // of somebody's paid render, into a cache the container user may
    // not be able to write.
    expect(active).toContain('ffmpeg')
    expect(active).toContain('chromium')
    expect(active).toContain('ENV FFPROBE_PATH=/usr/bin/ffprobe')
    expect(active).toContain('ENV REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium')
    // Nothing is fetched from a vendor CDN during the build.
    expect(active).not.toContain('ensureBrowser')
  })

  it('creates and OWNS the shared media path before the user drops', () => {
    // Both processes write there — the app stores approved media, the
    // worker writes render artifacts. A root-only path is a worker that
    // cannot render.
    expect(active).toContain('mkdir -p /app/var/media')
    expect(active).toContain('chown -R bun:bun /app/var')
    const mkdirAt = active.indexOf('chown -R bun:bun /app/var')
    const userAt = active.indexOf('USER bun')
    expect(mkdirAt).toBeGreaterThan(-1)
    expect(mkdirAt).toBeLessThan(userAt)
  })

  it('ships the runtime smoke check', () => {
    expect(active).toContain('COPY --from=build /app/scripts ./scripts')
    expect(packageJson.scripts['smoke:runtime']).toBe(
      'bun run scripts/runtime-smoke.ts',
    )
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
    expect(packageJson.scripts['db:migrate']).toBe('bun run scripts/migrate.ts')
    // Nothing in the request path migrates.
    const server = read('server.ts')
    expect(server).not.toContain('migrate')
  })

  it('documents backup, restore and an operator verification step', () => {
    expect(runbook).toContain('./scripts/backup-db.sh')
    expect(runbook).toContain('./scripts/restore-db.sh')
    expect(runbook).toContain('THROWAWAY database')
  })

  it('records the vendor decisions as SETTLED rather than silently dropping them', () => {
    // Both Step 20 vendor decisions are made now — Kling for visuals,
    // 9jaLingo for speech — and the runbook must say so explicitly,
    // the same way the Remotion provisioning decision is recorded.
    expect(runbook).toContain('Visual generation vendor')
    expect(runbook).toContain('Speech synthesis vendor')
    expect(runbook).toContain('Kling')
    expect(runbook).toContain('9jaLingo')
    expect(runbook).toContain('SETTLED')
    // The list still names what remains genuinely open.
    expect(runbook).toContain('Outstanding — not yet decided')
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

describe('the production migration and backup path', () => {
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  /** TypeScript prose, stripped, so a doc comment explaining a rule
   * can neither trip a guard nor satisfy one. */
  function tsCode(text: string): string {
    return text
      .split(NEWLINE)
      .filter((line) => {
        const t = line.trimStart()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join(NEWLINE)
  }
  const migrateScript = tsCode(read('scripts/migrate.ts'))
  // withoutComments already strips `#` lines, which is what a shell
  // script's prose is.
  const backup = withoutComments(read('scripts/backup-db.sh'))
  const restore = withoutComments(read('scripts/restore-db.sh'))

  it('migrates with a RUNTIME dependency, never a development one', () => {
    // The trap this replaced: `db:migrate` called drizzle-kit, which is
    // a devDependency, while the runtime image installs with
    // `--production`. The command the runbook gave an operator was one
    // the production image could not run — discovered at the moment a
    // schema change is due, on a server, with the site down.
    expect(pkg.scripts['db:migrate']).toBe('bun run scripts/migrate.ts')
    expect(pkg.scripts['db:migrate']).not.toContain('drizzle-kit')
    expect(migrateScript).toContain("from 'drizzle-orm/mysql2/migrator'")
    expect(migrateScript).not.toContain('drizzle-kit')
    // drizzle-orm ships to production; drizzle-kit deliberately does not.
    expect(pkg.dependencies['drizzle-orm']).toBeDefined()
    expect(pkg.devDependencies['drizzle-kit']).toBeDefined()
    expect(pkg.dependencies['drizzle-kit']).toBeUndefined()
    // Generating a migration is still development work, and remains the
    // only thing the kit is needed for.
    expect(pkg.scripts['db:generate']).toContain('drizzle-kit')
  })

  it('ships everything that migration needs into the runtime image', () => {
    // A runner present without its migrations is the same failure in a
    // different place.
    expect(dockerfile).toContain('COPY --from=build /app/migrations ./migrations')
    expect(dockerfile).toContain('COPY --from=build /app/scripts ./scripts')
    expect(dockerfile).toContain('COPY --from=build /app/src ./src')
  })

  it('never applies migrations automatically', () => {
    // A schema change lands when a person decides it lands, having
    // taken a backup first. Nothing may migrate at boot or on request.
    expect(read('server.ts')).not.toContain('migrate')
    expect(read('src/workers/prayer-generation-worker.ts')).not.toContain(
      'migrationsFolder',
    )
    const active = withoutComments(compose)
    expect(active).not.toContain('db:migrate')
  })

  it('backs up THROUGH THE CONTAINER, not through a published port', () => {
    // Production publishes no database port and the host has no MariaDB
    // client — the client exists only inside the database image.
    for (const script of [backup, restore]) {
      expect(script).toContain('compose -f "$COMPOSE_FILE" exec -T')
      expect(script).not.toContain('--host=')
      expect(script).not.toContain('--port=')
      expect(script).not.toContain('127.0.0.1')
      expect(script).not.toContain('DATABASE_HOST')
      expect(script).not.toContain('DATABASE_PORT')
    }
  })

  it('never puts a credential on a host command line', () => {
    // Arguments and host-side environment are readable by every other
    // user on the machine through the process list. The password is
    // resolved INSIDE the container, from the environment it already
    // has, which is why these strings are single-quoted in the source.
    for (const script of [backup, restore]) {
      expect(script).toContain('MYSQL_PWD="$MARIADB_ROOT_PASSWORD"')
      // The host-expanded forms, all absent.
      expect(script).not.toContain('MYSQL_PWD="$DATABASE_PASSWORD"')
      expect(script).not.toContain('--password')
      expect(script).not.toContain('-p$')
      expect(script).not.toContain('echo "$DATABASE_PASSWORD"')
      // And the whole point: the expansion sits inside SINGLE quotes,
      // so the host shell never performs it.
      expect(script).toContain("sh -c '")
    }
  })

  it('assumes sudo docker rather than a docker-group deploy user', () => {
    // The docker group is root-equivalent: any member can bind-mount /
    // into a container and write anywhere. `sudo docker` keeps the
    // privilege visible and audited.
    for (const script of [backup, restore]) {
      expect(script).toContain('DOCKER=${DOCKER:-docker}')
    }
    // The instruction to use sudo lives in the refusal message an
    // operator actually sees when Compose is unreachable.
    expect(read('scripts/backup-db.sh')).toContain('sudo docker')
    expect(read('scripts/restore-db.sh')).toContain('sudo docker')
    expect(read('deploy/bootstrap-vps.sh')).not.toContain('usermod -aG docker')
  })

  it('refuses a backup that is empty, corrupt, or inside the repository', () => {
    // A file that exists is not a backup. Each of these produced a
    // plausible-looking archive that could not be restored.
    expect(backup).toContain('gzip -t "$TARGET"')
    expect(backup).toContain('if [ ! -s "$TARGET" ]')
    expect(backup).toContain('refusing: BACKUP_DIR is inside the repository')
    expect(backup).toContain('.sha256')
  })

  it('READS the env file, and never SOURCES it', () => {
    // `set -a; . .env` executes the file as shell. A value containing
    // spaces or parentheses breaks the script — a Windows browser path
    // did exactly that — and a value containing $(...) would RUN it.
    // Compose parses this file by different rules anyway, so agreeing
    // with the shell is not even correct.
    for (const script of [backup, restore]) {
      expect(script).not.toContain('. "$REPO_ROOT/.env"')
      expect(script).not.toContain('set -a')
      expect(script).toContain('read_env')
    }
  })

  it('keeps the restore deliberately awkward', () => {
    expect(restore).toContain('CONFIRM_RESTORE')
    expect(restore).toContain('RESTORE_INTO')
    // Refuses while the application could be writing into a schema
    // being rebuilt underneath it.
    expect(restore).toContain("for service in app worker")
    expect(restore).toContain('gzip -t "$BACKUP_FILE"')
  })
})
