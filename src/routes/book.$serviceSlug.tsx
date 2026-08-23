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
import { AppShell } from '@/components/app-shell'
import {
  Card,
  ErrorNotice,
  Field,
  IconArrow,
  Notice,
  StepIndicator,
  buttonClass,
  inputClass,
} from '@/components/ui'
import { formatAmountMinor, formatUtcSqlInTimezone } from '@/lib/display-time'

/**
 * Booking (Step 21A.4), following Screen 3 of the approved reference:
 * a stepped workspace with a live summary beside it.
 *
 * The browser only ever sends the service identity, a SERVER-ISSUED
 * slot start and an optional note — price, duration, House and
 * validity are server authority (Step 5 revalidates under the House
 * lock). Availability and price are never computed or guessed here:
 * every slot shown came from the server, and an amount is only ever
 * the snapshot the server returned.
 */
export const Route = createFileRoute('/book/$serviceSlug')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params, context }) => ({
    user: context.user,
    booking: await getBookingContextFn({
      data: { serviceSlug: params.serviceSlug },
    }),
  }),
  head: () => ({
    meta: [{ title: 'Book an appointment — Yorùbá Heritage World Virtual' }],
  }),
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

const BOOKING_STEPS = [
  'Service',
  'Date and time',
  'Review',
  'Payment',
] as const

function BookingPage() {
  const { user, booking } = Route.useLoaderData()

  if (!booking.bookable) {
    return (
      <AppShell userName={user.preferredName}>
        <h1 className="font-display text-3xl text-ink sm:text-4xl">
          {booking.serviceName}
        </h1>
        <div className="mt-6 max-w-2xl">
          <Notice>
            This service is not open for online booking at the moment.
          </Notice>
          <div className="mt-5">
            <Link to="/services" className={buttonClass('secondary', 'md')}>
              Back to services
            </Link>
          </div>
        </div>
      </AppShell>
    )
  }

  if (!booking.eligibility.eligible) {
    return (
      <AppShell userName={user.preferredName}>
        <h1 className="font-display text-3xl text-ink sm:text-4xl">
          {booking.serviceName}
        </h1>
        <div className="mt-6 max-w-2xl">
          <Notice tone="caution">
            Your profile is not yet eligible for booking a spiritual service.
            Please complete your profile first.
          </Notice>
          <div className="mt-5">
            <Link to="/profile" className={buttonClass('primary', 'md')}>
              Go to your profile
              <IconArrow />
            </Link>
          </div>
        </div>
      </AppShell>
    )
  }

  return <BookingForm userName={user.preferredName} context={booking} />
}

