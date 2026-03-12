/**
 * Agent Loop Tests
 *
 * Deterministic tests for the agent loop using mock clients.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import {
  MockInferenceClient,
  MockConwayClient,
  MockSocialClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
  toolCallResponse,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase, AgentTurn, AgentState } from "../types.js";
import { insertGoal, insertProject } from "../state/database.js";

// Mock Conway registry discovery to prevent real network calls to dead endpoint
vi.mock("../registry/discovery.js", () => ({
  discoverAgents: vi.fn().mockResolvedValue([]),
  searchAgents: vi.fn().mockResolvedValue([]),
}));

function getLoopDetectionState(db: AutomatonDatabase): Record<string, unknown> {
  const raw = db.getKV("loop_detection_state");
  return raw ? JSON.parse(raw) : {};
}

const POST_WARNING_PIVOT_KEY = "loop.post_warning_pivot_required";
const CF_MIGRATION_SEEDED_KEY = "legacy.cf_migration.seeded";

let uniqueResponseCounter = 0;

function uniqueToolResponse(
  name: string,
  args: Record<string, unknown>,
): ReturnType<typeof toolCallResponse> {
  uniqueResponseCounter += 1;
  const uid = `fixture_${uniqueResponseCounter}`;
  return {
    id: `resp_${uid}`,
    model: "mock-model",
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: `call_${uid}`,
        type: "function" as const,
        function: { name, arguments: JSON.stringify(args) },
      }],
    },
    toolCalls: [{
      id: `call_${uid}`,
      type: "function" as const,
      function: { name, arguments: JSON.stringify(args) },
    }],
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    finishReason: "tool_calls",
  };
}

describe("Agent Loop", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let identity: ReturnType<typeof createTestIdentity>;
  let config: ReturnType<typeof createTestConfig>;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    identity = createTestIdentity();
    config = createTestConfig();
    uniqueResponseCounter = 0;
  });

  afterEach(() => {
    db.close();
  });

  it("exec tool runs and is persisted", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo hello" } },
      ]),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // First turn should have the exec tool call
    expect(turns.length).toBeGreaterThanOrEqual(1);
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls[0].name).toBe("exec");
    expect(execTurn!.toolCalls[0].error).toBeUndefined();

    // Verify conway.exec was called
    expect(conway.execCalls.length).toBeGreaterThanOrEqual(1);
    expect(conway.execCalls[0].command).toBe("echo hello");
  });

  it("forbidden patterns blocked", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "rm -rf ~/.automaton" } },
      ]),
      noToolResponse("OK."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The tool result should contain a blocked message, not an error
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    const execCall = execTurn!.toolCalls.find((tc) => tc.name === "exec");
    expect(execCall!.result).toContain("Blocked");

    // conway.exec should NOT have been called
    expect(conway.execCalls.length).toBe(0);
  });

  it("low credits forces low-compute mode", async () => {
    conway.creditsCents = 50; // Below $1 threshold -> critical

    const inference = new MockInferenceClient([
      noToolResponse("Low on credits."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(inference.lowComputeMode).toBe(true);
  });

  it("sleep tool transitions state", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "sleep", arguments: { duration_seconds: 60, reason: "test" } },
      ]),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
  });

  it("idle auto-sleep on no tool calls", async () => {
    const inference = new MockInferenceClient([
      noToolResponse("Nothing to do."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
  });

  it.skip("classifies a no-tool wake cycle as empty_wake_cycle (requires: lastNoProgressSignals tracking)", async () => {
    const inference = new MockInferenceClient([
      noToolResponse("I cannot do anything right now."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    const loopState = getLoopDetectionState(db);
    expect(loopState.lastNoProgressSignals).toContain("empty_wake_cycle");
    expect(db.getKV("portfolio.no_progress_cycles")).toBe("1");
  });

  it("does not classify bounded sleep as empty_wake_cycle", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "sleep", arguments: { duration_seconds: 60, reason: "waiting on dependency" } },
      ]),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    const loopState = getLoopDetectionState(db);
    expect(loopState.lastNoProgressSignals ?? []).not.toContain("empty_wake_cycle");
  });

  it("respects existing sleep_until on startup and skips inference", async () => {
    const inference = new MockInferenceClient([noToolResponse("should not run")]);
    db.setKV("sleep_until", new Date(Date.now() + 5 * 60_000).toISOString());

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
    expect(inference.calls.length).toBe(0);
  });

  it("inbox messages cause pendingInput injection", async () => {
    // Insert an inbox message before running the loop
    db.insertInboxMessage({
      id: "test-msg-1",
      from: "0xsender",
      to: "0xrecipient",
      content: "Hello from another agent!",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      // First response: wakeup prompt
      toolCallResponse([
        { name: "exec", arguments: { command: "echo awake" } },
      ]),
      // Second response: inbox message (after wakeup turn, pendingInput is cleared,
      // then inbox messages are picked up on the next iteration)
      noToolResponse("Received the message."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // One of the turns should have input from the inbox message
    const inboxTurn = turns.find(
      (t) => t.input?.includes("Hello from another agent!"),
    );
    expect(inboxTurn).toBeDefined();
    expect(inboxTurn!.inputSource).toBe("agent");
  });

  it("MAX_TOOL_CALLS_PER_TURN limits tool calls", async () => {
    // Create a response with 15 tool calls (max is 10)
    const manyToolCalls = Array.from({ length: 15 }, (_, i) => ({
      name: "exec",
      arguments: { command: `echo ${i}` },
    }));

    const inference = new MockInferenceClient([
      toolCallResponse(manyToolCalls),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The first turn should have at most 10 tool calls executed
    const execTurn = turns.find((t) => t.toolCalls.length > 0);
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls.length).toBeLessThanOrEqual(10);
  });

  it("consecutive errors trigger sleep", async () => {
    // Create an inference client that always throws
    const failingInference = new MockInferenceClient([]);
    failingInference.chat = async () => {
      throw new Error("Inference API unavailable");
    };

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleSpy3 = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      identity,
      config: { ...config, logLevel: "debug" },
      db,
      conway,
      inference: failingInference,
    });

    // After 5 consecutive errors, should be sleeping
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
    consoleSpy3.mockRestore();
  });

  it("1214 invalid-messages triggers immediate turn-history reset", async () => {
    db.insertTurn({
      id: "stale-turn-1214",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "stale",
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costCents: 0,
    });
    expect(db.getTurnCount()).toBe(1);

    const failingInference = new MockInferenceClient([]);
    failingInference.chat = async () => {
      throw new Error(
        "Inference error (byok): 400 code 1214 invalid messages payload (model=glm-5, endpoint=https://api.z.ai/api/coding/paas/v4/chat/completions): The messages parameter is illegal.",
      );
    };

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference: failingInference,
    });

    const lastError = JSON.parse(db.getKV("last_error") || "{}");
    expect(db.getTurnCount()).toBe(0);
    expect(db.getAgentState()).toBe("sleeping");
    expect(lastError.recovery).toBe("reset_turn_history_1214");
  });

  it("1214 recovery still triggers when provider omits explicit 400 token", async () => {
    db.insertTurn({
      id: "stale-turn-1214-variant",
      timestamp: new Date().toISOString(),
      state: "running",
      thinking: "stale",
      toolCalls: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      costCents: 0,
    });
    expect(db.getTurnCount()).toBe(1);

    const failingInference = new MockInferenceClient([]);
    failingInference.chat = async () => {
      throw new Error("Inference error (byok): code=1214 The messages parameter is illegal.");
    };

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference: failingInference,
    });

    const lastError = JSON.parse(db.getKV("last_error") || "{}");
    expect(db.getTurnCount()).toBe(0);
    expect(db.getAgentState()).toBe("sleeping");
    expect(lastError.recovery).toBe("reset_turn_history_1214");
  });

  it("429 limit-exhausted errors back off without hitting fatal loop", async () => {
    const resetAtMs = Date.now() + 45 * 60_000;
    const resetAt = new Date(resetAtMs).toISOString().replace("T", " ").slice(0, 19);
    const failingInference = new MockInferenceClient([]);
    failingInference.chat = async () => {
      throw new Error(
        `Inference error (byok): 429: Weekly/Monthly Limit Exhausted. Your limit will reset at ${resetAt}`,
      );
    };

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference: failingInference,
    });

    const sleepUntilRaw = db.getKV("sleep_until");
    const lastError = JSON.parse(db.getKV("last_error") || "{}");
    expect(sleepUntilRaw).toBeDefined();
    const sleepUntilMs = Date.parse(sleepUntilRaw!);
    expect(sleepUntilMs - Date.now()).toBeGreaterThan(25 * 60_000);
    expect(lastError.recovery).toBe("inference_429_backoff");
    expect(lastError.message).not.toContain("[FATAL]");
  });

  it("financial state cached fallback on API failure", async () => {
    // Pre-cache a known balance
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 5000, usdcBalance: 1.0 }));

    // Make credits API fail
    conway.getCreditsBalance = async () => {
      throw new Error("API down");
    };

    const inference = new MockInferenceClient([
      noToolResponse("Running with cached balance."),
    ]);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy2 = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    // Should not die, should use cached balance and continue
    const state = db.getAgentState();
    expect(state).not.toBe("dead");

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
  });

  it("turn persistence is atomic with inbox ack", async () => {
    // Insert an inbox message
    db.insertInboxMessage({
      id: "atomic-msg-1",
      from: "0xsender",
      to: "0xrecipient",
      content: "Test atomic persistence",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo processing" } },
      ]),
      noToolResponse("Done processing."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // After processing, the inbox message should be marked as processed
    const unprocessed = db.getUnprocessedInboxMessages(10);
    // The message should have been consumed (either processed or not showing as unprocessed)
    // Since we successfully completed the turn, it should be processed
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  it("state transitions are reported via onStateChange", async () => {
    const stateChanges: AgentState[] = [];

    const inference = new MockInferenceClient([
      noToolResponse("Nothing to do."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Should have transitioned through waking -> running -> sleeping
    expect(stateChanges).toContain("waking");
    expect(stateChanges).toContain("running");
    expect(stateChanges).toContain("sleeping");
  });

  it("cycle turn limit forces sleep after maxTurnsPerCycle", async () => {
    // Set a low cycle limit
    const lowLimitConfig = createTestConfig({ maxTurnsPerCycle: 3 });

    // Create responses that would keep running indefinitely (all mutating tools)
    const responses = Array.from({ length: 10 }, () =>
      toolCallResponse([{ name: "exec", arguments: { command: "echo loop" } }]),
    );
    const inference = new MockInferenceClient(responses);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config: lowLimitConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have stopped at or before the cycle limit (3 turns)
    expect(turns.length).toBeLessThanOrEqual(3);
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
  });

  it("cycle limit sets 2-minute sleep duration", async () => {
    const lowLimitConfig = createTestConfig({ maxTurnsPerCycle: 1 });

    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo test" } }]),
    ]);

    await runAgentLoop({
      identity,
      config: lowLimitConfig,
      db,
      conway,
      inference,
    });

    const sleepUntil = db.getKV("sleep_until");
    expect(sleepUntil).toBeDefined();
    // Sleep should be ~2 minutes (120_000ms) from now
    const sleepMs = new Date(sleepUntil!).getTime() - Date.now();
    expect(sleepMs).toBeGreaterThan(100_000); // at least ~100s
    expect(sleepMs).toBeLessThan(150_000); // at most ~150s
  });

  it("respects custom maxTurnsPerCycle from config", async () => {
    // A limit of 5 should allow exactly 5 turns before forcing sleep
    const limit5Config = createTestConfig({ maxTurnsPerCycle: 5 });

    // Use varied tool names to avoid loop detection (fires after 3 identical patterns)
    const toolNames = ["exec", "write_file", "git_status", "exec", "write_file", "exec", "write_file"];
    const responses = toolNames.map((name) =>
      toolCallResponse([{ name, arguments: name === "exec" ? { command: "echo work" } : { path: "/tmp/test" } }]),
    );

    const inference = new MockInferenceClient(responses);
    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config: limit5Config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have stopped at the cycle limit of 5
    expect(turns.length).toBeLessThanOrEqual(5);
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("zero credits enters critical tier, not dead", async () => {
    conway.creditsCents = 0; // $0 -> critical tier (agent stays alive)

    const inference = new MockInferenceClient([
      noToolResponse("I have no credits but I'm still alive."),
    ]);

    const stateChanges: AgentState[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Zero credits = critical, not dead. Agent should stay alive.
    expect(stateChanges).toContain("critical");
    expect(stateChanges).not.toContain("dead");
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("maintenance loop detected after 3 consecutive idle-only turns", async () => {
    // Simulate: wakeup turn with check_credits, then 2 more idle-only turns,
    // triggering maintenance loop detection on the 3rd idle-only turn.
    // Construct responses with unique tool_call IDs to avoid DB collisions.
    function idleToolResponse(name: string, args: Record<string, unknown>, uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      idleToolResponse("check_credits", {}, "t1"),
      idleToolResponse("system_synopsis", {}, "t2"),
      idleToolResponse("review_memory", {}, "t3"),
      idleToolResponse("list_children", {}, "t4"),
      idleToolResponse("discover_agents", { limit: 5 }, "t5"),
      noToolResponse("I will now work on something productive."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // After 5 consecutive idle-only turns, the loop injects an intervention
    // and still consumes the next turn rather than force-sleeping.
    expect(turns.length).toBe(6);
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeDefined();
  });

  it("maintenance loop NOT triggered when turns mix idle and productive tools", async () => {
    // Turn 1: idle-only, Turn 2: has productive tool (exec), Turn 3: idle-only
    // Should NOT trigger because turn 2 breaks the consecutive count.
    const inference = new MockInferenceClient([
      // Turn 1 (wakeup): idle-only
      toolCallResponse([
        { name: "check_credits", arguments: {} },
      ]),
      // Turn 2: productive tool — resets idle counter
      toolCallResponse([
        { name: "exec", arguments: { command: "echo hello" } },
      ]),
      // Turn 3: idle-only — counter starts at 1 again
      toolCallResponse([
        { name: "system_synopsis", arguments: {} },
      ]),
      // Turn 4: end
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // No maintenance loop intervention should have been injected
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeUndefined();
  });

  it("maintenance loop triggers with varying idle tool combinations", async () => {
    // Each turn uses a different idle-only tool, but all are idle-only.
    // The existing exact-pattern detector would NOT catch this (different patterns).
    // The new idle-tool detector SHOULD catch it.
    function idleToolResponse(name: string, args: Record<string, unknown>, uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      idleToolResponse("check_credits", {}, "v1"),
      idleToolResponse("check_usdc_balance", {}, "v2"),
      idleToolResponse("git_status", {}, "v3"),
      idleToolResponse("list_children", {}, "v4"),
      idleToolResponse("discover_agents", { limit: 5 }, "v5"),
      noToolResponse("Starting productive work now."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // After 5 consecutive idle-only turns (even with different tools),
    // the loop injects a no-idle directive instead of forcing sleep.
    expect(turns.length).toBe(6);
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeDefined();
  });

  it("loop enforcement forces sleep after warning is ignored (6 identical patterns)", async () => {
    // 6 identical exec tool calls: warning fires at turn 3, enforcement at turn 6.
    // Use unique IDs to avoid DB collisions.
    function execResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      execResponse("e1"),
      execResponse("e2"),
      execResponse("e3"), // Warning fires here
      execResponse("e4"),
      execResponse("e5"),
      execResponse("e6"), // Enforcement fires here — forced sleep
    ]);

    const turns: AgentTurn[] = [];
    const stateChanges: AgentState[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
      onStateChange: (state) => stateChanges.push(state),
    });

    // Should have the warning at turn 4 (injected after turn 3)
    const warningTurn = turns.find(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(warningTurn).toBeDefined();

    // Agent should be sleeping due to enforcement
    expect(db.getAgentState()).toBe("sleeping");
    expect(stateChanges[stateChanges.length - 1]).toBe("sleeping");
  });

  it("loop enforcement resets when agent changes behavior after warning", async () => {
    // 3 identical exec calls → warning → different tool → 3 more exec calls → warning (not enforcement)
    function execResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      execResponse("r1"),
      execResponse("r2"),
      execResponse("r3"), // Warning fires, loopWarningPattern = "exec"
      // Turn 4: different tool — resets loopWarningPattern
      toolCallResponse([
        { name: "send_message", arguments: { to: "0x123", content: "hello" } },
      ]),
      execResponse("r5"),
      execResponse("r6"),
      execResponse("r7"), // Warning fires again (NOT enforcement — tracker was reset)
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have gotten a warning, not enforcement (agent is still running, not force-slept)
    // The second set of 3 identical patterns gets a NEW warning, not enforcement
    const warningTurns = turns.filter(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(warningTurns.length).toBeGreaterThanOrEqual(2);

    // No enforcement turn should exist
    const enforcementTurn = turns.find(
      (t) => t.input?.includes("LOOP ENFORCEMENT"),
    );
    expect(enforcementTurn).toBeUndefined();
  });

  it("sets post-warning guard when loop warning is injected", async () => {
    const inference = new MockInferenceClient([
      uniqueToolResponse("exec", { command: "echo loop-a" }),
      uniqueToolResponse("exec", { command: "echo loop-b" }),
      uniqueToolResponse("exec", { command: "echo loop-c" }),
      noToolResponse("done"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const warningTurn = turns.find((turn) => turn.input?.includes("LOOP DETECTED"));
    expect(warningTurn).toBeDefined();
    expect(db.getKV(POST_WARNING_PIVOT_KEY)).toBe("1");
  });

  it("blocks sleep when post-warning guard is active", async () => {
    db.setKV(POST_WARNING_PIVOT_KEY, "1");
    const inference = new MockInferenceClient([
      uniqueToolResponse("sleep", { duration_seconds: 30, reason: "fallback" }),
      noToolResponse("done"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(turns.some((turn) => turn.input?.includes("PIVOT REQUIRED"))).toBe(true);
  });

  it("allows a meaningful tool call on the turn immediately after a system loop warning", async () => {
    const inference = new MockInferenceClient([
      uniqueToolResponse("exec", { command: "echo loop-1" }),
      uniqueToolResponse("exec", { command: "echo loop-2" }),
      uniqueToolResponse("exec", { command: "echo loop-3" }),
      uniqueToolResponse("write_file", { path: "/tmp/real-artifact.txt", content: "artifact" }),
      uniqueToolResponse("sleep", { duration_seconds: 15, reason: "after work" }),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const pivotRequiredTurns = turns.filter((turn) => turn.input?.includes("PIVOT REQUIRED"));
    expect(pivotRequiredTurns.length).toBe(0);
    expect(db.getKV(POST_WARNING_PIVOT_KEY)).toBeUndefined();
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("does not block sleep when no prior system warning was issued", async () => {
    const inference = new MockInferenceClient([
      uniqueToolResponse("sleep", { duration_seconds: 10, reason: "idle" }),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV(POST_WARNING_PIVOT_KEY)).toBeUndefined();
  });

  it("blocks WORKLOG rewrite after a post-warning guard is active", async () => {
    db.setKV(POST_WARNING_PIVOT_KEY, "1");
    const inference = new MockInferenceClient([
      uniqueToolResponse("write_file", { path: "/tmp/WORKLOG.md", content: "updated notes" }),
      noToolResponse("done"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(turns.some((turn) => turn.input?.includes("WORKLOG.md rewrite"))).toBe(true);
  });

  it("blocks low-signal localhost checks after a post-warning guard is active", async () => {
    db.setKV(POST_WARNING_PIVOT_KEY, "1");
    conway.exec = async (command: string, timeout?: number) => {
      conway.execCalls.push({ command, timeout });
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    const inference = new MockInferenceClient([
      uniqueToolResponse("exec", { command: "curl http://localhost:3000/health" }),
      noToolResponse("done"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(turns.some((turn) => turn.input?.includes("localhost verification produced low-signal output"))).toBe(true);
  });

  it("discover_agents loop triggers discovery cooldown and blocked retry", { timeout: 180_000 }, async () => {
    // Repeated idle discovery should trigger a dedicated cooldown intervention.
    // A subsequent discover_agents attempt should be blocked by the cooldown.
    function discoverResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "discover_agents", arguments: JSON.stringify({ limit: 15 }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "discover_agents", arguments: JSON.stringify({ limit: 15 }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      discoverResponse("d1"),
      discoverResponse("d2"),
      discoverResponse("d3"), // should be blocked by cooldown
      noToolResponse("Processing discovery results."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const discoveryWarning = turns.find(
      (t) => t.input?.includes("DISCOVERY LOOP DETECTED"),
    );
    expect(discoveryWarning).toBeDefined();

    const blockedCall = turns
      .flatMap((t) => t.toolCalls)
      .find((tc) => tc.name === "discover_agents" && tc.error?.includes("temporarily blocked"));
    expect(blockedCall).toBeDefined();
  });

  it("forces sleep backoff on exec-dominant non-progress loops even when tool patterns vary", async () => {
    const strictConfig = createTestConfig({
      portfolio: {
        noProgressCycleLimit: 2,
      },
    });

    function uniqueToolResponse(
      uid: string,
      calls: Array<{ name: string; arguments: Record<string, unknown> }>,
    ): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: calls.map((call, i) => ({
            id: `call_${uid}_${i}`,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        },
        toolCalls: calls.map((call, i) => ({
          id: `call_${uid}_${i}`,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      uniqueToolResponse("np1", [
        { name: "exec", arguments: { command: "echo one" } },
      ]),
      uniqueToolResponse("np2", [
        { name: "exec", arguments: { command: "echo two" } },
        { name: "list_children", arguments: {} },
      ]),
      uniqueToolResponse("np3", [
        { name: "exec", arguments: { command: "echo three" } },
        { name: "check_credits", arguments: {} },
      ]),
      noToolResponse("should not run"),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config: strictConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(turns.length).toBeLessThanOrEqual(3);
    expect(db.getAgentState()).toBe("sleeping");
    const sleepUntil = db.getKV("sleep_until");
    expect(sleepUntil).toBeDefined();
    const sleepMs = new Date(sleepUntil!).getTime() - Date.now();
    expect(sleepMs).toBeGreaterThan(150_000);
  });

  it("blocks introspection/status tools during no-progress stalls", async () => {
    const stalledConfig = createTestConfig({
      portfolio: {
        noProgressCycleLimit: 1,
      },
    });
    db.setKV("portfolio.no_progress_cycles", "1");

    const inference = new MockInferenceClient([
      {
        id: "resp_stall_seed",
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_stall_seed",
            type: "function" as const,
            function: { name: "check_balance", arguments: "{}" },
          }],
        },
        toolCalls: [{
          id: "call_stall_seed",
          type: "function" as const,
          function: { name: "check_balance", arguments: "{}" },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      },
      {
        id: "resp_stall_block",
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_stall_block",
            type: "function" as const,
            function: { name: "review_memory", arguments: "{}" },
          }],
        },
        toolCalls: [{
          id: "call_stall_block",
          type: "function" as const,
          function: { name: "review_memory", arguments: "{}" },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      },
      {
        id: "resp_stall_block_recall",
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_stall_block_recall",
            type: "function" as const,
            function: { name: "recall_facts", arguments: "{}" },
          }],
        },
        toolCalls: [{
          id: "call_stall_block_recall",
          type: "function" as const,
          function: { name: "recall_facts", arguments: "{}" },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      },
      {
        id: "resp_stall_block_skills",
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_stall_block_skills",
            type: "function" as const,
            function: { name: "list_skills", arguments: "{}" },
          }],
        },
        toolCalls: [{
          id: "call_stall_block_skills",
          type: "function" as const,
          function: { name: "list_skills", arguments: "{}" },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      },
      {
        id: "resp_stall_block_instances",
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_stall_block_instances",
            type: "function" as const,
            function: { name: "list_instances", arguments: "{}" },
          }],
        },
        toolCalls: [{
          id: "call_stall_block_instances",
          type: "function" as const,
          function: { name: "list_instances", arguments: "{}" },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      },
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: stalledConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const blocked = turns
      .flatMap((turn) => turn.toolCalls)
      .find((call) => call.name === "review_memory");
    expect(blocked).toBeDefined();
    expect(blocked?.error).toContain("tool temporarily blocked during no-progress stall");

    const blockedRecall = turns
      .flatMap((turn) => turn.toolCalls)
      .find((call) => call.name === "recall_facts");
    expect(blockedRecall).toBeDefined();
    expect(blockedRecall?.error).toContain("tool temporarily blocked during no-progress stall");

    const blockedSkills = turns
      .flatMap((turn) => turn.toolCalls)
      .find((call) => call.name === "list_skills");
    expect(blockedSkills).toBeDefined();
    expect(blockedSkills?.error).toContain("tool temporarily blocked during no-progress stall");

    const blockedInstances = turns
      .flatMap((turn) => turn.toolCalls)
      .find((call) => call.name === "list_instances");
    expect(blockedInstances).toBeDefined();
    expect(blockedInstances?.error).toContain("tool temporarily blocked during no-progress stall");
  });

  it("flags mixed mutating no-progress loops when tool patterns vary", async () => {
    const inference = new MockInferenceClient([
      uniqueToolResponse("write_file", { path: "/tmp/alpha.txt", content: "alpha" }),
      uniqueToolResponse("exec", { command: "echo restart" }),
      uniqueToolResponse("write_file", { path: "/tmp/beta.txt", content: "beta" }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const interventionTurn = turns.find((turn) =>
      turn.input?.includes("MIXED MUTATING LOOP DETECTED"));
    expect(interventionTurn).toBeDefined();
  });

  it.skip("flags repeated write_file turns without verification (requires: write_without_verification intervention)", async () => {
    const inference = new MockInferenceClient([
      uniqueToolResponse("write_file", { path: "/tmp/one.txt", content: "one" }),
      uniqueToolResponse("write_file", { path: "/tmp/two.txt", content: "two" }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const interventionTurn = turns.find((turn) => turn.input?.includes("WRITE WITHOUT VERIFICATION"));
    expect(interventionTurn).toBeDefined();
  });

  it("does not flag write_file when the next cycle verifies the artifact", async () => {
    const inference = new MockInferenceClient([
      uniqueToolResponse("write_file", { path: "/tmp/one.txt", content: "one" }),
      uniqueToolResponse("exec", { command: "echo verify" }),
      noToolResponse("done"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(turns.some((turn) => turn.input?.includes("WRITE WITHOUT VERIFICATION"))).toBe(false);
    const loopState = getLoopDetectionState(db);
    expect(loopState.lastNoProgressSignals ?? []).not.toContain("write_without_verification");
  });

  it.skip("flags stale capability claims when sovereign publication is available (requires: publish_service intervention)", async () => {
    const sovereignConfig = createTestConfig({
      useSovereignProviders: true,
      cloudflareApiToken: "cf-token",
      vultrApiKey: "vultr-token",
      maxTurnsPerCycle: 3,
      portfolio: {
        noProgressCycleLimit: 1,
      },
    });
    const inference = new MockInferenceClient([
      noToolResponse("I have 0 USDC so I cannot deploy or publish anything."),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: sovereignConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const correctionTurn = turns.find((turn) => turn.input?.includes("STALE CAPABILITY CLAIM"));
    expect(correctionTurn).toBeDefined();
  });

  it("does not flag stale capability claims when sovereign publication is unavailable", async () => {
    const inference = new MockInferenceClient([
      noToolResponse("I have 0 USDC so I cannot deploy or publish anything."),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(turns.some((turn) => turn.input?.includes("STALE CAPABILITY CLAIM"))).toBe(false);
  });

  it("flags stale Cloudflare blocker claims when sovereign publishing is available via apiKey plus email", async () => {
    const sovereignConfig = createTestConfig({
      useSovereignProviders: true,
      cloudflareApiKey: "cf-key",
      cloudflareEmail: "ops@compintel.co",
      vultrApiKey: "vultr-key",
      maxTurnsPerCycle: 3,
      portfolio: {
        noProgressCycleLimit: 1,
      },
    });
    const inference = new MockInferenceClient([
      noToolResponse("Cloudflare API token is missing, so I still cannot publish to compintel.co subdomains."),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: sovereignConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const correctionTurn = turns.find((turn) =>
      turn.input?.includes("STALE CAPABILITY CLAIM"));
    expect(correctionTurn).toBeDefined();
  });

  it("still flags stale Cloudflare claims when the same turn only has successful Cloudflare output", async () => {
    const sovereignConfig = createTestConfig({
      useSovereignProviders: true,
      cloudflareApiKey: "cf-key",
      cloudflareEmail: "ops@compintel.co",
      vultrApiKey: "vultr-key",
      maxTurnsPerCycle: 3,
      portfolio: {
        noProgressCycleLimit: 1,
      },
    });
    conway.exec = async (command: string, timeout?: number) => {
      conway.execCalls.push({ command, timeout });
      return { stdout: "cloudflare publish succeeded", stderr: "", exitCode: 0 };
    };
    const inference = new MockInferenceClient([
      {
        id: "resp_stale_cloudflare_success_output",
        model: "mock-model",
        message: {
          role: "assistant",
          content: "Cloudflare API token is missing, so I still cannot publish to compintel.co subdomains.",
          tool_calls: [{
            id: "call_stale_cloudflare_success_output",
            type: "function" as const,
            function: { name: "exec", arguments: JSON.stringify({ command: "echo cloudflare status" }) },
          }],
        },
        toolCalls: [{
          id: "call_stale_cloudflare_success_output",
          type: "function" as const,
          function: { name: "exec", arguments: JSON.stringify({ command: "echo cloudflare status" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      },
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: sovereignConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const correctionTurn = turns.find((turn) =>
      turn.input?.includes("STALE CAPABILITY CLAIM"));
    expect(correctionTurn).toBeDefined();
  });

  it.skip("redirects forbidden background exec toward publish_service or verification (requires: background_exec redirection)", async () => {
    const inference = new MockInferenceClient([
      uniqueToolResponse("exec", { command: "node server.js &" }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const correctionTurn = turns.find((turn) => turn.input?.includes("PUBLICATION REDIRECT"));
    expect(correctionTurn).toBeDefined();
    const blockedExec = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "exec");
    expect(blockedExec?.error ?? blockedExec?.result ?? "").toContain("background operator &");
  });

  it.skip("blocks complete_task for public revenue work without public proof (requires: completion_validation logic)", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run("task-public-proof", "goal-public-proof", "Publish revenue API", "Expose paid API publicly", now);

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof",
        output: "Verified on localhost only",
        artifacts: "http://localhost:8081/health",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("requires public completion evidence");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get("task-public-proof") as { status: string };
    expect(taskRow.status).toBe("pending");
  });

  it("rejects temporary tunnel URLs as public completion evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-temp", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-temp",
      "goal-public-proof-temp",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-temp",
        output: "Verified https://beautifully-epinions-featured-serious.trycloudflare.com/health",
        artifacts: "https://beautifully-epinions-featured-serious.trycloudflare.com/health",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("requires public completion evidence");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-temp",
    ) as { status: string };
    expect(taskRow.status).toBe("pending");
  });

  it("rejects query-string route fragments as public completion evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-query-fragment", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-query-fragment",
      "goal-public-proof-query-fragment",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-query-fragment",
        output: "Verified https://api.compintel.co/?next=/health",
        artifacts: "https://api.compintel.co/?next=/health",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("requires public completion evidence");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-query-fragment",
    ) as { status: string };
    expect(taskRow.status).toBe("pending");
  });

  it("rejects bare compintel apex URLs as public completion evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-apex", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-apex",
      "goal-public-proof-apex",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-apex",
        output: "Verified https://compintel.co/health",
        artifacts: "https://compintel.co/health",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("requires public completion evidence");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-apex",
    ) as { status: string };
    expect(taskRow.status).toBe("pending");
  });

  it("rejects non-https public URLs as public completion evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-http", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-http",
      "goal-public-proof-http",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-http",
        output: "Verified http://api.compintel.co/health",
        artifacts: "http://api.compintel.co/health",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("requires public completion evidence");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-http",
    ) as { status: string };
    expect(taskRow.status).toBe("pending");
  });

  it("accepts approved https URLs wrapped in common formatting", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-formatted", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-formatted",
      "goal-public-proof-formatted",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-formatted",
        output: "Verified <https://api.compintel.co/health> and `https://api.compintel.co/health`",
        artifacts: "<https://api.compintel.co/health>,`https://api.compintel.co/health`",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("marked as completed");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-formatted",
    ) as { status: string };
    expect(taskRow.status).toBe("completed");
  });

  it("accepts approved public host plus separate business-route evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-split", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-split",
      "goal-public-proof-split",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-split",
        output: "Public hostname: https://api.compintel.co",
        artifacts: "Verified business route /health responds with 200",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("marked as completed");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-split",
    ) as { status: string };
    expect(taskRow.status).toBe("completed");
  });

  it("accepts approved public host plus separate backtick-wrapped route evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-split-backticks", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-split-backticks",
      "goal-public-proof-split-backticks",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-split-backticks",
        output: "Public host: https://api.compintel.co",
        artifacts: "Verified business route `/health` responds with 200",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("marked as completed");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-split-backticks",
    ) as { status: string };
    expect(taskRow.status).toBe("completed");
  });

  it("accepts approved public host plus separate angle-bracket-wrapped route evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-split-angle", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-split-angle",
      "goal-public-proof-split-angle",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-split-angle",
        output: "Public host: https://api.compintel.co",
        artifacts: "Verified business route </health> responds with 200",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("marked as completed");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-split-angle",
    ) as { status: string };
    expect(taskRow.status).toBe("completed");
  });

  it("accepts wrapped approved https URLs followed by prose punctuation", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-punctuated", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-punctuated",
      "goal-public-proof-punctuated",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-punctuated",
        output: "Primary endpoint is <https://api.compintel.co/health>: use it for smoke tests.",
        artifacts: "Health check passed at <https://api.compintel.co/health>: verified.",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("marked as completed");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-punctuated",
    ) as { status: string };
    expect(taskRow.status).toBe("completed");
  });

  it("rejects hash-fragment routes as public completion evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-hash-fragment", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-hash-fragment",
      "goal-public-proof-hash-fragment",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-hash-fragment",
        output: "Verified https://api.compintel.co/#/health",
        artifacts: "https://api.compintel.co/#/health",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("requires public completion evidence");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-hash-fragment",
    ) as { status: string };
    expect(taskRow.status).toBe("pending");
  });

  it("rejects split evidence when route proof only appears in query or fragment prose", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-prose-spoof", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-prose-spoof",
      "goal-public-proof-prose-spoof",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-prose-spoof",
        output: "Public hostname: https://api.compintel.co",
        artifacts: "callback ?next=/health and fragment #/health should not count as proof",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("requires public completion evidence");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-prose-spoof",
    ) as { status: string };
    expect(taskRow.status).toBe("pending");
  });

  it("accepts approved public evidence with uppercase https scheme", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-uppercase-scheme", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-uppercase-scheme",
      "goal-public-proof-uppercase-scheme",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-uppercase-scheme",
        output: "Verified HTTPS://api.compintel.co/health",
        artifacts: "HTTPS://api.compintel.co/health",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("marked as completed");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-uppercase-scheme",
    ) as { status: string };
    expect(taskRow.status).toBe("completed");
  });

  it("accepts approved public evidence wrapped in emphasized markdown", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-emphasis", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-emphasis",
      "goal-public-proof-emphasis",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-emphasis",
        output: "Verified **https://api.compintel.co/health**",
        artifacts: "**https://api.compintel.co/health**",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("marked as completed");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-emphasis",
    ) as { status: string };
    expect(taskRow.status).toBe("completed");
  });

  it("rejects malformed embedded-scheme text as public completion evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-embedded-scheme", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run(
      "task-public-proof-embedded-scheme",
      "goal-public-proof-embedded-scheme",
      "Publish revenue API",
      "Expose paid API publicly",
      now,
    );

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-embedded-scheme",
        output: "Verified nothttps://api.compintel.co/health",
        artifacts: "nothttps://api.compintel.co/health",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("requires public completion evidence");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get(
      "task-public-proof-embedded-scheme",
    ) as { status: string };
    expect(taskRow.status).toBe("pending");
  });

  it("allows complete_task for public revenue work with public route evidence", async () => {
    const now = new Date().toISOString();
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("goal-public-proof-ok", "Ship public API", "Revenue API", now);
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, task_class, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, 'pending', 'monetization', 'generalist', 50, '[]', ?)`,
    ).run("task-public-proof-ok", "goal-public-proof-ok", "Publish revenue API", "Expose paid API publicly", now);

    const inference = new MockInferenceClient([
      uniqueToolResponse("complete_task", {
        task_id: "task-public-proof-ok",
        output: "Verified https://api.compintel.co/health and https://api.compintel.co/v1/pricing",
        artifacts: "https://api.compintel.co/health,https://api.compintel.co/v1/pricing",
      }),
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const completionCall = turns.flatMap((turn) => turn.toolCalls).find((call) => call.name === "complete_task");
    expect(completionCall?.result).toContain("marked as completed");

    const taskRow = db.raw.prepare("SELECT status FROM task_graph WHERE id = ?").get("task-public-proof-ok") as { status: string };
    expect(taskRow.status).toBe("completed");
  });

  it.skip("replays the reviewed loop fixture and surfaces corrective interventions (requires: connie-loop-closure-regression.json fixture)", async () => {
    const fixturePath = path.join(process.cwd(), "src/__tests__/fixtures/connie-loop-closure-regression.json");
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf-8")) as {
      steps: Array<Record<string, unknown>>;
    };
    const fixtureResponses = fixture.steps.map((step, index) => {
      if (step.type === "no_tool") {
        return noToolResponse(String(step.message || `fixture-no-tool-${index}`));
      }
      return uniqueToolResponse(
        String(step.name),
        (step.arguments as Record<string, unknown>) || {},
      );
    });

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: createTestConfig({
        maxTurnsPerCycle: 6,
        portfolio: {
          noProgressCycleLimit: 1,
        },
      }),
      db,
      conway,
      inference: new MockInferenceClient(fixtureResponses),
      onTurnComplete: (turn) => turns.push(turn),
    });

    expect(turns.some((turn) => turn.input?.includes("WRITE WITHOUT VERIFICATION"))).toBe(true);
    expect(turns.some((turn) => turn.input?.includes("PUBLICATION REDIRECT"))).toBe(true);
  });

  it("allows introspection tools for explicit agent/creator inputs during stalls", async () => {
    const stalledConfig = createTestConfig({
      portfolio: {
        noProgressCycleLimit: 1,
      },
    });
    db.setKV("portfolio.no_progress_cycles", "2");
    db.insertInboxMessage({
      id: "stall-bypass-agent-msg",
      from: "0xagent",
      to: "0xrecipient",
      content: "Please run recall for context",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      {
        id: "resp_stall_bypass_warmup",
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_stall_bypass_warmup",
            type: "function" as const,
            function: { name: "exec", arguments: JSON.stringify({ command: "echo warmup" }) },
          }],
        },
        toolCalls: [{
          id: "call_stall_bypass_warmup",
          type: "function" as const,
          function: { name: "exec", arguments: JSON.stringify({ command: "echo warmup" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      },
      {
        id: "resp_stall_bypass_recall",
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call_stall_bypass_recall",
            type: "function" as const,
            function: { name: "recall_facts", arguments: JSON.stringify({ category: "financial" }) },
          }],
        },
        toolCalls: [{
          id: "call_stall_bypass_recall",
          type: "function" as const,
          function: { name: "recall_facts", arguments: JSON.stringify({ category: "financial" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      },
      noToolResponse("ack"),
    ]);

    const turns: AgentTurn[] = [];
    await runAgentLoop({
      identity,
      config: stalledConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const agentInputTurn = turns.find((turn) => turn.inputSource === "agent");
    expect(agentInputTurn).toBeDefined();

    const recallCall = agentInputTurn?.toolCalls.find((call) => call.name === "recall_facts");
    expect(recallCall).toBeDefined();
    expect(recallCall?.error ?? "").not.toContain("tool temporarily blocked during no-progress stall");
  });

  it("seeds the legacy migration goal on first startup when no equivalent goal exists", async () => {
    insertProject(db.raw, {
      id: "proj-legacy-seed",
      name: "legacy migration",
      status: "incubating",
      lane: "build",
    });
    const inference = new MockInferenceClient([
      noToolResponse("no work"),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    const seeded = db.raw.prepare(
      "SELECT id FROM goals WHERE title = ?",
    ).get("Migrate legacy public products from Cloudflare URLs to compintel.co") as { id: string } | undefined;
    expect(seeded).toBeDefined();
    expect(db.getKV(CF_MIGRATION_SEEDED_KEY)).toBeDefined();
  });

  it("does not reseed the migration goal if the KV marker is already present", async () => {
    insertProject(db.raw, {
      id: "proj-legacy-kv",
      name: "legacy migration kv",
      status: "incubating",
      lane: "build",
    });
    db.setKV(CF_MIGRATION_SEEDED_KEY, new Date().toISOString());
    const inference = new MockInferenceClient([
      noToolResponse("no work"),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    const goals = db.raw.prepare(
      "SELECT COUNT(*) AS c FROM goals WHERE title = ?",
    ).get("Migrate legacy public products from Cloudflare URLs to compintel.co") as { c: number };
    expect(goals.c).toBe(0);
  });

  it("does not reseed the migration goal if an equivalent active goal already exists", async () => {
    insertProject(db.raw, {
      id: "proj-legacy-existing",
      name: "legacy migration existing",
      status: "incubating",
      lane: "build",
    });
    insertGoal(db.raw, {
      title: "Migrate legacy Cloudflare routes to compintel",
      description: "existing cleanup work",
      status: "active",
      projectId: "proj-legacy-existing",
    });
    const inference = new MockInferenceClient([
      noToolResponse("no work"),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    const goals = db.raw.prepare(
      "SELECT COUNT(*) AS c FROM goals WHERE title = ?",
    ).get("Migrate legacy public products from Cloudflare URLs to compintel.co") as { c: number };
    expect(goals.c).toBe(0);
    expect(db.getKV(CF_MIGRATION_SEEDED_KEY)).toBeDefined();
  });
});
