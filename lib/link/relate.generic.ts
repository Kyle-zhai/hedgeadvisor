/**
 * lib/link/relate.generic.ts — cross-venue linking for ANY theme (not just the World Cup).
 *
 * Kalshi has no text search, so we route a Polymarket bet to candidate Kalshi categories by
 * keyword, scan the cached series catalog for title matches, and look inside each mutually-exclusive
 * Kalshi event for the entity's market. The entity's market is EQUIVALENT (a real cross-venue hedge);
 * its event-siblings are MUTEX; the same entity in a non-aligned event is SAME_ENTITY context.
 *
 * Precision is the whole game here: a wrong EQUIVALENT fabricates a hedge, so we gate on entity-token
 * containment + a high name score with margin + event-title alignment, and DOWNGRADE (never guess)
 * when those fail. Domain-specific containment (e.g. champion ⊆ continent) stays in the WC path.
 */
import { tokenSetScore } from "@/lib/polymarket";
import { norm } from "@/lib/polymarket/text";
import { listKalshiEvents, fetchKalshiMarkets, listSeriesCatalog, type KalshiMarket, type KalshiCategory } from "@/lib/kalshi";
import { classify, type KalshiRole } from "./classify";
import { sameSubject, titleOverlap } from "./match";
import type { ClaimKind, CrossVenueLink } from "./types";

// Partition-NARROWING tokens: if one title carries one of these and the other does not, the two
// markets resolve over DIFFERENT partitions (nominee≠winner, primary≠general, group≠tournament),
// so they are NOT equivalent even when the entity + topic match. Gating on these prevents the
// cardinal honesty failure: selling a same-entity-different-partition leg as a guaranteed hedge.
const NARROWING_TOKENS = new Set([
  "nominee", "nomination", "primary", "caucus", "runoff",
  "conference", "division", "group", "semifinal", "semifinals",
  "quarterfinal", "quarterfinals", "qualifier", "qualifying", "regular",
  // prop-type narrowers: "X to win" ≠ "X golden boot" ≠ "X reach final" ≠ "X total goals"
  "golden", "boot", "scorer", "reach", "final", "finals", "advance", "stage", "total", "goals", "assists",
]);

/** True only when the two event titles describe the SAME single-winner partition (not a sub-partition). */
export function partitionsAligned(pmTitle: string, kalshiTitle: string): boolean {
  const a = new Set(norm(pmTitle).split(" "));
  const b = new Set(norm(kalshiTitle).split(" "));
  // a narrowing token present on exactly one side ⇒ different partition ⇒ NOT equivalent
  for (const t of NARROWING_TOKENS) if (a.has(t) !== b.has(t)) return false;
  return titleOverlap(pmTitle, kalshiTitle) >= 0.25;
}

const MAX_SERIES = 4;
const MAX_EVENTS_PER_SERIES = 2;
const MAX_SIBLINGS = 4;

/** Quick WC detector from the resolved Polymarket event slug/title. */
export function isWorldCupContext(eventSlug: string, eventTitle: string): boolean {
  return /world[\s-]?cup/i.test(`${eventSlug} ${eventTitle}`);
}

// Keyword → Kalshi category routing. A bet may map to several; we keep all (bounded by the cache).
const ROUTES: { re: RegExp; cat: KalshiCategory }[] = [
  { re: /\b(president|presidential|senate|senator|governor|election|nominee|primary|congress|parliament|prime minister|ballot|gop|democrat|republican|mayor|referendum)\b/i, cat: "Politics" },
  { re: /\b(nfl|nba|mlb|nhl|soccer|football|world cup|championship|super bowl|playoff|match|game|tournament|league|cup|olympic|series|finals|tennis|golf)\b/i, cat: "Sports" },
  { re: /\b(gdp|cpi|inflation|fed|interest rate|rate cut|rate hike|jobs|unemployment|recession|payroll|treasury|yield)\b/i, cat: "Economics" },
  { re: /\b(bitcoin|btc|ethereum|eth|crypto|solana|sol|dogecoin|token|coin)\b/i, cat: "Crypto" },
  { re: /\b(war|treaty|ceasefire|coup|sanction|nato|united nations|embassy|invasion|hostage)\b/i, cat: "World" },
  { re: /\b(earnings|ipo|ceo|stock|nasdaq|revenue|acquisition|merger|company|shares)\b/i, cat: "Companies" },
];

