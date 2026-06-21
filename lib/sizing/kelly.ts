/**
 * lib/sizing/kelly.ts — fractional (half) Kelly over the outcome partition.
 *
 * We maximize E[log(terminal wealth)] across the 60 mutually-exclusive outcomes,
 * where the hedge's cost at size x comes from walking the live book (convex in x).
 * Kelly avoids ruin (log → -∞ on any wipeout outcome). Note: a leg only HELPS if
 * its payoff set excludes the held-win outcome — that exclusion (done by the caller
 * via `hedgePaysIn`) is what makes a real hedge; Kelly then sizes it. We halve the
 * full-Kelly size as the standard prudence haircut, plus an extra shrink when the
 * correlation input is a PRIOR rather than ANALYTIC.
 *
 * `capacityLimited` is set when the unconstrained optimum sits AT the depth ceiling,
 * i.e. the recommended size is bounded by book liquidity, NOT by the Kelly objective.
 * The caller must surface this so a depth-bound size is never presented as the
 * risk-optimal half-Kelly size (an honesty requirement).
 */
import type { Outcome } from "@/lib/netcost";
import { round2 } from "./util";

export interface HedgeSizeInput {
  outcomes: Outcome[];
  heldIndex: number;
  heldShares: number;
  heldBasisUsd: number;
  hedgePaysIn: Set<number>;
  /** Cost of buying x hedge shares against the live book (convex, walks levels). */
  costOfShares: (x: number) => { cashOutUsd: number; avgPrice: number; capacityHit: boolean };
  bankrollUsd: number;
  maxShares: number;
  /** Correlation-uncertainty haircut in [0,1]; 0 for ANALYTIC edges. */
  uncertaintyHaircut?: number;
}

export interface HedgeSize {
  fullKellyShares: number;
  recShares: number; // half-Kelly * (1 - haircut), rounded to executable
  band: [number, number];
  gAtRec: number;
  /** True when the optimum is pinned to the depth ceiling (size is liquidity-bound). */
  capacityLimited: boolean;
}

function expectedLogWealth(
  x: number,
  input: HedgeSizeInput,
): number {
  const { outcomes, heldIndex, heldShares, heldBasisUsd, hedgePaysIn, costOfShares, bankrollUsd } =
    input;
  if (x <= 0) {
    // baseline: no hedge
    let g = 0;
    const cashFloor = bankrollUsd - heldBasisUsd;
    for (let i = 0; i < outcomes.length; i++) {
      const held = i === heldIndex ? heldShares : 0;
      const w = cashFloor + held;
      if (w <= 0) return -Infinity;
      g += outcomes[i].q * Math.log(w);
    }
    return g;
  }
  const cost = costOfShares(x);
  const cashFloor = bankrollUsd - heldBasisUsd - cost.cashOutUsd;
  let g = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const held = i === heldIndex ? heldShares : 0;
    const hedge = hedgePaysIn.has(i) ? x : 0;
    const w = cashFloor + held + hedge;
    if (w <= 0) return -Infinity; // Kelly forbids ruin
    g += outcomes[i].q * Math.log(w);
  }
  return g;
}

export function sizeHedge(input: HedgeSizeInput): HedgeSize {
  const cap = Math.max(0, input.maxShares);
  if (cap <= 0) {
    return {
      fullKellyShares: 0,
      recShares: 0,
      band: [0, 0],
      gAtRec: expectedLogWealth(0, input),
      capacityLimited: true,
    };
  }

  const STEPS = 240;
  let bestX = 0;
  let bestG = expectedLogWealth(0, input);
  for (let s = 1; s <= STEPS; s++) {
    const x = (cap * s) / STEPS;
    const g = expectedLogWealth(x, input);
    if (g > bestG) {
      bestG = g;
      bestX = x;
    }
  }
  // refine around the best grid point
  const span = cap / STEPS;
  const lo = Math.max(0, bestX - span);
  const hi = Math.min(cap, bestX + span);
  for (let s = 0; s <= 40; s++) {
    const x = lo + ((hi - lo) * s) / 40;
    const g = expectedLogWealth(x, input);
    if (g > bestG) {
      bestG = g;
      bestX = x;
    }
  }

  const haircut = Math.min(0.9, Math.max(0, input.uncertaintyHaircut ?? 0));
  const fullKelly = bestX;
  // The optimum is pinned to the ceiling => size is bounded by liquidity, not Kelly.
  const capacityLimited = fullKelly >= cap - span - 1e-9;
  const rec = Math.max(0, fullKelly * 0.5 * (1 - haircut));
  const bandHalf = fullKelly * 0.5 * Math.max(0.1, 0.15 + haircut * 0.5);

  return {
    fullKellyShares: round2(fullKelly),
    recShares: round2(rec),
    band: [round2(Math.max(0, rec - bandHalf)), round2(Math.min(cap, rec + bandHalf))],
    gAtRec: expectedLogWealth(rec, input),
    capacityLimited,
  };
}
