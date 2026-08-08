import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { getCurrentUserFn } from '@/auth/actions'
import { getMyAppointmentsFn } from '@/services/booking-actions'
import { formatAmountMinor, formatUtcSqlInTimezone } from '@/lib/display-time'

/** The authenticated user's own appointments (spec §44): upcoming,
 * pending-payment holds and history. Owner-scoped server-side. */
export const Route = createFileRoute('/appointments/')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async () => getMyAppointmentsFn(),
  component: MyAppointmentsPage,
})

const STATUS_STYLE: Record<string, string> = {
  CONFIRMED: 'bg-emerald-950 text-emerald-400',
  PENDING_PAYMENT: 'bg-amber-950 text-amber-400',
  CANCELLED: 'bg-stone-800 text-stone-400',
  COMPLETED: 'bg-sky-950 text-sky-400',
  NO_SHOW: 'bg-red-950 text-red-400',
  EXPIRED: 'bg-stone-800 text-stone-500',
}

function MyAppointmentsPage() {
  const rows = Route.useLoaderData()

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">My appointments</h1>
          <Link
            to="/payments"
            className="text-sm text-stone-400 hover:text-amber-500"
          >
            Payment history →
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="mt-8 text-stone-400">
            You have no appointments yet.{' '}
            <Link
              to="/services"
              className="text-amber-500 hover:text-amber-400"
            >
              Browse services
            </Link>
          </p>
        ) : (
          <ul className="mt-8 space-y-3">
            {rows.map((row) => (
              <li key={row.publicId}>
                <Link
                  to="/appointments/$publicId"
                  params={{ publicId: row.publicId }}
                  className="block rounded-lg border border-stone-800 bg-stone-900 p-4 transition-colors hover:border-amber-600"
                >
                  <div className="flex items-center justify-between gap-4">
                    <span className="font-medium">
                      {row.serviceNameSnapshot}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs ${STATUS_STYLE[row.status] ?? 'bg-stone-800 text-stone-400'}`}
                    >
                      {row.status.replaceAll('_', ' ')}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-stone-400">
                    {row.houseNameSnapshot} ·{' '}
                    {formatUtcSqlInTimezone(row.startsAtUtc, row.userTimezone)}{' '}
                    ({row.userTimezone})
                  </p>
                  <p className="mt-1 text-sm text-stone-500">
                    {formatAmountMinor(
                      row.priceMinorSnapshot,
                      row.currencySnapshot,
                    )}
                    {row.payment
                      ? ` · payment ${row.payment.status.toLowerCase()}`
                      : ''}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
