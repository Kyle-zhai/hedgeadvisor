/**
 * lib/relate/weightFit.ts — §19 item 2: fit the optimizer's ranking weights (specificity / uncertainty)
 * from OUT-OF-SAMPLE walk-forward evidence instead of hand-tuning.
 *
 * The objective mirrors what the weights actually do: within each anchor-FAIL episode, the optimizer
 * picks the top-scored candidate — so a weight pair is good exactly when the top-1 pick's REALIZED
 * fail-state reduction is high. We grid-search (wSpec, wUnc) maximizing the mean realized
 * reduction-per-dollar of the argmax-scored candidate per episode.
 *
 * HONESTY FLOOR (non-negotiable): with few episodes a 2-parameter grid fit is noise-mining. Below
 * `minEpisodes` (default 100 — today's moat has ~21 actionable episodes) the fitter returns
 * `applied: false` and the pinned defaults stand. The weights only ever REORDER candidates the
 * optimizer already admitted; no fit can loosen an admission or honesty gate.
 */

export interface WeightFitPoint {
  /** Independent anchor-FAIL episode (cluster) this candidate belonged to. */
  episodeKey: string;
  /** The optimizer's own ranking inputs at decision time (walk-forward: training data only). */
  reductionPerDollar: number;
  specificity: number;
  uncertainty: number;
  /** Realized per-dollar payoff of this candidate in the episode: pays ? (1/price − 1) : −1. */
  realizedReductionPerDollar: number;
}

export interface WeightFitResult {
  applied: boolean;
  reason?: string;
  episodes: number;
  /** Best grid point (present only when applied). */
  best?: { specificity: number; uncertainty: number; objective: number };
  /** The pinned defaults' objective on the same data, for an honest comparison. */
  defaultObjective?: number;
  grid?: Array<{ specificity: number; uncertainty: number; objective: number }>;
}

export const DEFAULT_RANK_WEIGHTS = { specificity: 0.2, uncertainty: 0.15 } as const;
const MIN_EPISODES = 100;

/** Mean realized reduction of the top-1 pick per episode under score = r + wS·spec − wU·unc. */
function objective(points: Map<string, WeightFitPoint[]>, wS: number, wU: number): number {
  let sum = 0;
  let n = 0;
  for (const eps of points.values()) {
    let best: WeightFitPoint | null = null;
    let bestScore = -Infinity;
    for (const p of eps) {
      const s = p.reductionPerDollar + wS * p.specificity - wU * p.uncertainty;
      if (s > bestScore) { bestScore = s; best = p; }
    }
    if (best) { sum += best.realizedReductionPerDollar; n++; }
  }
  return n ? sum / n : 0;
}

export function fitRankingWeights(points: WeightFitPoint[], opts: { minEpisodes?: number; step?: number; max?: number } = {}): WeightFitResult {
  const byEpisode = new Map<string, WeightFitPoint[]>();
  for (const p of points) {
    const list = byEpisode.get(p.episodeKey) ?? [];
    list.push(p);
    byEpisode.set(p.episodeKey, list);
  }
  // Only episodes with a genuine CHOICE (≥2 candidates) inform a ranking fit.
  for (const [k, v] of byEpisode) if (v.length < 2) byEpisode.delete(k);
  const episodes = byEpisode.size;
  const minEpisodes = opts.minEpisodes ?? MIN_EPISODES;
  const defaultObjective = objective(byEpisode, DEFAULT_RANK_WEIGHTS.specificity, DEFAULT_RANK_WEIGHTS.uncertainty);
  if (episodes < minEpisodes) {
    return {
      applied: false,
      reason: `only ${episodes} multi-candidate fail-episodes (need ${minEpisodes}); a 2-parameter grid fit below that is noise-mining — pinned defaults stand`,
      episodes,
      defaultObjective,
    };
  }
  const step = opts.step ?? 0.05;
  const max = opts.max ?? 0.6;
  const grid: Array<{ specificity: number; uncertainty: number; objective: number }> = [];
  let best: { specificity: number; uncertainty: number; objective: number } =
    { specificity: DEFAULT_RANK_WEIGHTS.specificity, uncertainty: DEFAULT_RANK_WEIGHTS.uncertainty, objective: defaultObjective };
  for (let wS = 0; wS <= max + 1e-9; wS += step) {
    for (let wU = 0; wU <= max + 1e-9; wU += step) {
      const o = objective(byEpisode, wS, wU);
      const cell = { specificity: Number(wS.toFixed(2)), uncertainty: Number(wU.toFixed(2)), objective: o };
      grid.push(cell);
      if (o > best.objective + 1e-12) best = cell;
    }
  }
  return { applied: true, episodes, best, defaultObjective, grid };
}
