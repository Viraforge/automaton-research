import type BetterSqlite3 from "better-sqlite3";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("records exec_timeout when a command exceeds timeout", async () => {
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() } as any,
      workerId: "w1",
    });

    const tools = (pool as any).buildWorkerTools("w1", "t1") as Array<{ name: string; execute: (args: any) => Promise<string> }>;
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    const output = await execTool!.execute({ command: "sleep 1", timeout_ms: 5 });
    expect(output).toContain("exec timeout:");

    const issueRow = db.prepare("SELECT value FROM kv WHERE key = 'orchestrator.worker_issue.last'").get() as
      | { value: string }
      | undefined;
    expect(issueRow?.value).toBeDefined();
    const issue = JSON.parse(issueRow!.value) as { type?: string };
    expect(issue.type).toBe("exec_timeout");
  });

  it("records exec_timeout when stderr contains timeout signature", async () => {
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() } as any,
      workerId: "w2",
    });

    const tools = (pool as any).buildWorkerTools("w2", "t2") as Array<{ name: string; execute: (args: any) => Promise<string> }>;
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    const output = await execTool!.execute({
      command: "node -e \"console.error('command timed out after 60000ms'); process.exit(1)\"",
      timeout_ms: 60_000,
    });
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
      timeoutMs: 50,
    });
    const task = makeTaskNode(goalId, taskId, 50);

    const inference = {
      chat: vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
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

describe("orchestration/local-worker local tool contract", () => {
  let db: BetterSqlite3.Database;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    db = createInMemoryDb();
    originalHome = process.env.HOME;
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-home-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    db.close();
    process.env.HOME = originalHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("runs exec in HOME cwd and never uses Conway transport", async () => {
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() } as any,
      workerId: "w-local-exec",
    });

    const tools = (pool as any).buildWorkerTools("w-local-exec", "t-local-exec") as Array<{
      name: string;
      execute: (args: any) => Promise<string>;
    }>;
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    const output = await execTool!.execute({ command: "pwd", timeout_ms: 5_000 });

    expect(output).toContain(homeDir);
  });

  it("expands tilde paths and creates parent directories for write/read", async () => {
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() } as any,
      workerId: "w-local-file",
    });

    const tools = (pool as any).buildWorkerTools("w-local-file", "t-local-file") as Array<{
      name: string;
      execute: (args: any) => Promise<string>;
    }>;
    const writeTool = tools.find((tool) => tool.name === "write_file");
    const readTool = tools.find((tool) => tool.name === "read_file");
    expect(writeTool).toBeDefined();
    expect(readTool).toBeDefined();

    const target = "~/nested/worker/output.txt";
    const writeOutput = await writeTool!.execute({ path: target, content: "hello-world" });
    const readOutput = await readTool!.execute({ path: target });
    const resolved = path.join(homeDir, "nested/worker/output.txt");
    const diskContent = await fs.readFile(resolved, "utf8");

    expect(writeOutput).toContain("Wrote");
    expect(readOutput).toBe("hello-world");
    expect(diskContent).toBe("hello-world");
  });

  it("does not trigger network calls for local worker tool execution", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const pool = new LocalWorkerPool({
      db,
      inference: { chat: vi.fn() } as any,
      workerId: "w-local-no-network",
    });

    const tools = (pool as any).buildWorkerTools("w-local-no-network", "t-local-no-network") as Array<{
      name: string;
      execute: (args: any) => Promise<string>;
    }>;
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();

    await execTool!.execute({ command: "echo local", timeout_ms: 5_000 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
