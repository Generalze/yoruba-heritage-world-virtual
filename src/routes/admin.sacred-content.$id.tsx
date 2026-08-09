import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  ACCESS_POLICIES,
  EXTERNAL_AI_POLICIES,
  GUIDANCE_LANGUAGES,
  PROVENANCE_TYPES,
  VARIANT_KINDS,
  VOICE_POLICIES,
} from '@/db/schema'
import {
  archiveSacredVersionFn,
  createSacredVersionFn,
  getSacredContentItemFn,
  publishSacredVersionFn,
  setSacredContentActiveFn,
  setSacredRightsStatusFn,
  setSacredRuntimeEnabledFn,
  submitSacredVersionFn,
  updateSacredDraftFn,
  updateSacredProfileFn,
} from '@/services/sacred-content-actions'
import {
  LANGUAGE_LABELS,
  RIGHTS_STATUS_LABELS,
  contentTypeLabel,
} from '@/lib/guidance-labels'
import { Route as AdminRoute } from './admin'
import type { RightsStatus } from '@/db/schema'

/**
 * Sacred item detail. Three DELIBERATELY separate indicators per
 * version: Cultural Status (workflow), Rights Status (independent
 * gate) and Runtime (computed eligibility) — never one merged badge.
 * All sacred text renders as escaped plain text.
 */
export const Route = createFileRoute('/admin/sacred-content/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid item id')
    return getSacredContentItemFn({ data: { id } })
  },
  component: SacredItemPage,
})

type Loaded = Awaited<ReturnType<typeof getSacredContentItemFn>>
type VersionRow = Loaded['versions'][number]
type ProfileRow = Loaded['profiles'][number]

const RIGHTS_NEXT: Record<string, Array<RightsStatus>> = {
  UNREVIEWED: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['CLEARED', 'RESTRICTED'],
  CLEARED: ['RESTRICTED', 'WITHDRAWN'],
  RESTRICTED: ['PENDING_REVIEW'],
  WITHDRAWN: ['PENDING_REVIEW'],
}

