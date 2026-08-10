import { env } from '@/lib/env'
import { createMockRenderEngine } from './mock'
import type { RenderEngine } from './types'

/**
 * Render engine access point (Phase One, Step 16). The ONLY way the
 * assembly service obtains an engine — mirrors the Step 14/15 provider
 * registries (exactly one active slot, swappable for tests).
 *
 * Only the deterministic mock exists at this stage. A real Remotion
 * adapter plugs in here behind the SAME RenderEngine interface, opt-in
 * and explicitly selected, with no change to the assembly service.
 */

let overrideEngine: RenderEngine | null = null
let defaultEngine: RenderEngine | null = null

export function getRenderEngine(): RenderEngine {
  if (overrideEngine) return overrideEngine
  defaultEngine ??= createMockRenderEngine()
  return defaultEngine
}

/**
 * Resolves the engine a PERSISTED renderer code refers to, failing
 * CLOSED on mismatch. A render result records which engine produced it;
 * re-verifying that result later against whichever engine happens to be
 * active would be asking the wrong thing entirely.
 */
export function resolveRenderEngine(rendererCode: string): RenderEngine | null {
  const active = getRenderEngine()
  return active.code === rendererCode ? active : null
}

export type RenderEnvironmentCheck =
  | { ok: true }
  | { ok: false; reasonCode: string }

/**
 * PRODUCTION MUST NEVER SILENTLY USE THE MOCK.
 *
 * The mock produces a synthetic artifact that is not a real
 * composition. In development and test that is exactly what is wanted;
 * in production it would mean handing someone a file that looks like
 * their prayer video and is not. So a mock engine is refused outright
 * when NODE_ENV is production — there is no flag, no override and no
 * "just this once": the refusal is the feature.
 *
 * Checked in TWO places on purpose — before the render is executed, and
 * again at the final gate before RENDERING → UPLOADING — so an engine
 * swapped in mid-flight cannot smuggle a mock artifact forward.
 */
export function checkRenderEngineAllowed(
  engine: Pick<RenderEngine, 'code' | 'isMock' | 'isEnabled'>,
  nodeEnv: string = env.NODE_ENV,
): RenderEnvironmentCheck {
  if (!engine.isEnabled()) {
    return { ok: false, reasonCode: 'renderer_disabled' }
  }
  if (engine.isMock && nodeEnv === 'production') {
    return { ok: false, reasonCode: 'mock_renderer_forbidden_in_production' }
  }
  return { ok: true }
}

export function setRenderEngineForTests(engine: RenderEngine): void {
  overrideEngine = engine
}

export function resetRenderEngineForTests(): void {
  overrideEngine = null
}
