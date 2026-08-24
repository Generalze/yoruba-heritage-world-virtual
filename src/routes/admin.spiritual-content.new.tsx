import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import type { CONTENT_SCOPE_TYPES } from '@/db/schema'
import { GUIDANCE_CONTENT_TYPES } from '@/db/schema'
import {
  createSpiritualContentItemFn,
  listSpiritualContentFn,
} from '@/services/spiritual-content-actions'
import { contentTypeLabel } from '@/lib/guidance-labels'

/** New content ITEM (stable identity only — sacred text is authored on
 * versions afterwards). Scope rules are validated server-side; SERVICE
 * scope derives its House from the Service. */
export const Route = createFileRoute('/admin/spiritual-content/new')({
  loader: async () => listSpiritualContentFn({ data: {} }),
  component: NewContentItemPage,
})

function NewContentItemPage() {
  const data = Route.useLoaderData()
  const navigate = useNavigate()
  const create = useServerFn(createSpiritualContentItemFn)

  const [code, setCode] = useState('')
  const [contentType, setContentType] = useState<string>('PREPARATION')
  const [scopeType, setScopeType] = useState<string>('PLATFORM')
  const [sacredHouseId, setSacredHouseId] = useState<string>('')
  const [serviceId, setServiceId] = useState<string>('')
  const [sortOrder, setSortOrder] = useState('0')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleCreate() {
    setBusy(true)
    setError(null)
    try {
      const result = await create({
        data: {
          code: code.trim(),
          contentType: contentType as (typeof GUIDANCE_CONTENT_TYPES)[number],
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
        to: '/admin/spiritual-content/$id',
        params: { id: String(result.id) },
      })
    } catch (createError) {
      setError(
        createError instanceof Error
          ? createError.message
          : 'The content item could not be created.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="max-w-2xl">
      <Link
        to="/admin/spiritual-content"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Library
      </Link>
      <h1 className="mt-4 text-2xl font-bold">New guidance content item</h1>
      <p className="mt-2 text-sm text-ink-soft">
        The item is a stable identity. Guidance text itself is authored as
        versions and goes through review before publication.
      </p>

      <div className="mt-6 space-y-4 rounded-lg border border-line bg-surface-raised p-6">
        <label className="block text-sm text-ink-soft">
          Stable code (UPPER_SNAKE_CASE)
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            placeholder="e.g. HOUSE_ARRIVAL_NOTES"
            className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="block text-sm text-ink-soft">
          Content type
          <select
            value={contentType}
            onChange={(event) => setContentType(event.target.value)}
            className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
          >
            {GUIDANCE_CONTENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {contentTypeLabel(type)}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-ink-soft">
          Applicability scope
          <select
            value={scopeType}
            onChange={(event) => setScopeType(event.target.value)}
            className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
          >
            <option value="PLATFORM">Platform (everyone)</option>
            <option value="SACRED_HOUSE">Sacred House</option>
            <option value="SERVICE">Service</option>
          </select>
        </label>
        {scopeType === 'SACRED_HOUSE' ? (
          <label className="block text-sm text-ink-soft">
            Sacred House
            <select
              value={sacredHouseId}
              onChange={(event) => setSacredHouseId(event.target.value)}
              className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
            >
              <option value="">Select…</option>
              {data.houses.map((house) => (
                <option key={house.id} value={house.id}>
                  {house.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {scopeType === 'SERVICE' ? (
          <label className="block text-sm text-ink-soft">
            Service (its House is derived automatically)
            <select
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
              className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
            >
              <option value="">Select…</option>
              {data.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="block text-sm text-ink-soft">
          Sort order
          <input
            type="number"
            value={sortOrder}
            onChange={(event) => setSortOrder(event.target.value)}
            className="mt-2 w-32 rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
          />
        </label>
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={busy}
          className="rounded-md bg-gold px-5 py-2.5 text-sm font-medium text-night hover:bg-gold-bright disabled:opacity-60"
        >
          {busy ? 'Creating…' : 'Create item'}
        </button>
        {error ? (
          <p className="rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}
