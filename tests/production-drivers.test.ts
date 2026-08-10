import { afterEach, describe, expect, it } from 'bun:test'

import { createDisabledTtsProvider } from '@/providers/tts/disabled'
import { createDisabledVisualGenerationProvider } from '@/providers/visual-generation/disabled'
import {
  resetTtsProviderForTests,
  setTtsProviderForTests,
} from '@/providers/tts/registry'
import {
  resetVisualGenerationProviderForTests,
  setVisualGenerationProviderForTests,
} from '@/providers/visual-generation/registry'
import { checkRenderEngineAllowed } from '@/providers/render/registry'
import { checkObjectStorageAllowed } from '@/providers/object-storage/registry'
import { createMockRenderEngine } from '@/providers/render/mock'
import { createRemotionRenderEngine } from '@/providers/render/remotion'
import { LocalPrivateObjectStorage } from '@/providers/object-storage/local'
import { createS3CompatibleObjectStorage } from '@/providers/object-storage/s3'
import { submitSpeech } from '@/services/audio-generation'
import { submitScene } from '@/services/visual-generation'
import { TtsProviderError } from '@/providers/tts/types'
import { VisualGenerationProviderError } from '@/providers/visual-generation/types'
import type { ManifestAudioRequirement, ManifestVisualTask } from '@/services/generation-storyboards'
import type { SpeechTaskIdentity } from '@/services/audio-generation'

/**
 * ============================================================================
 * PRODUCTION DRIVER GUARDS — Phase One, Step 20.
 *
 * Two separate promises, both proved here:
 *
 *   1. production REFUSES the adapters that are fine in development —
 *      a mock renderer, local final object storage — and the refusal is
 *      an environment check, not a flag anyone can flip; and
 *   2. a DISABLED generation or speech adapter causes required work to
 *      FAIL CLOSED, never to be silently skipped, and refuses BEFORE
 *      the approved sacred body is ever read.
 * ============================================================================
 */

afterEach(() => {
  resetTtsProviderForTests()
  resetVisualGenerationProviderForTests()
})

describe('production refuses mock and local adapters', () => {
  it('refuses a mock render engine in production, and allows it elsewhere', () => {
    const mock = createMockRenderEngine()
    expect(mock.isMock).toBe(true)
    const refused = checkRenderEngineAllowed(mock, 'production')
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected refusal')
    expect(refused.reasonCode).toBe('mock_renderer_forbidden_in_production')
    for (const nodeEnv of ['development', 'test']) {
      expect(checkRenderEngineAllowed(mock, nodeEnv).ok).toBe(true)
    }
  })

  it('accepts the REAL engine in production', () => {
    // The refusal is about mock-ness, not about being cautious in
    // general — otherwise production could never render at all.
    const remotion = createRemotionRenderEngine()
    expect(remotion.isMock).toBe(false)
    expect(checkRenderEngineAllowed(remotion, 'production').ok).toBe(true)
  })

  it('refuses LOCAL final object storage in production, and allows it elsewhere', () => {
    const local = new LocalPrivateObjectStorage('/tmp/does-not-need-to-exist')
    expect(local.isLocal).toBe(true)
    const refused = checkObjectStorageAllowed(local, 'production')
    expect(refused.ok).toBe(false)
    if (refused.ok) throw new Error('expected refusal')
    expect(refused.reasonCode).toBe(
      'local_object_storage_forbidden_in_production',
    )
    for (const nodeEnv of ['development', 'test']) {
      expect(checkObjectStorageAllowed(local, nodeEnv).ok).toBe(true)
    }
  })

  it('accepts the REAL object storage adapter in production', () => {
    const s3 = createS3CompatibleObjectStorage(
      {
        OBJECT_STORAGE_ENDPOINT: 'https://s3.example',
        OBJECT_STORAGE_REGION: 'eu-west-1',
        OBJECT_STORAGE_BUCKET: 'yhwv-private',
        OBJECT_STORAGE_ACCESS_KEY_ID: 'AKIA_PLACEHOLDER',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-placeholder',
      },
      // A client that is never called: constructing the adapter must
      // not require a network, and this test makes no request.
      { client: { send: async () => ({}) } },
    )
    expect(s3.isLocal).toBe(false)
    expect(checkObjectStorageAllowed(s3, 'production').ok).toBe(true)
  })

  it('refuses a disabled provider regardless of environment', () => {
    const disabled = {
      code: 'X',
      isLocal: false,
      isEnabled: () => false,
    }
    for (const nodeEnv of ['development', 'test', 'production']) {
      const result = checkObjectStorageAllowed(disabled, nodeEnv)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reasonCode).toBe('object_storage_disabled')
    }
  })
})

