**Spec**

This spec upgrades Connie from a loop-prone single-goal builder into a controlled multi-project revenue operator. It covers governance, persistence, runtime controls, orchestration, reporting, and testing. The intended outcome is that Connie can build and monetize multiple products while avoiding inference churn, dead-channel retries, ghost goals, and cosmetic progress.

Primary goals:
- Support multiple concurrent product efforts under strict WIP limits.
- Treat revenue work as a portfolio, not a single undifferentiated goal stream.
- Convert operator guidance, especially LLM-agent marketing channels, into structured executable state.
- Enforce governance in code, not just prose.
- Make regressions provable through tests.

Non-goals for this phase:
- No mandatory dual-LLM governor.
- No autonomous capital allocation across real funds.
- No full CRM or marketing automation platform.
- No broad redesign of inference clients beyond existing 1214/429 protections.

**Reasoning**

The logs and docs show the same failure mode from different angles:
- Connie found real opportunities, including LLM-agent channels and venues like ClawNews.
- Connie repeatedly narrated strategic pivots but did not convert them into verified outcomes.
- Discovery was treated as action.
- Terminal blockers such as `social relay not configured`, `insufficient ETH for gas`, `1214 invalid messages`, and `429 Weekly/Monthly Limit Exhausted` were retried instead of closed.
- Active goals could remain alive without meaningful executable task structure.
- The existing governance docs are conceptually correct but not operational enough to prevent rhetorical compliance.

The system already has strong primitives:
- goals
- task DAGs
- child agents
- memory
- identity
- messaging
- heartbeats
- governance docs

What is missing is an enforceable control plane:
- project lifecycle
- channel lifecycle
- progress classifier
- budget limits
- kill criteria
- structured distribution queue
- tests that replay historical failures

**Clarifications**

Ghost goal detection timing:
- Validate at three points:
  - immediately after planner/replanner output is normalized
  - at orchestrator tick start for the currently selected goal
  - after fallback single-task synthesis, before execution continues
- A goal is a ghost goal only if it still has `0/0` executable tasks after planner fallback and normalization. This avoids false positives during transient planning windows.

Channel transition rules:
- `misconfigured`:
  - entered on deterministic configuration errors such as missing `socialRelayUrl`
  - exits automatically when config is reloaded and validation passes
- `funding_required`:
  - entered on deterministic funding precondition failures such as missing ETH for ERC-8004 gas
  - exits automatically when balance/funding precheck passes
- `quota_exhausted`:
  - entered on provider responses with explicit reset timestamp or limit-exhausted message
  - auto-expires at `cooldown_until`
- `cooldown`:
  - entered on transient failures
  - auto-expires at `cooldown_until`
- `blocked_by_policy`:
  - entered when governance forbids the route
  - exits only if the governing condition changes
- `disabled`:
  - manual/operator or explicit runtime disable
  - does not auto-recover

Discovery correction semantics:
- "Inject a correction" means:
  - write a system-origin pending input on the next loop cycle
  - require one of:
    - create a distribution target
    - execute a publish/contact action against an existing target
    - explicitly mark the venue blocked/skipped with reason
- It does not auto-fail the goal by itself.
- If the correction is ignored twice, then fail the current distribution attempt and replan or pause the project.

`paused` vs `blocked`:
- `blocked`:
  - work is still desired, but an unmet dependency prevents execution
  - should resume automatically when dependency state changes
- `paused`:
  - work is intentionally stopped by portfolio policy, WIP limits, budget policy, or operator decision
  - does not auto-resume without an explicit resume condition or operator action

Budget enforcement:
- Enforce in three places:
  - before expensive tool calls
  - before project/goal activation
  - at loop/orchestrator boundaries
- Tool-level checks prevent obvious overspend.
- Loop/orchestrator checks prevent aggregate drift.

Operator target priority:
- Operator-provided targets always outrank discovered targets by default.
- Discovery can supplement, but not displace, operator targets unless operator targets are exhausted, blocked, or explicitly deprioritized.

