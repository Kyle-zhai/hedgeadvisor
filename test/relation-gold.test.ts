import { describe, it, expect } from "vitest";
import { RELATION_GOLD, type GoldRelation } from "@/lib/association/relationGold";

const DIRECTIONS = new Set(["POSITIVE", "NEGATIVE", "AMBIGUOUS"]);
describe("relation gold dataset integrity", () => {
  it("has unique ids and valid, in-range fields", () => {
    const ids = new Set<string>();
    for (const g of RELATION_GOLD as GoldRelation[]) {
      expect(ids.has(g.id), `dup id ${g.id}`).toBe(false); ids.add(g.id);
      expect(DIRECTIONS.has(g.label.direction)).toBe(true);
      expect(g.label.pGivenAnchorWins).toBeGreaterThanOrEqual(0);
      expect(g.label.pGivenAnchorWins).toBeLessThanOrEqual(1);
      expect(g.label.pGivenAnchorFails).toBeGreaterThanOrEqual(0);
      expect(g.label.pGivenAnchorFails).toBeLessThanOrEqual(1);
      expect(g.anchor.title.length).toBeGreaterThan(0);
      expect(g.candidate.title.length).toBeGreaterThan(0);
    }
  });
  it("includes negative controls (UNRELATED/AMBIGUOUS)", () => {
    const negs = RELATION_GOLD.filter((g) => g.label.relation === "UNRELATED" || g.label.direction === "AMBIGUOUS");
    expect(negs.length).toBeGreaterThanOrEqual(3);
  });
  it("covers the taxonomy and has enough rows", () => {
    expect(RELATION_GOLD.length).toBeGreaterThanOrEqual(40);
    const types = new Set(RELATION_GOLD.map((g) => g.relationType));
    for (const t of ["logical-implication","logical-mutex","same-entity-causal","cross-entity","macro-chain","geopolitics-commodity","politics-sector","negative-control"]) {
      expect(types.has(t), `missing relationType ${t}`).toBe(true);
    }
  });
});
