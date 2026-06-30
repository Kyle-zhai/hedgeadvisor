/**
 * lib/relate/comboSnapshot.ts — Block C joint-combo data pipeline.
 *
 * Freezes the multi-leg combos discover recommends (open markets, pre-resolution), settles them against real
 * venue outcomes, and assembles BacktestComboRecord[] for the (already unit-tested) backtestCombos scorer +
 * jointCalibratedGate. NOTHING here promotes a tier — it LOGS and MEASURES. The gate stays not-eligible until
 * cluster-deduped settled fail-episodes accrue (honesty rule: no JOINT-CALIBRATED before joint evidence).
 */

import { getSql, ensureSchema, dbEnabled } from "@/lib/data/db";
import { fetchEventBundle } from "@/lib/polymarket";
import { fetchKalshiMarkets } from "@/lib/kalshi";
import { pmOutcome, kalshiOutcome } from "./enumerate";
import type { BacktestComboRecord } from "./comboBacktest";

export type LegSide = "YES" | "NO";

// ---------- pure core (unit-tested) ----------

/** A leg pays iff the side it bought matches the settled outcome. */
export function legPaid(side: LegSide, settledYes: boolean): boolean {
  return side === "YES" ? settledYes : !settledYes;
}

/** Realized $ a combo paid: each paid leg returns costUsd/legPrice (shares bought × $1), unpaid legs return $0. */
export function comboPayoffUsd(legs: Array<{ paid: boolean; costUsd: number; legPrice: number }>): number {
  return legs.reduce((sum, l) => sum + (l.paid && l.legPrice > 0 ? l.costUsd / l.legPrice : 0), 0);
}

export interface ComboSnapshotRow {
  comboId: string; observedAt: string; anchorResolvedAt: string | null; anchorPays: boolean | null;
  predictedCoverageLower: number; premiumUsd: number; comboPayoffUsd: number | null; clusterKey: string;
}
export interface ComboLegRow { rank: number; scenarioBucket: string; paid: boolean | null }

/** Assemble a backtest record — only for a FULLY settled combo (anchor + every leg). Unsettled ⇒ null. */
export function toBacktestRecord(snap: ComboSnapshotRow, legs: ComboLegRow[]): BacktestComboRecord | null {
  if (snap.anchorPays === null || snap.anchorResolvedAt === null || snap.comboPayoffUsd === null) return null;
  if (legs.some((l) => l.paid === null)) return null;
  return {
    observedAt: snap.observedAt,
    anchorResolvedAt: snap.anchorResolvedAt,
    anchorPays: snap.anchorPays,
    predictedCoverageLower: snap.predictedCoverageLower,
    premiumSpent: snap.premiumUsd,
    comboPayoffUsd: snap.comboPayoffUsd,
    legs: legs.map((l) => ({ rank: l.rank, scenario: l.scenarioBucket as BacktestComboRecord["legs"][number]["scenario"], paid: l.paid as boolean })),
  };
}

// ---------- freeze ----------

export interface AnchorFreeze { marketId: string; venue: "polymarket" | "kalshi"; eventKey: string }
export interface ComboLegFreeze { marketId: string; venue: "polymarket" | "kalshi"; eventKey: string; side: LegSide; legPrice: number; costUsd: number; scenario: string }
export interface ComboFreeze { legs: ComboLegFreeze[]; coverage: number; totalCostUsd: number; tier: string }

const dayOf = (iso: string) => iso.slice(0, 10);

/** Deterministic combo id ⇒ re-freezing the same combo on the same day is idempotent (never overwrites). */
function comboId(anchor: AnchorFreeze, observedAt: string, legs: ComboLegFreeze[]): string {
  const sig = legs.map((l) => `${l.venue}:${l.marketId}:${l.side}`).sort().join(",");
  return `${anchor.venue}:${anchor.marketId}:${dayOf(observedAt)}:${sig}`;
}

