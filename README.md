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

| Command               | Purpose                             |
| --------------------- | ----------------------------------- |
| `bun run dev`         | Development server (port 3000)      |
| `bun run build`       | Production build (`dist/`)          |
| `bun run start`       | Run the production build with Bun   |
| `bun run typecheck`   | Generate routes + TypeScript check  |
| `bun run lint`        | ESLint                              |
| `bun run test`        | Unit tests (`bun test`)             |
| `bun run db:generate` | Generate Drizzle migrations         |
| `bun run db:migrate`  | Apply migrations to the database    |
| `bun run db:seed`     | Seed roles/permissions (idempotent) |

Full stack via Docker (production-style): `docker compose up --build`.

### Authentication development notes

After starting the database, run migrations and the RBAC seed once:

```bash
bun run db:migrate
bun run db:seed
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
