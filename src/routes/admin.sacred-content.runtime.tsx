import { Link, createFileRoute } from '@tanstack/react-router'

import { listSacredRuntimeStateFn } from '@/services/sacred-content-actions'
import { RIGHTS_STATUS_LABELS, contentTypeLabel } from '@/lib/guidance-labels'

/**
 * Runtime state overview: which PUBLISHED sacred versions are runtime
 * eligible right now, and which are blocked and by which gate. Safe
 * metadata only — no sacred bodies here.
 */
export const Route = createFileRoute('/admin/sacred-content/runtime')({
  loader: async () => listSacredRuntimeStateFn(),
  component: SacredRuntimePage,
})

function SacredRuntimePage() {
  const rows = Route.useLoaderData()
  const eligible = rows.filter((r) => r.eligible)
  const blocked = rows.filter((r) => !r.eligible)

  return (
    <div>
      <Link
        to="/admin/sacred-content"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Sacred library
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Runtime eligibility</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Computed from all gates simultaneously: published + storage authorized +
        rights cleared + prayer-room access + runtime enabled + integrity hash.
        No human approves individual appointments — the autonomous engine will
        only ever draw from the eligible set below.
      </p>

      <h2 className="mt-8 text-sm font-medium tracking-widest text-affirm uppercase">
        Eligible now ({eligible.length})
      </h2>
      <RuntimeTable rows={eligible} empty="No runtime-eligible content yet." />

      <h2 className="mt-8 text-sm font-medium tracking-widest text-gold-deep uppercase">
        Published but blocked ({blocked.length})
      </h2>
      <RuntimeTable
        rows={blocked}
        empty="No blocked published versions."
        showFailures
      />
    </div>
  )
}

function RuntimeTable({
  rows,
  empty,
  showFailures = false,
}: {
  rows: Awaited<ReturnType<typeof listSacredRuntimeStateFn>>
  empty: string
  showFailures?: boolean
}) {
  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-ink-soft">{empty}</p>
  }
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[800px] border-separate border-spacing-0 text-sm">
        <thead>
          <tr className="text-left text-xs tracking-wider text-ink-soft uppercase">
            <th className="border-b border-line px-3 py-2">Code</th>
            <th className="border-b border-line px-3 py-2">Type</th>
            <th className="border-b border-line px-3 py-2">Scope</th>
            <th className="border-b border-line px-3 py-2">Lang</th>
            <th className="border-b border-line px-3 py-2">Version</th>
            <th className="border-b border-line px-3 py-2">Rights</th>
            <th className="border-b border-line px-3 py-2">Enabled</th>
            {showFailures ? (
              <th className="border-b border-line px-3 py-2">
                Blocked by
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.versionId} className="hover:bg-surface">
              <td className="border-b border-line px-3 py-2">
                <Link
                  to="/admin/sacred-content/$id"
                  params={{ id: String(row.itemId) }}
                  className="font-medium text-gold-deep hover:underline"
                >
                  {row.code}
                </Link>
              </td>
              <td className="border-b border-line px-3 py-2">
                {contentTypeLabel(row.contentType)}
              </td>
              <td className="border-b border-line px-3 py-2">
                {row.scopeType}
              </td>
              <td className="border-b border-line px-3 py-2">
                {row.language}
              </td>
              <td className="border-b border-line px-3 py-2">
                v{row.versionNumber}
              </td>
              <td className="border-b border-line px-3 py-2">
                {RIGHTS_STATUS_LABELS[row.rightsStatus] ?? row.rightsStatus}
              </td>
              <td className="border-b border-line px-3 py-2">
                {row.runtimeEnabled ? 'yes' : 'no'}
              </td>
              {showFailures ? (
                <td className="border-b border-line px-3 py-2 text-xs text-ink-soft">
                  {row.failures.join(', ')}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
