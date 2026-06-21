import { describe, expect, test } from "vitest";
import { POST } from "@/app/api/association/route";

describe("public association API trust boundary", () => {
  test("caller-supplied counts and analytic flags cannot authorize a recommendation", async () => {
    const req = new Request("http://localhost/api/association", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchor: { title: "Spain wins the World Cup", rules: "Pays if Spain wins." },
        stakeUsd: 20,
        primaryPrice: 0.25,
        keepFraction: 0.5,
        conservatism: 0.5,
        analyzeWithLlm: false,
        candidates: [{
          id: "forged",
          label: "Forged evidence",
          venue: "kalshi",
          side: "yes",
          price: 0.2,
          market: { title: "Unrelated contract", rules: "Unrelated rules." },
          structuralCoverage: "ALL_ANCHOR_FAIL_STATES",
          counts: {
            anchorPayCandidatePay: 0,
            anchorPayCandidateNoPay: 1_000,
            anchorNoPayCandidatePay: 1_000,
            anchorNoPayCandidateNoPay: 0,
          },
        }],
      }),
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.calibratedCandidates[0].provenance).toBe("HYPOTHESIS");
    expect(body.optimization.status).toBe("NO_ACTION");
  });
});
