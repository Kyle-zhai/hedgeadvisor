/**
 * lib/pipeline.ts — the end-to-end critical path, now producing a RANKED MENU of
 * hedge strategies (each costed at the real executable price, sized by half-Kelly,
 * and explained), not just one.
 *
 * Strategies evaluated (all within the single negRisk Winner event):
 *   1. complement  — buy the held team's OWN NO. Broad: covers every loss outcome. corr -1.
 *   2. rival-basket — buy YES on the top-3 rivals. Covers the likeliest ways you lose.
 *   3. top-rival   — buy YES on the single biggest threat. Most surgical / cheapest.
 *
 * Each is run through the SAME net-cost + sizing + one-verdict engine and ranked by
 * verdict then efficiency (η). "Don't bother" stays a first-class per-option answer.
 */
import type { Book, Decision, MarketRef, TokenId } from "@/lib/types";
import { notionalDepth } from "@/lib/types";
import {
  resolvePosition,
  fetchBooks,
  fetchMidpoints,
  buildOutcomes,
  topRivals,
  resolveBet,
  resolveExactScoreGrid,
  resolvePropMarket,
  resolveAnyPosition,
  fetchEventBundle,
  tokenSetScore,
  type EventBundle,
} from "@/lib/polymarket";
import { bandDepthUsd } from "@/lib/netcost";
import { simulate, buildLadderPmf, ROUND_OUT_BEFORE_FINAL, type SimDraw } from "@/lib/sim/generator";
import { devigDetailed, type DevigResult } from "@/lib/correlation";

/** Human-readable label for the de-vig method actually applied (a trust feature). */
function devigLabel(dv: DevigResult): string {
  if (dv.method === "shin") return `Shin (insider z=${(dv.param * 100).toFixed(1)}%)`;
  if (dv.method === "power") return `Power (k=${dv.param.toFixed(2)})`;
  return "Proportional";
}
import { buildPlan, buildSingleBet, type PlanOutcomeInput } from "@/lib/plan";
import type { Plan } from "@/lib/types";
import { priceLegBudget, walkBookBuyBudgetCapped, takerFeeUsd, type Outcome } from "@/lib/netcost";
import { complementEdge, rivalEdge } from "@/lib/correlation";
import { sizeStrategy, decideStrategy, type Strategy, type StrategyLeg } from "@/lib/sizing";
import { explain, explainTemplate } from "@/lib/explain";
import { buildPlacementCards, buildMarketDeepLink, type PlacementCard } from "@/lib/execute";
import { buildCombo, detectStructuralJoint, sharesEntity, type PricedComboLeg, type ComboResult, type StructLeg } from "@/lib/combo";
import { marginalBand, jointAllHit } from "@/lib/estimate";

const DEFAULT_SLUG = process.env.HEDGE_DEFAULT_EVENT_SLUG ?? "world-cup-winner";

export interface HedgeRequest {
  query: string;
  eventSlug?: string;
  stakeUsd?: number;
  shares?: number;
  avgPrice?: number;
  bankrollUsd?: number;
}

export interface HedgeOption {
  decision: Decision;
  explanation: string;
  placementCards: PlacementCard[];
}

export interface HedgeResponse {
  status: "ok" | "ambiguous" | "not_found";
  eventTitle?: string;
  positionTitle?: string;
  candidates?: { title: string; score: number }[];
  suggestions?: string[];
  options?: HedgeOption[]; // ranked: best first
  decision?: Decision; // = recommended (options[0]) for back-compat
  explanation?: { text: string; source: "llm" | "template" };
  placementCards?: PlacementCard[];
  rivals?: { title: string; q: number }[];
  meta?: {
    outcomes: number;
    overroundPct: number;
    noBookDepthShares: number;
    pricesSource: "live" | "snapshot"; // de-vig priced off live CLOB midpoints vs the Gamma snapshot
    pricedAt: string; // ISO timestamp of the price snapshot used
    bankrollUsd: number; // bankroll used for Kelly sizing
    bankrollAssumed: boolean; // true => defaulted (position assumed ~20% of bankroll), not user-supplied
    deVig?: string; // de-vig method applied (Shin / power / proportional) for the partition
  };
}

interface LegDef {
  ref: MarketRef;
  side: "buy_yes" | "buy_no";
  tokenId: TokenId;
  book: Book;
  weight: number; // share of the total scale budget
  paysIn: Set<number>;
}
interface StratDef {
  key: string;
  label: string;
  why: string;
  legs: LegDef[];
}

function depthUsd(book: Book): number {
  return notionalDepth(book.asks);
}

/** Verdict rank for sorting: GO(0) < PARTIAL(1) < NO_GO(2); ties broken by higher η. */
function rankKey(d: Decision): [number, number] {
  const order = d.verdict === "GO" ? 0 : d.verdict === "PARTIAL" ? 1 : 2;
  return [order, -d.eta];
}

