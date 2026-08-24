import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'

import { StatusBadge } from '@/components/admin'
import { adminListDeitiesFn } from '@/services/admin-catalogue-actions'
import { CATALOGUE_STATUSES } from '@/db/schema'

export const Route = createFileRoute('/admin/catalogue/deities/')({
  loader: () => adminListDeitiesFn(),
  component: AdminDeitiesList,
})

function AdminDeitiesList() {
  const deities = Route.useLoaderData()
  const [statusFilter, setStatusFilter] = useState<string>('ALL')

  const visible =
    statusFilter === 'ALL'
      ? deities
      : deities.filter((deity) => deity.profileStatus === statusFilter)

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Deity Profiles</h1>
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            className="rounded-md border border-line-strong bg-surface-raised px-3 py-1.5 text-sm text-ink"
          >
            <option value="ALL">All statuses</option>
            {CATALOGUE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.replace('_', ' ')}
              </option>
            ))}
          </select>
          <Link
            to="/admin/catalogue/deities/new"
            className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-night hover:bg-gold-bright"
          >
            New profile
          </Link>
        </div>
      </div>
      <table className="mt-6 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs text-ink-soft uppercase">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Code</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Active</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {visible.map((deity) => (
            <tr key={deity.id} className="border-b border-line">
              <td className="py-3 pr-4">{deity.name}</td>
              <td className="py-3 pr-4 font-mono text-xs text-ink-soft">
                {deity.code}
              </td>
              <td className="py-3 pr-4">
                <StatusBadge status={deity.profileStatus} />
              </td>
              <td className="py-3 pr-4 text-ink-soft">
                {deity.active ? 'yes' : 'no'}
              </td>
              <td className="py-3 text-right">
                <Link
                  to="/admin/catalogue/deities/$id"
                  params={{ id: deity.id }}
                  className="text-gold-deep hover:text-ink"
                >
                  Open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
