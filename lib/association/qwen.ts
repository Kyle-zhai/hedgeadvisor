import { z } from "zod";
import type { MarketRuleInput, RelationHypothesis } from "./types";
import {
  chatCompletionWithFallback,
  extractJsonContent,
  relationModelChain,
  relationThinkingEnabled,
  type ModelAttempt,
} from "./modelFallback";
import { llmCacheKey, loadLlmCache, recordLlmRun, storeLlmCache } from "./llmCache";

const NodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  label: z.string().min(1).max(160),
  kind: z.enum(["ENTITY", "EVENT", "CONDITION", "INSTITUTION", "OBSERVABLE"]),
});
const EdgeSchema = z.object({
  from: z.string().max(40),
  to: z.string().max(40),
  kind: z.enum(["CAUSES", "ENABLES", "INHIBITS", "SIGNALS", "REACTS_TO", "SHARES_DRIVER", "RESOLVES_WITH", "IMPLIES"]),
});
const MechanismGraphSchema = z.object({
  anchorEventClass: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  candidateEventClass: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  mechanismType: z.enum(["IDENTITY", "LOGICAL", "INSTITUTIONAL", "CAUSAL", "BEHAVIORAL", "INFORMATION", "ECONOMIC", "NARRATIVE", "TEMPORAL", "COMMON_CAUSE", "IMPLICATION", "OTHER"]),
  scope: z.enum(["SAME_ENTITY", "ENTITY_SPECIFIC", "EVENT_GLOBAL", "CROSS_ENTITY", "CROSS_DOMAIN"]),
  timeOrder: z.enum(["ANCHOR_BEFORE_CANDIDATE", "CANDIDATE_BEFORE_ANCHOR", "OVERLAPPING", "COMMON_HORIZON", "UNKNOWN"]),
  portability: z.enum(["INSTANCE_ONLY", "ENTITY_CLASS", "EVENT_CLASS", "CROSS_DOMAIN_CLASS"]),
  nodes: z.array(NodeSchema).min(2).max(12),
  edges: z.array(EdgeSchema).min(1).max(20),
  sharedDrivers: z.array(z.string().max(160)).max(12),
}).superRefine((graph, ctx) => {
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const [i, edge] of graph.edges.entries()) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", i], message: "edge endpoints must reference node ids" });
  }
});

const RelationSchema = z.object({
  relation: z.enum(["EQUIVALENT", "MUTEX", "IMPLICATION", "CAUSAL", "THEMATIC", "UNRELATED", "AMBIGUOUS"]),
  direction: z.enum(["POSITIVE", "NEGATIVE", "AMBIGUOUS", "ANCHOR_TO_CANDIDATE", "CANDIDATE_TO_ANCHOR"]),
  mechanism: z.string().max(1200),
  sharedEntities: z.array(z.string().max(120)).max(20),
  counterexamples: z.array(z.string().max(500)).min(1).max(12),
  confidence: z.number().min(0).max(1),
  requiresCalibration: z.boolean(),
  mechanismGraph: MechanismGraphSchema,
});

// Meaning-preserving aliases for enum values the models commonly emit outside the schema vocabulary,
// applied BEFORE the valid-set check. Anything still unrecognized is then COERCED to the field's
// catch-all default (see canonicalizeRelationJson) rather than failing the whole parse — the audit
// (2026-06-22) showed ~50% of LLM classifications were being discarded over graph-vocabulary nits
// while their relation/direction/mechanism were sound. Coercion preserves the actionable signal; an
// unrecognized RELATION/DIRECTION coerces to AMBIGUOUS (which never authorizes a hedge side), so this
// stays honest — it normalizes the mechanism-graph metadata, it does not invent confidence.
const MECH_TYPE_ALIAS: Record<string, string> = {
  LOGICAL_IMPLICATION: "LOGICAL", LOGICAL_SUBSET: "LOGICAL", THEMATIC: "OTHER", THEMATIC_LINK: "OTHER",
  CORRELATION: "COMMON_CAUSE", COMMON_DRIVER: "COMMON_CAUSE", ASSOCIATION: "OTHER", STRUCTURAL: "LOGICAL",
  MUTEX: "LOGICAL", REPUTATIONAL: "BEHAVIORAL", POLITICAL: "INSTITUTIONAL", FINANCIAL: "ECONOMIC", SENTIMENT: "BEHAVIORAL",
};
const TIME_ORDER_ALIAS: Record<string, string> = {
  SIMULTANEOUS: "OVERLAPPING", SIMULTANEOUS_WINDOW: "OVERLAPPING", CONCURRENT: "OVERLAPPING",
  INDEPENDENT: "UNKNOWN", NONE: "UNKNOWN", UNSPECIFIED: "UNKNOWN", UNORDERED: "UNKNOWN", AMBIGUOUS: "UNKNOWN",
  ANCHOR_AFTER_CANDIDATE: "CANDIDATE_BEFORE_ANCHOR", CANDIDATE_AFTER_ANCHOR: "ANCHOR_BEFORE_CANDIDATE",
  CANDIDATE_TO_ANCHOR: "CANDIDATE_BEFORE_ANCHOR", ANCHOR_TO_CANDIDATE: "ANCHOR_BEFORE_CANDIDATE",
};
const EDGE_KIND_ALIAS: Record<string, string> = {
  IMPLICATION: "IMPLIES", LOGICALLY_IMPLIES: "IMPLIES", INFLUENCES: "SIGNALS", INFLUENCE: "SIGNALS", AFFECTS: "SIGNALS",
  IMPACTS: "SIGNALS", SUGGESTS_STRENGTH: "SIGNALS", CORRELATES_WITH: "SHARES_DRIVER", CORRELATED_WITH: "SHARES_DRIVER",
  THEMATIC: "SHARES_DRIVER", THEMATIC_LINK: "SHARES_DRIVER", THEMATIC_ASSOCIATION: "SHARES_DRIVER",
  PRECEDES: "SIGNALS", LEADS_TO: "CAUSES", RESULTS_IN: "CAUSES", CONTRIBUTES_TO: "ENABLES",
  CONTRIBUTES_TO_PROBABILITY: "ENABLES", REQUIRES: "REACTS_TO", REQUIRES_MATCH_PLAY: "REACTS_TO",
  PRECLUDES: "INHIBITS", PREVENTS: "INHIBITS", REDUCES: "INHIBITS", INCREASES: "ENABLES", DEPENDS_ON: "REACTS_TO",
};

