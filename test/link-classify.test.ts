/**
 * Cross-venue relationship classifier. These are the HONESTY-critical invariants: structural
 * relations (EQUIVALENT / MUTEX / SUBSET) are ANALYTIC, but the only actionable use is
 * same-direction amplify (EQUIVALENT / SUBSET) for a cross-venue price comparison; rivals
 * (MUTEX) are context, never a short of your own bet. The (role × claimKind) matrix must
 * never upgrade a merely-correlated pairing into a guaranteed one.
 */
import { describe, expect, test } from "vitest";
import { classify } from "@/lib/link";

const ctx = { entity: "Spain", opponent: "Saudi Arabia", fixture: "Spain vs Saudi Arabia", continent: "Europe", rivalName: "France" };

describe("classify — structural (ANALYTIC, actionable)", () => {
  test("champion bet ↔ Kalshi champion market = EQUIVALENT, amplify+context, same-direction YES", () => {
    const c = classify("champion_self", "champion", ctx)!;
    expect(c.rule).toBe("EQUIVALENT");
    expect(c.provenance).toBe("ANALYTIC");
    expect(c.uses).toEqual(["amplify", "context"]); // no hedge: never short your own bet
    expect(c.uses).not.toContain("hedge");
    expect(c.side).toBe("yes"); // same direction: buy YES on the cheaper venue
  });

  test("champion bet ↔ a rival winning the cup = MUTEX, context only (not a short)", () => {
    const c = classify("champion_rival", "champion", ctx)!;
    expect(c.rule).toBe("MUTEX");
    expect(c.provenance).toBe("ANALYTIC");
    expect(c.uses).toEqual(["context"]);
    expect(c.uses).not.toContain("hedge");
  });

  test("champion bet ↔ own continent winning = SUBSET (containment)", () => {
    const c = classify("continent_self", "champion", ctx)!;
    expect(c.rule).toBe("SUBSET");
    expect(c.provenance).toBe("ANALYTIC");
  });

  test("champion bet ↔ another continent winning = MUTEX, context only", () => {
    const c = classify("continent_other", "champion", ctx)!;
    expect(c.rule).toBe("MUTEX");
    expect(c.uses).toEqual(["context"]);
  });

  test("match bet ↔ same Kalshi fixture = EQUIVALENT; siblings = MUTEX context", () => {
    expect(classify("match_self", "match", ctx)!.rule).toBe("EQUIVALENT");
    const sib = classify("match_rival", "match", ctx)!;
    expect(sib.rule).toBe("MUTEX");
    expect(sib.uses).toEqual(["context"]);
  });
});

describe("classify — speculative (context only, never a hedge)", () => {
  test("champion market vs a MATCH bet is SAME_ENTITY, not EQUIVALENT", () => {
    const c = classify("champion_self", "match", ctx)!;
    expect(c.rule).toBe("SAME_ENTITY");
    expect(c.provenance).toBe("SPECULATIVE");
    expect(c.uses).toEqual(["context"]);
  });

  test("the 'announcer says champion' archetype is NARRATIVE, speculative", () => {
    const c = classify("narrative", "champion", ctx)!;
    expect(c.rule).toBe("NARRATIVE");
    expect(c.provenance).toBe("SPECULATIVE");
    expect(c.uses).toEqual(["context"]);
  });

  test("match totals = SAME_EVENT context", () => {
    expect(classify("total_match", "match", ctx)!.rule).toBe("SAME_EVENT");
  });

  test("a rival's cup win is not a clean signal for a single-match bet → dropped", () => {
    expect(classify("champion_rival", "match", ctx)).toBeNull();
    expect(classify("continent_other", "match", ctx)).toBeNull();
  });
});
