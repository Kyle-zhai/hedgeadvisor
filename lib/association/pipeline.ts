import type { ConditionalCounts, MarketRuleInput, OptimizerCandidate, RobustOptimizerInput } from "./types";
import { calibrateConditionalPayoff } from "./calibration";
import { analyzeRelationWithQwen, type QwenRelationResult } from "./qwen";
import { optimizeRobustHedge } from "./optimizer";

export interface HybridCandidateInput {
  id: string;
  label: string;
  venue: "polymarket" | "kalshi";
  side: "yes" | "no";
  price: number;
  maxSpendUsd?: number;
  market: MarketRuleInput;
  counts?: ConditionalCounts;
  /** Set only after deterministic rule validation outside the LLM. */
  structuralCoverage?: "ALL_ANCHOR_FAIL_STATES";
}

export interface HybridAssociationInput extends Omit<RobustOptimizerInput, "candidates"> {
  anchor: MarketRuleInput;
  candidates: HybridCandidateInput[];
  credibleLevel?: number;
  minSamplesPerBranch?: number;
  analyzeWithLlm?: boolean;
}

export async function buildHybridHedgeRecommendation(input: HybridAssociationInput) {
  const credibleLevel = input.credibleLevel ?? 0.95;
  const minSamples = input.minSamplesPerBranch ?? 20;
  const llmEnabled = input.analyzeWithLlm !== false;

  const prepared: OptimizerCandidate[] = input.candidates.map((candidate) => {
    const calibration = candidate.counts
      ? calibrateConditionalPayoff(candidate.counts, credibleLevel, minSamples)
      : undefined;
    return {
      id: candidate.id,
      label: candidate.label,
      venue: candidate.venue,
      side: candidate.side,
      price: candidate.price,
      maxSpendUsd: candidate.maxSpendUsd,
      structuralCoverage: candidate.structuralCoverage,
      provenance: candidate.structuralCoverage ? "ANALYTIC" : calibration ? "CALIBRATED" : "HYPOTHESIS",
      calibration,
    };
  });

  const relations: Array<{ candidateId: string; result: QwenRelationResult }> = llmEnabled
    ? await Promise.all(
        input.candidates.map(async (candidate) => ({
          candidateId: candidate.id,
          result: await analyzeRelationWithQwen(input.anchor, candidate.market),
        })),
      )
    : input.candidates.map((candidate) => ({
        candidateId: candidate.id,
        result: { status: "disabled", model: process.env.QWEN_RELATION_MODEL ?? "qwen-plus", reason: "LLM analysis disabled by request" },
      }));

  const optimization = optimizeRobustHedge({
    stakeUsd: input.stakeUsd,
    primaryPrice: input.primaryPrice,
    keepFraction: input.keepFraction,
    conservatism: input.conservatism,
    maxLegs: input.maxLegs,
    candidates: prepared,
  });

  return {
    anchor: input.anchor,
    relations,
    calibratedCandidates: prepared,
    optimization,
    safeguards: {
      llmCanSetCorrelation: false,
      llmCanAuthorizeTrade: false,
      hypothesesWithoutCalibrationRejected: true,
      strictWorstCaseSeparatelyReported: true,
    },
  };
}