State migration:
- On schema migration, all active legacy goals are attached to a default `legacy-import` project unless an explicit project mapping is available.
- That legacy project should start in `shipping` or `blocked` depending on current goal/task validity.
- A dedicated migration test must validate this mapping against a snapshot DB.

**Scope**

In scope:
- Governance docs rewrite and tightening.
- System prompt alignment with governance.
- New persistent entities for projects, channels, targets, and project metrics.
- Multiple active projects under WIP limits.
- Goal-to-project linkage.
- Distribution target queue sourced from operator input and discovery.
- Channel state machine and retry suppression.
- Invalid active-goal detection for ghost goals.
- Project-aware orchestrator selection and stall handling.
- Heartbeat reporting for portfolio status and blockers.
- Full regression test expansion.

Out of scope:
- New social relay protocol design beyond the existing signed messaging contract.
- New external marketing integrations beyond current repo capabilities.
- Advanced pricing or market-sizing engines.
- A second LLM unless later explicitly chosen.
- Automated funding of on-chain registration gas.

**Product Requirements**

Connie must be able to:
- Manage multiple product efforts as projects.
- Keep projects in explicit lifecycle states.
- Keep one project shipping, one distributing, and one researching when within budget.
- Refuse to keep a project active without a buyer, channel, and monetization hypothesis.
- Stop retrying channels that are structurally unavailable.
- Treat discovery as reconnaissance only.
- Persist operator-provided marketing venues as first-class structured targets.
- Mark stalled or over-budget projects as paused or killed.
- Report portfolio state in heartbeat and status output.

**Governance Requirements**

Governance rules must exist in three places:
- docs
- runtime logic
- tests

New governance commitments:
- A project is only active if it has an offer, target customer, channel, monetization step, and budget.
- Discovery does not count as delivery.
- Cosmetic artifacts do not count as revenue progress unless paired with deploy validation or distribution execution.
- Goals with no executable tasks are invalid.
- Terminal channel blockers must disable the channel until conditions change.
- Multiple revenue tracks are allowed only under explicit WIP limits.
- Sleep is disallowed when ready distribution or monetization work exists.
- Heartbeats must expose stalled state, not hide it.

**Data Model**

Add new entities.

`projects`
- `id`
- `name`
- `description`
- `status`
  - `incubating|shipping|distribution|monetizing|paused|blocked|killed|archived`
- `lane`
  - `build|distribution|research`
- `offer`
- `target_customer`
- `primary_channel_id`
- `monetization_hypothesis`
- `next_monetization_step`
- `success_metric`
- `kill_criteria`
- `budget_tokens`
- `budget_compute_cents`
- `budget_time_minutes`
- `spent_tokens`
- `spent_compute_cents`
- `created_at`
- `updated_at`
- `paused_at`
- `killed_at`

`distribution_channels`
- `id`
- `name`
- `channel_type`
- `requires_config`
- `requires_funding`
- `supports_listing`
- `supports_messaging`
- `supports_publish`
- `status`
  - `ready|misconfigured|quota_exhausted|funding_required|blocked_by_policy|cooldown|disabled`
- `blocker_reason`
- `cooldown_until`
- `last_checked_at`
- `created_at`
- `updated_at`

`distribution_targets`
- `id`
- `project_id`
- `channel_id`
- `target_key`
- `target_label`
- `priority`
- `status`
  - `pending|attempted|published|contacted|replied|converted|blocked|skipped`
- `operator_provided`
- `last_attempt_at`
- `last_result`
- `created_at`
- `updated_at`

`project_metrics`
- `id`
- `project_id`
- `metric_type`
  - `lead|reply|trial|payment|deploy|listing|message|usage`
- `value`
- `metadata`
- `created_at`

Extend `goals`
- `project_id`
- `stage_hint`
- `next_monetization_step`
- optionally `priority`