describe('disabled adapters fail closed', () => {
  it('reports itself disabled and refuses every call, non-retryably', async () => {
    const tts = createDisabledTtsProvider()
    expect(tts.isEnabled()).toBe(false)
    expect(tts.code).toBe('DISABLED')
    for (const call of [
      () => tts.submitSpeech({} as never),
      () => tts.pollSpeech('anything'),
    ]) {
      let thrown: unknown
      try {
        await call()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(TtsProviderError)
      // Retrying cannot install a vendor.
      expect((thrown as TtsProviderError).retryable).toBe(false)
    }

    const visual = createDisabledVisualGenerationProvider()
    expect(visual.isEnabled()).toBe(false)
    for (const call of [
      () => visual.submitScene({} as never),
      () => visual.pollScene('anything'),
    ]) {
      let thrown: unknown
      try {
        await call()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(VisualGenerationProviderError)
      expect((thrown as VisualGenerationProviderError).retryable).toBe(false)
    }
  })

  it('refuses TTS BEFORE the approved sacred body is read', async () => {
    // TEETH: Step 15's rule is that the body is retrieved only when
    // synthesis is currently authorized. A deployment with no speech
    // backend is one where it never is — so the refusal must come
    // before compilation, not after. The identity below is deliberately
    // EMPTY: if anything touched it, this would throw rather than
    // return a clean failure.
    setTtsProviderForTests(createDisabledTtsProvider())
    const result = await submitSpeech({
      requirement: {} as ManifestAudioRequirement,
    } as SpeechTaskIdentity & { requirement: ManifestAudioRequirement })
    expect(result.status).toBe('FAILED')
    if (result.status !== 'FAILED') throw new Error('expected failure')
    // A recorded task failure — visible and bounded, never a silent
    // skip.
    expect(result.errorCode).toBe('tts_unavailable')
    expect(result.providerCode).toBe('DISABLED')
  })

  it('refuses visual generation before compiling a request', async () => {
    setVisualGenerationProviderForTests(
      createDisabledVisualGenerationProvider(),
    )
    const result = await submitScene({} as ManifestVisualTask)
    expect(result.status).toBe('FAILED')
    if (result.status !== 'FAILED') throw new Error('expected failure')
    expect(result.errorCode).toBe('visual_generation_unavailable')
    expect(result.providerCode).toBe('DISABLED')
  })
})

describe('registries never fall back', () => {
  it('has no path from an unknown driver to a local or mock adapter', async () => {
    // The enums in src/lib/env.ts stop an unknown value before it gets
    // here; these switches are the second lock on the same door, so a
    // value added to an enum and forgotten in a registry throws instead
    // of silently selecting the mock.
    for (const file of [
      'src/providers/object-storage/registry.ts',
      'src/providers/render/registry.ts',
      'src/providers/visual-generation/registry.ts',
      'src/providers/tts/registry.ts',
    ]) {
      const source = await Bun.file(file).text()
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      expect(code).toContain('default:')
      expect(code).toContain('throw new')
      // No `?? createMock…` / `?? new Local…` fallback anywhere.
      expect(code).not.toMatch(/\?\?\s*createMock/)
      expect(code).not.toMatch(/\?\?\s*new Local/)
    }
  })
})
