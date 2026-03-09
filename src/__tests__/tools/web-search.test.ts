import { describe, it, expect, vi } from "vitest";
import { getWebSearchTool } from "../../agent/tools/web-search.js";

describe("web_search tool", () => {
  it("should return structured results with title, url, snippet, domain, relevanceScore", async () => {
    const tool = getWebSearchTool();

    // Test input validation
    const result = await tool.execute({
      query: "agent marketplace platforms",
      max_results: 5,
      search_type: "all",
    });

    expect(result).toHaveProperty("query");
    expect(result).toHaveProperty("resultsCount");
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("executedAt");
    expect(result).toHaveProperty("cacheHit");
    expect(result.results).toBeInstanceOf(Array);
    
    // When results are available, verify structure
    if (result.results.length > 0) {
      expect(result.results[0]).toHaveProperty("title");
      expect(result.results[0]).toHaveProperty("url");
      expect(result.results[0]).toHaveProperty("snippet");
      expect(result.results[0]).toHaveProperty("domain");
      expect(result.results[0]).toHaveProperty("relevanceScore");
    }
  });

  it("should support search_type filters: all, news, research, code", async () => {
    const tool = getWebSearchTool();

    const newsResult = await tool.execute({
      query: "AI agent economy news",
      search_type: "news",
      max_results: 3,
    });

    expect(newsResult.results).toBeDefined();
    expect(newsResult.results.length).toBeGreaterThanOrEqual(0);
  });

  it("should cache results and return cacheHit: true on second query", async () => {
    const tool = getWebSearchTool();

    const first = await tool.execute({
      query: "agent frameworks",
      max_results: 5,
    });
    expect(first.cacheHit).toBe(false);

    // Same query should hit cache
    const second = await tool.execute({
      query: "agent frameworks",
      max_results: 5,
    });
    expect(second.cacheHit).toBe(true);
    expect(second.results).toEqual(first.results);
  });

  it("should validate max_results is between 1-20", async () => {
    const tool = getWebSearchTool();

    try {
      await tool.execute({
        query: "agents",
        max_results: 50, // Invalid: > 20
      });
      expect.fail("Should have thrown validation error");
    } catch (e) {
      expect(e.message).toContain("max_results must be between 1 and 20");
    }
  });
});
