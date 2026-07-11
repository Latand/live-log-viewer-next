# Releasing

## Production Viewer deployment

Production application releases are admitted by the durable runtime host:

```bash
scripts/rebuild.sh
```

The default request resolves `origin/main` in the adapter's canonical mirror. A full lowercase commit SHA can be selected with `LLV_DEPLOY_REVISION`. Reuse `LLV_DEPLOY_IDEMPOTENCY_KEY` after a client timeout to receive the original receipt.

The runtime host serializes deployment requests and journals every phase before invoking the host adapter. Its stable listener reads `state/viewer-release.json` for each new connection, so promotion and rollback use an atomic target-file rename. Candidate and previous Viewer containers stay under Docker ownership on alternate loopback ports.

Enable this mode only after the [bootstrap listener migration](docker.md#bootstrap-listener-ownership) has health-gated an alternate managed release, placed its identity in `state/viewer-release.json`, and freed `127.0.0.1:8898` for runtime-host:

```bash
export LLV_DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
LLV_RUNTIME_EVENTS=1 LLV_VIEWER_DEPLOYMENTS=1 docker compose --profile runtime-host up -d runtime-host
```

The runtime-host container uses UID/GID `1000:1000` by default and receives
the Docker socket GID as a supplementary group. `LLV_UID`, `LLV_GID`,
`LLV_TMUX_TMPDIR`, and `LLV_ENV_FILE` flow into nested Compose resolution so
candidate containers preserve supported host overrides. The Docker namespace
shim restores the complete credential set before invoking the host CLI.

The built-in host adapter lives at `/app/scripts/runtime-host-viewer-adapter.ts`. It maintains a clean canonical Git mirror under the durable state directory, resolves a commit SHA, creates a detached source worktree, builds a versioned Docker image, starts a distinct candidate container with the runtime-host socket configured, checks process readiness plus remote authorized/unauthorized behavior and every referenced CSS/JavaScript asset, and atomically changes the listener target. Post-promotion failure restores the journaled previous target. Successful cleanup retains the serving and immediate rollback containers; failed and superseded managed candidates are retired.

Each adapter action has a fixed deadline. Runtime-host records the adapter PID
and process-start identity durably, launches it with a parent-death signal, and
reconciles that exact process group before replaying a journaled phase after a
restart.

The adapter protocol invokes one fixed executable with one action argument and
sends one JSON object on stdin. Every action must be idempotent because restart
recovery can replay it.

`ViewerReleaseIdentity` is an object with string fields `image`, `container`,
`endpoint`, and `revision`.

| Action | JSON input |
| --- | --- |
| `resolve-revision` | `{ "revision": string }` |
| `build-candidate` | `{ "deploymentId": string, "revision": string }` |
| `start-candidate` | `{ "candidate": ViewerReleaseIdentity }` |
| `current-release` | `{}` |
| `verify-candidate` | `{ "candidate": ViewerReleaseIdentity }` |
| `promote` | `{ "candidate": ViewerReleaseIdentity }` |
| `verify-promoted` | `{ "candidate": ViewerReleaseIdentity }` |
| `rollback` | `{ "previous": ViewerReleaseIdentity, "candidate": ViewerReleaseIdentity }` |
| `retire` | `{ "release": ViewerReleaseIdentity }` |
| `retain-only` | `{ "releases": ViewerReleaseIdentity[] }` |

`retire` removes the supplied failed or superseded release container and may
remove its unused image. `retain-only` preserves the supplied serving and
rollback releases and removes every other managed Viewer container and unused
image. Browser request data cannot select executables, Docker arguments,
Compose projects, or shell text.

Deployment state is available through `POST /api/runtime/deployments`, `GET /api/runtime/deployments/:id`, the runtime snapshot, and the existing SSE stream. The Viewer shows the latest phase in a compact status pill.

The legacy direct Compose replacement workflow is unsupported after listener migration.

## Package release

1. Bump `version` in `package.json`.
2. Run `npm publish --dry-run` and inspect the file list. It should contain
   `bin/`, `dist/`, `README.md`, `LICENSE`, and `package.json`.
3. Run `npm publish`.

The `prepack` script runs automatically for `npm pack`, `npm publish`, and
their dry runs. It builds with `LLV_STANDALONE=1`, copies `.next/standalone` to
`dist/standalone`, and copies `.next/static` into
`dist/standalone/.next/static`.

Observed `npm pack --dry-run` output lists package-relative paths such as
`dist/standalone/server.js`; those are the paths inside the tarball.
