/**
 * lib/relate/superpose.ts — the SUPERPOSITION strategy: a stacked, multi-leg companion bet with ONE
 * AGGRESSIVE↔CONSERVATIVE direction knob, built on a single honest idea.
 *
 * Unconditionally every leg is EV-NEGATIVE (you pay the vig). But CONDITIONAL on the anchor's outcome a
 * correlated leg flips positive:
 *   - a leg that co-moves with the anchor WINNING pays more often than its price in the win-world: a/q > 1;
 *   - a leg that pays when the anchor FAILS beats its price in the fail-world:                    f/q > 1.
 * So the SAME machine, aimed at opposite target states, gives the user two honest choices:
 *   - CONSERVATIVE (direction → 0): stack fail-paying legs  ⇒ SMALLER loss if the anchor fails.
 *   - AGGRESSIVE   (direction → 1): stack win-paying legs   ⇒ HIGHER payoff if the anchor wins.
 *
 * The legs are LOGICALLY RELATED to each other because every leg is conditioned on the SAME pivotal event
 * (the anchor outcome) and all share its sign in the chosen direction — a coherent thesis, not a grab bag.
 *
 * Honesty backbone (unchanged): adding any leg only ever LOWERS the unconditional EV (the vig), and the
 * opposite state always gets worse. The knob reshapes the conditional payoff profile; it never beats EV.
 */

export type Direction = number; // 0 = fully conservative … 1 = fully aggressive
/** Confidence tier of a leg: structurally certain → settlement-proven → LLM prior. */
export type Tier = "ANALYTIC" | "CALIBRATED" | "MODELED";

export interface SuperposeAnchor {
  /** De-vigged P(anchor wins). */
  winProb: number;
  /** Dollars at risk on the primary bet (S). */
  stakeUsd: number;
  /** Your average entry price (p). Winnings if the anchor wins = S·(1−p)/p. */
  entryPrice: number;
}

export interface SuperposeLeg {
  id: string;
  marketTitle: string;
  title: string;
  side: "YES" | "NO";
  /** Executable de-vigged price = cost per $1 of payout (q). */
  q: number;
  /** P(this leg pays | anchor WINS)  — a. (In production: elicited; may carry estimation noise.) */
  pWin: number;
  /** P(this leg pays | anchor FAILS) — f. */
  pFail: number;
  /** Orthogonal facet (one leg per dimension in a combo). */
  dimension: string;
  mechanism?: string;
  /** Mechanism TYPE (the bucket key, e.g. "CROSS_ENTITY"), carried so a MODELED leg can be given a
   *  gold-residual conservative interval downstream. Not the human-readable `mechanism` text. */
  mechType?: string;
  /** Confidence tier. ANALYTIC legs carry EXACT conditionals (a structural certainty like A ⊆ B) and
   *  bypass the noise margin; default MODELED (LLM-elicited). */
  tier?: Tier;
  /** Source market id (for re-pricing q at the real executable book cost before building). */
  marketId?: string;
  /** Source venue (so a recommendation derived from this leg labels the right book). */
  venue?: "polymarket" | "kalshi";
  /** De-vigged MARKET pay-probability of the bought side (the honest unconditional rate). Set when q is
   *  re-priced to the executable book: marginal ≤ q (q carries the vig), so the leg can only LOWER EV. */
  marginal?: number;
}

export interface PlacedLeg {
  id: string;
  marketTitle: string;
  title: string;
  side: "YES" | "NO";
  q: number;
  pWin: number;
  pFail: number;
  dimension: string;
  mechanism?: string;
  /** Mechanism TYPE (bucket key), carried from the source leg for the MODELED gold-residual interval. */
  mechType?: string;
  costUsd: number;
  shares: number;
  /** a/q − 1: per-dollar return when the anchor WINS. */
  edgeWin: number;
  /** f/q − 1: per-dollar return when the anchor FAILS. */
  edgeFail: number;
  tier: Tier;
  /** De-vigged market marginal of the bought side (≤ q); drives the honest unconditional EV. */
  marginal?: number;
  /** Source venue (carried through for downstream recommendation labels). */
  venue?: "polymarket" | "kalshi";
}

