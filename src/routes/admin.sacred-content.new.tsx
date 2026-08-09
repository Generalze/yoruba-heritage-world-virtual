import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import type { CONTENT_SCOPE_TYPES } from '@/db/schema'
import { SACRED_RUNTIME_CONTENT_TYPES } from '@/db/schema'
import {
  createSacredContentItemFn,
  listSacredContentFn,
} from '@/services/sacred-content-actions'
import { contentTypeLabel } from '@/lib/guidance-labels'

/**
 * New SACRED_RUNTIME item — only the ten approved sacred runtime types
 * are offered here; the domain is fixed server-side by this route's
 * server function and never taken from the browser.
 */
export const Route = createFileRoute('/admin/sacred-content/new')({
  loader: async () => listSacredContentFn({ data: {} }),
  component: NewSacredItemPage,
})

function NewSacredItemPage() {
  const data = Route.useLoaderData()
  const navigate = useNavigate()
  const create = useServerFn(createSacredContentItemFn)

  const [code, setCode] = useState('')
  const [contentType, setContentType] = useState<string>('PRAYER')
  const [scopeType, setScopeType] = useState<string>('PLATFORM')
  const [sacredHouseId, setSacredHouseId] = useState<string>('')
  const [serviceId, setServiceId] = useState<string>('')
  const [sortOrder, setSortOrder] = useState('0')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit() {
    setBusy(true)
    setError(null)
    try {
      const result = await create({
        data: {
          code: code.trim(),
          contentType:
            contentType as (typeof SACRED_RUNTIME_CONTENT_TYPES)[number],
          scopeType: scopeType as (typeof CONTENT_SCOPE_TYPES)[number],
          sacredHouseId:
            scopeType === 'SACRED_HOUSE' && sacredHouseId
              ? Number(sacredHouseId)
              : null,
          serviceId:
            scopeType === 'SERVICE' && serviceId ? Number(serviceId) : null,
          sortOrder: Number(sortOrder) || 0,
        },
      })
      await navigate({
        to: '/admin/sacred-content/$id',
        params: { id: String(result.id) },
      })
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : 'Creation failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl">
      <Link
        to="/admin/sacred-content"
        className="text-sm text-stone-400 hover:text-amber-500"
      >
        ← Sacred library
      </Link>
      <h1 className="mt-4 text-2xl font-bold">New sacred content item</h1>
      <p className="mt-2 text-sm text-stone-400">
        A stable identity for one human-authored sacred block. Versions and
        their runtime profiles are added on the next screen.
      </p>

      <div className="mt-6 space-y-4">
        <label className="block text-sm text-stone-400">
          Code (UPPER_SNAKE_CASE, stable machine identifier)
          <input
            value={code}
            onChange={(event) =>
              setCode(event.target.value.toUpperCase().slice(0, 60))
            }
            placeholder="OSUN_HOUSE_MORNING_PRAYER"
            className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
          />
        </label>
        <label className="block text-sm text-stone-400">
          Sacred content type
          <select
            value={contentType}
            onChange={(event) => setContentType(event.target.value)}
            className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
          >
            {SACRED_RUNTIME_CONTENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {contentTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-stone-400">
          Scope
          <select
            value={scopeType}
            onChange={(event) => setScopeType(event.target.value)}
            className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
          >
            <option value="PLATFORM">Platform (all Houses)</option>
            <option value="SACRED_HOUSE">Sacred House</option>
            <option value="SERVICE">Service</option>
          </select>
        </label>
        {scopeType === 'SACRED_HOUSE' ? (
          <label className="block text-sm text-stone-400">
            Sacred House
            <select
              value={sacredHouseId}
              onChange={(event) => setSacredHouseId(event.target.value)}
              className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
            >
              <option value="">Select…</option>
              {data.houses.map((house) => (
                <option key={house.id} value={String(house.id)}>
                  {house.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {scopeType === 'SERVICE' ? (
          <label className="block text-sm text-stone-400">
            Service
            <select
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
              className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
            >
              <option value="">Select…</option>
              {data.services.map((service) => (
                <option key={service.id} value={String(service.id)}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block text-sm text-stone-400">
          Sort order
          <input
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            inputMode="numeric"
            className="mt-2 w-32 rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
          />
        </label>
        {error ? (
          <p className="rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy || !code.trim()}
          onClick={() => void handleSubmit()}
          className="rounded-md bg-amber-600 px-5 py-2.5 text-sm font-medium text-stone-950 hover:bg-amber-500 disabled:opacity-60"
        >
          Create item
        </button>
      </div>
    </div>
  )
}
