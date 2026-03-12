import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { createCloudflareProvider } from "../providers/cloudflare.js";
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
        cloudflareApiToken: "cf-test-token",
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
    expect(conway.execCalls[0]?.command).toContain("http://alpha.compintel.co {");
    expect(conway.execCalls[0]?.command).toContain("https://alpha.compintel.co {");
    expect(vi.mocked(createCloudflareProvider)).toHaveBeenCalledWith({
      apiToken: "cf-test-token",
    });
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

describe("expose_port tool with auto-publish", () => {
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
        cloudflareApiToken: "cf-test-token",
        cloudflareZoneId: "zone-test",
      }),
      db,
      conway,
      inference: new MockInferenceClient(),
    };

    // Mock Conway to return localhost (BYOK mode)
    conway.exposePort = vi.fn(async (port) => ({
      port,
      publicUrl: `http://localhost:${port}`,
      sandboxId: "local",
    }));

    listZones.mockResolvedValue([{ id: "zone-test", name: "compintel.co", status: "active" }]);
    listRecords.mockResolvedValue([
      { id: "rec-api", type: "A", host: "api.compintel.co", value: "66.135.29.159", ttl: 1 },
    ]);
    addRecord.mockResolvedValue({
      id: "rec-new",
      type: "A",
      host: "api-3000-abc123.compintel.co",
      value: "66.135.29.159",
      ttl: 1,
    });
    deleteRecord.mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it("returns localhost when no cloudflare credentials", async () => {
    const ctxNoCloudflare = {
      ...ctx,
      config: createTestConfig({
        useSovereignProviders: false,
        cloudflareApiToken: undefined,
      }),
    };

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctxNoCloudflare);

    expect(result).toContain("http://localhost:3000");
    expect(addRecord).not.toHaveBeenCalled();
  });

  it("auto-publishes to compintel.co when in BYOK mode with cloudflare", async () => {
    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctx);
    expect(vi.mocked(createCloudflareProvider)).toHaveBeenCalledWith({
      apiToken: "cf-test-token",
    });

    // Should call Cloudflare to create DNS record
    expect(addRecord).toHaveBeenCalledWith(
      "zone-test",
      "A",
      expect.stringMatching(/^api-3000-[a-z0-9]{6}\.compintel\.co$/),
      "66.135.29.159",
      1,
      true, // proxied
    );

    // Should configure Caddy reverse proxy
    expect(conway.execCalls.length).toBeGreaterThan(0);
    const caddy = conway.execCalls[conway.execCalls.length - 1];
    expect(caddy?.command).toContain("reverse_proxy http://127.0.0.1:3000");

    // Should return HTTPS URL, not localhost
    expect(result).toContain("https://api-3000-");
    expect(result).toContain(".compintel.co");
    expect(result).not.toContain("localhost");
  });

  it("falls back to localhost if auto-publish fails", async () => {
    // Mock Caddy publish script to fail
    vi.spyOn(conway, "exec").mockResolvedValueOnce({
      stdout: "",
      stderr: "Caddy error",
      exitCode: 1,
    });

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");

    const result = await exposeTool!.execute({ port: 3000 }, ctx);

    // Should mention the failure but also show localhost fallback
    expect(result).toContain("localhost");
    expect(result).toMatch(/public publishing failed|auto-publish failed/);
  });
});

describe("manage_dns tool with cloudflare auth modes", () => {
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
        cloudflareApiToken: "cf-test-token",
        cloudflareZoneId: "zone-test",
      }),
      db,
      conway,
      inference: new MockInferenceClient(),
    };

    listRecords.mockResolvedValue([
      { id: "rec-api", type: "A", host: "api.compintel.co", value: "66.135.29.159", ttl: 1 },
    ]);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it("uses API token auth for manage_dns list", async () => {
    const dnsTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "manage_dns");
    expect(dnsTool).toBeDefined();

    const result = await dnsTool!.execute(
      {
        action: "list",
        domain: "compintel.co",
      },
      ctx,
    );

    expect(result).toContain("api.compintel.co");
    expect(vi.mocked(createCloudflareProvider)).toHaveBeenCalledWith({
      apiToken: "cf-test-token",
    });
  });
});
