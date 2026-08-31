import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  CONTENT_SCOPE_TYPES,
  GUIDANCE_LANGUAGES,
  SACRED_RUNTIME_CONTENT_TYPES,
  SLOT_REFERENCE_REQUIREMENTS,
  SLOT_SHOT_FAMILIES,
  SLOT_KINDS,
  SLOT_SELECTOR_MODES,
  VARIANT_KINDS,
} from '@/db/schema'
import {
  archivePrayerTemplateVersionFn,
  createPrayerTemplateVersionFn,
  getPrayerTemplateFn,
  previewPrayerSessionFn,
  publishPrayerTemplateVersionFn,
  setPrayerTemplateActiveFn,
  submitPrayerTemplateVersionFn,
  updatePrayerTemplateDraftFn,
} from '@/services/prayer-template-actions'
import { LANGUAGE_LABELS, contentTypeLabel } from '@/lib/guidance-labels'
import { Route as AdminRoute } from './admin'

/**
 * Template detail: scope, per-language version lifecycle, ordered
 * slots with selectors/pins/forbidden pairs, duration/priority/weight,
 * definition hash, DRAFT authoring and a staff-only preview that runs
 * the REAL autonomous resolver (never returning sacred bodies).
 */
export const Route = createFileRoute('/admin/prayer-templates/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id')
    return getPrayerTemplateFn({ data: { id } })
  },
  component: PrayerTemplatePage,
})

type Loaded = Awaited<ReturnType<typeof getPrayerTemplateFn>>
type DefinitionRow = Loaded['definitions'][number]

interface SlotForm {
  slotKey: string
  position: string
  slotKind: string
  minSelect: string
  maxSelect: string
  contentType: string
  selectorMode: string
  themeCode: string
  variantKind: string
  silenceDurationSeconds: string
  /** Human-authored camera decision. CONTENT only; SILENCE keeps ''. */
  shotFamily: string
  referenceRequirement: string
  allowedScopes: Array<string>
  pinnedContentVersionIds: string
}

const EMPTY_SLOT: SlotForm = {
  slotKey: '',
  position: '1',
  slotKind: 'CONTENT',
  minSelect: '1',
  maxSelect: '1',
  contentType: 'PRAYER',
  selectorMode: 'ELIGIBLE_FILTER',
  themeCode: '',
  variantKind: '',
  silenceDurationSeconds: '',
  // Deliberately EMPTY, never 'OPTIONAL': the author must choose. A
  // default here would be the platform quietly making a camera and
  // reference decision on leadership's behalf.
  shotFamily: '',
  referenceRequirement: '',
  allowedScopes: ['PLATFORM'],
  pinnedContentVersionIds: '',
}

