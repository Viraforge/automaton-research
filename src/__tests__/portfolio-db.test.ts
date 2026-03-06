import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "./mocks.js";
import type { AutomatonDatabase } from "../types.js";
import {
  insertDistributionTarget,
  insertProject,
  listDistributionTargetsByProject,
  listProjects,
  recordProjectMetric,
  upsertDistributionChannel,
} from "../state/database.js";

describe("portfolio db primitives", () => {
  let db: AutomatonDatabase;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates and lists projects", () => {
    const projectId = insertProject(db.raw, {
      id: "p1",
      name: "Project One",
      offer: "Offer",
      targetCustomer: "Customer",
      monetizationHypothesis: "Charge for access",
    });
    expect(projectId).toBe("p1");
    const rows = listProjects(db.raw);
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe("Project One");
  });

  it("records project metric and distribution targets", () => {
    insertProject(db.raw, {
      id: "p2",
      name: "Project Two",
      offer: "Offer",
      targetCustomer: "Customer",
      monetizationHypothesis: "Charge for access",
    });
    upsertDistributionChannel(db.raw, {
      id: "social_relay",
      name: "Social Relay",
      channelType: "messaging",
      supportsMessaging: true,
      status: "ready",
    });
    insertDistributionTarget(db.raw, {
      id: "t1",
      projectId: "p2",
      channelId: "social_relay",
      targetKey: "clawnews",
      targetLabel: "ClawNews",
      priority: 100,
      operatorProvided: true,
      status: "pending",
    });
    recordProjectMetric(db.raw, {
      id: "m1",
      projectId: "p2",
      metricType: "lead",
      value: 1,
      metadata: { source: "test" },
    });
    const targets = listDistributionTargetsByProject(db.raw, "p2");
    expect(targets.length).toBe(1);
    const metrics = db.raw.prepare("SELECT COUNT(*) AS count FROM project_metrics WHERE project_id = ?").get("p2") as {
      count: number;
    };
    expect(metrics.count).toBe(1);
  });
});
