# Issue #86: Preserve board continuity across account migration

## Task statement

Preserve a conversation's durable board identity, placement, delivery state, and migration history while account migration creates source forks, target copies, successor generations, restarts, and partial repairs. Ensure concurrent processes and recovery scans converge on one stable conversation owner without duplicate board cards.

## Acceptance criteria

- AC1: A committed migration successor inherits the predecessor conversation's durable board placement.
- AC2: Source forks, target copies, and later successor generations converge on one stable conversation owner.
- AC3: Board placement and held deliveries recover after controller restarts and partial migration repairs.
- AC4: Codex fork and copy operations are journaled so recovery can identify artifacts and avoid duplicate cards.
- AC5: Concurrent board mutations are serialized and durably persisted across processes.
- AC6: Migration artifacts appear as archived history in the files read model.
- AC7: Deleted or repaired migration paths retain continuity through durable remapping.
- AC8: Provider operations and repair flows remain idempotent under retries, crashes, and concurrent scans.
- AC9: Existing behavior remains covered by the full test suite.
- AC10: `bun test` passes.
- AC11: `bunx tsc --noEmit` completes without diagnostics.
