# Docker

The npm/bunx CLI includes its own supervised runtime host, so pipelines and the
orchestrator do not require Docker. Compose keeps a separate production
ownership model: the `runtime-host` profile owns the stable listener, journal,
deployment coordinator, and socket configured below. CLI supervision does not
change this profile.

The Docker image pins Node 22 and builds the Next.js app inside the image from a clean environment. It keeps the viewer host-coupled by design: Compose uses the host network, host PID namespace, privileged `nsenter` shims, the real `/home/user` tree, and the host tmux socket.

Runtime tools are split by coupling. The image owns stable runtimes: Node 22, Git, GitHub CLI, OpenSSH client, curl, CA certificates, Python 3, and a faster-whisper venv at `/opt/llv-whisper-venv`. Compose mounts the full host home at `/home/user`, so SSH keys, Git config, GitHub CLI auth, Claude/Codex state, app cache, Hugging Face cache, and workspace roots line up with host paths. `GIT_SSH_COMMAND` points image Git/OpenSSH at the mounted host SSH config, known hosts, and default GitHub identity.

Host developer CLIs run through `nsenter` shims in `/usr/local/bin`, ahead of mounted user bins in `PATH`. The shims enter the host mount and PID namespaces, use the caller uid/gid, preserve host-visible cwd values, and fall back to `$HOME` for container-only paths such as `/app`. They execute the exact host paths: `claude`, `codex`, and `bun` from `/home/user/.bun/bin`; `uv` from `/home/user/.local/bin`; `just` and `tmux` from `/usr/bin`. `LLV_DOCKER_NSENTER_SHIMS=1` also makes direct Claude/Codex resolver calls choose `/usr/local/bin` shims. The image contains the app, Node dependencies, the local transcription helper script, and the prebuilt `.next` output.

## Production instance

Runtime-host owns production releases and the stable listener on
`127.0.0.1:8898`. Docker owns the current and rollback Viewer containers on
candidate ports. Complete the bootstrap migration below before activating
runtime-host.

### Bootstrap listener ownership

Keep the legacy Viewer serving port 8898 while the first managed release is
prepared. Skip this command when the legacy service is already running:

```bash
LLV_ALLOW_LEGACY_VIEWER=1 docker compose --profile legacy-viewer-migration up -d --build viewer
```

Build the runtime-host image and run its one-time bootstrap action. The action
resolves `origin/main` from the canonical mirror, builds and starts a candidate
on an available alternate port, runs the full health gate, and atomically
writes `state/viewer-release.json`. It retires the candidate when verification
fails and leaves the legacy listener in place.

```bash
export LLV_DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
docker compose --profile runtime-host build runtime-host
printf '%s\n' '{"revision":"origin/main"}' | \
  docker compose --profile runtime-host run --rm -T \
    -e LLV_DEPLOYMENT_ADAPTER_PROTOCOL=1 \
    runtime-host \
    bun-container run scripts/runtime-host-viewer-adapter.ts bootstrap-release
test -s "${LLV_VIEWER_DEPLOY_TARGET:-$HOME/.config/agent-log-viewer/state/viewer-release.json}"
```

The bootstrap action refuses to replace an existing target. After it returns a
healthy candidate and the target-file check succeeds, stop and remove the
legacy container. This frees port 8898 for runtime-host while the managed
candidate continues serving on its alternate port.

```bash
docker compose --profile legacy-viewer-migration stop viewer
docker compose --profile legacy-viewer-migration rm -f viewer
```

Activate runtime-host and verify the stable listener:

```bash
LLV_RUNTIME_EVENTS=1 LLV_VIEWER_DEPLOYMENTS=1 docker compose --profile runtime-host up -d runtime-host
curl --fail --silent --show-error http://127.0.0.1:8898/ >/dev/null
scripts/rebuild.sh
```