/** Freeze recommended combos + their legs. Open markets only — writes no settlement. Fail-safe (no DB ⇒ 0). */
export async function persistComboSnapshots(anchor: AnchorFreeze, combos: ComboFreeze[], at = new Date()): Promise<number> {
  if (!dbEnabled()) return 0;
  const sql = await getSql();
  if (!sql) return 0;
  await ensureSchema(sql);
  const observedAt = new Date(Math.floor(at.getTime() / 60_000) * 60_000).toISOString();
  const clusterKey = `${anchor.venue}:${anchor.marketId}`;
  let written = 0;
  for (const combo of combos) {
    if (!combo.legs.length) continue;
    const id = comboId(anchor, observedAt, combo.legs);
    const res = await sql`
      INSERT INTO combo_snapshot (combo_id, anchor_market_id, anchor_venue, anchor_event_key, observed_at,
        predicted_coverage_lower, premium_usd, tier, cluster_key)
      VALUES (${id}, ${anchor.marketId}, ${anchor.venue}, ${anchor.eventKey}, ${observedAt},
        ${combo.coverage}, ${combo.totalCostUsd}, ${combo.tier}, ${clusterKey})
      ON CONFLICT (combo_id) DO NOTHING RETURNING combo_id`;
    if (!res.length) continue; // already frozen
    written++;
    for (let rank = 0; rank < combo.legs.length; rank++) {
      const l = combo.legs[rank];
      await sql`
        INSERT INTO combo_leg_snapshot (combo_id, rank, market_id, venue, event_key, side, leg_price, cost_usd, scenario_bucket)
        VALUES (${id}, ${rank}, ${l.marketId}, ${l.venue}, ${l.eventKey}, ${l.side}, ${l.legPrice}, ${l.costUsd}, ${l.scenario})
        ON CONFLICT (combo_id, rank) DO NOTHING`;
    }
  }
  return written;
}

// ---------- settle ----------

/** Re-fetch one market's settled outcome (null = unresolved/disputed/aged-out). Cached per event within a run. */
async function resolveOutcome(
  venue: string, eventKey: string, marketId: string,
  pmCache: Map<string, Array<{ conditionId: string; midpointYes: number; resolved: boolean }>>,
  kalshiCache: Map<string, Array<{ ticker: string; result?: string; status: string }>>,
): Promise<boolean | null> {
  if (venue === "polymarket") {
    let markets = pmCache.get(eventKey);
    if (!markets) {
      const b = await fetchEventBundle(eventKey).catch(() => null);
      markets = (b?.markets ?? []).map((m) => ({ conditionId: m.conditionId, midpointYes: m.midpointYes, resolved: m.resolved }));
      pmCache.set(eventKey, markets);
    }
    const m = markets.find((x) => x.conditionId === marketId);
    return m ? pmOutcome(m.midpointYes, m.resolved) : null;
  }
  let markets = kalshiCache.get(eventKey);
  if (!markets) {
    const ms = await fetchKalshiMarkets(eventKey, true).catch(() => []);
    markets = ms.map((m) => ({ ticker: m.ticker, result: m.result, status: m.status }));
    kalshiCache.set(eventKey, markets);
  }
  const km = markets.find((x) => x.ticker === marketId);
  return km ? kalshiOutcome(km.result, km.status) : null;
}

export interface ComboSettleResult { settled: number; pending: number }

