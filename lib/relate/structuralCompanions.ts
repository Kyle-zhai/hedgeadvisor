/**
 * lib/relate/structuralCompanions.ts — LOGICALLY-CERTAIN (ANALYTIC) companions for an anchor.
 *
 * Three deterministic sources, all Fréchet-exact functions of the de-vigged marginals (no LLM, the same
 * every run), so these legs are tier ANALYTIC and bypass the MODELED noise margin:
 *
 *   1. SINGLE-WINNER SIBLINGS (domain-general, §13 L3/L4): when the anchor's own event is venue-proven
 *      mutually exclusive (`mutuallyExclusiveEvent` — PM negRisk / Kalshi mutual-exclusivity metadata),
 *      every sibling outcome is an exact rival: it CANNOT pay when the anchor wins. Elections, awards,
 *      FOMC decision brackets, "which X wins" — anything either venue lists as a single-winner field.
 *   2. CUMULATIVE THRESHOLD LADDERS (domain-general, §13 L2): same NON-mutex event, strictly cumulative
 *      phrasing ("above/at least X"): the higher bar is a SUBSET of the lower. Range bins ("X to Y") are
 *      mutex, NOT subsets, and are never treated as ladders (the kalshiBackfill lesson).
 *   3. WC nation→confederation overlay (the original seed table): a cross-market subset (champion ⊆ its
 *      own continent) that has no shared eventKey, so it needs a membership table.
 *
 * Membership always comes from venue metadata / numeric parsing — never an LLM guess — which is what
 * entitles these legs to ANALYTIC ("LLM output must never set structuralCoverage", association/types.ts).
 *
 *   anchor A ⊆ basket B:   P(B|A)=1,     P(B|¬A)=(P(B)−P(A))/(1−P(A))
 *   anchor A ⟂ rival  R:   P(R|A)=0,     P(R|¬A)= P(R)      /(1−P(A))
 *   subset C ⊆ anchor A:   P(C|A)=P(C)/P(A),  P(C|¬A)=0
 */
import type { NormalizedMarket } from "./types";
import { confederationOf, type Confederation } from "@/lib/data/seed/wc2026-structure";
import { norm } from "@/lib/polymarket/text";
import type { SuperposeLeg } from "./superpose";
import type { ScenarioBucket } from "./scenarioBucket";

/** Confederation → the continent-market outcome label fragment(s) it appears under. */
const CONF_CONTINENT: Record<Confederation, string[]> = {
  UEFA: ["europe"],
  CONMEBOL: ["south america"],
  CONCACAF: ["north america", "concacaf"],
  CAF: ["africa"],
  AFC: ["asia"],
  OFC: ["oceania"],
};

