#!/usr/bin/env bash
# Rebuild and redeploy the prod Agent Log Viewer (Docker Compose).
#
# Prod runs as the `viewer` Compose service on 127.0.0.1:8898; the old
# `agent-log-viewer.service` systemd unit is disabled. This script rebuilds the
# image (which compiles `.next` inside a clean environment — that is what closed
# the leaked-__NEXT_PRIVATE_* "generate is not a function" failure class for
# good) and redeploys, then verifies the served CSS the HTML points at returns
# 200 so an HTML/asset hash desync can never ship silently.
#
# Usage: scripts/rebuild.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PORT="${PORT:-8898}"
TOKEN="$(sed -n 's/^LLV_TOKEN=//p' "$HOME/.config/agent-log-viewer/service.env" 2>/dev/null | head -1)"

# --- 1. build the image (clean-env .next build happens inside it) ----------
echo "==> building image"
docker compose build viewer

# --- 2. redeploy ----------------------------------------------------------
echo "==> redeploying viewer (127.0.0.1:${PORT})"
docker compose up -d viewer

# --- 3. verify page + CSS -------------------------------------------------
BASE="http://127.0.0.1:${PORT}/"
[ -n "$TOKEN" ] && BASE="${BASE}?k=${TOKEN}"

for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE" 2>/dev/null || echo 000)"
  [ "$code" = "200" ] && break
  sleep 1
done
[ "${code:-000}" = "200" ] || { echo "!! page not serving (HTTP ${code:-000})" >&2; docker compose logs --tail 40 viewer >&2; exit 1; }

# The CSS the freshly-served HTML references must exist and return 200 —
# the exact check that catches the hash-desync failure mode.
html_css="$(curl -s --max-time 5 "$BASE" | grep -oE '/_next/static/css/[^\"]+\.css' | head -1)"
if [ -n "$html_css" ]; then
  css_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}${html_css}" 2>/dev/null || echo 000)"
  [ "$css_code" = "200" ] || { echo "!! CSS $html_css returns HTTP $css_code (HTML/asset desync)" >&2; exit 1; }
  echo "==> OK  page 200, css 200 ($html_css)"
else
  echo "==> page 200 (no <link> css found — check manually)"
fi

echo "==> done. tmux agents: $(tmux has-session -t agents 2>/dev/null && echo alive || echo none)"
