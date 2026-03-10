import type { AutomatonTool, ToolContext } from "../../types.js";
import { createLogger } from "../../observability/logger.js";
import { ResilientHttpClient } from "../../http/client.js";

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
        // Get Tavily API key from injected runtime config
        const config = _context.config as any;
        const tavilyApiKey = config?.discovery?.tavilyApiKey;

        // Graceful degradation if key not configured
        if (!tavilyApiKey) {
          logger.warn(
            `[WEB_SEARCH] tavilyApiKey not configured — returning empty results`
          );
          const emptyResult: WebSearchResult = {
            query: input.query,
            resultsCount: 0,
            results: [],
            executedAt: new Date().toISOString(),
            cacheHit: false,
          };
          cache.set(cacheKey, { data: emptyResult, timestamp: Date.now() });
          return JSON.stringify(emptyResult);
        }

        // Map search_type to Tavily parameters
        const searchTypeMap = {
          all: { topic: "general", search_depth: "basic" },
          news: { topic: "news", search_depth: "basic" },
          research: { topic: "general", search_depth: "advanced" },
          code: { topic: "general", search_depth: "basic" },
        } as const;

        const tavilyParams = searchTypeMap[searchType as keyof typeof searchTypeMap];
        if (searchType === "code") {
          logger.info(
            `[WEB_SEARCH] "${input.query}" (type: code, note: no code-specific search available in Tavily, using general)`
          );
        } else {
          logger.info(`[WEB_SEARCH] "${input.query}" (type: ${searchType})`);
        }

        // Call Tavily API
        const httpClient = new ResilientHttpClient();
        const tavilyResponse = await httpClient.request(
          "https://api.tavily.com/search",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              api_key: tavilyApiKey,
              query: input.query,
              max_results: maxResults,
              topic: tavilyParams.topic,
              search_depth: tavilyParams.search_depth,
              include_raw_content: false,
            }),
          }
        );

        if (!tavilyResponse.ok) {
          const errorText = await tavilyResponse.text();
          throw new Error(
            `Tavily API error ${tavilyResponse.status}: ${errorText}`
          );
        }

        const tavilyData = (await tavilyResponse.json()) as {
          results?: Array<{
            title: string;
            url: string;
            content?: string;
            score?: number;
            published_date?: string;
          }>;
        };

        // Validate Tavily response has results array
        if (!Array.isArray(tavilyData.results)) {
          tavilyData.results = [];
        }

        // Map Tavily response to WebSearchResult
        const results = tavilyData.results.map((r) => {
          let domain = "unknown";
          try {
            domain = new URL(r.url).hostname;
          } catch {
            // Malformed URL, use fallback
          }

          return {
            title: r.title,
            url: r.url,
            snippet: r.content ?? "",
            source: domain,
            domain,
            relevanceScore: r.score ?? 1.0,
            publishedAt: r.published_date ?? undefined,
          };
        });

        const result: WebSearchResult = {
          query: input.query,
          resultsCount: results.length,
          results,
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