export async function runHedge(req: HedgeRequest): Promise<HedgeResponse> {
  // Cross-domain by default: resolve the position to ANY live negRisk event (politics,
  // macro, crypto, sports). A pinned eventSlug forces a specific event. Falls back to the
  // World Cup event for backward-compatibility if the generic resolver finds nothing.
  let resolved = req.eventSlug
    ? await resolvePosition(req.query, req.eventSlug)
    : await resolveAnyPosition(req.query);
  if (resolved.kind === "not_found" && !req.eventSlug) {
    const wc = await resolvePosition(req.query, DEFAULT_SLUG);
    if (wc.kind !== "not_found") resolved = wc;
  }
  if (resolved.kind === "not_found") return { status: "not_found", suggestions: resolved.suggestions };
  if (resolved.kind === "ambiguous") {
    return {
      status: "ambiguous",
      eventTitle: resolved.bundle.title,
      candidates: resolved.candidates.map((c) => ({ title: c.title, score: Number(c.score.toFixed(2)) })),
    };
  }

  const bundle: EventBundle = resolved.bundle;
  const heldIndex = resolved.index;
  const heldRef = bundle.markets[heldIndex];

  // ── Precision: de-vig off FRESH live CLOB midpoints, not the Gamma snapshot ──
  // Makes q (and every risk metric) current and consistent with the books the
  // hedge is actually walked against. Falls back to the snapshot on any miss.
  let pricesSource: "live" | "snapshot" = "snapshot";
  try {
    const mids = await fetchMidpoints(bundle.markets.map((m) => m.tokenIdYes));
    if (mids.size > 0) {
      for (const m of bundle.markets) {
        const mid = mids.get(m.tokenIdYes);
        if (mid !== undefined) m.midpointYes = mid;
      }
      bundle.yesPrices = bundle.markets.map((m) => m.midpointYes);
      pricesSource = "live";
    }
  } catch {
    /* keep the Gamma snapshot */
  }
  const pricedAt = new Date().toISOString();

  const outcomes: Outcome[] = buildOutcomes(bundle);
  const heldTitle = heldRef.groupItemTitle ?? heldRef.question;

  const avgPrice = req.avgPrice ?? (heldRef.midpointYes || 0.1);
  const heldShares = req.shares ?? (req.stakeUsd ? req.stakeUsd / Math.max(avgPrice, 1e-6) : 0);
  const heldBasisUsd = req.stakeUsd ?? heldShares * avgPrice;
  const bankrollAssumed = req.bankrollUsd === undefined;
  const bankrollUsd = req.bankrollUsd ?? Math.max(heldBasisUsd * 5, 100);
  const overroundPct = bundle.yesPrices.reduce((a, b) => a + b, 0) - 1;

  const rivals = topRivals(bundle, heldIndex, outcomes, 3);
  const rivalSummary = rivals.map((r) => ({ title: r.ref.groupItemTitle ?? r.ref.question, q: Number(r.q.toFixed(3)) }));

  const baseMeta = {
    outcomes: outcomes.length,
    overroundPct: Number(overroundPct.toFixed(4)),
    noBookDepthShares: 0,
    pricesSource,
    pricedAt,
    bankrollUsd: Math.round(bankrollUsd),
    bankrollAssumed,
    deVig: devigLabel(devigDetailed(bundle.yesPrices)),
  };

  // ── Resolved position short-circuit ──
  if (heldRef.resolved) {
    const decision = decideStrategy({
      heldRef,
      heldShares,
      heldAvgPrice: avgPrice,
      heldBasisUsd,
      heldIndex,
      outcomes,
      strategy: null,
      positionResolved: true,
    });
    const opt: HedgeOption = { decision, explanation: explainTemplate(decision), placementCards: [] };
    return {
      status: "ok",
      eventTitle: bundle.title,
      positionTitle: heldTitle,
      options: [opt],
      decision,
      explanation: await explain(decision),
      placementCards: [],
      rivals: rivalSummary,
      meta: baseMeta,
    };
  }

  // ── Fetch every book we might need in one batch ──
  const tokens: TokenId[] = [heldRef.tokenIdNo, ...rivals.map((r) => r.ref.tokenIdYes)];
  const books = await fetchBooks(tokens);
  const noBook = books.get(heldRef.tokenIdNo);
  baseMeta.noBookDepthShares = noBook ? Math.round(noBook.asks.reduce((s, l) => s + l.size, 0)) : 0;

  const allExceptHeld = new Set<number>();
  outcomes.forEach((_, i) => {
    if (i !== heldIndex) allExceptHeld.add(i);
  });

  // ── Strategy definitions (only those whose books priced) ──
  const defs: StratDef[] = [];

  if (noBook) {
    defs.push({
      key: "complement",
      label: `Buy NO · ${heldTitle}`,
      why: complementEdge(heldTitle).why,
      legs: [{ ref: heldRef, side: "buy_no", tokenId: heldRef.tokenIdNo, book: noBook, weight: 1, paysIn: allExceptHeld }],
    });
  }

  const rivalLegs = rivals
    .map((r) => ({ r, book: books.get(r.ref.tokenIdYes) }))
    .filter((x): x is { r: (typeof rivals)[number]; book: Book } => Boolean(x.book));

  if (rivalLegs.length >= 2) {
    const qsum = rivalLegs.reduce((s, x) => s + x.r.q, 0) || 1;
    const names = rivalLegs.map((x) => x.r.ref.groupItemTitle ?? x.r.ref.question);
    defs.push({
      key: "rival-basket",
      label: `Buy YES · ${names.join(" + ")}`,
      why: `Covers the most likely teams to beat you (${names.join(", ")}). Each leg pays if that team wins — the branches where ${heldTitle} most likely loses. It leaves rarer upsets uncovered, so it removes less worst-case risk than the broad NO hedge, but it's cheaper and more targeted.`,
      legs: rivalLegs.map((x) => ({
        ref: x.r.ref,
        side: "buy_yes" as const,
        tokenId: x.r.ref.tokenIdYes,
        book: x.book,
        weight: x.r.q / qsum,
        paysIn: new Set<number>([x.r.index]),
      })),
    });
  }

  if (rivalLegs.length >= 1) {
    const top = rivalLegs[0];
    const name = top.r.ref.groupItemTitle ?? top.r.ref.question;
    defs.push({
      key: "top-rival",
      label: `Buy YES · ${name}`,
      why: `A targeted bet that your single biggest threat (${name}) wins. Cheapest of the options, but it only covers the one branch where ${name} beats you — not other upsets.`,
      legs: [{ ref: top.r.ref, side: "buy_yes", tokenId: top.r.ref.tokenIdYes, book: top.book, weight: 1, paysIn: new Set<number>([top.r.index]) }],
    });
  }

  // ── Evaluate each within-event strategy through the same engine ──
  const evaluated = defs.map((def) => evaluateStrategy(def, { outcomes, heldRef, heldIndex, heldShares, heldAvgPrice: avgPrice, heldBasisUsd, bankrollUsd, heldTitle }));

  // ── Cross-event option (structural MC): the held outcome's containment-rung NO, when liquid ──
  const crossEvent = await crossEventLadderHedge({
    heldRef,
    heldTitle,
    heldShares,
    heldBasisUsd,
    bankrollUsd,
    champQ: outcomes.map((o) => o.q),
    heldIndex,
    heldAvgPrice: avgPrice,
  });
  if (crossEvent) evaluated.push(crossEvent);

  // If nothing could even be built (all books degenerate), emit one honest CANNOT_PRICE option.
  if (evaluated.length === 0) {
    const decision = decideStrategy({
      heldRef,
      heldShares,
      heldAvgPrice: avgPrice,
      heldBasisUsd,
      heldIndex,
      outcomes,
      strategy: null,
      degenerateBook: true,
    });
    evaluated.push(decision);
  }

  evaluated.sort((a, b) => {
    const [ao, ae] = rankKey(a);
    const [bo, be] = rankKey(b);
    return ao - bo || ae - be;
  });

  const options: HedgeOption[] = evaluated.map((decision) => ({
    decision,
    explanation: explainTemplate(decision),
    placementCards: decision.verdict === "NO_GO" ? [] : buildPlacementCards(decision),
  }));

  const recommended = options[0];

  return {
    status: "ok",
    eventTitle: bundle.title,
    positionTitle: heldTitle,
    options,
    decision: recommended.decision,
    explanation: await explain(recommended.decision), // LLM polish only for the top pick
    placementCards: recommended.placementCards,
    rivals: rivalSummary,
    meta: baseMeta,
  };
}

