/**
 * lib/hedge/cvar.ts — joint-scenario CVaR multi-leg optimizer (the probability-WEIGHTED companion
 * to the probability-free maximin).
 *
 * The maximin minimizes the absolute WORST case (no probabilities). CVaR_α minimizes the expected
 * loss in the worst α-tail of the JOINT scenario distribution — using the de-vigged outcome
 * probabilities q_i as the scenario weights. Same hard win-floor budget cap (Σ spend ≤ (1−k)·G), so
 * a CVaR hedge never eats more than (1−k) of the winnings. Honesty note: this layer DOES use
 * market-implied probabilities, so its outputs are labeled "market-implied, not a forecast".
 *
 * Objective is convex in the allocations; we descend it with the same greedy water-fill the maximin
 * uses (add the next dollar to the leg that most reduces CVaR), which converges to the optimum.
 */
import type { PnLPoint } from "@/lib/types";
import { riskMetrics } from "@/lib/netcost";
import type { MaximinLeg } from "./maximin";

export interface CvarInput {
  states: string[];
  stateProbs: number[]; // de-vigged P(state i); should sum ≈ 1
  primaryWinIdx: number[];
  stakeUsd: number;
  primaryPrice: number; // payout = stake / price
  legs: MaximinLeg[];
  keepFraction: number; // k ∈ [0,1); budget = (1−k)·G
  alpha?: number; // tail mass (default 0.1 ⇒ worst-10% CVaR)
  steps?: number;
}

export interface CvarResult {
  alpha: number;
  budgetUsd: number;
  spendUsd: number;
  allocUsd: Record<string, number>;
  cvarBeforeUsd: number; // CVaR of the un-hedged position (positive magnitude)
  cvarAfterUsd: number; // CVaR after the optimal allocation
  cvarReductionPct: number; // (before − after) / before
  keepIfWinUsd: number; // worst PnL across B-wins states after the hedge
  lossIfFailUsd: number; // worst PnL magnitude across B-fails states after the hedge
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Per-state PnL distribution for a given allocation (alloc in USD per leg id). */
function pnlDist(input: CvarInput, alloc: Map<string, number>): PnLPoint[] {
  const price = clamp01(input.primaryPrice);
  const heldShares = price > 1e-9 ? input.stakeUsd / price : 0;
  const winSet = new Set(input.primaryWinIdx);
  let spend = 0;
  for (const v of alloc.values()) spend += v;
  return input.states.map((label, i) => {
    let pay = winSet.has(i) ? heldShares : 0;
    for (const leg of input.legs) {
      if (leg.paysIn.has(i)) pay += (alloc.get(leg.id) ?? 0) / Math.max(1e-9, leg.price);
    }
    return { outcome: label, pnl: pay - (input.stakeUsd + spend), prob: Math.max(0, input.stateProbs[i] ?? 0) };
  });
}

function cvarOf(input: CvarInput, alloc: Map<string, number>, alpha: number): number {
  return riskMetrics(pnlDist(input, alloc), alpha).cvar;
}

export function solveCvar(input: CvarInput): CvarResult {
  const alpha = input.alpha ?? 0.1;
  const steps = Math.max(50, input.steps ?? 400);
  const k = clamp01(input.keepFraction);
  const price = clamp01(input.primaryPrice);
  const payout = price > 1e-9 ? input.stakeUsd / price : 0;
  const profit = Math.max(0, payout - input.stakeUsd);
  const budget = Math.max(0, (1 - k) * profit);

  const legs = input.legs.filter((l) => l.price > 1e-9 && l.paysIn.size > 0);
  const alloc = new Map<string, number>(legs.map((l) => [l.id, 0]));

  const cvarBefore = cvarOf(input, alloc, alpha);

  if (budget > 1e-9 && legs.length > 0) {
    const dEps = budget / steps;
    let spent = 0;
    while (spent < budget - 1e-9) {
      // add the next increment to the leg that most reduces CVaR (greedy convex descent)
      let bestLeg: string | null = null;
      let bestCvar = Infinity;
      for (const leg of legs) {
        alloc.set(leg.id, (alloc.get(leg.id) ?? 0) + dEps);
        const c = cvarOf(input, alloc, alpha);
        alloc.set(leg.id, (alloc.get(leg.id) ?? 0) - dEps);
        if (c < bestCvar) {
          bestCvar = c;
          bestLeg = leg.id;
        }
      }
      // stop if no leg strictly reduces CVaR (don't waste budget making the tail worse/flat)
      const current = cvarOf(input, alloc, alpha);
      if (bestLeg === null || bestCvar >= current - 1e-9) break;
      alloc.set(bestLeg, (alloc.get(bestLeg) ?? 0) + dEps);
      spent += dEps;
    }
  }

  const finalDist = pnlDist(input, alloc);
  const winSet = new Set(input.primaryWinIdx);
  const winPnls = finalDist.filter((_, i) => winSet.has(i)).map((d) => d.pnl);
  const failPnls = finalDist.filter((_, i) => !winSet.has(i)).map((d) => d.pnl);
  const cvarAfter = riskMetrics(finalDist, alpha).cvar;
  let spendUsd = 0;
  const allocUsd: Record<string, number> = {};
  for (const [id, v] of alloc) {
    if (v > 1e-9) allocUsd[id] = Number(v.toFixed(2));
    spendUsd += v;
  }

  return {
    alpha,
    budgetUsd: Number(budget.toFixed(2)),
    spendUsd: Number(spendUsd.toFixed(2)),
    allocUsd,
    cvarBeforeUsd: Number(cvarBefore.toFixed(2)),
    cvarAfterUsd: Number(cvarAfter.toFixed(2)),
    cvarReductionPct: cvarBefore > 1e-9 ? Number(((cvarBefore - cvarAfter) / cvarBefore).toFixed(4)) : 0,
    keepIfWinUsd: Number((winPnls.length ? Math.min(...winPnls) : 0).toFixed(2)),
    lossIfFailUsd: Number((failPnls.length ? Math.max(0, -Math.min(...failPnls)) : 0).toFixed(2)),
  };
}
