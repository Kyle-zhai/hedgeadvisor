/**
 * lib/correlation/relation.ts — the φ-based relation engine (spec Stages 3–5).
 *
 * Every binary↔binary relationship reduces to ONE quantity, the joint probability P(A∩B). From it,
 * the phi coefficient (binary Pearson correlation) is analytic, and so are the optimal hedge ratio,
 * the hedge effectiveness (R² = φ²), and the directional hedge signal. We never fabricate a joint:
 * it comes from structure when derivable (exclusive→0, subset→min), else from a STATED, Fréchet-
 * clamped estimate, else independence. A joint that leaves the Fréchet–Hoeffding box is impossible,
 * so we clamp it and DOWNGRADE confidence — that is the engine's reliability backstop.
 */
import { corrFromJoint } from "./structural";

export type RelationType = "same" | "related" | "mutually_exclusive" | "independent";
export type HedgeSignal = "same_exposure" | "hedge" | "diversify";
export type Confidence = "high" | "medium" | "low";
export type RelationMethod = "structural" | "frechet_estimate" | "independence";

export interface EventRelation {
  relation: RelationType;
  correlation: number; // φ ∈ [−1, 1]
  pAB: number; // estimated joint P(A∩B)
  frechet: [number, number]; // the Fréchet–Hoeffding feasible box for P(A∩B)
  frechetViolated: boolean; // the input joint had to be clamped into the box (an unreliability flag)
  hedgeSignal: HedgeSignal;
  hedgeRatio: number; // N_B*/N_A — signed optimal min-variance hedge ratio (− ⇒ take the opposite side of B)
  effectiveness: number; // φ² — fraction of variance the optimal hedge removes
  confidence: Confidence;
  reasoning: string; // one-line Chinese explanation
  method: RelationMethod;
}

const SIGNAL_TAU = 0.1; // |φ| below this ⇒ diversify (B can't meaningfully move with A)
const RELATED_TAU = 0.05; // |φ| below this ⇒ independent
const EXTREME_LO = 0.02; // marginal in (0,EXTREME_LO)∪(1−EXTREME_LO,1) ⇒ φ numerically unstable

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const sigma = (p: number) => Math.sqrt(clamp01(p) * (1 - clamp01(p)));

/** Fréchet–Hoeffding bounds: the exact feasible range of P(A∩B) given the marginals. */
export function frechetBounds(pA: number, pB: number): [number, number] {
  return [Math.max(0, pA + pB - 1), Math.min(pA, pB)];
}

/** Joint implied by a correlation φ, clamped into the feasible Fréchet box. */
export function jointFromPhi(pA: number, pB: number, phi: number): { pAB: number; clamped: boolean } {
  const raw = pA * pB + phi * sigma(pA) * sigma(pB);
  const [lo, hi] = frechetBounds(pA, pB);
  const pAB = Math.min(hi, Math.max(lo, raw));
  return { pAB, clamped: raw < lo - 1e-9 || raw > hi + 1e-9 };
}

/** Signed optimal min-variance hedge ratio (N_B over N_A) = −φ·σ_A/σ_B. */
export function optimalHedgeRatio(phi: number, pA: number, pB: number): number {
  const sB = sigma(pB);
  if (sB <= 1e-9) return 0;
  return -phi * (sigma(pA) / sB);
}

export function hedgeSignalFor(phi: number): HedgeSignal {
  if (phi > SIGNAL_TAU) return "same_exposure";
  if (phi < -SIGNAL_TAU) return "hedge";
  return "diversify";
}

function classify(phi: number, pAB: number, pA: number, pB: number): RelationType {
  if (pAB <= Math.max(1e-4, 0.02 * Math.min(pA, pB)) && phi < 0) return "mutually_exclusive";
  if (phi >= 0.97 && Math.abs(pAB - Math.min(pA, pB)) < 0.02) return "same";
  if (Math.abs(phi) < RELATED_TAU) return "independent";
  return "related";
}

export interface RelationInput {
  pA: number;
  pB: number;
  /** Path 甲: a structurally-derived joint (exclusive ⇒ 0, subset ⇒ min). Highest trust. */
  structuralJoint?: number;
  structuralKind?: "exclusive" | "same-outcome" | "subset";
  /** Path 乙: an illustrative/stated ρ to imply the joint when nothing structural applies.
   *  NOTE: price co-movement is NEVER fed here — it is not the settlement correlation. The settled
   *  relationship comes from lib/association (conditional payoff calibration on resolved outcomes). */
  estimateRho?: number;
  /** Confidence inputs. */
  liquidityOk?: boolean;
  labelA?: string;
  labelB?: string;
}

