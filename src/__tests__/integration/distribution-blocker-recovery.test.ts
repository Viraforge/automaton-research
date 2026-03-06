import { describe, expect, it } from "vitest";
import { createTestConfig, createTestDb } from "../mocks.js";
import { ensureCoreDistributionChannels, getChannelUseDecision, recordChannelOutcome } from "../../distribution/channels.js";
import { insertProject, insertDistributionTarget, listPendingDistributionTargets, updateProjectSpend } from "../../state/database.js";
import { enforceProjectBudgetStates } from "../../portfolio/policy.js";

describe("staged validation: distribution blocker recovery + portfolio routing", () => {
  it("enforces ready/misconfigured/funding-required behavior with multi-project targets", () => {
    const db = createTestDb();
    const config = createTestConfig({
      socialRelayUrl: "",
      distribution: { channelCooldownDefaultMs: 1_000 },
      portfolio: { killOnBudgetExhaustion: false },
    } as any);

    ensureCoreDistributionChannels(db.raw, config as any);

    // social relay starts misconfigured when url is missing
    let socialDecision = getChannelUseDecision(db.raw, "social_relay", config as any);
    expect(socialDecision.allowed).toBe(false);
    expect(socialDecision.status).toBe("misconfigured");

    // config reload with relay url should auto-recover to ready
    config.socialRelayUrl = "https://relay.example";
    socialDecision = getChannelUseDecision(db.raw, "social_relay", config as any);
    expect(socialDecision.allowed).toBe(true);
    expect(socialDecision.status).toBe("ready");

    // funding-required route: registration failure sets erc8004 channel unavailable
    recordChannelOutcome(
      db.raw,
      "erc8004_registry",
      "Registration failed: Insufficient ETH for gas. Please fund your wallet with ETH for gas.",
      config as any,
    );
    const ercDecision = getChannelUseDecision(db.raw, "erc8004_registry", config as any);
    expect(ercDecision.allowed).toBe(false);
    expect(ercDecision.status).toBe("funding_required");

    // two active projects with operator-style targets
    insertProject(db.raw, {
      id: "p1",
      name: "Project 1",
      status: "shipping",
      lane: "distribution",
      offer: "Offer 1",
      targetCustomer: "LLM agents",
      monetizationHypothesis: "Paid listing",
      budgetComputeCents: 100,
    });
    insertProject(db.raw, {
      id: "p2",
      name: "Project 2",
      status: "distribution",
      lane: "distribution",
      offer: "Offer 2",
      targetCustomer: "Builders",
      monetizationHypothesis: "Sponsored placement",
      budgetComputeCents: 100,
    });
    insertDistributionTarget(db.raw, {
      id: "t1",
      projectId: "p1",
      channelId: "social_relay",
      targetKey: "clawnews",
      targetLabel: "ClawNews",
      priority: 100,
      status: "pending",
      operatorProvided: true,
    });
    insertDistributionTarget(db.raw, {
      id: "t2",
      projectId: "p2",
      channelId: "erc8004_registry",
      targetKey: "erc-directory",
      targetLabel: "ERC Directory",
      priority: 90,
      status: "pending",
      operatorProvided: true,
    });

    const pending = listPendingDistributionTargets(db.raw);
    expect(pending.map((p) => p.id)).toEqual(["t1", "t2"]);

    // budget enforcement transitions over-budget project out of active execution
    updateProjectSpend(db.raw, "p2", { computeCents: 100 });
    const transitions = enforceProjectBudgetStates(db.raw, config as any);
    expect(transitions).toEqual([{ projectId: "p2", status: "paused" }]);

    db.close();
  });
});
