/**
 * lib/relate/discover.ts — the end-to-end relation engine (Stages 1→5).
 *
 * Given a free-text anchor bet, resolve it, build a live cross-venue market universe (Polymarket +
 * Kalshi), then: Stage 1 generate candidate pairs, Stage 2 classify each, Stages 3–5 quantify into
 * an EventRelation (φ, hedge ratio, effectiveness, confidence). Returns the ranked relations plus
 * the engine's most useful by-product: the single BEST hedge it found across both venues.
 */
import { resolveAnyPosition, resolvePosition, fetchEventBundle, fetchMidpoints, type EventBundle } from "@/lib/polymarket";
import { gammaGet } from "@/lib/polymarket/client";
import { listKalshiEvents, fetchKalshiMarkets } from "@/lib/kalshi";
import { buildEventRelation, frechetProjectedPhi, type EventRelation } from "@/lib/correlation";
import { elicitConditionalWithQwen } from "@/lib/association";
import { normalizePolymarketEvent, normalizeKalshiEvent } from "./normalize";
import { norm } from "@/lib/polymarket/text";
import { selectRecallCandidates } from "./candidates";
import { buildSemanticScorer } from "./embed";
import { classifyPair } from "./classify";
import { buildOptimizerCandidates } from "./toOptimizerCandidates";
import { persistCandidateSnapshots } from "./candidateSnapshot";
import { recallCandidatesWithQwen, type RecallDiagnostics } from "./llmRecall";
import { optimizeRobustHedge, type RobustOptimizerResult } from "@/lib/association";
import type { MechanismGraph } from "@/lib/association";
import type { CandidatePair, NormalizedMarket } from "./types";

const WC_CATEGORY = "world-cup";
const csv = (value: string | undefined, fallback: string[]) => {
  const parsed = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return parsed?.length ? parsed : fallback;
};
// Broader live WC universe across both venues (the anchor's own event is added on top). The
// non-anchor part is the same every request, so it's CACHED as a persistent index (below).
const PM_EVENTS = csv(process.env.HEDGE_RELATE_PM_EVENTS, [
  "world-cup-winner", "world-cup-golden-boot-winner", "which-continent-will-win-the-world-cup",
  "world-cup-nation-to-reach-final", "world-cup-group-d-winner",
]);
const KALSHI_SERIES = csv(process.env.HEDGE_RELATE_KALSHI_SERIES, [
  "KXMENWORLDCUP",
  "KXWCCONTINENT",
  "KXWCGROUPWINNER",
  // NARRATIVE / broadcast markets — the announcer-word family. In the pool so soft associations are
  // RECALLED (and then honestly gated by settlement calibration), not invisible.
  "KXWCFIRSTSONG",
]);
const TOP_PM_EVENTS = Math.min(60, Math.max(0, Number(process.env.HEDGE_RELATE_PM_TOP_EVENTS ?? 24)));
const TOP_KALSHI_EVENTS = Math.min(60, Math.max(0, Number(process.env.HEDGE_RELATE_KALSHI_TOP_EVENTS ?? 24)));

function categoryOf(bundle: EventBundle): string {
  const text = `${bundle.title} ${bundle.tags.join(" ")}`.toLowerCase();
  if (/world cup|fifa/.test(text)) return WC_CATEGORY;
  return `topic:${bundle.tags[0]?.toLowerCase() || bundle.slug.split("-").slice(0, 2).join("-")}`;
}

async function topOpenPmSlugs(): Promise<string[]> {
  if (TOP_PM_EVENTS <= 0) return [];
  try {
    const events = await gammaGet<Array<{ slug?: string; negRisk?: boolean; active?: boolean; closed?: boolean }>>(
      `/events?closed=false&active=true&order=volume24hr&ascending=false&limit=${TOP_PM_EVENTS}`,
    );
    return events.filter((e) => e.slug && !e.closed && (e.active ?? true)).map((e) => e.slug!);
  } catch {
    return [];
  }
}

// Persistent shared-universe index: the non-anchor markets are identical across requests, so build
// them once and reuse for a TTL (a real index, not a per-request rebuild). True full-corpus indexing
// across ALL markets on both venues would need a vector store; this is the serverless-appropriate cut.
let sharedCache: { at: number; markets: NormalizedMarket[] } | null = null;
const SHARED_TTL = 5 * 60 * 1000;

