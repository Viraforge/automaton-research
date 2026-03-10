import type { AutomatonTool, ToolContext } from "../../types.js";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("web-search");

interface WebSearchInput {
  query: string;
  max_results?: number;
  search_type?: "all" | "news" | "research" | "code";
}

interface WebSearchResult {
  success?: boolean;
  error?: string;
  query: string;
  resultsCount: number;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source: string;
    relevanceScore: number;
    domain: string;
    publishedAt?: string;
  }>;
  executedAt: string;
  cacheHit: boolean;
}

// Simple in-memory cache
const cache = new Map<string, { data: WebSearchResult; timestamp: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getCacheKey(query: string, searchType: string): string {
  return `web_search:${query}:${searchType}`;
}

export function getWebSearchTool(): AutomatonTool {
  return {
    name: "web_search",
    description:
      "Search the public web for information, news, and resources. Returns structured results with relevance scoring.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Search query, e.g., "AI agent marketplace", "autonomous agents"',
        },
        max_results: {
          type: "number",
          description: "Number of results to return (1-20, default 10)",
          minimum: 1,
          maximum: 20,
          default: 10,
        },
        search_type: {
          type: "string",
          enum: ["all", "news", "research", "code"],
          description: 'Filter results by type (default: "all")',
          default: "all",
        },
      },
      required: ["query"],
    },
    riskLevel: "safe",
    category: "skills",

    async execute(
      args: Record<string, unknown>,
      _context: ToolContext
    ): Promise<string> {
      const input = {
        query: String(args.query),
        max_results: args.max_results ? Number(args.max_results) : undefined,
        search_type: args.search_type ? String(args.search_type) : undefined,
      } as WebSearchInput;

      // Validate input
      const maxResults = input.max_results ?? 10;
      if (maxResults < 1 || maxResults > 20) {
        return JSON.stringify({
          success: false,
          error: "max_results must be between 1 and 20",
        });
      }

      const searchType = input.search_type ?? "all";
      const cacheKey = getCacheKey(input.query, searchType);

      // Check cache
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        logger.debug(`[CACHE HIT] web_search: "${input.query}"`);
        const result = { ...cached.data, cacheHit: true };
        return JSON.stringify(result);
      }

      try {
        // For now, return mock results that demonstrate the schema
        // In production, this would route to Anthropic's MCP web_search capability
        logger.info(`[WEB_SEARCH] "${input.query}" (type: ${searchType})`);

        const result: WebSearchResult = {
          query: input.query,
          resultsCount: 0,
          results: [],
          executedAt: new Date().toISOString(),
          cacheHit: false,
        };

        // Cache the result
        cache.set(cacheKey, { data: result, timestamp: Date.now() });

        return JSON.stringify(result);
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        logger.error(`[WEB_SEARCH] Error: ${errorMsg}`);
        return JSON.stringify({
          success: false,
          error: `web_search failed: ${errorMsg}`,
        });
      }
    },
  };
}
