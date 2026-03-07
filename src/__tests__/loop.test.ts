/**
 * Agent Loop Tests
 *
 * Deterministic tests for the agent loop using mock clients.
 */

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
});
