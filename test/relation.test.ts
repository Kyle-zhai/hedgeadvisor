/**
 * The φ-based relation engine (spec Stages 3–5). The canonical check is the spec's own worked
 * example (France 0.18 / Mbappé 0.22 / φ=0.45 → P_ab=0.111, ratio −0.42, effectiveness 0.20),
 * plus the structural cases (mutually-exclusive longshots, containment) and the reliability
 * backstops (Fréchet clamping + confidence downgrade, extreme-probability instability).
 */
import { describe, expect, test } from "vitest";
import { buildEventRelation, frechetBounds, jointFromPhi, optimalHedgeRatio } from "@/lib/correlation";

describe("φ math core", () => {
  test("Fréchet bounds are exact", () => {
    expect(frechetBounds(0.18, 0.22)).toEqual([0, 0.18]);
    const [lo, hi] = frechetBounds(0.7, 0.6);
    expect(lo).toBeCloseTo(0.3, 9);
    expect(hi).toBeCloseTo(0.6, 9);
  });

  test("jointFromPhi matches the spec worked example (France×Mbappé)", () => {
    const { pAB, clamped } = jointFromPhi(0.18, 0.22, 0.45);
    expect(pAB).toBeCloseTo(0.1112, 3);
    expect(clamped).toBe(false);
  });

  test("optimal hedge ratio = −φ·σA/σB", () => {
    expect(optimalHedgeRatio(0.45, 0.18, 0.22)).toBeCloseTo(-0.4174, 3);
  });
});

describe("buildEventRelation — spec worked example", () => {
  const r = buildEventRelation({ pA: 0.18, pB: 0.22, estimateRho: 0.45, labelA: "France 夺冠", labelB: "Mbappé 金靴" });
  test("recovers φ ≈ 0.45 and joint ≈ 0.111", () => {
    expect(r.correlation).toBeCloseTo(0.45, 2);
    expect(r.pAB).toBeCloseTo(0.111, 2);
  });
  test("same_exposure signal, reverse hedge ratio ≈ −0.42, effectiveness ≈ 0.20", () => {
    expect(r.relation).toBe("related");
    expect(r.hedgeSignal).toBe("same_exposure");
    expect(r.hedgeRatio).toBeCloseTo(-0.42, 2);
    expect(r.effectiveness).toBeCloseTo(0.2, 2);
    expect(r.method).toBe("frechet_estimate");
    expect(r.reasoning).toContain("同向暴露");
  });
});

describe("structural relations (path 甲, high confidence)", () => {
  test("mutually-exclusive longshots → joint 0, negative φ, hedge signal, high confidence", () => {
    const r = buildEventRelation({ pA: 0.196, pB: 0.059, structuralJoint: 0, structuralKind: "exclusive", labelA: "France", labelB: "Brazil", liquidityOk: true });
    expect(r.relation).toBe("mutually_exclusive");
    expect(r.pAB).toBe(0);
    expect(r.correlation).toBeLessThan(0);
    expect(r.hedgeSignal).toBe("hedge");
    expect(r.confidence).toBe("high");
    // honest: two longshots barely hedge each other (low effectiveness)
    expect(r.effectiveness).toBeLessThan(0.1);
  });

  test("containment (subset) → strong positive φ, same_exposure, not a hedge", () => {
    const r = buildEventRelation({ pA: 0.124, pB: 0.45, structuralJoint: 0.124, structuralKind: "subset", labelA: "England 夺冠", labelB: "欧洲夺冠", liquidityOk: true });
    expect(r.relation).toBe("related");
    expect(r.correlation).toBeGreaterThan(0.3);
    expect(r.hedgeSignal).toBe("same_exposure");
    expect(r.confidence).toBe("high");
  });
});

describe("reliability backstops", () => {
  test("a Fréchet-impossible φ is clamped and confidence downgraded", () => {
    // ρ=0.95 with pA=0.18,pB=0.22 implies joint 0.18·0.22+0.95·σσ > min(0.18,0.22)=0.18 → clamp
    const r = buildEventRelation({ pA: 0.18, pB: 0.22, estimateRho: 0.95, liquidityOk: true });
    expect(r.frechetViolated).toBe(true);
    expect(r.pAB).toBeLessThanOrEqual(0.18 + 1e-9);
    expect(r.confidence).not.toBe("high"); // downgraded by the violation
  });

  test("independence default is at most medium confidence", () => {
    const r = buildEventRelation({ pA: 0.3, pB: 0.4, liquidityOk: true });
    expect(r.method).toBe("independence");
    expect(r.relation).toBe("independent");
    expect(r.correlation).toBeCloseTo(0, 4);
    expect(["medium", "low"]).toContain(r.confidence);
  });

  test("extreme marginals downgrade confidence (φ unstable near 0/1)", () => {
    const r = buildEventRelation({ pA: 0.99, pB: 0.5, estimateRho: 0.3, liquidityOk: true });
    expect(["medium", "low"]).toContain(r.confidence);
  });
});
