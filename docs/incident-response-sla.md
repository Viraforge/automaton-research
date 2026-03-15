# Incident Response — On-Call, Alerting, and Response SLAs

> Effective: 2026-03-15
> Owner: Senior Platform Engineer
> Reference: DLD-182

## 1. On-Call Ownership

| Role | Responsibility |
|------|---------------|
| **Primary on-call** | Senior Platform Engineer |
| **Escalation L1** | CTO |
| **Escalation L2** | CEO |

**Coverage:** All compintel.co production services validated by H2 gate.

### On-Call Schedule

- **Primary:** Senior Platform Engineer — 24/7 automated monitoring via BetterStack
- **Escalation:** CTO is paged if primary does not acknowledge within 15 minutes
- **CEO escalation:** triggered for P0 incidents exceeding 1 hour without mitigation

## 2. Monitored Services

Services passing H2 validation (DLD-180) as of 2026-03-15:

| Service | Health Endpoint | Status |
|---------|----------------|--------|
| Polymarket API | `https://polymarket.compintel.co/health` | CONDITIONAL GO |
| Premium Analytics | `https://premium-analytics.compintel.co/health` | CONDITIONAL GO |
| Revenue Tracker | `https://revenue-tracker.compintel.co/health` | CONDITIONAL GO (bug: `/api/revenue` ungated) |
| Webhook Service | `https://webhook-service.compintel.co/health` | NO-GO (404 on paid endpoint) |

**Monitor criteria:** HTTP GET to health endpoint must return 200 with valid JSON containing `"status":"ok"`.

### BetterStack Uptime Monitors (pending API token)

Each validated service requires a BetterStack uptime monitor with:
- **Monitor type:** `status` (HTTP keyword)
- **Check frequency:** 60 seconds
- **Expected status:** 200
- **Expected keyword:** `"status":"ok"`
- **Alert channels:** email + webhook (configured in BetterStack)

**Blocker:** BetterStack Uptime API token is not yet provisioned. The existing logging source token (`s2298532`) is for log ingestion only. Board/CTO must generate an Uptime API token from BetterStack Settings > API tokens.

## 3. Alert Routing

```
Service degradation detected (non-200 or unreachable)
    │
    ├─► BetterStack fires alert (within 60s of failure)
    │
    ├─► Page SLA: on-call notified within 5 minutes
    │
    ├─► If no ACK within 15 min → escalate to CTO
    │
    └─► If P0 and no mitigation within 1 hour → escalate to CEO
```

## 4. Response SLAs

| SLA | Target | Applies To |
|-----|--------|-----------|
| **Acknowledge** | 15 minutes from page | All severities |
| **Mitigate** | 1 hour from acknowledgment | P0, P1 |
| **Mitigate** | 4 hours from acknowledgment | P2 |
| **Mitigate** | Next business day | P3 |
| **Post-mortem** | 24 hours from resolution | P0, P1 |

## 5. Incident Classification

| Severity | Definition | Example |
|----------|-----------|---------|
| **P0** | All services down or x402 payments failing | VPS unreachable, Caddy crash, all health endpoints 5xx |
| **P1** | Single service degraded, payments affected | One API returning 500s, x402 verification broken |
| **P2** | Single service degraded, no payment impact | Slow response times, partial data, elevated error rate |
| **P3** | Non-user-facing issue | Log rotation failure, disk warning, monitoring gap |

## 6. Incident Response Procedure

### Detection
1. BetterStack uptime monitor detects failure (automated)
2. Manual report via Paperclip issue (human-triggered)
3. Log anomaly detected in BetterStack Logs (proactive)

### Triage (within 15 min of page)
1. Acknowledge the alert in BetterStack
2. Classify severity (P0–P3)
3. Create Paperclip issue if not already tracked
4. Post initial status update

### Mitigation
1. SSH to VPS (`64.176.199.191`) — verify systemd service status
2. Check Caddy reverse proxy: `systemctl status caddy`, review `/etc/caddy/Caddyfile`
3. Check application logs: BetterStack Logs dashboard or `journalctl -u <service>`
4. If service crash: `systemctl restart <service>`, verify health endpoint
5. If Caddy issue: check TLS certs, upstream config, restart if needed
6. If VPS issue: check Vultr console, verify network connectivity

### Rollback Triggers
- Deploy caused the incident → revert to previous git SHA, restart service
- Config change caused it → restore previous config from git history
- Infrastructure change → revert via Vultr console or Caddy config rollback

### Post-Mortem (P0/P1 only, within 24h)
1. Timeline of events (detection → acknowledgment → mitigation → resolution)
2. Root cause analysis
3. Impact assessment (duration, affected services, payment impact)
4. Action items to prevent recurrence
5. Post as Paperclip issue comment and commit to `docs/postmortems/`

## 7. Communication Templates

### Initial Status Update
```
## Incident: [P0/P1/P2/P3] — [Brief description]
- **Detected:** [timestamp]
- **Acknowledged:** [timestamp]
- **Affected services:** [list]
- **Impact:** [user-facing impact]
- **Status:** Investigating / Mitigating
```

### Resolution Update
```
## Resolved: [Brief description]
- **Duration:** [start → end]
- **Root cause:** [one line]
- **Fix applied:** [what changed]
- **Post-mortem:** [link, if P0/P1]
```
