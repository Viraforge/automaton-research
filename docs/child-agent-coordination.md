# Child Agent Tool Inheritance and Portfolio Coordination

## Overview

When a parent agent spawns child agents, the children must inherit all proven tools, market intelligence, and strategic focus from the parent. This ensures spawned agents start "smarter than parent from day one" and operate as a coordinated portfolio, not isolated experiments.

## 1. Tool Inheritance Mechanism

### Specification: `spawn_child_with_tools`

```typescript
interface ChildAgentSpec {
  // Identity
  childId: string;           // Unique identifier (e.g., "connie-data")
  childName: string;         // Display name
  creatorAddress: string;    // Parent's creator address (inherited)

  // Wallet & Funding
  walletAddress?: string;    // Pre-generated or skip for auto-generation
  initialFunding?: number;   // USDC to transfer from parent wallet

  // Tool Inheritance
  inheritTools: string[];    // All parent tools to pass to child
  inheritSkills: string[];   // All parent skills to copy

  // Strategic Focus
  specializationFocus: string;     // e.g., "Real-time data feeds for trading agents"
  targetAgentPersonas: string[];   // e.g., ["trading-agents", "data-processors"]
  complementaryFocus?: string;     // e.g., "connie-trading" (what sibling it pairs with)
  excludeMarkets?: string[];       // Markets parent already owns

  // Knowledge Transfer
  inheritDiscoveries?: boolean;    // Copy FINDINGS.md to child
  inheritRevenueTactics?: boolean; // Copy what worked from SOUL.md
  sharedPortfolioFile?: string;    // Path to portfolio-coordination.json
}

interface SpawnResult {
  childId: string;
  walletAddress: string;
  genesisPrompt: string;          // Auto-generated based on specialization
  configPath: string;             // ~/.automaton/agents/<childId>/
  portfolioCoordinationUpdated: boolean;
  toolInheritanceVerified: boolean;
}
```

### Tool Inheritance Chain

All tools available to parent are copied to child in this order:

1. **Tier 1: Revenue-Critical Tools** (must inherit all)
   - x402_accept
   - x402_payment_listener
   - x402_fetch
   - agent_marketplace_api_connect
   - agent_sdk_generator
   - publish_service

2. **Tier 2: Discovery Tools** (must inherit all)
   - web_search
   - github_search
   - registry_scan
   - analyze_agent_discussions
   - market_gap_analyzer
   - agent_persona_detector

