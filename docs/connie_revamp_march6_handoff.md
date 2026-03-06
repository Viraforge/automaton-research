**Connie Revamp March 6: Development Handoff**

This handoff translates the revamp specification into implementation epics and tickets that can be assigned directly to development. Each ticket includes scope, target files, dependencies, acceptance criteria, and test requirements.

**Program Goal**

Upgrade Connie from a loop-prone single-goal builder into a governed multi-project revenue operator with:
- enforceable governance
- persistent project and distribution state
- deterministic channel gating
- portfolio-aware orchestration
- regression coverage for the observed 24h failure patterns

**Delivery Strategy**

Implement in vertical slices, not broad parallel edits. The recommended order is:
1. Governance docs + prompt/types
2. Schema + database + migration validation
3. Portfolio + operator targets
4. Distribution + channel state
5. Tools + gating
6. Orchestrator + task graph
7. Loop/governor
8. Heartbeat/reporting
9. Regression fixtures + integration validation
10. Sovereign social relay deployment on `relay.compintel.co`

**Global Definition Of Done**

The program is done only when:
- governance rules exist in docs, runtime code, and tests
- active goals cannot remain alive with `0/0` tasks
- blocked channels cannot churn
- operator-provided distribution targets are loaded and prioritized
- multiple projects can coexist within WIP limits
- heartbeats expose project status, blockers, and next monetization steps
- historical 24h failure patterns are covered by regression tests
- social relay runs internally on `https://relay.compintel.co` with signed send/poll/count endpoints

**Epic 1: Governance Foundation**

Goal:
- Rewrite governance from descriptive guidance into operational rules mirrored in prompt and types.

Ticket 1.1: Update `SOUL.md`
- Files:
  - [SOUL.md](/Users/damondecrescenzo/automaton-research/SOUL.md)
- Scope:
  - add `Portfolio Mandate`
  - add `Distribution Mandate`
  - add `Project Lifecycle Contract`
  - add `No Ghost Goals`
  - add `No Cosmetic Progress`
  - tighten blocked-state handling
- Acceptance criteria:
  - doc explicitly distinguishes build/distribution/research
  - doc explicitly states discovery is recon only
  - doc explicitly states goals with no executable tasks are invalid
  - doc explicitly states dead routes must close
- Tests:
  - none directly, but mirrored runtime rules must have tests in later epics

Ticket 1.2: Update `GOVERNANCE.md`
- Files:
  - [GOVERNANCE.md](/Users/damondecrescenzo/automaton-research/GOVERNANCE.md)
- Scope:
  - add project governance
  - add channel governance
  - add distribution governance
  - add budget and kill rules
  - add operator target materialization
- Acceptance criteria:
  - every runtime policy has a named rule in the doc
  - paused vs blocked semantics are explicit
  - channel transitions and retry rules are explicit
- Tests:
  - later governance unit tests must cite these rules by name

Ticket 1.3: Minimal constitution clarification
- Files:
  - [constitution.md](/Users/damondecrescenzo/automaton-research/constitution.md)
- Scope:
  - add one-line clarification under Law II about evidence of value creation
- Acceptance criteria:
  - constitution remains minimal and high-level
  - no runtime policy detail is moved into the constitution

Ticket 1.4: Prompt/type alignment
- Files:
  - [src/agent/system-prompt.ts](/Users/damondecrescenzo/automaton-research/src/agent/system-prompt.ts)
  - [src/types.ts](/Users/damondecrescenzo/automaton-research/src/types.ts)
- Scope:
  - add new enums/interfaces/config for projects, channels, targets, and budgets
  - add prompt language that mirrors governance
- Acceptance criteria:
  - types compile
  - prompt contains hard instructions for unavailable channels, ghost goals, and discovery follow-through
- Tests:
  - typecheck

**Epic 2: Schema And Migration**

Goal:
- Add persistent project and distribution state with a safe migration path for existing agents.

