import { describe, expect, test } from "vitest";
import { tokenSetScore, teamQuery } from "@/lib/polymarket/resolve";

describe("outcome matcher (domain-neutral)", () => {
  test("a surname resolves to a full candidate name (politics)", () => {
    expect(tokenSetScore("Newsom", "Gavin Newsom")).toBeGreaterThanOrEqual(0.85);
    expect(tokenSetScore("Whitmer", "Gretchen Whitmer")).toBeGreaterThanOrEqual(0.85);
  });
  test("exact team name still scores 1 (no soccer regression)", () => {
    expect(tokenSetScore("Spain", "Spain")).toBe(1);
    expect(tokenSetScore("England", "England")).toBe(1);
  });
  test("a wrong name scores ~0 (no false positives)", () => {
    expect(tokenSetScore("Newsom", "Gretchen Whitmer")).toBe(0);
    expect(tokenSetScore("Spain", "France")).toBe(0);
  });
  test("teamQuery strips domain category words but keeps the entity", () => {
    expect(teamQuery("Newsom wins the 2028 Democratic nomination")).toContain("newsom");
    expect(teamQuery("Newsom wins the 2028 Democratic nomination")).not.toContain("democratic");
    expect(teamQuery("Spain wins the World Cup")).toBe("spain");
  });
});
