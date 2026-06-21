/**
 * Generic (theme-agnostic) cross-venue linking: the pure pieces that must hold without network —
 * keyword→category routing, the shared matcher's safety (entity containment, no false matches),
 * the generic relation classifications, and the Kalshi fee schedule used to cost cross-venue legs.
 */
import { describe, expect, test } from "vitest";
import { routeCategories, partitionsAligned } from "@/lib/link";
import { refersTo, entityMatches, sameSubject, titleOverlap, parseEntityQuery } from "@/lib/link";
import { classify } from "@/lib/link";
import { kalshiTakerFeeUsd, SPORTS_FEE, takerFeeUsd } from "@/lib/netcost";

describe("routeCategories — keyword → Kalshi category", () => {
  test("politics bet routes to Politics", () => {
    expect(routeCategories("2028 presidential election winner Trump")).toContain("Politics");
  });
  test("crypto bet routes to Crypto", () => {
    expect(routeCategories("Will Bitcoin reach $200,000")).toContain("Crypto");
  });
  test("economics bet routes to Economics", () => {
    expect(routeCategories("Fed interest rate cut in 2026 CPI")).toContain("Economics");
  });
  test("never returns empty (falls back to a broad set)", () => {
    expect(routeCategories("some unmatched gibberish xyzzy").length).toBeGreaterThan(0);
  });
  test("ranks by signal strength so a strong category is never dropped by the cap", () => {
    // a company bet that also trips macro/crypto/sports keywords must KEEP Companies
    const cats = routeCategories("company earnings IPO merger CEO stock shares revenue with one rate mention and a coin");
    expect(cats).toContain("Companies");
  });
});

describe("partition-identity gate (the cardinal honesty guard)", () => {
  test("nominee vs winner are DIFFERENT partitions → not aligned (no false EQUIVALENT)", () => {
    expect(partitionsAligned("2028 US Presidential Election Winner", "2028 Republican Presidential Nominee")).toBe(false);
    expect(partitionsAligned("World Cup Winner", "World Cup Group D Winner")).toBe(false);
  });
  test("winner vs winner (same partition) IS aligned", () => {
    expect(partitionsAligned("2026 World Cup Winner", "2026 World Soccer Cup Winner")).toBe(true);
  });
});

describe("subject disambiguation (no relative matched as EQUIVALENT)", () => {
  test("sameSubject rejects a generational-suffix mismatch but keeps the principal", () => {
    expect(sameSubject("Trump", "Donald Trump Jr")).toBe(false);
    expect(sameSubject("Donald Trump", "Donald Trump Jr")).toBe(false);
    expect(sameSubject("Trump", "Donald Trump")).toBe(true);
    expect(sameSubject("Newsom", "Gavin Newsom")).toBe(true);
    expect(sameSubject("Robert F Kennedy", "Robert F Kennedy Jr")).toBe(false);
  });
});

describe("shared matcher safety", () => {
  test("entity containment: Spain matches Spain, not Saudi Arabia", () => {
    expect(refersTo("Spain", "Spain")).toBe(true);
    expect(refersTo("Spain", "Saudi Arabia")).toBe(false);
    expect(refersTo("United States", "United States")).toBe(true);
    expect(refersTo("United States", "United Kingdom")).toBe(false);
  });
  test("entityMatches is symmetric (full name ↔ surname) but still strict", () => {
    expect(entityMatches("Gavin Newsom", "Newsom")).toBe(true); // full → surname
    expect(entityMatches("Newsom", "Gavin Newsom")).toBe(true); // surname → full
    expect(entityMatches("Trump", "Donald Trump")).toBe(true);
    expect(entityMatches("Spain", "Saudi Arabia")).toBe(false); // no false match
    expect(entityMatches("Newsom", "Harris")).toBe(false);
  });
  test("parseEntityQuery strips claim/category words to the bare entity", () => {
    expect(parseEntityQuery("Spain wins next match")).toBe("spain");
    expect(parseEntityQuery("Trump to win the 2028 election")).toContain("trump");
  });
  test("titleOverlap is a symmetric token fraction", () => {
    expect(titleOverlap("World Cup Winner", "World Cup Winner")).toBe(1);
    expect(titleOverlap("World Cup Winner", "totally unrelated text")).toBe(0);
    expect(titleOverlap("2028 Democratic Nominee", "2028 Republican Nominee")).toBeGreaterThan(0);
  });
});

describe("generic classify roles", () => {
  const ctx = { entity: "Trump", rivalName: "Newsom" };
  test("generic_self → EQUIVALENT, amplify+context, same-direction YES", () => {
    const c = classify("generic_self", "generic", ctx)!;
    expect(c.rule).toBe("EQUIVALENT");
    expect(c.provenance).toBe("ANALYTIC");
    expect(c.side).toBe("yes");
    expect(c.uses).toEqual(["amplify", "context"]);
    expect(c.uses).not.toContain("hedge");
  });
  test("generic_sibling → MUTEX, context only (not a short)", () => {
    const c = classify("generic_sibling", "generic", ctx)!;
    expect(c.rule).toBe("MUTEX");
    expect(c.provenance).toBe("ANALYTIC");
    expect(c.uses).toEqual(["context"]);
  });
  test("generic_same_entity / generic_narrative are SPECULATIVE context", () => {
    expect(classify("generic_same_entity", "generic", ctx)!.provenance).toBe("SPECULATIVE");
    expect(classify("generic_narrative", "generic", ctx)!.uses).toEqual(["context"]);
  });
});

describe("Kalshi fee schedule", () => {
  test("Kalshi fee (rate 0.07) is higher than Polymarket sports (0.03) at the same price", () => {
    const p = 0.5;
    const k = kalshiTakerFeeUsd(100, p);
    const s = takerFeeUsd(100, p, "buy", SPORTS_FEE);
    expect(k).toBeGreaterThan(s);
    // peaks at p=0.5: 0.07 * 100 * 0.5 * 0.5 = 1.75
    expect(k).toBeCloseTo(1.75, 3);
  });
});