// Static "definitional containment" table: held event → rung event(s) whose NO is a partial
// cross-event hedge. Soccer: reach-the-final. Politics: win-the-nomination (winning the
// presidency definitionally REQUIRES the nomination). Validated by price monotonicity at
// runtime — never an LLM/causal guess. Add rows here to extend cross-event coverage.
// rungWinners = how many outcomes simultaneously "clear" the rung (2 teams reach a final;
// 1 nominee per party) — needed to de-vig the rung partition's per-outcome midpoint correctly.
const CROSS_EVENT_LADDERS: Array<{ heldEventSlug: string; ladderEventSlugs: string[]; rungVerb: string; rungWinners: number }> = [
  { heldEventSlug: "world-cup-winner", ladderEventSlugs: ["world-cup-nation-to-reach-final"], rungVerb: "reach the final", rungWinners: 2 },
  {
    heldEventSlug: "presidential-election-winner-2028",
    ladderEventSlugs: ["democratic-presidential-nominee-2028", "republican-presidential-nominee-2028"],
    rungVerb: "win the nomination",
    rungWinners: 1,
  },
];

/**
 * Generic cross-event "ladder" hedge: buy the held outcome's NO on a definitional-containment
 * rung event (reach-the-final / win-the-nomination), evaluated on a structural MC sim.
 * Usually NO_GO — it covers the early-exit branch but RAISES the worst case in the "cleared
 * the rung but still lost" branch. Honest completeness, not a new GO.
 */
