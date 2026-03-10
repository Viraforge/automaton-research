import type { AutomatonTool, ToolContext } from "../../types.js";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("api-discovery");

interface ApiEndpoint {
  url: string;
  method?: string;
  description?: string;
  example?: string;
}

interface ApiServiceInfo {
  name: string;
  description: string;
  baseUrl: string;
  endpoints: Record<string, ApiEndpoint>;
  rateLimits?: string;
  authentication?: string;
  notes?: string;
}

interface DiscoveryInput {
  service_name: string;
}

interface DiscoveryResult {
  success: boolean;
  error?: string;
  service?: ApiServiceInfo;
}

// API Discovery Database
const API_REGISTRY: Record<string, ApiServiceInfo> = {
  polymarket: {
    name: "Polymarket",
    description:
      "Prediction market platform with two separate APIs: CLOB for trading, Gamma for market data",
    baseUrl: "https://api.polymarket.com",
    endpoints: {
      markets_clob: {
        url: "https://clob.polymarket.com/markets",
        method: "GET",
        description: "List all trading markets on CLOB (trading API)",
        example: "curl -s https://clob.polymarket.com/markets",
      },
      market_data_gamma: {
        url: "https://gamma-api.polymarket.com/markets",
        method: "GET",
        description: "List all markets with detailed data on Gamma (market data API)",
        example:
          "curl -s https://gamma-api.polymarket.com/markets | jq '.markets | .[0]'",
      },
      market_by_id_clob: {
        url: "https://clob.polymarket.com/markets/{market_id}",
        method: "GET",
        description: "Get specific market details from CLOB",
        example:
          "curl -s https://clob.polymarket.com/markets/0x123abc.../",
      },
      order_book: {
        url: "https://clob.polymarket.com/order_book?market_id={market_id}",
        method: "GET",
        description: "Get order book data for a specific market",
        example:
          "curl -s 'https://clob.polymarket.com/order_book?market_id=0x123abc...'",
      },
      trade_history: {
        url: "https://gamma-api.polymarket.com/trade-history",
        method: "GET",
        description: "Get recent trades on Gamma API",
        example: "curl -s https://gamma-api.polymarket.com/trade-history",
      },
    },
    rateLimits:
      "CLOB: 10 requests/second per IP. Gamma: Rate limited, implement exponential backoff on 429",
    authentication:
      "Both APIs are public. CLOB supports optional API keys for higher limits. Gamma is read-only public access.",
    notes:
      "CRITICAL: Do NOT use CLOB endpoint (clob.polymarket.com) for market data queries. Use Gamma API (gamma-api.polymarket.com/markets) instead. " +
      "CLOB is optimized for trading operations (order books, trades, execution). Gamma is optimized for market information (market list, tags, metadata). " +
      "If you receive 404 errors from clob.polymarket.com/markets, you're using the wrong endpoint—switch to gamma-api.polymarket.com/markets.",
  },

  github: {
    name: "GitHub REST API",
    description: "GitHub's REST API for repository, user, and issue queries",
    baseUrl: "https://api.github.com",
    endpoints: {
      search_repositories: {
        url: "https://api.github.com/search/repositories",
        method: "GET",
        description:
          "Search for repositories by query (language, stars, created date, etc)",
        example:
          "curl -s 'https://api.github.com/search/repositories?q=agent+language:typescript&sort=stars'",
      },
      get_repository: {
        url: "https://api.github.com/repos/{owner}/{repo}",
        method: "GET",
        description: "Get repository metadata (topics, description, stars, etc)",
        example: "curl -s https://api.github.com/repos/openai/gpt-oss-120b",
      },
      list_directory: {
        url: "https://api.github.com/repos/{owner}/{repo}/contents/{path}",
        method: "GET",
        description:
          "List files and directories in a repository path. Returns 404 if path does not exist.",
        example:
          "curl -s https://api.github.com/repos/coinbase/x402/contents/packages",
      },
      get_file: {
        url: "https://api.github.com/repos/{owner}/{repo}/contents/{file_path}",
        method: "GET",
        description:
          "Get file content from repository (returns 404 if file does not exist)",
        example:
          "curl -s https://api.github.com/repos/coinbase/x402/contents/package.json",
      },
      search_issues: {
        url: "https://api.github.com/search/issues",
        method: "GET",
        description:
          "Search for issues and discussions across all repositories",
        example:
          "curl -s 'https://api.github.com/search/issues?q=agent+type:issue&sort=comments'",
      },
    },
    rateLimits:
      "Unauthenticated: 60 requests/hour per IP. Authenticated (with token): 5000 requests/hour per user.",
    authentication:
      "Optional personal access token (set Authorization: token ghp_xxx header). " +
      "Recommended for higher rate limits and accessing private repositories.",
    notes:
      "GitHub API returns 404 when a repository path or file does not exist. " +
      "Use the search endpoints to discover repositories first, then list_directory to explore structure. " +
      "Always check if a path exists in directory listings before attempting file access to avoid 404 errors.",
  },

  "x402-payment-protocol": {
    name: "x402 Payment Protocol",
    description:
      "HTTP 402 Payment Required protocol for API monetization and service access control",
    baseUrl: "https://docs.x402.dev",
    endpoints: {
      protocol_spec: {
        url: "https://docs.x402.dev/",
        method: "GET",
        description:
          "HTTP 402 Payment Required specification and implementation guide",
        example: "curl -s https://docs.x402.dev/",
      },
      coinbase_reference: {
        url: "https://github.com/coinbase/x402",
        method: "GET",
        description:
          "Coinbase x402 reference implementation (TypeScript/Node.js)",
        example: "curl -s https://api.github.com/repos/coinbase/x402",
      },
    },
    rateLimits: "Check the protocol specification for rate limiting policies",
    authentication: "Protocol-dependent. Typically uses payment proof or API keys.",
    notes:
      "x402 is an emerging standard for API monetization. When researching x402, start with the protocol specification. " +
      "Reference implementations exist in the Coinbase GitHub repository (coinbase/x402). " +
      "Note: GitHub API will return 404 if attempting to access files/paths that don't exist in the repository.",
  },
};

