import { describe, expect, test } from "vitest";
import { deriveAutoJobs } from "@/lib/relate/autoBackfill";

const px = (yes: number) => JSON.stringify([String(yes), String(1 - yes)]);

describe("auto-backfill: deterministic structural discovery from settled PM events", () => {
  test("negRisk single-winner event ⇒ cross_entity|logical rivals, anchor alternates for branch balance", () => {
    const ev = {
      slug: "nba-champion-2099", title: "NBA Champion", negRisk: true, closed: true,
      markets: [
        { conditionId: "0xaaaa01", groupItemTitle: "Team A", outcomePrices: px(1), volumeNum: 100 }, // winner
        { conditionId: "0xbbbb02", groupItemTitle: "Team B", outcomePrices: px(0), volumeNum: 90 },
        { conditionId: "0xcccc03", groupItemTitle: "Team C", outcomePrices: px(0), volumeNum: 80 },
      ],
    };
    const jobs = deriveAutoJobs([ev], 0);
    expect(jobs.length).toBe(2); // winner vs top-2 rivals
    for (const j of jobs) {
      expect(j.relation.role).toBe("cross_entity");
      expect(j.relation.mechanismSignature!.startsWith("logical.cross_entity")).toBe(true);
      expect(j.relation.anchorFamily).toBe("competition_winner");
    }
    // counter 0 → anchor = winner (Team A); counter 1 → anchor = rival (loser)
    expect(jobs[0].anchor.marketId).toBe("0xaaaa01"); // win-branch sample
    expect(jobs[1].anchor.marketId).not.toBe("0xaaaa01"); // fail-branch sample (anchor is a loser)
  });

  test("numeric-threshold ladder (non-negRisk) ⇒ same_entity|logical subset pairs (higher ⊆ lower)", () => {
    const ev = {
      slug: "btc-price-dec-2099", title: "What price will Bitcoin hit in December?", negRisk: false, closed: true,
      markets: [
        { conditionId: "0x100k", groupItemTitle: "$100k", outcomePrices: px(1), volumeNum: 50 },
        { conditionId: "0x105k", groupItemTitle: "$105k", outcomePrices: px(1), volumeNum: 40 },
        { conditionId: "0x110k", groupItemTitle: "$110k", outcomePrices: px(0), volumeNum: 30 },
      ],
    };
    const jobs = deriveAutoJobs([ev], 0);
    expect(jobs.length).toBe(2); // (100k,105k) and (105k,110k)
    for (const j of jobs) {
      expect(j.relation.role).toBe("same_entity");
      expect(j.relation.mechanismSignature!.startsWith("logical.same_entity")).toBe(true);
      expect(j.relation.anchorFamily).toBe("asset_price_threshold");
    }
    // anchor = the HIGHER threshold (the subset); candidate = lower (the superset)
    expect(jobs[0].anchor.marketId).toBe("0x105k");
    expect(jobs[0].candidate.marketId).toBe("0x100k");
  });

  test("ignores unsettled markets and events with <2 settled outcomes", () => {
    expect(deriveAutoJobs([{ slug: "x", title: "X", negRisk: true, closed: true,
      markets: [{ conditionId: "0x1", groupItemTitle: "A", outcomePrices: px(0.5) }] }], 0)).toHaveLength(0);
    expect(deriveAutoJobs([{ slug: "y", title: "Y", negRisk: true, closed: false, markets: [] }], 0)).toHaveLength(0);
  });
});
