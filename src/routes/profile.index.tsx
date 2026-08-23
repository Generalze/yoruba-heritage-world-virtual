import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { getCurrentUserFn } from '@/auth/actions'
import { getMyProfileFn } from '@/services/profile-actions'
import { AppShell } from '@/components/app-shell'
import { Card, IconArrow, Notice } from '@/components/ui'

/**
 * Profile overview (Step 21A.2) on the shared authenticated shell.
 * Every value shown is the acting user's own stored record; an absent
 * field is stated plainly as "not provided" rather than filled with a
 * placeholder that would read as data.
 */
export const Route = createFileRoute('/profile/')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: () => getMyProfileFn(),
  head: () => ({
    meta: [{ title: 'Your profile — Yorùbá Heritage World Virtual' }],
  }),
  component: ProfileOverview,
})

function ProfileOverview() {
  const data = Route.useLoaderData()
  const { profile, completion, consents } = data

  return (
    <AppShell userName={data.user.preferredName}>
      <header>
        <p className="text-xs font-semibold tracking-[0.28em] text-gold-deep uppercase">
          Your account
        </p>
        <h1 className="font-display mt-2 text-3xl text-ink sm:text-4xl">
          Your profile
        </h1>
      </header>

      <div className="mt-6">
        {completion.complete ? (
          <Notice tone="affirm">
            Your profile is complete. Your account is ready for service
            booking.
          </Notice>
        ) : (
          <Notice tone="caution">
            Your profile is incomplete. Complete it before booking a spiritual
            service.
          </Notice>
        )}
      </div>

      {!completion.ageEligible && profile?.dateOfBirth ? (
        <div className="mt-3">
          <Notice>
            Spiritual-service booking requires being 18 or older. Your account
            remains available for browsing.
          </Notice>
        </div>
      ) : null}

      <div className="mt-8 grid gap-6">
        <Card>
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-sm font-semibold tracking-wide text-ink">
              Personal details
            </h2>
            <Link
              to="/profile/edit"
              className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
            >
              Edit
              <IconArrow />
            </Link>
          </div>
          <dl className="mt-4 divide-y divide-line text-sm">
            <Row label="Full name" value={profile?.fullName ?? null} />
            <Row label="Preferred name" value={data.user.preferredName} />
            <Row label="Phone" value={profile?.phoneE164 ?? null} />
            <Row label="Country" value={profile?.countryCode ?? null} />
            <Row label="Timezone" value={profile?.timezone ?? null} />
            <Row
              label="Language"
              value={
                data.languages.find(
                  (language) => language.code === profile?.preferredLanguage,
                )?.name ?? null
              }
            />
            <Row label="Date of birth" value={profile?.dateOfBirth ?? null} />
          </dl>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold tracking-wide text-ink">
                Private spiritual interests
              </h2>
              <Link
                to="/profile/spiritual"
                className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
              >
                Edit
                <IconArrow />
              </Link>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              {data.interestIds.length === 0
                ? 'No interests selected — this is optional.'
                : `${data.interestIds.length} selected.`}{' '}
              Your selections are private and never shown publicly.
            </p>
          </Card>

          <Card>
            <div className="flex items-center justify-between gap-4">
              <h2 className="text-sm font-semibold tracking-wide text-ink">
                Notices and consent
              </h2>
              <Link
                to="/profile/consents"
                className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
              >
                Review
                <IconArrow />
              </Link>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-ink-soft">
              {completion.requiredConsentsAccepted
                ? 'Required notices accepted.'
                : 'Required notices not yet accepted.'}{' '}
              Updates &amp; announcements:{' '}
              {consents.marketingOptIn ? 'subscribed' : 'not subscribed'}.
            </p>
          </Card>
        </div>
      </div>
    </AppShell>
  )
}

function Row(props: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4 py-2.5">
      <dt className="text-ink-soft">{props.label}</dt>
      <dd
        className={
          props.value ? 'text-right text-ink' : 'text-right text-ink-soft italic'
        }
      >
        {props.value ?? 'not provided'}
      </dd>
    </div>
  )
}
