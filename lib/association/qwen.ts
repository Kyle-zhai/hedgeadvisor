import { z } from "zod";
import type { MarketRuleInput, RelationHypothesis } from "./types";
import {
  chatCompletionWithFallback,
  extractJsonContent,
  relationModelChain,
  relationThinkingEnabled,
  type ModelAttempt,
} from "./modelFallback";

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

// Meaning-preserving aliases for enum values Qwen commonly emits outside the schema vocabulary.
// Anything NOT listed here is left as-is and still fails the Zod parse (fail-closed honesty).
const MECH_TYPE_ALIAS: Record<string, string> = {
  LOGICAL_IMPLICATION: "LOGICAL", THEMATIC: "OTHER", CORRELATION: "COMMON_CAUSE",
  COMMON_DRIVER: "COMMON_CAUSE", ASSOCIATION: "OTHER", STRUCTURAL: "LOGICAL",
  REPUTATIONAL: "BEHAVIORAL", POLITICAL: "INSTITUTIONAL", FINANCIAL: "ECONOMIC", SENTIMENT: "BEHAVIORAL",
};
const TIME_ORDER_ALIAS: Record<string, string> = {
  SIMULTANEOUS: "OVERLAPPING", SIMULTANEOUS_WINDOW: "OVERLAPPING", CONCURRENT: "OVERLAPPING",
  INDEPENDENT: "UNKNOWN", NONE: "UNKNOWN", UNSPECIFIED: "UNKNOWN", UNORDERED: "UNKNOWN",
  ANCHOR_AFTER_CANDIDATE: "CANDIDATE_BEFORE_ANCHOR", CANDIDATE_AFTER_ANCHOR: "ANCHOR_BEFORE_CANDIDATE",
};
const EDGE_KIND_ALIAS: Record<string, string> = {
  IMPLICATION: "IMPLIES", INFLUENCES: "SIGNALS", INFLUENCE: "SIGNALS", AFFECTS: "SIGNALS",
  IMPACTS: "SIGNALS", CORRELATES_WITH: "SHARES_DRIVER", CORRELATED_WITH: "SHARES_DRIVER",
  PRECEDES: "SIGNALS", LEADS_TO: "CAUSES", RESULTS_IN: "CAUSES", CONTRIBUTES_TO: "ENABLES",
  PREVENTS: "INHIBITS", REDUCES: "INHIBITS", INCREASES: "ENABLES", DEPENDS_ON: "REACTS_TO",
};

/** Narrow, meaning-preserving aliases observed from Qwen. Unknown values still fail closed. */
function canonicalizeRelationJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (typeof root.mechanism === "string" && root.mechanism.length > 1200) root.mechanism = root.mechanism.slice(0, 1200);
  const graph = root.mechanismGraph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return value;
  const g = graph as Record<string, unknown>;
  if (typeof g.mechanismType === "string") { const k = g.mechanismType.toUpperCase(); g.mechanismType = MECH_TYPE_ALIAS[k] ?? k; }
  if (typeof g.timeOrder === "string") { const k = g.timeOrder.toUpperCase(); g.timeOrder = TIME_ORDER_ALIAS[k] ?? k; }
  if (Array.isArray(g.edges)) {
    for (const edge of g.edges) {
      if (edge && typeof edge === "object") {
        const e = edge as Record<string, unknown>;
        if (typeof e.kind === "string") { const k = e.kind.toUpperCase(); e.kind = EDGE_KIND_ALIAS[k] ?? k; }
      }
    }
  }
  return value;
}

export interface QwenRelationResult {
  status: "ok" | "disabled" | "error";
  model: string;
  hypothesis?: RelationHypothesis;
  reason?: string;
  attempts?: ModelAttempt[];
}

export interface QwenRelationOptions {
  apiKey?: string;
  model?: string;
  models?: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
    return { status: "error", model: completion.model, reason: completion.reason, attempts: completion.attempts };
  }
  const decoded = decode(completion.content);
  if (!decoded.parsed) return { status: "error", model: completion.model, reason: decoded.error, attempts: completion.attempts };
  return { status: "ok", model: completion.model, hypothesis: decoded.parsed.data, attempts: completion.attempts };
}