async function crossEventLadderHedge(ctx: {
  heldRef: MarketRef;
  heldTitle: string;
  heldShares: number;
  heldBasisUsd: number;
  bankrollUsd: number;
  champQ: number[];
  heldIndex: number;
  heldAvgPrice: number;
}): Promise<Decision | null> {
  const entry = CROSS_EVENT_LADDERS.find((e) => e.heldEventSlug === ctx.heldRef.eventSlug);
  if (!entry) return null;
  const rungVerb = entry.rungVerb;
  let rfMarket: MarketRef | undefined;
  let rungBundle: EventBundle | undefined;
  for (const slug of entry.ladderEventSlugs) {
    let b: EventBundle | null = null;
    try {
      b = await fetchEventBundle(slug);
    } catch {
      continue;
    }
    const m = b?.markets.find((mk) => tokenSetScore(ctx.heldTitle, mk.groupItemTitle ?? "") >= 0.85);
    if (m && !m.resolved && b) {
      rfMarket = m;
      rungBundle = b;
      break;
    }
  }
  if (!rfMarket || !rungBundle) return null;
  let noBook;
  try {
    noBook = (await fetchBooks([rfMarket.tokenIdNo])).get(rfMarket.tokenIdNo);
  } catch {
    return null;
  }
  if (!noBook) return null;
  if (bandDepthUsd(noBook, 3) < Math.min(ctx.heldBasisUsd, 50)) return null; // thin → no honest option

  const qWin = ctx.champQ[ctx.heldIndex] ?? ctx.heldRef.midpointYes;
  // De-vig the rung midpoint partition-aware (the rung partition sums to ~rungWinners + vig),
  // so it's consistent with the de-vigged qWin/champQ used in the sim.
  const ladderSum = rungBundle.yesPrices.reduce((a, x) => a + (x > 0 ? x : 0), 0) || 1;
  const overFactor = ladderSum / Math.max(1, entry.rungWinners);
  const sReachFinal = Math.min(0.999, rfMarket.midpointYes / overFactor);
  // price-monotonicity gate: a true subset (win ⊆ clear-rung) requires P(win) ≤ P(clear rung).
  if (sReachFinal < qWin - 0.02) return null;
  const ladderPmf = buildLadderPmf(qWin, sReachFinal);
  const draws: SimDraw[] = simulate({
    q: ctx.champQ,
    ladderTeams: [ctx.heldIndex],
    ladderPmf: new Map([[ctx.heldIndex, ladderPmf]]),
    N: 20000,
    seed: 42,
  });
  const paysInSim = (d: SimDraw) => d.rounds.get(ctx.heldIndex) === ROUND_OUT_BEFORE_FINAL;

  // size the reach-final NO (half-Kelly over the sims, capped by depth + free cash)
  const cap = Math.min(bandDepthUsd(noBook, 3) * 0.6, Math.max(0, ctx.bankrollUsd - ctx.heldBasisUsd));
  const gAt = (budget: number) => {
    const leg = priceLegBudget(rfMarket!, "buy_no", rfMarket!.tokenIdNo, noBook!, budget);
    const cost = leg.stakeUsd + leg.takerFeeUsd;
    const floor = ctx.bankrollUsd - ctx.heldBasisUsd - cost;
    let g = 0;
    for (const d of draws) {
      let w = floor + (d.champion === ctx.heldIndex ? ctx.heldShares : 0) + (paysInSim(d) ? leg.shares : 0);
      if (w <= 0) return -Infinity;
      g += Math.log(w);
    }
    return g / draws.length;
  };
  let bestB = 0;
  let bestG = gAt(0);
  for (let i = 1; i <= 40 && cap > 0; i++) {
    const b = (cap * i) / 40;
    const g = gAt(b);
    if (g > bestG) {
      bestG = g;
      bestB = b;
    }
  }
  const recB = bestB * 0.5; // half-Kelly
  const leg = priceLegBudget(rfMarket, "buy_no", rfMarket.tokenIdNo, noBook, recB);
  leg.corr = {
    fromTitle: `${ctx.heldTitle} wins`,
    toTitle: `${ctx.heldTitle} fails to ${rungVerb} (NO)`,
    rho: 0,
    rule: "CROSS_EVENT",
    provenance: "PRIOR",
    band: [0, 0],
    why: `Pays only when ${ctx.heldTitle} fails to ${rungVerb}. It covers that branch, but adds cost if they ${rungVerb} yet still lose — so it can raise your worst case.`,
  };
  const strategy: Strategy | null =
    recB > 0 && leg.shares > 0
      ? {
          key: "cross-ladder",
          label: `Buy NO · ${ctx.heldTitle} to ${rungVerb} (cross-event)`,
          why: leg.corr.why,
          legs: [leg],
          paysIn: [new Set<number>()],
          simPaysIn: [paysInSim],
          band: [Number((recB * 0.7).toFixed(2)), Number((recB * 1.3).toFixed(2))],
        }
      : null;

  return decideStrategy({
    heldRef: ctx.heldRef,
    heldShares: ctx.heldShares,
    heldAvgPrice: ctx.heldAvgPrice,
    heldBasisUsd: ctx.heldBasisUsd,
    heldIndex: ctx.heldIndex,
    outcomes: [],
    strategy,
    sim: { draws, heldPaysInSim: (d) => d.champion === ctx.heldIndex },
  });
}

