import snapshot from "./relationCorrection.json";

export interface ScoredExample { mechanismType: string; predFail: number; goldFail: number; predWin: number; goldWin: number }
/** sdFail/sdWin: sample standard deviation of the per-mechanism residuals (gold - pred). Optional so the
 *  pre-existing JSON snapshot (which lacks them) still loads cleanly. */
export interface Correction { biasFail: number; biasWin: number; n: number; sdFail?: number; sdWin?: number }
export type CorrectionMap = Map<string, Correction>;

/** Reliability-shrink coefficient: a thin bucket's bias is pulled toward 0 by n/(n+K) so we don't over-trust
 *  a handful of rows (e.g. IMPLICATION n=11 keeps ~58% of its bias, not 100%). */
const RELIABILITY_K = 8;

/** Load the committed gold-derived correction snapshot into a CorrectionMap (keys uppercased to match
 *  the mechanismType enum). Empty `byMechanismType` ⇒ empty map ⇒ applyCorrection is a no-op.
 *  Reads sdFail/sdWin when present (older snapshots omit them). */
export function loadCorrectionMap(): CorrectionMap {
  const by = (snapshot as { byMechanismType?: Record<string, Correction> }).byMechanismType ?? {};
  const out: CorrectionMap = new Map();
  for (const [mech, c] of Object.entries(by)) {
    const entry: Correction = { biasFail: c.biasFail, biasWin: c.biasWin, n: c.n };
    if (typeof c.sdFail === "number") entry.sdFail = c.sdFail;
    if (typeof c.sdWin === "number") entry.sdWin = c.sdWin;
    out.set(mech.toUpperCase(), entry);
  }
  return out;
}

/** Mean (gold - predicted) per mechanismType, only for buckets with >= minSamples. source: "gold".
 *  Also records sdFail/sdWin = sample standard deviation of the residuals (n-1 denom; 0 for a single row). */
export function buildCorrectionFromGold(examples: ScoredExample[], minSamples = 8): CorrectionMap {
  const groups = new Map<string, ScoredExample[]>();
  for (const e of examples) groups.set(e.mechanismType, [...(groups.get(e.mechanismType) ?? []), e]);
  const out: CorrectionMap = new Map();
  for (const [mech, rows] of groups) {
    if (rows.length < minSamples) continue;
    const mean = (f: (e: ScoredExample) => number) => rows.reduce((s, e) => s + f(e), 0) / rows.length;
    const sampleSd = (f: (e: ScoredExample) => number, m: number) =>
      rows.length < 2 ? 0 : Math.sqrt(rows.reduce((s, e) => s + (f(e) - m) ** 2, 0) / (rows.length - 1));
    const resFail = (e: ScoredExample) => e.goldFail - e.predFail;
    const resWin = (e: ScoredExample) => e.goldWin - e.predWin;
    const biasFail = mean(resFail);
    const biasWin = mean(resWin);
    out.set(mech, {
      biasFail, biasWin, n: rows.length,
      sdFail: sampleSd(resFail, biasFail),
      sdWin: sampleSd(resWin, biasWin),
    });
  }
  return out;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
/** MODELED-only nudge of elicited conditionals toward gold-consistent values. Never sets a tier/provenance.
 *  The applied bias is reliability-shrunk by n/(n+K) so thin buckets contribute proportionally less. */
export function applyCorrection(
  elicited: { pGivenAnchorWins: number; pGivenAnchorFails: number },
  mechanismType: string,
  corrections: CorrectionMap,
  shrink = 0.5,
): { pGivenAnchorWins: number; pGivenAnchorFails: number } {
  const c = corrections.get(mechanismType);
  if (!c) return elicited;
  const reliability = c.n / (c.n + RELIABILITY_K);
  return {
    pGivenAnchorWins: clamp01(elicited.pGivenAnchorWins + shrink * reliability * c.biasWin),
    pGivenAnchorFails: clamp01(elicited.pGivenAnchorFails + shrink * reliability * c.biasFail),
  };
}
