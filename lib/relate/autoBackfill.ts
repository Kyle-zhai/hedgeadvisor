/**
 * lib/relate/autoBackfill.ts — SELF-SUSTAINING historical discovery: grow the settlement moat with ZERO
 * manual manifest. It scans recently-SETTLED multi-outcome Polymarket events and emits the two structural
 * relations whose label is GUARANTEED by venue metadata (no LLM, no hand-curation):
 *
 *   1. cross_entity | logical  — a mutually-exclusive (negRisk) single-winner event (every election,
 *      championship, award, "who wins X"): the winner and each top rival are exclusive, so a rival's YES
 *      pays exactly when the anchor outcome fails. Anchors alternate winner/loser so both branches fill.
 *   2. same_entity | logical   — a numeric-threshold ladder on ONE quantity ("BTC > $100k / > $110k",
 *      "CPI > 0.3% / > 0.5%"): the higher threshold is a SUBSET of the lower, an exact logical nesting.
 *
 * Each generated job is ingested through the SAME anti-leakage path as the hand-curated backfill
 * (runHistoricalBackfillJob: real pre-resolution price, lead window, idempotent by relation_key+sample_key),
 * so re-runs are safe and the moat grows across EVERY domain automatically as markets settle.
 */
import { gammaGet } from "@/lib/polymarket/client";
import { canonicalEventClass } from "./ontology";
import { runHistoricalBackfillJob, type HistoricalBackfillJob, type HistoricalBackfillResult } from "./historicalBackfill";
import { norm } from "@/lib/polymarket/text";

interface PmMarket { conditionId?: string; groupItemTitle?: string; question?: string; outcomePrices?: string | string[]; volumeNum?: number }
interface PmEvent { slug?: string; title?: string; negRisk?: boolean; closed?: boolean; markets?: PmMarket[] }

const sig = (mech: string, scope: string, dir: string, edges: string) =>
  `${mech}.${scope}.concurrent.event_class.${dir}.edges=${edges}`;

function yesWon(m: PmMarket): boolean | null {
  let p: unknown = m.outcomePrices;
  if (typeof p === "string") { try { p = JSON.parse(p); } catch { return null; } }
  if (!Array.isArray(p) || p.length < 1) return null;
  const yes = Number(p[0]);
  if (!Number.isFinite(yes)) return null;
  return yes >= 0.99 ? true : yes <= 0.01 ? false : null; // only SETTLED (0/1) markets
}
const label = (m: PmMarket) => (m.groupItemTitle || m.question || "").trim();

/** Pull a first numeric magnitude from a threshold-style label ("$110k", "above 0.5%", "150,000"). */
function threshold(text: string): number | null {
  const m = norm(text).replace(/,/g, "").match(/([\d]+(?:\.\d+)?)\s*([kmb%]?)/);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2];
  if (unit === "k") v *= 1e3; else if (unit === "m") v *= 1e6; else if (unit === "b") v *= 1e9;
  return v;
}

