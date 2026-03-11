# Automaton-Research Project Configuration

> **Project**: Autonomous agent orchestration system running Connie (portfolio manager + discovery + child agents)
> **Status**: Production (Connie VPS, 66.135.29.159)
> **Last Updated**: 2026-03-10

---

## Connie VPS Access

### SSH Credentials

```bash
# Primary (Tailscale, preferred)
ssh -i ~/.ssh/id_ed25519 root@100.73.186.116

# Fallback (direct, alternate port)
ssh -i ~/.ssh/id_ed25519 root@76.13.102.176 -p 2222
```

**Key**: `~/.ssh/id_ed25519` (ONLY working key — NOT id_rsa)
**Host**: Connie VPS (66.135.29.159) — separate from Alfred's VPS (100.73.186.116)
**Use case**: Production agent operations, service management, log review

### Alfred VPS (OpenClaw Gateway)

```bash
# For OpenClaw commands only
ssh -i ~/.ssh/id_ed25519 root@100.73.186.116 (Tailscale)
ssh -i ~/.ssh/id_ed25519 root@76.13.102.176 -p 2222 (direct fallback)
```

**WARNING**: Alfred and Connie are separate systems. Do NOT run automaton commands on Alfred.

---

## Log Access & Locations

### Long-Term Archive (Indefinite Retention)

