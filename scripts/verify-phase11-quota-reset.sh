#!/usr/bin/env bash
set -euo pipefail

GATE_TIMESTAMP="${GATE_TIMESTAMP:-2026-03-12T05:05:53Z}"
RELAY_URL="${RELAY_URL:-https://relay.compintel.co}"
RELAY_HOST="${RELAY_HOST:-relay.compintel.co}"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/phase11_evidence_$(date -u +%Y%m%dT%H%M%SZ)}"

mkdir -p "$OUTPUT_DIR"

fail_reasons=()

record_failure() {
  fail_reasons+=("$1")
}

echo "Evidence directory: $OUTPUT_DIR"
echo "Gate timestamp: $GATE_TIMESTAMP"
echo ""

echo "[1/4] Relay endpoint health"
HEALTH_HTTP_CODE="$(curl -sS -o "$OUTPUT_DIR/relay_health.json" -w "%{http_code}" "$RELAY_URL/health" || echo "000")"
health_ok="false"
if [ "$HEALTH_HTTP_CODE" = "200" ] && python3 - <<'PY' "$OUTPUT_DIR/relay_health.json"
import json, sys
try:
    data = json.load(open(sys.argv[1], "r", encoding="utf-8"))
    raise SystemExit(0 if data.get("status") == "ok" else 1)
except Exception:
    raise SystemExit(1)
PY
then
  health_ok="true"
  echo "PASS: relay /health returned HTTP 200 and status=ok"
else
  record_failure "relay_health"
  echo "FAIL: relay /health check failed (code=$HEALTH_HTTP_CODE)"
fi
echo ""

echo "[2/4] TLS certificate"
tls_ok="false"
{
  echo | openssl s_client -servername "$RELAY_HOST" -connect "$RELAY_HOST:443" 2>/dev/null | \
    openssl x509 -noout -issuer -subject -dates
} >"$OUTPUT_DIR/tls_certificate.txt" || true

if grep -qi "Let's Encrypt" "$OUTPUT_DIR/tls_certificate.txt" && python3 - <<'PY' "$OUTPUT_DIR/tls_certificate.txt"
from datetime import datetime, timezone
import sys

not_before = None
not_after = None
for line in open(sys.argv[1], "r", encoding="utf-8"):
    line = line.strip()
    if line.startswith("notBefore="):
        not_before = datetime.strptime(line.split("=", 1)[1], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
    if line.startswith("notAfter="):
        not_after = datetime.strptime(line.split("=", 1)[1], "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
now = datetime.now(timezone.utc)
ok = bool(not_before and not_after and not_before <= now <= not_after)
raise SystemExit(0 if ok else 1)
PY
then
  tls_ok="true"
  echo "PASS: TLS certificate valid and issued by Let's Encrypt"
else
  record_failure "tls_certificate"
  echo "FAIL: TLS certificate check failed"
fi
echo ""

echo "[3/4] Message-path probe"
PROBE_HTTP_CODE="$(curl -sS -o "$OUTPUT_DIR/message_endpoint_probe.json" -w "%{http_code}" \
  -X POST "$RELAY_URL/v1/messages/test" \
  -H "Content-Type: application/json" \
  --data '{"gate":"phase11-quota-reset"}' || echo "000")"

relay_routing_operational="false"
case "$PROBE_HTTP_CODE" in
  200|401|403|404)
    relay_routing_operational="true"
    echo "PASS: message endpoint reachable (HTTP $PROBE_HTTP_CODE)"
    ;;
  *)
    record_failure "relay_routing"
    echo "FAIL: message endpoint probe failed (HTTP $PROBE_HTTP_CODE)"
    ;;
esac
echo ""

echo "[4/4] Channel readiness and service checks"
all_services_active="false"
social_relay_ready="false"
no_error_loops="true"
successful_relay_message_op="false"

SSH_OK="false"
if [ -n "${VPS_HOST:-}" ] && [ -n "${VPS_USER:-}" ] && [ -n "${VPS_SSH_KEY:-}" ]; then
  SSH_KEY_FILE="$OUTPUT_DIR/vps_ssh_key"
  printf "%s\n" "$VPS_SSH_KEY" >"$SSH_KEY_FILE"
  chmod 600 "$SSH_KEY_FILE"
  SSH_OK="true"

  ssh -i "$SSH_KEY_FILE" -o BatchMode=yes -o StrictHostKeyChecking=no -o ConnectTimeout=15 \
    "$VPS_USER@$VPS_HOST" 'bash -s' -- "$GATE_TIMESTAMP" >"$OUTPUT_DIR/vps_snapshot.log" <<'REMOTE'
set -euo pipefail
GATE_TS="$1"

CONNIE_HOME="$(grep 'Environment=HOME=' /etc/systemd/system/local-connie.service 2>/dev/null | sed 's/.*HOME=//')"
if [ -z "$CONNIE_HOME" ]; then
  CONNIE_HOME="$HOME"
fi

echo "=== SERVICE_STATUS ==="
echo "caddy=$(systemctl is-active caddy 2>/dev/null || echo unknown)"
echo "relay=$(systemctl is-active automaton-social-relay 2>/dev/null || echo unknown)"
echo "connie=$(systemctl is-active local-connie 2>/dev/null || echo unknown)"

echo "=== HEARTBEAT_LOG ==="
HB_LOG="$CONNIE_HOME/.automaton/discord-heartbeat.log"
if [ -f "$HB_LOG" ]; then
  tail -400 "$HB_LOG"
else
  echo "missing:$HB_LOG"
fi

echo "=== APP_LOG ==="
if [ -f /tmp/connie-research.log ]; then
  tail -2000 /tmp/connie-research.log
else
  echo "missing:/tmp/connie-research.log"
fi

