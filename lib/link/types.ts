/**
 * lib/link/types.ts — the cross-venue logical-relationship contract.
 *
 * A Polymarket position B is the anchor. Each related Kalshi market is classified by the
 * LOGICAL relation between its resolution condition and B's — never a fitted correlation.
 * The honesty rule (same as the in-venue engine): only STRUCTURAL relations
 * (EQUIVALENT / MUTEX / SUBSET / SUPERSET) are ANALYTIC and may be acted on as a hedge or
 * amplify leg. Thematic ties (SAME_EVENT / SAME_ENTITY) and narrative/broadcast ties
 * (NARRATIVE — the "announcer says 'champion'" archetype) are SPECULATIVE context only:
 * we surface them and explain the link, but never claim they guarantee a payoff.
 */

export type LinkRule =
  | "EQUIVALENT" // resolves identically to B on the other venue
  | "MUTEX" // mutually exclusive with B — pays in a subset of the states where B FAILS
  | "SUBSET" // B ⊆ this (B winning implies this; this is broader)
  | "SUPERSET" // this ⊆ B (this implies B)
  | "SAME_EVENT" // same underlying event, a different question (correlated, not implied)
  | "SAME_ENTITY" // same entity, a different question (correlated, not implied)
  | "NARRATIVE"; // thematic / broadcast / sentiment tie — speculative, never a hedge

export type LinkProvenance = "ANALYTIC" | "SPECULATIVE";
export type LinkUse = "hedge" | "amplify" | "context";

export type ClaimKind = "champion" | "match" | "generic";

export type Venue = "polymarket" | "kalshi";

/** One classified Kalshi market related to the Polymarket anchor. */
export interface CrossVenueLink {
  rule: LinkRule;
  provenance: LinkProvenance;
  uses: LinkUse[]; // how this link can HONESTLY be acted on
  venue: Venue; // the venue this linked market lives on (always "kalshi" today)
  kalshiTicker: string;
  kalshiLabel: string; // outcome label, e.g. "Spain"
  kalshiMarketTitle: string; // group/event title, e.g. "World Cup Winner"
  kalshiSide: "yes" | "no"; // the side that ALIGNS with the stated relationship
  kalshiYesMid: number | null; // 0..1 (live mid for the YES contract)
  kalshiDeepLink: string;
  rulesSnippet: string; // resolution text excerpt — the truth source
  why: string; // plain-language reason the rule holds
  priceNote?: string; // cross-venue price comparison when both sides are priced
}

/** The Polymarket anchor as resolved + the classified Kalshi links. */
export interface RelateResult {
  status: "ok" | "ambiguous" | "not_found";
  pm?: {
    entity: string; // "Spain"
    claim: string; // "Spain wins the World Cup"
    claimKind: ClaimKind;
    eventTitle: string;
    eventSlug: string;
    yesMid: number | null; // 0..1
    stakeUsd: number;
    deepLink: string;
  };
  links?: CrossVenueLink[];
  candidates?: { title: string; score: number }[];
  suggestions?: string[];
  pricedAt?: string;
}
