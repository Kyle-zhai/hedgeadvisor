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
import { withFewShot } from "./relationFewShot";

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

Move the two conditionals apart ONLY when a specific, concrete mechanism links the two outcomes. The real mechanisms, with their direction:
  (a) shared contributor — same team, player, party, or region drives both (a player on the anchor nation winning the Golden Boot rises with the anchor): POSITIVE, pGivenAnchorWins > pGivenAnchorFails.
  (b) mutual exclusivity — they cannot both be true (two nations winning the same cup; two candidates winning the SAME party's nomination): near-impossible together, pGivenAnchorWins ≈ 0, pGivenAnchorFails > 0.
  (c) prerequisite — the anchor REQUIRES the candidate outcome, or excludes it. Winning a general election requires first winning that party's nomination, so a DIFFERENT same-party candidate winning that nomination excludes the anchor (NEGATIVE); the anchor candidate winning their own nomination is required (POSITIVE).
  (d) shared market or environment — assets in the SAME class move together (two cryptocurrencies; two tech stocks; a sector); a strong partisan or macro environment moves same-side races/outcomes together and opposite-side ones apart; an economic regime (recession, easing cycle) moves related macro outcomes together. This is REAL dependence.
  (e) same-event collateral — a market that RESOLVES on the anchor's OWN match, game, event, or broadcast, even when it looks topically unrelated: an in-game stat (total goals, a red card, a clean sheet, a penalty shootout), a crowd/reaction market (fans celebrating, the camera shows tears), or a broadcast/narrative market (the TV announcer says a word like "upset" or "golazo", the first song played). These are DOWNSTREAM consequences of the same event, so reason from how the anchor's result drives them: an "announcer says UPSET", "a red card", or "ends in a draw" market pays mostly when a FAVORED anchor team LOSES (NEGATIVE, a hedge); a "fans celebrate", "clean sheet", or "the star player scores" market pays when it WINS (POSITIVE). SCOPE MATTERS: a collateral market that resolves on ONE specific match only weakly tracks a TOURNAMENT-level anchor (the team plays many matches and can win the trophy after a draw/upset in any single one), so keep the two conditionals CLOSE to the base rate unless the anchor is itself about that same single match; only side-specific events (a red card AGAINST the favorite) are clean — a generic "any red card / any penalty" is mixed and should read near-independent.

OTHERWISE, DEFAULT TO INDEPENDENCE: set pGivenAnchorWins = pGivenAnchorFails = the candidate's base rate. In particular, two outcomes in DIFFERENT, unrelated domains (a sports result vs a crypto price vs a box-office result vs an unrelated election) are independent — do NOT invent a link from "same news cycle", "general uncertainty", or cross-domain "risk-on/off". And a candidate of ONE party winning an office is NOT mutually exclusive with someone of the OTHER party winning that other party's nomination — that is independent, never a strong exclusion.

Return JSON only with keys pGivenAnchorWins, pGivenAnchorFails, confidence (0-1; LOW when the link is speculative or you defaulted to independence), reason (one short sentence; say "independent, no concrete mechanism" when they are unrelated). Example JSON: {"pGivenAnchorWins":0.30,"pGivenAnchorFails":0.08,"confidence":0.5,"reason":"same-nation contributor, so it rises with the anchor"}`;

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
        // Flag-gated few-shot anchors (HEDGE_RELATION_FEWSHOT=1); default OFF → SYSTEM unchanged.
        { role: "system", content: withFewShot(SYSTEM) },
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
