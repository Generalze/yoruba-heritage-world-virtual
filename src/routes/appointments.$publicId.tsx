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
  acknowledgeGuidanceFn,
  cancelMyAppointmentFn,
  getMyAppointmentFn,
} from '@/services/booking-actions'
import { AppShell } from '@/components/app-shell'
import {
  Card,
  ErrorNotice,
  IconArrow,
  StatusChip,
  buttonClass,
  humanizeStatus,
  statusTone,
} from '@/components/ui'
import {
  formatAmountMinor,
  formatUtcSqlInTimezone,
  msUntilUtcSql,
} from '@/lib/display-time'
import { LANGUAGE_LABELS, contentTypeLabel } from '@/lib/guidance-labels'

/**
 * Owner appointment detail (spec §44/§45). Server-side ownership via
 * public UUID + session user. Cancel/reschedule controls are UX hints —
 * Step 5 domain cutoffs remain the authority. Representative
 * assignments are internal and never displayed here.
 *
 * The clock reading is taken ONCE in the loader rather than at render
 * time, so the server pass and the hydration pass cannot disagree
 * about which controls to offer. The server re-checks every cutoff on
 * the action itself regardless.
 */
export const Route = createFileRoute('/appointments/$publicId')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params, context }) => ({
    user: context.user,
    data: await getMyAppointmentFn({ data: { publicId: params.publicId } }),
    nowMs: Date.now(),
  }),
  head: () => ({
    meta: [{ title: 'Appointment — Yorùbá Heritage World Virtual' }],
  }),
  component: AppointmentDetailPage,
})

function AppointmentDetailPage() {
  const { user, data, nowMs } = Route.useLoaderData()
  const router = useRouter()
  const cancel = useServerFn(cancelMyAppointmentFn)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)

  const appointment = data.appointment
  const tz = appointment.userTimezone
  const scheduledStart = appointment.startsAtUtc
  const scheduled = scheduledStart != null
  const startMs = scheduledStart
    ? new Date(`${scheduledStart.replace(' ', 'T')}Z`).getTime()
    : null
  const outsideCancelCutoff =
    startMs == null ||
    startMs - data.cutoffs.cancellationCutoffMinutes * 60_000 > nowMs

  const canCancel =
    appointment.status === 'PENDING_PAYMENT' ||
    (appointment.status === 'CONFIRMED' && outsideCancelCutoff)
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

  return (
    <AppShell userName={user.preferredName}>
      <header>
        <Link
          to="/appointments"
          className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
        >
          <span aria-hidden="true">←</span>
          My appointments
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <h1 className="font-display text-3xl text-ink sm:text-4xl">
            {appointment.serviceNameSnapshot}
          </h1>
          <StatusChip tone={statusTone(appointment.status)}>
            {humanizeStatus(appointment.status)}
          </StatusChip>
        </div>
      </header>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="grid gap-6">
          <Card>
            <h2 className="text-sm font-semibold tracking-wide text-ink">
              Appointment details
            </h2>
            <dl className="mt-4 divide-y divide-line text-sm">
              <div className="flex justify-between gap-4 py-2.5">
                <dt className="text-ink-soft">Sacred House</dt>
                <dd className="text-right text-ink">
                  {appointment.houseNameSnapshot}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-2.5">
                <dt className="text-ink-soft">Date and time</dt>
                <dd className="text-right text-ink">
                  {appointment.startsAtUtc
                    ? formatUtcSqlInTimezone(appointment.startsAtUtc, tz)
                    : appointment.status === 'CONFIRMED'
                      ? 'Awaiting scheduling'
                      : 'Assigned after payment'}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-2.5">
                <dt className="text-ink-soft">Timezone</dt>
                <dd className="text-right text-ink">{tz}</dd>
              </div>
              <div className="flex justify-between gap-4 py-2.5">
                <dt className="text-ink-soft">Amount</dt>
                <dd className="text-right text-ink">
                  {formatAmountMinor(
                    appointment.priceMinorSnapshot,
                    appointment.currencySnapshot,
                  )}
                </dd>
              </div>
              {data.attempts.length > 0 ? (
                <div className="flex justify-between gap-4 py-2.5">
                  <dt className="text-ink-soft">Payment</dt>
                  <dd className="text-right text-ink">
                    {data.settled
                      ? 'Settled'
                      : humanizeStatus(data.attempts[0].status)}
                  </dd>
                </div>
              ) : null}
            </dl>

            {appointment.privateRequestNote ? (
              <div className="mt-5 border-t border-line pt-5">
                <h3 className="text-xs font-semibold tracking-[0.28em] text-ink-soft uppercase">
                  Your private request
                </h3>
                <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-ink">
                  {appointment.privateRequestNote}
                </p>
              </div>
            ) : null}
          </Card>

          <GuidanceSection
            guidance={data.guidance}
            publicId={appointment.publicId}
          />

          <ErrorNotice message={error} />
        </div>

        <div className="grid gap-6 lg:content-start">
          {holdLive ? (
            <Card>
              <h2 className="text-sm font-semibold tracking-wide text-ink">
                Payment required
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                Your time is held while you complete payment.
              </p>
              <div className="mt-4">
                <Link
                  to="/checkout/$appointmentPublicId"
                  params={{ appointmentPublicId: appointment.publicId }}
                  className={buttonClass('primary', 'md')}
                >
                  Complete payment
                  <IconArrow />
                </Link>
              </div>
            </Card>
          ) : null}

          <PrayerRoomSection
            publicId={appointment.publicId}
            status={appointment.status}
            scheduled={scheduled}
          />

          {canCancel ? (
            <Card>
              <h2 className="text-sm font-semibold tracking-wide text-ink">
                Manage this appointment
              </h2>
              <div className="mt-4 flex flex-col gap-3">
                {canCancel ? (
                  confirmCancel ? (
                    <div className="rounded-md border border-alert/40 bg-alert/10 p-4">
                      <p className="text-sm text-alert">
                        Cancel this appointment?
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleCancel()}
                          disabled={busy}
                          className="rounded-md border border-alert px-4 py-2 text-sm font-semibold text-alert transition-colors hover:bg-alert/15 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {busy ? 'Cancelling…' : 'Yes, cancel'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmCancel(false)}
                          className={buttonClass('secondary', 'md')}
                        >
                          Keep it
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmCancel(true)}
                      className="inline-flex items-center justify-center rounded-md border border-line-strong px-5 py-2.5 text-sm font-semibold text-ink-soft transition-colors hover:border-alert hover:text-alert"
                    >
                      Cancel appointment
                    </button>
                  )
                ) : null}
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </AppShell>
  )
}

