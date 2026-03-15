#!/usr/bin/env bash
# setup-staging-service.sh — Create the local-connie-staging systemd service
# Run once on the VPS to set up the staging environment.
# The staging service mirrors production but uses:
#   - Separate code directory:  /root/.openclaw/workspace/artifacts/automaton-research-staging
#   - Separate data directory:  /root/.automaton-staging
#   - Separate config/DB:       /root/.automaton-staging/automaton.json & state.db
#   - Does NOT override HOME (preserves credential access at /paperclip or /root)

set -euo pipefail

STAGING_SERVICE="local-connie-staging"
STAGING_DIR="/root/.openclaw/workspace/artifacts/automaton-research-staging"
STAGING_HOME="/root/.automaton-staging"

# Derive HOME from the production service so credentials are shared
PROD_HOME=$(grep 'Environment=HOME=' /etc/systemd/system/local-connie.service 2>/dev/null | sed 's/.*HOME=//')
if [ -z "$PROD_HOME" ]; then
  PROD_HOME="/root"
fi

# Create staging data directory
mkdir -p "$STAGING_HOME"

# Seed a minimal staging config if one doesn't exist
if [ ! -f "$STAGING_HOME/automaton.json" ] && [ -f "$PROD_HOME/.automaton/automaton.json" ]; then
  cp "$PROD_HOME/.automaton/automaton.json" "$STAGING_HOME/automaton.json"
  echo "Seeded staging config from production"
fi

# Create the systemd unit
cat > "/etc/systemd/system/${STAGING_SERVICE}.service" <<EOF
[Unit]
Description=Connie Automaton (Staging)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${STAGING_DIR}
ExecStart=/usr/bin/node ${STAGING_DIR}/dist/index.js
Environment=HOME=${PROD_HOME}
Environment=CONNIE_HOME=${PROD_HOME}
Environment=AUTOMATON_CONFIG_PATH=${STAGING_HOME}/automaton.json
Environment=AUTOMATON_DB_PATH=${STAGING_HOME}/state.db
Environment=AUTOMATON_ENV=staging
Environment=NODE_ENV=staging
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# Create drop-in directory
mkdir -p "/etc/systemd/system/${STAGING_SERVICE}.service.d"

systemctl daemon-reload
systemctl enable "$STAGING_SERVICE"

echo "Staging service '${STAGING_SERVICE}' created and enabled."
echo "  Code:   ${STAGING_DIR}"
echo "  Data:   ${STAGING_HOME}"
echo "  Config: ${STAGING_HOME}/automaton.json"
echo "  DB:     ${STAGING_HOME}/state.db"
echo ""
echo "Start with: systemctl start ${STAGING_SERVICE}"
echo "Logs with:  journalctl -u ${STAGING_SERVICE} -f"
