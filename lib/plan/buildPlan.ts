/**
 * lib/plan/buildPlan.ts — assemble a real-market betting plan from a fixture's
 * mutually-exclusive outcomes, a view, a budget and the slider.
 *
 * Honesty backbone: every leg is costed with the CAPPED near-touch walk (no fabricated
 * fills), the payoff table is sorted most-likely-first (usually the loss), the expected
 * value is shown honestly (typically negative — the vig), and a "you lose ~all of it"
 * stat fires when the loss probability is high.
 */
import type {
  Book,
  MarketRef,
  Plan,
  PlanLeg,
  PlanScenario,
  PlanCostBreakdown,
  PlanRiskMetrics,
  PlanAlternative,
} from "@/lib/types";
import { priceLegBudget } from "@/lib/netcost";
import { buildMarketDeepLink } from "@/lib/execute";
import { blendAlloc, sliderToWeight, posture } from "./allocate";

export interface PlanOutcomeInput {
  title: string;
  ref: MarketRef;
  book: Book;
  q: number; // de-vigged, market-implied probability
}
export interface BuildPlanInput {
  fixtureTitle: string;
  betDesc: string;
  outcomes: PlanOutcomeInput[];
  viewIndices: number[]; // outcomes the user backs (e.g. [England] or [England, Draw])
  budgetUsd: number;
  sliderS: number;
  /** Cap how many distinct bets/legs to place. The view is ALWAYS kept; the remaining
   *  slots go to the largest allocations; the budget is then rescaled across the kept legs.
   *  Undefined ⇒ no cap (depth/dust still self-limit on small budgets). */
  maxLegs?: number;
  /** Aggregate every outcome that returns ~nothing into one "Any other …" scenario row,
   *  so a wide partition (e.g. the 17-cell exact-score grid) doesn't print a wall of
   *  identical losing rows. Honest: the merged row carries the summed probability. */
  collapseZeroPayout?: string; // the merged row's label (e.g. "Any other scoreline")
}

/**
 * Keep the view + the largest other allocations, up to `maxLegs`, then rescale the kept
 * dollars back up to the full budget. Concentrating the budget into fewer bets is exactly
 * what "buy N bets" means; rescaling preserves the total the user chose to deploy.
 */
function capLegs(alloc: number[], viewIndices: number[], maxLegs: number, budgetUsd: number): number[] {
  if (!(maxLegs > 0) || maxLegs >= alloc.length) return alloc;
  const keep = new Set<number>(viewIndices.filter((i) => i >= 0 && i < alloc.length));
  alloc
    .map((a, i) => ({ a, i }))
    .filter((x) => !keep.has(x.i) && x.a > 0)
    .sort((x, y) => y.a - x.a)
    .forEach((x) => {
      if (keep.size < maxLegs) keep.add(x.i);
    });
  const kept = alloc.map((a, i) => (keep.has(i) ? a : 0));
  const sum = kept.reduce((s, a) => s + a, 0) || 1;
  return kept.map((a) => (a * budgetUsd) / sum); // rescale to the full budget
}

const usd0 = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const usd2 = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const cents = (p: number) => `${(p * 100).toFixed(1)}¢`;
const r2 = (x: number) => Number(x.toFixed(2));

/** P&L distribution risk (worst-case magnitude + volatility), in USD. */
function riskOf(scenarios: { prob: number; pnlUsd: number }[], ev: number): PlanRiskMetrics {
  const worst = Math.min(...scenarios.map((s) => s.pnlUsd));
  const variance = scenarios.reduce((a, s) => a + s.prob * (s.pnlUsd - ev) ** 2, 0);
  return { maxLossUsd: r2(Math.max(0, -worst)), stdDevUsd: r2(Math.sqrt(Math.max(0, variance))) };
}

/**
 * Honest plan verdict. A constructed bet is ALWAYS EV-negative (the vig), so the verdict
 * never says "GO/edge" — it rates the RISK PROFILE and always treats not-betting as valid.
 */
