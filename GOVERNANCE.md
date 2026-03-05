# Governance

Deterministic operating rules for execution, orchestration, and escalation.

## 1) Execution Policy

- Use early failure semantics: detect invalid preconditions before tool execution.
- Use bounded retries for transient errors.
- Convert persistent repeats into explicit `failed` outcomes to force replanning.
- Prefer small, testable increments over broad speculative work.
- Repeated intent statements without verified outcome are non-progress and must be treated as blockers.
- Default infrastructure target for web/API deployment is `compintel.co` / `api.compintel.co`.
- Deployment plans that drift to unrelated hosting providers without explicit operator approval are invalid and must be replanned.

## 1.1) Anti-Loop Commitment Contract

- "I will build X" is not progress. Only verified outputs count.
- If the same intent class repeats twice without a verified result, switch strategy class immediately:
  - `build` -> `distribution` (traffic, positioning, acquisition)
  - `distribution` -> `research` (new tactic, segment, channel test)
  - `research` -> `build` (ship concrete experiment)
- Do not restate the same commitment text in consecutive cycles.
- Every cycle must produce:
  1) one concrete artifact change, and
  2) one verification signal tied to that artifact.
- Discovery/status tools (`discover_agents`, `list_children`, `orchestrator_status`, balance checks) are capped to one call per wake cycle unless a new failure signal appears.
- `discover_agents` cannot be called in two consecutive cycles without a newly created artifact (file, deploy, or goal/task state change).
- If discovery is repeated twice without conversion to a concrete build/distribution action, force lane switch and record the blocker in `WORKLOG.md`.

## 2) Orchestrator Anti-Stall Rules

- If `executing` phase has no completed tasks for 10 minutes, trigger stall recovery.
- Quarantine dead workers for a cooldown window before reassignment.
- Do not keep tasks in `assigned/running` indefinitely after repeated worker aborts.
- Force replan when the same task-worker failure signature repeats.

## 3) Worker Failure Budget

For each task:

- Abort-like inference failures: retry up to 2 times.
- On third abort-like failure: mark task failed (non-retryable) and escalate.
- Do not spawn a new worker for the same signature without changed conditions.

## 4) Sleep Governance

- Maximum sleep while orchestration is active: 300 seconds.
- Maximum sleep when child status is missing repeatedly: 120 seconds.
- Any requested sleep beyond limit must be clamped and logged with reason.
- Long sleeps require a concrete wake condition and owner.
- Sleep is disallowed when there is unfinished local work in the current strategy class.
- If active goals or in-flight tasks exist, use short polling and execute productive work between polls.

## 5) Heartbeat Governance

- Minimum heartbeat cadence during incident/debug: every 10 minutes.
- Deduplication must never suppress heartbeats beyond 10 minutes.
- Heartbeats must include: state, blocker, next action, and last real progress time.
- If stalled for 20+ minutes: heartbeat title/state must indicate `stalled`.
- Heartbeats must include the current strategy class (`build`/`distribution`/`research`) and the next concrete artifact to produce.
- If the same discovery/status action repeats, heartbeat must explicitly name it as a loop blocker and include a forced next action that produces an artifact.

## 6) Escalation Ladder

When blocked:

1. Retry with bounded strategy change.
2. Fallback path execution.
3. Mark failing unit as failed and replan.
4. Page operator with exact blocker + evidence + proposed fix.

Never loop silently between steps 1-2 without advancing to 3-4.

## 7) Deployment Validation Requirements

A deploy is valid only when all checks pass:

- CI workflow green.
- Target service running desired task count.
- Latest task revision timestamp is current.
- Health endpoints pass.
- Logs show successful startup without critical errors.

If any fail, rollback criteria apply immediately.

## 8) Change Management

- Every behavioral governance change must include:
  - Rationale.
  - Expected failure mode prevented.
  - Validation method.
- Keep rules short, operational, and testable.