interface EvalCtx {
  outcomes: Outcome[];
  heldRef: MarketRef;
  heldIndex: number;
  heldShares: number;
  heldAvgPrice: number;
  heldBasisUsd: number;
  bankrollUsd: number;
  heldTitle: string;
}

function evaluateStrategy(def: StratDef, ctx: EvalCtx): Decision {
  const depthCapUsd = def.legs.reduce((s, l) => s + depthUsd(l.book) * 0.6, 0);
  // Economic ceiling for the search range (so Kelly + bankroll pick the TRUE interior
  // optimum, not an arbitrary multiple-of-stake cap): you never need to spend more than
  // fully neutralizing the position (each $1-payout hedge share costs <$1, so heldShares
  // dollars over-covers) and never more than your free cash.
  const economicCapUsd = Math.min(ctx.heldShares, Math.max(0, ctx.bankrollUsd - ctx.heldBasisUsd));
  const maxScaleUsd = Math.max(0, Math.min(depthCapUsd, economicCapUsd));

  const legsAtScale = (scaleUsd: number): { legs: StrategyLeg[]; capacityHit: boolean } => {
    let capacityHit = false;
    const legs: StrategyLeg[] = def.legs.map((l) => {
      const budget = scaleUsd * l.weight;
      const fill = walkBookBuyBudgetCapped(l.book, budget, 3);
      const p = fill.avgFillPrice ?? l.book.midpoint;
      const fee = takerFeeUsd(fill.filledShares, p, "buy", {
        rate: l.ref.feeRate,
        exponent: l.ref.feeExponent,
        takerOnly: l.ref.feeTakerOnly,
      });
      if (fill.capacityHit) capacityHit = true;
      return { shares: fill.filledShares, cashOutUsd: fill.notionalSpent + fee, paysIn: l.paysIn };
    });
    return { legs, capacityHit };
  };

  const size = sizeStrategy({
    outcomes: ctx.outcomes,
    heldIndex: ctx.heldIndex,
    heldShares: ctx.heldShares,
    heldBasisUsd: ctx.heldBasisUsd,
    bankrollUsd: ctx.bankrollUsd,
    maxScaleUsd,
    uncertaintyHaircut: 0, // all legs are ANALYTIC (exclusivity / complement)
    legsAtScale,
  });

  // Price the final legs at the RECOMMENDED scale, then drop any leg too thin to fill.
  const priced = def.legs
    .map((l) => {
      const leg = priceLegBudget(l.ref, l.side, l.tokenId, l.book, size.recScaleUsd * l.weight);
      leg.corr =
        l.side === "buy_no"
          ? complementEdge(ctx.heldTitle)
          : rivalEdge(ctx.heldTitle, l.ref.groupItemTitle ?? l.ref.question, ctx.heldRef.midpointYes, l.ref.midpointYes);
      return { leg, paysIn: l.paysIn };
    })
    .filter((x) => x.leg.shares > 0);

  // Depth-bound is true only when the RECOMMENDED size actually can't fully fill —
  // not when the (larger) full-Kelly optimum hits the cap but half-Kelly fills fine.
  const recCapacityHit = priced.some((x) => x.leg.capacityHit);
  const depthBound = depthCapUsd < economicCapUsd && recCapacityHit;

  const strategy: Strategy | null =
    size.recScaleUsd > 0 && priced.length > 0
      ? {
          key: def.key,
          label: def.label,
          why: def.why,
          legs: priced.map((x) => x.leg),
          paysIn: priced.map((x) => x.paysIn),
          band: size.band,
        }
      : null;

  return decideStrategy({
    heldRef: ctx.heldRef,
    heldShares: ctx.heldShares,
    heldAvgPrice: ctx.heldAvgPrice,
    heldBasisUsd: ctx.heldBasisUsd,
    heldIndex: ctx.heldIndex,
    outcomes: ctx.outcomes,
    strategy,
    capacityLimited: depthBound,
  });
}

// ── Bet-plan flow: pick a real bet → adjustable budget → λ slider → plan ──

export interface PlanRequest {
  query: string; // e.g. "England beats Croatia" or "England vs Croatia 1:0"
  budgetUsd?: number;
  sliderS?: number; // 0..1; v1 clamps to [0.4,1.0] (aggressive end locked)
  maxLegs?: number; // cap the number of distinct bets/legs (the view is always kept)
}

export interface PlanResponse {
  status: "ok" | "not_found" | "ambiguous";
  fixtureTitle?: string;
  plan?: Plan;
  suggestions?: { slug: string; title: string }[];
  meta?: { betType: string; pricedAt: string; sliderS: number; note?: string; deVig?: string; fixtureSlug?: string; viewTitle?: string };
}

