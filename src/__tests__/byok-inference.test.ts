/**
 * BYOK Inference Routing Tests
 *
 * Verifies that when inferenceBaseUrl is set, inference traffic routes
 * through the BYOK endpoint regardless of model name heuristics or
 * mixed API key environments.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { MIGRATION_V6 } from "../state/schema.js";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceRouter } from "../inference/router.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { createInferenceClient } from "../inference/client.js";
import { resolveInferenceBackend } from "../inference/client.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../inference/types.js";
import type { ModelStrategyConfig } from "../types.js";

let db: BetterSqlite3.Database;

function createTestDb(): BetterSqlite3.Database {
  const testDb = new Database(":memory:");
  testDb.pragma("journal_mode = WAL");
  testDb.pragma("foreign_keys = ON");
  testDb.exec(MIGRATION_V6);
  return testDb;
}

beforeEach(() => {
  db = createTestDb();
});

afterEach(() => {
  db.close();
});

// ─── resolveInferenceBackend: BYOK precedence ───────────────────

describe("resolveInferenceBackend — BYOK precedence", () => {
  it("returns 'byok' for provider 'other' even when OpenAI key is present", () => {
    const backend = resolveInferenceBackend("gpt-5.2", {
      openaiApiKey: "sk-real-key",
      getModelProvider: () => "other",
    });
    expect(backend).toBe("byok");
  });

  it("returns 'byok' for provider 'other' even when Anthropic key is present", () => {
    const backend = resolveInferenceBackend("claude-3.5-sonnet", {
      anthropicApiKey: "sk-ant-real-key",
      getModelProvider: () => "other",
    });
    expect(backend).toBe("byok");
  });

  it("skips heuristics when inferenceBaseUrl is set (gpt-* name with OpenAI key)", () => {
    const backend = resolveInferenceBackend("gpt-5.2", {
      openaiApiKey: "sk-real-key",
      inferenceBaseUrl: "https://custom.provider/v4",
      // No registry — tests heuristic bypass
    });
    expect(backend).toBe("byok");
  });

  it("skips heuristics when inferenceBaseUrl is set (claude-* name with Anthropic key)", () => {
    const backend = resolveInferenceBackend("claude-3.5-sonnet", {
      anthropicApiKey: "sk-ant-real-key",
      inferenceBaseUrl: "https://custom.provider/v4",
    });
    expect(backend).toBe("byok");
  });

  it("still routes to OpenAI when no inferenceBaseUrl and OpenAI key present", () => {
    const backend = resolveInferenceBackend("gpt-5.2", {
      openaiApiKey: "sk-real-key",
      // no inferenceBaseUrl
    });
    expect(backend).toBe("openai");
  });

  it("still routes to Anthropic when no inferenceBaseUrl and Anthropic key present", () => {
    const backend = resolveInferenceBackend("claude-3.5-sonnet", {
      anthropicApiKey: "sk-ant-real-key",
      // no inferenceBaseUrl
    });
    expect(backend).toBe("anthropic");
  });

  it("returns 'byok' for unknown model with no keys", () => {
    const backend = resolveInferenceBackend("glm-5", {});
    expect(backend).toBe("byok");
  });

  it("routes MiniMax model through byok when provider is 'other'", () => {
    const backend = resolveInferenceBackend("MiniMax-M2.5", {
      inferenceBaseUrl: "https://api.minimax.io/v1",
      getModelProvider: () => "other",
    });
    expect(backend).toBe("byok");
  });

  it("rewrites system messages for MiniMax BYOK payload compatibility", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_minimax_system_rewrite",
          model: "MiniMax-M2.5",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const client = createInferenceClient({
        apiKey: "test-key",
        inferenceApiKey: "test-byok-key",
        inferenceBaseUrl: "https://api.minimax.io/v1",
        defaultModel: "MiniMax-M2.5",
        maxTokens: 64,
      });

      await client.chat([
        { role: "system", content: "system instruction" },
        { role: "user", content: "hello" },
      ]);

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(String(requestInit?.body || "{}")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      expect(payload.messages).toEqual([
        { role: "user", content: "system instruction" },
        { role: "user", content: "hello" },
      ]);
      expect(payload.messages?.some((m) => m.role === "system")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("routes glm-5 through byok when inferenceBaseUrl set", () => {
    const backend = resolveInferenceBackend("glm-5", {
      inferenceBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    });
    expect(backend).toBe("byok");
  });

  it("ollama still wins when provider is 'ollama' even with inferenceBaseUrl", () => {
    const backend = resolveInferenceBackend("llama3", {
      ollamaBaseUrl: "http://localhost:11434",
      inferenceBaseUrl: "https://custom.provider/v4",
      getModelProvider: () => "ollama",
    });
    expect(backend).toBe("ollama");
  });

  it("throws a clear error when BYOK backend is selected without inferenceBaseUrl", async () => {
    const client = createInferenceClient({
      apiKey: "test-key",
      inferenceApiKey: "test-byok-key",
      defaultModel: "glm-5",
      maxTokens: 256,
      getModelProvider: () => "other",
    });

    await expect(
      client.chat([{ role: "user", content: "hello" }]),
    ).rejects.toThrow("BYOK inference requires inferenceBaseUrl to be set");
  });

  it("drops out-of-order tool messages before BYOK request", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_1",
          model: "glm-5",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const client = createInferenceClient({
        apiKey: "test-key",
        inferenceApiKey: "test-byok-key",
        inferenceBaseUrl: "https://api.minimax.io/v1",
        defaultModel: "glm-5",
        maxTokens: 64,
      });

      await client.chat([
        { role: "tool", content: "{\"ok\":true}", tool_call_id: "future_call" },
        { role: "assistant", content: "", tool_calls: [{ id: "future_call", type: "function", function: { name: "x", arguments: "{}" } }] },
        { role: "user", content: "hello" },
      ]);

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(String(requestInit?.body || "{}")) as { messages?: Array<{ role?: string }> };
      expect(payload.messages?.some((m) => m.role === "tool")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rewrites duplicate tool_call ids and keeps only active matching tool results", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_2",
          model: "glm-5",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const client = createInferenceClient({
        apiKey: "test-key",
        inferenceApiKey: "test-byok-key",
        inferenceBaseUrl: "https://api.minimax.io/v1",
        defaultModel: "glm-5",
        maxTokens: 64,
      });

      await client.chat([
        {
          role: "assistant",
          content: "first tools",
          tool_calls: [{ id: "dup", type: "function", function: { name: "a", arguments: "{}" } }],
        },
        { role: "tool", content: "{\"ok\":true}", tool_call_id: "dup" },
        {
          role: "assistant",
          content: "second tools",
          tool_calls: [{ id: "dup", type: "function", function: { name: "b", arguments: "{}" } }],
        },
        // stale/out-of-order tool result for old call id should be dropped
        { role: "tool", content: "{\"old\":true}", tool_call_id: "dup" },
        { role: "user", content: "hello" },
      ]);

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(String(requestInit?.body || "{}")) as {
        messages?: Array<{ role?: string; tool_call_id?: string; tool_calls?: Array<{ id?: string }> }>;
      };
      const assistantToolCallIds = (payload.messages || [])
        .filter((m) => m.role === "assistant" && Array.isArray(m.tool_calls))
        .flatMap((m) => (m.tool_calls || []).map((tc) => String(tc.id || "")));
      const toolMessageIds = (payload.messages || [])
        .filter((m) => m.role === "tool")
        .map((m) => String(m.tool_call_id || ""));

      expect(new Set(assistantToolCallIds).size).toBe(assistantToolCallIds.length);
      expect(toolMessageIds.every((id) => assistantToolCallIds.includes(id))).toBe(true);
      expect(toolMessageIds).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("drops assistant tool-call turns when matching tool results are incomplete", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_incomplete_tools",
          model: "glm-5",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const client = createInferenceClient({
        apiKey: "test-key",
        inferenceApiKey: "test-byok-key",
        inferenceBaseUrl: "https://api.minimax.io/v1",
        defaultModel: "glm-5",
        maxTokens: 64,
      });

      await client.chat([
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "call_b", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", content: "{\"ok\":true}", tool_call_id: "call_a" },
        { role: "user", content: "continue" },
      ]);

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(String(requestInit?.body || "{}")) as {
        messages?: Array<{ role?: string; tool_calls?: unknown[] }>;
      };
      expect((payload.messages || []).some((m) => m.role === "assistant" && Array.isArray(m.tool_calls))).toBe(false);
      expect((payload.messages || []).some((m) => m.role === "tool")).toBe(false);
      expect((payload.messages || []).some((m) => m.role === "user")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("coalesces and rewrites consecutive system messages for MiniMax BYOK request", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_system",
          model: "glm-5",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const client = createInferenceClient({
        apiKey: "test-key",
        inferenceApiKey: "test-byok-key",
        inferenceBaseUrl: "https://api.minimax.io/v1",
        defaultModel: "glm-5",
        maxTokens: 64,
      });

      await client.chat([
        { role: "system", content: "policy A" },
        { role: "system", content: "policy B" },
        { role: "user", content: "hello" },
      ]);

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(String(requestInit?.body || "{}")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      const userMessages = (payload.messages || []).filter((m) => m.role === "user");
      expect(userMessages[0]?.content).toContain("policy A");
      expect(userMessages[0]?.content).toContain("policy B");
      expect((payload.messages || []).some((m) => m.role === "system")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("injects fallback user message when sanitization removes all messages", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "resp_fallback",
          model: "glm-5",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const client = createInferenceClient({
        apiKey: "test-key",
        inferenceApiKey: "test-byok-key",
        inferenceBaseUrl: "https://api.minimax.io/v1",
        defaultModel: "glm-5",
        maxTokens: 64,
      });

      await client.chat([
        { role: "tool", content: "{\"orphan\":true}", tool_call_id: "missing_tool_call" },
      ]);

      const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      const payload = JSON.parse(String(requestInit?.body || "{}")) as {
        messages?: Array<{ role?: string; content?: string }>;
      };
      expect(payload.messages).toEqual([{ role: "user", content: "Continue." }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces provider 1214 invalid messages diagnostics", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "1214",
            message: "The messages parameter is illegal.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ));
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const client = createInferenceClient({
        apiKey: "test-key",
        inferenceApiKey: "test-byok-key",
        inferenceBaseUrl: "https://api.minimax.io/v1",
        defaultModel: "glm-5",
        maxTokens: 64,
      });

      await expect(
        client.chat([{ role: "user", content: "hello" }]),
      ).rejects.toThrow("1214");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── BYOK model registration in ModelRegistry ──────────────────

describe("BYOK model registration", () => {
  it("upsert converts existing baseline model to provider 'other'", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    // gpt-5.2 exists as provider "openai" from static baseline
    const before = registry.get("gpt-5.2");
    expect(before).toBeDefined();
    expect(before!.provider).toBe("openai");

    // Simulate BYOK registration: force provider to "other"
    const now = new Date().toISOString();
    registry.upsert({
      ...before!,
      provider: "other",
      enabled: true,
      updatedAt: now,
    });

    const after = registry.get("gpt-5.2");
    expect(after!.provider).toBe("other");
    expect(after!.enabled).toBe(true);
  });

  it("BYOK model survives initialize() cleanup when provider is 'other'", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    // Register a custom BYOK model as "other"
    const now = new Date().toISOString();
    registry.upsert({
      modelId: "custom-llm",
      provider: "other",
      displayName: "Custom LLM",
      tierMinimum: "critical",
      costPer1kInput: 0,
      costPer1kOutput: 0,
      maxTokens: 4096,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: null,
      createdAt: now,
      updatedAt: now,
    });

    // Re-initialize (simulates agent loop restart)
    registry.initialize();

    const entry = registry.get("custom-llm");
    expect(entry).toBeDefined();
    expect(entry!.enabled).toBe(true);
    expect(entry!.provider).toBe("other");
  });

  it("BYOK model with provider 'other' remains enabled by initialize() cleanup", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    const now = new Date().toISOString();
    registry.upsert({
      modelId: "defunct-llm",
      provider: "other",
      displayName: "Defunct LLM",
      tierMinimum: "critical",
      costPer1kInput: 0,
      costPer1kOutput: 0,
      maxTokens: 4096,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: null,
      createdAt: now,
      updatedAt: now,
    });

    // Re-initialize — cleanup disables non-baseline, non-ollama, non-other models
    registry.initialize();

    const entry = registry.get("defunct-llm");
    expect(entry).toBeDefined();
    expect(entry!.enabled).toBe(true); // "other" is a protected provider
  });
});

// ─── InferenceRouter: BYOK model selection ──────────────────────

describe("InferenceRouter — BYOK model selection", () => {
  it("selects BYOK model when baseline models are disabled", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    // Disable all baseline models (simulates BYOK with no OpenAI key)
    for (const entry of registry.getAll()) {
      registry.setEnabled(entry.modelId, false);
    }

    // Register BYOK model
    const now = new Date().toISOString();
    registry.upsert({
      modelId: "glm-5",
      provider: "other",
      displayName: "GLM-5",
      tierMinimum: "critical",
      costPer1kInput: 0,
      costPer1kOutput: 0,
      maxTokens: 4096,
      contextWindow: 128000,
      supportsTools: true,
      supportsVision: false,
      parameterStyle: "max_tokens",
      enabled: true,
      lastSeen: null,
      createdAt: now,
      updatedAt: now,
    });

    const strategyConfig: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      inferenceModel: "glm-5",
      lowComputeModel: "glm-5",
    };
    const budget = new InferenceBudgetTracker(db, strategyConfig);
    const router = new InferenceRouter(db, registry, budget);

    const selected = router.selectModel("high", "agent_turn");
    expect(selected).toBeDefined();
    expect(selected!.modelId).toBe("glm-5");
  });

  it("does NOT select baseline model when it conflicts with BYOK model name", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    // Scenario: user sets inferenceModel: "glm-5" but with inferenceBaseUrl
    // The BYOK registration should convert glm-5 to provider "other"
    const glm5 = registry.get("glm-5")!;
    registry.upsert({
      ...glm5,
      provider: "other",
      enabled: true,
      updatedAt: new Date().toISOString(),
    });

    const strategyConfig: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      inferenceModel: "glm-5",
    };
    const budget = new InferenceBudgetTracker(db, strategyConfig);
    const router = new InferenceRouter(db, registry, budget);

    const selected = router.selectModel("high", "agent_turn");
    expect(selected).toBeDefined();
    expect(selected!.modelId).toBe("glm-5");
    expect(selected!.provider).toBe("other");
  });
});