function BookingForm({
  userName,
  context,
}: {
  userName: string
  context: BookableContext
}) {
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

  const amount = formatAmountMinor(context.priceMinor, context.currency)

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
    <AppShell userName={userName}>
      <header>
        <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
          Book an appointment
        </p>
        <h1 className="font-display mt-2 text-3xl text-ink sm:text-4xl">
          {context.serviceName}
        </h1>
        <p className="mt-2 text-sm text-ink-soft">
          Offered by {context.houseName}
        </p>
      </header>

      {/* The stepper sits on its own dark band, as in the reference */}
      <nav
        aria-label="Booking progress"
        className="texture-night mt-6 rounded-lg border border-night-line bg-night px-5 py-4"
      >
        <StepIndicator
          steps={BOOKING_STEPS}
          current={selected ? 2 : 1}
        />
      </nav>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="grid gap-6">
          <Card>
            <h2 className="text-sm font-semibold tracking-wide text-ink">
              Choose a date
            </h2>
            <div className="mt-4 max-w-xs">
              <Field
                label="Appointment date"
                hint={`Times are offered in the Sacred House timezone (${context.houseTimezone}) and shown in yours.`}
              >
                <input
                  type="date"
                  value={date}
                  onChange={(event) => void handleLoadSlots(event.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>

            {busy && slots === null ? (
              <p className="mt-5 text-sm text-ink-soft">Loading times…</p>
            ) : null}

            {slots !== null ? (
              slots.length === 0 ? (
                <div className="mt-5">
                  <Notice>
                    No available times on this date. Please try another date.
                  </Notice>
                </div>
              ) : (
                <div className="mt-6">
                  <h3 className="text-sm font-semibold tracking-wide text-ink">
                    Choose a time
                  </h3>
                  <p className="mt-1 text-xs text-ink-soft">
                    Shown in your timezone ({userTimezone}).
                  </p>
                  <ul className="mt-4 flex flex-wrap gap-2">
                    {slots.map((slot) => {
                      const isSelected =
                        selected?.startsAtUtc === slot.startsAtUtc
                      return (
                        <li key={slot.startsAtUtc}>
                          <button
                            type="button"
                            onClick={() => setSelected(slot)}
                            aria-pressed={isSelected}
                            className={`rounded-md border px-4 py-2 text-sm transition-colors ${
                              isSelected
                                ? 'border-gold-deep bg-surface font-semibold text-ink'
                                : 'border-line-strong text-ink hover:border-gold-deep hover:text-gold-deep'
                            }`}
                          >
                            {formatUtcSqlInTimezone(
                              slot.startsAtUtc,
                              userTimezone,
                              { timeStyle: 'short' },
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            ) : null}
          </Card>

          {selected ? (
            <Card>
              <h2 className="text-sm font-semibold tracking-wide text-ink">
                Review and reserve
              </h2>
              <dl className="mt-4 divide-y divide-line text-sm">
                <div className="flex justify-between gap-4 py-2.5">
                  <dt className="text-ink-soft">Your time</dt>
                  <dd className="text-right text-ink">
                    {formatUtcSqlInTimezone(selected.startsAtUtc, userTimezone)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 py-2.5">
                  <dt className="text-ink-soft">Sacred House local time</dt>
                  <dd className="text-right text-ink">
                    {selected.houseLocalDate} {selected.houseLocalTime} (
                    {context.houseTimezone})
                  </dd>
                </div>
              </dl>

              <div className="mt-5">
                <Field
                  label="Private request (optional)"
                  hint="Seen only by the Sacred House."
                >
                  <textarea
                    value={note}
                    onChange={(event) =>
                      setNote(event.target.value.slice(0, 1500))
                    }
                    rows={4}
                    maxLength={1500}
                    className={inputClass}
                  />
                </Field>
              </div>

              <div className="mt-5">
                <ErrorNotice message={error} />
              </div>

              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => void handleReserve()}
                  disabled={busy}
                  className={`${buttonClass('primary', 'md')} disabled:cursor-not-allowed disabled:opacity-60`}
                >
                  {busy ? 'Reserving…' : 'Reserve and continue to payment'}
                  {busy ? null : <IconArrow />}
                </button>
                <p className="mt-3 text-xs leading-relaxed text-ink-soft">
                  Your time is held briefly while you complete payment. The
                  reservation expires automatically if payment is not
                  completed.
                </p>
              </div>
            </Card>
          ) : null}

          {!selected && error ? <ErrorNotice message={error} /> : null}
        </div>

        {/* Summary — every figure is the server's snapshot */}
        <Card>
          <h2 className="text-sm font-semibold tracking-wide text-ink">
            Booking summary
          </h2>
          <dl className="mt-4 divide-y divide-line text-sm">
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Service</dt>
              <dd className="text-right text-ink">{context.serviceName}</dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Sacred House</dt>
              <dd className="text-right text-ink">{context.houseName}</dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Duration</dt>
              <dd className="text-right text-ink">
                {context.durationMinutes} minutes
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Selected time</dt>
              <dd className="text-right text-ink">
                {selected
                  ? formatUtcSqlInTimezone(selected.startsAtUtc, userTimezone)
                  : 'Not chosen yet'}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-3">
              <dt className="font-semibold text-ink">Amount</dt>
              <dd className="font-display text-right text-lg text-ink">
                {amount}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs leading-relaxed text-ink-soft">
            Appointments are booked with {context.houseName}, never with an
            individual member. The Sacred House privately assigns the members
            responsible for your appointment.
          </p>
        </Card>
      </div>
    </AppShell>
  )
}
