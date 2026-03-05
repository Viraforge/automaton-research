import { describe, expect, it } from "vitest";
import { parseUtcTimestamp } from "../../orchestration/time.js";

describe("orchestration/time", () => {
  it("parses sqlite UTC datetime as UTC", () => {
    const parsed = parseUtcTimestamp("2026-03-05 12:00:00");
    expect(parsed).toBe(Date.parse("2026-03-05T12:00:00Z"));
  });

  it("parses ISO datetime and returns null on invalid values", () => {
    expect(parseUtcTimestamp("2026-03-05T12:00:00.000Z")).toBe(Date.parse("2026-03-05T12:00:00.000Z"));
    expect(parseUtcTimestamp("")).toBeNull();
    expect(parseUtcTimestamp("not-a-date")).toBeNull();
  });
});
