/**
 * lib/polymarket/resolveAny.ts — DOMAIN-AGNOSTIC position resolution.
 *
 * The hedge engine's math is already domain-neutral (buy own NO works for "Trump wins"
 * exactly like "Spain wins"). The blocker is discovery: Gamma's `search` has poor recall
 * for live events, so we MERGE /public-search with the top-volume open-event listing,
 * keep only negRisk (mutually-exclusive) open events that share a token with the query,
 * rank by title-match + volume, then resolve the outcome within the best candidate.
 */
import { gammaGet } from "./client";
import { fetchEventBundle, resolvePosition, type ResolveResult } from "./resolve";
import { norm } from "./text";

interface EvLite {
  id?: string;
  slug?: string;
  title?: string;
  negRisk?: boolean;
  closed?: boolean;
  active?: boolean;
  volume?: number;
  volume24hr?: number;
}

function tokenSet(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((w) => w.length > 2));
}

async function gatherCandidates(query: string): Promise<EvLite[]> {
  const map = new Map<string, EvLite>();
  const add = (e?: EvLite) => {
    if (e?.slug && !map.has(e.slug)) map.set(e.slug, e);
  };
  try {
    const r = await gammaGet<{ events?: EvLite[] }>(`/public-search?q=${encodeURIComponent(query)}`);
    (r?.events ?? []).forEach(add);
  } catch {
    /* search is flaky — the volume listing below is the real net */
  }
  try {
    const r = await gammaGet<EvLite[]>(`/events?closed=false&active=true&order=volume24hr&ascending=false&limit=100`);
    (Array.isArray(r) ? r : []).forEach(add);
  } catch {
    /* ignore */
  }
  return [...map.values()];
}

interface Scored {
  e: EvLite;
  score: number;
}
function rankEvents(query: string, evs: EvLite[]): Scored[] {
  const qTokens = tokenSet(query);
  return evs
    .filter((e) => e.negRisk && !e.closed && (e.active ?? true) && e.slug)
    .map((e) => {
      const tTokens = tokenSet(e.title ?? "");
      let inter = 0;
      for (const t of qTokens) if (tTokens.has(t)) inter++;
      const titleScore = qTokens.size ? inter / Math.max(qTokens.size, tTokens.size) : 0;
      const vol = e.volume24hr ?? e.volume ?? 0;
      // Require a REAL title match (≥0.2); volume only ranks AMONG genuine matches, it can't
      // promote a one-generic-token coincidence ("race"/"bitcoin") into a match.
      return { e, score: titleScore + Math.min(0.15, vol / 1e7), titleScore };
    })
    .filter((x) => x.titleScore >= 0.2)
    .sort((a, b) => b.score - a.score);
}

export type AnyResolveResult = ResolveResult & { eventSlug?: string };

// Structural WC events whose ENTITY lives in the OUTCOMES, not the event title — so title-ranking
// can't find them ("Europe" / "France to reach the final" / "Mbappé golden boot"). We probe these
// by slug as a last resort, matching the query against their outcomes. Extend per season.
const STRUCTURAL_FALLBACK_SLUGS = [
  "world-cup-winner", // the NATION winner — its outcomes are nations ("France"), not in the event title,
  "which-continent-will-win-the-world-cup",
  "world-cup-nation-to-reach-final",
  "world-cup-golden-boot-winner",
];

/** Resolve a free-text position to the best live negRisk event + outcome, across domains. */
export async function resolveAnyPosition(query: string): Promise<AnyResolveResult> {
  const ranked = rankEvents(query, await gatherCandidates(query));

  // Scan the top candidates, but PREFER a decisive outcome RESOLVE over an event-level AMBIGUOUS
  // disambiguation. A higher title-overlap event ("Which continent will WIN THE WORLD CUP") can outrank
  // the nation-level "World Cup Winner" yet only offer a pick-an-outcome dead-end, while the lower-ranked
  // event actually CONTAINS the queried outcome ("France"). Returning on the first ambiguous (as before)
  // stranded the user on the continent picker; instead keep the first ambiguous as a fallback and keep
  // looking for a clean resolve.
  let fallback: AnyResolveResult | null = null;
  for (const c of ranked.slice(0, 5)) {
    const res = await resolvePosition(query, c.e.slug!);
    if (res.kind === "resolved") return { ...res, eventSlug: c.e.slug };
    if (res.kind === "ambiguous" && !fallback) fallback = { ...res, eventSlug: c.e.slug };
  }

  // Title-ranking found no clean outcome → try the structural events whose entity is an OUTCOME
  // (nation winner / continent / reach-final / golden-boot). Only a decisive "resolved" counts here; we
  // don't want a vague ambiguous match from an off-topic query to hijack the result.
  const results = await Promise.all(
    STRUCTURAL_FALLBACK_SLUGS.map((slug) => resolvePosition(query, slug).then((r) => ({ slug, r })).catch(() => null)),
  );
  for (const hit of results) {
    if (hit && hit.r.kind === "resolved") return { ...hit.r, eventSlug: hit.slug };
  }

  // No clean resolve anywhere → offer the best event-level disambiguation we did find.
  if (fallback) return fallback;
  if (ranked.length === 0) return { kind: "not_found", suggestions: [] };
  return { kind: "not_found", suggestions: ranked.slice(0, 5).map((c) => c.e.title ?? c.e.slug!) };
}
