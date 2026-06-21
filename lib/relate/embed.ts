/**
 * lib/relate/embed.ts — OPTIONAL semantic recall for Stage 1 (embedding cosine).
 *
 * Embeddings find non-obvious cross-entity links (France ↔ Mbappé) that lexical overlap can't.
 * They are RECALL only — they never judge the relation (Stage 2 does that). For a few hundred WC
 * markets, an in-memory brute-force cosine is plenty; no vector DB. No key / any error → returns
 * null and the caller falls back to lexical similarity (the always-on baseline).
 */
import type { NormalizedMarket } from "./types";

const EMBED_MODEL = process.env.HEDGE_EMBED_MODEL ?? "openai/text-embedding-3-small";
const QWEN_EMBED_MODEL = process.env.QWEN_EMBED_MODEL ?? "text-embedding-v4";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}

// PERSISTENT embedding index: id → vector, with a TTL. Embeddings are stable, so we embed each
// market at most once and reuse the vector across requests — a real growing index, not a per-call
// recompute. Each discovery only embeds the markets not already in the index.
const vectorIndex = new Map<string, { at: number; v: number[] }>();
const INDEX_TTL = 6 * 60 * 60 * 1000;

function embedText(m: NormalizedMarket): string {
  return `${m.marketTitle}: ${m.title}. ${m.resolutionCriteria}`.slice(0, 400);
}

/**
 * Embed any markets missing from the index, then return a cosine scorer over the cached index.
 * Returns null when no gateway key is configured or embedding fails — caller uses lexical similarity.
 */
export async function buildSemanticScorer(
  markets: NormalizedMarket[],
): Promise<((a: NormalizedMarket, b: NormalizedMarket) => number) | null> {
  if (process.env.HEDGE_ENABLE_SEMANTIC_EMBEDDINGS?.toLowerCase() === "false") return null;
  const qwenKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY; // || so empty "" falls through
  const provider = process.env.AI_GATEWAY_API_KEY ? "gateway" : qwenKey ? "qwen" : null;
  if (!provider) return null;
  const model = provider === "gateway" ? EMBED_MODEL : QWEN_EMBED_MODEL;
  const cacheKey = (id: string) => `${provider}:${model}:${id}`;
  try {
    const now = Date.now();
    const missing = markets.filter((m) => {
      const hit = vectorIndex.get(cacheKey(m.id));
      return !hit || now - hit.at >= INDEX_TTL;
    });
    if (missing.length > 0) {
      let embeddings: number[][] = [];
      if (provider === "gateway") {
        const { embedMany } = await import("ai");
        ({ embeddings } = await embedMany({ model, values: missing.map(embedText), maxRetries: 1 }));
      } else {
        const baseUrl = (process.env.QWEN_BASE_URL ?? "https://dashscope-intl.aliyuncs.com/compatible-mode/v1").replace(/\/$/, "");
        // DashScope text-embedding-v4 accepts at most 10 inputs per synchronous request.
        for (let i = 0; i < missing.length; i += 10) {
          const batch = missing.slice(i, i + 10);
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 15_000);
          try {
            const response = await fetch(`${baseUrl}/embeddings`, {
              method: "POST",
              signal: ctrl.signal,
              headers: { authorization: `Bearer ${qwenKey}`, "content-type": "application/json" },
              body: JSON.stringify({ model, input: batch.map(embedText) }),
            });
            if (!response.ok) throw new Error(`Qwen embeddings HTTP ${response.status}`);
            const body = await response.json() as { data?: Array<{ index?: number; embedding?: number[] }> };
            const ordered = [...(body.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
            if (ordered.length !== batch.length || ordered.some((x) => !Array.isArray(x.embedding))) throw new Error("invalid Qwen embedding response");
            embeddings.push(...ordered.map((x) => x.embedding!));
          } finally {
            clearTimeout(timer);
          }
        }
      }
      if (embeddings.length !== missing.length) throw new Error("embedding count mismatch");
      missing.forEach((m, i) => vectorIndex.set(cacheKey(m.id), { at: Date.now(), v: embeddings[i] }));
    }
    return (a, b) => {
      const va = vectorIndex.get(cacheKey(a.id))?.v;
      const vb = vectorIndex.get(cacheKey(b.id))?.v;
      return va && vb ? cosine(va, vb) : 0;
    };
  } catch {
    return null;
  }
}
