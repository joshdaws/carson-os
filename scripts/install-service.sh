#!/usr/bin/env bash
set -euo pipefail

# Install CarsonOS as a launchd service (macOS)
#
# Runs the server in the background, starts on login, restarts on crash.
# Uses your development checkout as the runtime, ~/.carsonos for data.
#
# Usage:
#   ./scripts/install-service.sh          # install and start
#   ./scripts/install-service.sh --stop   # stop the service
#   ./scripts/install-service.sh --uninstall  # remove the service

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PLIST_NAME="com.carsonos.server"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.carsonos/logs"

# ── Commands ──────────────────────────────────────────────────────

stop_service() {
  if launchctl list "$PLIST_NAME" &>/dev/null; then
    launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
    echo -e "  ${GREEN}✓${NC} Service stopped"
  else
    echo -e "  ${YELLOW}○${NC} Service was not running"
  fi
}

uninstall_service() {
  stop_service
  rm -f "$PLIST_PATH"
  echo -e "  ${GREEN}✓${NC} Service removed"
  exit 0
}

# ── Handle flags ──────────────────────────────────────────────────

case "${1:-}" in
  --stop)
    stop_service
    exit 0
    ;;
  --uninstall)
    uninstall_service
    ;;
esac

# ── Pre-checks ────────────────────────────────────────────────────

if [[ "$(uname)" != "Darwin" ]]; then
  echo -e "${RED}launchd services are macOS only.${NC}"
  echo "On Linux, create a systemd unit instead."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo -e "${RED}Node.js not found.${NC} Run ./setup.sh first."
  exit 1
fi

if ! command -v pnpm &>/dev/null; then
  echo -e "${RED}pnpm not found.${NC} Run: npm install -g pnpm"
  exit 1
fi

# ── Build ─────────────────────────────────────────────────────────

echo ""
echo "  Installing CarsonOS service"
echo "  ==========================="
echo ""
echo "  Project: $PROJECT_DIR"
echo "  Data:    $HOME/.carsonos"
echo "  Logs:    $LOG_DIR"
echo ""

# Ensure deps are installed
echo "  Installing dependencies..."
(cd "$PROJECT_DIR" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)
echo ""

# ── Create plist ──────────────────────────────────────────────────

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$PLIST_PATH")"

NODE_PATH="$(which node)"
PNPM_PATH="$(which pnpm)"

cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PNPM_PATH}</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE_PATH"):$(dirname "$PNPM_PATH"):/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>DATA_DIR</key>
    <string>${HOME}/.carsonos</string>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLIST

echo -e "  ${GREEN}✓${NC} Created $PLIST_PATH"

# ── Load service ──────────────────────────────────────────────────

# Stop existing service if running
stop_service

launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo -e "  ${GREEN}✓${NC} Service started"

# ── Verify ────────────────────────────────────────────────────────

sleep 2
if launchctl list "$PLIST_NAME" &>/dev/null; then
  echo ""
  echo -e "  ${GREEN}CarsonOS is running!${NC}"
  echo ""
  echo "  Dashboard: http://localhost:3300"
  echo "  Logs:      tail -f $LOG_DIR/stdout.log"
  echo "  Stop:      ./scripts/install-service.sh --stop"
  echo "  Uninstall: ./scripts/install-service.sh --uninstall"
  echo ""
else
  echo ""
  echo -e "  ${RED}Service may not have started. Check logs:${NC}"
  echo "  tail -20 $LOG_DIR/stderr.log"
  echo ""
fi
