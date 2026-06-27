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
import { marketDimension, eventFamily, relationRole, mechanismSignature } from "./relationKey";
import { loadTuningProfile, lookupBucket, type BucketStat } from "./tuningProfile";
import { buildSuperposition, type SuperposeLeg, type SuperposeAnchor, type Superposition } from "./superpose";
import { deriveStructuralCompanions } from "./structuralCompanions";
import { selectRecallCandidates } from "./candidates";
import { buildSemanticScorer } from "./embed";
import { classifyPair } from "./classify";
import { buildOptimizerCandidates, priceSide } from "./toOptimizerCandidates";
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
  // SAME-EVENT COLLATERAL markets (live on Kalshi): in-game stats driven by the SAME matches as the
  // winner bet. Their hedge strength is MATCH-level — strong for a single-match bet, diluted for a
  // tournament winner (the team plays many matches) — and the elicited-φ gate weights them accordingly.
  "KXWCTOTALGOAL", // World Cup Total Goals (per match)
  "KXWCFTTS", // World Cup Team To Score First
  "KXWCFREEKICKGOAL",
  "KXWCFASTESTGOAL",
  "KXWCSOA", // World Cup Score or Assist
  // NARRATIVE / broadcast markets — the announcer-word / first-song family. Speculative + thin, kept in
  // the pool so soft associations are RECALLED (and then honestly gated by the φ + liquidity), not invisible.
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
  const t = norm(m.title);
  // placeholder / anonymized outcomes ("Player Q", "Person P", "Other", "the Field") have no resolvable
  // entity to reason about, and the conditional estimator returns degenerate φ for them.
  return /^(player|team|person|candidate)\s+[a-z0-9]{1,3}$/.test(t)
    || /^(other|another|the field|field|someone else|none of (the|these))$/.test(t);
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
  market: { id: string; venue: "polymarket" | "kalshi"; eventKey: string; title: string; marketTitle: string; probYes: number; url: string; category?: string; predicate?: string };
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
 *  (Fréchet-projected signed φ), NOT the unreliable mechanism MUTEX/CAUSAL label. The elicited sign is a
 *  LOW-CONFIDENCE MODELED signal (the WC-anchor eval in REFOCUS §4 measured only 36% sign accuracy on
 *  single-nation champions), so every such leg is MODELED until settlement calibration promotes it.
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
  scope: "same-event" | "cross-event"; // same match/event as the anchor (collateral) vs a different event
  dimension: string; // the orthogonal facet (scoreline/narrative/election/macro-policy/asset-price/…)
  tier: "CALIBRATED" | "MODELED"; // settlement-proven posterior vs LLM-elicited prior
  samples: number; // settlement observations backing this leg's relation template (0 = cold-start / no DB)
}

/** One leg inside a combo: a single bet you place, fully described. */
export interface HedgeComboLeg {
  marketId: string;
  venue: "polymarket" | "kalshi";
  title: string;        // the outcome you bet on, e.g. "Uzbekistan (-1.5)"
  marketTitle: string;  // the market it lives in
  url: string;
  side: "YES" | "NO";   // which side to buy
  legPrice: number;     // price of that side
  pGivenFails: number;  // P(this leg pays | your bet fails) — the fail-state it covers
  costUsd: number;      // dollars to put on this leg
  mechanism: string;    // why it pays when your bet fails
  dimension: string;    // the FACET of the event this leg covers (scoring/discipline/timing/narrative/…)
  scope: "same-event" | "cross-event"; // collateral on the anchor's own event, or a different event
  tier: "CALIBRATED" | "MODELED"; // settlement-proven posterior vs LLM-elicited prior
  samples: number;      // settlement observations backing this leg (0 = cold-start / no DB)
}

/** A COMBO = a basket of 1–4 complementary legs. Each leg covers a different way your bet can fail, so
 *  together they cover more of the fail-space than any single leg. Coverage assumes the legs are
 *  conditionally independent given the anchor outcome (legs are de-duplicated by scenario to limit overlap). */
export interface HedgeCombo {
  legs: HedgeComboLeg[];
  coverage: number;             // P(at least one leg pays | your bet fails)
  totalCostUsd: number;
  expectedReductionUsd: number; // expected downside cut if your bet fails (MODELED: assumes legs pay at pGivenFails)
  hedgedLossUsd: number;
  /** STRICT worst case if your bet fails AND no leg pays: you lose the stake AND the whole premium. Every
   *  soft leg can pay $0, so this is the honest probability-free floor, always ≥ the modeled hedgedLossUsd. */
  strictWorstLossUsd: number;
  keptIfWinUsd: number;
  rationale: string;
  tier: "CALIBRATED" | "MODELED"; // the combo's confidence = its WEAKEST leg (any MODELED leg ⇒ MODELED)
}