/**
 * Recorded Prayer Room entry point (Step 18). Deliberately a LINK, not
 * a status readout. Availability depends on an admin-prepared video
 * being attached and its private upload still verifying; legacy
 * generated appointments still work, but this page never claims a room
 * is open on the strength of the clock alone. The Prayer Room page
 * proves ownership, the appointment-time gate and the full upload
 * verification server-side on every load.
 *
 * It appears only for statuses that can ever have a recording, and it
 * shows nothing about storage internals or production workflow.
 */
function PrayerRoomSection({
  publicId,
  status,
  scheduled,
}: {
  publicId: string
  status: string
  scheduled: boolean
}) {
  if (status !== 'CONFIRMED' && status !== 'COMPLETED') return null
  return (
    <Card>
      <h2 className="text-sm font-semibold tracking-wide text-ink">
        Prayer Room
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-ink-soft">
        {scheduled
          ? 'Your recorded Prayer Room opens at the scheduled appointment time, once the recording is ready.'
          : 'Your Prayer Room is awaiting admin scheduling and remains locked until a date and time are assigned.'}
      </p>
      <div className="mt-4">
        <Link
          to="/prayer-room/$publicId"
          params={{ publicId }}
          className={buttonClass('secondary', 'md')}
        >
          View Prayer Room status
        </Link>
      </div>
    </Card>
  )
}

type GuidanceData = Awaited<ReturnType<typeof getMyAppointmentFn>>['guidance']

/**
 * Frozen spiritual guidance for this appointment (Step 7). Plain text
 * rendered exclusively through React escaping — no HTML, no Markdown,
 * no raw-markup injection APIs. Sections appear only for versions that
 * were actually assigned and are visible for the current status.
 */
function GuidanceSection({
  guidance,
  publicId,
}: {
  guidance: GuidanceData
  publicId: string
}) {
  const router = useRouter()
  const acknowledge = useServerFn(acknowledgeGuidanceFn)
  const [busyVersion, setBusyVersion] = useState<number | null>(null)
  const [ackError, setAckError] = useState<string | null>(null)

  if (guidance.setState === 'NONE' || guidance.items.length === 0) {
    return null
  }

  async function handleAcknowledge(contentVersionId: number) {
    setBusyVersion(contentVersionId)
    setAckError(null)
    try {
      await acknowledge({ data: { publicId, contentVersionId } })
      await router.invalidate()
    } catch (error) {
      setAckError(
        error instanceof Error
          ? error.message
          : 'The acknowledgement could not be saved.',
      )
    } finally {
      setBusyVersion(null)
    }
  }

  return (
    <section className="grid gap-4">
      <h2 className="text-sm font-semibold tracking-wide text-ink">
        Spiritual guidance from your Sacred House
      </h2>
      {guidance.items.map((item) => (
        <article
          key={item.contentVersionId}
          className="rounded-lg border border-line bg-surface-raised p-6 shadow-[0_1px_3px_rgba(43,32,24,0.08)]"
        >
          <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
            {contentTypeLabel(item.contentType)}
            {item.fallbackUsed
              ? ` · shown in ${LANGUAGE_LABELS[item.language] ?? item.language}`
              : ''}
          </p>
          <h3 className="font-display mt-2 text-xl text-ink">{item.title}</h3>
          <p className="mt-3 leading-relaxed whitespace-pre-wrap text-ink">
            {item.body}
          </p>
          {item.acknowledgementRequired ? (
            item.acknowledgedAt ? (
              <p className="mt-4 text-xs font-medium text-affirm">
                ✓ You confirmed reading this guidance.
              </p>
            ) : (
              <button
                type="button"
                disabled={busyVersion !== null}
                onClick={() => void handleAcknowledge(item.contentVersionId)}
                className={`${buttonClass('secondary', 'md')} mt-4 disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {busyVersion === item.contentVersionId
                  ? 'Saving…'
                  : 'I have read this guidance'}
              </button>
            )
          ) : null}
        </article>
      ))}
      <ErrorNotice message={ackError} />
    </section>
  )
}
