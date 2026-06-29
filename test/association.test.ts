import { describe, expect, test, vi } from "vitest";
import {
  analyzeRelationWithQwen,
  betaQuantile,
  calibrateConditionalPayoff,
  countConditionalObservations,
  optimizeRobustHedge,
  regularizedBeta,
  type OptimizerCandidate,
} from "@/lib/association";

describe("conditional payoff calibration", () => {
  test("beta CDF/quantile primitives are numerically accurate", () => {
    expect(regularizedBeta(0.5, 2, 2)).toBeCloseTo(0.5, 12);
    expect(betaQuantile(0.025, 1, 1)).toBeCloseTo(0.025, 12);
    expect(betaQuantile(0.975, 1, 1)).toBeCloseTo(0.975, 12);
  });

  test("counts weighted paired outcomes and separates fail-pay from win-pay", () => {
    const counts = countConditionalObservations([
      { anchorPays: true, candidatePays: false, weight: 30 },
      { anchorPays: true, candidatePays: true, weight: 2 },
      { anchorPays: false, candidatePays: true, weight: 40 },
      { anchorPays: false, candidatePays: false, weight: 3 },
    ]);
    const cal = calibrateConditionalPayoff(counts, 0.95, 20);
    expect(cal.sufficientEvidence).toBe(true);
    expect(cal.payGivenAnchorFails.mean).toBeGreaterThan(0.9);
    expect(cal.payGivenAnchorPays.mean).toBeLessThan(0.1);
    expect(cal.hedgeSpecificityLower).toBeGreaterThan(0.5);
  });

  test("small samples stay explicitly insufficient even when point estimates look perfect", () => {
    const cal = calibrateConditionalPayoff({
      anchorPayCandidatePay: 0,
      anchorPayCandidateNoPay: 3,
      anchorNoPayCandidatePay: 3,
      anchorNoPayCandidateNoPay: 0,
    });
    expect(cal.sufficientEvidence).toBe(false);
    expect(cal.payGivenAnchorFails.upper - cal.payGivenAnchorFails.lower).toBeGreaterThan(0.3);
  });
});

