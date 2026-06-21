/**
 * lib/combo/combo.ts — "Combo Truth Check": the honest math behind a multi-leg parlay.
 *
 * A combo/parlay pays $1 only if ALL legs hit. The honest questions this answers:
 *  - What does it ACTUALLY cost to assemble (legging in at the real executable price)?
 *  - What is it actually WORTH (product of de-vigged leg probabilities)?
 *  - How big is the COMPOUNDED vig (it stacks multiplicatively with each leg)?
 *  - If you were quoted a combo price (e.g. Polymarket Combos RFQ), is the "discount" real
 *    (cheaper than legging in yourself) or illusory?
 *
 * Honesty backbone: EV is ALWAYS shown negative; independence is assumed for the joint
 * probability and that assumption is flagged (correlated legs make it worse, not better).
 * Pure function — no I/O — so it is unit-tested in isolation.
 */

import type { JointEstimate } from "@/lib/estimate";
import { buildEventRelation, type EventRelation } from "@/lib/correlation";
import type { StructuralJoint } from "./structuralJoint";

export interface PricedComboLeg {
  title: string; // outcome label, e.g. "England"
  marketTitle: string; // the market/event it belongs to
  side: "yes" | "no";
  q: number; // de-vigged probability THIS leg hits (0..1)
  price: number; // executable per-share price you actually pay (0..1)
  deepLink: string;
  capacityHit?: boolean;
  /** Marginal probability band (lo/mid/hi) from de-vig method disagreement; for display. */
  band?: { lo: number; mid: number; hi: number };
}

export interface ComboQuoteCheck {
  quotedCents: number; // the combo price you were quoted, per $1 payout
  buildCents: number; // legging-in cost, per $1 payout
  diffCents: number; // quoted − build (negative = cheaper than DIY)
  realDiscount: boolean; // quoted strictly cheaper than building it yourself
  beatsFair: boolean; // quoted below fair value (would be +EV — essentially never)
  note: string;
}