export function routeCategories(text: string): KalshiCategory[] {
  // Rank by SIGNAL STRENGTH (keyword-hit count), not static ROUTES order, so the strongest-signal
  // category is never dropped by the cap. Each category appears once in ROUTES, so no de-dupe needed.
  const scored = ROUTES.map((r) => ({ cat: r.cat, n: (text.match(new RegExp(r.re.source, "gi")) || []).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  return scored.length ? scored.slice(0, 4).map((x) => x.cat) : ["Politics", "Economics", "Crypto"];
}

function mkLink(role: KalshiRole, claim: ClaimKind, entity: string, rivalName: string | undefined, m: KalshiMarket, marketTitle: string, pmYes: number | null): CrossVenueLink | null {
  const c = classify(role, claim, { entity, rivalName });
  if (!c) return null;
  let priceNote: string | undefined;
  if (c.rule === "EQUIVALENT" && pmYes != null && m.yesMid != null) {
    const pm = Math.round(pmYes * 100);
    const k = Math.round(m.yesMid * 100);
    const diff = Math.abs(pm - k);
    priceNote = diff <= 1 ? `Both venues price YES ≈ ${pm}¢ — aligned.` : `Polymarket ${pm}¢ vs Kalshi ${k}¢ — ${diff}¢ apart, ${k < pm ? "Kalshi" : "Polymarket"} cheaper for YES.`;
  }
  return {
    rule: c.rule,
    provenance: c.provenance,
    uses: c.uses,
    venue: "kalshi",
    kalshiTicker: m.ticker,
    kalshiLabel: m.label,
    kalshiMarketTitle: marketTitle,
    kalshiSide: c.side,
    kalshiYesMid: m.yesMid,
    kalshiDeepLink: m.deepLink,
    rulesSnippet: m.rules.slice(0, 240),
    why: c.why,
    priceNote,
  };
}

export interface GenericHedgeAnchor {
  states: string[];
  heldIndex: number;
  coverTicker: string;
  coverLabel: string;
  coverDeepLink: string;
  kalshiFeeMultiplier: number;
}
export interface GenericRelateResult {
  links: CrossVenueLink[];
  hedgeAnchor?: GenericHedgeAnchor;
}

export interface GenericRelateInput {
  entity: string;
  pmEventTitle: string;
  pmTags: string[];
  claimKind: ClaimKind;
  pmYesMid: number | null;
}

/** Find the live Kalshi markets logically tied to an arbitrary Polymarket bet. */
export async function relateGeneric(input: GenericRelateInput): Promise<GenericRelateResult> {
  const { entity, pmEventTitle, pmTags, claimKind, pmYesMid } = input;
  const routeText = `${pmEventTitle} ${entity} ${pmTags.join(" ")}`;
  const cats = routeCategories(routeText);
  const catalog = await listSeriesCatalog(cats).catch(() => []);
  if (catalog.length === 0) return { links: [] };

  const anchorText = `${pmEventTitle} ${entity}`;
  const candidates = catalog
    .map((s) => ({ s, score: titleOverlap(anchorText, s.title) }))
    .filter((x) => x.score >= 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SERIES);

  const links: CrossVenueLink[] = [];
  let hedgeAnchor: GenericHedgeAnchor | undefined;
  let foundEquivalent = false;

  for (const { s } of candidates) {
    if (foundEquivalent) break;
    const events = await listKalshiEvents(s.ticker, 30).catch(() => []);
    const ranked = events
      .filter((e) => e.mutuallyExclusive)
      .map((e) => ({ e, sc: titleOverlap(anchorText, `${e.title} ${e.subTitle}`) }))
      .sort((a, b) => b.sc - a.sc)
      .slice(0, MAX_EVENTS_PER_SERIES);

    for (const { e } of ranked) {
      const markets = await fetchKalshiMarkets(e.eventTicker).catch(() => []);
      if (markets.length < 2) continue;
      const scored = markets.map((m) => ({ m, sc: tokenSetScore(entity, m.label) })).sort((a, b) => b.sc - a.sc);
      const top = scored[0];
      const runnerUp = scored[1]?.sc ?? 0;
      // sameSubject (containment + no generational-suffix mismatch) is the hard gate; require a clear
      // margin over the runner-up so an ambiguous partition downgrades to context, not a false EQUIVALENT.
      const entityMatch = top && sameSubject(entity, top.m.label) && top.sc >= 0.5 && top.sc - runnerUp >= 0.1;
      if (!entityMatch) continue;

      // EQUIVALENT requires the SAME partition, not just topic overlap: a nominee/primary/group event
      // is NOT the winner partition even when entity + topic match → downgrade to SAME_ENTITY context.
      const aligned = partitionsAligned(pmEventTitle, `${e.title} ${e.subTitle}`);
      if (aligned) {
        // EQUIVALENT + MUTEX siblings (the clean generic hedge)
        const self = mkLink("generic_self", claimKind, entity, undefined, top.m, e.title, pmYesMid);
        if (self) links.push(self);
        const sibs = markets
          .filter((m) => m.ticker !== top.m.ticker && m.yesMid != null)
          .sort((a, b) => (b.yesMid ?? 0) - (a.yesMid ?? 0))
          .slice(0, MAX_SIBLINGS);
        for (const sib of sibs) {
          const l = mkLink("generic_sibling", claimKind, entity, sib.label, sib, e.title, null);
          if (l) links.push(l);
        }
        hedgeAnchor = {
          states: markets.map((m) => m.label),
          heldIndex: markets.findIndex((m) => m.ticker === top.m.ticker),
          coverTicker: top.m.ticker,
          coverLabel: top.m.label,
          coverDeepLink: top.m.deepLink,
          kalshiFeeMultiplier: e.feeMultiplier,
        };
        foundEquivalent = true;
        break;
      } else {
        // same entity, different question → speculative context only
        const l = mkLink("generic_same_entity", claimKind, entity, undefined, top.m, e.title, null);
        if (l) links.push(l);
      }
    }
  }

  // de-dupe by ticker (keep the first/strongest classification)
  const seen = new Set<string>();
  const deduped = links.filter((l) => (seen.has(l.kalshiTicker) ? false : (seen.add(l.kalshiTicker), true)));
  return { links: deduped, hedgeAnchor };
}