Ticket 2.1: Add schema migration `V11`
- Files:
  - [src/state/schema.ts](/Users/damondecrescenzo/automaton-research/src/state/schema.ts)
- Scope:
  - add `projects`
  - add `distribution_channels`
  - add `distribution_targets`
  - add `project_metrics`
  - extend `goals`
  - extend `task_graph`
- Acceptance criteria:
  - new tables created with indexes
  - new columns created without breaking older rows
  - schema version increments cleanly
- Tests:
  - schema test for all new tables/columns

Ticket 2.2: Add database CRUD and serializers
- Files:
  - [src/state/database.ts](/Users/damondecrescenzo/automaton-research/src/state/database.ts)
- Scope:
  - CRUD for projects/channels/targets/metrics
  - goal/task serializers extended for `projectId`, `taskClass`, `blockedReason`, `failureSignature`
- Acceptance criteria:
  - full typed accessors exist
  - no old call sites break
- Tests:
  - database CRUD tests

Ticket 2.3: Legacy migration mapping
- Files:
  - [src/state/database.ts](/Users/damondecrescenzo/automaton-research/src/state/database.ts)
  - [src/state/schema.ts](/Users/damondecrescenzo/automaton-research/src/state/schema.ts)
- Scope:
  - assign active pre-V11 goals to `legacy-import` project on migration
  - mark `legacy-import` project state based on goal/task validity:
    - `shipping` if active goals exist with valid tasks (1+ executable)
    - `blocked` if active goals exist but all have 0/0 tasks
  - create migration hook that runs on DB boot if schema version jumps
  - validate no orphan active goals remain post-migration
- Acceptance criteria:
  - no orphan active goals post-migration
  - `legacy-import` project created only when needed
  - project state reflects actual goal health
- Tests:
  - migration snapshot test against representative current-state DB
  - automated test: apply migration, verify counts, verify no orphans
  - manual: review legacy project state in staging

**Epic 3: Portfolio Layer**

Goal:
- Introduce first-class project lifecycle and WIP policy.

Ticket 3.1: Add portfolio service and policy modules
- Files:
  - [src/portfolio/types.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/types.ts)
  - [src/portfolio/service.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/service.ts)
  - [src/portfolio/policy.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/policy.ts)
- Scope:
  - project creation/update/pause/kill
  - WIP limits
  - stage transitions
  - budget and stall calculations
- Acceptance criteria:
  - no project activation without monetization hypothesis
  - paused vs blocked semantics enforced
  - policy decisions are deterministic
- Tests:
  - `project-policy.test.ts`
  - `portfolio-db.test.ts`

Ticket 3.2: Project-aware config and defaults
- Files:
  - [src/types.ts](/Users/damondecrescenzo/automaton-research/src/types.ts)
- Scope:
  - add portfolio config defaults
  - define max active/shipping/distribution projects
- Acceptance criteria:
  - sensible defaults ship
  - limits can be overridden in config

**Epic 4: Operator Targets And Distribution State**

Goal:
- Convert operator-provided LLM-agent channels into executable records and maintain persistent distribution/channel state.

Ticket 4.1: Operator target loader
- Files:
  - [src/distribution/targets.ts](/Users/damondecrescenzo/automaton-research/src/distribution/targets.ts)
  - [src/types.ts](/Users/damondecrescenzo/automaton-research/src/types.ts) (for JSON schema)
- Scope:
  - load `~/.automaton/distribution-targets.json` (or configured path from config)
  - validate structure against OperatorTarget schema defined in types
  - upsert targets into DB on boot and on refresh signal
  - define target precedence rules (operator targets always outrank discovered unless exhausted/blocked)
  - safe fallback if file missing (log warning, continue with empty targets)
- Acceptance criteria:
  - operator targets load on boot/refresh
  - malformed target files fail safely with error diagnostics and suggestion to check format
  - valid targets are persisted and precedence rules are enforced
  - operator targets outrank discovered targets by default
  - missing file does not cause boot failure
