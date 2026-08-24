import { Link, createFileRoute } from '@tanstack/react-router'

import { listPrayerTemplatesFn } from '@/services/prayer-template-actions'

/**
 * Prayer session template library (Step 9) — staff only. Templates
 * define approved session structure and selection rules; they contain
 * no sacred text.
 */
export const Route = createFileRoute('/admin/prayer-templates/')({
  loader: async () => listPrayerTemplatesFn(),
  component: PrayerTemplateLibraryPage,
})

function PrayerTemplateLibraryPage() {
  const data = Route.useLoaderData()

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Prayer Session Templates</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Approved structures and selection rules the autonomous engine
            executes. Humans approve the rules once — no per-appointment
            approval exists.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            to="/admin/prayer-templates/review"
            className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink-soft hover:border-gold-deep"
          >
            Review queue
          </Link>
          <Link
            to="/admin/prayer-templates/new"
            className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-night hover:bg-gold-bright"
          >
            New template
          </Link>
        </div>
      </div>

      {data.templates.length === 0 ? (
        <p className="mt-10 text-ink-soft">
          No templates yet. Leadership-approved session structures will appear
          here.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[760px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs tracking-wider text-ink-soft uppercase">
                <th className="border-b border-line px-3 py-2">Code</th>
                <th className="border-b border-line px-3 py-2">Scope</th>
                <th className="border-b border-line px-3 py-2">en</th>
                <th className="border-b border-line px-3 py-2">yo</th>
                <th className="border-b border-line px-3 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {data.templates.map((template) => {
                const scopeName =
                  template.scopeType === 'SACRED_HOUSE'
                    ? (data.houses.find((h) => h.id === template.sacredHouseId)
                        ?.name ?? 'House')
                    : template.scopeType === 'SERVICE'
                      ? (data.services.find((s) => s.id === template.serviceId)
                          ?.name ?? 'Service')
                      : 'Platform'
                const summary = (lang: 'en' | 'yo') => {
                  const s = template[lang]
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
                  <tr key={template.id} className="hover:bg-surface">
                    <td className="border-b border-line px-3 py-2">
                      <Link
                        to="/admin/prayer-templates/$id"
                        params={{ id: String(template.id) }}
                        className="font-medium text-gold-deep hover:underline"
                      >
                        {template.code}
                      </Link>
                    </td>
                    <td className="border-b border-line px-3 py-2">
                      {scopeName}
                    </td>
                    <td className="border-b border-line px-3 py-2 text-xs text-ink-soft">
                      {summary('en')}
                    </td>
                    <td className="border-b border-line px-3 py-2 text-xs text-ink-soft">
                      {summary('yo')}
                    </td>
                    <td className="border-b border-line px-3 py-2">
                      {template.active ? 'yes' : 'no'}
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
