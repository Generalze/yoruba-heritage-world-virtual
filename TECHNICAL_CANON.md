# TECHNICAL_CANON.md

## Project
**Yorùbá Heritage World Virtual**

## Product Identity
Yorùbá Heritage World Virtual is the technical implementation foundation for the wider **Yorùbá Heritage Sacred House** concept: a secure digital platform for Yorùbá prayer, divination, ancestral connection, sacred cultural practice, Sacred House appointments, recorded Prayer Rooms, daily spiritual subscriptions, offerings, thanksgiving, and later live services and membership.

This document is the **technical canon** for the project. It defines the architecture, engineering constraints, video-generation system, security boundaries, development priorities, and cost-control decisions that should guide implementation.

Where this document conflicts with ad-hoc implementation choices, this canon takes priority unless deliberately amended.

---

# 1. Core Product Rules

The following product rules are locked:

- Users book **Sacred Houses**, not individual prayer warriors, priests, or Babaláwo.
- Sacred Houses privately assign the approved representative or group responsible for an appointment.
- Deity profiles are informational and educational, and may connect users to services and subscriptions.
- Olódùmárè is presented separately and respectfully, not as one equivalent deity among others.
- Daily spiritual subscriptions are a distinct system from appointment bookings.
- Recorded Prayer Rooms are time-gated and linked to confirmed appointments.
- Live Prayer Rooms are a later-phase capability.
- Spiritual instructions, rituals, prayers, herbs, fasting instructions, sacrifices, medicines, restrictions, and culturally sensitive content must **not be invented automatically by AI**.
- Sacred/spiritual content must be entered, reviewed, versioned, and approved by authorised cultural or spiritual leadership before publication or use.
- AI may personalise the presentation and selection of **approved content**, but may not create doctrine or bypass approval rules.

Canonical appointment journey:

```text
Deity Profile
    ↓
Sacred House
    ↓
Service
    ↓
Appointment
    ↓
Internal House Assignment
    ↓
Prayer Room
```

---

# 2. Development Strategy

The project will be developed and perfected in GitHub before final production deployment to a VPS.

Canonical workflow:

```text
Local Development
      ↓
Git Repository
      ↓
GitHub
      ↓
Testing / Staging
      ↓
Production VPS
```

Development should remain inexpensive. Avoid introducing paid managed infrastructure during early development unless it directly improves a core experience.

The primary paid AI expense accepted for the project is **high-quality visual generation through Kling and/or OpenArt-compatible workflows**.

---

# 3. Recommended Core Technology Stack

The project should favour a TypeScript/JavaScript stack that can be developed locally and deployed to a VPS without requiring expensive managed platforms.

Recommended baseline:

```text
Frontend:
React + TypeScript

Application / API:
Node.js-compatible TypeScript server

Database:
MySQL or MariaDB

ORM / Query Layer:
Lightweight typed database layer chosen during implementation

Authentication:
Server-side session-based authentication or equivalent secure implementation

Background Processing:
Database-backed job queue initially

Video Assembly:
Remotion + FFmpeg

AI Visual Generation:
Kling API or equivalent high-quality video-generation provider

Creative Asset Production:
OpenArt as an optional production studio

Storage:
S3-compatible private object storage

Deployment:
Docker / Docker Compose on VPS

Source Control:
GitHub
```

## 3.1 Cost-Control Decision: No Redis Initially

Redis is **not required for the first implementation**.

Use a MySQL/MariaDB-backed job table for:

- video generation jobs
- notification jobs
- appointment reminders
- subscription content scheduling
- retries

Redis may be introduced later only if load, concurrency, or queue performance makes it necessary.

This avoids another service, another failure point, and another monthly cost during early development.

---

# 4. Production VPS Architecture

The VPS should run separate logical processes even if they initially run on the same machine.

```text
                VPS
                 │
     ┌───────────┼───────────┐
     │           │           │
 Web App/API   Worker     Scheduler
     │           │           │
     └───────┬───┴───────┬───┘
             │           │
          Database    External APIs
                         │
             ┌───────────┼────────────┐
             │           │            │
          Kling        TTS       Object Storage
```

The application server must never perform long video rendering synchronously inside normal HTTP requests.

---

# 5. Canonical Personalised Video Architecture

The recorded prayer-video system is a core product capability.

Target duration:

**90 to 120 seconds per personalised recorded prayer video.**

Canonical architecture:

```text
        Personalization Engine
                 │
                 ▼
      Approved Spiritual Content
                 │
                 ▼
       Video Recipe + Storyboard
                 │
        ┌────────┴────────┐
        │                 │
        ▼                 ▼
Approved Visual       Kling / AI Video
Library               Unique Realistic Scenes
        │                 │
        └────────┬────────┘
                 ▼
      Recorded Audio + Dynamic TTS
                 │
                 ▼
              Remotion
                 │
                 ▼
      Unique 90–120 sec MP4
                 │
                 ▼
       Private Object Storage
                 │
                 ▼
             Prayer Room
                 │
                 ▼
                User
```

---

# 6. Visual Realism Is a Core Requirement

Realistic visuals are not decorative. They are a central part of the Prayer Room experience because they are intended to help the participant relate emotionally and visually to the prayer and strengthen participation.

Therefore:

- visual quality is a core product requirement;
- scenes should feel culturally coherent, realistic, reverent, cinematic, and spiritually appropriate;
- AI-generated visuals must follow an approved visual canon;
- the system should not rely on random generic AI imagery.

---

# 7. Where Kling and OpenArt Fit

## 7.1 Kling

Kling, or an equivalent high-quality video generation API, is the **runtime AI visual-generation layer**.

It should generate short realistic scene clips, typically several seconds each.

Kling should **not normally generate one uninterrupted 90–120 second video**.

Instead, the engine generates multiple short scenes that are later assembled by Remotion.

Example:

```text
Scene 1  → 8 seconds
Scene 2  → 10 seconds
Scene 3  → 12 seconds
Scene 4  → 8 seconds
...
```

## 7.2 OpenArt

OpenArt is primarily an **asset-development and experimentation studio**.

Use it to create and refine:

- Sacred House environments
- realistic Yorùbá cultural settings
- symbolic environments
- water and nature imagery
- ceremonial spaces
- approved clothing and visual references
- background footage
- establishing scenes
- visual mood studies

Approved assets may then be stored in the platform's Visual Library.

OpenArt is **not a required runtime dependency**.

## 7.3 Cost-Control Principle

Do not pay to generate every second of every prayer video uniquely.

Preferred composition:

```text
90–120 second final video

≈ 50–80 seconds
approved reusable / reusable-with-variation footage

+

≈ 20–50 seconds
new AI-generated personalised footage

+

unique prayer selection
unique scene order
unique audio
unique subtitles
unique name / service context
unique timing
```

This provides uniqueness without unnecessary AI-video cost.

The exact ratio may vary by service.

---

# 8. Remotion Is the Final Assembly Engine

Remotion is responsible for building the final personalised MP4 from approved and generated assets.

Remotion may combine:

- Kling-generated clips
- approved reusable video clips
- approved still imagery with motion
- recorded prayer audio
- dynamic TTS
- subtitles
- Yorùbá / English text
- Sacred House identity
- transitions
- ambient sound
- music where approved
- participant name
- session/service title
- timed reflection prompts
- call-and-response prompts
- closing screen

Remotion is the **final compositor**, not the spiritual-content authority.

FFmpeg may be used under or alongside Remotion for media processing, encoding, probing, normalisation, and final optimisation.

---

# 9. Canonical 90–120 Second Video Structure

The renderer should support a small number of approved timeline templates rather than inventing a new structure from scratch for every video.

Example template:

```text
0–10 sec
Opening / Sacred House establishing scene

10–25 sec
Preparation / welcome / participant orientation

25–55 sec
Core prayer section one

55–75 sec
Participation / reflection / response section

75–100 sec
Core prayer section two / symbolic visual sequence

100–115 sec
Closing blessing

115–120 sec
Personalised closing / Sacred House identity
```

The exact duration of each segment may vary while total target duration remains 90–120 seconds.

---

# 10. Approved Content Database

AI must select from approved content.

Recommended `content_blocks` fields:

```text
id
type
sacred_house_id
deity_id
service_id
theme
language
stage
duration
text
subtitle_text
audio_asset_id
video_asset_id
repeatable
approved_by
approval_status
version
active
created_at
updated_at
```

