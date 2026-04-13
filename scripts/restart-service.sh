#!/usr/bin/env bash
set -euo pipefail

# Restart the CarsonOS background service.
# Detects the platform and uses the appropriate service manager.

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

PLIST_NAME="com.carsonos.server"
SYSTEMD_NAME="carsonos"

if [[ "$(uname)" == "Darwin" ]]; then
  # macOS — launchd
  if launchctl list "$PLIST_NAME" &>/dev/null; then
    launchctl kickstart -k "gui/$(id -u)/$PLIST_NAME"
    echo -e "${GREEN}Service restarted (launchd)${NC}"
  else
    echo -e "${RED}Service not installed. Run: ./scripts/install-service.sh${NC}"
    exit 1
  fi
elif command -v systemctl &>/dev/null; then
  # Linux — systemd
  if systemctl --user is-active "$SYSTEMD_NAME" &>/dev/null; then
    systemctl --user restart "$SYSTEMD_NAME"
    echo -e "${GREEN}Service restarted (systemd)${NC}"
  else
    echo -e "${RED}Service not installed. Run: ./scripts/install-service.sh${NC}"
    exit 1
  fi
else
  echo -e "${RED}No service manager detected. Kill and restart manually:${NC}"
  echo "  pkill -f 'tsx.*carsonos' && pnpm start"
  exit 1
fi
