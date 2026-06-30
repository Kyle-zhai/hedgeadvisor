/**
 * lib/relate/comboOverlap.ts — Phase 2/3 of the joint-combo roadmap
 * (docs/settlement-moat-and-joint-combo-calibration.md, Part II).
 *
 * Pairwise overlap primitives for multi-leg combos. A good combo covers DIFFERENT anchor-failure scenarios;
 * two legs that hedge the SAME failure path are largely redundant (the second adds payout size, not new
 * coverage). These conservative RULE-BASED penalties ("先用规则，再逐步由 settlement 学习") let the combo
 * selector prefer scenario-diverse legs and stop adding redundant ones.
 *
 * HONESTY: penalties only ever LOWER estimated coverage / marginal gain — they never inflate it, never size a
 * position, and never promote a tier. The engine's reported combo `coverage` stays the assumption-free
 * Fréchet–Hoeffding lower bound; these helpers govern WHICH legs are chosen, not the headline coverage number.
 */

import type { ScenarioBucket } from "./scenarioBucket";

/** Minimal leg shape for overlap reasoning (a structural subset of HedgeStrategy / combo legs). */
export interface OverlapLeg {
  marketId: string;
  marketTitle: string;
  scenario: ScenarioBucket;
  scope?: "same-event" | "cross-event";
  /** P(this leg pays | the anchor fails) — the fraction of the fail-space it covers on its own. */
  pGivenFails: number;
}

/**
 * Conservative rule-based overlap penalty in [0,1] between two legs (1 = the second leg adds NO new coverage).
 * Doc Part II table: same exact event 0.8–1.0; same scenario 0.6–0.85; different scenario same domain 0.2–0.5;
 * different scenario + historically low overlap 0–0.25; unknown cross-domain 0.5 until proven. These are a
 * pre-settlement PRIOR; Phase 5 replaces them with learned penalties where evidence exists.
 */
export function overlapPenalty(a: OverlapLeg, b: OverlapLeg): number {
  if (a.marketId === b.marketId) return 1.0;            // literally the same market outcome
  if (a.marketTitle === b.marketTitle) return 0.9;      // same event/market, different outcome ⇒ near-duplicate cover
  if (a.scenario === b.scenario) {
    // unrelated_control legs aren't a real failure path, so two of them are only weakly "the same".
    return a.scenario === "unrelated_control" ? 0.5 : 0.7;
  }
  // Different scenarios = the desirable case (orthogonal failure paths). Two same-EVENT collateral facets of
  // one match still co-move somewhat; cross-event different-scenario legs are the most orthogonal.
  if (a.scope === "same-event" && b.scope === "same-event") return 0.35;
  return 0.2;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * Conservative combo coverage with overlap penalties: `1 − ∏(1 − p_i·(1−penalty_i))`, where each leg's
 * penalty is the MAX overlap with any earlier-selected leg (so a redundant leg contributes almost nothing).
 * This is the doc's optimistic-with-penalty estimate, used for SELECTION ranking — NOT the reported headline
 * coverage (which stays the Fréchet lower bound). Order matters: pass legs in selection order.
 */
export function conservativeCoverage(legs: OverlapLeg[]): number {
  let uncovered = 1;
  const selected: OverlapLeg[] = [];
  for (const leg of legs) {
    const pen = selected.length ? Math.max(...selected.map((s) => overlapPenalty(leg, s))) : 0;
    uncovered *= 1 - clamp01(leg.pGivenFails * (1 - pen));
    selected.push(leg);
  }
  return 1 - uncovered;
}

/** Marginal coverage a candidate adds beyond the already-selected legs (≥0; ~0 when fully redundant). */
export function marginalCoverageGain(candidate: OverlapLeg, selected: OverlapLeg[]): number {
  return Math.max(0, conservativeCoverage([...selected, candidate]) - conservativeCoverage(selected));
}
