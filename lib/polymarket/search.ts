/**
 * lib/polymarket/search.ts — typeahead discovery over REAL, live Polymarket markets.
 *
 * Three scopes, all returning only markets that actually exist live (the "real, not
 * fabricated" guarantee the product is built on):
 *   - searchEvents:   cross-domain negRisk events via Gamma /public-search (for the hedge
 *                     flow — multi-outcome events you can hold a position in).
 *   - searchFixtures: real World Cup match fixtures matching the typed team (for /plan).
 *   - searchOutcomes: the live outcomes of one event (step 2 after picking an event).
 */
import uFuzzy from "@leeoniya/ufuzzy";
import { gammaGet } from "./client";
import { fetchFixtures, type Fixture } from "./fixtures";
import { fetchEventBundle, tokenSetScore } from "./resolve";
import { norm } from "./text";

// Single-typo-tolerant matcher (Damerau-Levenshtein) for the local fixture list, so
// "Bayrn"→Bayern / "Croatai"→Croatia still surface. ~7.5KB, no index build — fine per request.
const uf = new uFuzzy({ intraMode: 1 });

/** Teams (from a small list) that uFuzzy matches against the query, with typo tolerance. */
function fuzzyMatches(query: string, haystack: string[]): Set<string> {
  const needle = query.trim();
  if (needle.length < 3 || haystack.length === 0) return new Set();
  try {
    const idxs = uf.filter(haystack, needle);
    if (!idxs || idxs.length === 0) return new Set();
    return new Set(idxs.map((i) => haystack[i]));
  } catch {
    return new Set();
  }
}

/**
 * Tiny TTL + in-flight-dedupe memo. The Gamma host rate-limits (~60 req/min); typeahead
 * fires per keystroke, so we cache identical lookups briefly and collapse concurrent
 * identical requests into one. Stateless-friendly: a plain module Map, no DB.
 */
