import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createBuiltinTools } from "../../agent/tools.js";
import { initSpawnQueue, _resetSpawnQueue } from "../../replication/spawn-queue.js";

// Mock ResilientHttpClient for web_search so tests don't depend on network
// github_search uses raw fetch() so it's not affected by this mock
vi.mock("../../http/client.js", () => ({
  ResilientHttpClient: vi.fn().mockImplementation(() => ({
    request: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "AI Agent Marketplace Platform Discovery",
            url: "https://example.com/marketplace",
            content:
              "A comprehensive guide to finding and deploying autonomous AI agents.",
            score: 0.96,
            published_date: "2026-03-10",
          },
          {
            title: "Agent Economy 2026: Market Analysis",
            url: "https://example.com/analysis/agent-economy",
            content:
              "In-depth analysis of the emerging agent economy and market opportunities.",
            score: 0.92,
            published_date: "2026-03-09",
          },
          {
            title: "Autonomous Agent Platforms: Comparison",
            url: "https://example.com/comparison",
            content:
              "Comparison of leading autonomous agent deployment platforms.",
            score: 0.88,
            published_date: "2026-03-08",
          },
        ],
      }),
      text: async () => "",
    }),
  })),
}));

// Mock loadConfig() for github_search so it doesn't need real credentials
vi.mock("../../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    discovery: { githubToken: "ghp_mock_token_for_testing" },
  }),
}));

