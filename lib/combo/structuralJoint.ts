/**
 * lib/combo/structuralJoint.ts — derive the EXACT cross-market joint when Polymarket's
 * structure makes the relationship between two legs analytic, instead of estimating a range.
 *
 * Three derivable cases (all exact, no fitted coefficient):
 *   - same-outcome YES+NO: the same outcome bought both ways → P(all) = 0 (impossible).
 *   - mutual exclusivity: ≥2 YES legs in one single-winner set (same event slug or shared
 *     negRiskMarketId) → P(all) = 0.
 *   - subset / containment: one outcome is contained in another for the same entity
 *     (winning ⊆ reaching the final; a team winning ⊆ its confederation winning) → the legs
 *     are REDUNDANT: both hitting just means the narrower one, so P(all) = P(narrower).
 *
 * Honesty: this REPLACES an estimated range with a derivable truth (provenance ANALYTIC) and,
 * for the subset case, flags that parlaying redundant legs is dominated by buying the narrower
 * leg alone — so we never dangle a tempting (and misleading) parlay.
 */
import { norm } from "@/lib/polymarket/text";
import { confederationOf, type Confederation } from "@/lib/data/seed/wc2026-structure";

export interface StructLeg {
  eventSlug: string;
  index: number; // outcome index within its event
  title: string; // outcome entity, e.g. "England" or "Europe (UEFA)"
  side: "yes" | "no";
  negRiskMarketId: string | null;
  q: number; // de-vigged probability this leg hits
}

export interface StructuralJoint {
  p: number; // EXACT joint P(all legs hit)
  kind: "same-outcome" | "exclusive" | "subset";
  why: string;
}

const WINNER_EVENT = "world-cup-winner";
const REACH_FINAL_EVENT = "world-cup-nation-to-reach-final";
const CONTINENT_EVENT = "which-continent-will-win-the-world-cup";

const entityEq = (a: string, b: string) => {
  const na = norm(a);
  const nb = norm(b);
  return na.length > 0 && na === nb;
};
/** Same team/candidate named across two markets (looser than exact: token containment). */
export function sharesEntity(a: string, b: string): boolean {
  const ta = new Set(norm(a).split(" ").filter((w) => w.length > 2));
  const tb = new Set(norm(b).split(" ").filter((w) => w.length > 2));
  for (const w of ta) if (tb.has(w)) return true;
  return false;
}

/** Exact joint if the structure makes it derivable, else null (caller falls back to estimate). */
export function detectStructuralJoint(legs: StructLeg[]): StructuralJoint | null {
  if (legs.length < 2) return null;

  // 1) same outcome bought YES and NO → can never both happen
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i];
      const b = legs[j];
      if (a.eventSlug === b.eventSlug && a.index === b.index && a.side !== b.side) {
        return { p: 0, kind: "same-outcome", why: `You're betting both YES and NO on the same outcome (“${a.title}”). They can't both happen — this combo can never pay.` };
      }
    }
  }

  // 2) mutual exclusivity: ≥2 YES legs in the same single-winner set
  const yes = legs.filter((l) => l.side === "yes");
  for (let i = 0; i < yes.length; i++) {
    for (let j = i + 1; j < yes.length; j++) {
      const a = yes[i];
      const b = yes[j];
      const sameEvent = a.eventSlug === b.eventSlug && a.index !== b.index;
      const sameNeg = !!a.negRiskMarketId && a.negRiskMarketId === b.negRiskMarketId && !(a.eventSlug === b.eventSlug && a.index === b.index);
      if (sameEvent || sameNeg) {
        return { p: 0, kind: "exclusive", why: `“${a.title}” and “${b.title}” are outcomes of the same single-winner market — only one can win, so this combo can never all hit.` };
      }
    }
  }

  // 3) subset/containment (exactly 2 YES legs, same entity, one event contained in the other)
  if (yes.length === legs.length && legs.length === 2) {
    return subsetJoint(legs[0], legs[1]) ?? subsetJoint(legs[1], legs[0]);
  }
  return null;
}

function subsetJoint(narrow: StructLeg, broad: StructLeg): StructuralJoint | null {
  const p = Math.min(narrow.q, broad.q);
  const pctN = `${(narrow.q * 100).toFixed(1)}%`;
  // winning the tournament ⊆ reaching the final (same team)
  if (narrow.eventSlug === WINNER_EVENT && broad.eventSlug === REACH_FINAL_EVENT && entityEq(narrow.title, broad.title)) {
    return {
      p,
      kind: "subset",
      why: `${narrow.title} winning the World Cup is contained in ${narrow.title} reaching the final, so both legs hitting just means ${narrow.title} wins — the exact joint is P(win)=${pctN}, not the lower independent product. These legs are redundant: you'd do better buying “${narrow.title} to win” alone.`,
    };
  }
  // a team winning ⊆ that team's confederation winning (continent market)
  if (narrow.eventSlug === WINNER_EVENT && broad.eventSlug === CONTINENT_EVENT) {
    const conf = confederationOf(narrow.title);
    if (conf && confederationMatches(broad.title, conf)) {
      return {
        p,
        kind: "subset",
        why: `${narrow.title} winning is contained in “${broad.title}” winning (${narrow.title} is ${conf}), so both legs hitting just means ${narrow.title} wins — the exact joint is ${pctN}. Redundant: buying “${narrow.title} to win” alone dominates this parlay.`,
      };
    }
  }
  return null;
}

/** Continent-market outcome titles carry the confederation code, e.g. "Europe (UEFA)". */
function confederationMatches(continentTitle: string, conf: Confederation): boolean {
  return new RegExp(`\\b${conf}\\b`, "i").test(continentTitle);
}
