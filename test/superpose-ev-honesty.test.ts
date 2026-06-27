import { test, expect } from "vitest";
import { buildSuperposition, type SuperposeAnchor, type SuperposeLeg } from "@/lib/relate/superpose";

// Regression (review of b5fd337/7e47de1): with a default no-entry anchor (entry == winProb ⇒ nakedEv == 0),
// a funded leg must STILL drive the displayed EV strictly below naked — never exactly $0 ("free hedge").
// The honest unconditional EV uses each leg's MARKET marginal (un-floored, ≤ q). A sub-2% longshot whose
// marginal (1.1%) sits below its executable price (1.6%) must contribute a real negative, not clamp to 0.
test("funded sub-2% longshot leg ⇒ EV strictly below naked (no 'free hedge' $0)", () => {
  const anchor: SuperposeAnchor = { winProb: 0.4, stakeUsd: 50, entryPrice: 0.4 }; // nakedEv == 0 exactly
  const leg: SuperposeLeg = {
    id: "ls", marketId: "ls", marketTitle: "Some longshot", title: "Longshot pays on fail",
    side: "YES", q: 0.016, pWin: 0.0, pFail: 0.05, marginal: 0.011, dimension: "x", tier: "MODELED",
  };
  const sup = buildSuperposition(anchor, [leg], 0); // conservative
  expect(sup.nakedEvUsd).toBe(0);
  expect(sup.legs.length).toBeGreaterThan(0);
  expect(sup.totalCostUsd).toBeGreaterThan(0);
  expect(sup.evUsd).toBeLessThan(sup.nakedEvUsd); // STRICTLY below — the vig is real, not $0
});

// Control: the SAME leg with NO market marginal falls back to the conditional-implied rate. With an
// optimistic pFail the fallback can clamp to 0 — which is exactly why production now attaches `marginal`.
test("same leg WITHOUT marginal would clamp to naked (documents why marginal is attached in prod)", () => {
  const anchor: SuperposeAnchor = { winProb: 0.4, stakeUsd: 50, entryPrice: 0.4 };
  const leg: SuperposeLeg = {
    id: "ls", marketId: "ls", marketTitle: "Some longshot", title: "Longshot pays on fail",
    side: "YES", q: 0.016, pWin: 0.0, pFail: 0.05, dimension: "x", tier: "MODELED",
  };
  const sup = buildSuperposition(anchor, [leg], 0);
  expect(sup.evUsd).toBeLessThanOrEqual(sup.nakedEvUsd + 1e-9); // honesty backbone still holds (≤ naked)
});

// Defensive floor: even if a marginal somehow exceeded q (production now bounds marginal ≤ pre-fee ask < q
// so this cannot happen, but the EV math must never claim better-than-market regardless), the per-leg term
// Math.min(0, …) keeps EV ≤ naked — it must NEVER display a positive/free-money EV.
test("marginal > q can never produce EV above naked (Math.min(0,…) floor)", () => {
  const anchor: SuperposeAnchor = { winProb: 0.4, stakeUsd: 50, entryPrice: 0.4 };
  const leg: SuperposeLeg = {
    id: "x", marketId: "x", marketTitle: "m", title: "t",
    side: "YES", q: 0.30, pWin: 0.0, pFail: 0.45, marginal: 0.40, dimension: "x", tier: "MODELED", // marginal > q
  };
  const sup = buildSuperposition(anchor, [leg], 0);
  expect(sup.evUsd).toBeLessThanOrEqual(sup.nakedEvUsd + 1e-9); // never above naked, even with marginal > q
});
