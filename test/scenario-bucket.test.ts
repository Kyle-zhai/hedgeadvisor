import { describe, it, expect } from "vitest";
import { classifyScenarioBucket, scenarioDistribution, SCENARIO_BUCKETS, type ScenarioInput } from "@/lib/relate/scenarioBucket";

const anchor = "Spain win the 2026 World Cup";
const c = (candidateTitle: string, extra: Partial<ScenarioInput> = {}): ScenarioInput => ({ anchorTitle: anchor, candidateTitle, ...extra });

describe("classifyScenarioBucket", () => {
  it("structural: cross-entity MUTEX rival → rival_wins", () => {
    expect(classifyScenarioBucket(c("Brazil win the 2026 World Cup", { relation: "MUTEX", scope: "CROSS_ENTITY", direction: "NEGATIVE" }))).toBe("rival_wins");
  });
  it("structural: IMPLICATION subset → logical_subset", () => {
    expect(classifyScenarioBucket(c("Spain reach the 2026 World Cup final", { relation: "IMPLICATION", scope: "SAME_ENTITY", direction: "POSITIVE" }))).toBe("logical_subset");
  });
  it("keyword: injury → injury_absence (even with a CAUSAL relation)", () => {
    expect(classifyScenarioBucket(c("Spain's first-choice striker ruled out injured", { relation: "CAUSAL", scope: "ENTITY_SPECIFIC", direction: "NEGATIVE" }))).toBe("injury_absence");
  });
  it("keyword: elimination → path_elimination", () => {
    expect(classifyScenarioBucket(c("Spain eliminated before the semifinal", { relation: "CAUSAL", direction: "NEGATIVE" }))).toBe("path_elimination");
  });
  it("keyword: manager resigns → performance_collapse", () => {
    expect(classifyScenarioBucket(c("Spain head coach resigns before the tournament", { relation: "CAUSAL", direction: "NEGATIVE" }))).toBe("performance_collapse");
  });
  it("keyword: macro regime (CPI/Fed) → macro_regime, beating generic 'report'", () => {
    expect(classifyScenarioBucket(c("US CPI inflation above 3% in 2026", { relation: "CAUSAL", scope: "CROSS_DOMAIN", direction: "NEGATIVE" }))).toBe("macro_regime");
    expect(classifyScenarioBucket(c("Fed cuts interest rates in 2026", { relation: "CAUSAL", scope: "CROSS_DOMAIN", direction: "POSITIVE" }))).toBe("macro_regime");
  });
  it("keyword: regulation/court → regulatory_shock", () => {
    expect(classifyScenarioBucket(c("EU antitrust ruling bans the merger", { relation: "CAUSAL", direction: "NEGATIVE" }))).toBe("regulatory_shock");
  });
  it("keyword: commodity → supply_demand_shock", () => {
    expect(classifyScenarioBucket(c("Brent crude oil above $100 a barrel", { relation: "CAUSAL", scope: "CROSS_DOMAIN", direction: "POSITIVE" }))).toBe("supply_demand_shock");
  });
  it("keyword: earnings → information_release", () => {
    expect(classifyScenarioBucket(c("Nvidia beats Q3 earnings guidance", { relation: "CAUSAL", direction: "POSITIVE" }))).toBe("information_release");
  });
  it("keyword: crowd reaction → behavioral_reaction", () => {
    expect(classifyScenarioBucket(c("Fans celebrate in the streets after the final", { relation: "CAUSAL", direction: "POSITIVE" }))).toBe("behavioral_reaction");
  });
  it("explicit independence → unrelated_control (overrides any keyword)", () => {
    expect(classifyScenarioBucket(c("Brent crude oil above $100", { relation: "CAUSAL", reason: "independent, no concrete mechanism" }))).toBe("unrelated_control");
    expect(classifyScenarioBucket(c("Taylor Swift announces a tour", { relation: "UNRELATED", direction: "AMBIGUOUS" }))).toBe("unrelated_control");
  });
  it("cross-entity fallback (no keyword) → rival_wins; same-entity fallback → logical_subset", () => {
    expect(classifyScenarioBucket(c("Argentina win the 2026 World Cup", { relation: "MUTEX", scope: "CROSS_ENTITY", direction: "NEGATIVE" }))).toBe("rival_wins");
    expect(classifyScenarioBucket(c("Spain top the group", { relation: "CAUSAL", scope: "SAME_ENTITY", direction: "POSITIVE" }))).toBe("logical_subset");
  });
  it("no signal at all → unrelated_control (never throws, always a valid bucket)", () => {
    const b = classifyScenarioBucket(c("Some unrelated market"));
    expect(SCENARIO_BUCKETS).toContain(b);
    expect(b).toBe("unrelated_control");
  });
});

describe("scenarioDistribution", () => {
  it("tallies buckets", () => {
    expect(scenarioDistribution(["rival_wins", "rival_wins", "injury_absence"])).toEqual({ rival_wins: 2, injury_absence: 1 });
  });
});
