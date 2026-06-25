import { describe, expect, test } from "vitest";
import { deriveAutoJobs } from "@/lib/relate/autoBackfill";

const px = (yes: number) => JSON.stringify([String(yes), String(1 - yes)]);

describe("auto-backfill: deterministic structural discovery from settled PM events", () => {
  test("genuine 2-way exclusive ⇒ ONE cross_entity|logical pair of the two real contenders (no winner-pairing artifact)", () => {
    const ev = {
      slug: "ohio-senate-2099", title: "Ohio US Senate Election", negRisk: true, closed: true,
      markets: [
        { conditionId: "0xdem01", groupItemTitle: "Democrat", outcomePrices: px(0), volumeNum: 100 }, // lost
        { conditionId: "0xrep02", groupItemTitle: "Republican", outcomePrices: px(1), volumeNum: 95 }, // won
        { conditionId: "0xoth03", groupItemTitle: "Another party", outcomePrices: px(0), volumeNum: 1 }, // negligible → dropped
      ],
    };
    const jobs = deriveAutoJobs([ev]);
    expect(jobs.length).toBe(1); // exactly one pair: the two real contenders (not the negligible 3rd)
    expect(jobs[0].relation.role).toBe("cross_entity");
    expect(jobs[0].relation.mechanismSignature!.startsWith("logical.cross_entity")).toBe(true);
    const ids = [jobs[0].anchor.marketId, jobs[0].candidate.marketId].sort();
    expect(ids).toEqual(["0xdem01", "0xrep02"]); // the two mains, never the negligible "Another party"
  });

  test("multi-way FIELD (3+ real contenders, e.g. World Cup) ⇒ SKIPPED — not a logical 2-way hedge", () => {
    const ev = {
      slug: "world-cup-winner-2099", title: "World Cup Winner", negRisk: true, closed: true,
      markets: [
        { conditionId: "0xfra01", groupItemTitle: "France", outcomePrices: px(0), volumeNum: 100 },
        { conditionId: "0xspa02", groupItemTitle: "Spain", outcomePrices: px(1), volumeNum: 90 },
        { conditionId: "0xbra03", groupItemTitle: "Brazil", outcomePrices: px(0), volumeNum: 85 },
      ],
    };
    expect(deriveAutoJobs([ev])).toHaveLength(0); // a 32-team field is not logically exclusive
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
    const jobs = deriveAutoJobs([ev]);
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
      markets: [{ conditionId: "0x1", groupItemTitle: "A", outcomePrices: px(0.5) }] }])).toHaveLength(0);
    expect(deriveAutoJobs([{ slug: "y", title: "Y", negRisk: true, closed: false, markets: [] }])).toHaveLength(0);
  });
});
