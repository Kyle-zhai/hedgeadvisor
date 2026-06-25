import type {
  OptimizerCandidate,
  RobustAllocation,
  RobustOptimizerInput,
  RobustOptimizerResult,
} from "./types";

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const round = (x: number) => Number(x.toFixed(4));

interface RankedCandidate {
  candidate: OptimizerCandidate;
  pFail: number;
  pWin: number;
  reductionPerDollar: number;
  specificity: number;
  uncertainty: number;
  score: number;
}

/**
 * Exact optimizer for the stated separable robust objective. Each dollar allocated to leg i changes
 * modeled loss conditional on anchor failure by 1 - P(pay|fail)/price. With a single budget and hard
 * per-leg capacity limits, sorting those constant marginal benefits is the exact fractional-knapsack
 * solution. No local-search or discretization error is introduced.
 *
 * Strict worst-case is reported separately: a calibrated leg may pay zero in an adversarial state and
 * therefore cannot claim deterministic max-loss reduction. Only verified ALL_FAIL_STATES legs can.
 */
export function optimizeRobustHedge(input: RobustOptimizerInput): RobustOptimizerResult {
  const stake = Math.max(0, input.stakeUsd);
  const primaryPrice = clamp01(input.primaryPrice);
  const keep = clamp01(input.keepFraction);
  const c = clamp01(input.conservatism);
  const maxLegs = Math.max(1, Math.floor(input.maxLegs ?? 3));
  const maxSoftLegs = Math.max(0, Math.floor(input.maxCalibratedSoftLegs ?? 1));
  const profit = primaryPrice > 1e-9 ? stake * (1 - primaryPrice) / primaryPrice : 0;
  const budget = Math.max(0, (1 - keep) * profit);
  const rejected: RobustOptimizerResult["rejected"] = [];
  const ranked: RankedCandidate[] = [];

  for (const candidate of input.candidates) {
    const price = candidate.price;
    if (!(price > 0 && price < 1)) {
      rejected.push({ candidateId: candidate.id, reason: "invalid executable price" });
      continue;
    }
    let pFail: number;
    let pWin: number;
    let uncertainty = 0;
    if (candidate.structuralCoverage === "ALL_ANCHOR_FAIL_STATES" && candidate.provenance === "ANALYTIC") {
      pFail = 1;
      pWin = 0;
    } else if (candidate.provenance === "ANALYTIC" && candidate.structuralPayoff) {
      // Logically-certain leg that does NOT cover all fail states (exclusive rival, subset). Its
      // conditional payoff is derived from the rules + current prices, so it is admissible at launch
      // without settlement calibration. No uncertainty penalty (it is structural, not estimated).
      if (c >= 0.98) {
        rejected.push({ candidateId: candidate.id, reason: "strictest posture accepts verified ALL-fail-state coverage only" });
        continue;
      }
      pFail = clamp01(candidate.structuralPayoff.payGivenFail);
      pWin = clamp01(candidate.structuralPayoff.payGivenWin);
    } else if (candidate.provenance === "CALIBRATED" && candidate.calibration) {
      if (c >= 0.98) {
        rejected.push({ candidateId: candidate.id, reason: "strictest posture accepts verified structural coverage only" });
        continue;
      }
      const cal = candidate.calibration;
      if (!cal.sufficientEvidence) {
        rejected.push({ candidateId: candidate.id, reason: "insufficient settled observations in one or both anchor branches" });
        continue;
      }
      const fail = cal.payGivenAnchorFails;
      const win = cal.payGivenAnchorPays;
      pFail = fail.mean - c * (fail.mean - fail.lower);
      pWin = win.mean + c * (win.upper - win.mean);
      uncertainty = (fail.upper - fail.lower) + (win.upper - win.lower);
      // FRÉCHET FEASIBILITY: a leg cannot pay MORE often conditional on the anchor failing than its own
      // marginal allows — P(pay|fail) ≤ P(pay)/P(fail). A coarse settlement bucket (learned from genuine
      // 2-way exclusives) would otherwise claim a tiny-marginal candidate (a longshot "rival" of a
      // multi-way field) is a near-certain hedge. The executable price bounds the de-vigged marginal, so
      // clamp the conditional payoff to the candidate's own probability mass. Mirrors the combo path's clamp.
      const anchorFailP = Math.max(0.02, 1 - primaryPrice);
      pFail = Math.min(pFail, Math.min(1, price / anchorFailP));
      pWin = Math.max(pWin, Math.max(0, (price - anchorFailP) / Math.max(0.02, primaryPrice)));
      // At the strict end, a soft leg must remain hedge-specific across the full credible interval.
      if (c >= 0.8 && cal.hedgeSpecificityLower <= 0) {
        rejected.push({ candidateId: candidate.id, reason: "credible intervals do not prove the leg pays more often when the anchor fails" });
        continue;
      }
    } else {
      rejected.push({ candidateId: candidate.id, reason: "LLM/semantic hypothesis has no calibrated payoff evidence" });
      continue;
    }
    const reductionPerDollar = pFail / price - 1;
    const specificity = pFail - pWin;
    // Uncertainty and payout-in-win are ranking penalties, never substitutes for the actual fail payoff.
    const score = reductionPerDollar + 0.2 * specificity - 0.15 * c * uncertainty;
    if (reductionPerDollar <= 1e-9) {
      rejected.push({ candidateId: candidate.id, reason: "worst-adjusted expected payout does not offset its executable cost" });
      continue;
    }
    if (specificity <= 0 && candidate.provenance !== "ANALYTIC") {
      rejected.push({ candidateId: candidate.id, reason: "candidate is not hedge-specific after conservatism adjustment" });
      continue;
    }
    ranked.push({ candidate, pFail, pWin, reductionPerDollar, specificity, uncertainty, score });
  }

  ranked.sort((a, b) => b.score - a.score || b.reductionPerDollar - a.reductionPerDollar || a.candidate.id.localeCompare(b.candidate.id));
  const allocations: RobustAllocation[] = [];
  let remainingBudget = budget;
  let remainingModeledLoss = stake;
  let strictWorstLoss = stake;
  let calibratedSoftLegs = 0;
  const usedGroups = new Set<string>();

  for (const r of ranked) {
    if (allocations.length >= maxLegs) break;
    if (remainingBudget <= 1e-9 || remainingModeledLoss <= 1e-9) break;
    const isSoft = r.candidate.provenance === "CALIBRATED";
    if (isSoft && calibratedSoftLegs >= maxSoftLegs) {
      rejected.push({ candidateId: r.candidate.id, reason: "joint soft-leg model unavailable; only the best calibrated soft leg is admitted" });
      continue;
    }
    if (r.candidate.associationGroup && usedGroups.has(r.candidate.associationGroup)) {
      rejected.push({ candidateId: r.candidate.id, reason: "a better execution alternative from the same association group was selected" });
      continue;
    }
    const cap = Math.max(0, r.candidate.maxSpendUsd ?? remainingBudget);
    // Never spend past modeled break-even: x * marginal reduction <= remaining loss.
    const neutralizingSpend = remainingModeledLoss / r.reductionPerDollar;
    const spend = Math.min(remainingBudget, cap, neutralizingSpend);
    if (spend <= 1e-9) continue;
    const modeledReduction = spend * r.reductionPerDollar;
    remainingModeledLoss = Math.max(0, remainingModeledLoss - modeledReduction);
    remainingBudget -= spend;
    if (r.candidate.structuralCoverage === "ALL_ANCHOR_FAIL_STATES" && r.candidate.provenance === "ANALYTIC") {
      strictWorstLoss = Math.max(0, strictWorstLoss - modeledReduction);
    } else {
      // A soft leg can pay zero in a possible state; its premium then increases the true worst loss.
      strictWorstLoss += spend;
    }
    allocations.push({
      candidateId: r.candidate.id,
      label: r.candidate.label,
      venue: r.candidate.venue,
      side: r.candidate.side,
      spendUsd: round(spend),
      shares: round(spend / r.candidate.price),
      effectivePayGivenFail: round(r.pFail),
      effectivePayGivenWin: round(r.pWin),
      modeledLossReductionUsd: round(modeledReduction),
      provenance: r.candidate.provenance,
    });
    if (isSoft) calibratedSoftLegs++;
    if (r.candidate.associationGroup) usedGroups.add(r.candidate.associationGroup);
  }

  const spend = allocations.reduce((sum, a) => sum + a.spendUsd, 0);
  return {
    status: allocations.length ? "RECOMMEND" : "NO_ACTION",
    reason: allocations.length
      ? "Selected by conservative conditional-payoff benefit after executable cost; strict worst-case is kept separate."
      : "No candidate remains beneficial after evidence, uncertainty, price, and liquidity gates.",
    conservatism: c,
    budgetUsd: round(budget),
    spendUsd: round(spend),
    keepIfPrimaryWinsFloorUsd: round(Math.max(0, profit - spend)),
    modeledLossIfPrimaryFailsUsd: round(remainingModeledLoss),
    strictWorstLossIfPrimaryFailsUsd: round(strictWorstLoss),
    allocations,
    rejected,
  };
}
