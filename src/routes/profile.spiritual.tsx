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
import { AdminError } from '@/components/admin'
import {
  getMyProfileFn,
  saveSpiritualInterestsFn,
} from '@/services/profile-actions'

export const Route = createFileRoute('/profile/spiritual')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: () => getMyProfileFn(),
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
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100">
      <div className="mx-auto w-full max-w-xl">
        <Link
          to="/profile"
          className="text-sm text-stone-400 hover:text-amber-500"
        >
          ← Your profile
        </Link>
        <h1 className="mt-3 text-2xl font-bold">Spiritual interests</h1>
        <p className="mt-2 text-sm text-stone-400">
          Select any areas you would like your spiritual journey to focus on —
          none, one, or several. Your selections are private: they are never
          shown publicly and never shared. They do not commit you to any deity,
          Sacred House or service.
        </p>

        <ul className="mt-6 grid gap-2 sm:grid-cols-2">
          {data.catalogue.map((interest) => (
            <li key={interest.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-md border border-stone-800 bg-stone-900 px-4 py-3 text-sm hover:border-amber-600">
                <input
                  type="checkbox"
                  checked={selected.has(interest.id)}
                  onChange={() => toggle(interest.id)}
                />
                {interest.name}
              </label>
            </li>
          ))}
        </ul>

        <AdminError message={error} />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy}
          className="mt-6 rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save interests'}
        </button>
      </div>
    </main>
  )
}
