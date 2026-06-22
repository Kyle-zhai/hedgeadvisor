/**
 * app/api/cron/settle/route.ts — the resolved-market enumerator (the settlement "water source").
 *
 * Sweeps RESOLVED markets, reads each venue's own settle outcome, pairs anchor (team-wins-tournament)
 * with candidate families by event INSTANCE, and writes cluster-weighted observations into the
 * calibration store. Leakage-safe (only settled markets) and dispute-safe (ambiguous ⇒ excluded).
 * FAIL-CLOSED on CRON_SECRET; no-ops without DATABASE_URL. Like the price snapshot, it must run while
 * markets are LIVE/recently-resolved — settled markets age out of the venue APIs (capture-or-lose-it).
 *
 * Jobs are configurable so the same route can backfill prior event instances without mixing clusters.
 */
import { NextResponse } from "next/server";
import { fetchEventBundle } from "@/lib/polymarket";
import { listKalshiEvents, fetchKalshiEvent, fetchKalshiMarkets, type KalshiEventMeta } from "@/lib/kalshi";
import { dbEnabled } from "@/lib/data/db";
import { analyzeRelationWithQwen, loadPendingFrozenPairs, upsertAssociationRelation, upsertAssociationObservations, type RelationHypothesis } from "@/lib/association";
import { eventFamily, mechanismSignature, predicateOf, relationRole, type RelationRole } from "@/lib/relate/relationKey";
import { buildRelationObservations, observationsForResolvedInstances, frozenResolvedInstance, type ResolvedInstance, type SettledOutcome } from "@/lib/relate/settle";
import { pmOutcome, kalshiOutcome, pairResolvedInstances, type MarketOutcome } from "@/lib/relate/enumerate";
import { sameEntityStrict } from "@/lib/link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Leave headroom under maxDuration so the deterministic observation WRITES (which run after any LLM
// backfill) always get to persist — the LLM loop stops issuing new calls once this budget is spent.
const LLM_BUDGET_MS = 40_000;

interface SettleJob {
  cluster: string;
  category: string;
  anchorSlug: string;
  /** Optional anchor labels/entities to backfill; empty means every resolved anchor outcome. */
  anchorEntities: string[];
  candidateSlugs: string[];
  kalshiSeries: string[];
  /** Exact event tickers are the reliable path for old/high-volume series backfills. */
  kalshiEventTickers: string[];
  llmMechanisms: boolean;
  maxLlmPairs: number;
  /** Optional event ticker/title substring used to keep a series result in this exact event cluster. */
  kalshiEventNeedle?: string;
}

function settleJobs(): SettleJob[] {
  const fallbackAnchor = process.env.HEDGE_DEFAULT_EVENT_SLUG ?? "world-cup-winner";
  const fallback: SettleJob = {
    // cluster defaults to the anchor EVENT identity so distinct events are distinct clusters (the
    // walk-forward unit). A hardcoded constant would collapse every event into one cluster ⇒ no training.
    cluster: process.env.HEDGE_SETTLE_CLUSTER ?? fallbackAnchor,
    category: "world-cup",
    anchorSlug: fallbackAnchor,
    anchorEntities: [],
    candidateSlugs: ["world-cup-golden-boot-winner", "world-cup-nation-to-reach-final"],
    kalshiSeries: (process.env.HEDGE_KALSHI_NARRATIVE_SERIES ?? "KXWCFIRSTSONG").split(",").map((s) => s.trim()).filter(Boolean),
    kalshiEventTickers: [],
    // OFF by default: live Qwen mechanism discovery is slow + belongs in the pre-settlement /relations
    // snapshot cron. The routine settle cron stays deterministic so it always finishes and persists.
    // Opt in per-job via HEDGE_SETTLE_JOBS_JSON for a manual backfill (bounded by the deadline below).
    llmMechanisms: false,
    maxLlmPairs: 40,
    kalshiEventNeedle: process.env.HEDGE_KALSHI_EVENT_NEEDLE ?? "2026",
  };
  const raw = process.env.HEDGE_SETTLE_JOBS_JSON;
  if (!raw) return [fallback];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("HEDGE_SETTLE_JOBS_JSON must be a non-empty JSON array");
  return (parsed as Partial<SettleJob>[]).map((j, index) => {
    if (!j.anchorSlug) throw new Error(`settlement job ${index} requires anchorSlug`);
    const anchorSlug = String(j.anchorSlug).trim();
    return {
      // cluster defaults to the anchor event so each independent event instance is its own cluster.
      cluster: (j.cluster ? String(j.cluster).trim() : "") || anchorSlug,
      category: j.category ? String(j.category).trim() : "world-cup",
      anchorSlug,
      anchorEntities: Array.isArray(j.anchorEntities) ? j.anchorEntities.map(String).map((s) => s.trim()).filter(Boolean) : [],
      candidateSlugs: Array.isArray(j.candidateSlugs) ? j.candidateSlugs.map(String).map((s) => s.trim()).filter(Boolean) : [],
      kalshiSeries: Array.isArray(j.kalshiSeries) ? j.kalshiSeries.map(String).map((s) => s.trim()).filter(Boolean) : [],
      kalshiEventTickers: Array.isArray(j.kalshiEventTickers) ? j.kalshiEventTickers.map(String).map((s) => s.trim()).filter(Boolean) : [],
      llmMechanisms: j.llmMechanisms ?? false,
      maxLlmPairs: Math.min(200, Math.max(0, Math.floor(Number(j.maxLlmPairs ?? 40)))),
      kalshiEventNeedle: j.kalshiEventNeedle ? String(j.kalshiEventNeedle).trim() : undefined,
    };
  });
}