Extend `task_graph`
- `project_id`
- `task_class`
  - `build|distribution|research|ops|monetization`
- `failure_signature`
- `blocked_reason`

**Configuration Requirements**

Extend [src/types.ts](/Users/damondecrescenzo/automaton-research/src/types.ts):

Add `portfolio` config:
- `maxActiveProjects`
- `maxShippingProjects`
- `maxDistributionProjects`
- `stalledProjectTtlMs`
- `noProgressCycleLimit`
- `killOnBudgetExhaustion`

Add `distribution` config:
- `operatorTargetsPath`
- `enforceKnownVenueFollowThrough`
- `channelCooldownDefaultMs`

Defaults should be conservative:
- max active projects: `3`
- max shipping: `2`
- max distribution: `1`

**Governance Documentation Edits**

Update [SOUL.md](/Users/damondecrescenzo/automaton-research/SOUL.md):
- Add `Portfolio Mandate`
- Add `Distribution Mandate`
- Add `Project Lifecycle Contract`
- Add `No Ghost Goals`
- Add `No Cosmetic Progress`
- Tighten `Blocked-State Contract` with terminal blocker closure

Update [GOVERNANCE.md](/Users/damondecrescenzo/automaton-research/GOVERNANCE.md):
- Add `Project Governance`
- Add `Channel Governance`
- Add `Distribution Governance`
- Add `Goal Validity Rules`
- Add `Portfolio Reporting Rules`
- Add `Operator Intent Materialization`
- Add `Budget and Kill Rules`

Update [constitution.md](/Users/damondecrescenzo/automaton-research/constitution.md):
- Minimal one-line clarification under Law II:
  - value creation must be evidenced by delivery, distribution, or paid usage, not performative activity

Update [src/agent/system-prompt.ts](/Users/damondecrescenzo/automaton-research/src/agent/system-prompt.ts):
- Inject portfolio state, channel state, and project budgets.
- Add hard constraints:
  - unavailable channels cannot be retried
  - goals with zero tasks must be failed or replanned
  - discovery without follow-through is a blocker
  - every active project needs buyer/channel/metric

**Runtime Behavior Requirements**

Progress classifier:
- counts as progress:
  - task completed or failed with evidence
  - deploy health improved
  - distribution target executed
  - project stage changed
  - project metric recorded
- does not count as progress:
  - thought text
  - repeated planning
  - `discover_agents` alone
  - file creation without verification or distribution
  - status-only turns

Channel state machine:
- terminal blockers:
  - `social relay not configured` -> `misconfigured`
  - `insufficient ETH for gas` -> `funding_required`
  - `1214 invalid messages` -> inference payload error path, no repeated normal retries
  - `429 limit exhausted` -> `quota_exhausted` until exact reset
- transient blockers:
  - network fetch failures
  - temporary 5xx
  - temporary rate limit without hard reset
- terminal blockers suppress future tool use until conditions change
- exact recovery behavior:
  - auto-expire `cooldown` and `quota_exhausted` via `cooldown_until`
  - revalidate `misconfigured` and `funding_required` on config/funding checks
  - require explicit condition change before leaving `blocked_by_policy` or `disabled`

Ghost goals:
- any active goal with `0/0` tasks after planning/execution validation is invalid
- must be marked failed, blocked, or replanned
- must not remain active silently
- enforcement points:
  - planner output validation
  - replanner output validation
  - orchestrator tick preflight

Discovery follow-through:
- `discover_agents` may only run if:
  - there is a queued distribution action to support
  - there is a fresh blocker signal
  - operator explicitly requested discovery mode
- if a known venue appears in results and no distribution target or action is created in the next turn, the loop injects a correction
- if the correction is ignored twice, the project lane switches or the current distribution attempt is failed

Portfolio operation:
- multiple active projects are allowed, not multiple unconstrained active goals
- project WIP limits apply globally
- orchestrator chooses work by portfolio priority, not just oldest goal

