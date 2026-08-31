import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import {
  VISUAL_BIBLE_REFERENCE_ROLES,
  VISUAL_BIBLE_RULE_CATEGORIES,
} from '@/db/schema'
import type { VisualBibleReferenceRole } from '@/db/schema'
import {
  approveVisualBibleVersionFn,
  archiveVisualBibleVersionFn,
  createVisualBibleVersionFn,
  getVisualBibleFn,
  bindVisualBibleReferenceFn,
  loadPublishedVisualBibleFn,
  setVisualBibleReferenceModeFn,
  unbindVisualBibleReferenceFn,
  publishVisualBibleVersionFn,
  returnVisualBibleVersionFn,
  submitVisualBibleVersionFn,
  updateVisualBibleDraftFn,
} from '@/services/visual-bible-actions'
import { Route as AdminRoute } from './admin'

/**
 * Visual Bible detail: version lifecycle, ordered human-authored
 * rules, review/publish actions, definition hash and a verified-load
 * check that exercises the real fail-closed integrity loader.
 */
export const Route = createFileRoute('/admin/visual-bibles/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id')
    return getVisualBibleFn({ data: { id } })
  },
  component: VisualBiblePage,
})

interface RuleForm {
  category: string
  position: string
  ruleText: string
}

function VisualBiblePage() {
  const data = Route.useLoaderData()
  const { admin } = AdminRoute.useRouteContext()
  const router = useRouter()
  const createVersion = useServerFn(createVisualBibleVersionFn)
  const updateDraft = useServerFn(updateVisualBibleDraftFn)
  const submit = useServerFn(submitVisualBibleVersionFn)
  const approve = useServerFn(approveVisualBibleVersionFn)
  const returnVersion = useServerFn(returnVisualBibleVersionFn)
  const publish = useServerFn(publishVisualBibleVersionFn)
  const archive = useServerFn(archiveVisualBibleVersionFn)
  const verifiedLoad = useServerFn(loadPublishedVisualBibleFn)
  const setReferenceMode = useServerFn(setVisualBibleReferenceModeFn)
  const bindReference = useServerFn(bindVisualBibleReferenceFn)
  const unbindReference = useServerFn(unbindVisualBibleReferenceFn)

  const canApprove = admin.permissions.includes('media.approve')
  const canPublish = admin.permissions.includes('media.publish')

  const working = data.versions.find((version) =>
    ['DRAFT', 'UNDER_REVIEW', 'APPROVED'].includes(version.status),
  )
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingVersionId, setEditingVersionId] = useState<number | null>(null)
  const [rules, setRules] = useState<Array<RuleForm>>([
    { category: 'ENVIRONMENT', position: '1', ruleText: '' },
  ])
  const [returning, setReturning] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [loadResult, setLoadResult] = useState<string | null>(null)

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

  function loadDraftIntoForm(versionId: number) {
    const draftRules = data.rulesByVersion[versionId] ?? []
    setRules(
      draftRules.map((rule) => ({
        category: rule.category,
        position: String(rule.position),
        ruleText: rule.ruleText,
      })),
    )
    setEditingVersionId(versionId)
    setShowForm(true)
  }

  async function handleSave() {
    const payload = {
      rules: rules.map((rule) => ({
        category:
          rule.category as (typeof VISUAL_BIBLE_RULE_CATEGORIES)[number],
        position: Number(rule.position) || 0,
        ruleText: rule.ruleText,
      })),
    }
    await run(async () => {
      if (editingVersionId != null) {
        await updateDraft({
          data: { versionId: editingVersionId, version: payload },
        })
      } else {
        await createVersion({
          data: { bibleId: data.bible.id, version: payload },
        })
      }
      setShowForm(false)
      setEditingVersionId(null)
    })
  }

  return (
    <div>
      <Link
        to="/admin/visual-bibles"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Visual Bibles
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{data.houseName} — Visual Bible</h1>
        <div className="flex gap-2">
          {!working && !showForm ? (
            <button
              type="button"
              onClick={() => {
                setEditingVersionId(null)
                setRules([
                  { category: 'ENVIRONMENT', position: '1', ruleText: '' },
                ])
                setShowForm(true)
              }}
              className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-night hover:bg-gold-bright"
            >
              New draft
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await verifiedLoad({
                  data: { sacredHouseId: data.bible.sacredHouseId },
                })
                setLoadResult(
                  result.status === 'OK'
                    ? `OK — v${result.versionNumber}, ${result.rules.length} rules, hash verified`
                    : result.status,
                )
              })
            }
            className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink-soft hover:border-gold-deep disabled:opacity-60"
          >
            Run verified load
          </button>
        </div>
      </div>
      {loadResult ? (
        <p className="mt-2 text-xs text-ink-soft">
          Verified loader result: {loadResult}
        </p>
      ) : null}

      <ul className="mt-6 space-y-3">
        {data.versions.map((version) => {
          const versionRules = data.rulesByVersion[version.id] ?? []
          const versionReferences =
            data.referenceStateByVersion[version.id] ?? []
          return (
            <li
              key={version.id}
              className="rounded-md border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  v{version.versionNumber} · {versionRules.length} rules
                  {version.referenceMode === 'IMAGE_REFERENCE_REQUIRED'
                    ? ` · ${versionReferences.length}/6 references`
                    : null}
                </span>
                <span className="rounded-full bg-gold/10 px-2.5 py-0.5 text-xs text-gold-deep">
                  {version.status.replaceAll('_', ' ')}
                </span>
              </div>
              {version.definitionSha256 ? (
                <p className="mt-1 text-xs break-all text-ink-soft">
                  Definition SHA-256: {version.definitionSha256}
                </p>
              ) : null}
              <ReferencePanel
                versionId={version.id}
                status={version.status}
                referenceMode={version.referenceMode}
                references={versionReferences}
                busy={busy}
                onSetMode={async (mode) => {
                  await run(() =>
                    setReferenceMode({
                      data: { versionId: version.id, referenceMode: mode },
                    }),
                  )
                }}
                onBind={async (role, mediaAssetVersionId) => {
                  await run(() =>
                    bindReference({
                      data: {
                        versionId: version.id,
                        role,
                        mediaAssetVersionId,
                      },
                    }),
                  )
                }}
                onUnbind={async (role) => {
                  await run(() =>
                    unbindReference({
                      data: { versionId: version.id, role },
                    }),
                  )
                }}
              />
              {version.reviewNote && version.status === 'DRAFT' ? (
                <p className="mt-2 rounded-md border border-gold bg-gold/10 px-3 py-2 text-xs text-gold-deep">
                  Returned with reason: {version.reviewNote}
                </p>
              ) : null}
              <ul className="mt-3 space-y-1 text-xs text-ink-soft">
                {versionRules.map((rule) => (
                  <li key={rule.id}>
                    {rule.position}. [{rule.category}] {rule.ruleText}
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {version.status === 'DRAFT' ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => loadDraftIntoForm(version.id)}
                      className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                    >
                      Edit rules
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
                {version.status === 'UNDER_REVIEW' && canApprove ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          approve({ data: { versionId: version.id } }),
                        )
                      }
                      className="rounded-md bg-affirm px-3 py-1.5 font-medium text-white hover:bg-affirm/90 disabled:opacity-60"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setReturning(version.id)}
                      className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                    >
                      Return to draft
                    </button>
                  </>
                ) : null}
                {version.status === 'APPROVED' && canPublish ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        publish({ data: { versionId: version.id } }),
                      )
                    }
                    className="rounded-md bg-gold px-3 py-1.5 font-medium text-night hover:bg-gold-bright disabled:opacity-60"
                  >
                    Publish
                  </button>
                ) : null}
                {version.status !== 'ARCHIVED' && canPublish ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        archive({ data: { versionId: version.id } }),
                      )
                    }
                    className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-alert hover:text-alert disabled:opacity-60"
                  >
                    Archive
                  </button>
                ) : null}
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
                        returnVersion({
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
          )
        })}
      </ul>

      {showForm ? (
        <div className="mt-4 space-y-3 rounded-md border border-dashed border-line-strong p-4">
          {rules.map((rule, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <label className="block text-xs text-ink-soft">
                Category
                <select
                  value={rule.category}
                  onChange={(event) =>
                    updateRule(index, { category: event.target.value })
                  }
                  className="mt-1 w-56 rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                >
                  {VISUAL_BIBLE_RULE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-ink-soft">
                Position
                <input
                  value={rule.position}
                  onChange={(event) =>
                    updateRule(index, {
                      position: event.target.value.replace(/[^0-9]/g, ''),
                    })
                  }
                  className="mt-1 w-20 rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                />
              </label>
              <label className="block flex-1 text-xs text-ink-soft">
                Rule (human-authored plain text)
                <input
                  value={rule.ruleText}
                  onChange={(event) =>
                    updateRule(index, {
                      ruleText: event.target.value.slice(0, 2000),
                    })
                  }
                  className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setRules((current) =>
                    current.filter((_, ruleIndex) => ruleIndex !== index),
                  )
                }
                className="rounded-md border border-line-strong px-2 py-1.5 text-xs text-ink-soft hover:border-alert hover:text-alert"
              >
                Remove
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() =>
                setRules((current) => [
                  ...current,
                  {
                    category: 'ENVIRONMENT',
                    position: String(current.length + 1),
                    ruleText: '',
                  },
                ])
              }
              className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:border-gold-deep"
            >
              Add rule
            </button>
            <button
              type="button"
              disabled={busy || rules.some((rule) => !rule.ruleText.trim())}
              onClick={() => void handleSave()}
              className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-night hover:bg-gold-bright disabled:opacity-60"
            >
              {editingVersionId != null ? 'Save draft' : 'Create draft'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false)
                setEditingVersionId(null)
              }}
              className="rounded-md border border-line-strong px-4 py-2 text-sm text-ink-soft"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          {error}
        </p>
      ) : null}
    </div>
  )

  function updateRule(index: number, patch: Partial<RuleForm>) {
    setRules((current) =>
      current.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, ...patch } : rule,
      ),
    )
  }
}

