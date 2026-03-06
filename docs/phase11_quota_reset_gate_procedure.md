# Phase 11 Quota Reset Gate Activation Procedure

**Gate Activation Time**: 2026-03-12 05:05:53 UTC
**Status**: ✅ Ready for execution
**Repository State**: PR #28 merged to main (commit a4fc04b)

---

## Overview

This document defines the gate activation sequence for Phase 11 Sovereign Relay at the BYOK quota reset boundary. The gate verifies operational readiness before resuming Connie inference operations.

## Gate Activation Sequence

### Phase 0: Pre-Gate Readiness (Before 05:05:53 UTC)

- [ ] Verify PR #28 merged to main: **✅ DONE** (a4fc04b)
- [ ] Confirm VPS services stable: Caddy + relay running
- [ ] Confirm DNS propagated: relay.compintel.co → 66.135.29.159
- [ ] Confirm TLS certificate valid (Let's Encrypt)
- [ ] Have GitHub secrets ready: VPS_HOST, VPS_USER, VPS_SSH_KEY

### Phase 1: Execute Gate Verification (05:05:53 UTC +0s)

**Option A: GitHub Actions Workflow** (Recommended)

```bash
gh workflow run vps-phase11-gate.yml \
  --ref main \
  -f gate_timestamp="2026-03-12T05:05:53Z" \
  -f relay_url="https://relay.compintel.co"
```

Monitor workflow run:
```bash
gh run list --workflow vps-phase11-gate.yml --limit 1 --json number,status,createdAt
gh run view <RUN_ID> --log  # View logs in real-time
```

**Option B: Manual Script Execution**

```bash
# On local machine with SSH access to VPS
VPS_HOST="66.135.29.159" \
VPS_USER="root" \
VPS_SSH_KEY="$(cat ~/.ssh/vps_key)" \
scripts/verify-phase11-quota-reset.sh
```

### Phase 2: Evaluate Gate Result (05:05:53 UTC +30s to +60s)

**Success Criteria** (all must be true):

1. ✅ `social_relay_ready = true`
   - Channel state is "ready" (not cooldown, misconfigured, or quota_exhausted)

2. ✅ `relay_routing_operational = true`
   - Message endpoint (`POST /v1/messages/*`) returns 4xx (auth), not 5xx (server error)
   - Proves end-to-end routing works

3. ✅ `all_services_active = true`
   - Caddy service active
   - Relay service active
   - No recent critical errors in service logs

4. ✅ `pass = true`
   - Overall gate result is PASS

**Retrieve Results**:

```bash
# GitHub Actions artifact
gh run download <RUN_ID> -n phase11-gate-evidence-<RUN_ID>
cat phase11-gate-evidence-*/gate_result.json | jq .

# Manual script execution
cat /tmp/phase11_evidence_*/gate_result.json | jq .
```

### Phase 3: Interpretation & Decision

**If Gate Passes** (`pass: true` in gate_result.json):

```json
{
  "timestamp": "2026-03-12T05:05:53Z",
  "results": {
    "social_relay_ready": true,
    "relay_routing_operational": true,
    "all_services_active": true
  },
  "pass": true,
  "evidence_directory": "/tmp/phase11_evidence_..."
}
```

→ **Proceed to Phase 4: Resume Operations**

**If Gate Fails** (`pass: false`):

```json
{
  "pass": false,
  "results": {
    "social_relay_ready": false,
    "relay_routing_operational": true,
    "all_services_active": true
  }
}
```

→ **Do NOT resume Connie operations**
→ **Investigate failed conditions** (see Troubleshooting section)
→ **Re-run gate** after fixes

---

## Phase 4: Post-Gate Operations (If PASS)

### 4a: First-Cycle Monitoring (Immediate)

**Observe first active cycle of Connie after quota reset activation**.

Monitor for:
- [ ] `social_relay` channel transitions to `ready` state
- [ ] No error states: cooldown, misconfigured, quota_exhausted
- [ ] Successful `/v1/messages/*` operations (real relay traffic)
- [ ] No churn: wake-check-sleep loops, dead-channel retries

**Evidence to Capture**:

```bash
# Check channel heartbeat
ssh root@66.135.29.159 \
  "tail -50 /root/.automaton-research-home/connie-agent/logs/heartbeat.log | grep social_relay"

# Check relay access logs
ssh root@66.135.29.159 \
  "tail -50 /var/log/relay.log || journalctl -u automaton-social-relay -n 50"

# Verify Connie inference ops
ssh root@66.135.29.159 \
  "tail -50 /root/.automaton-research-home/connie-agent/logs/inference.log | head -20"
```

### 4b: Gate Report Generation

Create gate activation report documenting:

```markdown
## Phase 11 Quota Reset Gate Report

**Gate Execution Time**: 2026-03-12T05:05:53Z
**Result**: PASS / FAIL
**Evidence Path**: /tmp/phase11_evidence_* or artifacts/phase11-gate-evidence-*

### Verification Results
- social_relay_ready: true/false
- relay_routing_operational: true/false
- all_services_active: true/false

### First Cycle Observations
- Relay traffic observed: YES/NO
- Channel state progression: ready/cooldown/error
- Any service restarts: YES/NO
- Churn indicators: present/absent

### Artifact Inventory
- relay_health.json
- tls_certificate.txt
- channel_heartbeat.log
- message_endpoint_probe.json
- caddy_recent_logs.log
- gate_result.json

### Sign-Off
Generated: [timestamp]
Operator: [name]
Status: [ready/blocked/investigating]
```

Append to: `docs/connie_revamp_march6_handoff.md` (Operations section)

---

## Evidence Artifacts

The gate verification produces these evidence files for audit trail:

| File | Purpose | Success Indicator |
|------|---------|-------------------|
| `relay_health.json` | Health endpoint response | `{"status":"ok"}` with HTTP 200 |
| `tls_certificate.txt` | Certificate validity | Issuer: Let's Encrypt, not expired |
| `channel_heartbeat.log` | Channel state snapshot | Contains "ready" (no error keywords) |
| `message_endpoint_probe.json` | Message routing test | HTTP 401/403/404/200 (not 5xx) |
| `caddy_recent_logs.log` | Service health logs | No "failed", "inactive", "error" |
| `gate_result.json` | Structured pass/fail | `"pass": true` with all conditions true |

---

## Troubleshooting

### If `social_relay_ready = false`

**Symptoms**: `"ready"` not found in heartbeat, or error keywords present

**Investigation**:
```bash
ssh root@66.135.29.159 \
  "grep social_relay /root/.automaton-research-home/connie-agent/logs/heartbeat.log | tail -20"
```

**Common Causes**:
- Channel still in cooldown from quota reset
- Configuration not persisted (check `socialRelayUrl`)
- Relay endpoint unreachable (check network/firewall)

**Remediation**:
- Wait for cooldown timer to expire
- Verify `socialRelayUrl` in Connie config
- Run `VPS Check Social Relay` workflow
- Check firewall rules (ports 80/443 open)

### If `relay_routing_operational = false`

**Symptoms**: `message_endpoint_probe.json` shows HTTP 5xx error

**Investigation**:
```bash
curl -X POST https://relay.compintel.co/v1/messages/test \
  -H "Content-Type: application/json" \
  -d '{"test": true}' -v

ssh root@66.135.29.159 "journalctl -u automaton-social-relay -n 100"
```

**Common Causes**:
- Relay service crashed during quota reset
- Reverse proxy config corrupted (check Caddy)
- Message validation failure (signature/rate limits)

**Remediation**:
- Restart relay: `ssh root@66.135.29.159 systemctl restart automaton-social-relay`
- Check Caddy config: `ssh root@66.135.29.159 caddy validate --config /etc/caddy/Caddyfile`
- Run TLS workflow: `gh workflow run vps-tls-relay.yml`

### If `all_services_active = false`

**Symptoms**: Caddy or relay service inactive

**Investigation**:
```bash
ssh root@66.135.29.159 systemctl status caddy automaton-social-relay
```

**Common Causes**:
- Service crashed during quota reset
- Missing dependencies or config files
- Resource exhaustion (disk, memory)

**Remediation**:
- Restart services: `ssh root@66.135.29.159 systemctl restart caddy automaton-social-relay`
- Check logs: `ssh root@66.135.29.159 journalctl -p err -n 50`
- Verify disk space: `ssh root@66.135.29.159 df -h`

---

## Success Scenario

```
========================================
Phase 11 Sovereign Relay Verification
Date: 2026-03-12 05:05:53 UTC
==========================================

[1/4] Checking relay endpoint health...
✓ Relay health endpoint responding (HTTP 200)
✓ Relay status is 'ok'

[2/4] Verifying TLS certificate...
✓ TLS certificate valid

[3/4] Checking social_relay channel readiness...
✓ VPS accessible via SSH
✓ social_relay channel shows 'ready' state
✓ No error states detected in heartbeat

[4/4] Testing end-to-end message routing...
✓ Message endpoint reachable (HTTP 403 - auth expected)
  This proves relay routing is working end-to-end

[5/5] Verifying relay service operational status...
✓ Caddy service is active
✓ Relay service is active

═══════════════════════════════════════════════════════
PHASE 11 QUOTA RESET GATE: ✅ PASS
═══════════════════════════════════════════════════════

Structured result written to: /tmp/phase11_evidence_20260312_050553/gate_result.json
```

→ Proceed with Phase 4 operations

---

## Rollback Plan

If gate verification fails and investigative remediation is unsuccessful:

1. **Keep quota reset paused** - Do not resume inference operations
2. **File incident report** with all evidence artifacts and timestamps
3. **Escalate to infrastructure team** for detailed analysis
4. **Re-run gate** once remediation is applied and verified
5. **Document incident** in ops log for future reference

---

## Related Documentation

- [Phase 11 Sovereign Relay Runbook](./social_relay_compintel_runbook.md)
- [Connie Revamp Handoff](./connie_revamp_march6_handoff.md)
- [VPS Phase 11 Gate Workflow](./.github/workflows/vps-phase11-gate.yml)
- [Verification Script](./scripts/verify-phase11-quota-reset.sh)

---

**Generated**: 2026-03-06
**Status**: Ready for March 12, 2026 05:05:53 UTC execution
**Approval**: Phase 11 infrastructure complete, relay endpoint operational
