# Issue #60 — durable board closes

## Task statement

Fix closed scheme cards resurfacing after reload. The server must preserve close
tombstones across concurrent board writers and carry them across transcript
succession paths, including clients that retry a stale whole-list `hidden` patch
or omit a `remap-paths` mutation.

## Acceptance criteria

- AC1: A legacy whole-list board PATCH retried with a current revision cannot
  erase hidden entries committed by another writer.
- AC2: Legacy board PATCH requests remain schema-compatible, and revision-zero
  preference seeding continues to work.
- AC3: Hidden tombstones take precedence over stale manual and expanded
  membership supplied by whole-list clients.
- AC4: Server-side board mutations derive aliases from durable conversation
  generations and continuity paths.
- AC5: A closed predecessor remains hidden when its successor appears and root
  reconciliation arrives without a client-provided remap.
- AC6: Root reconciliation preserves hidden entries when conversation identity
  remains stable.
- AC7: Regression tests reproduce the concurrent stale-list retry and the
  successor-without-remap scenarios through the board route.
- AC8: A malformed or unreadable conversation registry leaves validated board
  mutations available and skips alias enrichment for that request.
- AC9: Pending continuity paths cannot create aliases from a future successor
  back to the current predecessor during initial or repeated migrations;
  committed continuity paths keep carrying tombstones during later migrations.
- AC10: Scanner discovery, observed spawn settlement, provider persistence, and
  explicit continuity callbacks all record pending succession provenance.
- AC11: Return-to-source routing and target retirement preserve an abandoned
  successor fence after clearing the active migration.
- AC12: A table-driven route regression covers commit, return-to-source,
  target retirement, chained succession, deferred board repair, and queued
  cleanup receipts across close-before/during/after timing and alias
  enrichment, root reconciliation, and client remap mutations.
- AC13: Fenced successor paths can trigger committed alias repair while
  remaining ineligible for root reconciliation and client remaps.
- AC14: `bun test` passes.
- AC15: `bunx tsc --noEmit` passes.
- AC16: The live board state and production Viewer on port 8898 remain
  unchanged during implementation and verification.
