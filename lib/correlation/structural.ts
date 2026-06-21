/**
 * lib/correlation/structural.ts — correlations DERIVED from price + logic, never
 * fitted from history. Each edge carries its rule + a plain-language "why" that
 * the explanation layer renders verbatim. This is the "covariance weakness turned
 * into explainability strength" payoff.
 *
 * General tool for binaries X,Y:
 *   rho = (P(X∧Y) - P(X)P(Y)) / sqrt(P(X)(1-P(X)) P(Y)(1-P(Y)))
 * We take marginals from prices and the JOINT from structure.
 */
import type { CorrelationEdge } from "@/lib/types";

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

function band(center: number, fn: (dp: number) => number): [number, number] {
  const a = fn(-0.005);
  const b = fn(0.005);
  const lo = Math.min(a, b, center);
  const hi = Math.max(a, b, center);
  return [Number(lo.toFixed(3)), Number(hi.toFixed(3))];
}

/** The held position's OWN NO is the exact complement: corr = -1, deterministic. */
export function complementEdge(teamTitle: string): CorrelationEdge {
  return {
    fromTitle: `${teamTitle} wins`,
    toTitle: `${teamTitle} does NOT win (NO)`,
    rho: -1,
    rule: "EXCLUSIVE",
    provenance: "ANALYTIC",
    band: [-1, -1],
    why: `"${teamTitle} NO" pays $1 in exactly the outcomes where "${teamTitle} wins" pays $0 — it is the exact complement of your position, the cleanest possible hedge.`,
  };
}

/** A rival outcome (mutually exclusive with the held team). */
export function rivalEdge(
  heldTitle: string,
  rivalTitle: string,
  pHeld: number,
  pRival: number,
): CorrelationEdge {
  const rho = exclusiveCorr(pHeld, pRival);
  return {
    fromTitle: `${heldTitle} wins`,
    toTitle: `${rivalTitle} wins`,
    rho: Number(rho.toFixed(3)),
    rule: "EXCLUSIVE",
    provenance: "ANALYTIC",
    band: band(rho, (dp) => exclusiveCorr(pHeld, clampP(pRival + dp))),
    why: `"${heldTitle}" and "${rivalTitle}" can't both win, so a "${rivalTitle} wins" position pays out in part of the world where your "${heldTitle}" loses.`,
  };
}

/** A superset basket the held team belongs to (e.g. a European team wins). */
export function supersetEdge(
  heldTitle: string,
  basketTitle: string,
  pHeld: number,
  pBasket: number,
): CorrelationEdge {
  const rho = subsetCorr(pHeld, pBasket);
  return {
    fromTitle: `${heldTitle} wins`,
    toTitle: basketTitle,
    rho: Number(rho.toFixed(3)),
    rule: "SUBSET",
    provenance: "ANALYTIC",
    band: band(rho, (dp) => subsetCorr(pHeld, clampP(pBasket + dp))),
    why: `"${heldTitle} wins" is contained inside "${basketTitle}", so it moves strongly WITH your position — a poor hedge (it pays when you already pay).`,
  };
}

/** A same-team ladder rung (e.g. Spain reaches the final) — strong positive, bad hedge. */
export function ladderEdge(
  heldTitle: string,
  rungTitle: string,
  pHeld: number,
  pRung: number,
): CorrelationEdge {
  const rho = subsetCorr(pHeld, pRung); // held ⊆ rung
  return {
    fromTitle: `${heldTitle} wins`,
    toTitle: rungTitle,
    rho: Number(rho.toFixed(3)),
    rule: "LADDER",
    provenance: "ANALYTIC",
    band: band(rho, (dp) => subsetCorr(pHeld, clampP(pRung + dp))),
    why: `"${rungTitle}" happens in every world where "${heldTitle} wins" (and more), so it rises and falls with your position — not protection.`,
  };
}
