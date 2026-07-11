# Issues 31 and 113: deterministic agent reaping and verified tmux kills

## Task statement

Implement deterministic lifecycle cleanup for stale agent conversations and a reliable conversation-kill primitive. Resolve kills through registry-owned tmux pane identities, verify termination of the pane shell and recorded agent processes, apply policy TTLs to eligible automated conversations, protect active or user-managed conversations, schedule cleanup through the durable controller, journal active attempts, and expose a dry-run lifecycle report.

## Acceptance criteria

- AC1: Conversation kills resolve the target from registry-owned pane IDs and return a clear error when the target cannot be resolved.
- AC2: A successful kill verifies termination of the tmux pane shell and every recorded agent-process identity.
- AC3: Reaper classification covers flow workers, headless reviewers, probes, resume duplicates, and agents whose transcripts are missing, using the policy TTL assigned to each class.
- AC4: Automatic cleanup protects user-authored conversations, agents in the middle of a turn, and conversations manually placed on the board.
- AC5: Reaper evaluation runs through the durable controller and journals active reap attempts.
- AC6: `GET /api/lifecycle/reaper` exposes the dry-run report without actuating cleanup.
- AC7: Automatic reap actuation requires `LLV_REAPER_ENABLED=1`.
- AC8: Focused tests cover kill resolution, process-death verification, classification, protection rules, scheduling, journaling, and the lifecycle API.
- AC9: `bun test` and `bunx tsc --noEmit` pass.
