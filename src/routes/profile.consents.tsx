import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import {
  SPIRITUAL_SERVICE_NOTICE_BODY,
  SPIRITUAL_SERVICE_NOTICE_PLACEHOLDER,
  SPIRITUAL_SERVICE_NOTICE_TITLE,
} from '@/lib/spiritual-service-notice'

import { getCurrentUserFn } from '@/auth/actions'
import {
  acceptRequiredConsentsFn,
  getMyProfileFn,
  setMarketingPreferenceFn,
} from '@/services/profile-actions'
import { AppShell } from '@/components/app-shell'
import { Card, ErrorNotice, buttonClass } from '@/components/ui'

/**
 * Notices and consent (Step 21A.2) on the shared authenticated shell.
 * The notice text is the platform's approved wording, rendered as
 * plain text — never as raw HTML. Acceptance state, versions and the
 * optional marketing preference are the acting user's real records,
 * and the server remains the authority for all of them.
 */
export const Route = createFileRoute('/profile/consents')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: () => getMyProfileFn(),
  head: () => ({
    meta: [{ title: 'Notices and consent — Yorùbá Heritage World Virtual' }],
  }),
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

  const allAccepted = data.consents.required.every((consent) => consent.accepted)

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
    <AppShell userName={data.user.preferredName}>
      <header>
        <Link
          to="/profile"
          className="inline-flex items-center gap-2 text-sm font-semibold text-gold-deep transition-colors hover:text-ink"
        >
          <span aria-hidden="true">←</span>
          Your profile
        </Link>
        <h1 className="font-display mt-3 text-3xl text-ink sm:text-4xl">
          Notices and consent
        </h1>
      </header>

      <div className="mt-8 grid max-w-3xl gap-6">
        <Card>
          <h2 className="text-sm font-semibold tracking-wide text-ink">
            Required notices
          </h2>
          <ul className="mt-4 divide-y divide-line text-sm">
            {data.consents.required.map((consent) => (
              <li
                key={consent.type}
                className="flex items-center justify-between gap-4 py-2.5"
              >
                <span className="text-ink">
                  {NOTICE_TITLES[consent.type] ?? consent.type}
                </span>
                {consent.accepted ? (
                  <span className="shrink-0 text-xs text-affirm">
                    Accepted (v{consent.currentVersion})
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-caution">
                    Not accepted
                  </span>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-5 rounded-md border border-line bg-surface p-4 text-xs leading-relaxed text-ink-soft">
            <p className="font-semibold text-ink">
              {SPIRITUAL_SERVICE_NOTICE_TITLE}
            </p>
            <p className="mt-2">{SPIRITUAL_SERVICE_NOTICE_BODY}</p>
            <p className="mt-2">{SPIRITUAL_SERVICE_NOTICE_PLACEHOLDER}</p>
          </div>

          {!allAccepted ? (
            <div className="mt-5">
              <label className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-ink">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                  className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-gold-deep)]"
                />
                I have read and accept the Terms of Service, the Privacy
                Notice, and the Spiritual Service Notice.
              </label>
              <button
                type="button"
                disabled={busy || !agreed}
                onClick={() => void run(() => acceptAll())}
                className={`${buttonClass('primary', 'md')} mt-4 disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {busy ? 'Saving…' : 'Accept required notices'}
              </button>
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 className="text-sm font-semibold tracking-wide text-ink">
            Updates and announcements (optional)
          </h2>
          <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm leading-relaxed text-ink">
            <input
              type="checkbox"
              checked={data.consents.marketingOptIn}
              disabled={busy}
              onChange={(event) =>
                void run(() =>
                  setMarketing({ data: { optIn: event.target.checked } }),
                )
              }
              className="mt-1 h-4 w-4 shrink-0 accent-[var(--color-gold-deep)]"
            />
            I would like to receive updates, spiritual programmes and
            announcements.
          </label>
          <p className="mt-3 text-xs leading-relaxed text-ink-soft">
            Entirely optional — declining never affects your account, your
            profile completion, or future service booking. You can change this
            at any time.
          </p>
        </Card>

        <ErrorNotice message={error} />
      </div>
    </AppShell>
  )
}