function planVerdict(pProfit: number, pLoseAll: number): { verdict: "CAUTION" | "HIGH_RISK"; reason: string } {
  if (pProfit < 0.25 || pLoseAll >= 0.6) {
    return { verdict: "HIGH_RISK", reason: "Negative EV after costs, and a high chance you lose most of it. Not betting is a valid choice." };
  }
  return { verdict: "CAUTION", reason: "Negative EV after costs (the vig). The variance is reasonable for the exposure, but not betting is still valid." };
}

/**
 * A standalone single-market bet (exact score, over/under, BTTS, handicap…). We do
 * NOT fold these into the result risk-distribution because the honest joint would need
 * the unresolved score grid (the "Any Other Score" catch-all breaks clean membership).
 * So we present it truthfully as one binary: it happens (prob q) → big payoff, else lose.
 */
export function buildSingleBet(args: {
  fixtureTitle: string;
  betDesc: string;
  ref: MarketRef;
  book: Book;
  q: number; // market-implied (de-vigged) probability it happens
  budgetUsd: number;
  tokenId?: string; // defaults to the YES token
  side?: "buy_yes" | "buy_no"; // "buy_no" for the "under"/NO side of a prop
}): Plan {
  const side = args.side ?? "buy_yes";
  const tokenId = args.tokenId ?? args.ref.tokenIdYes;
  const filled = priceLegBudget(args.ref, side, tokenId, args.book, args.budgetUsd, 3);
  const cost = filled.stakeUsd + filled.takerFeeUsd;
  const payout = filled.shares; // $1/share if it resolves YES
  const q = Math.min(1, Math.max(0, args.q));
  const scenarios: PlanScenario[] = [
    { outcome: `${args.betDesc} happens`, prob: q, payoutUsd: payout, pnlUsd: payout - cost },
    { outcome: `it doesn't`, prob: 1 - q, payoutUsd: 0, pnlUsd: -cost },
  ].sort((a, b) => b.prob - a.prob);
  const ev = scenarios.reduce((s, sc) => s + sc.prob * sc.pnlUsd, 0);
  const pProfit = scenarios.filter((s) => s.pnlUsd > 1e-9).reduce((s, sc) => s + sc.prob, 0);
  const pLoseAll = 1 - q;
  const warnings: string[] = [];
  if (filled.capacityHit) warnings.push(`Only ${usd0(cost)} of your ${usd0(args.budgetUsd)} fills near the touch; this market is thin, capped to what's liquid.`);

  const facts: Record<string, string> = {
    betDesc: args.betDesc,
    posture: "Express",
    deployedUsd: usd0(cost),
    budgetUsd: usd0(args.budgetUsd),
    pProfit: pct(pProfit),
    expectedValueUsd: usd2(ev),
    maxGainUsd: usd0(payout - cost),
    maxLossUsd: usd0(-cost),
    mostLikely: `${scenarios[0].outcome} (${pct(scenarios[0].prob)}) → you ${scenarios[0].pnlUsd >= 0 ? "make" : "lose"} ${usd0(Math.abs(scenarios[0].pnlUsd))}`,
    evNote: "This is a single longshot-style bet. Prediction bets lose money on average (the vig); this expresses your exact pick, it is not an edge.",
  };
  // Fair-value (CLV) honesty line: what the de-vigged market says it's worth vs what you pay.
  const costCents = Math.max(0, (filled.avgFillPrice - q) * 100);
  facts.fairValue = `Fair value ${cents(q)} · you pay ${cents(filled.avgFillPrice)} → ${costCents.toFixed(1)}¢/share is the vig + spread you eat.`;
  if (pLoseAll >= 0.8) facts.loseAllWarning = `About ${pct(pLoseAll)} chance you lose ~all of your ${usd0(cost)}.`;

  const mid = args.book.midpoint;
  const cb: PlanCostBreakdown = {
    fairValueUsd: r2(filled.shares * q),
    spreadUsd: r2(filled.spreadCostUsd),
    slippageUsd: r2(Math.max(0, filled.slippageUsd - filled.spreadCostUsd)),
    takerFeeUsd: r2(filled.takerFeeUsd),
    vigUsd: r2((mid - q) * filled.shares),
  };
  const risk = riskOf(scenarios, ev);
  const verdictInfo = planVerdict(pProfit, pLoseAll);
  const alternatives: PlanAlternative[] = [
    { label: "Don't bet", costUsd: 0, maxLossUsd: 0, pProfit: 0, evUsd: 0, verdict: "NONE", note: "Zero cost, zero risk. Always valid for an EV-negative bet." },
  ];

  return {
    fixtureTitle: args.fixtureTitle,
    betDesc: args.betDesc,
    sliderS: 0,
    posture: "Express",
    legs: [
      {
        ref: args.ref,
        side,
        outcomeTitle: args.betDesc,
        shares: filled.shares,
        avgFillPrice: filled.avgFillPrice,
        fairValue: Number(q.toFixed(4)),
        costUsd: cost,
        limitPrice: Number(filled.worstFillPrice.toFixed(3)),
        deepLink: buildMarketDeepLink(args.ref.eventSlug),
        capacityHit: filled.capacityHit,
      },
    ],
    budgetUsd: args.budgetUsd,
    deployedUsd: Number(cost.toFixed(2)),
    scenarios: scenarios.map((s) => ({
      outcome: s.outcome,
      prob: Number(s.prob.toFixed(3)),
      payoutUsd: Number(s.payoutUsd.toFixed(2)),
      pnlUsd: Number(s.pnlUsd.toFixed(2)),
    })),
    pProfit: Number(pProfit.toFixed(3)),
    pLoseAll: Number(pLoseAll.toFixed(3)),
    expectedValueUsd: Number(ev.toFixed(2)),
    maxGainUsd: Number((payout - cost).toFixed(2)),
    maxLossUsd: Number((-cost).toFixed(2)),
    costBreakdown: cb,
    risk,
    nakedRisk: risk, // a single bet IS all-in on the prop
    maxLossProtectedPct: 0,
    verdict: verdictInfo.verdict,
    verdictReason: verdictInfo.reason,
    alternatives,
    feeRatePct: args.ref.feeRate,
    warnings,
    facts,
  };
}

