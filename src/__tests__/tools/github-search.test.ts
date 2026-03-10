import { describe, it, expect, beforeEach } from "vitest";
import { getGitHubSearchTool } from "../../agent/tools/github-search.js";
import { loadConfig } from "../../config.js";

describe("github_search tool", () => {
  let tool;

  beforeEach(() => {
    tool = getGitHubSearchTool();
  });

  it("should return repositories with name, owner, stars, description, url", async () => {
    const resultStr = await tool.execute(
      {
        query: "agent framework",
        filter: "repo",
        max_results: 5,
      },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty("query");
    expect(result).toHaveProperty("filter");
    expect(result).toHaveProperty("results");
    expect(result).toHaveProperty("executedAt");
    expect(result).toHaveProperty("cacheHit");

    if (result.results.length > 0) {
      const repo = result.results[0];
      expect(repo.type).toBe("repo");
      expect(repo.title).toBeDefined();
      expect(repo.url).toBeDefined();
      expect(repo.owner).toBeDefined();
      expect(repo.stars).toBeDefined();
    }
  });

  it("should search issues and discussions", async () => {
    const resultStr = await tool.execute(
      {
        query: "agent latency problem",
        filter: "issue",
        max_results: 3,
      },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result.filter).toBe("issue");
    expect(result.results).toBeInstanceOf(Array);
    result.results.forEach((item) => {
      expect(item.type).toBe("issue");
      expect(item.title).toBeDefined();
      expect(item.url).toBeDefined();
    });
  });

  it("should validate GitHub token is configured", async () => {
    const config = loadConfig();
    if (!config?.discovery?.githubToken) {
      expect.fail("GitHub token not configured in discovery settings");
    }
    expect(config.discovery.githubToken).toMatch(/^ghp_/);
  });

  it("should sort results by specified field", async () => {
    const resultStr = await tool.execute(
      {
        query: "agent",
        filter: "repo",
        sort: "stars",
        max_results: 5,
      },
      {} as any
    );

    const result = JSON.parse(resultStr);

    if (result.results.length > 1) {
      // Results should be sorted by stars (descending)
      const stars = result.results
        .filter((r) => r.stars !== undefined)
        .map((r) => r.stars);
      for (let i = 1; i < stars.length; i++) {
        expect(stars[i]).toBeLessThanOrEqual(stars[i - 1]);
      }
    }
  });

  it("should cache results with 24-hour TTL", async () => {
    const firstStr = await tool.execute(
      {
        query: "autonomous agents",
        filter: "repo",
      },
      {} as any
    );
    const first = JSON.parse(firstStr);
    expect(first.cacheHit).toBe(false);

    const secondStr = await tool.execute(
      {
        query: "autonomous agents",
        filter: "repo",
      },
      {} as any
    );
    const second = JSON.parse(secondStr);
    expect(second.cacheHit).toBe(true);
  });
});
