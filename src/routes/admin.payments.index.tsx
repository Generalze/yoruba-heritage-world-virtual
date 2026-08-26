import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import {
  PAYMENT_ATTEMPT_STATUSES,
  PAYMENT_PROVIDERS,
  PAYMENT_RESOLUTION_STATUSES,
} from '@/db/schema'
import { adminListPaymentsFn } from '@/services/payment-admin-actions'
import { formatAmountMinor } from '@/lib/display-time'

/**
 * Admin payment listing (spec §49): observational/operational review.
 * PAID_REQUIRES_REVIEW rows are highlighted — that queue IS the
 * operational follow-up for late/duplicate/mismatched money. There is
 * deliberately no mark-paid control anywhere in this area.
 */

const searchSchema = z.object({
  provider: z.enum(PAYMENT_PROVIDERS).optional(),
  status: z.enum(PAYMENT_ATTEMPT_STATUSES).optional(),
  resolution: z.enum(PAYMENT_RESOLUTION_STATUSES).optional(),
  review: z.boolean().optional(),
})

type PaymentSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/admin/payments/')({
  validateSearch: (search: Record<string, unknown>): PaymentSearch => {
    const parsed = searchSchema.safeParse(search)
    return parsed.success ? parsed.data : {}
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) =>
    adminListPaymentsFn({
      data: {
        provider: deps.provider,
        status: deps.status,
        resolutionStatus: deps.resolution,
        requiresReview: deps.review,
      },
    }),
  component: AdminPaymentsPage,
})

function AdminPaymentsPage() {
  const rows = Route.useLoaderData()
  const search = Route.useSearch()

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Payments</h1>
        <div className="flex flex-wrap gap-2 text-xs">
          <FilterLink
            label="All"
            search={{}}
            active={!search.review && !search.status && !search.provider}
          />
          <FilterLink
            label="Requires review"
            search={{ review: true }}
            active={search.review === true}
          />
          <FilterLink
            label="Succeeded"
            search={{ status: 'SUCCEEDED' }}
            active={search.status === 'SUCCEEDED'}
          />
          <FilterLink
            label="Failed"
            search={{ status: 'FAILED' }}
            active={search.status === 'FAILED'}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <p className="mt-8 text-ink-soft">No payments match this filter.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs tracking-wider text-ink-soft uppercase">
                <th className="py-2 pr-4">Payment</th>
                <th className="py-2 pr-4">Provider</th>
                <th className="py-2 pr-4">Amount</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Resolution</th>
                <th className="py-2 pr-4">User</th>
                <th className="py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-line ${
                    row.resolutionStatus === 'PAID_REQUIRES_REVIEW'
                      ? 'bg-gold/10'
                      : ''
                  }`}
                >
                  <td className="py-2 pr-4">
                    <Link
                      to="/admin/payments/$id"
                      params={{ id: String(row.id) }}
                      className="text-gold-deep hover:text-ink"
                    >
                      {row.publicId.slice(0, 8)}…
                    </Link>
                  </td>
                  <td className="py-2 pr-4">{row.provider}</td>
                  <td className="py-2 pr-4">
                    {formatAmountMinor(row.amountMinor, row.currency)}
                  </td>
                  <td className="py-2 pr-4">{row.status}</td>
                  <td className="py-2 pr-4">
                    {row.resolutionStatus === 'PAID_REQUIRES_REVIEW' ? (
                      <span className="rounded-full bg-gold/10 px-2 py-0.5 text-xs text-gold-deep">
                        REVIEW{row.reviewReason ? `: ${row.reviewReason}` : ''}
                      </span>
                    ) : (
                      row.resolutionStatus
                    )}
                  </td>
                  <td className="py-2 pr-4 text-ink-soft">{row.userEmail}</td>
                  <td className="py-2 text-ink-soft">
                    {row.createdAt instanceof Date
                      ? row.createdAt
                          .toISOString()
                          .slice(0, 16)
                          .replace('T', ' ')
                      : String(row.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FilterLink({
  label,
  search,
  active,
}: {
  label: string
  search: PaymentSearch
  active: boolean
}) {
  return (
    <Link
      to="/admin/payments"
      search={search}
      className={`rounded-full border px-3 py-1 ${
        active
          ? 'border-gold text-gold-deep'
          : 'border-line-strong text-ink-soft hover:border-gold-deep'
      }`}
    >
      {label}
    </Link>
  )
}
