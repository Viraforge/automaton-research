import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
} from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";

describe("distribution and portfolio tools", () => {
  let db: AutomatonDatabase;
  let ctx: ToolContext;

  beforeEach(() => {
    db = createTestDb();
    ctx = {
      identity: createTestIdentity(),
      config: createTestConfig(),
      db,
      conway: new MockConwayClient(),
      inference: new MockInferenceClient(),
    };
  });

  afterEach(() => {
    db.close();
  });

  it("blocks send_message when social channel is misconfigured", async () => {
    const tools = createBuiltinTools("sandbox");
    const result = await executeTool("send_message", {
      to_address: "0x123",
      content: "hello",
    }, tools, ctx);

    expect(result.error).toBeUndefined();
    expect(result.result).toMatch(/Blocked by distribution channel state|social relay not configured/i);
  });

  it("requires project_id when no eligible project can be inferred", async () => {
    const tools = createBuiltinTools("sandbox");
    const result = await executeTool("create_goal", {
      title: "Ship feature",
      description: "Do the thing",
    }, tools, ctx);

    expect(result.result).toContain("project_id is required");
  });

  it("creates project then goal in that project", async () => {
    const tools = createBuiltinTools("sandbox");
    const createProject = await executeTool("create_project", {
      id: "proj-test",
      name: "Test Project",
      offer: "Offer",
      target_customer: "Agent founders",
      monetization_hypothesis: "Paid listing",
    }, tools, ctx);
    expect(createProject.error).toBeUndefined();

    const createGoal = await executeTool("create_goal", {
      title: "Publish launch note",
      description: "Publish to first channel",
      project_id: "proj-test",
    }, tools, ctx);
    expect(createGoal.error).toBeUndefined();
    expect(createGoal.result).toContain("Goal created");
    expect(createGoal.result).toContain("project: proj-test");
  });

  it("blocks create_goal when project compute budget is exhausted", async () => {
    const tools = createBuiltinTools("sandbox");
    await executeTool("create_project", {
      id: "proj-budget",
      name: "Budget Project",
      offer: "Offer",
      target_customer: "Customer",
      monetization_hypothesis: "Paid",
      budget_compute_cents: 10,
    }, tools, ctx);
    db.raw.prepare("UPDATE projects SET spent_compute_cents = 10 WHERE id = 'proj-budget'").run();

    const createGoal = await executeTool("create_goal", {
      title: "Budgeted goal",
      description: "do work",
      project_id: "proj-budget",
    }, tools, ctx);
    expect(createGoal.result).toContain("exceeded budget");
  });
});