Recommended content types:

```text
OPENING
GREETING
HOUSE_INTRO
INVOCATION
PRAYER
CALL_RESPONSE
REFLECTION
CHANT
SILENCE
INSTRUCTION
BLESSING
CLOSING
FOLLOW_UP
```

Content may not be used in production unless:

```text
approval_status = APPROVED
AND
active = true
```

## 10.1 Amendment — Implemented Sacred Runtime Content Library (Phase One, Step 8)

This amendment narrowly refines the conceptual `content_blocks` design above.
The implemented system EXTENDS the existing
`spiritual_content_items` / `spiritual_content_versions` architecture
(Phase One, Step 7) instead of creating a parallel `content_blocks`
approval system.

- **Content domains.** Every spiritual content item carries a
  `content_domain`: `GUIDANCE` (Step 7 appointment preparation/guidance)
  or `SACRED_RUNTIME` (approved sacred blocks for the future autonomous
  Prayer Room engine). The two domains share one workflow implementation
  but never mix: guidance assignment considers only `GUIDANCE`; runtime
  candidate queries consider only `SACRED_RUNTIME`.
- **Sacred runtime content types** (exactly): `OPENING`, `GREETING`,
  `HOUSE_INTRO`, `INVOCATION`, `PRAYER`, `CALL_RESPONSE`, `REFLECTION`,
  `CHANT`, `BLESSING`, `CLOSING`.
- `SILENCE` is NOT sacred text — it belongs to future approved session
  templates/timelines. Preparation, follow-up and instructional guidance
  remain Step 7 `GUIDANCE` content types.
- **Independent gates.** Cultural publication (DRAFT → UNDER_REVIEW →
  APPROVED → PUBLISHED → ARCHIVED) and rights clearance
  (UNREVIEWED / PENDING_REVIEW / CLEARED / RESTRICTED / WITHDRAWN) are
  independent. PUBLISHED does not imply rights-cleared; CLEARED does not
  imply culturally approved. Rights may only be CLEARED on immutable
  (APPROVED or PUBLISHED) text.
- **Runtime eligibility is COMPUTED**, never stored as a status: active
  SACRED_RUNTIME item + PUBLISHED version + sacred profile + digital
  storage authorization + rights CLEARED + access policy
  `PRAYER_ROOM_PRIVATE` + `runtime_enabled` + valid SHA-256 integrity
  hash + supported exact language.
- **Autonomy.** Humans approve content, templates and policies UPSTREAM
  once. Normal Prayer Room operation is autonomous and must NOT require
  human per-appointment approval. AI may later select/orchestrate inside
  approved template/rule boundaries but may never invent doctrine or
  alter approved sacred text.
- **External AI use is governed per sacred version** via
  `external_ai_policy`: `NO_EXTERNAL_AI`, `METADATA_ONLY` (default), or
  `APPROVED_TEXT_CONTEXT` (exact approved text may be supplied as
  context to a future authorized process — never rewritten, translated
  or extended).
- **Integrity.** Every published sacred version is protected by a
  SHA-256 hash (`content_sha256`) over the exact stored UTF-8 body,
  stamped transactionally at publication. Future recipe/render systems
  prove they consume the exact approved text via
  `content_version_id` + `content_sha256`; a mismatch fails closed.
- **Voice.** Human-recorded prayer remains preferred; each sacred
  version carries an explicit `voice_policy`
  (`HUMAN_RECORDED_REQUIRED`, `APPROVED_TTS_ALLOWED`, `TEXT_ONLY`).

## 10.2 Amendment — Approved Prayer Session Templates & Selection Rules (Phase One, Step 9)

Selection is now governed by APPROVED TEMPLATES:

```text
Approved Template (published, immutable, SHA-256-hashed definition)
        ↓ deterministic rules-based selection (seeded, no wall-clock randomness)
Step 8 runtime-eligible sacred content (re-verified at selection time)
        ↓
Validated resolved session plan (ordered slots + exact content versions + hashes)
```

- Humans approve the rules UPSTREAM — session structure (ordered
  CONTENT/SILENCE slots), allowed content (explicitly pinned versions or
  approved eligibility filters with explicit allowed scopes), forbidden
  content-item pairs, repeatability use, and language/duration
  boundaries — through the same DRAFT → UNDER_REVIEW → APPROVED →
  PUBLISHED workflow. Published template versions are immutable; the
  normalized definition (never a JSON blob) is hashed
  (`definition_sha256`) transactionally at publication.
- Runtime operation is AUTONOMOUS: the resolver picks the most specific
  applicable published template (SERVICE → SACRED_HOUSE → PLATFORM,
  then priority, then deterministic `selection_weight` variation),
  selects only currently runtime-eligible sacred content in the exact
  requested language, automatically falls back to another applicable
  published template when content has been withdrawn/disabled, and
  otherwise fails closed (`NO_VALID_TEMPLATE`). There is NO
  per-appointment human approval.
- The same input seed against the same committed database state always
  produces the same resolved plan; different seeds may produce
  different APPROVED combinations.
- AI does not create, translate or alter sacred content or templates;
  future orchestration may only operate inside these approved
  boundaries.

## 10.3 Amendment — Approved Media Asset Library & Visual Bibles (Phase One, Step 10)

The approved media authority layer the future autonomous recipe engine
consumes:

```text
Approved Media (rights + consent + integrity gates)
+
Approved Visual Bible (hashed, human-authored visual canon per House)
→ runtime-eligible media pool
→ Step 11 recipe engine
```

- Media assets (AUDIO/IMAGE/VIDEO) follow the shared human workflow
  (DRAFT → UNDER_REVIEW → APPROVED → PUBLISHED → ARCHIVED); binaries
  live in PRIVATE storage behind a `MediaStorageProvider` abstraction
  (local adapter now, S3-compatible later) with server-generated keys
  and a server-computed SHA-256 of the exact stored bytes.
- Runtime eligibility is COMPUTED per call from independent gates:
  asset active + version PUBLISHED + rights CLEARED + runtime enabled
  + storage object present + byte-hash match + supported type +
  (identifiable person ⇒ consent GRANTED). Hash mismatch or a missing
  object fails closed and is never auto-healed; rights or consent
  withdrawal removes future eligibility immediately. No
  per-appointment media approval exists.
- Human-recorded sacred audio remains PREFERRED: exact links attach a
  PUBLISHED sacred content version to a PUBLISHED media version
  (PRIMARY_AUDIO / ALTERNATE_AUDIO / VISUAL_REFERENCE), and the Step 8
  voice policy governs use — HUMAN_RECORDED_REQUIRED accepts only
  eligible linked HUMAN_RECORDED audio; TEXT_ONLY needs none. No TTS
  exists yet.
- Real-person voice cloning or likeness generation is NEVER implied by
  rights clearance, publication, ordinary consent or
  DERIVATIVE_GENERATION_ALLOWED; `voice_clone_authorized` defaults
  false and requires explicit documented permission.
- Each Sacred House has ONE canonical versioned Visual Bible of
  human-authored ordered rules (environment, symbols, prohibitions,
  negative-prompt guidance, …); published versions carry a
  deterministic definition SHA-256 that the runtime loader re-verifies,
  failing closed on corruption.

## 10.4 Amendment — Validated Video Recipe Engine (Phase One, Step 11)

```text
Approved Session Plan (Step 9)
+ Approved Media (Step 10)
+ Verified Visual Bible
→ Validated Deterministic Video Recipe
→ future generation/render job (Step 12+)
```

- The recipe engine snapshots every render-significant authority:
  context (Service → authoritatively derived House, language, seed),
  template version + definition SHA-256, Visual Bible version + hash
  when used, ordered segments with exact sacred content version +
  content SHA-256, selected media version + file SHA-256, audio mode
  (NONE / HUMAN_RECORDED / LINKED_HUMAN_AUDIO / TTS_ALLOWED_PENDING),
  visual mode (LINKED_REFERENCE / LIBRARY_MEDIA / GENERATION_ALLOWED /
  HOLD_PREVIOUS), external-AI and voice policies, durations, and a
  final canonical `recipeSha256`. Recipes carry NO sacred bodies,
  storage keys, consent references, rights notes or user PII.
