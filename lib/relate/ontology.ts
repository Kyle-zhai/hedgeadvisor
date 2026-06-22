import type { AssociationDirection, MechanismGraph } from "@/lib/association";
import { norm } from "@/lib/polymarket/text";

/**
 * Finite event ontology used by calibration keys. Qwen may describe an event class in free-form
 * snake_case, but free-form labels must never create or merge statistical cohorts directly.
 */
type KnownEventClass =
  | "competition_winner"
  | "stage_advance"
  | "match_outcome"
  | "award_outcome"
  | "broadcast_language"
  | "media_mention"
  | "election_outcome"
  | "policy_decision"
  | "regulatory_action"
  | "economic_threshold"
  | "asset_price_threshold"
  | "company_performance"
  | "product_event"
  | "leadership_change"
  | "legal_outcome"
  | "geopolitical_event"
  | "weather_event"
  | "entertainment_performance";
export type CanonicalEventClass = KnownEventClass | `other_event_${string}`;

const RULES: Array<{ re: RegExp; value: KnownEventClass }> = [
  { re: /broadcast|announcer|commentary|spoken|speech|language|word_occurrence/, value: "broadcast_language" },
  { re: /media|headline|mention|coverage|social_post/, value: "media_mention" },
  { re: /election|electoral|nominee|primary_vote|president|mayor|governor/, value: "election_outcome" },
  { re: /regulat|approval|license|antitrust|enforcement/, value: "regulatory_action" },
  { re: /policy|legislation|bill_pass|rate_decision|central_bank|fed_decision/, value: "policy_decision" },
  { re: /bitcoin|crypto|token|stock_price|asset_price|price_threshold/, value: "asset_price_threshold" },
  { re: /inflation|gdp|unemployment|occupancy|economic|macro|demand_threshold/, value: "economic_threshold" },
  { re: /revenue|earnings|sales|valuation|company_performance/, value: "company_performance" },
  { re: /product|launch|release|shipment/, value: "product_event" },
  { re: /coach|ceo|leader|resign|depart|appoint|leadership/, value: "leadership_change" },
  { re: /indict|convict|court|legal|lawsuit|verdict/, value: "legal_outcome" },
  { re: /war|conflict|ceasefire|strait|border|geopolit/, value: "geopolitical_event" },
  { re: /weather|temperature|hurricane|rain|snow|storm/, value: "weather_event" },
  { re: /box_office|album|film|movie|stream|entertainment/, value: "entertainment_performance" },
  { re: /golden_boot|award|prize|top_scorer/, value: "award_outcome" },
  { re: /reach_final|stage_advance|qualif|advance|playoff/, value: "stage_advance" },
  { re: /match_winner|match_outcome|game_outcome|fixture/, value: "match_outcome" },
  { re: /champion|title|tournament_winner|competition_winner|continent_winner|group_winner/, value: "competition_winner" },
];

const clean = (value: string) => norm(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const shortHash = (value: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).slice(0, 7);
};

export function canonicalEventClass(raw: string | undefined, fallback = "other"): CanonicalEventClass {
  const text = clean(`${raw ?? ""} ${fallback}`);
  for (const rule of RULES) if (rule.re.test(text)) return rule.value;
  // Unknown classes are quarantined, not pooled into one giant "other" cohort. A stable bounded hash
  // prevents accidental cross-domain mixing while the ontology awaits an explicit mapping.
  return `other_event_${shortHash(text || "other")}`;
}

export type PayoffDirection = "positive" | "negative" | "ambiguous";

export function canonicalPayoffDirection(direction: AssociationDirection | string | undefined): PayoffDirection {
  if (direction === "POSITIVE" || direction === "positive") return "positive";
  if (direction === "NEGATIVE" || direction === "negative") return "negative";
  return "ambiguous";
}

/** Stable finite signature. Node labels and free-form explanations never enter the cohort key. */
export function canonicalMechanismSignature(
  graph: MechanismGraph | undefined,
  direction?: AssociationDirection | string,
): string | undefined {
  if (!graph || graph.portability === "INSTANCE_ONLY") return undefined;
  const edges = [...new Set(graph.edges.map((edge) => edge.kind.toLowerCase()))].sort().join("+") || "none";
  return [
    graph.mechanismType.toLowerCase(),
    graph.scope.toLowerCase(),
    graph.timeOrder.toLowerCase(),
    graph.portability.toLowerCase(),
    canonicalPayoffDirection(direction),
    `edges=${edges}`,
  ].join(".");
}
