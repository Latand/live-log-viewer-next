#!/usr/bin/env bash
# Register the Viewer MCP server ("viewer") everywhere agents run on this
# machine: the operator's Claude Code user config, the operator's Codex
# config, and every Viewer-managed account (CLAUDE_CONFIG_DIR /
# CODEX_HOME under ~/.config/agent-log-viewer/accounts). Idempotent —
# safe to re-run after adding accounts.
#
# The server name must stay "viewer" (or an isViewerMcpServer() match in
# src/lib/mcp/presentation.ts) so transcript calls render as Viewer cards.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_BIN="${LLV_MCP_BIN:-$REPO_ROOT/bin/mcp-server.mjs}"
ACCOUNTS_ROOT="${LLV_CONFIG_ROOT:-$HOME/.config/agent-log-viewer}/accounts"

if [ ! -f "$MCP_BIN" ]; then
  echo "error: MCP launcher not found at $MCP_BIN (set LLV_MCP_BIN to override)" >&2
  exit 1
fi

add_claude() { # $1 = label, $2 = CLAUDE_CONFIG_DIR or "" for the user default
  local label="$1" dir="$2"
  if [ -n "$dir" ]; then
    if CLAUDE_CONFIG_DIR="$dir" claude mcp get viewer >/dev/null 2>&1; then
      echo "claude[$label]: viewer already registered"
    else
      CLAUDE_CONFIG_DIR="$dir" claude mcp add viewer -s user -- bun "$MCP_BIN" >/dev/null
      echo "claude[$label]: viewer added"
    fi
  else
    if claude mcp get viewer >/dev/null 2>&1; then
      echo "claude[$label]: viewer already registered"
    else
      claude mcp add viewer -s user -- bun "$MCP_BIN" >/dev/null
      echo "claude[$label]: viewer added"
    fi
  fi
}

add_codex_toml() { # $1 = label, $2 = config.toml path
  local label="$1" toml="$2"
  if [ ! -f "$toml" ]; then
    echo "codex[$label]: no config.toml, skipped"
    return
  fi
  if grep -q '^\[mcp_servers\.viewer\]' "$toml"; then
    echo "codex[$label]: viewer already registered"
    return
  fi
  printf '\n[mcp_servers.viewer]\ncommand = "bun"\nargs = ["%s"]\n' "$MCP_BIN" >> "$toml"
  echo "codex[$label]: viewer added"
}

command -v claude >/dev/null 2>&1 && add_claude user "" || echo "claude: CLI not found, skipped user config"
add_codex_toml user "$HOME/.codex/config.toml"

for dir in "$ACCOUNTS_ROOT"/claude/*/; do
  [ -d "$dir" ] || continue
  case "$dir" in *.lock/) continue ;; esac
  add_claude "$(basename "$dir")" "$dir"
done

for dir in "$ACCOUNTS_ROOT"/codex/*/; do
  [ -d "$dir" ] || continue
  case "$dir" in *.lock/) continue ;; esac
  add_codex_toml "$(basename "$dir")" "${dir}config.toml"
done

echo "done. New agent sessions pick the server up at startup; running sessions need a restart."
