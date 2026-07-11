# Issue #102 — runtime-host deployment ownership

## Task statement

Make the durable runtime host the single serialized authority for Viewer
production deployments. Every admitted deployment must resolve a clean pinned
revision from the canonical repository, build and verify an isolated candidate,
promote it through an atomic listener switch, retain rollback capability, and
reach a deterministic journaled result across Viewer or runtime-host restarts.

## Acceptance criteria

- AC1: Deployment requests default to `origin/main`, resolve through a clean
  canonical repository mirror, and build from the resulting immutable commit.
- AC2: The request interface accepts `origin/main` or a full lowercase commit
  SHA and rejects shell fragments, Compose arguments, and mutable checkout state.
- AC3: One durable deployment lease serializes execution; concurrent requests
  receive a stable busy receipt, and idempotency-key replay returns the original
  deployment receipt and pinned revision. Admission transport allows bounded
  canonical mirror resolution without inheriting the ordinary request timeout.
- AC4: A versioned candidate image and distinct candidate container start on an
  alternate loopback endpoint while the serving release remains available.
- AC5: Bounded candidate readiness polling stops early after container exit;
  success requires process readiness, the root route, remote-shaped authorized
  success and unauthorized rejection when configured, and every
  HTML-referenced CSS and JavaScript asset.
- AC6: Promotion uses an atomic stable-listener target switch and preserves
  existing connections on their selected release.
- AC7: Promotion errors and post-promotion health failures restore the retained
  previous healthy release automatically.
- AC8: The runtime journal persists receipts, phases, ownership identity,
  candidate and previous release identities, errors, and health evidence.
- AC9: Runtime-host restart recovery verifies the lease PID and process-start
  identity before reclaiming, reconciles the exact durable adapter process
  identity, then resumes build, candidate, promotion, or rollback work toward a
  deterministic terminal phase.
- AC10: The runtime socket and Viewer routes expose request and read operations;
  snapshot and SSE projection carry progress and terminal deployment events.
- AC11: The Viewer renders a minimal current deployment status surface while
  runtime-host retains execution ownership.
- AC12: Docker and privileged host operations stay behind a fixed host adapter;
  browser-controlled data cannot select executables, shell text, Docker
  arguments, or Compose projects. Every adapter action has a bounded deadline,
  and adapter subprocess trees terminate with runtime-host ownership loss.
- AC13: The supported production release script submits an idempotent runtime
  request and follows its durable status.
- AC14: Structured agent sessions remain hosted by runtime-host throughout
  Viewer candidate replacement and cutover; promoted Viewer containers receive
  the runtime-events flag and runtime-host socket explicitly.
- AC15: Deployment execution contains zero tmux calls and has zero dependency on
  the legacy tmux supervisor.
- AC16: Focused fake-backed tests cover serialization, replay, candidate health,
  asset consistency, promotion, rollback, process identity, socket receipts,
  journal restart recovery, and one staged end-to-end sequence.
- AC17: Implementation and verification leave the live Viewer stack on port
  8898 unchanged.
- AC18: `bun test` passes.
- AC19: `bunx tsc --noEmit` passes.
- AC20: Failed candidates are retired, successful cleanup retains the serving
  and immediate rollback containers, and older managed releases are removed.