Metric recording:
- Metrics may be recorded in two ways:
  - explicit tool calls such as `record_project_metric`
  - automatic runtime detection for known events:
    - successful deploy health validation -> `deploy`
    - successful publish/listing action -> `listing`
    - successful message send -> `message`
    - explicit payment/use signals -> `payment` or `usage`

Budget precision:
- `budget_tokens` and `spent_tokens` are integers.
- `budget_compute_cents` and `spent_compute_cents` remain integer cents.

429 cooldown precision:
- Prefer explicit reset timestamps parsed from provider messages.
- If unavailable, fall back to bounded exponential backoff.
- Persist the resulting unblock time in channel state.

**Repository-Ready Implementation Plan**

**Phase 1: Governance and Type Foundation**

Files:
- [SOUL.md](/Users/damondecrescenzo/automaton-research/SOUL.md)
- [GOVERNANCE.md](/Users/damondecrescenzo/automaton-research/GOVERNANCE.md)
- [constitution.md](/Users/damondecrescenzo/automaton-research/constitution.md)
- [src/types.ts](/Users/damondecrescenzo/automaton-research/src/types.ts)
- [src/agent/system-prompt.ts](/Users/damondecrescenzo/automaton-research/src/agent/system-prompt.ts)

Edits:
- define new project and channel concepts in docs and types
- add typed enums/interfaces
- add config knobs
- align prompt language with governance

Deliverables:
- docs spec committed
- types compile cleanly
- prompt updated to consume future project/channel context

**Phase 2: Schema and Database API**

Files:
- [src/state/schema.ts](/Users/damondecrescenzo/automaton-research/src/state/schema.ts)
- [src/state/database.ts](/Users/damondecrescenzo/automaton-research/src/state/database.ts)

Edits:
- add migration `V11` for projects/channels/targets/metrics and goal/task extensions
- add CRUD functions for new entities
- extend goal/task serializers
- add query helpers:
  - list active projects
  - list ready targets
  - summarize project metrics
  - mark channel blocked/cooldown/ready
- add legacy-goal migration logic:
  - attach active pre-V11 goals to `legacy-import`
  - validate no orphan active goals remain

Deliverables:
- migrations apply cleanly
- database API fully typed
- no breaking changes to existing goal/task accessors
- migration test passes against a representative snapshot DB

**Phase 3: Project Service Layer + Operator Target Loading**

New files:
- [src/portfolio/types.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/types.ts)
- [src/portfolio/service.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/service.ts)
- [src/portfolio/policy.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/policy.ts)
- [src/distribution/targets.ts](/Users/damondecrescenzo/automaton-research/src/distribution/targets.ts)

Responsibilities:
- create/update/pause/kill projects
- enforce WIP limits
- compute project health and budget status
- determine next eligible projects
- transition project lifecycle states
- load operator-provided targets early and upsert them into persistent state
- define precedence rules between operator and discovered targets

Deliverables:
- single entrypoint for project selection and policy
- no project activation without monetization hypothesis
- operator target source validated early

**Phase 4: Distribution State Layer**

New files:
- [src/distribution/channels.ts](/Users/damondecrescenzo/automaton-research/src/distribution/channels.ts)

Responsibilities:
- maintain channel state machine
- merge discovered venues into structured target backlog
- create follow-through actions from discovery results

Deliverables:
- structured distribution queue
- persistent known-channel states
- ready/blocked target filtering

**Phase 5: Governance Runtime**

New files:
- [src/governance/progress.ts](/Users/damondecrescenzo/automaton-research/src/governance/progress.ts)
- [src/governance/channel-state.ts](/Users/damondecrescenzo/automaton-research/src/governance/channel-state.ts)
- optional [src/governance/policy-sync.ts](/Users/damondecrescenzo/automaton-research/src/governance/policy-sync.ts)

