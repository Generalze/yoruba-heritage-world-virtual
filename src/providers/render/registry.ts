import { env } from '@/lib/env'
import { createMockRenderEngine } from './mock'
import { createRemotionRenderEngine } from './remotion'
import { RenderEngineError } from './types'
import type { RenderEngine } from './types'

/**
 * Render engine access point (Phase One, Step 16). The ONLY way the
 * assembly service obtains an engine — mirrors the Step 14/15 provider
 * registries (exactly one active slot, swappable for tests).
 *
 * TWO engines exist: the deterministic mock (the DEFAULT, and the only
 * one automated verification ever selects) and the real Remotion
 * adapter, which is strictly OPT-IN through RENDER_DRIVER=REMOTION.
 * Both satisfy the same RenderEngine interface, and the assembly
 * service cannot tell them apart — except through `isMock`, which the
 * production guard below refuses on.
 */

let overrideEngine: RenderEngine | null = null
let defaultEngine: RenderEngine | null = null

/**
 * EXPLICIT SELECTION ONLY. An unknown driver string never reaches the
 * default branch — RENDER_DRIVER is a validated enum, so a typo stops
 * the process at configuration time in EVERY environment — and if a
 * value is ever added to the enum without being handled here, this
 * throws rather than quietly returning the mock. "It silently rendered
 * with the mock" is the failure this shape exists to prevent.
 */
export function getRenderEngine(): RenderEngine {
  if (overrideEngine) return overrideEngine
  if (defaultEngine) return defaultEngine
  switch (env.RENDER_DRIVER) {
    case 'MOCK':
      defaultEngine = createMockRenderEngine()
      break
    case 'REMOTION':
      defaultEngine = createRemotionRenderEngine()
      break
    default:
      throw new RenderEngineError(
        'render_driver_unknown',
        'RENDER_DRIVER names no implemented engine; the mock is never a substitute.',
        false,
      )
  }
  return defaultEngine
}

/** Drops the memoized engine so a configuration change (or a test that
 * varies the driver) is observed rather than cached forever. */
export function resetRenderEngineDefaultForTests(): void {
  defaultEngine = null
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

/**
 * THE TRUSTED PERSISTED-RENDERER REGISTRY.
 *
 * A render result records the exact engine that produced it, forever.
 * Verification of a COMPLETED recording therefore cannot ask "is this
 * the engine we run today?" — the honest question is "is this an engine
 * this platform trusts to have produced a deliverable?" The difference
 * matters the first time Remotion is upgraded: under the stricter
 * question every recording ever made would become unavailable the
 * moment package.json changed, which is not a security property, it is
 * an outage.
 *
 * So NEW SPEND stays strict — a render is only ever performed into a
 * row whose identity equals the CURRENTLY selected engine exactly — and
 * COMPLETED verification checks membership of this list instead.
 *
 * GOVERNANCE RULE, and the reason this is a list rather than a lookup:
 * when a renderer is upgraded, the new identity is ADDED here. An old
 * identity is REMOVED only by an explicit governance or security
 * decision — because removing one declares every recording it produced
 * untrustworthy and takes them all away from the people they belong to.
 * That must never happen as a side effect of bumping a dependency.
 */
export interface TrustedRendererIdentity {
  code: string
  version: string
  isMock: boolean
}

export const TRUSTED_RENDERER_IDENTITIES: ReadonlyArray<TrustedRendererIdentity> =
  [
    // Development and test only; the production guard refuses it
    // wherever it appears, so trusting it here is not a loophole.
    { code: 'MOCK_RENDER', version: 'mock-1', isMock: true },
    // The real compositor. Kept in step with the exact pinned package
    // version — see REMOTION_ENGINE_VERSION.
    { code: 'REMOTION', version: 'remotion-4.0.507', isMock: false },
  ]

export type TrustedIdentityCheck =
  | { ok: true }
  | { ok: false; reasonCode: string }

/**
 * Is this PERSISTED identity one this platform vouches for?
 *
 * Checked as a whole tuple. A trusted code with an unknown version is
 * NOT trusted — that is precisely the tampered or unrecognised-build
 * case — and neither is a trusted code and version with the wrong mock
 * flag, which is how synthetic output would try to pass itself off as a
 * real render.
 */
export function checkTrustedRendererIdentity(
  identity: TrustedRendererIdentity,
  nodeEnv: string = env.NODE_ENV,
): TrustedIdentityCheck {
  const trusted = TRUSTED_RENDERER_IDENTITIES.some(
    (candidate) =>
      candidate.code === identity.code &&
      candidate.version === identity.version &&
      candidate.isMock === identity.isMock,
  )
  if (!trusted) {
    return { ok: false, reasonCode: 'renderer_identity_untrusted' }
  }
  // The production prohibition follows the ARTIFACT, not the active
  // engine: a mock-produced recording is never deliverable in
  // production, however it came to be there.
  if (identity.isMock && nodeEnv === 'production') {
    return { ok: false, reasonCode: 'mock_renderer_forbidden_in_production' }
  }
  return { ok: true }
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
