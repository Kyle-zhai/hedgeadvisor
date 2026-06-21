/**
 * lib/polymarket/fixtures.ts — discover REAL live World Cup match fixtures and
 * resolve a free-text bet intent ("England beats Croatia", "England vs Croatia 1:0")
 * to a real market. This is the "only real markets" guarantee.
 *
 * Why this exists (verified 2026-06-15):
 *  - The Gamma `search` param is BROKEN (returns elections/crypto). Use TAG ENUMERATION.
 *  - Slugs (fifwc-{home}-{away}-{date}) use inconsistent team codes (kr/kor, prt/esp),
 *    so you CANNOT synthesize a slug from a team name — you match against the live dump.
 *  - "Spain vs Portugal" is not a real fixture (different groups) → must be rejected
 *    with real suggestions, never fabricated.
 */
import type { MarketRef } from "@/lib/types";
import { gammaGet, parseJsonArray } from "./client";
import { tokenSetScore, fetchEventBundle } from "./resolve";
import { fetchMidpoints } from "./discovery";
import { devigDetailed } from "@/lib/correlation";

const WC_TAG = process.env.HEDGE_WC_TAG_SLUG ?? "fifa-world-cup";
const FIXTURE_SLUG = /^fifwc-[a-z]+-[a-z]+-\d{4}-\d{2}-\d{2}$/; // bare 1X2 result event

interface RawMarket {
  conditionId?: string;
  question?: string;
  groupItemTitle?: string;
  clobTokenIds?: string | string[];
  outcomePrices?: string | string[];
  closed?: boolean;
  resolved?: boolean;
  feeSchedule?: { rate?: number; exponent?: number; takerOnly?: boolean };
  feesEnabled?: boolean;
}
interface RawEvent {
  id?: string;
  slug?: string;
  title?: string;
  negRisk?: boolean;
  negRiskMarketID?: string;
  closed?: boolean;
  active?: boolean;
  markets?: RawMarket[];
}

export interface FixtureOutcome {
  index: number;
  title: string; // "England" | "Draw" | "Croatia"
  isDraw: boolean;
  ref: MarketRef;
}
export interface Fixture {
  slug: string;
  title: string;
  date: string; // YYYY-MM-DD
  eventId: string;
  negRiskMarketId: string | null;
  outcomes: FixtureOutcome[];
  teams: string[]; // non-draw outcome titles
}

function toRef(raw: RawMarket, e: RawEvent): MarketRef | null {
  const tokenIds = parseJsonArray(raw.clobTokenIds);
  if (tokenIds.length < 2 || !raw.conditionId) return null;
  const prices = parseJsonArray(raw.outcomePrices).map(Number);
  return {
    conditionId: raw.conditionId,
    eventId: String(e.id ?? ""),
    eventSlug: String(e.slug ?? ""),
    question: raw.question ?? "",
    groupItemTitle: raw.groupItemTitle ?? null,
    tokenIdYes: tokenIds[0],
    tokenIdNo: tokenIds[1],
    midpointYes: Number.isFinite(prices[0]) ? prices[0] : 0,
    resolved: Boolean(raw.resolved || raw.closed),
    feeRate: raw.feesEnabled === false ? 0 : raw.feeSchedule?.rate ?? 0.03,
    feeExponent: raw.feeSchedule?.exponent ?? 1,
    feeTakerOnly: raw.feeSchedule?.takerOnly ?? true,
    negRiskMarketId: e.negRiskMarketID ?? null,
  };
}

function toFixture(e: RawEvent): Fixture | null {
  const slug = String(e.slug ?? "");
  if (!FIXTURE_SLUG.test(slug)) return null;
  const outcomes: FixtureOutcome[] = [];
  (e.markets ?? []).forEach((m, i) => {
    const ref = toRef(m, e);
    if (!ref) return;
    const title = ref.groupItemTitle ?? ref.question;
    outcomes.push({ index: outcomes.length, title, isDraw: /draw|tie/i.test(title), ref });
  });
  if (outcomes.length < 2) return null;
  return {
    slug,
    title: e.title ?? slug,
    date: slug.slice(-10),
    eventId: String(e.id ?? ""),
    negRiskMarketId: e.negRiskMarketID ?? null,
    outcomes,
    teams: outcomes.filter((o) => !o.isDraw).map((o) => o.title),
  };
}