// Deterministic GraphQL mock responses for github_search
function makeMockFetch() {
  return vi.fn(async (_url: string, opts: RequestInit) => {
    const body = JSON.parse(opts.body as string);
    const q: string = body.query ?? "";
    if (q.includes("type: REPOSITORY")) {
      return {
        ok: true,
        json: async () => ({
          data: {
            search: {
              repositoryCount: 1,
              edges: [{
                node: {
                  name: "mock-agent-framework",
                  owner: { login: "testorg" },
                  description: "A mock agent framework",
                  url: "https://github.com/testorg/mock-agent-framework",
                  stargazerCount: 1337,
                  createdAt: "2024-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                  primaryLanguage: { name: "TypeScript" },
                },
              }],
            },
          },
        }),
      };
    }
    if (q.includes("type: ISSUE")) {
      return {
        ok: true,
        json: async () => ({
          data: {
            search: {
              edges: [{
                node: {
                  title: "Agent latency issue",
                  url: "https://github.com/testorg/repo/issues/1",
                  repository: { name: "mock-repo" },
                  createdAt: "2024-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              }],
            },
          },
        }),
      };
    }
    if (q.includes("type: DISCUSSION")) {
      return {
        ok: true,
        json: async () => ({
          data: {
            search: {
              edges: [{
                node: {
                  title: "Agent coordination patterns",
                  url: "https://github.com/testorg/repo/discussions/1",
                  repository: { name: "mock-repo", owner: { login: "testorg" } },
                  createdAt: "2024-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:00Z",
                },
              }],
            },
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ data: { search: { edges: [] } } }) };
  });
}

describe("discovery tools integration", () => {
  beforeEach(() => {
    initSpawnQueue();  // Initialize spawn queue for tests that use spawn_child
    vi.stubGlobal("fetch", makeMockFetch());  // Mock fetch for github_search
  });

  afterEach(() => {
    _resetSpawnQueue();  // Reset spawn queue singleton between tests
    vi.unstubAllGlobals();  // Clean up global fetch stub
  });

  it("should execute web_search and return valid result structure", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const webSearch = tools.find((t) => t.name === "web_search");

    expect(webSearch).toBeDefined();

    const mockContext = {
      config: { discovery: { tavilyApiKey: "mock-key" } },
    };

    const resultStr = await webSearch!.execute(
      {
        query: "agent marketplace",
        max_results: 3,
      },
      mockContext as any
    );

    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty("query");
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("executedAt");
    expect(result).toHaveProperty("cacheHit");
    expect(result.results).toBeInstanceOf(Array);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.resultsCount).toBe(result.results.length);
  });

  it("should execute github_search with valid GitHub token", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const gitHub = tools.find((t) => t.name === "github_search");

    expect(gitHub).toBeDefined();

    const resultStr = await gitHub!.execute(
      {
        query: "agent framework",
        filter: "repo",
        max_results: 3,
      },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty("query");
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("executedAt");
    expect(result).toHaveProperty("cacheHit");
    expect(result.results).toBeInstanceOf(Array);
  });

  it("should demonstrate use case: find agent platforms with web_search", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const webSearch = tools.find((t) => t.name === "web_search");

    expect(webSearch).toBeDefined();

    const mockContext = {
      config: { discovery: { tavilyApiKey: "mock-key" } },
    };

    // This is the actual use case from specification
    const resultStr = await webSearch!.execute(
      {
        query: "AI agent marketplace platforms 2026",
        search_type: "all",
        max_results: 5,
      },
      mockContext as any
    );

    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty("results");
    expect(result.results).toBeInstanceOf(Array);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.resultsCount).toBe(result.results.length);
  });

  it("should demonstrate use case: find agent discussions with github_search", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const gitHub = tools.find((t) => t.name === "github_search");

    expect(gitHub).toBeDefined();

    // This is the actual use case from specification
    const resultStr = await gitHub!.execute(
      {
        query: "agents need data API performance latency",
        filter: "issue",
        max_results: 5,
      },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty("results");
    expect(result.results).toBeInstanceOf(Array);
  });

  it("should verify discovery tools are in tool registry", () => {
    const tools = createBuiltinTools("test-sandbox");
    const webSearch = tools.find((t) => t.name === "web_search");
    const gitHub = tools.find((t) => t.name === "github_search");
    const apiDiscovery = tools.find((t) => t.name === "get_api_discovery");

    expect(webSearch).toBeDefined();
    expect(gitHub).toBeDefined();
    expect(apiDiscovery).toBeDefined();
    expect(webSearch?.category).toBe("skills");
    expect(gitHub?.category).toBe("skills");
    expect(apiDiscovery?.category).toBe("skills");
    expect(webSearch?.riskLevel).toBe("safe");
    expect(gitHub?.riskLevel).toBe("safe");
    expect(apiDiscovery?.riskLevel).toBe("safe");
  });

  it("should execute get_api_discovery for polymarket and return endpoints", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const apiDiscovery = tools.find((t) => t.name === "get_api_discovery");

    expect(apiDiscovery).toBeDefined();

    const resultStr = await apiDiscovery!.execute(
      { service_name: "polymarket" },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result.success).toBe(true);
    expect(result.service).toBeDefined();
    expect(result.service?.name).toContain("Polymarket");
    expect(result.service?.endpoints).toBeDefined();
    expect(Object.keys(result.service?.endpoints || {})).toContain(
      "markets_clob"
    );
    expect(Object.keys(result.service?.endpoints || {})).toContain(
      "market_data_gamma"
    );
    expect(result).toHaveProperty("executedAt");
    expect(result).toHaveProperty("cacheHit");
    expect(result).toHaveProperty("service_name");
    expect(result.service_name).toBe("polymarket");
  });

  it("should execute get_api_discovery for github and return rate limits", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const apiDiscovery = tools.find((t) => t.name === "get_api_discovery");

    expect(apiDiscovery).toBeDefined();

    const resultStr = await apiDiscovery!.execute(
      { service_name: "github" },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result.success).toBe(true);
    expect(result.service).toBeDefined();
    expect(result.service?.name).toContain("GitHub");
    expect(result.service?.authentication).toContain("personal access token");
    expect(result.service?.rateLimits).toContain("5000 requests/hour");
    expect(result.service?.notes).toContain("ALWAYS list_directory");
  });

  it("should handle invalid service gracefully", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const apiDiscovery = tools.find((t) => t.name === "get_api_discovery");

    expect(apiDiscovery).toBeDefined();

    const resultStr = await apiDiscovery!.execute(
      { service_name: "invalid-service" },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(result.error).toContain("Available services");
    expect(result).toHaveProperty("executedAt");
    expect(result).toHaveProperty("cacheHit");
  });
});
