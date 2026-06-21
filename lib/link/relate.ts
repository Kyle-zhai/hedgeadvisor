/**
 * lib/link/relate.ts — the cross-venue linker.
 *
 * Anchor: a Polymarket bet B on an entity E (e.g. "Spain"). We resolve B on Polymarket, then
 * discover the LIVE Kalshi markets that touch E and classify each by its logical relation to B
 * (lib/link/classify.ts). Structural relations (EQUIVALENT / MUTEX / SUBSET) are real cross-venue
 * hedge or amplify legs; thematic and narrative ties are surfaced as labeled, speculative context.
 *
 * The whole World Cup family of Kalshi series is wired here:
 *   KXMENWORLDCUP  champion        KXWCGAME   per-match winner   KXWCTOTAL  match totals
 *   KXWCCONTINENT  continent       KXWCFIRSTSONG  broadcast/narrative
 * Discovery is text-driven off real market labels + rules text — no fabricated correlation.
 */
import {
  resolveAnyPosition,
  resolvePosition,
  resolveBet,
  fetchMidpoints,
  fetchBooks,
  tokenSetScore,
  type EventBundle,
} from "@/lib/polymarket";
import { buildMarketDeepLink } from "@/lib/execute";
import { norm } from "@/lib/polymarket/text";
import { confederationOf, type Confederation } from "@/lib/data/seed/wc2026-structure";
import { listKalshiEvents, fetchKalshiMarkets, type KalshiMarket } from "@/lib/kalshi";
import type { Book } from "@/lib/types";
import { classify, type KalshiRole } from "./classify";
import { parseEntityQuery, refersTo, opponentOf, fixtureSortKey } from "./match";
import { buildCrossVenueHedge } from "./hedge";
import { relateGeneric } from "./relate.generic";
import type { ClaimKind, CrossVenueLink, CrossVenueHedge, RelateResult } from "./types";

const DEFAULT_SLUG = process.env.HEDGE_DEFAULT_EVENT_SLUG ?? "world-cup-winner";

const WC_SERIES = {
  champion: "KXMENWORLDCUP",
  game: "KXWCGAME",
  total: "KXWCTOTAL",
  continent: "KXWCCONTINENT",
  narrative: ["KXWCFIRSTSONG"],
};
const MAX_RIVAL_LINKS = 4;

const CONF_CONTINENT: Record<Confederation, string[]> = {
  UEFA: ["europe"],
  CONMEBOL: ["south america"],
  CONCACAF: ["north america", "concacaf"],
  CAF: ["africa"],
  AFC: ["asia"],
  OFC: ["oceania"],
};

export interface RelateRequest {
  query: string;
  eventSlug?: string;
  stakeUsd?: number;
}

function detectClaimKind(query: string): ClaimKind {
  const q = query.toLowerCase();
  const champ = /\b(champion|world cup winner|win(s|ning)? (the )?(world cup|cup|tournament)|win it all|lift the (cup|trophy))\b/.test(q);
  const match = /\b(beats?|defeats?|vs\.?|v\.?|next match|next game|this match|win(s)? (their|its|the) (match|game))\b/.test(q);
  if (champ && !match) return "champion";
  if (match) return "match";
  return "champion";
}

function priceNote(pmYes: number | null, kYes: number | null): string | undefined {
  if (pmYes == null || kYes == null) return undefined;
  const pm = Math.round(pmYes * 100);
  const k = Math.round(kYes * 100);
  const diff = Math.abs(pm - k);
  if (diff <= 1) return `Both venues price YES ≈ ${pm}¢ — aligned.`;
  const cheaper = k < pm ? "Kalshi" : "Polymarket";
  return `Polymarket ${pm}¢ vs Kalshi ${k}¢ — ${diff}¢ apart, ${cheaper} cheaper for YES.`;
}

function toLink(
  role: KalshiRole,
  claim: ClaimKind,
  ctx: Parameters<typeof classify>[2],
  m: KalshiMarket,
  marketTitle: string,
  pmYes: number | null,
): CrossVenueLink | null {
  const c = classify(role, claim, ctx);
  if (!c) return null;
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
    priceNote: c.rule === "EQUIVALENT" ? priceNote(pmYes, m.yesMid) : undefined,
  };
}