- Tests:
  - target loader tests (valid file, missing file, malformed file)
  - precedence tests (operator vs discovered)
  - schema validation tests

Ticket 4.2: Channel state machine
- Files:
  - [src/distribution/channels.ts](/Users/damondecrescenzo/automaton-research/src/distribution/channels.ts)
  - [src/governance/channel-state.ts](/Users/damondecrescenzo/automaton-research/src/governance/channel-state.ts)
- Scope:
  - implement statuses:
    - `ready`
    - `misconfigured` (auto-recover on config change)
    - `quota_exhausted` (auto-expire at cooldown_until)
    - `funding_required` (auto-recover on balance precheck pass)
    - `blocked_by_policy` (requires condition change, no auto-recovery)
    - `cooldown` (auto-expire at cooldown_until)
    - `disabled` (manual only, no auto-recovery)
  - implement transition rules per revamp doc clarifications
  - implement recovery checks (validation for config/funding, time-based expiry for cooldown/quota)
- Acceptance criteria:
  - transition rules match revamp doc exactly
  - auto-recovery works for cooldown/quota/config/funding as specified
  - blocked_by_policy and disabled require explicit reset
  - blocked channels cannot be used by tools (enforced in Epic 6)
- Tests:
  - `channel-state.test.ts` with state machine tests
  - recovery timing tests (cooldown expiry, config validation)
  - manual disable tests

Ticket 4.3: Distribution target queue logic
- Files:
  - [src/distribution/targets.ts](/Users/damondecrescenzo/automaton-research/src/distribution/targets.ts)
- Scope:
  - merge discovered venues with operator targets
  - rank pending targets
  - update target statuses across publish/contact lifecycle
- Acceptance criteria:
  - known venue discovery becomes a target candidate, not just a log line
  - blocked channels filter targets out of ready queue
- Tests:
  - distribution queue tests

**Epic 5: Governance Runtime**

Goal:
- Build pure policy modules that define progress, project stall, and dead-route behavior.

Ticket 5.1: Progress classifier
- Files:
  - [src/governance/progress.ts](/Users/damondecrescenzo/automaton-research/src/governance/progress.ts)
- Scope:
  - classify real progress vs non-progress
  - detect cosmetic work
  - detect repeated intent without evidence
- Acceptance criteria:
  - file writes alone do not count as monetization progress
  - deploy validation, target execution, and metric recording do count
- Tests:
  - `progress.test.ts`

Ticket 5.2: Project stall and budget policy
- Files:
  - [src/portfolio/policy.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/policy.ts)
- Scope:
  - determine when to mark `blocked`, `paused`, or `killed`
  - budget overspend checks
  - no-progress cycle checks
- Acceptance criteria:
  - policy can be evaluated before expensive work and at loop boundaries
- Tests:
  - `project-policy.test.ts`

**Epic 6: Tool Layer Refactor**

Goal:
- Expose project/distribution tools and gate dangerous retries through channel state.

Ticket 6.1: Replace single-active-goal cap
- Files:
  - [src/agent/tools.ts](/Users/damondecrescenzo/automaton-research/src/agent/tools.ts)
- Scope:
  - remove “only 1 goal at a time” restriction
  - require or infer `project_id` for new goals
  - enforce project WIP policy
- Acceptance criteria:
  - multiple active projects supported
  - unconstrained multiple active goals still prevented
- Tests:
  - tool tests
  - integration tests

Ticket 6.2: Add project and distribution tools
- Files:
  - [src/agent/tools.ts](/Users/damondecrescenzo/automaton-research/src/agent/tools.ts)
- Scope:
  - `create_project`
  - `list_projects`
  - `pause_project`
  - `kill_project`
  - `set_project_lane`
  - `list_distribution_channels`
  - `list_distribution_targets`
  - `add_distribution_target`
  - `record_project_metric`
