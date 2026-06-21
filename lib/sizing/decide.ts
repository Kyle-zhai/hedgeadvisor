/**
 * lib/sizing/decide.ts — THE single go/no-go authority. Produces `Decision`.
 *
 * `decideStrategy` evaluates a whole hedge STRATEGY (1..N legs) end-to-end.
 * `decideHedge` is the single-leg convenience wrapper (used by tests).
 *
 * Honesty rules baked in:
 *  - Cost is measured two ways and BOTH are shown: execution friction (out of
 *    pocket beyond mid) AND expected cost = E[P&L_before] - E[P&L_after] (the vig).
 *  - η uses the expected cost on a CVaR (tail) basis with η_min = 3.0 (spec §3.4).
 *  - Never GO if the worst case gets worse, if cost ≥ max-loss removed, or if no
 *    risk is removed. "This hedge isn't worth it" / "can't price this" are
 *    first-class outputs.
 *  - Every within-book hedge carries the NEGATIVE_EV_VIG note.
 */
import type {
  Decision,
  FilledLeg,
  MarketRef,
  PnLPoint,
  ReasonCode,
  RiskMetrics,
  Verdict,
} from "@/lib/types";
import { pnlDistribution, pnlDistributionSim, riskMetrics, type Outcome, type PnLLeg, type SimLeg } from "@/lib/netcost";
import type { SimDraw } from "@/lib/sim/generator";

export interface Strategy {
  key: string;
  label: string; // e.g. "Buy NO on Spain (complement)"
  why: string; // strategy-level plain-language reason
  legs: FilledLeg[];
  paysIn: Set<number>[]; // per-leg outcome sets (same length as legs) — analytic mode
  /** per-leg sim predicates (same length as legs) — used in cross-event SIM mode */
  simPaysIn?: Array<(d: SimDraw) => boolean>;
  band: [number, number]; // size band (USD scale) for display
}

export interface StrategyDecideInput {
  heldRef: MarketRef;
  heldShares: number;
  heldAvgPrice: number;
  heldBasisUsd: number;
  heldIndex: number;
  outcomes: Outcome[];
  strategy: Strategy | null;
  basis?: "maxLoss" | "stdDev" | "cvar";
  etaMin?: number;
  degenerateBook?: boolean;
  positionResolved?: boolean;
  capacityLimited?: boolean;
  /** Cross-event SIM mode: build the P&L distribution over tournament draws instead of
   *  the 60-team partition. The held position pays per `heldPaysInSim`; strategy legs use
   *  `strategy.simPaysIn`. Everything from riskMetrics onward (η, guards, facts) is identical. */
  sim?: { draws: SimDraw[]; heldPaysInSim: (d: SimDraw) => boolean };
}

