#!/usr/bin/env bash
set -euo pipefail

# CarsonOS first-run setup
# Checks prerequisites, installs dependencies, creates data directory

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

DATA_DIR="${DATA_DIR:-$HOME/.carsonos}"

echo ""
echo "  CarsonOS Setup"
echo "  =============="
echo ""

# --- Check prerequisites ---

errors=0

# Node.js 20+
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge 20 ]; then
    echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
  else
    echo -e "  ${RED}✗${NC} Node.js $(node -v) — need 20+"
    errors=$((errors + 1))
  fi
else
  echo -e "  ${RED}✗${NC} Node.js — not found (need 20+)"
  echo "    Install: https://nodejs.org or 'nvm install 20'"
  errors=$((errors + 1))
fi

# pnpm
if command -v pnpm &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} pnpm $(pnpm -v)"
else
  echo -e "  ${RED}✗${NC} pnpm — not found"
  echo "    Install: npm install -g pnpm"
  errors=$((errors + 1))
fi

# Claude CLI
if command -v claude &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Claude CLI"
else
  echo -e "  ${RED}✗${NC} Claude CLI — not found"
  echo "    Install: npm install -g @anthropic-ai/claude-code"
  echo "    Requires a Claude subscription"
  errors=$((errors + 1))
fi

# QMD
if command -v qmd &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} QMD"
else
  echo -e "  ${RED}✗${NC} QMD — not found"
  echo "    Install: npm install -g @anthropic-ai/qmd"
  errors=$((errors + 1))
fi

# gws (optional)
if command -v gws &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} gws (Google Workspace CLI)"
else
  echo -e "  ${YELLOW}○${NC} gws — not found (optional, for Google Calendar/Gmail/Drive)"
  echo "    Install: npm install -g @anthropic-ai/gws"
fi

echo ""

if [ "$errors" -gt 0 ]; then
  echo -e "  ${RED}$errors missing prerequisite(s). Install them and re-run this script.${NC}"
  echo ""
  exit 1
fi

# --- Install dependencies ---

echo "  Installing dependencies..."
pnpm install
echo ""

# --- Create data directory ---

if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR"
  echo -e "  ${GREEN}✓${NC} Created $DATA_DIR"
else
  echo -e "  ${GREEN}✓${NC} $DATA_DIR already exists"
fi

# --- Done ---

echo ""
echo -e "  ${GREEN}Setup complete!${NC}"
echo ""
echo "  Next steps:"
echo ""
echo "    1. Start the server:"
echo "       pnpm dev"
echo ""
echo "    2. Open the onboarding flow:"
echo "       http://localhost:3300/onboarding"
echo ""
echo "    3. Connect Telegram:"
echo "       Message @BotFather → /newbot → copy token → enter during onboarding"
echo ""
echo "    4. (Optional) Connect Google Calendar/Gmail:"
echo "       See README.md for gws setup instructions"
echo ""
