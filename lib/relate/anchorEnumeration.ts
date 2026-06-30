/**
 * lib/relate/anchorEnumeration.ts — Block A (full-market radar): pick a rotated, diversified, deduped, bounded
 * ANCHOR set from market_index rows so the relations cron sweeps the whole open universe over time instead of
 * only the 8 hardcoded config anchors. Pure + deterministic (rotation cursor injected, no Date/random) so it is
 * unit-testable and workflow-resumable. PM-only: discoverRelations can only anchor on a Polymarket market today.
 */

export interface IndexAnchorRow { venue: string; eventKey: string; title: string; marketTitle: string; category: string }
export interface AnchorJob { query: string; eventSlug: string; topK: number }

const TOPIC_STOP = new Set(["will", "the", "does", "can", "are", "was", "who", "what", "when", "and", "for"]);

/** Coarse topic bucket for diversification. PM index rows carry no category, so fall back to the first
 *  meaningful token of the event slug (e.g. "fifwc-arg-cvi-…" → "fifwc", "will-trump-win" → "trump"). This
 *  is what spreads a run across domains instead of 8 variants of one match. */
function topicBucket(category: string, eventKey: string): string {
  const cat = (category || "").trim();
  if (cat) return cat;
  const tok = eventKey.split(/[^a-z0-9]+/i).map((t) => t.toLowerCase()).find((t) => t.length >= 3 && !TOPIC_STOP.has(t) && !/^\d+$/.test(t));
  return tok || "other";
}

/**
 * One anchor per EVENT (dedupe by eventKey), round-robin across category buckets for breadth, each bucket
 * rotated by `offset` (a daily cursor) so consecutive runs cover different slices → full sweep over time.
 * Bounded by `limit`. query = marketTitle||title, eventSlug = eventKey, topK = 4.
 */
export function selectIndexAnchors(rows: IndexAnchorRow[], opts: { limit: number; offset?: number }): AnchorJob[] {
  const lim = Math.max(0, Math.floor(opts.limit));
  if (lim === 0) return [];

  // PM-only + valid, deduped by eventKey (first occurrence wins).
  const seen = new Set<string>();
  const items: Array<{ eventKey: string; query: string; category: string }> = [];
  for (const r of rows) {
    if (r.venue !== "polymarket") continue;
    const eventKey = (r.eventKey || "").trim();
    const query = (r.marketTitle || r.title || "").trim();
    if (!eventKey || !query || seen.has(eventKey)) continue;
    seen.add(eventKey);
    items.push({ eventKey, query, category: topicBucket(r.category, eventKey) });
  }

  // Group by category, preserving first-seen category order for a stable round-robin.
  const order: string[] = [];
  const groups = new Map<string, typeof items>();
  for (const it of items) {
    if (!groups.has(it.category)) { groups.set(it.category, []); order.push(it.category); }
    groups.get(it.category)!.push(it);
  }

  // Rotate each group by the cursor so the leading slice moves run-to-run.
  const off = Math.max(0, Math.floor(opts.offset ?? 0));
  for (const cat of order) {
    const g = groups.get(cat)!;
    const k = g.length ? off % g.length : 0;
    groups.set(cat, [...g.slice(k), ...g.slice(0, k)]);
  }
  // ALSO rotate the bucket VISIT order by the cursor. With the full index there are hundreds of tiny
  // single-event topic buckets, so within-bucket rotation alone is a no-op and the round-robin would always
  // pick the same leading buckets — every hourly run would return the same anchors. Rotating the visit order
  // makes each run sweep a different set of topics (the actual full-market sweep).
  const bo = order.length ? off % order.length : 0;
  const visit = [...order.slice(bo), ...order.slice(0, bo)];

  // Round-robin across categories until `limit` (or every group is exhausted).
  const out: AnchorJob[] = [];
  const idx = new Map(order.map((c) => [c, 0]));
  let progressed = true;
  while (out.length < lim && progressed) {
    progressed = false;
    for (const cat of visit) {
      if (out.length >= lim) break;
      const g = groups.get(cat)!;
      const i = idx.get(cat)!;
      if (i < g.length) {
        out.push({ query: g[i].query, eventSlug: g[i].eventKey, topK: 4 });
        idx.set(cat, i + 1);
        progressed = true;
      }
    }
  }
  return out;
}
