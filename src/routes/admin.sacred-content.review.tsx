import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  approveSacredVersionFn,
  listSacredReviewQueueFn,
  returnSacredVersionFn,
} from '@/services/sacred-content-actions'
import { LANGUAGE_LABELS, contentTypeLabel } from '@/lib/guidance-labels'
import { Route as AdminRoute } from './admin'

/**
 * Sacred cultural review queue — ADMIN/SUPER_ADMIN only. Approval here
 * is the CULTURAL gate only: rights clearance and runtime enablement
 * remain separate, later gates.
 */
export const Route = createFileRoute('/admin/sacred-content/review')({
  beforeLoad: ({ context }) => {
    const admin = (context as { admin?: { permissions: Array<string> } }).admin
    if (!admin?.permissions.includes('spiritual_content.approve')) {
      throw redirect({ to: '/admin/sacred-content' })
    }
  },
  loader: async () => listSacredReviewQueueFn(),
  component: SacredReviewQueuePage,
})

function SacredReviewQueuePage() {
  const queue = Route.useLoaderData()
  const { admin } = AdminRoute.useRouteContext()
  const router = useRouter()
  const approve = useServerFn(approveSacredVersionFn)
  const returnToDraft = useServerFn(returnSacredVersionFn)
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
        to="/admin/sacred-content"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Sacred library
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Sacred content review queue</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Cultural approval only. Rights clearance and runtime enablement are
        separate gates managed on the item page.
      </p>

      {queue.length === 0 ? (
        <p className="mt-8 text-ink-soft">Nothing is waiting for review.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {queue.map(({ version, item }) => (
            <li
              key={version.id}
              className="rounded-lg border border-line bg-surface-raised p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Link
                    to="/admin/sacred-content/$id"
                    params={{ id: String(item.id) }}
                    className="font-medium text-gold-deep hover:underline"
                  >
                    {item.code}
                  </Link>
                  <span className="ml-3 text-sm text-ink-soft">
                    {contentTypeLabel(item.contentType)} · {item.scopeType} ·{' '}
                    {LANGUAGE_LABELS[version.language] ?? version.language} v
                    {version.versionNumber}
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
              <h2 className="mt-3 text-lg font-semibold">{version.title}</h2>
              <pre className="mt-4 max-h-80 overflow-y-auto rounded-md bg-surface p-4 text-sm whitespace-pre-wrap text-ink">
                {version.body}
              </pre>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => approve({ data: { versionId: version.id } }))
                  }
                  className="rounded-md bg-affirm px-4 py-2 text-sm font-medium text-white hover:bg-affirm/90 disabled:opacity-60"
                >
                  Approve (cultural)
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