- HUMAN_RECORDED_REQUIRED sacred text fails the recipe closed when no
  eligible linked human recording exists; APPROVED_TTS_ALLOWED without
  human audio yields TTS_ALLOWED_PENDING (no TTS exists yet).
  GENERATION_ALLOWED descriptors are safe metadata only, require a
  verified published Visual Bible, and never contain sacred text —
  APPROVED_TEXT_CONTEXT bodies are retrieved server-side by the future
  stage.
- Same service + language + variation seed + committed DB state →
  byte-identical recipe; different seeds may select different APPROVED
  media. No per-session human approval exists.
- `validateVideoRecipe()` re-checks every CURRENT authority (template
  and Visual Bible hashes, sacred/media eligibility and hashes, scope
  and language applicability, voice policy, recipe hash) and fails
  CLOSED with machine-readable reasons the moment any upstream
  authority changes. Nothing is ever auto-healed.

## 10.5 Amendment — Appointment-Bound Generation Orchestration (Phase One, Step 12)

```text
Verified payment
→ CONFIRMED appointment (authoritative CAS)
→ atomic DB generation enqueue (same transaction, lightweight)
→ asynchronous PREPARING worker (DB-backed queue, bounded leases)
→ validated immutable recipe snapshot (append-only, SHA-256 payload)
→ STORYBOARDING
→ future provider pipeline (Step 13+)
```

- ONE generation job per appointment (DB-unique) — payment/webhook
  replays can never duplicate it. The confirmation transaction does
  ONLY: CONFIRMED + guidance assignment + job insertion; recipe
  building, media hashing and provider work never run inside it. The
  guidance language snapshot is the authoritative generation language —
  if it cannot be established, confirmation fails closed.
- The variation seed is the SHA-256 of a versioned canonical string
  (video-v1 | userId | appointmentId | serviceId | startsAtUtc), frozen
  at confirmation; only the hash is ever stored or exposed.
- The queue is DB-backed initially (no Redis/BullMQ): row-locked claims,
  bounded lease tokens, stale-lease recovery to RETRYING, a central
  legal-transition state machine, and a deterministic bounded retry
  schedule (1m/5m/15m/60m/60m) with sanitized machine error codes.
- Recipe snapshots are append-only and immutable; loaders re-verify the
  payload SHA-256 and the embedded recipe hash and fail closed. EVERY
  later generation/render stage must revalidate current authority
  (loadAndValidateGenerationRecipe) before provider work. READY cannot
  be produced in Step 12; no per-session human approval exists; no paid
  providers are called.

## 10.6 Amendment — Deterministic Storyboard & Generation Manifest (Phase One, Step 13)

```text
Validated Recipe Snapshot
→ Deterministic Storyboard (ordered scenes over the approved timeline)
→ Provider-Neutral Generation Manifest (future tasks, no provider chosen)
→ GENERATING_VISUALS
→ future provider executor (Step 14+)
```

- GENERATING_VISUALS means ONLY that a validated manifest exists and is
  ready for the future visual executor. No per-session human approval
  exists at any point.
- 8–12 scenes remains the NORMAL target where the approved duration
  naturally supports it — it is never forced. Planning never pads with
  invented content, never stretches prayer duration to hit a count, and
  never adds spiritual actions, objects, clothing or rituals. Total
  recipe duration is preserved exactly and SILENCE is preserved verbatim
  as HOLD_PREVIOUS. Long CONTENT windows may be split into purely
  PRESENTATIONAL sub-scenes by dividing the existing timeline only. A
  bounded scene ceiling fails loudly rather than truncating silently.
- Planning is provider-neutral: no provider is selected and none is
  called. GENERATION_REQUIRED scenes carry structured, body-free intent
  (House/Service, content type, theme, duration, Visual Bible
  version+hash, approved rule references by identity, external-AI
  policy, content id+hash). Visual Bible rules are referenced by stable
  identity/category/order — sensitive rule text is never copied, and a
  missing rule is never permission to invent.
- Sacred bodies NEVER enter a storyboard or manifest under any policy;
  APPROVED_TEXT_CONTEXT only permits the future stage to retrieve the
  approved text server-side after another authority validation. Audio
  requirements are NONE / EXISTING_HUMAN_AUDIO (the exact approved
  media Step 11 selected) / TTS_PENDING (identity + policy only, never
  speech text) — Step 13 synthesizes nothing.
- Storyboards and manifests are immutable, append-only and canonically
  hashed; loaders fail closed on payload/hash/binding/timeline
  violations and never rebuild or heal. Current authority is
  revalidated before every later generation or render stage, and no
  provider expenditure occurs in Step 13.

## 10.7 Amendment — Visual Generation Executor Foundation (Phase One, Step 14)

```text
GENERATING_VISUALS
→ revalidate manifest against CURRENT authority
→ execute GENERATION_REQUIRED visual tasks (deterministic mock provider)
→ verify + store generated scene artifacts privately
→ GENERATING_AUDIO
→ future audio stage (Step 15+)
```

- Execution is provider-neutral behind a `VisualGenerationProvider`
  abstraction (`submitScene` / `pollScene`, statuses PENDING / COMPLETED
  / FAILED). Only a deterministic mock exists in Phase One: no real
  provider, no network call, no paid execution of any kind. Idempotency
  keys are the ones Step 13 already derived — none is invented here — so
  a repeated submission for the same key is the SAME job, never a
  duplicate paid execution.
- Current authority is revalidated before EVERY provider action, on each
  submit and on each poll, because a task may sit outstanding across
  many worker cycles while rights, content or the Visual Bible change
  underneath it. Withdrawal of authority fails closed before the
  provider is contacted.
- METADATA_ONLY never retrieves the sacred body at all — the eligibility
  query structurally omits the body column rather than fetching and
  ignoring it. APPROVED_TEXT_CONTEXT may retrieve the CURRENT approved
  body server-side, after validation, solely for the in-memory request.
  Visual Bible rule text is likewise in-memory only. Nothing invents
  spiritual actions, objects, clothing, ritual detail or doctrine.
- Persistence carries SAFE metadata only: provider code, opaque provider
  operation id, attempts/status, artifact hash/mime/duration, a private
  internal artifact reference, and bounded sanitized errors and
  timestamps. Sacred bodies, raw provider requests and responses, raw
  Visual Bible rule text and credentials are NEVER persisted or logged.
  Task identity is unique on generation job + manifest snapshot +
  manifest task, with the Step 13 idempotency key unique in its own
  right; approved-media scenes create no task at all.
- Artifacts are validated before they count: allowed mime, non-empty
  bytes, bounded duration and a SHA-256 recomputed from the actual
  stored bytes — a provider-reported hash is never trusted. Storage
  reuses the existing private local media abstraction; no public URL and
  no object store.
- Provider work never happens inside a DB transaction. A poll meaning
  "still processing" releases the lease and becomes due again shortly
  WITHOUT consuming retry budget; a real execution failure uses bounded
  retry with resumeStatus=GENERATING_VISUALS; an expired lease still
  consumes retry budget. Job-level mutations remain lease-gated, and
  task-row writes are compare-and-set on the exact status observed, so a
  stale worker can neither finalize a job nor overwrite a newer worker's
  result.
- GENERATING_VISUALS → GENERATING_AUDIO occurs only when the current
  manifest revalidates VALID, every GENERATION_REQUIRED task SUCCEEDED,
  every stored result passes integrity validation, and approved media
  remains currently valid. A valid manifest with zero generation tasks
  may advance, but only after that same validation. Every status change
  goes through the central generation transition authority.

---

## 10.8 Amendment — Audio Generation & Approved Speech Synthesis (Phase One, Step 15)

```text
GENERATING_AUDIO
→ revalidate manifest against CURRENT authority
→ resolve EXISTING_HUMAN_AUDIO (never synthesized, re-verified in place)
→ execute TTS_PENDING where CURRENT authority still permits it
→ verify + store speech artifacts privately
→ RENDERING
→ future rendering stage (Step 16+)
```

- An approved HUMAN recording of sacred text is NEVER synthesized,
  regenerated or replaced. The exact media version and hash Step 13
  selected is re-resolved and re-proved against present authority —
  rights, runtime enablement, consent, the governing sacred-media link,
  Service/House scope and language — and the private stored object must
  still exist with bytes hashing to the frozen value. It creates no
  provider task of any kind. If it can no longer be validated, the job
  fails closed; synthesis is never a fallback for a withdrawn recording.
