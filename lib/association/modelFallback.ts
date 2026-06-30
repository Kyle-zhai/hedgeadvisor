// Ordered fallback chain: each model is tried in order, and quota / rate-limit / error responses fall
// through to the NEXT model (see chatCompletionWithFallback). Qwen/DashScope is the primary provider.
export const DEFAULT_RELATION_MODEL_CHAIN = [
  "qwen3-max-2025-09-23",
  "qwen-plus-2025-12-01",
  "qwen-long-latest",
  "qwen3.5-27b",
  "glm-4.5-air",
  "deepseek-r1-distill-qwen-14b",
  "qwen-plus-1220",
  "qwen3.5-flash-2026-02-23",
  "qwen-flash-2025-07-28",
] as const;

export const DEFAULT_RELATION_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export interface ModelAttempt {
  model: string;
  status: "ok" | "error";
  reason?: string;
  durationMs?: number;
}

export interface ChatFallbackOptions {
  apiKey: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  models: string[];
  bodyForModel: (model: string) => Record<string, unknown>;
  /** Return an error string to reject this model's content and continue to the next model. */
  validateContent?: (content: string, model: string) => string | undefined;
}

export interface ChatFallbackResult {
  status: "ok" | "error";
  model: string;
  content?: string;
  reason?: string;
  attempts: ModelAttempt[];
}

const unique = (models: string[]) => [...new Set(models.map((model) => model.trim()).filter(Boolean))];

export function relationApiKey(explicit?: string): string | undefined {
  return explicit || process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || process.env.RELATION_API_KEY;
}

export function relationBaseUrl(explicit?: string): string {
  return (explicit || process.env.QWEN_BASE_URL || process.env.RELATION_BASE_URL || DEFAULT_RELATION_BASE_URL).replace(/\/$/, "");
}

export function relationTimeoutMs(explicit?: number): number {
  const configured = Number(process.env.QWEN_RELATION_TIMEOUT_MS ?? process.env.RELATION_TIMEOUT_MS ?? 30_000);
  return explicit ?? (Number.isFinite(configured) ? Math.min(120_000, Math.max(5_000, configured)) : 30_000);
}

/** Explicit per-call models win. A legacy single-model override remains supported for tests and
 * one-off diagnostics; normal runtime uses the ordered comma-separated chain. */
export function relationModelChain(explicitModel?: string, explicitModels?: string[], role?: "recall" | "classify" | "elicit"): string[] {
  if (explicitModels?.length) return unique(explicitModels);
  if (explicitModel?.trim()) return [explicitModel.trim()];
  const roleSpecific =
    role === "recall" ? process.env.QWEN_RECALL_MODELS ?? process.env.HEDGE_RECALL_MODELS
      : role === "classify" ? process.env.QWEN_CLASSIFY_MODELS ?? process.env.HEDGE_CLASSIFY_MODELS
        : role === "elicit" ? process.env.QWEN_ELICIT_MODELS ?? process.env.HEDGE_ELICIT_MODELS
          : undefined;
  const configured = (roleSpecific ?? process.env.QWEN_RELATION_MODELS ?? process.env.RELATION_MODELS)?.split(",") ?? [];
  if (configured.some((model) => model.trim())) return unique(configured);
  const legacyPrimary = (process.env.QWEN_RELATION_MODEL ?? process.env.RELATION_MODEL)?.trim();
  return unique([legacyPrimary ?? "", ...DEFAULT_RELATION_MODEL_CHAIN]);
}

/** Bailian's MiniMax endpoint requires thinking=true; Qwen hybrids stay deterministic and concise. */
export function relationThinkingEnabled(model: string): boolean {
  return /^minimax[-/]/i.test(model);
}

/** Extract the final JSON object while tolerating fenced output or MiniMax native <think> blocks. */
export function extractJsonContent(content: string): string {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const withoutFence = withoutThinking.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  return start >= 0 && end > start ? withoutFence.slice(start, end + 1) : withoutFence;
}

function errorCode(body: string): string | undefined {
  try {
    const decoded = JSON.parse(body) as { code?: unknown; error?: { code?: unknown; type?: unknown }; type?: unknown };
    const value = decoded.code ?? decoded.error?.code ?? decoded.type ?? decoded.error?.type;
    return typeof value === "string" ? value.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

/** One key/base URL, ordered model failover. Authentication errors stop immediately because trying
 * another model cannot repair a bad key; quota, rate-limit, model and output errors fall through. */
export async function chatCompletionWithFallback(options: ChatFallbackOptions): Promise<ChatFallbackResult> {
  const models = unique(options.models);
  const attempts: ModelAttempt[] = [];
  if (!models.length) return { status: "error", model: "", reason: "No relation models configured", attempts };

  for (const model of models) {
    const startedAt = Date.now();
    const controller = new AbortController();
    // Bailian's MiniMax-M2.5 is thinking-only and does not support thinking_budget. Give it enough
    // time to reach the final JSON while keeping faster fallback models on the configured timeout.
    const attemptTimeoutMs = relationThinkingEnabled(model) ? Math.max(options.timeoutMs, 90_000) : options.timeoutMs;
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      const response = await options.fetchImpl(`${options.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(options.bodyForModel(model)),
      });
      if (!response.ok) {
        const code = errorCode(await response.text().catch(() => ""));
        const reason = `HTTP ${response.status}${code ? ` (${code})` : ""}`;
        attempts.push({ model, status: "error", reason, durationMs: Date.now() - startedAt });
        if (response.status === 401) return { status: "error", model, reason, attempts };
        continue;
      }
      const raw = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = raw.choices?.[0]?.message?.content;
      if (!content) {
        attempts.push({ model, status: "error", reason: "returned no content", durationMs: Date.now() - startedAt });
        continue;
      }
      const contentError = options.validateContent?.(content, model);
      if (contentError) {
        attempts.push({ model, status: "error", reason: contentError, durationMs: Date.now() - startedAt });
        continue;
      }
      attempts.push({ model, status: "ok", durationMs: Date.now() - startedAt });
      return { status: "ok", model, content, attempts };
    } catch (error) {
      attempts.push({ model, status: "error", reason: error instanceof Error ? error.message : "request failed", durationMs: Date.now() - startedAt });
    } finally {
      clearTimeout(timer);
    }
  }
  const last = attempts.at(-1);
  return {
    status: "error",
    model: last?.model ?? models[0],
    reason: attempts.map((attempt) => `${attempt.model}: ${attempt.reason ?? attempt.status}`).join("; "),
    attempts,
  };
}
