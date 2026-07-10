# Task: Deterministic runtime image permissions across worktrees (issue #76)

## Statement

The #74 integration image crashed the viewer at the production health gate:
the integration checkout was created under umask 077, so tracked config files
sat at mode 0600. Docker `COPY` preserves the source mode while resetting
ownership to `root:root`, and the compose service runs as UID 1000, so Next
could not read `/app/tsconfig.json` while loading `next.config.ts`. Root
restored the prior image manually; the external tmux supervisor stayed
healthy throughout.

Make runtime-image permissions deterministic across worktrees and host
umasks, verify them at build time as the real non-root runtime identity, and
add a regression test. Branch `fix/docker-runtime-permissions`, PR #104,
rebased onto current main (which carried an emergency runtime-stage
`chmod -R a+rX /app` hotfix this change supersedes).

## Acceptance criteria

Code-merge acceptance (demonstrable from this branch):

- AC1: Image file permissions derive from the Dockerfile alone — a umask-077
  checkout (0600 `tsconfig.json`/`next.config.ts`) produces the same runtime
  modes as a umask-022 checkout (dirs 755, files 644, executables 755).
- AC2: All runtime files are readable and all directories traversable by the
  configured non-root viewer user (compose default `1000:1000`).
- AC3: Executable files retain their execution bits (mode spec uses `X`).
- AC4: No runtime write access is granted beyond the existing contract
  (owner stays root; group/other receive no write bits).
- AC5: Image verification runs as the actual non-root runtime identity at
  build time and fails the build — before any deployment — on unreadable
  config or application files, including the exact incident files.
- AC6: A regression test under `bun test` guards both mechanisms: the
  build-stage normalization (spec extracted from the Dockerfile, applied to a
  umask-077 fixture, asserting deterministic 644/755/755) and the runtime
  gate's presence after the last `COPY --from=build`.
- AC7: The emergency runtime-stage `chmod -R a+rX /app` hotfix is removed
  (it duplicated all of /app into an extra image layer); its guarantee is
  preserved by AC1 + AC5.
- AC8: `bun test` and `bunx tsc --noEmit` pass; the change's own verification
  (scratch-tagged builds, throwaway containers) never touches the production
  tag `agent-log-viewer:node22`, the running viewer, or the external tmux
  supervisor.

Release (cutover) acceptance — required by issue #76, executed by the
operator via `scripts/rebuild.sh` when this image is deployed; the issue must
not be considered fully accepted until these are demonstrated in production:

- AC9: The production health check (page HTTP 200) and the CSS asset check
  (HTML-referenced stylesheet HTTP 200) pass after container replacement on
  127.0.0.1:8898.
- AC10: External tmux ownership remains active throughout the cutover —
  `agent-log-viewer-legacy-tmux.service` stays up and agent sessions stay
  reachable (rebuild.sh already refuses a viewer-only rebuild when the
  supervisor is inactive or the migration marker is absent).
