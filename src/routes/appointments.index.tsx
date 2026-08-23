import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { getCurrentUserFn } from '@/auth/actions'
import { getMyAppointmentsFn } from '@/services/booking-actions'
import { AppShell } from '@/components/app-shell'
import {
  Card,
  IconArrow,
  StatusChip,
  buttonClass,
  humanizeStatus,
  statusTone,
} from '@/components/ui'
import { formatAmountMinor, formatUtcSqlInTimezone } from '@/lib/display-time'

/**
 * The authenticated user's own appointments (spec §44): upcoming,
 * pending-payment holds and history. Owner-scoped server-side — this
 * page can only ever render the acting user's records.
 */
export const Route = createFileRoute('/appointments/')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ context }) => ({
    user: context.user,
    rows: await getMyAppointmentsFn(),
  }),
  head: () => ({
    meta: [{ title: 'My appointments — Yorùbá Heritage World Virtual' }],
  }),
  component: MyAppointmentsPage,
})

function MyAppointmentsPage() {
  const { user, rows } = Route.useLoaderData()

  return (
    <AppShell userName={user.preferredName}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
            Your account
          </p>
          <h1 className="font-display mt-2 text-3xl text-ink sm:text-4xl">
            My appointments
          </h1>
        </div>
        <Link
          to="/payments"
          className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
        >
          Payment history
          <IconArrow />
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="mt-8 max-w-2xl">
          <Card>
            <p className="text-sm leading-relaxed text-ink-soft">
              You have no appointments yet.
            </p>
            <div className="mt-4">
              <Link to="/services" className={buttonClass('primary', 'md')}>
                Browse services
                <IconArrow />
              </Link>
            </div>
          </Card>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4">
          {rows.map((row) => (
            <li key={row.publicId}>
              <Link
                to="/appointments/$publicId"
                params={{ publicId: row.publicId }}
                className="block rounded-lg border border-line bg-surface-raised p-5 shadow-[0_1px_3px_rgba(43,32,24,0.08)] transition-colors hover:border-gold-deep"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="font-display text-lg text-ink">
                      {row.serviceNameSnapshot}
                    </h2>
                    <p className="mt-1 text-sm text-ink-soft">
                      {row.houseNameSnapshot}
                    </p>
                  </div>
                  <StatusChip tone={statusTone(row.status)}>
                    {humanizeStatus(row.status)}
                  </StatusChip>
                </div>

                <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <div className="flex justify-between gap-3 sm:justify-start sm:gap-2">
                    <dt className="text-ink-soft">When</dt>
                    <dd className="text-right text-ink sm:text-left">
                      {formatUtcSqlInTimezone(
                        row.startsAtUtc,
                        row.userTimezone,
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 sm:justify-start sm:gap-2">
                    <dt className="text-ink-soft">Amount</dt>
                    <dd className="text-right text-ink sm:text-left">
                      {formatAmountMinor(
                        row.priceMinorSnapshot,
                        row.currencySnapshot,
                      )}
                      {row.payment
                        ? ` · payment ${row.payment.status.toLowerCase()}`
                        : ''}
                    </dd>
                  </div>
                </dl>

                <p className="mt-3 text-xs text-ink-soft">
                  Times shown in your timezone ({row.userTimezone}).
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  )
}
