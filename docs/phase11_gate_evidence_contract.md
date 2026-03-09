# Phase 11 Gate Evidence Directory Contract

This document defines the authoritative evidence directory contract for `scripts/verify-phase11-quota-reset.sh` and `.github/workflows/vps-phase11-gate.yml`.

## Resolution Order

The script resolves the evidence directory in this order:

1. `EVIDENCE_DIR` (if set)
2. `OUTPUT_DIR` (if set)
3. auto-generated `/tmp/phase11_evidence_<timestamp>`

After resolution, both `EVIDENCE_DIR` and `OUTPUT_DIR` are exported to the same final path.

## Required Artifacts

The gate run must produce these files in the resolved directory:

- `relay_health.json`
- `relay_health_status_code.txt`
- `tls_certificate.txt`
- `channel_heartbeat.log`
- `channel_errors.log`
- `churn_signals.log`
- `message_endpoint_probe.json`
- `message_endpoint_probe_status_code.txt`
- `caddy_status.txt`
- `relay_service_status.txt`
- `caddy_recent_logs.log`
- `relay_recent_logs.log`
- `gate_result.json`

Conditional artifacts:

- `critical_service_errors.log` (when critical service errors are detected)
- `signed_probe.log` / `signed_probe.err` (when `SIGNED_PROBE_REQUIRED=true`)

## Workflow Contract

The workflow must:

1. Provide `OUTPUT_DIR` before invoking the script.
2. Validate `${OUTPUT_DIR}/gate_result.json` exists.
3. Validate JSON shape with `jq` before artifact upload.
4. Upload `${OUTPUT_DIR}` as `phase11-gate-evidence-<run_id>`.

## Failure Semantics

- Script exit code is authoritative:
  - `0` => PASS
  - `1` => FAIL
- Workflow should fail if:
  - script exits non-zero
  - `gate_result.json` is missing
  - `gate_result.json` fails schema/key checks

