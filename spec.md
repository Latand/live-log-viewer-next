# Issue #1005: Orchestrator context policy registry alignment

## Task statement

Derive Claude orchestrator context-window policy from the scanner model registry through `normalizeModelKey` and `registryWindow`. Keep the 50% rotation threshold and an operator-readable policy audit name. Models without a registry entry must retain an unknown threshold.

## Acceptance criteria

AC1: `fable-5` resolves to a 1,000,000-token window, and 129,000 reported tokens render as 13% with no rotation recommendation.

AC2: `sonnet-5` resolves to a 1,000,000-token window.

AC3: the persisted `opus` launch alias resolves through the current Opus registry entry and retains a 1,000,000-token window, a 500,000-token rotation threshold, and its established audit label.

AC4: `haiku-4-5` resolves to a 200,000-token window and a 100,000-token rotation threshold.

AC5: a model absent from the registry resolves to a null policy, and callers report that its threshold is unknown.

AC6: the policy audit name identifies the normalized registry key and resolved window so rotation banner wording remains meaningful.

AC7: `ROTATION_THRESHOLD_FRACTION` remains `0.5`.

AC8: the focused orchestrator health tests and TypeScript compilation pass.

## Validation gates

- `bun test src/lib/orchestrator/health.test.ts`
- `bunx tsc --noEmit`
- `git diff --check`
- `bun scripts/privacy-publication-gate.ts --base <captured-base>`