Responsibilities:
- classify real progress vs non-progress
- map errors to channel states
- decide whether a channel/tool is eligible
- decide when a project is stalled or kill-worthy

Deliverables:
- reusable pure functions for tests and runtime
- single place for policy constants

**Phase 6: Tool Layer Integration**

File:
- [src/agent/tools.ts](/Users/damondecrescenzo/automaton-research/src/agent/tools.ts)

Edits:
- change `create_goal`:
  - remove one-goal-only cap
  - require or infer `project_id`
  - enforce project validity and WIP limits
- add tools:
  - `create_project`
  - `list_projects`
  - `pause_project`
  - `kill_project`
  - `set_project_lane`
  - `list_distribution_channels`
  - `list_distribution_targets`
  - `add_distribution_target`
  - `record_project_metric`
- wrap these existing tools with channel checks:
  - `send_message`
  - `message_child`
  - `discover_agents`
  - `register_erc8004`
- persist blocked results into channel state, not just text

Deliverables:
- project and distribution management is available to the agent
- blocked channels cannot be retried blindly

**Phase 7: Orchestrator and Task Graph Integration**

Files:
- [src/orchestration/task-graph.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/task-graph.ts)
- [src/orchestration/orchestrator.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/orchestrator.ts)
- [src/orchestration/planner.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/planner.ts)

Edits:
- extend task insertion and progress refresh to use `project_id` and `task_class`
- reject `0/0` goals
- require planner outputs for revenue goals to include distribution and monetization tasks
- add project-aware `pickGoal`
- add repeated failure signature tracking
- add per-project stall detection and lifecycle transitions
- add fallback behavior that does not leave ghost goals alive

Deliverables:
- orchestrator is portfolio-aware
- invalid goals do not survive
- distribution work competes fairly with build work
- staged rollout notes and extra regression coverage are required for this phase

**Phase 8: Loop and Governor Integration**

File:
- [src/agent/loop.ts](/Users/damondecrescenzo/automaton-research/src/agent/loop.ts)

Edits:
- extend current loop detection to:
  - classify project no-progress across cycles
  - inject lane-switch directives
  - enforce discovery follow-through
  - deny sleep when ready work exists
- integrate channel-state checks into wake/recovery flow
- keep current 1214 and 429 protections, but bind them to persistent channel/provider state
- add `0/0` goal validation in active-cycle checks

Deliverables:
- no more churn on dead paths
- no more wake-check-sleep loops while ready distribution work exists
- no conflict with existing 1214/429 recovery semantics

**Phase 9: Heartbeat and Reporting**

File:
- [src/heartbeat/tasks.ts](/Users/damondecrescenzo/automaton-research/src/heartbeat/tasks.ts)

Edits:
- add portfolio summary output:
  - active projects
  - lane
  - status
  - last progress time
  - next monetization step
  - spend since last progress
  - blocked channels
- mark stalled projects explicitly
- include project metrics summary

Deliverables:
- heartbeats expose truth, not generic sleep language

**Phase 10: Full Regression and Fixture Replay**

Deliverables:
- historical failure fixtures extracted before rollout
- fixture-based regression suite in CI
- migration snapshot test
- staged validation checklist
- staged execution runbook: [docs/staged_validation_runbook.md](/Users/damondecrescenzo/automaton-research/docs/staged_validation_runbook.md)

**Phase 11: Sovereign Social Relay On Subdomain**

Goal:
- run the internal relay as a first-class production service at `https://relay.compintel.co`
- remove dependency on any external relay domain

Runtime contract (must remain stable):
- base URL in Connie config: `socialRelayUrl = "https://relay.compintel.co"`
- required endpoints:
  - `POST /v1/messages`
  - `POST /v1/messages/poll`
  - `GET /v1/messages/count`
  - `GET /health`
- authentication and integrity:
  - wallet signature verification for send/poll/count
  - replay window checks
  - per-sender rate limiting
- transport:
  - HTTPS only (client rejects non-HTTPS)

