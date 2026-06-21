/**
 * lib/types.ts — THE single contract.
 *
 * Every module imports from here. Per the spec's consistency review, the two
 * cardinal rules are:
 *   1) ONE fee function (lib/netcost/fee.ts) — nobody re-derives it.
 *   2) ONE go/no-go authority (lib/sizing/decide.ts) — produces `Decision`.
 *
 * Units that bite (per adversarial review):
 *   - Order book `size` is in SHARES (number), parsed from strings at the data boundary.
 *   - Depth gates compare DOLLARS to DOLLARS (use notionalDepth()).
 *   - All prices are probabilities in [0,1].
 */

export type Price = number; // 0..1
export type TokenId = string;

/** One level of an order book. price in [0,1], size in SHARES. */
export interface OrderLevel {
  price: Price;
  size: number;
}

/**
 * A normalized order book. ⚠️ Polymarket returns bids ASCENDING and asks
 * DESCENDING (opposite of its own docs). After normalizeBook():
 *   - bids: DESCENDING  (bids[0] = best bid = highest)
 *   - asks: ASCENDING   (asks[0] = best ask = lowest)
 */
export interface Book {
  bids: OrderLevel[];
  asks: OrderLevel[];
  midpoint: Price;
  bestBid: Price;
  bestAsk: Price;
  tokenId: TokenId;
}

/** Sum of price*size over one side, in dollars. */
export function notionalDepth(levels: OrderLevel[]): number {
  return levels.reduce((s, l) => s + l.price * l.size, 0);
}

/**
 * A resolved reference to a single tradable outcome market.
 * Carries the per-market fee fields all the way through — they must NOT be
 * dropped downstream (the net-cost engine needs them).
 */
export interface MarketRef {
  conditionId: string;
  eventId: string;
  eventSlug: string;
  question: string;
  groupItemTitle: string | null; // e.g. "Spain"
  tokenIdYes: TokenId;
  tokenIdNo: TokenId;
  midpointYes: Price; // last known YES midpoint (display only; never used for fills)
  resolved: boolean;
  resolvedAtMs?: number | null; // venue close/resolution time (epoch ms), for leakage-safe walk-forward ordering
  // Fee schedule, threaded from lib/data so the net-cost engine never guesses:
  feeRate: number; // 0.03 for sports
  feeExponent: number; // 1
  feeTakerOnly: boolean; // true
  negRiskMarketId: string | null; // shared across a mutually-exclusive set
}

/** The result of walking a book to fill a target size. */
export interface FillResult {
  filledShares: number;
  unfilledShares: number;
  avgFillPrice: Price | null;
  worstFillPrice: Price | null;
  notionalSpent: number;
  midpoint: Price;
  slippagePerShare: number | null; // avgFill - midpoint
  slippageUsd: number; // (avgFill - midpoint) * filledShares
  capacityHit: boolean; // size > available depth (within the price band, for capped walks)
  /** For capped (near-touch) walks: USD that actually cleared within the price band. */
  fillableUsd?: number;
}

/** A priced hedge leg: the deterministic engine's atomic costed unit. */
export interface FilledLeg {
  ref: MarketRef;
  side: "buy_yes" | "buy_no";
  tokenId: TokenId;
  shares: number;
  avgFillPrice: Price;
  worstFillPrice: Price;
  slippageUsd: number;
  spreadCostUsd: number; // (bestAsk - mid) * shares
  takerFeeUsd: number;
  entryCostUsd: number; // execution premium over mid + fee
  stakeUsd: number; // shares * avgFillPrice (capital deployed)
  capacityHit: boolean;
  /** Structural correlation of this leg to the held position, with provenance. */
  corr?: CorrelationEdge;
}

/** A single P&L outcome with its (de-vigged) probability. */
export interface PnLPoint {
  outcome: string; // the team that wins (the resolving outcome label)
  pnl: number;
  prob: number;
}

export interface RiskMetrics {
  stdDev: number;
  maxLoss: number;
  cvar: number; // expected shortfall in the worst tail
  pLoss: number; // P(P&L < 0)
}

export type CorrRule =
  | "EXCLUSIVE"
  | "SUBSET"
  | "LADDER"
  | "SIBLING"
  | "MATCH"
  | "FACTOR"
  | "CROSS_EVENT";

export type CorrProvenance = "ANALYTIC" | "PRIOR";

/** A signed, magnitude-tagged, explainable correlation between two markets. */
export interface CorrelationEdge {
  fromTitle: string;
  toTitle: string;
  rho: number;
  rule: CorrRule;
  provenance: CorrProvenance;
  band: [number, number]; // [rho_lo, rho_hi]
  why: string; // the plain-language reason the rule produced this rho
}

