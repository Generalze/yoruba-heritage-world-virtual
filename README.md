# Yorùbá Heritage World Virtual

**Yorùbá Heritage World Virtual** is a digital prayer and sacred-cultural platform built to support Yorùbá prayer, divination, ancestral connection, Sacred House appointments, personalised recorded Prayer Rooms, daily spiritual practices, offerings, thanksgiving, and future live spiritual services.

## Project Status

🚧 **Development Stage — Architecture & Foundation**

The platform is currently being designed and developed before deployment to a production VPS.

## Core Experience

The platform will provide:

- User registration and private spiritual profiles
- Yorùbá deity profiles
- Sacred House profiles and services
- Sacred House appointment booking
- Secure online payments
- Personalised 90–120 second Recorded Prayer Rooms
- Realistic AI-assisted spiritual visuals
- Approved recorded prayer audio and controlled TTS
- Daily spiritual subscriptions
- Offerings and thanksgiving services
- Administrative content approval
- Roles, permissions and audit logs

## Personalised Prayer Video System

The canonical video pipeline is:

```text
Personalization Engine
        ↓
Approved Spiritual Content
        ↓
Video Recipe + Storyboard
        ↓
┌──────────────────────────────┐
│                              │
Approved Visual Library   Kling / AI Video
│                              │
└──────────────┬───────────────┘
               ↓
       Recorded Audio + TTS
               ↓
            Remotion
               ↓
      90–120 sec Personalised MP4
               ↓
       Private Object Storage
               ↓
           Prayer Room
               ↓
              User
```

## Technical Canon

All development must follow:

**[TECHNICAL_CANON.md](./TECHNICAL_CANON.md)**

The Technical Canon defines the project's architecture, video-generation system, AI boundaries, cultural approval rules, security requirements, cost-control strategy, VPS deployment approach, and development sequence.

Changes that conflict with the Technical Canon should not be implemented unless the canon is deliberately reviewed and updated.

## Getting Started (Development)

