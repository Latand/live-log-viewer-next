# Issue #1006: Recover conversations owned by dead stage hosts

Restore messaging for a pipeline-stage Codex conversation after its structured host exits without releasing ownership. Reconcile ownership only when the recorded host process is provably gone, then let the existing send and resume path claim a fresh viewer-owned structured host and deliver the queued message.

## Acceptance criteria

AC1: Send admission detects a stale structured-host claim whose recorded process identity is provably dead and releases that claim before recovery.

AC2: A send to a completed pipeline-stage conversation with a dead host proceeds through a fresh structured-host claim and reaches the delivery queue.

AC3: Startup reconciliation releases stale dead-host ownership for terminal or superseded structured conversations.

AC4: Periodic runtime reconciliation releases the same stale ownership when the viewer remains running after the stage host disappears.

AC5: Live owners and unverifiable process identities remain fenced from takeover.

AC6: Recovery uses the existing structured send and resume path without adding a new UI surface or changing explicit legacy delivery.

AC7: Runtime-state tests use isolated temporary state and cover stage completion, unclean host loss, retained ownership, fresh claiming, and successful message enqueueing.

AC8: Focused tests, TypeScript type checking, scoped linting, diff checks, and publication privacy checks pass.

## Validation gates

- `bun test src/lib/runtime/structuredMessageDelivery.test.ts src/lib/runtime/startup.test.ts src/lib/reaperRuntime.test.ts src/lib/runtime/structuredRecovery.test.ts`
- `LLV_AGENT_REGISTRY_SQLITE=sqlite bun test src/lib/runtime/structuredMessageDelivery.test.ts src/lib/runtime/startup.test.ts src/lib/reaperRuntime.test.ts src/lib/runtime/structuredRecovery.test.ts`
- `bunx tsc --noEmit`
- Scoped ESLint over changed TypeScript files
- `git diff --check`
- `bun scripts/privacy-publication-gate.ts --base origin/main`
- `bun run privacy:check`
