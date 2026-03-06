# ⏰ MARCH 12, 2026 QUOTA RESET GATE REMINDER

**CRITICAL**: Phase 11 Sovereign Relay gate execution is scheduled for this date and time.

---

## Gate Activation Window

**Date & Time**: March 12, 2026 at **05:05:53 UTC**

**Calendar Entry**:
```
Event: Phase 11 Quota Reset Gate Verification
Date: 2026-03-12
Start Time: 05:05:53 UTC
Duration: ~5-10 minutes (execution) + 10-20 minutes (result review + first-cycle monitoring)
Reminders:
  - 2026-03-12 04:55:53 UTC (10 minutes before)
  - 2026-03-12 05:00:53 UTC (5 minutes before)
```

---

## Execution Checklist

### T-10 minutes (04:55:53 UTC)
- [ ] Verify main branch is up to date: `git log --oneline -1`
- [ ] Confirm VPS services are stable:
  ```bash
  ssh root@66.135.29.159 "systemctl status caddy automaton-social-relay"
  ```
- [ ] Test relay health endpoint:
  ```bash
  curl -s https://relay.compintel.co/health | jq .
  ```

### T-5 minutes (05:00:53 UTC)
- [ ] Prepare GitHub workflow execution or manual script
- [ ] Verify GitHub secrets are configured (VPS_HOST, VPS_USER, VPS_SSH_KEY)
- [ ] Have terminal open and ready for execution

### T+0 (05:05:53 UTC) - Execute
- [ ] **Option A (Recommended)**: GitHub Actions
  ```bash
  gh workflow run vps-phase11-gate.yml --ref main \
    -f gate_timestamp="2026-03-12T05:05:53Z" \
    -f relay_url="https://relay.compintel.co"

  # Monitor execution
  gh run list --workflow vps-phase11-gate.yml --limit 1
  gh run view <RUN_ID> --log
  ```

- [ ] **Option B**: Manual script
  ```bash
  scripts/verify-phase11-quota-reset.sh
  ```

### T+1-2 minutes (05:06:53-05:07:53 UTC) - Monitor
- [ ] Gate script running
- [ ] Evidence directory being created
- [ ] Relay health check executing

### T+3-5 minutes (05:08:53-05:10:53 UTC) - Results
- [ ] Retrieve gate result:
  ```bash
  # GitHub Actions
  gh run download <RUN_ID> -n phase11-gate-evidence-<RUN_ID>
  cat phase11-gate-evidence-*/gate_result.json | jq .

  # Manual
  cat /tmp/phase11_evidence_*/gate_result.json | jq .
  ```

- [ ] Check result status:
  - If `"pass": true` → **Proceed to Post-Gate Operations**
  - If `"pass": false` → **DO NOT RESUME; investigate blocker**

---

## Post-Gate Actions (If PASS)

### T+5-10 minutes (05:10:53-05:15:53 UTC)
- [ ] Archive evidence directory (local or GitHub artifacts)
- [ ] Update gate report in [connie_revamp_march6_handoff.md](./connie_revamp_march6_handoff.md)
  - Fill in workflow URL, artifact path, gate_result.json summary
- [ ] Verify social_relay channel state:
  ```bash
  ssh root@66.135.29.159 \
    "tail -50 /root/.automaton-research-home/connie-agent/logs/heartbeat.log | grep social_relay"
  ```

### T+10-30 minutes (05:15:53-05:35:53 UTC) - First-Cycle Monitoring
- [ ] Monitor Connie's first active cycle after quota reset
  - Verify `social_relay` channel transitions to `ready`
  - Confirm successful `/v1/messages/*` operations
  - Watch for wake-check-sleep churn or dead-channel retries

- [ ] Capture evidence:
  ```bash
  ssh root@66.135.29.159 "tail -50 /root/.automaton-research-home/connie-agent/logs/heartbeat.log"
  ssh root@66.135.29.159 "tail -50 /var/log/relay.log || journalctl -u automaton-social-relay -n 50"
  ssh root@66.135.29.159 "tail -20 /root/.automaton-research-home/connie-agent/logs/inference.log"
  ```

### T+30 minutes (05:35:53 UTC) - Report
- [ ] Complete gate report entries in handoff doc:
  - First-cycle observations
  - Channel state progression
  - Relay traffic verification
  - Governance behavior check
  - Decision & sign-off

- [ ] Upload evidence artifacts and finalize report

---

## Blocker Handling (If FAIL)

**DO NOT RESUME Connie operations** if `"pass": false`

**Investigate**:
```bash
# Check which condition failed
cat /tmp/phase11_evidence_*/gate_result.json | jq .results

# Troubleshooting guide
# See: docs/phase11_quota_reset_gate_procedure.md (Troubleshooting section)
```

**Re-run gate** after fixes are applied.

---

## Quick Links

- **Gate Procedure**: [phase11_quota_reset_gate_procedure.md](./phase11_quota_reset_gate_procedure.md)
- **Relay Runbook**: [social_relay_compintel_runbook.md](./social_relay_compintel_runbook.md)
- **Verification Script**: [scripts/verify-phase11-quota-reset.sh](../scripts/verify-phase11-quota-reset.sh)
- **Gate Workflow**: [.github/workflows/vps-phase11-gate.yml](../.github/workflows/vps-phase11-gate.yml)
- **Handoff Report**: [connie_revamp_march6_handoff.md](./connie_revamp_march6_handoff.md#phase-11-quota-reset-gate-execution-report)

---

## Automation Alternative

If available, consider scheduling this gate execution via:
- GitHub Actions scheduled workflow (cron at 05:05:53 UTC)
- System cron job (with proper timezone UTC handling)
- Calendar reminder with automation script trigger

**Example cron** (run on machine in UTC timezone):
```bash
# Run gate at 05:05:53 UTC on March 12, 2026
5 5 12 3 * cd /path/to/automaton-research && bash scripts/verify-phase11-quota-reset.sh >> /tmp/gate_execution.log 2>&1
```

---

**Status**: 🟢 Ready for March 12, 2026 execution
**Last Updated**: 2026-03-06
**Next Review**: 2026-03-11 (day before gate)
