import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { getCurrentUserFn, logoutFn } from '@/auth/actions'
import { getMyCompletionFn } from '@/services/profile-actions'
import { getMyAppointmentsFn } from '@/services/booking-actions'
import { AppShell } from '@/components/app-shell'
import {
  Badge,
  Button,
  Card,
  CheckItem,
  IconArrow,
  Notice,
  ProgressRing,
  buttonClass,
} from '@/components/ui'
import { formatUtcSqlInTimezone, msUntilUtcSql } from '@/lib/display-time'

/**
 * The signed-in dashboard (Step 21A.2), following Screen 2 of the
 * approved reference: dark sidebar, warm cream workspace, restrained
 * cards, strong hierarchy.
 *
 * EVERY figure here is the acting user's OWN record. Nothing is
 * fabricated: no member id (the platform issues none), no invented
 * verification state, no location or statistic that is not stored, no
 * appointment that does not exist. The completion dial is computed
 * from the SAME missing-field list the server returns, and the
 * checklist prints each item in words, so the ring is never the only
 * way to read it.
 */

export const Route = createFileRoute('/dashboard')({
  // Server-side protection: unauthenticated visitors are redirected to
  // login before this route ever loads. The check runs on the server
  // (SSR) and via server-fn RPC on client navigation.
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ context }) => {
    const [status, appointments] = await Promise.all([
      getMyCompletionFn(),
      getMyAppointmentsFn(),
    ])
    // Resolved HERE rather than at render time: the loader result is
    // serialized once and reused for hydration, so "upcoming" cannot
    // disagree between the server pass and the client pass.
    const nowMs = Date.now()
    const upcoming =
      appointments
        .filter(
          (row) =>
            (row.status === 'CONFIRMED' || row.status === 'PENDING_PAYMENT') &&
            msUntilUtcSql(row.startsAtUtc, nowMs) > 0,
        )
        .sort((a, b) => a.startsAtUtc.localeCompare(b.startsAtUtc))
        .at(0) ?? null
    return { user: context.user, status, upcoming }
  },
  head: () => ({
    meta: [{ title: 'Dashboard — Yorùbá Heritage World Virtual' }],
  }),
  component: DashboardPage,
})

/** The six stored personal fields plus the required notices — exactly
 * what `getProfileCompletion` measures, in reading order. */
const COMPLETION_STEPS: ReadonlyArray<{ field: string; label: string }> = [
  { field: 'fullName', label: 'Full name' },
  { field: 'phone', label: 'Phone number' },
  { field: 'country', label: 'Country' },
  { field: 'timezone', label: 'Timezone' },
  { field: 'preferredLanguage', label: 'Preferred language' },
  { field: 'dateOfBirth', label: 'Date of birth' },
]

/** Fixed locale: the same string must render on the server and after
 * hydration, so the runtime default locale is never consulted. */
