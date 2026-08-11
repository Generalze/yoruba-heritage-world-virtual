# Operations runbook

Phase One, Step 20. Everything an operator needs to start, stop, migrate,
back up and restore this platform — and the things that are deliberately
NOT automated, with the reason.

Nothing in this document contains a credential, and no command in it
prints one. If you find yourself pasting a password into a shell, stop
and use the `.env` file instead.

---

## 1. Topology

Three containers, from `docker-compose.yml`:

| service  | what it is                          | command                       |
| -------- | ----------------------------------- | ----------------------------- |
| `app`    | web server (SSR pages + `/api`)     | `bun server.ts`               |
| `worker` | autonomous generation pipeline      | `bun run worker:generation`   |
| `db`     | MariaDB 11                          | —                             |

`app` and `worker` run **the same image at the same revision**. They are
built once and tagged `yhwv-app:${APP_REVISION}`; set `APP_REVISION` to
the git SHA you are deploying. A worker one commit behind the app is a
worker enforcing last week's governance rules, which is why this is not
negotiable.

**The database publishes no port.** It is reachable only on the Compose
network. Local development gets the port back explicitly:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
```

That override binds `127.0.0.1:3306` only, never `0.0.0.0`, and is never
used in production.

---

## 2. Configuration and the preflight

Both processes run the SAME production preflight before doing anything:
the app before it binds a port, the worker before it claims a job. A
misconfigured production deployment refuses to start rather than
starting and discovering the problem while somebody's paid appointment
is halfway through the pipeline.

Failures are logged as bounded codes plus the ENVIRONMENT VARIABLE NAME
to set — never a value:

```
[preflight] worker: local_object_storage_forbidden_in_production (set OBJECT_STORAGE_DRIVER)
```

Production requires, at minimum:

- `APP_BASE_URL` — must be `https://`
- `DATABASE_PASSWORD` — non-empty
- `TRUST_PROXY` — **explicitly set**, true or false. There is no safe
  default: off, and every client IP collapses to the proxy's, so rate
  limiting protects nobody; on without a proxy that overwrites
  `X-Forwarded-For`, and any client can forge one to evade the same rate
  limiting. Set it to `true` only when the reverse proxy in front of
  this app overwrites the header.
- `OBJECT_STORAGE_DRIVER=S3` plus its five settings — `LOCAL` is refused
- `OBJECT_STORAGE_ENDPOINT` — a plain HTTPS base URL. No username or
  password, no query, no fragment: each would be silently discarded,
  leaving your intent and the effective configuration different.
- `OBJECT_STORAGE_FORCE_PATH_STYLE=true` — required while Phase One
  delivers media by redirect. Virtual-hosted addressing puts the bucket
  in the HOST, so the signed URL would land on an origin neither the
  Prayer Room’s pin nor the CSP knows about, and every playback would be
  refused.
- `RENDER_DRIVER=REMOTION` — `MOCK` is refused
- `VISUAL_GENERATION_DRIVER` and `TTS_DRIVER` — `MOCK` is refused
- `VISUAL_GENERATION_DRIVER=KLING` additionally requires **all three**
  of `KLING_API_KEY`, `KLING_API_BASE_URL` (plain HTTPS — no
  credentials, query or fragment) and `KLING_ARTIFACT_ORIGINS`
  (comma-separated **bare HTTPS origins** — no paths, no wildcards). A
  gap is a startup refusal (`kling_config_missing` / `kling_endpoint_…`
  / `kling_artifact_…` naming the variable) — never a silent fallback
  to `MOCK` or `DISABLED`. The API key is a secret: server environment
  only, outside Git.
- `TTS_DRIVER=9JALINGO` additionally requires **all four** of
  `NAIJALINGO_API_KEY`, `NAIJALINGO_API_BASE_URL` (plain HTTPS — no
  credentials, query or fragment), `NAIJALINGO_YO_VOICE_ID` and
  `NAIJALINGO_MODEL`. A gap is a startup refusal
  (`naijalingo_config_missing` / `naijalingo_endpoint_…` naming the
  variable) — never a silent fallback to `MOCK` or `DISABLED`. The API
  key is a secret: server environment only, outside Git.

Sessions need **no** `SESSION_SECRET`: they are 256-bit random bearer
tokens stored hashed, so there is nothing to leak or rotate.

### Visual generation: Kling (`VISUAL_GENERATION_DRIVER=KLING`)

The one approved visual adapter (Step 20): Kling API 2.0 text-to-video,
with Kling 3.0 encoded in the endpoint (`POST /text-to-video/kling-3.0`)
— no model id to configure or guess. Submission is asynchronous: the
platform's at-most-once reservation applies unchanged (durable
reservation before the create call, the provider's exact task id
persisted and polled, ambiguous outcomes quarantined as
`provider_outcome_unknown`, zero HTTP-client retries).

