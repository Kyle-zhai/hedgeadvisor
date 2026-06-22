import type { NormalizedMarket } from "./types";
import { lexicalSimilarity, metadataCompatible } from "./candidates";
import { chatCompletionWithFallback, extractJsonContent, relationModelChain, relationThinkingEnabled } from "@/lib/association/modelFallback";
import type { ModelAttempt } from "@/lib/association/modelFallback";
import { llmCacheKey, loadLlmCache, recordLlmRun, storeLlmCache } from "@/lib/association/llmCache";

export interface RecallDiagnostics {
  status: "ok" | "error" | "disabled";
  model?: string;
  cached: boolean;
  attempts?: ModelAttempt[];
  selected: number;
  pool: number;
}

interface RecallOptions {
  apiKey?: string;
  model?: string;
  models?: string[];
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  cache?: boolean;
  onDiagnostics?: (diagnostics: RecallDiagnostics) => void;
}

/** One batched LLM shortlist when paid embeddings are disabled. Recall only, never evidence. */
export async function recallCandidatesWithQwen(
  anchor: NormalizedMarket,
  universe: NormalizedMarket[],
  limit: number,
  options: RecallOptions = {},
): Promise<NormalizedMarket[] | null> {
  const startedAt = Date.now();
  const apiKey = options.apiKey || process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY; // || so empty "" falls through
  if (!apiKey || limit <= 0) {
    options.onDiagnostics?.({ status: "disabled", cached: false, selected: 0, pool: 0 });
    return null;
  }
  const models = relationModelChain(options.model, options.models);
  const baseUrl = (options.baseUrl || process.env.QWEN_BASE_URL || "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
  const eligible = universe.filter((candidate) => candidate.liquidityOk && metadataCompatible(anchor, candidate, true));
  const lexical = [...eligible].sort((a, b) => lexicalSimilarity(anchor, b) - lexicalSimilarity(anchor, a));
  const pool: NormalizedMarket[] = lexical.slice(0, 40);
  const seenEvents = new Set(pool.map((market) => market.eventKey));
  for (const candidate of eligible) {
    if (pool.length >= 80) break;
    if (seenEvents.has(candidate.eventKey)) continue;
    seenEvents.add(candidate.eventKey);
    pool.push(candidate);
  }
  if (!pool.length) return [];

  const useCache = options.cache ?? !options.fetchImpl;
  const trackMetrics = !options.fetchImpl;
  const cacheKey = llmCacheKey("recall", "recall-v2", {
    anchor: { id: anchor.id, title: anchor.title, marketTitle: anchor.marketTitle, rules: anchor.resolutionCriteria },
    limit,
    models,
    pool: pool.map((candidate) => ({ id: candidate.id, title: candidate.title, marketTitle: candidate.marketTitle, rules: candidate.resolutionCriteria })),
  });
  if (useCache) {
    const cached = await loadLlmCache<{ candidateIds?: unknown }>(cacheKey);
    if (cached && Array.isArray(cached.value.candidateIds)) {
      const ids = new Set(cached.value.candidateIds.filter((id): id is string => typeof id === "string").slice(0, limit));
      const matched = pool.filter((candidate) => ids.has(candidate.id)).slice(0, limit);
      const attempts: ModelAttempt[] = [{ model: cached.model, status: "ok", durationMs: 0 }];
      const diagnostics = { status: "ok" as const, model: cached.model, cached: true, attempts, selected: matched.length, pool: pool.length };
      options.onDiagnostics?.(diagnostics);
      if (trackMetrics) await recordLlmRun({ operation: "recall", cacheHit: true, status: "ok", model: cached.model, attempts, latencyMs: Date.now() - startedAt });
      return matched;
    }
  }

  const decode = (content: string) => {
    try {
      const decoded = JSON.parse(extractJsonContent(content)) as { candidateIds?: unknown };
      return Array.isArray(decoded.candidateIds) ? ({ decoded } as const) : ({ error: "no candidateIds array" } as const);
    } catch (error) {
      return { error: `invalid JSON: ${error instanceof Error ? error.message : "parse failed"}` } as const;
    }
  };
  const completion = await chatCompletionWithFallback({
    apiKey,
    baseUrl,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 45_000,
    models,
    bodyForModel: (attemptModel) => ({
      model: attemptModel,
      temperature: 0,
      enable_thinking: relationThinkingEnabled(attemptModel),
      max_tokens: 2000, // a long candidateIds list for big pools must not truncate (→ invalid JSON)
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Shortlist prediction-market contracts that may have a real logical, causal, institutional, behavioral, informational, economic, narrative, temporal, or common-cause mechanism with the anchor. Find non-obvious cross-entity and cross-domain candidates. Exclude mere word/date overlap. Return JSON only, exactly {\"candidateIds\":[\"id\"]}. This is recall only; do not estimate correlation or recommend trades." },
        { role: "user", content: JSON.stringify({
          anchor: { title: anchor.title, marketTitle: anchor.marketTitle, rules: anchor.resolutionCriteria },
          limit,
          candidates: pool.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            marketTitle: candidate.marketTitle,
            rules: candidate.resolutionCriteria.slice(0, 240),
            category: candidate.category,
          })),
        }) },
      ],
    }),
    validateContent: (content) => decode(content).error,
  });
  if (completion.status !== "ok" || !completion.content) {
    console.error(`[llmRecall] all models failed: ${completion.reason}`);
    options.onDiagnostics?.({ status: "error", model: completion.model, cached: false, attempts: completion.attempts, selected: 0, pool: pool.length });
    if (trackMetrics) await recordLlmRun({ operation: "recall", cacheHit: false, status: "error", model: completion.model, attempts: completion.attempts, latencyMs: Date.now() - startedAt });
    return null;
  }
  const result = decode(completion.content);
  if (!result.decoded || !Array.isArray(result.decoded.candidateIds)) return null;
  const candidateIds = result.decoded.candidateIds;
  const ids = new Set(candidateIds.filter((id): id is string => typeof id === "string").slice(0, limit));
  const matched = pool.filter((candidate) => ids.has(candidate.id)).slice(0, limit);
  if (useCache) await storeLlmCache(cacheKey, "recall", { candidateIds: [...ids] }, completion.model);
  options.onDiagnostics?.({ status: "ok", model: completion.model, cached: false, attempts: completion.attempts, selected: matched.length, pool: pool.length });
  if (trackMetrics) await recordLlmRun({ operation: "recall", cacheHit: false, status: "ok", model: completion.model, attempts: completion.attempts, latencyMs: Date.now() - startedAt });
  console.error(`[llmRecall] model=${completion.model} pool=${pool.length} modelReturnedIds=${candidateIds.length} matchedPoolIds=${matched.length}`);
  return matched;
}