Prerequisites: [Bun](https://bun.sh) 1.3+, [Docker](https://www.docker.com/) (for the local database).

```bash
# 1. Configure environment (placeholders only — never commit .env)
cp .env.example .env   # then fill in your local values

# 2. Start the local MariaDB database
docker compose up -d db

# 3. Install dependencies and run the app
bun install
bun run dev            # http://localhost:3000
```

Health check: `GET http://localhost:3000/api/health` reports application and database status.

Useful scripts:

| Command                  | Purpose                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| `bun run dev`            | Development server (port 3000)                                                                       |
| `bun run build`          | Production build (`dist/`)                                                                           |
| `bun run start`          | Run the production build with Bun                                                                    |
| `bun run typecheck`      | Generate routes + TypeScript check                                                                   |
| `bun run lint`           | ESLint                                                                                               |
| `bun run test`           | Unit tests (`bun test`)                                                                              |
| `bun run db:generate`    | Generate Drizzle migrations                                                                          |
| `bun run db:migrate`     | Apply migrations to the database                                                                     |
| `bun run db:seed`        | Seed roles/permissions (idempotent)                                                                  |
| `bun run db:seed:domain` | Seed approved catalogue: deities, Sacred Houses, focus areas, service families, members (idempotent) |

Full stack via Docker (production-style): `docker compose up --build`.

### Authentication development notes

After starting the database, run migrations and the seeds once:

```bash
bun run db:migrate
bun run db:seed          # roles/permissions
bun run db:seed:domain   # approved spiritual-domain catalogue
```

- Registration/login live at `/register` and `/login`; the authenticated
  dashboard is at `/dashboard`.
- Sessions are server-side: the browser holds only an opaque token in an
  HttpOnly cookie, the database stores a SHA-256 hash of it. No
  `SESSION_SECRET` is needed at this stage, so none exists in `.env`.
- The seed creates roles and permissions only — never users or
  passwords. Register through the UI to create a local account.
- `bun test` includes database integration tests and requires the local
  MariaDB container to be running with migrations applied.
- Client IPs are read from the socket by default. Set `TRUST_PROXY=true`
  only when deploying behind a trusted reverse proxy that overwrites
  `X-Forwarded-For`.

### Public catalogue routes

- `/deities` and `/deities/$slug` — published deity profiles
- `/sacred-houses` and `/sacred-houses/$slug` — the four Sacred Houses
  with focus areas, members and service families
- `/services` and `/services/$slug` — service families grouped by
  Sacred House (no prices/durations until approved)
- `/olodumare` — separate page; Olódùmárè is never a deities-table
  record

Only `PUBLISHED` + `active` records appear publicly. The catalogue is
database-driven: seeded records are development data, and authorised
staff manage records through the admin area without code changes.
Appointments are booked with Sacred Houses — individual members are
never bookable.

### Admin catalogue (Step 3.5)

The catalogue admin area lives at `/admin/catalogue` (deities,
sacred-houses, services, plus an Admin-only `review` queue).

- Workflow: `DRAFT → UNDER_REVIEW → APPROVED → PUBLISHED → ARCHIVED`,
  with Admin able to return a submission to DRAFT with a required
  reason. Publishing is only ever possible from APPROVED — for every
  role.
- CONTENT_MANAGER authors and submits; ADMIN (and SUPER_ADMIN) review,
  approve, publish, unpublish and archive.
- Editing substantive content (names, descriptions, focus areas,
  members, deity relationships) on an APPROVED record returns it to
  DRAFT; on a PUBLISHED record it is blocked until unpublished.
- Grant staff roles to an existing registered account with:
  `bun run admin:grant <email> <USER|CONTENT_MANAGER|ADMIN|SUPER_ADMIN>`

### Appointment scheduling foundation (Step 5)

- Booking belongs to the SACRED HOUSE (capacity: one concurrent
  appointment); members are never bookable. The House derives from the
  selected service server-side.
- Admin scheduling at `/admin/scheduling` (per-House booking settings,
  weekly availability in the House's IANA timezone, date exceptions).
  Booking is disabled by default; no hours are seeded.
- Admin operations at `/admin/appointments` (filterable list, detail,
  cancel with reason, reschedule, complete, no-show, private
  representative assignment). No payment controls — confirmation
  belongs to the future verified-payment layer only.
- Appointments store UTC instants plus user/House timezone snapshots
  and commercial snapshots; `PENDING_PAYMENT` holds expire lazily after
  the configured hold and stop blocking availability immediately.
- Statuses: PENDING_PAYMENT, CONFIRMED, CANCELLED, COMPLETED, NO_SHOW,
  EXPIRED. Double-booking is prevented by a per-House row lock
  (`SELECT … FOR UPDATE` on the booking-settings row) around every
  interval allocation.
- Timezone arithmetic uses `@js-temporal/polyfill` (free, local).

### User profile (Step 4)

Self-service profile routes (authenticated, own data only):

- `/profile` — overview and completion status
- `/profile/edit` — personal details (full name, preferred name, phone
  in E.164, ISO country, IANA timezone, language `en`/`yo`, date of
  birth)
- `/profile/spiritual` — private spiritual interests (18 approved
  categories; zero, one or many; never public, never inferred into a
  deity/House)
- `/profile/consents` — required notices (Terms, Privacy, Spiritual
  Service Notice — versioned records) and the optional
  updates/announcements preference

Profile completion is computed server-side (all personal fields +
required consents). Future spiritual-service booking eligibility
additionally requires age ≥ 18, calculated from date of birth at
evaluation time — interests and the optional marketing preference are
never required. Consent versions are development placeholders
(`v1`) in `src/services/profile.ts`; real legal text/versions replace
them before production. The spiritual-interest catalogue seeds with
`bun run db:seed:domain` (idempotent); migration `0003` adds
`user_profiles`, `spiritual_interests`, `user_spiritual_interests`,
`user_consents`.

## Development Principles

- GitHub-first development
- VPS-ready architecture
- Cost-conscious development
- MySQL / MariaDB database
- Background processing for video generation
- Remotion + FFmpeg for final video assembly
- Kling for selected realistic generated scenes
- OpenArt for approved visual-asset development
- Private media storage
- AI provider abstraction
- Sacred and cultural content approval before publication
- AI must not independently invent prayers, rituals, doctrine, or spiritual instructions

## Development Phases

### Phase One

Core platform, appointments, payments, personalised Recorded Prayer Rooms, daily spiritual subscriptions, and administration.

### Phase Two

Live Prayer Rooms, extended services, family/group sessions, and advanced communication.

### Phase Three

Membership, community, and expanded subscription services.

---

**Yorùbá Heritage World Virtual**

_A digital home for Yorùbá prayer, ancestral connection and sacred cultural practice._
