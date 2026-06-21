/**
 * lib/relate/toOptimizerCandidates.ts — adapt Discover's classified candidates into the canonical
 * robust optimizer's input (lib/association/optimizeRobustHedge), priced off the REAL book.
 *
 * POSITIVE-SUM ONLY. A hedge here is never a short of the user's own bet (no anchor-NO complement, no
 * cross-venue equivalent NO, no exclusive rival, no same-entity subset). Every leg is a standalone
 * positive bet on a DIFFERENT event that tends to pay when the anchor fails, so ideally both win and
 * at worst one wins. Two confidence tiers feed the optimizer:
 *
 *   CALIBRATED — settled-outcome history (loadConditionalCounts on a stable relation_key) gives a
 *                beta-binomial credible interval where the leg pays MORE often when the anchor fails.
 *   HYPOTHESIS — Qwen mechanism graph, no calibration yet: admitted as an INFERRED low-confidence leg
 *                (edge assumed from the mechanism) only below balanced conservatism, never as a guarantee.
 *
 * Qwen DISCOVERS (hypothesis), settled DATA PROVES (calibrated), the optimizer DECIDES (cost = book
 * all-in price, capacity = depth, uncertainty = credible bounds).
 */
import type { Book } from "@/lib/types";
import { fetchBooks } from "@/lib/polymarket";
import { fetchKalshiBook } from "@/lib/kalshi";
import { walkBookBuyBudgetCapped, bandDepthUsd, kalshiTakerFeeUsd, takerFeeUsd } from "@/lib/netcost";
import { calibrateConditionalPayoff, loadConditionalCounts, type OptimizerCandidate } from "@/lib/association";
import { mechanismSignature, relationKey, relationRole } from "./relationKey";
import type { CandidatePair, NormalizedMarket, PairClassification } from "./types";

const NOMINAL_BUDGET = 50; // near-touch pricing probe size (USD)
const MAX_HYPOTHESIS = 8; // cap rejected legs shown (transparency), per relation-family dedup
const INFERRED_REL_EDGE = 0.4; // max ASSUMED relative edge of an inferred mechanism leg (at confidence 1)
const CREDIBLE_LEVEL = 0.95;
const MIN_SAMPLES = 20;

/** All-in executable price + capacity for BUYING one side of a market, off its real book. */
async function priceSide(m: NormalizedMarket, side: "yes" | "no"): Promise<{ price: number; capacityUsd: number } | null> {
  const token = side === "no" ? m.noTokenId : m.yesTokenId;
  let book: Book | null = null;
  if (m.venue === "polymarket") {
    book = (await fetchBooks([token]).catch(() => new Map())).get(token) ?? null;
  } else {
    book = await fetchKalshiBook(token, side).catch(() => null);
  }
  if (!book) return null;
  const fill = walkBookBuyBudgetCapped(book, NOMINAL_BUDGET, 3);
  const p = fill.avgFillPrice ?? book.bestAsk;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const perShareFee = m.venue === "kalshi"
    ? kalshiTakerFeeUsd(1, p, m.feeRate / 0.07)
    : takerFeeUsd(1, p, "buy", { rate: m.feeRate, exponent: m.feeExponent, takerOnly: m.feeTakerOnly });
  return { price: Math.min(0.999, p + perShareFee), capacityUsd: Number(bandDepthUsd(book, 3).toFixed(2)) };
}

/** The side you'd BUY to hedge: a leg that pays when the anchor FAILS. A POSITIVELY-correlated leg
 *  is hedged by its NO; a NEGATIVELY-correlated leg (rival, inverse) by its YES. */
function hedgeSide(cls: PairClassification): "yes" | "no" | null {
  const dir = cls.hypothesis?.direction ?? (cls.direction === "positive" ? "POSITIVE" : cls.direction === "negative" ? "NEGATIVE" : "AMBIGUOUS");
  if (dir === "POSITIVE") return "no";
  if (dir === "NEGATIVE") return "yes";
  return null; // no clear hedge direction ⇒ not a candidate
}

export interface ClassifiedCandidate {
  pair: CandidatePair;
  cls: PairClassification;
}

