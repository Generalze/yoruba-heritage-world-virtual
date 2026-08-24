import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { AdminError, AdminField, adminInputClass } from '@/components/admin'
import {
  adminCreateServiceFn,
  adminListSacredHousesFn,
} from '@/services/admin-catalogue-actions'

export const Route = createFileRoute('/admin/catalogue/services/new')({
  loader: () => adminListSacredHousesFn(),
  component: NewServicePage,
})

function NewServicePage() {
  const houses = Route.useLoaderData()
  const create = useServerFn(adminCreateServiceFn)
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
          sacredHouseId: Number(form.get('sacredHouseId')),
          code: String(form.get('code') ?? ''),
          name: String(form.get('name') ?? ''),
          slug: String(form.get('slug') ?? ''),
          shortDescription: String(form.get('shortDescription') ?? ''),
        },
      })
      await navigate({ to: '/admin/catalogue/services/$id', params: { id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create service.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold">New service</h1>
      <p className="mt-2 text-sm text-ink-soft">
        New services start as DRAFT. Prices and durations stay empty until
        authorised values exist — the system never invents them.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <AdminField label="Sacred House">
          <select
            name="sacredHouseId"
            required
            className="w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-ink"
          >
            {houses.map((house) => (
              <option key={house.id} value={house.id}>
                {house.name}
              </option>
            ))}
          </select>
        </AdminField>
        <AdminField label="Service name">
          <input
            name="name"
            required
            maxLength={150}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="Machine code (ASCII, e.g. OSUN_FERTILITY)">
          <input
            name="code"
            required
            maxLength={50}
            pattern="[A-Z][A-Z0-9_]+"
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="URL slug (ASCII, e.g. osun-fertility)">
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
