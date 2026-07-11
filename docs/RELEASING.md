# Releasing

## Production Viewer deployment

Production application releases are admitted by the durable runtime host:

```bash
scripts/rebuild.sh
```

The default request resolves `origin/main` in the adapter's canonical mirror. A full lowercase commit SHA can be selected with `LLV_DEPLOY_REVISION`. Reuse `LLV_DEPLOY_IDEMPOTENCY_KEY` after a client timeout to receive the original receipt.

The runtime host serializes deployment requests and journals every phase before invoking the host adapter. Its stable listener reads `state/viewer-release.json` for each new connection, so promotion and rollback use an atomic target-file rename. Candidate and previous Viewer containers stay under Docker ownership on alternate loopback ports.

Enable this mode only after the one-time listener migration has placed the current healthy release identity in `state/viewer-release.json` and freed `127.0.0.1:8898` for runtime-host:

```bash
LLV_RUNTIME_EVENTS=1 LLV_VIEWER_DEPLOYMENTS=1 docker compose --profile runtime-host up -d runtime-host
```

The built-in host adapter lives at `/app/scripts/runtime-host-viewer-adapter.ts`. It maintains a clean canonical Git mirror under the durable state directory, resolves a commit SHA, creates a detached source worktree, builds a versioned Docker image, starts a distinct candidate container, checks process readiness plus root/authenticated routes and every referenced CSS/JavaScript asset, and atomically changes the listener target. Post-promotion failure restores the journaled previous target.

The adapter protocol is a fixed executable plus one action argument. JSON request data arrives on stdin. Supported actions are `resolve-revision`, `build-candidate`, `start-candidate`, `current-release`, `verify-candidate`, `promote`, `verify-promoted`, and `rollback`. Browser request data cannot select executables, Docker arguments, Compose projects, or shell text.

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
