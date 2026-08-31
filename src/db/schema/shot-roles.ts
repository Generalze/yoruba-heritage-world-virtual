/**
 * THE canonical shot-role vocabulary — one authority, two domains.
 *
 * A prayer template slot AUTHORS a camera decision; a Visual Bible
 * version BINDS an approved reference image to a role. Those are
 * different domains, but they must name the same six things, because
 * the runtime resolves a reference by matching one to the other.
 *
 * They were previously two independent declarations with identical
 * values and nothing preventing drift: adding a role on one side only
 * would fail closed for REQUIRED scenes and, worse, silently drop the
 * reference for OPTIONAL ones. This module exists so that divergence is
 * not merely unlikely but unrepresentable — both domains import THIS
 * list, and a regression test proves they still do.
 *
 * Deliberately free of every other schema import so neither domain can
 * create an import cycle by depending on it.
 */
export const SHOT_ROLES = [
  'WIDE_MASTER',
  'MEDIUM_PRAYER',
  'DIRECT_CAMERA',
  'SIDE_PRAYER',
  'WORKING_DETAIL',
  'ENVIRONMENT_INSERT',
] as const

export type ShotRole = (typeof SHOT_ROLES)[number]
