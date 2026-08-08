import { useState } from 'react'
import {
  Link,
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  AdminError,
  AdminField,
  StatusBadge,
  adminInputClass,
} from '@/components/admin'
import {
  adminAssignRepresentativeFn,
  adminCancelAppointmentFn,
  adminCompleteAppointmentFn,
  adminGetAppointmentFn,
  adminMarkNoShowFn,
  adminRemoveRepresentativeFn,
  adminRescheduleAppointmentFn,
} from '@/services/appointment-actions'
import { adminGetAppointmentGuidanceFn } from '@/services/spiritual-content-actions'
import { LANGUAGE_LABELS, contentTypeLabel } from '@/lib/guidance-labels'

export const Route = createFileRoute('/admin/appointments/$id')({
  params: {
    parse: (params) => ({ id: z.coerce.number().int().parse(params.id) }),
    stringify: (params) => ({ id: String(params.id) }),
  },
  beforeLoad: ({ context }) => {
    if (!context.admin.permissions.includes('appointments.view')) {
      throw redirect({ to: '/admin' })
    }
  },
  loader: async ({ params }) => {
    const appointment = await adminGetAppointmentFn({ data: { id: params.id } })
    if (!appointment) throw notFound()
    const guidance = await adminGetAppointmentGuidanceFn({
      data: { appointmentId: params.id },
    })
    return { ...appointment, guidanceSet: guidance }
  },
  component: AppointmentDetail,
})

