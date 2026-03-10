import type { AutomatonTool, ToolContext, ToolCallResult, ToolCategory } from "../../types.js";
import { loadConfig } from "../../config.js";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("github-search");

interface GitHubSearchInput {
  query: string;
  filter?: "repo" | "issue" | "discussion" | "all";
  sort?: "stars" | "updated" | "created";
  max_results?: number;
}

interface GitHubSearchResult {
  success?: boolean;
  error?: string;
  query: string;
  filter: string;
  results: Array<{
    type: "repo" | "issue" | "discussion";
    title: string;
    url: string;
    owner?: string;
    description?: string;
    stars?: number;
    tags?: string[];
    createdAt: string;
    updatedAt: string;
  }>;
  executedAt: string;
  cacheHit: boolean;
}

const cache = new Map<string, { data: GitHubSearchResult; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(
  query: string,
  filter: string,
  sort: string
): string {
  return `github_search:${query}:${filter}:${sort}`;
}

async function queryGitHubGraphQL(
  query: string,
  variables: Record<string, unknown>
): Promise<unknown> {
  const config = loadConfig();
  if (!config?.discovery?.githubToken) {
    throw new Error("GitHub token not configured in discovery settings");
  }

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.discovery.githubToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
  };

  if (data.errors) {
    throw new Error(`GitHub GraphQL error: ${data.errors[0].message}`);
  }

  return data.data;
}

export function getGitHubSearchTool(): AutomatonTool {
  return {
    name: "github_search",
    description:
      "Search GitHub for agent projects, issues, and discussions. Find repositories, extract problem statements, and identify adoption signals via stars.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Search query, e.g., "agent framework", "autonomous AI"',
        },
        filter: {
          type: "string",
          enum: ["repo", "issue", "discussion", "all"],
          description: "Filter by result type (default: all)",
          default: "all",
        },
        sort: {
          type: "string",
          enum: ["stars", "updated", "created"],
          description: "Sort by field (default: updated)",
          default: "updated",
        },
        max_results: {
          type: "number",
          description: "Number of results to return (1-100, default 30)",
          minimum: 1,
          maximum: 100,
          default: 30,
        },
      },
      required: ["query"],
    },
    riskLevel: "safe",
    category: "skills" as ToolCategory,

    async execute(
      args: Record<string, unknown>,
      _context: ToolContext
    ): Promise<string> {
      const input = {
        query: String(args.query),
        filter: args.filter ? String(args.filter) : "all",
        sort: args.sort ? String(args.sort) : "updated",
        max_results: args.max_results ? Number(args.max_results) : 30,
      } as GitHubSearchInput;

      const cacheKey = getCacheKey(
        input.query,
        input.filter || "all",
        input.sort || "updated"
      );

      // Check cache
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        logger.debug(
          `[CACHE HIT] github_search: "${input.query}" (filter: ${input.filter})`
        );
        const result = { ...cached.data, cacheHit: true };
        return JSON.stringify(result);
      }

      try {
        logger.info(
          `[GITHUB_SEARCH] "${input.query}" (filter: ${input.filter}, sort: ${input.sort})`
        );

        // Build search query based on filter
        let searchQuery = input.query;
        if (input.filter === "repo") {
          searchQuery += " language:typescript";
        }

        // Execute GitHub search
        const results: GitHubSearchResult["results"] = [];

        if (input.filter === "repo" || input.filter === "all") {
          const repoQuery = `
            query SearchRepositories($query: String!, $first: Int!) {
              search(query: $query, type: REPOSITORY, first: $first) {
                repositoryCount
                edges {
                  node {
                    ... on Repository {
                      name
                      owner { login }
                      description
                      url
                      stargazerCount
                      createdAt
                      updatedAt
                      primaryLanguage { name }
                    }
                  }
                }
              }
            }
          `;

          const repoData = (await queryGitHubGraphQL(repoQuery, {
            query: searchQuery,
            first: Math.min(input.max_results || 30, 30),
          })) as {
            search: { edges: Array<{ node: Record<string, unknown> }> };
          };

          if (repoData.search?.edges) {
            repoData.search.edges.forEach((edge) => {
              const repo = edge.node as Record<string, unknown>;
              results.push({
                type: "repo",
                title: String(repo.name),
                url: String(repo.url),
                owner: String(
                  (repo.owner as Record<string, unknown>).login
                ),
                description: String(repo.description || ""),
                stars: Number(repo.stargazerCount),
                tags: repo.primaryLanguage
                  ? [
                      String(
                        (repo.primaryLanguage as Record<string, unknown>)
                          .name
                      ),
                    ]
                  : [],
                createdAt: String(repo.createdAt),
                updatedAt: String(repo.updatedAt),
              });
            });
          }
        }

        if (input.filter === "issue" || input.filter === "all") {
          const issueQuery = `
            query SearchIssues($query: String!, $first: Int!) {
              search(query: $query, type: ISSUE, first: $first) {
                edges {
                  node {
                    ... on Issue {
                      title
                      url
                      repository { name }
                      createdAt
                      updatedAt
                    }
                  }
                }
              }
            }
          `;

          const issueData = (await queryGitHubGraphQL(issueQuery, {
            query: input.query,
            first: Math.min(input.max_results || 30, 30),
          })) as {
            search: { edges: Array<{ node: Record<string, unknown> }> };
          };

          if (issueData.search?.edges) {
            issueData.search.edges.forEach((edge) => {
              const issue = edge.node as Record<string, unknown>;
              const repoName =
                issue.repository && typeof issue.repository === "object"
                  ? String((issue.repository as Record<string, unknown>).name)
                  : "unknown";
              results.push({
                type: "issue",
                title: String(issue.title),
                url: String(issue.url),
                owner: repoName,
                createdAt: String(issue.createdAt),
                updatedAt: String(issue.updatedAt),
              });
            });
          }
        }

        // Sort results if specified
        const sortField = input.sort || "updated";
        if (sortField === "stars") {
          results.sort((a, b) => (b.stars || 0) - (a.stars || 0));
        } else if (sortField === "updated") {
          results.sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() -
              new Date(a.updatedAt).getTime()
          );
        } else if (sortField === "created") {
          results.sort(
            (a, b) =>
              new Date(b.createdAt).getTime() -
              new Date(a.createdAt).getTime()
          );
        }

        // Limit to requested number
        const limited = results.slice(0, input.max_results || 30);

        const result: GitHubSearchResult = {
          success: true,
          query: input.query,
          filter: input.filter || "all",
          results: limited,
          executedAt: new Date().toISOString(),
          cacheHit: false,
        };

        // Cache the result
        cache.set(cacheKey, { data: result, timestamp: Date.now() });

        return JSON.stringify(result);
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        logger.error(`[GITHUB_SEARCH] Error: ${errorMsg}`);
        return JSON.stringify({
          success: false,
          error: `github_search failed: ${errorMsg}`,
        });
      }
    },
  };
}
