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

export const Route = createFileRoute('/dashboard')({
  // Server-side protection: unauthenticated visitors are redirected to
  // login before this route ever loads. The check runs on the server
  // (SSR) and via server-fn RPC on client navigation.
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: async ({ context }) => ({
    user: context.user,
    status: await getMyCompletionFn(),
  }),
  component: DashboardPage,
})

function DashboardPage() {
  const { user, status } = Route.useLoaderData()
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

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Welcome, {user.preferredName}</h1>
          <button
            type="button"
            onClick={handleLogout}
            disabled={busy}
            className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300 transition-colors hover:border-amber-500 hover:text-amber-500 disabled:opacity-60"
          >
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>

        {status.completion.complete ? (
          <p className="mt-6 rounded-md border border-emerald-900 bg-emerald-950/50 px-4 py-3 text-sm text-emerald-300">
            Profile complete. Your account is ready for future service booking.{' '}
            <Link
              to="/profile"
              className="text-emerald-200 underline hover:text-emerald-100"
            >
              View profile
            </Link>
          </p>
        ) : (
          <p className="mt-6 rounded-md border border-amber-900 bg-amber-950/40 px-4 py-3 text-sm text-amber-300">
            Profile incomplete. Complete your profile before booking a spiritual
            service.{' '}
            <Link
              to="/profile"
              className="text-amber-200 underline hover:text-amber-100"
            >
              Complete your profile
            </Link>
          </p>
        )}
        {status.eligibility.reasons.includes('AGE_REQUIREMENT_NOT_MET') &&
        status.completion.missingFields.length === 0 ? (
          <p className="mt-3 rounded-md border border-stone-700 bg-stone-900 px-4 py-3 text-xs text-stone-400">
            Note: spiritual-service booking requires being 18 or older. Your
            account remains available for browsing.
          </p>
        ) : null}

        <section className="mt-8 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            Your account
          </h2>
          <dl className="mt-4 space-y-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Preferred name</dt>
              <dd>{user.preferredName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-stone-400">Account status</dt>
              <dd>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-950 px-2.5 py-0.5 text-emerald-400">
                  {user.accountStatus}
                </span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="mt-8 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            Appointments & payments
          </h2>
          <div className="mt-4 flex flex-wrap gap-4 text-sm">
            <Link
              to="/services"
              className="text-stone-300 hover:text-amber-500"
            >
              Browse services
            </Link>
            <Link
              to="/appointments"
              className="text-stone-300 hover:text-amber-500"
            >
              My appointments
            </Link>
            <Link
              to="/payments"
              className="text-stone-300 hover:text-amber-500"
            >
              Payment history
            </Link>
          </div>
        </section>

        <p className="mt-8 text-sm text-stone-500">
          Prayer Rooms and further features arrive in later approved stages.
        </p>
      </div>
    </main>
  )
}
