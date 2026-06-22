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
}

export interface ElicitOptions {
  apiKey?: string;
  model?: string;
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
  const model = options.model || process.env.QWEN_RELATION_MODEL || "qwen-plus";
  if (!apiKey) return { status: "disabled", model, failReason: "DASHSCOPE_API_KEY/QWEN_API_KEY is not configured" };
  const baseUrl = (options.baseUrl || process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const configured = Number(process.env.QWEN_RELATION_TIMEOUT_MS ?? 30_000);
  const timeoutMs = options.timeoutMs ?? (Number.isFinite(configured) ? Math.min(120_000, Math.max(5_000, configured)) : 30_000);
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
        max_tokens: 800,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `ANCHOR outcome: ${anchorTitle}\nCANDIDATE outcome: ${candidateTitle}\nReturn JSON only.` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) return { status: "error", model, failReason: `Qwen HTTP ${res.status}` };
    const raw = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = raw.choices?.[0]?.message?.content;
    if (!content) return { status: "error", model, failReason: "Qwen returned no content" };
    const parsed = ElicitSchema.safeParse(JSON.parse(content) as unknown);
    if (!parsed.success) return { status: "error", model, failReason: `schema: ${parsed.error.issues.slice(0, 2).map((i) => i.message).join("; ")}` };
    return { status: "ok", model, ...parsed.data };
  } catch (err) {
    return { status: "error", model, failReason: err instanceof Error ? err.message : "Qwen request failed" };
  } finally {
    clearTimeout(timer);
  }
}
