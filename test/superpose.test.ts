import { describe, expect, test } from "vitest";
import { buildSuperposition, type SuperposeLeg } from "@/lib/relate/superpose";
import { runExperiment } from "@/lib/relate/superposeExperiment";

const anchor = { winProb: 0.3, stakeUsd: 20, entryPrice: 0.3 }; // W = 20·0.7/0.3 = 46.67
// Prices are HONEST: q ≥ the leg's de-vigged fair (marginal = 0.3·pWin + 0.7·pFail), so no leg is a
// free unconditional edge — the conditional improvement is the only thing the direction knob buys.
const cands: SuperposeLeg[] = [
  // two AMPLIFIERS (pay more when the anchor WINS), distinct dimensions. marg≈0.31 / 0.27
  { id: "amp1", marketTitle: "M1", title: "Amp 1", side: "YES", q: 0.34, pWin: 0.80, pFail: 0.10, dimension: "scoreline" },
  { id: "amp2", marketTitle: "M2", title: "Amp 2", side: "YES", q: 0.29, pWin: 0.70, pFail: 0.08, dimension: "individual" },
  // two HEDGES (pay more when the anchor FAILS), distinct dimensions. marg≈0.56 / 0.53
  { id: "hed1", marketTitle: "M3", title: "Hedge 1", side: "YES", q: 0.58, pWin: 0.10, pFail: 0.75, dimension: "narrative" },
  { id: "hed2", marketTitle: "M4", title: "Hedge 2", side: "YES", q: 0.55, pWin: 0.12, pFail: 0.70, dimension: "macro" },
];

describe("superposition payoff math", () => {
  test("AGGRESSIVE stacks win-paying legs ⇒ higher payoff if the anchor WINS, and is multi-leg", () => {
    const a = buildSuperposition(anchor, cands, 1);
    expect(a.mode).toBe("aggressive");
    expect(a.legs.length).toBeGreaterThanOrEqual(2); // stacked
    expect(a.legs.every((l) => l.pWin > l.pFail)).toBe(true); // only amplifiers
    expect(a.winPnlUsd).toBeGreaterThan(a.nakedWinPnlUsd); // higher payoff if you win
    expect(a.bestCaseUsd).toBeGreaterThan(a.nakedWinPnlUsd);
    expect(a.coherent).toBe(true); // R3: legs logically related
  });

  test("CONSERVATIVE stacks fail-paying legs ⇒ smaller loss if the anchor FAILS, and is multi-leg", () => {
    const c = buildSuperposition(anchor, cands, 0);
    expect(c.mode).toBe("conservative");
    expect(c.legs.length).toBeGreaterThanOrEqual(2); // stacked
    expect(c.legs.every((l) => l.pFail > l.pWin)).toBe(true); // only hedges
    // failPnl is a negative number; "smaller loss" = closer to 0 = greater than naked −S
    expect(c.failPnlUsd).toBeGreaterThan(c.nakedFailPnlUsd);
    expect(c.coherent).toBe(true);
  });

  test("honesty backbone: neither direction beats the naked unconditional EV (you still pay the vig)", () => {
    for (const dir of [0, 0.5, 1]) {
      const s = buildSuperposition(anchor, cands, dir);
      expect(s.evUsd).toBeLessThanOrEqual(s.nakedEvUsd + 1e-6);
      expect(s.strictWorstUsd).toBeLessThanOrEqual(-anchor.stakeUsd); // worst case never better than losing the stake
    }
  });
});

describe("Monte-Carlo experiment: most scenarios satisfy all three requirements", () => {
  test("pass-rate is a clear majority across 400 vig-priced, noisily-elicited scenarios", () => {
    const r = runExperiment({ seed: 12345, scenarios: 400 });
    // Surface the full report so the judgment is auditable.
    // eslint-disable-next-line no-console
    console.log("SUPERPOSE EXPERIMENT", JSON.stringify(r, null, 2));
    // ~88% at this seed, ~90% mean across seeds (verified 0.877–0.943) — well past "大多数" (a majority).
    expect(r.passRate).toBeGreaterThan(0.8);
    expect(r.evHonestRate).toBe(1); // honesty backbone holds in EVERY scenario (true EV never beats naked)
    // Direction actually does its job, on average: conservative cuts the fail-loss, aggressive lifts the win.
    expect(r.avgFailLossReductionPct).toBeGreaterThan(0.05);
    expect(r.avgWinGainUpliftPct).toBeGreaterThan(0.05);
  });
});