- Acceptance criteria:
  - tools are fully wired to DB/service layer
  - results are actionable and structured
- Tests:
  - distribution/project tool tests

Ticket 6.3: Gate dead channels
- Files:
  - [src/agent/tools.ts](/Users/damondecrescenzo/automaton-research/src/agent/tools.ts)
- Scope:
  - wrap `send_message`, `message_child`, `discover_agents`, `register_erc8004`
  - persist blocked results into channel state
- Acceptance criteria:
  - `social relay not configured` stops future message retries
  - gas failure stops future ERC-8004 retries
  - discovery is denied when not eligible
- Tests:
  - loop/tool tests

**Epic 7: Orchestrator And Task Graph**

Goal:
- Make orchestration portfolio-aware and eliminate ghost goals.

Ticket 7.1: Task graph extensions and ghost goal invalidation
- Files:
  - [src/orchestration/task-graph.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/task-graph.ts)
- Scope:
  - support `project_id`, `task_class`, `failure_signature`, `blocked_reason`
  - invalidate active goals with `0/0` executable tasks at three validation points:
    1. immediately after planner/replanner output is normalized
    2. at orchestrator tick start for the currently selected goal
    3. after fallback single-task synthesis, before execution continues
  - mark invalid goals as failed, blocked, or replanned (prevent silent persistence)
- Acceptance criteria:
  - ghost goals (0/0 after fallback) cannot remain `active`
  - validation occurs at all three points
  - invalid goals trigger explicit state transitions (not silent skipping)
- Tests:
  - task-graph tests with 0/0 validation
  - planner output tests
  - orchestrator preflight tests

Ticket 7.2: Planner requirements for revenue goals
- Files:
  - [src/orchestration/planner.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/planner.ts)
- Scope:
  - require distribution and monetization tasks for revenue goals
  - validate task classes
- Acceptance criteria:
  - build-only revenue plans are rejected or repaired
- Tests:
  - orchestrator/planner tests

Ticket 7.3: Portfolio-aware goal selection
- Files:
  - [src/orchestration/orchestrator.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/orchestrator.ts)
- Scope:
  - choose work by portfolio priority and project state
  - handle repeated failure signatures
  - transition stalled projects
- Acceptance criteria:
  - distribution-ready work can outrank older build-only work
  - same failure signature does not churn forever
- Tests:
  - orchestrator tests
  - integration tests

**Epic 8: Loop Governor**

Goal:
- Turn loop detection into a real governor for no-progress, discovery-follow-through, and sleep denial.

Ticket 8.1: Discovery follow-through enforcement
- Files:
  - [src/agent/loop.ts](/Users/damondecrescenzo/automaton-research/src/agent/loop.ts)
- Scope:
  - if known venue discovered and no follow-through occurs, inject correction as system-origin pending input
  - if ignored twice, fail current distribution attempt or switch lane
- Acceptance criteria:
  - discovered venues cannot be silently ignored
- Tests:
  - loop tests with ClawNews-like fixtures

Ticket 8.2: Project no-progress governor
- Files:
  - [src/agent/loop.ts](/Users/damondecrescenzo/automaton-research/src/agent/loop.ts)
- Scope:
  - classify project no-progress across cycles
  - deny sleep when ready targets/work exist
  - apply project-level stall handling
- Acceptance criteria:
  - wake-check-sleep loops stop when work is available
- Tests:
  - loop tests

Ticket 8.3: Preserve and extend 1214/429 handling
- Files:
  - [src/agent/loop.ts](/Users/damondecrescenzo/automaton-research/src/agent/loop.ts)
- Scope:
  - keep current recovery logic
  - bind it to persistent provider/channel state
- Acceptance criteria:
  - existing protections still pass
  - no conflict between rate-limit backoff and channel-state gating
- Tests:
  - existing 1214/429 loop tests
  - new provider-state tests

**Epic 9: Heartbeat And Reporting**

Goal:
- Make portfolio status visible and auditable.

