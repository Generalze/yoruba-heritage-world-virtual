import { Link, createFileRoute } from '@tanstack/react-router'

import { StatusBadge } from '@/components/admin'
import { adminListSacredHousesFn } from '@/services/admin-catalogue-actions'

export const Route = createFileRoute('/admin/catalogue/sacred-houses/')({
  loader: () => adminListSacredHousesFn(),
  component: AdminHousesList,
})

function AdminHousesList() {
  const houses = Route.useLoaderData()

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Sacred Houses</h1>
        <Link
          to="/admin/catalogue/sacred-houses/new"
          className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500"
        >
          New Sacred House
        </Link>
      </div>
      <table className="mt-6 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-stone-800 text-xs text-stone-500 uppercase">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Code</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2 pr-4">Active</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {houses.map((house) => (
            <tr key={house.id} className="border-b border-stone-900">
              <td className="py-3 pr-4">{house.name}</td>
              <td className="py-3 pr-4 font-mono text-xs text-stone-400">
                {house.code}
              </td>
              <td className="py-3 pr-4">
                <StatusBadge status={house.status} />
              </td>
              <td className="py-3 pr-4 text-stone-400">
                {house.active ? 'yes' : 'no'}
              </td>
              <td className="py-3 text-right">
                <Link
                  to="/admin/catalogue/sacred-houses/$id"
                  params={{ id: house.id }}
                  className="text-amber-500 hover:text-amber-400"
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
