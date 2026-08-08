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
  adminDeityWorkflowFn,
  adminGetDeityFn,
  adminListSacredHousesFn,
  adminListServicesFn,
  adminSetDeityHouseLinkFn,
  adminSetDeityServiceLinkFn,
  adminUpdateDeityFn,
} from '@/services/admin-catalogue-actions'
import type { WorkflowEvent } from '@/services/admin-catalogue'

export const Route = createFileRoute('/admin/catalogue/deities/$id')({
  params: {
    parse: (params) => ({ id: z.coerce.number().int().parse(params.id) }),
    stringify: (params) => ({ id: String(params.id) }),
  },
  loader: async ({ params }) => {
    const [deity, houses, services] = await Promise.all([
      adminGetDeityFn({ data: { id: params.id } }),
      adminListSacredHousesFn(),
      adminListServicesFn(),
    ])
    if (!deity) throw notFound()
    return { deity, houses, services }
  },
  notFoundComponent: () => (
    <div>
      <p>Profile not found.</p>
      <Link
        to="/admin/catalogue/deities"
        className="text-amber-500 hover:text-amber-400"
      >
        Back to deity profiles
      </Link>
    </div>
  ),
  component: EditDeityPage,
})

function EditDeityPage() {
  const { deity, houses, services } = Route.useLoaderData()
  const update = useServerFn(adminUpdateDeityFn)
  const workflow = useServerFn(adminDeityWorkflowFn)
  const setHouseLink = useServerFn(adminSetDeityHouseLinkFn)
  const setServiceLink = useServerFn(adminSetDeityServiceLinkFn)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const editable =
    deity.profileStatus === 'DRAFT' || deity.profileStatus === 'APPROVED'
  const relationshipsEditable = editable

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
    await run(() =>
      update({
        data: {
          id: deity.id,
          name: String(form.get('name') ?? ''),
          slug: String(form.get('slug') ?? ''),
          shortDescription: String(form.get('shortDescription') ?? ''),
          sortOrder: Number(form.get('sortOrder') ?? 0),
        },
      }),
    )
  }

  function handleEvent(event: WorkflowEvent, note?: string) {
    void run(() => workflow({ data: { id: deity.id, event, note } }))
  }

  return (
    <div className="max-w-2xl">
      <Link
        to="/admin/catalogue/deities"
        className="text-sm text-stone-400 hover:text-amber-500"
      >
        ← All deity profiles
      </Link>
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{deity.name}</h1>
        <StatusBadge status={deity.profileStatus} />
      </div>
      <p className="mt-1 font-mono text-xs text-stone-500">{deity.code}</p>

      {deity.reviewNote ? (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          Returned by review: {deity.reviewNote}
        </p>
      ) : null}
      {deity.approvedAt ? (
        <p className="mt-2 text-xs text-stone-500">
          Approved {new Date(deity.approvedAt).toLocaleString()}
        </p>
      ) : null}

      <form onSubmit={handleSave} className="mt-6 space-y-4">
        <AdminField label="Display name">
          <input
            name="name"
            defaultValue={deity.name}
            required
            maxLength={150}
            disabled={!editable}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="URL slug">
          <input
            name="slug"
            defaultValue={deity.slug}
            required
            maxLength={100}
            disabled={!editable}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="Approved short description">
          <textarea
            name="shortDescription"
            defaultValue={deity.shortDescription ?? ''}
            maxLength={1000}
            rows={3}
            disabled={!editable}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="Sort order">
          <input
            name="sortOrder"
            type="number"
            defaultValue={deity.sortOrder}
            min={0}
            className={adminInputClass}
          />
        </AdminField>
        {deity.profileStatus === 'APPROVED' ? (
          <p className="text-xs text-amber-500">
            Warning: editing this approved profile (including relationships)
            removes its approval — the record returns to DRAFT and must go
            through review again before it can be published.
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <section className="mt-8">
        <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
          Connected Sacred Houses
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          Relationships are selected explicitly — never inferred.
        </p>
        <ul className="mt-3 space-y-2">
          {houses.map((house) => {
            const linked = deity.linkedHouseIds.includes(house.id)
            return (
              <li key={house.id} className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={linked}
                  disabled={busy || !relationshipsEditable}
                  onChange={() =>
                    void run(() =>
                      setHouseLink({
                        data: {
                          deityId: deity.id,
                          sacredHouseId: house.id,
                          linked: !linked,
                        },
                      }),
                    )
                  }
                />
                <span>{house.name}</span>
                <StatusBadge status={house.status} />
              </li>
            )
          })}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
          Connected services
        </h2>
        <ul className="mt-3 space-y-2">
          {services.map((row) => {
            const linked = deity.linkedServiceIds.includes(row.service.id)
            return (
              <li
                key={row.service.id}
                className="flex items-center gap-3 text-sm"
              >
                <input
                  type="checkbox"
                  checked={linked}
                  disabled={busy || !relationshipsEditable}
                  onChange={() =>
                    void run(() =>
                      setServiceLink({
                        data: {
                          deityId: deity.id,
                          serviceId: row.service.id,
                          linked: !linked,
                        },
                      }),
                    )
                  }
                />
                <span>
                  {row.service.name}
                  <span className="text-stone-500"> — {row.houseName}</span>
                </span>
              </li>
            )
          })}
        </ul>
      </section>

      <AdminError message={error} />
      <WorkflowActions
        events={deity.events}
        busy={busy}
        onEvent={handleEvent}
      />
    </div>
  )
}
