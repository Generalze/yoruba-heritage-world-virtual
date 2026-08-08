import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { getCurrentUserFn } from '@/auth/actions'
import {
  createReservationFn,
  getBookingContextFn,
  getBookingSlotsFn,
} from '@/services/booking-actions'
import { formatAmountMinor, formatUtcSqlInTimezone } from '@/lib/display-time'

/**
 * User booking page (spec §12/§15). The browser only ever sends the
 * service identity, a server-issued slot start and an optional note —
 * price, duration, House and validity are server authority (Step 5
 * revalidates under the House lock).
 */
export const Route = createFileRoute('/book/$serviceSlug')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params }) =>
    getBookingContextFn({ data: { serviceSlug: params.serviceSlug } }),
  component: BookingPage,
})

interface Slot {
  startsAtUtc: string
  endsAtUtc: string
  houseLocalDate: string
  houseLocalTime: string
}

type BookingContext = Awaited<ReturnType<typeof getBookingContextFn>>
type BookableContext = Extract<BookingContext, { bookable: true }>

function BookingPage() {
  const context = Route.useLoaderData()

  if (!context.bookable) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
        <h1 className="text-2xl font-bold">{context.serviceName}</h1>
        <p className="mt-4 max-w-md text-center text-stone-400">
          This service is not open for online booking at the moment.
        </p>
        <Link
          to="/services"
          className="mt-6 text-amber-500 hover:text-amber-400"
        >
          Back to services
        </Link>
      </main>
    )
  }

  if (!context.eligibility.eligible) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
        <h1 className="text-2xl font-bold">{context.serviceName}</h1>
        <p className="mt-4 max-w-md text-center text-stone-400">
          Your profile is not yet eligible for booking a spiritual service.
          Please complete your profile first.
        </p>
        <Link
          to="/profile"
          className="mt-6 text-amber-500 hover:text-amber-400"
        >
          Go to your profile
        </Link>
      </main>
    )
  }

  return <BookingForm context={context} />
}

function BookingForm({ context }: { context: BookableContext }) {
  const navigate = useNavigate()
  const loadSlots = useServerFn(getBookingSlotsFn)
  const reserve = useServerFn(createReservationFn)

  const [date, setDate] = useState('')
  const [slots, setSlots] = useState<Array<Slot> | null>(null)
  const [selected, setSelected] = useState<Slot | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const userTimezone =
    typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'UTC'

  async function handleLoadSlots(chosenDate: string) {
    setDate(chosenDate)
    setSelected(null)
    setSlots(null)
    setError(null)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(chosenDate)) return
    setBusy(true)
    try {
      const result = await loadSlots({
        data: {
          serviceSlug: context.serviceSlug,
          fromDate: chosenDate,
          toDate: chosenDate,
        },
      })
      setSlots(result)
    } catch {
      setError('Available times could not be loaded. Please try another date.')
    } finally {
      setBusy(false)
    }
  }

  async function handleReserve() {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const reservation = await reserve({
        data: {
          serviceSlug: context.serviceSlug,
          startsAtUtc: selected.startsAtUtc,
          privateRequestNote: note.trim() ? note.trim() : undefined,
        },
      })
      await navigate({
        to: '/checkout/$appointmentPublicId',
        params: { appointmentPublicId: reservation.publicId },
      })
    } catch (reserveError) {
      setError(
        reserveError instanceof Error
          ? reserveError.message
          : 'The reservation could not be created.',
      )
      // The slot may have just been taken — refresh the list.
      if (date) void handleLoadSlots(date)
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <Link
          to="/services"
          className="text-sm text-stone-400 hover:text-amber-500"
        >
          ← All services
        </Link>
        <h1 className="mt-4 text-3xl font-bold">Book: {context.serviceName}</h1>
        <p className="mt-2 text-sm text-stone-400">
          Offered by {context.houseName}
        </p>

        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex gap-3">
            <dt className="text-stone-400">Duration</dt>
            <dd>{context.durationMinutes} minutes</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-stone-400">Price</dt>
            <dd className="font-medium text-amber-400">
              {formatAmountMinor(context.priceMinor, context.currency)}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-stone-400">House timezone</dt>
            <dd>{context.houseTimezone}</dd>
          </div>
        </dl>

        <section className="mt-8 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            1. Choose a date
          </h2>
          <input
            type="date"
            value={date}
            onChange={(event) => void handleLoadSlots(event.target.value)}
            className="mt-4 rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
          />

          {busy && slots === null ? (
            <p className="mt-4 text-sm text-stone-500">Loading times…</p>
          ) : null}
          {slots !== null ? (
            slots.length === 0 ? (
              <p className="mt-4 text-sm text-stone-500">
                No available times on this date. Please try another date.
              </p>
            ) : (
              <>
                <h2 className="mt-6 text-sm font-medium tracking-widest text-amber-500 uppercase">
                  2. Choose a time (shown in your timezone: {userTimezone})
                </h2>
                <div className="mt-4 flex flex-wrap gap-2">
                  {slots.map((slot) => (
                    <button
                      key={slot.startsAtUtc}
                      type="button"
                      onClick={() => setSelected(slot)}
                      className={`rounded-md border px-3 py-2 text-sm transition-colors ${
                        selected?.startsAtUtc === slot.startsAtUtc
                          ? 'border-amber-500 bg-amber-950/40 text-amber-300'
                          : 'border-stone-700 text-stone-300 hover:border-amber-500'
                      }`}
                    >
                      {formatUtcSqlInTimezone(slot.startsAtUtc, userTimezone, {
                        timeStyle: 'short',
                      })}
                    </button>
                  ))}
                </div>
              </>
            )
          ) : null}
        </section>

        {selected ? (
          <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              3. Review and reserve
            </h2>
            <dl className="mt-4 space-y-2 text-sm">
              <div className="flex gap-3">
                <dt className="text-stone-400">Your time</dt>
                <dd>
                  {formatUtcSqlInTimezone(selected.startsAtUtc, userTimezone)}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-stone-400">House local time</dt>
                <dd>
                  {selected.houseLocalDate} {selected.houseLocalTime} (
                  {context.houseTimezone})
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="text-stone-400">Amount due</dt>
                <dd className="font-medium text-amber-400">
                  {formatAmountMinor(context.priceMinor, context.currency)}
                </dd>
              </div>
            </dl>
            <label className="mt-4 block text-sm text-stone-400">
              Private request (optional, seen only by the Sacred House)
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value.slice(0, 1500))}
                rows={4}
                maxLength={1500}
                className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
              />
            </label>
            <button
              type="button"
              onClick={() => void handleReserve()}
              disabled={busy}
              className="mt-4 rounded-md bg-amber-600 px-5 py-2.5 text-sm font-medium text-stone-950 transition-colors hover:bg-amber-500 disabled:opacity-60"
            >
              {busy ? 'Reserving…' : 'Reserve and continue to payment'}
            </button>
            <p className="mt-3 text-xs text-stone-500">
              Your time is held briefly while you complete payment. The
              reservation expires automatically if payment is not completed.
            </p>
          </section>
        ) : null}

        {error ? (
          <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        ) : null}
      </div>
    </main>
  )
}