echo "=== RELAY_LOG ==="
journalctl -u automaton-social-relay --since "$GATE_TS" --no-pager -n 500 2>/dev/null || true

echo "=== CADDY_LOG ==="
journalctl -u caddy --since "$GATE_TS" --no-pager -n 300 2>/dev/null || true
REMOTE

  awk '/^=== HEARTBEAT_LOG ===/{flag=1;next}/^=== APP_LOG ===/{flag=0}flag' \
    "$OUTPUT_DIR/vps_snapshot.log" >"$OUTPUT_DIR/channel_heartbeat.log"
  awk '/^=== APP_LOG ===/{flag=1;next}/^=== RELAY_LOG ===/{flag=0}flag' \
    "$OUTPUT_DIR/vps_snapshot.log" >"$OUTPUT_DIR/connie_app.log"
  awk '/^=== RELAY_LOG ===/{flag=1;next}/^=== CADDY_LOG ===/{flag=0}flag' \
    "$OUTPUT_DIR/vps_snapshot.log" >"$OUTPUT_DIR/relay_service.log"
  awk '/^=== CADDY_LOG ===/{flag=1;next}flag' \
    "$OUTPUT_DIR/vps_snapshot.log" >"$OUTPUT_DIR/caddy_recent_logs.log"
else
  echo "WARN: VPS_HOST/VPS_USER/VPS_SSH_KEY not set; skipping SSH checks"
fi

if [ "$SSH_OK" = "true" ]; then
  if grep -q "caddy=active" "$OUTPUT_DIR/vps_snapshot.log" && grep -q "relay=active" "$OUTPUT_DIR/vps_snapshot.log"; then
    all_services_active="true"
    echo "PASS: caddy and relay services are active"
  else
    record_failure "service_status"
    echo "FAIL: caddy and/or relay service not active"
  fi

  if grep -Eiq 'social_relay[^[:alnum:]]+ready|"social_relay".*"ready"' "$OUTPUT_DIR/channel_heartbeat.log" "$OUTPUT_DIR/connie_app.log" && \
     ! grep -Eiq 'social_relay[^[:alnum:]]+(cooldown|misconfigured|quota_exhausted|funding_required)' "$OUTPUT_DIR/channel_heartbeat.log" "$OUTPUT_DIR/connie_app.log"
  then
    social_relay_ready="true"
    echo "PASS: social_relay reached ready state without blocker status"
  else
    record_failure "social_relay_ready"
    echo "FAIL: social_relay ready state not confirmed"
  fi

  if grep -Eiq 'wake-check-sleep|no progress cycle|repeated failure signature|churn' "$OUTPUT_DIR/connie_app.log"; then
    no_error_loops="false"
    record_failure "error_loops"
    echo "FAIL: loop/churn pattern detected"
  else
    echo "PASS: no obvious loop/churn patterns detected"
  fi

  if grep -Eiq '/v1/messages/.+ (200|201|202)|relay.*(message|publish).*(success|sent|queued|posted)' "$OUTPUT_DIR/connie_app.log" "$OUTPUT_DIR/relay_service.log"; then
    successful_relay_message_op="true"
    echo "PASS: observed successful relay message operation"
  else
    record_failure "relay_message_success"
    echo "FAIL: no successful relay message operation observed"
  fi
else
  # Degraded mode: allow non-SSH checks only.
  all_services_active="false"
  social_relay_ready="false"
  no_error_loops="true"
  successful_relay_message_op="false"
  record_failure "ssh_unavailable"
fi
echo ""

pass="false"
if [ "$social_relay_ready" = "true" ] && \
   [ "$no_error_loops" = "true" ] && \
   [ "$relay_routing_operational" = "true" ] && \
   [ "$all_services_active" = "true" ] && \
   [ "$successful_relay_message_op" = "true" ] && \
   [ "$health_ok" = "true" ] && \
   [ "$tls_ok" = "true" ]; then
  pass="true"
fi

python3 - <<'PY' \
  "$OUTPUT_DIR/gate_result.json" \
  "$GATE_TIMESTAMP" \
  "$social_relay_ready" \
  "$no_error_loops" \
  "$relay_routing_operational" \
  "$all_services_active" \
  "$successful_relay_message_op" \
  "$pass" \
  "$OUTPUT_DIR"
import json
import sys
from datetime import datetime, timezone

path = sys.argv[1]
gate_ts = sys.argv[2]
social_relay_ready = sys.argv[3] == "true"
no_error_loops = sys.argv[4] == "true"
relay_routing_operational = sys.argv[5] == "true"
all_services_active = sys.argv[6] == "true"
successful_relay_message_op = sys.argv[7] == "true"
passed = sys.argv[8] == "true"
evidence_dir = sys.argv[9]

payload = {
    "timestamp": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "quota_reset_gate": gate_ts,
    "results": {
        "social_relay_ready": social_relay_ready,
        "no_error_loops": no_error_loops,
        "relay_routing_operational": relay_routing_operational,
        "all_services_active": all_services_active,
        "successful_relay_message_op": successful_relay_message_op,
    },
    "pass": passed,
    "evidence_directory": evidence_dir,
}

with open(path, "w", encoding="utf-8") as f:
    json.dump(payload, f, indent=2)
PY

echo "============================================================"
if [ "$pass" = "true" ]; then
  echo "PHASE 11 QUOTA RESET GATE: PASS"
else
  echo "PHASE 11 QUOTA RESET GATE: FAIL"
fi
echo "gate_result.json: $OUTPUT_DIR/gate_result.json"
echo "============================================================"

if [ "${#fail_reasons[@]}" -gt 0 ]; then
  printf "Failed conditions: %s\n" "${fail_reasons[*]}"
fi

if [ "$pass" != "true" ]; then
  exit 1
fi
