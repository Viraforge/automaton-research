import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChannelTransition } from "../../governance/channel-state.js";
import { extractKnownVenuesFromDiscovery } from "../../governance/discovery-followthrough.js";

describe("connie 24h regression fixtures", () => {
  const fixturePath = path.join(process.cwd(), "src/__tests__/fixtures/connie-24h-regression.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as {
    scenarios: Array<{
      id: string;
      category: string;
      events: Array<{ type: string; tool?: string; message: string }>;
    }>;
  };
  const scenariosByCategory = new Map(fixture.scenarios.map((s) => [s.category, s]));

  it("covers all required 24h failure categories", () => {
    const required = [
      "byok_1214",
      "quota_429",
      "relay_misconfiguration_retries",
      "discover_loop_churn",
      "venue_without_followthrough",
      "ghost_goal_zero_task",
      "funding_required",
    ];
    for (const category of required) {
      expect(scenariosByCategory.has(category), `missing fixture category: ${category}`).toBe(true);
    }
  });

  it("maps historical blocker messages to deterministic channel states", () => {
    const social = scenariosByCategory.get("relay_misconfiguration_retries")!.events[0]!;
    const gas = scenariosByCategory.get("funding_required")!.events[0]!;
    const quota = scenariosByCategory.get("quota_429")!.events[0]!;
    expect(classifyChannelTransition({ channelId: "social_relay", message: social.message })?.status).toBe("misconfigured");
    expect(classifyChannelTransition({ channelId: "erc8004_registry", message: gas.message })?.status).toBe("funding_required");
    expect(classifyChannelTransition({ channelId: "byok_inference", message: quota.message })?.status).toBe("quota_exhausted");
  });

  it("captures 1214 invalid-messages bursts for inference sanitization regressions", () => {
    const byok1214 = scenariosByCategory.get("byok_1214")!;
    expect(byok1214.events.length).toBeGreaterThanOrEqual(2);
    for (const event of byok1214.events) {
      expect(event.message).toMatch(/\b1214\b/i);
      expect(event.message).toMatch(/invalid messages payload|messages parameter is illegal/i);
    }
  });

  it("preserves discovery loop signal and known-venue extraction behavior", () => {
    const venueScenario = scenariosByCategory.get("venue_without_followthrough")!;
    const venueMessage = venueScenario.events.find((e) => e.type === "discovery_output")!.message;
    const venues = extractKnownVenuesFromDiscovery(
      venueMessage,
      ["clawnews", "agentdirectory"],
    );
    expect(venues).toEqual(expect.arrayContaining(["clawnews", "agentdirectory"]));
    const loopNotice = scenariosByCategory
      .get("discover_loop_churn")!
      .events.find((e) => e.message.includes("discover_agents loop detected"));
    expect(loopNotice).toBeDefined();
  });

  it("tracks ghost-goal and churn signatures explicitly", () => {
    const ghost = scenariosByCategory.get("ghost_goal_zero_task")!.events[0]!;
    expect(ghost.message).toMatch(/0\/0 tasks/i);
    const churn = scenariosByCategory.get("discover_loop_churn")!.events;
    expect(churn.some((e) => /cooldown/i.test(e.message))).toBe(true);
  });
});