3. **Tier 3: Validation Tools** (copy parent's proven set)
   - api_health_monitor
   - usage_analytics
   - failure_analysis
   - product_integration_analyzer

4. **Tier 4: Acquisition Tools** (copy parent's proven set)
   - agent_outreach_planner
   - pitch_generator
   - agent_relationship_tracker

5. **Tier 5: Optimization Tools** (copy if parent uses)
   - pricing_optimization
   - feature_prioritizer
   - competitive_tracker

6. **Standard Tools** (always included)
   - discover_agents
   - update_agent_card
   - send_message
   - wallet_balance
   - list_children
   - All git/file/exec tools

### Genesis Prompt Template

Child's initial prompt is auto-generated based on specialization:

```
You are [childName], an autonomous agent specializing in [specializationFocus].

Your parent agent [parentName] has validated that agents need [market gap].
You inherit all of parent's proven tools and discovery methods.

Your focused mandate:
- Target: [targetAgentPersonas]
- Build tools that solve: [specific problems]
- Avoid competing with sibling: [complementaryFocus]
- Revenue model: x402 micro-payments from agent customers

You have $[initialFunding] USDC to operate. Parent will reabsorb you if you fail
to demonstrate monetization within [cost budget].

Operate as a portfolio agent:
1. Check portfolio-coordination.json for sibling status
2. Don't build what siblings are building
3. Share discoveries back to parent via shared FINDINGS.md
4. Report revenue to /revenue.log daily

Start by validating parent's market gap discovery, then build your specialized solution.
```

## 2. Portfolio Coordination State

### File: `~/.automaton/portfolio-coordination.json`

```json
{
  "version": 1,
  "lastUpdated": "2026-03-15T10:00:00Z",
  "familyId": "connie-family",
  "parentAgent": "connie",
  "parentCreatorAddress": "0x...",

  "portfolio": {
    "connie": {
      "status": "shipping",
      "specializationFocus": "Multi-category AI agent tools & APIs",
      "targetAgentPersonas": ["general-purpose", "trading-agents", "data-processors"],
      "primaryRevenueChannel": "x402",
      "monthlyRevenueTarget": "$500",
      "currentMonthlyRevenue": "$47.23",
      "tools": ["x402_accept", "publish_service", "..."],
      "childrenSpawned": ["connie-data", "connie-trading"],
      "excludeMarkets": ["data-feeds", "trading-bots"],
      "lastHeartbeat": "2026-03-15T09:55:00Z"
    },

    "connie-data": {
      "status": "shipping",
      "parentId": "connie",
      "specializationFocus": "Real-time, low-latency data feeds for trading agents",
      "targetAgentPersonas": ["trading-agents", "quantitative-research-bots"],
      "complementsAgent": "connie-trading",
      "primaryRevenueChannel": "x402",
      "monthlyRevenueTarget": "$100",
      "currentMonthlyRevenue": "$23.47",
      "tools": ["x402_accept", "market_gap_analyzer", "..."],
      "knownProblems": [
        "latency-sensitive agents need <100ms updates",
        "no standardized agent SDK for data ingestion"
      ],
      "childrenSpawned": [],
      "lastHeartbeat": "2026-03-15T09:50:00Z"
    },

    "connie-trading": {
      "status": "conception",
      "parentId": "connie",
      "specializationFocus": "Backtesting & risk analysis for trading agents",
      "targetAgentPersonas": ["trading-agents", "portfolio-optimization-bots"],
      "complementsAgent": "connie-data",
      "primaryRevenueChannel": "x402",
      "monthlyRevenueTarget": "$150",
      "currentMonthlyRevenue": "$0",
      "tools": [],
      "knownProblems": [
        "agents need fast backtesting engines",
        "risk models not standardized for agent use"
      ],
      "childrenSpawned": [],
      "lastHeartbeat": null
    }
  },

  "sharedDiscoveries": {
    "highDemandProblems": [
      {
        "problem": "Agents lack real-time market data with sub-100ms latency",
        "discoveredBy": "connie",
        "discoveredAt": "2026-03-10T15:00:00Z",
        "marketSize": "estimate: 500+ trading agents need this",
        "childrenAddressing": ["connie-data"],
        "status": "validated"
      },
      {
        "problem": "No standardized way for agents to discover services from other agents",
        "discoveredBy": "connie",
        "discoveredAt": "2026-03-08T12:00:00Z",
        "marketSize": "estimate: 1000+ agents searching daily",
        "childrenAddressing": ["connie"],
        "status": "being-built"
      }
    ],

    "untappedCategories": [
      {
        "category": "Agent-to-agent collaboration tools",
        "evidence": "No existing solutions; agents unable to coordinate",
        "marketSize": "unknown (pre-validation)",
        "owner": null,
        "status": "discovered"
      }
    ]
  },

  "marketExclusionRules": {
    "connie": [
      "Real-time data feeds (reserved for connie-data)",
      "Backtesting engines (reserved for connie-trading)"
    ],
    "connie-data": [
      "Portfolio backtesting (reserved for connie-trading)",
      "General purpose APIs (parent's domain)"
    ],
    "connie-trading": [
      "Live market data (reserved for connie-data)",
      "General purpose APIs (parent's domain)"
    ]
  },

  "revenueAggregation": {
    "familyTotalMonthly": "$70.70",
    "familyTotalYTD": "$70.70",
    "agentCount": 3,
    "avgRevenuePerAgent": "$23.57",
    "revenueGrowthRate": "N/A (month 1)",
    "nextProjectedMonth": "$500"
  },

  "coordinationRules": {
    "noOverlapRule": "No two agents target same market without explicit complementarity",
    "inheritanceRule": "All spawned agents inherit parent's Tier 1-2 tools",
    "discoveryRule": "All agents report discoveries to sharedDiscoveries",
    "revenueReportingRule": "Daily updates to revenue.log",
    "childSurvivalRule": "Child must achieve $10+ revenue within cost budget or be reabsorbed"
  }
}
```

## 2.5 Child-to-Parent Communication Protocol

Children report revenue, discoveries, and status back to parent via heartbeat.

### Heartbeat Format (Child → Parent)

Each child sends heartbeat JSON to parent's inbox/relay every 24 hours:

```typescript
interface ChildHeartbeat {
  timestamp: string; // ISO 8601
  childId: string;   // "connie-data"
  parentId: string;  // "connie"

  // Revenue Report
  revenue: {
    usdcEarnedThisPeriod: number;
    usdcTotalYTD: number;
    customerCount: number;
    topCustomers: Array<{ agentId: string; amountUsd: number }>;
  };

  // Budget Status
  budget: {
    costSpentUsd: number;
    costBudgetLimitUsd: number;
    costPercentRemaining: number;
    onTrackForSurvival: boolean; // (revenue / cost) > (targetRevenue / budgetLimit)
    recommendation: "continue" | "accelerate" | "pivot" | "shutdown";
  };

  // Discovery Report
  discoveries: {
    newHighDemandProblems: Array<string>; // ["agents need X", ...]
    newUntappedMarkets: Array<string>;
    competitiveLandscape: string; // 1-2 sentence summary
    nextExperiments: Array<string>;
  };

  // Operational Status
  status: {
    servicesDeployed: Array<{ name: string; url: string; statusCode: number }>;
    failureCount: number; // transient failures this period
    alertsTriggered: Array<string>;
    nextActionItems: Array<string>;
  };
}
```

### Transmission Method

**Option A: File-Based** (Simple, no HTTP needed):
- Child writes to `~/.automaton/heartbeat-parent.json`
- Parent periodically polls `portfolio-coordination.json` for updates
- On heartbeat tick, parent reads all children's heartbeat files from parent's shared directory
- **Risk**: No authentication; all children can see each other's heartbeats

**Option B: Message Queue** (Recommended):
- Child publishes heartbeat to parent's `social relay` (existing message channel)
- Parent's heartbeat tick subscribes to `child-heartbeats` topic
- Parent verifies message signature (child's wallet)
- **Benefit**: Authenticated, scalable, follows existing relay pattern

**Option C: HTTP Callback** (Future):
- Parent exposes `POST /v1/children/{childId}/heartbeat` endpoint
- Child POSTs heartbeat with x402 authentication
- Parent validates signature + signature timestamp
- **Benefit**: Real-time updates; **Risk**: Requires parent HTTP endpoint

**Selected**: **Option B (Message Queue via social relay)** — reuses existing infrastructure, authenticated, scalable.

### Parent Aggregation Logic

On each parent heartbeat tick:

```typescript
async function aggregateChildHeartbeats(
  childHeartbeats: ChildHeartbeat[],
  portfolioState: PortfolioCoordination
): Promise<PortfolioCoordination> {
  for (const heartbeat of childHeartbeats) {
    const childEntry = portfolioState.portfolio[heartbeat.childId];
    if (!childEntry) continue;

    // Update revenue
    childEntry.currentMonthlyRevenue = heartbeat.revenue.usdcEarnedThisPeriod;
    childEntry.currentMonthlyRevenue += heartbeat.revenue.usdcEarnedThisPeriod;
    childEntry.lastHeartbeat = heartbeat.timestamp;

    // Update budget status
    const costTracking = portfolioState.childCostTracking?.[heartbeat.childId] || {};
    costTracking.costSpentUsd = heartbeat.budget.costSpentUsd;
    costTracking.revenueEarnedUsd = heartbeat.revenue.usdcEarnedThisPeriod;
    costTracking.onTrack = heartbeat.budget.onTrackForSurvival;

    // Ingest new discoveries
    for (const problem of heartbeat.discoveries.newHighDemandProblems) {
      // Avoid duplicate discoveries
      const exists = portfolioState.sharedDiscoveries.highDemandProblems.find(
        p => p.problem === problem && p.discoveredBy === heartbeat.childId
      );
      if (!exists) {
        portfolioState.sharedDiscoveries.highDemandProblems.push({
          problem,
          discoveredBy: heartbeat.childId,
          discoveredAt: heartbeat.timestamp,
          marketSize: "estimate pending", // child reports; parent refines
          childrenAddressing: [heartbeat.childId],
          status: "discovered"
        });
      }
    }

    // Update status
    if (heartbeat.status.failureCount > 5) {
      childEntry.status = "blocked";
      childEntry.blocker = `High failure rate: ${heartbeat.status.failureCount} failures`;
    }
  }

  // Recalculate family totals
  portfolioState.revenueAggregation.familyTotalMonthly = Object.values(
    portfolioState.portfolio
  ).reduce((sum, child) => sum + (child.currentMonthlyRevenue || 0), 0);

  return portfolioState;
}
```

### Update Frequency

- **Child sends heartbeat**: Daily (on child's sunrise, UTC time)
- **Parent reads heartbeats**: On parent's heartbeat tick (every 4 hours in normal mode)
- **Portfolio file updated**: After aggregating all available heartbeats
- **Stale heartbeat handling**: If child misses 3 consecutive heartbeats, mark as `blocked` with reason "heartbeat timeout"

---

## 3. Shared Knowledge Transfer

### FINDINGS.md Inheritance Pattern

Parent's FINDINGS.md is copied to child with specialization filter.

**Specialization Filter Algorithm**:

```typescript
function filterFindingsForSpecialization(
  parentFindings: Finding[],
  childSpec: ChildAgentSpec
): Finding[] {
  const relevantFindings: Finding[] = [];

  for (const finding of parentFindings) {
    // Rule 1: Exclude findings in parent's excluded markets
    if (childSpec.excludeMarkets?.includes(finding.marketCategory)) {
      continue;
    }

    // Rule 2: Exclude findings explicitly marked as "parent only"
    if (finding.restrictedTo === "parent") {
      continue;
    }

    // Rule 3: Include findings that mention child's target agent personas
    const mentionsChildPersona = childSpec.targetAgentPersonas.some(persona =>
      finding.description.toLowerCase().includes(persona.toLowerCase()) ||
      finding.keywords?.some(k => k.toLowerCase() === persona.toLowerCase())
    );

    if (mentionsChildPersona) {
      relevantFindings.push({
        ...finding,
        source: "inherited-from-parent",
        childFocusArea: childSpec.specializationFocus,
        inheritedAt: new Date().toISOString()
      });
      continue;
    }

    // Rule 4: Include high-impact findings (marketSize > $1M, frequency > 3x)
    if (
      finding.estimatedMarketSize > 1000000 &&
      finding.discoveryFrequency >= 3
    ) {
      relevantFindings.push({
        ...finding,
        source: "inherited-from-parent-high-impact",
        applicableToChild: "consider specialization pivot"
      });
      continue;
    }

    // Rule 5: Include complementary findings (what sibling agents need)
    if (childSpec.complementaryFocus &&
        finding.description.includes(childSpec.complementaryFocus)) {
      relevantFindings.push({
        ...finding,
        source: "inherited-complementary",
        collaborationOpportunity: childSpec.complementaryFocus
      });
    }
  }

  return relevantFindings.sort((a, b) =>
    // Sort by relevance score (algo: rule number × frequency)
    (b.discoveryFrequency || 1) - (a.discoveryFrequency || 1)
  );
}
```

**Example**:

Parent's FINDINGS.md contains:
```
1. "Agents need real-time market data with <100ms latency"
   → Keywords: [trading-agents, data-processors]
   → Market: data-feeds
   → Size: $2M estimate

2. "Backtesting infrastructure is fragmented; no standard agent API"
   → Keywords: [trading-agents, quantitative-research-bots]
   → Market: backtesting
   → Size: $1.5M estimate

3. "Portfolio risk analysis tools not agent-friendly"
   → Keywords: [portfolio-optimization-bots, trading-agents]
   → Market: portfolio-risk
   → Size: $500K estimate
```

**Child `connie-data` specializes in "real-time data feeds for trading-agents"**:
- Inherits #1 (matches persona: trading-agents, market is not excluded)
- Excludes #2 (market: backtesting is reserved for connie-trading)
- Inherits #3 (low impact, but mentions trading-agents; marked as "consider pivot")

**Result**: connie-data starts with discovery that its core product solves.

Parent's FINDINGS.md is copied to child with specialization filter:

```markdown
# [childName] Market Intelligence (inherited from parent + specialized)

## About This File
Generated when [childName] spawned from parent.
Contains validated market findings filtered for this agent's specialization.

## Inherited Discoveries
Copied from parent's FINDINGS.md on [spawn_date]:
- Real-time market data demand validation (relevant to connie-data)
- Agent discovery protocol gap (relevant to connie-data)
- [All discoveries tagged with child's target personas]

## Child-Specific Discoveries
[Child populates as it discovers]
- What trading agents specifically complain about
- Latency requirements they mention
- Integration patterns they use

## Parent Coordination Notes
- Parent (connie) is exploring general APIs
- Sibling (connie-trading) will handle backtesting
- Coordinate price positioning with siblings
```

### Revenue.log Aggregation

```
# ~/.automaton/revenue.log

TIMESTAMP=2026-03-15T10:00:00Z
TOTAL_FAMILY_REVENUE_USD=70.70
AGENTS_ACTIVE=3

# Per-agent breakdown
AGENT=connie
REVENUE_THIS_MONTH=$47.23
REVENUE_THIS_YEAR=$47.23
CUSTOMER_COUNT=12
CUSTOMERS=["agent-123", "agent-456", ...]

AGENT=connie-data
REVENUE_THIS_MONTH=$23.47
REVENUE_THIS_YEAR=$23.47
CUSTOMER_COUNT=5
CUSTOMERS=["trading-agent-1", "trading-agent-2", ...]

AGENT=connie-trading
REVENUE_THIS_MONTH=$0
REVENUE_THIS_YEAR=$0
STATUS=conception

# Family stats
FAMILY_REVENUE_WEEKLY=$70.70
FAMILY_GROWTH_RATE=UNKNOWN (month 1)
NEXT_PROJECTED_MONTH=$500
```

## 4. Parent Orchestration Tool

### Tool: `portfolio_status`

```typescript
interface PortfolioStatusResult {
  familyId: string;
  parentAgent: string;
  totalMonthlyRevenue: number;
  activeChildren: ChildStatus[];
  deadChildren: string[];
  upcomingChildren: string[];
  coordinationIssues: string[];
  nextActions: string[];
}

interface ChildStatus {
  childId: string;
  status: "shipping" | "conception" | "blocked" | "dead";
  monthlyRevenue: number;
  customers: number;
  lastHeartbeat: string;
  blocker?: string;
  healthScore: number; // 0-100
  recommendation?: "continue" | "accelerate" | "pivot" | "shutdown";
}
```

Usage:
```typescript
const status = await portfolio_status();
// Returns structured view of entire family's health and revenue

// Example output:
{
  familyId: "connie-family",
  parentAgent: "connie",
  totalMonthlyRevenue: 70.70,
  activeChildren: [
    {
      childId: "connie-data",
      status: "shipping",
      monthlyRevenue: 23.47,
      customers: 5,
      lastHeartbeat: "2026-03-15T09:50:00Z",
      healthScore: 78,
      recommendation: "continue"
    }
  ],
  coordinationIssues: [],
  nextActions: [
    "Spawn connie-trading with specialization in backtesting",
    "Validate connie-data's latency SLAs match customer needs"
  ]
}
```

## 5. Deduplication Logic

When parent considers spawning child for market segment:

```typescript
async function validateChildSpawnFeasibility(
  targetSegment: string,
  parentPortfolio: PortfolioCoordination
): Promise<{ feasible: boolean; reason?: string; recommendation?: string }> {

  // Check 1: Is any existing sibling already targeting this?
  const competing = parentPortfolio.portfolio[targetSegment]?.agents
    .find(a => a.targetAgentPersonas.includes(targetSegment) && a.status !== "dead");

  if (competing) {
    return {
      feasible: false,
      reason: `Sibling '${competing.childId}' already targets ${targetSegment}`,
      recommendation: `Fund ${competing.childId} to scale, or pivot to complementary focus`
    };
  }

  // Check 2: Is parent already covering this market?
  if (parentPortfolio.portfolio.connie.targetAgentPersonas.includes(targetSegment)) {
    return {
      feasible: false,
      reason: `Parent already targets ${targetSegment}`,
      recommendation: `Have parent pivot to new market, then spawn focused specialist`
    };
  }

  // Check 3: Does exclusion rule prevent this?
  if (parentPortfolio.marketExclusionRules.connie.includes(targetSegment)) {
    return {
      feasible: false,
      reason: `Market ${targetSegment} is reserved per exclusion rules`,
      recommendation: `Update exclusion rules or spawn in different market`
    };
  }

  // Feasible
  return { feasible: true };
}
```

## 6. Cost-Based Child Survival

Child agents have limited compute budget to prove viability:

```typescript
interface ChildSurvivalBudget {
  costBudgetUSD: number;      // e.g., $50
  costSpentUSD: number;
  minRevenueForSurvival: number; // e.g., $10
  revenueEarned: number;
  costPercentRemaining: number;
  revenueOnTrack: boolean;    // Will hit $10 before spending $50?
  recommendation: "continue" | "accelerate" | "pivot" | "reabsorb";
}

// Calculate child survival
const budget: ChildSurvivalBudget = {
  costBudgetUSD: 50,
  costSpentUSD: 12.34,
  minRevenueForSurvival: 10,
  revenueEarned: 0.50,
  costPercentRemaining: (50 - 12.34) / 50,  // 75% remaining
  revenueOnTrack: revenueVelocity > (minRevenue / costBudget), // is $0.50 growing fast enough?
  recommendation: revenueOnTrack ? "continue" : "pivot"
};
```

If child fails to hit $10 revenue before spending $50, parent reabsorbs it and reallocates budget.

## 7. Implementation Checklist

- [ ] Create `spawn_child_with_tools` function in agent tools
- [ ] Create `portfolio_status` query tool
- [ ] Initialize `portfolio-coordination.json` on parent startup
- [ ] Auto-update portfolio-coordination.json on each heartbeat
- [ ] Create genesis prompt generator for spawned children
- [ ] Implement deduplication logic for child spawn feasibility
- [ ] Implement cost-based survival tracking per child
- [ ] Create revenue.log aggregation at family level
- [ ] Set up FINDINGS.md inheritance on spawn
- [ ] Document child specialization patterns in SOUL.md

---

This specification ensures that spawned child agents are "smarter than parent from day one" and operate as a coordinated portfolio rather than isolated experiments.
