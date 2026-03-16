/**
 * Phase 0 Infrastructure Validation Smoke Tests (DLD-320)
 *
 * Exercises the happy path of production infrastructure modules:
 * 1. Risk controls — portfolio policy, survival tiers, policy engine (pure functions)
 * 2. Deployment gate — channel-state classification, progress evaluation (pure functions)
 *
 * NOTE: Orchestrator (task-graph) and Paper Trading (dataset) require better-sqlite3
 * native bindings which are not available in this env (no make/gcc). Those modules are
 * validated via a separate Python smoke script (phase0-smoke-dataset.py).
 * The orchestrator task-graph DB operations are structurally validated by confirming
 * normalizeTaskResult works correctly (the only pure function in that module).
 */

import { describe, it, expect } from "vitest";

// ═══════════════════════════════════════════════════════════════
// Module 1: Orchestrator — pure functions only
// ═══════════════════════════════════════════════════════════════

import { normalizeTaskResult } from "../orchestration/task-graph.js";

// ═══════════════════════════════════════════════════════════════
// Module 2: Risk controls
// ═══════════════════════════════════════════════════════════════

import {
  resolvePortfolioPolicy,
  isProjectBudgetExceeded,
} from "../portfolio/policy.js";

import {
  getSurvivalTier,
  getSurvivalTierFromUsdc,
  getFinancialStateFromUsdc,
  formatBalance,
  formatCredits,
} from "../financial/survival.js";

import { PolicyEngine } from "../agent/policy-engine.js";
import type {
  PolicyRule,
  PolicyAction,
  AutomatonTool,
  RiskLevel,
  InputSource,
  PolicyRequest,
} from "../types.js";

// ═══════════════════════════════════════════════════════════════
// Module 3: Deployment gate
// ═══════════════════════════════════════════════════════════════

import {
  classifyChannelTransition,
  canUseChannel,
} from "../governance/channel-state.js";

import { evaluateProgress } from "../governance/progress.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeMockTool(overrides?: Partial<AutomatonTool>): AutomatonTool {
  return {
    name: "test_tool",
    description: "test",
    category: "utility",
    riskLevel: "low" as RiskLevel,
    parameters: {},
    execute: async () => "ok",
    ...overrides,
  } as AutomatonTool;
}

function makePolicyRequest(
  tool: AutomatonTool,
  inputSource?: InputSource,
): PolicyRequest {
  return {
    tool,
    args: {},
    turnContext: { inputSource: inputSource ?? "heartbeat" },
  } as PolicyRequest;
}

// ═══════════════════════════════════════════════════════════════
// SMOKE TESTS
// ═══════════════════════════════════════════════════════════════

describe("Phase 0 Smoke: Orchestrator (pure functions)", () => {
  it("normalizeTaskResult handles valid result", () => {
    const valid = normalizeTaskResult({ success: true, output: "done" });
    expect(valid).not.toBeNull();
    expect(valid!.success).toBe(true);
    expect(valid!.output).toBe("done");
    expect(valid!.artifacts).toEqual([]);
    expect(valid!.costCents).toBe(0);
    expect(valid!.duration).toBe(0);
  });

  it("normalizeTaskResult handles result with all fields", () => {
    const full = normalizeTaskResult({
      success: false,
      output: "error occurred",
      artifacts: ["log.txt", "report.json"],
      costCents: 42,
      duration: 1500,
    });
    expect(full).not.toBeNull();
    expect(full!.success).toBe(false);
    expect(full!.artifacts).toEqual(["log.txt", "report.json"]);
    expect(full!.costCents).toBe(42);
    expect(full!.duration).toBe(1500);
  });

  it("normalizeTaskResult rejects invalid inputs", () => {
    expect(normalizeTaskResult(null)).toBeNull();
    expect(normalizeTaskResult("not an object")).toBeNull();
    expect(normalizeTaskResult({ success: true })).toBeNull();
    expect(normalizeTaskResult({ output: "missing success" })).toBeNull();
    expect(normalizeTaskResult(42)).toBeNull();
  });
});

