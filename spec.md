# Issue #150: Durable Claude stream broker host

Productize the issue #25 Claude stream-json prototype as `ClaudeStreamBrokerHost`, an `EngineHost` adapter that owns one long-lived Claude process per hosted session and preserves queue, replay, and resume state durably.

## Acceptance criteria

AC1: Every runtime implementation change lives under `src/lib/runtime/`. Structured Claude hosting activates only when `LLV_STRUCTURED_HOSTS=1`; the default remains disabled and existing tmux behavior stays unchanged.

AC2: Every outbound user queue entry is fsynced to the Claude delivery ledger before the first corresponding stdin write. A crash after the ledger append and before actuation leaves a safely retryable entry.

AC3: A ledger entry becomes delivered only after its matching replayed user message appears on the Claude stream or in the durable Claude transcript during adoption.

AC4: `ClaudeStreamBrokerHost` conforms to `EngineHost`: `attach(afterSeq)`, `send`, `interrupt`, `answer`, `health`, and `release`. Replay is monotonic and durable for late viewers, regular active-turn sends queue for the following turn, and interruption uses an explicit control request.

AC5: A fresh broker resumes the same Claude session through `--resume <session_id>`. Registry adoption persists the broker process identity, event cursor, CLI version, writer epoch, active turn, and pending attention state.

AC6: Claude children use the local `claude.ai` subscription login. Provider API-key and OAuth-token environment variables never cross into the child process or diagnostic output.

AC7: The real CLI integration test skips cleanly when the Claude binary or subscription login is unavailable and verifies late attach plus restart resume when available.

AC8: No tmux delivery, flow-engine, scanner, or UI source is changed.

## Validation gates

- `bun test`
- `bunx tsc --noEmit`
- ESLint for every changed TypeScript file
- Real local Claude subscription integration when the authenticated CLI is available