- Machine speech is permitted ONLY where the AUTHORITATIVE sacred
  runtime profile still says `APPROVED_TTS_ALLOWED` at the moment of the
  call. `HUMAN_RECORDED_REQUIRED` and `TEXT_ONLY` are refusals, not
  gaps: they fail closed, and a manifest's snapshotted policy can never
  override the current one in either direction.
- Authority is proved in TWO STAGES, and the order is itself a rule.
  Immediately before each submission and each poll, the content version,
  its content hash, its language and its voice policy are revalidated
  from METADATA ONLY — the query does not name the body column at all.
  Only once that proof passes, and only on the submission path, is the
  EXACT approved body retrieved server-side and re-validated against the
  authoritative content hash. A forbidden or withdrawn requirement is
  therefore refused with the sacred body never having been read. Polling
  CONTINUES an existing operation: it re-proves current authority but
  never retrieves, recompiles, resends or rewrites the text.
- The body is spoken verbatim — never rewritten, translated, summarised,
  extended or supplemented with invented prayer. It exists in memory for
  that one call: never persisted, never logged, never returned to the
  caller and never folded into an artifact seed.
- The idempotency key is AUTHORITY, not input. It is always recomputed
  from generation job + manifest hash + requirement id; a caller-supplied
  key is treated as a claim and any mismatch fails closed before a
  provider is contacted, because a well-formed but wrong key would mint
  a second paid synthesis of speech that already exists.
- Before any provider spend, the durable task row must BE the manifest
  requirement it claims: same requirement id, scene, authoritative
  idempotency key and manifest snapshot. A tampered row is refused at
  that gate with zero provider calls, never discovered at finalization
  after the spend.
- NO VOICE OR LIKENESS CLONING. The provider contract carries no speaker
  sample, reference recording or person-derived voice identifier at all,
  so an adapter has nothing to clone from.
- Execution is provider-neutral behind a `TtsProvider` abstraction
  (`submitSpeech` / `pollSpeech`, statuses PENDING / COMPLETED /
  FAILED). Only a deterministic mock exists in Phase One: no real speech
  API, no network call, no paid synthesis. Idempotency is derived from
  generation job + manifest hash + requirement id, so a repeated
  submission for the same key is the SAME job, never a duplicate paid
  synthesis, and a poll is bound to the provider code persisted at
  submission — a provider-code mismatch fails closed rather than asking
  a different backend about an operation it never issued.
- Persistence carries SAFE metadata only: requirement identity,
  idempotency key, provider code, opaque provider operation id,
  attempts/status, artifact hash/mime/duration, a private internal
  artifact reference, and bounded sanitised errors and timestamps.
  Sacred bodies, spoken text, raw provider requests and responses, voice
  samples and credentials are NEVER persisted or logged. Task identity
  is unique on generation job + manifest snapshot + requirement, with
  the idempotency key unique in its own right; human-audio and
  no-audio requirements create no task at all.
- Artifacts are validated before they count: allowed audio mime,
  non-empty bytes, bounded positive duration and a SHA-256 recomputed
  from the actual stored bytes — a provider-reported hash is never
  trusted. Storage reuses the existing private local media abstraction;
  no public URL and no object store.
- Provider work never happens inside a DB transaction. A poll meaning
  "still processing" releases the lease and becomes due again shortly
  WITHOUT consuming retry budget; a real failure uses bounded retry with
  resumeStatus=GENERATING_AUDIO; an expired lease still consumes retry
  budget. Job-level mutations remain lease-gated, task-row writes are
  compare-and-set on the exact status observed, every provider action is
  fenced by a lease heartbeat on both sides, and a result rejected after
  its bytes were stored has that orphan artifact removed.
- GENERATING_AUDIO → RENDERING occurs only when the current manifest
  revalidates VALID, the persisted task rows are exactly the manifest's
  TTS requirements, every one SUCCEEDED with an artifact that still
  verifies against private storage, and every EXISTING_HUMAN_AUDIO
  requirement still validates and is still byte-intact. A valid manifest
  with no audio at all may advance, but only after that same validation.
  Every status change goes through the central generation transition
  authority.
- Step 15 RENDERS NOTHING. It composes, mixes and muxes no media, uses
  no Remotion or FFmpeg, produces no deliverable video and cannot reach
  UPLOADING or READY.

---

## 10.9 Amendment — Render Assembly Engine (Phase One, Step 16)

```text
RENDERING
→ revalidate the CURRENT manifest and every visual/audio source
→ build an immutable deterministic RENDER PLAN (canonical SHA-256)
→ execute it through the engine-neutral RenderEngine boundary
→ verify + store the final artifact in PRIVATE LOCAL storage
→ UPLOADING
→ future delivery stage (Step 17+)
```

- The render plan is IMMUTABLE, append-only and derived ONLY from
  already-approved, already-verified upstream authority: the Step 13
  storyboard/manifest, Step 14's verified visual outputs and approved
  media, and Step 15's verified speech outputs and approved human
  recordings. It carries render-significant SAFE metadata only — ids,
  hashes, timings, bounded machine codes and private local storage
  references — and never sacred body text, spoken text, Visual Bible
  rule text, provider payloads, credentials or personal detail. The
  same authority always produces the same canonical hash, which is what
  makes retry safe and comparison at the final gate meaningful.
- Every storyboard scene resolves EXACTLY ONCE to approved media, a
  verified generated artifact, or a held previous visual. A leading
  HOLD_PREVIOUS — a first scene with no earlier picture to hold — fails
  closed rather than inventing one.
- AUDIO IS NEVER BENT TO FIT. Sacred audio is never truncated,
  time-stretched, sped up, slowed, looped, rewritten or replaced by a
  synthesized substitute. An audio requirement belongs to the FULL
  original recipe segment, so a segment split across several visual
  scenes still carries its recording exactly once. Each segment
  reserves `max(plannedSegmentDuration, verifiedActualAudioDuration)`:
  when the audio is shorter the planned visual window stands and the
  remainder is silent; when it is longer the segment grows by exactly
  the overrun, the final approved visual of that segment is held, and
  every later scene shifts deterministically. Total duration is
  computed from the reconciled timeline — never guessed, never forced
  to a target by altering approved content — under a loud global
  ceiling that FAILS rather than silently truncating.
- Visual sources are fitted without invention, and WHAT a source is
  comes from authoritative asset metadata rather than from whether a
  duration happens to be recorded: an IMAGE is held as a still whatever
  stray duration metadata claims, a VIDEO whose length is unknown FAILS
  CLOSED rather than being guessed at, and a generated scene is always a
  clip with its verified Step 14 length. A shown clip longer than its
  window is trimmed and a shorter one holds its final frame.
  HOLD_PREVIOUS means exactly one thing — freeze the frame last
  DISPLAYED — so it always resolves to a hold and can never become a
  trim or a replay of the earlier footage.
- The rendered output must be the container the plan committed to, not
  merely an allowlisted one, and that binding is re-proved at acceptance
  and again at the final gate.
- Before any render is started, the durable result row must BE this
  job’s result for this manifest snapshot, this render-plan snapshot,
  this plan hash and this idempotency key; a mismatch means zero render
  calls, not a discovery at finalization.
- A worker that has lost its lease writes NOTHING onto the result row
  after render work returns or throws: a stale failure verdict would
  overwrite whatever the newer owner is legitimately doing with that
  row, and the row-status CAS alone cannot tell those two apart.
- SOURCE INTEGRITY IS RE-PROVED, NOT ASSUMED. Immediately before
  planning and again at the final gate, every generated visual must
  trace to its exact successful Step 14 task with intact stored bytes
  and matching SHA-256; every approved media visual must still pass
  current runtime/rights/consent/link/scope authority with bytes
  matching the manifest's frozen hash; every TTS result must trace to
  its exact successful Step 15 task with intact bytes; and every human
  recording goes back through Step 15's own current-authority
  verification. A missing, tampered or withdrawn source means NO
  RENDER — never a substitute and never a partial assembly.
- Rendering happens behind an engine-neutral RenderEngine boundary
  (`render()`), never against a compositor directly. Remotion remains
  the canonical REAL compositor for this platform and plugs into that
  same boundary; such an adapter must be opt-in, must pin every
  `@remotion/*` package to one compatible version, and must never be
  invoked by automated verification. FFmpeg may serve as helper or
  probing infrastructure, never as spiritual authority.