describe("Phase 0 Smoke: Risk Controls", () => {
  describe("Portfolio Policy", () => {
    it("resolvePortfolioPolicy returns sane defaults", () => {
      const policy = resolvePortfolioPolicy();
      expect(policy.maxActiveProjects).toBe(3);
      expect(policy.maxShippingProjects).toBe(1);
      expect(policy.maxDistributionProjects).toBe(1);
      expect(policy.noProgressCycleLimit).toBe(6);
      expect(policy.killOnBudgetExhaustion).toBe(false);
    });

    it("resolvePortfolioPolicy respects config overrides", () => {
      const policy = resolvePortfolioPolicy({
        portfolio: { maxActiveProjects: 5, killOnBudgetExhaustion: true },
      } as any);
      expect(policy.maxActiveProjects).toBe(5);
      expect(policy.killOnBudgetExhaustion).toBe(true);
    });

    it("resolvePortfolioPolicy clamps out-of-range values", () => {
      const policy = resolvePortfolioPolicy({
        portfolio: { maxActiveProjects: 100 },
      } as any);
      expect(policy.maxActiveProjects).toBe(20); // clamped to max
    });

    it("isProjectBudgetExceeded detects compute overspend", () => {
      expect(isProjectBudgetExceeded({
        budgetComputeCents: 1000, spentComputeCents: 1000,
        budgetTokens: 0, spentTokens: 0,
      } as any)).toBe(true);
    });

    it("isProjectBudgetExceeded detects token overspend", () => {
      expect(isProjectBudgetExceeded({
        budgetComputeCents: 0, spentComputeCents: 0,
        budgetTokens: 5000, spentTokens: 5000,
      } as any)).toBe(true);
    });

    it("isProjectBudgetExceeded allows under-budget project", () => {
      expect(isProjectBudgetExceeded({
        budgetComputeCents: 1000, spentComputeCents: 500,
        budgetTokens: 0, spentTokens: 0,
      } as any)).toBe(false);
    });

    it("isProjectBudgetExceeded allows zero-budget project (unlimited)", () => {
      expect(isProjectBudgetExceeded({
        budgetComputeCents: 0, spentComputeCents: 999,
        budgetTokens: 0, spentTokens: 999,
      } as any)).toBe(false);
    });
  });

  describe("Survival Tiers", () => {
    it("getSurvivalTier classifies all tiers (legacy credits)", () => {
      expect(getSurvivalTier(600)).toBe("high");
      expect(getSurvivalTier(100)).toBe("normal");
      expect(getSurvivalTier(20)).toBe("low_compute");
      expect(getSurvivalTier(0)).toBe("critical");
      expect(getSurvivalTier(-1)).toBe("dead");
    });

    it("getSurvivalTierFromUsdc classifies USDC tiers", () => {
      expect(getSurvivalTierFromUsdc(10.0)).toBe("high");
      expect(getSurvivalTierFromUsdc(1.0)).toBe("normal");
      expect(getSurvivalTierFromUsdc(0.2)).toBe("low_compute");
      expect(getSurvivalTierFromUsdc(0.0)).toBe("critical");
      expect(getSurvivalTierFromUsdc(-0.01)).toBe("dead");
    });

    it("getFinancialStateFromUsdc builds state object", () => {
      const state = getFinancialStateFromUsdc(5.0);
      expect(state.usdcBalance).toBe(5.0);
      expect(state.creditsCents).toBe(500);
      expect(state.lastChecked).toBeTruthy();
    });

    it("formatBalance and formatCredits produce display strings", () => {
      expect(formatBalance(5.5)).toBe("$5.50");
      expect(formatCredits(550)).toBe("$5.50");
      expect(formatBalance(0)).toBe("$0.00");
      expect(formatCredits(1)).toBe("$0.01");
    });
  });

  describe("Policy Engine (no DB required)", () => {
    it("deriveAuthorityLevel maps input sources correctly", () => {
      expect(PolicyEngine.deriveAuthorityLevel("heartbeat")).toBe("external");
      expect(PolicyEngine.deriveAuthorityLevel("creator")).toBe("agent");
      expect(PolicyEngine.deriveAuthorityLevel("agent")).toBe("agent");
      expect(PolicyEngine.deriveAuthorityLevel("system")).toBe("system");
      expect(PolicyEngine.deriveAuthorityLevel("wakeup")).toBe("system");
      expect(PolicyEngine.deriveAuthorityLevel(undefined)).toBe("external");
    });
  });
});

