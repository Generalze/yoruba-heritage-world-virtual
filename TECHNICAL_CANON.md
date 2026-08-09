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
