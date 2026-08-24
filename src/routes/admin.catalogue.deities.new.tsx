import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { AdminError, AdminField, adminInputClass } from '@/components/admin'
import { adminCreateDeityFn } from '@/services/admin-catalogue-actions'

export const Route = createFileRoute('/admin/catalogue/deities/new')({
  component: NewDeityPage,
})

function NewDeityPage() {
  const create = useServerFn(adminCreateDeityFn)
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
      await navigate({ to: '/admin/catalogue/deities/$id', params: { id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create profile.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold">New deity profile</h1>
      <p className="mt-2 text-sm text-ink-soft">
        New profiles always start as DRAFT — publication requires review and
        approval. Enter only approved content; leave the description empty if
        approved text does not exist yet.
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
        <AdminField label="Machine code (ASCII, e.g. OSUN)">
          <input
            name="code"
            required
            maxLength={50}
            pattern="[A-Z][A-Z0-9_]+"
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="URL slug (ASCII, e.g. osun)">
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
          className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-night hover:bg-gold-bright disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create draft'}
        </button>
      </form>
    </div>
  )
}
