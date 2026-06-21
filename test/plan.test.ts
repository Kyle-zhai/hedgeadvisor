import { describe, expect, test } from "vitest";
import { buildPlan, buildSingleBet, type PlanOutcomeInput } from "@/lib/plan";
import type { Book, MarketRef } from "@/lib/types";

function deepBook(price: number, id: string): Book {
  return {
    bids: [{ price: price - 0.01, size: 1_000_000 }],
    asks: [{ price, size: 1_000_000 }],
    midpoint: price - 0.005,
    bestBid: price - 0.01,
    bestAsk: price,
    tokenId: id,
  };
}
function ref(team: string): MarketRef {
  return {
    conditionId: `c-${team}`,
    eventId: "e",
    eventSlug: "fifwc-eng-hrv-2026-06-17",
    question: `${team} to win`,
    groupItemTitle: team,
    tokenIdYes: `${team}-y`,
    tokenIdNo: `${team}-n`,
    midpointYes: 0.4,
    resolved: false,
    feeRate: 0.03,
    feeExponent: 1,
    feeTakerOnly: true,
    negRiskMarketId: "nr",
  };
}
// de-vigged 3-way (sums ~1): England 0.56 / Draw 0.26 / Croatia 0.18
const outcomes: PlanOutcomeInput[] = [
  { title: "England", ref: ref("England"), book: deepBook(0.565, "e"), q: 0.56 },
  { title: "Draw", ref: ref("Draw"), book: deepBook(0.255, "d"), q: 0.26 },
  { title: "Croatia", ref: ref("Croatia"), book: deepBook(0.185, "c"), q: 0.18 },
];
const base = { fixtureTitle: "England vs Croatia", betDesc: "England to beat Croatia", outcomes, viewIndices: [0], budgetUsd: 100 };

const spread = (p: { maxGainUsd: number; maxLossUsd: number }) => p.maxGainUsd - p.maxLossUsd;

