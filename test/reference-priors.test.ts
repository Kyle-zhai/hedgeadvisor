import { afterEach, describe, expect, test } from "vitest";
import { validateReferencePriors, loadReferencePriors, resetReferencePriorsCache } from "@/lib/relate/referencePriors";

/** §19 item 3 — the REFERENCE_CLASS prior loader: fail-closed validation, leaf-key discipline, env merge. */

const good = { payGivenFail: 0.42, payGivenWin: 0.18, pseudoSamples: 24, source: "1974-2024 test dataset" };

describe("validateReferencePriors", () => {
  test("accepts a well-formed leaf-keyed prior and skips documentation keys", () => {
    const m = validateReferencePriors({ "_doc": "ignored", "cross_domain|causal|negative|yes": good });
    expect(m.size).toBe(1);
    expect(m.get("cross_domain|causal|negative|yes")).toMatchObject(good);
  });

  test("fail-closed: malformed entries are SKIPPED, never coerced", () => {
    const m = validateReferencePriors({
      "cross_domain|causal|negative|yes": { ...good, payGivenFail: 1.4 },      // prob out of range
      "same_entity|logical|positive|no": { ...good, pseudoSamples: 0 },         // no evidence mass
      "cross_entity|logical|negative|yes": { ...good, source: "  " },           // unauditable
      "cross_domain|economic|negative|no": good,                                // the one valid row
    });
    expect(m.size).toBe(1);
    expect(m.has("cross_domain|economic|negative|no")).toBe(true);
  });

  test("leaf-key discipline: non-4-segment or bad-side keys are rejected (no coarse-rung priors)", () => {
    const m = validateReferencePriors({
      "cross_domain|negative|yes": good,               // 3 segments = fallback rung — forbidden
      "cross_domain|causal|negative|maybe": good,      // side must be yes/no
      "cross_domain|causal|negative|yes|extra": good,  // 5 segments
    });
    expect(m.size).toBe(0);
  });

  test("non-object input yields an empty map", () => {
    expect(validateReferencePriors(null).size).toBe(0);
    expect(validateReferencePriors("nope").size).toBe(0);
  });
});

describe("loadReferencePriors (seed + env merge)", () => {
  afterEach(() => {
    delete process.env.HEDGE_REFERENCE_PRIORS_JSON;
    resetReferencePriorsCache();
  });

  test("the shipped seed is empty by design — the whole layer is a no-op", () => {
    resetReferencePriorsCache();
    expect(loadReferencePriors().size).toBe(0);
  });

  test("env override supplies curated priors without a deploy; malformed env JSON is ignored", () => {
    resetReferencePriorsCache();
    process.env.HEDGE_REFERENCE_PRIORS_JSON = JSON.stringify({ "cross_domain|causal|negative|yes": good });
    expect(loadReferencePriors().get("cross_domain|causal|negative|yes")).toMatchObject(good);
    resetReferencePriorsCache();
    process.env.HEDGE_REFERENCE_PRIORS_JSON = "{not json";
    expect(loadReferencePriors().size).toBe(0); // seed remains authoritative
  });
});
