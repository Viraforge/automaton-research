import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ulid } from "ulid";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { AutomatonConfig, OperatorDistributionTarget } from "../types.js";
import {
  getProjectById,
  insertDistributionTarget,
  insertProject,
  listDistributionTargetsByProject,
} from "../state/database.js";

function defaultTargetsPath(): string {
  return path.join(os.homedir(), ".automaton", "distribution-targets.json");
}

function parseTarget(input: unknown): OperatorDistributionTarget | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const projectId = typeof obj.project_id === "string" ? obj.project_id.trim() : "";
  const channelId = typeof obj.channel_id === "string" ? obj.channel_id.trim() : "";
  const targetKey = typeof obj.target_key === "string" ? obj.target_key.trim() : "";
  if (!projectId || !channelId || !targetKey) return null;
  return {
    projectId,
    channelId,
    targetKey,
    targetLabel: typeof obj.target_label === "string" ? obj.target_label : undefined,
    priority: typeof obj.priority === "number" ? obj.priority : undefined,
    tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : undefined,
  };
}

function ensureProjectExists(db: SqliteDatabase, projectId: string): void {
  if (getProjectById(db, projectId)) return;
  insertProject(db, {
    id: projectId,
    name: projectId,
    description: "Auto-created from operator distribution target import.",
    status: "incubating",
    lane: "distribution",
    offer: "",
    targetCustomer: "",
    monetizationHypothesis: "Execute operator-provided distribution targets.",
    nextMonetizationStep: "Publish or contact first operator-provided target.",
    successMetric: "1 contacted/published target",
    killCriteria: "No response after 3 attempts",
  });
}

export function loadOperatorTargets(
  db: SqliteDatabase,
  config?: AutomatonConfig,
): { loaded: number; inserted: number; skipped: number; path: string; warning?: string } {
  const filePath = config?.distribution?.operatorTargetsPath || defaultTargetsPath();
  if (!fs.existsSync(filePath)) {
    return { loaded: 0, inserted: 0, skipped: 0, path: filePath, warning: "operator target file not found" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { loaded: 0, inserted: 0, skipped: 0, path: filePath, warning: `invalid JSON: ${detail}` };
  }

  if (!Array.isArray(parsed)) {
    return { loaded: 0, inserted: 0, skipped: 0, path: filePath, warning: "expected top-level array" };
  }

  let loaded = 0;
  let inserted = 0;
  let skipped = 0;
  for (const item of parsed) {
    const target = parseTarget(item);
    if (!target) {
      skipped += 1;
      continue;
    }
    loaded += 1;
    ensureProjectExists(db, target.projectId);
    const existing = listDistributionTargetsByProject(db, target.projectId).find(
      (row) => row.channelId === target.channelId && row.targetKey === target.targetKey,
    );
    if (existing) {
      skipped += 1;
      continue;
    }
    insertDistributionTarget(db, {
      id: ulid(),
      projectId: target.projectId,
      channelId: target.channelId,
      targetKey: target.targetKey,
      targetLabel: target.targetLabel ?? target.targetKey,
      priority: Math.max(0, Math.floor(target.priority ?? 100)),
      status: "pending",
      operatorProvided: true,
    });
    inserted += 1;
  }

  return { loaded, inserted, skipped, path: filePath };
}
