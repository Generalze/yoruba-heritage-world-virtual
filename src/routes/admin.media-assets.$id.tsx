import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  MEDIA_EXTERNAL_AI_POLICIES,
  MEDIA_SOURCE_TYPES,
  SACRED_MEDIA_LINK_ROLES,
} from '@/db/schema'
import {
  approveMediaVersionFn,
  archiveMediaVersionFn,
  createSacredMediaLinkFn,
  getMediaAssetFn,
  publishMediaVersionFn,
  removeSacredMediaLinkFn,
  returnMediaVersionFn,
  setMediaAssetActiveFn,
  setMediaConsentStatusFn,
  setMediaRightsStatusFn,
  setMediaRuntimeEnabledFn,
  submitMediaVersionFn,
  updateMediaDraftFn,
  uploadMediaVersionFn,
} from '@/services/media-asset-actions'
import { RIGHTS_STATUS_LABELS } from '@/lib/guidance-labels'
import { Route as AdminRoute } from './admin'
import type { RightsStatus } from '@/db/schema'

/**
 * Media asset detail: versions, upload, metadata, and the three
 * SEPARATE gates (editorial status, rights, consent) plus computed
 * runtime eligibility. Media bytes are never rendered or downloadable
 * from this page — governance metadata only.
 */
export const Route = createFileRoute('/admin/media-assets/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id)
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id')
    return getMediaAssetFn({ data: { id } })
  },
  component: MediaAssetPage,
})

type Loaded = Awaited<ReturnType<typeof getMediaAssetFn>>
type VersionRow = Loaded['versions'][number]

const RIGHTS_NEXT: Record<string, Array<RightsStatus>> = {
  UNREVIEWED: ['PENDING_REVIEW'],
  PENDING_REVIEW: ['CLEARED', 'RESTRICTED'],
  CLEARED: ['RESTRICTED', 'WITHDRAWN'],
  RESTRICTED: ['PENDING_REVIEW'],
  WITHDRAWN: ['PENDING_REVIEW'],
}

const CONSENT_NEXT: Record<string, Array<string>> = {
  NOT_APPLICABLE: ['PENDING'],
  PENDING: ['GRANTED', 'WITHDRAWN'],
  GRANTED: ['WITHDRAWN'],
  WITHDRAWN: ['PENDING'],
}

