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
  adminAddFocusAreaFn,
  adminAddMemberFn,
  adminGetSacredHouseFn,
  adminSacredHouseWorkflowFn,
  adminUpdateFocusAreaFn,
  adminUpdateMemberFn,
  adminUpdateSacredHouseFn,
} from '@/services/admin-catalogue-actions'
import { MEMBER_TYPES } from '@/db/schema'
import type { WorkflowEvent } from '@/services/admin-catalogue'

export const Route = createFileRoute('/admin/catalogue/sacred-houses/$id')({
  params: {
    parse: (params) => ({ id: z.coerce.number().int().parse(params.id) }),
    stringify: (params) => ({ id: String(params.id) }),
  },
  loader: async ({ params }) => {
    const house = await adminGetSacredHouseFn({ data: { id: params.id } })
    if (!house) throw notFound()
    return house
  },
  notFoundComponent: () => (
    <div>
      <p>Sacred House not found.</p>
      <Link
        to="/admin/catalogue/sacred-houses"
        className="text-amber-500 hover:text-amber-400"
      >
        Back to Sacred Houses
      </Link>
    </div>
  ),
  component: EditHousePage,
})

function EditHousePage() {
  const house = Route.useLoaderData()
  const update = useServerFn(adminUpdateSacredHouseFn)
  const workflow = useServerFn(adminSacredHouseWorkflowFn)
  const addFocus = useServerFn(adminAddFocusAreaFn)
  const updateFocus = useServerFn(adminUpdateFocusAreaFn)
  const addMemberFn = useServerFn(adminAddMemberFn)
  const updateMemberFn = useServerFn(adminUpdateMemberFn)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const editable = house.status === 'DRAFT' || house.status === 'APPROVED'

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
          id: house.id,
          name: String(form.get('name') ?? ''),
          slug: String(form.get('slug') ?? ''),
          shortDescription: String(form.get('shortDescription') ?? ''),
          sortOrder: Number(form.get('sortOrder') ?? 0),
        },
      }),
    )
  }

  async function handleAddFocus(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const label = String(new FormData(form).get('label') ?? '').trim()
    if (!label) return
    await run(() => addFocus({ data: { sacredHouseId: house.id, label } }))
    form.reset()
  }

  async function handleAddMember(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const displayName = String(data.get('displayName') ?? '').trim()
    if (!displayName) return
    await run(() =>
      addMemberFn({
        data: {
          sacredHouseId: house.id,
          displayName,
          memberType: String(
            data.get('memberType') ?? 'PRAYER_WARRIOR',
          ) as (typeof MEMBER_TYPES)[number],
        },
      }),
    )
    form.reset()
  }

  function handleEvent(event: WorkflowEvent, note?: string) {
    void run(() => workflow({ data: { id: house.id, event, note } }))
  }

  return (
    <div className="max-w-2xl">
      <Link
        to="/admin/catalogue/sacred-houses"
        className="text-sm text-stone-400 hover:text-amber-500"
      >
        ← All Sacred Houses
      </Link>
      <div className="mt-3 flex items-center gap-3">
        <h1 className="text-2xl font-bold">{house.name}</h1>
        <StatusBadge status={house.status} />
      </div>
      <p className="mt-1 font-mono text-xs text-stone-500">{house.code}</p>

      {house.reviewNote ? (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          Returned by review: {house.reviewNote}
        </p>
      ) : null}

      <form onSubmit={handleSave} className="mt-6 space-y-4">
        <AdminField label="Display name">
          <input
            name="name"
            defaultValue={house.name}
            required
            maxLength={150}
            disabled={!editable}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="URL slug">
          <input
            name="slug"
            defaultValue={house.slug}
            required
            maxLength={100}
            disabled={!editable}
            className={adminInputClass}
          />
        </AdminField>
        <AdminField label="Approved short description">
          <textarea
            name="shortDescription"
            defaultValue={house.shortDescription ?? ''}
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
            defaultValue={house.sortOrder}
            min={0}
            className={adminInputClass}
          />
        </AdminField>
        {house.status === 'APPROVED' ? (
          <p className="text-xs text-amber-500">
            Changing content, focus areas or members of an approved House
            returns it to DRAFT for re-approval.
          </p>
        ) : null}
        {house.status === 'PUBLISHED' ? (
          <p className="text-xs text-amber-500">
            This House is live. Unpublish it before changing content, focus
            areas or members.
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
          Focus areas
        </h2>
        <ul className="mt-3 space-y-2">
          {house.focusAreas.map((area) => (
            <li key={area.id} className="flex items-center gap-3 text-sm">
              <span
                className={area.active ? '' : 'text-stone-600 line-through'}
              >
                {area.label}
              </span>
              <button
                type="button"
                disabled={busy || !editable}
                onClick={() =>
                  void run(() =>
                    updateFocus({
                      data: { id: area.id, active: !area.active },
                    }),
                  )
                }
                className="text-xs text-stone-500 hover:text-amber-500 disabled:opacity-40"
              >
                {area.active ? 'deactivate' : 'activate'}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={handleAddFocus} className="mt-3 flex gap-2">
          <input
            name="label"
            maxLength={200}
            placeholder="Approved focus area wording"
            disabled={!editable}
            className={adminInputClass}
          />
          <button
            type="submit"
            disabled={busy || !editable}
            className="rounded-md border border-stone-700 px-4 text-sm text-stone-200 hover:border-amber-500 disabled:opacity-40"
          >
            Add
          </button>
        </form>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
          Members (informational only — never bookable)
        </h2>
        <ul className="mt-3 space-y-2">
          {house.members.map((member) => (
            <li key={member.id} className="flex items-center gap-3 text-sm">
              <span
                className={member.active ? '' : 'text-stone-600 line-through'}
              >
                {member.displayName}
                <span className="text-stone-500">
                  {' '}
                  — {member.memberType.replace('_', ' ')}
                </span>
              </span>
              <button
                type="button"
                disabled={busy || !editable}
                onClick={() =>
                  void run(() =>
                    updateMemberFn({
                      data: { id: member.id, active: !member.active },
                    }),
                  )
                }
                className="text-xs text-stone-500 hover:text-amber-500 disabled:opacity-40"
              >
                {member.active ? 'deactivate' : 'activate'}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={handleAddMember} className="mt-3 flex flex-wrap gap-2">
          <input
            name="displayName"
            maxLength={150}
            placeholder="Approved member name"
            disabled={!editable}
            className={`${adminInputClass} flex-1`}
          />
          <select
            name="memberType"
            disabled={!editable}
            className="rounded-md border border-stone-700 bg-stone-900 px-3 py-2 text-sm text-stone-200"
          >
            {MEMBER_TYPES.map((type) => (
              <option key={type} value={type}>
                {type.replace('_', ' ')}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={busy || !editable}
            className="rounded-md border border-stone-700 px-4 text-sm text-stone-200 hover:border-amber-500 disabled:opacity-40"
          >
            Add
          </button>
        </form>
      </section>

      <AdminError message={error} />
      <WorkflowActions
        events={house.events}
        busy={busy}
        onEvent={handleEvent}
      />
    </div>
  )
}
