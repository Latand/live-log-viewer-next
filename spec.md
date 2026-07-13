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
- AC6: A periodic Viewer tick finds stale Viewer review commands whose exact flow-artifact path, PID, and process-start identity match a persisted Viewer flow round, plus orphaned MCP roots identified through explicit executable or package-runner shapes, including `uv` global options followed by `run`, at or above a configurable age threshold; the default is two hours.
- AC7: Reaper selection and actuation protect every fresh tmux pane ancestry, every active flow-round identity, every Codex or Claude owner subtree, every live Codex app-server tree, and every Claude ancestry.
- AC8: Reaper actuation refreshes flow, process, PPID, and process-start evidence before TERM and KILL, captures identities for every orphan descendant, then fences each identity at both signal boundaries. A failed tmux observation suppresses the cleanup tick.
- AC9: Consecutive Codex app-server initialize timeouts use persisted exponential cooldowns starting at one minute and capped at fifteen minutes.
- AC10: Transcript quota data remains available during initialize-timeout cooldowns, and a successful live probe clears the timeout streak.
- AC11: Unit tests cover group signaling, stale-process selection and revalidation, tmux/flow/Claude protections, and initialize-timeout backoff.
- AC12: `bun test`, touched-file ESLint, and `bunx tsc --noEmit` pass.

## Inherited runtime contract from issue #150

Productize the issue #25 Claude stream-json prototype as `ClaudeStreamBrokerHost`, an `EngineHost` adapter that owns one long-lived Claude process per hosted session and preserves queue, replay, and resume state durably.

### Base acceptance criteria

AC1: Every runtime implementation change lives under `src/lib/runtime/`. Structured Claude hosting activates only when `LLV_STRUCTURED_HOSTS=1`; the default remains disabled and existing tmux behavior stays unchanged.

AC2: Every outbound user queue entry is fsynced to the Claude delivery ledger before the first corresponding stdin write. A crash after the ledger append and before actuation leaves a safely retryable entry.

AC3: A ledger entry becomes delivered only after its matching replayed user message appears on the Claude stream or in the durable Claude transcript during adoption.

AC4: `ClaudeStreamBrokerHost` conforms to `EngineHost`: `attach(afterSeq)`, `send`, `interrupt`, `answer`, `health`, and `release`. Replay is monotonic and durable for late viewers, regular active-turn sends queue for the following turn, and interruption uses an explicit control request.

AC5: A fresh broker resumes the same Claude session through `--resume <session_id>`. Registry adoption persists the broker process identity, event cursor, CLI version, writer epoch, active turn, and pending attention state.

AC6: Claude children use the local `claude.ai` subscription login. Provider API-key and OAuth-token environment variables never cross into the child process or diagnostic output.

AC7: The real CLI integration test skips cleanly when the Claude binary or subscription login is unavailable and verifies late attach plus restart resume when available.

AC8: No tmux delivery, flow-engine, scanner, or UI source is changed.

### Base validation gates

- `bun test`
- `bunx tsc --noEmit`
- ESLint for every changed TypeScript file
- Real local Claude subscription integration when the authenticated CLI is available
