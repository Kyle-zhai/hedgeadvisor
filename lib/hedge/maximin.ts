/**
 * lib/hedge/maximin.ts — the loss-minimization core, probability-free.
 *
 * North star (owner, 2026-06-17): the product does NOT predict whether the user's bet B wins.
 * It answers: "if B does NOT win, how little can I lose?" — subject to a hard win-floor:
 * if B DOES win the user must still keep at least a fraction `k` of the winnings.
 *
 * This is a maximin over per-state payoffs — NO win-probability is used anywhere. Every quantity
 * below is deterministic given the resolving state:
 *
 *   maximize    min over B-FAILS states of  PnL(state)        # lose the least if wrong
 *   subject to  PnL(state) ≥ k·G for every B-WINS state        # winning keeps ≥ k of its profit
 *               spend_i ≥ 0,  Σ spend_i ≤ (1−k)·G  = budget    # the win-floor as a budget cap
 *
 * where G = payout − stake = the profit if B wins with no hedge, and a hedge leg pays $1/share in
 * a known SET of states (structural coverage — never a fabricated correlation).
 *
 * Exact allocator (no probabilities, no fitted coefficients):
 *  - If any B-fails state is left UNCOVERED by the selected legs, spending only lowers that state's
 *    PnL (cost rises, nothing pays there) → the optimal spend is 0. We never waste money making the
 *    worst case worse; we report the uncovered states so the UI can say "these legs can't cover X".
 *  - If every B-fails state is covered, more protection always lifts the floor, so we spend the full
 *    budget and water-fill it to EQUALIZE the covered fail-states (the maximin optimum). With a single
 *    cover-all leg (e.g. B-NO) this is just "spend it all on B-NO"; with per-outcome legs it reproduces
 *    the price-proportional min-variance allocation.
 */

export interface MaximinLeg {
  id: string;
  label: string;
  /** Executable per-share price you actually pay (0..1), walked off the real book by the caller. */
  price: number;
  /** State indices in which this leg pays $1/share (structural coverage). */
  paysIn: Set<number>;
  provenance?: "ANALYTIC" | "SPECULATIVE" | "REDUNDANT";
}

export interface MaximinInput {
  /** Labels for every state of the partition (e.g. each team in a single-winner market). */
  states: string[];
  /** Indices of the states in which the primary bet B pays. */
  primaryWinIdx: number[];
  /** Dollars staked on B. */
  stakeUsd: number;
  /** Executable price paid for B (0..1). payout = stake / price. */
  primaryPrice: number;
  /** Candidate hedge legs, already priced off the book. */
  legs: MaximinLeg[];
  /** Keep-fraction k ∈ [0,1): if B wins, keep ≥ k·G. budget = (1−k)·G. Default 0.5. */
  keepFraction: number;
  /** Water-fill granularity. */
  steps?: number;
  /**
   * The fail-states this strategy TARGETS (a partial combo deliberately covers a subset, e.g. the top
   * rivals). The allocator maximizes the min PnL over these; `lossIfPrimaryFails` is still reported over
   * ALL fail-states (the honest tail). Default = all fail-states (the strict global-worst objective,
   * which spends $0 if any targeted state is uncoverable — never wasting money to worsen the worst case).
   */
  objectiveStates?: number[];
}

export interface MaximinStatePnL {
  label: string;
  pnl: number;
  isWin: boolean;
}

