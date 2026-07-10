# Issue #97: Rate-limit visibility and blocked flows

## Task statement

Detect current per-conversation engine usage limits, combine pane and structured account-limit evidence, and expose the blocked state in the viewer so operators can see why a conversation or attached flow cannot progress. Preserve ready composers containing historical quota text and keep successor spawning, flow rebinding, and migration-lineage handling outside this PR.

## Acceptance criteria

- AC1: A current usage-limit banner in a live conversation pane marks that conversation as rate-limited and captures a reliable reset time when one can be parsed.
- AC2: Historical quota prose in a ready composer does not mark the conversation as rate-limited.
- AC3: Fresh structured account exhaustion is joined to live conversations using stable account identity, including when automatic account balancing is disabled.
- AC4: Rate-limited conversations expose a visible badge and attention state; exact reset copy is omitted when the exhausted window has no reliable timestamp.
- AC5: An attached implementer flow projects the rate-limited conversation as `blocked: rate-limited` instead of remaining silently in `waiting_ready`.
- AC6: A rate-limited flow does not offer the waiting-state transition action while its implementer is blocked.
- AC7: Conversation and exhausted-account identifiers remain available as stable seams for a later continue-on-account successor workflow.
- AC8: Rate-limit evidence refreshes with live state and clears when the active signal is no longer present or fresh.
- AC9: Existing automated tests pass with `bun test`, and the project type-checks with `bunx tsc --noEmit`.
