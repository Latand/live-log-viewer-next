# Issue 117: reliable headless reviewer spawning

## Task statement

Repair headless review rounds started by the flow engine so Codex receives its prompt with a deterministic EOF, reviewer launches avoid exhausted accounts, a configured Claude/Fable reviewer can take over when Codex quota is exhausted, and transient no-verdict exits recover without manual retry-round babysitting.

## Acceptance criteria

- AC1: `codex exec` receives the complete reviewer prompt through stdin and observes EOF after the payload flushes.
- AC2: Headless Codex launches select an authenticated account with fresh session and weekly headroom when one is available.
- AC3: A retry prefers an untried eligible account, then the configured Claude/Fable fallback, before reusing a failed account.
- AC4: Effective reviewer role and account identity are persisted before process launch.
- AC5: PID, session id, and reviewer transcript receipt are persisted immediately after launch.
- AC6: Restart recovery interprets file-backed output with the persisted effective reviewer engine, including Claude fallback attempts.
- AC7: A headless reviewer exit without a verdict triggers one automatic retry inside the logical round.
- AC8: Repeated no-verdict failure parks in `needs_decision` with captured diagnostics.
- AC9: Confirmed exhaustion across primary and fallback reviewer accounts parks with a dedicated rate-limit `stateDetail` that surfaces `resetsAt`.
- AC10: Legacy persisted flows load with compatible defaults for fallback and retry fields.
- AC11: `bun test` and `bunx tsc --noEmit` pass before each review-ready push.
- AC12: Work remains inside this checkout and leaves production services on port 8898 unchanged.
