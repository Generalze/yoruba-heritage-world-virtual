import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import type { VISIBILITY_STAGES } from '@/db/schema'
import { GUIDANCE_LANGUAGES } from '@/db/schema'
import {
  archiveSpiritualVersionFn,
  createSpiritualVersionFn,
  getSpiritualContentItemFn,
  publishSpiritualVersionFn,
  setSpiritualContentActiveFn,
  submitSpiritualVersionFn,
  updateSpiritualDraftFn,
} from '@/services/spiritual-content-actions'
import { LANGUAGE_LABELS, contentTypeLabel } from '@/lib/guidance-labels'
import { Route as AdminRoute } from './admin'

/**
 * Content item detail: structure (frozen once any version is reviewed),
 * version history per language, DRAFT authoring, and permission-gated
 * workflow actions. Sacred text renders as escaped plain text only.
 */
export const Route = createFileRoute('/admin/spiritual-content/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid item id')
    return getSpiritualContentItemFn({ data: { id } })
  },
  component: ContentItemPage,
})

type VersionRow = Awaited<
  ReturnType<typeof getSpiritualContentItemFn>
>['versions'][number]

function ContentItemPage() {
  const data = Route.useLoaderData()
  const { admin } = AdminRoute.useRouteContext()
  const router = useRouter()
  const setActive = useServerFn(setSpiritualContentActiveFn)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canApprove = admin.permissions.includes('spiritual_content.approve')
  const canPublish = admin.permissions.includes('spiritual_content.publish')
  const item = data.item

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
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
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Library
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{item.code}</h1>
        <div className="flex items-center gap-3 text-sm">
          {item.active ? (
            <span className="rounded-full bg-affirm/10 px-3 py-1 text-affirm">
              active
            </span>
          ) : (
            <span className="rounded-full bg-surface px-3 py-1 text-ink-soft">
              inactive
            </span>
          )}
          {canPublish ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  setActive({ data: { id: item.id, active: !item.active } }),
                )
              }
              className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
            >
              {item.active ? 'Deactivate (future assignments)' : 'Reactivate'}
            </button>
          ) : null}
        </div>
      </div>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
          Structure{' '}
          {data.structureFrozen ? '(frozen — reviewed history exists)' : ''}
        </h2>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex gap-3">
            <dt className="text-ink-soft">Type</dt>
            <dd>{contentTypeLabel(item.contentType)}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-ink-soft">Scope</dt>
            <dd>{item.scopeType}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-ink-soft">Sacred House</dt>
            <dd>
              {data.houses.find((h) => h.id === item.sacredHouseId)?.name ??
                '—'}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-ink-soft">Service</dt>
            <dd>
              {data.services.find((s) => s.id === item.serviceId)?.name ?? '—'}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-ink-soft">Sort order</dt>
            <dd>{item.sortOrder}</dd>
          </div>
        </dl>
        {data.structureFrozen ? (
          <p className="mt-3 text-xs text-ink-soft">
            Code, type and scope are frozen because reviewed versions exist. To
            retarget this guidance, archive/deactivate this item and create a
            new one.
          </p>
        ) : null}
      </section>

      {GUIDANCE_LANGUAGES.map((language) => (
        <LanguageSection
          key={language}
          language={language}
          itemId={item.id}
          versions={data.versions.filter((v) => v.language === language)}
          canApprove={canApprove}
          canPublish={canPublish}
          busy={busy}
          run={run}
        />
      ))}

      {error ? (
        <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function LanguageSection({
  language,
  itemId,
  versions,
  canApprove,
  canPublish,
  busy,
  run,
}: {
  language: string
  itemId: number
  versions: Array<VersionRow>
  canApprove: boolean
  canPublish: boolean
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const createVersion = useServerFn(createSpiritualVersionFn)
  const updateDraft = useServerFn(updateSpiritualDraftFn)
  const submit = useServerFn(submitSpiritualVersionFn)
  const publish = useServerFn(publishSpiritualVersionFn)
  const archive = useServerFn(archiveSpiritualVersionFn)

  const working = versions.find((v) =>
    ['DRAFT', 'UNDER_REVIEW', 'APPROVED'].includes(v.status),
  )
  const [showForm, setShowForm] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [stage, setStage] = useState<string>('AFTER_CONFIRMATION')
  const [ackRequired, setAckRequired] = useState(false)
  const [allowFallback, setAllowFallback] = useState(false)

  const editingDraft = working?.status === 'DRAFT' ? working : null

  function loadDraftIntoForm(draft: VersionRow) {
    setTitle(draft.title)
    setBody(draft.body)
    setStage(draft.visibilityStage)
    setAckRequired(draft.acknowledgementRequired)
    setAllowFallback(draft.allowEnglishFallback)
    setShowForm(true)
  }

  async function handleSave() {
    const payload = {
      title,
      body,
      visibilityStage: stage as (typeof VISIBILITY_STAGES)[number],
      acknowledgementRequired: ackRequired,
      allowEnglishFallback: language === 'en' ? allowFallback : false,
    }
    await run(async () => {
      if (editingDraft) {
        await updateDraft({
          data: { versionId: editingDraft.id, version: payload },
        })
      } else {
        await createVersion({
          data: {
            itemId,
            version: {
              ...payload,
              language: language as 'en' | 'yo',
            },
          },
        })
      }
      setShowForm(false)
    })
  }

  return (
    <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
          {LANGUAGE_LABELS[language] ?? language} versions
        </h2>
        {!working && !showForm ? (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:border-gold-deep"
          >
            New draft
          </button>
        ) : null}
      </div>

      {versions.length === 0 && !showForm ? (
        <p className="mt-4 text-sm text-ink-soft">
          No {LANGUAGE_LABELS[language] ?? language} versions yet. Content is
          written by authorized people only — never generated.
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {versions.map((version) => (
          <li
            key={version.id}
            className="rounded-md border border-line bg-surface p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium">
                v{version.versionNumber} — {version.title}
              </span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs ${
                  version.status === 'PUBLISHED'
                    ? 'bg-affirm/10 text-affirm'
                    : version.status === 'ARCHIVED'
                      ? 'bg-surface text-ink-soft'
                      : 'bg-gold/10 text-gold-deep'
                }`}
              >
                {version.status.replaceAll('_', ' ')}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-soft">
              Stage: {version.visibilityStage.replaceAll('_', ' ')} ·
              acknowledgement{' '}
              {version.acknowledgementRequired ? 'required' : 'not required'}
              {version.language === 'en' && version.allowEnglishFallback
                ? ' · English fallback allowed'
                : ''}
            </p>
            {version.reviewNote && version.status === 'DRAFT' ? (
              <p className="mt-2 rounded-md border border-gold bg-gold/10 px-3 py-2 text-xs text-gold-deep">
                Returned with reason: {version.reviewNote}
              </p>
            ) : null}
            {version.status !== 'DRAFT' ? (
              <pre className="mt-3 max-h-48 overflow-y-auto rounded-md bg-surface-raised p-3 text-xs whitespace-pre-wrap text-ink-soft">
                {version.body}
              </pre>
            ) : null}
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {version.status === 'DRAFT' ? (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => loadDraftIntoForm(version)}
                    className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                  >
                    Edit draft
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        submit({ data: { versionId: version.id } }),
                      )
                    }
                    className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                  >
                    Submit for review
                  </button>
                </>
              ) : null}
              {version.status === 'APPROVED' && canPublish ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => publish({ data: { versionId: version.id } }))
                  }
                  className="rounded-md bg-gold px-3 py-1.5 font-medium text-night hover:bg-gold-bright disabled:opacity-60"
                >
                  Publish
                  {versions.some((v) => v.status === 'PUBLISHED')
                    ? ' (replaces the current published version)'
                    : ''}
                </button>
              ) : null}
              {version.status !== 'ARCHIVED' && canPublish ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => archive({ data: { versionId: version.id } }))
                  }
                  className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-alert hover:text-alert disabled:opacity-60"
                >
                  Archive
                </button>
              ) : null}
              {version.status === 'UNDER_REVIEW' && canApprove ? (
                <Link
                  to="/admin/spiritual-content/review"
                  className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep"
                >
                  Open in review queue
                </Link>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {showForm ? (
        <div className="mt-4 space-y-3 rounded-md border border-dashed border-line-strong p-4">
          <label className="block text-sm text-ink-soft">
            Title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value.slice(0, 200))}
              className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="block text-sm text-ink-soft">
            Guidance text (plain text; line breaks are preserved)
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value.slice(0, 20_000))}
              rows={10}
              className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="block text-sm text-ink-soft">
            Visibility stage
            <select
              value={stage}
              onChange={(event) => setStage(event.target.value)}
              className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
            >
              <option value="AFTER_CONFIRMATION">After confirmation</option>
              <option value="BEFORE_APPOINTMENT">Before appointment</option>
              <option value="AFTER_APPOINTMENT">
                After appointment (completed only)
              </option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm text-ink-soft">
            <input
              type="checkbox"
              checked={ackRequired}
              onChange={(event) => setAckRequired(event.target.checked)}
            />
            Ask the user to confirm they have read this guidance
          </label>
          {language === 'en' ? (
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={allowFallback}
                onChange={(event) => setAllowFallback(event.target.checked)}
              />
              Allow this English version for Yorùbá-preferring users when no
              Yorùbá version is published (explicit fallback)
            </label>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleSave()}
              className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-night hover:bg-gold-bright disabled:opacity-60"
            >
              {editingDraft ? 'Save draft' : 'Create draft'}
            </button>
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink-soft"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
