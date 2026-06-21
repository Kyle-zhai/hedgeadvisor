/**
 * lib/sim/generator.ts — structural Monte-Carlo tournament generator.
 *
 * Cross-event markets ("Spain reaches the final") are NOT functions of "who wins", so
 * the single 60-team partition is insufficient. We simulate tournaments: draw the
 * champion from the de-vigged winner probs q, and for any team that needs it, draw its
 * furthest round CONSISTENTLY (champion ⟺ round=won). Every market's payoff is then a
 * predicate over the draw. We only specify MARGINALS read from prices + the one
 * structural tie — no fitted covariance.
 *
 * Degeneracy guarantee: with no ladder team, a sim is just a champion draw from q, so the
 * sim reproduces the analytic 60-partition engine within MC tolerance (the regression test).
 */

/** Furthest round for a team. We model the rungs the MVP can price: out-before-final,
 *  lost the final, or won. (Extensible to R32/R16/QF/SF when those books are liquid.) */
export const ROUND_OUT_BEFORE_FINAL = 0;
export const ROUND_LOST_FINAL = 5;
export const ROUND_WON = 6;

export interface SimDraw {
  champion: number; // index into the team partition
  /** furthest round per laddered team index (only teams we drew a ladder for). */
  rounds: Map<number, number>;
}

/** Deterministic PRNG (seed from the data snapshot → reproducible verdicts). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw an index from a (not necessarily normalized) probability vector. */
export function categorical(weights: number[], rng: () => number): number {
  const total = weights.reduce((a, b) => a + (Number.isFinite(b) ? Math.max(0, b) : 0), 0);
  if (!Number.isFinite(total) || total <= 0) return 0;
  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= Math.max(0, weights[i]);
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Build the held team's furthest-round PMF over {out-before-final, lost-final, won}.
 * qWin from the deep Winner market; sReachFinal from the reach-final market (P(reach final)).
 * Enforces the monotone constraint qWin ≤ sReachFinal ≤ 1 (PAVA-min on this 2-rung ladder).
 */
export function buildLadderPmf(qWin: number, sReachFinal: number): { outBeforeFinal: number; lostFinal: number; won: number } {
  const won = Math.min(0.999, Math.max(0, qWin));
  const reachFinal = Math.min(1, Math.max(won, sReachFinal)); // monotone: can't be < won
  return {
    outBeforeFinal: Math.max(0, 1 - reachFinal),
    lostFinal: Math.max(0, reachFinal - won),
    won,
  };
}

export interface SimConfig {
  q: number[]; // de-vigged champion probabilities (length = #teams)
  ladderTeams: number[]; // team indices that need a furthest-round draw
  /** pmf per ladder team index: {outBeforeFinal, lostFinal, won} (won must equal q[i]). */
  ladderPmf: Map<number, { outBeforeFinal: number; lostFinal: number; won: number }>;
  N: number;
  seed: number;
}

export function simulate(cfg: SimConfig): SimDraw[] {
  const rng = mulberry32(cfg.seed);
  const draws: SimDraw[] = [];
  for (let s = 0; s < cfg.N; s++) {
    const champion = categorical(cfg.q, rng);
    const rounds = new Map<number, number>();
    for (const team of cfg.ladderTeams) {
      if (team === champion) {
        rounds.set(team, ROUND_WON);
      } else {
        const pmf = cfg.ladderPmf.get(team);
        if (!pmf) {
          rounds.set(team, ROUND_OUT_BEFORE_FINAL);
          continue;
        }
        // conditional on NOT champion: {out-before-final, lost-final} renormalized
        const denom = pmf.outBeforeFinal + pmf.lostFinal || 1;
        rounds.set(team, rng() * denom < pmf.outBeforeFinal ? ROUND_OUT_BEFORE_FINAL : ROUND_LOST_FINAL);
      }
    }
    draws.push({ champion, rounds });
  }
  return draws;
}