async function freshPmBundle(slug: string): Promise<EventBundle | null> {
  const b = await fetchEventBundle(slug).catch(() => null);
  if (!b) return null;
  try {
    const mids = await fetchMidpoints(b.markets.map((m) => m.tokenIdYes));
    if (mids.size) {
      for (const m of b.markets) {
        const mid = mids.get(m.tokenIdYes);
        if (mid !== undefined) m.midpointYes = mid;
      }
      b.yesPrices = b.markets.map((m) => m.midpointYes);
    }
  } catch {
    /* snapshot ok */
  }
  return b;
}

/** Build (and cache) the venue-spanning, anchor-independent market index. */
async function sharedUniverse(): Promise<NormalizedMarket[]> {
  if (sharedCache && Date.now() - sharedCache.at < SHARED_TTL) return sharedCache.markets;
  const byId = new Map<string, NormalizedMarket>();
  const add = (ms: NormalizedMarket[]) => ms.forEach((m) => byId.has(m.id) || byId.set(m.id, m));

  const pmSlugs = [...new Set([...PM_EVENTS, ...(await topOpenPmSlugs())])];
  const pmBundles = await Promise.all(pmSlugs.map(freshPmBundle));
  for (const b of pmBundles) if (b) add(normalizePolymarketEvent(b, categoryOf(b)));

  const kalshiEvents = new Map<string, Awaited<ReturnType<typeof listKalshiEvents>>[number]>();
  for (const series of KALSHI_SERIES) {
    const events = await listKalshiEvents(series, 3).catch(() => []);
    for (const ev of events.slice(0, 3)) kalshiEvents.set(ev.eventTicker, ev);
  }
  const broadKalshi = TOP_KALSHI_EVENTS > 0 ? await listKalshiEvents("", TOP_KALSHI_EVENTS).catch(() => []) : [];
  for (const ev of broadKalshi) kalshiEvents.set(ev.eventTicker, ev);
  const kalshiMarkets = await Promise.all([...kalshiEvents.values()].map(async (ev) => ({
    ev,
    markets: await fetchKalshiMarkets(ev.eventTicker).catch(() => []),
  })));
  for (const { ev, markets } of kalshiMarkets) {
    if (markets.length) add(normalizeKalshiEvent(markets, ev.title || ev.seriesTicker, `topic:${ev.category.toLowerCase()}`, ev.mutuallyExclusive, ev.feeMultiplier));
  }
  const markets = [...byId.values()];
  sharedCache = { at: Date.now(), markets };
  return markets;
}

// Candidates that can never be a POSITIVE-SUM cross-event hedge for a team/nation anchor, so they
// pollute neither the relation map nor the optimizer (eval 2026-06-21: these dominated the noise and
// the engine never produced a valid hedge from them):
//  - individual player-award outcomes (Golden Boot / top scorer): same-nation => amplifier (fails WITH
//    the anchor), cross-nation => weak noise, and we have no roster to tell which.
//  - unidentifiable placeholder outcomes ("Player Q", "Team AH") with no resolvable entity.
function isHedgeIneligibleCandidate(m: NormalizedMarket): boolean {
  if (m.eventFamily === "golden_boot") return true;
  return /^(player|team)\s+[a-z]{1,2}$/.test(norm(m.title));
}

async function buildUniverse(anchorBundle: EventBundle): Promise<NormalizedMarket[]> {
  const byId = new Map<string, NormalizedMarket>();
  const add = (ms: NormalizedMarket[]) => ms.forEach((m) => byId.has(m.id) || byId.set(m.id, m));
  const category = categoryOf(anchorBundle);
  add(normalizePolymarketEvent(anchorBundle, category)); // anchor first (its outcomes win on dedupe)
  add(await sharedUniverse());
  return [...byId.values()];
}

