import { describe, expect, test, vi } from "vitest";
import { analyzeRelationWithQwen } from "@/lib/association";
import { llmCacheKey } from "@/lib/association/llmCache";

const hypothesis = {
  relation: "CAUSAL", direction: "POSITIVE", mechanism: "A common event can affect both contracts.",
  sharedEntities: ["France"], counterexamples: ["The second contract may resolve independently."],
  confidence: 0.6, requiresCalibration: true,
  mechanismGraph: {
    anchorEventClass: "national_team_title", candidateEventClass: "coach_departure",
    mechanismType: "CAUSAL", scope: "ENTITY_SPECIFIC", timeOrder: "ANCHOR_BEFORE_CANDIDATE", portability: "EVENT_CLASS",
    nodes: [
      { id: "anchor_event", label: "Team wins", kind: "EVENT" },
      { id: "candidate_event", label: "Coach departs", kind: "EVENT" },
    ],
    edges: [{ from: "anchor_event", to: "candidate_event", kind: "CAUSES" }], sharedDrivers: [],
  },
};

describe("persistent LLM cache contract", () => {
  test("stable cache keys ignore object insertion order", () => {
    expect(llmCacheKey("x", "v1", { a: 1, b: 2 })).toBe(llmCacheKey("x", "v1", { b: 2, a: 1 }));
    expect(llmCacheKey("x", "v1", { a: 1 })).not.toBe(llmCacheKey("x", "v2", { a: 1 }));
  });

  test("a validated classification is reused without a second model call", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(hypothesis) } }] }), { status: 200 }));
    const anchor = { title: "France wins cache-test-unique", rules: "Pays if France wins." };
    const candidate = { title: "Coach leaves cache-test-unique", rules: "Pays if the coach leaves." };
    const options = { apiKey: "test", model: "test-model", fetchImpl: fetchImpl as unknown as typeof fetch, cache: true };
    const first = await analyzeRelationWithQwen(anchor, candidate, options);
    const second = await analyzeRelationWithQwen(anchor, candidate, options);
    expect(first.status).toBe("ok");
    expect(first.cached).toBe(false);
    expect(second.status).toBe("ok");
    expect(second.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