/** Live: enumerate open WC fixtures via tag pagination (NOT the broken search param). */
export async function fetchFixtures(maxPages = 8): Promise<Fixture[]> {
  const out: Fixture[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const offset = page * 100;
    let evs: RawEvent[];
    try {
      evs = await gammaGet<RawEvent[]>(
        `/events?closed=false&active=true&tag_slug=${encodeURIComponent(WC_TAG)}&limit=100&offset=${offset}`,
      );
    } catch {
      break;
    }
    if (!Array.isArray(evs) || evs.length === 0) break;
    for (const e of evs) {
      const fx = toFixture(e);
      if (fx && !seen.has(fx.slug) && !fx.outcomes.every((o) => o.ref.resolved)) {
        seen.add(fx.slug);
        out.push(fx);
      }
    }
    if (evs.length < 100) break;
  }
  return out;
}

// ── bet-intent parsing ──
export interface BetIntent {
  rawTeams: string[]; // up to 2 team-ish phrases the user typed
  scoreline: [number, number] | null; // e.g. [1,0]
  // the subject ("X beats Y" / "X 1:0" => X is the view team); null if just "X vs Y"
  viewTeamHint: string | null;
}

export function parseBetIntent(query: string): BetIntent {
  const q = query.trim();
  const score = q.match(/(\d+)\s*[:\-]\s*(\d+)/);
  const scoreline: [number, number] | null = score ? [Number(score[1]), Number(score[2])] : null;

  // One separator: "vs / beats / against / over / defeats" OR a scoreline (which sits
  // BETWEEN the two teams, e.g. "England 1:0 Croatia"). Split on any of them.
  const sep = /\s*(?:vs\.?|versus|beats?|against|over|defeats?|to beat|\d+\s*[:-]\s*\d+)\s*/i;
  const strip = (p: string) =>
    p.replace(/\b(win|wins|winning|to|the|world|cup|match|game|fifa|2026)\b/gi, "").trim();
  const rawTeams = q.split(sep).map(strip).filter(Boolean).slice(0, 2);

  // "X beats Y" / "X 1:0 Y" => X (first side) is the view team; plain "X vs Y" => no subject.
  const subjectByVerb = /\b(beats?|defeats?|over|to beat)\b/i.test(q);
  const viewTeamHint = (subjectByVerb || scoreline) && rawTeams.length >= 1 ? rawTeams[0] : null;
  return { rawTeams, scoreline, viewTeamHint };
}

// ── prop bets (match totals + both-teams-to-score; deep, no team ambiguity) ──
export interface PropSpec {
  kind: "total" | "btts";
  side: "over" | "under" | "yes";
  line?: number;
  label: string;
}

/** Extract a prop bet and return the query with the prop phrase removed (so team
 *  matching runs on the residual). Handles match totals (over/under N.5) and BTTS. */
export function parseProp(query: string): { spec: PropSpec | null; residual: string } {
  if (/\b(both teams to score|btts)\b/i.test(query) && !/(first|1st|second|2nd)\s*half/i.test(query)) {
    return {
      spec: { kind: "btts", side: "yes", label: "Both teams to score" },
      residual: query.replace(/\b(both teams to score|btts)\b/gi, " "),
    };
  }
  const t = query.match(/\b(over|under)\s*(\d+(?:\.\d+)?)\b/i);
  if (t) {
    const side = t[1].toLowerCase() === "over" ? "over" : "under";
    const line = Number(t[2]);
    return {
      spec: { kind: "total", side, line, label: `${side === "over" ? "Over" : "Under"} ${line} goals` },
      residual: query.replace(t[0], " "),
    };
  }
  return { spec: null, residual: query };
}

