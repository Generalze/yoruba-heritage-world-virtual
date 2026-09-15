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
import { formatAmountMinor } from '@/lib/display-time'

/**
 * Customer booking creates an unscheduled, payment-held reservation.
 * Date/time is deliberately assigned by admin only after verified payment.
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
    meta: [{ title: 'Book an appointment - Yoruba Heritage World Virtual' }],
  }),
  component: BookingPage,
})

type BookingContext = Awaited<ReturnType<typeof getBookingContextFn>>
type BookableContext = Extract<BookingContext, { bookable: true }>

const BOOKING_STEPS = ['Service', 'Request', 'Payment', 'Scheduling'] as const

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
            Online booking is not available for this service at the moment.
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
  const reserve = useServerFn(createReservationFn)

  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const amount = formatAmountMinor(context.priceMinor, context.currency)

  async function handleReserve() {
    setBusy(true)
    setError(null)
    try {
      const reservation = await reserve({
        data: {
          serviceSlug: context.serviceSlug,
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
          : 'The booking could not be started.',
      )
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

      <nav
        aria-label="Booking progress"
        className="texture-night mt-6 rounded-lg border border-night-line bg-night px-5 py-4"
      >
        <StepIndicator steps={BOOKING_STEPS} current={1} />
      </nav>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="grid gap-6">
          <Card>
            <h2 className="text-sm font-semibold tracking-wide text-ink">
              Private request
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              After verified payment, the Sacred House admin schedules your
              appointment and prepares your private Prayer Room video.
            </p>

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
                  rows={5}
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
                {busy ? 'Starting booking...' : 'Continue to payment'}
                {busy ? null : <IconArrow />}
              </button>
              <p className="mt-3 text-xs leading-relaxed text-ink-soft">
                The appointment time is assigned by admin after payment is
                verified. Your Prayer Room stays locked until that scheduled
                time.
              </p>
            </div>
          </Card>
        </div>

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
              <dt className="text-ink-soft">Scheduling</dt>
              <dd className="text-right text-ink">Assigned by admin</dd>
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
          <p className="mt-3 text-xs leading-relaxed text-ink-soft">
            There is no fixed customer-facing duration. The experience follows
            the approved video prepared for your booking.
          </p>
        </Card>
      </div>
    </AppShell>
  )
}
