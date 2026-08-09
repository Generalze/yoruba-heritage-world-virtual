import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import { VISUAL_BIBLE_RULE_CATEGORIES } from '@/db/schema'
import {
  approveVisualBibleVersionFn,
  archiveVisualBibleVersionFn,
  createVisualBibleVersionFn,
  getVisualBibleFn,
  loadPublishedVisualBibleFn,
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
        className="text-sm text-stone-400 hover:text-amber-500"
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
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-500"
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
            className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300 hover:border-amber-500 disabled:opacity-60"
          >
            Run verified load
          </button>
        </div>
      </div>
      {loadResult ? (
        <p className="mt-2 text-xs text-stone-400">
          Verified loader result: {loadResult}
        </p>
      ) : null}

      <ul className="mt-6 space-y-3">
        {data.versions.map((version) => {
          const versionRules = data.rulesByVersion[version.id] ?? []
          return (
            <li
              key={version.id}
              className="rounded-md border border-stone-800 bg-stone-950 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  v{version.versionNumber} · {versionRules.length} rules
                </span>
                <span className="rounded-full bg-amber-950 px-2.5 py-0.5 text-xs text-amber-400">
                  {version.status.replaceAll('_', ' ')}
                </span>
              </div>
              {version.definitionSha256 ? (
                <p className="mt-1 text-xs break-all text-stone-500">
                  Definition SHA-256: {version.definitionSha256}
                </p>
              ) : null}
              {version.reviewNote && version.status === 'DRAFT' ? (
                <p className="mt-2 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
                  Returned with reason: {version.reviewNote}
                </p>
              ) : null}
              <ul className="mt-3 space-y-1 text-xs text-stone-300">
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
                      className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-300 hover:border-amber-500 disabled:opacity-60"
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
                      className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-300 hover:border-amber-500 disabled:opacity-60"
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
                      className="rounded-md bg-emerald-700 px-3 py-1.5 font-medium text-white hover:bg-emerald-600 disabled:opacity-60"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setReturning(version.id)}
                      className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-300 hover:border-amber-500 disabled:opacity-60"
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
                    className="rounded-md bg-amber-600 px-3 py-1.5 font-medium text-stone-950 hover:bg-amber-500 disabled:opacity-60"
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
                    className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-400 hover:border-red-700 hover:text-red-400 disabled:opacity-60"
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
                    className="w-full max-w-md rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
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
                    className="rounded-md border border-amber-700 px-3 py-2 text-sm text-amber-400 hover:bg-amber-950 disabled:opacity-60"
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
        <div className="mt-4 space-y-3 rounded-md border border-dashed border-stone-700 p-4">
          {rules.map((rule, index) => (
            <div key={index} className="flex flex-wrap items-end gap-2">
              <label className="block text-xs text-stone-400">
                Category
                <select
                  value={rule.category}
                  onChange={(event) =>
                    updateRule(index, { category: event.target.value })
                  }
                  className="mt-1 w-56 rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
                >
                  {VISUAL_BIBLE_RULE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category.replaceAll('_', ' ')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs text-stone-400">
                Position
                <input
                  value={rule.position}
                  onChange={(event) =>
                    updateRule(index, {
                      position: event.target.value.replace(/[^0-9]/g, ''),
                    })
                  }
                  className="mt-1 w-20 rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
                />
              </label>
              <label className="block flex-1 text-xs text-stone-400">
                Rule (human-authored plain text)
                <input
                  value={rule.ruleText}
                  onChange={(event) =>
                    updateRule(index, {
                      ruleText: event.target.value.slice(0, 2000),
                    })
                  }
                  className="mt-1 w-full rounded-md border border-stone-700 bg-stone-950 px-2 py-1.5 text-sm text-stone-100"
                />
              </label>
              <button
                type="button"
                onClick={() =>
                  setRules((current) =>
                    current.filter((_, ruleIndex) => ruleIndex !== index),
                  )
                }
                className="rounded-md border border-stone-700 px-2 py-1.5 text-xs text-stone-400 hover:border-red-700 hover:text-red-400"
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
              className="rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-300 hover:border-amber-500"
            >
              Add rule
            </button>
            <button
              type="button"
              disabled={busy || rules.some((rule) => !rule.ruleText.trim())}
              onClick={() => void handleSave()}
              className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-stone-950 hover:bg-amber-500 disabled:opacity-60"
            >
              {editingVersionId != null ? 'Save draft' : 'Create draft'}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false)
                setEditingVersionId(null)
              }}
              className="rounded-md border border-stone-700 px-4 py-2 text-sm text-stone-300"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
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
