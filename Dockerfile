# syntax=docker/dockerfile:1.7

FROM node:22.16.0-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm install -g bun@1.2.18
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM node:22.16.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
RUN npm install -g bun@1.2.18
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN env -u __NEXT_PRIVATE_STANDALONE_CONFIG \
        -u __NEXT_PRIVATE_PREBUNDLED_REACT \
        -u __NEXT_PRIVATE_BUILD_WORKER \
        bun run build

# COPY preserves source file modes while resetting ownership to root:root, so a
# umask-077 checkout (tsconfig.json at 0600) produces runtime files the
# UID-1000 viewer user cannot read and `next start` crashes (#76). Normalize
# here — the runtime stage inherits these modes via COPY --from — so image
# permissions derive from the Dockerfile alone, identically for every
# worktree: dirs 755, files 644, anything already executable 755.
RUN chmod -R u=rwX,go=rX /app

FROM node:22.16.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=127.0.0.1 \
    PORT=8898 \
    LLV_WHISPER_VENV=/opt/llv-whisper-venv \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PATH=/usr/local/bin:/home/latand/.bun/bin:/home/latand/.npm-global/bin:/home/latand/.local/bin:/usr/bin:/bin

RUN <<'EOF'
set -eu
apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gh \
  git \
  openssh-client \
  python3 \
  python3-pip \
  python3-venv \
  util-linux
