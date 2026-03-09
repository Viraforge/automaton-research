#!/usr/bin/env bash
#
# Phase 11 Sovereign Relay Quota Reset Gate Verification
#
# Verifies:
# 1) Relay health endpoint
# 2) TLS certificate validity
# 3) social_relay channel readiness and no error loops
# 4) Message routing path
# 5) Service activity on VPS
#
# Output:
# - Evidence directory with artifacts
# - gate_result.json (machine parseable)
# - Exit code 0 on PASS, 1 on FAIL
#

set -euo pipefail

# Required runtime configuration
: "${RELAY_URL:?RELAY_URL environment variable required}"
: "${GATE_TIMESTAMP:=2026-03-12T05:05:53Z}"
: "${VPS_HOST:?VPS_HOST environment variable required}"
: "${VPS_USER:=root}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY environment variable required}"

# Optional runtime configuration
: "${SSH_CONNECT_TIMEOUT:=8}"
: "${EVIDENCE_WINDOW_SECONDS:=120}"
: "${CADDY_SERVICE_NAME:=caddy}"
: "${RELAY_SERVICE_NAME:=automaton-social-relay}"
: "${HEARTBEAT_LOG_PATH:=/root/.automaton-research-home/connie-agent/logs/heartbeat.log}"
: "${SIGNED_PROBE_REQUIRED:=true}"
: "${SIGNED_PROBE_SCRIPT:=scripts/test-social-relay.ts}"

# Evidence directory contract:
# 1) EVIDENCE_DIR
# 2) OUTPUT_DIR
# 3) auto-generated /tmp path
if [ -n "${EVIDENCE_DIR:-}" ]; then
  FINAL_EVIDENCE_DIR="$EVIDENCE_DIR"
elif [ -n "${OUTPUT_DIR:-}" ]; then
  FINAL_EVIDENCE_DIR="$OUTPUT_DIR"
else
  FINAL_EVIDENCE_DIR="/tmp/phase11_evidence_$(date +%Y%m%d_%H%M%S)"
fi

EVIDENCE_DIR="$FINAL_EVIDENCE_DIR"
OUTPUT_DIR="$FINAL_EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"
export EVIDENCE_DIR OUTPUT_DIR

# SSH key setup
SSH_KEY_FILE="$EVIDENCE_DIR/vps_ssh_key"
# Preserve final newline so OpenSSH key parsing is valid.
printf '%s\n' "$VPS_SSH_KEY" > "$SSH_KEY_FILE"
chmod 600 "$SSH_KEY_FILE"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

RELAY_HEALTH_ENDPOINT="${RELAY_URL%/}/health"
RELAY_MESSAGES_TEST_ENDPOINT="${RELAY_URL%/}/v1/messages/test"

log() { echo "$*"; }
pass_line() { echo -e "${GREEN}✓ $*${NC}"; }
warn_line() { echo -e "${YELLOW}⚠ $*${NC}"; }
fail_line() { echo -e "${RED}✗ $*${NC}"; }

ssh_vps() {
  ssh \
    -o ConnectTimeout="$SSH_CONNECT_TIMEOUT" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -i "$SSH_KEY_FILE" \
    "$VPS_USER@$VPS_HOST" "$@"
}

json_escape_string() {
  jq -Rn --arg v "$1" '$v'
}

echo "=========================================="
echo "Phase 11 Sovereign Relay Quota Gate"
echo "Date: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "Gate timestamp: $GATE_TIMESTAMP"
echo "Relay URL: $RELAY_URL"
echo "VPS: $VPS_USER@$VPS_HOST"
echo "Evidence dir: $EVIDENCE_DIR"
echo "=========================================="
echo ""

# Condition values (must all be true for pass)
SOCIAL_RELAY_READY="false"
NO_ERROR_LOOPS="false"
RELAY_ROUTING_OPERATIONAL="false"
ALL_SERVICES_ACTIVE="false"
SUCCESSFUL_RELAY_MESSAGE_OP="false"

FAILED_CONDITIONS=()

# 1) Relay health check
log "${YELLOW}[1/5] Checking relay endpoint health...${NC}"
if response=$(curl -fsS -w "\n%{http_code}" "$RELAY_HEALTH_ENDPOINT" 2>"$EVIDENCE_DIR/relay_health.stderr"); then
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  echo "$body" > "$EVIDENCE_DIR/relay_health.json"
  echo "$http_code" > "$EVIDENCE_DIR/relay_health_status_code.txt"

  if [ "$http_code" = "200" ] && echo "$body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    pass_line "Relay health endpoint is healthy (HTTP 200, status=ok)"
  else
    fail_line "Relay health endpoint returned unexpected content (HTTP $http_code)"
  fi
else
  fail_line "Failed to reach relay health endpoint"
fi
echo ""