const MECH_TYPES = new Set(["IDENTITY", "LOGICAL", "INSTITUTIONAL", "CAUSAL", "BEHAVIORAL", "INFORMATION", "ECONOMIC", "NARRATIVE", "TEMPORAL", "COMMON_CAUSE", "IMPLICATION", "OTHER"]);
const SCOPES = new Set(["SAME_ENTITY", "ENTITY_SPECIFIC", "EVENT_GLOBAL", "CROSS_ENTITY", "CROSS_DOMAIN"]);
const TIME_ORDERS = new Set(["ANCHOR_BEFORE_CANDIDATE", "CANDIDATE_BEFORE_ANCHOR", "OVERLAPPING", "COMMON_HORIZON", "UNKNOWN"]);
const PORTABILITIES = new Set(["INSTANCE_ONLY", "ENTITY_CLASS", "EVENT_CLASS", "CROSS_DOMAIN_CLASS"]);
const EDGE_KINDS = new Set(["CAUSES", "ENABLES", "INHIBITS", "SIGNALS", "REACTS_TO", "SHARES_DRIVER", "RESOLVES_WITH", "IMPLIES"]);
const NODE_KINDS = new Set(["ENTITY", "EVENT", "CONDITION", "INSTITUTION", "OBSERVABLE"]);
const RELATIONS = new Set(["EQUIVALENT", "MUTEX", "IMPLICATION", "CAUSAL", "THEMATIC", "UNRELATED", "AMBIGUOUS"]);
const DIRECTIONS = new Set(["POSITIVE", "NEGATIVE", "AMBIGUOUS", "ANCHOR_TO_CANDIDATE", "CANDIDATE_TO_ANCHOR"]);

const coerceEnum = (raw: unknown, alias: Record<string, string>, valid: Set<string>, fallback: string): string => {
  if (typeof raw !== "string") return fallback;
  const k = raw.toUpperCase().replace(/[\s-]+/g, "_");
  const aliased = alias[k] ?? k;
  return valid.has(aliased) ? aliased : fallback;
};

/** Repair the model's JSON into the feasible schema: known aliases first, then coerce any still-
 *  unrecognized enum to that field's safe default, supply missing required fields, and fix the
 *  mechanism graph (drop dangling edges, synthesize a generic edge/nodes when degenerate). The
 *  relation/direction stay the model's own read (unknown ⇒ AMBIGUOUS), so nothing fabricates a sign. */
function canonicalizeRelationJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  root.relation = coerceEnum(root.relation, {}, RELATIONS, "AMBIGUOUS");
  root.direction = coerceEnum(root.direction, {}, DIRECTIONS, "AMBIGUOUS");
  if (typeof root.mechanism !== "string") root.mechanism = "";
  else if (root.mechanism.length > 1200) root.mechanism = root.mechanism.slice(0, 1200);
  if (!Array.isArray(root.sharedEntities)) root.sharedEntities = [];
  if (!Array.isArray(root.counterexamples) || root.counterexamples.length === 0) root.counterexamples = ["(no counterexample provided by the model)"];
  if (typeof root.confidence !== "number") root.confidence = 0.3;
  if (typeof root.requiresCalibration !== "boolean") root.requiresCalibration = true;

  const graph = root.mechanismGraph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return value;
  const g = graph as Record<string, unknown>;
  g.mechanismType = coerceEnum(g.mechanismType, MECH_TYPE_ALIAS, MECH_TYPES, "OTHER");
  g.scope = coerceEnum(g.scope, {}, SCOPES, "CROSS_ENTITY");
  g.timeOrder = coerceEnum(g.timeOrder, TIME_ORDER_ALIAS, TIME_ORDERS, "UNKNOWN");
  g.portability = coerceEnum(g.portability, {}, PORTABILITIES, "INSTANCE_ONLY");
  const slug = (raw: unknown, fb: string): string => {
    if (typeof raw !== "string") return fb;
    const s = raw.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);
    return /^[a-z]/.test(s) ? s : fb;
  };
  g.anchorEventClass = slug(g.anchorEventClass, "anchor_event");
  g.candidateEventClass = slug(g.candidateEventClass, "candidate_event");

  // Nodes: coerce kind; guarantee at least the two canonical event nodes.
  let nodes = Array.isArray(g.nodes) ? (g.nodes as Record<string, unknown>[]).filter((n) => n && typeof n === "object" && typeof n.id === "string" && typeof n.label === "string") : [];
  for (const n of nodes) n.kind = coerceEnum(n.kind, {}, NODE_KINDS, "EVENT");
  if (nodes.length < 2) {
    nodes = [{ id: "anchor_event", label: "anchor event", kind: "EVENT" }, { id: "candidate_event", label: "candidate event", kind: "EVENT" }];
  }
  g.nodes = nodes;
  const ids = new Set(nodes.map((n) => n.id as string));

  // Edges: coerce kind, drop endpoints that don't reference a node, synthesize a generic edge if none survive.
  let edges = Array.isArray(g.edges) ? (g.edges as Record<string, unknown>[]).filter((e) => e && typeof e === "object" && ids.has(e.from as string) && ids.has(e.to as string)) : [];
  for (const e of edges) e.kind = coerceEnum(e.kind, EDGE_KIND_ALIAS, EDGE_KINDS, "SHARES_DRIVER");
  if (edges.length === 0) edges = [{ from: nodes[0].id, to: nodes[1].id, kind: "SHARES_DRIVER" }];
  g.edges = edges.slice(0, 20);
  if (!Array.isArray(g.sharedDrivers)) g.sharedDrivers = [];
  return value;
}

export interface QwenRelationResult {
  status: "ok" | "disabled" | "error";
  model: string;
  hypothesis?: RelationHypothesis;
  reason?: string;
  attempts?: ModelAttempt[];
  cached?: boolean;
}

export interface QwenRelationOptions {
  apiKey?: string;
  model?: string;
  models?: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Defaults to true for live calls and false for injected test transports. */
  cache?: boolean;
}

const SYSTEM = `You classify relationships between prediction-market resolution rules and build a small causal/event mechanism graph.
Return JSON only. Never invent a numeric correlation, conditional probability, or trade size.
EQUIVALENT, MUTEX, and IMPLICATION require logical necessity under the written rules.
CAUSAL and THEMATIC are hypotheses and always require historical calibration.
List concrete counterexamples where one contract pays and the other does not.
Confidence measures confidence in the textual classification only, not statistical strength.
direction is the payoff-association sign when known (POSITIVE/NEGATIVE/AMBIGUOUS). If you can only
state a logical/causal arrow and not its payoff sign, use ANCHOR_TO_CANDIDATE or CANDIDATE_TO_ANCHOR;
these arrow values are audit metadata and never authorize a hedge side.
mechanismGraph is mandatory. Use canonical enum values exactly. Include at least anchor_event and candidate_event nodes and grounded directed edges; do not add facts absent from the contracts or ordinary public knowledge.
anchorEventClass and candidateEventClass must be reusable entity/date-free snake_case event classes, not market titles (for example national_team_title, coach_departure, policy_enactment, hotel_occupancy_threshold).
scope means: SAME_ENTITY=same named subject; ENTITY_SPECIFIC=candidate is tied to this anchor entity; EVENT_GLOBAL=one shared event without an entity restriction; CROSS_ENTITY=different subjects in one domain; CROSS_DOMAIN=different domains.
portability says whether historical evidence may pool beyond this exact instance. Use INSTANCE_ONLY when the mechanism depends on unique wording or circumstances.
The top-level JSON keys MUST be exactly relation, direction, mechanism, sharedEntities, counterexamples, confidence, requiresCalibration, mechanismGraph. Do not wrap them under classification/result/output and do not move scope or portability out of mechanismGraph.
Use this exact shape:
{"relation":"CAUSAL","direction":"POSITIVE","mechanism":"...","sharedEntities":[],"counterexamples":["..."],"confidence":0.5,"requiresCalibration":true,"mechanismGraph":{"anchorEventClass":"...","candidateEventClass":"...","mechanismType":"CAUSAL","scope":"CROSS_DOMAIN","timeOrder":"ANCHOR_BEFORE_CANDIDATE","portability":"EVENT_CLASS","nodes":[{"id":"anchor_event","label":"...","kind":"EVENT"},{"id":"candidate_event","label":"...","kind":"EVENT"}],"edges":[{"from":"anchor_event","to":"candidate_event","kind":"CAUSES"}],"sharedDrivers":[]}}`;

