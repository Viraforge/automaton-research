/**
 * BYOK Inference Routing Tests
 *
 * Verifies that when inferenceBaseUrl is set, inference traffic routes
 * through the BYOK endpoint regardless of model name heuristics or
 * mixed API key environments.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    const backend = resolveInferenceBackend("MiniMax-M2.5-highspeed", {
      inferenceBaseUrl: "https://api.minimax.io/v1",
      getModelProvider: () => "other",
    });
    expect(backend).toBe("byok");
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

    // Re-initialize (simulates agent loop restart)
    registry.initialize();

    const entry = registry.get("glm-5");
    expect(entry).toBeDefined();
    expect(entry!.enabled).toBe(true);
    expect(entry!.provider).toBe("other");
  });

  it("BYOK model with provider 'defunct' gets disabled by initialize() cleanup", () => {
    const registry = new ModelRegistry(db);
    registry.initialize();

    const now = new Date().toISOString();
    registry.upsert({
      modelId: "glm-5",
      provider: "defunct",
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

    // Re-initialize — cleanup disables non-baseline, non-ollama, non-other models
    registry.initialize();

    const entry = registry.get("glm-5");
    expect(entry).toBeDefined();
    expect(entry!.enabled).toBe(false); // "defunct" is NOT protected
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

    // Scenario: user sets inferenceModel: "gpt-5.2" but with inferenceBaseUrl
    // The BYOK registration should convert gpt-5.2 to provider "other"
    const gpt52 = registry.get("gpt-5.2")!;
    registry.upsert({
      ...gpt52,
      provider: "other",
      enabled: true,
      updatedAt: new Date().toISOString(),
    });

    // Disable all OTHER baseline models
    for (const entry of registry.getAll()) {
      if (entry.modelId === "gpt-5.2") continue;
      if (entry.provider === "openai") registry.setEnabled(entry.modelId, false);
    }

    const strategyConfig: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      inferenceModel: "gpt-5.2",
    };
    const budget = new InferenceBudgetTracker(db, strategyConfig);
    const router = new InferenceRouter(db, registry, budget);

    const selected = router.selectModel("high", "agent_turn");
    expect(selected).toBeDefined();
    expect(selected!.modelId).toBe("gpt-5.2");
    expect(selected!.provider).toBe("other");
  });
});
