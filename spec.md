# Issue #159: Headless Codex process containment

## Task statement

Prevent Viewer-owned headless Codex work from accumulating MCP server fleets. Isolate every review and app-server child in a process group, disable MCP startup, reap stale Viewer review groups and orphaned MCP roots, and reduce quota-probe churn after repeated initialize timeouts.

## CLI verification

Codex CLI 0.144.1 treats `-c mcp_servers={}` as a merge, so configured MCP entries remain enabled when a thread starts. The verified review-round isolation flag is `codex exec --ignore-user-config`; it preserves `CODEX_HOME` authentication and starts zero configured MCP children. App-server launches still carry the requested empty-table override. Structured thread start and resume additionally read the effective server table, disable every entry, disable plugin/app MCP sources, and suppress app instructions.

## Acceptance criteria

- AC1: Viewer-owned `codex exec` reviewers start with clean user configuration and zero configured MCP servers.
- AC2: Both Viewer-owned `codex app-server` implementations pass `-c mcp_servers={}`.
- AC3: Structured Codex thread start and resume disable all effective MCP entries plus plugin/app MCP sources.
- AC4: Every Viewer-owned headless Codex child uses `detached: true` and receives group-wide SIGTERM followed by group-wide SIGKILL after the existing grace period, including when the group leader exits during grace.
- AC5: Interactive tmux agent spawn behavior remains unchanged.
- AC6: A periodic Viewer tick finds stale Viewer review commands whose exact flow-artifact path, PID, and process-start identity match a persisted Viewer flow round, plus orphaned MCP roots at or above a configurable age threshold; the default is two hours.
- AC7: Reaper selection protects every fresh tmux pane ancestry, every active flow-round identity, every live Codex app-server tree, and every Claude ancestry.
- AC8: Reaper actuation refreshes tmux, flow, process, and process-start evidence immediately before signaling. A failed tmux observation suppresses the cleanup tick.
- AC9: Consecutive Codex app-server initialize timeouts use persisted exponential cooldowns starting at one minute and capped at fifteen minutes.
- AC10: Transcript quota data remains available during initialize-timeout cooldowns, and a successful live probe clears the timeout streak.
- AC11: Unit tests cover group signaling, stale-process selection and revalidation, tmux/flow/Claude protections, and initialize-timeout backoff.
- AC12: `bun test`, touched-file ESLint, and `bunx tsc --noEmit` pass.