// ── per-relation discovery (each catches its own failure → []) ──

/** Fetch the live Kalshi champion event + its 48 team markets once (shared anchor). */
async function fetchChampionMarkets(): Promise<{ title: string; markets: KalshiMarket[]; feeMultiplier: number } | null> {
  const events = await listKalshiEvents(WC_SERIES.champion, 4).catch(() => []);
  if (events.length === 0) return null;
  const ev = events[0];
  const markets = await fetchKalshiMarkets(ev.eventTicker).catch(() => []);
  if (markets.length === 0) return null;
  return { title: ev.title, markets, feeMultiplier: ev.feeMultiplier };
}

function championLinks(
  champ: { title: string; markets: KalshiMarket[] },
  entity: string,
  claim: ClaimKind,
  pmYes: number | null,
): CrossVenueLink[] {
  const { title, markets } = champ;
  const ev = { title };
  const out: CrossVenueLink[] = [];
  const self = markets.find((m) => refersTo(entity, m.label));
  if (self) {
    const l = toLink("champion_self", claim, { entity }, self, ev.title, pmYes);
    if (l) out.push(l);
  }
  if (claim === "champion") {
    const rivals = markets
      .filter((m) => !refersTo(entity, m.label) && m.yesMid != null)
      .sort((a, b) => (b.yesMid ?? 0) - (a.yesMid ?? 0))
      .slice(0, MAX_RIVAL_LINKS);
    for (const r of rivals) {
      const l = toLink("champion_rival", claim, { entity, rivalName: r.label }, r, ev.title, pmYes);
      if (l) out.push(l);
    }
  }
  return out;
}

async function continentLinks(entity: string, claim: ClaimKind): Promise<CrossVenueLink[]> {
  // HONESTY GUARD: we can only classify continents if we KNOW the entity's continent. The seed
  // covers the major contenders; for any unknown team we SUPPRESS all continent legs rather than
  // risk emitting the entity's OWN continent (which pays when B WINS) as a "hedge".
  const conf = confederationOf(entity);
  if (!conf) return [];
  const keywords = CONF_CONTINENT[conf];
  const events = await listKalshiEvents(WC_SERIES.continent, 4);
  if (events.length === 0) return [];
  const ev = events[0];
  const markets = await fetchKalshiMarkets(ev.eventTicker);
  if (markets.length === 0) return [];
  const isSelf = (m: KalshiMarket) => keywords.some((k) => norm(m.label).includes(k));
  const out: CrossVenueLink[] = [];
  const self = markets.find(isSelf);
  if (self) {
    // SUBSET (amplify-only): B-champion ⊆ B's continent wins. Never a hedge.
    const l = toLink("continent_self", claim, { entity, continent: self.label }, self, ev.title, null);
    if (l) out.push(l);
  }
  if (claim === "champion") {
    for (const m of markets) {
      // Invariant: a continent_other leg must NOT be the anchor's own continent (that would pay
      // when B wins). isSelf() already excludes it; assert defensively.
      if (isSelf(m) || m.yesMid == null) continue;
      const l = toLink("continent_other", claim, { entity, continent: m.label }, m, ev.title, null);
      if (l) out.push(l);
    }
  }
  return out.slice(0, 1 + MAX_RIVAL_LINKS);
}

/** Returns the soonest open Kalshi game event involving `entity`, or null. */
async function findEntityGameEvent(entity: string) {
  const events = await listKalshiEvents(WC_SERIES.game, 80);
  const mine = events
    .filter((e) => refersTo(entity, e.title))
    .sort((a, b) => fixtureSortKey(a.eventTicker) - fixtureSortKey(b.eventTicker));
  return mine[0] ?? null;
}

