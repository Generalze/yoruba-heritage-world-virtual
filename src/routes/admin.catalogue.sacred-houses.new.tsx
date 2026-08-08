import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { AdminError, AdminField, adminInputClass } from '@/components/admin'
import { adminCreateSacredHouseFn } from '@/services/admin-catalogue-actions'

export const Route = createFileRoute('/admin/catalogue/sacred-houses/new')({
  component: NewHousePage,
})

function NewHousePage() {
  const create = useServerFn(adminCreateSacredHouseFn)
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const form = new FormData(event.currentTarget)
    try {
      const { id } = await create({
        data: {
          code: String(form.get('code') ?? ''),
          name: String(form.get('name') ?? ''),
          slug: String(form.get('slug') ?? ''),
          shortDescription: String(form.get('shortDescription') ?? ''),
        },
      })
      await navigate({
        to: '/admin/catalogue/sacred-houses/$id',
        params: { id },
      })
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to create Sacred House.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold">New Sacred House</h1>
      <p className="mt-2 text-sm text-stone-400">
        New Sacred Houses start as DRAFT. Enter only approved content.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <AdminField label="Display name (approved spelling, full diacritics)">
          <input
            name="name"
            required
            maxLength={150}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="Machine code (ASCII, e.g. ABULE_OSUN)">
          <input
            name="code"
            required
            maxLength={50}
            pattern="[A-Z][A-Z0-9_]+"
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="URL slug (ASCII, e.g. abule-osun)">
          <input
            name="slug"
            required
            maxLength={100}
            pattern="[a-z0-9][a-z0-9\-]*"
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="Approved short description (optional)">
          <textarea
            name="shortDescription"
            maxLength={1000}
            rows={3}
            className={adminInputClass}
          />
        </AdminField>
        <AdminError message={error} />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create draft'}
        </button>
      </form>
    </div>
  )
}
