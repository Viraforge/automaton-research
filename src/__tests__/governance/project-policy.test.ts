import { describe, expect, it } from "vitest";
import { createTestDb } from "../mocks.js";
import { insertProject, updateProjectSpend, getProjectById } from "../../state/database.js";
import { enforceProjectBudgetStates, isProjectBudgetExceeded, resolvePortfolioPolicy } from "../../portfolio/policy.js";

describe("project budget policy", () => {
  it("detects budget exceeded from compute spend", () => {
    const db = createTestDb();
    insertProject(db.raw, {
      id: "p-budget",
      name: "Budgeted Project",
      offer: "Offer",
      targetCustomer: "Customer",
      monetizationHypothesis: "Paid",
      budgetComputeCents: 100,
    });
    updateProjectSpend(db.raw, "p-budget", { computeCents: 100 });
    const project = getProjectById(db.raw, "p-budget");
    expect(project).toBeDefined();
    expect(isProjectBudgetExceeded(project!)).toBe(true);
    db.close();
  });

  it("pauses by default when budget is exceeded", () => {
    const db = createTestDb();
    insertProject(db.raw, {
      id: "p-budget2",
      name: "Budgeted Project 2",
      offer: "Offer",
      targetCustomer: "Customer",
      monetizationHypothesis: "Paid",
      budgetComputeCents: 50,
      status: "shipping",
    });
    updateProjectSpend(db.raw, "p-budget2", { computeCents: 51 });
    const changed = enforceProjectBudgetStates(db.raw, { portfolio: { killOnBudgetExhaustion: false } } as any);
    expect(changed).toEqual([{ projectId: "p-budget2", status: "paused" }]);
    expect(getProjectById(db.raw, "p-budget2")?.status).toBe("paused");
    db.close();
  });

  it("kills when killOnBudgetExhaustion is enabled", () => {
    const db = createTestDb();
    insertProject(db.raw, {
      id: "p-budget3",
      name: "Budgeted Project 3",
      offer: "Offer",
      targetCustomer: "Customer",
      monetizationHypothesis: "Paid",
      budgetComputeCents: 20,
      status: "shipping",
    });
    updateProjectSpend(db.raw, "p-budget3", { computeCents: 21 });
    const changed = enforceProjectBudgetStates(db.raw, { portfolio: { killOnBudgetExhaustion: true } } as any);
    expect(changed).toEqual([{ projectId: "p-budget3", status: "killed" }]);
    expect(getProjectById(db.raw, "p-budget3")?.status).toBe("killed");
    db.close();
  });

  it("resolves policy defaults", () => {
    const policy = resolvePortfolioPolicy(undefined);
    expect(policy.maxActiveProjects).toBeGreaterThan(0);
    expect(policy.noProgressCycleLimit).toBeGreaterThan(0);
  });
});
