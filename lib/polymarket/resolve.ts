/**
 * lib/polymarket/resolve.ts — free-text position → concrete market.
 *
 * Reliable path (per spec): pin the EVENT by slug, then fuzzy-match the team
 * against groupItemTitle (NOT question — all 60 questions are near-identical).
 * Parses the JSON-string fields (clobTokenIds / outcomePrices) at this boundary.
 */
import type { MarketRef } from "@/lib/types";
import { gammaGet, parseJsonArray } from "./client";
import { norm } from "./text";

interface RawMarket {
  conditionId?: string;
  question?: string;
  groupItemTitle?: string;
  clobTokenIds?: string | string[];
  outcomePrices?: string | string[];
  outcomes?: string | string[];
  negRiskMarketID?: string;
  closed?: boolean;
  resolved?: boolean;
  umaResolutionStatus?: string;
  closedTime?: string; // ISO time the market closed/resolved (gamma)
  endDate?: string; // ISO scheduled end (fallback resolution proxy)
  // per-market fee schedule (sports 0.03 / politics 0.04 / crypto 0.07 — read live)
  feeSchedule?: { rate?: number; exponent?: number; takerOnly?: boolean };
  feesEnabled?: boolean;
  feeRate?: number;
  feeRateBps?: number;
}
interface RawEvent {
  id?: string;
  slug?: string;
  title?: string;
  negRisk?: boolean;
  negRiskMarketID?: string;
  tags?: Array<{ slug?: string; label?: string; id?: string }> | string[];
  markets?: RawMarket[];
}

export interface EventBundle {
  eventId: string;
  slug: string;
  title: string;
  negRisk: boolean;
  negRiskMarketId: string | null;
  tags: string[];
  markets: MarketRef[];
  /** YES midpoints aligned with `markets`, for de-vigging. */
  yesPrices: number[];
}

export type ResolveResult =
  | { kind: "resolved"; bundle: EventBundle; index: number }
  | { kind: "ambiguous"; bundle: EventBundle; candidates: { index: number; title: string; score: number }[] }
  | { kind: "not_found"; suggestions: string[] };

function parseMarket(raw: RawMarket, event: RawEvent): MarketRef | null {
  const tokenIds = parseJsonArray(raw.clobTokenIds);
  if (tokenIds.length < 2 || !raw.conditionId) return null;
  const prices = parseJsonArray(raw.outcomePrices).map(Number);
  return {
    conditionId: raw.conditionId,
    eventId: String(event.id ?? ""),
    eventSlug: String(event.slug ?? ""),
    question: raw.question ?? "",
    groupItemTitle: raw.groupItemTitle ?? null,
    tokenIdYes: tokenIds[0],
    tokenIdNo: tokenIds[1],
    midpointYes: Number.isFinite(prices[0]) ? prices[0] : 0,
    resolved: Boolean(raw.resolved || raw.closed),
    resolvedAtMs: (() => {
      const t = raw.closedTime ? Date.parse(raw.closedTime) : raw.endDate ? Date.parse(raw.endDate) : NaN;
      return Number.isFinite(t) ? t : null;
    })(),
    feeRate: raw.feesEnabled === false ? 0 : raw.feeSchedule?.rate ?? (typeof raw.feeRate === "number" ? raw.feeRate : 0.03),
    feeExponent: raw.feeSchedule?.exponent ?? 1,
    feeTakerOnly: raw.feeSchedule?.takerOnly ?? true,
    negRiskMarketId: raw.negRiskMarketID ?? event.negRiskMarketID ?? null,
  };
}

function normTags(tags: RawEvent["tags"]): string[] {
  if (!tags) return [];
  return tags
    .map((t) => (typeof t === "string" ? t : (t.slug ?? t.label ?? t.id ?? "")))
    .filter(Boolean) as string[];
}

