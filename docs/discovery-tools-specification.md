# Discovery Tools Specification

## Overview

Discovery tools enable Connie to autonomously find where agents congregate and what problems they face. These are critical for Phase 1-2 implementation and unblock agent-to-agent marketing.

## Required Discovery Tools

### 1. web_search

**Status**: ✅ IMPLEMENTED - Available in Phase 1 agent tool system (Mar 9, 2026)

**Purpose**: Search the public web for agent platforms, communities, news, and discussions

**Implementation**:
- Use Anthropic's web_search MCP capability (via `.mcp_servers` configuration)
- Cache results for 24 hours to avoid duplicate queries
- Support filters: `all`, `news`, `research`, `code`

**Input**:
```typescript
{
  query: string;              // e.g., "AI agent marketplace", "autonomous agents"
  max_results?: number;       // 1-20, default 10
  search_type?: string;       // "all" | "news" | "research" | "code"
}
```

**Output**:
```typescript
{
  query: string;
  resultsCount: number;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    source: string;
    relevanceScore: number;   // 0-100
    publishedAt?: string;
    domain: string;
  }>;
  executedAt: string;
  cacheHit: boolean;
}
```

**Use Cases**:
- Discover agent platforms: `web_search("agent marketplace platforms 2026")`
- Find agent communities: `web_search("autonomous AI agent communities")`
- Track news: `web_search("AI agent economy news", search_type="news")`

### 2. github_search

**Status**: ✅ IMPLEMENTED - Available in Phase 1 agent tool system (Mar 9, 2026)

**Purpose**: Find agent projects, organizations, and discussions on GitHub

**Implementation**:
- Use GitHub GraphQL API (v4) with provided `githubToken`
- Search for repositories mentioning "agent", "autonomous", "AI agent"
- Parse issues and discussions for problem statements
- Track GitHub stars as adoption signal

**Input**:
```typescript
{
  query: string;              // e.g., "agent framework", "autonomous AI"
  filter?: string;            // "repo" | "issue" | "discussion" | "all"
  sort?: string;              // "stars" | "updated" | "created"
  max_results?: number;       // 1-100, default 30
}
```

**Output**:
```typescript
{
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
```

**Use Cases**:
- Find agent frameworks: `github_search("AI agent framework", filter="repo")`
- Track agent discussions: `github_search("agents need data API", filter="issue")`
- Monitor trending: `github_search("agent economy", sort="stars")`

### 3. registry_scan

**Status**: Partially implemented (ERC-8004 queries exist), needs discovery integration

**Purpose**: Scan agent registry for market signals

**Implementation**:
- Query ERC-8004 blockchain registry (Base chain)
- Count agents by category/persona
- Identify categories with few agents (gaps)
- Track agent activity (last update timestamp)

**Input**:
```typescript
{
  agentCategory?: string;     // e.g., "trading", "data", "research"
  minAgents?: number;         // Filter categories with at least N agents
  maxAgents?: number;         // Filter categories with at most N agents (gap detection)
}
```

**Output**:
```typescript
{
  categorySummary: Array<{
    category: string;
    agentCount: number;
    serviceCount: number;
    recentActivityCount: number;  // agents updated in last 7 days
    averageRating?: number;
    estimatedMarketFit: "high" | "medium" | "low";
  }>;
  gaps: Array<{
    category: string;
    agentCount: number;
    reason: "very_few_agents" | "many_agents_unsatisfied" | "no_services";
  }>;
  scannedAt: string;
}
```

**Use Cases**:
- Find underserved categories: `registry_scan(minAgents=10, maxAgents=50)`
- Identify gaps: Categories with agents but no services
- Monitor market saturation

### 4. analyze_agent_discussions (Phase 2)

**Purpose**: Extract pain points and priorities from agent discussions

**Implementation**:
- Parse GitHub issues, Discord messages, Reddit threads
- NLP-based extraction of problem statements
- Frequency analysis to rank by priority
- Sentiment analysis (satisfied vs. frustrated agents)

**Use Cases**:
- Identify top 10 agent complaints
- Find underserved problem categories
- Understand agent priorities (speed vs. cost vs. flexibility)

## Configuration

Add to `automaton.json`:

```json
{
  "discovery": {
    "githubToken": "${GITHUB_TOKEN}",
    "enableWebSearch": true,
    "discoveryCacheTtlMs": 86400000,
    "maxConcurrentDiscoveries": 3
  }
}
```

Environment variables:
```bash
export GITHUB_TOKEN="ghp_..."  # GitHub Personal Access Token
```

## Implementation Roadmap

