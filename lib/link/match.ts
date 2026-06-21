/**
 * lib/link/match.ts — the ONE shared text matcher for cross-venue linking.
 *
 * Both the World Cup path and the generic path use these, so entity/label matching can't
 * drift between them. All matching is token-based and conservative (containment, not fuzzy
 * guessing) because a wrong match here would fabricate a structural relationship.
 */
import { norm } from "@/lib/polymarket/text";
import { tokenSetScore } from "@/lib/polymarket";

// Claim/category words to strip when extracting the entity from free text, so
// "Spain wins next match" / "Spain to win the World Cup" both reduce to "spain".
const ENTITY_STRIP = new Set([
  "win", "wins", "winning", "won", "to", "the", "a", "an", "of", "in", "on", "for", "at", "is",
  "will", "be", "next", "this", "their", "its", "match", "game", "group", "cup", "world", "fifa",
  "tournament", "champion", "champions", "championship", "beat", "beats", "vs", "v", "soccer",
  "election", "winner", "above", "below", "over", "under", "reach", "reaches",
]);

/** Strip claim/category words → the bare entity tokens for dictionary matching. */
export function parseEntityQuery(query: string): string {
  const words = norm(query).split(" ").filter((w) => w && !ENTITY_STRIP.has(w));
  return words.join(" ") || norm(query);
}

/** All of `entity`'s tokens appear in `label` (so "Spain" matches "Spain", not "Saudi Arabia"). */
export function refersTo(entity: string, label: string): boolean {
  const e = norm(entity).split(" ").filter((w) => w.length > 1);
  if (e.length === 0) return false;
  const l = new Set(norm(label).split(" ").filter(Boolean));
  return e.every((w) => l.has(w));
}

/**
 * SYMMETRIC entity match for cross-venue linking: true when one name contains the other
 * ("Gavin Newsom" ↔ "Newsom", "Trump" ↔ "Donald Trump"). Venues label the same subject
 * differently (full name vs surname, with/without nation), so a one-directional containment
 * misses real matches. Still strict (token containment, never fuzzy) to avoid false EQUIVALENTs.
 */
export function entityMatches(entity: string, label: string): boolean {
  return refersTo(entity, label) || refersTo(label, entity);
}

// Generational suffixes change the SUBJECT (RFK Jr ≠ JFK, Trump Jr ≠ Donald Trump).
const NAME_SUFFIX = new Set(["jr", "sr", "ii", "iii", "iv"]);

/**
 * STRICTEST identity: the two labels have the SAME normalized token SET (order-independent). Used
 * to gate the ANALYTIC cover-all claim, where a fabricated equivalence is the cardinal failure and a
 * missed one is merely a foregone hedge. Containment is NOT enough here: "Congo" ⊄≡ "DR Congo",
 * "Korea Republic" ≠ "Korea DPR", "United States" ≠ "United Arab Emirates".
 */
export function sameEntityStrict(a: string, b: string): boolean {
  const ta = new Set(norm(a).split(" ").filter((w) => w.length > 1));
  const tb = new Set(norm(b).split(" ").filter((w) => w.length > 1));
  if (ta.size === 0 || ta.size !== tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

/**
 * Stricter than entityMatches: the two names refer to the SAME person/subject. Rejects a
 * generational-suffix mismatch ("Trump" vs "Donald Trump Jr"), so a relative is never matched
 * as EQUIVALENT to the principal. Used to gate cross-venue EQUIVALENT on person-name markets.
 */
export function sameSubject(entity: string, label: string): boolean {
  if (!entityMatches(entity, label)) return false;
  const e = new Set(norm(entity).split(" ").filter((w) => w.length > 1));
  const l = new Set(norm(label).split(" ").filter((w) => w.length > 1));
  for (const s of NAME_SUFFIX) if (e.has(s) !== l.has(s)) return false;
  return true;
}

/** Split a fixture title "Spain vs Saudi Arabia" → the side that is NOT the entity. */
export function opponentOf(entity: string, fixtureTitle: string): string | null {
  const parts = fixtureTitle.split(/\s+vs\.?\s+/i);
  if (parts.length !== 2) return null;
  const [a, b] = parts.map((s) => s.trim());
  if (refersTo(entity, a)) return b;
  if (refersTo(entity, b)) return a;
  return null;
}

/** Token-overlap score of two free-text strings in [0,1] (re-exported for callers). */
export { tokenSetScore };

/** Symmetric token-overlap fraction (size of intersection / max set size). */
export function titleOverlap(a: string, b: string): number {
  const sa = new Set(norm(a).split(" ").filter((w) => w.length > 1));
  const sb = new Set(norm(b).split(" ").filter((w) => w.length > 1));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** Parse the date code embedded in a WC event ticker (…-26JUN21…) for "soonest match" sorting. */
export function fixtureSortKey(eventTicker: string): number {
  const m = eventTicker.match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const yy = Number(m[1]);
  const mm = MONTHS.indexOf(m[2]);
  const dd = Number(m[3]);
  if (mm < 0) return Number.MAX_SAFE_INTEGER;
  return (2000 + yy) * 10000 + (mm + 1) * 100 + dd;
}
