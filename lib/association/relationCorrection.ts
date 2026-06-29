import snapshot from "./relationCorrection.json";

export interface ScoredExample { mechanismType: string; predFail: number; goldFail: number; predWin: number; goldWin: number }
export interface Correction { biasFail: number; biasWin: number; n: number }
export type CorrectionMap = Map<string, Correction>;

/** Load the committed gold-derived correction snapshot into a CorrectionMap (keys uppercased to match
 *  the mechanismType enum). Empty `byMechanismType` ⇒ empty map ⇒ applyCorrection is a no-op. */
export function loadCorrectionMap(): CorrectionMap {
  const by = (snapshot as { byMechanismType?: Record<string, Correction> }).byMechanismType ?? {};
  const out: CorrectionMap = new Map();
  for (const [mech, c] of Object.entries(by)) out.set(mech.toUpperCase(), c);
  return out;
}

/** Mean (gold - predicted) per mechanismType, only for buckets with >= minSamples. source: "gold". */
export function buildCorrectionFromGold(examples: ScoredExample[], minSamples = 8): CorrectionMap {
  const groups = new Map<string, ScoredExample[]>();
  for (const e of examples) groups.set(e.mechanismType, [...(groups.get(e.mechanismType) ?? []), e]);
  const out: CorrectionMap = new Map();
  for (const [mech, rows] of groups) {
    if (rows.length < minSamples) continue;
    const mean = (f: (e: ScoredExample) => number) => rows.reduce((s, e) => s + f(e), 0) / rows.length;
    out.set(mech, { biasFail: mean((e) => e.goldFail - e.predFail), biasWin: mean((e) => e.goldWin - e.predWin), n: rows.length });
  }
  return out;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** MODELED-only nudge of elicited conditionals toward gold-consistent values. Never sets a tier/provenance. */
export function applyCorrection(
  elicited: { pGivenAnchorWins: number; pGivenAnchorFails: number },
  mechanismType: string,
  corrections: CorrectionMap,
  shrink = 0.5,
): { pGivenAnchorWins: number; pGivenAnchorFails: number } {
  const c = corrections.get(mechanismType);
  if (!c) return elicited;
  return {
    pGivenAnchorWins: clamp01(elicited.pGivenAnchorWins + shrink * c.biasWin),
    pGivenAnchorFails: clamp01(elicited.pGivenAnchorFails + shrink * c.biasFail),
  };
}
