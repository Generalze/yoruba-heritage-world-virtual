import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { getCurrentUserFn } from '@/auth/actions'
import { AdminError } from '@/components/admin'
import {
  acceptRequiredConsentsFn,
  getMyProfileFn,
  setMarketingPreferenceFn,
} from '@/services/profile-actions'

export const Route = createFileRoute('/profile/consents')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: () => getMyProfileFn(),
  component: ConsentsPage,
})

const NOTICE_TITLES: Record<string, string> = {
  TERMS: 'Terms of Service',
  PRIVACY: 'Privacy Notice',
  SPIRITUAL_NOTICE: 'Spiritual Service Notice',
}

function ConsentsPage() {
  const data = Route.useLoaderData()
  const acceptAll = useServerFn(acceptRequiredConsentsFn)
  const setMarketing = useServerFn(setMarketingPreferenceFn)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [agreed, setAgreed] = useState(false)

  const allAccepted = data.consents.required.every((c) => c.accepted)

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-xl">
        <Link
          to="/profile"
          className="text-sm text-stone-400 hover:text-amber-500"
        >
          ← Your profile
        </Link>
        <h1 className="mt-3 text-2xl font-bold">Notices and consent</h1>

        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            Required notices
          </h2>
          <ul className="mt-4 space-y-3 text-sm">
            {data.consents.required.map((consent) => (
              <li
                key={consent.type}
                className="flex items-center justify-between gap-4"
              >
                <span>{NOTICE_TITLES[consent.type] ?? consent.type}</span>
                {consent.accepted ? (
                  <span className="text-xs text-emerald-400">
                    accepted (v{consent.currentVersion})
                  </span>
                ) : (
                  <span className="text-xs text-amber-500">not accepted</span>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-5 rounded-md border border-stone-700 bg-stone-950 p-4 text-xs leading-relaxed text-stone-400">
            <p className="font-medium text-stone-300">
              Spiritual Service Notice
            </p>
            <p className="mt-2">
              Spiritual and cultural services offered on this platform do not
              guarantee outcomes and are not substitutes for medical care, legal
              advice, financial advice, psychiatric or mental-health care, or
              emergency services. If you need urgent help, contact the
              appropriate professional or emergency service.
            </p>
            <p className="mt-2 text-stone-500">
              Development placeholder notice text (v1) — final legal wording and
              versions are provided before production.
            </p>
          </div>

          {!allAccepted ? (
            <div className="mt-5">
              <label className="flex items-start gap-3 text-sm text-stone-300">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                  className="mt-1"
                />
                I have read and accept the Terms of Service, the Privacy Notice,
                and the Spiritual Service Notice.
              </label>
              <button
                type="button"
                disabled={busy || !agreed}
                onClick={() => void run(() => acceptAll())}
                className="mt-4 rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500 disabled:opacity-50"
              >
                {busy ? 'Saving…' : 'Accept required notices'}
              </button>
            </div>
          ) : null}
        </section>

        <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
          <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
            Updates and announcements (optional)
          </h2>
          <label className="mt-4 flex items-start gap-3 text-sm text-stone-300">
            <input
              type="checkbox"
              checked={data.consents.marketingOptIn}
              disabled={busy}
              onChange={(event) =>
                void run(() =>
                  setMarketing({ data: { optIn: event.target.checked } }),
                )
              }
              className="mt-1"
            />
            I would like to receive updates, spiritual programmes and
            announcements.
          </label>
          <p className="mt-3 text-xs text-stone-500">
            Entirely optional — declining never affects your account, your
            profile completion, or future service booking. You can change this
            at any time.
          </p>
        </section>

        <AdminError message={error} />
      </div>
    </main>
  )
}