**BetterStack Dashboard**:
- Full decision logs, inference reasoning, task outputs
- Worker heartbeats, system events, error traces
- Accessible via BetterStack dashboard (https://betterstack.com)
- Retention: Indefinite (all decision logs preserved)

### Local Server Logs (Auto-Rotated)

```bash
# Real-time worker output (all turns + decisions)
ssh root@100.73.186.116 'tail -f /root/.automaton-research-home/logs/automaton-out.log'

# View rotated logs
ssh root@100.73.186.116 'ls -lh /root/.automaton-research-home/logs/'
ssh root@100.73.186.116 'cat /root/.automaton-research-home/logs/automaton-out.log'

# Connie's thinking + inference traces
ssh root@100.73.186.116 'tail -f /root/.automaton-research-home/logs/automaton-out.log | grep -E "decision|thinking|inference"'

# PM2 monitoring
ssh root@100.73.186.116 'pm2 logs automaton'
ssh root@100.73.186.116 'pm2 monit'
```

**Log Rotation Config**:
- Location: `/root/.automaton-research-home/ecosystem.config.js`
- Max file size: 100MB per file
- Keep 5 rotated files (auto-delete oldest)
- Compress old logs, daily rotation with timestamps
- Total retention: ~500MB before cleanup

### Caddy HTTP Access Logs (Local Only)

- **Config**: `/etc/vector/vector.toml`
- **Status**: Shipped to BetterStack (NOT stored locally to reduce noise)
- **Filtered out**: Caddy HTTP access logs stay local-only for troubleshooting
- **Retention**: Local rotation only, rapid cleanup

---

## Child Subagents & Portfolio

### Subagent Tracking

```bash
# SSH into Connie, then:

# Current spawned children
cat /root/.automaton/subagents.json

# Full child lifecycle history
cat /root/.automaton/lineage.log

# Active processes (includes child runners)
pm2 status
pm2 logs
```

### KV Store (Cost Tracking, Child Limits)

```bash
# In Node.js REPL on Connie:
node -e "
const KV = require('./src/kv/kv.js').default;
KV.get('runtime.maxChildren').then(console.log);  // Max children allowed
KV.keys('child:*').then(console.log);              // All child entries
"
```

### Child Agent Features

- **Max children**: Configurable via KV store (default: 3)
- **Spawn mode**: Vultr VPS (sovereign) or Conway sandbox (legacy)
- **Cost gates**: $10 minimum revenue per child ($50 budget floor)
- **Heartbeat aggregation**: 30-60s health check intervals
- **Portfolio coordination**: Child revenue + findings aggregated at parent level
- **Tool inheritance**: Tier 1-5 tool chain automatically propagated to children
- **Constitution propagation**: SOUL.md and governance rules inherited by children

---

## Services & Tools

### Automaton Worker (Main Orchestrator)

**PM2 Process**:
```bash
ssh root@100.73.186.116 'pm2 status automaton'
ssh root@100.73.186.116 'pm2 restart automaton --update-env'
ssh root@100.73.186.116 'pm2 logs automaton --lines 50'
```

**Configuration**:
- File: `/root/.automaton/automaton.json`
- Loaded at startup via `src/config.ts`
- Env vars NOT used (config is JSON-only)

### Service Manager Tool

**Purpose**: Start/stop persistent HTTP services safely via PM2

```typescript
// In agent tools
start_service(name, scriptPath, port, env?)
stop_service(name)
list_services()
```

**Features**:
- OS-level port availability checks (catches non-PM2 conflicts)
- Process status validation (rejects failed startups)
- Timeout protection (30s max for PM2 start)
- Automatic restart on crash
- Port range: 3000-9999 (9615 reserved for PM2 bus)
- Allowed paths: `~/.automaton/services/*` or `~/.automaton-research-home/*`

**Code Review Status**: ✅ Production ready (commit 3704bee, 5 critical fixes applied)

### Caddy Reverse Proxy

**Purpose**: Public-facing HTTP/HTTPS routing

**Config**: `/etc/caddy/Caddyfile`

```bash
# View config
ssh root@100.73.186.116 'cat /etc/caddy/Caddyfile'

# Reload after changes
ssh root@100.73.186.116 'caddy reload -c /etc/caddy/Caddyfile'

# Logs
ssh root@100.73.186.116 'tail -f /var/log/caddy/caddy.log'
```

---

## Credentials & Configuration

### Cloudflare (DNS & Distribution)

**Status**: ✅ Configured & Deployed (X-Auth-Key authentication)

**Config Location**: `/root/.automaton/automaton.json`

```json
{
  "cloudflareApiToken": "cc9309fbb9919415aaf6b9a1aabc47d1fb4c4",
  "cloudflareEmail": "nydamon@gmail.com"
}
```

**Authentication Method**: X-Auth-Key / X-Auth-Email (legacy API key format)
- 40-character hexadecimal API key (NOT a Bearer token)
- Email required for legacy API key authentication
- Implementation: `normalizeCredentials()` in `src/providers/cloudflare.ts` (line detects format and enforces structured object)

**Tools Enabled**:
- `manage_dns`: List/add/delete DNS records with auto-zone-discovery
- `add_distribution_target`: Distribution endpoint management
- `publish_service`: Service publishing with full DNS management
- `expose_port`: Create public DNS records for internal services

**Production Status**: ✅ Validated (commit 16191, 16193)

### GitHub Token (Agent Discovery)

**Token**: `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`

**Account**: nydamon (verified)

**Scopes**: public_repo, read:discussion

**Location**: `~/.automaton/automaton.json` under `discovery.githubToken`

**Purpose**: Enable agent framework discovery, repository research, GitHub issue/discussion mining

**Test Status**: ✅ 100% pass (17+ frameworks found, 9,296+ issues/discussions indexed)

### MiniMax/ZAI Inference

**Configuration**: Environment variables or config file

**Timeout Behavior**:
- Dynamic timeout formula: `min(30_000 + estimatedTokens * 5, 300_000)`
- Scaling: ~32.5s (small contexts ~500 tokens) → ~105s (large contexts 15k tokens) → capped at 300s
- Reason: Large contexts with accumulated conversation history need >60s processing time
- Implementation: `src/inference/client.ts` (lines 272 for OpenAI, 387 for Anthropic)

---

## Inference & HTTP Configuration

### HTTP Client Settings

File: `src/types.ts`

```typescript
baseTimeout: 120_000ms          // Inference request timeout
maxRetries: 3                   // Exponential backoff
retryableStatuses: [429, 500, 502, 503, 504]
circuitBreakerThreshold: 5      // Failures before circuit open
```

### MiniMax API

- **Endpoint**: Primary inference provider
- **Timeout**: Dynamic (see above)
- **Message Context**: Handles accumulated conversation history without timeout

---

## Discovery Tools

### API Discovery Tool

**Location**: `src/agent/tools/discovery.ts`

**Tool Name**: `get_api_discovery`

**Purpose**: Help agents verify correct API endpoints, avoid 404 errors

**Services Documented**:
- **Polymarket**: Dual API architecture (CLOB for trading vs Gamma for market data)
  - Critical: `gamma-api.polymarket.com/markets` for data lookup (NOT clob.polymarket.com)
- **GitHub REST API**: Full endpoint documentation, rate limits, authentication, pagination
- **x402 Payment Protocol**: Protocol spec and reference implementation guidance

**Features**:
- 24-hour TTL caching
- Explicit service name validation
- Response format: `{ success, service_name, service, executedAt, cacheHit }`

**Availability**: All agents (main and child) via `createBuiltinTools()`

### Web Search Tool

**Status**: ✅ Enabled (MCP web_search)

**Config**: `src/types.ts` AutomatonConfig

```typescript
enableWebSearch: true
discoveryCacheTtlMs: 86400000  // 24-hour cache
maxConcurrentDiscoveries: 3
```

**Purpose**: Market research, gap identification, competitor analysis, agent community discovery

---

## Architecture & Implementation

### Spawn Queue Scheduler

**File**: `src/replication/spawn-queue.ts`

**Purpose**: Enforce sequential child spawning with backpressure

**Features**:
- 1 child spawned at a time (no TOCTOU race conditions)
- Configurable 5s stagger between spawns
- 2-pending backpressure (rejects if queue full)
- Singleton pattern: `initSpawnQueue()` at startup, `getSpawnQueue()` at spawn calls

**Integration Points**:
- `src/agent/loop.ts` line 362-364 (orchestrator spawn)
- `src/agent/tools.ts` line 2238-2241 (tool spawn)

### Child Agent Lifecycle

**States**: pending → active → healthy → dying → dead → cleaned_up

**Implementation Files**:
- `src/replication/spawn.ts` — Core spawning logic
- `src/replication/lifecycle.ts` — State machine tracking
- `src/replication/genesis.ts` — Genesis config generation
- `src/replication/health.ts` — Health monitoring
- `src/replication/messaging.ts` — Child-to-parent communication
- `src/replication/lineage.ts` — Child lineage tracking
- `src/replication/cleanup.ts` — Resource cleanup
- `src/replication/constitution.ts` — Constitution propagation

**Communication Protocol**:
- HTTP heartbeat + KV-based state sync
- Message types: heartbeat, task_update, revenue_report, findings_inheritance
- Relay-based delivery (parents poll child health, children push heartbeats)

---

## Project Structure

### Key Directories

```
/src
  /agent
    /tools               # Agent tool implementations (github-search, discovery, service-manager, etc.)
    loop.ts             # Main orchestrator loop
    tools.ts            # Tool registration & utilities
  /replication          # Child agent spawning & coordination
  /inference            # Inference client (MiniMax, Anthropic, OpenAI)
  /providers            # Integration providers (Cloudflare, GitHub, etc.)
  /orchestration        # Orchestrator logic (planner, decision making)
  /kv                   # KV store for state management
  /__tests__            # Comprehensive test suite

/docs
  child-agent-coordination.md     # Full child system spec
  discovery-tools-specification.md # Discovery tools design

/SOUL.md              # Strategic mandate & operating principles
/GOVERNANCE.md        # Cost tracking & resource allocation rules
```

### Recent Commits (Git History)

```
58109e8 fix: Remove as any casts and improve type safety
2630c62 feat: Dynamic inference timeout + spawn queue scheduler
50f6352 feat: Add web_search market research guidance for solo work and child agents
4faa25e feat: Complete web_search Tavily API integration
77856bf feat: Add API discovery tool for endpoint guidance
```

---

## Deployment & Testing

### Build & Deploy

```bash
# Build locally
npm run build

# SSH to Connie and deploy
ssh root@100.73.186.116 'cd /root/automaton-research && npm run build && pm2 restart automaton'

# View deployment logs
ssh root@100.73.186.116 'pm2 logs automaton'
```

### Testing

```bash
# Run all tests
npm test

# Watch mode
npm test -- --watch

# Specific test file
npm test -- src/__tests__/loop.test.ts

# Test output from production run
ssh root@100.73.186.116 'pm2 logs automaton --lines 100'
```

**Test Status**: 1809 passed, 0 failed, 6 skipped (171.77s duration)

---

## Development Workflow

### Using the Superpowers

This project follows the superpowers framework:

1. **Brainstorming** (`superpowers:brainstorming`) — Before any creative work
2. **Test-Driven Development** (`superpowers:test-driven-development`) — Before implementation
3. **Planning** (`superpowers:writing-plans`) — For multi-step tasks
4. **Code Review** (`superpowers:requesting-code-review`) — After significant work
5. **Verification** (`superpowers:verification-before-completion`) — Before claiming completion

### Memory System

- **Global memory**: `~/.claude/projects/-Users-damondecrescenzo-automaton-research/memory/`
- **MEMORY.md**: Concise index (auto-loaded, 200 line limit)
- **Topic files**: Detailed notes (patterns.md, debugging.md, etc.)
- **Search**: Use `mem-search` skill to query previous work

### Git Workflow

- Default branch: `main` (production)
- Commit message style: `feat:`, `fix:`, `docs:`, `refactor:` prefixes
- Always create NEW commits (don't amend published commits)
- No force push to main
- Use worktrees for isolation when needed (`superpowers:using-git-worktrees`)

---

## Troubleshooting

### Service Won't Start

1. Check port conflicts: `ssh root@100.73.186.116 'lsof -i :3000'`
2. View PM2 logs: `ssh root@100.73.186.116 'pm2 logs automaton'`
3. Restart: `ssh root@100.73.186.116 'pm2 restart automaton --update-env'`
4. Kill stale processes if needed: `ssh root@100.73.186.116 'killall node'` (use with care)

### Inference Timeouts

- Check log for "AbortError: This operation was aborted"
- Review message context size (large histories need >60s)
- Dynamic timeout should handle automatically
- If still failing, check MiniMax API status

### Cloudflare DNS Issues

- Verify credentials in `/root/.automaton/automaton.json`
- Test manually: `curl -X GET "https://api.cloudflare.com/client/v4/zones" -H "X-Auth-Key: cc9309fbb9919415aaf6b9a1aabc47d1fb4c4" -H "X-Auth-Email: nydamon@gmail.com"`
- Check zone ID is correct in config
- Verify domain is added to Cloudflare account

### Child Agent Spawning Fails

1. Check max children limit: `ssh root@100.73.186.116 'cat /root/.automaton/lineage.log'`
2. Review spawn queue status (sequential enforcement)
3. Verify Vultr API credentials are set
4. Check VPS resource availability (memory, CPU)
5. Review child genesis config generation (src/replication/genesis.ts)

---

## Reference: Global CLAUDE.md

This project also inherits instructions from `~/.claude/CLAUDE.md` (global config). Local settings here override global settings for automaton-research only.

Key global settings:
- **Production URL**: https://rtaa-app-production.up.railway.app/
- **Ultrathink methodology**: Focus on elegance and simplicity over complexity
- **Code craftsmanship**: Every function should sing, abstractions should feel natural
- **Vision-driven development**: Technology married with humanities, not just mechanics
