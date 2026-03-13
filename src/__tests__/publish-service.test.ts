import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBuiltinTools } from "../agent/tools.js";
import { createCloudflareProvider } from "../providers/cloudflare.js";
import * as publicAssetRegistry from "../publication/public-asset-registry.js";
import * as productsRegistry from "../publication/products-registry.js";
import * as compintelSiteGenerator from "../publication/generate-compintel-site.js";
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
  let registryPath: string;
  let registryDirPath: string;
  let previousRegistryPath: string | undefined;
  let previousProductsRegistryPath: string | undefined;
  let previousSiteRoot: string | undefined;
  let siteRoot: string;
  let productsRegistryPath: string;

  beforeEach(async () => {
    db = createTestDb();
    conway = new MockConwayClient();
    registryDirPath = await mkdtemp(join(tmpdir(), "publish-service-registry-"));
    registryPath = join(registryDirPath, "public-assets.json");
    productsRegistryPath = join(registryDirPath, "products.json");
    siteRoot = join(registryDirPath, "site");
    await writeFile(registryPath, '{"assets":[]}\n', "utf8");
    await writeFile(productsRegistryPath, '{"products":[]}\n', "utf8");
    previousRegistryPath = process.env.PUBLIC_ASSET_REGISTRY_PATH;
    previousProductsRegistryPath = process.env.PRODUCTS_REGISTRY_PATH;
    previousSiteRoot = process.env.COMPINTEL_SITE_ROOT;
    process.env.PUBLIC_ASSET_REGISTRY_PATH = registryPath;
    process.env.PRODUCTS_REGISTRY_PATH = productsRegistryPath;
    process.env.COMPINTEL_SITE_ROOT = siteRoot;
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

  afterEach(async () => {
    if (previousRegistryPath === undefined) delete process.env.PUBLIC_ASSET_REGISTRY_PATH;
    else process.env.PUBLIC_ASSET_REGISTRY_PATH = previousRegistryPath;
    if (previousProductsRegistryPath === undefined) delete process.env.PRODUCTS_REGISTRY_PATH;
    else process.env.PRODUCTS_REGISTRY_PATH = previousProductsRegistryPath;
    if (previousSiteRoot === undefined) delete process.env.COMPINTEL_SITE_ROOT;
    else process.env.COMPINTEL_SITE_ROOT = previousSiteRoot;

    await rm(registryDirPath, { recursive: true, force: true });
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
    expect(conway.execCalls.length).toBeGreaterThanOrEqual(2);
    expect(conway.execCalls[0]?.command).toContain("127.0.0.1:9090/health");
    const publishCall = conway.execCalls[conway.execCalls.length - 1];
    expect(publishCall?.command).toContain("alpha.compintel.co");
    expect(publishCall?.command).toContain("reverse_proxy http://127.0.0.1:9090");
    expect(publishCall?.command).toContain("Caddyfile.published-alpha.compintel.co");
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

  it("blocks publish_service when local health check fails", async () => {
    vi.spyOn(conway, "exec").mockResolvedValueOnce({
      stdout: "",
      stderr: "connection refused",
      exitCode: 7,
    });

    const publishTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "publish_service");
    const result = await publishTool!.execute(
      {
        subdomain: "alpha",
        port: 9090,
        healthcheck_path: "/health",
      },
      ctx,
    );

    expect(result).toContain("Blocked: local service health check failed");
    expect(addRecord).not.toHaveBeenCalled();
    expect(deleteRecord).not.toHaveBeenCalled();
  });

  it("records successful publication in the public asset registry", async () => {
    const publishTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "publish_service");

    await publishTool!.execute(
      {
        subdomain: "alpha",
        port: 9090,
        healthcheck_path: "/health",
      },
      ctx,
    );

    const registryContent = await readFile(registryPath, "utf8");
    const registry = JSON.parse(registryContent) as {
      assets: Array<{
        id: string;
        title: string;
        url: string;
        subdomain: string;
        status: string;
        healthcheckPath: string;
        port: number;
      }>;
    };

    expect(registry.assets).toHaveLength(1);
    expect(registry.assets[0]).toMatchObject({
      id: "alpha",
      title: "alpha.compintel.co",
      url: "https://alpha.compintel.co",
      subdomain: "alpha",
      status: "published",
      healthcheckPath: "/health",
      port: 9090,
    });
  });

  it("promotes products registry and regenerates compintel site on successful publish", async () => {
    const promoteSpy = vi.spyOn(productsRegistry, "promoteProductToPublished");
    const generateSpy = vi.spyOn(compintelSiteGenerator, "generateCompintelSite");
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

    expect(result).toContain("Service published: https://alpha.compintel.co");
    expect(promoteSpy).toHaveBeenCalledWith({
      slug: "alpha",
      publicUrl: "https://alpha.compintel.co",
      healthcheckPath: "/health",
      internalPort: 9090,
      name: "alpha",
      summary: "Published service at https://alpha.compintel.co",
      category: "service",
      serviceName: "alpha",
    });
    expect(generateSpy).toHaveBeenCalled();
  });

  it("returns publication success with a warning when registry sync fails", async () => {
    vi.spyOn(publicAssetRegistry, "upsertPublicAssetRecord").mockRejectedValueOnce(new Error("disk full"));
    const publishTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "publish_service");

    const result = await publishTool!.execute(
      {
        subdomain: "alpha",
        port: 9090,
        healthcheck_path: "/health",
      },
      ctx,
    );

    expect(result).toContain("Service published: https://alpha.compintel.co");
    expect(result).toContain("Warning:");
    expect(result).toContain("public asset registry sync failed");
    expect(result).toContain("disk full");
  });

  it("waits through transient registry lock contention and still records the publish without warning", async () => {
    const publishTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "publish_service");
    const lockPath = `${registryPath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );

    const releaseTimer = setTimeout(() => {
      void rm(lockPath, { force: true });
    }, 2_200);

    try {
      const result = await publishTool!.execute(
        {
          subdomain: "alpha",
          port: 9090,
          healthcheck_path: "/health",
        },
        ctx,
      );

      const registryContent = await readFile(registryPath, "utf8");
      const registry = JSON.parse(registryContent) as {
        assets: Array<{ subdomain: string; url: string }>;
      };

      expect(result).toContain("Service published: https://alpha.compintel.co");
      expect(result).not.toContain("Warning:");
      expect(registry.assets).toHaveLength(1);
      expect(registry.assets[0]).toMatchObject({
        subdomain: "alpha",
        url: "https://alpha.compintel.co",
      });
    } finally {
      clearTimeout(releaseTimer);
      await rm(lockPath, { force: true });
    }
  });

  it("creates draft products and regenerates site via create_product tool", async () => {
    const createProductTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "create_product");
    expect(createProductTool).toBeDefined();

    const result = await createProductTool!.execute(
      {
        name: "Alpha Product",
        slug: "alpha-product",
        summary: "Alpha summary",
        category: "automation",
        internal_port: 9100,
        service_name: "alpha-service",
      },
      ctx,
    );

    expect(result).toContain("Draft product saved: Alpha Product");
    const productsPath = process.env.PRODUCTS_REGISTRY_PATH;
    expect(productsPath).toBeDefined();
    const registryContent = await readFile(productsPath!, "utf8");
    const registry = JSON.parse(registryContent) as {
      products: Array<{ slug: string; status: string; name: string; internalPort?: number; serviceName?: string }>;
    };
    expect(registry.products).toHaveLength(1);
    expect(registry.products[0]).toMatchObject({
      slug: "alpha-product",
      status: "draft",
      name: "Alpha Product",
      internalPort: 9100,
      serviceName: "alpha-service",
    });
  });
});

describe("expose_port tool with auto-publish", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let ctx: ToolContext;
  let registryPath: string;
  let registryDirPath: string;
  let previousRegistryPath: string | undefined;
  let previousProductsRegistryPath: string | undefined;
  let previousSiteRoot: string | undefined;
  let siteRoot: string;
  let productsRegistryPath: string;

  beforeEach(async () => {
    db = createTestDb();
    conway = new MockConwayClient();
    registryDirPath = await mkdtemp(join(tmpdir(), "expose-port-registry-"));
    registryPath = join(registryDirPath, "public-assets.json");
    productsRegistryPath = join(registryDirPath, "products.json");
    siteRoot = join(registryDirPath, "site");
    await writeFile(registryPath, '{"assets":[]}\n', "utf8");
    await writeFile(productsRegistryPath, '{"products":[]}\n', "utf8");
    previousRegistryPath = process.env.PUBLIC_ASSET_REGISTRY_PATH;
    previousProductsRegistryPath = process.env.PRODUCTS_REGISTRY_PATH;
    previousSiteRoot = process.env.COMPINTEL_SITE_ROOT;
    process.env.PUBLIC_ASSET_REGISTRY_PATH = registryPath;
    process.env.PRODUCTS_REGISTRY_PATH = productsRegistryPath;
    process.env.COMPINTEL_SITE_ROOT = siteRoot;
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

  afterEach(async () => {
    if (previousRegistryPath === undefined) delete process.env.PUBLIC_ASSET_REGISTRY_PATH;
    else process.env.PUBLIC_ASSET_REGISTRY_PATH = previousRegistryPath;
    if (previousProductsRegistryPath === undefined) delete process.env.PRODUCTS_REGISTRY_PATH;
    else process.env.PRODUCTS_REGISTRY_PATH = previousProductsRegistryPath;
    if (previousSiteRoot === undefined) delete process.env.COMPINTEL_SITE_ROOT;
    else process.env.COMPINTEL_SITE_ROOT = previousSiteRoot;

    await rm(registryDirPath, { recursive: true, force: true });
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

  it("blocks non-compintel public URLs in sovereign mode when cloudflare credentials are missing", async () => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: "https://beautifully-epinions-featured-serious.trycloudflare.com",
      sandboxId: "test-sandbox-id",
    }));
    const ctxWithoutCloudflareCredentials = {
      ...ctx,
      config: createTestConfig({
        useSovereignProviders: true,
        cloudflareApiToken: undefined,
        cloudflareApiKey: undefined,
      }),
    };

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctxWithoutCloudflareCredentials);

    expect(result).toContain("Blocked:");
    expect(result).toContain("Cloudflare publication credentials are missing");
    expect(result).not.toContain("trycloudflare.com");
  });

  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("preserves loopback URL %s in sovereign mode when cloudflare credentials are missing", async (loopbackUrl) => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: loopbackUrl,
      sandboxId: "test-sandbox-id",
    }));
    const ctxWithoutCloudflareCredentials = {
      ...ctx,
      config: createTestConfig({
        useSovereignProviders: true,
        cloudflareApiToken: undefined,
        cloudflareApiKey: undefined,
      }),
    };

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctxWithoutCloudflareCredentials);

    expect(result).toContain(loopbackUrl);
    expect(result).not.toContain("Blocked:");
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

  it("records successful managed publication in the public asset registry", async () => {
    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctx);
    const registryContent = await readFile(registryPath, "utf8");
    const registry = JSON.parse(registryContent) as {
      assets: Array<{
        id: string;
        title: string;
        url: string;
        subdomain: string;
        status: string;
        port: number;
      }>;
    };

    expect(result).toContain("https://api-3000-");
    expect(registry.assets).toHaveLength(1);
    expect(registry.assets[0]).toMatchObject({
      id: expect.stringMatching(/^api-3000-[a-z0-9]{6}$/),
      title: expect.stringMatching(/^api-3000-[a-z0-9]{6}\.compintel\.co$/),
      url: expect.stringMatching(/^https:\/\/api-3000-[a-z0-9]{6}\.compintel\.co$/),
      subdomain: expect.stringMatching(/^api-3000-[a-z0-9]{6}$/),
      status: "published",
      port: 3000,
    });
  });

  it("syncs the public asset registry for already-managed approved compintel exposures", async () => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: "https://api.compintel.co",
      sandboxId: "test-sandbox-id",
    }));

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctx);
    const registryContent = await readFile(registryPath, "utf8");
    const registry = JSON.parse(registryContent) as {
      assets: Array<{
        id: string;
        title: string;
        url: string;
        subdomain: string;
        status: string;
        healthcheckPath: string;
        port: number;
      }>;
    };

    expect(result).toContain("https://api.compintel.co");
    expect(addRecord).not.toHaveBeenCalled();
    expect(conway.execCalls).toHaveLength(0);
    expect(registry.assets).toHaveLength(1);
    expect(registry.assets[0]).toMatchObject({
      id: "api",
      title: "api.compintel.co",
      url: "https://api.compintel.co",
      subdomain: "api",
      status: "published",
      healthcheckPath: "/health",
      port: 3000,
    });
  });

  it("promotes non-compintel public URLs to compintel.co publication", async () => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: "https://beautifully-epinions-featured-serious.trycloudflare.com",
      sandboxId: "test-sandbox-id",
    }));

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctx);

    expect(result).toContain(".compintel.co");
    expect(result).not.toContain("trycloudflare.com");
  });

  it("does not treat the compintel apex host as an approved final publication URL", async () => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: "https://compintel.co",
      sandboxId: "test-sandbox-id",
    }));

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctx);

    expect(result).toContain("https://api-3000-");
    expect(result).toContain(".compintel.co");
    expect(result).not.toContain("Port 3000 exposed at: https://compintel.co");
    expect(addRecord).toHaveBeenCalledWith(
      "zone-test",
      "A",
      expect.stringMatching(/^api-3000-[a-z0-9]{6}\.compintel\.co$/),
      "66.135.29.159",
      1,
      true,
    );
  });

  it("does not treat trycloudflare URLs as valid final publication targets", async () => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: "https://beautifully-epinions-featured-serious.trycloudflare.com",
      sandboxId: "test-sandbox-id",
    }));

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctx);

    expect(result).not.toContain("trycloudflare.com");
  });

  it("blocks temporary tunnel URLs when managed publication fails", async () => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: "https://beautifully-epinions-featured-serious.trycloudflare.com",
      sandboxId: "test-sandbox-id",
    }));
    vi.spyOn(conway, "exec").mockResolvedValueOnce({
      stdout: "",
      stderr: "Caddy error",
      exitCode: 1,
    });

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctx);

    expect(result).toContain("Blocked:");
    expect(result).toContain("not a valid public asset URL");
    expect(result).not.toContain("trycloudflare.com");
  });

  it("blocks managed publication earlier when only cloudflareApiKey is set without cloudflareEmail", async () => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: "https://beautifully-epinions-featured-serious.trycloudflare.com",
      sandboxId: "test-sandbox-id",
    }));
    const ctxWithIncompleteCloudflareCredentials = {
      ...ctx,
      config: createTestConfig({
        useSovereignProviders: true,
        cloudflareApiToken: undefined,
        cloudflareApiKey: "cf-test-key",
        cloudflareEmail: undefined,
        cloudflareZoneId: "zone-test",
      }),
    };

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctxWithIncompleteCloudflareCredentials);

    expect(result).toContain("Blocked:");
    expect(result).toContain("Cloudflare publication credentials are missing");
    expect(addRecord).not.toHaveBeenCalled();
    expect(conway.execCalls).toHaveLength(0);
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

  it.each([
    "http://127.0.0.1:3000",
    "http://[::1]:3000",
  ])("preserves loopback URL %s when managed publication fails", async (loopbackUrl) => {
    conway.exposePort = vi.fn(async (port: number) => ({
      port,
      publicUrl: loopbackUrl,
      sandboxId: "test-sandbox-id",
    }));
    vi.spyOn(conway, "exec").mockResolvedValueOnce({
      stdout: "",
      stderr: "Caddy error",
      exitCode: 1,
    });

    const exposeTool = createBuiltinTools("test-sandbox-id").find((tool) => tool.name === "expose_port");
    expect(exposeTool).toBeDefined();

    const result = await exposeTool!.execute({ port: 3000 }, ctx);

    expect(result).toContain(loopbackUrl);
    expect(result).toMatch(/public publishing failed|auto-publish failed/);
    expect(result).not.toContain("Blocked:");
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