Facts an operator should know:

- **Visuals only.** Every request carries `settings.audio: "off"` and
  `multi_shot: false`; an artifact that arrives with an audio stream
  anyway is refused, never shipped. Voice belongs to the TTS/human-
  recording pipeline.
- **Whole seconds, 3–15.** A scene outside Kling's documented duration
  law is refused before the network as a recorded, retryable task
  failure — durations are never silently rounded.
- **Prompts are compiled, not written.** Deterministically from the
  currently approved Visual Bible rules plus safe scene metadata;
  `METADATA_ONLY` content never has its sacred body retrieved, and
  `APPROVED_TEXT_CONTEXT` sends only the exact authorized text. A
  compiled prompt that cannot fit Kling's 3072-char bound is refused —
  approved text is never truncated to fit a vendor.
- **Artifacts download only from `KLING_ARTIFACT_ORIGINS`.** HTTPS,
  exact origins, redirects refused, bounded size, `video/mp4` only;
  bytes are hashed locally and the real duration is measured with
  ffprobe — provider-reported durations are never trusted. Signed
  artifact URLs are never logged.

### Speech synthesis: 9jaLingo (`TTS_DRIVER=9JALINGO`)

The one approved speech adapter (Step 20). 9jaLingo's OpenAI-compatible
`POST /v1/audio/speech` synthesizes **synchronously** — the WAV bytes
come back in the request itself; there is no provider job to poll — and
the platform's at-most-once reservation still applies unchanged: the
task row is durably reserved before the call, a success is recorded
directly as SUCCEEDED, and an ambiguous outcome is quarantined as
`provider_outcome_unknown`, never retried automatically.

Governance facts an operator should know:

- **Yoruba only.** A requirement in any other language is refused
  before the network as a recorded, retryable task failure — the prayer
  is never translated to fit a vendor.
- The approved text is sent **verbatim, exactly once**; the voice and
  model come only from `NAIJALINGO_YO_VOICE_ID` / `NAIJALINGO_MODEL`.
  No reference audio or likeness input exists anywhere in the contract
  — voice cloning is structurally impossible, not merely forbidden.
- Approved **human recordings remain preferred** and are never
  synthesized; a manifest built entirely from them never touches this
  adapter.

### Deliberately reduced capability

`VISUAL_GENERATION_DRIVER=DISABLED` and `TTS_DRIVER=DISABLED` remain
valid production settings for a deployment that does not want a
capability — both stages now also have an approved real adapter
(KLING, 9JALINGO). DISABLED means:

- a job that REQUIRES that work **fails closed** and is recorded as
  failed. It is never silently skipped, because a recording assembled
  without a required scene or voice is missing something a person was
  promised;
- a job that requires neither — approved media for every scene, approved
  human recordings for every voice — runs normally.

The startup log says so:

```
[preflight] worker: reduced capability — visual_generation_disabled, tts_disabled
```

---

## 3. Starting and stopping

```sh
# build both processes from one image
APP_REVISION=$(git rev-parse --short HEAD) docker compose build

# start
APP_REVISION=$(git rev-parse --short HEAD) docker compose up -d

# watch the preflight decide
docker compose logs -f app worker
```

**Stopping is graceful and the grace periods differ on purpose.**
`docker compose stop` sends `SIGTERM`; the app drains in-flight requests
(30s grace) so nobody is cut off mid-booking or mid-webhook, and the
worker finishes its current pipeline pass and closes the pool (120s
grace) because a render can be long-running and tearing it out mid-encode
wastes the work and consumes a retry.

Never `docker compose kill` the worker in normal operation. A hard kill
leaves a lease held; it is recovered automatically after expiry by the
lease sweep, but the job loses one attempt from its bounded budget for
no reason.

### Health endpoints

- `GET /api/health` — **liveness**. "This process is alive." A container
  that is alive but misconfigured should be left alone for you to fix;
  restarting it just reproduces the misconfiguration more often.
- `GET /api/ready` — **readiness**. 200 when the preflight passes, the
  database is reachable, AND — when a real renderer is selected — the
  local render tooling (ffprobe, the baked headless browser) is present.
  503 otherwise. This is what the Docker healthcheck uses and what a
  reverse proxy should use to take an instance out of rotation.

Neither payload contains a credential, host, bucket, endpoint, object
key, path, personal detail or sacred text. Readiness reports issue CODES
only; the variable NAMES stay in the process log, where you already are.

---

## 4. Migrations