export interface Superposition {
  direction: Direction;
  mode: "aggressive" | "conservative" | "balanced";
  legs: PlacedLeg[];
  totalCostUsd: number;
  /** Expected P&L conditional on the anchor WINNING, WITH the strategy (uses the legs' stated a). */
  winPnlUsd: number;
  /** Expected P&L conditional on the anchor FAILING, WITH the strategy (uses the legs' stated f). */
  failPnlUsd: number;
  nakedWinPnlUsd: number; // +W
  nakedFailPnlUsd: number; // −S
  /** Worst realizable: anchor fails AND every leg loses ⇒ −(S + totalCost). */
  strictWorstUsd: number;
  /** Best realizable: anchor wins AND every leg pays ⇒ W + Σ c·(1/q − 1). */
  bestCaseUsd: number;
  /** Unconditional EV (always ≤ naked EV, ≤ the vig). Proof the strategy never beats EV. */
  evUsd: number;
  nakedEvUsd: number;
  /** All legs share the target sign vs the anchor (the "logically related" property, R3). */
  coherent: boolean;
  /** The combo's tier = its WEAKEST leg (any MODELED ⇒ MODELED; all ANALYTIC ⇒ ANALYTIC). */
  tier: Tier;
}

export interface SuperposeOpts {
  /** Total dollars to deploy across companion legs. Default min(0.5·W, stake): never risk more on
   *  companions than the stake itself, and never more than half your potential winnings (longshots have
   *  huge W, so the stake cap keeps the companion spend sane). */
  riskBudgetUsd?: number;
  maxLegs?: number; // default 4
  /** Estimated target-edge a leg must clear to be SELECTED, to absorb elicitation noise. Default 0.08. */
  edgeMargin?: number;
  /** Per-leg spend cap as a fraction of the budget, to force STACKING (≥2 legs). Default 0.6. */
  perLegCapFraction?: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const clampP = (p: number) => clamp(p, 1e-4, 1 - 1e-4);

/**
 * Build the superposition strategy for a chosen direction.
 *
 * Selection: a leg qualifies only if its TARGET-state edge clears `edgeMargin` (so noise can't promote a
 * non-edge leg), where the target is a direction-blend of the win-edge (a/q−1) and fail-edge (f/q−1). We
 * keep at most one leg per dimension (orthogonality) and the top `maxLegs` by edge.
 *
 * Sizing: the budget is split across the selected legs in proportion to their edge (so EVERY selected leg
 * is funded ⇒ genuinely stacked), each capped at `perLegCapFraction` of the budget.
 *
 * The payoff profile is computed from the legs' own (stated) conditional probabilities — honest about what
 * the engine believes. A separate Monte-Carlo experiment scores these strategies against TRUE outcomes.
 */
export function buildSuperposition(
  anchor: SuperposeAnchor,
  candidates: SuperposeLeg[],
  direction: Direction,
  opts: SuperposeOpts = {},
): Superposition {
  const S = Math.max(0, anchor.stakeUsd);
  const p = clampP(anchor.entryPrice);
  const pi = clampP(anchor.winProb);
  const W = S * (1 - p) / p; // winnings if the anchor wins
  const lambda = clamp(direction, 0, 1);
  const riskBudget = Math.max(0, opts.riskBudgetUsd ?? Math.min(0.5 * W, S));
  const maxLegs = Math.max(1, Math.floor(opts.maxLegs ?? 4));
  const edgeMargin = Math.max(0, opts.edgeMargin ?? 0.08);
  const perLegCap = riskBudget * clamp(opts.perLegCapFraction ?? 0.6, 0.25, 1);
  const mode: Superposition["mode"] = lambda >= 0.66 ? "aggressive" : lambda <= 0.34 ? "conservative" : "balanced";

  const enriched = candidates.map((c) => {
    const q = clamp(c.q, 1e-3, 1 - 1e-3);
    const a = clampP(c.pWin);
    const f = clampP(c.pFail);
    const edgeWin = a / q - 1;
    const edgeFail = f / q - 1;
    // direction-blended target edge: λ=1 ⇒ pure win-edge (aggressive), λ=0 ⇒ pure fail-edge (conservative)
    const targetEdge = lambda * edgeWin + (1 - lambda) * edgeFail;
    const tier: Tier = c.tier ?? "MODELED";
    return { c, q, a, f, edgeWin, edgeFail, targetEdge, tier };
  });

  // Qualify: positive target edge AND the leg genuinely leans the chosen way (aggressive legs co-move with
  // the win, conservative legs with the fail), so the combo is coherent. ANALYTIC legs carry EXACT
  // conditionals, so they only need a positive edge — the noise margin is for absorbing elicitation error.
  const qualified = enriched.filter((e) => {
    const gate = e.tier === "ANALYTIC" ? 1e-9 : edgeMargin;
    if (e.targetEdge <= gate) return false;
    if (mode === "aggressive") return e.a > e.f; // amplifier
    if (mode === "conservative") return e.f > e.a; // hedge
    return true; // balanced: either, as long as it has target edge
  });

  // Collapse to the most TRUSTWORTHY leg per slot (ANALYTIC over CALIBRATED over MODELED, then best edge),
  // FIRST per underlying MARKET (two legs on the same market are the same bet/facet — this dedupes a
  // structural ANALYTIC leg against the LLM's MODELED leg on that market even if their dimension labels
  // disagree), THEN per orthogonal DIMENSION. So a structural certainty always wins its slot, once.
  const tierRank = (t: Tier) => (t === "ANALYTIC" ? 0 : t === "CALIBRATED" ? 1 : 2);
  const best = (a: typeof qualified[number], b: typeof qualified[number]) =>
    tierRank(a.tier) - tierRank(b.tier) || b.targetEdge - a.targetEdge;
  const byMarket = new Map<string, typeof qualified[number]>();
  for (const e of [...qualified].sort(best)) if (!byMarket.has(e.c.marketTitle)) byMarket.set(e.c.marketTitle, e);
  const byDim = new Map<string, typeof qualified[number]>();
  for (const e of [...byMarket.values()].sort(best)) if (!byDim.has(e.c.dimension)) byDim.set(e.c.dimension, e);
  const selected = [...byDim.values()].sort(best).slice(0, maxLegs);

  // Size: water-fill the budget across selected legs in proportion to edge (so EVERY selected leg is
  // funded ⇒ genuinely stacked), each capped at perLegCap; excess from capped legs spills to the rest.
  const cost = new Map(selected.map((e) => [e.c.id, 0]));
  const weight = new Map(selected.map((e) => [e.c.id, Math.max(e.targetEdge, 1e-6)]));
  let remaining = riskBudget;
  let active = selected.map((e) => e.c.id);
  for (let iter = 0; iter < 8 && remaining > 0.01 && active.length; iter++) {
    const wsum = active.reduce((s, id) => s + weight.get(id)!, 0);
    let spent = 0;
    const next: string[] = [];
    for (const id of active) {
      const cur = cost.get(id)!;
      const give = Math.min(remaining * (weight.get(id)! / wsum), perLegCap - cur);
      cost.set(id, cur + give);
      spent += give;
      if (perLegCap - (cur + give) > 1e-9) next.push(id); // still has room
    }
    remaining -= spent;
    active = next;
    if (spent < 1e-9) break;
  }
  const legs: PlacedLeg[] = selected
    .filter((e) => (cost.get(e.c.id) ?? 0) > 0.01)
    .map((e) => {
      const c = Number(cost.get(e.c.id)!.toFixed(2));
      return {
        id: e.c.id, marketTitle: e.c.marketTitle, title: e.c.title, side: e.c.side,
        q: e.q, pWin: e.a, pFail: e.f, dimension: e.c.dimension, mechanism: e.c.mechanism, mechType: e.c.mechType,
        costUsd: c, shares: Number((c / e.q).toFixed(2)), edgeWin: e.edgeWin, edgeFail: e.edgeFail, tier: e.tier,
        marginal: e.c.marginal, venue: e.c.venue,
      };
    });

  const totalCost = legs.reduce((s, l) => s + l.costUsd, 0);
  // Conditional expectations from the legs' stated probabilities (honest about engine belief).
  const winLegPnl = legs.reduce((s, l) => s + l.costUsd * (l.pWin / l.q - 1), 0);
  const failLegPnl = legs.reduce((s, l) => s + l.costUsd * (l.pFail / l.q - 1), 0);
  const winPnl = W + winLegPnl;
  const failPnl = -S + failLegPnl;
  const strictWorst = -(S + totalCost); // anchor fails, no leg pays
  const bestCase = W + legs.reduce((s, l) => s + l.costUsd * (1 / l.q - 1), 0); // anchor wins, all legs pay
  const nakedEv = pi * W + (1 - pi) * (-S);
  // Honesty backbone: never DISPLAY a better-than-market EV. The UNCONDITIONAL EV uses each leg's MARKET
  // marginal (de-vigged fair pay-rate) — NOT the optimistic elicited conditionals — because buying a
  // vig-priced leg (q ≥ marginal) can only LOWER unconditional EV: each contributes cost·(marginal/q − 1)
  // ≤ 0. (winPnl/failPnl above keep the engine's CONDITIONAL beliefs for the scenario display.) Using the
  // raw conditionals here would let LLM optimism imply a positive EV that the clamp then masks as exactly
  // naked (e.g. $0), making a vig-costing hedge look "free". Falls back to the conditional-implied marginal
  // when no market marginal is attached (e.g. direct unit-test legs); still clamped at naked.
  const legUncondEv = legs.reduce((s, l) => {
    const marginal = l.marginal ?? (pi * l.pWin + (1 - pi) * l.pFail);
    return s + Math.min(0, l.costUsd * (marginal / l.q - 1));
  }, 0);
  const ev = Math.min(nakedEv + legUncondEv, nakedEv);
  const coherent = legs.length > 0 && (
    mode === "aggressive" ? legs.every((l) => l.pWin > l.pFail)
      : mode === "conservative" ? legs.every((l) => l.pFail > l.pWin)
        : legs.every((l) => (lambda >= 0.5 ? l.pWin > l.pFail : l.pFail > l.pWin)));

  // Combo tier = its WEAKEST leg (any MODELED ⇒ MODELED; all ANALYTIC ⇒ ANALYTIC).
  const tier: Tier = legs.length === 0 || legs.some((l) => l.tier === "MODELED") ? "MODELED"
    : legs.some((l) => l.tier === "CALIBRATED") ? "CALIBRATED" : "ANALYTIC";

  return {
    direction: lambda, mode, legs, tier,
    totalCostUsd: Number(totalCost.toFixed(2)),
    winPnlUsd: Number(winPnl.toFixed(2)),
    failPnlUsd: Number(failPnl.toFixed(2)),
    nakedWinPnlUsd: Number(W.toFixed(2)),
    nakedFailPnlUsd: Number((-S).toFixed(2)),
    strictWorstUsd: Number(strictWorst.toFixed(2)),
    bestCaseUsd: Number(bestCase.toFixed(2)),
    evUsd: Number(ev.toFixed(4)),
    nakedEvUsd: Number(nakedEv.toFixed(4)),
    coherent,
  };
}
