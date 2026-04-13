#!/usr/bin/env bash
set -euo pipefail

# Install CarsonOS as a background service.
#
# macOS: launchd (~/Library/LaunchAgents)
# Linux: systemd user service (~/.config/systemd/user)
#
# Runs the server in the background, starts on login, restarts on crash.
#
# Usage:
#   ./scripts/install-service.sh          # install and start
#   ./scripts/install-service.sh --stop   # stop the service
#   ./scripts/install-service.sh --uninstall  # remove the service

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.carsonos/logs"
PLATFORM="$(uname)"

# ── Platform detection ───────────────────────────────────────────

if [[ "$PLATFORM" == "Darwin" ]]; then
  SERVICE_TYPE="launchd"
  PLIST_NAME="com.carsonos.server"
  PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
elif command -v systemctl &>/dev/null; then
  SERVICE_TYPE="systemd"
  SYSTEMD_NAME="carsonos"
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  SYSTEMD_PATH="${SYSTEMD_DIR}/${SYSTEMD_NAME}.service"
else
  SERVICE_TYPE="none"
fi

# ── Service commands ─────────────────────────────────────────────

stop_service() {
  if [[ "$SERVICE_TYPE" == "launchd" ]]; then
    if launchctl list "$PLIST_NAME" &>/dev/null; then
      launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
      echo -e "  ${GREEN}✓${NC} Service stopped (launchd)"
    else
      echo -e "  ${YELLOW}○${NC} Service was not running"
    fi
  elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
    if systemctl --user is-active "$SYSTEMD_NAME" &>/dev/null; then
      systemctl --user stop "$SYSTEMD_NAME"
      echo -e "  ${GREEN}✓${NC} Service stopped (systemd)"
    else
      echo -e "  ${YELLOW}○${NC} Service was not running"
    fi
  fi
}

uninstall_service() {
  stop_service
  if [[ "$SERVICE_TYPE" == "launchd" ]]; then
    rm -f "$PLIST_PATH"
  elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
    systemctl --user disable "$SYSTEMD_NAME" 2>/dev/null || true
    rm -f "$SYSTEMD_PATH"
    systemctl --user daemon-reload
  fi
  echo -e "  ${GREEN}✓${NC} Service removed"
  exit 0
}

# ── Handle flags ─────────────────────────────────────────────────

case "${1:-}" in
  --stop)
    stop_service
    exit 0
    ;;
  --uninstall)
    uninstall_service
    ;;
esac

# ── Pre-checks ───────────────────────────────────────────────────

if [[ "$SERVICE_TYPE" == "none" ]]; then
  echo -e "${RED}No supported service manager found.${NC}"
  echo "  macOS: launchd (built-in)"
  echo "  Linux: systemd (most distros)"
  echo ""
  echo "You can still run CarsonOS manually: pnpm start"
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

# ── Install ──────────────────────────────────────────────────────

echo ""
echo "  Installing CarsonOS service"
echo "  ==========================="
echo ""
echo "  Platform: $SERVICE_TYPE"
echo "  Project:  $PROJECT_DIR"
echo "  Data:     $HOME/.carsonos"
echo "  Logs:     $LOG_DIR"
echo ""

# Ensure deps are installed
echo "  Installing dependencies..."
(cd "$PROJECT_DIR" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install)
echo ""

mkdir -p "$LOG_DIR"

NODE_PATH="$(which node)"
PNPM_PATH="$(which pnpm)"

if [[ "$SERVICE_TYPE" == "launchd" ]]; then
  # ── macOS launchd ────────────────────────────────────────────

  mkdir -p "$(dirname "$PLIST_PATH")"

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
  stop_service
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  echo -e "  ${GREEN}✓${NC} Service started"

elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
  # ── Linux systemd ────────────────────────────────────────────

  mkdir -p "$SYSTEMD_DIR"

  cat > "$SYSTEMD_PATH" << UNIT
[Unit]
Description=CarsonOS — Family AI Agent Platform
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
Environment=PATH=$(dirname "$NODE_PATH"):$(dirname "$PNPM_PATH"):/usr/local/bin:/usr/bin:/bin
Environment=HOME=${HOME}
Environment=DATA_DIR=${HOME}/.carsonos
Environment=NODE_ENV=production
ExecStart=${PNPM_PATH} start
Restart=on-failure
RestartSec=10
StandardOutput=append:${LOG_DIR}/stdout.log
StandardError=append:${LOG_DIR}/stderr.log

[Install]
WantedBy=default.target
UNIT

  echo -e "  ${GREEN}✓${NC} Created $SYSTEMD_PATH"
  systemctl --user daemon-reload
  systemctl --user enable "$SYSTEMD_NAME"
  stop_service
  systemctl --user start "$SYSTEMD_NAME"
  echo -e "  ${GREEN}✓${NC} Service started and enabled on login"
fi

# ── Verify ───────────────────────────────────────────────────────

sleep 2
RUNNING=false
if [[ "$SERVICE_TYPE" == "launchd" ]] && launchctl list "$PLIST_NAME" &>/dev/null; then
  RUNNING=true
elif [[ "$SERVICE_TYPE" == "systemd" ]] && systemctl --user is-active "$SYSTEMD_NAME" &>/dev/null; then
  RUNNING=true
fi

if $RUNNING; then
  echo ""
  echo -e "  ${GREEN}CarsonOS is running!${NC}"
  echo ""
  echo "  Dashboard:  http://localhost:3300"
  echo "  Logs:       tail -f $LOG_DIR/stdout.log"
  echo "  Restart:    pnpm restart"
  echo "  Stop:       ./scripts/install-service.sh --stop"
  echo "  Uninstall:  ./scripts/install-service.sh --uninstall"
  echo ""
else
  echo ""
  echo -e "  ${RED}Service may not have started. Check logs:${NC}"
  echo "  tail -20 $LOG_DIR/stderr.log"
  echo ""
fi
