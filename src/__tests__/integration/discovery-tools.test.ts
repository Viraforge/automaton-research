import { describe, it, expect, vi } from "vitest";
import { createBuiltinTools } from "../../agent/tools.js";
import { loadConfig } from "../../config.js";

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

describe("discovery tools integration", () => {
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
    const config = loadConfig();
    expect(config?.discovery?.githubToken).toMatch(/^ghp_/);

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
