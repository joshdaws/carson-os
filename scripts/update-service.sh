#!/usr/bin/env bash
set -euo pipefail

# Update CarsonOS to the latest version and restart the service.
#
# Usage:
#   ./scripts/update-service.sh           # pull latest main, install, restart
#   ./scripts/update-service.sh v0.1.2    # checkout a specific tag

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PLIST_NAME="com.carsonos.server"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:-}"

echo ""
echo "  Updating CarsonOS"
echo "  ================="
echo ""

cd "$PROJECT_DIR"

# Save current version
OLD_VERSION=$(cat VERSION 2>/dev/null || echo "unknown")

# Pull latest
git fetch origin

if [ -n "$TAG" ]; then
  echo "  Checking out $TAG..."
  git checkout "$TAG"
else
  echo "  Pulling latest main..."
  git checkout main
  git pull origin main
fi

NEW_VERSION=$(cat VERSION 2>/dev/null || echo "unknown")
echo -e "  ${GREEN}✓${NC} $OLD_VERSION → $NEW_VERSION"

# Install deps
echo "  Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Build UI + server. ui/dist/ is .gitignored, and the launchd/systemd plist
# runs with NODE_ENV=production which tells app.ts to serve ui/dist/index.html
# as static files. Skipping this step leaves a blank UI with ENOENT on /.
echo "  Building UI + server..."
pnpm build

# Restart service if it's running
RESTARTED=false
if [[ "$(uname)" == "Darwin" ]] && launchctl list "$PLIST_NAME" &>/dev/null; then
  echo "  Restarting service..."
  launchctl kickstart -k "gui/$(id -u)/$PLIST_NAME"
  RESTARTED=true
elif command -v systemctl &>/dev/null && systemctl --user is-active carsonos &>/dev/null; then
  echo "  Restarting service..."
  systemctl --user restart carsonos
  RESTARTED=true
fi

if $RESTARTED; then
  echo -e "  ${GREEN}✓${NC} Service restarted"
else
  echo -e "  ${YELLOW}○${NC} Service not running (start with ./scripts/install-service.sh)"
fi

echo ""
echo -e "  ${GREEN}Update complete!${NC} Running v${NEW_VERSION}"
echo ""
