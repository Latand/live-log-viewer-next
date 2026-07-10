#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_source="$repo_dir/deploy/systemd/agent-log-viewer-legacy-tmux.service"
unit_target="$HOME/.config/systemd/user/agent-log-viewer-legacy-tmux.service"

if [ "${1:-}" != "--install" ]; then
  echo "SAFE PREFLIGHT: pass --install only after explicit operator approval"
  systemctl --user show-environment >/dev/null
  loginctl show-user "$(id -u)" -p Linger
  test -r "$unit_source"
  test -d "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  echo "unit=$unit_source"
  echo "runtime=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-log-viewer"
  exit 0
fi

install -Dm0644 "$unit_source" "$unit_target"
systemctl --user daemon-reload
systemctl --user enable --now agent-log-viewer-legacy-tmux.service
TMUX_TMPDIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/agent-log-viewer" tmux has-session -t agents