function AppointmentDetail() {
  const appointment = Route.useLoaderData()
  const cancel = useServerFn(adminCancelAppointmentFn)
  const reschedule = useServerFn(adminRescheduleAppointmentFn)
  const complete = useServerFn(adminCompleteAppointmentFn)
  const noShow = useServerFn(adminMarkNoShowFn)
  const assign = useServerFn(adminAssignRepresentativeFn)
  const removeRep = useServerFn(adminRemoveRepresentativeFn)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [newStart, setNewStart] = useState('')

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  const confirmed = appointment.status === 'CONFIRMED'

  return (
    <div className="max-w-2xl">
      <Link
        to="/admin/appointments"
        className="text-sm text-stone-400 hover:text-amber-500"
      >
        ← Appointments
      </Link>
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">
          {appointment.serviceNameSnapshot}
        </h1>
        <StatusBadge status={appointment.status} />
      </div>
      <p className="mt-1 font-mono text-xs text-stone-500">
        {appointment.publicId}
      </p>

      <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6 text-sm">
        <dl className="space-y-2">
          <Row label="Sacred House" value={appointment.houseNameSnapshot} />
          <Row label="Starts (UTC)" value={appointment.startsAtUtc} />
          <Row label="Ends (UTC)" value={appointment.endsAtUtc} />
          <Row label="House timezone" value={appointment.houseTimezone} />
          <Row label="User timezone" value={appointment.userTimezone} />
          <Row
            label="Duration"
            value={`${appointment.durationMinutesSnapshot} minutes`}
          />
          <Row
            label="Price"
            value={`${(appointment.priceMinorSnapshot / 100).toLocaleString()} ${appointment.currencySnapshot}`}
          />
          <Row label="User id" value={String(appointment.userId)} />
          <Row
            label="Reschedules"
            value={String(appointment.rescheduleCount)}
          />
          {appointment.reservationExpiresAt ? (
            <Row
              label="Reservation expires (UTC)"
              value={appointment.reservationExpiresAt}
            />
          ) : null}
          {appointment.cancellationReason ? (
            <Row
              label="Cancellation reason"
              value={appointment.cancellationReason}
            />
          ) : null}
        </dl>
        {appointment.privateRequestNote ? (
          <div className="mt-4 rounded-md border border-stone-700 bg-stone-950 p-3">
            <p className="text-xs font-medium text-stone-400">
              Private request to the Sacred House
            </p>
            <p className="mt-1 whitespace-pre-wrap text-stone-300">
              {appointment.privateRequestNote}
            </p>
          </div>
        ) : null}
      </section>

      {confirmed ? (
        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            Representatives (private — users never book individuals)
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            {appointment.representatives.map((rep) => (
              <li key={rep.memberId} className="flex items-center gap-3">
                <span>
                  {rep.displayName}
                  <span className="text-stone-500"> — {rep.role}</span>
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      removeRep({
                        data: { id: appointment.id, memberId: rep.memberId },
                      }),
                    )
                  }
                  className="text-xs text-stone-500 hover:text-red-400"
                >
                  remove
                </button>
              </li>
            ))}
            {appointment.representatives.length === 0 ? (
              <li className="text-stone-500">No representatives assigned.</li>
            ) : null}
          </ul>
          <form
            className="mt-4 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              void run(() =>
                assign({
                  data: {
                    id: appointment.id,
                    memberId: Number(form.get('memberId')),
                    role: String(form.get('role')) as 'PRIMARY' | 'SUPPORT',
                  },
                }),
              )
            }}
          >
            <select
              name="memberId"
              className="rounded-md border border-stone-700 bg-stone-900 px-3 py-2 text-sm text-stone-200"
            >
              {appointment.houseMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </select>
            <select
              name="role"
              className="rounded-md border border-stone-700 bg-stone-900 px-3 py-2 text-sm text-stone-200"
            >
              <option value="PRIMARY">PRIMARY</option>
              <option value="SUPPORT">SUPPORT</option>
            </select>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md border border-stone-700 px-4 text-sm text-stone-200 hover:border-amber-500 disabled:opacity-40"
            >
              Assign
            </button>
          </form>
        </section>
      ) : null}

      {appointment.status === 'PENDING_PAYMENT' || confirmed ? (
        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            Operations
          </h2>
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex flex-wrap items-end gap-2">
              <AdminField label="Cancellation reason (required)">
                <input
                  value={cancelReason}
                  onChange={(event) => setCancelReason(event.target.value)}
                  maxLength={500}
                  className={adminInputClass}
                />
              </AdminField>
              <button
                type="button"
                disabled={busy || cancelReason.trim().length === 0}
                onClick={() =>
                  void run(() =>
                    cancel({
                      data: { id: appointment.id, reason: cancelReason.trim() },
                    }),
                  )
                }
                className="rounded-md border border-red-900 px-4 py-2 text-red-300 hover:border-red-700 disabled:opacity-40"
              >
                Cancel appointment
              </button>
            </div>
            {confirmed ? (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <AdminField label="New start (UTC, YYYY-MM-DD HH:MM:SS)">
                    <input
                      value={newStart}
                      onChange={(event) => setNewStart(event.target.value)}
                      placeholder="2026-09-01 10:00:00"
                      className={adminInputClass}
                    />
                  </AdminField>
                  <button
                    type="button"
                    disabled={busy || newStart.trim().length === 0}
                    onClick={() =>
                      void run(() =>
                        reschedule({
                          data: {
                            id: appointment.id,
                            newStartsAtUtc: newStart.trim(),
                          },
                        }),
                      )
                    }
                    className="rounded-md border border-stone-700 px-4 py-2 text-stone-200 hover:border-amber-500 disabled:opacity-40"
                  >
                    Reschedule
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => complete({ data: { id: appointment.id } }))
                    }
                    className="rounded-md border border-emerald-900 px-4 py-2 text-emerald-300 hover:border-emerald-700 disabled:opacity-40"
                  >
                    Mark completed
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() => noShow({ data: { id: appointment.id } }))
                    }
                    className="rounded-md border border-stone-700 px-4 py-2 text-stone-300 hover:border-amber-500 disabled:opacity-40"
                  >
                    Mark no-show
                  </button>
                </div>
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
        <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
          Spiritual guidance set (frozen at confirmation)
        </h2>
        {!appointment.guidanceSet ? (
          <p className="mt-4 text-sm text-stone-500">
            No guidance selection exists for this appointment (confirmed before
            the guidance stage, or not yet confirmed).
          </p>
        ) : (
          <>
            <p className="mt-3 text-xs text-stone-500">
              Result: {appointment.guidanceSet.set.selectionResult} ·{' '}
              {appointment.guidanceSet.set.assignmentCount} assignment(s) ·
              language snapshot:{' '}
              {appointment.guidanceSet.set.preferredLanguageSnapshot ?? '—'}
            </p>
            {appointment.guidanceSet.assignments.length > 0 ? (
              <table className="mt-4 w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-stone-800 text-xs tracking-wider text-stone-500 uppercase">
                    <th className="py-2 pr-4">Title</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2 pr-4">Lang</th>
                    <th className="py-2 pr-4">Version</th>
                    <th className="py-2 pr-4">Stage</th>
                    <th className="py-2">Acknowledged</th>
                  </tr>
                </thead>
                <tbody>
                  {appointment.guidanceSet.assignments.map((assignment) => (
                    <tr
                      key={assignment.contentVersionId}
                      className="border-b border-stone-900"
                    >
                      <td className="py-2 pr-4">{assignment.title}</td>
                      <td className="py-2 pr-4">
                        {contentTypeLabel(assignment.contentType)}
                      </td>
                      <td className="py-2 pr-4">
                        {LANGUAGE_LABELS[assignment.language] ??
                          assignment.language}
                        {assignment.fallbackUsed ? ' (fallback)' : ''}
                      </td>
                      <td className="py-2 pr-4">v{assignment.versionNumber}</td>
                      <td className="py-2 pr-4 text-stone-400">
                        {assignment.visibilityStage.replaceAll('_', ' ')}
                      </td>
                      <td className="py-2">
                        {assignment.acknowledgementRequired
                          ? assignment.acknowledgedAt
                            ? '✓ yes'
                            : 'pending'
                          : 'not required'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        )}
      </section>

      <AdminError message={error} />
    </div>
  )
}

function Row(props: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-stone-400">{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  )
}