export function buildPlan(input: BuildPlanInput): Plan {
  const { outcomes, viewIndices, budgetUsd, sliderS, fixtureTitle, betDesc } = input;
  const prices = outcomes.map((o) => o.book.bestAsk);
  const w = sliderToWeight(sliderS);
  let dollarAlloc = blendAlloc(prices, viewIndices, budgetUsd, w);
  // N-legs filter: keep the view + the largest other allocations, up to maxLegs.
  if (input.maxLegs && input.maxLegs > 0) {
    dollarAlloc = capLegs(dollarAlloc, viewIndices, input.maxLegs, budgetUsd);
  }

  const legs: PlanLeg[] = [];
  const sharesByOutcome = outcomes.map(() => 0);
  const warnings: string[] = [];
  const cb: PlanCostBreakdown = { fairValueUsd: 0, spreadUsd: 0, slippageUsd: 0, takerFeeUsd: 0, vigUsd: 0 };
  let deployedUsd = 0;

  outcomes.forEach((o, i) => {
    const alloc = dollarAlloc[i];
    if (alloc <= 0.5) return; // ignore dust allocations
    const filled = priceLegBudget(o.ref, "buy_yes", o.ref.tokenIdYes, o.book, alloc, 3);
    if (filled.shares <= 0) {
      warnings.push(`Skipped ${o.title}: no fillable depth near the touch price.`);
      return;
    }
    const costUsd = filled.stakeUsd + filled.takerFeeUsd;
    deployedUsd += costUsd;
    sharesByOutcome[i] = filled.shares;
    // honest cost decomposition (sums to deployedUsd): fair value + spread + slippage + fee + vig
    cb.fairValueUsd += filled.shares * o.q;
    cb.spreadUsd += filled.spreadCostUsd;
    cb.slippageUsd += Math.max(0, filled.slippageUsd - filled.spreadCostUsd);
    cb.takerFeeUsd += filled.takerFeeUsd;
    cb.vigUsd += (o.book.midpoint - o.q) * filled.shares;
    legs.push({
      ref: o.ref,
      side: "buy_yes",
      outcomeTitle: o.title,
      shares: filled.shares,
      avgFillPrice: filled.avgFillPrice,
      fairValue: Number(o.q.toFixed(4)),
      costUsd,
      limitPrice: Number(filled.worstFillPrice.toFixed(3)),
      deepLink: buildMarketDeepLink(o.ref.eventSlug),
      capacityHit: filled.capacityHit,
    });
    if (filled.capacityHit) {
      warnings.push(`${o.title}: only ${usd0(costUsd)} of the intended ${usd0(alloc)} fills near the touch; capped to what's liquid.`);
    }
  });

  // Scenarios over the mutually-exclusive partition: only the winning outcome's leg pays.
  let scenarios: PlanScenario[] = outcomes.map((o, i) => {
    const payoutUsd = sharesByOutcome[i]; // $1/share if outcome i resolves YES
    return { outcome: o.title, prob: o.q, payoutUsd, pnlUsd: payoutUsd - deployedUsd };
  });
  // Optionally collapse the wall of "pays ~nothing" rows into one honest aggregate row.
  if (input.collapseZeroPayout) {
    const zeroish = (s: PlanScenario) => s.payoutUsd < deployedUsd * 0.05;
    const losers = scenarios.filter(zeroish);
    if (losers.length > 1) {
      const prob = losers.reduce((s, x) => s + x.prob, 0);
      scenarios = scenarios.filter((s) => !zeroish(s));
      scenarios.push({ outcome: input.collapseZeroPayout, prob, payoutUsd: 0, pnlUsd: -deployedUsd });
    }
  }
  scenarios.sort((a, b) => b.prob - a.prob); // most-likely first (honesty)

  const ev = scenarios.reduce((s, sc) => s + sc.prob * sc.pnlUsd, 0);
  const pProfit = scenarios.filter((s) => s.pnlUsd > 1e-9).reduce((s, sc) => s + sc.prob, 0);
  const pLoseAll = scenarios.filter((s) => s.payoutUsd < deployedUsd * 0.05).reduce((s, sc) => s + sc.prob, 0);
  const maxGainUsd = Math.max(...scenarios.map((s) => s.pnlUsd));
  const maxLossUsd = Math.min(...scenarios.map((s) => s.pnlUsd));
  const top = scenarios[0];

  const facts: Record<string, string> = {
    betDesc,
    posture: posture(sliderS),
    deployedUsd: usd0(deployedUsd),
    budgetUsd: usd0(budgetUsd),
    pProfit: pct(pProfit),
    expectedValueUsd: usd2(ev),
    maxGainUsd: usd0(maxGainUsd),
    maxLossUsd: usd0(maxLossUsd),
    mostLikely: `${top.outcome} (${pct(top.prob)}) → you ${top.pnlUsd >= 0 ? "make" : "lose"} ${usd0(Math.abs(top.pnlUsd))}`,
    evNote: "Prediction-market bets are expected to LOSE money on average (the vig). This plan expresses your view; it is not an edge.",
    fairValueNote: "Each leg shows fair value (de-vigged market probability) next to what you pay; the gap is the vig + spread you eat.",
  };
  if (pLoseAll >= 0.8) {
    facts.loseAllWarning = `About ${pct(pLoseAll)} chance you lose ~all of your ${usd0(deployedUsd)}.`;
  }
  // Guaranteed-loss guard (the plan-flow equivalent of NO_GO): if the spread covers so much
  // of the board that you lose in EVERY outcome, that's not a hedge worth making — say so and
  // point at the number-of-bets filter (concentrating on fewer outcomes restores real upside).
  if (maxGainUsd <= 0 && legs.length > 1) {
    facts.guaranteedLossWarning = `This plan buys ~every outcome, so every result is about the same — you lose roughly ${usd2(-maxGainUsd)} to ${usd2(-maxLossUsd)} no matter what (the vig). That's the "Protect" extreme. For a spread with real upside, slide toward Express or cut the Number of bets.`;
    warnings.unshift(facts.guaranteedLossWarning);
  }

  const planRisk = riskOf(scenarios, ev);
  // Baseline = all budget on your pick (no spreading), for an honest risk comparison.
  const vIdx = viewIndices.find((i) => i >= 0 && i < outcomes.length) ?? 0;
  const vq = outcomes[vIdx]?.q ?? 0;
  const vPrice = outcomes[vIdx]?.book.bestAsk || 0.5;
  const nakedShares = vPrice > 0 ? deployedUsd / vPrice : 0;
  const nakedScenarios = [
    { prob: vq, pnlUsd: nakedShares - deployedUsd },
    { prob: 1 - vq, pnlUsd: -deployedUsd },
  ];
  const nakedEv = nakedScenarios.reduce((a, s) => a + s.prob * s.pnlUsd, 0);
  const nakedRisk = riskOf(nakedScenarios, nakedEv);
  const maxLossProtectedPct =
    nakedRisk.maxLossUsd > 0 ? Math.max(0, (nakedRisk.maxLossUsd - planRisk.maxLossUsd) / nakedRisk.maxLossUsd) : 0;
  const verdictInfo = planVerdict(pProfit, pLoseAll);
  const alternatives: PlanAlternative[] = [
    { label: "Don't bet", costUsd: 0, maxLossUsd: 0, pProfit: 0, evUsd: 0, verdict: "NONE", note: "Zero cost, zero risk. Always valid for an EV-negative bet." },
    {
      label: "All-in on your pick",
      costUsd: r2(deployedUsd),
      maxLossUsd: nakedRisk.maxLossUsd,
      pProfit: Number(vq.toFixed(3)),
      evUsd: r2(nakedEv),
      verdict: vq < 0.25 ? "HIGH_RISK" : "CAUTION",
      note: "Maximum upside if your pick wins, maximum variance.",
    },
  ];
  const costBreakdown: PlanCostBreakdown = {
    fairValueUsd: r2(cb.fairValueUsd),
    spreadUsd: r2(cb.spreadUsd),
    slippageUsd: r2(cb.slippageUsd),
    takerFeeUsd: r2(cb.takerFeeUsd),
    vigUsd: r2(cb.vigUsd),
  };

  return {
    fixtureTitle,
    betDesc,
    sliderS,
    posture: posture(sliderS),
    legs,
    budgetUsd,
    deployedUsd: Number(deployedUsd.toFixed(2)),
    scenarios: scenarios.map((s) => ({
      outcome: s.outcome,
      prob: Number(s.prob.toFixed(3)),
      payoutUsd: Number(s.payoutUsd.toFixed(2)),
      pnlUsd: Number(s.pnlUsd.toFixed(2)),
    })),
    pProfit: Number(pProfit.toFixed(3)),
    pLoseAll: Number(pLoseAll.toFixed(3)),
    expectedValueUsd: Number(ev.toFixed(2)),
    maxGainUsd: Number(maxGainUsd.toFixed(2)),
    maxLossUsd: Number(maxLossUsd.toFixed(2)),
    costBreakdown,
    risk: planRisk,
    nakedRisk,
    maxLossProtectedPct: Number(maxLossProtectedPct.toFixed(3)),
    verdict: verdictInfo.verdict,
    verdictReason: verdictInfo.reason,
    alternatives,
    bookOverroundPct: Number((outcomes.reduce((a, o) => a + (o.book.midpoint > 0 ? o.book.midpoint : 0), 0) - 1).toFixed(4)),
    feeRatePct: outcomes[vIdx]?.ref.feeRate ?? 0.03,
    warnings,
    facts,
  };
}