**Migrations are never applied automatically.** Not at boot, not at
request time, not by a healthcheck. An application that migrates itself
on startup will, one day, migrate itself during an incident, on a
half-rolled-out revision, twice concurrently.

They ship inside the image, so the exact schema a revision expects is
always present.

```sh
# 1. BACK UP FIRST (§5). Not optional.
./scripts/backup-db.sh

# 2. Inspect what is pending
docker compose run --rm --no-deps app bun run db:migrate --help

# 3. Apply, from the same image as the revision being deployed
APP_REVISION=$(git rev-parse --short HEAD) \
  docker compose run --rm app bun run db:migrate

# 4. Verify
docker compose exec db mariadb -u"$DATABASE_USER" -p"$DATABASE_PASSWORD" \
  "$DATABASE_NAME" -e "SELECT COUNT(*) AS applied FROM __drizzle_migrations;"
```

Order for a schema-changing deploy: **back up → migrate → deploy**. Stop
the worker first if a migration touches generation tables, so no pass is
mid-transaction against a schema that is changing underneath it:

```sh
docker compose stop worker
# migrate
docker compose start worker
```

---

## 5. Backup and restore

Scripts live in `scripts/`. Both read credentials from the environment
and **print none of them**; both refuse to write inside the repository.

### Back up

```sh
BACKUP_DIR=/var/backups/yhwv ./scripts/backup-db.sh
```

Writes `yhwv-<database>-<UTC timestamp>.sql.gz` to `BACKUP_DIR`
(default `/var/backups/yhwv`), with `--single-transaction` so the dump is
consistent without locking the site, then prints the file name and its
SHA-256.

**Backups belong outside Git and off this machine.** The script refuses a
`BACKUP_DIR` inside the working tree. A backup that only exists on the
server it is backing up is not a backup.

The database is not the whole system. Also back up:

- the **private object bucket** — the finished recordings. Use the
  storage provider's own versioning/replication; the application never
  deletes a canonical object, but an operator with credentials can.
- the **`media_data` volume** — approved and intermediate media. The
  approved media is the input the pipeline cannot regenerate.

### Restore

```sh
BACKUP_FILE=/var/backups/yhwv/yhwv-....sql.gz ./scripts/restore-db.sh
```

The script is deliberately awkward: it requires `CONFIRM_RESTORE=yes`,
refuses to run while `app` or `worker` is up, and verifies the archive's
SHA-256 against a `.sha256` sidecar before touching anything.

**Operator verification, every time — a backup you have not restored is
a hypothesis:**

```sh
# 1. Restore into a THROWAWAY database, never production
DATABASE_NAME=yhwv_restore_check ./scripts/restore-db.sh

# 2. Prove it is the schema you expect
docker compose exec db mariadb ... -e "
  SELECT COUNT(*) AS tables_now FROM information_schema.tables
   WHERE table_schema = 'yhwv_restore_check';
  SELECT COUNT(*) AS applied FROM yhwv_restore_check.__drizzle_migrations;"

# 3. Prove it has the data you expect (counts only — never dump content)
docker compose exec db mariadb ... -e "
  SELECT COUNT(*) FROM yhwv_restore_check.appointments;
  SELECT COUNT(*) FROM yhwv_restore_check.prayer_generation_uploads;"

# 4. Drop it
```

Record the date of the last successful verification. An unverified
backup regime fails silently for months and then fails loudly once.

---

## 6. Rendering in production

`RENDER_DRIVER=REMOTION` selects the real compositor.

- **ffprobe and the headless browser are BAKED INTO THE IMAGE** and named
  explicitly (`FFPROBE_PATH=/usr/bin/ffprobe`,
  `REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium`). Nothing is downloaded
  at first render. Verify inside a container, as the unprivileged user:

  ```sh
  # Needs NO payment, storage or database credentials — it checks
  # tooling, not configuration.
  docker compose run --rm --no-deps worker bun run smoke:runtime
  ```

  It proves the shared media path is writable, ffprobe is executable and
  the browser is executable — without downloading or rendering anything.
- **The WORKER gates on it too, before it touches the queue.** In
  production with a real renderer it proves the same capabilities before
  lease recovery and before any pipeline pass, exits non-zero if either
  is missing, and mutates no job or lease on the way out. Readiness
  protects the web tier; this protects the queue.
- **Readiness gates on that tooling.** When `RENDER_DRIVER` selects the
  real engine, `/api/ready` answers 503 if either binary is missing, so a
  deployment that cannot render is taken out of rotation rather than
  accepting bookings it will fail.