Ticket 9.1: Portfolio heartbeat summary
- Files:
  - [src/heartbeat/tasks.ts](/Users/damondecrescenzo/automaton-research/src/heartbeat/tasks.ts)
- Scope:
  - report active projects
  - report lane, blocker, last progress, next monetization step
  - report blocked channels and spend
- Acceptance criteria:
  - stalled state is explicit
  - heartbeat no longer hides blockers behind generic sleep wording
- Tests:
  - heartbeat tests

**Epic 10: Regression Harness**

Goal:
- Encode the 24h failure history into reproducible tests.

Ticket 10.1: Extract historical failure fixtures
- Files:
  - new fixture files under `src/__tests__/fixtures/` or similar
  - source logs from [tmp/vps-log-pull-24h-run-22770520881.log](/Users/damondecrescenzo/automaton-research/tmp/vps-log-pull-24h-run-22770520881.log)
- Scope:
  - extract:
    - repeated `1214`
    - repeated `429`
    - repeated `discover_agents` loops
    - repeated `send_message` with unconfigured relay
    - venue discovery without follow-through
    - active `0/0` goals
- Acceptance criteria:
  - fixtures are deterministic and sanitized

Ticket 10.2: Add regression suite
- Files:
  - [src/__tests__/regressions/connie-portfolio-regression.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/regressions/connie-portfolio-regression.test.ts)
- Scope:
  - replay historical sequences
  - assert new behavior
- Acceptance criteria:
  - all observed failure patterns are covered by tests

**Epic 11: Sovereign Social Relay On `relay.compintel.co`**

Goal:
- deploy and operate the internal signed messaging relay on a dedicated subdomain and make Connie use it as `socialRelayUrl`.

Ticket 11.1: Relay runtime entrypoint and packaging
- Files:
  - [src/social/relay-server.ts](/Users/damondecrescenzo/automaton-research/src/social/relay-server.ts)
  - new relay startup file (for example `src/social/relay-main.ts`)
  - [package.json](/Users/damondecrescenzo/automaton-research/package.json)
- Scope:
  - provide production startup command for relay process
  - support config via env vars (port, db path, bind address)
  - keep API contract stable:
    - `POST /v1/messages`
    - `POST /v1/messages/poll`
    - `GET /v1/messages/count`
    - `GET /health`
- Acceptance criteria:
  - relay starts as a standalone process
  - endpoint contract matches current social client behavior
- Tests:
  - relay unit/integration tests remain green
  - script smoke test via [scripts/test-social-relay.ts](/Users/damondecrescenzo/automaton-research/scripts/test-social-relay.ts)

Ticket 11.2: Server deployment and TLS routing
- Files:
  - deployment artifacts/scripts (new `ops/` files)
  - optional workflow updates under `.github/workflows/`
  - [docs/social_relay_compintel_runbook.md](/Users/damondecrescenzo/automaton-research/docs/social_relay_compintel_runbook.md)
- Scope:
  - create subdomain DNS record `relay.compintel.co`
  - terminate TLS at reverse proxy and forward to local relay process
  - enforce HTTPS-only access
  - add systemd unit and restart policy for relay service
  - configure log rotation and health probe
- Acceptance criteria:
  - `https://relay.compintel.co/health` returns `200`
  - relay process survives restart/reboot
  - no direct public exposure of unencrypted relay port
- Tests:
  - manual deployment checklist
  - post-deploy health check command/script

Ticket 11.3: Connie integration and channel recovery
- Files:
  - [src/types.ts](/Users/damondecrescenzo/automaton-research/src/types.ts)
  - [src/index.ts](/Users/damondecrescenzo/automaton-research/src/index.ts)
  - ops workflow/config files
- Scope:
  - set `socialRelayUrl` to `https://relay.compintel.co` in production config path
  - validate `social_relay` channel auto-recovers from `misconfigured` to `ready`
  - ensure no fallback to external relay domains
