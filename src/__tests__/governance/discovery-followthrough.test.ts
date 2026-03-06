import { describe, expect, it } from "vitest";
import {
  evaluateDiscoveryFollowThrough,
  extractKnownVenuesFromDiscovery,
  type DiscoveryFollowThroughState,
} from "../../governance/discovery-followthrough.js";
import type { ToolCallResult } from "../../types.js";

function tool(name: string, result: string, error?: string): ToolCallResult {
  return {
    id: `${name}-1`,
    name,
    arguments: {},
    result,
    durationMs: 1,
    error,
  };
}

describe("discovery follow-through governance", () => {
  it("extracts known venues from discovery output", () => {
    const venues = extractKnownVenuesFromDiscovery(
      "Found opportunities on ClawNews and ERC8004 directory.",
      ["clawnews", "other-venue"],
    );
    expect(venues).toContain("clawnews");
  });

  it("creates pending follow-through state after known-venue discovery", () => {
    const decision = evaluateDiscoveryFollowThrough(
      null,
      [tool("discover_agents", "Found ClawNews listing")],
      ["clawnews"],
      "2026-03-06T17:00:00.000Z",
    );
    expect(decision.nextState?.pendingVenues).toContain("clawnews");
    expect(decision.injectMessage).toBeUndefined();
  });

  it("injects correction when discovery follow-through is missing", () => {
    const state: DiscoveryFollowThroughState = {
      pendingVenues: ["clawnews"],
      misses: 0,
      detectedAt: "2026-03-06T17:00:00.000Z",
    };
    const decision = evaluateDiscoveryFollowThrough(
      state,
      [tool("list_goals", "ok")],
      ["clawnews"],
      "2026-03-06T17:01:00.000Z",
    );
    expect(decision.nextState?.misses).toBe(1);
    expect(decision.injectMessage).toContain("DISCOVERY FOLLOW-THROUGH REQUIRED");
  });

  it("clears pending state when follow-through action is performed", () => {
    const state: DiscoveryFollowThroughState = {
      pendingVenues: ["clawnews"],
      misses: 1,
      detectedAt: "2026-03-06T17:00:00.000Z",
    };
    const decision = evaluateDiscoveryFollowThrough(
      state,
      [tool("add_distribution_target", "ok")],
      ["clawnews"],
      "2026-03-06T17:02:00.000Z",
    );
    expect(decision.nextState).toBeNull();
  });
});