export interface DiscoverResult {
  status: "ok" | "ambiguous" | "not_found";
  strategies?: HedgeStrategy[];
  combos?: HedgeCombo[];
  /** The AGGRESSIVE↔CONSERVATIVE superposition: one stacked strategy per direction, from the same elicited
   *  conditionals. Aggressive raises the payoff if your bet WINS; conservative cuts the loss if it FAILS.
   *  Both are MODELED (LLM-elicited) and EV-negative; the knob reshapes the conditional payoff, not the EV. */
  directional?: { aggressive: Superposition; conservative: Superposition };
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
  /** Cross-event diversity quota at recall: markets from distinct other events injected so a combo can span
   *  dimensions the anchor's own event lacks. Default 8; set 0 to disable (e.g. cheap cron snapshots). */
  diversityK?: number;
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
 * Build both directions of the superposition, RE-PRICING every candidate leg at its REAL executable book
 * cost (de-vig fair + spread + fee) first. This is the honesty fix: the leg's de-vigged FAIR price equals
 * its modeled marginal, so at fair value every leg contributes EXACTLY 0 to EV (and a structural leg even
 * more so) — the displayed EV then collapses to ~0, hiding the vig. Pricing at the executable ask makes
 * marginal/price < 1, so the EV is genuinely negative (the vig you actually pay). Falls back to the
 * de-vigged price when a book is unavailable, so it degrades gracefully and never blocks a strategy.
 */
async function buildDirectionalSuperposition(
  anchor: SuperposeAnchor,
  budgetUsd: number,
  universeById: Map<string, NormalizedMarket>,
  aggLegs: SuperposeLeg[],
  consLegs: SuperposeLeg[],
): Promise<{ aggressive: Superposition; conservative: Superposition }> {
  const key = (l: SuperposeLeg) => `${l.marketId}|${l.side}`;
  const uniq = new Map<string, SuperposeLeg>();
  for (const l of [...aggLegs, ...consLegs]) if (l.marketId && universeById.has(l.marketId) && !uniq.has(key(l))) uniq.set(key(l), l);
  const exec = new Map<string, number>();
  await mapPool([...uniq.values()], 8, async (l) => {
    const priced = await priceSide(universeById.get(l.marketId!)!, l.side === "NO" ? "no" : "yes", budgetUsd).catch(() => null);
    if (priced && priced.price > 0 && priced.price < 1) exec.set(key(l), priced.price);
  });
  // HONESTY: keep ONLY legs we can price at the REAL executable book (walk + taker fee). A leg with no
  // fetchable book would otherwise keep its de-vigged FAIR price, making its EV contribution ≈ 0 and the
  // whole strategy look "free" — understating the vig. We cannot honestly state the cost of a companion we
  // cannot execute, so we DROP it (an unbuyable leg has no place in an actionable strategy). With every
  // surviving leg priced above fair, the strategy EV is genuinely negative by construction.
  const applyExec = (legs: SuperposeLeg[]) =>
    legs.flatMap((l) => { const q = l.marketId ? exec.get(key(l)) : undefined; return q != null ? [{ ...l, marginal: l.q, q }] : []; });
  return {
    aggressive: buildSuperposition(anchor, applyExec(aggLegs), 1, { riskBudgetUsd: budgetUsd }),
    conservative: buildSuperposition(anchor, applyExec(consLegs), 0, { riskBudgetUsd: budgetUsd }),
  };
}

const CALIB_MIN_SAMPLES = 20; // pooled observations per branch in a bucket before a leg is admitted CALIBRATED
const BUCKET_MIN_SAMPLES = 4; // minimum evidence before a learned bucket rule influences the prior at all
const BUCKET_PRIOR_STRENGTH = 12; // κ: the LLM prior counts as κ pseudo-samples in the shrink toward the bucket

/**
 * Apply the LEARNED bucket rule (role × mechanism × side) to ONE leg's modeled conditionals, for BOTH
 * branches: the FAIL branch shrinks toward bucket.pGivenFails (the hedge signal), the WIN branch toward
 * bucket.pGivenWins (the amplifier signal), each weighted by κ pseudo-samples of evidence. Both are then
 * re-clamped to the Fréchet-feasible bound so neither branch can claim a leg pays more often than its own
 * marginal allows. Tier promotes to CALIBRATED only when BOTH branches carry ≥ CALIB_MIN_SAMPLES of real
 * settlement evidence; a missing/weak bucket leaves the modeled values untouched at MODELED.
 *
 * Direction-AGNOSTIC: the caller decides whether the leg is a hedge (fail-leaning) or amplifier
 * (win-leaning) via its own gate. This is the SINGLE calibration path now shared by the "optimal hedge"
 * strategies AND the aggressive↔conservative superposition legs — so the superposition's confidence ladder
 * (MODELED → CALIBRATED) is finally driven by the moat, not stuck at MODELED.
 */
export function calibrateLeg(
  bucket: BucketStat | null,
  pWsideModeled: number,
  pFsideModeled: number,
  qSide: number,
  anchorWinProb: number,
): { pWside: number; pFside: number; tier: "CALIBRATED" | "MODELED"; samples: number } {
  const ap = Math.min(0.999, Math.max(0.001, anchorWinProb));
  let pWside = pWsideModeled;
  let pFside = pFsideModeled;
  let tier: "CALIBRATED" | "MODELED" = "MODELED";
  let samples = 0;
  if (bucket) {
    // Weight BOTH branches by the WEAKER branch's evidence (min samples). The hedge-vs-amplifier CONTRAST
    // (pFside − pWside, which decides admission) is only as trustworthy as the thinner branch, so an
    // ASYMMETRIC bucket (e.g. 5 fail / 18 win) cannot pull the win-branch harder than the fail-branch and
    // manufacture a spurious directional flip that vetoes a confident MODELED leg. A genuinely calibrated
    // bucket (≥20 BOTH branches) still earns enough weight to correctly disqualify a mis-signed leg.
    const m = Math.min(bucket.samplesFail, bucket.samplesWin);
    const w = m / (m + BUCKET_PRIOR_STRENGTH); // κ pseudo-samples of LLM prior, evidence on the weaker branch
    pFside = w * bucket.pGivenFails + (1 - w) * pFsideModeled;
    pWside = w * bucket.pGivenWins + (1 - w) * pWsideModeled;
    tier = m >= CALIB_MIN_SAMPLES ? "CALIBRATED" : "MODELED";
    samples = bucket.samplesFail + bucket.samplesWin;
  }
  // FRÉCHET FEASIBILITY — ALWAYS, bucket or not: a leg cannot pay more conditional on a state than its OWN
  // marginal allows. P(pay|fail) ≤ P(side)/P(fail); P(pay|win) ≤ P(side)/P(win). Without this a raw,
  // over-optimistic elicited conditional (common for a thin-book longshot: modeled pFail≈0.4 but market
  // marginal≈0.03) would be admitted as a "great hedge" and only later surface as a huge-vig loss.
  pFside = Math.min(0.999, Math.max(0.001, Math.min(pFside, qSide / Math.max(0.05, 1 - ap))));
  pWside = Math.min(0.999, Math.max(0.001, Math.min(pWside, qSide / Math.max(0.05, ap))));
  return { pWside, pFside, tier, samples };
}

/**
 * Build the validated cross-event hedge strategy list. The mechanism-classification MUTEX/CAUSAL label
 * is unreliable for sizing (it conflates "different party" with "mutually exclusive" — e.g. it wrongly
 * marks a Democratic-nominee market as a MUTEX hedge for a Republican's presidency). So we do NOT trust
 * it: we elicit P(candidate pays | anchor wins) and P(candidate pays | anchor fails) and derive a
 * Fréchet-projected SIGNED φ. This is a MODELED prior (measured at only ~36% sign accuracy on the WC
 * champion eval, REFOCUS §4), gated by settlement calibration before it is ever trusted. A candidate is a genuine hedge only when
 * its bought side pays MEANINGFULLY more often when the anchor fails than when it wins, and more than its
 * own base rate. Everything is then priced from the real conditionals. Exploratory layer only.
 */
async function buildCrossEventStrategies(
  anchor: { title: string; marketTitle: string; eventKey: string; url: string; probYes: number; category?: string; eventFamily?: string },
  relations: DiscoveredRelation[],
  stakeUsd: number,
  baseWinnings: number,
  entryPrice: number,
  universe: NormalizedMarket[],
): Promise<{ strategies: HedgeStrategy[]; directional: { aggressive: Superposition; conservative: Superposition } }> {
  const universeById = new Map(universe.map((m) => [m.id, m]));
  const hedgeLikely = (r: DiscoveredRelation) => {
    const h = r.hypothesis;
    if (!h) return 0;
    return (h.direction === "NEGATIVE" ? 2 : 0) + (h.relation === "MUTEX" || h.relation === "IMPLICATION" || h.relation === "CAUSAL" ? 1 : 0);
  };
  // Exclude same-event and same-ENTITY companions. For grouped markets the anchor label can be generic
  // ("Champion", "Final"), while the entity lives in the event title ("Spain Stage of Elimination").
  // Those prerequisite NO legs are still shorting the user's own outcome, not a cross-event companion.
  const entityStop = new Set([
    "the", "to", "win", "wins", "winner", "world", "cup", "stage", "elimination", "champion",
    "final", "semifinals", "quarterfinals", "knockout", "round", "group", "polymarket", "kalshi",
    // generic category / temporal words — NOT the distinguishing entity (else two different people in
    // the same race, e.g. Newsom vs Raimondo, look like the "same entity" via "presidential"/"2028").
    "presidential", "election", "president", "nominee", "nomination", "democratic", "republican",
    "party", "primary", "season", "championship", "match", "total", "goals", "score",
    "2024", "2025", "2026", "2027", "2028", "2029", "2030",
  ]);
  const entityTokens = (text: string) => norm(text).split(" ").filter((w) => w.length > 2 && !entityStop.has(w));
  const anchorTokens = new Set(entityTokens(`${anchor.title} ${anchor.marketTitle}`));
  const sharesEntity = (r: DiscoveredRelation) =>
    entityTokens(`${r.market.title} ${r.market.marketTitle}`).some((w) => anchorTokens.has(w));
  const sameEvent = (r: DiscoveredRelation) =>
    r.market.eventKey === anchor.eventKey || r.market.url === anchor.url || norm(r.market.marketTitle) === norm(anchor.marketTitle);
  // Same-MATCH collateral (a different market on the SAME match: "Portugal total goals", "Uzbekistan
  // +1.5", match "total goals O/U" for a "Portugal beats Uzbekistan" anchor) is exactly what we want and
  // SHOULD share the match's teams — so include any market whose title nests the anchor's match identity
  // and let the elicited-φ gate decide. For genuinely DIFFERENT events, keep the strict cross-event rule.
  const anchorMt = norm(anchor.marketTitle);
  const eligible = relations
    .filter((r) => {
      const mt = norm(r.market.marketTitle);
      if (mt === anchorMt) return false; // the other side of the same bet (rival outcome)
      if (anchorMt.length > 6 && (mt.includes(anchorMt) || anchorMt.includes(mt))) return true; // same-match collateral; φ decides
      if (r.recall === "diversity") return !sameEvent(r) && !sharesEntity(r); // cross-event diversity; φ decides
      return r.classifyMethod !== "rule" && !sameEvent(r) && !sharesEntity(r); // genuine cross-event
    })
    .sort((a, b) => hedgeLikely(b) - hedgeLikely(a));
  // Reserve elicitation slots for cross-event DIVERSITY candidates so a self-contained anchor (a single
  // match) can still reach other dimensions; the rest go to the similarity-recalled (same-event) legs.
  const diverse = eligible.filter((r) => r.recall === "diversity").slice(0, 10);
  const similar = eligible.filter((r) => r.recall !== "diversity").slice(0, 16);
  const cands = [...new Map([...similar, ...diverse].map((r) => [r.market.id, r])).values()].slice(0, 24);
  if (cands.length === 0) {
    // No LLM candidates — but logically-certain structural companions (continent basket) still apply.
    const superAnchor = { winProb: Math.min(0.999, Math.max(0.001, anchor.probYes)), stakeUsd, entryPrice };
    const superBudget = Math.min(0.5 * baseWinnings, stakeUsd);
    const structural = deriveStructuralCompanions({ title: anchor.title, probYes: superAnchor.winProb }, universe);
    return { strategies: [], directional: await buildDirectionalSuperposition(superAnchor, superBudget, universeById, structural, structural) };
  }
  const anchorTitle = `${anchor.title} (${anchor.marketTitle})`;
  const ap = Math.min(0.999, Math.max(0.001, anchor.probYes));
  const PHI_MIN = 0.12; // meaningful dependence
  const CONF_MIN = 0.35; // elicitation-confidence floor
  // A cross-DOMAIN (diversity) leg claims a correlation between unrelated events, which is rare and easy to
  // hallucinate, so hold it to a stricter bar than a same-event collateral leg.
  const DIVERSITY_PHI_MIN = 0.25;
  const DIVERSITY_CONF_MIN = 0.5;
  // The LEARNED tuning profile: realized conditional payoff per structural bucket (role × mechanism × side),
  // pooled across ALL templates. This is the generalizable rule, applied to every leg including unseen ones.
  const tuning = await loadTuningProfile();
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
  for (const x of elicited) {
    if (!x) continue;
    const { r, pW, pF, phi, conf, reason } = x;
    const phiMin = r.recall === "diversity" ? DIVERSITY_PHI_MIN : PHI_MIN;
    const confMin = r.recall === "diversity" ? DIVERSITY_CONF_MIN : CONF_MIN;
    if (Math.abs(phi) < phiMin || conf < confMin) continue;
    const buyYes = phi < 0; // anti-correlated → the candidate's YES pays when your bet fails
    const qSide = Math.min(0.98, Math.max(0.02, buyYes ? r.market.probYes : 1 - r.market.probYes));
    const pWsideModeled = buyYes ? pW : 1 - pW; // P(bought side pays | anchor wins), before calibration
    // P(bought side pays | anchor fails). The model's level often disagrees with the price; clamp to the
    // market-feasible bound P(side)/P(anchor fails) so the payoff stays consistent with the real price.
    const pFsideModeled = Math.min(buyYes ? pF : 1 - pF, qSide / Math.max(0.05, 1 - ap));
    // ── LEARNED-RULE tuning (not a per-template lookup): map this leg to its structural bucket (relation
    // ROLE × mechanism TYPE × bought SIDE) and apply the rule the moat learned for that bucket across ALL
    // templates. The bucket's realized P(pays | anchor fails) shrinks the LLM prior toward what outcomes of
    // this STRUCTURE actually do (κ pseudo-samples), so a never-seen pair is still tuned by its role; a
    // well-evidenced bucket with positive specificity promotes the leg to CALIBRATED. Empty profile (no DB)
    // ⇒ untouched MODELED prior at zero cost. ──
    const side: "yes" | "no" = buyYes ? "yes" : "no";
    const candidateFamily = r.mechanismGraph?.candidateEventClass ?? eventFamily(r.market.marketTitle, r.market.category ?? "");
    const role = relationRole(`${anchor.title} ${anchor.marketTitle}`, { entity: r.market.title, family: candidateFamily, context: `${r.market.marketTitle} ${r.market.title}`, mechanismGraph: r.mechanismGraph });
    const mechType = mechanismSignature(r.mechanismGraph, r.hypothesis?.direction)?.split(".")[0] ?? "rule";
    // Shrink BOTH branches toward what this STRUCTURE actually settled (the moat's learned rule), then
    // Fréchet-clamp. The hedge gate below decides admission — a leg mapped to an amplifier-shaped bucket
    // sees its fail payoff shrink below its win payoff and is correctly rejected as a hedge.
    const cal = calibrateLeg(lookupBucket(tuning, role, mechType, side, BUCKET_MIN_SAMPLES), pWsideModeled, pFsideModeled, qSide, ap);
    const { pWside, pFside, tier, samples } = cal;
    const edge = pFside / qSide - 1; // expected hedge return per $1 spent, when your bet fails
    if (edge <= 0 || pFside <= pWside) continue; // must beat its price on fail, and pay more on fail than win
    // Spend at most enough to cover the stake (stake*qSide) AND at most half the bet's own upside, so the
    // hedge never costs more than you would win (a heavy favorite has small winnings, so its hedge is
    // small). Cut = cost × per-dollar edge, capped at the stake (you cannot recover more than you risked).
    const costUsd = Math.min(stakeUsd * qSide, 0.5 * baseWinnings);
    const expectedReductionUsd = Math.min(costUsd * edge, stakeUsd);
    // Same-event collateral (a different market on the anchor's OWN match/event) vs a different event. The
    // diversity-recall legs are always cross-event; a same-match market nests the anchor's match identity.
    const mt = norm(r.market.marketTitle);
    const scope: "same-event" | "cross-event" =
      r.recall !== "diversity" && anchorMt.length > 6 && (mt.includes(anchorMt) || anchorMt.includes(mt)) ? "same-event" : "cross-event";
    out.push({
      marketId: r.market.id, venue: r.market.venue, title: r.market.title, marketTitle: r.market.marketTitle,
      probYes: r.market.probYes, url: r.market.url, side: buyYes ? "YES" : "NO",
      legPrice: Number(qSide.toFixed(4)), phi: Number(phi.toFixed(3)), pGivenFails: Number(pFside.toFixed(3)),
      pGivenWins: Number(pWside.toFixed(3)), confidence: Number(conf.toFixed(2)), costUsd: Number(costUsd.toFixed(2)),
      expectedReductionUsd: Number(expectedReductionUsd.toFixed(2)), hedgedLossUsd: Number((stakeUsd - expectedReductionUsd).toFixed(2)),
      keptIfWinUsd: Number((baseWinnings - costUsd).toFixed(2)), mechanism: reason.slice(0, 160), scope,
      dimension: hedgeDimension({ title: r.market.title, marketTitle: r.market.marketTitle, category: r.market.category }),
      tier, samples,
    });
  }
  // ── SUPERPOSITION: the AGGRESSIVE↔CONSERVATIVE direction knob, built from the SAME elicited conditionals
  // (no extra LLM cost). A leg pays-on-WIN with prob pW and pays-on-FAIL with prob pF; its NO side flips both.
  // Conservative stacks fail-paying legs (smaller loss if you fail); aggressive stacks win-paying legs (higher
  // payoff if you win). EV stays negative either way — the price already carries the vig. The legs are logically
  // related because every leg is conditioned on the SAME pivotal event (your bet's outcome) and shares its sign. ──
  const toSuperposeLegs = (direction: number): SuperposeLeg[] => {
    const legs: SuperposeLeg[] = [];
    for (const x of elicited) {
      if (!x || x.conf < CONF_MIN) continue;
      const { r, pW, pF, reason } = x;
      const qYes = Math.min(0.98, Math.max(0.02, r.market.probYes));
      // Map to the structural bucket (same role × mechanism as the hedge path) and CALIBRATE BOTH sides:
      // the win-branch shrinks toward the bucket's amplifier signal, the fail-branch toward its hedge
      // signal. So a superposition leg is promoted to CALIBRATED when the moat has real evidence for its
      // structure — the aggressive AND conservative ladders are finally moat-driven, not stuck at MODELED.
      const candidateFamily = r.mechanismGraph?.candidateEventClass ?? eventFamily(r.market.marketTitle, r.market.category ?? "");
      const role = relationRole(`${anchor.title} ${anchor.marketTitle}`, { entity: r.market.title, family: candidateFamily, context: `${r.market.marketTitle} ${r.market.title}`, mechanismGraph: r.mechanismGraph });
      const mechType = mechanismSignature(r.mechanismGraph, r.hypothesis?.direction)?.split(".")[0] ?? "rule";
      const yesCal = calibrateLeg(lookupBucket(tuning, role, mechType, "yes", BUCKET_MIN_SAMPLES), pW, pF, qYes, ap);
      const noCal = calibrateLeg(lookupBucket(tuning, role, mechType, "no", BUCKET_MIN_SAMPLES), 1 - pW, 1 - pF, 1 - qYes, ap);
      const sides = [
        { side: "YES" as const, q: qYes, win: yesCal.pWside, fail: yesCal.pFside, tier: yesCal.tier },
        { side: "NO" as const, q: 1 - qYes, win: noCal.pWside, fail: noCal.pFside, tier: noCal.tier },
      ];
      // aggressive (λ≥.5) wants the side that leans WIN; conservative wants the side that leans FAIL.
      const lean = (s: typeof sides[number]) => (direction >= 0.5 ? s.win - s.fail : s.fail - s.win);
      const pick = lean(sides[0]) >= lean(sides[1]) ? sides[0] : sides[1];
      if (lean(pick) <= 0) continue; // no directional tilt on either side ⇒ not a companion for this direction
      legs.push({
        id: r.market.id, marketId: r.market.id, marketTitle: r.market.marketTitle, title: r.market.title, side: pick.side,
        q: Math.min(0.98, Math.max(0.02, pick.q)), pWin: pick.win, pFail: pick.fail, tier: pick.tier,
        dimension: hedgeDimension({ title: r.market.title, marketTitle: r.market.marketTitle, category: r.market.category }),
        mechanism: reason.slice(0, 160),
      });
    }
    return legs;
  };
  const superAnchor = { winProb: ap, stakeUsd, entryPrice };
  // Companion budget = min(half the potential winnings, the stake) — a longshot's winnings are huge, so the
  // stake cap keeps the companion spend sane (you never risk more on companions than the bet itself).
  const superBudget = Math.min(0.5 * baseWinnings, stakeUsd);
  // ANALYTIC structural companions (continent basket: anchor ⊆ own continent = amplifier, ⟂ others = hedge)
  // are deterministic and appear EVERY run, ahead of the per-draw MODELED elicited legs.
  const structural = deriveStructuralCompanions({ title: anchor.title, probYes: ap }, universe);
  const directional = await buildDirectionalSuperposition(
    superAnchor, superBudget, universeById,
    [...structural, ...toSuperposeLegs(1)], [...structural, ...toSuperposeLegs(0)],
  );

  return {
    strategies: out
      .sort((a, b) => b.expectedReductionUsd - a.expectedReductionUsd || b.confidence - a.confidence)
      .slice(0, 10), // keep extra legs as raw material for combo construction
    directional,
  };
}

// Facets (DIMENSIONS) of an event a hedge leg can cover. A combo must span GENUINELY ORTHOGONAL dimensions —
// facets that can vary independently of one another. The hard lesson: total goals, a team's goals, the winning
// margin/handicap, the exact score and win/draw/lose are ALL monotone functions of the goals scored, so they
// are ONE dimension (the SCORELINE) — pairing "total under" with "margin under" is fake diversification, the
// same underlying factor twice. Truly different dimensions are the ones a scoreline does not determine:
// discipline (a red card), timing (the first goal), narrative (what the announcer says), an individual player,
// the method of decision (penalties). Order matters — these orthogonal facets must be tested BEFORE the
// scoreline catch-all (since "first GOAL", "player to SCORE" contain goal/score words). Same-market outcomes
// share a dimension. The canonical user case: "team loses" hedged by "announcer says 'upset'" (narrative).
const DIMENSION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(announc|commentat|broadcast|says?|said|song|anthem|chant|mention|celebrat|trophy|interview|halftime show)\b/i, "narrative"],
  [/\b(red\s?cards?|yellow\s?cards?|bookings?|cards?|fouls?|sent off|ejection|var\b|penalty (kick )?awarded)\b/i, "discipline"],
  [/\b(first goal|opening goal|first (team )?to score|first scorer|next goal|earliest goal|injury time|stoppage time|kick[- ]?off time|goal before \d|goal after \d)\b/i, "timing"],
  [/\b(to score|scorer|golden boot|assists?|hat[- ]?trick|man of the match|motm|mvp|brace)\b/i, "individual"],
  [/\b(penalt|extra time|shoot[- ]?out|advance|qualif|progress|go through|knockout|to win the (group|tie))\b/i, "method"],
  // politics facets (tested before the scoreline catch-all so a stray digit can't mislabel them)
  [/\b(nominee|nomination|primary)\b/i, "nomination"],
  [/\b(senate|house|governor|gubernatorial|congress|representative)\b/i, "downballot"],
  [/\b(vote share|popular vote|% of vote|share of the vote|electoral votes?)\b/i, "voteshare"],
  [/\b(turnout|approval|favorab|disapprov)\b/i, "sentiment"],
  // SCORELINE catch-all: every goal/margin/result metric (one dimension; do NOT split these).
  [/\b(o\s*\/?\s*u|over|under|total|goals?|score|handicap|spread|win by|margin|to nil|clean sheet|both teams to score|btts|draw|win|lose|loss|result)\b/i, "scoreline"],
  [/(\(|\s)[+\-]\s?\d|\d\s*[-:]\s*\d/i, "scoreline"], // handicaps (-1.5) and exact scorelines (0 - 0)
];
function hedgeDimension(s: { title: string; marketTitle: string; category?: string }): string {
  // Classify on the market's OWN labels only, never the LLM mechanism prose (it contains jargon like
  // "the candidate market"/"score" that would mislabel the facet). Order: (1) keyword facet rules — these
  // correctly collapse every goal/margin/handicap/exact-score metric into `scoreline`; (2) any sports market
  // with no specific facet is still a scoreline/result bet; (3) cross-domain falls to the canonical event
  // class as its dimension (election / macro-policy / asset-price / geopolitics …), so a Fed or election
  // anchor can span genuinely orthogonal facets.
  const hay = `${s.title} ${s.marketTitle}`;
  for (const [re, dim] of DIMENSION_RULES) if (re.test(hay)) return dim;
  if (/\bvs\.?\b|soccer|football|basketball|baseball|hockey|tennis|world.?cup|league|\bmatch\b|\bgame\b/i.test(`${s.marketTitle} ${s.category ?? ""}`)) return "scoreline";
  return marketDimension(s.marketTitle, s.category ?? "");
}

