import { useEffect, useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { getCurrentUserFn } from '@/auth/actions'
import {
  getCheckoutFn,
  initiatePaymentFn,
  reconcilePaymentFn,
  simulateMockPaymentFn,
} from '@/services/booking-actions'
import {
  formatAmountMinor,
  formatUtcSqlInTimezone,
  msUntilUtcSql,
} from '@/lib/display-time'

/**
 * Checkout (spec §16): snapshot facts, informational countdown, and the
 * providers currently satisfying every server-side requirement. The
 * countdown is UX only — the server refuses initialization on expired
 * holds regardless of what this page shows.
 */
export const Route = createFileRoute('/checkout/$appointmentPublicId')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params }) =>
    getCheckoutFn({
      data: { appointmentPublicId: params.appointmentPublicId },
    }),
  component: CheckoutPage,
})

function useCountdown(expiresAtUtcSql: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null)
  useEffect(() => {
    if (!expiresAtUtcSql) {
      setLabel(null)
      return
    }
    const update = () => {
      const remaining = msUntilUtcSql(expiresAtUtcSql, Date.now())
      if (remaining <= 0) {
        setLabel('expired')
        return
      }
      const minutes = Math.floor(remaining / 60_000)
      const seconds = Math.floor((remaining % 60_000) / 1000)
      setLabel(`${minutes}:${String(seconds).padStart(2, '0')}`)
    }
    update()
    const timer = setInterval(update, 1000)
    return () => clearInterval(timer)
  }, [expiresAtUtcSql])
  return label
}

function CheckoutPage() {
  const data = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const initiate = useServerFn(initiatePaymentFn)
  const reconcile = useServerFn(reconcilePaymentFn)
  const simulate = useServerFn(simulateMockPaymentFn)

  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mockAttempt, setMockAttempt] = useState<string | null>(null)

  const appointment = data.appointment
  const countdown = useCountdown(
    appointment.status === 'PENDING_PAYMENT'
      ? appointment.reservationExpiresAt
      : null,
  )
  const expired =
    appointment.status === 'EXPIRED' ||
    (appointment.status === 'PENDING_PAYMENT' && countdown === 'expired')

  const userTimezone = appointment.userTimezone

  async function handlePay(provider: string) {
    setBusyProvider(provider)
    setError(null)
    try {
      const result = await initiate({
        data: {
          appointmentPublicId: appointment.publicId,
          provider: provider as
            'PAYSTACK' | 'PAYPAL' | 'STRIPE' | 'CRYPTO' | 'MOCK',
        },
      })
      if (result.checkoutUrl) {
        // Hosted provider checkout — URL was produced server-side.
        window.location.assign(result.checkoutUrl)
        return
      }
      // Mock/crypto-mock attempts run the inline simulator (dev only).
      setMockAttempt(result.attemptPublicId)
    } catch (payError) {
      setError(
        payError instanceof Error
          ? payError.message
          : 'The payment could not be started.',
      )
    } finally {
      setBusyProvider(null)
    }
  }

  async function handleSimulate(
    scenario:
      | 'success'
      | 'duplicate_success'
      | 'failure'
      | 'cancel'
      | 'amount_mismatch'
      | 'currency_mismatch',
  ) {
    if (!mockAttempt) return
    setBusyProvider('MOCK_SIM')
    setError(null)
    try {
      await simulate({
        data: { attemptPublicId: mockAttempt, scenario },
      })
      await reconcile({ data: { attemptPublicId: mockAttempt } })
      await router.invalidate()
      await navigate({
        to: '/payments/return/$provider',
        params: { provider: 'mock' },
        search: { attempt: mockAttempt },
      })
    } catch (simError) {
      setError(
        simError instanceof Error ? simError.message : 'Simulation failed.',
      )
    } finally {
      setBusyProvider(null)
    }
  }

  if (appointment.status === 'CONFIRMED') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
        <h1 className="text-2xl font-bold text-emerald-400">
          Appointment confirmed
        </h1>
        <p className="mt-4 text-stone-400">
          Payment has been received and your appointment is confirmed.
        </p>
        <Link
          to="/appointments/$publicId"
          params={{ publicId: appointment.publicId }}
          className="mt-6 text-amber-500 hover:text-amber-400"
        >
          View appointment
        </Link>
      </main>
    )
  }

  if (expired || appointment.status !== 'PENDING_PAYMENT') {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-stone-950 px-6 text-stone-100">
        <h1 className="text-2xl font-bold">Reservation expired</h1>
        <p className="mt-4 max-w-md text-center text-stone-400">
          This reservation is no longer active. Your chosen time was released.
          Please start a new booking.
        </p>
        <Link
          to="/services"
          className="mt-6 text-amber-500 hover:text-amber-400"
        >
          Book again
        </Link>
      </main>
    )
  }

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-2xl">
        <h1 className="text-3xl font-bold">Checkout</h1>

        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            Your reservation
          </h2>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Service</dt>
              <dd>{appointment.serviceNameSnapshot}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Sacred House</dt>
              <dd>{appointment.houseNameSnapshot}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Date & time ({userTimezone})</dt>
              <dd>
                {formatUtcSqlInTimezone(appointment.startsAtUtc, userTimezone)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Duration</dt>
              <dd>{appointment.durationMinutesSnapshot} minutes</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Amount</dt>
              <dd className="font-medium text-amber-400">
                {formatAmountMinor(
                  appointment.priceMinorSnapshot,
                  appointment.currencySnapshot,
                )}
              </dd>
            </div>
          </dl>
          {countdown && countdown !== 'expired' ? (
            <p className="mt-4 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
              Reservation held for {countdown}. Complete payment before the hold
              expires.
            </p>
          ) : null}
        </section>

        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            Choose a payment method
          </h2>
          {data.providers.length === 0 ? (
            <p className="mt-4 text-sm text-stone-500">
              No payment method is currently available for this appointment.
              Please contact support.
            </p>
          ) : (
            <div className="mt-4 flex flex-col gap-3">
              {data.providers.map((provider) => (
                <button
                  key={provider.code}
                  type="button"
                  onClick={() => void handlePay(provider.code)}
                  disabled={busyProvider !== null}
                  className="rounded-md border border-stone-700 px-4 py-3 text-left text-sm text-stone-200 transition-colors hover:border-amber-500 hover:text-amber-400 disabled:opacity-60"
                >
                  {busyProvider === provider.code
                    ? 'Starting payment…'
                    : `Pay with ${provider.displayName}`}
                </button>
              ))}
            </div>
          )}
        </section>

        {mockAttempt ? (
          <section className="mt-6 rounded-lg border border-dashed border-stone-600 bg-stone-900/60 p-6">
            <h2 className="text-sm font-medium tracking-widest text-stone-400 uppercase">
              Development simulator (mock provider)
            </h2>
            <div className="mt-4 flex flex-wrap gap-2">
              {(
                [
                  ['success', 'Simulate success'],
                  ['failure', 'Simulate failure'],
                  ['cancel', 'Simulate cancellation'],
                  ['amount_mismatch', 'Simulate amount mismatch'],
                ] as const
              ).map(([scenario, label]) => (
                <button
                  key={scenario}
                  type="button"
                  onClick={() => void handleSimulate(scenario)}
                  disabled={busyProvider !== null}
                  className="rounded-md border border-stone-700 px-3 py-2 text-xs text-stone-300 hover:border-amber-500 disabled:opacity-60"
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {error ? (
          <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        ) : null}

        <p className="mt-6 text-xs text-stone-500">
          Payment confirmation always comes from the verified payment provider —
          never from returning to this page.
        </p>
      </div>
    </main>
  )
}
