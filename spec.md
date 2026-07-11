# Issue #86 follow-up: Harden migration successor recovery

## Task statement

Harden recovery after partial successor creation. Definite Codex fork failures must remain retryable, uncertain transport and protocol outcomes must retain ambiguity, and Claude tmux cleanup must distinguish an absent original host from an endpoint or process identity whose state cannot be verified.

## Acceptance criteria

- AC1: A definite pre-dispatch or server-rejected Codex fork failure clears the pending request marker and retries the fork on the next attempt.
- AC2: A Codex fork failure with an uncertain transport or protocol outcome preserves the pending request marker and blocks duplicate dispatch until artifact recovery resolves it.
- AC3: Malformed post-dispatch app-server frames and successful fork payloads with missing required fields are classified as unknown outcomes.
- AC4: Claude cleanup treats explicit missing-pane evidence, a replaced pane identity, or a restarted original tmux server as completed cleanup.
- AC5: Claude cleanup remains pending when its tmux endpoint or pane query fails without explicit absence evidence.
- AC6: Claude cleanup remains pending when a required persisted server or pane process identity cannot be observed.
- AC7: `bun test` passes.
- AC8: `bunx tsc --noEmit` completes without diagnostics.