/**
 * Build multi-leg hedge COMBOS from the validated single legs. A combo bundles 1–4 legs that each cover a
 * DIFFERENT DIMENSION of the event (scoring vs discipline vs timing vs narrative vs nomination …), so it
 * diversifies across the ways your bet can fail rather than restating one market's outcomes. At most ONE leg
 * per dimension: mutually-exclusive outcomes of a single market (several nominees, several O/U thresholds)
 * collapse to one and never stack. Legs are assembled greedily by expected cut; coverage uses a conditional-
 * independence model (stated in the UI); legs are sized to pay the stake if they hit, cost capped at half the upside.
 */
function buildCombos(legs: HedgeStrategy[], stakeUsd: number, baseWinnings: number): HedgeCombo[] {
  if (legs.length === 0) return [];
  // Keep at most ONE leg per DIMENSION (the best by single-leg cut). Two legs on the same facet (two scoring
  // props, two nominees) cover the same kind of fail state, so only the strongest survives; a multi-leg
  // combo is therefore multi-dimensional by construction.
  const byDimension = new Map<string, HedgeStrategy>();
  for (const s of [...legs].sort((a, b) => b.expectedReductionUsd - a.expectedReductionUsd)) {
    const k = s.dimension;
    if (!byDimension.has(k)) byDimension.set(k, s);
  }
  const distinct = [...byDimension.values()];
  // Spend at most HALF the bet's upside on the whole combo, with NO floor: an extreme favorite has tiny
  // winnings, so its hedge budget is tiny (and may round to nothing). This guarantees kept-if-win =
  // baseWinnings - totalCost >= 0.5*baseWinnings > 0 — you can never spend more than the bet can win.
  const budget = 0.5 * baseWinnings;
  // Allocate the budget across distinct-aspect legs in priority order: each leg gets up to enough to pay
  // the stake if it hits (stake*legPrice), highest-priority first, until the budget or 4 legs run out. So
  // the total cost never exceeds the budget and kept-if-win stays positive.
  const assemble = (ordered: HedgeStrategy[], capPerLeg = Infinity): HedgeCombo => {
    let remaining = budget;
    const picks: { s: HedgeStrategy; cost: number }[] = [];
    for (const s of ordered) {
      if (picks.length >= 4 || remaining <= 0.05) break;
      const cost = Math.min(stakeUsd * s.legPrice, capPerLeg, remaining);
      if (cost <= 0.05) continue;
      picks.push({ s, cost });
      remaining -= cost;
    }
    // Honest joint coverage (Boole–Fréchet aware, cf. PortBench's full-covariance point). Group legs by
    // market: distinct-ENTITY partition outcomes in one market (different nominees) are MUTUALLY EXCLUSIVE →
    // additive (Σ, capped); same-market PROP legs (over/under, handicaps) are positively CORRELATED (driven
    // by one match) → conservative max. Across markets, conditionally independent. The expected cut is a sum
    // of per-leg expectations and stays correct by linearity regardless of correlation.
    const isProp = (t: string) => /\b(o\s*\/?\s*u|over|under|total|goals?|half|handicap|spread)\b/i.test(t) || /[+(\-]\s*\d/.test(t);
    const groups = new Map<string, { sum: number; max: number; prop: boolean }>();
    for (const { s } of picks) {
      const g = groups.get(s.marketTitle) ?? { sum: 0, max: 0, prop: false };
      groups.set(s.marketTitle, { sum: Math.min(1, g.sum + s.pGivenFails), max: Math.max(g.max, s.pGivenFails), prop: g.prop || isProp(s.title) });
    }
    const coverage = 1 - [...groups.values()].reduce((p, g) => p * (1 - (g.prop ? g.max : g.sum)), 1);
    const totalCost = picks.reduce((c, x) => c + x.cost, 0);
    // expected cut = Σ (allocation × the leg's per-dollar edge when your bet fails), capped at the stake.
    const cut = Math.min(picks.reduce((c, { s, cost }) => c + cost * (s.pGivenFails / Math.max(0.02, s.legPrice) - 1), 0), stakeUsd);
    return {
      legs: picks.map(({ s, cost }) => ({
        marketId: s.marketId, venue: s.venue, title: s.title, marketTitle: s.marketTitle, url: s.url,
        side: s.side, legPrice: s.legPrice, pGivenFails: s.pGivenFails, costUsd: Number(cost.toFixed(2)),
        mechanism: s.mechanism, dimension: s.dimension, scope: s.scope, tier: s.tier, samples: s.samples,
      })),
      coverage: Number(coverage.toFixed(3)),
      totalCostUsd: Number(totalCost.toFixed(2)),
      expectedReductionUsd: Number(Math.max(0, cut).toFixed(2)),
      hedgedLossUsd: Number((stakeUsd - Math.max(0, cut)).toFixed(2)),
      // strict worst case: bet fails AND no soft leg pays ⇒ stake lost + full premium spent.
      strictWorstLossUsd: Number((stakeUsd + totalCost).toFixed(2)),
      keptIfWinUsd: Number((baseWinnings - totalCost).toFixed(2)),
      // combo confidence = its WEAKEST leg: any LLM-prior (MODELED) leg keeps the whole combo MODELED.
      tier: picks.every(({ s }) => s.tier === "CALIBRATED") ? "CALIBRATED" : "MODELED",
      rationale: picks.length > 1
        ? `Bundles ${picks.length} legs across different facets (${[...new Set(picks.map(({ s }) => s.dimension))].join(", ")}); each pays when your bet fails a different way. Covers ~${Math.round(coverage * 100)}% of fail states.`
        : `A single-leg ${picks[0].s.dimension} hedge covering ~${Math.round(coverage * 100)}% of your fail states.`,
    };
  };
  // Orderings → genuinely different combos: best value; a DIVERSIFIED basket that splits the budget evenly
  // across up to 4 distinct dimensions (so the multi-facet structure shows even when one leg would otherwise
  // eat the budget); a CROSS-EVENT-FIRST basket that leads with a genuine different-event leg when one passes
  // the gate and falls back to same-event collateral otherwise (the user's priority); the single strongest
  // leg. Dedupe by leg set; rank by cut.
  const byCut = [...distinct].sort((a, b) => b.expectedReductionUsd - a.expectedReductionUsd);
  const byCoverage = [...distinct].sort((a, b) => b.pGivenFails - a.pGivenFails);
  // cross-event first, then same-event collateral; within each, best cut first (so the fallback is ordered too)
  const crossFirst = [...distinct].sort((a, b) =>
    (a.scope === "cross-event" ? 0 : 1) - (b.scope === "cross-event" ? 0 : 1) || b.expectedReductionUsd - a.expectedReductionUsd);
  const spreadCap = budget / Math.min(4, Math.max(1, distinct.length)); // even split across up to 4 facets
  const seen = new Set<string>();
  const combos: HedgeCombo[] = [];
  for (const c of [assemble(byCut), assemble(byCut, spreadCap), assemble(crossFirst, spreadCap), assemble(byCoverage), assemble(byCut.slice(0, 1))]) {
    if (!c.legs.length) continue;
    const key = c.legs.map((l) => l.marketId).sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    combos.push(c);
  }
  return combos.sort((a, b) => b.expectedReductionUsd - a.expectedReductionUsd).slice(0, 4);
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
  // CAUSAL recall: the LLM shortlist explicitly targets non-obvious cross-domain mechanisms (Fed↔crypto,
  // regime↔oil) that lexical/embedding similarity misses. Run it ALONGSIDE embeddings (not only as their
  // fallback), so its picks are merged in and then gated by the elicited-φ test like any other candidate.
  const llmRecall = await recallCandidatesWithQwen(anchor, universe, Math.max(topK, 12), {
    onDiagnostics: (diagnostics) => { recallDiagnostics = diagnostics; },
  }).catch(() => null);
  const rawCandidates = selectRecallCandidates(anchor, universe, {
    topK,
    semanticScore: semanticScore ?? undefined,
    llmRecall,
    allowCrossCategory: true,
    minSimilarity: semanticScore ? 0.12 : 0.08,
    // Inject cross-event markets from distinct other events so a combo can reach DIMENSIONS the anchor's own
    // event lacks (its own match only has goals/handicap markets). The elicited-φ gate rejects non-hedges.
    diversityK: Math.max(0, req.diversityK ?? 8),
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
        market: { id: pair.b.id, venue: pair.b.venue, eventKey: pair.b.eventKey, title: pair.b.title, marketTitle: pair.b.marketTitle, probYes: Number(pair.b.probYes.toFixed(4)), url: pair.b.url, category: pair.b.category, predicate: pair.b.predicate },
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
  // Upside basis is the user's OWN entry (your winnings = stake·(1−entry)/entry), so the combo/strategy
  // cards share the same basis as the optimizer card above (which already prices off entryPrice). Falls
  // back to the current de-vigged price when no entry was supplied (entryPrice defaults to anchor.probYes).
  const baseWinnings = stakeUsd * (1 - entryPrice) / entryPrice;
  const strategyResult = req.withStrategies
    ? await buildCrossEventStrategies(
        { title: anchor.title, marketTitle: anchor.marketTitle, eventKey: anchor.eventKey, url: anchor.url, probYes: anchor.probYes, category: anchor.category, eventFamily: anchor.eventFamily },
        relations, stakeUsd, baseWinnings, entryPrice, universe,
      ).catch(() => null)
    : null;
  const strategies = strategyResult?.strategies;
  const directional = strategyResult?.directional;
  const combos = strategies && strategies.length ? buildCombos(strategies, stakeUsd, baseWinnings) : undefined;

  return {
    status: "ok",
    strategies,
    combos,
    directional,
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
