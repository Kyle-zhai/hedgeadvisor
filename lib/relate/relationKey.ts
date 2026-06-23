/**
 * lib/relate/relationKey.ts — stable RELATION TEMPLATES + keys, so settlement samples accumulate
 * WITHOUT cross-mechanism pollution.
 *
 * Treating every market PAIR as unique would never gather enough resolved observations; but lumping
 * "announcer says CHAMPION", "halftime first song", and "trophy lift" under one `broadcast_word` key
 * mixes incompatible settlement mechanisms and CORRUPTS the calibration. So a key is granular:
 *   anchorFamily -> candidateFamily:predicate[:channel] -> side @ vN
 * where `predicate` is the specific settlement event, `channel` distinguishes language/broadcast when
 * present, and the TEMPLATE_VERSION invalidates old samples whenever this templating logic changes.
 */
import { norm } from "@/lib/polymarket/text";
import { sameEntityStrict } from "@/lib/link/match";
import type { MechanismGraph } from "@/lib/association";
import { canonicalEventClass, canonicalMechanismSignature, eventDimension } from "./ontology";

/** Bump when eventFamily/predicate/role/weighting logic changes — old samples must NOT be reused. */
export const TEMPLATE_VERSION = 5;

/** The ENTITY relationship between an anchor (team) and a candidate — so unlike pairings never pool. */
export type RelationRole = "same_entity" | "entity_event" | "event_linked" | "cross_entity" | "cross_domain" | "same_team_player" | "rival" | "global_event" | "unrelated";

const RIVAL_FAMILIES = new Set(["tournament_winner", "continent_winner", "group_winner"]);

/** Classify the role of a candidate w.r.t. one anchor entity. */
export function relationRole(anchorEntity: string, candidate: { entity: string; family: string; context?: string; mechanismGraph?: MechanismGraph }): RelationRole {
  if (sameEntityStrict(anchorEntity, candidate.entity)) return "same_entity";
  const scope = candidate.mechanismGraph?.scope;
  if (scope === "SAME_ENTITY") return "same_entity";
  if (scope === "ENTITY_SPECIFIC") return "entity_event";
  if (scope === "EVENT_GLOBAL") return "event_linked";
  if (scope === "CROSS_ENTITY") return "cross_entity";
  if (scope === "CROSS_DOMAIN") return "cross_domain";
  if (candidate.family === "broadcast_word") {
    const anchor = norm(anchorEntity);
    const context = norm(`${candidate.entity} ${candidate.context ?? ""}`);
    // A broadcast prop tied to a named team/match is not global. Keep it in a separate template so
    // "announcer says champion during Spain's match" can be calibrated specifically for Spain-like
    // entity events, while a tournament-wide halftime song remains global.
    if (anchor && ` ${context} `.includes(` ${anchor} `)) return "entity_event";
    return "global_event";
  }
  if (RIVAL_FAMILIES.has(candidate.family)) return "rival"; // a DIFFERENT single-winner outcome
  return "unrelated"; // e.g. a player without a team map, or a cross-entity stage market
}

/** Stable, bounded cohort component. Free-form graph labels never enter a calibration key. */
export function mechanismSignature(graph?: MechanismGraph, direction?: string): string | undefined {
  return canonicalMechanismSignature(graph, direction);
}

const FAMILY_RULES: { re: RegExp; family: string }[] = [
  // ── cross-domain families (tested FIRST so "Presidential Election Winner" is not caught by /winner/) ──
  { re: /nominee|nomination|\bprimary\b|presidential|election|\bvotes?\b|electoral/, family: "election" },
  { re: /\bfed\b|rate cut|rate hike|interest rate|\bfomc\b|central bank|basis points|\bbps\b/, family: "rate_decision" },
  { re: /bitcoin|ethereum|\bbtc\b|\beth\b|crypto|hit \$|hits \$|above \$|price .* (hit|reach)/, family: "asset_price" },
  { re: /inflation|\bcpi\b|\bgdp\b|unemployment|recession|jobs report/, family: "macro_econ" },
  { re: /earnings|revenue|market cap|largest company|valuation/, family: "company" },
  { re: /regime|ceasefire|airspace|strait|invade|missile|peace deal|withdraw|war\b/, family: "geopolitics" },
  // ── sports families ──
  { re: /announcer|broadcast|mention|halftime|first song|\bsays?\b|\bword\b|trophy lift/, family: "broadcast_word" },
  { re: /golden boot|top scorer|\bscorer\b|most goals/, family: "golden_boot" },
  { re: /continent .* win|continent to win/, family: "continent_winner" },
  { re: /total goals|over\/under|\btotal\b/, family: "match_total" },
  { re: /group .* winner|group winner/, family: "group_winner" },
  { re: /reach.*final|furthest stage|advance/, family: "stage_advance" },
  { re: /\bvs\.?\b| beats /, family: "match_winner" },
  { re: /winner|champion|win the (world cup|cup|tournament)/, family: "tournament_winner" },
];