export async function buildOptimizerCandidates(anchor: NormalizedMarket, classified: ClassifiedCandidate[]): Promise<OptimizerCandidate[]> {
  // POSITIVE-SUM hedges only. We never short the user's own bet, so there is no anchor-NO complement,
  // no cross-venue equivalent NO, no mutually-exclusive rival, and no same-entity subset here. Every
  // leg is a standalone positive bet on a DIFFERENT event that tends to pay when the anchor fails.
  const out: OptimizerCandidate[] = [];
  let hypothesisCount = 0;

  // Most-liquid candidate first so the per-relation_key dedup keeps the best one (pre-price proxy).
  const ordered = [...classified].sort((a, b) => Number(b.pair.b.liquidityOk) - Number(a.pair.b.liquidityOk) || b.pair.b.probYes - a.pair.b.probYes);

  for (const { pair, cls } of ordered) {
    const m = pair.b;

    // Cross-event positive-sum hedge: a standalone bet on a DIFFERENT event, keyed by a stable
    // relation_key. Settled history calibrates it; otherwise it is admitted as inferred low-confidence.
    const preferredSide = hedgeSide(cls);
    const role = relationRole(anchor.title, {
      entity: m.title,
      family: m.eventFamily,
      context: `${m.marketTitle} ${m.description} ${m.resolutionCriteria}`,
      mechanismGraph: cls.hypothesis?.mechanismGraph,
    });
    // Drop every "short your own bet" leg: same event (rival), same entity (subset / own progress),
    // and anything unrelated. A hedge leg must resolve on a DIFFERENT event from the anchor.
    if (role === "unrelated" || role === "rival" || role === "same_entity" || m.eventKey === anchor.eventKey) continue;
    const graph = cls.hypothesis?.mechanismGraph;
    const mechanism = mechanismSignature(graph);
    const reusableCohort = !graph || graph.portability !== "INSTANCE_ONLY";
    const anchorFamily = graph?.anchorEventClass ?? anchor.eventFamily;
    const candidateFamily = graph?.candidateEventClass ?? m.eventFamily;
    const predicate = graph ? "mechanism" : m.predicate;
    // Evaluate BOTH sides from settlement evidence. Qwen may propose a direction for recall/display,
    // but it cannot suppress the side that historical outcomes actually prove is the hedge.
    const sides: Array<"yes" | "no"> = preferredSide
      ? [preferredSide, preferredSide === "yes" ? "no" : "yes"]
      : ["yes", "no"];
    let foundCalibrated = false;
    for (const side of sides) {
      const key = relationKey(anchorFamily, candidateFamily, predicate, role, side, mechanism);
      const counts = reusableCohort ? await loadConditionalCounts(key).catch(() => null) : null;
      const calibration = counts ? calibrateConditionalPayoff(counts, CREDIBLE_LEVEL, MIN_SAMPLES) : undefined;
      if (!calibration?.sufficientEvidence) continue;
      const priced = await priceSide(m, side);
      if (!priced) continue;
      foundCalibrated = true;
      out.push({
        id: `cal:${key}:${m.id}`,
        label: `${side === "no" ? "NOT " : ""}${m.title} · ${m.venue}`,
        venue: m.venue,
        side,
        price: priced.price,
        maxSpendUsd: priced.capacityUsd,
        provenance: "CALIBRATED",
        calibration,
        associationGroup: `soft-market:${m.id}`,
      });
    }
    if (foundCalibrated) continue;
    if (preferredSide && hypothesisCount < MAX_HYPOTHESIS) {
      hypothesisCount++;
      const side = preferredSide;
      const key = relationKey(anchorFamily, candidateFamily, predicate, role, side, mechanism);
      // A coherent cross-event/cross-domain MECHANISM graph ⇒ admit as an INFERRED low-confidence leg
      // (priced off the REAL book; the edge over the market price is ASSUMED ∝ the LLM's confidence,
      // capped relative to price so a cheap leg can't game it). The optimizer admits it only below
      // balanced conservatism and labels it inferred. Without a graph it stays a display-only HYPOTHESIS.
      const confidence = graph ? Math.min(1, Math.max(0, cls.hypothesis?.confidence ?? 0)) : 0;
      if (graph && confidence > 0) {
        const priced = await priceSide(m, side);
        if (priced && priced.price > 0 && priced.price < 1) {
          out.push({
            id: `inf:${key}:${m.id}`, label: `${side === "no" ? "NOT " : ""}${m.title} · ${m.venue}`,
            venue: m.venue, side, price: priced.price, maxSpendUsd: priced.capacityUsd,
            provenance: "HYPOTHESIS",
            inferredPayoff: { payGivenFail: Math.min(0.95, priced.price * (1 + confidence * INFERRED_REL_EDGE)), payGivenWin: priced.price, confidence },
            associationGroup: `soft-market:${m.id}`,
          });
          continue;
        }
      }
      // display-only hypothesis (no mechanism graph, or unpriced): the optimizer rejects it.
      const mid = side === "no" ? 1 - m.probYes : m.probYes;
      if (mid > 0 && mid < 1) out.push({ id: `hyp:${key}:${m.id}`, label: `${side === "no" ? "NOT " : ""}${m.title} · ${m.venue}`, venue: m.venue, side, price: Number(mid.toFixed(4)), provenance: "HYPOTHESIS" });
    }
  }
  return out;
}
