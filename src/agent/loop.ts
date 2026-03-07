/**
 * The Agent Loop
 *
 * The core ReAct loop: Think -> Act -> Observe -> Persist.
 * This is the automaton's consciousness. When this runs, it is alive.
 */

import path from "node:path";
import type {
  AutomatonIdentity,
  AutomatonConfig,
  AutomatonDatabase,
  ConwayClient,
  InferenceClient,
  AgentState,
  AgentTurn,
  ToolCallResult,
  FinancialState,
  ToolContext,
  AutomatonTool,
  Skill,
  SocialClientInterface,
  SpendTrackerInterface,
  InputSource,
  ModelStrategyConfig,
} from "../types.js";
import { DEFAULT_MODEL_STRATEGY_CONFIG } from "../types.js";
import type { PolicyEngine } from "./policy-engine.js";
import { buildSystemPrompt, buildWakeupPrompt } from "./system-prompt.js";
import { buildContextMessages, trimContext } from "./context.js";
import {
  createBuiltinTools,
  loadInstalledTools,
  toolsToInferenceFormat,
  executeTool,
} from "./tools.js";
import { sanitizeInput } from "./injection-defense.js";
import { getSurvivalTier, getSurvivalTierFromUsdc, getFinancialStateFromUsdc } from "../financial/survival.js";
import { getUsdcBalance } from "../wallet/x402.js";
import {
  claimInboxMessages,
  markInboxProcessed,
  markInboxFailed,
  resetInboxToReceived,
  consumeNextWakeEvent,
} from "../state/database.js";
import type { InboxMessageRow } from "../state/database.js";
import { ulid } from "ulid";
import { ModelRegistry } from "../inference/registry.js";
import { InferenceBudgetTracker } from "../inference/budget.js";
import { InferenceRouter } from "../inference/router.js";
import { MemoryRetriever } from "../memory/retrieval.js";
import { MemoryIngestionPipeline } from "../memory/ingestion.js";
import { DEFAULT_MEMORY_BUDGET } from "../types.js";
import { formatMemoryBlock } from "./context.js";
import { createLogger } from "../observability/logger.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { PlanModeController } from "../orchestration/plan-mode.js";
import { generateTodoMd, injectTodoContext } from "../orchestration/attention.js";
import { ColonyMessaging, LocalDBTransport } from "../orchestration/messaging.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import { SimpleAgentTracker, SimpleFundingProtocol } from "../orchestration/simple-tracker.js";
import { ContextManager, createTokenCounter } from "../memory/context-manager.js";
import { CompressionEngine } from "../memory/compression-engine.js";
import { EventStream } from "../memory/event-stream.js";
import { KnowledgeStore } from "../memory/knowledge-store.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import { redactSensitiveText } from "../observability/redaction.js";
import { evaluateProgress } from "../governance/progress.js";
import {
  DISTRIBUTION_CHANNEL_IDS,
  ensureCoreDistributionChannels,
  getChannelUseDecision,
  recordChannelOutcome,
} from "../distribution/channels.js";
import { loadOperatorTargets } from "../distribution/targets.js";
import { enforceProjectBudgetStates, resolvePortfolioPolicy } from "../portfolio/policy.js";
import {
  evaluateDiscoveryFollowThrough,
  type DiscoveryFollowThroughState,
} from "../governance/discovery-followthrough.js";

const logger = createLogger("loop");
const MAX_TOOL_CALLS_PER_TURN = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const MAX_REPETITIVE_TURNS = 3;
const MAX_IDLE_ONLY_TURNS = 5;
const INFERENCE_RUNTIME_KEYS_KEY = "inference.runtime_keys";
const DISCOVER_AGENTS_COOLDOWN_KEY = "discover_agents.cooldown_until";
const MAX_DISCOVER_IDLE_TURNS = 2;
const DISCOVER_AGENTS_COOLDOWN_MS = 10 * 60_000;
const INFERENCE_429_BACKOFF_MS_KEY = "inference.429_backoff_ms";
const INFERENCE_429_MIN_BACKOFF_MS = 5 * 60_000;
const INFERENCE_429_MAX_BACKOFF_MS = 60 * 60_000;
const INFERENCE_429_RESET_CAP_MS = 14 * 24 * 60 * 60_000;
const PROJECT_NO_PROGRESS_CYCLES_KEY = "portfolio.no_progress_cycles";
const DISCOVERY_FOLLOW_THROUGH_KEY = "distribution.discovery_follow_through";
const EXEC_NO_PROGRESS_BACKOFF_KEY = "loop.exec_no_progress_backoff_ms";
const EXEC_NO_PROGRESS_MIN_BACKOFF_MS = 3 * 60_000;
const EXEC_NO_PROGRESS_MAX_BACKOFF_MS = 30 * 60_000;
const STALL_BLOCKED_TOOLS = new Set([
  "review_memory",
  "recall_facts",
  "system_synopsis",
  "list_skills",
  "check_credits",
  "check_usdc_balance",
  "check_balance",
  "list_children",
  "list_instances",
  "orchestrator_status",
  "discover_agents",
]);
const STALL_BYPASS_INPUT_SOURCES = new Set<InputSource>(["creator", "agent"]);

function detectInferenceProviderFromBaseUrl(baseUrl?: string): "zai" | "minimax" | "unknown" {
  if (!baseUrl) return "unknown";
  const normalized = baseUrl.toLowerCase();
  if (normalized.includes("z.ai") || normalized.includes("bigmodel.cn")) return "zai";
  if (normalized.includes("minimax")) return "minimax";
  return "unknown";
}

export interface AgentLoopOptions {
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  db: AutomatonDatabase;
  conway: ConwayClient;
  inference: InferenceClient;
  social?: SocialClientInterface;
  skills?: Skill[];
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  onStateChange?: (state: AgentState) => void;
  onTurnComplete?: (turn: AgentTurn) => void;
  ollamaBaseUrl?: string;
}

