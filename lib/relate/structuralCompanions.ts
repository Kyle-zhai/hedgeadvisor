/**
 * lib/relate/structuralCompanions.ts — LOGICALLY-CERTAIN (ANALYTIC) companions for a single-winner anchor.
 *
 * Some companion relations are not a guess: a World-Cup champion is, with certainty, a champion FROM ITS
 * OWN CONTINENT, and CANNOT be a champion from a different continent. So for an anchor "Spain wins the WC":
 *   - "Europe wins the WC"        ⊇ Spain wins  → AMPLIFIER (pays for sure when Spain wins)
 *   - "South America wins the WC" ⟂ Spain wins  → HEDGE     (pays only when Spain fails)
 *   - "NOT Europe wins"           ⟂ Spain wins  → HEDGE     (a non-European champion ⇒ Spain failed)
 *
 * The conditional payoffs are EXACT functions of the de-vigged marginals (no LLM, deterministic, the same
 * every run), so these legs are tier ANALYTIC and bypass the MODELED noise margin. This is what makes the
 * Europe leg appear reliably instead of depending on a per-run LLM elicitation draw.
 *
 *   anchor A ⊆ basket B:   P(B|A)=1,  P(B|¬A)=(P(B)−P(A))/(1−P(A))
 *   anchor A ⟂ rival  R:   P(R|A)=0,  P(R|¬A)= P(R)      /(1−P(A))
 *
 * The mechanism is general (entity ⊆ group-basket, entity ⟂ sibling-basket); the WC nation→confederation
 * map is the first concrete membership table. Extend the map (party membership, sector, region…) to reuse it.
 */
import type { NormalizedMarket } from "./types";
import { confederationOf, type Confederation } from "@/lib/data/seed/wc2026-structure";
import { norm } from "@/lib/polymarket/text";
import type { SuperposeLeg } from "./superpose";

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

/**
 * Derive the ANALYTIC structural companion legs for an anchor against the live universe. Empty when the
 * anchor's membership is unknown or no continent-basket market is live (graceful — just no ANALYTIC legs).
 */
export function deriveStructuralCompanions(
  anchor: { title: string; probYes: number },
  universe: NormalizedMarket[],
): SuperposeLeg[] {
  const conf = resolveConfederation(anchor.title);
  if (!conf) return [];
  const myFrags = CONF_CONTINENT[conf] ?? [];
  if (!myFrags.length) return [];
  const continentOutcomes = universe.filter(isContinentMarket);
  if (!continentOutcomes.length) return [];

  const pA = clamp01(anchor.probYes);
  const denom = Math.max(0.02, 1 - pA); // P(¬A); guard the conditional denominator
  const legs: SuperposeLeg[] = [];
  const seen = new Set<string>();

  for (const m of continentOutcomes) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const label = norm(m.title);
    const pB = clamp01(m.probYes);
    const isMine = myFrags.some((frag) => label.includes(frag));
    if (isMine) {
      // A ⊆ B (own continent). YES = amplifier; NO = hedge (a non-own-continent champion ⇒ A failed).
      legs.push(mkLeg(m, "YES", 1, clamp01((pB - pA) / denom), `${anchor.title} winning the World Cup means ${m.title} wins it (a champion from ${anchor.title} is in ${m.title}). This YES pays for certain when ${anchor.title} wins.`));
      legs.push(mkLeg(m, "NO", 0, clamp01((1 - pB) / denom), `If ${anchor.title} wins, ${m.title} wins, so NO loses. NO pays only when the champion comes from outside ${m.title} — i.e. ${anchor.title} did not win.`));
    } else if (label) {
      // A ⟂ B (a different continent). YES pays only when A fails.
      legs.push(mkLeg(m, "YES", 0, clamp01(pB / denom), `${m.title} winning the World Cup is mutually exclusive with ${anchor.title} winning — it can only pay when ${anchor.title} fails.`));
    }
  }
  return legs;
}

function mkLeg(m: NormalizedMarket, side: "YES" | "NO", pWin: number, pFail: number, mechanism: string): SuperposeLeg {
  const qYes = Math.min(0.98, Math.max(0.02, m.probYes));
  return {
    id: `struct:${m.id}:${side}`,
    marketTitle: m.marketTitle,
    title: side === "NO" ? `NOT ${m.title}` : m.title,
    side,
    q: side === "YES" ? qYes : Number((1 - qYes).toFixed(4)),
    pWin,
    pFail,
    dimension: "continent",
    mechanism,
    tier: "ANALYTIC",
  };
}