- Phase One ships ONE engine: a deterministic MockRenderEngine, with
  zero network and zero paid calls, whose output is a SHA-256 expansion
  over plan and source HASHES only. It exists because Step 14/15 mock
  artifacts are deliberately synthetic and not decodable media. It is
  unmistakable — `isMock` is persisted on every render result, its
  artifact carries a self-identifying magic header, and a mock engine
  is REFUSED OUTRIGHT when NODE_ENV is production. There is no override.
- An engine composes exactly what the plan says. No subtitles,
  participant-name overlays, titles, watermarks, music, ambient audio,
  invented prompts or new spiritual text are added at this stage unless
  an existing approved authority already supplies them.
- ONE durable render result per job + manifest snapshot + render plan,
  keyed by sha256(job|manifestSha256|renderPlanSha256), so a
  deterministic retry converges on the same row and the same artifact
  instead of producing a second accepted output. Persistence records
  the renderer code/version and mock flag, status/attempts, the plan
  identity/hash, artifact hash/mime/duration and a private LOCAL
  reference — never raw render input.
- Rendering may be long-running: the periodic lease renewal stays
  active throughout, an explicit heartbeat fences the render on both
  sides, the render itself runs outside every DB transaction, and an
  artifact whose result is rejected (lease lost, or a lost status CAS)
  has its orphan bytes removed. A genuine failure uses bounded RETRYING
  with resumeStatus=RENDERING; an expired lease still consumes retry
  budget; a stale worker can never finalize.
- RENDERING → UPLOADING occurs only when the current manifest
  revalidates VALID, the persisted plan still hashes correctly AND is
  still the plan current authority produces, every input source still
  verifies, the render result belongs to this exact job/manifest/plan,
  it SUCCEEDED, its stored artifact exists with a matching SHA-256 and
  the reconciled duration, and the producing renderer is still
  resolvable and permitted in this environment.
- STEP 16 UPLOADS NOTHING. UPLOADING means only that a verified LOCAL
  artifact is ready for Step 17. There is no object store, no public
  URL, no Prayer Room and no delivery of any kind at this stage.

---

## 10.10 Amendment — Private Object Storage & Upload (Phase One, Step 17)

```text
UPLOADING
→ re-prove the EXACT Step 16 render/result/current authority
→ place the verified local bytes at a canonical PRIVATE object key
→ re-prove the remote object against that exact local artifact
→ READY
```

- READY means the generation pipeline's artifact is complete and
  PRIVATELY stored. Step 17 creates NO Prayer Room, exposes NO media,
  adds no public route, and hands no URL — signed or otherwise — to
  anybody. Delivery is a later, separately approved stage.
- Object storage is its own abstraction (`ObjectStorageProvider`),
  deliberately separate from the Step 10 local media provider, so a
  local disk adapter can never silently satisfy a production upload. It
  exposes put/head/get/remove, an integrity verification that must fail
  closed when it cannot prove what it claims, and a short-lived signed
  PRIVATE GET.
- There is NO public exposure in the contract at all: no public-read
  ACL, no public bucket policy, no public URL, no CDN. A signed read URL
  is bounded (15 minutes maximum), is generated by nothing in this
  pipeline, and is never persisted and never logged — the upload row has
  no column one could live in.
- Phase One ships a deterministic LOCAL adapter with zero network for
  development and end-to-end verification, plus the S3-compatible
  production BOUNDARY: a configuration contract, its validation, and a
  fail-closed factory. Production either has a real adapter configured
  or refuses to run the upload stage; it NEVER falls back to local
  storage, and a local provider is refused outright when NODE_ENV is
  production. Endpoint, region, bucket and credentials are environment
  secrets and never appear in a service, a row, an event or a log.
- The destination key is SERVER-GENERATED from an opaque identity:
  `renders/<shard>/<sha256(upload-v1|job|renderResultId|renderPlanSha256|artifactSha256)>.<ext>`.
  No appointment reference, user or house or service name, theme,
  language, timestamp or anything a user typed ever enters an object
  path — a storage listing is not a list of who prayed for what.
- One durable upload row per exact successful render result, unique on
  that identity, on its idempotency key and on the object key. It
  records ids, hashes, the object key, sizes/timings, an opaque provider
  etag/version and bounded codes — never file bytes, a signed URL, a
  credential, sacred body text, spoken text, personal detail or a raw
  provider response.
- A canonical object is CREATED, never overwritten. `putPrivateObject`
  is create-if-absent at the storage layer itself — an exclusive file
  create locally, a conditional create (If-None-Match: * or the
  provider equivalent) for any S3-compatible adapter — because a
  head-then-put leaves a gap another worker can appear in. An object
  that appears in that gap is verified and adopted when byte-identical,
  and fails closed when not; it is never overwritten and never deleted.
- An in-flight upload row is bound to the storage backend it was
  created for. A provider change fails closed before any storage call,
  and the persisted provider identity is re-proved against the resolved
  holding provider at the final gate.
- At the final gate every render-derived field on the upload row is
  bound to the FRESHLY revalidated Step 16 result — plan snapshot, plan
  hash, artifact hash, mime, duration, and a byte size recomputed from
  the local bytes themselves. Remote integrity is proved against those
  authoritative values, never against the upload row's own claims: the
  row is the thing being checked, so it can never also be the thing
  doing the checking.
- CRASH SAFETY BY CANONICAL KEY. "The object is already there" is the
  normal recovery case, not an error: a worker that uploaded and died
  before its database write finds its own object, verifies it byte for
  byte, and records success without a second accepted upload. An object
  at that key whose bytes DIFFER fails closed and is NEVER overwritten.
  For the same reason a stale worker never deletes the canonical
  object — unlike a per-attempt render artifact, that key is shared by
  every attempt, so deleting it could destroy another worker's valid
  upload.
- Before uploading, the ENTIRE Step 16 proof is re-run — the same
  `verifyCompletedRender` function Step 16's own gate uses, not a
  weaker restatement: current manifest, render-plan integrity and
  currency, exact render-result identity, SUCCEEDED status, renderer
  still permitted, and local bytes that still exist and still hash,
  match mime and match duration. The upload row's own identity is then
  proved before any provider call.
- "The provider returned success" is never proof. Before READY the
  remote object must exist at the canonical key, be non-empty, match the
  local artifact's byte size, mime and SHA-256, and be held by the
  expected provider. The local adapter re-reads and rehashes; a
  production adapter must use provider-supported checksum verification
  and fail closed when equivalent integrity cannot be proved. An ETag is
  NEVER accepted as a SHA-256.
- Lease discipline matches every other stage: explicit heartbeat before
  the upload, the upload outside every DB transaction, periodic renewal
  through a long upload, a heartbeat before accepting the result, a
  stale worker that can neither finalize nor write onto a newer owner's
  row, bounded RETRYING with resumeStatus=UPLOADING for genuine
  failures, and retry budget consumed by an expired lease. A retry
  converges on the same row and the same canonical object.
- UPLOADING → READY occurs only when all of the above re-proves a second
  time, the upload row is SUCCEEDED with matching identity, the holding
  provider is still resolvable and permitted, and the private object is
  still intact.

---

## 10.11 Amendment — Recorded Prayer Room Runtime (Phase One, Step 18)

```text
authenticated appointment OWNER
→ appointment-time gate (CURRENT startsAtUtc)
→ generation job READY
→ verifyCompletedUpload()   (the SAME Step 17 proof, re-run)
→ private playback of the recorded prayer
```

- ACCESS IS OWNERSHIP, AND OWNERSHIP ONLY. The browser supplies the
  appointment publicId and nothing else; the server proves an
  authenticated session, that the appointment belongs to that exact
  user, that its status is CONFIRMED or COMPLETED, that the
  appointment has started, that the generation job for it is READY,
  and that the Step 17 upload still verifies. Ownership is expressed
  in the query itself, not applied afterwards.
- STAFF ROLES GRANT NO BYPASS. The access path never asks about roles,
  so an administrator holding every permission in the system still
  cannot open somebody's Prayer Room.
- FAILURE IS NEUTRAL. An unknown appointment, another user’s
  appointment, an unauthenticated caller, a locked room and an
  unverifiable recording all answer with the same shape. A caller can
  never probe for other people's appointments, and an owner is never
  shown a hash, provider code, object key, job or upload id, pipeline
  error or private request note.
