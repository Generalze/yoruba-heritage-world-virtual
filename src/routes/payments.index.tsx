import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { getCurrentUserFn } from '@/auth/actions'
import { getMyPaymentsFn } from '@/services/booking-actions'
import { formatAmountMinor } from '@/lib/display-time'

/** Private payment history (spec §46): the user's own attempts only —
 * provider, amount, status, resolution and a support reference. */
export const Route = createFileRoute('/payments/')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async () => getMyPaymentsFn(),
  component: PaymentHistoryPage,
})

const STATUS_STYLE: Record<string, string> = {
  SUCCEEDED: 'bg-emerald-950 text-emerald-400',
  FAILED: 'bg-red-950 text-red-400',
  CANCELLED: 'bg-stone-800 text-stone-400',
  EXPIRED: 'bg-stone-800 text-stone-500',
  PENDING: 'bg-amber-950 text-amber-400',
  INITIALIZED: 'bg-amber-950 text-amber-400',
  CREATED: 'bg-stone-800 text-stone-400',
}

function PaymentHistoryPage() {
  const rows = Route.useLoaderData()

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Payment history</h1>
          <Link
            to="/appointments"
            className="text-sm text-stone-400 hover:text-amber-500"
          >
            My appointments →
          </Link>
        </div>

        {rows.length === 0 ? (
          <p className="mt-8 text-stone-400">No payments yet.</p>
        ) : (
          <ul className="mt-8 space-y-3">
            {rows.map((row) => (
              <li
                key={row.publicId}
                className="rounded-lg border border-stone-800 bg-stone-900 p-4"
              >
                <div className="flex items-center justify-between gap-4">
                  <span className="font-medium">
                    {formatAmountMinor(row.amountMinor, row.currency)}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs ${STATUS_STYLE[row.status] ?? 'bg-stone-800 text-stone-400'}`}
                  >
                    {row.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-stone-400">
                  {row.serviceNameSnapshot} · {row.houseNameSnapshot} · via{' '}
                  {row.provider}
                </p>
                <p className="mt-1 text-xs text-stone-500">
                  Reference: {row.providerReference ?? '—'}
                  {row.paidAt ? ` · paid ${row.paidAt} UTC` : ''}
                  {row.resolutionStatus === 'PAID_REQUIRES_REVIEW'
                    ? ' · under review'
                    : ''}
                </p>
                <div className="mt-2 flex gap-4 text-sm">
                  <Link
                    to="/appointments/$publicId"
                    params={{ publicId: row.appointmentPublicId }}
                    className="text-stone-400 hover:text-amber-500"
                  >
                    Appointment
                  </Link>
                  {row.status === 'SUCCEEDED' ? (
                    <Link
                      to="/payments/receipt/$attemptPublicId"
                      params={{ attemptPublicId: row.publicId }}
                      className="text-amber-500 hover:text-amber-400"
                    >
                      Receipt
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  )
}
