import { Link, createFileRoute } from '@tanstack/react-router'

import { AdminTableFrame, StatusBadge } from '@/components/admin'
import { adminListSacredHousesFn } from '@/services/admin-catalogue-actions'

export const Route = createFileRoute('/admin/catalogue/sacred-houses/')({
  loader: () => adminListSacredHousesFn(),
  component: AdminHousesList,
})

function AdminHousesList() {
  const houses = Route.useLoaderData()

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Sacred Houses</h1>
        <Link
          to="/admin/catalogue/sacred-houses/new"
          className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-night hover:bg-gold-bright"
        >
          New Sacred House
        </Link>
      </div>
      <AdminTableFrame label="Sacred Houses">
        <table className="w-full min-w-[640px] text-left text-sm">
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
            {houses.map((house) => (
              <tr key={house.id} className="border-b border-line">
                <td className="py-3 pr-4">{house.name}</td>
                <td className="py-3 pr-4 font-mono text-xs text-ink-soft">
                  {house.code}
                </td>
                <td className="py-3 pr-4">
                  <StatusBadge status={house.status} />
                </td>
                <td className="py-3 pr-4 text-ink-soft">
                  {house.active ? 'yes' : 'no'}
                </td>
                <td className="py-3 text-right">
                  <Link
                    to="/admin/catalogue/sacred-houses/$id"
                    params={{ id: house.id }}
                    className="text-gold-deep hover:text-ink"
                  >
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminTableFrame>
    </div>
  )
}
