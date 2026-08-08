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
import { AdminError, AdminField, adminInputClass } from '@/components/admin'
import {
  getMyProfileFn,
  savePersonalDetailsFn,
} from '@/services/profile-actions'

export const Route = createFileRoute('/profile/edit')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
  },
  loader: () => getMyProfileFn(),
  component: EditProfilePage,
})

function EditProfilePage() {
  const data = Route.useLoaderData()
  const save = useServerFn(savePersonalDetailsFn)
  const router = useRouter()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const detectedTimezone =
    data.profile?.timezone ??
    (typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'Africa/Lagos')

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const form = new FormData(event.currentTarget)
    try {
      await save({
        data: {
          fullName: String(form.get('fullName') ?? ''),
          preferredName: String(form.get('preferredName') ?? ''),
          phone: String(form.get('phone') ?? ''),
          countryCode: String(form.get('countryCode') ?? ''),
          timezone: String(form.get('timezone') ?? ''),
          preferredLanguage: String(form.get('preferredLanguage') ?? '') as
            'en' | 'yo',
          dateOfBirth: String(form.get('dateOfBirth') ?? ''),
        },
      })
      await router.invalidate()
      await navigate({ to: '/profile' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save profile.')
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
        <h1 className="mt-3 text-2xl font-bold">Personal details</h1>
        <p className="mt-2 text-sm text-stone-400">
          Names support full Yorùbá spelling — enter them exactly as you write
          them.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <AdminField label="Full name">
            <input
              name="fullName"
              defaultValue={data.profile?.fullName ?? ''}
              required
              maxLength={200}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Preferred name (how we address you)">
            <input
              name="preferredName"
              defaultValue={data.user.preferredName}
              required
              maxLength={100}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Phone (international format, e.g. +2348012345678)">
            <input
              name="phone"
              type="tel"
              defaultValue={data.profile?.phoneE164 ?? ''}
              required
              maxLength={20}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Country">
            <select
              name="countryCode"
              defaultValue={data.profile?.countryCode ?? 'NG'}
              required
              className={adminInputClass}
            >
              {data.countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </select>
          </AdminField>
          <AdminField label="Timezone">
            <select
              name="timezone"
              defaultValue={detectedTimezone}
              required
              className={adminInputClass}
            >
              {data.timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </AdminField>
          <AdminField label="Preferred language">
            <select
              name="preferredLanguage"
              defaultValue={data.profile?.preferredLanguage ?? 'en'}
              required
              className={adminInputClass}
            >
              {data.languages.map((language) => (
                <option key={language.code} value={language.code}>
                  {language.name}
                </option>
              ))}
            </select>
          </AdminField>
          <AdminField label="Date of birth">
            <input
              name="dateOfBirth"
              type="date"
              defaultValue={data.profile?.dateOfBirth ?? ''}
              required
              className={adminInputClass}
            />
          </AdminField>
          <p className="text-xs text-stone-500">
            Spiritual-service booking requires being 18 or older.
          </p>
          <AdminError message={error} />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save details'}
          </button>
        </form>
      </div>
    </main>
  )
}