/** Deterministically derive structural backfill jobs from settled Polymarket events. */
export function deriveAutoJobs(events: PmEvent[], startCounter = 0): HistoricalBackfillJob[] {
  const jobs: HistoricalBackfillJob[] = [];
  let counter = startCounter;
  for (const ev of events) {
    if (!ev.slug || !ev.closed) continue;
    const markets = (ev.markets ?? []).filter((m) => m.conditionId && yesWon(m) !== null && label(m));
    if (markets.length < 2) continue;
    const fam = canonicalEventClass(ev.title, ev.title);

    if (ev.negRisk) {
      // single-winner mutually-exclusive event ⇒ cross_entity|logical rivals
      const winner = markets.find((m) => yesWon(m) === true);
      if (!winner) continue;
      const rivals = markets
        .filter((m) => m !== winner)
        .sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))
        .slice(0, 2);
      for (const rival of rivals) {
        // alternate anchor winner/loser so the win-branch and fail-branch both accumulate
        const anchorWinner = counter++ % 2 === 0;
        const anchor = anchorWinner ? winner : rival;
        const candidate = anchorWinner ? rival : winner;
        jobs.push({
          id: `auto-rival-${ev.slug}-${anchor.conditionId!.slice(2, 8)}`.slice(0, 150),
          clusterKey: `auto:${ev.slug}`,
          anchor: { venue: "polymarket", eventKey: ev.slug, marketId: anchor.conditionId! },
          candidate: { venue: "polymarket", eventKey: ev.slug, marketId: candidate.conditionId! },
          relation: { anchorFamily: fam, candidateFamily: fam, predicate: "auto_exclusive_rival", role: "cross_entity", side: "yes", mechanismSignature: sig("logical", "cross_entity", "negative", "inhibits"), relationDirection: "NEGATIVE" },
          leadHours: 72,
        });
      }
    } else {
      // possible numeric-threshold LADDER on one quantity ⇒ same_entity|logical subset (higher ⊆ lower)
      const withT = markets.map((m) => ({ m, t: threshold(label(m)) })).filter((x): x is { m: PmMarket; t: number } => x.t !== null);
      if (withT.length < 3) continue; // need a real ladder, not an incidental number
      withT.sort((a, b) => a.t - b.t);
      for (let i = 0; i + 1 < withT.length; i++) {
        const lower = withT[i].m; // smaller threshold = SUPERSET
        const higher = withT[i + 1].m; // larger threshold ⊆ lower
        if (withT[i].t === withT[i + 1].t) continue;
        jobs.push({
          id: `auto-ladder-${ev.slug}-${i}`.slice(0, 150),
          clusterKey: `auto:${ev.slug}:t${i}`,
          anchor: { venue: "polymarket", eventKey: ev.slug, marketId: higher.conditionId! },
          candidate: { venue: "polymarket", eventKey: ev.slug, marketId: lower.conditionId! },
          relation: { anchorFamily: fam, candidateFamily: fam, predicate: "auto_threshold_subset", role: "same_entity", side: "yes", mechanismSignature: sig("logical", "same_entity", "positive", "implies"), relationDirection: "POSITIVE" },
          leadHours: 72,
        });
      }
    }
  }
  return jobs;
}

export interface AutoBackfillResult {
  scannedEvents: number;
  jobs: number;
  written: number;
  skipped: number;
  errors: number;
  byStructure: Record<string, number>;
  results: HistoricalBackfillResult[];
}

/** Scan settled Polymarket events across pages, derive structural jobs, and ingest them idempotently. */
export async function runAutoBackfill(opts: { pages?: number; pageSize?: number; maxJobs?: number } = {}): Promise<AutoBackfillResult> {
  const pages = Math.min(20, Math.max(1, opts.pages ?? 8));
  const pageSize = Math.min(100, Math.max(10, opts.pageSize ?? 50));
  const maxJobs = Math.min(280, Math.max(1, opts.maxJobs ?? 200));
  const all: PmEvent[] = [];
  for (let p = 0; p < pages; p++) {
    const negRisk = p % 2 === 0; // alternate negRisk (rivals) and non-negRisk (threshold ladders) pages
    const events = await gammaGet<PmEvent[]>(
      `/events?closed=true&negRisk=${negRisk}&limit=${pageSize}&offset=${p * pageSize}&order=volume&ascending=false`,
    ).catch(() => [] as PmEvent[]);
    if (!events.length) continue;
    all.push(...events);
  }
  // dedupe events by slug
  const bySlug = new Map<string, PmEvent>();
  for (const e of all) if (e.slug && !bySlug.has(e.slug)) bySlug.set(e.slug, e);
  const events = [...bySlug.values()];

  const jobs = deriveAutoJobs(events).slice(0, maxJobs);
  const byStructure: Record<string, number> = {};
  for (const j of jobs) {
    const k = `${j.relation.role}|${j.relation.mechanismSignature?.split(".")[0]}|${j.relation.side}`;
    byStructure[k] = (byStructure[k] ?? 0) + 1;
  }
  const results: HistoricalBackfillResult[] = [];
  for (const job of jobs) results.push(await runHistoricalBackfillJob(job));
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
