import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { CONTENT_SCOPE_TYPES, SACRED_RUNTIME_CONTENT_TYPES } from '@/db/schema'
import { listSacredContentFn } from '@/services/sacred-content-actions'
import { RIGHTS_STATUS_LABELS, contentTypeLabel } from '@/lib/guidance-labels'

/**
 * Sacred runtime content library (Step 8) — staff only, deliberately a
 * SEPARATE area from Step 7 guidance. List rows show governance
 * metadata only: sacred bodies are NEVER rendered in list views.
 */

const searchSchema = z.object({
  type: z.enum(SACRED_RUNTIME_CONTENT_TYPES).optional(),
  scope: z.enum(CONTENT_SCOPE_TYPES).optional(),
  active: z.boolean().optional(),
})

export const Route = createFileRoute('/admin/sacred-content/')({
  validateSearch: searchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) =>
    listSacredContentFn({
      data: {
        contentType: deps.type,
        scopeType: deps.scope,
        active: deps.active,
      },
    }),
  component: SacredContentLibraryPage,
})

function SacredContentLibraryPage() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Sacred Runtime Content</h1>
          <p className="mt-1 text-sm text-stone-400">
            Human-authored sacred blocks for the future autonomous Prayer Room
            engine. This library is separate from appointment guidance.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/admin/sacred-content/review"
            className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:border-amber-500"
          >
            Review queue
          </Link>
          <Link
            to="/admin/sacred-content/runtime"
            className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:border-amber-500"
          >
            Runtime state
          </Link>
          <Link
            to="/admin/sacred-content/new"
            className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-500"
          >
            New sacred item
          </Link>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-2 text-sm">
        <FilterLink label="All" search={{}} active={!search.type} />
        {SACRED_RUNTIME_CONTENT_TYPES.map((type) => (
          <FilterLink
            key={type}
            label={contentTypeLabel(type)}
            search={{ type }}
            active={search.type === type}
          />
        ))}
      </div>

      {data.items.length === 0 ? (
        <p className="mt-10 text-stone-400">
          No sacred runtime content yet. The library starts empty — every block
          is written and approved by authorized people.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[900px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs tracking-wider text-stone-500 uppercase">
                <th className="border-b border-stone-800 px-3 py-2">Code</th>
                <th className="border-b border-stone-800 px-3 py-2">Type</th>
                <th className="border-b border-stone-800 px-3 py-2">Scope</th>
                <th className="border-b border-stone-800 px-3 py-2">en / yo</th>
                <th className="border-b border-stone-800 px-3 py-2">Rights</th>
                <th className="border-b border-stone-800 px-3 py-2">Runtime</th>
                <th className="border-b border-stone-800 px-3 py-2">Theme</th>
                <th className="border-b border-stone-800 px-3 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => {
                const profiles = data.profiles.filter(
                  (p) => p.contentItemId === item.id,
                )
                const rights = [...new Set(profiles.map((p) => p.rightsStatus))]
                const anyRuntime = profiles.some((p) => p.runtimeEnabled)
                const themes = [
                  ...new Set(profiles.map((p) => p.themeCode).filter(Boolean)),
                ]
                const scopeName =
                  item.scopeType === 'SACRED_HOUSE'
                    ? (data.houses.find((h) => h.id === item.sacredHouseId)
                        ?.name ?? 'House')
                    : item.scopeType === 'SERVICE'
                      ? (data.services.find((s) => s.id === item.serviceId)
                          ?.name ?? 'Service')
                      : 'Platform'
                const summary = (lang: 'en' | 'yo') => {
                  const s = item[lang]
                  const parts: Array<string> = []
                  if (s.publishedVersion != null) {
                    parts.push(`v${s.publishedVersion} published`)
                  }
                  if (s.workingStatus) {
                    parts.push(
                      `v${s.workingVersion} ${s.workingStatus.toLowerCase().replaceAll('_', ' ')}`,
                    )
                  }
                  return parts.length > 0 ? parts.join(', ') : '—'
                }
                return (
                  <tr key={item.id} className="hover:bg-stone-900">
                    <td className="border-b border-stone-900 px-3 py-2">
                      <Link
                        to="/admin/sacred-content/$id"
                        params={{ id: String(item.id) }}
                        className="font-medium text-amber-500 hover:underline"
                      >
                        {item.code}
                      </Link>
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2">
                      {contentTypeLabel(item.contentType)}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2">
                      {scopeName}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2 text-xs text-stone-400">
                      en: {summary('en')}
                      <br />
                      yo: {summary('yo')}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2 text-xs">
                      {rights.length > 0
                        ? rights
                            .map((r) => RIGHTS_STATUS_LABELS[r] ?? r)
                            .join(', ')
                        : '—'}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2">
                      {anyRuntime ? (
                        <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs text-emerald-400">
                          enabled
                        </span>
                      ) : (
                        <span className="rounded-full bg-stone-800 px-2 py-0.5 text-xs text-stone-400">
                          off
                        </span>
                      )}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2 text-xs text-stone-400">
                      {themes.length > 0 ? themes.join(', ') : '—'}
                    </td>
                    <td className="border-b border-stone-900 px-3 py-2">
                      {item.active ? 'yes' : 'no'}
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

function FilterLink({
  label,
  search,
  active,
}: {
  label: string
  search: Record<string, unknown>
  active: boolean
}) {
  return (
    <Link
      to="/admin/sacred-content"
      search={search}
      className={`rounded-full px-3 py-1 ${
        active
          ? 'bg-amber-600 text-stone-950'
          : 'bg-stone-900 text-stone-300 hover:bg-stone-800'
      }`}
    >
      {label}
    </Link>
  )
}