function scoreConfidence(method: RelationMethod, frechetViolated: boolean, extreme: boolean, liquidityOk: boolean | undefined): Confidence {
  let score = method === "structural" ? 3 : 1;
  if (frechetViolated) score -= 2;
  if (extreme) score -= 1;
  if (liquidityOk === false) score -= 1;
  return score >= 3 ? "high" : score >= 1 ? "medium" : "low";
}

function reasoningFor(rel: RelationType, phi: number, signal: HedgeSignal, ratio: number, eff: number, a: string, b: string): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const r2 = `${Math.round(eff * 100)}%`;
  const phiStr = `${phi >= 0 ? "+" : ""}${phi.toFixed(2)}`;
  if (rel === "mutually_exclusive")
    return `「${a}」与「${b}」互斥（不可能同时为真，φ=${phiStr}）；买「${b}」会在你输掉「${a}」时赔付，是天然对冲，但只能消除约 ${r2} 的风险。`;
  if (rel === "same")
    return `「${a}」与「${b}」几乎是同一结果（φ=${phiStr}）；它们同生共死，不能互相对冲。`;
  if (rel === "independent")
    return `「${a}」与「${b}」基本独立（φ=${phiStr}）；「${b}」帮不上对冲，但可用于分散。`;
  // related
  if (signal === "same_exposure") {
    const side = ratio < 0 ? `买 No-${b} 约 ${Math.abs(ratio).toFixed(2)}:1` : `反向操作约 ${ratio.toFixed(2)}:1`;
    return `「${a}」与「${b}」同向暴露（φ=${phiStr}），风险在叠加而非分散；若要对冲需${side}，但只能消除约 ${r2} 的波动。`;
  }
  // related + negative φ ⇒ natural hedge
  return `「${a}」与「${b}」负相关（φ=${phiStr}）；买 Yes-${b} 约 ${Math.abs(ratio).toFixed(2)}:1 能对冲「${a}」，消除约 ${r2} 的波动。`;
}

/**
 * Build the full EventRelation for a pair, choosing the joint-estimation method by the data
 * available (structural → stated-ρ estimate → independence) and deriving φ, the hedge
 * signal/ratio, effectiveness, and confidence from it. (Price co-movement is NEVER a method here.)
 */
export function buildEventRelation(input: RelationInput): EventRelation {
  const pA = clamp01(input.pA);
  const pB = clamp01(input.pB);
  const frechet = frechetBounds(pA, pB);
  const extreme = pA < EXTREME_LO || pA > 1 - EXTREME_LO || pB < EXTREME_LO || pB > 1 - EXTREME_LO;
  const a = input.labelA ?? "A";
  const b = input.labelB ?? "B";

  let pAB: number;
  let method: RelationMethod;
  let frechetViolated = false;

  if (input.structuralJoint !== undefined) {
    // Path 甲 — exact, derived from market structure.
    pAB = Math.min(frechet[1], Math.max(frechet[0], input.structuralJoint));
    method = "structural";
  } else if (input.estimateRho !== undefined) {
    // Path 乙 — stated/illustrative ρ, Fréchet-clamped.
    const j = jointFromPhi(pA, pB, input.estimateRho);
    pAB = j.pAB;
    frechetViolated = j.clamped;
    method = "frechet_estimate";
  } else {
    // No information ⇒ assume independence (φ = 0).
    pAB = pA * pB;
    method = "independence";
  }

  const phi = Number(corrFromJoint(pA, pB, pAB).toFixed(4));
  const relation = classify(phi, pAB, pA, pB);
  const hedgeSignal = hedgeSignalFor(phi);
  const hedgeRatio = Number(optimalHedgeRatio(phi, pA, pB).toFixed(3));
  const effectiveness = Number((phi * phi).toFixed(4));
  // independence is a genuine no-information default, not a strong claim ⇒ at most medium.
  let confidence = scoreConfidence(method, frechetViolated, extreme, input.liquidityOk);
  if (method === "independence" && confidence === "high") confidence = "medium";

  return {
    relation,
    correlation: phi,
    pAB: Number(pAB.toFixed(4)),
    frechet: [Number(frechet[0].toFixed(4)), Number(frechet[1].toFixed(4))],
    frechetViolated,
    hedgeSignal,
    hedgeRatio,
    effectiveness,
    confidence,
    reasoning: reasoningFor(relation, phi, hedgeSignal, hedgeRatio, effectiveness, a, b),
    method,
  };
}
