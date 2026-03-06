import { describe, expect, it } from "vitest";
import { CHILD_LIVENESS_STALE_MS, isChildRecent, parseUtcTimestamp } from "../../orchestration/time.js";

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

  it("uses last_checked first when determining recency", () => {
    const now = Date.parse("2026-03-05T12:30:00Z");
    const recentLastChecked = "2026-03-05 12:20:00";
    const staleCreatedAt = "2026-03-05 11:00:00";
    expect(isChildRecent(recentLastChecked, staleCreatedAt, now)).toBe(true);
  });

  it("marks child stale after liveness window", () => {
    const now = Date.parse("2026-03-05T12:30:00Z");
    const stale = new Date(now - CHILD_LIVENESS_STALE_MS - 1).toISOString();
    expect(isChildRecent(stale, null, now)).toBe(false);
  });

  it("supports ttl override", () => {
    const now = Date.parse("2026-03-05T12:30:00Z");
    const fortyMinutesAgo = new Date(now - (40 * 60_000)).toISOString();
    expect(isChildRecent(fortyMinutesAgo, null, now, 60 * 60_000)).toBe(true);
    expect(isChildRecent(fortyMinutesAgo, null, now, 10 * 60_000)).toBe(false);
  });
});
