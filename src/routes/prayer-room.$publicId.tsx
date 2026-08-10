import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { getCurrentUserFn } from '@/auth/actions'
import { getPrayerRoomStatusFn } from '@/services/prayer-room-actions'
import { formatUtcSqlInTimezone } from '@/lib/display-time'

/**
 * Recorded Prayer Room (Phase One, Step 18).
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
 */
export const Route = createFileRoute('/prayer-room/$publicId')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params }) =>
    getPrayerRoomStatusFn({ data: { publicId: params.publicId } }),
  component: PrayerRoomPage,
})

function PrayerRoomPage() {
  const status = Route.useLoaderData()
  const { publicId } = Route.useParams()

  if (!status) {
    // Unknown id, or somebody else's appointment: one answer for both.
    return (
      <Shell>
        <h1 className="text-2xl font-bold">Prayer Room</h1>
        <p className="mt-4 text-sm text-stone-400">
          This Prayer Room is not available.
        </p>
        <Link
          to="/appointments"
          className="mt-6 inline-block text-sm text-stone-400 hover:text-amber-500"
        >
          ← My appointments
        </Link>
      </Shell>
    )
  }

  return (
    <Shell>
      <Link
        to="/appointments/$publicId"
        params={{ publicId }}
        className="text-sm text-stone-400 hover:text-amber-500"
      >
        ← Appointment
      </Link>
      <h1 className="mt-4 text-2xl font-bold">{status.serviceName}</h1>
      <p className="mt-1 text-sm text-stone-400">{status.houseName}</p>
      <p className="mt-1 text-sm text-stone-400">
        {formatUtcSqlInTimezone(status.startsAtUtc, status.userTimezone)} (
        {status.userTimezone})
      </p>

      <section className="mt-8 rounded-lg border border-stone-800 bg-stone-900 p-6">
        <PrayerRoomBody state={status.state} publicId={publicId} />
      </section>

      <p className="mt-6 text-xs leading-relaxed text-stone-500">
        This recording is part of a spiritual service and is provided for
        your personal use. It is private to your appointment and is not a
        substitute for professional medical, legal or financial advice.
      </p>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-2xl">{children}</div>
    </main>
  )
}

function PrayerRoomBody({
  state,
  publicId,
}: {
  state: 'PREPARING' | 'LOCKED' | 'AVAILABLE' | 'UNAVAILABLE'
  publicId: string
}) {
  if (state === 'AVAILABLE') {
    return (
      <>
        <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
          Your recorded prayer
        </h2>
        {/* Plain HTML video against the AUTHENTICATED endpoint. The
            browser never learns where the recording actually lives. */}
        <video
          className="mt-4 w-full rounded-md border border-stone-800 bg-black"
          controls
          controlsList="nodownload"
          preload="metadata"
          src={`/api/prayer-room/${publicId}/media`}
        >
          Your browser cannot play this recording.
        </video>
      </>
    )
  }
  if (state === 'LOCKED') {
    return (
      <>
        <h2 className="text-sm font-medium tracking-widest text-stone-400 uppercase">
          Not open yet
        </h2>
        <p className="mt-3 text-sm text-stone-300">
          Your Prayer Room opens at the time of your appointment. If you
          reschedule, it moves with it.
        </p>
      </>
    )
  }
  if (state === 'PREPARING') {
    return (
      <>
        <h2 className="text-sm font-medium tracking-widest text-stone-400 uppercase">
          Being prepared
        </h2>
        <p className="mt-3 text-sm text-stone-300">
          Your Sacred House is preparing this recording. Please check back a
          little later.
        </p>
      </>
    )
  }
  return (
    <>
      <h2 className="text-sm font-medium tracking-widest text-stone-400 uppercase">
        Not available
      </h2>
      <p className="mt-3 text-sm text-stone-300">
        A recording is not available for this appointment.
      </p>
    </>
  )
}