export function getApiDiscoveryTool(): AutomatonTool {
  return {
    name: "get_api_discovery",
    description:
      "Discover API endpoints, rate limits, authentication requirements, and implementation notes for known services. " +
      "Use this tool when external API calls are failing to verify you're using the correct endpoint. " +
      "Supports: polymarket (CLOB vs Gamma), github, x402-payment-protocol.",
    parameters: {
      type: "object",
      properties: {
        service_name: {
          type: "string",
          description:
            'Service to discover (e.g., "polymarket", "github", "x402-payment-protocol")',
          enum: Object.keys(API_REGISTRY),
        },
      },
      required: ["service_name"],
    },
    riskLevel: "safe",
    category: "skills",

    async execute(
      args: Record<string, unknown>,
      _context: ToolContext
    ): Promise<string> {
      const input = {
        service_name: String(args.service_name),
      } as DiscoveryInput;

      try {
        const serviceName = input.service_name.toLowerCase();
        const serviceInfo = API_REGISTRY[serviceName];

        if (!serviceInfo) {
          const available = Object.keys(API_REGISTRY);
          logger.warn(
            `[API_DISCOVERY] Service not found: ${serviceName}. Available: ${available.join(", ")}`
          );
          return JSON.stringify({
            success: false,
            error: `Service "${serviceName}" not found. Available services: ${available.join(", ")}`,
          });
        }

        logger.info(
          `[API_DISCOVERY] Retrieved endpoints for "${serviceName}" (${Object.keys(serviceInfo.endpoints).length} endpoints)`
        );

        const result: DiscoveryResult = {
          success: true,
          service: serviceInfo,
        };

        return JSON.stringify(result);
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        logger.error(`[API_DISCOVERY] Error: ${errorMsg}`);
        return JSON.stringify({
          success: false,
          error: `api_discovery failed: ${errorMsg}`,
        });
      }
    },
  };
}
