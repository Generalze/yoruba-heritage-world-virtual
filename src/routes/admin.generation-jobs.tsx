import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  cancelGenerationJobFn,
  getGenerationJobFn,
  listGenerationJobsFn,
  retryGenerationJobFn,
} from '@/services/generation-job-actions'

/**
 * Generation job operations (Step 12) — staff view of the DB queue:
 * status, attempts, lease state, recipe hashes and the event trail.
 * Technical retry/cancel only; nothing here shows sacred text,
 * private requests, payment data, consent references or storage keys.
 */
export const Route = createFileRoute('/admin/generation-jobs')({
  loader: async () => listGenerationJobsFn(),
  component: GenerationJobsPage,
})

type DetailData = Awaited<ReturnType<typeof getGenerationJobFn>>

function GenerationJobsPage() {
  const rows = Route.useLoaderData()
  const router = useRouter()
  const getDetail = useServerFn(getGenerationJobFn)
  const retry = useServerFn(retryGenerationJobFn)
  const cancel = useServerFn(cancelGenerationJobFn)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailData | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelling, setCancelling] = useState<number | null>(null)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setCancelling(null)
      setCancelReason('')
      await router.invalidate()
      if (detail) {
        setDetail(await getDetail({ data: { id: detail.job.id } }))
      }
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
      <h1 className="text-2xl font-bold">Generation Jobs</h1>
      <p className="mt-1 text-sm text-ink-soft">
        DB-backed prayer generation queue. Preparation runs autonomously in the
        worker (`bun run worker:generation`) — no per-appointment human approval
        exists.
      </p>

      {rows.length === 0 ? (
        <p className="mt-8 text-ink-soft">No generation jobs yet.</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[900px] border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs tracking-wider text-ink-soft uppercase">
                <th className="border-b border-line px-3 py-2">Job</th>
                <th className="border-b border-line px-3 py-2">
                  Appointment
                </th>
                <th className="border-b border-line px-3 py-2">
                  Service / House
                </th>
                <th className="border-b border-line px-3 py-2">Status</th>
                <th className="border-b border-line px-3 py-2">
                  Attempts
                </th>
                <th className="border-b border-line px-3 py-2">
                  Next / Lease
                </th>
                <th className="border-b border-line px-3 py-2">Error</th>
                <th className="border-b border-line px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(
                ({ job, appointmentPublicId, serviceName, houseName }) => (
                  <tr key={job.id} className="hover:bg-surface align-top">
                    <td className="border-b border-line px-3 py-2">
                      <button
                        type="button"
                        onClick={() =>
                          void run(async () =>
                            setDetail(
                              await getDetail({ data: { id: job.id } }),
                            ),
                          )
                        }
                        className="font-mono text-xs text-gold-deep hover:underline"
                      >
                        {job.publicId.slice(0, 8)}
                      </button>
                    </td>
                    <td className="border-b border-line px-3 py-2 font-mono text-xs">
                      {appointmentPublicId.slice(0, 8)}
                    </td>
                    <td className="border-b border-line px-3 py-2 text-xs">
                      {serviceName}
                      <br />
                      <span className="text-ink-soft">{houseName}</span>
                    </td>
                    <td className="border-b border-line px-3 py-2">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-xs ${
                          job.status === 'STORYBOARDING'
                            ? 'bg-affirm/10 text-affirm'
                            : job.status === 'FAILED'
                              ? 'bg-alert/10 text-alert'
                              : 'bg-gold/10 text-gold-deep'
                        }`}
                      >
                        {job.status}
                      </span>
                    </td>
                    <td className="border-b border-line px-3 py-2 text-xs">
                      {job.attemptCount}/{job.maxAttempts}
                    </td>
                    <td className="border-b border-line px-3 py-2 text-xs text-ink-soft">
                      {job.nextAttemptAt
                        ? `next ${new Date(job.nextAttemptAt).toISOString().slice(0, 16)}`
                        : '—'}
                      <br />
                      {job.leaseOwner
                        ? `lease ${job.leaseOwner.slice(0, 18)}`
                        : 'no lease'}
                    </td>
                    <td className="border-b border-line px-3 py-2 text-xs text-ink-soft">
                      {job.lastErrorCode ?? '—'}
                    </td>
                    <td className="border-b border-line px-3 py-2 text-xs">
                      {job.status === 'FAILED' ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(() => retry({ data: { id: job.id } }))
                          }
                          className="rounded-md border border-line-strong px-2 py-1 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                        >
                          Retry
                        </button>
                      ) : null}
                      {!['READY', 'CANCELLED'].includes(job.status) ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setCancelling(job.id)}
                          className="ml-1 rounded-md border border-line-strong px-2 py-1 text-ink-soft hover:border-alert hover:text-alert disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      ) : null}
                      {cancelling === job.id ? (
                        <span className="mt-1 flex gap-1">
                          <input
                            value={cancelReason}
                            onChange={(event) =>
                              setCancelReason(event.target.value.slice(0, 500))
                            }
                            placeholder="Reason (required)"
                            className="w-40 rounded-md border border-line-strong bg-surface-raised px-2 py-1 text-xs text-ink"
                          />
                          <button
                            type="button"
                            disabled={busy || !cancelReason.trim()}
                            onClick={() =>
                              void run(() =>
                                cancel({
                                  data: { id: job.id, reason: cancelReason },
                                }),
                              )
                            }
                            className="rounded-md border border-gold px-2 py-1 text-xs text-gold-deep hover:bg-gold/10 disabled:opacity-60"
                          >
                            OK
                          </button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}

      {detail ? (
        <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
          <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
            Job {detail.job.publicId}
          </h2>
          <dl className="mt-3 grid gap-1 text-xs text-ink-soft sm:grid-cols-2">
            <div>Status: {detail.job.status}</div>
            <div>Language: {detail.job.languageSnapshot}</div>
            <div className="break-all sm:col-span-2">
              Variation seed: {detail.job.variationSeed}
            </div>
            {detail.snapshots.map((snapshot) => (
              <div key={snapshot.id} className="break-all sm:col-span-2">
                Recipe snapshot #{snapshot.snapshotNumber} · recipe{' '}
                {snapshot.recipeSha256} · payload {snapshot.payloadSha256}
              </div>
            ))}
            {detail.storyboards.map((storyboard) => (
              <div key={storyboard.id} className="break-all sm:col-span-2">
                Storyboard #{storyboard.snapshotNumber} ·{' '}
                {storyboard.sceneCount} scenes · {storyboard.totalDurationMs} ms
                · hash {storyboard.storyboardSha256}
              </div>
            ))}
            {detail.manifests.map((manifest) => (
              <div key={manifest.id} className="break-all sm:col-span-2">
                Manifest #{manifest.snapshotNumber} · {manifest.visualTaskCount}{' '}
                visual task(s) · {manifest.audioRequirementCount} audio
                requirement(s) · hash {manifest.manifestSha256}
              </div>
            ))}
            {Object.keys(detail.sceneModes).length > 0 ? (
              <div className="sm:col-span-2">
                Scene modes:{' '}
                {Object.entries(detail.sceneModes)
                  .map(([mode, count]) => `${mode} ×${count}`)
                  .join(', ')}
                {' · '}Audio:{' '}
                {Object.entries(detail.audioModes)
                  .map(([mode, count]) => `${mode} ×${count}`)
                  .join(', ')}
                {' · '}Storyboard integrity: {detail.storyboardIntegrity}
              </div>
            ) : null}
          </dl>
          <h3 className="mt-4 text-xs tracking-widest text-ink-soft uppercase">
            Events
          </h3>
          <ul className="mt-2 space-y-1 text-xs text-ink-soft">
            {detail.events.map((event) => (
              <li key={event.id}>
                {new Date(event.createdAt).toISOString().slice(0, 19)} ·{' '}
                {event.fromStatus ?? '∅'} → {event.toStatus} · {event.eventCode}
                {event.detailCode ? ` (${event.detailCode})` : ''} · attempt{' '}
                {event.attemptNumber}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