export interface ComboResult {
  legs: PricedComboLeg[];
  comboProb: number; // Π q (independence) — also the fair per-$1 price
  buildPriceCents: number; // Π price, in cents per $1 payout
  fairPriceCents: number; // Π q, in cents per $1 payout
  compoundedVigCents: number; // build − fair (the stacked vig you eat)
  payoutMultiple: number; // 1 / buildPrice (what $1 staked returns if all hit)
  stakeUsd: number;
  expectedValueUsd: number; // honest, negative
  maxGainUsd: number;
  maxLossUsd: number;
  pProfit: number; // = comboProb
  verdict: "CAUTION" | "HIGH_RISK";
  verdictReason: string;
  quote?: ComboQuoteCheck;
  /** Cross-market joint estimate (independence + exact Fréchet range + illustrative ρ). */
  jointEstimate?: JointEstimate;
  /** EXACT structural joint when derivable (subset/exclusivity), supersedes the estimate. */
  structuralJoint?: StructuralJoint;
  /** For a 2-leg combo: the full φ-based relation (correlation, optimal hedge ratio, effectiveness). */
  relation?: EventRelation;
  warnings: string[];
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const r2 = (x: number) => Number(x.toFixed(2));
const product = (xs: number[]) => xs.reduce((a, b) => a * b, 1);

export interface BuildComboOpts {
  stakeUsd?: number;
  /** Optional quoted combo price per $1 payout, as a FRACTION (0..1). */
  quotedComboPrice?: number;
  /** True when ≥2 YES legs sit in the SAME market (mutually exclusive → can never all hit). */
  mutuallyExclusive?: boolean;
  /** Cross-market joint estimate computed by the caller (independence + Fréchet range + ρ point). */
  jointEstimate?: JointEstimate;
  /** EXACT structural joint computed by the caller (subset/containment or exclusivity). */
  structuralJoint?: StructuralJoint;
}

export function buildCombo(legs: PricedComboLeg[], opts: BuildComboOpts = {}): ComboResult {
  const stakeUsd = Math.max(1, opts.stakeUsd ?? 20);
  const clean = legs.map((l) => ({ ...l, q: clamp01(l.q), price: clamp01(l.price) }));

  // Impossible if mutually exclusive (gate) OR a structural detector proved P(joint)=0.
  const impossible = opts.mutuallyExclusive || opts.structuralJoint?.p === 0;
  // Subset/containment: the parlay is EXACTLY its narrower (dominant) leg — "all hit" ⟺ that one
  // leg hits, so the true chance is P(narrow), not the lower independent product. The
  // product-of-prices build cost is INVALID for nested legs (it implies a phantom edge), so we
  // collapse the headline math onto the narrow leg: its real price, its exact probability. This
  // keeps the top-line chance equal to the exact-joint card and the EV honestly ≤ 0 (just that
  // leg's own vig). Detector gates subset to exactly 2 legs, so argmin q is unambiguous.
  const subsetP = !impossible && opts.structuralJoint?.kind === "subset" ? opts.structuralJoint.p : undefined;
  const narrow = subsetP !== undefined ? clean.reduce((a, b) => (b.q < a.q ? b : a)) : undefined;

  const buildPrice =
    narrow !== undefined
      ? clamp01(Math.max(narrow.price, subsetP!)) // can't pay below fair on a real book
      : clamp01(product(clean.map((l) => l.price)) || 0); // Π executable price
  // An impossible combo can NEVER pay → true joint 0. A subset collapses to the exact P(narrow).
  const fairPrice = impossible ? 0 : narrow !== undefined ? clamp01(subsetP!) : clamp01(product(clean.map((l) => l.q))); // = comboProb
  const comboProb = fairPrice;
  const payoutMultiple = impossible ? 0 : buildPrice > 1e-6 ? 1 / buildPrice : 0;

  // EV per $1 = comboProb * payoutMultiple − 1 = fair/build − 1. Clamped ≤ 0: the honesty
  // backbone forbids a positive EV display, and for a NO leg off a stale/cheap book the raw
  // fair/build can briefly exceed 1 (YES-vs-NO are priced on separate books).
  const evFrac = Math.min(0, buildPrice > 1e-6 ? fairPrice / buildPrice - 1 : -1);
  const expectedValueUsd = r2(stakeUsd * evFrac);
  const maxGainUsd = r2(stakeUsd * Math.max(0, payoutMultiple - 1));
  const maxLossUsd = r2(-stakeUsd);

  const warnings: string[] = [];
  if (opts.structuralJoint && opts.structuralJoint.p === 0) {
    warnings.push(opts.structuralJoint.why); // exact, structural impossibility (subsumes the generic note)
  } else if (opts.mutuallyExclusive) {
    warnings.push("Mutually exclusive legs: two or more YES legs are in the SAME market and cannot all hit. This combo can never pay (true chance ~0%). Pick outcomes from DIFFERENT markets.");
  } else if (opts.structuralJoint && opts.structuralJoint.kind === "subset") {
    warnings.push(opts.structuralJoint.why); // redundant legs — exact joint shown separately
  } else if (clean.length >= 2) {
    warnings.push("Joint probability assumes the legs are INDEPENDENT. Correlated legs (same match, same event) make the true chance — and the EV — worse, not better.");
  }
  if (clean.some((l) => l.capacityHit)) {
    warnings.push("At least one leg is thin near the touch; the real legging-in cost may be higher than shown.");
  }

  const verdict: "CAUTION" | "HIGH_RISK" = comboProb < 0.1 ? "HIGH_RISK" : "CAUTION";
  const verdictReason =
    verdict === "HIGH_RISK"
      ? `About ${(comboProb * 100).toFixed(1)}% chance all ${clean.length} legs hit. Negative EV after the compounded vig; this is a longshot — not betting is a valid choice.`
      : `Negative EV after the compounded vig (${(buildPrice * 100 - fairPrice * 100).toFixed(1)}¢ per $1). It expresses a multi-leg view; it is not an edge.`;

  let quote: ComboQuoteCheck | undefined;
  if (opts.quotedComboPrice !== undefined && opts.quotedComboPrice > 0) {
    const quotedCents = clamp01(opts.quotedComboPrice) * 100;
    const buildCents = buildPrice * 100;
    const fairCents = fairPrice * 100;
    const diffCents = quotedCents - buildCents;
    const realDiscount = quotedCents < buildCents - 1e-9;
    const beatsFair = quotedCents < fairCents - 1e-9;
    quote = {
      quotedCents: r2(quotedCents),
      buildCents: r2(buildCents),
      diffCents: r2(diffCents),
      realDiscount,
      beatsFair,
      note: beatsFair
        ? "The quote is below fair value — verify it; a true +EV combo quote is extraordinary and usually a mispricing or a missed correlation."
        : realDiscount
          ? `Real discount: the quote is ${Math.abs(diffCents).toFixed(1)}¢ cheaper per $1 than legging in yourself. Still EV-negative (fair is ${fairCents.toFixed(1)}¢), but better than building it.`
          : `No discount: the quote is ${Math.abs(diffCents).toFixed(1)}¢ ${diffCents >= 0 ? "more expensive" : "cheaper"} than legging in yourself. You're better off buying the legs separately.`,
    };
  }

  // ── φ-based relation (spec Stages 3–5): only meaningful for a PAIR of events. ──
  // Pick the joint-estimation method by what the caller derived: structural (exact) > stated ρ
  // (the cross-market estimate's illustrative ρ) > independence. φ, the optimal hedge ratio,
  // effectiveness (φ²), and confidence all flow from the resulting joint.
  let relation: EventRelation | undefined;
  if (clean.length === 2) {
    const [la, lb] = clean;
    const sj = opts.structuralJoint;
    relation = buildEventRelation({
      pA: la.q,
      pB: lb.q,
      structuralJoint: sj && (sj.p === 0 || sj.kind === "subset") ? (sj.kind === "subset" ? Math.min(la.q, lb.q) : 0) : undefined,
      structuralKind: sj?.kind,
      estimateRho: !sj && opts.jointEstimate ? opts.jointEstimate.illustrativeRho : undefined,
      liquidityOk: !clean.some((l) => l.capacityHit),
      labelA: la.title,
      labelB: lb.title,
    });
  }

  return {
    legs: clean,
    comboProb: Number(comboProb.toFixed(4)),
    buildPriceCents: r2(buildPrice * 100),
    fairPriceCents: r2(fairPrice * 100),
    compoundedVigCents: r2((buildPrice - fairPrice) * 100),
    payoutMultiple: r2(payoutMultiple),
    stakeUsd: r2(stakeUsd),
    expectedValueUsd,
    maxGainUsd,
    maxLossUsd,
    pProfit: Number(comboProb.toFixed(4)),
    verdict,
    verdictReason,
    quote,
    jointEstimate: opts.structuralJoint && opts.structuralJoint.p > 0 ? undefined : opts.jointEstimate,
    structuralJoint: opts.structuralJoint,
    relation,
    warnings,
  };
}
