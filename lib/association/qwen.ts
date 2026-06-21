import { z } from "zod";
import type { MarketRuleInput, RelationHypothesis } from "./types";

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

/** Narrow, meaning-preserving aliases observed from Qwen. Unknown values still fail closed. */
function canonicalizeRelationJson(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const graph = root.mechanismGraph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) return value;
  const g = graph as Record<string, unknown>;
  if (g.mechanismType === "LOGICAL_IMPLICATION") g.mechanismType = "LOGICAL";
  if (Array.isArray(g.edges)) {
    for (const edge of g.edges) {
      if (edge && typeof edge === "object" && (edge as Record<string, unknown>).kind === "IMPLICATION") {
        (edge as Record<string, unknown>).kind = "IMPLIES";
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
}

export interface QwenRelationOptions {
  apiKey?: string;
  model?: string;
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
  const apiKey = options.apiKey ?? process.env.DASHSCOPE_API_KEY ?? process.env.QWEN_API_KEY;
  const model = options.model ?? process.env.QWEN_RELATION_MODEL ?? "qwen-plus";
  if (!apiKey) return { status: "disabled", model, reason: "DASHSCOPE_API_KEY/QWEN_API_KEY is not configured" };
  const baseUrl = (options.baseUrl ?? process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.QWEN_RELATION_TIMEOUT_MS ?? 30_000);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configuredTimeout)
    ? Math.min(120_000, Math.max(5_000, configuredTimeout))
    : 30_000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        enable_thinking: false,
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
    });
    if (!res.ok) return { status: "error", model, reason: `Qwen HTTP ${res.status}` };
    const raw = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = raw.choices?.[0]?.message?.content;
    if (!content) return { status: "error", model, reason: "Qwen returned no content" };
    const decoded = canonicalizeRelationJson(JSON.parse(content) as unknown);
    const parsed = RelationSchema.safeParse(decoded);
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
      const keys = decoded && typeof decoded === "object" && !Array.isArray(decoded) ? Object.keys(decoded).slice(0, 8).join(",") : typeof decoded;
      return { status: "error", model, reason: `Qwen output failed schema validation (${issues}); top-level keys: ${keys}` };
    }
    return { status: "ok", model, hypothesis: parsed.data };
  } catch (err) {
    return { status: "error", model, reason: err instanceof Error ? err.message : "Qwen request failed" };
  } finally {
    clearTimeout(timer);
  }
}
