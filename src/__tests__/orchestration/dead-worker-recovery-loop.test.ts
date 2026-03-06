import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulid";
import { Orchestrator } from "../../orchestration/orchestrator.js";
import type { AgentTracker, FundingProtocol } from "../../orchestration/types.js";
import type { MessageTransport } from "../../orchestration/messaging.js";
import { ColonyMessaging } from "../../orchestration/messaging.js";
import type { AutomatonDatabase } from "../../types.js";
import { createInMemoryDb } from "./test-db.js";

const IDENTITY = {
  name: "test",
  address: "0x1234" as any,
  account: {} as any,
  creatorAddress: "0x0000" as any,
  sandboxId: "sb-1",
  apiKey: "key",
  createdAt: "2026-01-01T00:00:00Z",
};

function makeAgentTracker(overrides: Partial<AgentTracker> = {}): AgentTracker {
  return {
    getIdle: vi.fn().mockReturnValue([]),
    getBestForTask: vi.fn().mockReturnValue(null),
    updateStatus: vi.fn(),
    register: vi.fn(),
    ...overrides,
  };
}

function makeFunding(overrides: Partial<FundingProtocol> = {}): FundingProtocol {
  return {
    fundChild: vi.fn().mockResolvedValue({ success: true }),
    recallCredits: vi.fn().mockResolvedValue({ success: true, amountCents: 0 }),
    getBalance: vi.fn().mockResolvedValue(1000),
    ...overrides,
  };
}

function makeMessaging(raw: BetterSqlite3.Database): ColonyMessaging {
  const transport: MessageTransport = {
    deliver: vi.fn().mockResolvedValue(undefined),
    getRecipients: vi.fn().mockReturnValue([]),
  };

  const automataDb = {
    raw,
    getIdentity: (key: string) => (key === "address" ? "0x1234" : undefined),
    getChildren: () => [],
    getUnprocessedInboxMessages: (_limit: number) => [],
    markInboxMessageProcessed: (_id: string) => {},
  } as unknown as AutomatonDatabase;

  return new ColonyMessaging(transport, automataDb);
}

function insertGoal(db: BetterSqlite3.Database): string {
  const id = ulid();
  db.prepare(
    "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(id, "Goal", "Desc", "active", new Date().toISOString());
  return id;
}

function insertTask(db: BetterSqlite3.Database, goalId: string, assignedTo: string): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO task_graph
     (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, goalId, "Task", "Desc", "assigned", assignedTo, "generalist", 50, "[]", new Date().toISOString());
  return id;
}

function setOrchestratorState(db: BetterSqlite3.Database, goalId: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))",
  ).run("orchestrator.state", JSON.stringify({
    phase: "executing",
    goalId,
    replanCount: 0,
    failedTaskId: null,
    failedError: null,
  }));
}

describe("orchestration/dead-worker-recovery-loop", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("breaks assign->stale->pending churn by quarantining stale worker", async () => {
    const deadWorker = "local://dead-worker";
    const goalId = insertGoal(db);
    const taskId = insertTask(db, goalId, deadWorker);
    setOrchestratorState(db, goalId);

    const agentTracker = makeAgentTracker({
      getIdle: vi.fn().mockReturnValue([
        { address: deadWorker, name: "dead", role: "generalist", status: "running" },
      ]),
    });

    const orchestrator = new Orchestrator({
      db,
      agentTracker,
      funding: makeFunding(),
      messaging: makeMessaging(db),
      inference: {
        chat: vi.fn().mockResolvedValue({ content: JSON.stringify({ estimatedSteps: 2 }) }),
      } as any,
      identity: IDENTITY,
      isWorkerAlive: (address: string) => address !== deadWorker,
      config: {},
    });

    await orchestrator.tick();

    const taskRow = db.prepare(
      "SELECT status, assigned_to FROM task_graph WHERE id = ?",
    ).get(taskId) as { status: string; assigned_to: string | null } | undefined;
    expect(taskRow?.status).toBe("assigned");
    expect(taskRow?.assigned_to).toBe(IDENTITY.address);

    const quarantineRow = db.prepare(
      "SELECT value FROM kv WHERE key = 'orchestrator.dead_workers'",
    ).get() as { value: string } | undefined;
    expect(quarantineRow?.value).toContain(deadWorker);
  });
});
