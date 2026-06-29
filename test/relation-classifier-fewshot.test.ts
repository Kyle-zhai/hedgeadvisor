import { describe, it, expect } from "vitest";
import { withFewShot } from "@/lib/association/relationFewShot";
import { SYSTEM } from "@/lib/association/qwen";

// Mirrors test/relation-fewshot-inject.test.ts but for the CLASSIFIER system prompt: the relation
// classifier must append worked examples only when HEDGE_RELATION_FEWSHOT is enabled, and otherwise
// leave the base SYSTEM prompt byte-for-byte unchanged (default OFF, behavior identical today).
describe("relation classifier few-shot wiring", () => {
  it("leaves the classifier SYSTEM prompt unchanged when disabled", () => {
    expect(withFewShot(SYSTEM, false)).toBe(SYSTEM);
  });

  it("appends exemplars to the classifier SYSTEM prompt only when enabled", () => {
    const on = withFewShot(SYSTEM, true);
    expect(on.startsWith(SYSTEM)).toBe(true);
    expect(on.length).toBeGreaterThan(SYSTEM.length);
    expect(on).toContain("Worked examples");
  });
});
