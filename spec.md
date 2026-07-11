# Task: stop the /api/board 413 storm and the phantom chime cascade

Production viewer (127.0.0.1:8898) showed two linked regressions on a busy
machine (400+ sessions; an account-migration wave left 183 archived
predecessor transcripts with recent mtimes):

1. `PATCH /api/board` failed with 413 in an endless loop. The dashboard's
   `reconcile-roots` mutation for project `-agents-tools-live-log-viewer-next`
   carries all 263 root paths (~37 KB serialized) against the 32 KB
   `MAX_BOARD_BODY_BYTES` cap. The board store treated the non-409 4xx as a
   transient network error and retried the identical payload forever, so every
   `close` mutation queued behind it never persisted (closed cards
   resurrected on reload / other devices).
2. A storm of identical spawn/finish chimes on every 10 s poll. The scan feed
   is capped at the `FILE_CAP = 400` most-recent files; with more sessions
   than that, the tail churns in and out each poll, and `useAgentChimes`
   forgot identities that left the feed — each return rang as a brand-new
   agent. Archived migration predecessors both ate ~half the cap slots and
   duplicated live conversation identities in the feed.

## Acceptance criteria

- AC1: A non-409 4xx response to a board PATCH drops the sent batch instead of
  retrying it: no backoff timer armed, sync returns to "current", and
  mutations queued behind the dropped batch still drain to the server.
- AC2: Semantics-coupled mutations (`reconcile-roots`, `remap-paths`) always
  travel as ONE mutation — never split, so reducer atomicity can never be
  broken by transport. Independent mutations batch into PATCHes bounded by
  the server's 128-mutation cap and a serialized-bytes batching budget. A
  rejected multi-mutation batch is bisected until the offender stands alone;
  only the lone rejected mutation is shed, so valid mutations on either side
  of the poison still land.
- AC3: `MAX_BOARD_BODY_BYTES` is derived from the true worst case of one
  maximal validator-legal mutation under full JSON escaping (two 512-path
  lists of 4096-char control-heavy paths ≈ 25.2 MB → 32 MB cap), so no
  validator-legal mutation is ever size-refused mid-transport; lists past the
  item-level caps draw the server's atomic validation error instead. The
  per-item limits (512 paths, 4096 chars each) remain the real guard.
- AC4: A conversation identity that leaves the capped feed and returns later
  in an unchanged attention state rings no chime; a genuine transition
  (live → waiting, or a truly new finished agent) still rings exactly once.
  The bounded history evicts by observation recency (LRU), so an identity
  that skipped a single poll is never evicted ahead of long-unseen entries.
- AC5: Archived migration predecessors (`migratedTo` set / non-current
  generations) never ring chimes and never clobber the tracked state of their
  successor (same stable conversation identity).
- AC6: The scanner ranks archived transcript generations (every
  generation/continuity path except the conversation's current one, per the
  agent registry) below live transcripts when applying `FILE_CAP`, so a
  migration wave cannot evict live conversations from the feed; with slack
  under the cap they still appear, and selected-project hydration stays
  complete (archived predecessors included) so legacy `#f=` deep links keep
  resolving to their successor.
- AC7: Existing behavior preserved: first-poll chime baseline stays silent,
  spawn blips ring once per child, revision-conflict replay and network-error
  backoff in the board store are unchanged. Full `bun test` suite passes and
  `tsc --noEmit` is clean.