Server build/deploy responsibilities:
- application:
  - keep relay implementation in [src/social/relay-server.ts](/Users/damondecrescenzo/automaton-research/src/social/relay-server.ts)
  - add/startpoint runner (for example `src/social/relay-main.ts`) for process startup
- hosting:
  - bind relay process to localhost port (for example `127.0.0.1:8787`)
  - terminate TLS at reverse proxy and route `relay.compintel.co` to relay process
  - enforce HTTPS redirect and strict TLS config
- persistence:
  - dedicated SQLite file for relay data (not shared with Connie state DB)
  - WAL mode enabled and disk backup policy documented
- operations:
  - systemd unit for relay process lifecycle and restart policy
  - log routing and rotation
  - health probe from monitoring using `GET /health`

Deliverables:
- relay reachable at `https://relay.compintel.co/health`
- Connie `socialRelayUrl` configured to `https://relay.compintel.co`
- distribution channel `social_relay` transitions to `ready` once config is applied
- operator target loading still functions independently of relay service health
- deployment steps documented in [docs/social_relay_compintel_runbook.md](/Users/damondecrescenzo/automaton-research/docs/social_relay_compintel_runbook.md)

**Testing Plan**

Testing is mandatory and must ship with the implementation.

**Unit Tests**

Add:
- [src/__tests__/governance/progress.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/governance/progress.test.ts)
- [src/__tests__/governance/channel-state.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/governance/channel-state.test.ts)
- [src/__tests__/governance/project-policy.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/governance/project-policy.test.ts)

Cases:
- repeated intent text is non-progress
- cosmetic artifact-only turns are non-progress
- deploy verified or distribution target executed is progress
- terminal blockers map to permanent channel states
- transient blockers map to cooldown
- WIP limits and budget rules enforce pause/kill behavior

**Database and Schema Tests**

Add:
- [src/__tests__/portfolio-db.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/portfolio-db.test.ts)

Cases:
- migrations create new tables and columns
- CRUD helpers work
- channel and target updates persist correctly
- goal and task linkage with project IDs works
- legacy active goals map into `legacy-import` project
- no orphan active goals remain after migration

**Loop Runtime Tests**

Expand:
- [src/__tests__/loop.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/loop.test.ts)

Add cases:
- known venue discovered -> next turn must create target, execute target, or mark blocked/skipped
- `social relay not configured` marks messaging channel unavailable and suppresses future `send_message`
- `register_erc8004` with insufficient gas marks funding-required and suppresses retries
- `discover_agents` without follow-through triggers system correction
- correction ignored twice triggers lane switch or failed distribution attempt
- active goal with zero tasks is invalidated
- sleep is denied when there are ready distribution targets
- 429 hard reset suppresses repeated wake inference attempts until the exact reset time
- 1214 keeps recovery behavior and also marks provider state appropriately
- budget checks fire before expensive tool execution and at loop boundary

**Tool Tests**

Add:
- [src/__tests__/distribution-tools.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/distribution-tools.test.ts)

Cases:
- new project tools work and respect limits
- distribution target tools persist records
- tool wrappers honor channel-state gating
- `discover_agents` can run when supporting a queued distribution action and cannot otherwise
- operator-provided targets outrank discovered targets by default

**Orchestrator Tests**

Expand:
- [src/__tests__/orchestration/orchestrator.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/orchestration/orchestrator.test.ts)
- [src/__tests__/orchestration/task-graph.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/orchestration/task-graph.test.ts)

Cases:
- project-aware goal selection prioritizes distribution-ready projects
- invalid `0/0` goals fail or replan
- revenue plans require distribution + monetization task classes
- repeated failure signatures force fail/pause instead of indefinite worker churn
- task insertion and progress calculations remain correct with project IDs
- paused vs blocked behavior differs correctly

**Heartbeat Tests**

Expand:
- [src/__tests__/heartbeat.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/heartbeat.test.ts)

