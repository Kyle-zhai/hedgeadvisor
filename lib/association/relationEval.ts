// lib/association/relationEval.ts
import type { GoldRelation } from "./relationGold";

export type Sign = "POSITIVE" | "NEGATIVE" | "AMBIGUOUS";
export interface PredictedRelation {
  relation?: string;
  direction?: string;            // model's stated direction (may disagree with its own conditionals)
  mechanismType?: string;
  pGivenAnchorWins?: number;
  pGivenAnchorFails?: number;
}
export interface RelationScore {
  relationType: string;
  signCorrect: boolean;
  mechanismMatch: boolean;
  relationMatch: boolean;
  condAbsErrFail: number;
  condAbsErrWin: number;
  judged: boolean;               // false when the model returned no usable conditionals
}

const EPS = 0.02;
export function signOf(pWins?: number, pFails?: number): Sign {
  if (pWins == null || pFails == null) return "AMBIGUOUS";
  if (pFails > pWins + EPS) return "NEGATIVE";
  if (pWins > pFails + EPS) return "POSITIVE";
  return "AMBIGUOUS";
}

export function scoreRelation(gold: GoldRelation, pred: PredictedRelation): RelationScore {
  const judged = pred.pGivenAnchorWins != null && pred.pGivenAnchorFails != null;
  const predSign = signOf(pred.pGivenAnchorWins, pred.pGivenAnchorFails);
  return {
    relationType: gold.relationType,
    signCorrect: judged && predSign === gold.label.direction,
    mechanismMatch: (pred.mechanismType ?? "").toUpperCase() === gold.label.mechanismType,
    relationMatch: (pred.relation ?? "").toUpperCase() === gold.label.relation,
    condAbsErrFail: judged ? Math.abs((pred.pGivenAnchorFails as number) - gold.label.pGivenAnchorFails) : 1,
    condAbsErrWin: judged ? Math.abs((pred.pGivenAnchorWins as number) - gold.label.pGivenAnchorWins) : 1,
    judged,
  };
}

export interface AggMetrics { n: number; judged: number; signAccuracy: number; mechanismAccuracy: number; relationAccuracy: number; condMAE: number }
function agg(rows: RelationScore[]): AggMetrics {
  const n = rows.length;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
  return {
    n, judged: rows.filter((r) => r.judged).length,
    signAccuracy: mean(rows.map((r) => (r.signCorrect ? 1 : 0))),
    mechanismAccuracy: mean(rows.map((r) => (r.mechanismMatch ? 1 : 0))),
    relationAccuracy: mean(rows.map((r) => (r.relationMatch ? 1 : 0))),
    condMAE: mean(rows.filter((r) => r.judged).flatMap((r) => [r.condAbsErrFail, r.condAbsErrWin])),
  };
}
export function aggregateScores(rows: RelationScore[]): { overall: AggMetrics; byType: Record<string, AggMetrics> } {
  const byType: Record<string, AggMetrics> = {};
  const types = [...new Set(rows.map((r) => r.relationType))];
  for (const t of types) byType[t] = agg(rows.filter((r) => r.relationType === t));
  return { overall: agg(rows), byType };
}