/** Resolve a prop spec to the real market + the side/token to buy, in -more-markets. */
export async function resolvePropMarket(
  fixtureSlug: string,
  spec: PropSpec,
): Promise<{ ref: MarketRef; tokenId: string; side: "buy_yes" | "buy_no"; q: number; desc: string } | null> {
  const bundle = await fetchEventBundle(`${fixtureSlug}-more-markets`);
  if (!bundle) return null;
  let target: MarketRef | undefined;
  if (spec.kind === "btts") {
    target = bundle.markets.find((m) => (m.groupItemTitle ?? "").toLowerCase() === "both teams to score");
  } else {
    const want = `o/u ${spec.line}`;
    target = bundle.markets.find((m) => (m.groupItemTitle ?? "").toLowerCase() === want);
  }
  if (!target || target.resolved) return null;
  // De-vig the binary off LIVE midpoints (yes/(yes+no)) so q is a TRUE probability,
  // consistent with the live book the leg is priced against. A raw/stale YES midpoint can
  // exceed the live ask and make EV look POSITIVE — the honesty backbone forbids that.
  let yesLive = target.midpointYes;
  let noLive = 1 - target.midpointYes;
  try {
    const mids = await fetchMidpoints([target.tokenIdYes, target.tokenIdNo]);
    yesLive = mids.get(target.tokenIdYes) ?? yesLive;
    noLive = mids.get(target.tokenIdNo) ?? noLive;
  } catch {
    /* keep snapshot fallback */
  }
  const denom = yesLive + noLive || 1;
  const yesQ = Math.min(0.99, Math.max(0.001, yesLive / denom));
  if (spec.side === "under") {
    return { ref: target, tokenId: target.tokenIdNo, side: "buy_no", q: Math.min(0.99, Math.max(0.001, 1 - yesQ)), desc: spec.label };
  }
  return { ref: target, tokenId: target.tokenIdYes, side: "buy_yes", q: yesQ, desc: spec.label };
}

// ── resolution against the live fixture set ──
export type BetType = "result" | "exact_score" | "prop";
export type ResolveBetResult =
  | {
      kind: "resolved";
      fixture: Fixture;
      betType: BetType;
      viewIndex: number; // index into fixture.outcomes for the team the user backs
      scoreline: [number, number] | null;
      prop?: PropSpec;
    }
  | { kind: "ambiguous"; matches: { slug: string; title: string }[] }
  | { kind: "not_found"; suggestions: { slug: string; title: string }[] };

function teamScore(query: string, team: string): number {
  return tokenSetScore(query, team);
}

/** Find the fixture that contains BOTH named teams; suggest real fixtures otherwise. */
export function resolveBetAgainst(query: string, fixtures: Fixture[]): ResolveBetResult {
  const { spec: propSpec, residual } = parseProp(query); // strip prop so team matching is clean
  const intent = parseBetIntent(residual);
  const teamUniverse = new Set<string>();
  fixtures.forEach((f) => f.teams.forEach((t) => teamUniverse.add(t)));

  // best-matching team for each side the user typed (keep nulls to preserve alignment)
  const matched = intent.rawTeams.map((rt) => {
    let best = "";
    let bestScore = 0;
    for (const t of teamUniverse) {
      const sc = teamScore(rt, t);
      if (sc > bestScore) {
        bestScore = sc;
        best = t;
      }
    }
    return bestScore >= 0.5 ? best : null;
  });

  const a = matched[0] ?? null;
  const b = matched[1] ?? null;
  // ⚠️ Must be TWO DISTINCT real teams. "South vs Korea" / "Korea vs Korea" both collapse
  // to one team ("South Korea") — that must NOT fabricate a matchup against some other team.
  if (!a || !b || a === b) {
    const team = a ?? b;
    const involving = team
      ? fixtures.filter((f) => f.teams.includes(team)).slice(0, 6)
      : fixtures.slice(0, 6);
    return { kind: "not_found", suggestions: involving.map((f) => ({ slug: f.slug, title: f.title })) };
  }
  const fixture = fixtures.find((f) => f.teams.includes(a) && f.teams.includes(b));
  if (!fixture) {
    // both teams are real but NOT a real fixture (e.g. Spain vs Portugal, different groups)
    const involving = fixtures
      .filter((f) => f.teams.includes(a) || f.teams.includes(b))
      .slice(0, 6)
      .map((f) => ({ slug: f.slug, title: f.title }));
    return { kind: "not_found", suggestions: involving };
  }

  // view team = the subject hint, else default to the first matched team
  const viewTeamName = intent.viewTeamHint
    ? [a, b].find((t) => teamScore(intent.viewTeamHint!, t) >= 0.5) ?? a
    : a;
  const viewIndex = fixture.outcomes.findIndex((o) => o.title === viewTeamName);
  const betType: BetType = intent.scoreline ? "exact_score" : propSpec ? "prop" : "result";
  return {
    kind: "resolved",
    fixture,
    betType,
    viewIndex: viewIndex >= 0 ? viewIndex : 0,
    scoreline: intent.scoreline,
    prop: propSpec ?? undefined,
  };
}

/** Live convenience: fetch fixtures then resolve. */
export async function resolveBet(query: string): Promise<ResolveBetResult> {
  const fixtures = await fetchFixtures();
  return resolveBetAgainst(query, fixtures);
}