function PrayerTemplatePage() {
  const data = Route.useLoaderData()
  const { admin } = AdminRoute.useRouteContext()
  const router = useRouter()
  const setActive = useServerFn(setPrayerTemplateActiveFn)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canApprove = admin.permissions.includes('spiritual_content.approve')
  const canPublish = admin.permissions.includes('spiritual_content.publish')
  const template = data.template

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
        to="/admin/prayer-templates"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Templates
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{template.code}</h1>
        <div className="flex items-center gap-3 text-sm">
          {template.active ? (
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
                  setActive({
                    data: { id: template.id, active: !template.active },
                  }),
                )
              }
              className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
            >
              {template.active ? 'Deactivate (future sessions)' : 'Reactivate'}
            </button>
          ) : null}
        </div>
      </div>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
          Scope{' '}
          {data.structureFrozen ? '(frozen — reviewed history exists)' : ''}
        </h2>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex gap-3">
            <dt className="text-ink-soft">Scope</dt>
            <dd>{template.scopeType}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-ink-soft">Sacred House</dt>
            <dd>
              {data.houses.find((h) => h.id === template.sacredHouseId)?.name ??
                '—'}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-ink-soft">Service</dt>
            <dd>
              {data.services.find((s) => s.id === template.serviceId)?.name ??
                '—'}
            </dd>
          </div>
        </dl>
      </section>

      {GUIDANCE_LANGUAGES.map((language) => (
        <TemplateLanguageSection
          key={language}
          language={language}
          templateId={template.id}
          definitions={data.definitions.filter(
            (definition) => definition.version.language === language,
          )}
          canApprove={canApprove}
          canPublish={canPublish}
          busy={busy}
          run={run}
        />
      ))}

      <PreviewSection houses={data.houses} services={data.services} />

      {error ? (
        <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

function SlotTable({ definition }: { definition: DefinitionRow }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[700px] border-separate border-spacing-0 text-xs">
        <thead>
          <tr className="text-left tracking-wider text-ink-soft uppercase">
            <th className="border-b border-line px-2 py-1">#</th>
            <th className="border-b border-line px-2 py-1">Key</th>
            <th className="border-b border-line px-2 py-1">Kind</th>
            <th className="border-b border-line px-2 py-1">Selector</th>
            <th className="border-b border-line px-2 py-1">Type</th>
            <th className="border-b border-line px-2 py-1">Min/Max</th>
            <th className="border-b border-line px-2 py-1">Scopes</th>
            <th className="border-b border-line px-2 py-1">Shot / reference</th>
            <th className="border-b border-line px-2 py-1">Pins / Silence</th>
          </tr>
        </thead>
        <tbody>
          {definition.slots.map((slot) => (
            <tr key={slot.id}>
              <td className="border-b border-line px-2 py-1">
                {slot.position}
              </td>
              <td className="border-b border-line px-2 py-1">{slot.slotKey}</td>
              <td className="border-b border-line px-2 py-1">
                {slot.slotKind}
              </td>
              <td className="border-b border-line px-2 py-1">
                {slot.selectorMode ?? '—'}
              </td>
              <td className="border-b border-line px-2 py-1">
                {slot.contentType ? contentTypeLabel(slot.contentType) : '—'}
                {slot.themeCode ? ` · ${slot.themeCode}` : ''}
                {slot.variantKind ? ` · ${slot.variantKind}` : ''}
              </td>
              <td className="border-b border-line px-2 py-1">
                {slot.minSelect}–{slot.maxSelect}
              </td>
              <td className="border-b border-line px-2 py-1">
                {slot.allowedScopes.join(', ') || '—'}
              </td>
              <td className="border-b border-line px-2 py-1">
                {slot.slotKind === 'SILENCE' ? (
                  '—'
                ) : slot.shotFamily && slot.referenceRequirement ? (
                  <>
                    {slot.shotFamily.replaceAll('_', ' ')}
                    <span className="text-ink-soft">
                      {' · '}
                      {slot.referenceRequirement}
                    </span>
                  </>
                ) : (
                  <span className="text-alert">not authored</span>
                )}
              </td>
              <td className="border-b border-line px-2 py-1">
                {slot.slotKind === 'SILENCE'
                  ? `${slot.silenceDurationSeconds}s silence`
                  : slot.pins.length > 0
                    ? `versions ${slot.pins.map((p) => p.contentVersionId).join(', ')}`
                    : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {definition.forbiddenPairs.length > 0 ? (
        <p className="mt-2 text-xs text-ink-soft">
          Forbidden pairs:{' '}
          {definition.forbiddenPairs
            .map((pair) => `${pair.contentItemIdA}×${pair.contentItemIdB}`)
            .join(', ')}
        </p>
      ) : null}
    </div>
  )
}

function TemplateLanguageSection({
  language,
  templateId,
  definitions,
  canApprove,
  canPublish,
  busy,
  run,
}: {
  language: string
  templateId: number
  definitions: Array<DefinitionRow>
  canApprove: boolean
  canPublish: boolean
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const createVersion = useServerFn(createPrayerTemplateVersionFn)
  const updateDraft = useServerFn(updatePrayerTemplateDraftFn)
  const submit = useServerFn(submitPrayerTemplateVersionFn)
  const publish = useServerFn(publishPrayerTemplateVersionFn)
  const archive = useServerFn(archivePrayerTemplateVersionFn)

  const working = definitions.find((definition) =>
    ['DRAFT', 'UNDER_REVIEW', 'APPROVED'].includes(definition.version.status),
  )
  const [showForm, setShowForm] = useState(false)
  const [editingVersionId, setEditingVersionId] = useState<number | null>(null)
  const [priority, setPriority] = useState('0')
  const [weight, setWeight] = useState('1')
  const [minSeconds, setMinSeconds] = useState('90')
  const [maxSeconds, setMaxSeconds] = useState('120')
  const [slots, setSlots] = useState<Array<SlotForm>>([{ ...EMPTY_SLOT }])
  const [pairs, setPairs] = useState('')

  function loadDraftIntoForm(definition: DefinitionRow) {
    setPriority(String(definition.version.priority))
    setWeight(String(definition.version.selectionWeight))
    setMinSeconds(String(definition.version.targetMinSeconds))
    setMaxSeconds(String(definition.version.targetMaxSeconds))
    setSlots(
      definition.slots.map((slot) => ({
        slotKey: slot.slotKey,
        position: String(slot.position),
        slotKind: slot.slotKind,
        minSelect: String(slot.minSelect),
        maxSelect: String(slot.maxSelect),
        contentType: slot.contentType ?? '',
        selectorMode: slot.selectorMode ?? '',
        themeCode: slot.themeCode ?? '',
        variantKind: slot.variantKind ?? '',
        silenceDurationSeconds:
          slot.silenceDurationSeconds != null
            ? String(slot.silenceDurationSeconds)
            : '',
        allowedScopes: slot.allowedScopes,
        shotFamily: slot.shotFamily ?? '',
        referenceRequirement: slot.referenceRequirement ?? '',
        pinnedContentVersionIds: slot.pins
          .map((pin) => pin.contentVersionId)
          .join(','),
      })),
    )
    setPairs(
      definition.forbiddenPairs
        .map((pair) => `${pair.contentItemIdA}:${pair.contentItemIdB}`)
        .join(','),
    )
    setEditingVersionId(definition.version.id)
    setShowForm(true)
  }

  function slotPayload(slot: SlotForm) {
    const silence = slot.slotKind === 'SILENCE'
    return {
      slotKey: slot.slotKey.trim(),
      position: Number(slot.position) || 0,
      slotKind: slot.slotKind as (typeof SLOT_KINDS)[number],
      minSelect: silence ? 0 : Number(slot.minSelect) || 0,
      maxSelect: silence ? 0 : Number(slot.maxSelect) || 0,
      contentType:
        !silence && slot.selectorMode === 'ELIGIBLE_FILTER' && slot.contentType
          ? (slot.contentType as (typeof SACRED_RUNTIME_CONTENT_TYPES)[number])
          : null,
      selectorMode:
        !silence && slot.selectorMode
          ? (slot.selectorMode as (typeof SLOT_SELECTOR_MODES)[number])
          : null,
      themeCode:
        !silence &&
        slot.selectorMode === 'ELIGIBLE_FILTER' &&
        slot.themeCode.trim()
          ? slot.themeCode.trim()
          : null,
      variantKind:
        !silence && slot.selectorMode === 'ELIGIBLE_FILTER' && slot.variantKind
          ? (slot.variantKind as (typeof VARIANT_KINDS)[number])
          : null,
      // SILENCE carries neither; CONTENT sends exactly what the author
      // chose, and null if they chose nothing — so the service refuses
      // rather than the UI inventing a default.
      shotFamily:
        !silence && slot.shotFamily
          ? (slot.shotFamily as (typeof SLOT_SHOT_FAMILIES)[number])
          : null,
      referenceRequirement:
        !silence && slot.referenceRequirement
          ? (slot.referenceRequirement as (typeof SLOT_REFERENCE_REQUIREMENTS)[number])
          : null,
      silenceDurationSeconds: silence
        ? Number(slot.silenceDurationSeconds) || 0
        : null,
      allowedScopes:
        !silence && slot.selectorMode === 'ELIGIBLE_FILTER'
          ? (slot.allowedScopes as Array<(typeof CONTENT_SCOPE_TYPES)[number]>)
          : [],
      pinnedContentVersionIds:
        !silence && slot.selectorMode === 'PINNED_VERSIONS'
          ? slot.pinnedContentVersionIds
              .split(',')
              .map((value) => Number(value.trim()))
              .filter((value) => Number.isInteger(value) && value > 0)
          : [],
    }
  }

  async function handleSave() {
    const payload = {
      priority: Number(priority) || 0,
      selectionWeight: Number(weight) || 1,
      targetMinSeconds: Number(minSeconds) || 0,
      targetMaxSeconds: Number(maxSeconds) || 0,
      slots: slots.map(slotPayload),
      forbiddenPairs: pairs
        .split(',')
        .map((pair) => pair.trim())
        .filter(Boolean)
        .map((pair) => {
          const [a, b] = pair.split(':').map((value) => Number(value.trim()))
          return { contentItemIdA: a || 0, contentItemIdB: b || 0 }
        }),
    }
    await run(async () => {
      if (editingVersionId != null) {
        await updateDraft({
          data: { versionId: editingVersionId, version: payload },
        })
      } else {
        await createVersion({
          data: {
            templateId,
            version: { ...payload, language: language as 'en' | 'yo' },
          },
        })
      }
      setShowForm(false)
      setEditingVersionId(null)
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
            onClick={() => {
              setEditingVersionId(null)
              setSlots([{ ...EMPTY_SLOT }])
              setPairs('')
              setShowForm(true)
            }}
            className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:border-gold-deep"
          >
            New draft
          </button>
        ) : null}
      </div>

      {definitions.length === 0 && !showForm ? (
        <p className="mt-4 text-sm text-ink-soft">
          No {LANGUAGE_LABELS[language] ?? language} versions yet.
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {definitions.map((definition) => {
          const version = definition.version
          return (
            <li
              key={version.id}
              className="rounded-md border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  v{version.versionNumber} · priority {version.priority} ·
                  weight {version.selectionWeight} · {version.targetMinSeconds}–
                  {version.targetMaxSeconds}s
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
              {version.definitionSha256 ? (
                <p className="mt-1 text-xs break-all text-ink-soft">
                  Definition SHA-256: {version.definitionSha256}
                </p>
              ) : null}
              {version.reviewNote && version.status === 'DRAFT' ? (
                <p className="mt-2 rounded-md border border-gold bg-gold/10 px-3 py-2 text-xs text-gold-deep">
                  Returned with reason: {version.reviewNote}
                </p>
              ) : null}
              <SlotTable definition={definition} />
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {version.status === 'DRAFT' ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => loadDraftIntoForm(definition)}
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
                {version.status === 'UNDER_REVIEW' && canApprove ? (
                  <Link
                    to="/admin/prayer-templates/review"
                    className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep"
                  >
                    Open in review queue
                  </Link>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>

      {showForm ? (
        <div className="mt-4 space-y-4 rounded-md border border-dashed border-line-strong p-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <NumField
              label="Priority"
              value={priority}
              onChange={setPriority}
            />
            <NumField
              label="Selection weight (1–100)"
              value={weight}
              onChange={setWeight}
            />
            <NumField
              label="Target min seconds"
              value={minSeconds}
              onChange={setMinSeconds}
            />
            <NumField
              label="Target max seconds"
              value={maxSeconds}
              onChange={setMaxSeconds}
            />
          </div>

          {slots.map((slot, index) => (
            <div key={index} className="rounded-md border border-line p-3">
              <div className="grid gap-3 sm:grid-cols-4">
                <label className="block text-xs text-ink-soft">
                  Slot key
                  <input
                    value={slot.slotKey}
                    onChange={(event) =>
                      updateSlot(index, {
                        slotKey: event.target.value.toUpperCase().slice(0, 60),
                      })
                    }
                    className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                  />
                </label>
                <NumField
                  small
                  label="Position"
                  value={slot.position}
                  onChange={(value) => updateSlot(index, { position: value })}
                />
                <label className="block text-xs text-ink-soft">
                  Kind
                  <select
                    value={slot.slotKind}
                    onChange={(event) =>
                      updateSlot(index, { slotKind: event.target.value })
                    }
                    className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                  >
                    {SLOT_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                </label>
                {/* Camera authority: CONTENT only, and never defaulted.
                    A SILENCE segment holds the previous visual and can
                    never generate, so it shows neither control. */}
                {slot.slotKind === 'CONTENT' ? (
                  <>
                    <label className="block text-xs text-ink-soft">
                      Shot family
                      <select
                        value={slot.shotFamily}
                        onChange={(event) =>
                          updateSlot(index, { shotFamily: event.target.value })
                        }
                        className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                      >
                        <option value="">Choose…</option>
                        {SLOT_SHOT_FAMILIES.map((family) => (
                          <option key={family} value={family}>
                            {family.replaceAll('_', ' ')}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block text-xs text-ink-soft">
                      Reference
                      <select
                        value={slot.referenceRequirement}
                        onChange={(event) =>
                          updateSlot(index, {
                            referenceRequirement: event.target.value,
                          })
                        }
                        className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                      >
                        <option value="">Choose…</option>
                        {SLOT_REFERENCE_REQUIREMENTS.map((requirement) => (
                          <option key={requirement} value={requirement}>
                            {requirement}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                ) : null}
                {slot.slotKind === 'SILENCE' ? (
                  <NumField
                    small
                    label="Silence seconds"
                    value={slot.silenceDurationSeconds}
                    onChange={(value) =>
                      updateSlot(index, { silenceDurationSeconds: value })
                    }
                  />
                ) : (
                  <label className="block text-xs text-ink-soft">
                    Selector
                    <select
                      value={slot.selectorMode}
                      onChange={(event) =>
                        updateSlot(index, { selectorMode: event.target.value })
                      }
                      className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                    >
                      {SLOT_SELECTOR_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {mode}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              {slot.slotKind === 'CONTENT' ? (
                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <NumField
                    small
                    label="Min select"
                    value={slot.minSelect}
                    onChange={(value) =>
                      updateSlot(index, { minSelect: value })
                    }
                  />
                  <NumField
                    small
                    label="Max select"
                    value={slot.maxSelect}
                    onChange={(value) =>
                      updateSlot(index, { maxSelect: value })
                    }
                  />
                  {slot.selectorMode === 'ELIGIBLE_FILTER' ? (
                    <>
                      <label className="block text-xs text-ink-soft">
                        Sacred type
                        <select
                          value={slot.contentType}
                          onChange={(event) =>
                            updateSlot(index, {
                              contentType: event.target.value,
                            })
                          }
                          className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                        >
                          {SACRED_RUNTIME_CONTENT_TYPES.map((type) => (
                            <option key={type} value={type}>
                              {contentTypeLabel(type)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block text-xs text-ink-soft">
                        Theme (optional)
                        <input
                          value={slot.themeCode}
                          onChange={(event) =>
                            updateSlot(index, {
                              themeCode: event.target.value
                                .toUpperCase()
                                .slice(0, 60),
                            })
                          }
                          className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                        />
                      </label>
                      <label className="block text-xs text-ink-soft sm:col-span-2">
                        Allowed scopes
                        <span className="mt-1 flex gap-3">
                          {CONTENT_SCOPE_TYPES.map((scope) => (
                            <label
                              key={scope}
                              className="flex items-center gap-1 text-xs text-ink-soft"
                            >
                              <input
                                type="checkbox"
                                checked={slot.allowedScopes.includes(scope)}
                                onChange={(event) =>
                                  updateSlot(index, {
                                    allowedScopes: event.target.checked
                                      ? [...slot.allowedScopes, scope]
                                      : slot.allowedScopes.filter(
                                          (value) => value !== scope,
                                        ),
                                  })
                                }
                              />
                              {scope}
                            </label>
                          ))}
                        </span>
                      </label>
                      <label className="block text-xs text-ink-soft sm:col-span-2">
                        Variant kind (optional)
                        <select
                          value={slot.variantKind}
                          onChange={(event) =>
                            updateSlot(index, {
                              variantKind: event.target.value,
                            })
                          }
                          className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                        >
                          <option value="">Any</option>
                          {VARIANT_KINDS.map((kind) => (
                            <option key={kind} value={kind}>
                              {kind}
                            </option>
                          ))}
                        </select>
                      </label>
                    </>
                  ) : (
                    <label className="block text-xs text-ink-soft sm:col-span-2">
                      Pinned content version ids (comma-separated)
                      <input
                        value={slot.pinnedContentVersionIds}
                        onChange={(event) =>
                          updateSlot(index, {
                            pinnedContentVersionIds: event.target.value,
                          })
                        }
                        className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
                      />
                    </label>
                  )}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() =>
                  setSlots((current) =>
                    current.filter((_, slotIndex) => slotIndex !== index),
                  )
                }
                className="mt-2 rounded-md border border-line-strong px-2 py-1 text-xs text-ink-soft hover:border-alert hover:text-alert"
              >
                Remove slot
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              setSlots((current) => [
                ...current,
                { ...EMPTY_SLOT, position: String(current.length + 1) },
              ])
            }
            className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-ink-soft hover:border-gold-deep"
          >
            Add slot
          </button>

          <label className="block text-sm text-ink-soft">
            Forbidden content-item pairs (itemA:itemB, comma-separated)
            <input
              value={pairs}
              onChange={(event) => setPairs(event.target.value)}
              className="mt-2 w-full rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
            />
          </label>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
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
    </section>
  )

  function updateSlot(index: number, patch: Partial<SlotForm>) {
    setSlots((current) =>
      current.map((slot, slotIndex) =>
        slotIndex === index ? { ...slot, ...patch } : slot,
      ),
    )
  }
}

function PreviewSection({
  houses,
  services,
}: {
  houses: Loaded['houses']
  services: Loaded['services']
}) {
  const preview = useServerFn(previewPrayerSessionFn)
  const [serviceId, setServiceId] = useState('')
  const [houseId, setHouseId] = useState('')
  const [language, setLanguage] = useState('en')
  const [seed, setSeed] = useState('preview-1')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof previewPrayerSessionFn>
  > | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function runPreview() {
    setBusy(true)
    setError(null)
    try {
      const resolved = await preview({
        data: {
          serviceId: serviceId ? Number(serviceId) : undefined,
          sacredHouseId: houseId ? Number(houseId) : undefined,
          language: language as 'en' | 'yo',
          variationSeed: seed,
        },
      })
      setResult(resolved)
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : 'Preview failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
      <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
        Resolver preview (staff only — real autonomous resolver)
      </h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <label className="block text-xs text-ink-soft">
          Service
          <select
            value={serviceId}
            onChange={(event) => setServiceId(event.target.value)}
            className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
          >
            <option value="">None</option>
            {services.map((service) => (
              <option key={service.id} value={String(service.id)}>
                {service.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-ink-soft">
          Sacred House
          <select
            value={houseId}
            onChange={(event) => setHouseId(event.target.value)}
            className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
          >
            <option value="">None</option>
            {houses.map((house) => (
              <option key={house.id} value={String(house.id)}>
                {house.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-ink-soft">
          Language
          <select
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
          >
            <option value="en">English</option>
            <option value="yo">Yorùbá</option>
          </select>
        </label>
        <label className="block text-xs text-ink-soft">
          Variation seed
          <input
            value={seed}
            onChange={(event) => setSeed(event.target.value.slice(0, 120))}
            className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
          />
        </label>
      </div>
      <button
        type="button"
        disabled={busy || !seed.trim()}
        onClick={() => void runPreview()}
        className="mt-3 rounded-md border border-line-strong px-4 py-2 text-sm text-ink-soft hover:border-gold-deep disabled:opacity-60"
      >
        Run preview
      </button>
      {error ? (
        <p className="mt-3 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-alert">
          {error}
        </p>
      ) : null}
      {result ? (
        result.status === 'RESOLVED' ? (
          <div className="mt-4 rounded-md border border-line bg-surface p-4 text-sm">
            <p>
              Resolved template{' '}
              <span className="font-medium text-gold-deep">
                {result.templateCode}
              </span>{' '}
              v{result.templateVersionNumber} ({result.templateScopeType}) ·
              est. {result.estimatedSeconds}s of {result.targetMinSeconds}–
              {result.targetMaxSeconds}s
            </p>
            <p className="mt-1 text-xs break-all text-ink-soft">
              Definition SHA-256: {result.definitionSha256}
            </p>
            <ul className="mt-3 space-y-1 text-xs text-ink-soft">
              {result.slots.map((slot) => (
                <li key={slot.slotKey}>
                  {slot.position}. {slot.slotKey} —{' '}
                  {slot.slotKind === 'SILENCE'
                    ? `${slot.silenceDurationSeconds}s silence`
                    : slot.selections
                        .map(
                          (selection) =>
                            `${selection.code} (v${selection.versionNumber}, ${selection.scopeType})`,
                        )
                        .join(', ') || 'no selections'}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-4 rounded-md border border-gold bg-gold/10 px-3 py-2 text-sm text-gold-deep">
            NO_VALID_TEMPLATE — {result.consideredTemplates} applicable
            template(s) considered; none could resolve with currently eligible
            content.
          </p>
        )
      ) : null}
    </section>
  )
}

function NumField({
  label,
  value,
  onChange,
  small = false,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  small?: boolean
}) {
  return (
    <label className={`block ${small ? 'text-xs' : 'text-sm'} text-ink-soft`}>
      {label}
      <input
        value={value}
        inputMode="numeric"
        onChange={(event) =>
          onChange(event.target.value.replace(/[^0-9-]/g, '').slice(0, 6))
        }
        className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
      />
    </label>
  )
}
