/**
 * lib/link/classify.ts — PURE relationship logic (no network), so it is unit-testable.
 *
 * Given the role a Kalshi market plays relative to the anchor entity E, and what KIND of
 * claim the Polymarket bet makes about E (win the tournament vs win one match), return the
 * logical relation, its provenance, and the honestly-allowed uses. The matrix encodes real
 * implications, e.g. "E is champion ⇒ E's continent wins" (SUBSET) but "E is champion" does
 * NOT imply "E won group game M" (so that pairing is SAME_ENTITY, never SUBSET).
 */
import type { ClaimKind, LinkProvenance, LinkRule, LinkUse } from "./types";

export type KalshiRole =
  | "champion_self" // "E wins the World Cup"
  | "champion_rival" // "<rival> wins the World Cup"
  | "match_self" // "E wins match M"
  | "match_rival" // "<opponent> wins M" / "M is a tie"
  | "continent_self" // "E's continent wins the World Cup"
  | "continent_other" // "another continent wins the World Cup"
  | "group_self" // "E wins its group"
  | "total_match" // "M total goals over/under"
  | "narrative" // broadcast/entertainment market tied to the event
  // ── generic (any theme), derived purely from single-winner partition structure ──
  | "generic_self" // a Kalshi market that resolves like B (same entity + aligned partition)
  | "generic_sibling" // another outcome in B's aligned mutually-exclusive Kalshi event
  | "generic_same_entity" // the same entity in a DIFFERENT Kalshi event/question
  | "generic_narrative"; // a thematically-adjacent Kalshi market

export interface ClassifyCtx {
  entity: string;
  opponent?: string;
  fixture?: string; // "Spain vs Saudi Arabia"
  continent?: string; // "Europe"
  rivalName?: string;
}

export interface Classification {
  rule: LinkRule;
  provenance: LinkProvenance;
  uses: LinkUse[];
  side: "yes" | "no"; // the Kalshi side that aligns with the relationship's primary use
  why: string;
}

const ANALYTIC = (rule: LinkRule, uses: LinkUse[], side: "yes" | "no", why: string): Classification => ({
  rule,
  provenance: "ANALYTIC",
  uses,
  side,
  why,
});
const SPECULATIVE = (rule: LinkRule, side: "yes" | "no", why: string): Classification => ({
  rule,
  provenance: "SPECULATIVE",
  uses: ["context"],
  side,
  why,
});

/**
 * Classify one (role, claimKind) pairing. Returns null when the pairing carries no clean
 * logical signal (we drop it rather than surface noise).
 */
export function classify(role: KalshiRole, claim: ClaimKind, ctx: ClassifyCtx): Classification | null {
  const E = ctx.entity;
  switch (role) {
    case "champion_self":
      if (claim === "champion")
        return ANALYTIC(
          "EQUIVALENT",
          ["amplify", "context"],
          "yes",
          `Same outcome on both venues: Kalshi "${E} wins the World Cup" resolves identically to your Polymarket bet. Buy YES on whichever venue is cheaper, net of fees. A clean cross-venue price check, not a hedge.`,
        );
      // match claim: winning the whole tournament neither requires nor is required by one match
      return SPECULATIVE(
        "SAME_ENTITY",
        "yes",
        `Same team, broader question: "${E} wins the World Cup" is correlated with your match bet but neither implies it — ${E} can win this match and not the cup, or win the cup having drawn it. Context, not a hedge.`,
      );
    case "champion_rival":
      if (claim === "champion")
        return ANALYTIC(
          "MUTEX",
          ["context"],
          "yes",
          `Mutually exclusive: only one nation wins the World Cup, so "${ctx.rivalName ?? "this rival"} wins" and ${E} winning cannot both happen. Shown as context, not an action.`,
        );
      return null;
    case "match_self":
      if (claim === "match")
        return ANALYTIC(
          "EQUIVALENT",
          ["amplify", "context"],
          "yes",
          `Same match on both venues: Kalshi "${E} wins ${ctx.fixture ?? "this match"}" resolves identically to your Polymarket bet. Buy YES on whichever venue is cheaper, and compare the two prices.`,
        );
      return SPECULATIVE(
        "SAME_ENTITY",
        "yes",
        `Same team, narrower question: ${E} winning ${ctx.fixture ?? "this match"} is correlated with winning the cup but does not decide it. Context, not a hedge.`,
      );
    case "match_rival":
      if (claim === "match")
        return ANALYTIC(
          "MUTEX",
          ["context"],
          "yes",
          `One of the ways you lose ${ctx.fixture ?? "this match"}: the ${ctx.opponent ?? "opponent"}-win and tie outcomes are mutually exclusive with your bet. Shown as context, not an action.`,
        );
      return null;
    case "continent_self":
      if (claim === "champion")
        return ANALYTIC(
          "SUBSET",
          ["amplify", "context"],
          "yes",
          `Containment: if ${E} wins the World Cup then ${ctx.continent ?? "their continent"} necessarily wins it, so your bet is a subset of this one. It is a looser, cheaper way to express the same direction (and a sanity bound: P(${E}) ≤ P(${ctx.continent ?? "continent"})).`,
        );
      return SPECULATIVE(
        "SAME_ENTITY",
        "yes",
        `${ctx.continent ?? "Continent"}-level market tied to ${E}. Correlated context, not a clean hedge for a single match.`,
      );
    case "continent_other":
      if (claim === "champion")
        return ANALYTIC(
          "MUTEX",
          ["context"],
          "yes",
          `Disjoint from your bet: if ${ctx.continent ?? "this continent"} wins the World Cup then ${E} did not. Shown as context, not an action.`,
        );
      return null;
    case "group_self":
      return SPECULATIVE(
        "SAME_ENTITY",
        "yes",
        `Same team, different question: ${E} winning its group is correlated with — but neither implies nor is implied by — your bet. Context only.`,
      );
    case "total_match":
      return SPECULATIVE(
        "SAME_EVENT",
        "yes",
        `Same match, different question: total goals in ${ctx.fixture ?? "this match"}. The scoreline shares the game with your bet but does not determine the winner. Context only.`,
      );
    case "narrative":
      return SPECULATIVE(
        "NARRATIVE",
        "yes",
        `Narrative tie to the same event (e.g. what gets said or performed on the broadcast). Thematically connected to ${E}'s run, but nothing here pays because your bet wins — this is colour/context, explicitly not a hedge.`,
      );
    // ── generic (theme-agnostic) relations, derived from partition structure only ──
    case "generic_self":
      return ANALYTIC(
        "EQUIVALENT",
        ["amplify", "context"],
        "yes",
        `Same outcome on Kalshi: this market resolves on "${E}" the same way your Polymarket bet does. Buy YES on whichever venue is cheaper, net of fees. A clean cross-venue price check.`,
      );
    case "generic_sibling":
      return ANALYTIC(
        "MUTEX",
        ["context"],
        "yes",
        `Mutually exclusive with your bet: in Kalshi's single-winner market only one outcome wins, so "${ctx.rivalName ?? "this outcome"}" and your bet cannot both win. Shown as context, not an action.`,
      );
    case "generic_same_entity":
      return SPECULATIVE(
        "SAME_ENTITY",
        "yes",
        `Same subject (${E}) but a DIFFERENT question on Kalshi — correlated with your bet, yet neither implies the other. Context, not a hedge.`,
      );
    case "generic_narrative":
      return SPECULATIVE(
        "NARRATIVE",
        "yes",
        `Thematically adjacent Kalshi market tied to ${E}. Related colour that may move independently of your bet — context only, not a hedge.`,
      );
    default:
      return null;
  }
}
