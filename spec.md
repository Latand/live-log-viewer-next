# External tmux supervisor integration hardening

## Task statement

Harden the external tmux supervisor integration for issues #68 and #67. A stale `legacy-tmux-migration-complete` marker must preserve message delivery through the configured endpoint and surface an actionable health warning. The migration phase machine must own marker commit and rollback around verified supervisor cutover. Spawn settlement must remain successful when host observation completes the same launch before `POST /api/spawn` finishes. Attach commands must resolve through the explicit external supervisor endpoint.

Testing uses injected filesystem and tmux adapters. The live supervisor socket, sessions, and migration marker remain untouched.

## Acceptance criteria

- AC1: The migration phase machine commits the completion marker only after it verifies supervisor reachability and confirms that sessions moved.
- AC2: Failed, aborted, resumed-terminal, and rolled-back migrations remove completion-marker state, including failures that happen after marker commit.
- AC3: Marker/configuration drift produces a structured degraded tmux health result while delivery continues through the configured tmux endpoint.
- AC4: `GET /api/files` includes the tmux health result in a secret-free `systemHealth` projection.
- AC5: The Viewer displays an accessible, actionable alert whenever tmux health is degraded and hides it for healthy state.
- AC6: Route settlement remains idempotent when observation settles the same `launchId` first, so a successful external-tmux spawn produces a successful API result and preserves hosted-spawn state.
- AC7: Attach resolution uses the endpoint descriptor derived from the configured `TMUX_TMPDIR`, including `/run/user/<uid>/agent-log-viewer` for the external supervisor socket.
- AC8: Regression tests exercise marker ordering, marker rollback, degraded health API/UI projection, spawn settlement races, and endpoint-aware attach behavior without changing live supervisor state.
- AC9: `bun test`, `bunx tsc --noEmit`, ESLint, and `git diff --check` pass.
