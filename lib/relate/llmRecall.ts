import type { NormalizedMarket } from "./types";
import { lexicalSimilarity, metadataCompatible } from "./candidates";

interface RecallOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** One batched LLM shortlist when paid embeddings are disabled. Recall only, never evidence. */
export async function recallCandidatesWithQwen(
  anchor: NormalizedMarket,
  universe: NormalizedMarket[],
  limit: number,
  options: RecallOptions = {},
): Promise<NormalizedMarket[] | null> {
  const apiKey = options.apiKey || process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY; // || so empty "" falls through
  if (!apiKey || limit <= 0) return null;
  const model = options.model || process.env.QWEN_RELATION_MODEL || "qwen-plus";
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        enable_thinking: false,
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
    });
    if (!response.ok) { console.error(`[llmRecall] HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`); return null; }
    const raw = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const decoded = JSON.parse(raw.choices?.[0]?.message?.content ?? "{}") as { candidateIds?: unknown };
    if (!Array.isArray(decoded.candidateIds)) { console.error(`[llmRecall] no candidateIds array; keys=${Object.keys(decoded).join(",")}`); return null; }
    const ids = new Set(decoded.candidateIds.filter((id): id is string => typeof id === "string").slice(0, limit));
    const matched = pool.filter((candidate) => ids.has(candidate.id)).slice(0, limit);
    console.error(`[llmRecall] pool=${pool.length} modelReturnedIds=${decoded.candidateIds.length} matchedPoolIds=${matched.length}`);
    return matched;
  } catch (e) {
    console.error("[llmRecall] failed:", e instanceof Error ? e.message : e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
