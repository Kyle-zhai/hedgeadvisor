/**
 * lib/polymarket/client.ts — thin read-only client for the three public
 * Polymarket hosts. No auth (reads are public). Conservative client-side
 * backoff because Cloudflare THROTTLES rather than hard-rejects.
 *
 * Design choices per the spec:
 *  - read-on-demand (we never bulk-mirror Polymarket data)
 *  - parse JSON-string fields (clobTokenIds/outcomePrices) at this boundary
 */

export const GAMMA = process.env.POLYMARKET_GAMMA_HOST ?? "https://gamma-api.polymarket.com";
export const CLOB = process.env.POLYMARKET_CLOB_HOST ?? "https://clob.polymarket.com";
export const DATA = process.env.POLYMARKET_DATA_HOST ?? "https://data-api.polymarket.com";

export class PolymarketError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "PolymarketError";
  }
}

async function withBackoff<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const wait = Math.min(2000, 150 * 2 ** i) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function getJson<T>(url: string, timeoutMs = 8000): Promise<T> {
  return withBackoff(async () => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new PolymarketError(`GET ${url} -> ${res.status}`, res.status);
      return (await res.json()) as T;
    } finally {
      clearTimeout(to);
    }
  });
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 8000): Promise<T> {
  return withBackoff(async () => {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new PolymarketError(`POST ${url} -> ${res.status}`, res.status);
      return (await res.json()) as T;
    } finally {
      clearTimeout(to);
    }
  });
}

export const gammaGet = <T>(path: string) => getJson<T>(`${GAMMA}${path}`);
export const clobGet = <T>(path: string) => getJson<T>(`${CLOB}${path}`);
export const clobPost = <T>(path: string, body: unknown) => postJson<T>(`${CLOB}${path}`, body);
export const dataGet = <T>(path: string) => getJson<T>(`${DATA}${path}`);

/** Polymarket encodes several array fields as JSON STRINGS. Parse defensively. */
export function parseJsonArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}
