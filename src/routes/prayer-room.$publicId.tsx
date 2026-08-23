import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { getCurrentUserFn } from '@/auth/actions'
import { getPrayerRoomStatusFn } from '@/services/prayer-room-actions'
import { formatUtcSqlInTimezone } from '@/lib/display-time'
import {
  SPIRITUAL_SERVICE_NOTICE_BODY,
  SPIRITUAL_SERVICE_NOTICE_PLACEHOLDER,
  SPIRITUAL_SERVICE_NOTICE_TITLE,
} from '@/lib/spiritual-service-notice'
import { BrandMark, Container, PatternDivider, SkipLink } from '@/components/ui'

/**
 * Recorded Prayer Room (Step 18; restyled in Step 21A.5).
 *
 * Owner-only, and proved server-side on every load and on every media
 * request. The page shows the same safe snapshots the appointment page
 * already shows its owner — service, Sacred House, scheduled time — and
 * nothing about how the recording was made: no hashes, no provider, no
 * object key, no job or upload id, no pipeline error, and none of the
 * private request note.
 *
 * There is no share link, no download button and no direct object URL
 * anywhere in this page's data: the <video> element points at the
 * authenticated media endpoint, which re-proves everything.
 *
 * VISUALLY this is the platform's one immersive surface — the dark,
 * quiet mood of Screen 4 — but it is a RECORDED room. Phase One has no
 * live session, so there is deliberately no microphone, camera,
 * participant tile, connection indicator or end-call control here
 * (UI direction §10.4). Navigation out stays visible throughout.
 */
export const Route = createFileRoute('/prayer-room/$publicId')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params }) =>
    getPrayerRoomStatusFn({ data: { publicId: params.publicId } }),
  head: () => ({
    meta: [{ title: 'Prayer Room — Yorùbá Heritage World Virtual' }],
  }),
  component: PrayerRoomPage,
})

function PrayerRoomPage() {
  const status = Route.useLoaderData()
  const { publicId } = Route.useParams()

  if (!status) {
    // Unknown id, or somebody else's appointment: one answer for both.
    return (
      <Shell backLabel="My appointments">
        <div className="mx-auto max-w-xl text-center">
          <PatternDivider onDark />
          <h1 className="font-display mt-8 text-3xl text-cream-on-night">
            Prayer Room
          </h1>
          <p className="mt-4 text-cream-soft-on-night">
            This Prayer Room is not available.
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell backLabel="Appointment" publicId={publicId}>
      <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div>
          <h1 className="font-display text-3xl text-cream-on-night sm:text-4xl">
            {status.serviceName}
          </h1>
          <p className="mt-2 text-sm text-cream-soft-on-night">
            {status.houseName}
          </p>

          <div className="mt-6">
            <PrayerRoomBody state={status.state} publicId={publicId} />
          </div>
        </div>

        <aside className="grid content-start gap-6">
          <NightPanel>
            <h2 className="text-sm font-semibold tracking-wide text-cream-on-night">
              Appointment
            </h2>
            <dl className="mt-4 divide-y divide-night-line text-sm">
              <Row label="Service" value={status.serviceName} />
              <Row label="Sacred House" value={status.houseName} />
              <Row
                label="Date and time"
                value={formatUtcSqlInTimezone(
                  status.startsAtUtc,
                  status.userTimezone,
                )}
              />
              <Row label="Timezone" value={status.userTimezone} />
            </dl>
            <p className="mt-4 text-xs leading-relaxed text-cream-soft-on-night">
              This Prayer Room is private to your account.
            </p>
          </NightPanel>

          <NightPanel>
            <h2 className="text-sm font-semibold tracking-wide text-cream-on-night">
              Preparing for your session
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-cream-soft-on-night">
              Any guidance your Sacred House has prepared for this
              appointment appears with the appointment itself.
            </p>
            <Link
              to="/appointments/$publicId"
              params={{ publicId }}
              className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-gold-bright transition-colors hover:text-cream-on-night"
            >
              View appointment and guidance
              <span aria-hidden="true">→</span>
            </Link>
          </NightPanel>
        </aside>
      </div>

      {/* The EXISTING Spiritual Service Notice, shared verbatim with
          the consent page rather than paraphrased here. */}
      <div className="mt-10 rounded-lg border border-night-line bg-night-raised p-5 text-xs leading-relaxed text-cream-soft-on-night">
        <p className="font-semibold text-cream-on-night">
          {SPIRITUAL_SERVICE_NOTICE_TITLE}
        </p>
        <p className="mt-2">{SPIRITUAL_SERVICE_NOTICE_BODY}</p>
        <p className="mt-2">{SPIRITUAL_SERVICE_NOTICE_PLACEHOLDER}</p>
      </div>
    </Shell>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="text-cream-soft-on-night">{label}</dt>
      <dd className="text-right text-cream-on-night">{value}</dd>
    </div>
  )
}

function NightPanel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-night-line bg-night-raised p-6">
      {children}
    </div>
  )
}

