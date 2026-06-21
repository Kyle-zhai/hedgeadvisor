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
import { buildEventRelation, type EventRelation } from "@/lib/correlation";
import { normalizePolymarketEvent, normalizeKalshiEvent } from "./normalize";
import { norm } from "@/lib/polymarket/text";
import { generateCandidates } from "./candidates";
import { buildSemanticScorer } from "./embed";
import { classifyPair } from "./classify";
import { buildOptimizerCandidates } from "./toOptimizerCandidates";
import { persistCandidateSnapshots } from "./candidateSnapshot";
import { recallCandidatesWithQwen } from "./llmRecall";
import { lexicalSimilarity } from "./candidates";
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
}

export interface DiscoverResult {
  status: "ok" | "ambiguous" | "not_found";
  anchor?: { id: string; venue: "polymarket" | "kalshi"; title: string; marketTitle: string; probYes: number; url: string };
  relations?: DiscoveredRelation[];
  /** The ACTIONABLE hedge: the cost/capacity/uncertainty-constrained robust optimizer's plan over the
   *  Discover candidates (settlement-calibrated; LLM/uncalibrated legs are rejected, not recommended). */
  robustHedge?: RobustOptimizerResult;
  universeSize?: number;
  semanticRecall?: boolean; // true ⇒ embeddings were used for Stage 1 recall
  candidates?: { title: string; score: number }[];
  suggestions?: string[];
  pricedAt?: string;
  /** Point-in-time relation rows persisted before settlement (zero when DATABASE_URL is unset). */
  candidateSnapshotsWritten?: number;
}

export interface DiscoverRequest {
  query: string;
  eventSlug?: string;
  topK?: number;
  stakeUsd?: number;
  keepFraction?: number; // win-floor k (default 0.5)
  conservatism?: number; // 0=model mean … 1=strictest credible-bound admissibility (default 0.5)
  maxLegs?: number; // default 3
}

export async function discoverRelations(req: DiscoverRequest): Promise<DiscoverResult> {
  const resolved = req.eventSlug
    ? await resolvePosition(req.query, req.eventSlug)
    : await resolveAnyPosition(req.query);
  if (resolved.kind === "ambiguous") {
    return { status: "ambiguous", candidates: resolved.candidates.map((c) => ({ title: c.title, score: Number(c.score.toFixed(2)) })) };
  }
  if (resolved.kind !== "resolved") return { status: "not_found", suggestions: resolved.suggestions };

  const bundle = resolved.bundle;
  const universe = await buildUniverse(bundle);
  const anchorRef = bundle.markets[resolved.index];
  const anchorId = `polymarket:${anchorRef.conditionId}`;
  const anchor = universe.find((m) => m.id === anchorId);
  if (!anchor) return { status: "not_found", suggestions: [] };

  // Stage 1: candidate generation (embeddings if a key is set, else lexical recall).
  const semanticScore = await buildSemanticScorer(universe);
  const topK = req.topK ?? 12;
  const baseCandidates = generateCandidates(anchor, universe, {
    topK: semanticScore ? topK : 0,
    semanticScore: semanticScore ?? undefined,
    allowCrossCategory: true,
    // Embeddings support genuinely non-lexical mechanisms. Without them, retain a small lexical
    // floor so Qwen still sees plausible cross-domain candidates rather than the entire catalog.
    minSimilarity: semanticScore ? 0.12 : 0.08,
  });
  const llmRecall = !semanticScore ? await recallCandidatesWithQwen(anchor, universe, topK) : null;
  const rawCandidates = llmRecall
    ? [...baseCandidates, ...llmRecall.map((candidate) => ({
        a: anchor,
        b: candidate,
        recall: "llm_recall" as const,
        similarity: Number(lexicalSimilarity(anchor, candidate).toFixed(3)),
      }))]
    : generateCandidates(anchor, universe, {
        topK,
        allowCrossCategory: true,
        minSimilarity: 0.08,
      });
  // Drop player-award and placeholder candidates at this one chokepoint, so they reach neither the
  // relation map (display) nor buildOptimizerCandidates (legs) — both consume `classified` below.
  const candidates = rawCandidates.filter(({ b }) => !isHedgeIneligibleCandidate(b));

  // Stage 2: classify every candidate (keeping the raw classification for the optimizer adapter).
  const classified = await Promise.all(candidates.map(async (pair) => ({ pair, cls: await classifyPair(pair) })));
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
      };
    })
    .sort((a, b) => Math.abs(b.relation.correlation) - Math.abs(a.relation.correlation));

  // ── The ACTIONABLE hedge: cost/capacity/uncertainty-constrained robust optimizer ──
  // Candidates are priced off the REAL book; only verified cover-all NO legs are ANALYTIC, the rest
  // are HYPOTHESIS (rejected without settlement calibration). No φ-from-price drives this.
  const optimizerCandidates = await buildOptimizerCandidates(anchor, classified).catch(() => []);
  let robustHedge: RobustOptimizerResult | undefined;
  if (optimizerCandidates.length > 0) {
    robustHedge = optimizeRobustHedge({
      stakeUsd: Math.max(1, req.stakeUsd ?? 20),
      primaryPrice: anchor.probYes,
      keepFraction: Math.min(1, Math.max(0, req.keepFraction ?? 0.5)),
      conservatism: Math.min(1, Math.max(0, req.conservatism ?? 0.5)),
      maxLegs: Math.max(1, Math.floor(req.maxLegs ?? 3)),
      candidates: optimizerCandidates,
    });
  }

  return {
    status: "ok",
    anchor: { id: anchor.id, venue: anchor.venue, title: anchor.title, marketTitle: anchor.marketTitle, probYes: Number(anchor.probYes.toFixed(4)), url: anchor.url },
    relations,
    robustHedge,
    universeSize: universe.length,
    semanticRecall: Boolean(semanticScore),
    pricedAt: new Date().toISOString(),
    candidateSnapshotsWritten,
  };
}