Cases:
- portfolio summary appears
- stalled state appears after no progress
- heartbeat includes next monetization step and blocker
- blocked channel summary appears
- spend summary appears

**Integration Tests**

Add:
- [src/__tests__/integration/multi-project-portfolio.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/integration/multi-project-portfolio.test.ts)
- [src/__tests__/integration/distribution-blocker-recovery.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/integration/distribution-blocker-recovery.test.ts)

Cases:
- one project shipping, one distributing, one incubating
- dead messaging channel reroutes to alternative ready targets
- operator-provided LLM-agent channels are loaded and used
- no project continues spending after budget kill threshold
- distribution targets move through statuses correctly
- cooldown channels auto-recover when `cooldown_until` elapses
- misconfigured and funding-required channels recover on config/funding changes

**Fixture-Based Regression Tests**

Add:
- [src/__tests__/regressions/connie-portfolio-regression.test.ts](/Users/damondecrescenzo/automaton-research/src/__tests__/regressions/connie-portfolio-regression.test.ts)

Use fixtures derived from the 24h logs:
- repeated `1214`
- repeated `429`
- repeated `discover_agents` loops
- repeated `send_message` with unconfigured relay
- repeated agent venue discoveries without follow-through
- active ghost goals with `0/0`
- repeated build loops with no deploy/distribution outcome

These tests are critical because they encode the exact failure history.

**Validation Strategy**

Validation must happen in four levels:

1. Unit
- governance, channel-state, and project-policy pure functions

2. Integration
- loop + tools + orchestrator + DB behavior

3. Fixture replay
- actual 24h failure sequences from Connie logs

4. Manual scenario validation
- one ready distribution channel
- one misconfigured messaging channel
- one funding-required registration route
- multiple active projects with operator targets
- verify the agent chooses real work and does not churn

**Implementation Checklist**

**Docs**
- [ ] Update [SOUL.md](/Users/damondecrescenzo/automaton-research/SOUL.md) with portfolio, distribution, no-ghost-goal, no-cosmetic-progress rules
- [ ] Update [GOVERNANCE.md](/Users/damondecrescenzo/automaton-research/GOVERNANCE.md) with project/channel/distribution/budget rules
- [ ] Update [constitution.md](/Users/damondecrescenzo/automaton-research/constitution.md) with minimal Law II clarification
- [ ] Update [src/agent/system-prompt.ts](/Users/damondecrescenzo/automaton-research/src/agent/system-prompt.ts) to reflect enforceable rules

**Types and Config**
- [ ] Add project/channel/target/metric enums and interfaces to [src/types.ts](/Users/damondecrescenzo/automaton-research/src/types.ts)
- [ ] Add `portfolio` and `distribution` config sections

**Schema**
- [ ] Add `V11` migration in [src/state/schema.ts](/Users/damondecrescenzo/automaton-research/src/state/schema.ts)
- [ ] Add new tables and extend `goals` and `task_graph`
- [ ] Add legacy-goal migration mapping to `legacy-import`
- [ ] Add migration snapshot test

**Database**
- [ ] Add project CRUD to [src/state/database.ts](/Users/damondecrescenzo/automaton-research/src/state/database.ts)
- [ ] Add channel CRUD
- [ ] Add target CRUD
- [ ] Add project metrics CRUD
- [ ] Extend goal/task serializers and APIs
- [ ] Add migration-safe fallback behavior for preexisting active goals

**New Modules**
- [ ] Create [src/portfolio/types.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/types.ts)
- [ ] Create [src/portfolio/service.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/service.ts)
- [ ] Create [src/portfolio/policy.ts](/Users/damondecrescenzo/automaton-research/src/portfolio/policy.ts)
- [ ] Create [src/distribution/channels.ts](/Users/damondecrescenzo/automaton-research/src/distribution/channels.ts)
- [ ] Create [src/distribution/targets.ts](/Users/damondecrescenzo/automaton-research/src/distribution/targets.ts)
- [ ] Create [src/governance/progress.ts](/Users/damondecrescenzo/automaton-research/src/governance/progress.ts)
- [ ] Create [src/governance/channel-state.ts](/Users/damondecrescenzo/automaton-research/src/governance/channel-state.ts)
- [ ] Optionally create [src/governance/policy-sync.ts](/Users/damondecrescenzo/automaton-research/src/governance/policy-sync.ts)

