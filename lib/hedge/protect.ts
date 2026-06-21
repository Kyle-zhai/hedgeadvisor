/**
 * lib/hedge/protect.ts — the loss-minimization pipeline ("one bet, one slider").
 *
 * Given the user's primary bet B, this resolves B to its live market, builds the candidate hedge
 * legs (B-NO, which covers every way you lose; plus each top rival, which covers one), prices them
 * off the REAL order book, and runs the probability-free maximin solver for a posture k and a chosen
 * leg set. No win-probability is used to recommend anything — only payoffs × executable prices.
 */
import type { Book } from "@/lib/types";
import {
  resolveAnyPosition,
  resolvePosition,
  buildOutcomes,
  fetchBooks,
  fetchMidpoints,
  topRivals,
  fetchEventBundle,
  type EventBundle,
} from "@/lib/polymarket";
import { walkBookBuyBudgetCapped, type Outcome } from "@/lib/netcost";
import { buildMarketDeepLink } from "@/lib/execute";
import { confederationOf, type Confederation } from "@/lib/data/seed/wc2026-structure";
import { solveMaximin, amplifyCurve, type MaximinLeg, type AmplifyPoint } from "./maximin";
import { solveCvar } from "./cvar";
import { optimizeRobustHedge, type RobustOptimizerResult } from "@/lib/association";

const DEFAULT_SLUG = process.env.HEDGE_DEFAULT_EVENT_SLUG ?? "world-cup-winner";
const CONTINENT_SLUG = "which-continent-will-win-the-world-cup";
const CONFEDERATIONS: Confederation[] = ["UEFA", "CONMEBOL", "CONCACAF", "CAF", "AFC", "OFC"];
const MAX_RIVAL_LEGS = 6;
// The conservative end never spends ALL the winnings: keep ≥ this fraction so there is ALWAYS an
// upside if B wins (no "you can't make money no matter what" degenerate full hedge).
const MIN_KEEP_FRACTION = 0.12;
const FRONTIER_POINTS = 12;

export interface ProtectRequest {
  query: string; // the primary bet B (free text)
  eventSlug?: string;
  stakeUsd?: number; // staked on B
  keepFraction?: number; // k ∈ [0,1): keep ≥ k·G if B wins. default 0.5
  selectedLegIds?: string[]; // candidate leg ids to use; default = the cover-all complement
  modelConservatism?: number; // 0..1 for calibrated soft legs; exact-only by default
}

export interface ProtectCandidate {
  id: string;
  label: string; // outcome label, e.g. "France"
  marketTitle: string;
  side: "yes" | "no";
  price: number; // executable near-touch price (0..1)
  provenance: "ANALYTIC" | "SPECULATIVE" | "REDUNDANT";
  covers: string; // human note: which losing states this leg pays in
  coversAll: boolean; // true for B-NO (pays in every way you lose)
  capacityHit: boolean;
  deepLink: string;
}

export interface ProtectStrategyLeg {
  id: string;
  label: string;
  side: "yes" | "no";
  price: number;
  provenance: "ANALYTIC" | "SPECULATIVE" | "REDUNDANT";
  deepLink: string;
}
export interface ProtectFrontierPoint {
  keepFraction: number; // k
  keepIfWinUsd: number; // what you keep if B wins (≥ k·G)
  coveredWorstUsd: number; // worst loss across the states this combo TARGETS (what it protects)
  lossIfPrimaryFailsUsd: number; // worst loss across ALL fail-states (the honest tail)
  spendUsd: number;
  allocUsd: Record<string, number>; // leg id → dollars to put on that leg at this posture
  // ── Joint-scenario CVaR (probability-WEIGHTED tail, market-implied — secondary context) ──
  cvarBeforeUsd?: number; // CVaR(10%) of the un-hedged position
  cvarAfterUsd?: number; // CVaR(10%) after the CVaR-optimal allocation of this leg set
  cvarSpendUsd?: number; // spend the CVaR optimizer chose (may differ from the maximin spend)
}
/** A pre-composed combo strategy: a bundle of real legs, evaluated across the whole posture range. */
export interface ProtectStrategy {
  id: string;
  name: string;
  covers: string;
  full: boolean; // covers every way you lose (no rare-upset tail)
  legs: ProtectStrategyLeg[];
  frontier: ProtectFrontierPoint[]; // k from 1 (no hedge) down to minKeepFraction
}

