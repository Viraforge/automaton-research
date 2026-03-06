import { describe, expect, it } from "vitest";
import { canUseChannel, classifyChannelTransition } from "../../governance/channel-state.js";

describe("channel-state governance", () => {
  it("classifies social relay misconfiguration", () => {
    const transition = classifyChannelTransition({
      channelId: "social_relay",
      message: "Social relay not configured. Set socialRelayUrl in config.",
    });
    expect(transition?.status).toBe("misconfigured");
    expect(transition?.cooldownUntil).toBeNull();
  });

  it("classifies quota exhausted and preserves reset", () => {
    const resetIso = "2026-03-12T05:05:53.000Z";
    const transition = classifyChannelTransition(
      { channelId: "byok_inference", message: "429 Weekly/Monthly Limit Exhausted" },
      { quotaResetIso: resetIso },
    );
    expect(transition?.status).toBe("quota_exhausted");
    expect(transition?.cooldownUntil).toBe(resetIso);
  });

  it("denies use for disabled and policy-blocked channels", () => {
    expect(canUseChannel("disabled")).toBe(false);
    expect(canUseChannel("blocked_by_policy")).toBe(false);
  });

  it("allows use after cooldown expiry", () => {
    const now = new Date("2026-03-06T12:00:00.000Z");
    const before = new Date(now.getTime() - 1_000).toISOString();
    expect(canUseChannel("cooldown", now.toISOString(), before)).toBe(true);
  });
});