/**
 * Run the agent loop. This is the main execution path.
 * Returns when the agent decides to sleep or when compute runs out.
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<void> {
  const { identity, config, db, conway, inference, social, skills, policyEngine, spendTracker, onStateChange, onTurnComplete, ollamaBaseUrl } =
    options;

  const builtinTools = createBuiltinTools(identity.sandboxId);
  const installedTools = loadInstalledTools(db);
  const tools = [...builtinTools, ...installedTools];
  const toolContext: ToolContext = {
    identity,
    config,
    db,
    conway,
    inference,
    social,
  };

  // Initialize inference router (Phase 2.3)
  const modelStrategyConfig: ModelStrategyConfig = {
    ...DEFAULT_MODEL_STRATEGY_CONFIG,
    ...(config.modelStrategy ?? {}),
    // Override with top-level config so the router fallback uses the correct models
    inferenceModel: config.inferenceModel || DEFAULT_MODEL_STRATEGY_CONFIG.inferenceModel,
    lowComputeModel: config.modelStrategy?.lowComputeModel || config.inferenceModel || DEFAULT_MODEL_STRATEGY_CONFIG.lowComputeModel,
  };
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();

  // BYOK mode: register configured model and disable unreachable providers
  if (config.inferenceBaseUrl) {
    const now = new Date().toISOString();
    const byokModels = new Set([
      config.inferenceModel,
      config.modelStrategy?.lowComputeModel,
    ].filter(Boolean) as string[]);

    for (const modelId of byokModels) {
      const existing = modelRegistry.get(modelId);
      modelRegistry.upsert({
        modelId,
        provider: "other",
        displayName: existing?.displayName || modelId,
        tierMinimum: existing?.tierMinimum || "critical",
        costPer1kInput: existing?.costPer1kInput ?? 0,
        costPer1kOutput: existing?.costPer1kOutput ?? 0,
        maxTokens: existing?.maxTokens || config.maxTokensPerTurn || 4096,
        contextWindow: existing?.contextWindow || 128000,
        supportsTools: existing?.supportsTools ?? true,
        supportsVision: existing?.supportsVision ?? false,
        parameterStyle: existing?.parameterStyle || "max_tokens",
        enabled: true,
        lastSeen: null,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      });
    }

    for (const entry of modelRegistry.getAll()) {
      if (byokModels.has(entry.modelId)) continue;
      if (entry.provider === "openai" && !config.openaiApiKey) {
        modelRegistry.setEnabled(entry.modelId, false);
      }
      if (entry.provider === "anthropic" && !config.anthropicApiKey) {
        modelRegistry.setEnabled(entry.modelId, false);
      }
    }
  }

  // Discover Ollama models if configured
  if (ollamaBaseUrl) {
    const { discoverOllamaModels } = await import("../ollama/discover.js");
    await discoverOllamaModels(ollamaBaseUrl, db.raw);
  }
  const budgetTracker = new InferenceBudgetTracker(db.raw, modelStrategyConfig);
  const inferenceRouter = new InferenceRouter(db.raw, modelRegistry, budgetTracker);

  // Optional orchestration bootstrap (requires V9 goals/task tables)
  let planModeController: PlanModeController | undefined;
  let orchestrator: Orchestrator | undefined;
  let contextManager: ContextManager | undefined;
  let compressionEngine: CompressionEngine | undefined;

  if (hasTable(db.raw, "goals")) {
    try {
      planModeController = new PlanModeController(db.raw);

      // Bridge automaton config API keys to env vars for the provider registry.
      // The registry reads keys from process.env; the automaton config may have
      // them from config.json.
      if (config.openaiApiKey && !process.env.OPENAI_API_KEY) {
        process.env.OPENAI_API_KEY = config.openaiApiKey;
      }
      if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
        process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
      }
      // Bridge inference API key to the provider implied by inferenceBaseUrl.
      // This avoids false "missing key" diagnostics when BYOK is configured.
      const inferredProvider = detectInferenceProviderFromBaseUrl(config.inferenceBaseUrl);
      if (config.inferenceApiKey) {
        if (inferredProvider === "zai" && !process.env.ZAI_API_KEY) {
          process.env.ZAI_API_KEY = config.inferenceApiKey;
        }
        if (inferredProvider === "minimax" && !process.env.MINIMAX_API_KEY) {
          process.env.MINIMAX_API_KEY = config.inferenceApiKey;
        }
        // Backward compatibility: if we cannot infer provider, keep previous
        // behavior so older MiniMax-only setups keep working.
        if (inferredProvider === "unknown" && !process.env.MINIMAX_API_KEY) {
          process.env.MINIMAX_API_KEY = config.inferenceApiKey;
        }
      }
      db.setKV(INFERENCE_RUNTIME_KEYS_KEY, JSON.stringify({
        inferredProvider,
        hasZaiRuntimeKey: Boolean(process.env.ZAI_API_KEY),
        hasMiniMaxRuntimeKey: Boolean(process.env.MINIMAX_API_KEY),
        hasConfigInferenceApiKey: Boolean(config.inferenceApiKey),
        baseUrl: config.inferenceBaseUrl || "",
        observedAt: new Date().toISOString(),
      }));

      const providersPath = path.join(
        process.env.HOME || process.cwd(),
        ".automaton",
        "inference-providers.json",
      );
      const registry = ProviderRegistry.fromConfig(providersPath);

      const unifiedInference = new UnifiedInferenceClient(registry);
      const agentTracker = new SimpleAgentTracker(db, {
        workerLivenessTtlMs: config.orchestration?.workerLivenessTtlMs,
      });
      const funding = new SimpleFundingProtocol(conway, identity, db, config.useSovereignProviders);
      const messaging = new ColonyMessaging(
        new LocalDBTransport(db),
        db,
      );

      contextManager = new ContextManager(createTokenCounter());
      compressionEngine = new CompressionEngine(
        contextManager,
        new EventStream(db.raw),
        new KnowledgeStore(db.raw),
        unifiedInference,
      );

      // Adapter: wrap the main agent's working inference client so local
      // workers can use it. This path honors configured inference routing
      // (BYOK/OpenAI/Anthropic/Ollama), unlike UnifiedInferenceClient which
      // resolves providers only from registry/env configuration.
      const workerInference = {
        chat: async (params: { messages: any[]; tools?: any[]; maxTokens?: number; temperature?: number }) => {
          const response = await inference.chat(
            params.messages,
            {
              tools: params.tools,
              maxTokens: params.maxTokens,
              temperature: params.temperature,
            },
          );
          return {
            content: response.message?.content ?? "",
            toolCalls: response.toolCalls,
          };
        },
      };

      // Local worker pool: runs inference-driven agents in-process
      // as async tasks. Falls back from Conway sandbox spawning.
      const workerPool = new LocalWorkerPool({
        db: db.raw,
        inference: workerInference,
        conway,
        workerId: `pool-${identity.name}`,
      });

      orchestrator = new Orchestrator({
        db: db.raw,
        agentTracker,
        funding,
        messaging,
        inference: unifiedInference,
        identity,
        isWorkerAlive: (address: string) => {
          if (address.startsWith("local://")) {
            return workerPool.hasWorker(address);
          }
          // Remote workers: check children table
          const child = db.raw.prepare(
            "SELECT status FROM children WHERE sandbox_id = ? OR address = ?",
          ).get(address, address) as { status: string } | undefined;
          if (!child) return false;
          return !["failed", "dead", "cleaned_up"].includes(child.status);
        },
        config: {
          ...config,
          spawnAgent: async (task: any) => {
            // Try Conway sandbox spawn first (production)
            try {
              const { generateGenesisConfig } = await import("../replication/genesis.js");
              const { spawnChild } = await import("../replication/spawn.js");
              const { ChildLifecycle } = await import("../replication/lifecycle.js");

              const role = task.agentRole ?? "generalist";
              const genesis = generateGenesisConfig(identity, config, {
                name: `worker-${role}-${Date.now().toString(36)}`,
                specialization: `${role}: ${task.title}`,
              });

              const lifecycle = new ChildLifecycle(db.raw);
              const child = await spawnChild(conway, identity, db, genesis, lifecycle);

              return {
                address: child.address,
                name: child.name,
                sandboxId: child.sandboxId,
              };
            } catch (sandboxError: any) {
              // Conway sandbox unavailable — fall back to local worker
              logger.info("Conway sandbox unavailable, spawning local worker", {
                taskId: task.id,
                error: sandboxError instanceof Error ? sandboxError.message : String(sandboxError),
              });

              try {
                const spawned = workerPool.spawn(task);
                return spawned;
              } catch (localError) {
                logger.warn("Failed to spawn local worker", {
                  taskId: task.id,
                  error: localError instanceof Error ? localError.message : String(localError),
                });
                return null;
              }
            }
          },
        },
      });
    } catch (error) {
      logger.warn(
        `Orchestrator initialization failed, continuing without orchestration: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      planModeController = undefined;
      orchestrator = undefined;
      contextManager = undefined;
      compressionEngine = undefined;
    }
  }

  // Set start time
  if (!db.getKV("start_time")) {
    db.setKV("start_time", new Date().toISOString());
  }
  ensureCoreDistributionChannels(db.raw, config);
  const loadedTargets = loadOperatorTargets(db.raw, config);
  if (loadedTargets.warning) {
    log(config, `[DISTRIBUTION] operator targets: ${loadedTargets.warning} (${loadedTargets.path})`);
  } else if (loadedTargets.inserted > 0) {
    log(config, `[DISTRIBUTION] loaded operator targets: inserted=${loadedTargets.inserted} from ${loadedTargets.path}`);
  }

  let consecutiveErrors = 0;
  let running = true;

  // Restore loop detection state across sleep cycles.
  // Without persistence, the agent can do write_file → exec → sleep (2 turns)
  // and detection never accumulates enough data within a single cycle.
  let lastToolPatterns: string[] = [];
  let loopWarningPattern: string | null = null;
  let discoverIdleTurns = 0;
  let idleToolTurns = 0;
  try {
    const persisted = db.getKV("loop_detection_state");
    if (persisted) {
      const parsed = JSON.parse(persisted);
      if (Array.isArray(parsed.patterns)) lastToolPatterns = parsed.patterns;
      if (typeof parsed.warningPattern === "string") loopWarningPattern = parsed.warningPattern;
      if (typeof parsed.discoverIdleTurns === "number" && Number.isFinite(parsed.discoverIdleTurns)) {
        discoverIdleTurns = Math.max(0, Math.floor(parsed.discoverIdleTurns));
      }
      if (typeof parsed.idleToolTurns === "number" && Number.isFinite(parsed.idleToolTurns)) {
        idleToolTurns = Math.max(0, Math.floor(parsed.idleToolTurns));
      }
    }
  } catch { /* ignore corrupt state */ }

  // Circuit breaker: track per-tool consecutive failure counts.
  // Orthogonal to loop detection (which tracks behavior patterns, not errors).
  let failedToolCounts: Map<string, number> = new Map();
  try {
    const savedFailures = db.getKV("failed_tool_counts");
    if (savedFailures) failedToolCounts = new Map(JSON.parse(savedFailures));
  } catch {
    // Ignore corrupt persisted state
  }

  let noProgressCycles = Number.parseInt(db.getKV(PROJECT_NO_PROGRESS_CYCLES_KEY) || "0", 10);
  if (!Number.isFinite(noProgressCycles) || noProgressCycles < 0) {
    noProgressCycles = 0;
  }
  let followThroughState: DiscoveryFollowThroughState | null = null;
  try {
    const raw = db.getKV(DISCOVERY_FOLLOW_THROUGH_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DiscoveryFollowThroughState;
      if (parsed && Array.isArray(parsed.pendingVenues) && typeof parsed.misses === "number") {
        followThroughState = parsed;
      }
    }
  } catch {
    followThroughState = null;
  }
  // blockedGoalTurns removed — replaced by immediate sleep + exponential backoff

  // Drain any stale wake events from before this loop started,
  // so they don't re-wake the agent after its first sleep.
  let drained = 0;
  while (consumeNextWakeEvent(db.raw)) drained++;

  // Respect an active sleep window across process restarts.
  // Clearing this unconditionally causes restart-driven inference churn.
  const startupSleepUntil = db.getKV("sleep_until");
  if (startupSleepUntil) {
    const startupSleepMs = Date.parse(startupSleepUntil);
    if (Number.isFinite(startupSleepMs) && startupSleepMs > Date.now()) {
      db.setAgentState("sleeping");
      onStateChange?.("sleeping");
      log(config, `[SLEEP] Startup respects existing sleep_until=${startupSleepUntil}`);
      return;
    }
    // Past timestamp: safe to clear stale value.
    db.deleteKV("sleep_until");
  }

  // Transition to waking state
  db.setAgentState("waking");
  onStateChange?.("waking");

  // Get financial state
  let financial = await getFinancialState(conway, identity.address, db, config.useSovereignProviders);

  // Check if this is the first run
  const isFirstRun = db.getTurnCount() === 0;

  // Build wakeup prompt
  const wakeupInput = buildWakeupPrompt({
    identity,
    config,
    financial,
    db,
  });

  // Transition to running
  db.setAgentState("running");
  onStateChange?.("running");

  log(config, `[WAKE UP] ${config.name} is alive. Credits: $${(financial.creditsCents / 100).toFixed(2)}`);

  // ─── The Loop ──────────────────────────────────────────────

  const MAX_IDLE_TURNS = 10; // Force sleep after N turns with no real work
  let idleTurnCount = 0;

  const maxCycleTurns = config.maxTurnsPerCycle ?? 25;
  let cycleTurnCount = 0;

  let pendingInput: { content: string; source: string } | undefined = {
    content: wakeupInput,
    source: "wakeup",
  };

  while (running) {
    // Declared outside try so the catch block can access for retry/failure handling
    let claimedMessages: InboxMessageRow[] = [];

    try {
      const budgetTransitions = enforceProjectBudgetStates(db.raw, config);
      if (budgetTransitions.length > 0) {
        log(
          config,
          `[PORTFOLIO] Budget enforcement changed projects: ${budgetTransitions.map((b) => `${b.projectId}:${b.status}`).join(", ")}`,
        );
      }

      // Check if we should be sleeping
      const sleepUntil = db.getKV("sleep_until");
      if (sleepUntil && new Date(sleepUntil) > new Date()) {
        log(config, `[SLEEP] Sleeping until ${sleepUntil}`);
        // IMPORTANT: mark agent as sleeping so the outer runtime pauses instead of immediately re-running.
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // Check for unprocessed inbox messages using the state machine:
      // received → in_progress (claim) → processed (on success) or received/failed (on failure)
      if (!pendingInput) {
        claimedMessages = claimInboxMessages(db.raw, 10);
        if (claimedMessages.length > 0) {
          const formatted = claimedMessages
            .map((m) => {
              const from = sanitizeInput(m.fromAddress, m.fromAddress, "social_address");
              const content = sanitizeInput(m.content, m.fromAddress, "social_message");
              if (content.blocked) {
                return `[INJECTION BLOCKED from ${from.content}]: message was blocked by safety filter`;
              }
              return `[Message from ${from.content}]: ${content.content}`;
            })
            .join("\n\n");
          pendingInput = { content: formatted, source: "agent" };
        }
      }

      // Refresh financial state periodically
      financial = await getFinancialState(conway, identity.address, db, config.useSovereignProviders);

      // Check survival tier
      // api_unreachable: creditsCents === -1 means API failed with no cache.
      // Do NOT kill the agent; continue in low-compute mode and retry next tick.
      if (financial.creditsCents === -1) {
        log(config, "[API_UNREACHABLE] Balance API unreachable, continuing in low-compute mode.");
        inference.setLowComputeMode(true);
      } else {
        const effectiveTier = config.useSovereignProviders
          ? getSurvivalTierFromUsdc(financial.usdcBalance)
          : getSurvivalTier(financial.creditsCents);

        if (effectiveTier === "critical") {
          log(config, "[CRITICAL] Credits critically low. Limited operation.");
          db.setAgentState("critical");
          onStateChange?.("critical");
          inference.setLowComputeMode(true);
        } else if (effectiveTier === "low_compute") {
          db.setAgentState("low_compute");
          onStateChange?.("low_compute");
          inference.setLowComputeMode(true);
        } else {
          if (db.getAgentState() !== "running") {
            db.setAgentState("running");
            onStateChange?.("running");
          }
          inference.setLowComputeMode(false);
        }
      }

      // Build context — filter out purely idle turns (only status checks)
      // to prevent the model from continuing a status-check pattern
      const IDLE_ONLY_TOOLS = new Set([
        "check_credits", "check_usdc_balance", "check_balance", "system_synopsis", "review_memory",
        "list_children", "check_child_status", "list_sandboxes", "list_models",
        "list_skills", "git_status", "git_log", "check_reputation",
        "recall_facts", "recall_procedure", "heartbeat_ping",
        "check_inference_spending", "discover_agents",
        "orchestrator_status", "list_goals", "get_plan",
      ]);
      const allTurns = db.getRecentTurns(20);
      const meaningfulTurns = allTurns.filter((t) => {
        if (t.toolCalls.length === 0) return true; // text-only turns are meaningful
        return t.toolCalls.some((tc) => !IDLE_ONLY_TOOLS.has(tc.name));
      });
      // Keep at least the last 2 turns for continuity, even if idle
      const recentTurns = trimContext(
        meaningfulTurns.length > 0 ? meaningfulTurns : allTurns.slice(-2),
      );
      const systemPrompt = buildSystemPrompt({
        identity,
        config,
        financial,
        state: db.getAgentState(),
        db,
        tools,
        skills,
        isFirstRun,
      });

      // Phase 2.2: Pre-turn memory retrieval
      let memoryBlock: string | undefined;
      try {
        const sessionId = db.getKV("session_id") || "default";
        const retriever = new MemoryRetriever(db.raw, DEFAULT_MEMORY_BUDGET);
        const memories = retriever.retrieve(sessionId, pendingInput?.content);
        if (memories.totalTokens > 0) {
          memoryBlock = formatMemoryBlock(memories);
        }
      } catch (error) {
        logger.error("Memory retrieval failed", error instanceof Error ? error : undefined);
        // Memory failure must not block the agent loop
      }

      let messages = buildContextMessages(
        systemPrompt,
        recentTurns,
        pendingInput,
      );

      // Inject memory block after system prompt, before conversation history
      if (memoryBlock) {
        messages.splice(1, 0, { role: "system", content: memoryBlock });
      }

      let orchestratorPhase: string | undefined;
      let hasOrchestratorProgress = false;
      if (orchestrator) {
        const orchestratorTick = await orchestrator.tick();
        orchestratorPhase = orchestratorTick.phase;
        db.setKV("orchestrator.last_tick", JSON.stringify(orchestratorTick));
        hasOrchestratorProgress =
          orchestratorTick.tasksAssigned > 0 ||
          orchestratorTick.tasksCompleted > 0 ||
          orchestratorTick.tasksFailed > 0;
        if (hasOrchestratorProgress) {
          db.setKV("orchestrator.last_progress_at", new Date().toISOString());
        }
        if (
          hasOrchestratorProgress
        ) {
          log(
            config,
            `[ORCHESTRATOR] phase=${orchestratorTick.phase} assigned=${orchestratorTick.tasksAssigned} completed=${orchestratorTick.tasksCompleted} failed=${orchestratorTick.tasksFailed}`,
          );
        }
      }

      // Skip an inference turn when parent has no direct input and
      // orchestrator is just waiting on workers (no new assignments/completions).
      if (!pendingInput && orchestrator && orchestratorPhase === "executing" && !hasOrchestratorProgress) {
        const cooldownMs = 180_000;
        log(config, `[IDLE] No parent input and no orchestrator progress. Sleeping ${Math.round(cooldownMs / 1000)}s.`);
        db.setKV("sleep_until", new Date(Date.now() + cooldownMs).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      if (planModeController) {
        try {
          const todoMd = generateTodoMd(db.raw);
          messages = injectTodoContext(messages, todoMd);
        } catch (error) {
          logger.warn(
            `todo.md context injection skipped: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Capture input before clearing
      const currentInput = pendingInput;

      // Clear pending input after use
      pendingInput = undefined;

      // ── Inference Call (via router when available) ──
      const survivalTier = config.useSovereignProviders
        ? getSurvivalTierFromUsdc(financial.usdcBalance)
        : getSurvivalTier(financial.creditsCents);
      log(config, `[THINK] Routing inference (tier: ${survivalTier}, model: ${inference.getDefaultModel()})...`);

      const inferenceTools = toolsToInferenceFormat(tools);
      const routerResult = await inferenceRouter.route(
        {
          messages: messages,
          taskType: "agent_turn",
          tier: survivalTier,
          sessionId: db.getKV("session_id") || "default",
          turnId: ulid(),
          tools: inferenceTools,
        },
        (msgs, opts) => inference.chat(msgs, { ...opts, tools: inferenceTools }),
      );

      // Build a compatible response for the rest of the loop
      const response = {
        message: { content: routerResult.content, role: "assistant" as const },
        toolCalls: routerResult.toolCalls as any[] | undefined,
        usage: {
          promptTokens: routerResult.inputTokens,
          completionTokens: routerResult.outputTokens,
          totalTokens: routerResult.inputTokens + routerResult.outputTokens,
        },
        finishReason: routerResult.finishReason,
      };

      const turn: AgentTurn = {
        id: ulid(),
        timestamp: new Date().toISOString(),
        state: db.getAgentState(),
        input: currentInput?.content,
        inputSource: currentInput?.source as any,
        thinking: (response.message.content || "").replace(/<\/?think>/gi, "").trim(),
        toolCalls: [],
        tokenUsage: response.usage,
        costCents: routerResult.costCents,
      };

      // ── Execute Tool Calls ──
      if (response.toolCalls && response.toolCalls.length > 0) {
        const toolCallMessages: any[] = [];
        let callCount = 0;
        const currentInputSource = currentInput?.source as InputSource | undefined;
        const portfolioPolicy = resolvePortfolioPolicy(config);

        for (const tc of response.toolCalls) {
          if (callCount >= MAX_TOOL_CALLS_PER_TURN) {
            log(config, `[TOOLS] Max tool calls per turn reached (${MAX_TOOL_CALLS_PER_TURN})`);
            break;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(tc.function.arguments);
          } catch (error) {
            logger.error("Failed to parse tool arguments", error instanceof Error ? error : undefined);
            args = {};
          }

          log(config, `[TOOL] ${tc.function.name}(${JSON.stringify(args).slice(0, 100)})`);

          const bypassStallBlocking =
            !!currentInputSource && STALL_BYPASS_INPUT_SOURCES.has(currentInputSource);
          if (
            !bypassStallBlocking
            && noProgressCycles >= portfolioPolicy.noProgressCycleLimit
            && STALL_BLOCKED_TOOLS.has(tc.function.name)
          ) {
            const blockedResult: ToolCallResult = {
              id: tc.id,
              name: tc.function.name,
              arguments: args,
              result: "",
              durationMs: 0,
              error: `tool temporarily blocked during no-progress stall: ${tc.function.name}. Execute a concrete distribution/monetization/build action before more introspection.`,
            };
            turn.toolCalls.push(blockedResult);
            log(config, `[TOOL RESULT] ${tc.function.name}: ERROR: ${blockedResult.error}`);
            callCount++;
            continue;
          }

          if (tc.function.name === "discover_agents") {
            const cooldownRaw = db.getKV(DISCOVER_AGENTS_COOLDOWN_KEY);
            const cooldownMs = cooldownRaw ? Date.parse(cooldownRaw) : Number.NaN;
            if (Number.isFinite(cooldownMs) && cooldownMs > Date.now()) {
              const secondsLeft = Math.max(1, Math.ceil((cooldownMs - Date.now()) / 1000));
              const result: ToolCallResult = {
                id: tc.id,
                name: tc.function.name,
                arguments: args,
                result: "",
                durationMs: 0,
                error: `discover_agents temporarily blocked for ${secondsLeft}s due to repetitive discovery loop; execute an artifact-producing action first.`,
              };
              turn.toolCalls.push(result);
              log(config, `[TOOL RESULT] ${tc.function.name}: ERROR: ${result.error}`);
              callCount++;
              continue;
            }
          }

          const result = await executeTool(
            tc.function.name,
            args,
            tools,
            toolContext,
            policyEngine,
            spendTracker ? {
              inputSource: currentInputSource,
              turnToolCallCount: turn.toolCalls.filter(t => t.name === "transfer_credits" || t.name === "transfer_usdc").length,
              sessionSpend: spendTracker,
            } : undefined,
          );

          // Override the ID to match the inference call's ID
          result.id = tc.id;
          turn.toolCalls.push(result);

          log(
            config,
            `[TOOL RESULT] ${tc.function.name}: ${result.error ? `ERROR: ${result.error}` : result.result.slice(0, 200)}`,
          );

          // Circuit breaker: track per-tool failure counts. The built-in exec
          // tool reports runtime failures as a canonical result string
          // ("exec error: ...") rather than throwing. Policy-denied exec
          // commands are expected safety stops and should not trip breaker state.
          const isExecStringFailure =
            tc.function.name === "exec"
            && /^exec error:/i.test((result.result || "").trim());
          const isExecPolicyDenied =
            tc.function.name === "exec"
            && /(^|\b)Policy denied:\s*FORBIDDEN_COMMAND\b/i.test(
              (result.error || result.result || "").trim(),
            );
          if ((result.error || isExecStringFailure) && !isExecPolicyDenied) {
            const count = (failedToolCounts.get(tc.function.name) ?? 0) + 1;
            failedToolCounts.set(tc.function.name, count);
            if (count >= 3) {
              log(config, `[CIRCUIT BREAKER] ${tc.function.name} failed ${count}× consecutively`);
              pendingInput = {
                content: `TOOL FAILURE ESCALATION: "${tc.function.name}" has failed ${count} consecutive times. Stop using this tool. Post the error to Discord and try a different approach.`,
                source: "system" as const,
              };
              failedToolCounts.delete(tc.function.name);
            }
          } else {
            failedToolCounts.delete(tc.function.name);
          }

          callCount++;
        }
      }

      // ── Persist Turn (atomic: turn + tool calls + inbox ack) ──
      const claimedIds = claimedMessages.map((m) => m.id);
      db.runTransaction(() => {
        db.insertTurn(turn);
        for (const tc of turn.toolCalls) {
          db.insertToolCall(turn.id, tc);
        }
        // Mark claimed inbox messages as processed (atomic with turn persistence)
        if (claimedIds.length > 0) {
          markInboxProcessed(db.raw, claimedIds);
        }
      });
      onTurnComplete?.(turn);

      // Phase 2.2: Post-turn memory ingestion (non-blocking)
      try {
        const sessionId = db.getKV("session_id") || "default";
        const ingestion = new MemoryIngestionPipeline(db.raw);
        ingestion.ingest(sessionId, turn, turn.toolCalls);
      } catch (error) {
        logger.error("Memory ingestion failed", error instanceof Error ? error : undefined);
        // Memory failure must not block the agent loop
      }

      // ── create_goal BLOCKED fast-break ──
      // When a goal is already active, the parent loop has nothing useful to do.
      // Force sleep immediately with exponential backoff so the agent doesn't
      // wake every 2 minutes just to get BLOCKED again.
      const blockedGoalCall = turn.toolCalls.find(
        (tc) => tc.name === "create_goal" && /\bblocked\b/i.test(tc.result || ""),
      );
      if (blockedGoalCall) {
        // Exponential backoff: 2min → 4min → 8min → cap at 10min
        const prevBackoff = parseInt(db.getKV("blocked_goal_backoff") || "0", 10);
        const backoffMs = Math.min(
          prevBackoff > 0 ? prevBackoff * 2 : 120_000,
          600_000,
        );
        db.setKV("blocked_goal_backoff", String(backoffMs));
        log(config, `[LOOP] create_goal BLOCKED — sleeping ${Math.round(backoffMs / 1000)}s (backoff).`);
        db.setKV("sleep_until", new Date(Date.now() + backoffMs).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      } else if (turn.toolCalls.some((tc) => tc.name === "create_goal" && !tc.error)) {
        // Goal was successfully created — reset backoff
        db.deleteKV("blocked_goal_backoff");
      }

      // ── Loop Detection ──
      if (turn.toolCalls.length > 0) {
        const currentPattern = turn.toolCalls
          .map((tc) => tc.name)
          .sort()
          .join(",");
        lastToolPatterns.push(currentPattern);

        // Keep only the last MAX_REPETITIVE_TURNS entries
        if (lastToolPatterns.length > MAX_REPETITIVE_TURNS) {
          lastToolPatterns = lastToolPatterns.slice(-MAX_REPETITIVE_TURNS);
        }

        // Reset enforcement tracker if agent changed behavior
        if (loopWarningPattern && currentPattern !== loopWarningPattern) {
          loopWarningPattern = null;
        }

        // Detect multi-tool maintenance loops: all tools in the turn are idle-only,
        // even if the specific combination varies across consecutive turns.
        const isAllIdleTools = turn.toolCalls.every((tc) => IDLE_ONLY_TOOLS.has(tc.name));
        if (!isAllIdleTools) {
          // ── Loop Enforcement Escalation ──
          // If we already warned about this pattern and the agent STILL repeats, force sleep.
          if (
            loopWarningPattern &&
            currentPattern === loopWarningPattern &&
            lastToolPatterns.length === MAX_REPETITIVE_TURNS &&
            lastToolPatterns.every((p) => p === currentPattern)
          ) {
            log(config, `[LOOP] Enforcement: agent ignored loop warning, forcing sleep.`);
            pendingInput = {
              content:
                `LOOP ENFORCEMENT: You were warned about repeating "${currentPattern}" but continued. ` +
                `Forcing sleep to prevent credit waste. On next wake, try a DIFFERENT approach.`,
              source: "system",
            };
            loopWarningPattern = null;
            lastToolPatterns = [];
            db.deleteKV("loop_detection_state");
            db.setAgentState("sleeping");
            onStateChange?.("sleeping");
            running = false;
            break;
          }

          // Check if the same pattern repeated MAX_REPETITIVE_TURNS times
          if (
            lastToolPatterns.length === MAX_REPETITIVE_TURNS &&
            lastToolPatterns.every((p) => p === currentPattern)
          ) {
            log(config, `[LOOP] Repetitive pattern detected: ${currentPattern}`);
            pendingInput = {
              content:
                `LOOP DETECTED: You have called "${currentPattern}" ${MAX_REPETITIVE_TURNS} times in a row with similar results. ` +
                `STOP repeating yourself. You already know your status. DO SOMETHING DIFFERENT NOW. ` +
                `Pick ONE concrete task from your genesis prompt and execute it.`,
              source: "system",
            };
            loopWarningPattern = currentPattern;
            lastToolPatterns = [];
          }
        }

        if (isAllIdleTools) {
          idleToolTurns++;
          const hasDiscoverAgentsCall = turn.toolCalls.some((tc) => tc.name === "discover_agents");
          discoverIdleTurns = hasDiscoverAgentsCall ? discoverIdleTurns + 1 : 0;
          if (discoverIdleTurns >= MAX_DISCOVER_IDLE_TURNS && !pendingInput) {
            const cooldownUntil = new Date(Date.now() + DISCOVER_AGENTS_COOLDOWN_MS).toISOString();
            db.setKV(DISCOVER_AGENTS_COOLDOWN_KEY, cooldownUntil);
            log(config, `[LOOP] discover_agents loop detected: ${discoverIdleTurns} idle discovery turns. Applying cooldown until ${cooldownUntil}.`);
            pendingInput = {
              content:
                `DISCOVERY LOOP DETECTED: You called discover_agents in ${discoverIdleTurns} idle turns. ` +
                `discover_agents is now blocked for ${Math.round(DISCOVER_AGENTS_COOLDOWN_MS / 60000)} minutes. ` +
                `Do not check status again. Build or ship one concrete artifact before any more discovery.`,
              source: "system",
            };
            discoverIdleTurns = 0;
          }
          if (idleToolTurns >= MAX_IDLE_ONLY_TURNS && !pendingInput) {
            log(config, `[LOOP] Maintenance loop detected: ${idleToolTurns} consecutive idle-only turns. Injecting no-idle directive.`);
            pendingInput = {
              content:
                `MAINTENANCE LOOP DETECTED: Your last ${idleToolTurns} turns only used status-check tools ` +
                `(${turn.toolCalls.map((tc) => tc.name).join(", ")}). ` +
                `You already know your status. Do NOT call status tools next turn. ` +
                `Immediately execute one concrete action that creates an artifact or external outcome.`,
              source: "system",
            };
            idleToolTurns = 0;
          }
        } else {
          idleToolTurns = 0;
          discoverIdleTurns = 0;
        }

        // Persist loop detection state AFTER all modifications so it survives
        // across sleep boundaries. Without this, a 2-turn cycle (write → sleep)
        // resets detection every wake, letting the agent loop indefinitely.
        db.setKV("loop_detection_state", JSON.stringify({
          patterns: lastToolPatterns,
          warningPattern: loopWarningPattern,
          discoverIdleTurns,
          idleToolTurns,
        }));
        db.setKV("failed_tool_counts", JSON.stringify([...failedToolCounts]));
      }

      // Log the turn
      if (turn.thinking) {
        log(config, `[THOUGHT] ${turn.thinking.slice(0, 300)}`);
      }

      const progress = evaluateProgress({
        toolCalls: turn.toolCalls,
        message: turn.thinking,
        metricRecorded: turn.toolCalls.some((tc) => tc.name === "record_project_metric" && !tc.error),
      });
      if (progress.progressed) {
        noProgressCycles = 0;
        db.deleteKV(EXEC_NO_PROGRESS_BACKOFF_KEY);
      } else {
        noProgressCycles += 1;
      }
      db.setKV(PROJECT_NO_PROGRESS_CYCLES_KEY, String(noProgressCycles));

      const recentPatternWindow = lastToolPatterns.slice(-MAX_REPETITIVE_TURNS);
      const execDominantNoProgressLoop = recentPatternWindow.length === MAX_REPETITIVE_TURNS
        && recentPatternWindow.every((pattern) => pattern.split(",").includes("exec"));
      const portfolioPolicy = resolvePortfolioPolicy(config);
      if (!progress.progressed && noProgressCycles >= portfolioPolicy.noProgressCycleLimit && execDominantNoProgressLoop) {
        const previousBackoff = Number.parseInt(db.getKV(EXEC_NO_PROGRESS_BACKOFF_KEY) || "0", 10);
        const backoffMs = Math.min(
          previousBackoff > 0 ? previousBackoff * 2 : EXEC_NO_PROGRESS_MIN_BACKOFF_MS,
          EXEC_NO_PROGRESS_MAX_BACKOFF_MS,
        );
        db.setKV(EXEC_NO_PROGRESS_BACKOFF_KEY, String(backoffMs));
        db.setKV("sleep_until", new Date(Date.now() + backoffMs).toISOString());
        log(
          config,
          `[LOOP] Exec-dominant no-progress loop detected (${noProgressCycles} cycles). Sleeping ${Math.round(backoffMs / 1000)}s.`,
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      const pendingTarget = db.raw.prepare(
        `SELECT t.id, t.channel_id AS channelId
         FROM distribution_targets t
         JOIN projects p ON p.id = t.project_id
         WHERE t.status = 'pending'
           AND p.status NOT IN ('paused', 'killed', 'archived')
         ORDER BY t.priority DESC, t.created_at ASC
         LIMIT 1`,
      ).get() as { id: string; channelId: string } | undefined;
      const hasReadyDistributionWork = !!pendingTarget
        && getChannelUseDecision(db.raw, pendingTarget.channelId, config).allowed;

      if (!progress.progressed && noProgressCycles >= portfolioPolicy.noProgressCycleLimit && hasReadyDistributionWork && !pendingInput) {
        pendingInput = {
          content:
            `NO-PROGRESS GOVERNOR: ${noProgressCycles} consecutive non-progress cycles while distribution work is ready. ` +
            `Execute one pending distribution target now, or explicitly mark it blocked with evidence.`,
          source: "system",
        };
      }

      const knownTargets = db.raw.prepare(
        `SELECT target_key AS targetKey, target_label AS targetLabel
         FROM distribution_targets
         WHERE operator_provided = 1`,
      ).all() as Array<{ targetKey: string; targetLabel: string | null }>;
      const knownVenueKeys = knownTargets.flatMap((target) =>
        [target.targetKey, target.targetLabel || ""].filter(Boolean));
      const followThroughDecision = evaluateDiscoveryFollowThrough(
        followThroughState,
        turn.toolCalls,
        knownVenueKeys,
        new Date().toISOString(),
      );
      followThroughState = followThroughDecision.nextState;
      if (followThroughState) {
        db.setKV(DISCOVERY_FOLLOW_THROUGH_KEY, JSON.stringify(followThroughState));
      } else {
        db.deleteKV(DISCOVERY_FOLLOW_THROUGH_KEY);
      }
      if (followThroughDecision.injectMessage && !pendingInput) {
        pendingInput = {
          content: followThroughDecision.injectMessage,
          source: "system",
        };
      }

      // ── Check for sleep command ──
      const sleepTool = turn.toolCalls.find((tc) => tc.name === "sleep");
      if (sleepTool && !sleepTool.error) {
        if (hasReadyDistributionWork) {
          pendingInput = {
            content:
              "SLEEP DENIED: pending distribution target is executable right now. Run a distribution action before sleeping.",
            source: "system",
          };
          continue;
        }
        log(config, "[SLEEP] Agent chose to sleep.");
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── Idle turn detection ──
      // If this turn had no pending input and didn't do any real work
      // (no mutations — only read/check/list/info tools), count as idle.
      // Use a blocklist of mutating tools rather than an allowlist of safe ones.
      const MUTATING_TOOLS = new Set([
        "exec", "write_file", "edit_own_file", "transfer_credits", "transfer_usdc", "topup_credits", "fund_child",
        "spawn_child", "start_child", "delete_sandbox", "create_sandbox", "create_instance", "destroy_instance",
        "install_npm_package", "install_mcp_server", "install_skill",
        "create_skill", "remove_skill", "install_skill_from_git",
        "install_skill_from_url", "pull_upstream", "git_commit", "git_push",
        "git_branch", "git_clone", "send_message", "message_child",
        "register_domain", "register_erc8004", "give_feedback",
        "update_genesis_prompt", "update_agent_card", "modify_heartbeat",
        "expose_port", "remove_port", "x402_fetch", "manage_dns",
        "distress_signal", "prune_dead_children", "sleep",
        "update_soul", "remember_fact", "set_goal", "complete_goal",
        "save_procedure", "note_about_agent", "forget",
        "enter_low_compute", "switch_model", "review_upstream_changes",
      ]);
      const didMutate = turn.toolCalls.some((tc) => MUTATING_TOOLS.has(tc.name));

      // Detect mixed-pattern mutating loops: a single mutating tool dominates
      // the rolling window even though per-turn patterns vary. Catches
      // "stuck creating the same file" scenarios the exact-pattern check misses.
      if (!pendingInput && lastToolPatterns.length >= MAX_REPETITIVE_TURNS) {
        const toolFrequency = new Map<string, number>();
        let discoverPatternCount = 0;
        for (const pattern of lastToolPatterns) {
          const toolsInPattern = pattern.split(",");
          if (toolsInPattern.includes("discover_agents")) discoverPatternCount++;
          for (const tool of toolsInPattern) {
            if (MUTATING_TOOLS.has(tool)) {
              toolFrequency.set(tool, (toolFrequency.get(tool) ?? 0) + 1);
            }
          }
        }
        if (discoverPatternCount >= MAX_REPETITIVE_TURNS) {
          const cooldownUntil = new Date(Date.now() + DISCOVER_AGENTS_COOLDOWN_MS).toISOString();
          db.setKV(DISCOVER_AGENTS_COOLDOWN_KEY, cooldownUntil);
          log(config, `[LOOP] discover_agents frequency loop: seen in ${discoverPatternCount}/${lastToolPatterns.length} recent turns. Cooldown until ${cooldownUntil}.`);
          pendingInput = {
            content:
              `DISCOVERY LOOP DETECTED: discover_agents was used in ${discoverPatternCount} consecutive turns. ` +
              `discover_agents is blocked for ${Math.round(DISCOVER_AGENTS_COOLDOWN_MS / 60000)} minutes. ` +
              `Stop checking and execute one concrete build/deploy task now.`,
            source: "system",
          };
          lastToolPatterns = [];
          db.setKV("loop_detection_state", JSON.stringify({
            patterns: lastToolPatterns,
            warningPattern: loopWarningPattern,
            discoverIdleTurns,
            idleToolTurns,
          }));
          db.setKV("failed_tool_counts", JSON.stringify([...failedToolCounts]));
          continue;
        }
        for (const [tool, count] of toolFrequency) {
          if (count >= MAX_REPETITIVE_TURNS) {
            log(config, `[LOOP] Mutating tool loop: "${tool}" used ${count} times in ${lastToolPatterns.length} turns`);
            pendingInput = {
              content:
                `REPETITIVE ACTION DETECTED: You have used "${tool}" ${count} times in your last ${lastToolPatterns.length} turns. ` +
                `You may be stuck in a loop. STOP and evaluate: are you making the same change repeatedly? ` +
                `If so, try a completely different approach or pick a different task from your genesis prompt.`,
              source: "system",
            };
            lastToolPatterns = [];
            db.setKV("loop_detection_state", JSON.stringify({
              patterns: lastToolPatterns,
              warningPattern: loopWarningPattern,
              discoverIdleTurns,
              idleToolTurns,
            }));
            db.setKV("failed_tool_counts", JSON.stringify([...failedToolCounts]));
            break;
          }
        }
      }

      if (!currentInput && !didMutate) {
        idleTurnCount++;
        if (idleTurnCount >= MAX_IDLE_TURNS) {
          log(config, `[IDLE] ${idleTurnCount} consecutive idle turns with no work. Entering sleep.`);
          db.setKV("sleep_until", new Date(Date.now() + 60_000).toISOString());
          db.setAgentState("sleeping");
          onStateChange?.("sleeping");
          running = false;
        }
      } else {
        idleTurnCount = 0;
      }

      // ── Cycle turn limit ──
      // Hard ceiling on turns per wake cycle, regardless of tool type.
      // Prevents runaway loops where mutating tools (exec, write_file)
      // defeat idle detection indefinitely.
      cycleTurnCount++;
      if (running && cycleTurnCount >= maxCycleTurns) {
        log(config, `[CYCLE LIMIT] ${cycleTurnCount} turns reached (max: ${maxCycleTurns}). Forcing sleep.`);
        db.setKV("sleep_until", new Date(Date.now() + 120_000).toISOString());
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
        break;
      }

      // ── If no tool calls and just text, the agent might be done thinking ──
      if (
        running &&
        (!response.toolCalls || response.toolCalls.length === 0) &&
        response.finishReason === "stop"
      ) {
        // Agent produced text without tool calls.
        // This is a natural pause point -- no work queued, sleep briefly.
        log(config, "[IDLE] No pending inputs. Entering brief sleep.");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 60_000).toISOString(),
        );
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        running = false;
      }

      consecutiveErrors = 0;
      db.deleteKV(INFERENCE_429_BACKOFF_MS_KEY);
      recordChannelOutcome(db.raw, DISTRIBUTION_CHANNEL_IDS.byokInference, "inference cycle healthy", config);
      // Mark error resolved (don't delete — heartbeat needs to see it)
      const prevError = db.getKV("last_error");
      if (prevError) {
        try {
          const parsed = JSON.parse(prevError);
          if (!parsed.resolvedAt) {
            parsed.resolvedAt = new Date().toISOString();
            db.setKV("last_error", JSON.stringify(parsed));
          }
        } catch { db.deleteKV("last_error"); }
      }
    } catch (err: any) {
      consecutiveErrors++;
      log(config, `[ERROR] Turn failed: ${err.message}`);

      // Persist error state for heartbeat/monitoring to report
      db.setKV("last_error", JSON.stringify({
        message: err.message?.slice(0, 500) || "Unknown error",
        consecutiveErrors,
        timestamp: new Date().toISOString(),
      }));

      // Handle inbox message state on turn failure:
      // Messages that have retries remaining go back to 'received';
      // messages that have exhausted retries move to 'failed'.
      if (claimedMessages.length > 0) {
        const exhausted = claimedMessages.filter((m) => m.retryCount >= m.maxRetries);
        const retryable = claimedMessages.filter((m) => m.retryCount < m.maxRetries);

        if (exhausted.length > 0) {
          markInboxFailed(db.raw, exhausted.map((m) => m.id));
          log(config, `[INBOX] ${exhausted.length} message(s) moved to failed (max retries exceeded)`);
        }
        if (retryable.length > 0) {
          resetInboxToReceived(db.raw, retryable.map((m) => m.id));
          log(config, `[INBOX] ${retryable.length} message(s) reset to received for retry`);
        }
      }

      const errorMessage = err?.message ?? String(err);
      if (isByokInvalidMessages1214(errorMessage)) {
        recordChannelOutcome(db.raw, DISTRIBUTION_CHANNEL_IDS.byokInference, errorMessage, config);
        log(config, "[RECOVERY] Detected BYOK 1214 invalid-messages response. Resetting turn history immediately.");
        clearTurnHistoryForRecovery(db, config);
        consecutiveErrors = 0;
        db.setKV("last_error", JSON.stringify({
          message: String(errorMessage).slice(0, 500),
          consecutiveErrors: 1,
          recovery: "reset_turn_history_1214",
          timestamp: new Date().toISOString(),
        }));
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV("sleep_until", new Date(Date.now() + 120_000).toISOString());
        running = false;
        continue;
      }

      if (isInferenceRateLimit429(errorMessage)) {
        recordChannelOutcome(db.raw, DISTRIBUTION_CHANNEL_IDS.byokInference, errorMessage, config);
        const sleepMs = computeInference429SleepMs(db, errorMessage);
        log(
          config,
          `[RECOVERY] Detected inference 429 rate limit. Backing off for ${Math.ceil(sleepMs / 60_000)} minute(s).`,
        );
        consecutiveErrors = 0;
        db.setKV("last_error", JSON.stringify({
          message: String(errorMessage).slice(0, 500),
          consecutiveErrors: 1,
          recovery: "inference_429_backoff",
          timestamp: new Date().toISOString(),
        }));
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV("sleep_until", new Date(Date.now() + sleepMs).toISOString());
        running = false;
        continue;
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        log(
          config,
          `[FATAL] ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Sleeping.`,
        );

        clearTurnHistoryForRecovery(db, config);

        // Update error state with forced sleep flag for heartbeat reporting
        db.setKV("last_error", JSON.stringify({
          message: err.message?.slice(0, 500) || "Unknown error",
          consecutiveErrors,
          forcedSleep: true,
          timestamp: new Date().toISOString(),
        }));
        db.setAgentState("sleeping");
        onStateChange?.("sleeping");
        db.setKV(
          "sleep_until",
          new Date(Date.now() + 300_000).toISOString(),
        );
        running = false;
      }
    }
  }

  log(config, `[LOOP END] Agent loop finished. State: ${db.getAgentState()}`);
}

function clearTurnHistoryForRecovery(db: AutomatonDatabase, config: AutomatonConfig): void {
  // Delete tool_calls first (FK: tool_calls.turn_id → turns.id).
  try {
    db.raw.prepare("DELETE FROM tool_calls").run();
    db.raw.prepare("DELETE FROM turns").run();
    log(config, "[RECOVERY] Cleared all turns for clean restart.");
  } catch (e) {
    log(config, `[ERROR] Failed to clear turns for recovery: ${e}`);
  }
}

function isByokInvalidMessages1214(message: string): boolean {
  return /\b1214\b/.test(message)
    && /invalid messages payload|messages parameter is illegal|invalid messages?/i.test(message);
}

function isInferenceRateLimit429(message: string): boolean {
  return /Inference error/i.test(message) && /\b429\b/.test(message);
}

function computeInference429SleepMs(db: AutomatonDatabase, message: string): number {
  const explicitReset = parseProviderResetTimestamp(message);
  if (explicitReset !== null) {
    const deltaMs = Math.max(INFERENCE_429_MIN_BACKOFF_MS, explicitReset - Date.now());
    const bounded = Math.min(INFERENCE_429_RESET_CAP_MS, deltaMs);
    db.deleteKV(INFERENCE_429_BACKOFF_MS_KEY);
    return bounded;
  }

  const previous = Number.parseInt(db.getKV(INFERENCE_429_BACKOFF_MS_KEY) || "", 10);
  const nextBackoffMs = Number.isFinite(previous) && previous > 0
    ? Math.min(previous * 2, INFERENCE_429_MAX_BACKOFF_MS)
    : INFERENCE_429_MIN_BACKOFF_MS;
  db.setKV(INFERENCE_429_BACKOFF_MS_KEY, String(nextBackoffMs));
  return nextBackoffMs;
}

function parseProviderResetTimestamp(message: string): number | null {
  const isoMatch = message.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const plainMatch = message.match(/\b(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\b/);
  if (!plainMatch) return null;

  const [, y, m, d, hh, mm, ss] = plainMatch;
  const utcMs = Date.UTC(
    Number(y),
    Number(m) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    Number(ss),
  );
  return Number.isFinite(utcMs) ? utcMs : null;
}

// ─── Helpers ───────────────────────────────────────────────────

// Cache last known good balances so transient API failures don't
// cause the automaton to believe it has $0 and kill itself.
let _lastKnownCredits = 0;
let _lastKnownUsdc = 0;

async function getFinancialState(
  conway: ConwayClient,
  address: string,
  db?: AutomatonDatabase,
  useSovereignProviders?: boolean,
): Promise<FinancialState> {
  let creditsCents = _lastKnownCredits;
  let usdcBalance = _lastKnownUsdc;

  if (useSovereignProviders) {
    // Sovereign mode: USDC is the sole financial metric.
    // Skip conway.getCreditsBalance() entirely.
    try {
      usdcBalance = await getUsdcBalance(address as `0x${string}`);
      if (usdcBalance > 0) _lastKnownUsdc = usdcBalance;
    } catch (error) {
      logger.error("USDC balance fetch failed", error instanceof Error ? error : undefined);
      if (db) {
        const cached = db.getKV("last_known_balance");
        if (cached) {
          try {
            const parsed = JSON.parse(cached);
            logger.warn("USDC API failed, using cached balance");
            return {
              creditsCents: parsed.creditsCents ?? 0,
              usdcBalance: parsed.usdcBalance ?? 0,
              lastChecked: new Date().toISOString(),
            };
          } catch (parseError) {
            logger.error("Failed to parse cached balance", parseError instanceof Error ? parseError : undefined);
          }
        }
      }
      return {
        creditsCents: -1,
        usdcBalance: -1,
        lastChecked: new Date().toISOString(),
      };
    }

    // Derive creditsCents from USDC for compatibility
    creditsCents = Math.round(usdcBalance * 100);

    if (db) {
      try {
        db.setKV("last_known_balance", JSON.stringify({ creditsCents, usdcBalance }));
      } catch (error) {
        logger.error("Failed to cache balance", error instanceof Error ? error : undefined);
      }
    }

    return { creditsCents, usdcBalance, lastChecked: new Date().toISOString() };
  }

  // Legacy mode: fetch Conway credits first, then USDC
  try {
    creditsCents = await conway.getCreditsBalance();
    if (creditsCents > 0) _lastKnownCredits = creditsCents;
  } catch (error) {
    logger.error("Credits balance fetch failed", error instanceof Error ? error : undefined);
    // Use last known balance from KV, not zero
    if (db) {
      const cached = db.getKV("last_known_balance");
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          logger.warn("Balance API failed, using cached balance");
          return {
            creditsCents: parsed.creditsCents ?? 0,
            usdcBalance: parsed.usdcBalance ?? 0,
            lastChecked: new Date().toISOString(),
          };
        } catch (parseError) {
          logger.error("Failed to parse cached balance", parseError instanceof Error ? parseError : undefined);
        }
      }
    }
    // No cache available -- return conservative non-zero sentinel
    logger.error("Balance API failed, no cache available");
    return {
      creditsCents: -1,
      usdcBalance: -1,
      lastChecked: new Date().toISOString(),
    };
  }

  try {
    usdcBalance = await getUsdcBalance(address as `0x${string}`);
    if (usdcBalance > 0) _lastKnownUsdc = usdcBalance;
  } catch (error) {
    logger.error("USDC balance fetch failed", error instanceof Error ? error : undefined);
  }

  // Cache successful balance reads
  if (db) {
    try {
      db.setKV(
        "last_known_balance",
        JSON.stringify({ creditsCents, usdcBalance }),
      );
    } catch (error) {
      logger.error("Failed to cache balance", error instanceof Error ? error : undefined);
    }
  }

  return {
    creditsCents,
    usdcBalance,
    lastChecked: new Date().toISOString(),
  };
}

function log(_config: AutomatonConfig, message: string): void {
  logger.info(redactSensitiveText(message));
}

function hasTable(db: AutomatonDatabase["raw"], tableName: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}