describe("robust hedge optimizer", () => {
  const base = { stakeUsd: 20, primaryPrice: 0.25, keepFraction: 0.5, conservatism: 0.9 };

  test("verified complement gets deterministic max-loss credit and exact sizing", () => {
    const complement: OptimizerCandidate = {
      id: "b-no", label: "Spain NO", venue: "polymarket", side: "no", price: 0.8,
      provenance: "ANALYTIC", structuralCoverage: "ALL_ANCHOR_FAIL_STATES",
    };
    const r = optimizeRobustHedge({ ...base, candidates: [complement] });
    expect(r.status).toBe("RECOMMEND");
    expect(r.budgetUsd).toBe(30); // profit=60, keep half
    expect(r.spendUsd).toBe(30);
    expect(r.modeledLossIfPrimaryFailsUsd).toBe(12.5);
    expect(r.strictWorstLossIfPrimaryFailsUsd).toBe(12.5);
    expect(r.keepIfPrimaryWinsFloorUsd).toBe(30);
  });

  test("strong calibrated leg can reduce modeled loss but never pretends to reduce strict worst loss", () => {
    const calibration = calibrateConditionalPayoff({
      anchorPayCandidatePay: 4, anchorPayCandidateNoPay: 96,
      anchorNoPayCandidatePay: 92, anchorNoPayCandidateNoPay: 8,
    });
    const candidate: OptimizerCandidate = {
      id: "word-no", label: "Announcer word NO", venue: "kalshi", side: "no", price: 0.45,
      maxSpendUsd: 5, provenance: "CALIBRATED", calibration,
    };
    const r = optimizeRobustHedge({ ...base, conservatism: 0.7, candidates: [candidate] });
    expect(r.status).toBe("RECOMMEND");
    expect(r.modeledLossIfPrimaryFailsUsd).toBeLessThan(20);
    expect(r.strictWorstLossIfPrimaryFailsUsd).toBeGreaterThan(20);
  });

  test("structural exclusive-rival leg is admitted at launch without calibration (modeled credit, not strict)", () => {
    const rival: OptimizerCandidate = {
      id: "rival-yes", label: "Brazil wins instead", venue: "kalshi", side: "yes", price: 0.2,
      maxSpendUsd: 100, provenance: "ANALYTIC", structuralPayoff: { payGivenFail: 0.3, payGivenWin: 0 },
    };
    const ok = optimizeRobustHedge({ ...base, conservatism: 0.7, candidates: [rival] });
    expect(ok.status).toBe("RECOMMEND"); // admitted WITHOUT settlement calibration
    expect(ok.allocations[0].provenance).toBe("ANALYTIC");
    expect(ok.modeledLossIfPrimaryFailsUsd).toBeLessThan(20); // certain conditional payoff reduces modeled loss
    expect(ok.strictWorstLossIfPrimaryFailsUsd).toBeGreaterThan(20); // but premium can pay 0 in some fail states
    // strictest posture wants GUARANTEED worst-loss reduction ⇒ partial-coverage structural legs excluded
    const strict = optimizeRobustHedge({ ...base, conservatism: 1, candidates: [rival] });
    expect(strict.status).toBe("NO_ACTION");
  });

  test("LLM confidence never authorizes payoff probabilities or sizing", () => {
    const hypothesis: OptimizerCandidate = {
      id: "inf-leg", label: "Coach departs · kalshi", venue: "kalshi", side: "yes", price: 0.3,
      maxSpendUsd: 100, provenance: "HYPOTHESIS",
    };
    for (const conservatism of [0, 0.3, 0.6, 1]) {
      const result = optimizeRobustHedge({ ...base, conservatism, candidates: [hypothesis] });
      expect(result.status).toBe("NO_ACTION");
      expect(result.allocations).toHaveLength(0);
      expect(result.rejected[0].reason).toContain("no calibrated payoff evidence");
    }
  });

  test("hypotheses and statistically ambiguous candidates are rejected", () => {
    const hypothesis: OptimizerCandidate = {
      id: "llm-only", label: "LLM-only idea", venue: "kalshi", side: "no", price: 0.3,
      provenance: "HYPOTHESIS",
    };
    const ambiguous: OptimizerCandidate = {
      id: "ambiguous", label: "Ambiguous", venue: "kalshi", side: "yes", price: 0.4,
      provenance: "CALIBRATED",
      calibration: calibrateConditionalPayoff({
        anchorPayCandidatePay: 50, anchorPayCandidateNoPay: 50,
        anchorNoPayCandidatePay: 52, anchorNoPayCandidateNoPay: 48,
      }),
    };
    const r = optimizeRobustHedge({ ...base, candidates: [hypothesis, ambiguous] });
    expect(r.status).toBe("NO_ACTION");
    expect(r.rejected).toHaveLength(2);
  });

  test("strictest posture categorically excludes calibrated soft associations", () => {
    const calibration = calibrateConditionalPayoff({
      anchorPayCandidatePay: 0, anchorPayCandidateNoPay: 200,
      anchorNoPayCandidatePay: 200, anchorNoPayCandidateNoPay: 0,
    });
    const r = optimizeRobustHedge({
      ...base,
      conservatism: 1,
      candidates: [{
        id: "almost-perfect-but-soft", label: "Soft", venue: "kalshi", side: "no", price: 0.4,
        provenance: "CALIBRATED", calibration,
      }],
    });
    expect(r.status).toBe("NO_ACTION");
    expect(r.rejected[0].reason).toContain("structural");
  });

  test("admits only the highest-scoring calibrated soft leg, independent of input order", () => {
    const strong = calibrateConditionalPayoff({
      anchorPayCandidatePay: 2, anchorPayCandidateNoPay: 198,
      anchorNoPayCandidatePay: 190, anchorNoPayCandidateNoPay: 10,
    });
    const weaker = calibrateConditionalPayoff({
      anchorPayCandidatePay: 30, anchorPayCandidateNoPay: 170,
      anchorNoPayCandidatePay: 150, anchorNoPayCandidateNoPay: 50,
    });
    const candidates: OptimizerCandidate[] = [
      { id: "weaker-first", label: "Weaker", venue: "kalshi", side: "yes", price: 0.48, maxSpendUsd: 5, provenance: "CALIBRATED", calibration: weaker },
      { id: "stronger-second", label: "Stronger", venue: "kalshi", side: "yes", price: 0.35, maxSpendUsd: 5, provenance: "CALIBRATED", calibration: strong },
    ];
    const r = optimizeRobustHedge({ ...base, conservatism: 0.7, candidates });
    expect(r.allocations).toHaveLength(1);
    expect(r.allocations[0].candidateId).toBe("stronger-second");
    expect(r.rejected.some((x) => x.candidateId === "weaker-first" && x.reason.includes("single best soft leg"))).toBe(true);
  });

  test("recommends a MODELED (current-ability) leg below the strict end, withholds it at the conservative end", () => {
    // The engine's unproven-but-best estimate: it should BE the recommendation when the user is not in a
    // strict posture, and step aside (await settlement calibration) only at the conservative end.
    const modeled: OptimizerCandidate = {
      id: "mdl", label: "Modeled hedge", venue: "polymarket", side: "yes", price: 0.3,
      provenance: "MODELED", modeledPayoff: { payGivenFail: 0.6, payGivenWin: 0.1 },
    };
    const lenient = optimizeRobustHedge({ ...base, conservatism: 0.4, candidates: [modeled] });
    expect(lenient.status).toBe("RECOMMEND");
    expect(lenient.allocations[0].provenance).toBe("MODELED");
    const strict = optimizeRobustHedge({ ...base, conservatism: 0.85, candidates: [modeled] });
    expect(strict.status).toBe("NO_ACTION");
  });

  test("MODELED failLower shades pFail DOWN continuously with conservatism (never up), and stays MODELED", () => {
    // A gold-residual lower bound (failLower < payGivenFail) should make the leg MORE conservative as the
    // knob rises: the effective fail payoff slides from payGivenFail toward failLower. It must never raise
    // pFail above payGivenFail, and the leg must remain MODELED-tiered. A heavy-favorite anchor (high
    // primaryPrice) keeps the Fréchet ceiling (price / P(fail)) above payGivenFail, so we observe the
    // continuous-conservatism shading directly rather than the feasibility clamp.
    const heavy = { stakeUsd: 20, primaryPrice: 0.9, keepFraction: 0.5, conservatism: 0.9 };
    const withBound: OptimizerCandidate = {
      id: "mdl", label: "Modeled hedge", venue: "polymarket", side: "yes", price: 0.3,
      provenance: "MODELED", modeledPayoff: { payGivenFail: 0.6, payGivenWin: 0.1, failLower: 0.4 },
    };
    const lenient = optimizeRobustHedge({ ...heavy, conservatism: 0.1, candidates: [withBound] });
    const firmer = optimizeRobustHedge({ ...heavy, conservatism: 0.5, candidates: [withBound] });
    expect(lenient.allocations[0].provenance).toBe("MODELED");
    expect(firmer.allocations[0].provenance).toBe("MODELED");
    // continuous: pFail = payGivenFail - c*(payGivenFail - failLower) = 0.6 - c*0.2
    expect(lenient.allocations[0].effectivePayGivenFail).toBeCloseTo(0.58, 3); // 0.6 - 0.1*0.2
    expect(firmer.allocations[0].effectivePayGivenFail).toBeCloseTo(0.50, 3);  // 0.6 - 0.5*0.2
    // strictly more conservative (lower) as c rises, never above the raw payGivenFail
    expect(firmer.allocations[0].effectivePayGivenFail).toBeLessThan(lenient.allocations[0].effectivePayGivenFail);
    expect(lenient.allocations[0].effectivePayGivenFail).toBeLessThanOrEqual(0.6);

    // A leg WITHOUT a bound keeps the flat 0.6-uncertainty fallback: its fail payoff is NOT shaded down.
    const noBound: OptimizerCandidate = {
      id: "mdl2", label: "Modeled hedge", venue: "polymarket", side: "yes", price: 0.3,
      provenance: "MODELED", modeledPayoff: { payGivenFail: 0.6, payGivenWin: 0.1 },
    };
    const noBoundRes = optimizeRobustHedge({ ...heavy, conservatism: 0.5, candidates: [noBound] });
    expect(noBoundRes.allocations[0].effectivePayGivenFail).toBeCloseTo(0.6, 3);
  });

  test("MODELED failLower never lets a leg pass the c>=0.8 reject gate", () => {
    // Even a tight, favorable interval cannot promote a MODELED leg past the strict gate — it stays withheld.
    const withBound: OptimizerCandidate = {
      id: "mdl", label: "Modeled hedge", venue: "polymarket", side: "yes", price: 0.3,
      provenance: "MODELED", modeledPayoff: { payGivenFail: 0.6, payGivenWin: 0.1, failLower: 0.59 },
    };
    const strict = optimizeRobustHedge({ ...base, conservatism: 0.8, candidates: [withBound] });
    expect(strict.status).toBe("NO_ACTION");
    expect(strict.rejected.some((x) => x.candidateId === "mdl")).toBe(true);
  });

  test("de-vigged marginal tightens the Fréchet clamp below the gross price (parameter-free)", () => {
    // A near-perfect bucket calibration (payGivenFail ≈ 1) on a candidate whose gross executable price
    // (0.5, carrying spread + fee + vig) does NOT bind the clamp at this anchor (P(fail)=0.4 ⇒
    // price/P(fail)=1.25, capped to 1), so the price-only pFail stays at the (high) calibrated mean. The
    // DE-VIGGED marginal (0.3) is the leg's true probability mass and binds the clamp (0.3/0.4=0.75),
    // correctly capping P(pay|fail). Both legs still allocate; carrying the marginal LOWERS pFail.
    const heavy = { stakeUsd: 20, primaryPrice: 0.6, keepFraction: 0.5, conservatism: 0.5 };
    const calibration = calibrateConditionalPayoff({
      anchorPayCandidatePay: 1, anchorPayCandidateNoPay: 199,
      anchorNoPayCandidatePay: 199, anchorNoPayCandidateNoPay: 1,
    });
    const withMarginal: OptimizerCandidate = {
      id: "devigged", label: "De-vigged leg", venue: "polymarket", side: "no", price: 0.5,
      marginal: 0.3, maxSpendUsd: 5, provenance: "CALIBRATED", calibration,
    };
    const priceOnly: OptimizerCandidate = { ...withMarginal, id: "price-only", marginal: undefined };
    const withRes = optimizeRobustHedge({ ...heavy, candidates: [withMarginal] });
    const withoutRes = optimizeRobustHedge({ ...heavy, candidates: [priceOnly] });
    // marginal-bound pFail clamps to marginal/P(fail) = 0.3/0.4 = 0.75
    expect(withRes.allocations[0].effectivePayGivenFail).toBeCloseTo(0.75, 3);
    // price-only clamp (price/P(fail)=1.25, capped to 1) does NOT bind ⇒ pFail stays at the cal mean (> 0.75)
    expect(withoutRes.allocations[0].effectivePayGivenFail).toBeGreaterThan(0.9);
    // tightening is monotone: the de-vigged clamp is never looser than the gross-price clamp
    expect(withRes.allocations[0].effectivePayGivenFail).toBeLessThan(withoutRes.allocations[0].effectivePayGivenFail);
  });

  test("a marginal above the executable price is ignored (clamp falls back to price, never loosens)", () => {
    // Guard: a stale/overstated marginal (> price) must NOT be used as the clamp numerator — that would
    // loosen the Fréchet bound. The optimizer falls back to price, so pFail matches the price-only result.
    const heavy = { stakeUsd: 20, primaryPrice: 0.6, keepFraction: 0.5, conservatism: 0.5 };
    const calibration = calibrateConditionalPayoff({
      anchorPayCandidatePay: 1, anchorPayCandidateNoPay: 199,
      anchorNoPayCandidatePay: 199, anchorNoPayCandidateNoPay: 1,
    });
    const overstated: OptimizerCandidate = {
      id: "overstated", label: "Overstated marginal", venue: "polymarket", side: "no", price: 0.5,
      marginal: 0.95, maxSpendUsd: 5, provenance: "CALIBRATED", calibration,
    };
    const priceOnly: OptimizerCandidate = { ...overstated, id: "price-only-2", marginal: undefined };
    const overRes = optimizeRobustHedge({ ...heavy, candidates: [overstated] });
    const priceRes = optimizeRobustHedge({ ...heavy, candidates: [priceOnly] });
    expect(overRes.allocations[0].effectivePayGivenFail).toBeCloseTo(priceRes.allocations[0].effectivePayGivenFail, 6);
  });

  test("never allocates both YES and NO alternatives from the same association market", () => {
    const calibration = calibrateConditionalPayoff({
      anchorPayCandidatePay: 10, anchorPayCandidateNoPay: 190,
      anchorNoPayCandidatePay: 180, anchorNoPayCandidateNoPay: 20,
    });
    const candidates: OptimizerCandidate[] = [
      { id: "same-market-yes", label: "YES", venue: "kalshi", side: "yes", price: 0.4, maxSpendUsd: 2, provenance: "CALIBRATED", calibration, associationGroup: "market:x" },
      { id: "same-market-no", label: "NO", venue: "kalshi", side: "no", price: 0.45, maxSpendUsd: 2, provenance: "CALIBRATED", calibration, associationGroup: "market:x" },
    ];
    const r = optimizeRobustHedge({ ...base, conservatism: 0.5, maxCalibratedSoftLegs: 2, candidates });
    expect(r.allocations).toHaveLength(1);
    expect(r.rejected.some((x) => x.reason.includes("same association group"))).toBe(true);
  });
});