/** Map a market's group/title (+ category) to its reusable relation template. */
export function eventFamily(marketTitle: string, category: string): string {
  const t = norm(marketTitle);
  for (const r of FAMILY_RULES) if (r.re.test(t)) return r.family;
  return norm(category).replace(/\s+/g, "-") || "other";
}

/** A market's ORTHOGONAL hedge dimension (the combo slot): family → canonical class → dimension. Cross-domain
 *  classes are each their own dimension; the keyword-level sports collapse (handicaps, exact scores) is handled
 *  upstream by the combo's own facet rules, with this as the cross-domain fallback. */
export function marketDimension(marketTitle: string, category: string): string {
  const fam = eventFamily(marketTitle, category);
  return eventDimension(fam, canonicalEventClass(fam, category));
}

// The specific SETTLEMENT predicate within a family — what actually has to happen for the contract to
// pay. Different predicates settle on different mechanisms and must NEVER share a calibration key.
const PREDICATE_RULES: { re: RegExp; predicate: string }[] = [
  { re: /first song|halftime show/, predicate: "first_song" },
  { re: /(says?|announce|mention|call).*(champion)/, predicate: "says_champion" },
  { re: /(says?|announce|mention|call).*(winner|win it)/, predicate: "says_winner" },
  { re: /trophy lift|lift the trophy|lifts the trophy/, predicate: "trophy_lift" },
  { re: /\bmention/, predicate: "mention" },
  { re: /golden boot|top scorer/, predicate: "top_scorer" },
  { re: /reach.*final/, predicate: "reach_final" },
  { re: /total goals|over .* goals|\btotal\b/, predicate: "total_goals" },
];

const CHANNEL_RE = /\b(english|spanish|french|portuguese|arabic|fox|espn|telemundo|bbc|univision)\b/;

/**
 * Extract the specific predicate (+ optional channel) from the candidate's title + rules + label.
 * `outcomeLabel` is the SPECIFIC contract (e.g. the song) — included for MULTI-OUTCOME markets so two
 * options of one event (first song = Swim vs Hung Up) never silently collide into one relation key.
 */
export function predicateOf(marketTitle: string, rules: string, outcomeLabel?: string): string {
  const t = norm(`${marketTitle} ${rules}`);
  let base = "";
  for (const r of PREDICATE_RULES) if (r.re.test(t)) { base = r.predicate; break; }
  if (!base) {
    const STOP = new Set(["the", "to", "of", "a", "an", "win", "wins", "world", "cup", "winner", "will", "be", "during"]);
    base = norm(marketTitle).split(" ").filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 3).join("_") || "generic";
  }
  const ch = t.match(CHANNEL_RE)?.[1];
  // Append the outcome label ONLY when it adds info (a distinct multi-outcome contract), so the
  // EVENT TYPE still pools across instances but different OUTCOMES of one event don't collide.
  const outcome = outcomeLabel ? norm(outcomeLabel).replace(/\s+/g, "_") : "";
  const distinctOutcome = outcome && !base.includes(outcome) && outcome !== "yes" && outcome !== "no" ? `=${outcome}` : "";
  return `${base}${ch ? `:${ch}` : ""}${distinctOutcome}`;
}

/** Stable relation key: anchorFamily -> candidateFamily:predicate -> role -> side @ version. */
export function relationKey(anchorFamily: string, candidateFamily: string, predicate: string, role: RelationRole, side: "yes" | "no", mechanism?: string): string {
  const anchorClass = canonicalEventClass(anchorFamily, anchorFamily);
  const candidateClass = canonicalEventClass(candidateFamily, candidateFamily);
  const stablePredicate = norm(predicate).replace(/[^a-z0-9:=]+/g, "_").replace(/^_+|_+$/g, "") || "generic";
  return `${anchorClass}->${candidateClass}:${stablePredicate}->${role}${mechanism ? `:m=${mechanism}` : ""}->${side}@v${TEMPLATE_VERSION}`;
}