export async function fetchEventBundle(slug: string): Promise<EventBundle | null> {
  const events = await gammaGet<RawEvent[]>(`/events?slug=${encodeURIComponent(slug)}`);
  const event = Array.isArray(events) ? events[0] : (events as RawEvent | undefined);
  if (!event || !event.markets) return null;
  const markets = event.markets
    .map((m) => parseMarket(m, event))
    .filter((m): m is MarketRef => m !== null);
  return {
    eventId: String(event.id ?? ""),
    slug: String(event.slug ?? slug),
    title: event.title ?? slug,
    negRisk: Boolean(event.negRisk),
    negRiskMarketId: event.negRiskMarketID ?? null,
    tags: normTags(event.tags),
    markets,
    yesPrices: markets.map((m) => m.midpointYes),
  };
}

// ── fuzzy matching ──
function tokenSetScore(query: string, target: string): number {
  const q = new Set(norm(query).split(" ").filter(Boolean));
  const t = new Set(norm(target).split(" ").filter(Boolean));
  if (q.size === 0 || t.size === 0) return 0;
  let inter = 0;
  for (const w of q) if (t.has(w)) inter++;
  const sym = inter / Math.max(q.size, t.size);
  // query-coverage: a surname ("Newsom") should match a full name ("Gavin Newsom").
  const qcov = (inter / q.size) * 0.9;
  return Math.max(sym, qcov);
}

/**
 * Extract the distinguishing outcome tokens from free text — DOMAIN-NEUTRAL so it works
 * for "Spain wins the World Cup", "Newsom wins the 2028 nomination", "BTC above $150k".
 * Strips filler/verbs/years/category words but keeps the entity (team/candidate/level).
 */
function teamQuery(free: string): string {
  const stop = new Set([
    // generic filler / verbs / comparators
    "win", "wins", "winning", "won", "the", "a", "an", "to", "be", "will", "of", "in", "on", "by",
    "above", "below", "over", "under", "than", "reach", "reaches", "hit", "hits", "beat", "beats",
    "next", "for", "at", "is",
    // domain category words (the entity, not the category, is the discriminator)
    "world", "cup", "fifa", "tournament", "champion", "champions",
    // tournament-structure category words (golden boot / reach the final / advance a stage):
    // the player/team is the discriminator, not the prop type
    "golden", "boot", "scorer", "top", "goal", "goals", "final", "finals",
    "semifinal", "semifinals", "quarterfinal", "quarterfinals", "advance", "advances", "stage",
    "election", "president", "presidential", "nominee", "nomination", "primary", "race",
    "democratic", "republican", "party", "gop", "dem", "dems", "democrat",
    // common years
    "2024", "2025", "2026", "2027", "2028", "2029", "2030",
  ]);
  const words = norm(free)
    .split(" ")
    .filter((w) => w && !stop.has(w));
  return words.join(" ") || norm(free);
}

export async function resolvePosition(query: string, slug: string): Promise<ResolveResult> {
  const bundle = await fetchEventBundle(slug);
  if (!bundle || bundle.markets.length === 0) {
    return { kind: "not_found", suggestions: [] };
  }
  // Exact-title short-circuit: if the query exactly equals one outcome's title, resolve it
  // decisively. Needed because a draw label like "Draw (Spain vs. Saudi Arabia)" CONTAINS
  // "Spain", which otherwise makes the bare query "Spain" look ambiguous with the draw.
  const nq = norm(query);
  const exacts = bundle.markets
    .map((m, index) => ({ index, t: norm(m.groupItemTitle ?? m.question) }))
    .filter((x) => x.t.length > 0 && x.t === nq);
  if (exacts.length === 1) return { kind: "resolved", bundle, index: exacts[0].index };

  const tq = teamQuery(query);
  const ranked = bundle.markets
    .map((m, index) => ({ index, title: m.groupItemTitle ?? m.question, score: tokenSetScore(tq, m.groupItemTitle ?? m.question) }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0];
  const runnerUp = ranked[1] ?? { score: 0 };
  if (top.score >= 0.85 && top.score - runnerUp.score >= 0.15) {
    return { kind: "resolved", bundle, index: top.index };
  }
  if (top.score >= 0.5) {
    return { kind: "ambiguous", bundle, candidates: ranked.slice(0, 6) };
  }
  return { kind: "not_found", suggestions: ranked.slice(0, 6).map((r) => r.title) };
}

export { teamQuery, tokenSetScore };
