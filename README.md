# Yorùbá Heritage World Virtual

**Yorùbá Heritage World Virtual** is a digital prayer and sacred-cultural platform built to support Yorùbá prayer, divination, ancestral connection, Sacred House appointments, personalised recorded Prayer Rooms, daily spiritual practices, offerings, thanksgiving, and future live spiritual services.

## Project Status

🚧 **Development Stage — Architecture & Foundation**

The platform is currently being designed and developed before deployment to a production VPS.

## Core Experience

The platform will provide:

* User registration and private spiritual profiles
* Yorùbá deity profiles
* Sacred House profiles and services
* Sacred House appointment booking
* Secure online payments
* Personalised 90–120 second Recorded Prayer Rooms
* Realistic AI-assisted spiritual visuals
* Approved recorded prayer audio and controlled TTS
* Daily spiritual subscriptions
* Offerings and thanksgiving services
* Administrative content approval
* Roles, permissions and audit logs

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

## Development Principles

* GitHub-first development
* VPS-ready architecture
* Cost-conscious development
* MySQL / MariaDB database
* Background processing for video generation
* Remotion + FFmpeg for final video assembly
* Kling for selected realistic generated scenes
* OpenArt for approved visual-asset development
* Private media storage
* AI provider abstraction
* Sacred and cultural content approval before publication
* AI must not independently invent prayers, rituals, doctrine, or spiritual instructions

## Development Phases

### Phase One

Core platform, appointments, payments, personalised Recorded Prayer Rooms, daily spiritual subscriptions, and administration.

### Phase Two

Live Prayer Rooms, extended services, family/group sessions, and advanced communication.

### Phase Three

Membership, community, and expanded subscription services.

---

**Yorùbá Heritage World Virtual**

*A digital home for Yorùbá prayer, ancestral connection and sacred cultural practice.*