/** For each pending combo, resolve anchor + every leg; when ALL settle, write the realized outcome + payoff. */
export async function settleComboSnapshots(limit = 200): Promise<ComboSettleResult> {
  if (!dbEnabled()) return { settled: 0, pending: 0 };
  const sql = await getSql();
  if (!sql) return { settled: 0, pending: 0 };
  await ensureSchema(sql);
  const combos = await sql`
    SELECT combo_id AS "comboId", anchor_market_id AS "anchorMarketId", anchor_venue AS "anchorVenue", anchor_event_key AS "anchorEventKey"
    FROM combo_snapshot WHERE anchor_resolved_at IS NULL ORDER BY observed_at ASC LIMIT ${Math.min(2000, Math.max(1, Math.floor(limit)))}` as Array<{ comboId: string; anchorMarketId: string; anchorVenue: string; anchorEventKey: string }>;
  if (!combos.length) return { settled: 0, pending: 0 };

  const pmCache = new Map<string, Array<{ conditionId: string; midpointYes: number; resolved: boolean }>>();
  const kalshiCache = new Map<string, Array<{ ticker: string; result?: string; status: string }>>();
  let settled = 0, pending = 0;

  for (const combo of combos) {
    const anchorYes = await resolveOutcome(combo.anchorVenue, combo.anchorEventKey, combo.anchorMarketId, pmCache, kalshiCache);
    if (anchorYes === null) { pending++; continue; } // anchor not resolved yet
    const legs = await sql`
      SELECT rank, market_id AS "marketId", venue, event_key AS "eventKey", side, leg_price AS "legPrice", cost_usd AS "costUsd"
      FROM combo_leg_snapshot WHERE combo_id = ${combo.comboId} ORDER BY rank` as Array<{ rank: number; marketId: string; venue: string; eventKey: string; side: LegSide; legPrice: number; costUsd: number }>;
    const settledLegs: Array<{ rank: number; paid: boolean; costUsd: number; legPrice: number }> = [];
    let allResolved = true;
    for (const leg of legs) {
      const legYes = await resolveOutcome(leg.venue, leg.eventKey, leg.marketId, pmCache, kalshiCache);
      if (legYes === null) { allResolved = false; break; }
      settledLegs.push({ rank: leg.rank, paid: legPaid(leg.side, legYes), costUsd: leg.costUsd, legPrice: leg.legPrice });
    }
    if (!allResolved) { pending++; continue; } // a leg hasn't resolved (or aged out) — retry next run
    const payoff = comboPayoffUsd(settledLegs);
    const nowIso = new Date().toISOString();
    for (const sl of settledLegs) {
      await sql`UPDATE combo_leg_snapshot SET paid = ${sl.paid} WHERE combo_id = ${combo.comboId} AND rank = ${sl.rank}`;
    }
    await sql`UPDATE combo_snapshot SET anchor_resolved_at = ${nowIso}, anchor_pays = ${anchorYes}, combo_payoff_usd = ${payoff}, settled_at = ${nowIso} WHERE combo_id = ${combo.comboId}`;
    settled++;
  }
  return { settled, pending };
}

// ---------- assemble ----------

/** Settled combos → BacktestComboRecord[], cluster-deduped (earliest observed_at per cluster). Fail-safe []. */
export async function loadComboBacktestRecords(limit = 5000): Promise<BacktestComboRecord[]> {
  if (!dbEnabled()) return [];
  const sql = await getSql();
  if (!sql) return [];
  await ensureSchema(sql);
  const snaps = await sql`
    SELECT DISTINCT ON (cluster_key)
      combo_id AS "comboId", observed_at::text AS "observedAt", anchor_resolved_at::text AS "anchorResolvedAt",
      anchor_pays AS "anchorPays", predicted_coverage_lower AS "predictedCoverageLower",
      premium_usd AS "premiumUsd", combo_payoff_usd AS "comboPayoffUsd", cluster_key AS "clusterKey"
    FROM combo_snapshot WHERE anchor_resolved_at IS NOT NULL
    ORDER BY cluster_key, observed_at ASC
    LIMIT ${Math.min(50000, Math.max(1, Math.floor(limit)))}` as ComboSnapshotRow[];
  const out: BacktestComboRecord[] = [];
  for (const snap of snaps) {
    const legs = await sql`
      SELECT rank, scenario_bucket AS "scenarioBucket", paid FROM combo_leg_snapshot WHERE combo_id = ${snap.comboId} ORDER BY rank` as ComboLegRow[];
    const rec = toBacktestRecord(snap, legs);
    if (rec) out.push(rec);
  }
  return out;
}
