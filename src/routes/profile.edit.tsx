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
  savePersonalDetailsFn,
} from '@/services/profile-actions'
import { AppShell } from '@/components/app-shell'
import {
  Card,
  ErrorNotice,
  Field,
  IconArrow,
  buttonClass,
  inputClass,
} from '@/components/ui'

/**
 * Personal details form (Step 21A.2) on the shared authenticated
 * shell. The submitted values and the server contract are unchanged
 * from the previous implementation — this pass restyles the surface
 * and nothing else. Validation stays server-side, where it is
 * authoritative.
 */
export const Route = createFileRoute('/profile/edit')({
  beforeLoad: async () => {
    const user = await getCurrentUserFn()
    if (!user) throw redirect({ to: '/login' })
    return { user }
  },
  loader: () => getMyProfileFn(),
  head: () => ({
    meta: [{ title: 'Personal details — Yorùbá Heritage World Virtual' }],
  }),
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
            | 'en'
            | 'yo',
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
          Personal details
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          Names support full Yorùbá spelling — enter them exactly as you write
          them.
        </p>
      </header>

      <div className="mt-8 max-w-2xl">
        <Card>
          <form onSubmit={handleSubmit} className="space-y-5">
            <Field label="Full name">
              <input
                name="fullName"
                defaultValue={data.profile?.fullName ?? ''}
                required
                maxLength={200}
                className={inputClass}
              />
            </Field>
            <Field label="Preferred name (how we address you)">
              <input
                name="preferredName"
                defaultValue={data.user.preferredName}
                required
                maxLength={100}
                className={inputClass}
              />
            </Field>
            <Field label="Phone (international format, e.g. +2348012345678)">
              <input
                name="phone"
                type="tel"
                defaultValue={data.profile?.phoneE164 ?? ''}
                required
                maxLength={20}
                className={inputClass}
              />
            </Field>
            <Field label="Country">
              <select
                name="countryCode"
                defaultValue={data.profile?.countryCode ?? 'NG'}
                required
                className={inputClass}
              >
                {data.countries.map((country) => (
                  <option key={country.code} value={country.code}>
                    {country.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Timezone">
              <select
                name="timezone"
                defaultValue={detectedTimezone}
                required
                className={inputClass}
              >
                {data.timezones.map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Preferred language">
              <select
                name="preferredLanguage"
                defaultValue={data.profile?.preferredLanguage ?? 'en'}
                required
                className={inputClass}
              >
                {data.languages.map((language) => (
                  <option key={language.code} value={language.code}>
                    {language.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Date of birth"
              hint="Spiritual-service booking requires being 18 or older."
            >
              <input
                name="dateOfBirth"
                type="date"
                defaultValue={data.profile?.dateOfBirth ?? ''}
                required
                className={inputClass}
              />
            </Field>

            <ErrorNotice message={error} />

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={busy}
                className={`${buttonClass('primary', 'md')} disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {busy ? 'Saving…' : 'Save details'}
                {busy ? null : <IconArrow />}
              </button>
              <Link to="/profile" className={buttonClass('secondary', 'md')}>
                Cancel
              </Link>
            </div>
          </form>
        </Card>
      </div>
    </AppShell>
  )
}