describe("Qwen relationship adapter", () => {
  const anchor = { title: "Spain wins the World Cup", rules: "Pays if Spain is champion." };
  const candidate = { title: "Announcer says champion", rules: "Pays if champion is spoken." };

  test("missing API key is a safe, network-free disabled result", async () => {
    const fetchImpl = vi.fn();
    const r = await analyzeRelationWithQwen(anchor, candidate, { apiKey: "", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.status).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("validates structured JSON returned by the OpenAI-compatible endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      relation: "THEMATIC", direction: "POSITIVE", mechanism: "Broadcast language may react to the result.",
      sharedEntities: ["Spain", "World Cup"], counterexamples: ["The word may describe another team."],
      confidence: 0.7, requiresCalibration: true,
      mechanismGraph: {
        anchorEventClass: "national_team_title",
        candidateEventClass: "broadcast_language_occurrence",
        mechanismType: "NARRATIVE",
        scope: "ENTITY_SPECIFIC",
        timeOrder: "OVERLAPPING",
        portability: "EVENT_CLASS",
        nodes: [
          { id: "anchor_event", label: "Spain wins the World Cup", kind: "EVENT" },
          { id: "candidate_event", label: "Champion is spoken", kind: "OBSERVABLE" },
        ],
        edges: [{ from: "anchor_event", to: "candidate_event", kind: "CAUSES" }],
        sharedDrivers: ["match narrative"],
      },
    }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const r = await analyzeRelationWithQwen(anchor, candidate, { apiKey: "test", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.status).toBe("ok");
    expect(r.hypothesis?.relation).toBe("THEMATIC");
    expect(r.hypothesis?.requiresCalibration).toBe(true);
    expect(r.hypothesis?.mechanismGraph?.candidateEventClass).toBe("broadcast_language_occurrence");
  });

  test("falls through quota failures in the configured model order", async () => {
    const valid = {
      relation: "CAUSAL", direction: "POSITIVE", mechanism: "A shared event can affect both outcomes.",
      sharedEntities: ["Spain"], counterexamples: ["The broadcast may use different wording."],
      confidence: 0.6, requiresCalibration: true,
      mechanismGraph: {
        anchorEventClass: "national_team_title", candidateEventClass: "broadcast_language_occurrence",
        mechanismType: "NARRATIVE", scope: "ENTITY_SPECIFIC", timeOrder: "OVERLAPPING", portability: "EVENT_CLASS",
        nodes: [
          { id: "anchor_event", label: "Spain wins", kind: "EVENT" },
          { id: "candidate_event", label: "Champion is spoken", kind: "OBSERVABLE" },
        ],
        edges: [{ from: "anchor_event", to: "candidate_event", kind: "SIGNALS" }], sharedDrivers: ["match narrative"],
      },
    };
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      seen.push(model);
      if (model === "MiniMax-M2.5") return new Response(JSON.stringify({ code: "AllocationQuota.FreeTierOnly" }), { status: 403 });
      if (model === "qwen3.6-flash") return new Response(JSON.stringify({ code: "Throttling.RateQuota" }), { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: `<think>ignored</think>${JSON.stringify(valid)}` } }] }), { status: 200 });
    });
    const r = await analyzeRelationWithQwen(anchor, candidate, {
      apiKey: "test",
      models: ["MiniMax-M2.5", "qwen3.6-flash", "qwen3-max-preview"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.status).toBe("ok");
    expect(r.model).toBe("qwen3-max-preview");
    expect(seen).toEqual(["MiniMax-M2.5", "qwen3.6-flash", "qwen3-max-preview"]);
    expect(r.attempts).toHaveLength(3);
  });

  test("does not retry another model when the shared API key is unauthorized", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: "InvalidApiKey" }), { status: 401 }));
    const r = await analyzeRelationWithQwen(anchor, candidate, {
      apiKey: "bad",
      models: ["MiniMax-M2.5", "qwen3.6-flash"],
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r.status).toBe("error");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
