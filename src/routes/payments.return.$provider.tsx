import { useEffect, useRef, useState } from 'react'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getCurrentUserFn } from '@/auth/actions'
import { reconcilePaymentFn } from '@/services/booking-actions'
import { AppShell } from '@/components/app-shell'
import { Card, IconArrow, Notice, PatternDivider } from '@/components/ui'

/**
 * Provider return page (spec §26): USER EXPERIENCE ONLY. Query-string
 * values are never proof of payment — the page triggers authenticated
 * server-side reconciliation (owner-checked; PayPal captures happen
 * server-side inside it) and displays the server's verdict.
 *
 * Every outcome states itself in words. The tone of the notice only
 * reinforces the heading and the sentence beneath it.
 */
export const Route = createFileRoute('/payments/return/$provider')({
  validateSearch: (search: Record<string, unknown>): { attempt?: string } => {
    const parsed = z
      .object({ attempt: z.string().uuid().optional() })
      .safeParse(search)
    return parsed.success ? parsed.data : {}
  },
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: ({ context }) => ({ user: context.user }),
  head: () => ({
    meta: [{ title: 'Payment status — Yorùbá Heritage World Virtual' }],
  }),
  component: PaymentReturnPage,
})

type Verdict = {
  status: string
  resolutionStatus: string
  appointmentPublicId: string
  appointmentStatus: string
} | null

function PaymentReturnPage() {
  const { user } = Route.useLoaderData()
  const { attempt } = Route.useSearch()
  const reconcile = useServerFn(reconcilePaymentFn)
  const [verdict, setVerdict] = useState<Verdict>(null)
  const [failed, setFailed] = useState(false)
  const started = useRef(false)

  useEffect(() => {
    if (started.current || !attempt) return
    started.current = true
    reconcile({ data: { attemptPublicId: attempt } })
      .then((result) => setVerdict(result))
      .catch(() => setFailed(true))
  }, [attempt, reconcile])

  if (!attempt) {
    return (
      <Shell userName={user.preferredName} title="Payment reference missing">
        <Notice tone="caution">
          This payment return link is incomplete. Check My appointments for your
          booking status.
        </Notice>
        <BackLinks />
      </Shell>
    )
  }
  if (failed) {
    return (
      <Shell userName={user.preferredName} title="Checking payment failed">
        <Notice tone="caution">
          We could not verify this payment right now. Your money is safe — the
          status will update automatically once the provider notifies us.
        </Notice>
        <BackLinks />
      </Shell>
    )
  }
  if (!verdict) {
    return (
      <Shell userName={user.preferredName} title="Checking payment…">
        <Notice>
          Verifying your payment with the provider. This takes a moment.
        </Notice>
      </Shell>
    )
  }

  const confirmed =
    verdict.status === 'SUCCEEDED' &&
    verdict.resolutionStatus === 'APPOINTMENT_CONFIRMED'
  const review =
    verdict.status === 'SUCCEEDED' &&
    verdict.resolutionStatus === 'PAID_REQUIRES_REVIEW'

  return (
    <Shell
      userName={user.preferredName}
      title={
        confirmed
          ? 'Payment confirmed'
          : review
            ? 'Payment received — under review'
            : verdict.status === 'PENDING' ||
                verdict.status === 'INITIALIZED' ||
                verdict.status === 'CREATED'
              ? 'Payment pending'
              : verdict.appointmentStatus === 'EXPIRED'
                ? 'Reservation expired'
                : 'Payment not completed'
      }
    >
      {confirmed ? (
        <Notice tone="affirm">
          Your payment was verified and your appointment is confirmed.
        </Notice>
      ) : review ? (
        <Notice tone="caution">
          Your payment arrived and has been recorded. Our team will review it
          and contact you — no money has been lost.
        </Notice>
      ) : verdict.status === 'FAILED' || verdict.status === 'CANCELLED' ? (
        <Notice>
          This payment did not complete. If your reservation is still held you
          can try again with another payment method.
        </Notice>
      ) : (
        <Notice>
          The provider has not finished processing this payment. The status will
          update automatically.
        </Notice>
      )}
      <div className="mt-6">
        <Link
          to="/appointments/$publicId"
          params={{ publicId: verdict.appointmentPublicId }}
          className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
        >
          View appointment
          <IconArrow />
        </Link>
      </div>
      <BackLinks />
    </Shell>
  )
}

/** This route is owner-scoped, so it wears the SIGNED-IN chrome — the
 * public header would offer "Log in" to someone already logged in. */
function Shell({
  userName,
  title,
  children,
}: {
  userName: string
  title: string
  children: React.ReactNode
}) {
  return (
    <AppShell userName={userName}>
      <div className="mx-auto w-full max-w-xl">
        <Card>
          <PatternDivider />
          <h1 className="font-display mt-6 text-center text-3xl text-ink">
            {title}
          </h1>
          <div className="mt-6">{children}</div>
        </Card>
      </div>
    </AppShell>
  )
}

function BackLinks() {
  return (
    <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm">
      <Link
        to="/appointments"
        className="font-semibold text-ink-soft transition-colors hover:text-ink"
      >
        My appointments
      </Link>
      <Link
        to="/payments"
        className="font-semibold text-ink-soft transition-colors hover:text-ink"
      >
        Payment history
      </Link>
    </div>
  )
}
