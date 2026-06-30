/**
 * lib/relate/kalshiBackfill.ts — Kalshi historical structural backfill (the second venue).
 *
 * Mirrors lib/relate/autoBackfill.ts (Polymarket) but for Kalshi settled events. Emits the same two
 * structurally-GUARANTEED relations, with CONSERVATIVE-CORRECT routing because Kalshi range events are
 * mutually-exclusive BINS (not subsets):
 *   - RIVAL (cross_entity, NEGATIVE): a mutuallyExclusive event with EXACTLY 2 settled contenders — a genuine
 *     2-way exclusive (candidate wins ⟺ anchor fails). A multi-outcome field (>2) is skipped (a single rival
 *     rarely wins on anchor fail) AND range BINS land here (mutex, >2) and are correctly skipped.
 *   - LADDER (same_entity, POSITIVE subset): a NON-mutex event with ≥3 CUMULATIVE-threshold markets
 *     ("above/≥/at least X"), where higher-X ⊆ lower-X. Bin labels ("X to Y") are excluded so a mutex bin is
 *     never mislabelled a subset.
 *
 * Ingestion reuses runHistoricalBackfillJob (already venue-aware: it fetches the leakage-safe pre-resolution
 * price via fetchKalshiHistory + the real settlement). LLM is NOT involved — these are logical structures.
 * HONESTY: anchor chosen by a stable ticker hash (never by who won), so both branches fill from real outcomes.
 */

import { listKalshiEvents, fetchKalshiMarkets, type KalshiMarket, type KalshiEventMeta } from "@/lib/kalshi";
import { canonicalEventClass } from "./ontology";
import { runHistoricalBackfillJob, type HistoricalBackfillJob, type HistoricalBackfillResult } from "./historicalBackfill";
import { norm } from "@/lib/polymarket/text";

const sig = (mech: string, scope: string, dir: string, edges: string) =>
  `${mech}.${scope}.concurrent.event_class.${dir}.edges=${edges}`;

function threshold(text: string): number | null {
  const m = norm(text).replace(/,/g, "").match(/([\d]+(?:\.\d+)?)\s*([kmb%]?)/);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2];
  if (unit === "k") v *= 1e3; else if (unit === "m") v *= 1e6; else if (unit === "b") v *= 1e9;
  return v;
}

// Cumulative ("above X" ⇒ above-(X+1) ⊆ above-X) vs a range BIN ("X to Y", which is mutex, NOT a subset).
const CUMULATIVE = /\b(above|over|at least|greater than|more than|or more|or higher|or above|or up)\b|≥|>=|\+\s*$/i;
const RANGE_BIN = /\bto\b|\bbetween\b|–|—|\d\s*-\s*\d/;
const settled = (m: KalshiMarket) => m.result === "yes" || m.result === "no";

/** Derive structural backfill jobs from ONE settled Kalshi event. Pure + unit-tested. */
export function deriveKalshiJobs(ev: KalshiEventMeta, markets: KalshiMarket[]): HistoricalBackfillJob[] {
  const jobs: HistoricalBackfillJob[] = [];
  const real = markets.filter((m) => m.ticker && settled(m) && m.label);
  if (real.length < 2) return jobs;
  const fam = canonicalEventClass(ev.title, ev.title);
  const clusterKey = `kalshi:${ev.eventTicker}`;

  if (ev.mutuallyExclusive) {
    // Only a GENUINE 2-way exclusive is a logical hedge. >2 (multi-outcome field OR range bins) is skipped.
    if (real.length !== 2) return jobs;
    const flip = [...ev.eventTicker].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7) % 2 === 0;
    const anchor = flip ? real[0] : real[1];
    const candidate = flip ? real[1] : real[0];
    jobs.push({
      id: `kalshi-rival-${ev.eventTicker}-${anchor.ticker}`.slice(0, 150),
      clusterKey,
      anchor: { venue: "kalshi", eventKey: ev.eventTicker, marketId: anchor.ticker, label: anchor.label },
      candidate: { venue: "kalshi", eventKey: ev.eventTicker, marketId: candidate.ticker, label: candidate.label },
      relation: { anchorFamily: fam, candidateFamily: fam, predicate: "auto_exclusive_rival", role: "cross_entity", side: "yes", mechanismSignature: sig("logical", "cross_entity", "negative", "inhibits"), relationDirection: "NEGATIVE" },
      leadHours: 72,
    });
    return jobs;
  }

  // LADDER: non-mutex CUMULATIVE thresholds only (exclude range bins so a mutex bin is never a "subset").
  const cum = real.filter((m) => CUMULATIVE.test(m.label) && !RANGE_BIN.test(m.label));
  const withT = cum.map((m) => ({ m, t: threshold(m.label) })).filter((x): x is { m: KalshiMarket; t: number } => x.t !== null);
  if (withT.length < 3) return jobs;
  withT.sort((a, b) => a.t - b.t);
  let emitted = 0;
  for (let i = 0; i + 1 < withT.length && emitted < 2; i++) {
    if (withT[i].t === withT[i + 1].t) continue;
    const lower = withT[i].m;  // smaller threshold = SUPERSET (above-2 ⊇ above-3)
    const higher = withT[i + 1].m; // larger threshold ⊆ lower
    jobs.push({
      id: `kalshi-ladder-${ev.eventTicker}-${i}`.slice(0, 150),
      clusterKey,
      anchor: { venue: "kalshi", eventKey: ev.eventTicker, marketId: higher.ticker, label: higher.label },
      candidate: { venue: "kalshi", eventKey: ev.eventTicker, marketId: lower.ticker, label: lower.label },
      relation: { anchorFamily: fam, candidateFamily: fam, predicate: "auto_threshold_subset", role: "same_entity", side: "yes", mechanismSignature: sig("logical", "same_entity", "positive", "implies"), relationDirection: "POSITIVE" },
      leadHours: 72,
    });
    emitted++;
  }
  return jobs;
}

export interface KalshiBackfillResult {
  scannedEvents: number;
  jobs: number;
  written: number;
  skipped: number;
  errors: number;
  byStructure: Record<string, number>;
  results: HistoricalBackfillResult[];
}

async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } }));
  return out;
}

/** Scan settled Kalshi events, derive structural jobs, ingest idempotently (leakage-safe via the shared runner). */
export async function runKalshiBackfill(opts: { limit?: number; maxJobs?: number; series?: string } = {}): Promise<KalshiBackfillResult> {
  const limit = Math.min(4000, Math.max(1, opts.limit ?? 1500));
  const maxJobs = Math.min(8000, Math.max(1, opts.maxJobs ?? 2000));
  const events = await listKalshiEvents(opts.series ?? "", limit, "settled").catch(() => [] as KalshiEventMeta[]);
  const perEvent = await mapPool(events, 8, async (ev) => {
    const markets = await fetchKalshiMarkets(ev.eventTicker, true).catch(() => [] as KalshiMarket[]);
    return deriveKalshiJobs(ev, markets);
  });
  const jobs = perEvent.flat().slice(0, maxJobs);
  const byStructure: Record<string, number> = {};
  for (const j of jobs) {
    const k = `${j.relation.role}|${j.relation.mechanismSignature?.split(".")[0]}|${j.relation.side}`;
    byStructure[k] = (byStructure[k] ?? 0) + 1;
  }
  const results = await mapPool(jobs, 6, (job) => runHistoricalBackfillJob(job));
  return {
    scannedEvents: events.length,
    jobs: jobs.length,
    written: results.filter((r) => r.status === "written").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    errors: results.filter((r) => r.status === "error").length,
    byStructure,
    results,
  };
}
