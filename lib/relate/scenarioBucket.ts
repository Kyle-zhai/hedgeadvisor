/**
 * lib/relate/scenarioBucket.ts — Phase 1 of the joint-combo roadmap
 * (see docs/settlement-moat-and-joint-combo-calibration.md, Part II).
 *
 * A `ScenarioBucket` labels WHICH anchor-failure PATH a hedge candidate covers — NOT the relation type.
 * It is the foundation for reliable multi-leg combos: a good combo covers DIFFERENT failure scenarios
 * rather than stacking several legs that all hedge the same path. Phases 2–3 (pairwise overlap, conservative
 * combo policy) consume this label; the conservative overlap penalties key off same-vs-different scenario.
 *
 * HONESTY: this is descriptive METADATA only. It never promotes a tier, never sizes a position, and never
 * asserts settlement evidence. It is a rule-based bootstrap ("先用规则，再逐步由 settlement 学习"); a future
 * step can let the elicitor emit the bucket directly and learn overlaps from settled combo observations.
 */

export const SCENARIO_BUCKETS = [
  "logical_subset",        // set/threshold/stage nesting (reach final ⊆ win; 90+ ⊆ 80+ points)
  "rival_wins",            // a competitor winning is the path that beats the anchor
  "path_elimination",      // anchor eliminated / fails to advance / misses a threshold
  "injury_absence",        // key person injured / suspended / ruled out / absent
  "performance_collapse",  // team/company/candidate performs far below expectation (resign, downgrade, miss)
  "macro_regime",          // rates / inflation / growth / monetary-policy environment
  "regulatory_shock",      // law / regulation / ban / approval / court ruling / sanction / tariff
  "supply_demand_shock",   // commodity / energy / supply-chain / inventory shock
  "information_release",   // earnings / CPI / jobs / polls / verdicts — scheduled information events
  "behavioral_reaction",   // market / voter / audience behavioral reaction
  "unrelated_control",     // no plausible anchor-failure path (negative control)
] as const;

export type ScenarioBucket = (typeof SCENARIO_BUCKETS)[number];

export interface ScenarioInput {
  anchorTitle: string;
  candidateTitle: string;
  candidateMarketTitle?: string;
  /** Relation classification, e.g. MUTEX | IMPLICATION | EQUIVALENT | CAUSAL | THEMATIC | UNRELATED | AMBIGUOUS. */
  relation?: string;
  /** Mechanism scope, e.g. SAME_ENTITY | ENTITY_SPECIFIC | EVENT_GLOBAL | CROSS_ENTITY | CROSS_DOMAIN. */
  scope?: string;
  /** Payoff direction, e.g. POSITIVE | NEGATIVE | AMBIGUOUS. */
  direction?: string;
  /** The elicitor's free-text reason; an explicit independence admission forces unrelated_control. */
  reason?: string;
}

const RULES: ReadonlyArray<readonly [ScenarioBucket, RegExp]> = [
  ["injury_absence", /\binjur|\bruled out\b|sidelined|suspend|\babsent\b|out (?:for|with)\b|\bfitness\b|hamstring|\bacl\b|will not play|won['’]t play|misses? the (?:match|game|tournament|season)/i],
  ["regulatory_shock", /\bbans?\b|\bbanned\b|regulat|antitrust|lawsuit|\bcourt\b|\bruling\b|\bverdict\b|sanction|tariff|\bapproval\b|\bfda\b|\bsec\b|indict|impeach|legislat|\bsubpoena\b|\bsettlement\b/i],
  ["supply_demand_shock", /\boil\b|\bgas\b|\bopec\b|\benergy\b|\bcrude\b|\bbarrel\b|commodit|\bwheat\b|\bcorn\b|\bcopper\b|\blithium\b|\buranium\b|\bnickel\b|supply chain|inventory|shipping|freight|\bharvest\b/i],
  ["macro_regime", /\bfed\b|rate (?:cut|hike|decision)|interest rate|\binflation\b|\bcpi\b|recession|\bgdp\b|unemployment|jobs report|payroll|\becb\b|monetary|treasury yield|\bppi\b/i],
  ["information_release", /earnings|guidance|quarterly|\bpoll\b|\bsurvey\b|\bresults\b|\bfiling\b|approval rating|data release|\breport\b/i],
  ["performance_collapse", /resign|steps? down|\bfired\b|\bsacked?\b|scandal|bankrupt|downgrade|cuts? guidance|profit warning|\brecall\b|misses? (?:earnings|estimates|expectations)|relegat/i],
  ["behavioral_reaction", /\bfans?\b|\bcrowd\b|celebrat|announcer|commentator|\bboo\b|\bcheer|sentiment|goes viral|\btrend|\btweets?\b/i],
  ["path_elimination", /eliminat|knocked out|crash(?:es)? out|fails? to (?:reach|qualify|advance|make|win)|does not (?:reach|qualify|advance|win)|misses? the (?:playoffs?|final|cut|knockout)|group stage exit|\bout of the\b/i],
];

/**
 * Best-effort rule-based bucket for a hedge candidate, relative to the anchor.
 * Precedence: explicit independence → structural relation → failure-path keywords → cross-entity rival → control.
 */
export function classifyScenarioBucket(input: ScenarioInput): ScenarioBucket {
  const rel = (input.relation ?? "").toUpperCase();
  const scope = (input.scope ?? "").toUpperCase();
  const reason = input.reason ?? "";

  // The elicitor's own independence admission, or an ambiguous/unrelated relation, is a negative control.
  if (
    rel === "UNRELATED" ||
    rel === "AMBIGUOUS" ||
    (input.direction ?? "").toUpperCase() === "AMBIGUOUS" ||
    /\bindependent\b|no concrete mechanism|\bunrelated\b/i.test(reason)
  ) {
    return "unrelated_control";
  }

  const text = `${input.candidateTitle} ${input.candidateMarketTitle ?? ""}`;

  // Structural relations are the clearest scenario signals.
  if ((rel === "MUTEX") && (scope === "CROSS_ENTITY" || scope === "ENTITY_SPECIFIC")) return "rival_wins";
  if (rel === "IMPLICATION" || rel === "EQUIVALENT") return "logical_subset";

  // Failure-path keywords (ordered so the more specific shock types win over generic "report").
  for (const [bucket, re] of RULES) if (re.test(text)) return bucket;

  // A cross-entity rival with no keyword hit is still a rival path; a same-entity logical leg is a subset.
  if (rel === "MUTEX") return "rival_wins";
  if (scope === "CROSS_ENTITY") return "rival_wins";
  if (scope === "SAME_ENTITY") return "logical_subset";

  return "unrelated_control";
}

/** Tally a scenario distribution over a set of legs (diagnostic; never enters sizing or calibration). */
export function scenarioDistribution(buckets: ScenarioBucket[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of buckets) out[b] = (out[b] ?? 0) + 1;
  return out;
}
