import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { getCurrentUserFn } from '@/auth/actions'
import {
  cancelMyAppointmentFn,
  getMyAppointmentFn,
  getRescheduleSlotsFn,
  rescheduleMyAppointmentFn,
} from '@/services/booking-actions'
import {
  formatAmountMinor,
  formatUtcSqlInTimezone,
  msUntilUtcSql,
} from '@/lib/display-time'

/**
 * Owner appointment detail (spec §44/§45). Server-side ownership via
 * public UUID + session user. Cancel/reschedule controls are UX hints —
 * Step 5 domain cutoffs remain the authority. Representative
 * assignments are internal and never displayed here.
 */
export const Route = createFileRoute('/appointments/$publicId')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params }) =>
    getMyAppointmentFn({ data: { publicId: params.publicId } }),
  component: AppointmentDetailPage,
})

function AppointmentDetailPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const cancel = useServerFn(cancelMyAppointmentFn)
  const reschedule = useServerFn(rescheduleMyAppointmentFn)
  const loadSlots = useServerFn(getRescheduleSlotsFn)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const [rescheduling, setRescheduling] = useState(false)
  const [date, setDate] = useState('')
  const [slots, setSlots] = useState<Array<{
    startsAtUtc: string
    houseLocalTime: string
  }> | null>(null)

  const appointment = data.appointment
  const tz = appointment.userTimezone
  const nowMs = Date.now()
  const startMs = new Date(
    `${appointment.startsAtUtc.replace(' ', 'T')}Z`,
  ).getTime()
  const outsideCancelCutoff =
    startMs - data.cutoffs.cancellationCutoffMinutes * 60_000 > nowMs
  const outsideRescheduleCutoff =
    startMs - data.cutoffs.rescheduleCutoffMinutes * 60_000 > nowMs

  const canCancel =
    appointment.status === 'PENDING_PAYMENT' ||
    (appointment.status === 'CONFIRMED' && outsideCancelCutoff)
  const canReschedule =
    appointment.status === 'CONFIRMED' && outsideRescheduleCutoff
  const holdLive =
    appointment.status === 'PENDING_PAYMENT' &&
    appointment.reservationExpiresAt != null &&
    msUntilUtcSql(appointment.reservationExpiresAt, nowMs) > 0

  async function handleCancel() {
    setBusy(true)
    setError(null)
    try {
      await cancel({ data: { publicId: appointment.publicId } })
      await router.invalidate()
      setConfirmCancel(false)
    } catch (cancelError) {
      setError(
        cancelError instanceof Error
          ? cancelError.message
          : 'The appointment could not be cancelled.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleLoadSlots(chosenDate: string) {
    setDate(chosenDate)
    setSlots(null)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(chosenDate)) return
    setBusy(true)
    setError(null)
    try {
      const result = await loadSlots({
        data: {
          publicId: appointment.publicId,
          fromDate: chosenDate,
          toDate: chosenDate,
        },
      })
      setSlots(result)
    } catch {
      setError('Available times could not be loaded for that date.')
    } finally {
      setBusy(false)
    }
  }

  async function handleReschedule(startsAtUtc: string) {
    setBusy(true)
    setError(null)
    try {
      await reschedule({
        data: { publicId: appointment.publicId, newStartsAtUtc: startsAtUtc },
      })
      await router.invalidate()
      setRescheduling(false)
      setSlots(null)
    } catch (rescheduleError) {
      setError(
        rescheduleError instanceof Error
          ? rescheduleError.message
          : 'The appointment could not be rescheduled.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-2xl">
        <Link
          to="/appointments"
          className="text-sm text-stone-400 hover:text-amber-500"
        >
          ← My appointments
        </Link>
        <div className="mt-4 flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold">
            {appointment.serviceNameSnapshot}
          </h1>
          <span className="rounded-full bg-stone-800 px-3 py-1 text-xs text-stone-300">
            {appointment.status.replaceAll('_', ' ')}
          </span>
        </div>

        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Sacred House</dt>
              <dd>{appointment.houseNameSnapshot}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Date & time ({tz})</dt>
              <dd>{formatUtcSqlInTimezone(appointment.startsAtUtc, tz)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Duration</dt>
              <dd>{appointment.durationMinutesSnapshot} minutes</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Amount</dt>
              <dd>
                {formatAmountMinor(
                  appointment.priceMinorSnapshot,
                  appointment.currencySnapshot,
                )}
              </dd>
            </div>
            {data.attempts.length > 0 ? (
              <div className="flex justify-between gap-4">
                <dt className="text-stone-400">Payment</dt>
                <dd>
                  {data.settled
                    ? 'settled'
                    : data.attempts[0].status.toLowerCase()}
                </dd>
              </div>
            ) : null}
          </dl>
          {appointment.privateRequestNote ? (
            <div className="mt-4 border-t border-stone-800 pt-4">
              <h2 className="text-xs font-medium tracking-widest text-stone-500 uppercase">
                Your private request
              </h2>
              <p className="mt-2 text-sm whitespace-pre-wrap text-stone-300">
                {appointment.privateRequestNote}
              </p>
            </div>
          ) : null}
        </section>

        {holdLive ? (
          <Link
            to="/checkout/$appointmentPublicId"
            params={{ appointmentPublicId: appointment.publicId }}
            className="mt-4 inline-block rounded-md bg-amber-600 px-5 py-2.5 text-sm font-medium text-stone-950 hover:bg-amber-500"
          >
            Complete payment
          </Link>
        ) : null}

        {(canCancel || canReschedule) && !rescheduling ? (
          <div className="mt-6 flex gap-3">
            {canCancel ? (
              confirmCancel ? (
                <span className="flex items-center gap-2 text-sm">
                  <span className="text-stone-400">
                    Cancel this appointment?
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCancel()}
                    disabled={busy}
                    className="rounded-md border border-red-800 px-3 py-1.5 text-red-400 hover:bg-red-950 disabled:opacity-60"
                  >
                    Yes, cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmCancel(false)}
                    className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-300"
                  >
                    Keep it
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmCancel(true)}
                  className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:border-red-700 hover:text-red-400"
                >
                  Cancel appointment
                </button>
              )
            ) : null}
            {canReschedule ? (
              <button
                type="button"
                onClick={() => setRescheduling(true)}
                className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:border-amber-500 hover:text-amber-400"
              >
                Reschedule
              </button>
            ) : null}
          </div>
        ) : null}

        {rescheduling ? (
          <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
                Choose a new time
              </h2>
              <button
                type="button"
                onClick={() => {
                  setRescheduling(false)
                  setSlots(null)
                }}
                className="text-xs text-stone-400 hover:text-stone-200"
              >
                Close
              </button>
            </div>
            <input
              type="date"
              value={date}
              onChange={(event) => void handleLoadSlots(event.target.value)}
              className="mt-4 rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
            />
            {slots ? (
              slots.length === 0 ? (
                <p className="mt-4 text-sm text-stone-500">
                  No available times on this date.
                </p>
              ) : (
                <div className="mt-4 flex flex-wrap gap-2">
                  {slots.map((slot) => (
                    <button
                      key={slot.startsAtUtc}
                      type="button"
                      onClick={() => void handleReschedule(slot.startsAtUtc)}
                      disabled={busy}
                      className="rounded-md border border-stone-700 px-3 py-2 text-sm text-stone-300 hover:border-amber-500 disabled:opacity-60"
                    >
                      {formatUtcSqlInTimezone(slot.startsAtUtc, tz, {
                        timeStyle: 'short',
                      })}
                    </button>
                  ))}
                </div>
              )
            ) : null}
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
