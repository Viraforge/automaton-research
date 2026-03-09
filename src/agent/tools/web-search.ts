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

function getCacheKey(input: WebSearchInput): string {
  return `web_search:${input.query}:${input.search_type || "all"}`;
}

export interface WebSearchTool {
  execute(input: WebSearchInput): Promise<WebSearchResult>;
}

export function getWebSearchTool(): WebSearchTool {
  return {
    async execute(input: WebSearchInput): Promise<WebSearchResult> {
      // Validate input
      const maxResults = input.max_results ?? 10;
      if (maxResults < 1 || maxResults > 20) {
        throw new Error("max_results must be between 1 and 20");
      }

      const searchType = input.search_type ?? "all";
      const cacheKey = getCacheKey(input);

      // Check cache
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        logger.debug(`[CACHE HIT] web_search: "${input.query}"`);
        return { ...cached.data, cacheHit: true };
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

        return result;
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        logger.error(`[WEB_SEARCH] Error: ${errorMsg}`);
        throw error;
      }
    },
  };
}
