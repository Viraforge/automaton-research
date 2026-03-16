# Merge Policy

## Auto-Merge Conditions

A pull request is automatically merged when **all** of the following are true:

1. CI status checks pass (`verify`, `policy`)
2. `ai-review/verdict` commit status is `PASS` or `PASS_WITH_NOTES`
3. PR is not classified as `HIGH_RISK`
4. No unresolved `BLOCKER` findings from the AI Code Reviewer

## Human Approval Required

A PR requires human approval when any of the following are true:

- `ai-review/verdict` = `HIGH_RISK_HUMAN_REQUIRED`
- PR touches high-risk areas:
  - Authentication logic (auth, login, session, token, JWT, OAuth)
  - Authorization / permissions (RBAC, ACL, roles, policy)
  - Secrets or environment variables (.env, credentials, API keys)
  - Deployment workflows (.github/workflows/, Dockerfile, docker-compose)
  - Infrastructure configs (Terraform, Ansible, k8s, Nginx, Caddyfile)
  - Database migrations (schema changes, ALTER TABLE, DROP)
  - Billing / payments (Stripe, invoices, subscriptions)
- AI Code Reviewer confidence is explicitly low
- Any `BLOCKER` finding remains unresolved

When human approval is required, the merge automation posts a comment on the PR requesting review.

## Workflow

```
Developer Agent produces commit
  → Platform Engineer pushes branch and opens PR
    → CI runs (verify, policy)
    → AI Code Reviewer reviews and sets ai-review/verdict
      → PASS / PASS_WITH_NOTES → auto-merge
      → FAIL → author fixes, reviewer re-evaluates
      → HIGH_RISK_HUMAN_REQUIRED → human reviews and approves
```

## Merge Method

All auto-merges use **squash merge** to keep the main branch history clean.

## Implementation

The merge automation is implemented as a GitHub Actions workflow (`.github/workflows/merge-automation.yml`) that triggers on `status` events. It evaluates merge conditions when `ai-review/verdict` is posted and either merges automatically or requests human approval.
