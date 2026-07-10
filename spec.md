# Issue #98: Flaky account-migration GET purity test

## Task

Diagnose and remove the cross-test state pollution that intermittently causes `src/app/api/account-migration-get-purity.test.ts` to fail during the full Bun test suite. Preserve the conditional GET and durable-byte purity guarantees with hermetic test inputs and correctly isolated workflow-store state.

## Acceptance criteria

- AC1: The pollution has a deterministic regression test that fails when workflow state paths remain bound to an earlier `LLV_STATE_DIR`.
- AC2: Workflow persistence resolves its state directory at operation time and follows an environment change made after module import.
- AC3: Workflow-store tests restore the captured environment value and remove only their owned sandbox.
- AC4: The account-migration GET-purity test uses stable transcript-scan input while exercising the production response implementation.
- AC5: A matching conditional request returns HTTP 304 and leaves durable state bytes unchanged.
- AC6: The targeted regression tests pass.
- AC7: At least three consecutive full `bun test` runs pass.
- AC8: `bunx tsc --noEmit` passes.
