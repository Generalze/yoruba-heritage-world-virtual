# Yorùbá Heritage World Virtual — UI Visual Direction

**Status:** Approved visual-direction reference for Phase One frontend implementation  
**Project:** Yorùbá Heritage World Virtual  
**Reference image:** `Yorùbá Heritage World UI Showcase.png`  
**Location:** `docs/design/`

---

## 1. Purpose

This document defines the approved visual direction for the Yorùbá Heritage World Virtual frontend.

The accompanying image:

`docs/design/Yorùbá Heritage World UI Showcase.png`

is a **visual reference only**. It communicates the desired mood, hierarchy, spacing, layout language, palette, navigation style, card treatment, and overall product atmosphere.

It is **not** authoritative for:

- business rules
- prices
- names
- dates
- statistics
- spiritual content
- deity facts
- Sacred House facts
- prayer wording
- ritual instructions
- appointment rules
- payment rules
- provider behavior
- user roles
- generation states
- Prayer Room capabilities

If the image conflicts with `TECHNICAL_CANON.md`, the database/schema, backend services, authorization rules, or current repository behavior, the repository and canon take precedence.

---

## 2. Product Character

The interface should feel:

- premium
- sacred
- culturally rooted
- calm
- trustworthy
- warm
- private
- respectful
- contemporary without becoming generic
- spiritually meaningful without becoming theatrical

Avoid the visual language of:

- generic SaaS dashboards
- neon spirituality
- fantasy gaming
- occult horror
- casino/gambling interfaces
- excessive gold
- excessive ornament
- aggressive gradients
- cluttered traditional-pattern overload
- animation-heavy interfaces

The product should feel like a **modern digital sacred house**, not a technology demo.

---

## 3. Core Visual Identity

### 3.1 Primary palette

Use a restrained palette based on the reference image.

**Warm cream / ivory**
- primary page background
- dashboard workspaces
- form backgrounds
- cards
- quiet content sections

**Deep brown / near-black brown**
- navigation
- sidebars
- immersive sections
- Prayer Room
- footer
- selected feature areas

**Warm muted gold**
- primary accent
- active navigation state
- main CTA buttons
- icon accents
- decorative lines
- selected premium details

**Soft taupe / warm neutral**
- borders
- dividers
- secondary text
- muted controls
- inactive states

Gold must remain an accent. Do not turn large interface areas bright gold.

### 3.2 Design tokens

Use semantic design tokens instead of scattered raw colors.

Example direction:

```css
--background: warm ivory;
--surface: cream;
--surface-elevated: light warm cream;
--foreground: deep brown;
--foreground-muted: warm gray-brown;
--brand-dark: near-black brown;
--brand-gold: muted warm gold;
--border: soft sand/taupe;
--success: restrained green;
--warning: warm amber;
--danger: muted deep red;
```

Exact values may be refined during implementation, but the visual relationship should remain consistent.

---

## 4. Typography

Use typography to separate spiritual/editorial presentation from functional UI.

### Display typography

Use a refined serif for:

- major page titles
- landing hero statements
- spiritual quotations
- selected section headings
- important Prayer Room messaging
- premium brand moments

The serif should feel elegant and readable, not medieval or decorative.

### Interface typography

Use a clean sans-serif for:

- navigation
- forms
- tables
- cards
- labels
- buttons
- status indicators
- dashboards
- administrative interfaces

### Typography rules

- Preserve Yorùbá diacritics correctly.
- Never remove accents for visual convenience.
- Do not use decorative fonts for long passages.
- Maintain strong mobile readability.
- Avoid extremely small dashboard text.
- Maintain clear hierarchy between headings, labels, metadata, and body copy.

---

## 5. Yorùbá Cultural Pattern Language

Use subtle Yorùbá-inspired geometric patterning as an atmospheric layer.

Appropriate uses:

- page-edge background texture
- hero overlays
- section separators
- card corner motifs
- subtle borders
- headers and footers
- Prayer Room framing
- empty states

Patterns must:

- remain subtle
- never compete with content
- not imply an unapproved sacred meaning
- not be labeled as an authentic spiritual symbol without approved source material

Decorative geometry is acceptable. Invented sacred symbolism is not.

---

## 6. Surfaces and Components

### Cards

Cards should generally use:

- warm light backgrounds
- restrained corner radius
- thin warm borders
- soft shadows
- generous internal spacing
- clear content hierarchy

Avoid:

- excessive glassmorphism
- heavy shadows
- neon outlines
- oversized pill styling on every element

### Buttons

**Primary buttons**
- muted gold / warm gold
- dark readable text
- strong but refined
- obvious hover/focus states

