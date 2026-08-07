# yoruba-heritage-world-virtual
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
