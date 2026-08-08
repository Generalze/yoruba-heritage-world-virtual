import { Link, createFileRoute } from '@tanstack/react-router'

import { StatusBadge } from '@/components/admin'
import { adminListServicesFn } from '@/services/admin-catalogue-actions'

export const Route = createFileRoute('/admin/catalogue/services/')({
  loader: () => adminListServicesFn(),
  component: AdminServicesList,
})

function AdminServicesList() {
  const rows = Route.useLoaderData()

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Services</h1>
        <Link
          to="/admin/catalogue/services/new"
          className="rounded-md bg-amber-600 px-4 py-2 text-sm font-semibold text-stone-950 hover:bg-amber-500"
        >
          New service
        </Link>
      </div>
      <table className="mt-6 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-stone-800 text-xs text-stone-500 uppercase">
            <th className="py-2 pr-4">Name</th>
            <th className="py-2 pr-4">Sacred House</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.service.id} className="border-b border-stone-900">
              <td className="py-3 pr-4">{row.service.name}</td>
              <td className="py-3 pr-4 text-stone-400">{row.houseName}</td>
              <td className="py-3 pr-4">
                <StatusBadge status={row.service.serviceStatus} />
              </td>
              <td className="py-3 text-right">
                <Link
                  to="/admin/catalogue/services/$id"
                  params={{ id: row.service.id }}
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