rm -rf /var/lib/apt/lists/*
# A real in-container bun for first-party services (runtime-host). It must
# live under a name the nsenter shims never claim: the `bun` shim below
# redirects to the HOST bun and remaps any cwd outside /home/latand to $HOME,
# which broke `bun run src/runtime-host/main.ts` with "Module not found".
npm install -g bun@1.2.18
cp "$(realpath /usr/local/bin/bun)" /usr/local/bin/bun-container
chmod +x /usr/local/bin/bun-container
chmod u+s /usr/bin/nsenter
python3 -m venv /opt/llv-whisper-venv
/opt/llv-whisper-venv/bin/pip install --no-cache-dir --upgrade pip
/opt/llv-whisper-venv/bin/pip install --no-cache-dir faster-whisper
cat > /usr/local/bin/python <<'WRAPPER'
#!/bin/sh
exec /opt/llv-whisper-venv/bin/python "$@"
WRAPPER
chmod +x /usr/local/bin/python
mkdir -p /usr/local/host-bin
make_nsenter_shim() {
  name=$1
  host_path=$2
  cat > "/usr/local/bin/$name" <<WRAPPER
#!/bin/sh
wd=\$PWD
case "\$wd" in
  /home/latand|/home/latand/*) ;;
  *) wd=\$HOME ;;
esac
exec nsenter -t 1 -m -p --setgid="\$(id -g)" --setuid="\$(id -u)" -- /bin/sh -c 'cd "\$1" || exit; shift; exec "\$@"' sh "\$wd" "$host_path" "\$@"
WRAPPER
  chmod +x "/usr/local/bin/$name"
}
make_nsenter_shim claude /home/latand/.bun/bin/claude
make_nsenter_shim codex /home/latand/.bun/bin/codex
make_nsenter_shim bun /home/latand/.bun/bin/bun
make_nsenter_shim uv /home/latand/.local/bin/uv
make_nsenter_shim just /usr/bin/just
make_nsenter_shim tmux /usr/bin/tmux
cat > /usr/local/bin/docker <<'WRAPPER'
#!/bin/sh
wd=$PWD
case "$wd" in
  /home/latand|/home/latand/*) ;;
  *) wd=$HOME ;;
esac
# Preserve the runtime-host supplementary Docker socket group while entering
# the host mount and PID namespaces, then restore the configured runtime UID,
# primary GID, and full supplementary group list before invoking Docker.
uid=$(id -u)
gid=$(id -g)
groups=$(id -G | tr ' ' ',')
exec nsenter -t 1 -m -p -- /usr/bin/setpriv --reuid="$uid" --regid="$gid" --groups="$groups" -- /bin/sh -c 'cd "$1" || exit; shift; exec "$@"' sh "$wd" /usr/bin/docker "$@"
WRAPPER
chmod +x /usr/local/bin/docker
cat > /usr/local/bin/tmux <<'WRAPPER'
#!/bin/sh
state_dir=/tmp/llv-tmux-cwd

host_wd() {
  case "$PWD" in
    /home/latand|/home/latand/*) printf '%s' "$PWD" ;;
    *) printf '%s' "$HOME" ;;
  esac
}

run_host_tmux() {
  wd=$(host_wd)
  # LC_ALL: without a UTF-8 locale tmux sanitizes control bytes in `-F` output,
  # turning the TAB field separators panePidMap relies on into "_" — which left
  # the viewer unable to see (or kill) any tmux session. Force UTF-8 so tabs
  # survive regardless of whether the container env propagates through nsenter.
  nsenter -t 1 -m -p --setgid="$(id -g)" --setuid="$(id -u)" -- /bin/sh -c 'cd "$1" || exit; shift; exec "$@"' sh "$wd" env LC_ALL=C.UTF-8 /usr/bin/tmux "$@"
}

target_key() {
  printf '%s' "$1" | tr -cd 'A-Za-z0-9_.-'
}

quote_shell() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

host_command_text() {
  printf '%s' "$1" \
    | sed \
      -e "s|'\/usr\/local\/bin\/claude'|'/home/latand/.bun/bin/claude'|g" \
      -e "s|'\/usr\/local\/bin\/codex'|'/home/latand/.bun/bin/codex'|g" \
      -e "s|'\/usr\/local\/bin\/bun'|'/home/latand/.bun/bin/bun'|g" \
      -e "s|'\/usr\/local\/bin\/uv'|'/home/latand/.local/bin/uv'|g" \
      -e "s|'\/usr\/local\/bin\/just'|'/usr/bin/just'|g" \
      -e "s|'\/usr\/local\/bin\/tmux'|'/usr/bin/tmux'|g" \
      -e 's|/usr/local/bin/claude|/home/latand/.bun/bin/claude|g' \
      -e 's|/usr/local/bin/codex|/home/latand/.bun/bin/codex|g' \
      -e 's|/usr/local/bin/bun|/home/latand/.bun/bin/bun|g' \
      -e 's|/usr/local/bin/uv|/home/latand/.local/bin/uv|g' \
      -e 's|/usr/local/bin/just|/usr/bin/just|g' \
      -e 's|/usr/local/bin/tmux|/usr/bin/tmux|g'
}

if [ "$1" = "new-window" ]; then
  cwd=
  prev=
  for arg in "$@"; do
    if [ "$prev" = "-c" ]; then
      cwd=$arg
      break
    fi
    prev=$arg
  done
  out=$(mktemp)
  err=$(mktemp)
  run_host_tmux "$@" >"$out" 2>"$err"
  code=$?
  cat "$out"
  if [ "$code" -eq 0 ] && [ -n "$cwd" ]; then
    target=$(awk 'NR == 1 { print $1 }' "$out")
    if [ -n "$target" ]; then
      mkdir -p "$state_dir"
      printf '%s' "$cwd" > "$state_dir/$(target_key "$target")"
    fi
  fi
  cat "$err" >&2
  rm -f "$out" "$err"
  exit "$code"
fi

if [ "$1" = "send-keys" ] && [ "${2:-}" = "-t" ] && [ "${4:-}" = "-l" ] && [ -n "${5:-}" ]; then
  target=$3
  command_text=$(host_command_text "$5")
  cwd_file="$state_dir/$(target_key "$target")"
  if [ -f "$cwd_file" ]; then
    cwd=$(cat "$cwd_file")
    rm -f "$cwd_file"
    run_host_tmux send-keys -t "$target" -l "cd $(quote_shell "$cwd") && $command_text"
    exit $?
  fi
  run_host_tmux send-keys -t "$target" -l "$command_text"
  exit $?
fi

run_host_tmux "$@"
WRAPPER
chmod +x /usr/local/bin/tmux
EOF

COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src
COPY --from=build /app/scripts/whisper_transcribe.py ./scripts/whisper_transcribe.py
COPY --from=build /app/scripts/runtime-host-viewer-adapter.ts ./scripts/runtime-host-viewer-adapter.ts
COPY --from=build /app/node_modules ./node_modules

# Permission gate: the compose service runs this image as a non-root user
# (default 1000:1000 — the same UID as `node` here), so every runtime file
# must be readable and every directory traversable by that identity. A bad
# checkout must fail the image build, never the production health gate. The
# build-stage normalization above makes this hold for every worktree umask;
# this gate replaces the emergency runtime-stage `chmod -R a+rX /app`, which
# duplicated all of /app into an extra image layer.
RUN <<'EOF'
set -eu
bad=$(/usr/sbin/runuser -u node -- find /app \( -type d ! -executable \) -o \( ! -type l ! -readable \) 2>&1 | head -20 || true)
if [ -n "$bad" ]; then
  echo "runtime files not accessible to UID 1000:" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi
/usr/sbin/runuser -u node -- sh -c 'cat /app/tsconfig.json /app/next.config.ts /app/package.json > /dev/null'
EOF

EXPOSE 8898
CMD ["sh", "-c", "exec node_modules/.bin/next start --port ${PORT:-8898} --hostname ${HOSTNAME:-127.0.0.1}"]
