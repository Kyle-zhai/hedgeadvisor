/**
 * lib/relate/toOptimizerCandidates.ts — adapt Discover's classified candidates into the canonical
 * robust optimizer's input (lib/association/optimizeRobustHedge), priced off the REAL book, with the
 * full provenance ladder wired in:
 *
 *   ANALYTIC   — a DETERMINISTIC rule proves the leg pays $1 in EVERY anchor-fail state (buy NO on
 *                the anchor's own market, or on a strict cross-venue EQUIVALENT). Never from the LLM.
 *   CALIBRATED — settled-outcome history (loadConditionalCounts on a stable relation_key) gives a
 *                beta-binomial credible interval where the leg pays MORE often when the anchor fails.
 *   HYPOTHESIS — only Qwen/semantic similarity (or insufficient settled samples). The optimizer
 *                rejects it: a hypothesis is "可能有关", never "可以买".
 *
 * This is the closed loop's wiring half: Qwen DISCOVERS (hypothesis), settled DATA PROVES (calibrated),
 * the optimizer DECIDES (cost = book all-in price, capacity = depth, uncertainty = credible bounds).
 */
import type { Book } from "@/lib/types";
import { fetchBooks } from "@/lib/polymarket";
import { fetchKalshiBook } from "@/lib/kalshi";
import { walkBookBuyBudgetCapped, bandDepthUsd, kalshiTakerFeeUsd, takerFeeUsd } from "@/lib/netcost";
import { sameEntityStrict } from "@/lib/link";
import { calibrateConditionalPayoff, loadConditionalCounts, type OptimizerCandidate } from "@/lib/association";
import { mechanismSignature, relationKey, relationRole } from "./relationKey";
import type { CandidatePair, NormalizedMarket, PairClassification } from "./types";

const NOMINAL_BUDGET = 50; // near-touch pricing probe size (USD)
const MAX_HYPOTHESIS = 8; // cap rejected legs shown (transparency), per relation-family dedup
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
  const out: OptimizerCandidate[] = [];

  // (1) The anchor's OWN NO — the exact complement, ANALYTIC, covers ALL anchor-fail states.
  const anchorNo = await priceSide(anchor, "no");
  if (anchorNo) {
    out.push({
      id: `anchor-no:${anchor.id}`, label: `${anchor.title} does NOT win · ${anchor.venue}`,
      venue: anchor.venue, side: "no", price: anchorNo.price, maxSpendUsd: anchorNo.capacityUsd,
      provenance: "ANALYTIC", structuralCoverage: "ALL_ANCHOR_FAIL_STATES",
    });
  }

  let hypothesisCount = 0;

  // Process the most-liquid candidate first so the per-relation_key dedup keeps the BEST one
  // (not merely the first by array order). Liquidity is the pre-price proxy; ANALYTIC legs are
  // handled in their own branch regardless of order.
  const ordered = [...classified].sort((a, b) => Number(b.pair.b.liquidityOk) - Number(a.pair.b.liquidityOk) || b.pair.b.probYes - a.pair.b.probYes);

  for (const { pair, cls } of ordered) {
    const m = pair.b;

    // (2) A RULE-verified cross-venue EQUIVALENT ("same"): buying its NO covers ALL anchor-fail states
    // (resolves identically) — ANALYTIC. Must be method "rule" AND strict outcome identity (defence-in-depth).
    if (cls.method === "rule" && cls.relation === "same" && sameEntityStrict(anchor.title, m.title)) {
      const eq = await priceSide(m, "no");
      if (eq) out.push({ id: `equiv-no:${m.id}`, label: `${m.title} does NOT win · ${m.venue}`, venue: m.venue, side: "no", price: eq.price, maxSpendUsd: eq.capacityUsd, provenance: "ANALYTIC", structuralCoverage: "ALL_ANCHOR_FAIL_STATES" });
      continue;
    }

    // (3) Soft association — buy the hedge side, keyed by a stable relation_key. Settled history
    // (if any) calibrates it; otherwise it stays a HYPOTHESIS (rejected by the optimizer).
    const preferredSide = hedgeSide(cls);
    // Granular key: include the candidate's settlement PREDICATE + ENTITY ROLE so says_champion ≠
    // first_song, and "France wins ↔ Mbappé golden boot" (unrelated) never pools as a hedge.
    const role = relationRole(anchor.title, {
      entity: m.title,
      family: m.eventFamily,
      context: `${m.marketTitle} ${m.description} ${m.resolutionCriteria}`,
      mechanismGraph: cls.hypothesis?.mechanismGraph,
    });
    if (role === "unrelated") continue; // no meaningful settlement relation to calibrate
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
    // HYPOTHESIS (capped for transparency): priced at the displayed mid; the optimizer rejects it.
    if (preferredSide && hypothesisCount < MAX_HYPOTHESIS) {
      hypothesisCount++;
      const side = preferredSide;
      const key = relationKey(anchorFamily, candidateFamily, predicate, role, side, mechanism);
      const mid = side === "no" ? 1 - m.probYes : m.probYes;
      if (mid > 0 && mid < 1) out.push({ id: `hyp:${key}:${m.id}`, label: `${side === "no" ? "NOT " : ""}${m.title} · ${m.venue}`, venue: m.venue, side, price: Number(mid.toFixed(4)), provenance: "HYPOTHESIS" });
    }
  }
  return out;
}