function mean(dist: PnLPoint[]): number {
  return dist.reduce((s, d) => s + d.prob * d.pnl, 0);
}
function fmtUsd(x: number): string {
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}
function fmtUsd2(x: number): string {
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function legLabel(leg: FilledLeg): string {
  const side = leg.side === "buy_no" ? "NO" : "YES";
  return `${side} ${leg.ref.groupItemTitle ?? leg.ref.question}`;
}

export function decideStrategy(input: StrategyDecideInput): Decision {
  const {
    heldRef,
    heldShares,
    heldAvgPrice,
    heldBasisUsd,
    heldIndex,
    outcomes,
    strategy,
    // North star (REFOCUS P0): the headline verdict rides on the PROBABILITY-FREE worst-case floor,
    // not a q-weighted tail. CVaR/stdDev remain available as labeled secondary context.
    basis = "maxLoss",
    etaMin = 3.0,
    degenerateBook = false,
    positionResolved = false,
    capacityLimited = false,
    sim,
  } = input;

  const heldLeg: PnLLeg = { shares: heldShares, cashOutUsd: heldBasisUsd, paysIn: new Set([heldIndex]) };
  const heldSimLeg: SimLeg = { shares: heldShares, cashOutUsd: heldBasisUsd, paysInSim: sim?.heldPaysInSim ?? (() => false) };
  const distBefore = sim ? pnlDistributionSim(sim.draws, [heldSimLeg]) : pnlDistribution(outcomes, [heldLeg]);
  const riskBefore = riskMetrics(distBefore);
  const meanBefore = mean(distBefore);

  const position = { ref: heldRef, shares: heldShares, avgPrice: heldAvgPrice, stakeUsd: heldBasisUsd };
  const decisionLegs = (s: Strategy | null) => (s ? s.legs.map((leg) => ({ leg, band: s.band })) : []);

  if (positionResolved) {
    return finalize(strategy, {
      verdict: "NO_GO",
      reason: "LEG_RESOLVED",
      position,
      legs: [],
      totalHedgeCostUsd: 0,
      riskBefore,
      riskAfter: riskBefore,
      eta: 0,
      basis,
      extraFacts: {
        headline: "Your position's market has already resolved.",
        detail: "The outcome is fixed; there's nothing left to hedge.",
      },
    });
  }
  if (degenerateBook) {
    return finalize(strategy, {
      verdict: "NO_GO",
      reason: "CANNOT_PRICE",
      position,
      legs: decisionLegs(strategy),
      totalHedgeCostUsd: 0,
      riskBefore,
      riskAfter: riskBefore,
      eta: 0,
      basis,
      extraFacts: {
        headline: "Can't price this hedge right now.",
        detail: "The order book is empty or degenerate; we won't fabricate a fill.",
      },
    });
  }
  if (!strategy || strategy.legs.length === 0 || strategy.legs.every((l) => l.shares <= 0)) {
    return finalize(strategy, {
      verdict: "NO_GO",
      reason: "NO_CORRELATED_LEG",
      position,
      legs: [],
      totalHedgeCostUsd: 0,
      riskBefore,
      riskAfter: riskBefore,
      eta: 0,
      basis,
      extraFacts: {
        headline: "No worthwhile hedge found.",
        detail: "Nothing correlated enough to your position is liquid/cheap enough to be worth it. Holding is rational.",
      },
    });
  }
  if (strategy.legs.some((l) => l.ref.resolved)) {
    return finalize(strategy, {
      verdict: "NO_GO",
      reason: "LEG_RESOLVED",
      position,
      legs: decisionLegs(strategy),
      totalHedgeCostUsd: 0,
      riskBefore,
      riskAfter: riskBefore,
      eta: 0,
      basis,
      extraFacts: {
        headline: "A hedge market in this strategy just resolved.",
        detail: "Re-run for a fresh recommendation.",
      },
    });
  }

  const hedgePnlLegs: PnLLeg[] = strategy.legs.map((leg, i) => ({
    shares: leg.shares,
    cashOutUsd: leg.stakeUsd + leg.takerFeeUsd,
    paysIn: strategy.paysIn[i] ?? new Set<number>(),
  }));
  const distAfter = sim
    ? pnlDistributionSim(sim.draws, [
        heldSimLeg,
        ...strategy.legs.map((leg, i) => ({
          shares: leg.shares,
          cashOutUsd: leg.stakeUsd + leg.takerFeeUsd,
          paysInSim: strategy.simPaysIn?.[i] ?? (() => false),
        })),
      ])
    : pnlDistribution(outcomes, [heldLeg, ...hedgePnlLegs]);
  const riskAfter = riskMetrics(distAfter);
  const meanAfter = mean(distAfter);

  const execFrictionUsd = strategy.legs.reduce((s, l) => s + l.entryCostUsd, 0);
  const expectedCostUsd = Math.max(0, meanBefore - meanAfter);
  const riskRemoved = riskBefore[basis] - riskAfter[basis];
  const maxLossReduction = riskBefore.maxLoss - riskAfter.maxLoss;
  const capacityHit = strategy.legs.some((l) => l.capacityHit);
  // One eta policy: always a finite, comparable ratio. Floor the denominator so a
  // near-free hedge gets a large-but-finite η (no Infinity/999/"∞" sentinel drift).
  const costFloor = Math.max(expectedCostUsd, execFrictionUsd, 0.01);
  const eta = riskRemoved > 0 ? riskRemoved / costFloor : 0;

  let verdict: Verdict;
  let reason: ReasonCode;
  if (riskAfter.maxLoss > riskBefore.maxLoss + 1e-6) {
    verdict = "NO_GO";
    reason = "COST_EXCEEDS_BENEFIT";
  } else if (expectedCostUsd >= maxLossReduction && maxLossReduction > 0) {
    verdict = "NO_GO";
    reason = "COST_EXCEEDS_BENEFIT";
  } else if (riskRemoved <= 0) {
    verdict = "NO_GO";
    reason = "COST_EXCEEDS_BENEFIT";
  } else if (capacityHit) {
    verdict = "PARTIAL";
    reason = "INSUFFICIENT_DEPTH";
  } else if (eta >= etaMin) {
    verdict = "GO";
    reason = "GO";
  } else {
    verdict = "PARTIAL";
    reason = "PARTIAL";
  }

  const noGoDetail =
    riskAfter.maxLoss > riskBefore.maxLoss + 1e-6
      ? "This actually RAISES your worst-case loss: if a team outside this hedge wins (often the most likely outcome), you lose your position AND this bet. It's a directional side bet, not a hedge."
      : "It costs more in expectation than the risk it removes. Holding is the rational move.";

  const stdRedPct = riskBefore.stdDev > 0 ? (riskBefore.stdDev - riskAfter.stdDev) / riskBefore.stdDev : 0;
  const totalShares = strategy.legs.reduce((s, l) => s + l.shares, 0);
  const totalStake = strategy.legs.reduce((s, l) => s + l.stakeUsd, 0);
  const legsDetail = strategy.legs
    .map((l) => `${legLabel(l)}: ${Math.round(l.shares).toLocaleString()} @ ≤${l.worstFillPrice.toFixed(3)}`)
    .join(" · ");

  return finalize(strategy, {
    verdict,
    reason,
    position,
    legs: decisionLegs(strategy),
    totalHedgeCostUsd: execFrictionUsd,
    riskBefore,
    riskAfter,
    eta: Number(eta.toFixed(2)),
    basis,
    extraFacts: {
      headline: verdictHeadline(verdict, strategy),
      ...(verdict === "NO_GO" ? { detail: noGoDetail } : {}),
      hedgeDesc: strategy.label,
      legsDetail,
      hedgeShares: Math.round(totalShares).toLocaleString("en-US"),
      limitPriceHint: strategy.legs[0].worstFillPrice.toFixed(3),
      stakeUsd: fmtUsd(totalStake),
      execCostUsd: fmtUsd2(execFrictionUsd),
      expectedCostUsd: fmtUsd2(expectedCostUsd),
      maxLossBefore: fmtUsd(riskBefore.maxLoss),
      maxLossAfter: fmtUsd(riskAfter.maxLoss),
      maxLossReduction: fmtUsd(maxLossReduction),
      stdDevBefore: fmtUsd(riskBefore.stdDev),
      stdDevAfter: fmtUsd(riskAfter.stdDev),
      stdDevReductionPct: fmtPct(stdRedPct),
      eta: eta.toFixed(1),
      corrWhy: strategy.why,
      vigNote:
        "Hedging within the same book is EV-negative after the spread, fee and vig. It buys variance reduction, not profit.",
      makerTip:
        "Posting limit orders (maker) instead of market orders pays ~0 fee and skips the spread, but may not fill before kickoff.",
      ...(capacityLimited
        ? {
            sizeNote:
              "This size is capped by book depth, not by the risk-optimal target; the ideal hedge is larger but can't fill at this price. We sized to what's actually liquid.",
          }
        : {}),
    },
  });
}

function verdictHeadline(verdict: Verdict, strategy: Strategy): string {
  if (verdict === "GO") return `Hedge recommended: ${strategy.label}.`;
  if (verdict === "PARTIAL") return `${strategy.label}: a smaller size clears the bar; full size doesn't.`;
  return `${strategy.label}: not worth it.`;
}

function finalize(
  strategy: Strategy | null,
  d: {
    verdict: Verdict;
    reason: ReasonCode;
    position: Decision["position"];
    legs: Decision["legs"];
    totalHedgeCostUsd: number;
    riskBefore: RiskMetrics;
    riskAfter: RiskMetrics;
    eta: number;
    basis: "maxLoss" | "stdDev" | "cvar";
    extraFacts: Record<string, string>;
  },
): Decision {
  const facts: Record<string, string> = {
    verdict: d.verdict,
    reason: d.reason,
    strategyKey: strategy?.key ?? "none",
    strategyLabel: strategy?.label ?? "n/a",
    positionDesc: `${d.position.shares.toLocaleString("en-US", { maximumFractionDigits: 0 })} × ${d.position.ref.groupItemTitle ?? d.position.ref.question} @ ${d.position.avgPrice.toFixed(3)}`,
    positionStakeUsd: `$${d.position.stakeUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    ...d.extraFacts,
  };
  return {
    verdict: d.verdict,
    reason: d.reason,
    position: d.position,
    legs: d.legs,
    totalHedgeCostUsd: Number(d.totalHedgeCostUsd.toFixed(2)),
    riskBefore: d.riskBefore,
    riskAfter: d.riskAfter,
    eta: d.eta,
    basis: d.basis,
    facts,
  };
}

// ── single-leg convenience wrapper (keeps the original API + tests intact) ──
export interface DecideInput {
  heldRef: MarketRef;
  heldShares: number;
  heldAvgPrice: number;
  heldBasisUsd: number;
  heldIndex: number;
  outcomes: Outcome[];
  hedge: { leg: FilledLeg; paysIn: Set<number>; band: [number, number] } | null;
  basis?: "maxLoss" | "stdDev" | "cvar";
  etaMin?: number;
  degenerateBook?: boolean;
  positionResolved?: boolean;
  capacityLimited?: boolean;
}

export function decideHedge(input: DecideInput): Decision {
  const strategy: Strategy | null = input.hedge
    ? {
        key: "complement",
        label: `${input.hedge.leg.side === "buy_no" ? "Buy NO" : "Buy YES"} · ${input.hedge.leg.ref.groupItemTitle ?? input.hedge.leg.ref.question}`,
        why: input.hedge.leg.corr?.why ?? "",
        legs: [input.hedge.leg],
        paysIn: [input.hedge.paysIn],
        band: input.hedge.band,
      }
    : null;
  return decideStrategy({
    heldRef: input.heldRef,
    heldShares: input.heldShares,
    heldAvgPrice: input.heldAvgPrice,
    heldBasisUsd: input.heldBasisUsd,
    heldIndex: input.heldIndex,
    outcomes: input.outcomes,
    strategy,
    basis: input.basis,
    etaMin: input.etaMin,
    degenerateBook: input.degenerateBook,
    positionResolved: input.positionResolved,
    capacityLimited: input.capacityLimited,
  });
}
