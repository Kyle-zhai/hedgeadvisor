import { describe, it, expect } from "vitest";
import { walkForwardByBucket } from "@/lib/relate/bucketBacktest";
import type { AssociationBacktestRow } from "@/lib/association/backtest";

// relationKey that parseRelationKey maps to leaf bucket "cross_entity|logical|negative|yes"
const HEDGE_KEY = "famA->famB->cross_entity:m=logical.cross_entity.concurrent.event_class.negative.edges=inhibits->x->yes";
const day = (i: number) => `2026-01-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`;

function rows(n: number, key: string, payFailRate: number, payWinRate: number, cluster: (i: number) => string): AssociationBacktestRow[] {
  return Array.from({ length: n }, (_, i) => {
    const anchorPays = i % 2 === 1; // alternate branches
    const candidatePays = anchorPays ? i % 10 < payWinRate * 10 : i % 10 < payFailRate * 10;
    return { relationKey: key, sampleKey: `s${i}`, clusterKey: cluster(i), anchorPays, candidatePays, resolvedAt: `2026-${String(Math.floor(i / 27) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}T00:00:00Z`, observedAt: "2025-12-01T00:00:00Z", candidatePrice: 0.3 };
  });
}

describe("walkForwardByBucket", () => {
  it("a dense hedge bucket (≥20/branch, positive specificity) becomes actionable out-of-sample", () => {
    // fail→cand pays 90%, win→cand pays 10% ⇒ strong positive hedge specificity
    const r = walkForwardByBucket(rows(80, HEDGE_KEY, 0.9, 0.1, (i) => `cl${i}`), { minSamplesPerBranch: 20, credibleLevel: 0.95 });
    expect(r.buckets).toBe(1);
    expect(r.actionable).toBeGreaterThan(0);
    expect(r.byBucket["cross_entity|logical|negative|yes"].actionable).toBeGreaterThan(0);
    expect(r.byBucket["cross_entity|logical|negative|yes"].meanSpecLower).toBeGreaterThan(0);
    expect(r.leakageViolations).toBe(0); // all unique clusters
  });
  it("a sparse bucket never reaches actionable", () => {
    const r = walkForwardByBucket(rows(6, HEDGE_KEY, 0.9, 0.1, (i) => `cl${i}`), { minSamplesPerBranch: 20 });
    expect(r.actionable).toBe(0);
  });
  it("counts leakage when earlier same-bucket rows share the test cluster (and excludes them from training)", () => {
    // force all rows into 2 clusters → many same-cluster earlier rows ⇒ leakage flagged, training starved
    const r = walkForwardByBucket(rows(40, HEDGE_KEY, 0.9, 0.1, (i) => `shared${i % 2}`), { minSamplesPerBranch: 20 });
    expect(r.leakageViolations).toBeGreaterThan(0);
    expect(r.actionable).toBe(0); // cluster-dedup starves training ⇒ nothing calibrates
  });
  it("rows with unparseable relationKeys are dropped", () => {
    const bad: AssociationBacktestRow[] = [{ relationKey: "nonsense", sampleKey: "s", clusterKey: "c", anchorPays: false, candidatePays: true, resolvedAt: day(1), observedAt: "2025-12-01T00:00:00Z", candidatePrice: 0.3 }];
    expect(walkForwardByBucket(bad).rows).toBe(0);
  });
});
