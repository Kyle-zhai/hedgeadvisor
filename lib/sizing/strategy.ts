/**
 * lib/sizing/strategy.ts — generalized multi-leg hedge sizing.
 *
 * Sizes a whole STRATEGY (1..N legs) by a single dollar `scale`, maximizing
 * E[log wealth] over the 60-outcome partition. The caller supplies `legsAtScale`,
 * which converts a dollar budget into costed legs by walking each leg's live book.
 * Same E[log wealth] objective as the single-leg sizer; this is the general form.
 */
import type { Outcome } from "@/lib/netcost";
import { round2 } from "./util";

export interface StrategyLeg {
  shares: number;
  cashOutUsd: number; // stake + fee actually paid
  paysIn: Set<number>; // outcome indices where this leg pays $1/share
}

export interface SizeStrategyInput {
  outcomes: Outcome[];
  heldIndex: number;
  heldShares: number;
  heldBasisUsd: number;
  bankrollUsd: number;
  maxScaleUsd: number; // upper bound on total hedge budget
  uncertaintyHaircut?: number;
  legsAtScale: (scaleUsd: number) => { legs: StrategyLeg[]; capacityHit: boolean };
}

export interface StrategySize {
  fullScaleUsd: number;
  recScaleUsd: number;
  band: [number, number];
  capacityLimited: boolean;
}

function expectedLogWealth(scaleUsd: number, input: SizeStrategyInput): number {
  const { outcomes, heldIndex, heldShares, heldBasisUsd, bankrollUsd } = input;
  const legs = scaleUsd <= 0 ? [] : input.legsAtScale(scaleUsd).legs;
  const cashOut = legs.reduce((s, l) => s + l.cashOutUsd, 0);
  const cashFloor = bankrollUsd - heldBasisUsd - cashOut;
  let g = 0;
  for (let i = 0; i < outcomes.length; i++) {
    let w = cashFloor + (i === heldIndex ? heldShares : 0);
    for (const leg of legs) if (leg.paysIn.has(i)) w += leg.shares;
    if (w <= 0) return -Infinity; // Kelly forbids ruin
    g += outcomes[i].q * Math.log(w);
  }
  return g;
}

export function sizeStrategy(input: SizeStrategyInput): StrategySize {
  const cap = Math.max(0, input.maxScaleUsd);
  if (cap <= 0) {
    return { fullScaleUsd: 0, recScaleUsd: 0, band: [0, 0], capacityLimited: true };
  }
  const STEPS = 200;
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
  const fullScale = bestX;
  const capacityLimited = fullScale >= cap - span - 1e-9;
  const rec = Math.max(0, fullScale * 0.5 * (1 - haircut));
  const bandHalf = fullScale * 0.5 * Math.max(0.1, 0.15 + haircut * 0.5);
  return {
    fullScaleUsd: round2(fullScale),
    recScaleUsd: round2(rec),
    band: [round2(Math.max(0, rec - bandHalf)), round2(Math.min(cap, rec + bandHalf))],
    capacityLimited,
  };
}
