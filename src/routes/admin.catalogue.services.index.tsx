import { Link, createFileRoute } from '@tanstack/react-router'

import {
  AdminHelpPanel,
  AdminTableFrame,
  StatusBadge,
} from '@/components/admin'
import { adminListServicesFn } from '@/services/admin-catalogue-actions'

export const Route = createFileRoute('/admin/catalogue/services/')({
  loader: () => adminListServicesFn(),
  component: AdminServicesList,
})

function AdminServicesList() {
  const rows = Route.useLoaderData()

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Services</h1>
        <Link
          to="/admin/catalogue/services/new"
          className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-night hover:bg-gold-bright"
        >
          New service
        </Link>
      </div>
      <AdminHelpPanel>
        <p>
          Services define what a customer can book with a Sacred House. Global
          payment currency is USD, and prices must be approved rather than
          invented.
        </p>
        <p>
          Do not describe a fixed customer-facing appointment duration. The
          public flow is booking, verified payment, confirmed appointment,
          prepared video upload, then a private Prayer Room that opens at the
          scheduled time.
        </p>
      </AdminHelpPanel>
      <AdminTableFrame label="Services">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-ink-soft uppercase">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Sacred House</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.service.id} className="border-b border-line">
                <td className="py-3 pr-4">{row.service.name}</td>
                <td className="py-3 pr-4 text-ink-soft">{row.houseName}</td>
                <td className="py-3 pr-4">
                  <StatusBadge status={row.service.serviceStatus} />
                </td>
                <td className="py-3 text-right">
                  <Link
                    to="/admin/catalogue/services/$id"
                    params={{ id: row.service.id }}
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
