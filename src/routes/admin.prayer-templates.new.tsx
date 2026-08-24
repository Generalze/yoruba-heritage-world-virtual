import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  createPrayerTemplateFn,
  listPrayerTemplatesFn,
} from '@/services/prayer-template-actions'
import type { CONTENT_SCOPE_TYPES } from '@/db/schema'

/** New prayer session template identity (code + scope). */
export const Route = createFileRoute('/admin/prayer-templates/new')({
  loader: async () => listPrayerTemplatesFn(),
  component: NewPrayerTemplatePage,
})

function NewPrayerTemplatePage() {
  const data = Route.useLoaderData()
  const navigate = useNavigate()
  const create = useServerFn(createPrayerTemplateFn)

  const [code, setCode] = useState('')
  const [scopeType, setScopeType] = useState<string>('PLATFORM')
  const [sacredHouseId, setSacredHouseId] = useState<string>('')
  const [serviceId, setServiceId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit() {
    setBusy(true)
    setError(null)
    try {
      const result = await create({
        data: {
          code: code.trim(),
          scopeType: scopeType as (typeof CONTENT_SCOPE_TYPES)[number],
          sacredHouseId:
            scopeType === 'SACRED_HOUSE' && sacredHouseId
              ? Number(sacredHouseId)
              : null,
          serviceId:
            scopeType === 'SERVICE' && serviceId ? Number(serviceId) : null,
        },
      })
      await navigate({
        to: '/admin/prayer-templates/$id',
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
        to="/admin/prayer-templates"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Templates
      </Link>
      <h1 className="mt-4 text-2xl font-bold">New prayer session template</h1>
      <p className="mt-2 text-sm text-ink-soft">
        A stable identity for one approved session structure. Versions with
        slots and selection rules are added on the next screen.
      </p>

      <div className="mt-6 space-y-4">
        <label className="block text-sm text-ink-soft">
          Code (UPPER_SNAKE_CASE)
          <input
            value={code}
            onChange={(event) =>
              setCode(event.target.value.toUpperCase().slice(0, 60))
            }
            placeholder="STANDARD_BLESSING_SESSION"
            className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
          />
        </label>
        <label className="block text-sm text-ink-soft">
          Scope
          <select
            value={scopeType}
            onChange={(event) => setScopeType(event.target.value)}
            className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
          >
            <option value="PLATFORM">Platform (all Houses)</option>
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
                <option key={house.id} value={String(house.id)}>
                  {house.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {scopeType === 'SERVICE' ? (
          <label className="block text-sm text-ink-soft">
            Service
            <select
              value={serviceId}
              onChange={(event) => setServiceId(event.target.value)}
              className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
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
        {error ? (
          <p className="rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy || !code.trim()}
          onClick={() => void handleSubmit()}
          className="rounded-md bg-gold px-5 py-2.5 text-sm font-medium text-night hover:bg-gold-bright disabled:opacity-60"
        >
          Create template
        </button>
      </div>
    </div>
  )
}