async function matchLinks(
  entity: string,
  claim: ClaimKind,
  gameEventTicker: string,
  fixtureTitle: string,
  pmYes: number | null,
): Promise<CrossVenueLink[]> {
  const markets = await fetchKalshiMarkets(gameEventTicker);
  if (markets.length === 0) return [];
  const opponent = opponentOf(entity, fixtureTitle) ?? undefined;
  const out: CrossVenueLink[] = [];
  const self = markets.find((m) => refersTo(entity, m.label));
  if (self) {
    const l = toLink("match_self", claim, { entity, fixture: fixtureTitle, opponent }, self, fixtureTitle, pmYes);
    if (l) out.push(l);
  }
  if (claim === "match") {
    for (const m of markets) {
      if (refersTo(entity, m.label)) continue;
      const l = toLink("match_rival", claim, { entity, fixture: fixtureTitle, opponent }, m, fixtureTitle, pmYes);
      if (l) out.push(l);
    }
  }
  // Totals for the SAME fixture. The KXWCTOTAL event ticker shares the game ticker's date+teams
  // suffix, so replacing only the series prefix targets the exact fixture; if that fixture has no
  // totals event, fetchKalshiMarkets returns [] (no wrong-match attachment). As a belt-and-suspenders
  // guard we also require the entity to appear in the totals rules text when that text is present.
  const totalTicker = gameEventTicker.replace(/^[^-]+/, WC_SERIES.total);
  const totals = await fetchKalshiMarkets(totalTicker);
  for (const m of totals.slice(0, 2)) {
    const fixtureMatches = !m.rules || refersTo(entity, m.rules) || (opponent ? refersTo(opponent, m.rules) : false);
    if (!fixtureMatches) continue;
    const l = toLink("total_match", claim, { entity, fixture: fixtureTitle }, m, `${fixtureTitle}: Total Goals`, null);
    if (l) out.push(l);
  }
  return out;
}

async function narrativeLinks(entity: string, claim: ClaimKind): Promise<CrossVenueLink[]> {
  const out: CrossVenueLink[] = [];
  for (const series of WC_SERIES.narrative) {
    const events = await listKalshiEvents(series, 2);
    if (events.length === 0) continue;
    const markets = await fetchKalshiMarkets(events[0].eventTicker);
    for (const m of markets.slice(0, 2)) {
      const l = toLink("narrative", claim, { entity }, m, events[0].title, null);
      if (l) out.push(l);
    }
    if (out.length) break;
  }
  return out;
}

const RULE_RANK: Record<CrossVenueLink["rule"], number> = {
  EQUIVALENT: 0,
  MUTEX: 1,
  SUBSET: 2,
  SUPERSET: 3,
  SAME_EVENT: 4,
  SAME_ENTITY: 5,
  NARRATIVE: 6,
};

