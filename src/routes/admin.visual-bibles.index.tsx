import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  createVisualBibleFn,
  listVisualBiblesFn,
} from '@/services/visual-bible-actions'

/** Visual Bibles (Step 10) — one canonical visual rulebook per House. */
export const Route = createFileRoute('/admin/visual-bibles/')({
  loader: async () => listVisualBiblesFn(),
  component: VisualBiblesPage,
})

function VisualBiblesPage() {
  const data = Route.useLoaderData()
  const navigate = useNavigate()
  const create = useServerFn(createVisualBibleFn)
  const [houseId, setHouseId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const housesWithout = data.houses.filter(
    (house) => !data.bibles.some((bible) => bible.sacredHouseId === house.id),
  )

  async function handleCreate() {
    setBusy(true)
    setError(null)
    try {
      const result = await create({
        data: { sacredHouseId: Number(houseId) },
      })
      await navigate({
        to: '/admin/visual-bibles/$id',
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
          <h1 className="text-2xl font-bold">Visual Bibles</h1>
          <p className="mt-1 text-sm text-stone-400">
            Human-authored visual canon per Sacred House — the approved rules
            every future visual generation must obey. Never AI generated.
          </p>
        </div>
        {housesWithout.length > 0 ? (
          <div className="flex items-end gap-2">
            <label className="block text-xs text-stone-400">
              Sacred House
              <select
                value={houseId}
                onChange={(event) => setHouseId(event.target.value)}
                className="mt-1 w-48 rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
              >
                <option value="">Select…</option>
                {housesWithout.map((house) => (
                  <option key={house.id} value={String(house.id)}>
                    {house.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !houseId}
              onClick={() => void handleCreate()}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-500 disabled:opacity-60"
            >
              Create Visual Bible
            </button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}

      {data.bibles.length === 0 ? (
        <p className="mt-10 text-stone-400">No Visual Bibles yet.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {data.bibles.map((bible) => (
            <li
              key={bible.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-800 bg-stone-900 px-4 py-3"
            >
              <Link
                to="/admin/visual-bibles/$id"
                params={{ id: String(bible.id) }}
                className="font-medium text-amber-500 hover:underline"
              >
                {bible.houseName}
              </Link>
              <span className="text-xs text-stone-400">
                {bible.versions.length > 0
                  ? bible.versions
                      .map(
                        (version) =>
                          `v${version.versionNumber} ${version.status.toLowerCase().replaceAll('_', ' ')}`,
                      )
                      .join(', ')
                  : 'no versions'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
