import { useEffect, useRef, useState } from 'react'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { getCurrentUserFn } from '@/auth/actions'
import { reconcilePaymentFn } from '@/services/booking-actions'

/**
 * Provider return page (spec §26): USER EXPERIENCE ONLY. Query-string
 * values are never proof of payment — the page triggers authenticated
 * server-side reconciliation (owner-checked; PayPal captures happen
 * server-side inside it) and displays the server's verdict.
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
  component: PaymentReturnPage,
})

type Verdict = {
  status: string
  resolutionStatus: string
  appointmentPublicId: string
  appointmentStatus: string
} | null

function PaymentReturnPage() {
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
      <Shell title="Payment reference missing">
        <p className="text-stone-400">
          This payment return link is incomplete. Check My Appointments for your
          booking status.
        </p>
        <BackLinks />
      </Shell>
    )
  }
  if (failed) {
    return (
      <Shell title="Checking payment failed">
        <p className="text-stone-400">
          We could not verify this payment right now. Your money is safe — the
          status will update automatically once the provider notifies us.
        </p>
        <BackLinks />
      </Shell>
    )
  }
  if (!verdict) {
    return (
      <Shell title="Checking payment…">
        <p className="text-stone-400">
          Verifying your payment with the provider. This takes a moment.
        </p>
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
        <p className="text-emerald-300">
          Your payment was verified and your appointment is confirmed.
        </p>
      ) : review ? (
        <p className="text-amber-300">
          Your payment arrived and has been recorded. Our team will review it
          and contact you — no money has been lost.
        </p>
      ) : verdict.status === 'FAILED' || verdict.status === 'CANCELLED' ? (
        <p className="text-stone-400">
          This payment did not complete. If your reservation is still held you
          can try again with another payment method.
        </p>
      ) : (
        <p className="text-stone-400">
          The provider has not finished processing this payment. The status will
          update automatically.
        </p>
      )}
      <div className="mt-6 flex flex-col gap-2">
        <Link
          to="/appointments/$publicId"
          params={{ publicId: verdict.appointmentPublicId }}
          className="text-amber-500 hover:text-amber-400"
        >
          View appointment
        </Link>
        <BackLinks />
      </div>
    </Shell>
  )
}

function Shell({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
      <div className="w-full max-w-md text-center">
        <h1 className="text-2xl font-bold">{title}</h1>
        <div className="mt-4">{children}</div>
      </div>
    </main>
  )
}

function BackLinks() {
  return (
    <div className="mt-2 flex flex-col gap-1 text-sm">
      <Link to="/appointments" className="text-stone-400 hover:text-amber-500">
        My appointments
      </Link>
      <Link to="/payments" className="text-stone-400 hover:text-amber-500">
        Payment history
      </Link>
    </div>
  )
}