export interface ProtectResponse {
  status: "ok" | "ambiguous" | "not_found";
  eventTitle?: string;
  candidates?: { title: string; score: number }[];
  suggestions?: string[];
  bet?: { title: string; marketTitle: string; price: number; stakeUsd: number; payoutUsd: number; profitUsd: number };
  states?: string[];
  strategies?: ProtectStrategy[]; // protect-side combos (left half)
  minKeepFraction?: number; // the conservative end never goes below this (always some upside if B wins)
  amplify?: AmplifyPoint[]; // the slider's RIGHT half (leverage reference; the page builds real parlays)
  pricedAt?: string;
  pricesSource?: "live" | "snapshot";
  associationEngine?: {
    qwenConfigured: boolean;
    modelConservatism: number;
    /** Exact structural baseline now; calibrated soft candidates plug into this same contract. */
    robustBaseline: RobustOptimizerResult;
  };
}

function nearTouch(book: Book | undefined, budgetUsd: number): { price: number; capacityHit: boolean } {
  if (!book) return { price: 1, capacityHit: true };
  const fill = walkBookBuyBudgetCapped(book, Math.max(1, budgetUsd), 3);
  const price = fill.avgFillPrice ?? book.bestAsk ?? book.midpoint ?? 1;
  return { price: Math.min(1, Math.max(0, price)), capacityHit: fill.capacityHit };
}