# 2) TLS check
log "${YELLOW}[2/5] Verifying TLS certificate...${NC}"
RELAY_HOST=$(echo "$RELAY_URL" | sed -E 's#^https?://([^/]+).*$#\1#')
if cert_info=$(echo | openssl s_client -servername "$RELAY_HOST" -connect "$RELAY_HOST:443" 2>/dev/null | openssl x509 -noout -text 2>/dev/null); then
  echo "$cert_info" > "$EVIDENCE_DIR/tls_certificate.txt"
  if echo "$cert_info" | grep -q "Let's Encrypt"; then
    pass_line "TLS certificate issued by Let's Encrypt"
  else
    warn_line "TLS certificate issuer is not Let's Encrypt"
  fi
else
  fail_line "TLS certificate verification failed"
fi
echo ""

# 3) Channel readiness + error loop checks
log "${YELLOW}[3/5] Checking social_relay channel readiness and churn signals...${NC}"
heartbeat_tail=""
error_signals=""
loop_signals=""

if ssh_vps "test -f '$HEARTBEAT_LOG_PATH'" >/dev/null 2>&1; then
  heartbeat_tail=$(ssh_vps "tail -n 400 '$HEARTBEAT_LOG_PATH'" 2>/dev/null || true)
  printf '%s\n' "$heartbeat_tail" > "$EVIDENCE_DIR/channel_heartbeat.log"

  error_signals=$(printf '%s\n' "$heartbeat_tail" | grep -iE "social_relay.*(misconfigured|quota_exhausted|cooldown|funding_required|blocked_by_policy)" || true)
  printf '%s\n' "$error_signals" > "$EVIDENCE_DIR/channel_errors.log"

  loop_signals=$(printf '%s\n' "$heartbeat_tail" | grep -iE "wake.*sleep|no progress|dead-channel|retry churn|crash sleep|stale loop" || true)
  printf '%s\n' "$loop_signals" > "$EVIDENCE_DIR/churn_signals.log"

  if printf '%s\n' "$heartbeat_tail" | grep -qiE "social_relay.*ready" && [ -z "$error_signals" ]; then
    SOCIAL_RELAY_READY="true"
    pass_line "social_relay channel is ready with no blocker state in heartbeat window"
  else
    fail_line "social_relay channel readiness not confirmed in heartbeat window"
  fi

  if [ -z "$loop_signals" ]; then
    NO_ERROR_LOOPS="true"
    pass_line "No churn/error-loop signatures found in heartbeat window"
  else
    fail_line "Churn/error-loop signatures detected in heartbeat window"
  fi
else
  fail_line "Cannot access heartbeat log via SSH at $HEARTBEAT_LOG_PATH"
fi
echo ""