Use `scripts/rebuild.sh` for every production Viewer release. Runtime-host
serializes the request, verifies the candidate, and switches its listener
target. Inspect the owner with
`docker compose --profile runtime-host logs -f runtime-host`.

Run that command from any checkout of the repository, a worktree included, with
nothing wrapping it and no `git pull` before it: it posts a revision, and the
runtime host builds that revision from its own canonical Git mirror rather than
from the working tree (#1309). With no argument and no `LLV_DEPLOY_REVISION`
override it resolves the canonical `refs/heads/main` tip and deploys that exact
commit; a full 40-character commit SHA in either case pins a redeploy or a
rollback and is posted lowercase.

### Bootstrap the runtime host onto a new revision (#1216)

`scripts/rebuild.sh` replaces the runtime-host generation only in the
`host-handoff` phase, which is downstream of `promoting`. A defect in the
promote path therefore pins the runtime host to the revision that carries the
defect: every later deployment runs the old promote code, fails in the same
place, rolls back, and never reaches the staging that would have installed the
fix. `scripts/bootstrap-runtime-host.ts` is the way out. It stages the same
#518 successor from a chosen revision without a deployment, so no promote has
to have succeeded first.

Run it on the host, from a checkout, with `bun`. The default mode renders the
plan and changes nothing:

```bash
bun scripts/bootstrap-runtime-host.ts            # plan only
bun scripts/bootstrap-runtime-host.ts <sha>      # plan a pinned revision
```

The plan names the target revision and image, the successor container it will
create, the predecessor container it is replacing, and — for a hand-over — the
one container it will stop. It also states what it never stops: Viewer release
containers, the structured and engine hosts inside them, and every live agent
session, pipeline, and orchestrator they own.

Read the plan, then choose how far to go:

```bash
bun scripts/bootstrap-runtime-host.ts --stage      # build and stage; stop nothing
bun scripts/bootstrap-runtime-host.ts --hand-over  # also stop the predecessor
```

`--stage` builds the image from a clean canonical worktree and creates the
successor container. The successor is *parked* on the singleton fence — it
waits there with no deadline, so it neither times out nor restart-loops — while
the predecessor keeps serving and the durable release record is repointed.
Nothing is stopped and there is no window to beat: the hand-over can follow
minutes or hours later and resumes that same container.

A successor staged by a *deployment* keeps the bounded #518 wait instead. There
the predecessor has already been asked to exit, so a bound on the wait is what
makes a wedged hand-over visible.

`--hand-over` performs the staging and then stops the predecessor runtime-host
container so the successor acquires the fence. `127.0.0.1:8898` is unserved for
the length of that exit; the run waits for the fence and names what it saw if
it never arrives. A managed predecessor remains stopped as the bounded rollback
target after the successor proves its startup and framed serving evidence.

After a host-only bootstrap the runtime host runs a newer revision than the
published Viewer release, so its boot-time MCP reconcile logs
`runtime-host MCP revision differs from the active Viewer release` and leaves
the published runtime unchanged. That is expected; the next successful
`scripts/rebuild.sh` brings the Viewer release up to the same revision.

The Compose `viewer` service exists only for the one-time listener migration. Its
`legacy-viewer-migration` profile and `LLV_ALLOW_LEGACY_VIEWER=1` launch grant
must both be present.

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

- `/home/user:/home/user`

This gives the scanner and spawn validation the same paths the host service sees, including:

- `/home/user/.claude/projects`
- `/home/user/.codex/sessions`
- `/home/user/.claude.json`
- any cwd under `/home/user`, such as `.agents`, `Projects`, `Documents`, `Downloads`, `Desktop`, and `remote`

Additional runtime mounts keep host sockets reachable:

- `/tmp/tmux-1000`
- `/tmp/claude-1000`

If the host uid differs, run with `LLV_UID` and `LLV_GID` set and make sure the matching `/tmp/tmux-$LLV_UID` and `/tmp/claude-$LLV_UID` paths exist.