**Secondary buttons**
- cream or transparent
- dark or gold border
- subtle hover treatment

**Destructive actions**
- clearly distinct
- must not resemble the primary spiritual/action CTA

### Forms

Forms should feel calm and premium:

- clear labels
- generous spacing
- visible focus states
- accessible validation
- readable error messages
- no placeholder-only labels

### Status indicators

Use compact text badges/chips where useful.

Never rely on color alone. Status text must remain readable.

---

## 7. Navigation

### Public navigation

Use a refined horizontal header on desktop.

Only link to routes that actually exist.

Potential categories, where implemented:

- Home
- Sacred Houses
- Deities / spiritual profiles
- Services
- About / Resources
- Login
- Join / Create Account

### Authenticated user navigation

Use a dark left sidebar inspired by the reference.

Potential destinations should map only to implemented product functionality, such as:

- Dashboard
- Appointments
- My Profile
- Sacred Interests
- Payments
- Prayer Room
- Resources
- Settings

Do not invent empty modules simply because they appear in the reference image.

### Admin navigation

Admin surfaces should use the same design family while remaining clearly administrative.

Normal catalogue/admin operation uses the real existing roles:

- `CONTENT_MANAGER`
- `ADMIN`

`SUPER_ADMIN` is a technical/recovery role, not a routine third editorial role.

---

## 8. Responsive Behavior

Every screen must be designed for:

- desktop
- laptop
- tablet
- mobile

### Mobile principles

- sidebars collapse to a drawer or sheet
- forms stack vertically
- tables become responsive lists/cards where appropriate
- important actions remain reachable
- touch targets remain large enough
- booking steps remain understandable
- primary journeys must not require horizontal scrolling
- Prayer Room remains immersive without hiding essential controls

The desktop reference must not be copied as a fixed-width desktop-only layout.

---

## 9. Accessibility

Frontend implementation must include:

- semantic HTML
- keyboard navigation
- visible focus treatment
- logical tab order
- accessible labels
- sufficient contrast
- text alternatives for meaningful images
- readable error/status states
- reduced-motion consideration
- no important information communicated by color alone

Animation must respect `prefers-reduced-motion`.

---

# 10. Screen Direction

## 10.1 Home / Landing Page

The landing page should be visually inspired by Screen 1 of the reference.

### Desired structure

A strong hero area with:

- brand
- welcoming copy
- one clear primary CTA
- one secondary discovery CTA
- culturally respectful imagery or approved visual assets

Follow with sections such as:

- featured services
- Sacred Houses
- approved spiritual/deity discovery
- cultural education/trust
- privacy/sacred-space reassurance
- footer

### Core product flow

The interface should naturally support:

**Deity/Profile discovery → Sacred House → Service → Appointment**

Do not force deity discovery if the real backend allows direct Sacred House/service discovery.

### Content restrictions

Do not invent:

- fake prices
- deity descriptions
- rituals
- blessings
- spiritual claims
- testimonials
- sacred quotations

Use approved application data or neutral development placeholders.

### Olódùmárè

Olódùmárè must be presented separately and respectfully.

Do **not** render Olódùmárè as a normal deity catalogue card.

---

## 10.2 User Dashboard / Profile Completion

The user dashboard should be inspired by Screen 2.

Use:

- cream workspace
- dark sidebar
- restrained cards
- strong information hierarchy

Possible real sections:

- profile completion
- consent/agreement status
- spiritual interests
- upcoming appointments
- Prayer Room availability
- next actions
- profile summary

Do not fabricate:

- member IDs
- verification states
- locations
- appointments
- statistics

The dashboard must use the authenticated user's actual records.

---

## 10.3 Appointment Booking

The booking interface should be inspired by Screen 3.

The authoritative platform flow remains:

**Sacred House → Service → Appointment → Assigned Representative → Prayer Room**

Appointments are booked with Sacred Houses, never directly with individual representatives.

The UI may visually break booking into steps such as:

- service
- Sacred House
- date/time
- review/payment

but the actual backend contract remains authoritative.

Rules:

- availability comes from the real booking system
- prices come from real service/payment data
- representatives are assigned privately/admin-side
- browser redirects never prove payment success
- payment confirmation must come from authoritative server settlement

Do not invent availability or pricing.

---

## 10.4 Prayer Room

The Prayer Room should borrow the dark, immersive mood of Screen 4.

However, the live-call controls visible in the concept are **not Phase One requirements**.

### Phase One Prayer Room is recorded

Do not implement:

- microphone call control
- camera call control
- live participant tiles
- live conferencing
- end-call controls
- live connection indicators

unless a future approved phase explicitly adds live Prayer Rooms.

### Phase One should include

