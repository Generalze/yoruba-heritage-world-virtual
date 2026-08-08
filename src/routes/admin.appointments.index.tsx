import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'

import { StatusBadge } from '@/components/admin'
import { adminListAppointmentsFn } from '@/services/appointment-actions'
import { APPOINTMENT_STATUSES } from '@/db/schema'

export const Route = createFileRoute('/admin/appointments/')({
  validateSearch: (
    search,
  ): {
    status?: (typeof APPOINTMENT_STATUSES)[number]
    houseId?: number
    date?: string
  } => ({
    ...(typeof search.status === 'string' &&
    (APPOINTMENT_STATUSES as ReadonlyArray<string>).includes(search.status)
      ? { status: search.status as (typeof APPOINTMENT_STATUSES)[number] }
      : {}),
    ...(typeof search.houseId === 'number' && search.houseId > 0
      ? { houseId: search.houseId }
      : {}),
    ...(typeof search.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(search.date)
      ? { date: search.date }
      : {}),
  }),
  beforeLoad: ({ context }) => {
    if (!context.admin.permissions.includes('appointments.view')) {
      throw redirect({ to: '/admin' })
    }
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    adminListAppointmentsFn({
      data: {
        status: deps.status,
        sacredHouseId: deps.houseId,
        fromDate: deps.date,
        toDate: deps.date,
      },
    }),
  component: AppointmentsList,
})

function AppointmentsList() {
  const { rows, houses } = Route.useLoaderData()
  const search = Route.useSearch()
  const router = useRouter()
  const [date, setDate] = useState(search.date ?? '')

  function updateSearch(next: Partial<typeof search>) {
    void router.navigate({
      to: '/admin/appointments',
      search: { ...search, ...next },
    })
  }

  return (
    <div>
      <h1 className="text-2xl font-bold">Appointments</h1>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
        <select
          value={search.status ?? ''}
          onChange={(event) =>
            updateSearch({
              status: (event.target.value || undefined) as typeof search.status,
            })
          }
          className="rounded-md border border-stone-700 bg-stone-900 px-3 py-1.5 text-stone-200"
        >
          <option value="">All statuses</option>
          {APPOINTMENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status.replace('_', ' ')}
            </option>
          ))}
        </select>
        <select
          value={search.houseId ?? ''}
          onChange={(event) =>
            updateSearch({
              houseId: event.target.value
                ? Number(event.target.value)
                : undefined,
            })
          }
          className="rounded-md border border-stone-700 bg-stone-900 px-3 py-1.5 text-stone-200"
        >
          <option value="">All Sacred Houses</option>
          {houses.map((house) => (
            <option key={house.id} value={house.id}>
              {house.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={date}
          onChange={(event) => {
            setDate(event.target.value)
            updateSearch({ date: event.target.value || undefined })
          }}
          className="rounded-md border border-stone-700 bg-stone-900 px-3 py-1.5 text-stone-200"
        />
      </div>

      <table className="mt-6 w-full text-left text-sm">
        <thead>
          <tr className="border-b border-stone-800 text-xs text-stone-500 uppercase">
            <th className="py-2 pr-4">Starts (UTC)</th>
            <th className="py-2 pr-4">Service</th>
            <th className="py-2 pr-4">Sacred House</th>
            <th className="py-2 pr-4">Status</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((appointment) => (
            <tr key={appointment.id} className="border-b border-stone-900">
              <td className="py-3 pr-4 font-mono text-xs">
                {appointment.startsAtUtc}
              </td>
              <td className="py-3 pr-4">{appointment.serviceNameSnapshot}</td>
              <td className="py-3 pr-4">{appointment.houseNameSnapshot}</td>
              <td className="py-3 pr-4">
                <StatusBadge status={appointment.status} />
              </td>
              <td className="py-3 text-right">
                <Link
                  to="/admin/appointments/$id"
                  params={{ id: appointment.id }}
                  className="text-amber-500 hover:text-amber-400"
                >
                  Open
                </Link>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="py-6 text-stone-500">
                No appointments match these filters.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}