function MediaAssetPage() {
  const data = Route.useLoaderData()
  const { admin } = AdminRoute.useRouteContext()
  const router = useRouter()
  const setActive = useServerFn(setMediaAssetActiveFn)
  const upload = useServerFn(uploadMediaVersionFn)
  const updateDraft = useServerFn(updateMediaDraftFn)
  const submit = useServerFn(submitMediaVersionFn)
  const approve = useServerFn(approveMediaVersionFn)
  const returnVersion = useServerFn(returnMediaVersionFn)
  const publish = useServerFn(publishMediaVersionFn)
  const archive = useServerFn(archiveMediaVersionFn)
  const setRights = useServerFn(setMediaRightsStatusFn)
  const setConsent = useServerFn(setMediaConsentStatusFn)
  const setRuntime = useServerFn(setMediaRuntimeEnabledFn)
  const createLink = useServerFn(createSacredMediaLinkFn)
  const removeLink = useServerFn(removeSacredMediaLinkFn)

  const canApprove = admin.permissions.includes('media.approve')
  const canPublish = admin.permissions.includes('media.publish')
  const canRights = admin.permissions.includes('media.rights_manage')
  const asset = data.asset

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showUpload, setShowUpload] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [sourceType, setSourceType] = useState('HUMAN_RECORDED')
  const [language, setLanguage] = useState('')
  const [identifiable, setIdentifiable] = useState(false)
  const [aiPolicy, setAiPolicy] = useState('NO_EXTERNAL_AI')
  const [noteFor, setNoteFor] = useState<{
    versionId: number
    kind: 'rights' | 'consent' | 'return'
    status?: string
  } | null>(null)
  const [noteText, setNoteText] = useState('')
  const [linkContentVersionId, setLinkContentVersionId] = useState('')
  const [linkVersionId, setLinkVersionId] = useState('')
  const [linkRole, setLinkRole] = useState('PRIMARY_AUDIO')

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      setNoteFor(null)
      setNoteText('')
      await router.invalidate()
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : 'Action failed.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function handleUpload() {
    if (!file) return
    const buffer = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    const CHUNK = 0x8000
    for (let i = 0; i < buffer.length; i += CHUNK) {
      binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK))
    }
    const bytesBase64 = btoa(binary)
    await run(async () => {
      await upload({
        data: {
          assetId: asset.id,
          mimeType: file.type,
          bytesBase64,
          metadata: {
            sourceType: sourceType as (typeof MEDIA_SOURCE_TYPES)[number],
            language: language ? (language as 'en' | 'yo') : null,
            durationSeconds: null,
            width: null,
            height: null,
            containsIdentifiablePerson: identifiable,
            consentStatus: identifiable ? 'PENDING' : 'NOT_APPLICABLE',
            consentReference: null,
            externalAiPolicy:
              aiPolicy as (typeof MEDIA_EXTERNAL_AI_POLICIES)[number],
            voiceCloneAuthorized: false,
          },
        },
      })
      setShowUpload(false)
      setFile(null)
    })
  }

  return (
    <div>
      <Link
        to="/admin/media-assets"
        className="text-sm text-ink-soft hover:text-ink"
      >
        ← Media library
      </Link>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">
          {asset.code}{' '}
          <span className="text-base font-normal text-ink-soft">
            ({asset.assetKind} · {asset.scopeType})
          </span>
        </h1>
        <div className="flex items-center gap-3 text-sm">
          {asset.active ? (
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
                  setActive({ data: { id: asset.id, active: !asset.active } }),
                )
              }
              className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
            >
              {asset.active ? 'Deactivate (future runtime)' : 'Reactivate'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowUpload((value) => !value)}
            className="rounded-md bg-gold px-3 py-1.5 font-medium text-night hover:bg-gold-bright"
          >
            Upload new version
          </button>
        </div>
      </div>

      {showUpload ? (
        <div className="mt-4 grid gap-3 rounded-md border border-dashed border-line-strong p-4 sm:grid-cols-4">
          <label className="block text-xs text-ink-soft sm:col-span-2">
            File
            <input
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="mt-1 w-full text-sm text-ink-soft"
            />
          </label>
          <label className="block text-xs text-ink-soft">
            Source
            <select
              value={sourceType}
              onChange={(event) => setSourceType(event.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
            >
              {MEDIA_SOURCE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs text-ink-soft">
            Language (optional)
            <select
              value={language}
              onChange={(event) => setLanguage(event.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
            >
              <option value="">None</option>
              <option value="en">English</option>
              <option value="yo">Yorùbá</option>
            </select>
          </label>
          <label className="block text-xs text-ink-soft">
            External AI policy
            <select
              value={aiPolicy}
              onChange={(event) => setAiPolicy(event.target.value)}
              className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
            >
              {MEDIA_EXTERNAL_AI_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {policy}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-soft sm:col-span-2">
            <input
              type="checkbox"
              checked={identifiable}
              onChange={(event) => setIdentifiable(event.target.checked)}
            />
            Contains an identifiable person (consent will be required before
            runtime use)
          </label>
          <div className="sm:col-span-4">
            <button
              type="button"
              disabled={busy || !file}
              onClick={() => void handleUpload()}
              className="rounded-md bg-gold px-4 py-2 text-sm font-medium text-night hover:bg-gold-bright disabled:opacity-60"
            >
              Upload draft version
            </button>
          </div>
        </div>
      ) : null}

      <ul className="mt-6 space-y-3">
        {data.versions.map((version: VersionRow) => {
          const check = data.eligibility.find(
            (item) => item.versionId === version.id,
          )
          return (
            <li
              key={version.id}
              className="rounded-md border border-line bg-surface p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">
                  v{version.versionNumber} · {version.mimeType} ·{' '}
                  {(version.byteSize / 1024).toFixed(1)} KB ·{' '}
                  {version.sourceType}
                  {version.language ? ` · ${version.language}` : ''}
                </span>
                <span className="flex flex-wrap gap-2 text-xs">
                  <span className="rounded-full bg-gold/10 px-2.5 py-0.5 text-gold-deep">
                    {version.status.replaceAll('_', ' ')}
                  </span>
                  <span className="rounded-full bg-surface px-2.5 py-0.5 text-ink-soft">
                    Rights:{' '}
                    {RIGHTS_STATUS_LABELS[version.rightsStatus] ??
                      version.rightsStatus}
                  </span>
                  <span className="rounded-full bg-surface px-2.5 py-0.5 text-ink-soft">
                    Consent: {version.consentStatus.replaceAll('_', ' ')}
                  </span>
                  <span
                    className={`rounded-full px-2.5 py-0.5 ${
                      check?.eligible
                        ? 'bg-affirm/10 text-affirm'
                        : 'bg-surface text-ink-soft'
                    }`}
                  >
                    Runtime: {check?.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}
                  </span>
                </span>
              </div>
              <p className="mt-1 text-xs break-all text-ink-soft">
                SHA-256: {version.fileSha256} · key: {version.storageKey} ·
                voice clone authorized:{' '}
                {version.voiceCloneAuthorized ? 'YES' : 'no'} · AI policy:{' '}
                {version.externalAiPolicy}
              </p>
              {check && !check.eligible && version.status === 'PUBLISHED' ? (
                <p className="mt-1 text-xs text-ink-soft">
                  Blocked by: {check.failures.join(', ')}
                </p>
              ) : null}
              {version.reviewNote && version.status === 'DRAFT' ? (
                <p className="mt-2 rounded-md border border-gold bg-gold/10 px-3 py-2 text-xs text-gold-deep">
                  Returned with reason: {version.reviewNote}
                </p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {version.status === 'DRAFT' ? (
                  <>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          updateDraft({
                            data: {
                              versionId: version.id,
                              metadata: {
                                sourceType: version.sourceType,
                                language: version.language,
                                durationSeconds: version.durationSeconds,
                                width: version.width,
                                height: version.height,
                                containsIdentifiablePerson:
                                  version.containsIdentifiablePerson,
                                consentStatus:
                                  version.consentStatus === 'PENDING'
                                    ? 'PENDING'
                                    : 'NOT_APPLICABLE',
                                consentReference: null,
                                externalAiPolicy: version.externalAiPolicy,
                                voiceCloneAuthorized:
                                  version.voiceCloneAuthorized,
                              },
                            },
                          }),
                        )
                      }
                      className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                    >
                      Re-save metadata
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
                      onClick={() =>
                        setNoteFor({ versionId: version.id, kind: 'return' })
                      }
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
                {canRights
                  ? (RIGHTS_NEXT[version.rightsStatus] ?? []).map((next) => (
                      <button
                        key={next}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (next === 'RESTRICTED' || next === 'WITHDRAWN') {
                            setNoteFor({
                              versionId: version.id,
                              kind: 'rights',
                              status: next,
                            })
                            setNoteText('')
                          } else {
                            void run(() =>
                              setRights({
                                data: { versionId: version.id, status: next },
                              }),
                            )
                          }
                        }}
                        className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                      >
                        Rights → {RIGHTS_STATUS_LABELS[next] ?? next}
                      </button>
                    ))
                  : null}
                {canRights && version.containsIdentifiablePerson
                  ? (CONSENT_NEXT[version.consentStatus] ?? []).map((next) => (
                      <button
                        key={next}
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (next === 'GRANTED') {
                            setNoteFor({
                              versionId: version.id,
                              kind: 'consent',
                              status: next,
                            })
                            setNoteText('')
                          } else {
                            void run(() =>
                              setConsent({
                                data: {
                                  versionId: version.id,
                                  status: next as 'PENDING' | 'WITHDRAWN',
                                },
                              }),
                            )
                          }
                        }}
                        className="rounded-md border border-line-strong px-3 py-1.5 text-ink-soft hover:border-gold-deep disabled:opacity-60"
                      >
                        Consent → {next.replaceAll('_', ' ')}
                      </button>
                    ))
                  : null}
                {canPublish && version.status === 'PUBLISHED' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        setRuntime({
                          data: {
                            versionId: version.id,
                            enabled: !version.runtimeEnabled,
                          },
                        }),
                      )
                    }
                    className={`rounded-md px-3 py-1.5 font-medium disabled:opacity-60 ${
                      version.runtimeEnabled
                        ? 'border border-alert/40 text-alert hover:bg-alert/10'
                        : 'bg-affirm text-white hover:bg-affirm/90'
                    }`}
                  >
                    {version.runtimeEnabled
                      ? 'Disable runtime'
                      : 'Enable runtime'}
                  </button>
                ) : null}
              </div>
              {noteFor?.versionId === version.id ? (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <input
                    value={noteText}
                    onChange={(event) =>
                      setNoteText(event.target.value.slice(0, 1000))
                    }
                    placeholder={
                      noteFor.kind === 'consent'
                        ? 'Documented consent reference (required)'
                        : 'Reason (required)'
                    }
                    className="w-full max-w-md rounded-md border border-line-strong bg-surface-raised px-3 py-2 text-sm text-ink"
                  />
                  <button
                    type="button"
                    disabled={busy || !noteText.trim()}
                    onClick={() =>
                      void run(() => {
                        if (noteFor.kind === 'rights') {
                          return setRights({
                            data: {
                              versionId: version.id,
                              status: noteFor.status as RightsStatus,
                              note: noteText,
                            },
                          })
                        }
                        if (noteFor.kind === 'consent') {
                          return setConsent({
                            data: {
                              versionId: version.id,
                              status: 'GRANTED',
                              consentReference: noteText,
                            },
                          })
                        }
                        return returnVersion({
                          data: { versionId: version.id, reason: noteText },
                        })
                      })
                    }
                    className="rounded-md border border-gold px-3 py-2 text-sm text-gold-deep hover:bg-gold/10 disabled:opacity-60"
                  >
                    Confirm
                  </button>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>

      <section className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
        <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
          Sacred content links
        </h2>
        <p className="mt-1 text-xs text-ink-soft">
          Exact PUBLISHED sacred version ↔ PUBLISHED media version links. Audio
          roles require AUDIO assets; language must match when set.
        </p>
        <ul className="mt-3 space-y-2 text-sm">
          {data.links.map(({ link, sacredVersion }) => (
            <li
              key={link.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2"
            >
              <span>
                {link.role} → sacred v{sacredVersion.versionNumber} (
                {sacredVersion.language}) “{sacredVersion.title}” · media
                version {link.mediaAssetVersionId}
              </span>
              {canPublish ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() => removeLink({ data: { linkId: link.id } }))
                  }
                  className="rounded-md border border-line-strong px-2 py-1 text-xs text-ink-soft hover:border-alert hover:text-alert disabled:opacity-60"
                >
                  Unlink
                </button>
              ) : null}
            </li>
          ))}
          {data.links.length === 0 ? (
            <li className="text-xs text-ink-soft">No links yet.</li>
          ) : null}
        </ul>
        {canPublish ? (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="block text-xs text-ink-soft">
              Sacred content version id
              <input
                value={linkContentVersionId}
                onChange={(event) =>
                  setLinkContentVersionId(
                    event.target.value.replace(/[^0-9]/g, ''),
                  )
                }
                className="mt-1 w-40 rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
              />
            </label>
            <label className="block text-xs text-ink-soft">
              Media version id
              <input
                value={linkVersionId}
                onChange={(event) =>
                  setLinkVersionId(event.target.value.replace(/[^0-9]/g, ''))
                }
                className="mt-1 w-32 rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
              />
            </label>
            <label className="block text-xs text-ink-soft">
              Role
              <select
                value={linkRole}
                onChange={(event) => setLinkRole(event.target.value)}
                className="mt-1 w-44 rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
              >
                {SACRED_MEDIA_LINK_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy || !linkContentVersionId || !linkVersionId}
              onClick={() =>
                void run(() =>
                  createLink({
                    data: {
                      contentVersionId: Number(linkContentVersionId),
                      mediaAssetVersionId: Number(linkVersionId),
                      role: linkRole as (typeof SACRED_MEDIA_LINK_ROLES)[number],
                    },
                  }),
                )
              }
              className="rounded-md border border-line-strong px-3 py-2 text-sm text-ink-soft hover:border-gold-deep disabled:opacity-60"
            >
              Create link
            </button>
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