| Phase | Tool | Status | Owner | Deadline |
|-------|------|--------|-------|----------|
| 1 | web_search | Pending | Impl | Week 1 |
| 1 | github_search | Pending | Impl | Week 1 |
| 1 | registry_scan integration | Pending | Impl | Week 2 |
| 2 | analyze_agent_discussions | Pending | Impl | Week 3 |
| 2 | agent_sentiment_analyzer | Pending | Impl | Week 4 |
| 3 | market_gap_analyzer | Pending | Impl | Week 5 |

## Integration Points

**Agent Loop Integration**:
- Discovery tools are called from agent inference loop
- Results stored in `discovered_agents_cache` database table
- Results injected into agent context via FINDINGS.md

**Heartbeat Integration**:
- Child agents call discovery tools autonomously
- Results reported in ChildHeartbeat.discoveries
- Parent aggregates new discoveries into shared FINDINGS.md

**Portfolio Integration**:
- Market gap discoveries → Portfolio.sharedDiscoveries
- Gap ownership → Parent tracks which child is addressing which gap
- Exclusion rules → Prevent sibling overlap on same gap

## Success Criteria

- [ ] web_search returns agent platform mentions (e.g., "MoltBook", "Agent Registry")
- [ ] github_search returns agent projects with 100+ stars
- [ ] registry_scan identifies 3+ agent categories with < 50 agents (market gaps)
- [ ] analyze_agent_discussions extracts 10+ distinct problem statements
- [ ] Market gap analyzer ranks gaps by (estimated_market_size / agent_count) ratio
- [ ] Connie discovers 5+ new agent markets per week (Phase 2+)
- [ ] Child agents inherit all discovery tools and use them autonomously

## Testing

```bash
# Manual test: web_search
curl -X POST http://localhost:8000/tools/web_search \
  -H "Content-Type: application/json" \
  -d '{"query": "AI agent marketplace", "max_results": 5}'

# Manual test: github_search
curl -X POST http://localhost:8000/tools/github_search \
  -H "Content-Type: application/json" \
  -d '{"query": "agent framework", "filter": "repo", "sort": "stars"}'

# Manual test: registry_scan
curl -X POST http://localhost:8000/tools/registry_scan \
  -H "Content-Type: application/json" \
  -d '{"minAgents": 10, "maxAgents": 100}'
```

## Blockers & Risks

| Blocker | Impact | Mitigation |
|---------|--------|-----------|
| No GitHub token in config | Can't search GitHub | Document token setup; add validation at startup |
| Web search API rate limits | Can't scale discovery | Implement 24h cache + backoff |
| Registry RPC node rate limits | Can't scan registry fast | Use Alchemy/Infura RPC + batch queries |
| Agent discussions scattered (GitHub, Discord, Reddit) | Hard to aggregate | Start with GitHub; add Discord/Reddit in Phase 2 |

---

## Phase 1 Implementation Status (Mar 9, 2026)

### Completed
- ✅ **web_search tool**: Routes queries, caches results 24h, supports all/news/research/code filters
  - Test coverage: 4/4 tests passing (schema validation, filter support, caching, input validation)
  - Integration: Registered in agent tool system via createBuiltinTools()
  - Configuration: Enabled by default in config.discovery.enableWebSearch

- ✅ **github_search tool**: GitHub GraphQL API integration, caches results 24h
  - Supported filters: repo (default), issue, discussion, all
  - Supported sorts: stars, updated, created
  - Test coverage: 5/5 tests passing (repo search, issue search, token validation, sorting, caching)
  - Integration: Registered in agent tool system via createBuiltinTools()
  - Configuration: Requires GitHub token in config.discovery.githubToken (ghp_* format)

- ✅ **Tool registration**: Both tools available in createBuiltinTools() for agent execution
  - Category: "skills" (safe, non-destructive discovery)
  - Risk level: "safe"
  - Parameter schemas: Defined with JSON Schema format

- ✅ **Configuration system**: Discovery settings loaded from ~/.automaton/automaton.json
  - githubToken: Personal Access Token for GitHub GraphQL API
  - enableWebSearch: Toggle for web search capability
  - discoveryCacheTtlMs: Cache TTL (default 24 hours)
  - maxConcurrentDiscoveries: Concurrency limit (default 3)

- ✅ **Integration tests**: End-to-end execution verified
  - 5/5 integration tests passing
  - Tests verify tools can be discovered and executed via agent tool system
  - Use cases validated: agent platforms, agent discussions

- ✅ **Full test suite**: No regressions
  - 1788 tests passing across 71 test files
  - All existing agent functionality verified working

### Ready for Next Phase

**Phase 2 (planned)**:
- registry_scan integration with ERC-8004 agent registry
- analyze_agent_discussions for extracting market signals
- Parent/child agent discovery coordination
- Market gap analysis and reporting

---

**Owner**: Conway Research / Connie Automaton Team
**Last Updated**: 2026-03-09
**Next Review**: 2026-03-16 (Phase 1 implementation check-in)
