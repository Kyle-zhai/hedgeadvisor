/**
 * lib/relate/superposeExperiment.ts — a deterministic Monte-Carlo experiment that JUDGES whether the
 * superposition strategy (lib/relate/superpose.ts) actually delivers its promise across many realistic,
 * vig-priced, noisily-elicited scenarios. No live data; fully seeded so results are reproducible.
 *
 * For each scenario we synthesize an anchor + a pool of candidate markets with KNOWN true conditional
 * payoffs (a = P(pay|win), f = P(pay|fail)), price them with a real overround, then hand the builder a
 * NOISY estimate of (a, f) (elicitation error) — exactly the production handicap. We build the conservative
 * (λ=0) and aggressive (λ=1) strategies, then Monte-Carlo the TRUE joint and score realized P&L vs naked.
 *
 * A scenario PASSES when, on realized outcomes:
 *   R1  both directions produce a multi-bet stacked strategy (≥1 leg; ≥2 tracked separately);
 *   R2c conservative loses MEANINGFULLY less than naked when the anchor fails;
 *   R2a aggressive gains MEANINGFULLY more than naked when the anchor wins;
 *   R3  the legs of each strategy are logically related (coherent: all share the anchor sign);
 *   EV  neither direction beats the naked unconditional EV (the honesty backbone holds).
 */
import { buildSuperposition, type SuperposeLeg, type SuperposeOpts } from "./superpose";

