import { NextResponse } from "next/server";
import { dbEnabled } from "@/lib/data/db";
import { loadComboBacktestRecords } from "@/lib/relate/comboSnapshot";
import { backtestCombos } from "@/lib/relate/comboBacktest";
import { jointCalibratedGate, type ComboFamilyEvidence } from "@/lib/relate/jointCalibration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Secret-gated, read-only walk-forward backtest of FROZEN combos against settlement (Block C). Reports the
 * combo scorer's metrics + the JOINT-CALIBRATED gate verdict. The gate stays not-eligible until cluster-deduped
 * settled fail-episodes accrue — this route never promotes a tier, it MEASURES.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!dbEnabled()) return NextResponse.json({ error: "DATABASE_URL is not configured" }, { status: 503 });

  const records = await loadComboBacktestRecords();
  const report = backtestCombos(records);
  const fails = report.anchorFailCombos;
  // Faithful-conservative family evidence: bestSingleLegLower is tied to realized coverage until per-leg single
  // coverage is measured, so the "beats best single leg" check cannot pass on unproven evidence. ECE defaults to
  // 1 and cluster-share to 1/fails when undefined — every gap keeps the gate not-eligible (the honest default).
  const evidence: ComboFamilyEvidence = {
    effectiveClusters: fails,
    realizedCoverageLower: report.realizedCoverageWhenFail ?? 0,
    bestSingleLegLower: report.realizedCoverageWhenFail ?? 0,
    secondLegMarginalContribution: report.marginalContributionByRank[1] ?? 0,
    premiumDragFraction: 0,
    walkForwardEce: report.coverageCalibrationGap !== null ? Math.abs(report.coverageCalibrationGap) : 1,
    maxSingleClusterShare: fails > 0 ? 1 / fails : 1,
  };
  const gate = jointCalibratedGate(evidence);
  return NextResponse.json({ records: records.length, report, evidence, jointCalibrated: gate });
}
