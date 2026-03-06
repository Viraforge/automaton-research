# Connie Revamp Staged Validation Runbook (Epic 9-10 Gate)

## Purpose

Validate the March 6 revamp behavior in a staging-like environment before merge/deploy to `main`.

This runbook verifies:
- portfolio governance
- channel-state gating and recovery
- discovery follow-through enforcement
- ghost-goal prevention
- heartbeat truthfulness
- regression stability

## Preconditions

- Branch: `feat/connie-revamp-portfolio-governance` (or merged equivalent).
- Database booted with schema v11.
- Connie paused except when running this validation scenario.
- Staging config uses non-production credentials.
- Operator targets file exists at configured path (default `~/.automaton/distribution-targets.json`).

## Scenario Setup

Create or confirm this staged scenario:

1. One `ready` distribution channel:
- Example: social relay with valid `socialRelayUrl`.

2. One `misconfigured` channel:
- Example: messaging route with missing/invalid required config.

3. One `funding_required` channel:
- Example: ERC-8004 registration route with insufficient gas/balance.

4. Multiple active projects (within WIP limits):
- at least one project in `shipping`
- at least one project in `distribution`
- operator-provided targets linked to at least one active distribution project

## Validation Steps

1. Type and baseline checks:
```bash
pnpm -s typecheck
pnpm -s vitest run src/__tests__/integration/distribution-blocker-recovery.test.ts
```

2. Run targeted governance/regression suites:
```bash
pnpm -s vitest run \
  src/__tests__/governance/channel-state.test.ts \
  src/__tests__/governance/discovery-followthrough.test.ts \
  src/__tests__/governance/project-policy.test.ts \
  src/__tests__/regressions/connie-portfolio-regression.test.ts \
  src/__tests__/heartbeat.test.ts \
  src/__tests__/loop.test.ts
```

3. Validate operator-target loading:
- Start loop runtime.
- Confirm log/report shows operator targets loaded.
- Confirm malformed file behavior is safe (diagnostic emitted, process continues, no crash).

4. Validate channel-state gating:
- Trigger a deterministic misconfiguration failure.
- Confirm channel transitions to `misconfigured` and tool use is blocked.
- Fix config and reload.
- Confirm channel transitions back to `ready`.

5. Validate funding gate:
- Trigger insufficient-gas path.
- Confirm channel transitions to `funding_required` and retries are suppressed.
- Add funds or mock passing precheck.
- Confirm channel transitions back to usable state.

6. Validate quota/cooldown behavior:
- Trigger provider limit/cooldown path.
- Confirm `quota_exhausted` or `cooldown` state with `cooldown_until`.
- Confirm loop does not churn repeated LLM calls before expiry.

7. Validate discovery follow-through:
- Run `discover_agents` with known venue in result.
- On next turn, verify one of:
  - target created
  - target executed (`publish`/`contact`)
  - target explicitly marked `blocked`/`skipped` with reason
- If ignored twice, confirm correction escalation (replan/pause/fail distribution attempt).

8. Validate ghost-goal prevention:
- Force planner/fallback to produce `0/0` executable tasks.
- Confirm goal is invalidated (failed/blocked/replanned), not kept active.

9. Validate heartbeat truth:
- Confirm heartbeat contains:
  - active projects summary
  - lane/status
  - blockers
  - next monetization step
  - spend/progress signal
- Force 20+ minute no-progress condition (or mocked equivalent) and confirm `stalled` state reporting.

## Pass/Fail Gate

Pass only if all are true:

- No dead-channel retry churn.
- No wake-check-sleep loop while ready monetization/distribution work exists.
- No active ghost goals (`0/0` tasks).
- Discovery follow-through enforcement triggers and escalates correctly.
- Portfolio state is visible and accurate in heartbeat output.
- Targeted regression suites pass.

Fail if any are false; capture logs and open a blocker issue before merge.

## Evidence Checklist

Attach to PR or release note:

- test command outputs
- heartbeat sample showing portfolio fields
- one transition log per channel type (`misconfigured`, `funding_required`, `quota_exhausted`/`cooldown`)
- one discovery follow-through correction example
- one ghost-goal invalidation example

## Rollout Note

After pass, keep Connie under elevated monitoring for first production window and watch for:
- repeated channel-state flips
- quota-induced inference churn
- no-progress cycles crossing policy thresholds