async function runJob(job: SettleJob, deadlineMs: number) {
  const settlementObservedAt = new Date().toISOString();
  const anchor = await fetchEventBundle(job.anchorSlug).catch(() => null);
  if (!anchor) return { cluster: job.cluster, settledAnchors: 0, relations: [] as string[], written: 0, error: "anchor event not found" };
  const anchorFamily = eventFamily(anchor.title, job.category);
  const allAnchorOutcomes: MarketOutcome[] = anchor.markets
    .map((m) => ({ entity: m.groupItemTitle ?? m.question, marketId: m.conditionId, settledYes: pmOutcome(m.midpointYes, m.resolved) }))
    .filter((o) => o.settledYes !== null);
  const anchorOutcomes = job.anchorEntities.length
    ? allAnchorOutcomes.filter((outcome) => job.anchorEntities.some((entity) => sameEntityStrict(outcome.entity, entity)))
    : allAnchorOutcomes;

  let written = 0;
  const relations: string[] = [];
  interface AggSlot {
    candFamily: string;
    predicate: string;
    role: RelationRole;
    mechanism?: string;
    hypothesis?: RelationHypothesis;
    llmModel?: string;
    instances: ResolvedInstance[];
  }
  const agg = new Map<string, AggSlot>();
  const anchorRules = new Map(anchor.markets.map((m) => [m.conditionId, m.question]));
  let llmPairs = 0;
  const add = (candFamily: string, predicate: string, role: RelationRole, instances: ResolvedInstance[], mechanism?: string, hypothesis?: RelationHypothesis, llmModel?: string) => {
    if (!instances.length) return;
    const k = `${candFamily}|${predicate}|${role}|${mechanism ?? "rule"}`;
    const slot = agg.get(k) ?? { candFamily, predicate, role, mechanism, hypothesis, llmModel, instances: [] };
    slot.instances.push(...instances);
    agg.set(k, slot);
  };
  const addLlmMechanisms = async (candidate: { entity: string; marketId: string; settledYes: boolean; title: string; rules: string; family: string; predicate: string }) => {
    if (!job.llmMechanisms || llmPairs >= job.maxLlmPairs || Date.now() > deadlineMs) return;
    for (const a of anchorOutcomes) {
      if (llmPairs >= job.maxLlmPairs || Date.now() > deadlineMs) break;
      llmPairs++;
      const result = await analyzeRelationWithQwen(
        { title: `${a.entity} — ${anchor.title}`, rules: anchorRules.get(a.marketId) ?? anchor.title },
        { title: `${candidate.entity} — ${candidate.title}`, rules: candidate.rules || candidate.title },
      );
      const hypothesis = result.hypothesis;
      const graph = hypothesis?.mechanismGraph;
      if (result.status !== "ok" || !hypothesis || !graph || graph.portability === "INSTANCE_ONLY") continue;
      if (hypothesis.relation === "UNRELATED" || hypothesis.relation === "AMBIGUOUS") continue;
      const role = relationRole(a.entity, { entity: candidate.entity, family: candidate.family, context: `${candidate.title} ${candidate.rules}`, mechanismGraph: graph });
      if (["unrelated", "rival"].includes(role)) continue;
      const instances = pairResolvedInstances(job.cluster, anchorOutcomes, {
        entity: candidate.entity,
        marketId: candidate.marketId,
        settledYes: candidate.settledYes,
        relatedEntities: [a.entity],
        resolvedAt: settlementObservedAt,
      }, role);
      add(graph.candidateEventClass, candidate.predicate, role, instances, mechanismSignature(graph, hypothesis.direction), hypothesis, result.model);
    }
  };
  if (anchorOutcomes.length === 0) return { cluster: job.cluster, settledAnchors: 0, relations, written };

  for (const slug of job.candidateSlugs) {
    const cand = await fetchEventBundle(slug).catch(() => null);
    if (!cand) continue;
    const candFamily = eventFamily(cand.title, job.category);
    for (const cm of cand.markets) {
      const settledYes = pmOutcome(cm.midpointYes, cm.resolved);
      if (settledYes === null) continue;
      const label = cm.groupItemTitle ?? cm.question;
      const context = `${cand.title} ${cm.question} ${label}`;
      const entityMatches = anchorOutcomes.filter((a) => relationRole(a.entity, { entity: label, family: candFamily, context }) === "entity_event");
      const hasSameEntity = anchorOutcomes.some((a) => relationRole(a.entity, { entity: label, family: candFamily, context }) === "same_entity");
      const role: RelationRole = entityMatches.length ? "entity_event" : candFamily === "broadcast_word" ? "global_event" : hasSameEntity ? "same_entity" : "unrelated";
      const predicate = predicateOf(cand.title, cm.question, role === "global_event" || role === "entity_event" ? label : undefined);
      if (["same_entity", "entity_event", "global_event"].includes(role)) {
        add(candFamily, predicate, role, pairResolvedInstances(job.cluster, anchorOutcomes, {
          entity: label, marketId: cm.conditionId, settledYes, relatedEntities: entityMatches.map((a) => a.entity), resolvedAt: settlementObservedAt,
        }, role));
      }
      await addLlmMechanisms({ entity: label, marketId: cm.conditionId, settledYes, title: cand.title, rules: cm.question, family: candFamily, predicate });
    }
  }

  const kalshiEvents = new Map<string, KalshiEventMeta>();
  const explicitTickers = new Set(job.kalshiEventTickers);
  for (const series of job.kalshiSeries) {
    const events = await listKalshiEvents(series, 200, "all").catch(() => []);
    for (const ev of events) kalshiEvents.set(ev.eventTicker, ev);
  }
  const directEvents = await Promise.all(job.kalshiEventTickers.map((ticker) => fetchKalshiEvent(ticker)));
  for (const ev of directEvents) if (ev) kalshiEvents.set(ev.eventTicker, ev);

  const needle = job.kalshiEventNeedle?.toLowerCase();
  for (const ev of kalshiEvents.values()) {
    if (!explicitTickers.has(ev.eventTicker) && needle && !`${ev.eventTicker} ${ev.title} ${ev.subTitle}`.toLowerCase().includes(needle)) continue;
    const markets = await fetchKalshiMarkets(ev.eventTicker, true).catch(() => []);
    const candFamily = eventFamily(ev.title || ev.seriesTicker, job.category);
    for (const km of markets) {
      const settledYes = kalshiOutcome(km.result, km.status);
      if (settledYes === null) continue;
      const context = `${ev.title} ${ev.subTitle} ${km.label} ${km.rules}`;
      const entityMatches = anchorOutcomes.filter((a) => relationRole(a.entity, { entity: km.label, family: candFamily, context }) === "entity_event");
      const hasSameEntity = anchorOutcomes.some((a) => relationRole(a.entity, { entity: km.label, family: candFamily, context }) === "same_entity");
      const role: RelationRole = entityMatches.length ? "entity_event" : candFamily === "broadcast_word" ? "global_event" : hasSameEntity ? "same_entity" : "unrelated";
      const predicate = predicateOf(ev.title || ev.seriesTicker, km.rules, role === "global_event" || role === "entity_event" ? km.label : undefined);
      if (["same_entity", "entity_event", "global_event"].includes(role)) {
        add(candFamily, predicate, role, pairResolvedInstances(job.cluster, anchorOutcomes, {
          entity: km.label, marketId: km.ticker, settledYes, relatedEntities: entityMatches.map((a) => a.entity), resolvedAt: settlementObservedAt,
        }, role));
      }
      await addLlmMechanisms({ entity: km.label, marketId: km.ticker, settledYes, title: ev.title || ev.seriesTicker, rules: km.rules, family: candFamily, predicate });
    }
  }

  for (const { candFamily, predicate, role, mechanism, hypothesis, llmModel, instances } of agg.values()) {
    for (const side of ["yes", "no"] as const) {
      const graphAnchorFamily = hypothesis?.mechanismGraph?.anchorEventClass ?? anchorFamily;
      const { relationKey, observations } = buildRelationObservations(graphAnchorFamily, candFamily, predicate, role, side, instances, mechanism);
      if (!observations.length) continue;
      if (dbEnabled()) {
        await upsertAssociationRelation({ relationKey, anchorTemplate: anchorFamily, candidateTemplate: `${candFamily}:${predicate}:${role}${mechanism ? `:${mechanism}` : ""}`, candidateSide: side, hypothesis, llmModel });
        written += await upsertAssociationObservations(relationKey, observations);
      }
      relations.push(relationKey);
    }
  }
  return { cluster: job.cluster, settledAnchors: anchorOutcomes.length, relations: [...new Set(relations)], written, llmPairs };
}

