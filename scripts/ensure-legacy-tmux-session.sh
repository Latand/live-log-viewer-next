#!/usr/bin/env bash
set -euo pipefail

runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-log-viewer"
expected="${TMUX_TMPDIR:-$runtime_dir}"
[ "$expected" = "$runtime_dir" ] || { echo "unexpected TMUX_TMPDIR: $expected" >&2; exit 1; }
[ -d "$runtime_dir" ] || { echo "supervisor runtime directory is unavailable" >&2; exit 1; }

for _ in $(seq 1 20); do
  tmux list-sessions >/dev/null 2>&1 && break
  sleep 0.1
done
tmux list-sessions >/dev/null 2>&1 || { echo "tmux server did not become ready" >&2; exit 1; }

sessions="$(tmux list-sessions -F '#{session_name}')"
if [ -n "$sessions" ] && [ "$sessions" != "agents" ]; then
  echo "foreign session exists on supervisor endpoint" >&2
  exit 1
fi
tmux has-session -t agents 2>/dev/null || tmux new-session -d -x 220 -y 50 -s agents
