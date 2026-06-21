/**
 * lib/netcost/benefit.ts — what the hedge BUYS, in dollars of risk.
 *
 * Models the user's P&L as a discrete distribution over the mutually-exclusive
 * outcome partition (the 60 teams), each weighted by its de-vigged probability q.
 * Each position/leg pays $1/share in a known SET of winning outcomes; given q the
 * joint distribution is EXACT — no covariance estimation needed (per the spec).
 *
 * All loss metrics are returned as POSITIVE dollar magnitudes so "reduction"
 * is just before - after (positive = good).
 */
import type { PnLPoint, RiskMetrics } from "@/lib/types";
import type { SimDraw } from "@/lib/sim/generator";

export interface Outcome {
  label: string;
  q: number; // de-vigged probability, outcomes sum to 1
}

/** A costed position over the outcome partition. */
export interface PnLLeg {
  shares: number;
  /** Total cash paid for this leg (stake + fee for hedges; sunk basis for the held position). */
  cashOutUsd: number;
  /** Indices of outcomes in which this leg pays $1/share. */
  paysIn: Set<number>;
}

export function pnlDistribution(outcomes: Outcome[], legs: PnLLeg[]): PnLPoint[] {
  const totalCashOut = legs.reduce((s, l) => s + l.cashOutUsd, 0);
  return outcomes.map((o, i) => {
    let terminal = 0;
    for (const leg of legs) if (leg.paysIn.has(i)) terminal += leg.shares;
    return { outcome: o.label, pnl: terminal - totalCashOut, prob: o.q };
  });
}

/** A leg whose payoff is a predicate over a simulated tournament (cross-event legs). */
export interface SimLeg {
  shares: number;
  cashOutUsd: number;
  paysInSim: (d: SimDraw) => boolean;
}

/**
 * P&L distribution over Monte-Carlo draws (each an equiprobable PnLPoint). Lets
 * same-event and cross-event legs live in ONE distribution. `riskMetrics` consumes the
 * result unchanged. With champion-only draws this matches the analytic partition.
 */
export function pnlDistributionSim(draws: SimDraw[], legs: SimLeg[]): PnLPoint[] {
  const totalCashOut = legs.reduce((s, l) => s + l.cashOutUsd, 0);
  const w = draws.length > 0 ? 1 / draws.length : 0;
  return draws.map((d, i) => {
    let terminal = 0;
    for (const leg of legs) if (leg.paysInSim(d)) terminal += leg.shares;
    return { outcome: `sim${i}`, pnl: terminal - totalCashOut, prob: w };
  });
}

export function riskMetrics(dist: PnLPoint[], alpha = 0.1): RiskMetrics {
  if (dist.length === 0) {
    return { stdDev: 0, maxLoss: 0, cvar: 0, pLoss: 0 };
  }
  const mean = dist.reduce((s, d) => s + d.prob * d.pnl, 0);
  const variance = dist.reduce((s, d) => s + d.prob * (d.pnl - mean) ** 2, 0);
  const stdDev = Math.sqrt(Math.max(0, variance));

  const minPnl = Math.min(...dist.map((d) => d.pnl));
  const maxLoss = Math.max(0, -minPnl);

  // CVaR / expected shortfall over the worst alpha-mass tail.
  const sorted = [...dist].sort((a, b) => a.pnl - b.pnl);
  let mass = 0;
  let acc = 0;
  for (const d of sorted) {
    const take = Math.min(d.prob, alpha - mass);
    if (take <= 0) break;
    acc += take * d.pnl;
    mass += take;
    if (mass >= alpha) break;
  }
  const cvarPnl = mass > 0 ? acc / mass : minPnl;
  const cvar = Math.max(0, -cvarPnl);

  const pLoss = dist.reduce((s, d) => s + (d.pnl < -1e-9 ? d.prob : 0), 0);

  return { stdDev, maxLoss, cvar, pLoss };
}

/**
 * The north-star metric (owner 2026-06-17): worst-case loss across ONLY the states where the
 * primary bet FAILS. Probability-free — a pure min over the non-win indices of the distribution.
 * Returned as a POSITIVE dollar magnitude (0 if the worst fail state is non-negative).
 */
export function lossIfPrimaryFails(dist: PnLPoint[], primaryWinIdx: Set<number>): number {
  const fails = dist.filter((_, i) => !primaryWinIdx.has(i));
  if (fails.length === 0) return 0;
  return Math.max(0, -Math.min(...fails.map((d) => d.pnl)));
}

/**
 * Cost of protection: the win-state upside you FORGO to buy the floor — the hedge premium, distinct
 * from execution friction and the vig. Worst B-wins PnL before the hedge minus worst after.
 * Probability-free; a POSITIVE magnitude (0 if the hedge doesn't reduce the win-state payout).
 */
export function costOfProtection(before: PnLPoint[], after: PnLPoint[], primaryWinIdx: Set<number>): number {
  const winBefore = before.filter((_, i) => primaryWinIdx.has(i)).map((d) => d.pnl);
  const winAfter = after.filter((_, i) => primaryWinIdx.has(i)).map((d) => d.pnl);
  if (winBefore.length === 0 || winAfter.length === 0) return 0;
  return Math.max(0, Math.min(...winBefore) - Math.min(...winAfter));
}