export interface MaximinResult {
  payoutUsd: number; // what B returns if it wins (stake / price)
  profitUsd: number; // G = payout − stake
  budgetUsd: number; // (1−k)·G — the most you may spend (the win-floor as a cap)
  spendUsd: number; // actually spent (≤ budget; 0 if no leg can cover the worst state)
  allocUsd: Record<string, number>; // leg id → dollars allocated
  keepIfWinUsd: number; // worst PnL across the B-wins states (≥ k·G by construction)
  lossIfPrimaryFailsUsd: number; // POSITIVE magnitude: −min PnL across ALL B-fails states (honest tail)
  coveredWorstUsd: number; // POSITIVE magnitude: −min PnL across the TARGETED fail-states (what it protects)
  worstFloorUsd: number; // POSITIVE magnitude: −min PnL across ALL states
  costOfProtectionUsd: number; // G − keepIfWin: the upside you forgo to buy the floor
  noHedgeLossUsd: number; // baseline worst fail loss with no hedge (= stake)
  perState: MaximinStatePnL[];
  uncovered: string[]; // B-fails states no selected leg can pay in (why we couldn't protect them)
  verdict: "REDUCES" | "NO_CHANGE";
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function solveMaximin(input: MaximinInput): MaximinResult {
  const steps = Math.max(50, input.steps ?? 600);
  const k = clamp01(input.keepFraction);
  const stake = Math.max(0, input.stakeUsd);
  const price = clamp01(input.primaryPrice);
  const payout = price > 1e-9 ? stake / price : 0;
  const profit = Math.max(0, payout - stake); // G
  const budget = Math.max(0, (1 - k) * profit);

  const n = input.states.length;
  const winSet = new Set(input.primaryWinIdx.filter((i) => i >= 0 && i < n));
  const failIdx: number[] = [];
  for (let i = 0; i < n; i++) if (!winSet.has(i)) failIdx.push(i);

  // usable legs: real price, non-empty coverage
  const legs = input.legs.filter((l) => l.price > 1e-9 && l.paysIn.size > 0);
  const spend = legs.map(() => 0);

  // What this strategy TARGETS: the objective states (default = all fail-states = strict global worst).
  const objIdx = (input.objectiveStates ?? failIdx).filter((s) => !winSet.has(s));
  // A targeted state no leg pays in can never be lifted; spending only lowers it. We spend ONLY when
  // every TARGETED state is coverable, so we never waste money worsening a state we meant to protect.
  const uncoveredIdx = failIdx.filter((s) => !legs.some((l) => l.paysIn.has(s)));
  const objAllCoverable = objIdx.length > 0 && objIdx.every((s) => legs.some((l) => l.paysIn.has(s)));
  const canProtect = budget > 1e-9 && legs.length > 0 && objAllCoverable;

  if (canProtect) {
    // Spend the whole budget, water-filled to equalize the TARGETED fail-states (the maximin optimum
    // over the objective). A cover-all leg (B-NO) ⇒ "spend it all on B-NO"; per-outcome legs reproduce
    // the price-proportional min-variance allocation over the targeted set.
    const dEps = budget / steps;
    const failPnl = (sIdx: number): number => {
      let total = 0;
      let pay = 0;
      for (let li = 0; li < legs.length; li++) {
        total += spend[li];
        if (legs[li].paysIn.has(sIdx)) pay += spend[li] / legs[li].price;
      }
      return pay - (stake + total);
    };
    for (let step = 0; step < steps; step++) {
      // raise the current worst TARGETED fail-state via its cheapest (highest 1/price) cover
      let worst = Infinity;
      let worstState = -1;
      for (const s of objIdx) {
        const v = failPnl(s);
        if (v < worst) {
          worst = v;
          worstState = s;
        }
      }
      // Stop once the targeted states are NEUTRALIZED (break-even). Spending past break-even chases
      // profit on a subset, wasting money and worsening the uncovered tail — never a hedge's job.
      if (worst >= -1e-9) break;
      let bestLi = -1;
      let bestRate = -Infinity;
      for (let li = 0; li < legs.length; li++) {
        if (legs[li].paysIn.has(worstState) && 1 / legs[li].price > bestRate) {
          bestRate = 1 / legs[li].price;
          bestLi = li;
        }
      }
      if (bestLi < 0) break;
      spend[bestLi] += dEps;
    }
  }

  const totalSpend = spend.reduce((a, b) => a + b, 0);
  const totalCost = stake + totalSpend;
  const perState: MaximinStatePnL[] = input.states.map((label, sIdx) => {
    let pay = winSet.has(sIdx) ? payout : 0;
    for (let li = 0; li < legs.length; li++) if (legs[li].paysIn.has(sIdx)) pay += spend[li] / legs[li].price;
    return { label, pnl: pay - totalCost, isWin: winSet.has(sIdx) };
  });

  const winPnls = perState.filter((p) => p.isWin).map((p) => p.pnl);
  const failPnls = perState.filter((p) => !p.isWin).map((p) => p.pnl);
  const objPnls = objIdx.map((s) => perState[s].pnl);
  const keepIfWin = winPnls.length ? Math.min(...winPnls) : 0;
  const lossIfFail = failPnls.length ? Math.max(0, -Math.min(...failPnls)) : 0;
  const coveredWorst = objPnls.length ? Math.max(0, -Math.min(...objPnls)) : lossIfFail;
  const worstFloor = perState.length ? Math.max(0, -Math.min(...perState.map((p) => p.pnl))) : 0;
  const costProt = Math.max(0, profit - keepIfWin);
  const noHedgeLoss = failIdx.length ? stake : 0;

  const allocUsd: Record<string, number> = {};
  legs.forEach((l, li) => {
    if (spend[li] > 1e-9) allocUsd[l.id] = round2(spend[li]);
  });

  return {
    payoutUsd: round2(payout),
    profitUsd: round2(profit),
    budgetUsd: round2(budget),
    spendUsd: round2(totalSpend),
    allocUsd,
    keepIfWinUsd: round2(keepIfWin),
    lossIfPrimaryFailsUsd: round2(lossIfFail),
    coveredWorstUsd: round2(coveredWorst),
    worstFloorUsd: round2(worstFloor),
    costOfProtectionUsd: round2(costProt),
    noHedgeLossUsd: round2(noHedgeLoss),
    perState: perState.map((p) => ({ ...p, pnl: round2(p.pnl) })),
    uncovered: uncoveredIdx.map((i) => input.states[i]),
    verdict: coveredWorst < noHedgeLoss - 1e-6 ? "REDUCES" : "NO_CHANGE",
  };
}

/**
 * Sample the cost-vs-protection frontier across the protect range (k: 1 → 0). Each point is what
 * the bipolar slider's LEFT half lands on: keepIfWin shrinks, lossIfPrimaryFails shrinks, all
 * probability-free. (The RIGHT/amplify half is handled separately and is illustrative.)
 */
export function protectFrontier(input: Omit<MaximinInput, "keepFraction">, points = 11): MaximinResult[] {
  const out: MaximinResult[] = [];
  for (let i = 0; i < points; i++) {
    const k = 1 - i / (points - 1); // 1 (no hedge) → 0 (break-even, max protect)
    out.push(solveMaximin({ ...input, keepFraction: k }));
  }
  return out;
}

function round2(x: number): number {
  return Number(x.toFixed(2));
}

/**
 * The RIGHT half of the bipolar slider: AMPLIFY. The only probability-free, non-fabricated way to
 * amplify a single bet is leverage — stake more on B itself. Win and loss both scale by (1+a):
 *   keepIfWin = (1+a)·G ,  lossIfFail = (1+a)·stake.
 * Correlated parlay legs would amplify too, but their value rests on a positive correlation we can't
 * derive structurally (only containment is exact, and that's redundant) — so honest correlated
 * amplification is an explicitly-speculative parlay, kept in the Combo surface, never recommended here.
 */
export interface AmplifyPoint {
  a: number; // extra stake as a fraction of the base stake (0 = no leverage)
  keepIfWinUsd: number;
  lossIfFailUsd: number;
  totalStakeUsd: number;
}

export function amplifyLeverage(stakeUsd: number, primaryPrice: number, a: number): AmplifyPoint {
  const p = clamp01(primaryPrice);
  const stake = Math.max(0, stakeUsd);
  const aa = Math.max(0, a);
  const profit = p > 1e-9 ? stake * (1 - p) / p : 0; // G
  return {
    a: aa,
    keepIfWinUsd: round2(profit * (1 + aa)),
    lossIfFailUsd: round2(stake * (1 + aa)),
    totalStakeUsd: round2(stake * (1 + aa)),
  };
}

/** Sample the amplify curve a ∈ [0,1] for the slider's right half. */
export function amplifyCurve(stakeUsd: number, primaryPrice: number, points = 11): AmplifyPoint[] {
  const out: AmplifyPoint[] = [];
  for (let i = 0; i < points; i++) out.push(amplifyLeverage(stakeUsd, primaryPrice, i / (points - 1)));
  return out;
}
