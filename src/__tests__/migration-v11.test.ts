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
});