- "NOT READY" IS TWO CONDITIONS, NOT ONE. For a playable appointment
  the owner-facing state is:
  - no generation job yet, or one still in flight — QUEUED, PREPARING,
    STORYBOARDING, GENERATING_VISUALS, GENERATING_AUDIO, RENDERING,
    UPLOADING or RETRYING (a bounded retry is not a verdict) —
    **PREPARING**;
  - a generation job in terminal FAILED or CANCELLED — **UNAVAILABLE**.
    A generation that has ended is never described as still being
    prepared: telling that owner to check back later would be an
    untruth they could act on indefinitely;
  - READY before the current appointment start — **LOCKED**;
  - READY at or after it, with the upload still verifying —
    **AVAILABLE**;
  - READY but authority or upload verification fails — **UNAVAILABLE**.

  UNAVAILABLE carries no error code, no stage and no hint about the
  pipeline, and media stays a neutral 404. Any generation status not
  explicitly classified as in-flight is treated as terminal — the
  fail-closed direction — and a test pins that partition against the
  schema enum so a new status must be classified deliberately.
- THE TIME GATE IS THE CURRENT APPOINTMENT START. A recorded Prayer
  Room opens exactly at `appointments.startsAtUtc` as it stands now,
  so rescheduling moves the gate automatically and no stored copy can
  drift out of step. There is deliberately NO automatic closing or
  expiry period: nothing takes away a recording the owner is entitled
  to. PENDING_PAYMENT, CANCELLED, NO_SHOW and EXPIRED never reach a
  recording at all.
- EVERY APPLICATION REQUEST RE-PROVES EVERYTHING. Playback runs the
  shared
  `verifyCompletedUpload()` — the same function Step 17’s own final
  gate uses — on every media request, not once at page load: current
  Step 16 authority, upload identity, canonical object identity,
  provider identity and environment permission, remote existence, byte
  size, MIME and SHA-256. A withdrawal, a tamper or a missing object
  closes the room on the very next byte range requested. Step 18
  regenerates nothing.
- THE MEDIA ENDPOINT IS AUTHENTICATED AND OPAQUE. Media is identified
  by appointment publicId only — there is no parameter for an object
  key, provider, upload or job, so a caller has nothing to aim at. For
  local/test storage the verified bytes are re-hashed against the
  authoritative SHA-256 immediately before they are written to the
  response, then proxied server-side with
  full byte-range support (200, 206 with Content-Range, 416 for an
  unsatisfiable range, Accept-Ranges, correct Content-Type and
  Content-Length, `Cache-Control: private, no-store`,
  `X-Content-Type-Options: nosniff`). No filesystem path, object key or
  provider identity ever appears in a response.
- A REMOTE PROVIDER GETS A SIGNED PRIVATE GET, AFTER THE SAME PROOF —
  AND IT IS A BEARER CAPABILITY. Only once authorization has fully
  passed is a short-lived PRIVATE signed GET created and redirected
  to. What the provider RETURNS is then validated, not assumed: a
  well-formed HTTPS URL with a finite expiry that is in the future and
  no later than the Prayer Room TTL (and therefore inside Step 17’s
  fifteen-minute ceiling). Anything else is refused with no redirect.
  Be precise about what such a link is: once issued, subsequent range
  requests go straight to the provider and do NOT re-run the
  application proof — the expiry is what bounds the capability. That
  is why the TTL is short and the returned value is checked. The URL
  lives in that response alone: never in a database row, never in an
  event, never in a log. No real remote adapter exists yet, so the
  production choice between signed redirects and full server-side
  proxying — and whatever revocation that implies — is left open for a
  later approved stage.
- NO PUBLIC SURFACE. There is no share link, no download control, no
  public route and no direct object URL in page data. Playback is a
  plain HTML video element pointed at the authenticated endpoint.
- NO NEW STATE AND NO NEW CONTENT. Step 18 adds no table: appointment,
  generation job and upload rows already say everything a Prayer Room
  needs, and duplicating them would create a second thing to drift. It
  introduces no spiritual content of its own and displays only safe
  existing snapshots — service name, Sacred House name and the
  scheduled time — under the existing spiritual-service framing.
- Live Prayer Rooms, sharing, subscriptions and any public media route
  remain out of scope at this stage.

---

## 10.12 Amendment — End-to-End Autonomous Pipeline (Phase One, Step 19)

```text
user books
→ verified payment (signed provider event → the ONE settlement path)
→ appointment CONFIRMED + generation job QUEUED, in ONE transaction
→ [ runGenerationPipelinePass(), repeatedly, by an unsupervised worker ]
→ READY private upload
→ time-gated Prayer Room playback
```

- THERE IS NO HUMAN STEP BETWEEN PAYMENT AND READY. No approval queue,
  no operator action, no review. Human authority is spent ONCE and
  UPSTREAM — on the spiritual content, media, templates, rights and
  runtime switches the pipeline is permitted to draw from. The runtime
  only assembles what was already approved, and every stage re-proves
  that authority still holds before it spends anything.
- ONE ORCHESTRATION, SHARED BY PRODUCTION AND TESTS.
  `runGenerationPipelinePass(workerId, clock)` calls the six existing
  stage workers — preparation, storyboard planning, visual generation,
  audio generation, render assembly, private upload — in canonical
  order, once each, and reports bounded outcomes. The worker executable
  calls that same function and nothing else. Before Step 19 the six
  stages met only inside the worker, where no test could reach them, so
  end-to-end coverage necessarily tested an imitation of the pipeline;
  the extraction exists precisely to abolish that.
- THE PASS IS ORCHESTRATION AND NOTHING ELSE. It writes no status, no
  lease and no event; it holds no transition authority and is not a
  second state machine. It does not decide which stage "should" run
  next — it runs all six and lets each stage's own claim query answer.
  It selects no spiritual content, approves nothing, alters no
  immutable snapshot and cannot manufacture a success. Every decision
  remains with the stage that owns it, under the central transition map
  and the same lease CAS as before.
- FAIRNESS BY CONSTRUCTION. Running one cycle of EVERY stage each pass,
  rather than draining whichever stage has work, is what prevents a
  stream of bookings in one stage from starving the others and what
  lets many jobs at different stages progress together.
- LEASE RECOVERY STAYS IN THE WORKER. Recovering another worker's
  abandoned lease is a lifecycle duty of a long-running process, on its
  own slow cadence — not part of doing one unit of pipeline work.
- ONE WORKER EXECUTABLE. `bun run worker:generation`, separate from the
  web server, with graceful SIGTERM/SIGINT shutdown, idle sleeping and
  the DB-backed queue. No second executable, no Redis, no broker.
- FAILURE IS ISOLATED, NEVER PAPERED OVER. A job that current
  governance cannot satisfy fails closed under the EXISTING bounded
  rules (a structural impossibility fails without storming the retry
  budget) and does not delay any other queued appointment. Nothing is
  invented to make a failed job look successful: its Prayer Room reads
  UNAVAILABLE — never AVAILABLE, and never PREPARING either, because
  that generation is over (§10.11).
- IDEMPOTENT AT BOTH ENDS. Replaying a provider webhook cannot produce
  a second settlement or a second generation job (the webhook event key
  and the UNIQUE appointment_id see to that), and further pipeline
  passes over a READY job do nothing at all: no new snapshot, task,
  render, upload or canonical object.
- PRIVACY THROUGH THE WHOLE PIPELINE. Personal details, the private
  request note and the approved sacred body appear in NO generation
  row: not in job events, snapshots, visual or audio task identities,
  render plans, render results or upload rows, and not in the object
  key, which is derived from hashes alone. The approved body stays
  where human authority put it.
- STEP 19 PROVES AUTONOMY, NOT PRODUCTION READINESS. Steps 14–17 still
  run on deterministic mocks and the local private-object adapter, all
  fail-closed in production. Real generation, speech and render
  providers, real object storage, the production media-proxy decision
  and any queue broker remain out of scope at this stage.

---
# 11. Visual Canon Database

Each visual asset should be classified and approved.

Recommended fields:

```text
id
sacred_house_id
deity_id
service_id
theme
asset_type
source_type
file_url
thumbnail_url
duration
prompt_reference
visual_style_id
approved_by
approval_status
version
repeatable
active
created_at
updated_at
```

`source_type` may include:

```text
HUMAN_RECORDED
AI_GENERATED
OPENART_CREATED
KLING_GENERATED
LICENSED
IN_HOUSE
```

---

# 12. Visual Bible

