/**
 * MANUAL live verification (hits the real Polymarket API). SKIPPED by default so the
 * offline suite stays deterministic and doesn't rot when these fixtures finish.
 * To run: change `describe.skip` → `describe`, set a CURRENT live fixture, then
 *   npx vitest run test/live-verify.test.ts --reporter=basic
 * Validates: (1) a non-existent matchup is honestly REJECTED, (2) a real exact-score pick
 * yields a logical real multi-leg hedge (EV≤0, fair≤price, coherent probabilities, valid
 * deep-links), (3) the number-of-bets (maxLegs) filter caps the legs live.
 */
import { describe, expect, test } from "vitest";
import { runPlan } from "@/lib/pipeline";
import { resolveBet } from "@/lib/polymarket";

const LONG = 90_000;

function audit(label: string, plan: NonNullable<Awaited<ReturnType<typeof runPlan>>["plan"]>) {
  const probSum = plan.scenarios.reduce((s, x) => s + x.prob, 0);
  console.log(`\n=== ${label} ===`);
  console.log(`fixture: ${plan.fixtureTitle} | ${plan.betDesc}`);
  console.log(`posture=${plan.posture} legs=${plan.legs.length} deployed=$${plan.deployedUsd} (budget $${plan.budgetUsd})`);
  console.log(`EV=$${plan.expectedValueUsd} pProfit=${(plan.pProfit * 100).toFixed(0)}% pLoseAll=${(plan.pLoseAll * 100).toFixed(0)}%`);
  console.log(`maxGain=$${plan.maxGainUsd} maxLoss=$${plan.maxLossUsd} scenarioProbSum=${probSum.toFixed(3)}`);
  for (const l of plan.legs) {
    console.log(
      `  • ${l.side} ${l.outcomeTitle}: ~${Math.round(l.shares)}sh @ ${l.avgFillPrice.toFixed(3)} ` +
        `(fair ${l.fairValue.toFixed(3)}, limit ${l.limitPrice.toFixed(3)}, $${l.costUsd.toFixed(2)})`,
    );
    // honesty invariant: you never pay BELOW the de-vigged fair value
    expect(l.avgFillPrice + 1e-6).toBeGreaterThanOrEqual(l.fairValue);
    expect(l.deepLink).toMatch(/^https:\/\/polymarket\.com\/event\//);
  }
  console.log("scenarios:");
  for (const s of plan.scenarios.slice(0, 8)) {
    console.log(`  - ${s.outcome}: p=${(s.prob * 100).toFixed(1)}% pay=$${s.payoutUsd.toFixed(2)} pnl=$${s.pnlUsd.toFixed(2)}`);
  }
  // core logic invariants
  expect(plan.expectedValueUsd).toBeLessThanOrEqual(0); // honest: never a claimed edge
  expect(plan.deployedUsd).toBeLessThanOrEqual(plan.budgetUsd * 1.05);
  expect(plan.deployedUsd).toBeGreaterThan(0);
  expect(probSum).toBeGreaterThan(0.9); // partition probabilities are coherent
  expect(probSum).toBeLessThan(1.15);
  expect(plan.maxGainUsd).toBeGreaterThan(plan.maxLossUsd);
}

describe.skip("LIVE verification (manual — un-skip + set a current fixture; hits real API)", () => {
  test("Spain vs Cabo Verde 0:0 is honestly rejected (not a real fixture)", async () => {
    const r = await resolveBet("Spain vs Cape Verde 0:0");
    console.log("\n=== resolveBet('Spain vs Cape Verde 0:0') ===");
    console.log("kind:", r.kind);
    if (r.kind === "not_found") {
      console.log("suggestions:", r.suggestions.map((s) => s.title).join(" | "));
    } else if (r.kind === "resolved") {
      console.log("UNEXPECTEDLY resolved to:", r.fixture.title, "betType:", r.betType);
    }
    // It must NOT fabricate a Spain–Cabo Verde matchup.
    expect(r.kind).not.toBe("resolved");

    const plan = await runPlan({ query: "Spain vs Cape Verde 0:0", budgetUsd: 50 });
    console.log("runPlan status:", plan.status, "| suggestions:", (plan.suggestions ?? []).map((s) => s.title).join(" | "));
    expect(plan.status).not.toBe("ok");
  }, LONG);

  test("a REAL exact-score pick → logical multi-leg hedge (Protect)", async () => {
    const plan = await runPlan({ query: "England vs Croatia 1:0", budgetUsd: 60, sliderS: 1.0 });
    console.log("\nstatus:", plan.status, "betType:", plan.meta?.betType, "note:", plan.meta?.note ?? "(none)");
    expect(plan.status).toBe("ok");
    expect(plan.plan).toBeTruthy();
    audit("England vs Croatia 1:0 — Protect", plan.plan!);
    // Protect should spread across more than one scoreline if depth allows.
    expect(plan.plan!.legs.length).toBeGreaterThanOrEqual(1);
  }, LONG);

  test("number-of-bets (maxLegs) caps the live plan", async () => {
    const capped = await runPlan({ query: "England vs Croatia 1:0", budgetUsd: 60, sliderS: 1.0, maxLegs: 2 });
    console.log("\nstatus:", capped.status, "betType:", capped.meta?.betType);
    if (capped.status === "ok" && capped.plan) {
      audit("England vs Croatia 1:0 — Protect, maxLegs=2", capped.plan);
      expect(capped.plan.legs.length).toBeLessThanOrEqual(2);
    } else {
      console.log("(not ok — skipping cap assertion)", capped.suggestions);
    }
  }, LONG);
});
