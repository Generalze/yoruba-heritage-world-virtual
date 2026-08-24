import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  approvePrayerTemplateVersionFn,
  listPrayerTemplateReviewQueueFn,
  returnPrayerTemplateVersionFn,
} from '@/services/prayer-template-actions'
import { LANGUAGE_LABELS } from '@/lib/guidance-labels'
import { Route as AdminRoute } from './admin'

/** Template review queue — ADMIN/SUPER_ADMIN only. */
export const Route = createFileRoute('/admin/prayer-templates/review')({
  beforeLoad: ({ context }) => {
    const admin = (context as { admin?: { permissions: Array<string> } }).admin
    if (!admin?.permissions.includes('spiritual_content.approve')) {
      throw redirect({ to: '/admin/prayer-templates' })
    }
  },
  loader: async () => listPrayerTemplateReviewQueueFn(),
  component: TemplateReviewQueuePage,
})

function TemplateReviewQueuePage() {
  const queue = Route.useLoaderData()
  const { admin } = AdminRoute.useRouteContext()
  const router = useRouter()
  const approve = useServerFn(approvePrayerTemplateVersionFn)
  const returnToDraft = useServerFn(returnPrayerTemplateVersionFn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [returning, setReturning] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  void admin

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setReturning(null)
      setReason('')
      await router.invalidate()
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : 'Action failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Link
        to="/admin/prayer-templates"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Templates
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Template review queue</h1>

      {queue.length === 0 ? (
        <p className="mt-8 text-ink-soft">Nothing is waiting for review.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {queue.map(({ version, template }) => (
            <li
              key={version.id}
              className="rounded-lg border border-line bg-surface-raised p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Link
                    to="/admin/prayer-templates/$id"
                    params={{ id: String(template.id) }}
                    className="font-medium text-gold-deep hover:underline"
                  >
                    {template.code}
                  </Link>
                  <span className="ml-3 text-sm text-ink-soft">
                    {template.scopeType} ·{' '}
                    {LANGUAGE_LABELS[version.language] ?? version.language} v
                    {version.versionNumber} · priority {version.priority} ·
                    weight {version.selectionWeight} ·{' '}
                    {version.targetMinSeconds}–{version.targetMaxSeconds}s
                  </span>
                </div>
                <span className="text-xs text-ink-soft">
                  submitted{' '}
                  {version.submittedAt
                    ? new Date(version.submittedAt)
                        .toISOString()
                        .slice(0, 16)
                        .replace('T', ' ')
                    : '—'}
                </span>
              </div>
              <p className="mt-2 text-xs text-ink-soft">
                Inspect the full slot structure on the template page before
                approving.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => approve({ data: { versionId: version.id } }))
                  }
                  className="rounded-md bg-affirm px-4 py-2 text-sm font-medium text-white hover:bg-affirm/90 disabled:opacity-60"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setReturning(version.id)}
                  className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink-soft hover:border-gold-deep disabled:opacity-60"
                >
                  Return to draft
                </button>
              </div>
              {returning === version.id ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={reason}
                    onChange={(event) =>
                      setReason(event.target.value.slice(0, 500))
                    }
                    placeholder="Reason (required)"
                    className="w-full max-w-md rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
                  />
                  <button
                    type="button"
                    disabled={busy || !reason.trim()}
                    onClick={() =>
                      void run(() =>
                        returnToDraft({
                          data: { versionId: version.id, reason },
                        }),
                      )
                    }
                    className="rounded-md border border-gold px-3 py-2 text-sm text-gold-deep hover:bg-gold/10 disabled:opacity-60"
                  >
                    Confirm return
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