- secure recorded video player
- appointment/service context
- Sacred House context
- preparation/post-session guidance where approved
- appropriate spiritual-service disclaimer
- locked/preparing/available/unavailable states
- private, focused presentation

Current Prayer Room backend behavior remains authoritative.

Do not add download/share capability unless supported by the backend.

---

## 10.5 Admin Catalogue Dashboard

The admin catalogue should be inspired by Screen 5.

Use:

- dark sidebar
- cream workspace
- clear status summaries
- compact administrative cards
- searchable/filterable tables or lists
- clear review/publish actions

The authoritative content lifecycle is:

`DRAFT`
→ `UNDER_REVIEW`
→ `APPROVED`
→ `PUBLISHED`
→ `ARCHIVED`

Rejection:

`UNDER_REVIEW → DRAFT` with a reason.

Do not replace these states with invented visual-reference labels.

Administrative screens may include real:

- Deity Profiles
- Sacred Houses
- Services
- approved spiritual content
- Visual Bible/content workflow
- publication status

Respect existing RBAC and audit behavior.

---

## 10.6 Content / Generation Monitoring

The generation-monitoring screen should be inspired by Screen 6.

Use a clean operational dashboard showing real generation state and bounded failure information.

The authoritative generation states are:

- `QUEUED`
- `PREPARING`
- `STORYBOARDING`
- `GENERATING_VISUALS`
- `GENERATING_AUDIO`
- `RENDERING`
- `UPLOADING`
- `READY`
- `RETRYING`
- `FAILED`
- `CANCELLED`

Do not replace these with generic labels if doing so hides the actual pipeline state.

The interface should help authorized staff understand:

- current stage
- safe bounded failure code
- timing
- whether operator action is needed

Never expose:

- raw provider error payloads
- API keys
- signed URLs
- sacred text sent to providers
- raw private user details
- internal secrets

---

## 11. Imagery

Imagery should reinforce the premium Yorùbá cultural atmosphere.

Preferred:

- approved photography
- approved generated visuals
- architecture
- textiles
- material culture
- natural environments
- respectful portraits where rights permit
- approved sacred visual language

Do not invent or publish:

- rituals
- sacrifices
- sacred objects
- spiritual clothing rules
- medicines
- herbs
- deity iconography
- religious actions

unless those details are explicitly approved in governed platform content.

---

## 12. Motion

Motion should be subtle.

Suitable:

- restrained fades
- small slide transitions
- card hover elevation
- progress transitions
- loading skeletons
- Prayer Room media transitions

Avoid:

- constant floating animation
- aggressive parallax
- flashing gold
- ceremonial effects implying spiritual meaning
- animations that delay user tasks

---

## 13. Data and Placeholder Policy

The visual showcase contains invented example values.

They must **not** be copied into production code.

Examples include:

- names
- photographs
- dates
- prices
- member IDs
- locations
- percentages
- appointment counts
- catalogue counts
- generation statistics
- job IDs
- timing values
- approval counts
- sample spiritual copy

During development:

- prefer real existing fixtures/seed data
- otherwise use clearly neutral placeholders
- never make fabricated spiritual material appear authoritative

---

## 14. Functional Authority

When implementing any screen, use this order of authority:

1. `TECHNICAL_CANON.md`
2. current backend/database/service contracts
3. current security and authorization rules
4. `UI_VISUAL_DIRECTION.md`
5. `Yorùbá Heritage World UI Showcase.png`

The image controls visual direction only.

It cannot override product behavior.

---

## 15. Implementation Discipline

Frontend work should:

- reuse existing routes/services
- keep backend authorization authoritative
- never expose server secrets in client bundles
- avoid provider logic in React components
- avoid hard-coded business data
- build reusable components
- preserve TypeScript/Tailwind conventions
- maintain responsive behavior
- preserve existing tests
- avoid unrelated backend refactors

If a frontend screen needs data the backend does not safely expose yet, stop and report the missing contract instead of inventing one.

---

## 16. Phase One UI Implementation Order

Recommended sequence:

1. Design system and theme foundation
2. Public landing page
3. Authenticated user shell and dashboard
4. Appointment booking experience
5. Recorded Prayer Room
6. Admin catalogue experience
7. Generation monitoring
8. Responsive/mobile/accessibility refinement
9. End-to-end browser journey verification
10. Launch-readiness polish

Each stage should be reviewed before moving to the next.

---

## 17. Final Design Principle

The interface should make users feel that they are entering a:

**private, dignified, modern Yorùbá sacred digital environment.**

Technology should feel invisible.

Visual beauty is important, but authenticity, privacy, approved spiritual authority, accessibility, and product correctness always come before decoration.
