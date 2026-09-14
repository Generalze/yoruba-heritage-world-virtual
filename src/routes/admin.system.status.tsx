import { createFileRoute } from '@tanstack/react-router'

import { AdminHelpPanel } from '@/components/admin'
import { adminGetSystemStatusFn } from '@/services/admin-system-actions'

export const Route = createFileRoute('/admin/system/status')({
  loader: () => adminGetSystemStatusFn(),
  component: AdminSystemStatusPage,
})

function AdminSystemStatusPage() {
  const status = Route.useLoaderData()

  return (
    <div className="max-w-4xl">
      <h1 className="text-2xl font-bold">System Status</h1>
      <p className="mt-2 text-sm text-ink-soft">
        Read-only operational summary. No credentials, endpoints, object keys or
        user data are shown here.
      </p>

      <AdminHelpPanel title="How this status works">
        <p>
          Health says the process is alive. Readiness says whether the process
          can serve real traffic. Disabled generation capabilities are reported
          as operational limits, not secrets.
        </p>
      </AdminHelpPanel>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <StatusCard title="Application">
          <StatusRow label="Health" value={status.health.status} />
          <StatusRow label="Database" value={status.health.database} />
          <StatusRow label="Readiness" value={status.readiness.status} />
          <StatusRow
            label="Configuration"
            value={status.readiness.checks.configuration}
          />
          <StatusRow
            label="Render runtime"
            value={status.readiness.checks.renderRuntime}
          />
        </StatusCard>

        <StatusCard title="Payments">
          <StatusRow
            label="Global currency"
            value={status.payments.globalCurrency}
          />
          <StatusRow
            label="Payments enabled"
            value={status.payments.paymentsEnabled ? 'true' : 'false'}
          />
          <StatusRow
            label="PayPal"
            value={
              status.payments.paypalEnabled
                ? `${status.payments.paypalEnv} enabled`
                : 'disabled'
            }
          />
          <StatusRow
            label="Stripe"
            value={status.payments.stripeEnabled ? 'enabled' : 'disabled'}
          />
        </StatusCard>

        <StatusCard title="Prayer Room">
          <StatusRow
            label="Manual prepared-video upload"
            value={
              status.productionPath.manualPreparedVideoUpload
                ? 'enabled'
                : 'off'
            }
          />
          <StatusRow
            label="Upload maximum"
            value={status.productionPath.prayerRoomUploadMax}
          />
          <StatusRow label="Media access" value="private and time-gated" />
        </StatusCard>

        <StatusCard title="Generation">
          <StatusRow
            label="Visual generation"
            value={
              status.productionPath.automatedVisualGeneration
                ? 'enabled'
                : 'disabled'
            }
          />
          <StatusRow
            label="TTS"
            value={status.productionPath.automatedTts ? 'enabled' : 'disabled'}
          />
          <StatusRow
            label="Phase-One path"
            value="manual prepared-video upload"
          />
        </StatusCard>
      </div>

      {status.readiness.issues.length > 0 ? (
        <section className="mt-6 rounded-lg border border-caution/40 bg-caution/10 p-5">
          <h2 className="text-sm font-semibold tracking-wide text-ink">
            Readiness issues
          </h2>
          <ul className="mt-3 flex flex-wrap gap-2 text-xs">
            {status.readiness.issues.map((issue) => (
              <li
                key={issue}
                className="rounded-full border border-caution/40 px-3 py-1 text-caution"
              >
                {issue}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function StatusCard(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface-raised p-5">
      <h2 className="text-sm font-semibold tracking-wide text-ink">
        {props.title}
      </h2>
      <dl className="mt-4 space-y-3 text-sm">{props.children}</dl>
    </section>
  )
}

function StatusRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-ink-soft">{props.label}</dt>
      <dd className="rounded-full border border-line-strong bg-surface px-2.5 py-0.5 text-right text-xs font-medium text-ink-soft">
        {props.value}
      </dd>
    </div>
  )
}