/**
 * SNAPSHOT-DRIVEN settlement (decouples discovery from the settle sweep). Reads every frozen pair that
 * hasn't yet produced an observation, re-fetches BOTH markets by their stored event/venue refs, and —
 * when both have settled — writes an observation under the snapshot's own relation_key. cluster = the
 * anchor EVENT instance, resolved_at = the true venue resolution time. No job config / candidate
 * re-enumeration required: any pair /relations froze becomes a backtest row once both sides settle.
 */
async function resolveFrozenSnapshots(): Promise<{ pending: number; resolved: number; written: number; relations: string[] }> {
  if (!dbEnabled()) return { pending: 0, resolved: 0, written: 0, relations: [] };
  const pending = await loadPendingFrozenPairs(2000).catch(() => []);
  if (!pending.length) return { pending: 0, resolved: 0, written: 0, relations: [] };
  const fallbackMs = Date.now();

  // Re-fetch each referenced event exactly once → (marketId → settle outcome + true resolution time).
  const events = new Map<string, { venue: string; key: string }>();
  for (const p of pending) {
    events.set(`${p.anchorVenue}:${p.anchorEventKey}`, { venue: p.anchorVenue, key: p.anchorEventKey });
    events.set(`${p.candidateVenue}:${p.candidateEventKey}`, { venue: p.candidateVenue, key: p.candidateEventKey });
  }
  const outcomes = new Map<string, Map<string, SettledOutcome>>();
  await Promise.all([...events.values()].map(async ({ venue, key }) => {
    const m = new Map<string, SettledOutcome>();
    if (venue === "polymarket") {
      const bundle = await fetchEventBundle(key).catch(() => null);
      for (const mk of bundle?.markets ?? []) m.set(mk.conditionId, { settledYes: pmOutcome(mk.midpointYes, mk.resolved), resolvedAtMs: mk.resolvedAtMs ?? null });
    } else if (venue === "kalshi") {
      const mks = await fetchKalshiMarkets(key, true).catch(() => []);
      for (const km of mks) m.set(km.ticker, { settledYes: kalshiOutcome(km.result, km.status), resolvedAtMs: km.settledAtMs });
    }
    outcomes.set(`${venue}:${key}`, m);
  }));

  const unsettled: SettledOutcome = { settledYes: null, resolvedAtMs: null };
  const groups = new Map<string, { relationKey: string; side: "yes" | "no"; instances: ResolvedInstance[] }>();
  let resolved = 0;
  for (const p of pending) {
    const a = outcomes.get(`${p.anchorVenue}:${p.anchorEventKey}`)?.get(p.anchorMarketId) ?? unsettled;
    const c = outcomes.get(`${p.candidateVenue}:${p.candidateEventKey}`)?.get(p.candidateMarketId) ?? unsettled;
    const inst = frozenResolvedInstance({ anchorMarketId: p.anchorMarketId, candidateMarketId: p.candidateMarketId, clusterKey: p.anchorEventKey }, a, c, fallbackMs);
    if (!inst) continue; // one side unsettled ⇒ skip (no leakage, no fabrication)
    resolved++;
    const gk = `${p.relationKey}|${p.candidateSide}`;
    const slot = groups.get(gk) ?? { relationKey: p.relationKey, side: p.candidateSide, instances: [] };
    slot.instances.push(inst);
    groups.set(gk, slot);
  }

  let written = 0;
  const relations: string[] = [];
  for (const { relationKey, side, instances } of groups.values()) {
    const observations = observationsForResolvedInstances(side, instances);
    if (!observations.length) continue;
    written += await upsertAssociationObservations(relationKey, observations);
    relations.push(relationKey);
  }
  return { pending: pending.length, resolved, written, relations: [...new Set(relations)] };
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let jobs: SettleJob[];
  try {
    jobs = settleJobs();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "invalid settlement configuration" }, { status: 500 });
  }
  const results = [];
  const deadline = Date.now() + LLM_BUDGET_MS; // shared across jobs so total LLM time is bounded
  for (const job of jobs) results.push(await runJob(job, deadline));
  // Snapshot-driven pass: resolve every frozen pair whose markets have now settled — this is what
  // actually feeds the walk-forward backtest, independent of the job config above.
  const frozen = await resolveFrozenSnapshots().catch((err) => ({ pending: 0, resolved: 0, written: 0, relations: [], error: err instanceof Error ? err.message : "frozen resolve failed" }));
  return NextResponse.json({
    ok: true,
    dbEnabled: dbEnabled(),
    jobs: results,
    frozen,
    written: results.reduce((sum, r) => sum + r.written, 0) + frozen.written,
    note: dbEnabled() ? undefined : "DATABASE_URL unset — counts not persisted",
  });
}
