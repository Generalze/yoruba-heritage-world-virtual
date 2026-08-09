import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { MEDIA_ASSET_KINDS, SACRED_RUNTIME_CONTENT_TYPES } from '@/db/schema'
import {
  createMediaAssetFn,
  listMediaAssetsFn,
} from '@/services/media-asset-actions'
import { RIGHTS_STATUS_LABELS } from '@/lib/guidance-labels'
import type { CONTENT_SCOPE_TYPES } from '@/db/schema'

/**
 * Approved media asset library (Step 10) — staff only. Binaries live
 * in private storage; nothing here exposes media publicly.
 */
export const Route = createFileRoute('/admin/media-assets/')({
  loader: async () => listMediaAssetsFn({ data: {} }),
  component: MediaLibraryPage,
})

function MediaLibraryPage() {
  const data = Route.useLoaderData()
  const navigate = useNavigate()
  const create = useServerFn(createMediaAssetFn)
  const [showForm, setShowForm] = useState(false)
  const [code, setCode] = useState('')
  const [assetKind, setAssetKind] = useState('AUDIO')
  const [scopeType, setScopeType] = useState('PLATFORM')
  const [houseId, setHouseId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [contentType, setContentType] = useState('')
  const [themeCode, setThemeCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleCreate() {
    setBusy(true)
    setError(null)
    try {
      const result = await create({
        data: {
          code: code.trim(),
          assetKind: assetKind as 'AUDIO' | 'IMAGE' | 'VIDEO',
          scopeType: scopeType as (typeof CONTENT_SCOPE_TYPES)[number],
          sacredHouseId:
            scopeType === 'SACRED_HOUSE' && houseId ? Number(houseId) : null,
          serviceId:
            scopeType === 'SERVICE' && serviceId ? Number(serviceId) : null,
          contentType: contentType
            ? (contentType as (typeof SACRED_RUNTIME_CONTENT_TYPES)[number])
            : null,
          themeCode: themeCode.trim() || null,
        },
      })
      await navigate({
        to: '/admin/media-assets/$id',
        params: { id: String(result.id) },
      })
    } catch (createError) {
      setError(
        createError instanceof Error ? createError.message : 'Creation failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Media Assets</h1>
          <p className="mt-1 text-sm text-stone-400">
            Approved audio/image/video the future autonomous recipe engine may
            draw from. Private storage only — nothing is public.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((value) => !value)}
          className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-500"
        >
          New asset
        </button>
      </div>

      {showForm ? (
        <div className="mt-6 grid gap-3 rounded-lg border border-dashed border-stone-700 p-4 sm:grid-cols-3">
          <label className="block text-xs text-stone-400">
            Code (UPPER_SNAKE_CASE)
            <input
              value={code}
              onChange={(event) =>
                setCode(event.target.value.toUpperCase().slice(0, 60))
              }
              className="mt-1 w-full rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
            />
          </label>
          <label className="block text-xs text-stone-400">
            Kind
            <select
              value={assetKind}
              onChange={(event) => setAssetKind(event.target.value)}
              className="mt-1 w-full rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
            >
              {MEDIA_ASSET_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-stone-400">
            Scope
            <select
              value={scopeType}
              onChange={(event) => setScopeType(event.target.value)}
              className="mt-1 w-full rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
            >
              <option value="PLATFORM">Platform</option>
              <option value="SACRED_HOUSE">Sacred House</option>
              <option value="SERVICE">Service</option>
            </select>
          </label>
          {scopeType === 'SACRED_HOUSE' ? (
            <label className="block text-xs text-stone-400">
              Sacred House
              <select
                value={houseId}
                onChange={(event) => setHouseId(event.target.value)}
                className="mt-1 w-full rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
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
            <label className="block text-xs text-stone-400">
              Service
              <select
                value={serviceId}
                onChange={(event) => setServiceId(event.target.value)}
                className="mt-1 w-full rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
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
          <label className="block text-xs text-stone-400">
            Sacred content type (optional)
            <select
              value={contentType}
              onChange={(event) => setContentType(event.target.value)}
              className="mt-1 w-full rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
            >
              <option value="">None</option>
              {SACRED_RUNTIME_CONTENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-stone-400">
            Theme code (optional)
            <input
              value={themeCode}
              onChange={(event) =>
                setThemeCode(event.target.value.toUpperCase().slice(0, 60))
              }
              className="mt-1 w-full rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
            />
          </label>
          <div className="sm:col-span-3">
            <button
              type="button"
              disabled={busy || !code.trim()}
              onClick={() => void handleCreate()}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-500 disabled:opacity-60"
            >
              Create asset
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {data.assets.length === 0 ? (
        <p className="mt-10 text-stone-400">
          No media assets yet. The library starts empty — every asset is
          uploaded and approved by authorized people.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs tracking-wider text-stone-500 uppercase">
                <th className="border-b border-stone-800 px-3 py-2">Code</th>
                <th className="border-b border-stone-800 px-3 py-2">Kind</th>
                <th className="border-b border-stone-800 px-3 py-2">Scope</th>
                <th className="border-b border-stone-800 px-3 py-2">
                  Versions
                </th>
                <th className="border-b border-stone-800 px-3 py-2">Rights</th>
                <th className="border-b border-stone-800 px-3 py-2">Runtime</th>
                <th className="border-b border-stone-800 px-3 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {data.assets.map((asset) => {
                const published = asset.versions.find(
                  (version) => version.status === 'PUBLISHED',
                )
                return (
                  <tr key={asset.id} className="hover:bg-stone-900">
                    <td className="border-b border-stone-900 px-3 py-2">
                      <Link
                        to="/admin/media-assets/$id"
                        params={{ id: String(asset.id) }}
                        className="font-medium text-amber-500 hover:underline"
                      >
                        {asset.code}
                      </Link>
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2">
                      {asset.assetKind}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2">
                      {asset.scopeType}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2 text-xs text-stone-400">
                      {asset.versions.length > 0
                        ? asset.versions
                            .map(
                              (version) =>
                                `v${version.versionNumber} ${version.status.toLowerCase().replaceAll('_', ' ')}`,
                            )
                            .join(', ')
                        : '—'}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2 text-xs">
                      {published
                        ? (RIGHTS_STATUS_LABELS[published.rightsStatus] ??
                          published.rightsStatus)
                        : '—'}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2">
                      {published?.runtimeEnabled ? (
                        <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs text-emerald-400">
                          enabled
                        </span>
                      ) : (
                        <span className="rounded-full bg-stone-800 px-2 py-0.5 text-xs text-stone-400">
                          off
                        </span>
                      )}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2">
                      {asset.active ? 'yes' : 'no'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