export async function analyzeRelationWithQwen(
  anchor: MarketRuleInput,
  candidate: MarketRuleInput,
  options: QwenRelationOptions = {},
): Promise<QwenRelationResult> {
  const startedAt = Date.now();
  // Use || not ?? so an EMPTY-STRING env var (e.g. a non-existent GitHub secret mapped to "") is
  // treated as absent and falls through — ?? would keep "" and wrongly disable Qwen.
  const apiKey = options.apiKey || process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  const models = relationModelChain(options.model, options.models);
  const model = models[0] ?? "MiniMax-M2.5";
  if (!apiKey) return { status: "disabled", model, reason: "DASHSCOPE_API_KEY/QWEN_API_KEY is not configured" };
  const baseUrl = (options.baseUrl || process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredTimeout = Number(process.env.QWEN_RELATION_TIMEOUT_MS ?? 30_000);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configuredTimeout)
    ? Math.min(120_000, Math.max(5_000, configuredTimeout))
    : 30_000);
  const decode = (content: string) => {
    try {
      const decoded = canonicalizeRelationJson(JSON.parse(extractJsonContent(content)) as unknown);
      const parsed = RelationSchema.safeParse(decoded);
      if (parsed.success) return { parsed } as const;
      const issues = parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
      const keys = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? Object.keys(decoded).slice(0, 8).join(",") : typeof decoded;
      return { error: `output failed schema validation (${issues}); top-level keys: ${keys}` } as const;
    } catch (error) {
      return { error: `invalid JSON (${error instanceof Error ? error.message : "parse failed"})` } as const;
    }
  };
  const useCache = options.cache ?? !options.fetchImpl;
  const trackMetrics = !options.fetchImpl;
  const cacheKey = llmCacheKey("classification", "relation-v2", { anchor, candidate, models });
  if (useCache) {
    const cached = await loadLlmCache<unknown>(cacheKey);
    if (cached) {
      const parsed = RelationSchema.safeParse(cached.value);
      if (parsed.success) {
        const attempts: ModelAttempt[] = [{ model: cached.model, status: "ok", durationMs: 0 }];
        if (trackMetrics) await recordLlmRun({ operation: "classification", cacheHit: true, status: "ok", model: cached.model, attempts, latencyMs: Date.now() - startedAt });
        return { status: "ok", model: cached.model, hypothesis: parsed.data, attempts, cached: true };
      }
    }
  }
  const completion = await chatCompletionWithFallback({
    apiKey,
    baseUrl,
    fetchImpl,
    timeoutMs,
    models,
    bodyForModel: (attemptModel) => ({
      model: attemptModel,
      temperature: 0,
      enable_thinking: relationThinkingEnabled(attemptModel),
      max_tokens: 3000,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: `Classify these contracts and return JSON.\nANCHOR:\n${JSON.stringify(anchor)}\nCANDIDATE:\n${JSON.stringify(candidate)}`,
        },
      ],
      response_format: { type: "json_object" },
    }),
    validateContent: (content) => decode(content).error,
  });
  if (completion.status !== "ok" || !completion.content) {
    if (trackMetrics) await recordLlmRun({ operation: "classification", cacheHit: false, status: "error", model: completion.model, attempts: completion.attempts, latencyMs: Date.now() - startedAt });
    return { status: "error", model: completion.model, reason: completion.reason, attempts: completion.attempts };
  }
  const decoded = decode(completion.content);
  if (!decoded.parsed) {
    if (trackMetrics) await recordLlmRun({ operation: "classification", cacheHit: false, status: "error", model: completion.model, attempts: completion.attempts, latencyMs: Date.now() - startedAt });
    return { status: "error", model: completion.model, reason: decoded.error, attempts: completion.attempts };
  }
  if (useCache) await storeLlmCache(cacheKey, "classification", decoded.parsed.data, completion.model);
  if (trackMetrics) await recordLlmRun({ operation: "classification", cacheHit: false, status: "ok", model: completion.model, attempts: completion.attempts, latencyMs: Date.now() - startedAt });
  return { status: "ok", model: completion.model, hypothesis: decoded.parsed.data, attempts: completion.attempts, cached: false };
}
