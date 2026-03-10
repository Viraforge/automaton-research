import { describe, it, expect } from "vitest";
import { createBuiltinTools } from "../../agent/tools.js";
import { loadConfig } from "../../config.js";

describe("discovery tools integration", () => {
  it("should execute web_search and return valid result structure", async () => {
    const tools = createBuiltinTools("test-sandbox");
    const webSearch = tools.find((t) => t.name === "web_search");

    expect(webSearch).toBeDefined();

    const resultStr = await webSearch!.execute(
      {
        query: "agent marketplace",
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

    // This is the actual use case from specification
    const resultStr = await webSearch!.execute(
      {
        query: "AI agent marketplace platforms 2026",
        search_type: "all",
        max_results: 5,
      },
      {} as any
    );

    const result = JSON.parse(resultStr);

    expect(result).toHaveProperty("results");
    expect(result.results).toBeInstanceOf(Array);
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

    expect(webSearch).toBeDefined();
    expect(gitHub).toBeDefined();
    expect(webSearch?.category).toBe("skills");
    expect(gitHub?.category).toBe("skills");
    expect(webSearch?.riskLevel).toBe("safe");
    expect(gitHub?.riskLevel).toBe("safe");
  });
});
