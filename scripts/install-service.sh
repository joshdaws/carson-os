#!/usr/bin/env bash
set -euo pipefail

# Install CarsonOS as a background service.
#
# macOS: launchd (~/Library/LaunchAgents)
# Linux: systemd user service (~/.config/systemd/user)
#
# Runs the CarsonOS server and signal-cli daemon in the background,
# both start on login and restart on crash.
#
# Usage:
#   ./scripts/install-service.sh          # install and start both services
#   ./scripts/install-service.sh --stop   # stop both services
#   ./scripts/install-service.sh --uninstall  # remove both services

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$HOME/.carsonos/logs"
PLATFORM="$(uname)"

# ── signal-cli config ────────────────────────────────────────────
# SIGNAL_NUMBER must be set in the environment (E.164 format, e.g. +1XXXXXXXXXX).
# SIGNAL_PORT defaults to 8080 but can be overridden.
SIGNAL_NUMBER="${SIGNAL_NUMBER:-}"
SIGNAL_PORT="${SIGNAL_PORT:-8080}"

# ── Platform detection ───────────────────────────────────────────

if [[ "$PLATFORM" == "Darwin" ]]; then
  SERVICE_TYPE="launchd"
  PLIST_NAME="com.carsonos.server"
  PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_NAME}.plist"
  SIGNAL_PLIST_NAME="com.carsonos.signal-cli"
  SIGNAL_PLIST_PATH="$HOME/Library/LaunchAgents/${SIGNAL_PLIST_NAME}.plist"
elif command -v systemctl &>/dev/null; then
  SERVICE_TYPE="systemd"
  SYSTEMD_NAME="carsonos"
  SYSTEMD_DIR="$HOME/.config/systemd/user"
  SYSTEMD_PATH="${SYSTEMD_DIR}/${SYSTEMD_NAME}.service"
  SIGNAL_SYSTEMD_NAME="carsonos-signal-cli"
  SIGNAL_SYSTEMD_PATH="${SYSTEMD_DIR}/${SIGNAL_SYSTEMD_NAME}.service"
else
  SERVICE_TYPE="none"
fi

# ── Service commands ─────────────────────────────────────────────

stop_signal_service() {
  if [[ "$SERVICE_TYPE" == "launchd" ]]; then
    if launchctl list "$SIGNAL_PLIST_NAME" &>/dev/null; then
      launchctl bootout "gui/$(id -u)/$SIGNAL_PLIST_NAME" 2>/dev/null || true
      echo -e "  ${GREEN}✓${NC} signal-cli stopped (launchd)"
    else
      echo -e "  ${YELLOW}○${NC} signal-cli was not running"
    fi
  elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
    if systemctl --user is-active "$SIGNAL_SYSTEMD_NAME" &>/dev/null; then
      systemctl --user stop "$SIGNAL_SYSTEMD_NAME"
      echo -e "  ${GREEN}✓${NC} signal-cli stopped (systemd)"
    else
      echo -e "  ${YELLOW}○${NC} signal-cli was not running"
    fi
  fi
}

stop_carsonos_service() {
  if [[ "$SERVICE_TYPE" == "launchd" ]]; then
    if launchctl list "$PLIST_NAME" &>/dev/null; then
      launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || true
      echo -e "  ${GREEN}✓${NC} CarsonOS stopped (launchd)"
    else
      echo -e "  ${YELLOW}○${NC} CarsonOS was not running"
    fi
  elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
    if systemctl --user is-active "$SYSTEMD_NAME" &>/dev/null; then
      systemctl --user stop "$SYSTEMD_NAME"
      echo -e "  ${GREEN}✓${NC} CarsonOS stopped (systemd)"
    else
      echo -e "  ${YELLOW}○${NC} CarsonOS was not running"
    fi
  fi
}

stop_service() {
  stop_carsonos_service
  stop_signal_service
}