/**
 * Reference authoring for ONE Visual Bible version.
 *
 * Editable only while DRAFT — after that this is a read-only record of
 * what was approved. The controls disappearing is a courtesy; the
 * service refuses the same operations regardless.
 *
 * Binding accepts an existing GOVERNED media asset version id. There is
 * deliberately no upload-by-file shortcut here: an image becomes usable
 * by passing the media library's own review, rights and runtime gates,
 * never by arriving through this screen.
 */
function ReferencePanel(props: {
  versionId: number
  status: string
  referenceMode: string
  references: Array<{
    role: string
    mediaAssetVersionId: number
    mediaFileSha256: string
    eligible: boolean
    failures: Array<string>
    assetKind: string | null
    rightsStatus: string | null
    runtimeEnabled: boolean | null
    externalAiPolicy: string | null
  }>
  busy: boolean
  onSetMode: (mode: 'TEXT_ONLY' | 'IMAGE_REFERENCE_REQUIRED') => Promise<void>
  onBind: (
    role: VisualBibleReferenceRole,
    mediaAssetVersionId: number,
  ) => Promise<void>
  onUnbind: (role: VisualBibleReferenceRole) => Promise<void>
}) {
  const [pending, setPending] = useState<Record<string, string>>({})
  const editable = props.status === 'DRAFT'
  const byRole = new Map(props.references.map((r) => [r.role, r]))

  return (
    <div className="mt-3 rounded-md border border-line bg-surface-raised p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-semibold tracking-wide text-ink uppercase">
          Reference imagery
        </span>
        {editable ? (
          <label className="text-xs text-ink-soft">
            Mode
            <select
              value={props.referenceMode}
              disabled={props.busy}
              onChange={(event) =>
                void props.onSetMode(
                  event.target.value as
                    'TEXT_ONLY' | 'IMAGE_REFERENCE_REQUIRED',
                )
              }
              className="ml-2 rounded-md border border-line-strong bg-surface-raised px-2 py-1 text-xs text-ink"
            >
              <option value="TEXT_ONLY">Text only</option>
              <option value="IMAGE_REFERENCE_REQUIRED">
                Image reference required
              </option>
            </select>
          </label>
        ) : (
          <span className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs text-ink-soft">
            {props.referenceMode.replaceAll('_', ' ')} · read-only
          </span>
        )}
      </div>

      {props.referenceMode === 'TEXT_ONLY' ? (
        <p className="mt-2 text-xs text-ink-soft">
          This version is governed by its written rules alone. Switch the mode
          to bind approved reference imagery.
        </p>
      ) : (
        <>
          <p className="mt-2 text-xs text-ink-soft">
            All six roles must be bound to approved, rights-cleared,
            runtime-enabled images for this Sacred House before the version can
            be submitted. {props.references.length}/6 bound.
          </p>
          <ul className="mt-2 space-y-1">
            {VISUAL_BIBLE_REFERENCE_ROLES.map((role) => {
              const bound = byRole.get(role)
              return (
                <li
                  key={role}
                  className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-1.5 text-xs"
                >
                  <span className="text-ink">{role.replaceAll('_', ' ')}</span>
                  {bound ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-ink-soft">
                        media version {bound.mediaAssetVersionId} ·{' '}
                        {bound.mediaFileSha256.slice(0, 12)}…
                      </span>
                      <span
                        className={
                          bound.eligible
                            ? 'rounded-full border border-affirm/40 bg-affirm/10 px-2 py-0.5 text-affirm'
                            : 'rounded-full border border-alert/40 bg-alert/10 px-2 py-0.5 text-alert'
                        }
                      >
                        {bound.eligible ? 'eligible' : 'not eligible'}
                      </span>
                      {bound.eligible ? null : (
                        <span className="text-alert">
                          {bound.failures.join(', ')}
                        </span>
                      )}
                      <span className="text-ink-soft">
                        {[
                          bound.assetKind,
                          bound.rightsStatus,
                          bound.runtimeEnabled == null
                            ? null
                            : bound.runtimeEnabled
                              ? 'runtime on'
                              : 'runtime off',
                          bound.externalAiPolicy,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {editable ? (
                        <button
                          type="button"
                          disabled={props.busy}
                          onClick={() => void props.onUnbind(role)}
                          className="rounded-md border border-line-strong px-2 py-1 text-ink-soft hover:border-alert disabled:opacity-60"
                        >
                          Unbind
                        </button>
                      ) : null}
                    </span>
                  ) : editable ? (
                    <span className="flex items-center gap-2">
                      <input
                        value={pending[role] ?? ''}
                        onChange={(event) =>
                          setPending((current) => ({
                            ...current,
                            [role]: event.target.value.replace(/[^0-9]/g, ''),
                          }))
                        }
                        placeholder="media version id"
                        className="w-36 rounded-md border border-line-strong bg-surface-raised px-2 py-1 text-xs text-ink"
                      />
                      <button
                        type="button"
                        disabled={props.busy || !pending[role]}
                        onClick={() => {
                          const id = Number(pending[role])
                          if (Number.isInteger(id) && id > 0) {
                            void props.onBind(role, id)
                          }
                        }}
                        className="rounded-md border border-line-strong px-2 py-1 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                      >
                        Bind
                      </button>
                    </span>
                  ) : (
                    <span className="text-alert">not bound</span>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}
    </div>
  )
}