- **Approved audio is MEASURED, and the plan GROWS to fit it.** Every
  time-bearing audio source is probed from its verified bytes *before*
  the immutable plan is built, and each segment is reserved at
  `max(plannedSegmentDuration, actualAudioDuration)`. A recording longer
  than its stored duration makes the timeline longer and shifts what
  follows; it is never trimmed, stretched, sped, slowed, looped or
  refused for that reason. A recording that cannot be measured fails
  closed rather than being planned around from a guess.
- **A hold freezes, it never replays.** `HOLD_PREVIOUS` and
  `HOLD_LAST_FRAME` hold the last frame that was actually displayed.

**Smoke test after any render-related change** (the real compositor is
deliberately never invoked by the automated test suite — that would mean
a network download and a non-deterministic render):

```sh
docker compose logs -f worker    # watch one job go RENDERING → UPLOADING → READY
```

Then open the Prayer Room for that appointment as its owner and confirm
the recording plays.

---

## 7. Reverse proxy

Put TLS termination in front of `app` and make the proxy:

- set `X-Forwarded-For` by **overwriting**, never appending a
  client-supplied value — then set `TRUST_PROXY=true`;
- forward `Host` unchanged so `APP_BASE_URL` matching works;
- forward request bodies **byte-for-byte** on `/api/webhooks/*`. Payment
  webhooks are verified by HMAC over raw bytes; a proxy that
  re-serializes JSON breaks every signature.

The app already sends its own security headers (CSP, HSTS in production
over HTTPS, `nosniff`, `Referrer-Policy`, `X-Frame-Options`,
`Permissions-Policy`). Do not duplicate or weaken them at the proxy.

---

## 8. Known-good local development

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
bun run db:migrate
bun run dev
bun run worker:generation      # separate terminal
```

Development runs `OBJECT_STORAGE_DRIVER=LOCAL`, `RENDER_DRIVER=MOCK`,
`VISUAL_GENERATION_DRIVER=MOCK`, `TTS_DRIVER=MOCK` — all four of which
production refuses outright.

### Run migrations BEFORE the test suite on a cold database

Every integration suite calls `migrate()` in its `beforeAll`, which is a
fast no-op once the schema exists. On a **freshly created volume** the
first one to run pays the whole cost — measured at 12–14 seconds on
Docker Desktop for Windows — which exceeds `bun test`'s default 5-second
hook timeout. The hook is killed mid-migration, leaving tables created
but the journal unwritten, and every later suite then fails with
`Table … already exists`.

So on a cold database, migrate first:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
bun run db:migrate      # once — 12–14s on a cold volume
bun test
```

This is a property of the environment, not of the application: the same
failure reproduces on earlier revisions of this repository against the
same cold volume. It is diagnosed here rather than papered over by
loosening a timeout or by making the application migrate itself.

### Test database connection resets

`bun test` occasionally fails mid-run with `ECONNREFUSED 127.0.0.1:3306`
while the container remains `healthy`, `RestartCount=0` and its log shows
`ready for connections`. This is host-side Docker Desktop port-proxy
churn, not application behaviour. Diagnose before assuming otherwise:

```sh
docker inspect --format='health={{.State.Health.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}' \
  yoruba-heritage-world-virtual-db-1
docker logs yoruba-heritage-world-virtual-db-1 | tail
```

If the container is healthy and never restarted, re-run the suite.
**Do not** add retry/reconnect logic to the application to paper over it:
that would hide genuine database unavailability in production, which is
exactly the signal readiness exists to surface.

---

## 9. Outstanding — not yet decided

Named here rather than quietly assumed:

1. ~~Visual generation vendor~~ — SETTLED (Step 20): **Kling**
   (API 2.0 text-to-video, Kling 3.0), `VISUAL_GENERATION_DRIVER=KLING`
   with the `KLING_*` variables. `DISABLED` remains valid where
   generation is not wanted.
2. ~~Speech synthesis vendor~~ — SETTLED (Step 20): **9jaLingo**,
   Yoruba only, `TTS_DRIVER=9JALINGO` with the `NAIJALINGO_*`
   variables. `DISABLED` remains valid where synthesis is not wanted;
   approved human recordings are unaffected either way.
3. ~~Remotion browser provisioning~~ — SETTLED. ffmpeg and chromium are
   installed at image build and named explicitly; nothing is fetched at
   render time. The cost is image SIZE, which is now the open question:
   see "image size" in the Step 20 report.
4. **CSP `script-src`.** Currently requires `'unsafe-inline'` because
   TanStack Start emits inline bootstrap script and serialized router
   state. Moving to nonces or hashes is real work in the framework's
   rendering path and is not claimed as done.
5. **Production media delivery.** Step 18 proxies local storage
   server-side and validates signed reads; with a remote provider, the
   choice between signed redirects (a bounded bearer capability) and full
   server-side proxying — and what revocation each implies — is still
   open.