function formatJoined(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) return null
  return new Intl.DateTimeFormat('en', {
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function DashboardPage() {
  const { user, status, upcoming } = Route.useLoaderData()
  const logout = useServerFn(logoutFn)
  const router = useRouter()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  async function handleLogout() {
    setBusy(true)
    try {
      await logout()
      await router.invalidate()
      await navigate({ to: '/' })
    } finally {
      setBusy(false)
    }
  }

  const { completion, eligibility } = status
  const missing = new Set(completion.missingFields)
  const doneSteps =
    COMPLETION_STEPS.filter((step) => !missing.has(step.field)).length +
    (completion.requiredConsentsAccepted ? 1 : 0)
  const totalSteps = COMPLETION_STEPS.length + 1
  const joined = formatJoined(user.createdAt)

  const nextSteps: Array<{ label: string; to: string }> = []
  if (completion.missingFields.length > 0) {
    nextSteps.push({
      label: 'Complete your personal details',
      to: '/profile/edit',
    })
  }
  if (!completion.requiredConsentsAccepted) {
    nextSteps.push({
      label: 'Accept the required notices',
      to: '/profile/consents',
    })
  }
  if (completion.complete && completion.ageEligible) {
    nextSteps.push({
      label: 'Browse services and book an appointment',
      to: '/services',
    })
  }
  nextSteps.push({
    label: 'Review your private spiritual interests',
    to: '/profile/spiritual',
  })

  return (
    <AppShell
      userName={user.preferredName}
      actions={
        <Button variant="secondary" onClick={handleLogout} disabled={busy}>
          {busy ? 'Signing out…' : 'Sign out'}
        </Button>
      }
    >
      <header>
        <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
          Your account
        </p>
        <h1 className="font-display mt-2 text-3xl text-ink sm:text-4xl">
          Ẹ káàbọ̀, {user.preferredName}
        </h1>
      </header>

      <div className="mt-6">
        {completion.complete ? (
          <Notice tone="affirm">
            Your profile is complete. Your account is ready for service
            booking.{' '}
            <Link
              to="/services"
              className="font-semibold underline underline-offset-4"
            >
              Browse services
            </Link>
          </Notice>
        ) : (
          <Notice tone="caution">
            Your profile is incomplete. Complete it before booking a spiritual
            service.{' '}
            <Link
              to="/profile/edit"
              className="font-semibold underline underline-offset-4"
            >
              Continue
            </Link>
          </Notice>
        )}
      </div>

      {eligibility.reasons.includes('AGE_REQUIREMENT_NOT_MET') &&
      completion.missingFields.length === 0 ? (
        <div className="mt-3">
          <Notice>
            Spiritual-service booking requires being 18 or older. Your account
            remains available for browsing.
          </Notice>
        </div>
      ) : null}

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
        {/* Completion — the dial, then the same facts in words */}
        <Card>
          <h2 className="text-sm font-semibold tracking-wide text-ink">
            Complete your profile
          </h2>
          <div className="mt-4 flex items-center gap-5">
            <ProgressRing done={doneSteps} total={totalSteps} />
            <p className="text-sm leading-relaxed text-ink-soft">
              {doneSteps} of {totalSteps} steps complete.{' '}
              {completion.complete
                ? 'Nothing further is required.'
                : 'The remaining items are listed below.'}
            </p>
          </div>
          <ul className="mt-5 divide-y divide-line">
            {COMPLETION_STEPS.map((step) => (
              <CheckItem
                key={step.field}
                label={step.label}
                done={!missing.has(step.field)}
              />
            ))}
            <CheckItem
              label="Required notices accepted"
              done={completion.requiredConsentsAccepted}
            />
          </ul>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link to="/profile/edit" className={buttonClass('primary', 'md')}>
              Edit personal details
            </Link>
            <Link to="/profile" className={buttonClass('secondary', 'md')}>
              View profile
            </Link>
          </div>
        </Card>

        {/* Summary — only fields the account actually holds */}
        <Card>
          <div className="flex items-start justify-between gap-4">
            <h2 className="text-sm font-semibold tracking-wide text-ink">
              Profile summary
            </h2>
            <Badge>{user.accountStatus}</Badge>
          </div>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">Preferred name</dt>
              <dd className="text-right text-ink">{user.preferredName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">Email</dt>
              <dd className="text-right break-words text-ink">{user.email}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">Email address</dt>
              <dd className="text-right text-ink">
                {user.emailVerifiedAt ? 'Verified' : 'Not yet verified'}
              </dd>
            </div>
            {joined ? (
              <div className="flex justify-between gap-4">
                <dt className="text-ink-soft">Member since</dt>
                <dd className="text-right text-ink">{joined}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">Required notices</dt>
              <dd className="text-right text-ink">
                {completion.requiredConsentsAccepted
                  ? 'Accepted'
                  : 'Not accepted'}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">Updates and announcements</dt>
              <dd className="text-right text-ink">
                {completion.marketingOptIn ? 'Subscribed' : 'Not subscribed'}
              </dd>
            </div>
          </dl>
          <div className="mt-5">
            <Link
              to="/profile/consents"
              className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
            >
              Review notices and consent
              <IconArrow />
            </Link>
          </div>
        </Card>
      </div>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-2">
        {/* Upcoming appointment — the user's own booking, or nothing */}
        <Card>
          <h2 className="text-sm font-semibold tracking-wide text-ink">
            Upcoming appointment
          </h2>
          {upcoming ? (
            <div className="mt-4">
              <p className="font-display text-lg text-ink">
                {upcoming.serviceNameSnapshot}
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                {upcoming.houseNameSnapshot}
              </p>
              <p className="mt-3 text-sm text-ink">
                {formatUtcSqlInTimezone(
                  upcoming.startsAtUtc,
                  upcoming.userTimezone,
                )}
              </p>
              <p className="mt-1 text-xs text-ink-soft">
                Shown in your timezone ({upcoming.userTimezone}).
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Badge>{upcoming.status.replace('_', ' ')}</Badge>
                <Link
                  to="/appointments/$publicId"
                  params={{ publicId: upcoming.publicId }}
                  className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
                >
                  View details
                  <IconArrow />
                </Link>
              </div>
            </div>
          ) : (
            <div className="mt-4">
              <p className="text-sm leading-relaxed text-ink-soft">
                You have no upcoming appointments.
              </p>
              <div className="mt-4">
                <Link
                  to="/appointments"
                  className={buttonClass('secondary', 'md')}
                >
                  View all appointments
                </Link>
              </div>
            </div>
          )}
        </Card>

        {/* Next steps — each one links to a route that exists */}
        <Card>
          <h2 className="text-sm font-semibold tracking-wide text-ink">
            Next steps
          </h2>
          <ul className="mt-4 divide-y divide-line">
            {nextSteps.map((step) => (
              <li key={step.to}>
                <Link
                  to={step.to}
                  className="flex items-center justify-between gap-4 py-3 text-sm text-ink transition-colors hover:text-gold-deep"
                >
                  {step.label}
                  <IconArrow />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </AppShell>
  )
}