/**
 * The immersive frame: a quiet dark page with a slim header that keeps
 * the way out visible. No live-session chrome of any kind.
 */
function Shell({
  backLabel,
  publicId,
  children,
}: {
  backLabel: string
  /** Present once the appointment is known: the way back points at the
   * appointment itself rather than the whole list. */
  publicId?: string
  children: ReactNode
}) {
  return (
    <div className="texture-night flex min-h-screen flex-col bg-night text-cream-on-night">
      <SkipLink />
      <header className="border-b border-night-line">
        <Container className="flex flex-wrap items-center justify-between gap-4 py-4">
          <div className="flex items-center gap-3">
            <span className="text-gold">
              <BrandMark className="h-7 w-7" />
            </span>
            <span className="leading-tight">
              <span className="font-display block text-base text-cream-on-night">
                Yorùbá Heritage World
              </span>
              <span className="block text-[0.6rem] font-semibold tracking-[0.3em] text-cream-soft-on-night uppercase">
                Prayer Room
              </span>
            </span>
          </div>
          {publicId ? (
            <Link
              to="/appointments/$publicId"
              params={{ publicId }}
              className="inline-flex items-center gap-2 text-sm font-semibold text-gold-bright transition-colors hover:text-cream-on-night"
            >
              <span aria-hidden="true">←</span>
              {backLabel}
            </Link>
          ) : (
            <Link
              to="/appointments"
              className="inline-flex items-center gap-2 text-sm font-semibold text-gold-bright transition-colors hover:text-cream-on-night"
            >
              <span aria-hidden="true">←</span>
              {backLabel}
            </Link>
          )}
        </Container>
      </header>
      <main id="main-content" className="flex-1">
        <Container className="py-10 sm:py-14">{children}</Container>
      </main>
      <footer className="border-t border-night-line">
        <Container className="py-5">
          <p className="text-xs text-cream-soft-on-night">
            Appointments and Prayer Rooms are private to your account.
          </p>
        </Container>
      </footer>
    </div>
  )
}

/** Each state says what it is in words; nothing depends on colour. */
function PrayerRoomBody({
  state,
  publicId,
}: {
  state: 'PREPARING' | 'LOCKED' | 'AVAILABLE' | 'UNAVAILABLE'
  publicId: string
}) {
  if (state === 'AVAILABLE') {
    return (
      <section aria-labelledby="prayer-recording">
        <h2
          id="prayer-recording"
          className="text-xs font-semibold tracking-[0.28em] text-gold-bright uppercase"
        >
          Your recorded prayer
        </h2>
        {/* Plain HTML video against the AUTHENTICATED endpoint. The
            browser never learns where the recording actually lives. */}
        <video
          className="mt-4 w-full rounded-lg border border-night-line bg-black shadow-[0_24px_60px_rgba(0,0,0,0.55)]"
          controls
          controlsList="nodownload"
          preload="metadata"
          src={`/api/prayer-room/${publicId}/media`}
        >
          Your browser cannot play this recording.
        </video>
      </section>
    )
  }

  const copy: Record<
    'LOCKED' | 'PREPARING' | 'UNAVAILABLE',
    { heading: string; body: string }
  > = {
    LOCKED: {
      heading: 'Not open yet',
      body: 'Your Prayer Room opens at the time of your appointment. If you reschedule, it moves with it.',
    },
    PREPARING: {
      heading: 'Being prepared',
      body: 'Your Sacred House is preparing this recording. Please check back a little later.',
    },
    UNAVAILABLE: {
      heading: 'Not available',
      body: 'A recording is not available for this appointment.',
    },
  }
  const { heading, body } = copy[state]

  return (
    <section
      aria-labelledby="prayer-state"
      className="rounded-lg border border-night-line bg-night-raised px-6 py-14 text-center"
    >
      <PatternDivider onDark />
      <h2
        id="prayer-state"
        className="font-display mt-8 text-2xl text-cream-on-night sm:text-3xl"
      >
        {heading}
      </h2>
      <p className="mx-auto mt-4 max-w-md leading-relaxed text-cream-soft-on-night">
        {body}
      </p>
    </section>
  )
}