Before large-scale AI generation begins, create a Visual Bible for every Sacred House.

Each Visual Bible should define:

- approved environments
- architectural references
- natural settings
- approved colours
- approved symbols
- approved clothing
- permitted ceremonial objects
- character appearance constraints
- age / gender representation where relevant
- camera style
- lighting
- movement
- atmosphere
- prohibited imagery
- prohibited symbols
- culturally inappropriate combinations
- negative prompt guidance

Generated scenes must remain inside these boundaries.

---

# 13. Personalization Engine

The platform should not depend on Claude or another LLM for every routine video.

Canonical architecture:

```text
          Personalization Engine
                  │
        ┌─────────┴─────────┐
        │                   │
   Rules Engine         AI Assistant
     PRIMARY              OPTIONAL
        │                   │
        └─────────┬─────────┘
                  ▼
        Approved Content
                  │
                  ▼
           Video Recipe
```

The rules engine is primary.

AI is optional and may assist in edge cases or selecting among approved content.

No AI response is trusted automatically.

---

# 14. Video Recipe

Every personalised video must first be represented by a structured recipe.

Example:

```json
{
  "videoType": "PERSONALIZED_RECORDED_PRAYER",
  "durationTargetSeconds": 110,
  "preferredName": "Adunni",
  "language": "en-yo",
  "sacredHouse": "abule_osun",
  "service": "fertility_conception",
  "sessionNumber": 1,
  "scenes": [
    {
      "type": "HOUSE_INTRO",
      "contentId": "OSH-INTRO-002",
      "visualSource": "LIBRARY"
    },
    {
      "type": "PRAYER",
      "contentId": "OSH-FERT-014",
      "visualSource": "KLING"
    },
    {
      "type": "REFLECTION",
      "contentId": "OSH-REFLECT-003",
      "visualSource": "LIBRARY"
    },
    {
      "type": "PRAYER",
      "contentId": "OSH-FERT-021",
      "visualSource": "KLING"
    },
    {
      "type": "CLOSING",
      "contentId": "OSH-CLOSE-007",
      "visualSource": "LIBRARY"
    }
  ]
}
```

The recipe is validated before rendering.

---

# 15. Variation and Uniqueness

Each video should have a deterministic variation seed.

Example:

```text
variation_seed =
hash(
    user_id
    + appointment_id
    + service_id
    + appointment_date
)
```

The seed may influence:

- approved prayer variant
- visual asset selection
- generated-scene prompt variation
- transitions
- ambience
- reflection timing
- opening variation
- closing variation
- subtitle presentation

The same seed should produce predictable results when rebuilding the same video.

---

# 16. User Content History

The system should avoid unnecessary repetition for returning users.

Recommended table:

```text
user_content_history

id
user_id
content_block_id
appointment_id
displayed_at
```

The personalization engine should prefer unseen approved content unless a block is marked `repeatable`.

---

# 17. Sanitised Personalization Context

External AI providers must receive only the minimum data necessary.

Approved example:

```json
{
  "preferredName": "Ade",
  "language": "en-yo",
  "sacredHouse": "aje",
  "service": "business_progress",
  "sessionNumber": 2,
  "approvedTheme": "open_doors"
}
```

Do not send:

- passwords
- phone numbers
- home addresses
- payment records
- card information
- private journal entries
- complete spiritual profile
- private support messages
- unrelated appointment history
- unnecessary date of birth data

---

# 18. Voice and TTS

Recorded human Yorùbá audio should be preferred for sacred prayers, chants, important invocations, and culturally sensitive pronunciation.

Dynamic TTS should mainly support:

- preferred-name insertion
- neutral introductions
- session navigation
- non-sacred connective narration
- approved supporting text

If culturally approved Yorùbá TTS becomes sufficiently reliable, it may be introduced after testing and approval.

Real-person voice cloning or likeness simulation requires explicit documented permission.

---

# 19. Video Generation Job System

Video generation is asynchronous.

Payment confirmation or appointment confirmation creates a job.

Canonical flow:

```text
Payment / Appointment Confirmed
        ↓
Create VideoGenerationJob
        ↓
Gather Sanitised Context
        ↓
Select Approved Content
        ↓
Create Storyboard / Recipe
        ↓
Generate Required AI Visuals
        ↓
Prepare Audio / TTS
        ↓
Render in Remotion
        ↓
Validate Output
        ↓
Upload to Private Storage
        ↓
Attach Video to Appointment
        ↓
Prayer Room Ready
```

Recommended statuses:

```text
QUEUED
PREPARING
STORYBOARDING
GENERATING_VISUALS
GENERATING_AUDIO
RENDERING
UPLOADING
READY
RETRYING
FAILED
CANCELLED
```

---

# 20. Video Generation Job Table

Recommended fields:

```text
id
user_id
appointment_id
sacred_house_id
service_id
template_id
recipe_json
language
voice_id
variation_seed
status
queued_at
generation_started_at
generation_completed_at
final_asset_id
thumbnail_asset_id
duration_seconds
content_version
approval_version
error_code
error_message
retry_count
created_at
updated_at
```

---

# 21. Queue Strategy

For early development and first production release:

Use the relational database itself as the job queue.

Worker behaviour:

```text
1. Poll for QUEUED jobs
2. Lock one job
3. Mark PROCESSING state
4. Execute step
5. Persist progress
6. Retry recoverable failures
7. Mark READY or FAILED
```

Add Redis / BullMQ / equivalent only when load justifies it.

---

# 22. Failure and Fallback Design

The Prayer Room must not fail merely because an AI provider fails.

Fallback behaviour:

```text
If Kling fails:
    substitute approved library visual

If TTS fails:
    use approved recorded alternative

If one generated scene fails:
    replace only that scene

If Remotion render fails:
    retry safely

If upload fails:
    retry upload without regenerating entire video
```

The job system should support step-level retries.

Avoid paying twice for expensive AI generation when only a later processing step fails.

---

# 23. Provider Abstraction

No external provider should be hardcoded throughout the application.

Create provider interfaces such as:

```text
VideoGenerationProvider
TTSProvider
ObjectStorageProvider
PaymentProvider
EmailProvider
AISelectionProvider
```

Example:

```text
VideoGenerationProvider

- generateScene()
- getJobStatus()
- cancelJob()
- estimateCost()
```

This permits future replacement of Kling without rewriting the entire application.

---

# 24. Storage

Final videos should not be permanently stored on the VPS filesystem.

Use private S3-compatible object storage.

Store:

- source video assets
- approved audio
- AI-generated scenes
- final MP4 files
- thumbnails
- subtitle files
- visual references

Prayer Room delivery should use temporary signed access URLs where supported.

The database stores asset metadata and object keys, not large binary files.

---

# 25. Database

Use MySQL or MariaDB to minimise development and VPS operating cost.

Key database domains:

```text
users
sessions
roles
permissions
audit_logs

deities
sacred_houses
sacred_house_members
services

appointments
appointment_assignments
appointment_status_history

content_blocks
content_approvals
visual_assets
audio_assets
video_templates

video_generation_jobs
user_content_history

subscriptions
subscription_content
subscription_history

payments
offerings
thanksgiving_requests

notifications
job_queue
support_requests
```

Use `utf8mb4` throughout for full Yorùbá text support.

---

# 26. Security

Minimum production requirements:

- HTTPS only
- secure server-side sessions
- CSRF protection where applicable
- password hashing with a modern password hashing function
- secure cookies
- rate limiting
- server-side permission checks
- role-based administration
- audit logs
- parameterised SQL / safe query layer
- secrets outside Git
- no raw payment card storage
- private storage for spiritual content
- expiring Prayer Room access
- least-privilege external API credentials
- backup and restore procedures

---

# 27. Secrets

Never commit API keys or passwords.

Use environment variables for:

```text
DATABASE_*
SESSION_SECRET

KLING_API_KEY
OPENART_API_KEY
TTS_API_KEY

OBJECT_STORAGE_ACCESS_KEY
OBJECT_STORAGE_SECRET_KEY

PAYSTACK_SECRET_KEY
PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET
PAYPAL_WEBHOOK_ID
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
CRYPTO_API_KEY
CRYPTO_WEBHOOK_SECRET

EMAIL_*
```

Only publish `.env.example` with placeholders.

---

# 28. Payment Architecture

Payment integrations must be isolated through provider adapters.