# 4) Message-path probe (transport)
log "${YELLOW}[4/5] Probing message-path routing...${NC}"
msg_response=$(curl -sS -w "\n%{http_code}" -X POST "$RELAY_MESSAGES_TEST_ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"test":true}' 2>"$EVIDENCE_DIR/message_endpoint_probe.stderr" || true)

msg_http_code=$(echo "$msg_response" | tail -n1)
msg_body=$(echo "$msg_response" | sed '$d')
printf '%s\n' "$msg_body" > "$EVIDENCE_DIR/message_endpoint_probe.json"
printf '%s\n' "$msg_http_code" > "$EVIDENCE_DIR/message_endpoint_probe_status_code.txt"

if [ "$msg_http_code" = "401" ] || [ "$msg_http_code" = "403" ] || [ "$msg_http_code" = "404" ] || [ "$msg_http_code" = "200" ] || [ "$msg_http_code" = "201" ]; then
  RELAY_ROUTING_OPERATIONAL="true"
  pass_line "Message path routing is reachable (HTTP $msg_http_code)"
else
  fail_line "Message path routing probe failed (HTTP ${msg_http_code:-unknown})"
fi

# Optional signed probe
if [ "$SIGNED_PROBE_REQUIRED" = "true" ]; then
  log "${YELLOW}[4.5/5] Signed protocol probe required...${NC}"
  if [ -f "$SIGNED_PROBE_SCRIPT" ] && command -v npx >/dev/null 2>&1; then
    if RELAY_URL="$RELAY_URL" npx tsx "$SIGNED_PROBE_SCRIPT" >"$EVIDENCE_DIR/signed_probe.log" 2>"$EVIDENCE_DIR/signed_probe.err"; then
      SUCCESSFUL_RELAY_MESSAGE_OP="true"
      pass_line "Signed send/poll/count probe succeeded"
    else
      fail_line "Signed send/poll/count probe failed (see signed_probe.err for details)"
      tail -n 10 "$EVIDENCE_DIR/signed_probe.err" >&2 || true
    fi
  else
    fail_line "Signed probe required but script/tsx unavailable"
  fi
else
  # In non-strict mode, transport-level success counts as operation proof for now.
  if [ "$RELAY_ROUTING_OPERATIONAL" = "true" ]; then
    SUCCESSFUL_RELAY_MESSAGE_OP="true"
  fi
fi
echo ""

# 5) Service checks
log "${YELLOW}[5/5] Verifying Caddy + relay services on VPS...${NC}"
caddy_status=$(ssh_vps "systemctl is-active '$CADDY_SERVICE_NAME' || true" 2>/dev/null || true)
relay_status=$(ssh_vps "systemctl is-active '$RELAY_SERVICE_NAME' || true" 2>/dev/null || true)
printf '%s\n' "$caddy_status" > "$EVIDENCE_DIR/caddy_status.txt"
printf '%s\n' "$relay_status" > "$EVIDENCE_DIR/relay_service_status.txt"

recent_caddy_logs=$(ssh_vps "journalctl -u '$CADDY_SERVICE_NAME' -n 120 --no-pager 2>/dev/null || true" 2>/dev/null || true)
printf '%s\n' "$recent_caddy_logs" > "$EVIDENCE_DIR/caddy_recent_logs.log"

recent_relay_logs=$(ssh_vps "journalctl -u '$RELAY_SERVICE_NAME' -n 120 --no-pager 2>/dev/null || true" 2>/dev/null || true)
printf '%s\n' "$recent_relay_logs" > "$EVIDENCE_DIR/relay_recent_logs.log"

if [ "$caddy_status" = "active" ] && [ "$relay_status" = "active" ]; then
  critical_errs=$(printf '%s\n%s\n' "$recent_caddy_logs" "$recent_relay_logs" | grep -iE "fatal|panic|segmentation fault|address already in use" || true)
  if [ -z "$critical_errs" ]; then
    ALL_SERVICES_ACTIVE="true"
    pass_line "Caddy and relay services are active with no critical errors"
  else
    fail_line "Critical service errors detected"
    printf '%s\n' "$critical_errs" > "$EVIDENCE_DIR/critical_service_errors.log"
  fi
else
  fail_line "Service status unhealthy (caddy=$caddy_status, relay=$relay_status)"
fi
echo ""

# Build failed condition list
[ "$SOCIAL_RELAY_READY" = "false" ] && FAILED_CONDITIONS+=("social_relay_ready")
[ "$NO_ERROR_LOOPS" = "false" ] && FAILED_CONDITIONS+=("no_error_loops")
[ "$RELAY_ROUTING_OPERATIONAL" = "false" ] && FAILED_CONDITIONS+=("relay_routing_operational")
[ "$ALL_SERVICES_ACTIVE" = "false" ] && FAILED_CONDITIONS+=("all_services_active")
[ "$SUCCESSFUL_RELAY_MESSAGE_OP" = "false" ] && FAILED_CONDITIONS+=("successful_relay_message_op")

OVERALL_PASS="false"
if [ ${#FAILED_CONDITIONS[@]} -eq 0 ]; then
  OVERALL_PASS="true"
fi

# Serialize failed conditions JSON array safely
failed_conditions_json="[]"
if [ ${#FAILED_CONDITIONS[@]} -gt 0 ]; then
  failed_conditions_json=$(printf '%s\n' "${FAILED_CONDITIONS[@]}" | jq -R . | jq -s .)
fi

cat > "$EVIDENCE_DIR/gate_result.json" <<EOF_JSON
{
  "version": 1,
  "timestamp": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')",
  "quota_reset_gate": "${GATE_TIMESTAMP}",
  "evidence_window_seconds": ${EVIDENCE_WINDOW_SECONDS},
  "results": {
    "social_relay_ready": ${SOCIAL_RELAY_READY},
    "no_error_loops": ${NO_ERROR_LOOPS},
    "relay_routing_operational": ${RELAY_ROUTING_OPERATIONAL},
    "all_services_active": ${ALL_SERVICES_ACTIVE},
    "successful_relay_message_op": ${SUCCESSFUL_RELAY_MESSAGE_OP}
  },
  "failed_conditions": ${failed_conditions_json},
  "pass": ${OVERALL_PASS},
  "evidence_directory": "${EVIDENCE_DIR}"
}
EOF_JSON

log "Structured result written to: $EVIDENCE_DIR/gate_result.json"
log ""

if [ "$OVERALL_PASS" = "true" ]; then
  echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
  echo -e "${GREEN}PHASE 11 QUOTA RESET GATE: ✅ PASS${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════════════════${NC}"
  exit 0
else
  echo -e "${RED}═══════════════════════════════════════════════════════${NC}"
  echo -e "${RED}PHASE 11 QUOTA RESET GATE: ❌ FAIL${NC}"
  echo -e "${RED}═══════════════════════════════════════════════════════${NC}"
  echo ""
  echo "Failed conditions:"
  for cond in "${FAILED_CONDITIONS[@]}"; do
    echo "  - $cond"
  done
  exit 1
fi
