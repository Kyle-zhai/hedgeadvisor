import { createHash } from "node:crypto";
import { ensureSchema, getSql } from "@/lib/data/db";
import type { ModelAttempt } from "./modelFallback";

interface CacheEntry<T> {
  value: T;
  model: string;
  expiresAt: number;
}

const memory = new Map<string, CacheEntry<unknown>>();
let maintenancePromise: Promise<void> | null = null;

async function maintain(sql: Awaited<ReturnType<typeof getSql>>): Promise<void> {
  if (!sql) return;
  if (!maintenancePromise) {
    maintenancePromise = (async () => {
      await sql`DELETE FROM llm_relation_cache WHERE expires_at < now() - interval '7 days'`;
      await sql`DELETE FROM llm_relation_run WHERE created_at < now() - interval '30 days'`;
    })().catch((error) => {
      console.error(`[llmMetrics] maintenance failed: ${error instanceof Error ? error.message : "unknown error"}`);
    });
  }
  await maintenancePromise;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function llmCacheKey(operation: string, version: string, input: unknown): string {
  return `${operation}:${createHash("sha256").update(`${version}:${stable(input)}`).digest("hex")}`;
}

function ttlMs(): number {
  const configured = Number(process.env.HEDGE_LLM_CACHE_TTL_HOURS ?? 168);
  const hours = Number.isFinite(configured) ? Math.min(720, Math.max(1, configured)) : 168;
  return hours * 3_600_000;
}

export async function loadLlmCache<T>(cacheKey: string): Promise<{ value: T; model: string } | null> {
  const cached = memory.get(cacheKey) as CacheEntry<T> | undefined;
  if (cached && cached.expiresAt > Date.now()) return { value: cached.value, model: cached.model };
  if (cached) memory.delete(cacheKey);

  const sql = await getSql();
  if (!sql) return null;
  try {
    await ensureSchema(sql);
    const rows = await sql`
      UPDATE llm_relation_cache
      SET hits = hits + 1, last_hit_at = now()
      WHERE cache_key = ${cacheKey} AND expires_at > now()
      RETURNING payload, model, expires_at::text
    ` as Array<{ payload: T | string; model: string; expires_at: string }>;
    const row = rows[0];
    if (!row) return null;
    const value = typeof row.payload === "string" ? JSON.parse(row.payload) as T : row.payload;
    memory.set(cacheKey, { value, model: row.model, expiresAt: new Date(row.expires_at).getTime() });
    return { value, model: row.model };
  } catch (error) {
    console.error(`[llmCache] read failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return null;
  }
}

export async function storeLlmCache(cacheKey: string, operation: string, value: unknown, model: string): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs());
  memory.set(cacheKey, { value, model, expiresAt: expiresAt.getTime() });
  const sql = await getSql();
  if (!sql) return;
  try {
    await ensureSchema(sql);
    await maintain(sql);
    await sql`
      INSERT INTO llm_relation_cache (cache_key, operation, payload, model, expires_at)
      VALUES (${cacheKey}, ${operation}, CAST(${JSON.stringify(value)} AS jsonb), ${model}, ${expiresAt.toISOString()})
      ON CONFLICT (cache_key) DO UPDATE SET
        operation = EXCLUDED.operation,
        payload = EXCLUDED.payload,
        model = EXCLUDED.model,
        created_at = now(),
        expires_at = EXCLUDED.expires_at
    `;
  } catch (error) {
    console.error(`[llmCache] write failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export async function recordLlmRun(input: {
  operation: string;
  cacheHit: boolean;
  status: "ok" | "error" | "disabled";
  model?: string;
  attempts?: ModelAttempt[];
  latencyMs: number;
}): Promise<void> {
  const sql = await getSql();
  if (!sql) return;
  try {
    await ensureSchema(sql);
    await maintain(sql);
    await sql`
      INSERT INTO llm_relation_run (operation, cache_hit, status, model, attempts, latency_ms)
      VALUES (${input.operation}, ${input.cacheHit}, ${input.status}, ${input.model ?? null},
        CAST(${input.attempts ? JSON.stringify(input.attempts) : null} AS jsonb), ${Math.max(0, Math.round(input.latencyMs))})
    `;
  } catch (error) {
    console.error(`[llmMetrics] write failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}
