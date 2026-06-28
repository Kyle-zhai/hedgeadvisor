import { describe, expect, test } from "vitest";
import { historicalPairCutoffMs, historicalPointAtOrBefore, auditManifestClusters, type HistoricalBackfillJob } from "@/lib/relate/historicalBackfill";

const job = (id: string, clusterKey: string, anchorId: string, candId: string): HistoricalBackfillJob => ({
  id, clusterKey,
  anchor: { venue: "polymarket", eventKey: "e1", marketId: anchorId },
  candidate: { venue: "polymarket", eventKey: "e2", marketId: candId },
  relation: { anchorFamily: "tournament_winner", candidateFamily: "asset_price", predicate: "p", role: "cross_domain", side: "yes" },
});

describe("historical provider backfill", () => {
  test("selects the last genuine point before cutoff and never falls forward", () => {
    const history = [{ t: 100, p: 0.2 }, { t: 200, p: 0.3 }, { t: 300, p: 0.4 }];
    expect(historicalPointAtOrBefore(history, 250_000)).toEqual({ t: 200, p: 0.3 });
    expect(historicalPointAtOrBefore(history, 50_000)).toBeNull();
  });

  test("rejects terminal and invalid prices", () => {
    const history = [{ t: 100, p: 0 }, { t: 200, p: 1 }, { t: 300, p: 0.55 }];
    expect(historicalPointAtOrBefore(history, 250_000)).toBeNull();
  });

  test("places a joint cutoff before the first leg resolves", () => {
    const hour = 3_600_000;
    expect(historicalPairCutoffMs(1_000 * hour, 1_500 * hour, 24)).toBe(976 * hour);
    expect(historicalPairCutoffMs(1_500 * hour, 1_000 * hour, 24)).toBe(976 * hour);
  });
});

describe("C3 manifest cluster discipline — one market = one episode = one clusterKey", () => {
  test("REJECTS jobs that split one market across different clusterKeys (correlated-as-independent)", () => {
    // anchor "A" filed under two clusterKeys: A resolves once, so these are the SAME episode counted twice.
    const r = auditManifestClusters([job("j1", "c1", "A", "X"), job("j2", "c2", "A", "Y")]);
    expect(r.ok.length).toBe(0);
    expect(r.rejected.length).toBe(2);
    expect(r.rejected[0].reason).toMatch(/multiple clusterKeys/);
  });

  test("ACCEPTS one episode (shared clusterKey) with multiple candidates — F1 dedups it to weight 1", () => {
    const r = auditManifestClusters([job("j1", "c1", "A", "X"), job("j2", "c1", "A", "Y")]);
    expect(r.ok.length).toBe(2);
    expect(r.rejected.length).toBe(0);
    expect(r.bucketClusterSpread["cross_domain|rule|yes"]).toBe(1); // one independent episode
  });

  test("ACCEPTS genuinely distinct episodes (distinct markets + clusterKeys)", () => {
    const r = auditManifestClusters([job("j1", "c1", "A", "X"), job("j2", "c2", "B", "Y")]);
    expect(r.ok.length).toBe(2);
    expect(r.rejected.length).toBe(0);
    expect(r.bucketClusterSpread["cross_domain|rule|yes"]).toBe(2); // two independent episodes
  });
});
