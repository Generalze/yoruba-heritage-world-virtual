import { createFileRoute, redirect } from '@tanstack/react-router'

import { getCurrentUserFn } from '@/auth/actions'
import { getMyReceiptFn } from '@/services/booking-actions'
import { formatAmountMinor, formatUtcSqlInTimezone } from '@/lib/display-time'

/** Printable HTML receipt (spec §47) — immutable snapshot facts of one
 * successful, verified payment. Owner-only; no PDF, no email. */
export const Route = createFileRoute('/payments/receipt/$attemptPublicId')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params }) =>
    getMyReceiptFn({ data: { attemptPublicId: params.attemptPublicId } }),
  component: ReceiptPage,
})

function ReceiptPage() {
  const receipt = Route.useLoaderData()

  return (
    <main className="min-h-screen bg-white px-6 py-12 text-stone-900 print:py-4">
      <div className="mx-auto w-full max-w-xl">
        <header className="border-b-2 border-stone-900 pb-4">
          <h1 className="text-2xl font-bold">Payment receipt</h1>
          <p className="mt-1 text-sm text-stone-500">
            Yorùbá Heritage World Virtual
          </p>
        </header>

        <dl className="mt-6 space-y-3 text-sm">
          <ReceiptRow label="Receipt reference" value={receipt.publicId} />
          <ReceiptRow
            label="Provider reference"
            value={receipt.providerReference ?? '—'}
          />
          <ReceiptRow label="Provider" value={receipt.provider} />
          <ReceiptRow
            label="Amount paid"
            value={formatAmountMinor(receipt.amountMinor, receipt.currency)}
          />
          <ReceiptRow label="Paid at (UTC)" value={receipt.paidAt ?? '—'} />
          <ReceiptRow label="Service" value={receipt.serviceNameSnapshot} />
          <ReceiptRow label="Sacred House" value={receipt.houseNameSnapshot} />
          <ReceiptRow
            label="Appointment"
            value={`${formatUtcSqlInTimezone(
              receipt.appointmentStartsAtUtc,
              receipt.userTimezone,
            )} (${receipt.userTimezone})`}
          />
          <ReceiptRow
            label="Duration"
            value={`${receipt.durationMinutesSnapshot} minutes`}
          />
          <ReceiptRow
            label="Appointment reference"
            value={receipt.appointmentPublicId}
          />
        </dl>

        <div className="mt-8 flex gap-3 print:hidden">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-md bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700"
          >
            Print receipt
          </button>
        </div>
        <p className="mt-6 text-xs text-stone-400">
          This receipt records a payment verified with the provider named above.
          Keep the references for any support enquiry.
        </p>
      </div>
    </main>
  )
}

function ReceiptRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6 border-b border-stone-200 pb-2">
      <dt className="text-stone-500">{label}</dt>
      <dd className="text-right font-medium break-all">{value}</dd>
    </div>
  )
}
