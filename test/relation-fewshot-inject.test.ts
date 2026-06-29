import { describe, it, expect } from "vitest";
import { withFewShot } from "@/lib/association/relationFewShot";

describe("few-shot injection", () => {
  it("appends exemplars only when enabled", () => {
    const base = "SYSTEM PROMPT";
    expect(withFewShot(base, false)).toBe(base);
    const on = withFewShot(base, true);
    expect(on.startsWith(base)).toBe(true);
    expect(on).toContain("Worked examples");
  });
});
