#!/bin/bash
# Better Stack setup for Connie logging
#
# Prerequisites:
#   1. Create free Better Stack account at logs.betterstack.com
#   2. Create "connie-prod" source, copy Source Token
#   3. Export LOGTAIL_TOKEN=<token>
#   4. Run this script as root
#
# Example:
#   LOGTAIL_TOKEN=abc123xyz bash scripts/setup-betterstack.sh

set -euo pipefail

: "${LOGTAIL_TOKEN:?LOGTAIL_TOKEN env var required — get it from logs.betterstack.com}"

echo "📊 Setting up Better Stack telemetry for Connie..."
echo "Token: ${LOGTAIL_TOKEN:0:20}****"

# Install Vector via official Timber repositories
echo "1️⃣  Installing Vector..."
curl -1sLf https://repositories.timber.io/public/vector/cfg/setup/bash.deb.sh | bash
apt-get update && apt-get install -y vector

# Write config with token substituted
echo "2️⃣  Writing Vector configuration..."
mkdir -p /etc/vector

# Get the repo root
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -f "$REPO_ROOT/infra/betterstack-vector.toml" ]; then
  echo "❌ Config template not found at $REPO_ROOT/infra/betterstack-vector.toml"
  exit 1
fi

sed "s|\${LOGTAIL_TOKEN}|${LOGTAIL_TOKEN}|g" \
  "$REPO_ROOT/infra/betterstack-vector.toml" > /etc/vector/vector.toml

# Validate Vector config
echo "3️⃣  Validating Vector configuration..."
if ! vector validate /etc/vector/vector.toml; then
  echo "❌ Vector config validation failed"
  exit 1
fi

# Harden: limit restart attempts to prevent restart loops
echo "4️⃣  Hardening Vector systemd service..."
systemctl set-property vector StartLimitIntervalSec=600 StartLimitBurst=2

# Enable and start Vector
echo "5️⃣  Starting Vector service..."
systemctl enable --now vector
sleep 2

# Check status
if systemctl status vector >/dev/null 2>&1; then
  echo "✅ Vector is running"
  echo ""
  echo "📈 Better Stack setup complete!"
  echo ""
  echo "Next steps:"
  echo "  1. Open https://logs.betterstack.com"
  echo "  2. Navigate to your 'connie-prod' source"
  echo "  3. Watch the live tail — logs should appear within 30 seconds"
  echo ""
  echo "Useful queries:"
  echo "  • level:error                                  (all errors)"
  echo "  • module:loop                                  (agent loop events)"
  echo "  • message:\"social_relay\" AND level:info      (channel state)"
  echo "  • message:\"no-progress\"                       (stall events)"
  echo "  • source:systemd                               (service logs)"
  echo ""
  echo "To view Vector logs:"
  echo "  journalctl -u vector -n 20 --no-pager"
else
  echo "❌ Vector failed to start"
  journalctl -u vector -n 20 --no-pager
  exit 1
fi