export type ReasonCode =
  | "GO"
  | "PARTIAL"
  | "COST_EXCEEDS_BENEFIT"
  | "NEGATIVE_EV_VIG"
  | "INSUFFICIENT_DEPTH"
  | "NO_CORRELATED_LEG"
  | "LEG_RESOLVED"
  | "CANNOT_PRICE";

export type Verdict = "GO" | "PARTIAL" | "NO_GO";

// ── Bet-plan flow (pick a real bet → adjustable budget → slider → plan) ──

export interface PlanLeg {
  ref: MarketRef;
  side: "buy_yes" | "buy_no";
  outcomeTitle: string; // "England" | "Draw" | "Croatia"
  shares: number;
  avgFillPrice: Price; // what you actually pay per share (book walked to the near touch)
  fairValue: Price; // de-vigged market-implied probability = the "fair" per-$1 price
  costUsd: number;
  limitPrice: Price; // protective limit to type on Polymarket (worst near-touch fill)
  deepLink: string; // Polymarket event page for this leg
  capacityHit: boolean; // budget for this leg couldn't fill within the near-touch band
}

export interface PlanScenario {
  outcome: string;
  prob: number; // de-vigged, market-implied
  payoutUsd: number; // what the plan pays in this outcome
  pnlUsd: number; // payout − total deployed
}

/** Where the money goes, decomposed so it sums to deployedUsd (honest cost accounting). */
export interface PlanCostBreakdown {
  fairValueUsd: number; // de-vigged value of what you bought (Σ shares·q)
  spreadUsd: number; // half-spread paid (bestAsk − mid)
  slippageUsd: number; // walking past best ask (avgFill − bestAsk)
  takerFeeUsd: number; // Polymarket taker fee
  vigUsd: number; // the market's overround (mid − fair)
}

/** Distribution risk for a plan (magnitudes, USD). */
export interface PlanRiskMetrics {
  maxLossUsd: number; // worst-case loss magnitude
  stdDevUsd: number; // P&L volatility
}

/** A ranked alternative to the current plan (incl. the always-valid "Don't bet"). */
export interface PlanAlternative {
  label: string;
  costUsd: number;
  maxLossUsd: number;
  pProfit: number;
  evUsd: number;
  verdict: "CAUTION" | "HIGH_RISK" | "NONE";
  note: string;
}

/** A complete, real-market betting plan. Produced by lib/plan/buildPlan.ts. */
export interface Plan {
  fixtureTitle: string;
  betDesc: string; // e.g. "England to beat Croatia"
  sliderS: number; // 0..1 (v1 ships 0.4..1.0)
  posture: "Express" | "Balanced" | "Protect";
  legs: PlanLeg[];
  budgetUsd: number;
  deployedUsd: number; // may be < budget if depth-gated
  scenarios: PlanScenario[]; // sorted by prob DESC (most-likely/losing first — honesty)
  pProfit: number; // P(P&L > 0)
  pLoseAll: number; // P(P&L ≈ −deployed)
  expectedValueUsd: number; // honest, typically NEGATIVE (vig)
  maxGainUsd: number;
  maxLossUsd: number;
  // ── dashboard metrics (all from real data) ──
  costBreakdown: PlanCostBreakdown;
  risk: PlanRiskMetrics; // this plan's risk
  nakedRisk: PlanRiskMetrics; // baseline: all budget on your pick (no spreading)
  maxLossProtectedPct: number; // (naked.maxLoss − plan.maxLoss) / naked.maxLoss
  verdict: "CAUTION" | "HIGH_RISK"; // never GO — a bet is EV-negative; this rates the risk profile
  verdictReason: string;
  alternatives: PlanAlternative[]; // ranked, includes "Don't bet"
  bookOverroundPct?: number; // the market's overround (Σ mid − 1), for the safety panel
  feeRatePct?: number; // taker fee rate on these markets (e.g. 0.03)
  warnings: string[]; // depth-gated legs, etc.
  facts: Record<string, string>; // honesty strings for the explanation/guardrail layer
}

/** The ONE decision object. Produced only by lib/sizing/decide.ts. */
export interface Decision {
  verdict: Verdict;
  reason: ReasonCode;
  position: {
    ref: MarketRef;
    shares: number;
    avgPrice: Price;
    stakeUsd: number;
  };
  legs: Array<{
    leg: FilledLeg;
    band: [number, number]; // strategy size sensitivity band (USD scale), shared across the strategy's legs
  }>;
  totalHedgeCostUsd: number;
  riskBefore: RiskMetrics;
  riskAfter: RiskMetrics;
  eta: number; // risk removed ($) per $ of cost, on the chosen basis
  basis: "maxLoss" | "stdDev" | "cvar";
  /** Pre-formatted strings for the LLM/template layer. Built by ONE formatter. */
  facts: Record<string, string>;
}
