import { describe, it, expect } from "vitest";
import { marketDimension, eventFamily } from "@/lib/relate/relationKey";
import { eventDimension, canonicalEventClass } from "@/lib/relate/ontology";

// P1: cross-domain markets must map to ORTHOGONAL dimensions (their canonical class), and every sports
// goal/score/margin family must collapse to ONE "scoreline" dimension (the user's hard rule).
describe("cross-domain hedge dimensions (template ontology)", () => {
  it("maps macro / asset / election / geopolitics to distinct dimensions", () => {
    expect(marketDimension("How many Fed rate cuts in 2026?", "business")).toBe("macro-policy");
    expect(marketDimension("What price will Bitcoin hit in June?", "crypto")).toBe("asset-price");
    expect(marketDimension("Presidential Election Winner 2028", "politics")).toBe("election");
    expect(marketDimension("Will the Iranian regime fall by June 30?", "world")).toBe("geopolitics");
  });

  it("collapses every sports goal/score family to one 'scoreline' dimension", () => {
    for (const fam of ["match_winner", "match_total", "tournament_winner", "continent_winner", "group_winner"]) {
      expect(eventDimension(fam, canonicalEventClass(fam, "soccer"))).toBe("scoreline");
    }
  });

  it("keeps genuinely orthogonal sports facets separate", () => {
    expect(eventDimension("broadcast_word", canonicalEventClass("broadcast_word", "soccer"))).toBe("narrative");
    expect(eventDimension("golden_boot", canonicalEventClass("golden_boot", "soccer"))).toBe("individual");
    expect(eventDimension("stage_advance", canonicalEventClass("stage_advance", "soccer"))).toBe("progression");
  });

  it("classifies the cross-domain family via the title before the generic /winner/ rule", () => {
    expect(eventFamily("Presidential Election Winner 2028", "politics")).toBe("election");
    expect(eventFamily("How many Fed rate cuts in 2026?", "business")).toBe("rate_decision");
  });
});
