/**
 * §19 Gate 0 — the Phase-1.5 HIT-RATE PROBE (the demand-signal measurement that gates the DEFER list).
 *
 * For N deliberately-diverse anchors (no sports bias), run the real discovery pipeline and count, per
 * anchor: how many hedge legs exist at all, how many are genuinely CROSS-EVENT (the cross-dimensional
 * differentiator), how many are ANALYTIC (settlement-free structural), and the §13 operator rows hit.
 * The headline number is the MEDIAN cross-event tradeable-leg count: if it is 0–1, the honest value
 * proposition is "explain the causal landscape + surface the occasional cross-market leg", and the
 * deferred generative-WALK work stays deferred (§18/§19).
 *
 * SKIPPED by default (hits live Polymarket/Kalshi + optionally the LLM chain). To run:
 *   HEDGE_PHASE15=1 npx vitest run test/phase15-hitrate.live.test.ts --reporter=basic
 */
import { describe, expect, test } from "vitest";
import { discoverRelations } from "@/lib/relate/discover";

const RUN = process.env.HEDGE_PHASE15 === "1";
const LONG = 10 * 60_000;

// Diverse, non-sports-biased anchor set (§15's six domains + a few more). Queries are free text — the
// resolver pins each to a live outcome; anchors that fail to resolve are reported, not silently dropped.
const ANCHORS = [
  "Fed decision",
  "US recession in 2026",
  "Bitcoin above $150k",
  "Democratic presidential nominee",
  "Israel Hamas ceasefire",
  "2026 hottest year on record",
  "Nvidia",
  "China invades Taiwan",
  "France to win the World Cup",
  "AI company IPO",
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

describe.skipIf(!RUN)("Phase-1.5 hit-rate probe (LIVE)", () => {
  test("median cross-event tradeable hedge legs per anchor", async () => {
    const rows: Array<{ anchor: string; status: string; total: number; crossEvent: number; analytic: number; uncoveredOps: number }> = [];
    for (const q of ANCHORS) {
      try {
        const r = await discoverRelations({ query: q, stakeUsd: 20, withStrategies: true } as Parameters<typeof discoverRelations>[0]);
        if (r.status !== "ok") {
          rows.push({ anchor: q, status: r.status, total: 0, crossEvent: 0, analytic: 0, uncoveredOps: -1 });
          continue;
        }
        const strategies = r.strategies ?? [];
        const consLegs = r.directional?.conservative?.legs ?? [];
        rows.push({
          anchor: q,
          status: "ok",
          total: strategies.length + consLegs.length,
          crossEvent: strategies.filter((s) => s.scope === "cross-event").length,
          analytic: consLegs.filter((l) => l.tier === "ANALYTIC").length,
          uncoveredOps: r.operatorCoverage?.uncovered.length ?? -1,
        });
      } catch (e) {
        rows.push({ anchor: q, status: `error:${(e as Error).message.slice(0, 60)}`, total: 0, crossEvent: 0, analytic: 0, uncoveredOps: -1 });
      }
    }
    const ok = rows.filter((r) => r.status === "ok");
    const summary = {
      anchors: rows.length,
      resolved: ok.length,
      medianCrossEventLegs: median(ok.map((r) => r.crossEvent)),
      medianAnalyticLegs: median(ok.map((r) => r.analytic)),
      medianTotalLegs: median(ok.map((r) => r.total)),
      perAnchor: rows,
    };
    console.log(`\n=== PHASE-1.5 HIT-RATE ===\n${JSON.stringify(summary, null, 2)}`);
    // The probe MEASURES; it must not fail on a low hit-rate — a 0–1 median is itself the finding.
    expect(rows).toHaveLength(ANCHORS.length);
    expect(ok.length).toBeGreaterThan(0); // at least something resolved, else the probe itself is broken
  }, LONG);
});
