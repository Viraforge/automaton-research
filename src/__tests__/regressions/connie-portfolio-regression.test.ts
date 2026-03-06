import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChannelTransition } from "../../governance/channel-state.js";
import { extractKnownVenuesFromDiscovery } from "../../governance/discovery-followthrough.js";

describe("connie 24h regression fixtures", () => {
  const fixturePath = path.join(process.cwd(), "src/__tests__/fixtures/connie-24h-regression.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as {
    events: Array<{ type: string; tool?: string; message: string }>;
  };

  it("maps historical blocker messages to deterministic channel states", () => {
    const social = fixture.events.find((e) => e.tool === "send_message")!;
    const gas = fixture.events.find((e) => e.tool === "register_erc8004")!;
    const quota = fixture.events.find((e) => e.message.includes("Weekly/Monthly Limit Exhausted"))!;
    expect(classifyChannelTransition({ channelId: "social_relay", message: social.message })?.status).toBe("misconfigured");
    expect(classifyChannelTransition({ channelId: "erc8004_registry", message: gas.message })?.status).toBe("funding_required");
    expect(classifyChannelTransition({ channelId: "byok_inference", message: quota.message })?.status).toBe("quota_exhausted");
  });

  it("preserves discovery loop signal and known-venue extraction behavior", () => {
    const venues = extractKnownVenuesFromDiscovery(
      "Found opportunities on ClawNews and AgentDirectory.",
      ["clawnews", "agentdirectory"],
    );
    expect(venues).toEqual(expect.arrayContaining(["clawnews", "agentdirectory"]));
    const loopNotice = fixture.events.find((e) => e.message.includes("discover_agents loop detected"));
    expect(loopNotice).toBeDefined();
  });
});
