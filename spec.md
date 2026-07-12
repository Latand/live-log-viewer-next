# Issues 31 and 113: deterministic agent reaping and verified tmux kills

## Task statement

Implement deterministic lifecycle cleanup for stale agent conversations and a reliable conversation-kill primitive. Resolve kills through registry-owned tmux pane identities, verify termination of the pane shell and recorded agent processes, apply policy TTLs to eligible automated conversations, protect active or user-managed conversations, schedule cleanup through the durable controller, journal active attempts, and expose a dry-run lifecycle report.

## Acceptance criteria

- AC1: Conversation kills resolve the target from registry-owned pane IDs and return a clear error when the target cannot be resolved.
- AC2: A successful kill carries the original complete tmux evidence through both re-observations and requires exact endpoint, server identity, pane identity, window name, agent identity, argv, and transcript path equality through actuation and post-kill registry cleanup.
- AC3: Reaper classification covers flow workers, headless reviewers, Viewer-launched probes, resume duplicates, and agents whose transcripts are missing, using the policy TTL assigned to each class.
- AC4: Automatic cleanup durably remembers positive human authorship, discounts path-bound Viewer deliveries and known Claude system task notifications, protects unverifiable live transcripts, and allows unknown missing transcripts to age through the explicit dead-transcript TTL.
- AC5: Reaper evaluation runs through the durable controller and journals active reap attempts.
- AC6: `GET /api/lifecycle/reaper` exposes the dry-run report without actuating cleanup.
- AC7: Automatic reap actuation requires `LLV_REAPER_ENABLED=1`.
- AC8: Focused tests cover pane and detached-process kill resolution, process-death verification, classification, protection rules, scheduling, journaling, and the lifecycle API.
- AC9: `bun test` and `bunx tsc --noEmit` pass.
- AC10: Flow cleanup captures and checkpoints the clean commit SHA immediately before reviewer launch, binds merge evidence to that immutable SHA, fails closed for dirty, changed, detached, remote-less, or otherwise unverifiable live checkouts, and preserves verified evidence after checkout deletion.
- AC11: One candidate actuation failure is journaled and leaves later eligible candidates available for the same sweep.
- AC12: Conversation kill acquires the per-session operation lock, refreshes registry host evidence inside the lock, and marks the entry unhosted only when artifact path and complete endpoint/server/pane/window/agent/argv evidence remain unchanged after termination.
- AC13: GitHub merge probes run asynchronously with a per-probe timeout and bounded concurrency so a stalled lookup cannot freeze the Viewer or delay independent flows indefinitely.
- AC14: Merge-probe results update only merge evidence in a freshly loaded flow store and are discarded when the flow transition revision changed during the probe.
- AC15: Reap actuation refreshes scanner lifecycle signals and registry turn state inside the session lock after asynchronous probes, then rejects busy, questioning, waiting, or delivery-revised candidates immediately before actuation.
- AC16: Reviewer verdicts and terminal errors persist a terminal timestamp; legacy errored rounds use their latest durable activity timestamp for the headless-reviewer TTL.
