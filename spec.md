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
- AC2: The board store never sends more mutations in one PATCH than the
  server's per-request validation cap (128); an oversized outbox drains across
  consecutive requests and fully lands.
- AC3: `MAX_BOARD_BODY_BYTES` admits a realistic large root reconciliation
  (hundreds of roots × ~120-char paths); the per-item limits (512 paths,
  4096 chars each) remain enforced.
- AC4: A conversation identity that leaves the capped feed and returns later
  in an unchanged attention state rings no chime; a genuine transition
  (live → waiting, or a truly new finished agent) still rings exactly once.
- AC5: Archived migration predecessors (`migratedTo` set / non-current
  generations) never ring chimes and never clobber the tracked state of their
  successor (same stable conversation identity).
- AC6: The scanner ranks archived transcript generations (every
  generation/continuity path except the conversation's current one, per the
  agent registry) below live transcripts when applying `FILE_CAP`, so a
  migration wave cannot evict live conversations from the feed; with slack
  under the cap they still appear.
- AC7: Existing behavior preserved: first-poll chime baseline stays silent,
  spawn blips ring once per child, revision-conflict replay and network-error
  backoff in the board store are unchanged. Full `bun test` suite passes and
  `tsc --noEmit` is clean.
