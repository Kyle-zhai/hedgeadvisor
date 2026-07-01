/**
 * lib/relate/toOptimizerCandidates.ts — adapt Discover's classified candidates into the canonical
 * robust optimizer's input (lib/association/optimizeRobustHedge), priced off the REAL book.
 *
 * POSITIVE-SUM ONLY. A hedge here is never a short of the user's own bet (no anchor-NO complement, no
 * cross-venue equivalent NO, no exclusive rival, no same-entity subset). Every leg is a standalone
 * positive bet on a DIFFERENT event that tends to pay when the anchor fails, so ideally both win and
 * at worst one wins. One evidence-bearing soft tier feeds the optimizer:
 *
 *   CALIBRATED — settled-outcome history (loadBucketCounts: the cluster-deduped, sign-keyed coarse
 *                role|mechType|direction|side bucket) gives a beta-binomial credible interval where the
 *                leg pays MORE often when the anchor fails.
 *   HYPOTHESIS — Qwen mechanism graph, no calibration yet: retained for explanation/audit, but NEVER
 *                assigned a payoff probability or admitted to sizing.
 *
 * Qwen DISCOVERS (hypothesis), settled DATA PROVES (calibrated), the optimizer DECIDES (cost = book
 * all-in price, capacity = depth, uncertainty = credible bounds).
 */
import type { Book } from "@/lib/types";
import { fetchBooks } from "@/lib/polymarket";
import { fetchKalshiBook } from "@/lib/kalshi";
import { walkBookBuyBudgetCapped, bandDepthUsd, kalshiTakerFeeUsd, takerFeeUsd } from "@/lib/netcost";
import { calibrateConditionalPayoff, type OptimizerCandidate } from "@/lib/association";
import { mechanismSignature, relationKey, relationRole } from "./relationKey";
import { graphVeto } from "./graphGuards";
import { loadReferencePriors } from "./referencePriors";
import { bucketKeys, loadBucketCounts } from "./tuningProfile";
import type { CandidatePair, NormalizedMarket, PairClassification } from "./types";
import { norm } from "@/lib/polymarket/text";

const MAX_HYPOTHESIS = 8; // cap rejected legs shown (transparency), per relation-family dedup
const CREDIBLE_LEVEL = 0.95;
const MIN_SAMPLES = 20;

