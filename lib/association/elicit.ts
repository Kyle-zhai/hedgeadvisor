/**
 * lib/association/elicit.ts — cross-event DEPENDENCE estimator (the engine improvement, 2026-06-21).
 *
 * Research-backed method (no drop-in OSS exists for cross-EVENT correlation; GitHub repos are all
 * same-outcome arbitrage). We elicit conditional probabilities from the LLM, then PROJECT the implied
 * joint onto the Fréchet box of the de-vigged market marginals (the "constrain LLM estimates to the
 * feasible probability space" step from Du et al. 2025, specialized to a binary pair using the market's
 * own marginals). The caller derives a SIGNED φ via frechetProjectedPhi — fixing the engine's ~0
 * independence default and its broken correlation sign. This is an INFERRED, low-confidence signal: it
 * is admitted only to the exploratory layer, never the settlement-calibrated trustworthy layer.
 */
import { z } from "zod";
import { chatCompletionWithFallback, extractJsonContent, relationModelChain, relationThinkingEnabled, type ModelAttempt } from "./modelFallback";

const ElicitSchema = z.object({
  pGivenAnchorWins: z.number().min(0).max(1),
  pGivenAnchorFails: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(800),
});

export interface ConditionalElicitResult {
  status: "ok" | "disabled" | "error";
  model: string;
  pGivenAnchorWins?: number;
  pGivenAnchorFails?: number;
  confidence?: number;
  reason?: string;
  failReason?: string;
  attempts?: ModelAttempt[];
}

export interface ElicitOptions {
  apiKey?: string;
  model?: string;
  models?: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const SYSTEM = `You are a careful forecaster estimating the DEPENDENCE between two prediction-market outcomes on DIFFERENT events, using ordinary real-world knowledge (team rosters, shared drivers, mutual exclusivity, common causes). For the CANDIDATE outcome, estimate two conditional probabilities:
- pGivenAnchorWins = P(candidate pays | the anchor outcome HAPPENS)
- pGivenAnchorFails = P(candidate pays | the anchor outcome does NOT happen)
Reason from the mechanism:
- A contributor to the anchor (e.g. a player on the anchor nation winning the Golden Boot) is MORE likely when the anchor happens: pGivenAnchorWins > pGivenAnchorFails.
- An outcome that cannot co-occur with the anchor (e.g. "a non-European nation wins" when the anchor is "France wins") is near-impossible when the anchor happens: pGivenAnchorWins ≈ 0, pGivenAnchorFails > 0.
- Unrelated events: both conditionals ≈ the candidate's own base rate (roughly equal).
Keep the two estimates plausible and internally consistent with the mechanism. Return JSON only with keys pGivenAnchorWins, pGivenAnchorFails, confidence (0-1, your confidence in the estimate), reason (one short sentence naming the mechanism). Example JSON: {"pGivenAnchorWins":0.30,"pGivenAnchorFails":0.08,"confidence":0.5,"reason":"same-nation contributor, so it rises with the anchor"}`;

/** Elicit P(candidate | anchor wins) and P(candidate | anchor fails) from the LLM. Disabled safely
 *  (status "disabled") when no key is configured, exactly like analyzeRelationWithQwen. */
export async function elicitConditionalWithQwen(
  anchorTitle: string,
  candidateTitle: string,
  options: ElicitOptions = {},
): Promise<ConditionalElicitResult> {
  // || not ?? so an empty-string env var is treated as absent (see qwen.ts).
  const apiKey = options.apiKey || process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;
  const models = relationModelChain(options.model, options.models);
  const model = models[0] ?? "MiniMax-M2.5";
  if (!apiKey) return { status: "disabled", model, failReason: "DASHSCOPE_API_KEY/QWEN_API_KEY is not configured" };
  const baseUrl = (options.baseUrl || process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const configured = Number(process.env.QWEN_RELATION_TIMEOUT_MS ?? 30_000);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configured) ? Math.min(120_000, Math.max(5_000, configured)) : 30_000);
  const decode = (content: string) => {
    try {
      const parsed = ElicitSchema.safeParse(JSON.parse(extractJsonContent(content)) as unknown);
      return parsed.success
        ? ({ parsed } as const)
        : ({ error: `schema: ${parsed.error.issues.slice(0, 2).map((issue) => issue.message).join("; ")}` } as const);
    } catch (error) {
      return { error: `invalid JSON: ${error instanceof Error ? error.message : "parse failed"}` } as const;
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
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `ANCHOR outcome: ${anchorTitle}\nCANDIDATE outcome: ${candidateTitle}\nReturn JSON only.` },
      ],
      response_format: { type: "json_object" },
    }),
    validateContent: (content) => decode(content).error,
  });
  if (completion.status !== "ok" || !completion.content) {
    return { status: "error", model: completion.model, failReason: completion.reason, attempts: completion.attempts };
  }
  const decoded = decode(completion.content);
  if (!decoded.parsed) return { status: "error", model: completion.model, failReason: decoded.error, attempts: completion.attempts };
  return { status: "ok", model: completion.model, ...decoded.parsed.data, attempts: completion.attempts };
}
