# PR #152: EngineHost interface and CodexAppServerHost

## Task statement

Implement issue #149 from the issue #25 runtime spike: define the shared structured-host contract, add the Codex app-server adapter on ChatGPT subscription authentication, persist its mutable host state beside the durable engine thread identity, and support restart adoption through `thread/resume`.

## Acceptance criteria

- AC1: `EngineHost` exposes `attach(afterSeq)`, `send`, `interrupt`, `answer`, `health`, and `release` with the spike contract semantics.
- AC2: `CodexAppServerHost` maps the contract to app-server JSON-RPC over stdio and uses the Codex thread ID as durable session identity.
- AC3: Structured hosting activates only when `LLV_STRUCTURED_HOSTS=1`; the default state remains disabled.
- AC4: Existing tmux delivery paths, flow engines, and UI remain unchanged.
- AC5: Registry state persists host kind, endpoint, PID plus process-start identity, event cursor, protocol version, writer-claim epoch, active turn reference, and pending attention.
- AC6: Viewer restart adoption resumes every eligible Codex registry row through `thread/resume`.
- AC7: Delivery maps queue entry IDs to `clientUserMessageId`, active turns use `expectedTurnId`, interruption stays explicit, and structured attention can be answered.
- AC8: The real Codex CLI integration starts a thread, attaches a late client, steers the active turn, restarts the host process, and resumes the same thread on the ChatGPT subscription.
- AC9: The real integration skips gracefully when the Codex CLI is unavailable.
- AC10: API keys and authentication tokens never cross into the child environment or diagnostic output.
- AC11: `bun test`, touched-file ESLint, and `bunx tsc --noEmit` pass.
- AC12: A fresh independent review reaches a clean APPROVE verdict.