Locked providers (Paystack is the preferred Nigeria-facing option;
PayPal and Stripe add international routes where the merchant account
and appointment currency support them; Crypto is part of the provider
architecture but remains disabled in production until a concrete
processor is explicitly approved):

```text
Paystack
PayPal
Stripe
Crypto
```

Payment webhooks must:

- verify provider signatures
- return quickly
- avoid doing expensive video generation synchronously
- create or update database records
- enqueue subsequent processing

Video generation begins only after the platform has verified payment / appointment eligibility.

---

# 29. Prayer Room Access

Recorded Prayer Rooms are private.

Access requires:

```text
authenticated user
AND
matching appointment
AND
appointment status permits access
AND
current time is within allowed window
```

Do not expose permanent public video URLs.

---

# 30. Admin Approval Workflow

All cultural and spiritual content should support:

```text
DRAFT
UNDER_REVIEW
APPROVED
REJECTED
ARCHIVED
```

Important changes should preserve:

- previous version
- approving administrator
- approval timestamp
- reason / note where applicable

A generated Prayer Room recipe must reference the exact approved content version used.

---

# 31. Auditability

Audit logs should capture important actions including:

- user account changes
- role changes
- content creation
- content approval
- service changes
- appointment assignments
- payment updates
- Prayer Room publication
- video-generation retries
- admin overrides
- privacy-sensitive data access

---

# 32. Development Environments

Use at minimum:

```text
LOCAL
STAGING
PRODUCTION
```

During early development, staging may run locally or on a low-cost VPS.

Production should not be the testing environment.

---

# 33. Docker Strategy

Docker Compose is recommended for the first VPS deployment.

Initial services may include:

```text
app
worker
scheduler
mysql
reverse-proxy
```

Object storage may remain external.

Redis should not be added initially unless proven necessary.

---

# 34. Observability Without High Cost

Begin with simple structured logs.

Track:

- HTTP errors
- authentication failures
- payment webhook failures
- generation-job failures
- Kling calls
- Kling cost estimates
- TTS calls
- render time
- upload time
- storage size
- queue depth

Do not pay for a sophisticated monitoring platform before usage requires it.

---

# 35. Cost Tracking Is Mandatory

Every paid AI-generation request should be attributable to a job.

Recommended usage table:

```text
provider_usage

id
job_id
provider
operation
external_request_id
units
estimated_cost
actual_cost
currency
created_at
```

This is particularly important for Kling/OpenArt-related generation.

The admin dashboard should eventually report:

```text
average cost per video
average Kling cost per video
average TTS cost per video
videos generated per day
failed generation cost
reused asset percentage
AI-generated asset percentage
```

---

# 36. Development Cost Policy

During development:

- use mock provider implementations first;
- use local placeholder clips for renderer development;
- use test-mode payments;
- avoid calling Kling for every code test;
- enable real AI generation only for selected integration tests;
- cache generated development scenes;
- reuse test fixtures;
- do not regenerate identical scenes unnecessarily;
- keep development storage small;
- avoid paid managed databases;
- avoid paid Redis;
- avoid cloud rendering until necessary.

This allows the platform to be substantially built and tested before significant AI-video spending begins.

---

# 37. AI Visual Development Mode

Implement:

```text
VIDEO_PROVIDER=mock
```

and:

```text
VIDEO_PROVIDER=kling
```

In development mode, the mock provider returns approved sample clips.

This means UI, queues, timelines, storage, retries, Prayer Room access, and rendering can be developed **without spending Kling credits on every test**.

Real Kling calls should be used only when testing visual-generation quality and production integration.

---

# 38. Rendering Development Mode

Remotion templates should be testable with:

- static local images
- local sample video
- sample audio
- mock TTS
- mock Kling results

No external API should be required just to run ordinary development tests.

---

# 39. Phase One Technical Scope

Phase One should prioritise:

```text
Public website
Accounts / login
User dashboard
Spiritual profile
Deity profiles
Sacred Houses
Sacred House services
Appointments
Payments
Preparation instructions
Recorded Prayer Rooms
Personalised 90–120 sec video engine
Daily spiritual subscriptions
Offerings
Thanksgiving requests
Admin
Content approval
Roles / permissions
Audit logs
Notifications
```

Do not allow Phase Two and Phase Three features to delay the recorded Prayer Room core.

---

# 40. Phase Two

Phase Two may add:

```text
Live Prayer Rooms
Live video
Audio-only sessions
Text sessions
Live divination
Extended sessions
Family sessions
Group sessions
Follow-up sessions
Improved scheduling
Advanced room controls
```

---

# 41. Phase Three

Phase Three may add:

```text
Membership
Community
Family memberships
Gift memberships
Member content
Priority bookings
Bundled subscriptions
Advanced reporting
```

---

# 42. Coding Order

Recommended implementation order:

```text
1. Project foundation
2. Database schema
3. Authentication
4. Roles / permissions
5. Sacred House + deity data model
6. Service catalogue
7. Appointment system
8. Payment abstraction
9. Approved content system
10. Media / asset library
11. Personalization engine
12. Video Recipe schema
13. Mock video provider
14. Remotion renderer
15. Background job worker
16. Private object storage
17. Prayer Room access
18. Kling integration
19. TTS integration
20. Cost tracking
21. Admin video monitoring
22. Subscription engine
23. Notifications
24. Full staging tests
25. VPS production deployment
```

This order intentionally postpones paid AI integration until the rest of the system is capable of using it correctly.

---

# 43. Canonical Operational Principle

The system should be capable of running daily without a developer or Claude manually operating it.

Normal production:

```text
User books / subscribes
        ↓
Platform validates payment
        ↓
Job created
        ↓
Rules engine selects approved content
        ↓
Required visuals generated
        ↓
Audio prepared
        ↓
Remotion renders
        ↓
Video uploaded
        ↓
Prayer Room unlocks
```

Claude or another LLM may assist development and exceptional selection logic, but normal production should not depend on a human developer sitting at the computer.

---

# 44. AI Authority Boundary

AI may:

- select among approved variants;
- generate realistic visual scenes inside the Visual Bible;
- create a validated storyboard using approved assets;
- generate non-sacred supporting narration;
- assist administrators with drafting content that still requires approval.

AI may not:

- create new doctrine;
- create unapproved prayers for production;
- create new sacrifices;
- prescribe herbs;
- prescribe medicines;
- invent fasting requirements;
- create spiritual restrictions;
- invent culturally sensitive rites;
- bypass Sacred House approval;
- impersonate a real religious leader without permission.

---

# 45. Final Canonical Architecture

```text
USER
 │
 ▼
Web Application
 │
 ├──────────────► Authentication / Profile
 │
 ├──────────────► Sacred Houses / Deities
 │
 ├──────────────► Appointments / Subscriptions
 │
 └──────────────► Payments
                      │
                      ▼
               Video Generation Job
                      │
                      ▼
              Personalization Engine
                      │
                      ▼
             Approved Content Database
                      │
                      ▼
               Video Recipe / Storyboard
                      │
          ┌───────────┴────────────┐
          │                        │
          ▼                        ▼
 Approved Visual Library      Kling / AI Video
          │                        │
          └───────────┬────────────┘
                      ▼
           Recorded Audio + TTS
                      │
                      ▼
                   Remotion
                      │
                      ▼
            Personalised 90–120 sec MP4
                      │
                      ▼
             Private Object Storage
                      │
                      ▼
                 Prayer Room
                      │
                      ▼
                     USER
```

---

# 46. Architecture Status

This document is the current locked technical canon.

Changes should be deliberate.

When changing a locked architectural decision:

1. document the reason;
2. assess development cost;
3. assess production cost;
4. assess privacy/security impact;
5. assess cultural/spiritual impact;
6. update this file before implementation.

---

## Current Locked Cost-Conscious Decisions

```text
VPS hosting                     YES
GitHub-first development        YES
MySQL / MariaDB                 YES
Database-backed queue initially YES
Redis initially                 NO
Remotion final assembly         YES
FFmpeg media processing         YES
Kling visual generation         YES
OpenArt asset development       YES / optional runtime
Full AI-generated 2-min video   NO
Hybrid reusable + unique video  YES
Private object storage          YES
AI-generated sacred doctrine    NO
Paid managed infrastructure     MINIMISE
Mock providers in development   REQUIRED
Cost tracking for AI calls      REQUIRED
```

---

**End of Technical Canon**
