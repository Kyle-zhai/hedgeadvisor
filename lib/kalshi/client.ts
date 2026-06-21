/**
 * lib/kalshi/client.ts — thin read-only client for Kalshi's public trade API v2.
 *
 * Kalshi's market/event/orderbook GETs are public (no auth) — the same "read-on-demand,
 * never bulk-mirror" posture as the Polymarket client. We keep a conservative client-side
 * backoff because the gateway throttles bursts. Prices come back as decimal-dollar STRINGS
 * ("0.8900"); parse them defensively at this boundary so nothing downstream re-derives units.
 */

export const KALSHI = process.env.KALSHI_HOST ?? "https://api.elections.kalshi.com/trade-api/v2";

export class KalshiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "KalshiError";
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
      if (!res.ok) throw new KalshiError(`GET ${url} -> ${res.status}`, res.status);
      return (await res.json()) as T;
    } finally {
      clearTimeout(to);
    }
  });
}

export const kalshiGet = <T>(path: string) => getJson<T>(`${KALSHI}${path}`);

/** Kalshi returns prices as decimal-dollar strings ("0.8900"). → number in [0,1], or null. */
export function parsePriceDollars(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  // tolerate the legacy integer-cent fields (0..100) as well as decimal dollars (0..1)
  const p = n > 1 ? n / 100 : n;
  return p > 0 && p < 1 ? p : null;
}