- Acceptance criteria:
  - startup logs show internal relay URL
  - `send_message` no longer fails with `social relay not configured`
  - channel state reflects `ready` when relay is healthy
- Tests:
  - distribution blocker recovery test
  - live smoke message send/poll test in staging

Ticket 11.4: Security and abuse controls
- Files:
  - [src/social/validation.ts](/Users/damondecrescenzo/automaton-research/src/social/validation.ts)
  - [src/social/client.ts](/Users/damondecrescenzo/automaton-research/src/social/client.ts)
  - [src/social/relay-server.ts](/Users/damondecrescenzo/automaton-research/src/social/relay-server.ts)
- Scope:
  - preserve replay-window checks and signature verification
  - preserve sender rate limiting and payload size caps
  - confirm logs redact sensitive fields
- Acceptance criteria:
  - invalid signatures are rejected
  - replay attempts are rejected
  - oversized payloads are rejected
- Tests:
  - `src/__tests__/social.test.ts`
  - dedicated negative-path relay tests if gaps are found

**Test Matrix**

Required new or expanded test files:
- [src/__tests__/governance/progress.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/governance/progress.test.ts)
- [src/__tests__/governance/channel-state.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/governance/channel-state.test.ts)
- [src/__tests__/governance/project-policy.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/governance/project-policy.test.ts)
- [src/__tests__/portfolio-db.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/portfolio-db.test.ts)
- [src/__tests__/distribution-tools.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/distribution-tools.test.ts)
- [src/__tests__/integration/multi-project-portfolio.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/integration/multi-project-portfolio.test.ts)
- [src/__tests__/integration/distribution-blocker-recovery.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/integration/distribution-blocker-recovery.test.ts)
- [src/__tests__/regressions/connie-portfolio-regression.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/regressions/connie-portfolio-regression.test.ts)

Expand:
- [src/__tests__/loop.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/loop.test.ts)
- [src/__tests__/heartbeat.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/heartbeat.test.ts)
- [src/__tests__/orchestration/orchestrator.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/orchestration/orchestrator.test.ts)
- [src/__tests__/orchestration/task-graph.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/orchestration/task-graph.test.ts)

**Cross-Ticket Dependencies**

- Epic 2 depends on Epic 1 types/config direction.
- Epic 3 depends on Epic 2 schema/database.
- Epic 4 depends on Epic 2 schema/database.
- Epic 5 depends on Epics 3 and 4 for complete policy context.
- Epic 6 depends on Epics 3, 4, and 5.
- Epic 7 depends on Epics 2, 3, 5, and 6 (tools inform orchestrator decisions).
- Epic 8 depends on Epics 4, 5, 6, and 7.
- Epic 9 depends on Epics 3, 4, and 7.
- Epic 10 fixture extraction should start during Epic 6, not after. Regression suite validation happens after Epics 7-8.
- Epic 11 depends on Epic 6 and Epic 10 (tool gating and regression protections must already be in place).

**Pre-Implementation Checklist**

Before assigning tickets, complete the following setup:

- [ ] Extract historical failure fixtures from 24h logs
  - Parse [tmp/vps-log-pull-24h-run-22770520881.log](/Users/damondecrescenzo/automaton-research/tmp/vps-log-pull-24h-run-22770520881.log) for:
    - repeated 1214 error sequences
    - repeated 429 rate limit sequences
    - repeated discover_agents loops
    - send_message with unconfigured relay patterns
    - venue discovery without follow-through
    - active 0/0 goals
  - Create fixture files under `src/__tests__/fixtures/`
  - Sanitize logs (remove tokens, personal data)
- [ ] Obtain current-state database snapshot
  - Needed for Ticket 2.3 migration test
  - Coordinate with ops/existing Connie instance
- [ ] Finalize operator target JSON schema
  - Define file path (default: `~/.automaton/distribution-targets.json`, configurable)
  - Document structure (name, type, target_url, priority, tags, etc.)
  - Document example file for test fixtures
