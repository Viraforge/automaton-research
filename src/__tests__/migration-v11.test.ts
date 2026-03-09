import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createDatabase } from "../state/database.js";
import { CREATE_TABLES, MIGRATION_V10, MIGRATION_V9 } from "../state/schema.js";

describe("schema migration v11 snapshot mapping", () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const file of tempFiles) {
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(`${file}-wal`, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(`${file}-shm`, { force: true }); } catch { /* ignore */ }
    }
  });

  it("maps legacy active goals to legacy-import project and backfills task project_id", () => {
    const dbPath = path.join(os.tmpdir(), `automaton-v10-${Date.now()}.db`);
    tempFiles.push(dbPath);

    const legacy = new Database(dbPath);
    legacy.exec(CREATE_TABLES);
    legacy.exec(MIGRATION_V9);
    legacy.exec(MIGRATION_V10);
    legacy.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (10, datetime('now'))",
    ).run();

    const now = new Date().toISOString();
    legacy.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("g_ghost", "Ghost Goal", "No tasks", now);
    legacy.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ).run("g_valid", "Valid Goal", "Has tasks", now);
    legacy.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, dependencies, created_at)
       VALUES ('t_valid', 'g_valid', 'Task', 'Do work', 'pending', '[]', ?)`,
    ).run(now);
    legacy.close();

    const migrated = createDatabase(dbPath);
    const goals = migrated.raw.prepare(
      "SELECT id, project_id FROM goals WHERE status = 'active' ORDER BY id ASC",
    ).all() as Array<{ id: string; project_id: string | null }>;
    expect(goals.map((g) => g.project_id)).toEqual(["legacy-import", "legacy-import"]);

    const taskProject = migrated.raw.prepare(
      "SELECT project_id FROM task_graph WHERE id = 't_valid'",
    ).get() as { project_id: string | null } | undefined;
    expect(taskProject?.project_id).toBe("legacy-import");

    const legacyProject = migrated.raw.prepare(
      "SELECT id, status FROM projects WHERE id = 'legacy-import'",
    ).get() as { id: string; status: string } | undefined;
    expect(legacyProject?.status).toBe("blocked");
    migrated.close();
  });

  it("migrates representative v10 snapshot fixture without orphan active goals", () => {
    const dbPath = path.join(os.tmpdir(), `automaton-v10-snapshot-${Date.now()}.db`);
    tempFiles.push(dbPath);

    const fixturePath = path.join(process.cwd(), "src/__tests__/fixtures/migration/v10_snapshot.sql");
    const fixtureSql = fs.readFileSync(fixturePath, "utf-8");

    const legacy = new Database(dbPath);
    legacy.exec(CREATE_TABLES);
    legacy.exec(MIGRATION_V9);
    legacy.exec(MIGRATION_V10);
    legacy.prepare(
      "INSERT INTO schema_version (version, applied_at) VALUES (10, datetime('now'))",
    ).run();
    legacy.exec(fixtureSql);
    legacy.close();

    const migrated = createDatabase(dbPath);

    const orphanActive = migrated.raw.prepare(
      "SELECT COUNT(*) AS c FROM goals WHERE status = 'active' AND project_id IS NULL",
    ).get() as { c: number };
    expect(orphanActive.c).toBe(0);

    const activeGoals = migrated.raw.prepare(
      "SELECT id, project_id FROM goals WHERE status = 'active' ORDER BY id ASC",
    ).all() as Array<{ id: string; project_id: string | null }>;
    expect(activeGoals.map((g) => g.id)).toEqual(["g_active_ghost", "g_active_valid"]);
    expect(activeGoals.map((g) => g.project_id)).toEqual(["legacy-import", "legacy-import"]);

    const pausedGoal = migrated.raw.prepare(
      "SELECT id, status, project_id FROM goals WHERE id = 'g_paused'",
    ).get() as { id: string; status: string; project_id: string | null } | undefined;
    expect(pausedGoal?.status).toBe("paused");
    expect(pausedGoal?.project_id ?? null).toBe(null);

    const taskBackfill = migrated.raw.prepare(
      "SELECT COUNT(*) AS c FROM task_graph WHERE goal_id = 'g_active_valid' AND project_id = 'legacy-import'",
    ).get() as { c: number };
    expect(taskBackfill.c).toBe(2);

    const legacyProject = migrated.raw.prepare(
      "SELECT id, status FROM projects WHERE id = 'legacy-import'",
    ).get() as { id: string; status: string } | undefined;
    expect(legacyProject?.status).toBe("blocked");

    migrated.close();
  });
});