/** Resolve the entity off Kalshi's canonical champion team list (authoritative, live). */
function resolveEntityFromChampion(
  query: string,
  champ: { markets: KalshiMarket[] } | null,
): { entity: string; suggestions: string[] } | null {
  if (!champ) return null;
  const parsed = parseEntityQuery(query);
  const ranked = champ.markets
    .map((m) => ({ label: m.label, score: tokenSetScore(parsed, m.label) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (top && top.score >= 0.5) return { entity: top.label, suggestions: [] };
  return { entity: "", suggestions: ranked.slice(0, 6).map((r) => r.label) };
}

/** Best-effort: the live Polymarket champion mid + event + NO token for the entity. */
async function pmChampionContext(entity: string, eventSlug: string | undefined) {
  let yesMid: number | null = null;
  let slug = eventSlug ?? DEFAULT_SLUG;
  let title = "World Cup Winner";
  let noToken: string | null = null;
  try {
    const pr = await resolvePosition(entity, slug);
    if (pr.kind === "resolved") {
      const ref = pr.bundle.markets[pr.index];
      slug = pr.bundle.slug;
      title = pr.bundle.title;
      noToken = ref.tokenIdNo;
      yesMid = ref.midpointYes > 0 && ref.midpointYes < 1 ? ref.midpointYes : null;
      try {
        const mids = await fetchMidpoints([ref.tokenIdYes]);
        const mid = mids.get(ref.tokenIdYes);
        if (mid !== undefined) yesMid = mid;
      } catch {
        /* keep snapshot mid */
      }
    }
  } catch {
    /* PM champion market not resolvable — compare is simply omitted */
  }
  return { yesMid, slug, title, noToken };
}

/** Fetch a single Polymarket NO book (for the cross-venue hedge cost compare). */
async function pmNoBookFor(noToken: string | null): Promise<Book | null> {
  if (!noToken) return null;
  try {
    return (await fetchBooks([noToken])).get(noToken) ?? null;
  } catch {
    return null;
  }
}

function sortLinks(links: CrossVenueLink[]): CrossVenueLink[] {
  return links.slice().sort((a, b) => RULE_RANK[a.rule] - RULE_RANK[b.rule] || (b.kalshiYesMid ?? 0) - (a.kalshiYesMid ?? 0));
}

/** Resolve a Polymarket bet B and return the live, classified Kalshi markets logically tied to it. */
export async function relateCrossVenue(req: RelateRequest): Promise<RelateResult> {
  const stakeUsd = Math.max(1, req.stakeUsd ?? 20);
  const claimKind = detectClaimKind(req.query);

  // ── Try the World Cup flagship first: anchor on Kalshi's canonical champion team list. ──
  const champ = await fetchChampionMarkets().catch(() => null);
  const ent = resolveEntityFromChampion(req.query, champ);
  if (champ && ent && ent.entity) {
    return relateWorldCup(req, champ, ent.entity, claimKind, stakeUsd);
  }

  // ── GENERIC path: resolve the entity on Polymarket, then link to ANY Kalshi theme. ──
  let resolved = req.eventSlug ? await resolvePosition(req.query, req.eventSlug) : await resolveAnyPosition(req.query);
  if (resolved.kind === "not_found" && !req.eventSlug) {
    const wc = await resolvePosition(req.query, DEFAULT_SLUG);
    if (wc.kind !== "not_found") resolved = wc;
  }
  if (resolved.kind === "ambiguous") {
    return { status: "ambiguous", candidates: resolved.candidates.map((c) => ({ title: c.title, score: Number(c.score.toFixed(2)) })) };
  }
  if (resolved.kind !== "resolved") {
    return { status: "not_found", suggestions: ent?.suggestions?.length ? ent.suggestions : resolved.suggestions };
  }

  const bundle: EventBundle = resolved.bundle;
  const ref = bundle.markets[resolved.index];
  const entity = ref.groupItemTitle ?? ref.question;
  let yesMid: number | null = ref.midpointYes > 0 && ref.midpointYes < 1 ? ref.midpointYes : null;
  try {
    const mids = await fetchMidpoints([ref.tokenIdYes]);
    const m = mids.get(ref.tokenIdYes);
    if (m !== undefined) yesMid = m;
  } catch {
    /* keep snapshot mid */
  }

  const g = await relateGeneric({ entity, pmEventTitle: bundle.title, pmTags: bundle.tags, claimKind, pmYesMid: yesMid }).catch(() => ({ links: [], hedgeAnchor: undefined }));

  let hedge: CrossVenueHedge | undefined;
  if (g.hedgeAnchor) {
    const pmNoBook = await pmNoBookFor(ref.tokenIdNo);
    const h = await buildCrossVenueHedge({
      claimKind,
      entity,
      stakeUsd,
      pmYesMid: yesMid,
      partition: "generic",
      states: g.hedgeAnchor.states,
      heldIndex: g.hedgeAnchor.heldIndex,
      coverTicker: g.hedgeAnchor.coverTicker,
      coverLabel: g.hedgeAnchor.coverLabel,
      coverDeepLink: g.hedgeAnchor.coverDeepLink,
      kalshiFeeMultiplier: g.hedgeAnchor.kalshiFeeMultiplier,
      pmNoBook,
    }).catch(() => undefined);
    if (h?.available) hedge = h;
  }

  const pm = {
    entity,
    claim: `${entity} — ${bundle.title}`,
    claimKind,
    eventTitle: bundle.title,
    eventSlug: bundle.slug,
    yesMid,
    stakeUsd,
    deepLink: buildMarketDeepLink(bundle.slug),
  };

  return { status: "ok", pm, links: sortLinks(g.links), hedge, pricedAt: new Date().toISOString() };
}

/** The World Cup flagship path: the hand-built relation set + solver-sized cross-venue hedge. */
async function relateWorldCup(
  req: RelateRequest,
  champ: { title: string; markets: KalshiMarket[]; feeMultiplier: number },
  entity: string,
  claimKind: ClaimKind,
  stakeUsd: number,
): Promise<RelateResult> {
  const pmChamp = await pmChampionContext(entity, req.eventSlug);
  const gameEvent = await findEntityGameEvent(entity).catch(() => null);
  const fixtureTitle = gameEvent?.title ?? "";

  // For a MATCH claim, Kalshi names the opponent → resolve the matching Polymarket market to price B.
  let pmMatchYes: number | null = null;
  let pmMatchDeepLink: string | null = null;
  let pmMatchNoToken: string | null = null;
  if (claimKind === "match" && gameEvent) {
    const opp = opponentOf(entity, gameEvent.title);
    if (opp) {
      try {
        const rb = await resolveBet(`${entity} beats ${opp}`);
        if (rb.kind === "resolved") {
          const o = rb.fixture.outcomes[rb.viewIndex];
          if (o) {
            const mids = await fetchMidpoints([o.ref.tokenIdYes]);
            pmMatchYes = mids.get(o.ref.tokenIdYes) ?? (o.ref.midpointYes || null);
            pmMatchDeepLink = buildMarketDeepLink(o.ref.eventSlug);
            pmMatchNoToken = o.ref.tokenIdNo;
          }
        }
      } catch {
        /* PM match market not priceable — the Kalshi side is still classified */
      }
    }
  }

  const isMatch = claimKind === "match";
  const pm = {
    entity,
    claim: isMatch ? `${entity} to win ${fixtureTitle || "their next match"}` : `${entity} to win the World Cup`,
    claimKind,
    eventTitle: isMatch ? fixtureTitle || pmChamp.title : pmChamp.title,
    eventSlug: pmChamp.slug,
    yesMid: isMatch ? pmMatchYes : pmChamp.yesMid,
    stakeUsd,
    deepLink: isMatch && pmMatchDeepLink ? pmMatchDeepLink : buildMarketDeepLink(pmChamp.slug),
  };

  const [continent, match, narrative] = await Promise.all([
    continentLinks(entity, claimKind).catch(() => []),
    gameEvent ? matchLinks(entity, claimKind, gameEvent.eventTicker, gameEvent.title, pm.yesMid).catch(() => []) : Promise.resolve([]),
    narrativeLinks(entity, claimKind).catch(() => []),
  ]);
  const champion = championLinks(champ, entity, claimKind, pm.yesMid);
  const links = sortLinks([...champion, ...match, ...continent, ...narrative]);

  // ── Solver-sized cross-venue hedge from the EQUIVALENT leg (cover-all NO). ──
  let hedge: CrossVenueHedge | undefined;
  if (isMatch && gameEvent) {
    const gameMarkets = await fetchKalshiMarkets(gameEvent.eventTicker).catch(() => []);
    const self = gameMarkets.find((m) => refersTo(entity, m.label));
    if (self) {
      const pmNoBook = await pmNoBookFor(pmMatchNoToken);
      const h = await buildCrossVenueHedge({
        claimKind, entity, stakeUsd, pmYesMid: pmMatchYes, partition: "match",
        states: gameMarkets.map((m) => m.label), heldIndex: gameMarkets.findIndex((m) => m.ticker === self.ticker),
        coverTicker: self.ticker, coverLabel: entity, coverDeepLink: self.deepLink, pmNoBook,
        kalshiFeeMultiplier: gameEvent.feeMultiplier,
      }).catch(() => undefined);
      if (h?.available) hedge = h;
    }
  } else {
    const self = champ.markets.find((m) => refersTo(entity, m.label));
    if (self) {
      const pmNoBook = await pmNoBookFor(pmChamp.noToken);
      const h = await buildCrossVenueHedge({
        claimKind, entity, stakeUsd, pmYesMid: pmChamp.yesMid, partition: "champion",
        states: champ.markets.map((m) => m.label), heldIndex: champ.markets.findIndex((m) => m.ticker === self.ticker),
        coverTicker: self.ticker, coverLabel: entity, coverDeepLink: self.deepLink, pmNoBook,
        kalshiFeeMultiplier: champ.feeMultiplier,
      }).catch(() => undefined);
      if (h?.available) hedge = h;
    }
  }

  return { status: "ok", pm, links, hedge, pricedAt: new Date().toISOString() };
}