/** All-in executable price + capacity for BUYING one side of a market, off its real book. */
export async function priceSide(m: NormalizedMarket, side: "yes" | "no", budgetUsd: number): Promise<{ price: number; capacityUsd: number; preFee: number; marginal: number } | null> {
  const token = side === "no" ? m.noTokenId : m.yesTokenId;
  let book: Book | null = null;
  if (m.venue === "polymarket") {
    book = (await fetchBooks([token]).catch(() => new Map())).get(token) ?? null;
  } else {
    book = await fetchKalshiBook(token, side).catch(() => null);
  }
  if (!book) return null;
  // Walk the amount this plan could actually deploy. A fixed probe (formerly $50) understates the
  // average price whenever a larger plan climbs multiple levels inside the accepted price band.
  const fill = walkBookBuyBudgetCapped(book, Math.max(1, budgetUsd), 3);
  const p = fill.avgFillPrice ?? book.bestAsk;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  const perShareFee = m.venue === "kalshi"
    ? kalshiTakerFeeUsd(1, p, m.feeRate / 0.07)
    : takerFeeUsd(1, p, "buy", { rate: m.feeRate, exponent: m.feeExponent, takerOnly: m.feeTakerOnly });
  const allIn = Math.min(0.999, p + perShareFee);
  const rawCapacity = bandDepthUsd(book, 3);
  const capacityUsd = fill.filledShares > 0
    ? Math.min(rawCapacity + perShareFee * fill.filledShares, fill.filledShares * allIn)
    : 0;
  // preFee = the executable fill price BEFORE the taker fee. True fair ≤ this ask < allIn (= ask + fee), so
  // it is an honest upper bound on a leg's marginal that guarantees the paid fee surfaces as negative EV.
  //
  // marginal = the DE-VIGGED unconditional P(this side pays). m.probYes is already de-vigged by
  // normalize.ts (devigDetailed: Shin → power → proportional) for mutually-exclusive PM books (a mid for
  // Kalshi / ordinary binaries). We bound it by preFee — true fair ≤ ask — so the carried marginal is
  // always ≤ price and never overstates the side's mass. This is the SAME honest marginal the superposition
  // path uses (discover.ts buildDirectionalSuperposition: min(snapshot fair, executable pre-fee ask)),
  // removing the asymmetry where superposition de-vigs but the optimizer's Fréchet clamp used gross price.
  // Parameter-free: no per-domain / horizon / platform fit, no fabricated calibration.
  const sideFair = side === "no" ? 1 - m.probYes : m.probYes;
  const marginal = Math.min(p, Math.max(0, Math.min(1, sideFair)));
  return { price: allIn, capacityUsd: Number(capacityUsd.toFixed(2)), preFee: p, marginal };
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

export async function buildOptimizerCandidates(anchor: NormalizedMarket, classified: ClassifiedCandidate[], pricingBudgetUsd = 50): Promise<OptimizerCandidate[]> {
  // POSITIVE-SUM hedges only. We never short the user's own bet, so there is no anchor-NO complement,
  // no cross-venue equivalent NO, no mutually-exclusive rival, and no same-entity subset here. Every
  // leg is a standalone positive bet on a DIFFERENT event that tends to pay when the anchor fails.
  const out: OptimizerCandidate[] = [];
  let hypothesisCount = 0;
  // GENERALIZABLE calibration source: realized conditional payoff per coarse structural BUCKET (relation
  // ROLE × mechanism TYPE × bought SIDE), pooled across ALL templates. This REPLACES the old per-relation_key
  // lookup — a never-seen template now calibrates from its bucket (the engine LEARNS a transferable rule, it
  // does not match the pair against its own history), and buckets cross the evidence threshold far sooner than
  // any single template. Empty without a DB ⇒ no CALIBRATED legs (HYPOTHESIS-only), exactly as before.
  const bucketCounts = await loadBucketCounts().catch(() => new Map());
  // Curated external base rates (REFERENCE_CLASS layer). Empty until priors are curated — a no-op then.
  const referencePriors = loadReferencePriors();

  // Most-liquid candidate first so the per-relation_key dedup keeps the best one (pre-price proxy).
  const ordered = [...classified].sort((a, b) => Number(b.pair.b.liquidityOk) - Number(a.pair.b.liquidityOk) || b.pair.b.probYes - a.pair.b.probYes);
  const entityStop = new Set([
    "the", "to", "win", "wins", "winner", "world", "cup", "stage", "elimination", "champion",
    "final", "semifinals", "quarterfinals", "knockout", "round", "group", "polymarket", "kalshi",
  ]);
  const entityTokens = (text: string) => norm(text).split(" ").filter((w) => w.length > 2 && !entityStop.has(w));
  const anchorTokens = new Set(entityTokens(`${anchor.title} ${anchor.marketTitle}`));
  const sharesAnchorEntity = (m: NormalizedMarket) =>
    entityTokens(`${m.title} ${m.marketTitle}`).some((w) => anchorTokens.has(w));

  for (const { pair, cls } of ordered) {
    const m = pair.b;

    // Cross-event positive-sum hedge: a standalone bet on a DIFFERENT event, keyed by a stable
    // relation_key. Settled history calibrates it; otherwise it remains display-only.
    const preferredSide = hedgeSide(cls);
    const anchorEntityContext = `${anchor.title} ${anchor.marketTitle}`;
    const role = relationRole(anchorEntityContext, {
      entity: m.title,
      family: m.eventFamily,
      context: `${m.marketTitle} ${m.description} ${m.resolutionCriteria}`,
      mechanismGraph: cls.hypothesis?.mechanismGraph,
    });
    // Drop every "short your own bet" leg: same event (rival), same entity (subset / own progress),
    // and anything unrelated. A hedge leg must resolve on a DIFFERENT event from the anchor.
    if (role === "unrelated" || role === "rival" || role === "same_entity" || m.eventKey === anchor.eventKey || sharesAnchorEntity(m)) continue;
    const graph = cls.hypothesis?.mechanismGraph;
    // N3 shared-resolution-source / P3 collider: deterministic graph veto (Gate 4). A candidate that
    // settles off the anchor's own feed is a correlated-failure trap, not a hedge; a pure collider's
    // association is Berkson noise. Veto-only — this can never admit or promote a leg.
    if (graphVeto(graph)) continue;
    const mechanism = mechanismSignature(graph, cls.hypothesis?.direction);
    const reusableCohort = !graph || graph.portability !== "INSTANCE_ONLY";
    const anchorFamily = graph?.anchorEventClass ?? anchor.eventFamily;
    const candidateFamily = graph?.candidateEventClass ?? m.eventFamily;
    const predicate = m.predicate;
    // Evaluate BOTH sides from settlement evidence. Qwen may propose a direction for recall/display,
    // but it cannot suppress the side that historical outcomes actually prove is the hedge.
    const sides: Array<"yes" | "no"> = preferredSide
      ? [preferredSide, preferredSide === "yes" ? "no" : "yes"]
      : ["yes", "no"];
    const mechType = mechanism?.split(".")[0] ?? "rule";
    // Payoff direction (signature segment 4) keys the bucket so this candidate only reads a sign-matched
    // cohort: a negative (hedge) candidate never inherits a positive (amplifier) bucket's blended payoff.
    const direction = mechanism?.split(".")[4] ?? "ambiguous";
    let foundCalibrated = false;
    for (const side of sides) {
      // Calibrate from the most-specific structural BUCKET with enough evidence (role|mech|side, else
      // role|side), pooled across ALL templates — NOT this pair's own relation_key history. INSTANCE_ONLY
      // mechanisms never pool (reusableCohort gate).
      let calibration: ReturnType<typeof calibrateConditionalPayoff> | undefined;
      let bucketKey: string | undefined;
      if (reusableCohort) {
        for (const bk of bucketKeys(role, mechType, direction, side)) {
          const counts = bucketCounts.get(bk);
          if (!counts) continue;
          const cal = calibrateConditionalPayoff(counts, CREDIBLE_LEVEL, MIN_SAMPLES);
          if (cal.sufficientEvidence) { calibration = cal; bucketKey = bk; break; }
        }
      }
      if (!calibration || !bucketKey) continue;
      const priced = await priceSide(m, side, pricingBudgetUsd);
      if (!priced) continue;
      foundCalibrated = true;
      out.push({
        id: `cal:${bucketKey}:${m.id}`,
        label: `${side === "no" ? "NOT " : ""}${m.title} · ${m.venue}`,
        venue: m.venue,
        side,
        price: priced.price,
        marginal: priced.marginal,
        maxSpendUsd: priced.capacityUsd,
        provenance: "CALIBRATED",
        calibration,
        associationGroup: `soft-market:${m.id}`,
      });
    }
    if (foundCalibrated) continue;
    // §19 item 3: curated EXTERNAL reference-class prior for the LEAF bucket (role|mech|direction|side).
    // Strictly BELOW CALIBRATED (checked only when no settlement bucket sufficed); the optimizer wall keeps
    // it out of the calibration slot entirely. LEAF-only lookup — transportability is judged per exact
    // bucket, never inherited from a coarser rung (§5 guard 2). Empty priors table ⇒ this is a no-op.
    let foundReference = false;
    for (const side of sides) {
      if (!reusableCohort) break; // INSTANCE_ONLY mechanisms never pool — same rule as calibration
      const leaf = bucketKeys(role, mechType, direction, side)[0];
      const rp = referencePriors.get(leaf);
      if (!rp) continue;
      const priced = await priceSide(m, side, pricingBudgetUsd);
      if (!priced) continue;
      foundReference = true;
      out.push({
        id: `ref:${leaf}:${m.id}`,
        label: `${side === "no" ? "NOT " : ""}${m.title} · ${m.venue}`,
        venue: m.venue,
        side,
        price: priced.price,
        marginal: priced.marginal,
        maxSpendUsd: priced.capacityUsd,
        provenance: "REFERENCE_CLASS",
        referencePrior: rp,
        associationGroup: `soft-market:${m.id}`,
      });
    }
    if (foundReference) continue;
    if (preferredSide && hypothesisCount < MAX_HYPOTHESIS) {
      hypothesisCount++;
      const side = preferredSide;
      const key = relationKey(anchorFamily, candidateFamily, predicate, role, side, mechanism);
      // A classification confidence is not a conditional payoff probability. Keep the hypothesis in
      // the audit/rejection output, but only settled calibration may later authorize sizing.
      const mid = side === "no" ? 1 - m.probYes : m.probYes;
      if (mid > 0 && mid < 1) out.push({ id: `hyp:${key}:${m.id}`, label: `${side === "no" ? "NOT " : ""}${m.title} · ${m.venue}`, venue: m.venue, side, price: Number(mid.toFixed(4)), provenance: "HYPOTHESIS" });
    }
  }
  return out;
}
