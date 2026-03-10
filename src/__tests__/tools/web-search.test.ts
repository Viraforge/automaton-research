import { describe, it, expect, vi } from "vitest";
import { getWebSearchTool } from "../../agent/tools/web-search.js";

// Mock ResilientHttpClient for deterministic offline tests
vi.mock("../../http/client.js", () => ({
  ResilientHttpClient: vi.fn().mockImplementation(() => ({
    request: vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        results: [
          {
            title: "AI Agent Marketplace Platform",
            url: "https://example.com/marketplace",
            content:
              "A comprehensive marketplace for autonomous AI agents with built-in task execution.",
            score: 0.95,
            published_date: "2026-03-01",
          },
          {
            title: "Agent Economy: The Next Frontier",
            url: "https://example.com/article/agent-economy",
            content:
              "Exploring the emerging economy of autonomous AI agents and their deployment.",
            score: 0.87,
            published_date: "2026-02-28",
          },
        ],
      }),
      text: async () => "",
    }),
  })),
}));

describe("web_search tool", () => {
  it("should return structured results with title, url, snippet, domain, relevanceScore", async () => {
    const tool = getWebSearchTool();

    // Provide mock config with Tavily key
    const mockContext = {
      config: { discovery: { tavilyApiKey: "mock-key" } },
    };

    const resultStr = await tool.execute({
      query: "agent marketplace platforms",
      max_results: 5,
      search_type: "all",
    }, mockContext as any);

    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty("query");
    expect(result).toHaveProperty("resultsCount");
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("executedAt");
    expect(result).toHaveProperty("cacheHit");
    expect(result.results).toBeInstanceOf(Array);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.resultsCount).toBe(result.results.length);

    // Verify result structure
    expect(result.results[0]).toHaveProperty("title");
    expect(result.results[0]).toHaveProperty("url");
    expect(result.results[0]).toHaveProperty("snippet");
    expect(result.results[0]).toHaveProperty("domain");
    expect(result.results[0]).toHaveProperty("relevanceScore");
  });

  it("should support search_type filters: all, news, research, code", async () => {
    const tool = getWebSearchTool();
    const mockContext = {
      config: { discovery: { tavilyApiKey: "mock-key" } },
    };

    const newsResultStr = await tool.execute({
      query: "AI agent economy news",
      search_type: "news",
      max_results: 3,
    }, mockContext as any);

    const newsResult = JSON.parse(newsResultStr);

    expect(newsResult.results).toBeDefined();
    expect(newsResult.results.length).toBeGreaterThan(0);
  });

  it("should cache results and return cacheHit: true on second query", async () => {
    const tool = getWebSearchTool();
    const mockContext = {
      config: { discovery: { tavilyApiKey: "mock-key" } },
    };

    const firstStr = await tool.execute({
      query: "agent frameworks",
      max_results: 5,
    }, mockContext as any);

    const first = JSON.parse(firstStr);
    expect(first.cacheHit).toBe(false);
    expect(first.results.length).toBeGreaterThan(0);

    // Same query should hit cache
    const secondStr = await tool.execute({
      query: "agent frameworks",
      max_results: 5,
    }, mockContext as any);

    const second = JSON.parse(secondStr);
    expect(second.cacheHit).toBe(true);
    expect(second.results).toEqual(first.results);
  });

  it("should validate max_results is between 1-20", async () => {
    const tool = getWebSearchTool();
    const mockContext = {
      config: { discovery: { tavilyApiKey: "mock-key" } },
    };

    const resultStr = await tool.execute({
      query: "agents",
      max_results: 50, // Invalid: > 20
    }, mockContext as any);

    const result = JSON.parse(resultStr);
    expect(result.success).toBe(false);
    expect(result.error).toContain("max_results must be between 1 and 20");
  });
});
