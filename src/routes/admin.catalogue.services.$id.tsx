import { useState } from 'react'
import {
  Link,
  createFileRoute,
  notFound,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  AdminError,
  AdminField,
  StatusBadge,
  WorkflowActions,
  adminInputClass,
} from '@/components/admin'
import {
  adminGetServiceFn,
  adminListSacredHousesFn,
  adminServiceWorkflowFn,
  adminUpdateServiceFn,
} from '@/services/admin-catalogue-actions'
import type { WorkflowEvent } from '@/services/admin-catalogue'

export const Route = createFileRoute('/admin/catalogue/services/$id')({
  params: {
    parse: (params) => ({ id: z.coerce.number().int().parse(params.id) }),
    stringify: (params) => ({ id: String(params.id) }),
  },
  loader: async ({ params }) => {
    const [service, houses] = await Promise.all([
      adminGetServiceFn({ data: { id: params.id } }),
      adminListSacredHousesFn(),
    ])
    if (!service) throw notFound()
    return { service, houses }
  },
  notFoundComponent: () => (
    <div>
      <p>Service not found.</p>
      <Link
        to="/admin/catalogue/services"
        className="text-gold-deep hover:text-ink"
      >
        Back to services
      </Link>
    </div>
  ),
  component: EditServicePage,
})

function EditServicePage() {
  const { service, houses } = Route.useLoaderData()
  const update = useServerFn(adminUpdateServiceFn)
  const workflow = useServerFn(adminServiceWorkflowFn)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const editable =
    service.serviceStatus === 'DRAFT' || service.serviceStatus === 'APPROVED'
  const houseChangeable = service.serviceStatus === 'DRAFT'

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

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const duration = String(form.get('durationMinutes') ?? '').trim()
    const price = String(form.get('priceMinor') ?? '').trim()
    const currency = String(form.get('currency') ?? '').trim()
    await run(() =>
      update({
        data: {
          id: service.id,
          name: String(form.get('name') ?? ''),
          slug: String(form.get('slug') ?? ''),
          shortDescription: String(form.get('shortDescription') ?? ''),
          sortOrder: Number(form.get('sortOrder') ?? 0),
          ...(houseChangeable
            ? { sacredHouseId: Number(form.get('sacredHouseId')) }
            : {}),
          durationMinutes: duration === '' ? null : Number(duration),
          priceMinor: price === '' ? null : Number(price),
          currency: currency === '' ? null : currency.toUpperCase(),
        },
      }),
    )
  }

  function handleEvent(event: WorkflowEvent, note?: string) {
    void run(() => workflow({ data: { id: service.id, event, note } }))
  }

  return (
    <div className="max-w-2xl">
      <Link
        to="/admin/catalogue/services"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← All services
      </Link>
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{service.name}</h1>
        <StatusBadge status={service.serviceStatus} />
      </div>
      <p className="mt-1 font-mono text-xs text-ink-soft">{service.code}</p>

      {service.reviewNote ? (
        <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
          Returned by review: {service.reviewNote}
        </p>
      ) : null}

      <form onSubmit={handleSave} className="mt-6 space-y-4">
        <AdminField label="Sacred House (changeable while DRAFT)">
          <select
            name="sacredHouseId"
            defaultValue={service.sacredHouseId}
            disabled={!houseChangeable}
            className="w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-ink disabled:opacity-60"
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
            defaultValue={service.name}
            required
            maxLength={150}
            disabled={!editable}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="URL slug">
          <input
            name="slug"
            defaultValue={service.slug}
            required
            maxLength={100}
            disabled={!editable}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="Approved short description">
          <textarea
            name="shortDescription"
            defaultValue={service.shortDescription ?? ''}
            maxLength={1000}
            rows={3}
            disabled={!editable}
            className={adminInputClass}
          />
        </AdminField>
        <div className="grid grid-cols-3 gap-3">
          <AdminField label="Duration (min)">
            <input
              name="durationMinutes"
              type="number"
              min={1}
              max={1440}
              defaultValue={service.durationMinutes ?? ''}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Price (minor units)">
            <input
              name="priceMinor"
              type="number"
              min={0}
              defaultValue={service.priceMinor ?? ''}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Currency">
            <input
              name="currency"
              maxLength={3}
              pattern="[A-Za-z]{3}"
              defaultValue={service.currency ?? ''}
              className={adminInputClass}
            />
          </AdminField>
        </div>
        <p className="text-xs text-ink-soft">
          Leave duration/price/currency empty unless authorised values exist —
          empty fields display publicly as “details provided when opened for
          booking”.
        </p>
        {service.serviceStatus === 'APPROVED' ? (
          <p className="text-xs text-gold-deep">
            Warning: editing this approved service’s name, slug or description
            removes its approval — it returns to DRAFT and must go through
            review again before it can be published.
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-night hover:bg-gold-bright disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <AdminError message={error} />
      <WorkflowActions
        events={service.events}
        busy={busy}
        onEvent={handleEvent}
      />
    </div>
  )
}
