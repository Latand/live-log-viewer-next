# Issue #151: Route the delivery queue through structured hosts

Persist structured-session composer messages in the runtime journal before actuation and deliver them through `EngineHost.send`.

## Acceptance criteria

AC1: Structured Codex and Claude messages enter the durable runtime journal before engine actuation.

AC2: Each conversation drains in FIFO order while independent conversations can progress concurrently.

AC3: Codex delivery uses the queue entry ID as its client message ID and preserves idle and active turn fences across races and retries.

AC4: Claude delivery uses its durable replay ledger so recovery cannot duplicate engine writes.

AC5: Migration-held structured messages drain through the runtime journal and remain fenced until durable structured completion.

AC6: Explicit `tmux-legacy` sessions retain the existing tmux delivery path.

AC7: Queued, delivering, delivered, and failed receipt states remain observable and recoverable after process loss.

## Validation gates

- `bunx tsc --noEmit`
- `bun test`
- `git diff --check`
