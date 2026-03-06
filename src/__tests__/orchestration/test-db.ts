import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  CREATE_TABLES,
  MIGRATION_V9,
  MIGRATION_V9_ALTER_CHILDREN_ROLE,
  MIGRATION_V10,
  MIGRATION_V11,
  MIGRATION_V11_ALTER_GOALS_NEXT_STEP,
  MIGRATION_V11_ALTER_GOALS_PROJECT,
  MIGRATION_V11_ALTER_GOALS_STAGE_HINT,
  MIGRATION_V11_ALTER_TASKS_BLOCKED_REASON,
  MIGRATION_V11_ALTER_TASKS_CLASS,
  MIGRATION_V11_ALTER_TASKS_PROJECT,
  MIGRATION_V11_ALTER_TASKS_SIGNATURE,
} from "../../state/schema.js";

export type TestDatabase = BetterSqlite3.Database;

export function createInMemoryDb(): TestDatabase {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(CREATE_TABLES);
  db.exec(MIGRATION_V9);
  try { db.exec(MIGRATION_V9_ALTER_CHILDREN_ROLE); } catch { /* column may already exist */ }
  db.exec(MIGRATION_V10);
  db.exec(MIGRATION_V11);
  try { db.exec(MIGRATION_V11_ALTER_GOALS_PROJECT); } catch { /* exists */ }
  try { db.exec(MIGRATION_V11_ALTER_GOALS_STAGE_HINT); } catch { /* exists */ }
  try { db.exec(MIGRATION_V11_ALTER_GOALS_NEXT_STEP); } catch { /* exists */ }
  try { db.exec(MIGRATION_V11_ALTER_TASKS_PROJECT); } catch { /* exists */ }
  try { db.exec(MIGRATION_V11_ALTER_TASKS_CLASS); } catch { /* exists */ }
  try { db.exec(MIGRATION_V11_ALTER_TASKS_SIGNATURE); } catch { /* exists */ }
  try { db.exec(MIGRATION_V11_ALTER_TASKS_BLOCKED_REASON); } catch { /* exists */ }
  return db;
}