export interface DiscoveredRelation {
  market: { id: string; venue: "polymarket" | "kalshi"; title: string; marketTitle: string; probYes: number; url: string };
  recall: CandidatePair["recall"];
  similarity: number;
  classifyMethod: "rule" | "llm" | "heuristic";
  relation: EventRelation;
  mechanismGraph?: MechanismGraph;
  /** LLM audit metadata only. Direction may suggest which side to inspect, but confidence never
   *  becomes a payoff probability or position size. */
  hypothesis?: {
    relation: string;
    direction: string;
    mechanism: string;
    confidence: number;
    requiresCalibration: boolean;
  };
}

/** A validated cross-event hedge strategy. Correlation comes from elicited conditional probabilities
 *  (Fréchet-projected signed φ, ~92% sign accuracy), NOT the unreliable mechanism MUTEX/CAUSAL label.
 *  Inferred / exploratory layer: priced from real prices + real conditionals, never the calibrated optimizer. */
export interface HedgeStrategy {
  marketId: string;
  venue: "polymarket" | "kalshi";
  title: string;
  marketTitle: string;
  probYes: number;
  url: string;
  side: "YES" | "NO";            // the side you buy so it pays when your bet fails
  legPrice: number;             // de-vigged price of that side
  phi: number;                  // signed correlation from conditionals (negative = anti-correlated = hedge)
  pGivenFails: number;          // P(bought side pays | anchor fails)
  pGivenWins: number;           // P(bought side pays | anchor wins)
  confidence: number;           // elicitation confidence
  costUsd: number;
  expectedReductionUsd: number; // expected downside cut if your bet fails
  hedgedLossUsd: number;
  keptIfWinUsd: number;
  mechanism: string;
}

export interface DiscoverResult {
  status: "ok" | "ambiguous" | "not_found";
  strategies?: HedgeStrategy[];
  anchor?: { id: string; venue: "polymarket" | "kalshi"; title: string; marketTitle: string; probYes: number; url: string };
  relations?: DiscoveredRelation[];
  /** The ACTIONABLE hedge: the cost/capacity/uncertainty-constrained robust optimizer's plan over the
   *  Discover candidates (settlement-calibrated; LLM/uncalibrated legs are rejected, not recommended). */
  robustHedge?: RobustOptimizerResult;
  universeSize?: number;
  semanticRecall?: boolean; // true ⇒ embeddings were used for Stage 1 recall
  candidates?: { title: string; score: number }[];
  /** The resolved event for an ambiguous result, so a caller can re-pin a chosen candidate. */
  eventSlug?: string;
  /** Ambiguous disambiguation hint: "outcome" = the query matched an outcome (a clear leader may be
   *  auto-pinned); "event" = the query named the whole event, so candidates are its outcomes to choose. */
  mode?: "outcome" | "event";
  /** When the API auto-pinned a clear leading candidate for an ambiguous query, the title it pinned to. */
  disambiguatedTo?: string;
  suggestions?: string[];
  pricedAt?: string;
  /** Point-in-time relation rows persisted before settlement (zero when DATABASE_URL is unset). */
  candidateSnapshotsWritten?: number;
  /** Operational telemetry only; never enters correlation, calibration, or sizing. */
  llm?: {
    recall?: RecallDiagnostics;
    classification: {
      candidates: number;
      rule: number;
      llm: number;
      heuristic: number;
      attempted: number;
      cacheHits: number;
      failures: number;
      models: Record<string, number>;
    };
  };
}

export interface DiscoverRequest {
  query: string;
  eventSlug?: string;
  topK?: number;
  stakeUsd?: number;
  /** User's actual average entry price. Defaults to the current de-vigged anchor probability only
   *  when analyzing a prospective position rather than an existing holding. */
  entryPrice?: number;
  keepFraction?: number; // win-floor k (default 0.5)
  conservatism?: number; // 0=model mean … 1=strictest credible-bound admissibility (default 0.5)
  maxLegs?: number; // default 3
  /** Build the validated cross-event hedge strategy list (extra LLM elicitation). User-facing only;
   *  the collection cron leaves it off so snapshots stay cheap. */
  withStrategies?: boolean;
}