export async function runPlan(req: PlanRequest): Promise<PlanResponse> {
  const r = await resolveBet(req.query);
  if (r.kind === "not_found") return { status: "not_found", suggestions: r.suggestions };
  if (r.kind === "ambiguous") return { status: "ambiguous", suggestions: r.matches };

  const fx = r.fixture;
  // Full slider range [0,1]. The aggressive "Express it" end (s<0.4) is now safe to
  // expose because legs are priced with the CAPPED near-touch walk (phantom-depth
  // can't be bought) and a "you can lose ~all of it" stat fires when pLoseAll is high.
  const sliderS = Math.min(1, Math.max(0, req.sliderS ?? 0.7));
  const budgetUsd = Math.max(1, req.budgetUsd ?? 20);
  const maxLegs = req.maxLegs && req.maxLegs > 0 ? Math.floor(req.maxLegs) : undefined;
  const viewTitleEarly = fx.outcomes[r.viewIndex]?.title ?? fx.teams[0];

  // ── Exact-score: build a real multi-leg PLAN over the exact-score partition, anchored
  // on the chosen cell. The slider hedges the pick across other likely scorelines (the grid
  // is mutually exclusive, so it's a clean partition); maxLegs caps how many cells to buy. ──
  if (r.betType === "exact_score" && r.scoreline) {
    const grid = await resolveExactScoreGrid(fx.slug, viewTitleEarly, r.scoreline);
    if (grid && grid.viewIndex >= 0) {
      const tokenIds = grid.cells.map((c) => c.ref.tokenIdYes);
      const books = await fetchBooks(tokenIds);
      // The chosen cell must itself be priceable + liquid enough to be the anchor.
      const viewBook = books.get(grid.cells[grid.viewIndex].ref.tokenIdYes);
      const minFill = Math.min(budgetUsd, 15);
      if (viewBook && bandDepthUsd(viewBook, 3) >= minFill) {
        const outcomeInputs: PlanOutcomeInput[] = [];
        let viewIdx = -1;
        grid.cells.forEach((c, i) => {
          const book = books.get(c.ref.tokenIdYes);
          if (!book) return;
          if (i === grid.viewIndex) viewIdx = outcomeInputs.length;
          outcomeInputs.push({ title: c.title, ref: c.ref, book, q: c.q });
        });
        if (viewIdx >= 0) {
          const plan = buildPlan({
            fixtureTitle: fx.title,
            betDesc: `${fx.title}: exact score ${grid.viewTitle}`,
            outcomes: outcomeInputs,
            viewIndices: [viewIdx],
            budgetUsd,
            sliderS,
            maxLegs,
            collapseZeroPayout: "Any other scoreline",
          });
          if (plan.legs.length > 0 && plan.deployedUsd >= 0.01) {
            return { status: "ok", fixtureTitle: fx.title, plan, meta: { betType: "exact_score", pricedAt: new Date().toISOString(), sliderS } };
          }
        }
      }
    }
    // unmatched or too thin → fall through to a match-result plan with a note
  }

  // ── Prop bet (match total / both-teams-to-score): honest standalone single bet ──
  if (r.betType === "prop" && r.prop) {
    const pm = await resolvePropMarket(fx.slug, r.prop);
    if (pm) {
      const book = (await fetchBooks([pm.tokenId])).get(pm.tokenId);
      if (book && bandDepthUsd(book, 3) >= Math.min(budgetUsd, 15)) {
        const plan = buildSingleBet({
          fixtureTitle: fx.title,
          betDesc: `${fx.title}: ${pm.desc}`,
          ref: pm.ref,
          book,
          q: pm.q,
          budgetUsd,
          tokenId: pm.tokenId,
          side: pm.side,
        });
        if (plan.deployedUsd >= 0.01) {
          return { status: "ok", fixtureTitle: fx.title, plan, meta: { betType: "prop", pricedAt: new Date().toISOString(), sliderS: 0 } };
        }
      }
    }
    // unmatched or too thin → fall through to a match-result plan
  }

  // Live books + fresh midpoints for the 3-way result partition.
  const tokenIds = fx.outcomes.map((o) => o.ref.tokenIdYes);
  const [books, mids] = await Promise.all([fetchBooks(tokenIds), fetchMidpoints(tokenIds)]);
  const yesPrices = fx.outcomes.map((o) => mids.get(o.ref.tokenIdYes) ?? o.ref.midpointYes);
  const dv = devigDetailed(yesPrices);
  const q = dv.q;

  const outcomeInputs: PlanOutcomeInput[] = [];
  fx.outcomes.forEach((o, i) => {
    const book = books.get(o.ref.tokenIdYes);
    if (book) outcomeInputs.push({ title: o.title, ref: o.ref, book, q: q[i] });
  });
  if (outcomeInputs.length < 2) {
    return { status: "not_found", suggestions: [{ slug: fx.slug, title: `${fx.title} (no live book to price right now)` }] };
  }

  const viewTitle = fx.outcomes[r.viewIndex]?.title ?? fx.teams[0];
  const viewIdx = outcomeInputs.findIndex((o) => o.title === viewTitle);
  const opponent = fx.teams.find((t) => t !== viewTitle) ?? "";
  const betDesc = opponent ? `${viewTitle} to beat ${opponent}` : `${viewTitle}`;

  const plan = buildPlan({
    fixtureTitle: fx.title,
    betDesc,
    outcomes: outcomeInputs,
    viewIndices: viewIdx >= 0 ? [viewIdx] : [0],
    budgetUsd,
    sliderS,
    maxLegs,
  });

  // Nothing actually placed (all allocations were dust, or no near-touch depth) → be honest.
  if (plan.legs.length === 0 || plan.deployedUsd < 0.01) {
    return {
      status: "not_found",
      fixtureTitle: fx.title,
      suggestions: [{ slug: fx.slug, title: `${fx.title} — no fillable depth near the touch (or budget too small) to build a plan right now` }],
    };
  }

  let note: string | undefined;
  if (r.betType === "exact_score") {
    note = "That exact scoreline isn't priceable right now (its order book is too thin near the touch, or the cell isn't listed). Showing a match-result plan for the same view instead.";
    plan.warnings.unshift(note);
  }

  return {
    status: "ok",
    fixtureTitle: fx.title,
    plan,
    meta: { betType: r.betType, pricedAt: new Date().toISOString(), sliderS, note, deVig: devigLabel(dv), fixtureSlug: fx.slug, viewTitle },
  };
}

