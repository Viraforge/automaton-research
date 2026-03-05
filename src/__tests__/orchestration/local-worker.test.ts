import type BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalWorkerPool } from "../../orchestration/local-worker.js";
import type { TaskNode } from "../../orchestration/task-graph.js";
import { insertGoal, insertTask } from "../../state/database.js";
import { createInMemoryDb } from "./test-db.js";

function makeTaskNode(goalId: string, taskId: string, timeoutMs: number): TaskNode {
  return {
    id: taskId,
    parentId: null,
    goalId,
    title: "worker task",
    description: "test task",
    status: "running",
    assignedTo: null,
    agentRole: "generalist",
    priority: 50,
    dependencies: [],
    result: null,
    metadata: {
      estimatedCostCents: 0,
      actualCostCents: 0,
      maxRetries: 1,
      retryCount: 0,
      timeoutMs,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
    },
  };
}

describe("orchestration/local-worker exec timeout classification", () => {
  let db: BetterSqlite3.Database;

  beforeEach(() => {
    db = createInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("records exec_timeout when conway.exec throws ETIMEDOUT", async () => {
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() } as any,
      conway: {
        exec: vi.fn().mockRejectedValue(new Error("spawnSync /bin/sh ETIMEDOUT")),
        writeFile: vi.fn(),
        readFile: vi.fn(),
      } as any,
      workerId: "w1",
    });

    const tools = (pool as any).buildWorkerTools("w1", "t1") as Array<{ name: string; execute: (args: any) => Promise<string> }>;
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    const output = await execTool!.execute({ command: "npm run dev", timeout_ms: 1_000 });
    expect(output).toContain("exec timeout:");

    const issueRow = db.prepare("SELECT value FROM kv WHERE key = 'orchestrator.worker_issue.last'").get() as
      | { value: string }
      | undefined;
    expect(issueRow?.value).toBeDefined();
    const issue = JSON.parse(issueRow!.value) as { type?: string };
    expect(issue.type).toBe("exec_timeout");
  });

  it("records exec_timeout when command result contains timeout signature", async () => {
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() } as any,
      conway: {
        exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "command timed out after 60000ms", exitCode: 1 }),
        writeFile: vi.fn(),
        readFile: vi.fn(),
      } as any,
      workerId: "w2",
    });

    const tools = (pool as any).buildWorkerTools("w2", "t2") as Array<{ name: string; execute: (args: any) => Promise<string> }>;
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    const output = await execTool!.execute({ command: "long command", timeout_ms: 60_000 });
    expect(output).toContain("exec timeout:");

    const issueRow = db.prepare("SELECT value FROM kv WHERE key = 'orchestrator.worker_issue.last'").get() as
      | { value: string }
      | undefined;
    expect(issueRow?.value).toBeDefined();
    const issue = JSON.parse(issueRow!.value) as { type?: string };
    expect(issue.type).toBe("exec_timeout");
  });

  it("records worker_timeout when task exceeds timeout budget", async () => {
    const goalId = insertGoal(db, {
      title: "Goal",
      description: "Desc",
      status: "active",
    });
    const taskId = insertTask(db, {
      goalId,
      title: "Task",
      description: "Desc",
      status: "running",
      timeoutMs: 1,
    });
    const task = makeTaskNode(goalId, taskId, 1);

    const inference = {
      chat: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          content: "",
          toolCalls: [{
            id: "tc-1",
            function: { name: "task_done", arguments: JSON.stringify({ summary: "done" }) },
          }],
        };
      }),
    };

    const pool = new LocalWorkerPool({
      db,
      inference: inference as any,
      conway: {
        exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
        writeFile: vi.fn(),
        readFile: vi.fn(),
      } as any,
      workerId: "w3",
      maxTurns: 3,
    });

    await (pool as any).runWorker("w3", task, new AbortController().signal);

    const issueRow = db.prepare("SELECT value FROM kv WHERE key = 'orchestrator.worker_issue.last'").get() as
      | { value: string }
      | undefined;
    expect(issueRow?.value).toBeDefined();
    const issue = JSON.parse(issueRow!.value) as { type?: string };
    expect(issue.type).toBe("worker_timeout");
  });

  it("does not classify successful fallback output as exec timeout", async () => {
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() } as any,
      conway: {
        exec: vi.fn().mockRejectedValue(new Error("Conway unavailable")),
        writeFile: vi.fn(),
        readFile: vi.fn(),
      } as any,
      workerId: "w4",
    });

    const tools = (pool as any).buildWorkerTools("w4", "t4") as Array<{ name: string; execute: (args: any) => Promise<string> }>;
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const output = await execTool!.execute({ command: "echo timeout completed", timeout_ms: 5_000 });
    expect(output).not.toContain("exec timeout:");

    const issueRow = db.prepare("SELECT value FROM kv WHERE key = 'orchestrator.worker_issue.last'").get() as
      | { value: string }
      | undefined;
    expect(issueRow).toBeUndefined();
  });
});