export async function runProtect(req: ProtectRequest): Promise<ProtectResponse> {
  const stakeUsd = Math.max(1, req.stakeUsd ?? 20);

  let resolved = req.eventSlug ? await resolvePosition(req.query, req.eventSlug) : await resolveAnyPosition(req.query);
  if (resolved.kind === "not_found" && !req.eventSlug) {
    const wc = await resolvePosition(req.query, DEFAULT_SLUG);
    if (wc.kind !== "not_found") resolved = wc;
  }
  if (resolved.kind === "not_found") return { status: "not_found", suggestions: resolved.suggestions };
  if (resolved.kind === "ambiguous") {
    return {
      status: "ambiguous",
      eventTitle: resolved.bundle.title,
      candidates: resolved.candidates.map((c) => ({ title: c.title, score: Number(c.score.toFixed(2)) })),
    };
  }

  const bundle: EventBundle = resolved.bundle;
  const heldIndex = resolved.index;
  const heldRef = bundle.markets[heldIndex];

  // de-vig / price off fresh live mids when available
  let pricesSource: "live" | "snapshot" = "snapshot";
  try {
    const mids = await fetchMidpoints(bundle.markets.map((m) => m.tokenIdYes));
    if (mids.size > 0) {
      for (const m of bundle.markets) {
        const mid = mids.get(m.tokenIdYes);
        if (mid !== undefined) m.midpointYes = mid;
      }
      bundle.yesPrices = bundle.markets.map((m) => m.midpointYes);
      pricesSource = "live";
    }
  } catch {
    /* keep snapshot */
  }

  const outcomes: Outcome[] = buildOutcomes(bundle);
  const states = outcomes.map((o) => o.label);
  const stateProbs = outcomes.map((o) => o.q); // de-vigged P(state); the CVaR layer's scenario weights
  const heldTitle = heldRef.groupItemTitle ?? heldRef.question;
  const primaryPrice = Math.min(1, Math.max(1e-3, heldRef.midpointYes || 0.1));
  const payoutUsd = stakeUsd / primaryPrice;
  const profitUsd = Math.max(0, payoutUsd - stakeUsd);

  const rivals = topRivals(bundle, heldIndex, outcomes, MAX_RIVAL_LEGS);
  const tokens = [heldRef.tokenIdNo, ...rivals.map((r) => r.ref.tokenIdYes)];
  const books = await fetchBooks(tokens);

  const allExceptHeld = new Set<number>();
  outcomes.forEach((_, i) => i !== heldIndex && allExceptHeld.add(i));

  const legMenu: ProtectCandidate[] = [];
  const solverLegs: MaximinLeg[] = [];

  const noBook = books.get(heldRef.tokenIdNo);
  if (noBook) {
    const { price, capacityHit } = nearTouch(noBook, stakeUsd);
    legMenu.push({
      id: "complement",
      label: `${heldTitle} does NOT win`,
      marketTitle: bundle.title,
      side: "no",
      price,
      provenance: "ANALYTIC",
      covers: "every way you lose (exact complement)",
      coversAll: true,
      capacityHit,
      deepLink: buildMarketDeepLink(heldRef.eventSlug),
    });
    solverLegs.push({ id: "complement", label: `${heldTitle} NO`, price, paysIn: allExceptHeld, provenance: "ANALYTIC" });
  }

  for (const r of rivals) {
    const book = books.get(r.ref.tokenIdYes);
    if (!book) continue;
    const name = r.ref.groupItemTitle ?? r.ref.question;
    const { price, capacityHit } = nearTouch(book, stakeUsd);
    const id = `rival-${r.index}`;
    legMenu.push({
      id,
      label: `${name} wins`,
      marketTitle: bundle.title,
      side: "yes",
      price,
      provenance: "ANALYTIC",
      covers: `only the branch where ${name} wins`,
      coversAll: false,
      capacityHit,
      deepLink: buildMarketDeepLink(r.ref.eventSlug),
    });
    solverLegs.push({ id, label: `${name} YES`, price, paysIn: new Set([r.index]), provenance: "ANALYTIC" });
  }

  // ── Cross-event structural hedge legs (champion-determined → exact over the partition) ──
  // A confederation winning the World Cup is decided by the champion's confederation, so
  // "a non-B confederation wins" pays EXACTLY in the subset of B's fail-states where a team of
  // that confederation is champion. It is a real cross-MARKET leg (the continent market) and needs
  // NO probability. We only claim the teams we can classify (conservative — the unclassifiable
  // longshot tail stays honestly uncovered, since only B-NO covers it).
  const heldConf = confederationOf(heldTitle);
  if (heldConf) {
    try {
      const cont = await fetchEventBundle(CONTINENT_SLUG);
      if (cont && cont.markets.length) {
        const confBooks = await fetchBooks(cont.markets.map((m) => m.tokenIdYes));
        for (const m of cont.markets) {
          const title = m.groupItemTitle ?? m.question;
          const conf = CONFEDERATIONS.find((c) => new RegExp(`\\b${c}\\b`, "i").test(title));
          if (!conf || conf === heldConf) continue; // B's own continent would also pay when B wins
          const paysIn = new Set<number>();
          states.forEach((label, i) => {
            if (confederationOf(label) === conf) paysIn.add(i);
          });
          if (paysIn.size === 0) continue;
          const book = confBooks.get(m.tokenIdYes);
          if (!book) continue;
          const { price, capacityHit } = nearTouch(book, stakeUsd);
          const id = `conf-${conf}`;
          legMenu.push({ id, label: `${title} wins`, marketTitle: cont.title, side: "yes", price, provenance: "ANALYTIC", covers: `every ${conf} team that could beat you (cross-market)`, coversAll: false, capacityHit, deepLink: buildMarketDeepLink(m.eventSlug) });
          solverLegs.push({ id, label: `${title} YES`, price, paysIn, provenance: "ANALYTIC" });
        }
      }
    } catch {
      /* continent market unavailable — skip cross-event legs */
    }
  }

  // ── Pre-compose combo STRATEGIES (bundles), not a parts-bin of single legs ──
  const legById = new Map(solverLegs.map((l) => [l.id, l]));
  const menuById = new Map(legMenu.map((l) => [l.id, l]));
  const totalFailStates = states.length - 1; // single-winner: every other outcome is a way you lose
  const comboDefs: { id: string; name: string; covers: string; legIds: string[] }[] = [];
  if (legById.has("complement")) {
    comboDefs.push({ id: "broad", name: "Full protection · buy your own NO", covers: "Covers every state where you lose (exact complement)", legIds: ["complement"] });
  }
  const rivalIds = legMenu.filter((l) => l.id.startsWith("rival-")).slice(0, 3).map((l) => l.id);
  if (rivalIds.length >= 2) {
    comboDefs.push({ id: "rivals", name: "Top-rivals basket", covers: "Covers the teams most likely to beat you (cheaper, leaves the rare-upset tail)", legIds: rivalIds });
  }
  const confIds = legMenu.filter((l) => l.id.startsWith("conf-")).map((l) => l.id);
  if (confIds.length >= 2) {
    comboDefs.push({ id: "confed", name: "Confederation spread", covers: "Covers teams outside your continent (cross-market)", legIds: confIds });
  }

  // Evaluate each combo across the whole posture range (k: 1 → MIN_KEEP_FRACTION), probability-free.
  const sampleK = (i: number) => 1 - (i / (FRONTIER_POINTS - 1)) * (1 - MIN_KEEP_FRACTION);
  const strategies: ProtectStrategy[] = comboDefs.map((c) => {
    const legs = c.legIds.map((id) => legById.get(id)!).filter(Boolean);
    const objective = new Set<number>();
    legs.forEach((l) => l.paysIn.forEach((s) => objective.add(s)));
    const objectiveStates = [...objective];
    const full = objectiveStates.length >= totalFailStates;
    const frontier: ProtectFrontierPoint[] = [];
    for (let i = 0; i < FRONTIER_POINTS; i++) {
      const kf = sampleK(i);
      const r = solveMaximin({ states, primaryWinIdx: [heldIndex], stakeUsd, primaryPrice, legs, keepFraction: kf, objectiveStates });
      // Joint-scenario CVaR(10%) over the SAME leg set, using de-vigged probs (secondary context):
      // the probability-weighted tail the maximin's worst-case can't express.
      const cv = solveCvar({ states, stateProbs, primaryWinIdx: [heldIndex], stakeUsd, primaryPrice, legs, keepFraction: kf, alpha: 0.1, steps: 120 });
      frontier.push({ keepFraction: Number(kf.toFixed(3)), keepIfWinUsd: r.keepIfWinUsd, coveredWorstUsd: r.coveredWorstUsd, lossIfPrimaryFailsUsd: r.lossIfPrimaryFailsUsd, spendUsd: r.spendUsd, allocUsd: r.allocUsd, cvarBeforeUsd: cv.cvarBeforeUsd, cvarAfterUsd: cv.cvarAfterUsd, cvarSpendUsd: cv.spendUsd });
    }
    return {
      id: c.id,
      name: c.name,
      covers: c.covers,
      full,
      legs: legs.map((l) => {
        const m = menuById.get(l.id);
        return { id: l.id, label: m?.label ?? l.label, side: m?.side ?? "yes", price: l.price, provenance: l.provenance ?? "ANALYTIC", deepLink: m?.deepLink ?? "" };
      }),
      frontier,
    };
  });

  // Shared robust optimizer contract is now part of the live Protect response. Today the verified
  // cover-all complement is eligible; partial structural legs remain in the state-matrix maximin
  // engine above, and future calibrated soft legs can enter here without weakening the strict floor.
  const modelConservatism = Math.min(1, Math.max(0, req.modelConservatism ?? 1));
  const complementLeg = solverLegs.find((l) => l.id === "complement");
  const robustBaseline = optimizeRobustHedge({
    stakeUsd,
    primaryPrice,
    keepFraction: Math.min(1, Math.max(MIN_KEEP_FRACTION, req.keepFraction ?? 0.5)),
    conservatism: modelConservatism,
    maxLegs: 3,
    candidates: complementLeg
      ? [{
          id: complementLeg.id,
          label: complementLeg.label,
          venue: "polymarket",
          side: "no",
          price: complementLeg.price,
          provenance: "ANALYTIC",
          structuralCoverage: "ALL_ANCHOR_FAIL_STATES",
        }]
      : [],
  });

  return {
    status: "ok",
    eventTitle: bundle.title,
    bet: { title: heldTitle, marketTitle: bundle.title, price: Number(primaryPrice.toFixed(4)), stakeUsd, payoutUsd: Number(payoutUsd.toFixed(2)), profitUsd: Number(profitUsd.toFixed(2)) },
    states,
    strategies,
    minKeepFraction: MIN_KEEP_FRACTION,
    amplify: amplifyCurve(stakeUsd, primaryPrice, 11),
    pricedAt: new Date().toISOString(),
    pricesSource,
    associationEngine: {
      qwenConfigured: Boolean(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY),
      modelConservatism,
      robustBaseline,
    },
  };
}
