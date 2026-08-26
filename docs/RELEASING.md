# Releasing

## Production Viewer deployment

Production application releases are admitted by the durable runtime host:

```bash
scripts/rebuild.sh
```

The default invocation carries no revision at all. `scripts/rebuild.sh` reads the canonical `refs/heads/main` tip itself with `git ls-remote` against the canonical remote and posts that exact commit, so no SHA is ever retyped between a note and a deploy — a mangled tail deployed a revision that never existed for six hours (#1032, #1033). It prints the resolved SHA before requesting admission.

A pinned redeploy or rollback still names its commit: `scripts/rebuild.sh <full lowercase commit SHA>`, or `LLV_DEPLOY_REVISION`. A revision the canonical repository does not carry is refused at admission with `revision <sha> not found in the canonical repository (fetched from <remote>)`.

Reuse `LLV_DEPLOY_IDEMPOTENCY_KEY` after a client timeout to receive the original receipt.

`POST /api/runtime/deployments` takes the same target two ways: `{"revision": "<full commit SHA>", "idempotencyKey": "..."}` pins a commit, and `{"ref": "refs/heads/<branch>", "idempotencyKey": "..."}` names a branch of the canonical repository, which the host adapter resolves in the canonical mirror. A request carrying both is refused. Only `refs/heads/*` of the canonical repository is accepted — no tags, no remote-tracking refs, no revision expressions. Whichever way the request named its target, the deployment ledger records the requested target and the exact resolved SHA that was built and promoted.

The canonical remote defaults to `https://github.com/Latand/live-log-viewer-next.git` for both the adapter's mirror and `scripts/rebuild.sh`. Set `LLV_VIEWER_CANONICAL_REMOTE` when a different public or private mirror is required.

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

The built-in host adapter lives at `/app/scripts/runtime-host-viewer-adapter.ts`. It maintains a clean canonical Git mirror under the durable state directory, resolves the requested branch ref or SHA to an exact commit (peeling `^{commit}`, which is what proves the object is actually present), creates a detached source worktree, builds a versioned Docker image, starts a distinct candidate container with the runtime-host socket configured, checks process readiness plus remote authorized/unauthorized behavior and every referenced CSS/JavaScript asset, and atomically changes the listener target. Post-promotion failure restores the journaled previous target. Successful cleanup retains the serving and immediate rollback containers; failed and superseded managed candidates are retired.

Each adapter action has a fixed deadline. Runtime-host records the adapter PID
and process-start identity durably, launches it with a parent-death signal, and
reconciles that exact process group before replaying a journaled phase after a
restart.

The serving candidate remains running after promotion. The immediate rollback
container stays stopped with its image, Compose snapshot, and reserved port
preserved. Rollback starts that container, passes its direct health gate, and
then atomically changes the stable target. This keeps rollback durable without
duplicating Viewer scanner memory and CPU between releases.

The adapter protocol invokes one fixed executable with one action argument and
sends one JSON object on stdin. Every action must be idempotent because restart
recovery can replay it.

`ViewerReleaseIdentity` is an object with string fields `image`, `container`,
`endpoint`, and `revision`.

| Action | JSON input |
| --- | --- |
| `resolve-revision` | `{ "revision": string }` — `origin/main`, `refs/heads/<branch>`, or a full commit SHA |
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

## Dependency updates

Dependabot opens one grouped npm pull request a week, plus security updates as they land ([`.github/dependabot.yml`](../.github/dependabot.yml)). Its npm ecosystem rewrites `package.json` and leaves `bun.lock` alone, which the lockfile-integrity rule in [`supply-chain.yml`](../.github/workflows/supply-chain.yml) rejects and `bun install --frozen-lockfile` refuses outright, so [`dependabot-lockfile.yml`](../.github/workflows/dependabot-lockfile.yml) runs `bun install --lockfile-only` on the Dependabot branch and pushes the result as `chore(deps): refresh bun.lock` with the repository `GITHUB_TOKEN`. The commit names `bun.lock` explicitly, so it carries that file and nothing else, and it is authored by the GitHub Actions bot the token belongs to.

It runs on `pull_request_target`, which is what a workflow needs to write anything on a Dependabot pull request: GitHub gives a workflow Dependabot triggered through `pull_request` a read-only `GITHUB_TOKEN`, and `pull_request_target` is the one pull-request event its [restriction list](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-on-actions) omits, barring a pull request whose base branch Dependabot itself created. That event also reads the workflow file from the base branch, so a Dependabot pull request opened before this merged is covered on its next event without being rebased first.

The job runs only for a pull request opened by `dependabot[bot]` from a branch of this repository, and it is the only job here that receives `contents: write`. A branch a person named `dependabot/…` does not reach it, and neither does a fork — the checkout deliberately does not set `allow-unsafe-pr-checkout`, so `actions/checkout` refuses a fork head under this event whatever the job's own condition says. The first step reads the head branch's protection state and fails the job when the branch is protected, before the branch's `package.json` is installed, and the token reaches no step until after that install. The push is an ordinary one from the revision the install read, so Git refuses a branch that a Dependabot force-push has already moved: the run that force-push starts resolves the lockfile again, and a lockfile only ever lands on the `package.json` it was resolved from.

GitHub raises no `synchronize` for a push made with that token, so nothing would inspect the commit the refresh just wrote. The refresh dispatches `supply-chain.yml`, `privacy-publication.yml` and `privacy-tracker-audit.yml` against the branch afterwards; each dispatched run reads the branch head, which is the commit its own check run lands on. Those three workflows accept `workflow_dispatch` for that reason alone, and their pull-request paths are untouched.

A Dependabot pull request opened before this workflow merged still carries older copies of the three gate workflows on its own branch, and a dispatch reads the workflow file from the branch it names, so those dispatches are refused there and the step reports each refusal as a warning rather than failing. The lockfile commit stands regardless; re-run the checks on the refreshed head, or comment `@dependabot rebase` before the lockfile commit lands to pull the current workflows onto the branch — Dependabot stops rebasing a pull request once anything else has pushed to it.

## Package release

High-severity dependency exceptions require a reason and expiry in [`security/audit-allowlist.json`](../security/audit-allowlist.json); expired entries fail the audit gate.

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