/**
 * Resolve a scoreline to the real exact-score cell. Cell titles are "{home} h - a {away}"
 * (score relative to the fixture's home/away, NOT the user's view team), so we orient the
 * user's [viewScore, oppScore] correctly whether the view team is home or away.
 */
export async function resolveExactScoreCell(
  fixtureSlug: string,
  viewTeam: string,
  scoreline: [number, number],
): Promise<{ ref: MarketRef; title: string; gridYesSum: number } | null> {
  const bundle = await fetchEventBundle(`${fixtureSlug}-exact-score`);
  if (!bundle) return null;
  // Sum of all cells' YES prices = 1 + overround → lets the caller de-vig a single cell
  // into a true probability (a raw cell midpoint overstates probability and flatters EV).
  const gridYesSum = bundle.markets.reduce((s, m) => s + (m.midpointYes > 0 ? m.midpointYes : 0), 0) || 1;
  const [vs, os] = scoreline;
  for (const m of bundle.markets) {
    const t = m.groupItemTitle ?? "";
    const mm = t.match(/^(.+?)\s+(\d+)\s*-\s*(\d+)\s+(.+)$/);
    if (!mm) continue;
    const home = mm[1];
    const h = Number(mm[2]);
    const a = Number(mm[3]);
    const away = mm[4];
    if (tokenSetScore(viewTeam, home) >= 0.6 && h === vs && a === os) return { ref: m, title: t, gridYesSum };
    if (tokenSetScore(viewTeam, away) >= 0.6 && a === vs && h === os) return { ref: m, title: t, gridYesSum };
  }
  return null;
}

export interface ExactScoreCell {
  ref: MarketRef;
  title: string; // "Spain 0 - 0 Cabo Verde" | "Any other score"
  q: number; // de-vigged across the whole grid (a TRUE probability)
}
export interface ExactScoreGrid {
  cells: ExactScoreCell[];
  viewIndex: number; // index into cells of the user's chosen scoreline; -1 if not present
  viewTitle: string; // the matched cell's title (or a synthesized "{team} v-o" label)
}

/**
 * Resolve a scoreline to the FULL exact-score partition (every cell + the "Any other
 * score" catch-all), so the bet-plan engine can build a real multi-leg hedge AROUND the
 * chosen cell — not just price the single cell. The grid is mutually exclusive and sums
 * to ~1, so it's a clean partition: q is de-vigged off LIVE midpoints (sum = 1+overround),
 * consistent with the books each leg is later walked against.
 */
export async function resolveExactScoreGrid(
  fixtureSlug: string,
  viewTeam: string,
  scoreline: [number, number],
): Promise<ExactScoreGrid | null> {
  const bundle = await fetchEventBundle(`${fixtureSlug}-exact-score`);
  if (!bundle) return null;
  const raw = bundle.markets.filter((m) => !m.resolved);
  if (raw.length === 0) return null;

  // Live midpoints for the whole grid (fall back to the Gamma snapshot on any miss).
  let mids = new Map<string, number>();
  try {
    mids = await fetchMidpoints(raw.map((m) => m.tokenIdYes));
  } catch {
    /* snapshot fallback below */
  }
  const liveMid = (m: MarketRef) => Math.max(0, mids.get(m.tokenIdYes) ?? m.midpointYes);
  // De-vig the whole score grid with the best valid method (Shin → power → proportional).
  // The exact-score grid is the most skewed/multi-outcome partition we price, so the
  // favourite–longshot correction matters most here.
  const gridQ = devigDetailed(raw.map(liveMid)).q;

  const [vs, os] = scoreline;
  let viewIndex = -1;
  let viewTitle = `${viewTeam} ${vs}-${os}`;
  const cells: ExactScoreCell[] = raw.map((m, i) => {
    const title = m.groupItemTitle ?? m.question;
    const q = Math.min(0.99, Math.max(0.0005, gridQ[i]));
    if (viewIndex < 0) {
      const mm = title.match(/^(.+?)\s+(\d+)\s*-\s*(\d+)\s+(.+)$/);
      if (mm) {
        const home = mm[1];
        const h = Number(mm[2]);
        const a = Number(mm[3]);
        const away = mm[4];
        if (tokenSetScore(viewTeam, home) >= 0.6 && h === vs && a === os) {
          viewIndex = i;
          viewTitle = title;
        } else if (tokenSetScore(viewTeam, away) >= 0.6 && a === vs && h === os) {
          viewIndex = i;
          viewTitle = title;
        }
      }
    }
    return { ref: m, title, q };
  });
  return { cells, viewIndex, viewTitle };
}
