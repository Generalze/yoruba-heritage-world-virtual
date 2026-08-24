import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'

import {
  listRecipePreviewContextFn,
  previewVideoRecipeFn,
} from '@/services/video-recipe-actions'

/**
 * Staff-only video recipe preview (Step 11): runs the real recipe
 * engine + validator for a chosen service/language/seed. Shows only
 * governance metadata — never sacred bodies, storage keys, consent
 * references or rights notes (the recipe contains none by design).
 */
export const Route = createFileRoute('/admin/video-recipes')({
  loader: async () => listRecipePreviewContextFn(),
  component: VideoRecipePreviewPage,
})

function VideoRecipePreviewPage() {
  const data = Route.useLoaderData()
  const preview = useServerFn(previewVideoRecipeFn)
  const [serviceId, setServiceId] = useState('')
  const [language, setLanguage] = useState('en')
  const [seed, setSeed] = useState('preview-1')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Awaited<
    ReturnType<typeof previewVideoRecipeFn>
  > | null>(null)

  async function runPreview() {
    setBusy(true)
    setError(null)
    try {
      const response = await preview({
        data: {
          serviceId: Number(serviceId),
          language: language as 'en' | 'yo',
          variationSeed: seed,
        },
      })
      setResult(response)
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
    <div>
      <h1 className="text-2xl font-bold">Video Recipe Preview</h1>
      <p className="mt-1 text-sm text-ink-soft">
        Deterministic dry-run of the autonomous recipe engine: approved session
        plan + eligible media + verified Visual Bible. Nothing is persisted or
        generated.
      </p>

      <div className="mt-6 grid max-w-3xl gap-3 sm:grid-cols-4">
        <label className="block text-xs text-ink-soft sm:col-span-2">
          Service
          <select
            value={serviceId}
            onChange={(event) => setServiceId(event.target.value)}
            className="mt-1 w-full rounded-md border border-line-strong bg-surface-raised px-2 py-1.5 text-sm text-ink"
          >
            <option value="">Select…</option>
            {data.services.map((service) => (
              <option key={service.id} value={String(service.id)}>
                {service.name} (
                {data.houses.find((h) => h.id === service.sacredHouseId)?.name})
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
        disabled={busy || !serviceId || !seed.trim()}
        onClick={() => void runPreview()}
        className="mt-3 rounded-md bg-gold px-4 py-2 text-sm font-medium text-night hover:bg-gold-bright disabled:opacity-60"
      >
        Build recipe
      </button>
      {error ? (
        <p className="mt-4 rounded-md border border-alert/40 bg-alert/10 px-4 py-3 text-sm text-alert">
          {error}
        </p>
      ) : null}

      {result ? (
        result.recipe.status === 'RECIPE_READY' ? (
          <div className="mt-6 rounded-lg border border-line bg-surface-raised p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium tracking-widest text-gold-deep uppercase">
                Recipe ready
              </h2>
              {result.validation ? (
                <span
                  className={`rounded-full px-3 py-1 text-xs ${
                    result.validation.status === 'VALID'
                      ? 'bg-affirm/10 text-affirm'
                      : 'bg-alert/10 text-alert'
                  }`}
                >
                  Validation: {result.validation.status}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-xs break-all text-ink-soft">
              recipeSha256: {result.recipe.recipeSha256}
            </p>
            <dl className="mt-3 grid gap-1 text-xs text-ink-soft sm:grid-cols-2">
              <div>
                Template version #{result.recipe.templateVersionId} (v
                {result.recipe.templateVersionNumber})
              </div>
              <div className="break-all">
                Template SHA: {result.recipe.templateDefinitionSha256}
              </div>
              <div>
                Visual Bible:{' '}
                {result.recipe.visualBible
                  ? `v${result.recipe.visualBible.versionNumber}`
                  : 'not required'}
              </div>
              <div>
                Estimated {result.recipe.totalEstimatedSeconds}s of{' '}
                {result.recipe.targetMinSeconds}–
                {result.recipe.targetMaxSeconds}s
              </div>
            </dl>
            {result.validation?.status === 'INVALID' ? (
              <p className="mt-2 rounded-md border border-alert/40 bg-alert/10 px-3 py-2 text-xs text-alert">
                Invalid: {result.validation.reasons.join(', ')}
              </p>
            ) : null}
            <ul className="mt-4 space-y-2 text-xs text-ink-soft">
              {result.recipe.segments.map((segment) => (
                <li
                  key={segment.segmentIndex}
                  className="rounded-md border border-line bg-surface px-3 py-2"
                >
                  <span className="font-medium">
                    {segment.slotPosition}. {segment.slotKey}
                  </span>{' '}
                  — {segment.kind}
                  {segment.kind === 'SILENCE'
                    ? ` · ${segment.durationSeconds}s · visual ${segment.visualMode}`
                    : ` · content v${segment.contentVersionId} (${segment.contentType}) · audio ${segment.audioMode}${
                        segment.audio
                          ? ` (media v${segment.audio.mediaAssetVersionId})`
                          : ''
                      } · visual ${segment.visualMode}${
                        segment.visual
                          ? ` (media v${segment.visual.mediaAssetVersionId}, ${segment.visual.scopeType})`
                          : ''
                      }${
                        segment.generation
                          ? ` (Visual Bible v${segment.generation.visualBibleVersionNumber}${
                              segment.generation.textContextAllowed
                                ? ', text context allowed'
                                : ''
                            })`
                          : ''
                      } · ${segment.durationSeconds}s`}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-6 rounded-md border border-gold bg-gold/10 px-4 py-3 text-sm text-gold-deep">
            RECIPE_UNAVAILABLE — {result.recipe.reasons.join(', ')}
          </p>
        )
      ) : null}
    </div>
  )
}
