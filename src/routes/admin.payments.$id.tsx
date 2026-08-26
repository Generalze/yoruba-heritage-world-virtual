import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { AdminTableFrame } from '@/components/admin'
import {
  adminGetPaymentFn,
  adminReverifyPaymentFn,
} from '@/services/payment-admin-actions'
import { formatAmountMinor } from '@/lib/display-time'

/**
 * Admin payment detail (spec §49/§50): full operational picture —
 * references, lifecycle timestamps, webhook history, settlement — and
 * ONE action: re-verify with the provider. No mark-paid, no force
 * success, no refund button. Provider truth only.
 */
export const Route = createFileRoute('/admin/payments/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid payment id')
    return adminGetPaymentFn({ data: { id } })
  },
  component: AdminPaymentDetailPage,
})

function AdminPaymentDetailPage() {
  const payment = Route.useLoaderData()
  const router = useRouter()
  const reverify = useServerFn(adminReverifyPaymentFn)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function handleReverify() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await reverify({ data: { id: payment.id } })
      setMessage(
        result.changed
          ? 'Provider state applied.'
          : 'No change — the provider reports the same state.',
      )
      await router.invalidate()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'Re-verification failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Link
        to="/admin/payments"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← All payments
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Payment {payment.publicId}</h1>
        {payment.resolutionStatus === 'PAID_REQUIRES_REVIEW' ? (
          <span className="rounded-full bg-gold/10 px-3 py-1 text-sm text-gold-deep">
            REQUIRES REVIEW
            {payment.reviewReason ? `: ${payment.reviewReason}` : ''}
          </span>
        ) : null}
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <section className="rounded-lg border border-line bg-surface-raised p-6">
          <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
            Payment
          </h2>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Provider" value={payment.provider} />
            <Row label="Status" value={payment.status} />
            <Row label="Resolution" value={payment.resolutionStatus} />
            <Row
              label="Amount"
              value={formatAmountMinor(payment.amountMinor, payment.currency)}
            />
            <Row
              label="Provider reference"
              value={payment.providerReference ?? '—'}
            />
            <Row
              label="Provider payment id"
              value={payment.providerPaymentId ?? '—'}
            />
            <Row
              label="Provider checkout id"
              value={payment.providerCheckoutId ?? '—'}
            />
            <Row
              label="Provider status"
              value={payment.providerStatus ?? '—'}
            />
            <Row label="Initialized" value={payment.initializedAt ?? '—'} />
            <Row label="Paid (UTC)" value={payment.paidAt ?? '—'} />
            <Row label="Failed (UTC)" value={payment.failedAt ?? '—'} />
            <Row label="Failure code" value={payment.failureCode ?? '—'} />
            <Row
              label="Failure message"
              value={payment.failureMessage ?? '—'}
            />
            {payment.quotedAsset ? (
              <>
                <Row
                  label="Crypto quote"
                  value={`${payment.quotedAmount} ${payment.quotedAsset} (${payment.quotedNetwork})`}
                />
                <Row
                  label="Quote expires"
                  value={payment.quoteExpiresAt ?? '—'}
                />
              </>
            ) : null}
          </dl>
        </section>

        <section className="rounded-lg border border-line bg-surface-raised p-6">
          <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
            Appointment & user
          </h2>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Service" value={payment.serviceNameSnapshot} />
            <Row label="Sacred House" value={payment.houseNameSnapshot} />
            <Row label="Starts (UTC)" value={payment.appointmentStartsAtUtc} />
            <Row label="Appointment status" value={payment.appointmentStatus} />
            <Row label="User" value={payment.userEmail} />
            <Row
              label="Settlement"
              value={
                payment.settlement
                  ? `${payment.settlement.resolution} (attempt #${payment.settlement.paymentAttemptId})`
                  : 'none'
              }
            />
          </dl>
          <div className="mt-4 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => void handleReverify()}
              disabled={busy}
              className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink-soft hover:border-gold-deep hover:text-ink disabled:opacity-60"
            >
              {busy ? 'Checking with provider…' : 'Re-verify with provider'}
            </button>
            {message ? (
              <p className="mt-3 text-sm text-ink-soft">{message}</p>
            ) : null}
            <p className="mt-3 text-xs text-ink-soft">
              Payment states come only from the verified provider. There is no
              manual override.
            </p>
          </div>
        </section>
      </div>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
          Webhook & reconciliation history
        </h2>
        {payment.webhookEvents.length === 0 ? (
          <p className="mt-4 text-sm text-ink-soft">
            No webhook events linked to this attempt.
          </p>
        ) : (
          <AdminTableFrame label="Webhook history" className="mt-4">
            <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs tracking-wider text-ink-soft uppercase">
                <th className="py-2 pr-4">Event</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Received</th>
                <th className="py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {payment.webhookEvents.map((event) => (
                <tr key={event.id} className="border-b border-line">
                  <td className="py-2 pr-4 text-ink-soft">
                    {event.eventKey.slice(0, 32)}
                  </td>
                  <td className="py-2 pr-4">{event.eventType}</td>
                  <td className="py-2 pr-4">{event.processingStatus}</td>
                  <td className="py-2 pr-4 text-ink-soft">
                    {event.receivedAt instanceof Date
                      ? event.receivedAt
                          .toISOString()
                          .slice(0, 19)
                          .replace('T', ' ')
                      : String(event.receivedAt)}
                  </td>
                  <td className="py-2 text-ink-soft">
                    {event.errorCode ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            </table>
          </AdminTableFrame>
        )}
      </section>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="text-right break-all">{value}</dd>
    </div>
  )
}
