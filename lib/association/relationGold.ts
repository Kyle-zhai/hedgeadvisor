import type { AssociationRelation, AssociationDirection, MechanismType, MechanismScope } from "./types";

export interface GoldRelation {
  id: string;
  domain: string;
  relationType: string;
  anchor: { title: string; eventClass: string };
  candidate: { title: string; eventClass: string };
  label: {
    relation: AssociationRelation;
    direction: Extract<AssociationDirection, "POSITIVE" | "NEGATIVE" | "AMBIGUOUS">;
    mechanismType: MechanismType;
    scope: MechanismScope;
    pGivenAnchorWins: number;
    pGivenAnchorFails: number;
    strengthBand: "strong" | "moderate" | "weak" | "none";
    counterexamples: string[];
    confidence: number;
  };
  basis: "logical" | "causal" | "historical";
  labeledBy: "opus-4.8";
  rationale: string;
}

export const RELATION_GOLD: GoldRelation[] = [
  {
    id: "logic-btc-threshold-implication",
    domain: "crypto", relationType: "logical-implication",
    anchor: { title: "Bitcoin above $100,000 in 2026", eventClass: "asset_price_threshold" },
    candidate: { title: "Bitcoin above $90,000 in 2026", eventClass: "asset_price_threshold" },
    label: { relation: "IMPLICATION", direction: "POSITIVE", mechanismType: "IMPLICATION", scope: "SAME_ENTITY",
      pGivenAnchorWins: 1.0, pGivenAnchorFails: 0.25, strengthBand: "strong",
      counterexamples: ["price gaps from $80k to $110k without printing $90k"], confidence: 0.97 },
    basis: "logical", labeledBy: "opus-4.8",
    rationale: "Monotonic price: hitting $100k entails having hit $90k.",
  },
  {
    id: "logic-wc-mutex-france-spain",
    domain: "sports", relationType: "logical-mutex",
    anchor: { title: "France win the 2026 World Cup", eventClass: "tournament_winner" },
    candidate: { title: "Spain win the 2026 World Cup", eventClass: "tournament_winner" },
    label: { relation: "MUTEX", direction: "NEGATIVE", mechanismType: "LOGICAL", scope: "CROSS_ENTITY",
      pGivenAnchorWins: 0.0, pGivenAnchorFails: 0.18, strengthBand: "strong",
      counterexamples: ["tournament cancelled / shared title (effectively impossible)"], confidence: 0.99 },
    basis: "logical", labeledBy: "opus-4.8",
    rationale: "Only one nation wins; if France wins, Spain cannot.",
  },
  {
    id: "causal-spain-star-injury",
    domain: "sports", relationType: "same-entity-causal",
    anchor: { title: "Spain win the 2026 World Cup", eventClass: "tournament_winner" },
    candidate: { title: "Spain's first-choice striker ruled out injured before the final", eventClass: "player_injury" },
    label: { relation: "CAUSAL", direction: "NEGATIVE", mechanismType: "CAUSAL", scope: "ENTITY_SPECIFIC",
      pGivenAnchorWins: 0.05, pGivenAnchorFails: 0.18, strengthBand: "moderate",
      counterexamples: ["a deep squad wins despite the injury"], confidence: 0.7 },
    basis: "causal", labeledBy: "opus-4.8",
    rationale: "Losing a key player lowers win probability, so the injury is more likely in the fail branch.",
  },
  {
    id: "neg-control-btc-vs-oscars",
    domain: "cross", relationType: "negative-control",
    anchor: { title: "Bitcoin above $100,000 in 2026", eventClass: "asset_price_threshold" },
    candidate: { title: "Oppenheimer sequel wins Best Picture 2026", eventClass: "award_winner" },
    label: { relation: "UNRELATED", direction: "AMBIGUOUS", mechanismType: "OTHER", scope: "CROSS_DOMAIN",
      pGivenAnchorWins: 0.1, pGivenAnchorFails: 0.1, strengthBand: "none",
      counterexamples: ["no shared driver"], confidence: 0.9 },
    basis: "logical", labeledBy: "opus-4.8",
    rationale: "Crypto price and an awards outcome share no mechanism; independent.",
  },
  {
    id: "neg-control-fed-vs-lakers",
    domain: "cross", relationType: "negative-control",
    anchor: { title: "Fed cuts rates at the next FOMC meeting", eventClass: "monetary_policy_decision" },
    candidate: { title: "Los Angeles Lakers win the 2026 NBA Finals", eventClass: "tournament_winner" },
    label: { relation: "UNRELATED", direction: "AMBIGUOUS", mechanismType: "OTHER", scope: "CROSS_DOMAIN",
      pGivenAnchorWins: 0.12, pGivenAnchorFails: 0.12, strengthBand: "none",
      counterexamples: ["no shared driver between monetary policy and a basketball outcome"], confidence: 0.92 },
    basis: "logical", labeledBy: "opus-4.8",
    rationale: "A monetary-policy decision and an NBA championship share no causal pathway; independent.",
  },
  {
    id: "neg-control-trump-approval-vs-btc",
    domain: "cross", relationType: "negative-control",
    anchor: { title: "Trump approval rating above 45% on Dec 31, 2026", eventClass: "approval_rating_threshold" },
    candidate: { title: "Bitcoin above $90,000 in 2026", eventClass: "asset_price_threshold" },
    label: { relation: "UNRELATED", direction: "AMBIGUOUS", mechanismType: "OTHER", scope: "CROSS_DOMAIN",
      pGivenAnchorWins: 0.4, pGivenAnchorFails: 0.4, strengthBand: "none",
      counterexamples: ["no reliable shared driver; any link is weak and noisy"], confidence: 0.75 },
    basis: "logical", labeledBy: "opus-4.8",
    rationale: "Presidential approval and a crypto price threshold have no dependable mechanism linking them; treat as independent.",
  },
];