describe("Phase 0 Smoke: Deployment Gate", () => {
  describe("Channel State Classification", () => {
    it("detects misconfigured social relay", () => {
      const result = classifyChannelTransition({
        channelId: "ch1",
        message: "Social relay not configured",
      });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("misconfigured");
      expect(result!.blockerReason).toBe("social relay not configured");
      expect(result!.cooldownUntil).toBeNull();
    });

    it("detects insufficient gas funding", () => {
      const result = classifyChannelTransition({
        channelId: "ch2",
        message: "Insufficient ETH for gas",
      });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("funding_required");
      expect(result!.blockerReason).toBe("insufficient gas funding");
    });

    it("detects quota exhaustion with reset time", () => {
      const resetIso = "2026-03-17T00:00:00Z";
      const result = classifyChannelTransition(
        { channelId: "ch3", message: "Weekly/Monthly Limit Exhausted" },
        { quotaResetIso: resetIso },
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe("quota_exhausted");
      expect(result!.cooldownUntil).toBe(resetIso);
    });

    it("detects transient failures (429/5xx) with cooldown", () => {
      const now = "2026-03-16T12:00:00Z";
      const result = classifyChannelTransition(
        { channelId: "ch4", message: "HTTP 429 rate limited", nowIso: now },
        { transientCooldownMs: 300_000 },
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe("cooldown");
      expect(result!.blockerReason).toBe("transient failure");
      const cooldownTime = new Date(result!.cooldownUntil!).getTime();
      expect(cooldownTime - new Date(now).getTime()).toBe(300_000);
    });

    it("detects timeout errors", () => {
      const result = classifyChannelTransition({
        channelId: "ch-timeout",
        message: "Request failed: ETIMEDOUT",
      });
      expect(result).not.toBeNull();
      expect(result!.status).toBe("cooldown");
    });

    it("detects 5xx server errors", () => {
      for (const code of ["500", "502", "503", "504"]) {
        const result = classifyChannelTransition({
          channelId: `ch-${code}`,
          message: `Server returned ${code}`,
        });
        expect(result).not.toBeNull();
        expect(result!.status).toBe("cooldown");
      }
    });

    it("returns null for unrecognized messages", () => {
      expect(classifyChannelTransition({
        channelId: "ch5",
        message: "Everything is fine",
      })).toBeNull();
    });
  });

  describe("canUseChannel gate", () => {
    it("blocks terminal states", () => {
      expect(canUseChannel("disabled")).toBe(false);
      expect(canUseChannel("misconfigured")).toBe(false);
      expect(canUseChannel("funding_required")).toBe(false);
      expect(canUseChannel("blocked_by_policy")).toBe(false);
    });

    it("allows ready channels", () => {
      expect(canUseChannel("ready")).toBe(true);
    });

    it("allows cooldown channels after cooldown expires", () => {
      expect(canUseChannel("cooldown", "2026-03-16T12:00:00Z", "2026-03-16T11:00:00Z")).toBe(true);
    });

    it("blocks cooldown channels before cooldown expires", () => {
      expect(canUseChannel("cooldown", "2026-03-16T12:00:00Z", "2026-03-16T13:00:00Z")).toBe(false);
    });
  });

  describe("Progress Evaluation", () => {
    it("task completion counts as progress", () => {
      const result = evaluateProgress({ toolCalls: [], taskDelta: { completed: 1 } });
      expect(result.progressed).toBe(true);
      expect(result.reason).toBe("task state changed");
    });

    it("task failure also counts as progress", () => {
      const result = evaluateProgress({ toolCalls: [], taskDelta: { failed: 1 } });
      expect(result.progressed).toBe(true);
    });

    it("productive tool call counts as progress", () => {
      const result = evaluateProgress({
        toolCalls: [{ id: "1", name: "create_project", arguments: {}, result: "ok", durationMs: 10 } as any],
      });
      expect(result.progressed).toBe(true);
      expect(result.reason).toContain("create_project");
    });

    it("discovery-only calls do not count as progress", () => {
      const result = evaluateProgress({
        toolCalls: [{ id: "1", name: "list_goals", arguments: {}, result: "ok", durationMs: 10 } as any],
      });
      expect(result.progressed).toBe(false);
      expect(result.reason).toContain("status or discovery only");
    });

    it("metric recording counts as progress", () => {
      expect(evaluateProgress({ toolCalls: [], metricRecorded: true }).progressed).toBe(true);
    });

    it("intent statement without action does not count", () => {
      const result = evaluateProgress({ toolCalls: [], message: "I will deploy the fix now" });
      expect(result.progressed).toBe(false);
      expect(result.reason).toContain("intent statement");
    });

    it("empty input has no progress signal", () => {
      const result = evaluateProgress({ toolCalls: [] });
      expect(result.progressed).toBe(false);
      expect(result.reason).toContain("no verified progress signal");
    });
  });
});
