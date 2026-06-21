import { describe, expect, test } from "vitest";
import { parseBetIntent, parseProp, resolveBetAgainst, type Fixture } from "@/lib/polymarket/fixtures";
import type { MarketRef } from "@/lib/types";

function ref(team: string): MarketRef {
  return {
    conditionId: `c-${team}`,
    eventId: "e",
    eventSlug: "fx",
    question: `Will ${team} win?`,
    groupItemTitle: team,
    tokenIdYes: `${team}-y`,
    tokenIdNo: `${team}-n`,
    midpointYes: 0.4,
    resolved: false,
    feeRate: 0.03,
    feeExponent: 1,
    feeTakerOnly: true,
    negRiskMarketId: "nr",
  };
}
function fixture(slug: string, title: string, a: string, b: string): Fixture {
  const outcomes = [a, "Draw", b].map((t, i) => ({ index: i, title: t, isDraw: t === "Draw", ref: ref(t) }));
  return { slug, title, date: slug.slice(-10), eventId: "e", negRiskMarketId: "nr", outcomes, teams: [a, b] };
}

const fixtures: Fixture[] = [
  fixture("fifwc-eng-hrv-2026-06-17", "England vs. Croatia", "England", "Croatia"),
  fixture("fifwc-fra-sen-2026-06-16", "France vs. Senegal", "France", "Senegal"),
  fixture("fifwc-ury-esp-2026-06-26", "Uruguay vs. Spain", "Uruguay", "Spain"),
  fixture("fifwc-prt-cdr-2026-06-17", "Portugal vs. Cameroon", "Portugal", "Cameroon"),
  fixture("fifwc-kor-esp-2026-06-22", "South Korea vs. Spain", "South Korea", "Spain"),
];

describe("parseBetIntent", () => {
  test("extracts two teams + scoreline + view subject from 'X beats Y N:M'", () => {
    const i = parseBetIntent("England beats Croatia 1:0");
    expect(i.scoreline).toEqual([1, 0]);
    expect(i.viewTeamHint?.toLowerCase()).toContain("england");
    expect(i.rawTeams.length).toBe(2);
  });
  test("plain 'X vs Y' has no view subject", () => {
    const i = parseBetIntent("England vs Croatia");
    expect(i.viewTeamHint).toBeNull();
    expect(i.scoreline).toBeNull();
  });
});

describe("parseProp (totals + BTTS)", () => {
  test("over/under totals", () => {
    expect(parseProp("England vs Croatia over 2.5").spec).toMatchObject({ kind: "total", side: "over", line: 2.5 });
    expect(parseProp("England vs Croatia under 1.5").spec).toMatchObject({ kind: "total", side: "under", line: 1.5 });
  });
  test("both teams to score", () => {
    expect(parseProp("both teams to score England vs Croatia").spec).toMatchObject({ kind: "btts" });
  });
  test("strips the prop so team matching stays clean (residual has the teams)", () => {
    const { residual } = parseProp("England vs Croatia over 2.5");
    expect(residual.toLowerCase()).toContain("england");
    expect(residual.toLowerCase()).toContain("croatia");
    expect(residual.toLowerCase()).not.toContain("over");
  });
  test("a plain result query has no prop", () => {
    expect(parseProp("England beats Croatia").spec).toBeNull();
  });
});

describe("resolveBetAgainst — prop bets resolve to the fixture + a prop spec", () => {
  test("'England vs Croatia over 2.5' → resolved, betType prop", () => {
    const r = resolveBetAgainst("England vs Croatia over 2.5", fixtures);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.fixture.slug).toBe("fifwc-eng-hrv-2026-06-17");
      expect(r.betType).toBe("prop");
      expect(r.prop).toMatchObject({ kind: "total", side: "over", line: 2.5 });
    }
  });
});

describe("resolveBetAgainst — real-markets guarantee", () => {
  test("'England beats Croatia' resolves to the real fixture, view = England", () => {
    const r = resolveBetAgainst("England beats Croatia", fixtures);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.fixture.slug).toBe("fifwc-eng-hrv-2026-06-17");
      expect(r.betType).toBe("result");
      expect(r.fixture.outcomes[r.viewIndex].title).toBe("England");
    }
  });

  test("'Spain vs Portugal' (NOT a real fixture) → not_found with real suggestions", () => {
    const r = resolveBetAgainst("Spain vs Portugal", fixtures);
    expect(r.kind).toBe("not_found");
    if (r.kind === "not_found") {
      // both are real teams but not a fixture → suggest fixtures involving either
      const slugs = r.suggestions.map((s) => s.slug);
      expect(slugs).toContain("fifwc-ury-esp-2026-06-26"); // Spain's real match
      expect(slugs).toContain("fifwc-prt-cdr-2026-06-17"); // Portugal's real match
    }
  });

  test("team-collapse is rejected: 'South vs Korea' must NOT fabricate a matchup", () => {
    // both phrases best-match the SAME team ("South Korea") → must be not_found, never
    // a fabricated "South Korea to beat Spain".
    const r = resolveBetAgainst("South vs Korea", fixtures);
    expect(r.kind).toBe("not_found");
  });
  test("'Korea vs Korea' is rejected (same team both sides)", () => {
    expect(resolveBetAgainst("Korea vs Korea", fixtures).kind).toBe("not_found");
  });
  test("a legit distinct multi-word matchup still resolves", () => {
    const r = resolveBetAgainst("South Korea beats Spain", fixtures);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.fixture.slug).toBe("fifwc-kor-esp-2026-06-22");
  });

  test("exact-score intent is flagged as a (gated) exact_score bet", () => {
    const r = resolveBetAgainst("England 1:0 Croatia", fixtures);
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") {
      expect(r.betType).toBe("exact_score");
      expect(r.scoreline).toEqual([1, 0]);
    }
  });
});
