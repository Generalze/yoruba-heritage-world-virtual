import { useState } from 'react'
import {
  Link,
  createFileRoute,
  redirect,
  useRouter,
} from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  approveSpiritualVersionFn,
  listSpiritualReviewQueueFn,
  returnSpiritualVersionFn,
} from '@/services/spiritual-content-actions'
import { LANGUAGE_LABELS, contentTypeLabel } from '@/lib/guidance-labels'
import { Route as AdminRoute } from './admin'

/**
 * Review queue — ADMIN/SUPER_ADMIN only (spiritual_content.approve).
 * Full sacred text is shown to reviewers as escaped plain text.
 * Actions: Approve, or Return to Draft with a mandatory reason.
 */
export const Route = createFileRoute('/admin/spiritual-content/review')({
  beforeLoad: ({ context }) => {
    const admin = (context as { admin?: { permissions: Array<string> } }).admin
    if (!admin?.permissions.includes('spiritual_content.approve')) {
      throw redirect({ to: '/admin/spiritual-content' })
    }
  },
  loader: async () => listSpiritualReviewQueueFn(),
  component: SpiritualReviewQueuePage,
})

function SpiritualReviewQueuePage() {
  const queue = Route.useLoaderData()
  const { admin } = AdminRoute.useRouteContext()
  const router = useRouter()
  const approve = useServerFn(approveSpiritualVersionFn)
  const returnToDraft = useServerFn(returnSpiritualVersionFn)
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
        to="/admin/spiritual-content"
        className="text-sm text-stone-400 hover:text-amber-500"
      >
        ← Library
      </Link>
      <h1 className="mt-4 text-2xl font-bold">Guidance review queue</h1>

      {queue.length === 0 ? (
        <p className="mt-8 text-stone-400">Nothing is waiting for review.</p>
      ) : (
        <ul className="mt-6 space-y-4">
          {queue.map(({ version, item }) => (
            <li
              key={version.id}
              className="rounded-lg border border-stone-800 bg-stone-900 p-6"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium">{item.code}</span>
                  <span className="ml-3 text-sm text-stone-400">
                    {contentTypeLabel(item.contentType)} · {item.scopeType} ·{' '}
                    {LANGUAGE_LABELS[version.language] ?? version.language} v
                    {version.versionNumber}
                  </span>
                </div>
                <span className="text-xs text-stone-500">
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
              <p className="mt-1 text-xs text-stone-500">
                Stage: {version.visibilityStage.replaceAll('_', ' ')} ·
                acknowledgement{' '}
                {version.acknowledgementRequired ? 'required' : 'not required'}
                {version.language === 'en' && version.allowEnglishFallback
                  ? ' · English fallback allowed'
                  : ''}
              </p>
              <pre className="mt-4 max-h-80 overflow-y-auto rounded-md bg-stone-950 p-4 text-sm whitespace-pre-wrap text-stone-200">
                {version.body}
              </pre>

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => approve({ data: { versionId: version.id } }))
                  }
                  className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                >
                  Approve
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setReturning(version.id)}
                  className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:border-amber-500 disabled:opacity-60"
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
                    className="w-full max-w-md rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
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
                    className="rounded-md border border-amber-700 px-3 py-2 text-sm text-amber-400 hover:bg-amber-950 disabled:opacity-60"
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
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}
