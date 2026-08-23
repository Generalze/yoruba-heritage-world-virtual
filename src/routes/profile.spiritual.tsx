import { useState } from 'react'
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
  getMyProfileFn,
  saveSpiritualInterestsFn,
} from '@/services/profile-actions'
import { AppShell } from '@/components/app-shell'
import { Card, ErrorNotice, buttonClass } from '@/components/ui'

/**
 * Private spiritual interests (Step 21A.2) on the shared authenticated
 * shell. The interest catalogue is the real active list; selections
 * are the acting user's own and are never shown publicly. Restyle
 * only — the toggle behaviour and server contract are unchanged.
 */
export const Route = createFileRoute('/profile/spiritual')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: () => getMyProfileFn(),
  head: () => ({
    meta: [{ title: 'Spiritual interests — Yorùbá Heritage World Virtual' }],
  }),
  component: SpiritualProfilePage,
})

function SpiritualProfilePage() {
  const data = Route.useLoaderData()
  const save = useServerFn(saveSpiritualInterestsFn)
  const router = useRouter()
  const navigate = useNavigate()
  const [selected, setSelected] = useState<Set<number>>(
    new Set(data.interestIds),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  function toggle(id: number) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSave() {
    setError(null)
    setBusy(true)
    try {
      await save({ data: { interestIds: Array.from(selected) } })
      await router.invalidate()
      await navigate({ to: '/profile' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save.')
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
          Spiritual interests
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          Select any areas you would like your spiritual journey to focus on —
          none, one, or several. Your selections are private: they are never
          shown publicly and never shared. They do not commit you to any deity,
          Sacred House or service.
        </p>
      </header>

      <div className="mt-8 max-w-3xl">
        <Card>
          <fieldset>
            <legend className="text-sm font-semibold tracking-wide text-ink">
              Areas of interest
              <span className="ml-2 font-normal text-ink-soft">
                ({selected.size} selected)
              </span>
            </legend>
            <ul className="mt-4 grid gap-2 sm:grid-cols-2">
              {data.catalogue.map((interest) => {
                const isSelected = selected.has(interest.id)
                return (
                  <li key={interest.id}>
                    <label
                      className={`flex cursor-pointer items-center gap-3 rounded-md border px-4 py-3 text-sm transition-colors ${
                        isSelected
                          ? 'border-gold-deep bg-surface text-ink'
                          : 'border-line bg-surface-raised text-ink hover:border-gold-deep'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggle(interest.id)}
                        className="h-4 w-4 shrink-0 accent-[var(--color-gold-deep)]"
                      />
                      {interest.name}
                    </label>
                  </li>
                )
              })}
            </ul>
          </fieldset>

          <div className="mt-6">
            <ErrorNotice message={error} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className={`${buttonClass('primary', 'md')} disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {busy ? 'Saving…' : 'Save interests'}
            </button>
            <Link to="/profile" className={buttonClass('secondary', 'md')}>
              Cancel
            </Link>
          </div>
        </Card>
      </div>
    </AppShell>
  )
}