- [ ] Document high-risk review strategy for Epics 7-8
  - Assign code reviewers
  - Schedule pair programming sessions
  - Define pause/rollback criteria
- [ ] Provision relay subdomain and TLS prerequisites
  - DNS A/AAAA or CNAME for `relay.compintel.co`
  - TLS certificate issuance and renewal path
  - reverse-proxy routing target and firewall rules

**Rollout Guidance**

- Treat Epic 7 and Epic 8 as high-risk.
- Require green targeted tests before moving from one epic to the next.
- Run migration snapshot validation before merging schema work.
- Start fixture extraction during Epic 6, run fixture-based regression suite before deploy.
- Pause Connie during rollout of Epics 7-8 unless explicitly testing in staging.

**Suggested Assignment Order**

1. Epic 1
2. Epic 2 (with migration snapshot test as blocking validation)
3. Epic 3 + Epic 4 together (can be parallel after Epic 2)
4. Epic 5
5. Epic 6 (start fixture extraction here)
6. Epic 7 (high-risk, requires pair review; consider splitting 7.3 if PR is too large)
7. Epic 8 (high-risk, requires pair review; tickets 8.1-8.3 may benefit from separate PRs)
8. Epic 9
9. Epic 10 (fixture extraction concurrent with Epic 6, suite completion after Epic 8)
10. Epic 11 (subdomain relay deployment + Connie integration)

**High-Risk Ticket Splitting Guidance**

Epic 7 and Epic 8 can be split for smaller, easier-to-review PRs:

- **Ticket 7.3 (Portfolio-aware goal selection)**: Can be split into:
  - 7.3a: Project-aware goal selection logic
  - 7.3b: Failure signature tracking and replan/pause logic
  - Merge order: 7.3a → 7.3b (sequential)

- **Tickets 8.1-8.3 (Loop governor)**: Can be split into three separate PRs:
  - 8.1: Discovery follow-through enforcement
  - 8.2: Project no-progress and sleep denial
  - 8.3: Preserve/extend 1214/429 handling
  - Merge order: 8.3 first (preserve existing behavior), then 8.1, then 8.2

This approach allows incremental review and validation without losing coherence.

**Per-Epic Release Gates**

Epic 1 gate:
- docs merged
- types compile

Epic 2 gate:
- migrations pass
- snapshot migration test passes
- legacy goal mapping validated

Epic 3-4 gate:
- operator targets load correctly
- project and channel CRUD stable
- precedence rules enforced (operator > discovered)

Epic 5-6 gate:
- tool gating works
- dead channels no longer churn
- fixture extraction started

Epic 7-8 gate:
- no ghost goals survive
- no discovery-without-follow-through
- no wake-check-sleep loops with ready work
- 1214/429 protections preserved and extended
- fixture-based regression suite passing

Epic 9-10 gate:
- heartbeats show portfolio truth
- historical 24h regressions replay cleanly
- staged validation scenario passes (one ready channel, one misconfigured, one funding-required, multiple projects with operator targets)
- execution follows [docs/staged_validation_runbook.md](/Users/damondecrescenzo/automaton-research/docs/staged_validation_runbook.md)

Epic 11 gate:
- `https://relay.compintel.co/health` is green
- Connie production config uses `https://relay.compintel.co` for `socialRelayUrl`
- `social_relay` channel state is `ready` under normal operation
- signed send/poll/count smoke test passes end-to-end

Post-Epic 11 runtime gate:
- run [`scripts/verify-phase11-quota-reset.sh`](/Users/damondecrescenzo/automaton-research/scripts/verify-phase11-quota-reset.sh) at quota-reset time
- require `gate_result.json` with `"pass": true`
- archive evidence directory and attach to release notes
- optional CI automation via [.github/workflows/vps-phase11-gate.yml](/Users/damondecrescenzo/automaton-research/.github/workflows/vps-phase11-gate.yml)
