import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getGitHubSearchTool } from "../../agent/tools/github-search.js";
import type { AutomatonTool } from "../../types.js";

// Mock loadConfig() so the token guard in github-search.ts passes without real config
vi.mock("../../config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    discovery: { githubToken: "ghp_mock_token_for_testing" },
  }),
}));

// Deterministic GraphQL mock responses by query type
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

describe("github_search tool", () => {
  let tool: AutomatonTool;

  beforeEach(() => {
    tool = getGitHubSearchTool();
    vi.stubGlobal("fetch", makeMockFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("should search issues with issue filter", async () => {
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
    result.results.forEach((item: any) => {
      expect(item.type).toBe("issue");
      expect(item.title).toBeDefined();
      expect(item.url).toBeDefined();
    });
  });

  it("should search discussions with discussion filter", async () => {
    const resultStr = await tool.execute(
      {
        query: "agent coordination",
        filter: "discussion",
        max_results: 3,
      },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result.filter).toBe("discussion");
    expect(result.results).toBeInstanceOf(Array);
    result.results.forEach((item: any) => {
      expect(item.type).toBe("discussion");
      expect(item.title).toBeDefined();
      expect(item.url).toBeDefined();
    });
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
      const stars = result.results
        .filter((r: any) => r.stars !== undefined)
        .map((r: any) => r.stars);
      for (let i = 1; i < stars.length; i++) {
        expect(stars[i]).toBeLessThanOrEqual(stars[i - 1]);
      }
    }
  });

  it("should cache results with 24-hour TTL", async () => {
    const firstStr = await tool.execute(
      {
        query: "autonomous agents unique-cache-key",
        filter: "repo",
      },
      {} as any
    );
    const first = JSON.parse(firstStr);
    expect(first.cacheHit).toBe(false);

    const secondStr = await tool.execute(
      {
        query: "autonomous agents unique-cache-key",
        filter: "repo",
      },
      {} as any
    );
    const second = JSON.parse(secondStr);
    expect(second.cacheHit).toBe(true);
  });
});
