import { describe, it, expect } from "vitest";
import { selectFewShot, renderFewShot } from "@/lib/association/relationFewShot";
import { RELATION_GOLD } from "@/lib/association/relationGold";

describe("few-shot selection", () => {
  it("picks diverse exemplars and excludes a held-out id (leave-one-out)", () => {
    const holdout = RELATION_GOLD[0].id;
    const picks = selectFewShot(RELATION_GOLD, 5, holdout);
    expect(picks.length).toBeLessThanOrEqual(5);
    expect(picks.some((p) => p.id === holdout)).toBe(false);
    expect(new Set(picks.map((p) => p.relationType)).size).toBe(picks.length); // one per type
  });
  it("renders exemplars as text", () => {
    const txt = renderFewShot(selectFewShot(RELATION_GOLD, 3));
    expect(txt).toContain("->");
    expect(txt.length).toBeGreaterThan(0);
  });
});
