import { Link, createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { CONTENT_SCOPE_TYPES, GUIDANCE_CONTENT_TYPES } from '@/db/schema'
import { listSpiritualContentFn } from '@/services/spiritual-content-actions'
import { contentTypeLabel } from '@/lib/guidance-labels'

/**
 * Spiritual guidance content library (Step 7). CONTENT_MANAGER and
 * ADMIN/SUPER_ADMIN. Safe metadata only — bodies are never rendered in
 * the list. All content is human-authored.
 */

const searchSchema = z.object({
  type: z.enum(GUIDANCE_CONTENT_TYPES).optional(),
  scope: z.enum(CONTENT_SCOPE_TYPES).optional(),
  active: z.boolean().optional(),
})
type ContentSearch = z.infer<typeof searchSchema>

export const Route = createFileRoute('/admin/spiritual-content/')({
  validateSearch: (search: Record<string, unknown>): ContentSearch => {
    const parsed = searchSchema.safeParse(search)
    return parsed.success ? parsed.data : {}
  },
  loaderDeps: ({ search }) => search,
  loader: async ({ deps }) =>
    listSpiritualContentFn({
      data: {
        contentType: deps.type,
        scopeType: deps.scope,
        active: deps.active,
      },
    }),
  component: SpiritualContentLibraryPage,
})

function SpiritualContentLibraryPage() {
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const houseName = (id: number | null) =>
    data.houses.find((house) => house.id === id)?.name ?? '—'
  const serviceName = (id: number | null) =>
    data.services.find((service) => service.id === id)?.name ?? '—'

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">Spiritual guidance library</h1>
        <div className="flex items-center gap-3">
          <Link
            to="/admin/spiritual-content/review"
            className="text-sm text-stone-400 hover:text-amber-500"
          >
            Review queue →
          </Link>
          <Link
            to="/admin/spiritual-content/new"
            className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-500"
          >
            New content item
          </Link>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <FilterLink
          label="All"
          search={{}}
          active={!search.type && !search.scope}
        />
        {GUIDANCE_CONTENT_TYPES.map((type) => (
          <FilterLink
            key={type}
            label={contentTypeLabel(type)}
            search={{ type }}
            active={search.type === type}
          />
        ))}
      </div>

      {data.items.length === 0 ? (
        <p className="mt-8 text-stone-400">
          No content items yet. The library starts empty until authorized staff
          add human-authored guidance.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stone-800 text-xs tracking-wider text-stone-500 uppercase">
                <th className="py-2 pr-4">Code</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Scope</th>
                <th className="py-2 pr-4">House / Service</th>
                <th className="py-2 pr-4">English</th>
                <th className="py-2 pr-4">Yorùbá</th>
                <th className="py-2 pr-4">Sort</th>
                <th className="py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => (
                <tr key={item.id} className="border-b border-stone-900">
                  <td className="py-2 pr-4">
                    <Link
                      to="/admin/spiritual-content/$id"
                      params={{ id: String(item.id) }}
                      className="text-amber-500 hover:text-amber-400"
                    >
                      {item.code}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    {contentTypeLabel(item.contentType)}
                  </td>
                  <td className="py-2 pr-4">{item.scopeType}</td>
                  <td className="py-2 pr-4 text-stone-400">
                    {item.scopeType === 'SACRED_HOUSE'
                      ? houseName(item.sacredHouseId)
                      : item.scopeType === 'SERVICE'
                        ? serviceName(item.serviceId)
                        : 'Platform'}
                  </td>
                  <td className="py-2 pr-4">
                    <VersionSummary summary={item.en} />
                  </td>
                  <td className="py-2 pr-4">
                    <VersionSummary summary={item.yo} />
                  </td>
                  <td className="py-2 pr-4 text-stone-500">{item.sortOrder}</td>
                  <td className="py-2">
                    {item.active ? (
                      <span className="text-emerald-400">yes</span>
                    ) : (
                      <span className="text-stone-500">no</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function VersionSummary({
  summary,
}: {
  summary: {
    publishedVersion: number | null
    workingStatus: string | null
    workingVersion: number | null
  }
}) {
  return (
    <span className="text-xs">
      {summary.publishedVersion != null ? (
        <span className="text-emerald-400">
          v{summary.publishedVersion} live
        </span>
      ) : (
        <span className="text-stone-500">none</span>
      )}
      {summary.workingStatus ? (
        <span className="ml-2 text-amber-400">
          v{summary.workingVersion} {summary.workingStatus.toLowerCase()}
        </span>
      ) : null}
    </span>
  )
}

function FilterLink({
  label,
  search,
  active,
}: {
  label: string
  search: ContentSearch
  active: boolean
}) {
  return (
    <Link
      to="/admin/spiritual-content"
      search={search}
      className={`rounded-full border px-3 py-1 ${
        active
          ? 'border-amber-500 text-amber-400'
          : 'border-stone-700 text-stone-400 hover:border-amber-600'
      }`}
    >
      {label}
    </Link>
  )
}