// ── Combo Truth Check: build a multi-leg parlay, price each leg off the REAL book ──

export interface ComboLegRequest {
  query: string; // free-text market/position, resolved to a real Polymarket outcome
  side: "yes" | "no";
}
export interface ComboRequest {
  legs: ComboLegRequest[];
  stakeUsd?: number;
  /** Optional quoted combo price (per $1 payout), as a FRACTION 0..1, to truth-check. */
  quotedComboPrice?: number;
}
export interface ComboResponse {
  status: "ok" | "error";
  result?: ComboResult;
  unresolved?: { query: string; reason: string }[];
  pricedAt?: string;
  error?: string;
}

export async function runCombo(req: ComboRequest): Promise<ComboResponse> {
  const stakeUsd = Math.max(1, req.stakeUsd ?? 20);
  const legReqs = (req.legs ?? []).filter((l) => l.query && l.query.trim().length > 0).slice(0, 8);
  if (legReqs.length === 0) return { status: "error", error: "Add at least one leg." };

  const priced: PricedComboLeg[] = [];
  const legSlugs: string[] = []; // event slug per priced leg (to detect same-market legs)
  const legInfo: StructLeg[] = []; // structural identity per leg (for the exact-joint detector)
  const unresolved: { query: string; reason: string }[] = [];

  for (const lr of legReqs) {
    // Fixture-style leg ("X beats Y"): resolveAnyPosition mis-picks the Draw/opponent (their tokens
    // overlap the query), so resolve via the fixture resolver, which targets the WINNER's match market.
    if (/\bbeats\b|\bvs\.?\b/i.test(lr.query)) {
      let rb;
      try {
        rb = await resolveBet(lr.query);
      } catch {
        rb = null;
      }
      if (rb && rb.kind === "resolved" && rb.fixture.outcomes[rb.viewIndex]) {
        const o = rb.fixture.outcomes[rb.viewIndex];
        const ref = o.ref;
        const side = lr.side === "no" ? "no" : "yes";
        let yesMid = ref.midpointYes;
        try {
          const mids = await fetchMidpoints([ref.tokenIdYes, ref.tokenIdNo]);
          const y = mids.get(ref.tokenIdYes);
          const n = mids.get(ref.tokenIdNo);
          if (y !== undefined && n !== undefined && y + n > 0) yesMid = y / (y + n);
          else if (y !== undefined) yesMid = y;
        } catch {
          /* keep snapshot */
        }
        const qYes = Math.min(0.99, Math.max(0.01, yesMid));
        const legQ = side === "no" ? 1 - qYes : qYes;
        const token = side === "no" ? ref.tokenIdNo : ref.tokenIdYes;
        let price = side === "no" ? 1 - ref.midpointYes : ref.midpointYes;
        let capacityHit = true;
        try {
          const book = (await fetchBooks([token])).get(token);
          if (book) {
            const fill = walkBookBuyBudgetCapped(book, stakeUsd, 3);
            price = fill.avgFillPrice ?? book.bestAsk ?? price;
            capacityHit = fill.capacityHit;
          }
        } catch {
          /* keep snapshot price */
        }
        if (legQ > price) {
          price = legQ;
          capacityHit = true;
        }
        priced.push({ title: o.title, marketTitle: rb.fixture.title, side, q: legQ, price, deepLink: buildMarketDeepLink(ref.eventSlug), capacityHit, band: { lo: Math.max(0, legQ - 0.02), mid: legQ, hi: Math.min(1, legQ + 0.02) } });
        legSlugs.push(rb.fixture.slug);
        legInfo.push({ eventSlug: rb.fixture.slug, index: o.index, title: o.title, side, negRiskMarketId: ref.negRiskMarketId ?? null, q: legQ });
        continue;
      }
    }
    let resolved;
    try {
      resolved = await resolveAnyPosition(lr.query);
    } catch {
      unresolved.push({ query: lr.query, reason: "lookup failed" });
      continue;
    }
    if (resolved.kind !== "resolved") {
      unresolved.push({
        query: lr.query,
        reason: resolved.kind === "ambiguous" ? "ambiguous — be more specific" : "no real Polymarket market found",
      });
      continue;
    }
    const ref = resolved.bundle.markets[resolved.index];
    const side = lr.side === "no" ? "no" : "yes";
    // de-vigged true prob for the YES outcome; NO leg hits with 1 − qYes
    const qYes = devigDetailed(resolved.bundle.yesPrices).q[resolved.index] ?? ref.midpointYes;
    const legQ = side === "no" ? 1 - qYes : qYes;
    // marginal uncertainty band from de-vig method disagreement (flip it for a NO leg)
    const yesBand = marginalBand(resolved.bundle.yesPrices, resolved.index);
    const band = side === "no" ? { lo: 1 - yesBand.hi, mid: 1 - yesBand.mid, hi: 1 - yesBand.lo } : { lo: yesBand.lo, mid: yesBand.mid, hi: yesBand.hi };
    const token = side === "no" ? ref.tokenIdNo : ref.tokenIdYes;
    // executable per-share price: walk the real book near the touch; fall back to the touch/mid
    let price = side === "no" ? 1 - ref.midpointYes : ref.midpointYes;
    let capacityHit = true;
    try {
      const book = (await fetchBooks([token])).get(token);
      if (book) {
        const fill = walkBookBuyBudgetCapped(book, stakeUsd, 3);
        price = fill.avgFillPrice ?? book.bestAsk ?? price;
        capacityHit = fill.capacityHit;
      }
    } catch {
      /* keep the snapshot price */
    }
    // Honesty floor: you can't pay BELOW fair value on a real book. A NO leg is priced on a
    // SEPARATE book from its de-vigged YES probability, so a stale/thin fallback can imply
    // price < fair (→ positive EV). Floor the pay price at fair and flag it as not-clean-fill.
    if (legQ > price) {
      price = legQ;
      capacityHit = true;
    }
    priced.push({
      title: ref.groupItemTitle ?? ref.question,
      marketTitle: resolved.bundle.title,
      side,
      q: legQ,
      price,
      deepLink: buildMarketDeepLink(ref.eventSlug),
      capacityHit,
      band,
    });
    legSlugs.push(resolved.bundle.slug);
    legInfo.push({
      eventSlug: resolved.bundle.slug,
      index: resolved.index,
      title: ref.groupItemTitle ?? ref.question,
      side,
      negRiskMarketId: ref.negRiskMarketId,
      q: legQ,
    });
  }

  if (priced.length === 0) {
    return { status: "ok", unresolved, pricedAt: new Date().toISOString() };
  }
  // ≥2 YES legs in the SAME market are mutually exclusive → the combo can never all hit.
  const yesPerEvent = new Map<string, number>();
  priced.forEach((l, i) => {
    if (l.side === "yes") yesPerEvent.set(legSlugs[i], (yesPerEvent.get(legSlugs[i]) ?? 0) + 1);
  });
  // Try to DERIVE the joint exactly from market structure (subset/containment or exclusivity);
  // this supersedes both the slug gate and the estimate when it fires.
  const structuralJoint = detectStructuralJoint(legInfo) ?? undefined;
  const mutuallyExclusive = [...yesPerEvent.values()].some((n) => n >= 2) || structuralJoint?.p === 0;

  // Cross-market joint ESTIMATE: only when nothing structural applies, every leg is in a DISTINCT
  // market, and the combo is possible. Shared-entity legs get a higher illustrative ρ.
  const distinctEvents = new Set(legSlugs).size;
  const crossMarket = !mutuallyExclusive && !structuralJoint && priced.length >= 2 && distinctEvents === priced.length;
  let sharedEntity = false;
  for (let i = 0; i < legInfo.length && !sharedEntity; i++)
    for (let j = i + 1; j < legInfo.length; j++) if (sharesEntity(legInfo[i].title, legInfo[j].title)) sharedEntity = true;
  const jointEstimate =
    crossMarket && priced.every((l) => l.band) ? jointAllHit(priced.map((l) => l.band!), { rho: sharedEntity ? 0.6 : 0.25 }) : undefined;

  const result = buildCombo(priced, { stakeUsd, quotedComboPrice: req.quotedComboPrice, mutuallyExclusive, jointEstimate, structuralJoint });
  return { status: "ok", result, unresolved, pricedAt: new Date().toISOString() };
}