function SacredItemPage() {
  const data = Route.useLoaderData()
  const { admin } = AdminRoute.useRouteContext()
  const router = useRouter()
  const setActive = useServerFn(setSacredContentActiveFn)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const canApprove = admin.permissions.includes('spiritual_content.approve')
  const canPublish = admin.permissions.includes('spiritual_content.publish')
  const canRights = admin.permissions.includes('sacred_content.rights_manage')
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
        to="/admin/sacred-content"
        className="text-sm text-stone-400 hover:text-amber-500"
      >
        ← Sacred library
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{item.code}</h1>
        <div className="flex items-center gap-3 text-sm">
          {item.active ? (
            <span className="rounded-full bg-emerald-950 px-3 py-1 text-emerald-400">
              active
            </span>
          ) : (
            <span className="rounded-full bg-stone-800 px-3 py-1 text-stone-400">
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
              className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-300 hover:border-amber-500 disabled:opacity-60"
            >
              {item.active ? 'Deactivate (future runtime)' : 'Reactivate'}
            </button>
          ) : null}
        </div>
      </div>

      <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
        <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
          Structure{' '}
          {data.structureFrozen ? '(frozen — reviewed history exists)' : ''}
        </h2>
        <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          <div className="flex gap-3">
            <dt className="text-stone-400">Type</dt>
            <dd>{contentTypeLabel(item.contentType)}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-stone-400">Scope</dt>
            <dd>{item.scopeType}</dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-stone-400">Sacred House</dt>
            <dd>
              {data.houses.find((h) => h.id === item.sacredHouseId)?.name ??
                '—'}
            </dd>
          </div>
          <div className="flex gap-3">
            <dt className="text-stone-400">Service</dt>
            <dd>
              {data.services.find((s) => s.id === item.serviceId)?.name ?? '—'}
            </dd>
          </div>
        </dl>
      </section>

      {GUIDANCE_LANGUAGES.map((language) => (
        <SacredLanguageSection
          key={language}
          language={language}
          itemId={item.id}
          versions={data.versions.filter((v) => v.language === language)}
          profiles={data.profiles}
          eligibility={data.eligibility}
          canApprove={canApprove}
          canPublish={canPublish}
          canRights={canRights}
          busy={busy}
          run={run}
        />
      ))}

      {error ? (
        <p className="mt-4 rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      ) : null}
    </div>
  )
}

const EMPTY_PROFILE = {
  variantKind: 'ORIGINAL',
  provenanceType: 'ORIGINAL_AUTHORED',
  sourceCommunity: '',
  sourcePlace: '',
  sourceReference: '',
  publicAttributionText: '',
  internalProvenanceNote: '',
  digitalStorageAuthorized: false,
  themeCode: '',
  durationHintSeconds: '',
  repeatable: false,
  voicePolicy: 'HUMAN_RECORDED_REQUIRED',
  externalAiPolicy: 'METADATA_ONLY',
  accessPolicy: 'STAFF_ONLY',
}

function SacredLanguageSection({
  language,
  itemId,
  versions,
  profiles,
  eligibility,
  canApprove,
  canPublish,
  canRights,
  busy,
  run,
}: {
  language: string
  itemId: number
  versions: Array<VersionRow>
  profiles: Array<ProfileRow>
  eligibility: Loaded['eligibility']
  canApprove: boolean
  canPublish: boolean
  canRights: boolean
  busy: boolean
  run: (action: () => Promise<unknown>) => Promise<void>
}) {
  const createVersion = useServerFn(createSacredVersionFn)
  const updateDraft = useServerFn(updateSacredDraftFn)
  const updateProfile = useServerFn(updateSacredProfileFn)
  const submit = useServerFn(submitSacredVersionFn)
  const publish = useServerFn(publishSacredVersionFn)
  const archive = useServerFn(archiveSacredVersionFn)
  const setRights = useServerFn(setSacredRightsStatusFn)
  const setRuntime = useServerFn(setSacredRuntimeEnabledFn)

  const working = versions.find((v) =>
    ['DRAFT', 'UNDER_REVIEW', 'APPROVED'].includes(v.status),
  )
  const [showForm, setShowForm] = useState(false)
  const [editingVersionId, setEditingVersionId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [profileForm, setProfileForm] = useState({ ...EMPTY_PROFILE })
  const [rightsNoteFor, setRightsNoteFor] = useState<{
    versionId: number
    status: RightsStatus
  } | null>(null)
  const [rightsNote, setRightsNote] = useState('')

  function loadDraftIntoForm(draft: VersionRow) {
    const profile = profiles.find((p) => p.contentVersionId === draft.id)
    setTitle(draft.title)
    setBody(draft.body)
    setProfileForm({
      variantKind: profile?.variantKind ?? 'ORIGINAL',
      provenanceType: profile?.provenanceType ?? 'ORIGINAL_AUTHORED',
      sourceCommunity: profile?.sourceCommunity ?? '',
      sourcePlace: profile?.sourcePlace ?? '',
      sourceReference: profile?.sourceReference ?? '',
      publicAttributionText: profile?.publicAttributionText ?? '',
      internalProvenanceNote: profile?.internalProvenanceNote ?? '',
      digitalStorageAuthorized: profile?.digitalStorageAuthorized ?? false,
      themeCode: profile?.themeCode ?? '',
      durationHintSeconds: profile?.durationHintSeconds
        ? String(profile.durationHintSeconds)
        : '',
      repeatable: profile?.repeatable ?? false,
      voicePolicy: profile?.voicePolicy ?? 'HUMAN_RECORDED_REQUIRED',
      externalAiPolicy: profile?.externalAiPolicy ?? 'METADATA_ONLY',
      accessPolicy: profile?.accessPolicy ?? 'STAFF_ONLY',
    })
    setEditingVersionId(draft.id)
    setShowForm(true)
  }

  function profilePayload() {
    return {
      variantKind: profileForm.variantKind as never,
      provenanceType: profileForm.provenanceType as never,
      sourceCommunity: profileForm.sourceCommunity.trim() || null,
      sourcePlace: profileForm.sourcePlace.trim() || null,
      sourceReference: profileForm.sourceReference.trim() || null,
      publicAttributionText: profileForm.publicAttributionText.trim() || null,
      internalProvenanceNote: profileForm.internalProvenanceNote.trim() || null,
      digitalStorageAuthorized: profileForm.digitalStorageAuthorized,
      themeCode: profileForm.themeCode.trim() || null,
      durationHintSeconds: profileForm.durationHintSeconds
        ? Number(profileForm.durationHintSeconds)
        : null,
      repeatable: profileForm.repeatable,
      voicePolicy: profileForm.voicePolicy as never,
      externalAiPolicy: profileForm.externalAiPolicy as never,
      accessPolicy: profileForm.accessPolicy as never,
    }
  }

  async function handleSave() {
    await run(async () => {
      if (editingVersionId != null) {
        await updateDraft({
          data: { versionId: editingVersionId, version: { title, body } },
        })
        await updateProfile({
          data: { versionId: editingVersionId, profile: profilePayload() },
        })
      } else {
        await createVersion({
          data: {
            itemId,
            version: { language: language as 'en' | 'yo', title, body },
            profile: profilePayload(),
          },
        })
      }
      setShowForm(false)
      setEditingVersionId(null)
    })
  }

  return (
    <section className="mt-6 rounded-lg border border-stone-800 bg-stone-900 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium tracking-widest text-amber-500 uppercase">
          {LANGUAGE_LABELS[language] ?? language} versions
        </h2>
        {!working && !showForm ? (
          <button
            type="button"
            onClick={() => {
              setEditingVersionId(null)
              setTitle('')
              setBody('')
              setProfileForm({ ...EMPTY_PROFILE })
              setShowForm(true)
            }}
            className="rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-300 hover:border-amber-500"
          >
            New draft
          </button>
        ) : null}
      </div>

      {versions.length === 0 && !showForm ? (
        <p className="mt-4 text-sm text-stone-500">
          No {LANGUAGE_LABELS[language] ?? language} versions yet. Sacred text
          is written by authorized people only — never generated, never
          translated automatically.
        </p>
      ) : null}

      <ul className="mt-4 space-y-3">
        {versions.map((version) => {
          const profile = profiles.find(
            (p) => p.contentVersionId === version.id,
          )
          const check = eligibility.find((e) => e.versionId === version.id)
          return (
            <li
              key={version.id}
              className="rounded-md border border-stone-800 bg-stone-950 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  v{version.versionNumber} — {version.title}
                </span>
                <span className="flex flex-wrap gap-2 text-xs">
                  <span
                    className={`rounded-full px-2.5 py-0.5 ${
                      version.status === 'PUBLISHED'
                        ? 'bg-emerald-950 text-emerald-400'
                        : version.status === 'ARCHIVED'
                          ? 'bg-stone-800 text-stone-500'
                          : 'bg-amber-950 text-amber-400'
                    }`}
                  >
                    Cultural: {version.status.replaceAll('_', ' ')}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 ${
                      profile?.rightsStatus === 'CLEARED'
                        ? 'bg-emerald-950 text-emerald-400'
                        : profile?.rightsStatus === 'RESTRICTED' ||
                            profile?.rightsStatus === 'WITHDRAWN'
                          ? 'bg-red-950 text-red-400'
                          : 'bg-stone-800 text-stone-400'
                    }`}
                  >
                    Rights:{' '}
                    {profile
                      ? (RIGHTS_STATUS_LABELS[profile.rightsStatus] ??
                        profile.rightsStatus)
                      : '—'}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 ${
                      check?.eligible
                        ? 'bg-emerald-950 text-emerald-400'
                        : 'bg-stone-800 text-stone-400'
                    }`}
                  >
                    Runtime: {check?.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}
                  </span>
                </span>
              </div>

              {profile ? (
                <dl className="mt-3 grid gap-1 text-xs text-stone-400 sm:grid-cols-2">
                  <div>Variant: {profile.variantKind}</div>
                  <div>Provenance: {profile.provenanceType}</div>
                  <div>
                    Storage authorized:{' '}
                    {profile.digitalStorageAuthorized ? 'yes' : 'NO'}
                  </div>
                  <div>Access: {profile.accessPolicy}</div>
                  <div>Voice: {profile.voicePolicy}</div>
                  <div>External AI: {profile.externalAiPolicy}</div>
                  <div>Theme: {profile.themeCode ?? '—'}</div>
                  <div>
                    Duration hint:{' '}
                    {profile.durationHintSeconds
                      ? `${profile.durationHintSeconds}s`
                      : '—'}
                  </div>
                  <div>Repeatable: {profile.repeatable ? 'yes' : 'no'}</div>
                  <div>Attribution: {profile.publicAttributionText ?? '—'}</div>
                  {profile.contentSha256 ? (
                    <div className="sm:col-span-2 break-all">
                      SHA-256: {profile.contentSha256}
                    </div>
                  ) : null}
                  {profile.internalProvenanceNote ? (
                    <div className="sm:col-span-2">
                      Internal note (staff only):{' '}
                      {profile.internalProvenanceNote}
                    </div>
                  ) : null}
                  {profile.rightsNote ? (
                    <div className="sm:col-span-2">
                      Rights note (staff only): {profile.rightsNote}
                    </div>
                  ) : null}
                </dl>
              ) : null}

              {check && !check.eligible && version.status === 'PUBLISHED' ? (
                <p className="mt-2 text-xs text-stone-500">
                  Blocked by: {check.failures.join(', ')}
                </p>
              ) : null}

              {version.reviewNote && version.status === 'DRAFT' ? (
                <p className="mt-2 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
                  Returned with reason: {version.reviewNote}
                </p>
              ) : null}
              {version.status !== 'DRAFT' ? (
                <pre className="mt-3 max-h-48 overflow-y-auto rounded-md bg-stone-900 p-3 text-xs whitespace-pre-wrap text-stone-300">
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
                      className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-300 hover:border-amber-500 disabled:opacity-60"
                    >
                      Edit draft & profile
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
                {version.status === 'UNDER_REVIEW' && canApprove ? (
                  <Link
                    to="/admin/sacred-content/review"
                    className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-300 hover:border-amber-500"
                  >
                    Open in review queue
                  </Link>
                ) : null}
                {canRights && profile
                  ? (RIGHTS_NEXT[profile.rightsStatus] ?? []).map((next) => (
                      <button
                        key={next}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (next === 'RESTRICTED' || next === 'WITHDRAWN') {
                            setRightsNoteFor({
                              versionId: version.id,
                              status: next,
                            })
                            setRightsNote('')
                          } else {
                            void run(() =>
                              setRights({
                                data: { versionId: version.id, status: next },
                              }),
                            )
                          }
                        }}
                        className="rounded-md border border-stone-700 px-3 py-1.5 text-stone-300 hover:border-amber-500 disabled:opacity-60"
                      >
                        Rights → {RIGHTS_STATUS_LABELS[next] ?? next}
                      </button>
                    ))
                  : null}
                {canPublish && profile && version.status === 'PUBLISHED' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        setRuntime({
                          data: {
                            versionId: version.id,
                            enabled: !profile.runtimeEnabled,
                          },
                        }),
                      )
                    }
                    className={`rounded-md px-3 py-1.5 font-medium disabled:opacity-60 ${
                      profile.runtimeEnabled
                        ? 'border border-red-800 text-red-400 hover:bg-red-950'
                        : 'bg-emerald-700 text-white hover:bg-emerald-600'
                    }`}
                  >
                    {profile.runtimeEnabled
                      ? 'Disable runtime'
                      : 'Enable runtime'}
                  </button>
                ) : null}
              </div>

              {rightsNoteFor?.versionId === version.id ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={rightsNote}
                    onChange={(event) =>
                      setRightsNote(event.target.value.slice(0, 1000))
                    }
                    placeholder={`Reason for ${rightsNoteFor.status} (required)`}
                    className="w-full max-w-md rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
                  />
                  <button
                    type="button"
                    disabled={busy || !rightsNote.trim()}
                    onClick={() =>
                      void run(async () => {
                        await setRights({
                          data: {
                            versionId: version.id,
                            status: rightsNoteFor.status,
                            note: rightsNote,
                          },
                        })
                        setRightsNoteFor(null)
                      })
                    }
                    className="rounded-md border border-amber-700 px-3 py-2 text-sm text-amber-400 hover:bg-amber-950 disabled:opacity-60"
                  >
                    Confirm
                  </button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      {showForm ? (
        <div className="mt-4 space-y-3 rounded-md border border-dashed border-stone-700 p-4">
          <label className="block text-sm text-stone-400">
            Title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value.slice(0, 200))}
              className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
            />
          </label>
          <label className="block text-sm text-stone-400">
            Sacred text (human-authored plain text; diacritics and line breaks
            are preserved exactly)
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value.slice(0, 20_000))}
              rows={10}
              className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="Variant kind"
              value={profileForm.variantKind}
              options={VARIANT_KINDS}
              onChange={(v) =>
                setProfileForm((f) => ({ ...f, variantKind: v }))
              }
            />
            <SelectField
              label="Provenance"
              value={profileForm.provenanceType}
              options={PROVENANCE_TYPES}
              onChange={(v) =>
                setProfileForm((f) => ({ ...f, provenanceType: v }))
              }
            />
            <SelectField
              label="Voice policy"
              value={profileForm.voicePolicy}
              options={VOICE_POLICIES}
              onChange={(v) =>
                setProfileForm((f) => ({ ...f, voicePolicy: v }))
              }
            />
            <SelectField
              label="External AI policy (future boundary — nothing calls AI now)"
              value={profileForm.externalAiPolicy}
              options={EXTERNAL_AI_POLICIES}
              onChange={(v) =>
                setProfileForm((f) => ({ ...f, externalAiPolicy: v }))
              }
            />
            <SelectField
              label="Access policy"
              value={profileForm.accessPolicy}
              options={ACCESS_POLICIES}
              onChange={(v) =>
                setProfileForm((f) => ({ ...f, accessPolicy: v }))
              }
            />
            <TextField
              label="Theme code (optional, UPPER_SNAKE_CASE)"
              value={profileForm.themeCode}
              onChange={(v) =>
                setProfileForm((f) => ({
                  ...f,
                  themeCode: v.toUpperCase().slice(0, 60),
                }))
              }
            />
            <TextField
              label="Duration hint seconds (optional, 1–600)"
              value={profileForm.durationHintSeconds}
              onChange={(v) =>
                setProfileForm((f) => ({
                  ...f,
                  durationHintSeconds: v.replace(/[^0-9]/g, '').slice(0, 3),
                }))
              }
            />
            <TextField
              label="Source community (optional)"
              value={profileForm.sourceCommunity}
              onChange={(v) =>
                setProfileForm((f) => ({
                  ...f,
                  sourceCommunity: v.slice(0, 255),
                }))
              }
            />
            <TextField
              label="Source place (optional)"
              value={profileForm.sourcePlace}
              onChange={(v) =>
                setProfileForm((f) => ({ ...f, sourcePlace: v.slice(0, 255) }))
              }
            />
            <TextField
              label="Source reference (optional)"
              value={profileForm.sourceReference}
              onChange={(v) =>
                setProfileForm((f) => ({
                  ...f,
                  sourceReference: v.slice(0, 1000),
                }))
              }
            />
            <TextField
              label="Public attribution text (optional)"
              value={profileForm.publicAttributionText}
              onChange={(v) =>
                setProfileForm((f) => ({
                  ...f,
                  publicAttributionText: v.slice(0, 500),
                }))
              }
            />
          </div>
          <label className="block text-sm text-stone-400">
            Internal provenance note (staff only, never public)
            <textarea
              value={profileForm.internalProvenanceNote}
              onChange={(event) =>
                setProfileForm((f) => ({
                  ...f,
                  internalProvenanceNote: event.target.value.slice(0, 2000),
                }))
              }
              rows={3}
              className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-stone-400">
            <input
              type="checkbox"
              checked={profileForm.repeatable}
              onChange={(event) =>
                setProfileForm((f) => ({
                  ...f,
                  repeatable: event.target.checked,
                }))
              }
            />
            Repeatable — leadership permits reuse for the same participant
          </label>
          <label className="flex items-start gap-2 text-sm text-stone-300">
            <input
              type="checkbox"
              checked={profileForm.digitalStorageAuthorized}
              onChange={(event) =>
                setProfileForm((f) => ({
                  ...f,
                  digitalStorageAuthorized: event.target.checked,
                }))
              }
              className="mt-1"
            />
            <span>
              I confirm this sacred material is authorized by the responsible
              leadership to be stored digitally on this platform. Review cannot
              begin without this confirmation.
            </span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
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
    </section>
  )
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: ReadonlyArray<string>
  onChange: (value: string) => void
}) {
  return (
    <label className="block text-sm text-stone-400">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option.replaceAll('_', ' ')}
          </option>
        ))}
      </select>
    </label>
  )
}

function TextField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="block text-sm text-stone-400">
      {label}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-2 w-full rounded-md border border-stone-700 bg-stone-950 px-3 py-2 text-sm text-stone-100"
      />
    </label>
  )
}