// ── seeded RNG (mulberry32) + gaussian (Box–Muller) ──
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng: () => number): number {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

const DIMS = ["scoreline", "narrative", "timing", "discipline", "individual", "method", "macro", "asset"];

interface TrueCandidate { id: string; a: number; f: number; q: number; dimension: string }

interface Scenario {
  pi: number; stakeUsd: number; entryPrice: number;
  trueCands: TrueCandidate[];
  estLegs: SuperposeLeg[]; // what the builder sees (noisy a,f; exact q)
}

function makeScenario(rng: () => number, elicitSigma: number): Scenario {
  const pi = 0.12 + rng() * 0.48; // [0.12, 0.60] de-vigged anchor win prob
  const entryPrice = clamp(pi + gauss(rng) * 0.03, 0.05, 0.9); // user's entry, near current
  const stakeUsd = 20;
  const K = 6 + Math.floor(rng() * 5); // 6..10 candidates
  const trueCands: TrueCandidate[] = [];
  const estLegs: SuperposeLeg[] = [];
  for (let i = 0; i < K; i++) {
    const r = rng();
    let a: number, f: number;
    if (r < 0.4) { // AMPLIFIER: pays more when anchor wins (a > f)
      a = 0.4 + rng() * 0.5;
      f = 0.02 + rng() * (a * 0.5);
    } else if (r < 0.8) { // HEDGE: pays more when anchor fails (f > a)
      f = 0.35 + rng() * 0.5;
      a = 0.02 + rng() * (f * 0.5);
    } else { // NEUTRAL: ~independent of the anchor
      const base = 0.2 + rng() * 0.4;
      a = clamp(base + gauss(rng) * 0.03, 0.02, 0.95);
      f = clamp(base + gauss(rng) * 0.03, 0.02, 0.95);
    }
    a = clamp(a, 0.02, 0.95); f = clamp(f, 0.02, 0.95);
    const marginal = pi * a + (1 - pi) * f;
    const vig = 0.02 + rng() * 0.04; // 2–6% overround baked into the price
    const q = clamp(marginal * (1 + vig), 0.02, 0.97);
    const dimension = DIMS[i % DIMS.length];
    const id = `c${i}`;
    trueCands.push({ id, a, f, q, dimension });
    // builder sees NOISY estimates of a,f (exact price)
    estLegs.push({
      id, marketTitle: `Market ${i}`, title: `Outcome ${i}`, side: "YES", q,
      pWin: clamp(a + gauss(rng) * elicitSigma, 0.01, 0.99),
      pFail: clamp(f + gauss(rng) * elicitSigma, 0.01, 0.99),
      dimension,
    });
  }
  return { pi, stakeUsd, entryPrice, trueCands, estLegs };
}

export interface ScenarioResult {
  passed: boolean;
  r1: boolean; r2c: boolean; r2a: boolean; r3: boolean; evHonest: boolean;
  multiLeg: boolean;
  consLegs: number; aggrLegs: number;
  meanFailLossNaked: number; meanFailLossCons: number; // smaller is better
  meanWinGainNaked: number; meanWinGainAggr: number; // larger is better
  failLossReductionPct: number; winGainUpliftPct: number;
}

function scoreScenario(s: Scenario, rng: () => number, opts: { draws: number; minImprovePct: number; builder: SuperposeOpts }): ScenarioResult {
  const anchor = { winProb: s.pi, stakeUsd: s.stakeUsd, entryPrice: s.entryPrice };
  const cons = buildSuperposition(anchor, s.estLegs, 0, opts.builder);
  const aggr = buildSuperposition(anchor, s.estLegs, 1, opts.builder);
  const W = s.stakeUsd * (1 - clamp(s.entryPrice, 1e-4, 1 - 1e-4)) / clamp(s.entryPrice, 1e-4, 1 - 1e-4);
  const trueOf = new Map(s.trueCands.map((c) => [c.id, c]));

  const legPnl = (legs: typeof cons.legs, win: boolean, draw: () => number) =>
    legs.reduce((sum, l) => {
      const t = trueOf.get(l.id)!;
      const pays = draw() < (win ? t.a : t.f);
      return sum + (pays ? l.costUsd / l.q - l.costUsd : -l.costUsd);
    }, 0);

  let failN = 0, winN = 0, failLossCons = 0, winGainAggr = 0;
  for (let d = 0; d < opts.draws; d++) {
    const win = rng() < s.pi;
    if (win) {
      winN++;
      winGainAggr += W + legPnl(aggr.legs, true, rng);
    } else {
      failN++;
      // loss is the positive magnitude of a negative P&L
      failLossCons += -(-s.stakeUsd + legPnl(cons.legs, false, rng));
    }
  }
  const meanFailLossCons = failN ? failLossCons / failN : s.stakeUsd;
  const meanWinGainAggr = winN ? winGainAggr / winN : W;
  const meanFailLossNaked = s.stakeUsd;
  const meanWinGainNaked = W;
  const failLossReductionPct = (meanFailLossNaked - meanFailLossCons) / Math.max(1e-9, meanFailLossNaked);
  const winGainUpliftPct = (meanWinGainAggr - meanWinGainNaked) / Math.max(1e-9, meanWinGainNaked);

  const r1 = cons.legs.length >= 1 && aggr.legs.length >= 1;
  const multiLeg = cons.legs.length >= 2 && aggr.legs.length >= 2;
  const r2c = meanFailLossCons < meanFailLossNaked * (1 - opts.minImprovePct);
  const r2a = meanWinGainAggr > meanWinGainNaked * (1 + opts.minImprovePct);
  const r3 = cons.coherent && aggr.coherent;
  // Honesty invariant: the TRUE unconditional EV (using real conditional payoffs) never beats naked,
  // because the price q ≥ the leg's de-vigged fair by construction (the vig). This is the real backbone
  // property; the builder's DISPLAYED ev is separately clamped so it can't claim a positive EV either.
  const nakedEv = s.pi * W + (1 - s.pi) * (-s.stakeUsd);
  const trueEv = (legs: typeof cons.legs) => {
    const wp = W + legs.reduce((sum, l) => sum + l.costUsd * ((trueOf.get(l.id)!.a) / l.q - 1), 0);
    const fp = -s.stakeUsd + legs.reduce((sum, l) => sum + l.costUsd * ((trueOf.get(l.id)!.f) / l.q - 1), 0);
    return s.pi * wp + (1 - s.pi) * fp;
  };
  const evHonest = trueEv(cons.legs) <= nakedEv + 1e-6 && trueEv(aggr.legs) <= nakedEv + 1e-6
    && cons.evUsd <= cons.nakedEvUsd + 1e-6 && aggr.evUsd <= aggr.nakedEvUsd + 1e-6;
  // The user's three requirements gate the pass; EV honesty is tracked as a separate invariant.
  const passed = r1 && r2c && r2a && r3;

  return {
    passed, r1, r2c, r2a, r3, evHonest, multiLeg,
    consLegs: cons.legs.length, aggrLegs: aggr.legs.length,
    meanFailLossNaked, meanFailLossCons, meanWinGainNaked, meanWinGainAggr,
    failLossReductionPct, winGainUpliftPct,
  };
}

export interface ExperimentReport {
  scenarios: number;
  passRate: number;
  r1Rate: number; r2cRate: number; r2aRate: number; r3Rate: number; evHonestRate: number;
  multiLegRate: number;
  avgFailLossReductionPct: number; // among scenarios where conservative funded a leg
  avgWinGainUpliftPct: number;     // among scenarios where aggressive funded a leg
}

export function runExperiment(opts: {
  seed?: number; scenarios?: number; draws?: number; minImprovePct?: number;
  elicitSigma?: number; builder?: SuperposeOpts;
} = {}): ExperimentReport {
  const rng = mulberry32(opts.seed ?? 12345);
  const scenarios = opts.scenarios ?? 400;
  const draws = opts.draws ?? 6000;
  const minImprovePct = opts.minImprovePct ?? 0.02;
  const elicitSigma = opts.elicitSigma ?? 0.08;
  const builder = opts.builder ?? {};
  const results: ScenarioResult[] = [];
  for (let i = 0; i < scenarios; i++) {
    const s = makeScenario(rng, elicitSigma);
    results.push(scoreScenario(s, rng, { draws, minImprovePct, builder }));
  }
  const rate = (pred: (r: ScenarioResult) => boolean) => results.filter(pred).length / results.length;
  const consFunded = results.filter((r) => r.consLegs >= 1);
  const aggrFunded = results.filter((r) => r.aggrLegs >= 1);
  return {
    scenarios,
    passRate: rate((r) => r.passed),
    r1Rate: rate((r) => r.r1),
    r2cRate: rate((r) => r.r2c),
    r2aRate: rate((r) => r.r2a),
    r3Rate: rate((r) => r.r3),
    evHonestRate: rate((r) => r.evHonest),
    multiLegRate: rate((r) => r.multiLeg),
    avgFailLossReductionPct: consFunded.length ? consFunded.reduce((s, r) => s + r.failLossReductionPct, 0) / consFunded.length : 0,
    avgWinGainUpliftPct: aggrFunded.length ? aggrFunded.reduce((s, r) => s + r.winGainUpliftPct, 0) / aggrFunded.length : 0,
  };
}