uninstall_service() {
  stop_service
  if [[ "$SERVICE_TYPE" == "launchd" ]]; then
    rm -f "$PLIST_PATH"
    rm -f "$SIGNAL_PLIST_PATH"
  elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
    systemctl --user disable "$SYSTEMD_NAME" 2>/dev/null || true
    systemctl --user disable "$SIGNAL_SYSTEMD_NAME" 2>/dev/null || true
    rm -f "$SYSTEMD_PATH"
    rm -f "$SIGNAL_SYSTEMD_PATH"
    systemctl --user daemon-reload
  fi
  echo -e "  ${GREEN}✓${NC} All services removed"
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

SIGNAL_CLI_PATH="$(command -v signal-cli 2>/dev/null || echo '')"
if [[ -z "$SIGNAL_CLI_PATH" ]]; then
  echo -e "  ${YELLOW}⚠${NC}  signal-cli not found in PATH — skipping Signal service install"
  echo "     Install signal-cli and re-run to enable Signal transport."
  INSTALL_SIGNAL=false
elif [[ -z "$SIGNAL_NUMBER" ]]; then
  echo -e "${RED}Error:${NC} SIGNAL_NUMBER is not set."
  echo ""
  echo "  signal-cli was found but no phone number is configured."
  echo "  Set SIGNAL_NUMBER in your environment (E.164 format) and re-run:"
  echo ""
  echo "    SIGNAL_NUMBER=+1XXXXXXXXXX ./scripts/install-service.sh"
  echo ""
  exit 1
else
  INSTALL_SIGNAL=true
fi

# ── Install ──────────────────────────────────────────────────────

echo ""
echo "  Installing CarsonOS services"
echo "  ============================"
echo ""
echo "  Platform:    $SERVICE_TYPE"
echo "  Project:     $PROJECT_DIR"
echo "  Data:        $HOME/.carsonos"
echo "  Logs:        $LOG_DIR"
if $INSTALL_SIGNAL; then
  echo "  signal-cli:  $SIGNAL_CLI_PATH ($SIGNAL_NUMBER → port $SIGNAL_PORT)"
fi
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

  # signal-cli daemon (install first so it's up before CarsonOS starts)
  if $INSTALL_SIGNAL; then
    cat > "$SIGNAL_PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SIGNAL_PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${SIGNAL_CLI_PATH}</string>
    <string>-a</string>
    <string>${SIGNAL_NUMBER}</string>
    <string>daemon</string>
    <string>--http</string>
    <string>localhost:${SIGNAL_PORT}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/signal-cli-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/signal-cli-stderr.log</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
PLIST

    echo -e "  ${GREEN}✓${NC} Created $SIGNAL_PLIST_PATH"
    stop_signal_service
    launchctl bootstrap "gui/$(id -u)" "$SIGNAL_PLIST_PATH"
    echo -e "  ${GREEN}✓${NC} signal-cli started"
  fi

  # CarsonOS server
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
  stop_carsonos_service
  # launchd can take a moment to fully deregister after bootout — retry once on error 5
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || \
    { sleep 2; launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"; }
  echo -e "  ${GREEN}✓${NC} CarsonOS started"

elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
  # ── Linux systemd ────────────────────────────────────────────

  mkdir -p "$SYSTEMD_DIR"

  # signal-cli daemon
  if $INSTALL_SIGNAL; then
    cat > "$SIGNAL_SYSTEMD_PATH" << UNIT
[Unit]
Description=signal-cli daemon for CarsonOS
After=network.target

[Service]
Type=simple
Environment=HOME=${HOME}
ExecStart=${SIGNAL_CLI_PATH} -a ${SIGNAL_NUMBER} daemon --http localhost:${SIGNAL_PORT}
Restart=on-failure
RestartSec=10
StandardOutput=append:${LOG_DIR}/signal-cli-stdout.log
StandardError=append:${LOG_DIR}/signal-cli-stderr.log

[Install]
WantedBy=default.target
UNIT

    echo -e "  ${GREEN}✓${NC} Created $SIGNAL_SYSTEMD_PATH"
    systemctl --user daemon-reload
    systemctl --user enable "$SIGNAL_SYSTEMD_NAME"
    stop_signal_service
    systemctl --user start "$SIGNAL_SYSTEMD_NAME"
    echo -e "  ${GREEN}✓${NC} signal-cli started and enabled on login"
  fi

  # CarsonOS server
  cat > "$SYSTEMD_PATH" << UNIT
[Unit]
Description=CarsonOS — Family AI Agent Platform
After=network.target${INSTALL_SIGNAL:+ $SIGNAL_SYSTEMD_NAME.service}

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
  stop_carsonos_service
  systemctl --user start "$SYSTEMD_NAME"
  echo -e "  ${GREEN}✓${NC} CarsonOS started and enabled on login"
fi

# ── Verify ───────────────────────────────────────────────────────

sleep 2
RUNNING=false
SIGNAL_RUNNING=false

if [[ "$SERVICE_TYPE" == "launchd" ]]; then
  launchctl list "$PLIST_NAME" &>/dev/null && RUNNING=true
  $INSTALL_SIGNAL && launchctl list "$SIGNAL_PLIST_NAME" &>/dev/null && SIGNAL_RUNNING=true
elif [[ "$SERVICE_TYPE" == "systemd" ]]; then
  systemctl --user is-active "$SYSTEMD_NAME" &>/dev/null && RUNNING=true
  $INSTALL_SIGNAL && systemctl --user is-active "$SIGNAL_SYSTEMD_NAME" &>/dev/null && SIGNAL_RUNNING=true
fi

echo ""
if $RUNNING; then
  echo -e "  ${GREEN}CarsonOS is running!${NC}"
else
  echo -e "  ${RED}CarsonOS may not have started. Check logs:${NC}"
  echo "  tail -20 $LOG_DIR/stderr.log"
fi

if $INSTALL_SIGNAL; then
  if $SIGNAL_RUNNING; then
    echo -e "  ${GREEN}signal-cli is running!${NC}"
  else
    echo -e "  ${RED}signal-cli may not have started. Check logs:${NC}"
    echo "  tail -20 $LOG_DIR/signal-cli-stderr.log"
  fi
fi

echo ""
echo "  Dashboard:  http://localhost:3300"
echo "  Logs:       tail -f $LOG_DIR/stdout.log"
if $INSTALL_SIGNAL; then
  echo "  Signal:     tail -f $LOG_DIR/signal-cli-stdout.log"
fi
echo "  Restart:    pnpm restart"
echo "  Stop:       ./scripts/install-service.sh --stop"
echo "  Uninstall:  ./scripts/install-service.sh --uninstall"
echo ""