/** A few common anchor-title aliases so the membership lookup is robust to venue labels. */
const TEAM_ALIAS: Record<string, string> = {
  usa: "United States", us: "United States", "u.s.a.": "United States",
  "south korea": "South Korea", "korea republic": "South Korea",
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function resolveConfederation(title: string): Confederation | null {
  const direct = confederationOf(title);
  if (direct) return direct;
  const alias = TEAM_ALIAS[norm(title)];
  return alias ? confederationOf(alias) : null;
}

/** Is this market the "which continent wins the World Cup" basket? */
function isContinentMarket(m: NormalizedMarket): boolean {
  return m.eventFamily === "continent_winner" || /continent.*(win|world cup)|(win|world cup).*continent/i.test(m.marketTitle);
}

// Cumulative ("above X" ⇒ above-(X+1) ⊆ above-X) vs a range BIN ("X to Y", mutex, NOT a subset).
// Same discipline as kalshiBackfill.deriveKalshiJobs — a bin must never be sold as a subset.
const CUMULATIVE = /\b(above|over|at least|greater than|more than|or more|or higher|or above|or up)\b|≥|>=|\+\s*$/i;
const RANGE_BIN = /\bto\b|\bbetween\b|–|—|\d\s*-\s*\d/;

/** Pull the numeric bar from a STRICTLY-cumulative threshold label; null for bins / non-threshold text. */
export function parseCumulativeThreshold(text: string): number | null {
  if (!CUMULATIVE.test(text) || RANGE_BIN.test(text)) return null;
  // Raw lowercase (NOT norm(): norm strips "." and would truncate "3.5%" to 3).
  const m = text.toLowerCase().replace(/,/g, "").match(/([\d]+(?:\.\d+)?)\s*([kmb%]?)/);
  if (!m) return null;
  let v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = m[2];
  if (unit === "k") v *= 1e3; else if (unit === "m") v *= 1e6; else if (unit === "b") v *= 1e9;
  return v;
}

/** Anchor identity: title/prob always; id/eventKey/mutuallyExclusiveEvent unlock the domain-general paths. */
export interface StructuralAnchor {
  title: string;
  probYes: number;
  id?: string;
  eventKey?: string;
  mutuallyExclusiveEvent?: boolean;
}

// Containment must show in the de-vigged prices too (subset price ≤ superset price). A small tolerance
// absorbs vig/rounding noise; a genuine violation means bad data → skip that rung honestly.
const PRICE_TOLERANCE = 0.02;

/**
 * Derive the ANALYTIC structural companion legs for an anchor against the live universe. Empty when no
 * structural relation is provable (graceful — just no ANALYTIC legs, never a guessed one).
 */
export function deriveStructuralCompanions(
  anchor: StructuralAnchor,
  universe: NormalizedMarket[],
): SuperposeLeg[] {
  const pA = clamp01(anchor.probYes);
  const denom = Math.max(0.02, 1 - pA); // P(¬A); guard the conditional denominator
  const anchorNorm = norm(anchor.title);
  const legs: SuperposeLeg[] = [];
  const seen = new Set<string>();
  const push = (leg: SuperposeLeg) => { if (!seen.has(leg.id)) { seen.add(leg.id); legs.push(leg); } };
  const isAnchor = (m: NormalizedMarket) => m.id === anchor.id || norm(m.title) === anchorNorm;

  // ── 1. Single-winner siblings (L3/L4): venue metadata proves the outcomes cannot co-occur. ──
  if (anchor.eventKey && anchor.mutuallyExclusiveEvent) {
    for (const m of universe) {
      if (m.eventKey !== anchor.eventKey || !m.mutuallyExclusiveEvent || isAnchor(m)) continue;
      push(mkLeg(m, "YES", 0, clamp01(clamp01(m.probYes) / denom),
        `"${m.title}" and "${anchor.title}" are different outcomes of the same single-winner market (${m.marketTitle}); venue metadata proves they cannot both happen, so this YES pays only when ${anchor.title} fails.`,
        "rival_wins", "same_event_rival"));
    }
  }

  // ── 2. Cumulative threshold ladder (L2): same NON-mutex event, strictly cumulative labels only. ──
  if (anchor.eventKey && anchor.mutuallyExclusiveEvent === false) {
    const tA = parseCumulativeThreshold(anchor.title);
    if (tA != null) {
      for (const m of universe) {
        if (m.eventKey !== anchor.eventKey || m.mutuallyExclusiveEvent || isAnchor(m)) continue;
        const tB = parseCumulativeThreshold(m.title);
        if (tB == null || tB === tA) continue;
        const pB = clamp01(m.probYes);
        if (tB < tA) {
          // B is the LOWER bar ⇒ A ⊆ B (clearing the high bar clears the low one).
          if (pB + PRICE_TOLERANCE < pA) continue; // containment must hold in prices too
          push(mkLeg(m, "YES", 1, clamp01((pB - pA) / denom),
            `"${anchor.title}" clearing its bar implies "${m.title}" (a lower bar on the same quantity) — this YES pays for certain when the anchor wins.`,
            "logical_subset", "threshold_ladder"));
          push(mkLeg(m, "NO", 0, clamp01((1 - pB) / denom),
            `If "${anchor.title}" happens then "${m.title}" (a lower bar) happened too, so NO loses. NO pays only when even the lower bar failed — i.e. the anchor failed.`,
            "logical_subset", "threshold_ladder"));
        } else {
          // B is the HIGHER bar ⇒ B ⊆ A: exact P(B|A)=pB/pA, P(B|¬A)=0. Pays only inside anchor-wins states.
          if (pA + PRICE_TOLERANCE < pB) continue;
          push(mkLeg(m, "YES", clamp01(pB / Math.max(0.02, pA)), 0,
            `"${m.title}" is a higher bar on the same quantity, so it can only happen when "${anchor.title}" happened — an amplifier that never pays when the anchor fails.`,
            "logical_subset", "threshold_ladder"));
        }
      }
    }
  }

  // ── 3. WC nation→confederation overlay (cross-market subset via the seed membership table). ──
  const conf = resolveConfederation(anchor.title);
  const myFrags = conf ? CONF_CONTINENT[conf] ?? [] : [];
  if (myFrags.length) {
    const continentOutcomes = universe.filter(isContinentMarket);
    for (const m of continentOutcomes) {
      const label = norm(m.title);
      const pB = clamp01(m.probYes);
      const isMine = myFrags.some((frag) => label.includes(frag));
      if (isMine) {
        // A ⊆ B (own continent). YES = amplifier; NO = hedge (a non-own-continent champion ⇒ A failed).
        push(mkLeg(m, "YES", 1, clamp01((pB - pA) / denom), `${anchor.title} winning the World Cup means ${m.title} wins it (a champion from ${anchor.title} is in ${m.title}). This YES pays for certain when ${anchor.title} wins.`, "logical_subset", "continent"));
        push(mkLeg(m, "NO", 0, clamp01((1 - pB) / denom), `If ${anchor.title} wins, ${m.title} wins, so NO loses. NO pays only when the champion comes from outside ${m.title} — i.e. ${anchor.title} did not win.`, "rival_wins", "continent"));
      } else if (label) {
        // A ⟂ B (a different continent). YES pays only when A fails.
        push(mkLeg(m, "YES", 0, clamp01(pB / denom), `${m.title} winning the World Cup is mutually exclusive with ${anchor.title} winning — it can only pay when ${anchor.title} fails.`, "rival_wins", "continent"));
      }
    }
  }
  return legs;
}

function mkLeg(m: NormalizedMarket, side: "YES" | "NO", pWin: number, pFail: number, mechanism: string, scenario: ScenarioBucket, dimension: string): SuperposeLeg {
  const qYes = Math.min(0.98, Math.max(0.02, m.probYes));
  // UN-floored de-vigged pay-prob of the bought side = the honest unconditional marginal. q above is
  // floored at 0.02 for sizing sanity, but the marginal must NOT be floored: a sub-2% longshot's true
  // fair (e.g. 1.1%) sits below its executable price, and flooring it to 2% would make the leg look
  // EV-neutral/"free". Clamp only to a tiny epsilon.
  const marginal = Math.min(0.9999, Math.max(0.0001, side === "YES" ? m.probYes : 1 - m.probYes));
  return {
    id: `struct:${m.id}:${side}`,
    marketTitle: m.marketTitle,
    title: side === "NO" ? `NOT ${m.title}` : m.title,
    side,
    q: side === "YES" ? qYes : Number((1 - qYes).toFixed(4)),
    marginal,
    venue: m.venue,
    pWin,
    pFail,
    dimension,
    mechanism,
    scenario,
    tier: "ANALYTIC",
    marketId: m.id,
  };
}
