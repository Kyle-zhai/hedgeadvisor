import { describe, expect, test } from "vitest";
import { simulate, buildLadderPmf, ROUND_WON, ROUND_OUT_BEFORE_FINAL, ROUND_LOST_FINAL } from "@/lib/sim/generator";
import { pnlDistribution, pnlDistributionSim, riskMetrics, type PnLLeg, type SimLeg, type Outcome } from "@/lib/netcost";

const outcomes: Outcome[] = [
  { label: "Spain", q: 0.56 },
  { label: "France", q: 0.26 },
  { label: "Brazil", q: 0.07 },
  { label: "Field", q: 0.11 },
];

describe("structural MC generator", () => {
  test("ladder PMF enforces monotonicity (qWin ≤ reachFinal) and sums to 1", () => {
    const pmf = buildLadderPmf(0.15, 0.3); // win 0.15, reach-final 0.30
    expect(pmf.won).toBeCloseTo(0.15, 6);
    expect(pmf.lostFinal).toBeCloseTo(0.15, 6); // reachFinal − won
    expect(pmf.outBeforeFinal).toBeCloseTo(0.7, 6);
    expect(pmf.outBeforeFinal + pmf.lostFinal + pmf.won).toBeCloseTo(1, 6);
    // monotone repair: a reach-final below win is lifted to win
    const bad = buildLadderPmf(0.2, 0.1);
    expect(bad.lostFinal).toBeGreaterThanOrEqual(0);
  });

  test("champion marginal reproduces q; ladder won-rate ≈ q[held]", () => {
    const held = 0;
    const pmf = buildLadderPmf(outcomes[held].q, 0.75);
    const draws = simulate({
      q: outcomes.map((o) => o.q),
      ladderTeams: [held],
      ladderPmf: new Map([[held, pmf]]),
      N: 40000,
      seed: 12345,
    });
    const champRate = draws.filter((d) => d.champion === held).length / draws.length;
    expect(champRate).toBeCloseTo(0.56, 1); // within ~0.05
    // held team's won-round only when it's champion (the structural tie)
    const wonRate = draws.filter((d) => d.rounds.get(held) === ROUND_WON).length / draws.length;
    expect(wonRate).toBeCloseTo(champRate, 5);
    // reach-final rate ≈ 0.75 (won + lostFinal)
    const reachFinal = draws.filter((d) => {
      const r = d.rounds.get(held);
      return r === ROUND_WON || r === ROUND_LOST_FINAL;
    }).length / draws.length;
    expect(reachFinal).toBeCloseTo(0.75, 1);
  });
});

describe("regression keystone: champion-only MC ≡ analytic partition", () => {
  test("complement hedge risk metrics match analytic within MC tolerance", () => {
    const heldShares = 6536;
    const heldBasis = 1000;
    const hedgeShares = 2000;
    const hedgeCash = 1700;

    // analytic over the 4-outcome partition
    const heldLeg: PnLLeg = { shares: heldShares, cashOutUsd: heldBasis, paysIn: new Set([0]) };
    const hedgeLeg: PnLLeg = { shares: hedgeShares, cashOutUsd: hedgeCash, paysIn: new Set([1, 2, 3]) };
    const analytic = riskMetrics(pnlDistribution(outcomes, [heldLeg, hedgeLeg]));

    // sim (champion-only, no ladder)
    const draws = simulate({ q: outcomes.map((o) => o.q), ladderTeams: [], ladderPmf: new Map(), N: 60000, seed: 999 });
    const simLegs: SimLeg[] = [
      { shares: heldShares, cashOutUsd: heldBasis, paysInSim: (d) => d.champion === 0 },
      { shares: hedgeShares, cashOutUsd: hedgeCash, paysInSim: (d) => d.champion !== 0 },
    ];
    const sim = riskMetrics(pnlDistributionSim(draws, simLegs));

    expect(sim.maxLoss).toBeCloseTo(analytic.maxLoss, 0); // deterministic across outcomes
    expect(Math.abs(sim.stdDev - analytic.stdDev) / analytic.stdDev).toBeLessThan(0.05);
  });
});
