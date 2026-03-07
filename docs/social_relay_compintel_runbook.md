# Social Relay Deployment Runbook (`relay.compintel.co`)

## Purpose

Deploy and operate the sovereign social relay backend used by Connie for signed message transport.

## Required Runtime Contract

- Base URL: `https://relay.compintel.co`
- Endpoints:
  - `POST /v1/messages`
  - `POST /v1/messages/poll`
  - `GET /v1/messages/count`
  - `GET /health`
- Security:
  - HTTPS-only public access
  - signature verification for send/poll/count
  - replay-window checks
  - payload-size and sender-rate limits

## Source Of Truth In Repo

- Relay server implementation: [src/social/relay-server.ts](/Users/damondecrescenzo/automaton-research/src/social/relay-server.ts)
- Relay process entrypoint: [src/social/relay-main.ts](/Users/damondecrescenzo/automaton-research/src/social/relay-main.ts)
- VPS deploy workflow: [.github/workflows/vps-deploy-relay.yml](/Users/damondecrescenzo/automaton-research/.github/workflows/vps-deploy-relay.yml)
- VPS check workflow: [.github/workflows/vps-check-relay.yml](/Users/damondecrescenzo/automaton-research/.github/workflows/vps-check-relay.yml)

## Deployment Steps

1. Ensure DNS for `relay.compintel.co` points to the VPS/reverse-proxy endpoint.
2. Ensure TLS cert is valid for `relay.compintel.co`.
3. Run GitHub workflow `VPS Deploy Social Relay`.
4. Ensure reverse proxy forwards `relay.compintel.co` to `127.0.0.1:8787`.
5. Set Connie config `socialRelayUrl` to `https://relay.compintel.co`.
6. Run GitHub workflow `VPS Check Social Relay`.

## Validation

- Local backend health: `http://127.0.0.1:8787/health` returns `{"status":"ok"}`
- Public health: `https://relay.compintel.co/health` returns `{"status":"ok"}`
- Connie startup log shows internal relay URL and no misconfigured social relay warning.
- `social_relay` distribution channel is `ready`.

## Failure Handling

- If service fails:
  - `systemctl status automaton-social-relay`
  - `journalctl -u automaton-social-relay -n 200 --no-pager`
- If public health fails but local health passes:
  - inspect reverse-proxy routing/TLS config
  - verify firewall allows `443`
- If Connie still reports relay misconfigured:
  - confirm `socialRelayUrl` persisted in runtime config
  - restart `local-connie`

## Quota Reset Gate

Run post-reset verification with evidence capture:

```bash
GATE_TIMESTAMP="2026-03-12T05:05:53Z" \
RELAY_URL="https://relay.compintel.co" \
VPS_HOST="<vps-host>" \
VPS_USER="<vps-user>" \
VPS_SSH_KEY="$(cat ~/.ssh/<keyfile>)" \
scripts/verify-phase11-quota-reset.sh
```

Expected:
- output shows `PHASE 11 QUOTA RESET GATE: PASS`
- `gate_result.json` is created in `/tmp/phase11_evidence_*`
- `failed_conditions` is an empty array
- schema reference: [phase11_gate_result_schema.json](/Users/damondecrescenzo/automaton-research/docs/phase11_gate_result_schema.json)

GitHub workflow alternative:
- Run `VPS Phase 11 Quota Gate`
- Workflow: [.github/workflows/vps-phase11-gate.yml](/Users/damondecrescenzo/automaton-research/.github/workflows/vps-phase11-gate.yml)
- Download artifact `phase11-gate-evidence-*` for logs and `gate_result.json`.
- Evidence contract: [phase11_gate_evidence_contract.md](/Users/damondecrescenzo/automaton-research/docs/phase11_gate_evidence_contract.md)

## Observability & Telemetry

For real-time monitoring of Connie's agent loop, relay events, and service health:

- **Setup**: Run `scripts/setup-betterstack.sh` (requires free logs.betterstack.com account)
- **Logs shipped**: App log, heartbeat diagnostics, relay/caddy/connie systemd journal
- **Queries**: `level:error`, `module:loop`, `message:"social_relay"`, `source:systemd`
- **UI**: https://logs.betterstack.com (live tail updates every 30s)
