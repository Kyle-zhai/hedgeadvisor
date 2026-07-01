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
import { chatCompletionWithFallback, extractJsonContent, relationApiKey, relationBaseUrl, relationModelChain, relationThinkingEnabled, relationTimeoutMs, type ModelAttempt } from "./modelFallback";
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

/** Flag-gated (HEDGE_RELATION_PROMPT_V2=1) reinforcement of the two empirically-weak cases in the eval:
 *  nested LOGICAL ENTAILMENT (was under-elicited → wrong sign) and TRUE INDEPENDENCE for unrelated pairs
 *  (was over-linked → spurious sign). Appended to SYSTEM; default OFF so it can be A/B-measured first. */
const SYSTEM_V2 = `

TWO CRITICAL CASES — apply BEFORE the independence default:
1) LOGICAL ENTAILMENT (the strongest POSITIVE — do NOT shade it toward the base rate). If the anchor outcome by DEFINITION guarantees the candidate, set pGivenAnchorWins = 0.99. This covers: nested numeric thresholds for the SAME subject (a team that wins 14+ games necessarily won 12+; a price above $150 is above $120; 5,000+ yards is 4,500+); later tournament/playoff stages implying every earlier one (reaching the final implies the semifinal and quarterfinal); and a broader event containing a narrower one. Then pGivenAnchorFails is the candidate's rate among the cases where the anchor did NOT happen — clearly above 0 and below pGivenAnchorWins. If instead the anchor guarantees the candidate CANNOT happen, set pGivenAnchorWins = 0.01.
2) TRUE INDEPENDENCE (be strict — most candidate pairs are independent). Before you move the two conditionals apart, NAME the concrete mechanism (a–e) in one phrase. If you cannot, the outcomes are INDEPENDENT: set pGivenAnchorWins = pGivenAnchorFails (the candidate's base rate) with LOW confidence. Outcomes in DIFFERENT unrelated domains — a sports result vs a crypto price vs a box-office number vs an unrelated country's election — are independent even when both are uncertain or both are "in the news"; never infer a link from shared timing, general risk-on/off sentiment, or vague thematic overlap.`;