**Tools**
- [ ] Remove single-active-goal cap in [src/agent/tools.ts](/Users/damondecrescenzo/automaton-research/src/agent/tools.ts)
- [ ] Add `create_project`
- [ ] Add `list_projects`
- [ ] Add `pause_project`
- [ ] Add `kill_project`
- [ ] Add `set_project_lane`
- [ ] Add `list_distribution_channels`
- [ ] Add `list_distribution_targets`
- [ ] Add `add_distribution_target`
- [ ] Add `record_project_metric`
- [ ] Gate `send_message`, `message_child`, `discover_agents`, `register_erc8004` through channel-state checks
- [ ] Enforce operator-target precedence over discovered targets

**Orchestration**
- [ ] Extend [src/orchestration/task-graph.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/task-graph.ts) with project linkage and ghost-goal invalidation
- [ ] Extend [src/orchestration/orchestrator.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/orchestrator.ts) with portfolio-aware goal selection and repeated failure signature handling
- [ ] Extend [src/orchestration/planner.ts](/Users/damondecrescenzo/automaton-research/src/orchestration/planner.ts) with required distribution/monetization tasks for revenue goals
- [ ] Add explicit ghost-goal preflight validation points

**Loop**
- [ ] Integrate channel-state and project no-progress rules in [src/agent/loop.ts](/Users/damondecrescenzo/automaton-research/src/agent/loop.ts)
- [ ] Add known-venue follow-through enforcement
- [ ] Add sleep denial when ready work exists
- [ ] Preserve and extend existing 1214 and 429 recovery paths
- [ ] Inject correction as a system-origin pending input with explicit required next actions

**Heartbeat**
- [ ] Extend [src/heartbeat/tasks.ts](/Users/damondecrescenzo/automaton-research/src/heartbeat/tasks.ts) with portfolio and blocked-channel reporting

**Distribution Source**
- [ ] Add loader for operator-provided targets in `src/distribution/targets.ts`
- [ ] Define source file format and defaults
- [ ] Validate operator target precedence logic

**Tests**
- [ ] Add governance unit tests
- [ ] Add database schema tests
- [ ] Expand loop tests
- [ ] Add distribution tool tests
- [ ] Expand orchestrator tests
- [ ] Expand heartbeat tests
- [ ] Add integration tests
- [ ] Add fixture-based regression test from the 24h Connie failure patterns
- [ ] Add migration snapshot test using a current-state DB
- [ ] Extract historical failure fixtures before implementation starts

**Suggested Delivery Order**

1. Docs and types
2. Schema, database APIs, and migration snapshot test
3. Project service layer plus operator target loading
4. Distribution and governance modules
5. Tool gating and project tools
6. Orchestrator and task-graph changes
7. Loop enforcement
8. Heartbeat reporting
9. Fixture-based regression extraction and test completion
10. Sovereign social relay deployment on `relay.compintel.co`
11. Targeted regression run and staged verification

**Acceptance Criteria**

This handoff is complete only when:
- governance docs explicitly define portfolio, channel, and ghost-goal rules
- those rules exist in runtime code
- those rules are covered by tests
- multiple projects can coexist within WIP limits
- blocked channels cannot churn
- known LLM-agent venues cannot be silently ignored
- active ghost goals cannot survive
- heartbeats expose real portfolio state and blockers
- the historical 24h failure patterns are covered by regression fixtures
- social relay is internally hosted at `https://relay.compintel.co` and passes signed send/poll/count checks
