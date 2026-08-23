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
import { AppShell } from '@/components/app-shell'
import {
  Card,
  ErrorNotice,
  IconArrow,
  Notice,
  StepIndicator,
  buttonClass,
} from '@/components/ui'
import {
  formatAmountMinor,
  formatUtcSqlInTimezone,
  msUntilUtcSql,
} from '@/lib/display-time'

/**
 * Checkout (Step 21A.4): snapshot facts, an informational countdown,
 * and the providers currently satisfying every server-side
 * requirement.
 *
 * The countdown is UX ONLY — the server refuses initialization on an
 * expired hold regardless of what this page shows, and payment
 * confirmation always comes from authoritative server settlement,
 * never from the browser returning to a page.
 */
export const Route = createFileRoute('/checkout/$appointmentPublicId')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ params, context }) => ({
    user: context.user,
    checkout: await getCheckoutFn({
      data: { appointmentPublicId: params.appointmentPublicId },
    }),
  }),
  head: () => ({
    meta: [{ title: 'Checkout — Yorùbá Heritage World Virtual' }],
  }),
  component: CheckoutPage,
})

const BOOKING_STEPS = ['Service', 'Date and time', 'Review', 'Payment'] as const

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
  const { user, checkout } = Route.useLoaderData()
  const router = useRouter()
  const navigate = useNavigate()
  const initiate = useServerFn(initiatePaymentFn)
  const reconcile = useServerFn(reconcilePaymentFn)
  const simulate = useServerFn(simulateMockPaymentFn)

  const [busyProvider, setBusyProvider] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mockAttempt, setMockAttempt] = useState<string | null>(null)

  const appointment = checkout.appointment
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
            | 'PAYSTACK'
            | 'PAYPAL'
            | 'STRIPE'
            | 'CRYPTO'
            | 'MOCK',
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
      await simulate({ data: { attemptPublicId: mockAttempt, scenario } })
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
      <AppShell userName={user.preferredName}>
        <h1 className="font-display text-3xl text-ink sm:text-4xl">
          Appointment confirmed
        </h1>
        <div className="mt-6 max-w-2xl">
          <Notice tone="affirm">
            Payment has been received and your appointment is confirmed.
          </Notice>
          <div className="mt-5">
            <Link
              to="/appointments/$publicId"
              params={{ publicId: appointment.publicId }}
              className={buttonClass('primary', 'md')}
            >
              View appointment
              <IconArrow />
            </Link>
          </div>
        </div>
      </AppShell>
    )
  }

  if (expired || appointment.status !== 'PENDING_PAYMENT') {
    return (
      <AppShell userName={user.preferredName}>
        <h1 className="font-display text-3xl text-ink sm:text-4xl">
          Reservation expired
        </h1>
        <div className="mt-6 max-w-2xl">
          <Notice tone="caution">
            This reservation is no longer active. Your chosen time was
            released. Please start a new booking.
          </Notice>
          <div className="mt-5">
            <Link to="/services" className={buttonClass('primary', 'md')}>
              Book again
              <IconArrow />
            </Link>
          </div>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell userName={user.preferredName}>
      <header>
        <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
          Checkout
        </p>
        <h1 className="font-display mt-2 text-3xl text-ink sm:text-4xl">
          Complete your payment
        </h1>
      </header>

      <nav
        aria-label="Booking progress"
        className="texture-night mt-6 rounded-lg border border-night-line bg-night px-5 py-4"
      >
        <StepIndicator steps={BOOKING_STEPS} current={3} />
      </nav>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1fr_1fr]">
        <Card>
          <h2 className="text-sm font-semibold tracking-wide text-ink">
            Your reservation
          </h2>
          <dl className="mt-4 divide-y divide-line text-sm">
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Service</dt>
              <dd className="text-right text-ink">
                {appointment.serviceNameSnapshot}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Sacred House</dt>
              <dd className="text-right text-ink">
                {appointment.houseNameSnapshot}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Date and time</dt>
              <dd className="text-right text-ink">
                {formatUtcSqlInTimezone(appointment.startsAtUtc, userTimezone)}
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Timezone</dt>
              <dd className="text-right text-ink">{userTimezone}</dd>
            </div>
            <div className="flex justify-between gap-4 py-2.5">
              <dt className="text-ink-soft">Duration</dt>
              <dd className="text-right text-ink">
                {appointment.durationMinutesSnapshot} minutes
              </dd>
            </div>
            <div className="flex justify-between gap-4 py-3">
              <dt className="font-semibold text-ink">Amount</dt>
              <dd className="font-display text-right text-lg text-ink">
                {formatAmountMinor(
                  appointment.priceMinorSnapshot,
                  appointment.currencySnapshot,
                )}
              </dd>
            </div>
          </dl>
          {countdown && countdown !== 'expired' ? (
            <div className="mt-5">
              <Notice tone="caution">
                Reservation held for {countdown}. Complete payment before the
                hold expires.
              </Notice>
            </div>
          ) : null}
        </Card>

        <div className="grid gap-6">
          <Card>
            <h2 className="text-sm font-semibold tracking-wide text-ink">
              Choose a payment method
            </h2>
            {checkout.providers.length === 0 ? (
              <div className="mt-4">
                <Notice>
                  No payment method is currently available for this
                  appointment. Please contact support.
                </Notice>
              </div>
            ) : (
              <ul className="mt-4 flex flex-col gap-3">
                {checkout.providers.map((provider) => (
                  <li key={provider.code}>
                    <button
                      type="button"
                      onClick={() => void handlePay(provider.code)}
                      disabled={busyProvider !== null}
                      className="flex w-full items-center justify-between gap-3 rounded-md border border-line-strong px-4 py-3 text-left text-sm font-semibold text-ink transition-colors hover:border-gold-deep hover:text-gold-deep disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {busyProvider === provider.code
                        ? 'Starting payment…'
                        : `Pay with ${provider.displayName}`}
                      <IconArrow />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-5">
              <ErrorNotice message={error} />
            </div>

            <p className="mt-4 text-xs leading-relaxed text-ink-soft">
              Payment confirmation always comes from the verified payment
              provider — never from returning to this page.
            </p>
          </Card>

          {mockAttempt ? (
            <div className="rounded-lg border border-dashed border-line-strong bg-surface p-6">
              <h2 className="text-sm font-semibold tracking-wide text-ink">
                Development simulator (mock provider)
              </h2>
              <p className="mt-1 text-xs text-ink-soft">
                Available only while the mock payment provider is selected;
                production refuses it outright.
              </p>
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
                    className="rounded-md border border-line-strong px-3 py-2 text-xs text-ink transition-colors hover:border-gold-deep hover:text-gold-deep disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </AppShell>
  )
}
