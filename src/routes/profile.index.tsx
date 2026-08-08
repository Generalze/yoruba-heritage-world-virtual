import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { getCurrentUserFn } from '@/auth/actions'
import { getMyProfileFn } from '@/services/profile-actions'

export const Route = createFileRoute('/profile/')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: () => getMyProfileFn(),
  component: ProfileOverview,
})

function ProfileOverview() {
  const data = Route.useLoaderData()
  const { profile, completion, consents } = data

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-2xl">
        <Link
          to="/dashboard"
          className="text-sm text-stone-400 hover:text-amber-500"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 text-2xl font-bold">Your profile</h1>

        {completion.complete ? (
          <p className="mt-4 rounded-md border border-emerald-900 bg-emerald-950/50 px-4 py-3 text-sm text-emerald-300">
            Profile complete. Your account is ready for future service booking.
          </p>
        ) : (
          <p className="mt-4 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
            Profile incomplete. Complete your profile before booking a spiritual
            service.
          </p>
        )}
        {!completion.ageEligible && profile?.dateOfBirth ? (
          <p className="mt-3 rounded-md border border-stone-700 bg-stone-900 px-4 py-3 text-xs text-stone-400">
            Spiritual-service booking requires being 18 or older. Your account
            remains available for browsing.
          </p>
        ) : null}

        <section className="mt-8 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Personal details
            </h2>
            <Link
              to="/profile/edit"
              className="text-sm text-amber-500 hover:text-amber-400"
            >
              Edit
            </Link>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Full name" value={profile?.fullName ?? null} />
            <Row label="Preferred name" value={data.user.preferredName} />
            <Row label="Phone" value={profile?.phoneE164 ?? null} />
            <Row label="Country" value={profile?.countryCode ?? null} />
            <Row label="Timezone" value={profile?.timezone ?? null} />
            <Row
              label="Language"
              value={
                data.languages.find(
                  (l) => l.code === profile?.preferredLanguage,
                )?.name ?? null
              }
            />
            <Row label="Date of birth" value={profile?.dateOfBirth ?? null} />
          </dl>
        </section>

        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Private spiritual interests
            </h2>
            <Link
              to="/profile/spiritual"
              className="text-sm text-amber-500 hover:text-amber-400"
            >
              Edit
            </Link>
          </div>
          <p className="mt-3 text-sm text-stone-400">
            {data.interestIds.length === 0
              ? 'No interests selected — this is optional.'
              : `${data.interestIds.length} selected.`}{' '}
            Your selections are private and never shown publicly.
          </p>
        </section>

        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
              Notices and consent
            </h2>
            <Link
              to="/profile/consents"
              className="text-sm text-amber-500 hover:text-amber-400"
            >
              Review
            </Link>
          </div>
          <p className="mt-3 text-sm text-stone-400">
            {completion.requiredConsentsAccepted
              ? 'Required notices accepted.'
              : 'Required notices not yet accepted.'}{' '}
            Updates &amp; announcements:{' '}
            {consents.marketingOptIn ? 'subscribed' : 'not subscribed'}.
          </p>
        </section>
      </div>
    </main>
  )
}

function Row(props: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-stone-400">{props.label}</dt>
      <dd className={props.value ? '' : 'text-stone-600 italic'}>
        {props.value ?? 'not provided'}
      </dd>
    </div>
  )
}
