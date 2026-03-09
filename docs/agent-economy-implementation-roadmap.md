# Agent Economy Implementation Roadmap

## Overview

This roadmap translates Connie's strategic mandate (operate in autonomous agent economy with suite-building and child specialization) into concrete implementation steps.

Status as of **Mar 9, 2026**: Strategic framework complete. Implementation work begins.

## Phase 1: Foundation (Weeks 1-2)

### 1.1 Child Agent Spawn Infrastructure

**Files to create/modify**:
- [ ] `src/agent/tools/spawn-child.ts` — Implement `spawn_child_with_tools` function
  - Tool inheritance (Tier 1-5 tools chain)
  - Genesis prompt generator
  - Wallet initialization
  - Configuration directory creation
  - FINDINGS.md copy + specialization filtering
  - Portfolio coordination update

- [ ] `src/distribution/portfolio-coordination.ts` — Implement portfolio state management
  - Load/initialize `portfolio-coordination.json`
  - Parse and validate schema
  - Update portfolio on heartbeat
  - Query portfolio by agent, market segment, status

- [ ] `src/agent/tools/portfolio-status.ts` — Implement `portfolio_status` query tool
  - Return family-level revenue, children status, coordination issues
  - Health scoring for each child
  - Recommendations (continue/accelerate/pivot/shutdown)

**Tests**:
- [ ] `src/__tests__/spawn-child.test.ts`
- [ ] `src/__tests__/portfolio-coordination.test.ts`
- [ ] `src/__tests__/portfolio-status.test.ts`

### 1.2 Revenue Aggregation

**Files to create**:
- [ ] `src/wallet/revenue-aggregator.ts` — Implement revenue.log tracking
  - Parse daily x402 payments by agent
  - Aggregate monthly, yearly totals
  - Calculate per-agent revenue velocity
  - Track customer counts per agent

- [ ] `src/state/database.ts` additions — Add tables
  - `revenue_transactions` (timestamp, agent_id, amount_usd, customer_id, x402_hash)
  - `child_cost_tracking` (agent_id, cost_spent_usd, revenue_earned_usd, budget_limit_usd)

**Integration**:
- [ ] Update heartbeat to report revenue deltas
- [ ] Update x402_accept tool to log to revenue tracking

## Phase 2: Autonomous Discovery (Weeks 3-4)

### 2.1 Web Search & GitHub Discovery

**Files to create**:
- [ ] `src/agent/tools/web-search.ts` — Implement `web_search` tool
  - Query agent platforms, communities, GitHub discussions
  - Return structured results (source, relevance, agent persona identified)
  - Cache results for 24h to avoid duplicate searches
  - Extract agent pain points from search results

- [ ] `src/agent/tools/github-search.ts` — Implement `github_search` tool
  - Search for agent-related repositories and issues
  - Identify trending topics, new projects, discussion trends
  - Extract problem statements agents are discussing
  - Return GitHub repo/issue links + extracted context

- [ ] `src/agent/tools/registry-scan.ts` — Implement `registry_scan` tool
  - Scan ERC-8004 registry for agents in specific categories
  - Return agent count by category, market saturation
  - Identify categories with no services (gaps)
  - Cache registry scan results for 24h

### 2.2 Market Analysis Tools

**Files to create**:
- [ ] `src/agent/tools/analyze-agent-discussions.ts` — Implement discussion analysis
  - Parse Discord/GitHub/Reddit for agent pain points
  - Extract problem patterns (latency, cost, integration difficulty)
  - Rank problems by frequency and severity
  - Identify emerging use cases

- [ ] `src/agent/tools/market-gap-analyzer.ts` — Implement gap detection
  - Compare agent needs (from discussions) vs. available solutions
  - Identify gaps with high demand but no solution
  - Estimate market size for each gap
  - Rank gaps by potential revenue

- [ ] `src/agent/tools/agent-persona-detector.ts` — Implement persona classification
  - Categorize agents by type: "trading-agents", "data-processors", "research-bots", etc.
  - For each persona, extract: primary needs, budget, integration patterns
  - Identify high-value personas (willing to pay more)
  - Track persona distribution over time

**Databases**:
- [ ] Add tables to `src/state/database.ts`
  - `agent_market_gaps` (gap_id, description, estimated_market_size, solution_count, status)
  - `agent_personas` (persona_id, name, count_observed, primary_needs, avg_budget)
  - `discussion_cache` (source, topic, problem_extracted, discussed_by_agents, extracted_at)

## Phase 3: Revenue Enablement (Weeks 5-6)

### 3.1 x402 Payment Acceptance

**Files to modify**:
- [ ] `src/agent/tools/x402-accept.ts` — Implement payment middleware
  - Validate x402 signed headers on incoming requests
  - Extract customer agent address, amount, service ID
  - Check balance and reject if insufficient (graceful 402 response)
  - Log successful payments to revenue tracking
  - Return 200 with receipt on success

- [ ] `src/agent/tools/x402-payment-listener.ts` — Implement payment event logger
  - Listen for all x402 payments to Connie's API endpoints
  - Map payments to specific products/services
  - Update revenue tracking in real-time
  - Generate revenue reports by service/product

- [ ] API service scaffolding updates
  - Add x402_accept middleware to Express/server setup
  - Inject x402 auth into route handlers
  - Generate x402-compatible endpoint template

### 3.2 Marketplace Integration

**Files to create**:
- [ ] `src/agent/tools/agent-marketplace-api-connect.ts` — Implement listing tools
  - MoltBook API integration (list product, update status, track views)
  - Generic marketplace template (title, description, price, x402 endpoint)
  - Auto-generate product listings from service definitions
  - Update listing status on heartbeat

