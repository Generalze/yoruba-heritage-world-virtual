import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { getCurrentUserFn } from '@/auth/actions'
import { getMyPaymentsFn } from '@/services/booking-actions'
import { AppShell } from '@/components/app-shell'
import {
  Card,
  IconArrow,
  StatusChip,
  buttonClass,
  humanizeStatus,
  statusTone,
} from '@/components/ui'
import { formatAmountMinor } from '@/lib/display-time'

/** Private payment history (spec §46): the user's own attempts only —
 * provider, amount, status, resolution and a support reference. */
export const Route = createFileRoute('/payments/')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ context }) => ({
    user: context.user,
    rows: await getMyPaymentsFn(),
  }),
  head: () => ({
    meta: [{ title: 'Payment history — Yorùbá Heritage World Virtual' }],
  }),
  component: PaymentHistoryPage,
})

function PaymentHistoryPage() {
  const { user, rows } = Route.useLoaderData()

  return (
    <AppShell userName={user.preferredName}>
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
            Your account
          </p>
          <h1 className="font-display mt-2 text-3xl text-ink sm:text-4xl">
            Payment history
          </h1>
        </div>
        <Link
          to="/appointments"
          className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
        >
          My appointments
          <IconArrow />
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="mt-8 max-w-2xl">
          <Card>
            <p className="text-sm leading-relaxed text-ink-soft">
              No payments yet.
            </p>
            <div className="mt-4">
              <Link to="/services" className={buttonClass('secondary', 'md')}>
                Browse services
              </Link>
            </div>
          </Card>
        </div>
      ) : (
        <ul className="mt-8 grid gap-4">
          {rows.map((row) => (
            <li key={row.publicId}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-display text-lg text-ink">
                      {formatAmountMinor(row.amountMinor, row.currency)}
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">
                      {row.serviceNameSnapshot} · {row.houseNameSnapshot}
                    </p>
                  </div>
                  <StatusChip tone={statusTone(row.status)}>
                    {humanizeStatus(row.status)}
                  </StatusChip>
                </div>

                <dl className="mt-4 divide-y divide-line text-sm">
                  <div className="flex justify-between gap-4 py-2">
                    <dt className="text-ink-soft">Provider</dt>
                    <dd className="text-right text-ink">{row.provider}</dd>
                  </div>
                  <div className="flex justify-between gap-4 py-2">
                    <dt className="text-ink-soft">Reference</dt>
                    <dd className="text-right break-words text-ink">
                      {row.providerReference ?? '—'}
                    </dd>
                  </div>
                  {row.paidAt ? (
                    <div className="flex justify-between gap-4 py-2">
                      <dt className="text-ink-soft">Paid</dt>
                      <dd className="text-right text-ink">{row.paidAt} UTC</dd>
                    </div>
                  ) : null}
                  {row.resolutionStatus === 'PAID_REQUIRES_REVIEW' ? (
                    <div className="flex justify-between gap-4 py-2">
                      <dt className="text-ink-soft">Resolution</dt>
                      <dd className="text-right text-ink">Under review</dd>
                    </div>
                  ) : null}
                </dl>

                <div className="mt-4 flex flex-wrap gap-4 text-sm">
                  <Link
                    to="/appointments/$publicId"
                    params={{ publicId: row.appointmentPublicId }}
                    className="inline-flex items-center gap-2 font-semibold text-gold-deep transition-colors hover:text-ink"
                  >
                    Appointment
                    <IconArrow />
                  </Link>
                  {row.status === 'SUCCEEDED' ? (
                    <Link
                      to="/payments/receipt/$attemptPublicId"
                      params={{ attemptPublicId: row.publicId }}
                      className="inline-flex items-center gap-2 font-semibold text-gold-deep transition-colors hover:text-ink"
                    >
                      Receipt
                      <IconArrow />
                    </Link>
                  ) : null}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </AppShell>
  )
}
