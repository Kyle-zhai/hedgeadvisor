/**
 * lib/correlation/structural.ts — correlations DERIVED from price + logic, never fitted from history.
 * General tool for binaries X,Y:  rho = (P(X∧Y) - P(X)P(Y)) / sqrt(P(X)(1-P(X)) P(Y)(1-P(Y)))
 * We take marginals from prices and the JOINT from structure.
 *
 * The old per-leg "edge" helpers (complementEdge / rivalEdge / supersetEdge / ladderEdge) were the
 * shorting hedge engine's; they were removed in the 2026-06-21 consolidation. Only the φ-from-joint
 * primitives remain (consumed by lib/correlation/relation.ts and lib/relate).
 */

function clampP(p: number): number {
  return Math.min(0.999, Math.max(0.001, p));
}

/** General correlation from marginals + joint. */
export function corrFromJoint(pX: number, pY: number, pXY: number): number {
  const x = clampP(pX);
  const y = clampP(pY);
  const denom = Math.sqrt(x * (1 - x) * y * (1 - y));
  if (denom <= 0) return 0;
  return (pXY - x * y) / denom;
}

/** Two mutually-exclusive outcomes (e.g. Spain wins vs France wins): joint = 0. */
export function exclusiveCorr(pX: number, pY: number): number {
  return corrFromJoint(pX, pY, 0);
}

/** member ⊆ basket (e.g. Spain wins ⊆ a European team wins): joint = pMember. */
export function subsetCorr(pMember: number, pBasket: number): number {
  return corrFromJoint(pMember, pBasket, Math.min(pMember, pBasket));
}
