import type { Database as SqliteDatabase } from "better-sqlite3";
import type { AutomatonConfig, ProjectStatus } from "../types.js";
import { listActiveProjects, type ProjectRow, updateProjectStatus } from "../state/database.js";

const ACTIVE_PROJECT_STATUSES: ProjectStatus[] = [
  "incubating",
  "shipping",
  "distribution",
  "monetizing",
];

export interface PortfolioPolicy {
  maxActiveProjects: number;
  maxShippingProjects: number;
  maxDistributionProjects: number;
  noProgressCycleLimit: number;
  killOnBudgetExhaustion: boolean;
}

export function resolvePortfolioPolicy(config?: AutomatonConfig): PortfolioPolicy {
  return {
    maxActiveProjects: clampInt(config?.portfolio?.maxActiveProjects, 3, 1, 20),
    maxShippingProjects: clampInt(config?.portfolio?.maxShippingProjects, 1, 1, 10),
    maxDistributionProjects: clampInt(config?.portfolio?.maxDistributionProjects, 1, 1, 10),
    noProgressCycleLimit: clampInt(config?.portfolio?.noProgressCycleLimit, 6, 1, 50),
    killOnBudgetExhaustion: config?.portfolio?.killOnBudgetExhaustion ?? false,
  };
}

export function canCreateActiveProject(db: SqliteDatabase, config?: AutomatonConfig): boolean {
  const policy = resolvePortfolioPolicy(config);
  const activeCount = listActiveProjects(db).filter((p) =>
    ACTIVE_PROJECT_STATUSES.includes(p.status)).length;
  return activeCount < policy.maxActiveProjects;
}

export function findSingleEligibleProject(projects: ProjectRow[]): ProjectRow | null {
  const eligible = projects.filter((project) => ACTIVE_PROJECT_STATUSES.includes(project.status));
  return eligible.length === 1 ? eligible[0] : null;
}

export function isProjectBudgetExceeded(project: ProjectRow): boolean {
  const computeExceeded = project.budgetComputeCents > 0 && project.spentComputeCents >= project.budgetComputeCents;
  const tokenExceeded = project.budgetTokens > 0 && project.spentTokens >= project.budgetTokens;
  return computeExceeded || tokenExceeded;
}

export function enforceProjectBudgetStates(
  db: SqliteDatabase,
  config?: AutomatonConfig,
): Array<{ projectId: string; status: ProjectStatus }> {
  const policy = resolvePortfolioPolicy(config);
  const active = listActiveProjects(db).filter((project) => ACTIVE_PROJECT_STATUSES.includes(project.status));
  const changed: Array<{ projectId: string; status: ProjectStatus }> = [];
  for (const project of active) {
    if (!isProjectBudgetExceeded(project)) continue;
    const nextStatus: ProjectStatus = policy.killOnBudgetExhaustion ? "killed" : "paused";
    if (project.status === nextStatus) continue;
    updateProjectStatus(db, project.id, nextStatus);
    changed.push({ projectId: project.id, status: nextStatus });
  }
  return changed;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