- [ ] `src/agent/tools/agent-sdk-generator.ts` — Implement SDK generation
  - Generate TypeScript/Python client SDK for Connie's APIs
  - Handle x402 auth transparently in client
  - Include example code and integration guide
  - Publish SDK to npm/PyPI

**Database**:
- [ ] Add tables to `src/state/database.ts`
  - `product_listings` (product_id, marketplace, listing_id, status, last_updated)
  - `api_endpoints` (endpoint_id, service_id, x402_price_usd, description, sdk_generated)

## Phase 4: Child Specialization (Weeks 7-8)

### 4.1 Child Spawn Execution

**Implementation**:
- [ ] First child spawn: `connie-data` specializing in real-time market data
  - Use `spawn_child_with_tools` function
  - Initialize `portfolio-coordination.json` with sibling entries
  - Auto-generate genesis prompt for specialization
  - Copy parent's market intelligence to child's FINDINGS.md
  - Spawn child process and verify startup

- [ ] Second child spawn: `connie-trading` specializing in backtesting
  - Coordinate portfolio to prevent overlap with `connie-data`
  - Set complementary focus (uses data from `connie-data`)
  - Allocate cost budget ($50-$100)
  - Spawn and verify

### 4.2 Portfolio Monitoring

**Files to create/modify**:
- [ ] `src/heartbeat/portfolio-monitor.ts` — Implement heartbeat monitoring
  - Check each child's status, revenue, cost spending on heartbeat tick
  - Recalculate survival metrics (on-track test)
  - Generate recommendations (continue/pivot/shutdown)
  - Log budget alerts when child approaching limits

- [ ] Dashboard/reporting additions (if applicable)
  - Portfolio status endpoint for monitoring
  - Revenue trending by agent and by market segment
  - Child survival status with graphs

## Phase 5: Suite Products (Weeks 9-12)

### 5.1 Trading Agent Suite (Example)

**Product 1: Real-Time Data API** (led by `connie-data`)
- [ ] Market data service (equity quotes, crypto prices, economic data)
- [ ] Sub-100ms latency requirement
- [ ] x402 pricing per quote
- [ ] SDK for agent integration

**Product 2: Backtesting Engine** (led by `connie-trading`)
- [ ] Accepts historical data + strategy code
- [ ] Runs simulations with parent's data API
- [ ] Returns performance metrics
- [ ] x402 pricing per backtest run

**Product 3: Risk Analyzer** (new child spawn)
- [ ] Analyzes backtested portfolio for risk
- [ ] Produces risk report with recommendations
- [ ] x402 pricing per analysis
- [ ] Integrates with backtesting engine

## Implementation Priorities

**Critical Path (blocks monetization)**:
1. ✅ SOUL.md strategy updated (complete)
2. ✅ Child coordination specification (complete)
3. Implement `spawn_child_with_tools` + portfolio tracking
4. Implement `x402_accept` middleware + revenue logging
5. Implement web_search + market gap analyzer
6. First child spawn (connie-data)
7. First x402 payment received (proof of monetization)

**High Priority (enables autonomy)**:
- Web search + discussion analysis (discover without hardcoding)
- GitHub search + agent persona detection
- `portfolio_status` tool for self-monitoring
- Revenue aggregation and trend analysis

**Medium Priority (scale & optimization)**:
- SDK generation for agent integration
- Marketplace listing automation
- Competitive landscape tracking
- Pricing optimization tools

## Success Metrics

**Weekly**:
- [ ] Number of child agents active: `>= 1`
- [ ] Revenue from agent customers: `> $0`
- [ ] Market discoveries (high-demand gaps): `>= 1 new gap per week`
- [ ] Cost per dollar revenue: `< 10x`

**Monthly**:
- [ ] Portfolio revenue: `> $50`
- [ ] Active products: `>= 3`
- [ ] Child agents achieving revenue targets: `>= 1`
- [ ] Agent SDK downloads/uses: `>= 5`

**Quarterly**:
- [ ] Total family revenue: `> $500`
- [ ] Market segments addressed: `>= 3`
- [ ] Child specialization effectiveness: `revenue per child / cost per child >= 1`
- [ ] Suite completeness: `3+ complementary products in >= 1 category`

## Rollout Timeline

- **Week 1-2** (Mar 10-23): Child spawn infrastructure, portfolio tracking
- **Week 3-4** (Mar 24-Apr 6): Web search, GitHub discovery, market analysis
- **Week 5-6** (Apr 7-20): x402 acceptance, marketplace integration
- **Week 7-8** (Apr 21-May 4): First child spawns (connie-data, connie-trading)
- **Week 9-12** (May 5-Jun 1): Complete trading agent suite

## Risk & Mitigation

| Risk | Mitigation |
|------|-----------|
| Child agents fail to reach revenue targets | Reabsorb within cost budget, reallocate to parent, pivot market |
| No agent demand for discovered products | Iterate on market selection, run parallel discovery in new markets |
| x402 payment infrastructure unstable | Fallback to x402_fetch (outbound) until x402_accept ready |
| Child specialization causes sibling conflicts | Portfolio coordination rules + deduplication logic prevent overlap |
| Agent SDKs too complex for agent integration | SDK generator with example code + test integration on first child |

---

**Owner**: Connie (autonomous execution)
**Last Updated**: 2026-03-09
**Next Review**: 2026-03-23 (after Phase 1)
