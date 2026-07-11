# Docker

The Docker image pins Node 22 and builds the Next.js app inside the image from a clean environment. It keeps the viewer host-coupled by design: Compose uses the host network, host PID namespace, privileged `nsenter` shims, the real `/home/latand` tree, and the host tmux socket.

Runtime tools are split by coupling. The image owns stable runtimes: Node 22, Git, GitHub CLI, OpenSSH client, curl, CA certificates, Python 3, and a faster-whisper venv at `/opt/llv-whisper-venv`. Compose mounts the full host home at `/home/latand`, so SSH keys, Git config, GitHub CLI auth, Claude/Codex state, app cache, Hugging Face cache, and workspace roots line up with host paths. `GIT_SSH_COMMAND` points image Git/OpenSSH at the mounted host SSH config, known hosts, and default GitHub identity.

Host developer CLIs run through `nsenter` shims in `/usr/local/bin`, ahead of mounted user bins in `PATH`. The shims enter the host mount and PID namespaces, use the caller uid/gid, preserve host-visible cwd values, and fall back to `$HOME` for container-only paths such as `/app`. They execute the exact host paths: `claude`, `codex`, and `bun` from `/home/latand/.bun/bin`; `uv` from `/home/latand/.local/bin`; `just` and `tmux` from `/usr/bin`. `LLV_DOCKER_NSENTER_SHIMS=1` also makes direct Claude/Codex resolver calls choose `/usr/local/bin` shims. The image contains the app, Node dependencies, the local transcription helper script, and the prebuilt `.next` output.

## Production instance

The `viewer` service is the production runtime on `127.0.0.1:8898`. It replaced the old `agent-log-viewer.service` systemd user unit, which is now disabled and inactive.

```bash
docker compose up -d --build viewer
```

`restart: unless-stopped` gives reboot survival (it replaces the systemd `Restart=always`). Manage the viewer with `docker compose` — `docker compose restart viewer`, `docker compose logs -f viewer` — not `systemctl`. If you ever re-enable the old systemd unit, stop the container first: both bind `127.0.0.1:8898` and only one process can own the port.

## Legacy tmux supervisor migration

The Viewer listens on `127.0.0.1:8898`. Legacy tmux panes acquire a separate user-service owner only after the explicitly approved migration. The service runs a foreground tmux server at `/run/user/1000/agent-log-viewer`, then bootstraps the canonical `agents` session.

Run this read-only preflight first:

```bash
./scripts/install-legacy-tmux-supervisor.sh
```

The installation command requires `--install` and a later operator approval. It enables `agent-log-viewer-legacy-tmux.service`; it does not run as a Compose service.

## Attach to a Viewer pane

Use the attach command copied by the Viewer for a live pane. It includes the configured endpoint and the pane's current display target. For example:

```bash
TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -t 'agents:2.0'
```

For an observation-only terminal, use the read-only form:

```bash
TMUX_TMPDIR='/run/user/1000/agent-log-viewer' tmux attach-session -r -t 'agents:2.0'
```

Detach with `Ctrl-b d`; the pane and its agent continue running. The endpoint prefix is required because an unqualified `tmux attach-session` can select another tmux server. If the Viewer reports that the pane changed or the tmux server restarted, refresh the page and copy a newly resolved command. Window renumbering is handled when the command is copied.

Keep `LLV_LEGACY_TMUX_EXTERNAL=0` while the container-owned server still hosts legacy panes. That preserves the current `/tmp/tmux-1000` behavior. The cutover phase machine may commit `state/legacy-tmux-migration-complete` only after it verifies both the supervisor endpoint and the moved sessions. Every failed, aborted, or rolled-back cutover removes that marker. After those checks succeed, deploy the Viewer with:

```bash
LLV_LEGACY_TMUX_EXTERNAL=1 \
LLV_TMUX_TMPDIR=/run/user/1000/agent-log-viewer \
./scripts/rebuild.sh
```

External-host mode fails closed when `agents` cannot be found through the dedicated endpoint. It never creates a replacement tmux server from the Viewer container. The migration preflight records a nonce-bound approval token; the later operator runbook must checkpoint the root, verify its successor uses the same engine-native thread, and roll back on any failed verification.

If marker and endpoint state drift apart, `/api/files` reports degraded tmux health and the Viewer displays an operator alert. Delivery continues through the configured endpoint so a stale marker cannot disable every legacy pane.

The `scripts/e2e-viewer-replacement.ts` helper provides prepare and verify snapshots for that later runbook. Its normal modes only inspect state. It does not recreate a container, send a root message, or kill a pane.

## Test instance

Use the test profile for local validation on another port:

```bash
LLV_TEST_PORT=8901 docker compose --profile test up --build viewer-test
```

This reuses the same image and mounts, with the service listening on `127.0.0.1:$LLV_TEST_PORT` through host networking, so no Compose port mapping is used.

To exercise the ChatGPT transcription backend in Docker, pass the backend override through Compose:

```bash
LLV_TEST_PORT=8901 LLV_TRANSCRIBE_BACKEND=chatgpt docker compose --profile test up viewer-test
```

## Mounted paths

Compose mounts the whole host home:

- `/home/latand:/home/latand`

This gives the scanner and spawn validation the same paths the host service sees, including:

- `/home/latand/.claude/projects`
- `/home/latand/.codex/sessions`
- `/home/latand/.claude.json`
- any cwd under `/home/latand`, such as `.agents`, `Projects`, `Documents`, `Downloads`, `Desktop`, and `remote`

Additional runtime mounts keep host sockets reachable:

- `/tmp/tmux-1000`
- `/tmp/claude-1000`

If the host uid differs, run with `LLV_UID` and `LLV_GID` set and make sure the matching `/tmp/tmux-$LLV_UID` and `/tmp/claude-$LLV_UID` paths exist.