/** Shared elicitation core: identical contract/decoding/guards for every FRAMING of the system prompt. */
async function elicitWithSystem(
  system: string,
  anchorTitle: string,
  candidateTitle: string,
  options: ElicitOptions = {},
): Promise<ConditionalElicitResult> {
  const apiKey = relationApiKey(options.apiKey);
  const models = relationModelChain(options.model, options.models, "elicit");
  const model = models[0] ?? "MiniMax-M2.5";
  if (!apiKey) return { status: "disabled", model, failReason: "DASHSCOPE_API_KEY/QWEN_API_KEY is not configured" };
  const baseUrl = relationBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = relationTimeoutMs(options.timeoutMs);
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
      ...(relationThinkingEnabled(attemptModel) ? { enable_thinking: true } : {}),
      max_tokens: 2000, // headroom: a reasoning model spends an internal pass before content; 800 risked empty
      messages: [
        // Flag-gated few-shot anchors (HEDGE_RELATION_FEWSHOT=1); default OFF → system unchanged.
        { role: "system", content: withFewShot(system) },
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
  const data = decoded.parsed.data;
  // HONESTY GUARD: when the elicitor's OWN reason declares independence ("independent, no concrete mechanism",
  // the exact phrase the SYSTEM prompt asks for on unrelated pairs) yet it still returned divergent conditionals,
  // trust the qualitative call over the noisy numbers and EQUALIZE them. Independence means no conditional loss
  // reduction, so this stops the optimizer building a spurious cross-domain hedge from a pair the model itself
  // says is unrelated. Observed live on qwen3-max: a Fed-decision anchor "hedged" by a World Cup market it
  // labeled "independent" (pWin 0.44 / pFail 0.85). Only fires on the explicit independence admission.
  const independent = /\bno concrete mechanism\b/i.test(data.reason) || /^\s*independent\b/i.test(data.reason);
  const mid = (data.pGivenAnchorWins + data.pGivenAnchorFails) / 2;
  const guarded = independent ? { ...data, pGivenAnchorWins: mid, pGivenAnchorFails: mid } : data;
  return { status: "ok", model: completion.model, ...guarded, attempts: completion.attempts };
}

/** Elicit P(candidate | anchor wins) and P(candidate | anchor fails) from the LLM. Disabled safely
 *  (status "disabled") when no key is configured, exactly like analyzeRelationWithQwen.
 *  Flag-gated V2 prompt (HEDGE_RELATION_PROMPT_V2=1) reinforces entailment + independence; default OFF. */
export async function elicitConditionalWithQwen(
  anchorTitle: string,
  candidateTitle: string,
  options: ElicitOptions = {},
): Promise<ConditionalElicitResult> {
  return elicitWithSystem(process.env.HEDGE_RELATION_PROMPT_V2 === "1" ? SYSTEM + SYSTEM_V2 : SYSTEM, anchorTitle, candidateTitle, options);
}

/** §19 anti-sycophancy, the ADVERSARIAL FRAMING: same contract, temp 0, but the system prompt ARGUES
 *  AGAINST the link — the pair earns divergent conditionals only if independence cannot honestly be
 *  defended. SycEval measured 46–95% agreement-flips when a stated belief leaks into the prompt; the
 *  fabricated-plausible-mechanism case is exactly what the single confession-regex guard misses. */
const ADVERSARIAL_SYSTEM = `You are a SKEPTICAL auditor. Your job is to REFUTE a claimed dependence between two prediction-market outcomes on DIFFERENT events. Start from the position that they are INDEPENDENT. Concede a dependence ONLY if you cannot honestly defend independence — i.e. a specific, concrete, NAMED mechanism undeniably links them: (a) shared contributor (same team/player/party/region drives both); (b) mutual exclusivity (cannot both be true); (c) prerequisite (one requires or excludes the other); (d) shared market or environment (same asset class; same partisan/macro regime); (e) same-event collateral (resolves on the anchor's own match/event/broadcast). Vague thematic overlap, a shared news cycle, "risk sentiment", or the mere plausibility of a story are NOT mechanisms — hold the line at independence for those.
Estimate for the CANDIDATE outcome:
- pGivenAnchorWins = P(candidate pays | the anchor outcome HAPPENS)
- pGivenAnchorFails = P(candidate pays | the anchor outcome does NOT happen)
If you maintain independence, set both EQUAL to the candidate's base rate and say "independent, no concrete mechanism".
Return JSON only with keys pGivenAnchorWins, pGivenAnchorFails, confidence (0-1), reason (one short sentence).`;

export async function elicitConditionalAdversarial(
  anchorTitle: string,
  candidateTitle: string,
  options: ElicitOptions = {},
): Promise<ConditionalElicitResult> {
  return elicitWithSystem(ADVERSARIAL_SYSTEM, anchorTitle, candidateTitle, options);
}

export interface SignVetoInput { pGivenAnchorWins: number; pGivenAnchorFails: number }

/** §19 anti-sycophancy combiner (pure, unit-tested). A leg keeps its divergent conditionals ONLY when the
 *  divergence SURVIVES being argued against: the adversarial pass must itself return a materially
 *  divergent, SAME-SIGN estimate. Otherwise the conditionals are EQUALIZED (φ→0 ⇒ the leg drops through
 *  the existing gates). Veto-only — it can never widen a divergence or admit a leg. Fail-OPEN on missing/
 *  errored adversarial evidence (a provider blip must not silently kill every leg); the veto fires only on
 *  an ACTIVE failure to reproduce the sign. Both passes are temperature-0 and differ by FRAMING, not RNG,
 *  so a replay reproduces the same decision (the freeze-path requirement). */
export function adversarialSignVeto(
  primary: SignVetoInput,
  adversarial: (Partial<SignVetoInput> & { status?: string }) | null | undefined,
  tolerance = 0.02,
): SignVetoInput & { vetoed: boolean } {
  const dP = primary.pGivenAnchorFails - primary.pGivenAnchorWins;
  if (Math.abs(dP) <= tolerance) return { ...primary, vetoed: false }; // already ~independent — nothing to defend
  if (!adversarial || adversarial.status !== "ok" || adversarial.pGivenAnchorWins == null || adversarial.pGivenAnchorFails == null) {
    return { ...primary, vetoed: false }; // fail-open: no adversarial evidence
  }
  const dA = adversarial.pGivenAnchorFails - adversarial.pGivenAnchorWins;
  const survives = Math.abs(dA) > tolerance && Math.sign(dA) === Math.sign(dP);
  if (survives) return { ...primary, vetoed: false };
  const mid = (primary.pGivenAnchorWins + primary.pGivenAnchorFails) / 2;
  return { pGivenAnchorWins: mid, pGivenAnchorFails: mid, vetoed: true };
}
