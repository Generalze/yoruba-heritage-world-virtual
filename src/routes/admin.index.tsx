import { Link, createFileRoute } from '@tanstack/react-router'

import { getAdminOverviewFn } from '@/services/admin-overview-actions'

export const Route = createFileRoute('/admin/')({
  loader: async () => getAdminOverviewFn(),
  component: AdminDashboard,
})

function AdminDashboard() {
  const overview = Route.useLoaderData()
  const reviewTotal = overview.reviewQueues.reduce(
    (sum, queue) => sum + queue.count,
    0,
  )

  return (
    <div>
      <h1 className="text-2xl font-bold">Administration</h1>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        Current operational status from the admin contracts: review depth,
        generation health and confirmed appointment load.
      </p>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <SummaryPanel
          label="Review queues"
          value={String(reviewTotal)}
          detail={
            overview.reviewQueues.length > 0
              ? `${overview.reviewQueues.length} queue${overview.reviewQueues.length === 1 ? '' : 's'} visible to you`
              : 'No review queues visible to you'
          }
          tone={reviewTotal > 0 ? 'attention' : 'neutral'}
        />
        <SummaryPanel
          label="Failed generation jobs"
          value={String(overview.generation?.failed ?? 0)}
          detail={
            overview.generation
              ? `${overview.generation.active} active, ${overview.generation.ready} ready`
              : 'Requires appointment operations access'
          }
          tone={(overview.generation?.failed ?? 0) > 0 ? 'alert' : 'neutral'}
        />
        <SummaryPanel
          label="Upcoming appointments"
          value={String(overview.upcomingAppointments?.count ?? 0)}
          detail={
            overview.upcomingAppointments
              ? 'Confirmed appointments from now forward'
              : 'Requires appointment operations access'
          }
          tone="neutral"
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <section className="min-w-0 rounded-lg border border-line bg-surface-raised p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Review queue depth</h2>
            <Link
              to="/admin/catalogue"
              className="text-sm font-medium text-gold-deep hover:underline"
            >
              Catalogue
            </Link>
          </div>
          {overview.reviewQueues.length === 0 ? (
            <p className="mt-4 text-sm text-ink-soft">
              No review queue summaries are available for your permissions.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-line">
              {overview.reviewQueues.map((queue) => (
                <li
                  key={queue.label}
                  className="flex items-center justify-between gap-4 py-3"
                >
                  <Link
                    to={queue.to}
                    className="text-sm font-medium text-ink hover:text-gold-deep"
                  >
                    {queue.label}
                  </Link>
                  <span className="rounded-full bg-gold/10 px-3 py-1 text-xs font-semibold text-gold-deep">
                    {queue.count}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="min-w-0 rounded-lg border border-line bg-surface-raised p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Generation monitoring</h2>
            <Link
              to="/admin/generation-jobs"
              className="text-sm font-medium text-gold-deep hover:underline"
            >
              Open jobs
            </Link>
          </div>
          {overview.generation ? (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                {overview.generation.statusCounts.length === 0 ? (
                  <span className="text-sm text-ink-soft">
                    No generation jobs yet.
                  </span>
                ) : (
                  overview.generation.statusCounts.map((row) => (
                    <span
                      key={row.status}
                      className="rounded-full border border-line px-3 py-1 text-xs text-ink-soft"
                    >
                      {row.status.replace('_', ' ')}: {row.count}
                    </span>
                  ))
                )}
              </div>
              {overview.generation.recentFailures.length > 0 ? (
                <div className="mt-5 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-separate border-spacing-0 text-sm">
                    <thead>
                      <tr className="text-left text-xs tracking-wider text-ink-soft uppercase">
                        <th className="border-b border-line px-3 py-2">Job</th>
                        <th className="border-b border-line px-3 py-2">
                          Service / House
                        </th>
                        <th className="border-b border-line px-3 py-2">
                          Error
                        </th>
                        <th className="border-b border-line px-3 py-2">
                          Updated
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.generation.recentFailures.map((job) => (
                        <tr key={job.publicId} className="align-top">
                          <td className="border-b border-line px-3 py-2 font-mono text-xs">
                            {job.publicId.slice(0, 8)}
                          </td>
                          <td className="border-b border-line px-3 py-2 text-xs">
                            {job.serviceName}
                            <br />
                            <span className="text-ink-soft">
                              {job.houseName}
                            </span>
                          </td>
                          <td className="border-b border-line px-3 py-2 text-xs text-alert">
                            {job.lastErrorCode ?? 'FAILED'}
                          </td>
                          <td className="border-b border-line px-3 py-2 text-xs text-ink-soft">
                            {formatDateTime(job.updatedAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-5 text-sm text-ink-soft">
                  No failed generation jobs.
                </p>
              )}
            </>
          ) : (
            <p className="mt-4 text-sm text-ink-soft">
              Generation summaries require appointment operations access.
            </p>
          )}
        </section>
      </div>

      <section className="mt-6 min-w-0 rounded-lg border border-line bg-surface-raised p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Upcoming appointments</h2>
          <Link
            to="/admin/appointments"
            className="text-sm font-medium text-gold-deep hover:underline"
          >
            Appointments
          </Link>
        </div>
        {overview.upcomingAppointments ? (
          overview.upcomingAppointments.next.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate border-spacing-0 text-sm">
                <thead>
                  <tr className="text-left text-xs tracking-wider text-ink-soft uppercase">
                    <th className="border-b border-line px-3 py-2">
                      Appointment
                    </th>
                    <th className="border-b border-line px-3 py-2">When</th>
                    <th className="border-b border-line px-3 py-2">
                      Service / House
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {overview.upcomingAppointments.next.map((appointment) => (
                    <tr key={appointment.publicId}>
                      <td className="border-b border-line px-3 py-2 font-mono text-xs">
                        {appointment.publicId.slice(0, 8)}
                      </td>
                      <td className="border-b border-line px-3 py-2 text-xs">
                        {appointment.startsAtUtc}
                      </td>
                      <td className="border-b border-line px-3 py-2 text-xs">
                        {appointment.serviceName}
                        <br />
                        <span className="text-ink-soft">
                          {appointment.houseName}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="mt-4 text-sm text-ink-soft">
              No confirmed upcoming appointments.
            </p>
          )
        ) : (
          <p className="mt-4 text-sm text-ink-soft">
            Appointment summaries require appointment operations access.
          </p>
        )}
      </section>
    </div>
  )
}

function SummaryPanel({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'neutral' | 'attention' | 'alert'
}) {
  const toneClass =
    tone === 'alert'
      ? 'text-alert'
      : tone === 'attention'
        ? 'text-gold-deep'
        : 'text-ink'

  return (
    <section className="min-w-0 rounded-lg border border-line bg-surface-raised p-5">
      <p className="text-xs font-semibold tracking-widest text-ink-soft uppercase">
        {label}
      </p>
      <p className={`mt-3 text-3xl font-bold ${toneClass}`}>{value}</p>
      <p className="mt-2 text-sm text-ink-soft">{detail}</p>
    </section>
  )
}

function formatDateTime(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ')
}