/** Bounded-concurrency map (keeps the per-anchor elicitation cost predictable). */
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Build the validated cross-event hedge strategy list. The mechanism-classification MUTEX/CAUSAL label
 * is unreliable for sizing (it conflates "different party" with "mutually exclusive" — e.g. it wrongly
 * marks a Democratic-nominee market as a MUTEX hedge for a Republican's presidency). So we do NOT trust
 * it: we elicit P(candidate pays | anchor wins) and P(candidate pays | anchor fails) and derive a
 * Fréchet-projected SIGNED φ (empirically ~92% sign accuracy). A candidate is a genuine hedge only when
 * its bought side pays MEANINGFULLY more often when the anchor fails than when it wins, and more than its
 * own base rate. Everything is then priced from the real conditionals. Exploratory layer only.
 */
async function buildCrossEventStrategies(
  anchor: { title: string; marketTitle: string; probYes: number },
  relations: DiscoveredRelation[],
  stakeUsd: number,
  baseWinnings: number,
): Promise<HedgeStrategy[]> {
  const hedgeLikely = (r: DiscoveredRelation) => {
    const h = r.hypothesis;
    if (!h) return 0;
    return (h.direction === "NEGATIVE" ? 2 : 0) + (h.relation === "MUTEX" || h.relation === "IMPLICATION" || h.relation === "CAUSAL" ? 1 : 0);
  };
  // Exclude same-ENTITY companions (the anchor's own name in another market — e.g. "Newsom as Governor",
  // or the anchor's own nomination): those are prerequisites of the same bet, not cross-event hedges.
  const anchorTokens = new Set(norm(anchor.title).split(" ").filter((w) => w.length > 2));
  const sharesEntity = (title: string) => norm(title).split(" ").some((w) => w.length > 2 && anchorTokens.has(w));
  const cands = relations
    .filter((r) => r.classifyMethod !== "rule" && r.market.marketTitle !== anchor.marketTitle && !sharesEntity(r.market.title))
    .sort((a, b) => hedgeLikely(b) - hedgeLikely(a))
    .slice(0, 16); // bound the elicitation cost
  if (cands.length === 0) return [];
  const anchorTitle = `${anchor.title} (${anchor.marketTitle})`;
  const ap = Math.min(0.999, Math.max(0.001, anchor.probYes));
  const PHI_MIN = 0.12; // meaningful dependence
  const CONF_MIN = 0.35; // elicitation-confidence floor
  const elicited = await mapPool(cands, 8, async (r) => {
    const e = await elicitConditionalWithQwen(anchorTitle, `${r.market.title} (${r.market.marketTitle})`).catch(() => null);
    if (!e || e.status !== "ok" || e.pGivenAnchorWins == null) return null;
    const pW = e.pGivenAnchorWins;
    const pF = e.pGivenAnchorFails ?? r.market.probYes;
    // φ from the model's OWN two conditionals (via its implied marginal), so equal conditionals ⇒ φ=0
    // regardless of any level mismatch with the market price. The real price is used only for pricing.
    const qB = ap * pW + (1 - ap) * pF;
    const fp = frechetProjectedPhi(ap, qB, pW);
    return { r, pW, pF, phi: fp.phi, conf: e.confidence ?? 0.5, reason: e.reason ?? "" };
  });
  const out: HedgeStrategy[] = [];
  const hedgeBudget = 0.25 * stakeUsd; // a modest hedge spend; the cut scales with the per-dollar edge
  for (const x of elicited) {
    if (!x) continue;
    const { r, pW, pF, phi, conf, reason } = x;
    if (Math.abs(phi) < PHI_MIN || conf < CONF_MIN) continue;
    const buyYes = phi < 0; // anti-correlated → the candidate's YES pays when your bet fails
    const qSide = Math.min(0.98, Math.max(0.02, buyYes ? r.market.probYes : 1 - r.market.probYes));
    const pWside = buyYes ? pW : 1 - pW; // P(bought side pays | anchor wins)
    // P(bought side pays | anchor fails). The model's level often disagrees with the price; clamp to the
    // market-feasible bound P(side)/P(anchor fails) so the payoff stays consistent with the real price.
    const pFside = Math.min(buyYes ? pF : 1 - pF, qSide / Math.max(0.05, 1 - ap));
    const edge = pFside / qSide - 1; // expected hedge return per $1 spent, when your bet fails
    if (edge <= 0 || pFside <= pWside) continue; // must beat its price on fail, and pay more on fail than win
    const costUsd = hedgeBudget;
    const expectedReductionUsd = costUsd * edge;
    out.push({
      marketId: r.market.id, venue: r.market.venue, title: r.market.title, marketTitle: r.market.marketTitle,
      probYes: r.market.probYes, url: r.market.url, side: buyYes ? "YES" : "NO",
      legPrice: Number(qSide.toFixed(4)), phi: Number(phi.toFixed(3)), pGivenFails: Number(pFside.toFixed(3)),
      pGivenWins: Number(pWside.toFixed(3)), confidence: Number(conf.toFixed(2)), costUsd: Number(costUsd.toFixed(2)),
      expectedReductionUsd: Number(expectedReductionUsd.toFixed(2)), hedgedLossUsd: Number((stakeUsd - expectedReductionUsd).toFixed(2)),
      keptIfWinUsd: Number((baseWinnings - costUsd).toFixed(2)), mechanism: reason.slice(0, 160),
    });
  }
  return out
    .sort((a, b) => b.expectedReductionUsd - a.expectedReductionUsd || b.confidence - a.confidence)
    .slice(0, 5);
}

export async function discoverRelations(req: DiscoverRequest): Promise<DiscoverResult> {
  const resolved = req.eventSlug
    ? await resolvePosition(req.query, req.eventSlug)
    : await resolveAnyPosition(req.query);
  if (resolved.kind === "ambiguous") {
    // Expose the resolved event so a caller (e.g. the collection cron) can re-pin the top candidate.
    const eventSlug = (resolved as { eventSlug?: string }).eventSlug ?? req.eventSlug;
    const mode = (resolved as { mode?: "outcome" | "event" }).mode ?? "outcome";
    return { status: "ambiguous", eventSlug, mode, candidates: resolved.candidates.map((c) => ({ title: c.title, score: Number(c.score.toFixed(2)) })) };
  }
  if (resolved.kind !== "resolved") return { status: "not_found", suggestions: resolved.suggestions };

  const bundle = resolved.bundle;
  const universe = await buildUniverse(bundle);
  const anchorRef = bundle.markets[resolved.index];
  const anchorId = `polymarket:${anchorRef.conditionId}`;
  const anchor = universe.find((m) => m.id === anchorId);
  if (!anchor) return { status: "not_found", suggestions: [] };

  // Stage 1: embeddings when explicitly enabled; otherwise cached batched LLM recall, with lexical
  // recall as the final network-free fallback.
  const semanticScore = await buildSemanticScorer(universe);
  const topK = req.topK ?? 12;
  let recallDiagnostics: RecallDiagnostics | undefined;
  const llmRecall = !semanticScore ? await recallCandidatesWithQwen(anchor, universe, topK, {
    onDiagnostics: (diagnostics) => { recallDiagnostics = diagnostics; },
  }) : null;
  const rawCandidates = selectRecallCandidates(anchor, universe, {
    topK,
    semanticScore: semanticScore ?? undefined,
    llmRecall,
    allowCrossCategory: true,
    minSimilarity: semanticScore ? 0.12 : 0.08,
  });
  // Drop player-award and placeholder candidates at this one chokepoint, so they reach neither the
  // relation map (display) nor buildOptimizerCandidates (legs) — both consume `classified` below.
  const candidates = rawCandidates.filter(({ b }) => !isHedgeIneligibleCandidate(b));

  // Stage 2: classify every candidate (keeping the raw classification for the optimizer adapter).
  const classified = await Promise.all(candidates.map(async (pair) => ({ pair, cls: await classifyPair(pair) })));
  const modelCounts: Record<string, number> = {};
  for (const { cls } of classified) if (cls.llmModel) modelCounts[cls.llmModel] = (modelCounts[cls.llmModel] ?? 0) + 1;
  const classificationDiagnostics = {
    candidates: classified.length,
    rule: classified.filter(({ cls }) => cls.method === "rule").length,
    llm: classified.filter(({ cls }) => cls.method === "llm").length,
    heuristic: classified.filter(({ cls }) => cls.method === "heuristic").length,
    attempted: classified.filter(({ cls }) => cls.method === "llm" || cls.llmAttempts !== undefined).length,
    cacheHits: classified.filter(({ cls }) => cls.llmCacheHit).length,
    failures: classified.filter(({ cls }) => Boolean(cls.llmFailureReason)).length,
    models: modelCounts,
  };
  const candidateSnapshotsWritten = await persistCandidateSnapshots(anchor, classified).catch(() => 0);

  // Stages 3–5: the descriptive relation map (φ from STRUCTURE or estimate only — never price-corr).
  const relations: DiscoveredRelation[] = classified
    .map(({ pair, cls }) => {
      const relation = buildEventRelation({
        pA: pair.a.probYes,
        pB: pair.b.probYes,
        structuralJoint: cls.structuralJoint,
        structuralKind: cls.structuralKind,
        estimateRho: cls.estimateRho,
        liquidityOk: pair.a.liquidityOk && pair.b.liquidityOk,
        labelA: pair.a.title,
        labelB: pair.b.title,
      });
      if (cls.method !== "heuristic") relation.reasoning = cls.reasoning;
      return {
        market: { id: pair.b.id, venue: pair.b.venue, title: pair.b.title, marketTitle: pair.b.marketTitle, probYes: Number(pair.b.probYes.toFixed(4)), url: pair.b.url },
        recall: pair.recall,
        similarity: pair.similarity,
        classifyMethod: cls.method,
        relation,
        mechanismGraph: cls.hypothesis?.mechanismGraph,
        hypothesis: cls.hypothesis ? {
          relation: cls.hypothesis.relation,
          direction: cls.hypothesis.direction,
          mechanism: cls.hypothesis.mechanism,
          confidence: cls.hypothesis.confidence,
          requiresCalibration: cls.hypothesis.requiresCalibration,
        } : undefined,
      };
    })
    .sort((a, b) => Math.abs(b.relation.correlation) - Math.abs(a.relation.correlation));

  // ── The ACTIONABLE hedge: cost/capacity/uncertainty-constrained robust optimizer ──
  // Candidates are priced off the REAL book; only verified cover-all NO legs are ANALYTIC, the rest
  // are HYPOTHESIS (rejected without settlement calibration). No φ-from-price drives this.
  const stakeUsd = Math.max(1, req.stakeUsd ?? 20);
  const entryPrice = Math.min(0.999, Math.max(0.001, req.entryPrice ?? anchor.probYes));
  const keepFraction = Math.min(1, Math.max(0, req.keepFraction ?? 0.5));
  const pricingBudgetUsd = Math.max(1, (1 - keepFraction) * stakeUsd * (1 - entryPrice) / entryPrice);
  const optimizerCandidates = await buildOptimizerCandidates(anchor, classified, pricingBudgetUsd).catch(() => []);
  // Always return an optimizer result, including when no candidate survives the evidence/pricing
  // adapter. The UI must show an explicit NO_ACTION decision instead of silently omitting the
  // product's primary recommendation card.
  const robustHedge: RobustOptimizerResult = optimizeRobustHedge({
    stakeUsd,
    primaryPrice: entryPrice,
    keepFraction,
    conservatism: Math.min(1, Math.max(0, req.conservatism ?? 0.5)),
    maxLegs: Math.max(1, Math.floor(req.maxLegs ?? 3)),
    candidates: optimizerCandidates,
  });

  // Validated cross-event hedge strategies (user-facing only; the cron leaves withStrategies off).
  const baseWinnings = stakeUsd * (1 - anchor.probYes) / Math.max(0.01, anchor.probYes);
  const strategies = req.withStrategies
    ? await buildCrossEventStrategies(
        { title: anchor.title, marketTitle: anchor.marketTitle, probYes: anchor.probYes },
        relations, stakeUsd, baseWinnings,
      ).catch(() => [])
    : undefined;

  return {
    status: "ok",
    strategies,
    anchor: { id: anchor.id, venue: anchor.venue, title: anchor.title, marketTitle: anchor.marketTitle, probYes: Number(anchor.probYes.toFixed(4)), url: anchor.url },
    relations,
    robustHedge,
    universeSize: universe.length,
    semanticRecall: Boolean(semanticScore),
    pricedAt: new Date().toISOString(),
    candidateSnapshotsWritten,
    llm: { recall: recallDiagnostics, classification: classificationDiagnostics },
  };
}
