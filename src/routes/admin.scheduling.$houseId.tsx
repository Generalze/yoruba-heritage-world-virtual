import { useState } from 'react'
import {
  Link,
  createFileRoute,
  notFound,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { AdminError, AdminField, adminInputClass } from '@/components/admin'
import {
  adminAddExceptionFn,
  adminAddWindowFn,
  adminGetSchedulingFn,
  adminRemoveExceptionFn,
  adminSetWindowActiveFn,
  adminUpdateBookingSettingsFn,
} from '@/services/appointment-actions'

export const Route = createFileRoute('/admin/scheduling/$houseId')({
  params: {
    parse: (params) => ({
      houseId: z.coerce.number().int().parse(params.houseId),
    }),
    stringify: (params) => ({ houseId: String(params.houseId) }),
  },
  beforeLoad: ({ context }) => {
    if (!context.admin.permissions.includes('availability.manage')) {
      throw redirect({ to: '/admin' })
    }
  },
  loader: async ({ params }) => {
    const data = await adminGetSchedulingFn({
      data: { houseId: params.houseId },
    })
    if (!data.house) throw notFound()
    return data
  },
  component: SchedulingHousePage,
})

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function SchedulingHousePage() {
  const data = Route.useLoaderData()
  const updateSettings = useServerFn(adminUpdateBookingSettingsFn)
  const addWindow = useServerFn(adminAddWindowFn)
  const setWindowActive = useServerFn(adminSetWindowActiveFn)
  const addException = useServerFn(adminAddExceptionFn)
  const removeException = useServerFn(adminRemoveExceptionFn)
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [exceptionType, setExceptionType] = useState('CLOSED')

  const houseId = data.house!.id
  const settings = data.settings

  async function run(action: () => Promise<unknown>) {
    setError(null)
    setBusy(true)
    try {
      await action()
      await router.invalidate()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handleSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    await run(() =>
      updateSettings({
        data: {
          houseId,
          settings: {
            schedulingTimezone: String(form.get('schedulingTimezone') ?? ''),
            bookingEnabled: form.get('bookingEnabled') === 'on',
            slotIncrementMinutes: Number(form.get('slotIncrementMinutes')),
            minimumLeadMinutes: Number(form.get('minimumLeadMinutes')),
            maximumAdvanceDays: Number(form.get('maximumAdvanceDays')),
            reservationHoldMinutes: Number(form.get('reservationHoldMinutes')),
            cancellationCutoffMinutes: Number(
              form.get('cancellationCutoffMinutes'),
            ),
            rescheduleCutoffMinutes: Number(
              form.get('rescheduleCutoffMinutes'),
            ),
          },
        },
      }),
    )
  }

  async function handleAddWindow(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const dataForm = new FormData(form)
    await run(() =>
      addWindow({
        data: {
          houseId,
          window: {
            dayOfWeek: Number(dataForm.get('dayOfWeek')),
            startLocalTime: String(dataForm.get('startLocalTime') ?? ''),
            endLocalTime: String(dataForm.get('endLocalTime') ?? ''),
          },
        },
      }),
    )
    form.reset()
  }

  async function handleAddException(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const dataForm = new FormData(form)
    const type = String(dataForm.get('type') ?? 'CLOSED') as
      'CLOSED' | 'BLOCK' | 'OPEN'
    await run(() =>
      addException({
        data: {
          houseId,
          exception: {
            localDate: String(dataForm.get('localDate') ?? ''),
            type,
            startLocalTime:
              type === 'CLOSED'
                ? null
                : String(dataForm.get('startLocalTime') ?? ''),
            endLocalTime:
              type === 'CLOSED'
                ? null
                : String(dataForm.get('endLocalTime') ?? ''),
            label: String(dataForm.get('label') ?? ''),
          },
        },
      }),
    )
    form.reset()
    setExceptionType('CLOSED')
  }

  return (
    <div className="max-w-3xl">
      <Link
        to="/admin/scheduling"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Scheduling
      </Link>
      <h1 className="mt-3 text-2xl font-bold">{data.house!.name}</h1>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
          Booking settings
        </h2>
        <form
          onSubmit={handleSettings}
          className="mt-4 grid gap-4 sm:grid-cols-2"
        >
          <AdminField label="Scheduling timezone (IANA)">
            <input
              name="schedulingTimezone"
              defaultValue={settings.schedulingTimezone}
              required
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Slot increment (minutes)">
            <input
              name="slotIncrementMinutes"
              type="number"
              defaultValue={settings.slotIncrementMinutes}
              min={5}
              max={240}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Minimum lead (minutes)">
            <input
              name="minimumLeadMinutes"
              type="number"
              defaultValue={settings.minimumLeadMinutes}
              min={0}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Maximum advance (days)">
            <input
              name="maximumAdvanceDays"
              type="number"
              defaultValue={settings.maximumAdvanceDays}
              min={1}
              max={365}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Reservation hold (minutes)">
            <input
              name="reservationHoldMinutes"
              type="number"
              defaultValue={settings.reservationHoldMinutes}
              min={5}
              max={120}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Cancellation cutoff (minutes)">
            <input
              name="cancellationCutoffMinutes"
              type="number"
              defaultValue={settings.cancellationCutoffMinutes}
              min={0}
              className={adminInputClass}
            />
          </AdminField>
          <AdminField label="Reschedule cutoff (minutes)">
            <input
              name="rescheduleCutoffMinutes"
              type="number"
              defaultValue={settings.rescheduleCutoffMinutes}
              min={0}
              className={adminInputClass}
            />
          </AdminField>
          <label className="flex items-center gap-3 self-end pb-2 text-sm text-ink">
            <input
              type="checkbox"
              name="bookingEnabled"
              defaultChecked={settings.bookingEnabled}
            />
            Booking enabled
          </label>
          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-gold px-4 py-2 text-sm font-semibold text-night hover:bg-gold-bright disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
          Weekly availability ({settings.schedulingTimezone})
        </h2>
        <ul className="mt-4 space-y-2 text-sm">
          {data.windows.map((window) => (
            <li key={window.id} className="flex items-center gap-4">
              <span
                className={window.active ? '' : 'text-ink-soft line-through'}
              >
                {DAY_NAMES[window.dayOfWeek - 1]}{' '}
                {window.startLocalTime.slice(0, 5)}–
                {window.endLocalTime.slice(0, 5)}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    setWindowActive({
                      data: { windowId: window.id, active: !window.active },
                    }),
                  )
                }
                className="text-xs text-ink-soft hover:text-ink"
              >
                {window.active ? 'deactivate' : 'activate'}
              </button>
            </li>
          ))}
          {data.windows.length === 0 ? (
            <li className="text-ink-soft">
              No availability configured — the House has no bookable hours.
            </li>
          ) : null}
        </ul>
        <form onSubmit={handleAddWindow} className="mt-4 flex flex-wrap gap-2">
          <select
            name="dayOfWeek"
            className="rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
          >
            {DAY_NAMES.map((name, i) => (
              <option key={name} value={i + 1}>
                {name}
              </option>
            ))}
          </select>
          <input
            name="startLocalTime"
            type="time"
            required
            className={`${adminInputClass} w-32`}
          />
          <input
            name="endLocalTime"
            type="time"
            required
            className={`${adminInputClass} w-32`}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md border border-line-strong px-4 text-sm text-ink hover:border-gold-deep disabled:opacity-40"
          >
            Add window
          </button>
        </form>
      </section>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
          Date exceptions
        </h2>
        <ul className="mt-4 space-y-2 text-sm">
          {data.exceptions.map((exception) => (
            <li key={exception.id} className="flex items-center gap-4">
              <span>
                {exception.localDate} — {exception.type}
                {exception.startLocalTime
                  ? ` ${exception.startLocalTime.slice(0, 5)}–${exception.endLocalTime?.slice(0, 5)}`
                  : ''}
                {exception.label ? (
                  <span className="text-ink-soft"> ({exception.label})</span>
                ) : null}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    removeException({ data: { exceptionId: exception.id } }),
                  )
                }
                className="text-xs text-ink-soft hover:text-alert"
              >
                remove
              </button>
            </li>
          ))}
        </ul>
        <form
          onSubmit={handleAddException}
          className="mt-4 flex flex-wrap gap-2"
        >
          <input
            name="localDate"
            type="date"
            required
            className={`${adminInputClass} w-40`}
          />
          <select
            name="type"
            value={exceptionType}
            onChange={(event) => setExceptionType(event.target.value)}
            className="rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
          >
            <option value="CLOSED">CLOSED (whole day)</option>
            <option value="BLOCK">BLOCK (remove interval)</option>
            <option value="OPEN">OPEN (add interval)</option>
          </select>
          {exceptionType !== 'CLOSED' ? (
            <>
              <input
                name="startLocalTime"
                type="time"
                required
                className={`${adminInputClass} w-32`}
              />
              <input
                name="endLocalTime"
                type="time"
                required
                className={`${adminInputClass} w-32`}
              />
            </>
          ) : null}
          <input
            name="label"
            placeholder="Internal label (optional)"
            maxLength={200}
            className={`${adminInputClass} w-56`}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md border border-line-strong px-4 text-sm text-ink hover:border-gold-deep disabled:opacity-40"
          >
            Add exception
          </button>
        </form>
      </section>

      <AdminError message={error} />
    </div>
  )
}