const memo = new Map<string, { at: number; val: unknown }>();
const inflight = new Map<string, Promise<unknown>>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < ttlMs) return hit.val as T;
  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;
  const p = (async () => {
    try {
      const val = await fn();
      memo.set(key, { at: Date.now(), val });
      return val;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p as Promise<T>;
}

export interface MarketSuggestion {
  label: string; // primary display line
  value: string; // text to place into the input on select
  sub: string; // secondary line (volume / date / implied %)
  slug: string;
  kind: "event" | "fixture" | "outcome";
}

interface EvLite {
  slug?: string;
  title?: string;
  negRisk?: boolean;
  closed?: boolean;
  active?: boolean;
  volume?: number;
  volume24hr?: number;
}

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter((w) => w.length > 1));
}
function overlap(q: Set<string>, t: Set<string>): number {
  if (!q.size) return 0;
  let i = 0;
  for (const w of q) if (t.has(w)) i++;
  return i / q.size;
}
/** Fraction of query words that prefix- or substring-match any target word (typeahead). */
function prefixCover(q: Set<string>, t: Set<string>): number {
  if (!q.size) return 0;
  let hits = 0;
  for (const w of q) {
    for (const tw of t) {
      if (tw.startsWith(w) || w.startsWith(tw) || (w.length >= 4 && tw.includes(w))) {
        hits++;
        break;
      }
    }
  }
  return hits / q.size;
}
function vol(v: number): string {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

/** Cross-domain real events for the hedge flow (multi-outcome / negRisk only). */
export async function searchEvents(q: string, limit = 8): Promise<MarketSuggestion[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  let evs: EvLite[] = [];
  try {
    const r = await cached(`ps:${query.toLowerCase()}`, 15_000, () =>
      gammaGet<{ events?: EvLite[] }>(`/public-search?q=${encodeURIComponent(query)}&limit_per_type=20`),
    );
    evs = r?.events ?? [];
  } catch {
    return [];
  }
  const qt = tokens(query);
  // /public-search already ranked by relevance (it handles partial words); we only keep
  // open, multi-outcome (negRisk) events and re-rank by token overlap + a small volume nudge.
  return evs
    .filter((e) => Boolean(e.slug) && e.negRisk === true && !e.closed && (e.active ?? true))
    .map((e) => ({ e, score: overlap(qt, tokens(e.title ?? "")) + Math.min(0.1, (e.volume24hr ?? e.volume ?? 0) / 1e8) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ e }) => ({
      label: e.title ?? e.slug!,
      value: e.title ?? "",
      sub: `${vol(e.volume24hr ?? e.volume ?? 0)} volume · multi-outcome market`,
      slug: e.slug!,
      kind: "event" as const,
    }));
}

// Real fixtures change rarely within a session; cache 60s + dedupe concurrent loads so
// per-keystroke search is snappy and never fires the multi-page fixture fetch twice at once.
function cachedFixtures(): Promise<Fixture[]> {
  return cached("fixtures", 60_000, fetchFixtures);
}

/** Real World Cup fixtures whose teams match the query, for the bet-plan flow. */
export async function searchFixtures(q: string, limit = 8): Promise<MarketSuggestion[]> {
  const query = q.trim();
  if (query.length < 2) return [];
  // If the user already typed a scoreline, keep it so selecting preserves their exact bet.
  const score = query.match(/(\d+)\s*[:\-]\s*(\d+)/);
  const scoreSuffix = score ? ` ${score[1]}:${score[2]}` : "";
  const qStripped = query.replace(/(\d+)\s*[:\-]\s*(\d+)/, " ").replace(/\b(vs\.?|beats?|v)\b/gi, " ");
  const qt = tokens(qStripped);
  const fixtures = await cachedFixtures();
  // uFuzzy over the unique team list adds single-typo tolerance on top of overlap/prefix.
  const allTeams = [...new Set(fixtures.flatMap((f) => f.teams))];
  const fuzzy = fuzzyMatches(qStripped, allTeams);

  return fixtures
    .map((f) => {
      // best team match for ranking + to choose which side is the subject. Combines exact
      // overlap, prefix/substring (partial words), and uFuzzy (typos like "Croatai").
      let best = "";
      let bestScore = 0;
      for (const t of f.teams) {
        const tt = tokens(t);
        const sc = Math.max(overlap(qt, tt), tokenSetScore(qStripped, t), prefixCover(qt, tt), fuzzy.has(t) ? 0.6 : 0);
        if (sc > bestScore) {
          bestScore = sc;
          best = t;
        }
      }
      return { f, best, bestScore };
    })
    .filter((x) => x.bestScore >= 0.34)
    .sort((a, b) => b.bestScore - a.bestScore)
    .slice(0, limit)
    .map(({ f, best }) => {
      const other = f.teams.find((t) => t !== best) ?? "";
      const value = other ? `${best} beats ${other}${scoreSuffix}` : `${best}${scoreSuffix}`;
      return {
        label: f.title,
        value,
        sub: `Match · ${f.date}${scoreSuffix ? ` · exact score${scoreSuffix}` : ""}`,
        slug: f.slug,
        kind: "fixture" as const,
      };
    });
}

/** The live outcomes of one event (step 2 of the hedge flow, after picking an event). */
export async function searchOutcomes(slug: string, limit = 14): Promise<MarketSuggestion[]> {
  let bundle;
  try {
    bundle = await fetchEventBundle(slug);
  } catch {
    return [];
  }
  if (!bundle) return [];
  return bundle.markets
    .filter((m) => !m.resolved)
    .map((m) => ({ m, q: m.midpointYes > 0 ? m.midpointYes : 0 }))
    .sort((a, b) => b.q - a.q)
    .slice(0, limit)
    .map(({ m, q }) => ({
      label: m.groupItemTitle ?? m.question,
      value: m.groupItemTitle ?? m.question,
      sub: `${(q * 100).toFixed(0)}% implied`,
      slug,
      kind: "outcome" as const,
    }));
}
