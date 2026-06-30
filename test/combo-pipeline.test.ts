import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { getSql } from "@/lib/data/db";
import { persistComboSnapshots, loadComboBacktestRecords, toBacktestRecord, type ComboSnapshotRow, type ComboLegRow } from "@/lib/relate/comboSnapshot";
import { backtestCombos } from "@/lib/relate/comboBacktest";
import { jointCalibratedGate } from "@/lib/relate/jointCalibration";

try { for (const l of readFileSync(".env.local", "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m && m[2].trim() && !process.env[m[1]]) process.env[m[1]] = m[2].trim(); } } catch {}

const PFX = "TESTCOMBO-" + Math.floor(Date.now() % 1e7);
const ANCHOR = `${PFX}-anchor`;

describe.skipIf(!process.env.DATABASE_URL)("combo pipeline (Block C)", () => {
  afterAll(async () => {
    const sql = await getSql(); if (!sql) return;
    const ids = await sql`SELECT combo_id FROM combo_snapshot WHERE anchor_market_id = ${ANCHOR}` as Array<{ combo_id: string }>;
    for (const { combo_id } of ids) await sql`DELETE FROM combo_leg_snapshot WHERE combo_id = ${combo_id}`;
    await sql`DELETE FROM combo_snapshot WHERE anchor_market_id = ${ANCHOR}`;
  });

  it("freezes a combo, settles it, assembles a record, scores it, and the gate stays not-eligible", async () => {
    const sql = await getSql(); if (!sql) return;

    // 1. FREEZE (open-market write, no settlement)
    const written = await persistComboSnapshots(
      { marketId: ANCHOR, venue: "polymarket", eventKey: `${PFX}-ev` },
      [{
        coverage: 0.7, totalCostUsd: 7, tier: "MODELED",
        legs: [
          { marketId: `${PFX}-l0`, venue: "polymarket", eventKey: `${PFX}-ev`, side: "YES", legPrice: 0.4, costUsd: 4, scenario: "rival_wins" },
          { marketId: `${PFX}-l1`, venue: "polymarket", eventKey: `${PFX}-ev`, side: "NO", legPrice: 0.5, costUsd: 3, scenario: "performance_collapse" },
        ],
      }],
      new Date("2026-02-01T00:00:00Z"),
    );
    expect(written).toBe(1);
    const [{ combo_id: comboId }] = await sql`SELECT combo_id FROM combo_snapshot WHERE anchor_market_id = ${ANCHOR}` as Array<{ combo_id: string }>;
    const legRows = await sql`SELECT count(*)::int AS n FROM combo_leg_snapshot WHERE combo_id = ${comboId}` as Array<{ n: number }>;
    expect(legRows[0].n).toBe(2);

    // 2. SETTLE (simulate the venue outcomes the settle cron would write): anchor FAILED, leg0 paid, leg1 did not
    await sql`UPDATE combo_leg_snapshot SET paid = true  WHERE combo_id = ${comboId} AND rank = 0`;
    await sql`UPDATE combo_leg_snapshot SET paid = false WHERE combo_id = ${comboId} AND rank = 1`;
    await sql`UPDATE combo_snapshot SET anchor_resolved_at = '2026-03-01T00:00:00Z', anchor_pays = false, combo_payoff_usd = 10, settled_at = now() WHERE combo_id = ${comboId}`;

    // 3. ASSEMBLE — toBacktestRecord over the real settled rows
    const [snap] = await sql`
      SELECT combo_id AS "comboId", observed_at::text AS "observedAt", anchor_resolved_at::text AS "anchorResolvedAt",
        anchor_pays AS "anchorPays", predicted_coverage_lower AS "predictedCoverageLower", premium_usd AS "premiumUsd",
        combo_payoff_usd AS "comboPayoffUsd", cluster_key AS "clusterKey" FROM combo_snapshot WHERE combo_id = ${comboId}` as ComboSnapshotRow[];
    const legs = await sql`SELECT rank, scenario_bucket AS "scenarioBucket", paid FROM combo_leg_snapshot WHERE combo_id = ${comboId} ORDER BY rank` as ComboLegRow[];
    const record = toBacktestRecord(snap, legs);
    expect(record).not.toBeNull();
    expect(record!.anchorPays).toBe(false);
    expect(record!.comboPayoffUsd).toBe(10);

    // loadComboBacktestRecords includes our settled cluster
    const all = await loadComboBacktestRecords();
    expect(all.some((r) => r.premiumSpent === 7 && r.observedAt.startsWith("2026-02-01"))).toBe(true);

    // 4. SCORE — backtestCombos over our record
    const report = backtestCombos([record!]);
    expect(report.combos).toBe(1);
    expect(report.anchorFailCombos).toBe(1);
    expect(report.realizedCoverageWhenFail).toBe(1); // leg0 paid ⇒ ≥1 leg covered the fail

    // 5. GATE — one cluster cannot earn JOINT-CALIBRATED
    const gate = jointCalibratedGate({
      effectiveClusters: report.anchorFailCombos, realizedCoverageLower: 1, bestSingleLegLower: 1,
      secondLegMarginalContribution: 0, premiumDragFraction: 0, walkForwardEce: 1, maxSingleClusterShare: 1,
    });
    expect(gate.eligible).toBe(false);
    expect(gate.reasons.join(" ")).toContain("clusters");
  });
});