describe("plan engine — the λ slider", () => {
  test("Protect (s=1.0) = low-variance spread: ~paid in every outcome, EV negative (vig)", () => {
    const p = buildPlan({ ...base, sliderS: 1.0 });
    expect(spread(p)).toBeLessThan(5); // terminal nearly equal across outcomes
    expect(p.pLoseAll).toBe(0); // you get money back whoever wins
    expect(p.expectedValueUsd).toBeLessThanOrEqual(0); // honest: vig
    expect(p.posture).toBe("Protect");
  });

  test("Balanced (s=0.4) concentrates on the view: bigger upside, bigger variance", () => {
    const bal = buildPlan({ ...base, sliderS: 0.4 });
    const prot = buildPlan({ ...base, sliderS: 1.0 });
    expect(bal.maxGainUsd).toBeGreaterThan(0);
    expect(bal.maxGainUsd).toBeGreaterThan(prot.maxGainUsd);
    expect(spread(bal)).toBeGreaterThan(spread(prot));
    // the view outcome (England) is the profitable scenario
    const eng = bal.scenarios.find((s) => s.outcome === "England")!;
    expect(eng.pnlUsd).toBeGreaterThan(0);
  });

  test("honesty outputs are present and correct", () => {
    const p = buildPlan({ ...base, sliderS: 0.4 });
    expect(p.facts.evNote).toMatch(/lose money on average|not an edge/i);
    expect(p.expectedValueUsd).toBeLessThanOrEqual(0); // never claims positive EV
    // scenarios sorted most-likely first (the honesty ordering)
    expect(p.scenarios[0].prob).toBeGreaterThanOrEqual(p.scenarios[1].prob);
    expect(p.deployedUsd).toBeGreaterThan(90); // deploys ~the budget on a deep book
    expect(p.deployedUsd).toBeLessThanOrEqual(101);
  });

  test("buildSingleBet honesty: a de-vigged q (≤ ask) yields EV ≤ 0 (never an edge)", () => {
    const ref = {
      conditionId: "c", eventId: "e", eventSlug: "fx", question: "Over 2.5", groupItemTitle: "O/U 2.5",
      tokenIdYes: "y", tokenIdNo: "n", midpointYes: 0.45, resolved: false,
      feeRate: 0.03, feeExponent: 1, feeTakerOnly: true, negRiskMarketId: "nr",
    } as const;
    const book = deepBook(0.45, "y");
    // q de-vigged BELOW the ask → must be EV-negative (the prop honesty fix)
    const p = buildSingleBet({ fixtureTitle: "F", betDesc: "Over 2.5 goals", ref, book, q: 0.43, budgetUsd: 100 });
    expect(p.expectedValueUsd).toBeLessThanOrEqual(0);
    expect(p.maxLossUsd).toBeLessThan(0); // you can lose your stake
    expect(p.pProfit).toBeGreaterThan(0); // but there's a real chance of profit
  });

  test("budget is adjustable: doubling the budget ~doubles deployed and payouts", () => {
    const a = buildPlan({ ...base, sliderS: 0.4, budgetUsd: 100 });
    const b = buildPlan({ ...base, sliderS: 0.4, budgetUsd: 200 });
    expect(b.deployedUsd).toBeGreaterThan(a.deployedUsd * 1.8);
    expect(b.maxGainUsd).toBeGreaterThan(a.maxGainUsd * 1.8);
  });

  test("legs carry fair value, a protective limit, and a Polymarket deep-link", () => {
    const p = buildPlan({ ...base, sliderS: 1.0 });
    const eng = p.legs.find((l) => l.outcomeTitle === "England")!;
    expect(eng.fairValue).toBeCloseTo(0.56, 2); // = the de-vigged q
    expect(eng.avgFillPrice).toBeGreaterThanOrEqual(eng.fairValue); // you never pay BELOW fair (honesty)
    expect(eng.limitPrice).toBeGreaterThan(0);
    expect(eng.deepLink).toMatch(/^https:\/\/polymarket\.com\/event\//);
    expect(p.facts.fairValueNote).toMatch(/vig \+ spread/i);
  });
});

// A wider partition (5 cells, like an exact-score grid) to exercise the N-legs filter.
const gridOutcomes: PlanOutcomeInput[] = [
  { title: "0-0", ref: ref("c00"), book: deepBook(0.12, "c00"), q: 0.11 },
  { title: "1-0", ref: ref("c10"), book: deepBook(0.16, "c10"), q: 0.15 },
  { title: "1-1", ref: ref("c11"), book: deepBook(0.14, "c11"), q: 0.13 },
  { title: "0-1", ref: ref("c01"), book: deepBook(0.1, "c01"), q: 0.09 },
  { title: "Any other", ref: ref("any"), book: deepBook(0.55, "any"), q: 0.52 },
];
const gridBase = { fixtureTitle: "Spain vs Cape Verde", betDesc: "exact score 0-0", outcomes: gridOutcomes, viewIndices: [0], budgetUsd: 100 };

describe("plan engine — number-of-bets (maxLegs) filter + zero-payout collapse", () => {
  test("maxLegs caps how many bets are placed and still deploys ~the whole budget", () => {
    const p = buildPlan({ ...gridBase, sliderS: 1.0, maxLegs: 2 });
    expect(p.legs.length).toBeLessThanOrEqual(2);
    expect(p.legs.some((l) => l.outcomeTitle === "0-0")).toBe(true); // the view is always kept
    expect(p.deployedUsd).toBeGreaterThan(90); // rescaled to the full budget on a deep book
    expect(p.deployedUsd).toBeLessThanOrEqual(103);
  });

  test("the view is kept even when maxLegs=1 and it's NOT the largest allocation", () => {
    // Under Protect, "Any other" (0.55) dwarfs the 0-0 view (0.12); maxLegs=1 must still keep 0-0.
    const p = buildPlan({ ...gridBase, sliderS: 1.0, maxLegs: 1 });
    expect(p.legs.length).toBe(1);
    expect(p.legs[0].outcomeTitle).toBe("0-0");
  });

  test("collapseZeroPayout merges the wall of losing scorelines into one honest row", () => {
    // Express (s=0) buys only the 0-0 view → the other 4 cells pay nothing.
    const p = buildPlan({ ...gridBase, sliderS: 0, collapseZeroPayout: "Any other scoreline" });
    expect(p.legs.length).toBe(1);
    const merged = p.scenarios.find((s) => s.outcome === "Any other scoreline")!;
    expect(merged).toBeTruthy();
    expect(p.scenarios.length).toBeLessThan(gridOutcomes.length); // fewer rows than cells
    // merged probability = sum of the cells that pay nothing (everything but 0-0)
    expect(merged.prob).toBeCloseTo(0.15 + 0.13 + 0.09 + 0.52, 2);
    expect(merged.pnlUsd).toBeLessThan(0);
    // still sorted most-likely first
    expect(p.scenarios[0].prob).toBeGreaterThanOrEqual(p.scenarios[1].prob);
  });

  test("maxLegs is a no-op when it exceeds the number of outcomes", () => {
    const capped = buildPlan({ ...gridBase, sliderS: 1.0, maxLegs: 99 });
    const uncapped = buildPlan({ ...gridBase, sliderS: 1.0 });
    expect(capped.legs.length).toBe(uncapped.legs.length);
    expect(capped.deployedUsd).toBeCloseTo(uncapped.deployedUsd, 1);
  });

  test("guaranteed-loss guard fires when an uncapped spread covers the whole board", () => {
    // Protect over a wide vigged grid buys ~every cell ∝ price → you lose in EVERY outcome.
    const p = buildPlan({ ...gridBase, sliderS: 1.0 });
    expect(p.legs.length).toBeGreaterThan(1);
    expect(p.maxGainUsd).toBeLessThanOrEqual(0); // loses no matter what
    expect(p.facts.guaranteedLossWarning).toBeTruthy();
    expect(p.warnings.some((w) => /no matter what/i.test(w))).toBe(true);
  });

  test("capping the bets removes the guaranteed loss and restores upside", () => {
    const p = buildPlan({ ...gridBase, sliderS: 1.0, maxLegs: 2 });
    expect(p.maxGainUsd).toBeGreaterThan(0);
    expect(p.facts.guaranteedLossWarning).toBeUndefined();
  });
});
