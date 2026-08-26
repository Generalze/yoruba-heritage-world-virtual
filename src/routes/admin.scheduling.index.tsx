import { Link, createFileRoute, redirect } from '@tanstack/react-router'

import { AdminTableFrame } from '@/components/admin'
import { adminListHousesSchedulingFn } from '@/services/appointment-actions'

export const Route = createFileRoute('/admin/scheduling/')({
  beforeLoad: ({ context }) => {
    if (!context.admin.permissions.includes('availability.manage')) {
      throw redirect({ to: '/admin' })
    }
  },
  loader: () => adminListHousesSchedulingFn(),
  component: SchedulingList,
})

function SchedulingList() {
  const houses = Route.useLoaderData()

  return (
    <div>
      <h1 className="text-2xl font-bold">Scheduling</h1>
      <p className="mt-2 text-sm text-ink-soft">
        Booking settings and availability belong to the Sacred House —
        individual members are never bookable and have no calendars.
      </p>
      <AdminTableFrame label="Scheduling">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-xs text-ink-soft uppercase">
              <th className="py-2 pr-4">Sacred House</th>
              <th className="py-2 pr-4">Booking</th>
              <th className="py-2 pr-4">Timezone</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {houses.map((house) => (
              <tr key={house.id} className="border-b border-line">
                <td className="py-3 pr-4">{house.name}</td>
                <td className="py-3 pr-4">
                  {house.settings.bookingEnabled ? (
                    <span className="text-affirm">enabled</span>
                  ) : (
                    <span className="text-ink-soft">disabled</span>
                  )}
                </td>
                <td className="py-3 pr-4 text-ink-soft">
                  {house.settings.schedulingTimezone}
                </td>
                <td className="py-3 text-right">
                  <Link
                    to="/admin/scheduling/$houseId"
                    params={{ houseId: house.id }}
                    className="text-gold-deep hover:text-ink"
                  >
                    Configure
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
