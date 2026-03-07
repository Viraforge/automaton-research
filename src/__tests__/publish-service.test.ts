import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import {
  MockConwayClient,
  MockInferenceClient,
  createTestConfig,
  createTestDb,
  createTestIdentity,
} from "./mocks.js";
import type { AutomatonDatabase, ToolContext } from "../types.js";

const listZones = vi.fn();
const listRecords = vi.fn();
const addRecord = vi.fn();
const deleteRecord = vi.fn();

vi.mock("../providers/cloudflare.js", () => ({
  createCloudflareProvider: vi.fn(() => ({
    listZones,
    listRecords,
    addRecord,
    deleteRecord,
  })),
}));

describe("publish_service tool", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let ctx: ToolContext;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    ctx = {
      identity: createTestIdentity(),
      config: createTestConfig({
        useSovereignProviders: true,
        cloudflareApiKey: "cf-test-key",
        cloudflareEmail: "ops@compintel.co",
        cloudflareZoneId: "zone-test",
      }),
      db,
      conway,
      inference: new MockInferenceClient(),
    };

    listZones.mockResolvedValue([{ id: "zone-test", name: "compintel.co", status: "active" }]);
    listRecords.mockResolvedValue([
      { id: "rec-api", type: "A", host: "api.compintel.co", value: "66.135.29.159", ttl: 1 },
      { id: "rec-old", type: "A", host: "alpha.compintel.co", value: "1.2.3.4", ttl: 1 },
    ]);
    addRecord.mockResolvedValue({
      id: "rec-new",
      type: "A",
      host: "alpha.compintel.co",
      value: "66.135.29.159",
      ttl: 1,
    });
    deleteRecord.mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it("publishes a compintel service via dns and caddy", async () => {
    const publishTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "publish_service");
    expect(publishTool).toBeDefined();

    const result = await publishTool!.execute(
      {
        subdomain: "alpha",
        port: 9090,
        healthcheck_path: "/health",
      },
      ctx,
    );

    expect(deleteRecord).toHaveBeenCalledWith("zone-test", "rec-old");
    expect(addRecord).toHaveBeenCalledWith(
      "zone-test",
      "A",
      "alpha.compintel.co",
      "66.135.29.159",
      1,
      false,
    );
    expect(conway.execCalls).toHaveLength(1);
    expect(conway.execCalls[0]?.command).toContain("alpha.compintel.co");
    expect(conway.execCalls[0]?.command).toContain("reverse_proxy http://127.0.0.1:9090");
    expect(conway.execCalls[0]?.command).toContain("BEGIN AUTOMATON SITES IMPORT");
    expect(result).toContain("Service published: https://alpha.compintel.co");
  });

  it("blocks publication outside compintel.co", async () => {
    const publishTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "publish_service");
    const result = await publishTool!.execute(
      {
        subdomain: "test.example.com",
        domain: "example.com",
        port: 8088,
      },
      ctx,
    );

    expect(result).toContain("Blocked: publish_service is restricted to compintel.co subdomains.");
    expect(addRecord).not.toHaveBeenCalled();
    expect(conway.execCalls).toHaveLength(0);
  });
});
