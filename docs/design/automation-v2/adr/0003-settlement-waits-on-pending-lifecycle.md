# ADR 0003: Settlement: an ended turn settles a stage only when nothing is pending

- Status: proposed
- Date: 2026-09-02
- Issue: #1446 (point 2), #1441, #1433, #611, #337
- Verified against: commit `d79b463e`

## Context

The stage transcript is the completion authority (#337): a terminal turn whose last assistant message ends in a fenced verdict settles the attempt (`src/lib/pipelines/engine.ts:2162-2169`). A terminal turn without a verdict starts verdict recovery, which re-checks the same evidence at most three times 30 s apart (`engine.ts:908-909`, `1028-1070`) and then parks the pipeline with `completedAt` stamped (`engine.ts:1057-1064`). A parked attempt with `completedAt` reads as turn-settled to the terminal host reaper (`engine.ts:3815`), which stops its host on the next tick (`engine.ts:2963-3056`).

A Claude Code agent that starts a background command ends its turn to wait for it; the harness re-invokes it with a task notification when the command finishes. Between the two the transcript shows exactly a terminal turn (`stop_reason: end_turn`, `src/lib/accounts/migration/turnState.ts:206`) with no verdict. Three attempts were killed this way in 24 hours (#1441), and the settlement rule is also what turns a transient provider error at the end of a turn into a failed attempt, and a spawn-time lock contention into a parked pipeline (#1433, `engine.ts:2057`).

In the two weeks to 2026-09-02, "verdict recovery exhausted" was the largest attempt error class in the state store (39 attempts whose completed turn was missing or had an invalid verdict, 25 more whose transcript was not yet readable).

## Options

1. **Keep the rule and lengthen the budget.** More checks, longer intervals. Blind: a bench that takes 40 minutes still dies, and a genuinely finished agent without a verdict waits the whole window every time.
2. **Teach agents never to end a turn with a background task.** Already in every stage prompt and in the orchestrator's memory. It reduces the incidents and cannot remove them: the harness's own tooling invites the pattern, and every new agent learns it again.
3. **Make settlement lifecycle-aware.** Define pending signals the engine can read from evidence it already has, and settle a terminal turn only when none is pending, each bounded by a ceiling.

## Decision

Option 3. **A terminal turn settles an attempt only when nothing is pending for it.** In order:

1. A terminal turn ending in a valid fenced verdict settles immediately. A verdict outranks every pending signal; the agent declared completion and a still-running background job is its own leftover, reaped with the host.
2. Otherwise the attempt is `waiting` and no recovery check is spent while one of these holds:
   - **background task**: the transcript's stable tail carries the harness's background-task start (a tool result announcing a task id) with no later completion notification for that id. The notification record is already classified by the session reader (`src/lib/session/reader.ts:124-130`); the start-record parser is new and lives beside the turn evidence (`src/lib/pipelines/durableEvidence.ts`). Ceiling 30 minutes, configurable. Codex has no such record; its turn stays open while tools run (`turnState.ts:144-155`), so the predicate is false there.
   - **provider throttle**: the turn ended on a retryable provider notice; a usage limit is the next case. Wait until the stated reset or a bounded recheck (#611 shape), then deliver one continuation into the same conversation; a dead host means a fresh attempt from the worktree.
   - **account limit**: the existing failover (`engine.ts:1111-1174`), now visible as a wait with its reset.
   - **account lock** and **host rebinding**: spawn-time transients, classified by error type, both booking the existing wall-clock wait (`engine.ts:2865-2887`) inside the same attempt. The spawn path takes the async lock (`src/lib/accounts/accountMutation.ts:65-69`, `289-299`) so it queues and never throws.
3. When nothing is pending, verdict recovery runs as today and shows as `waiting.kind = "verdict-recovery"`.
4. A ceiling that lapses parks the attempt naming what it waited for. Only then is `completedAt` stamped, so the reaper never stops a host an attempt is still waiting on.

`waiting` is one field on the attempt, read by the board, `list_pipelines` and the orchestrator; `controllerWait` and `verdictRecovery` stay as its bookkeeping.

## Consequences

- An agent that genuinely finished without a verdict while a background job is still running is settled at the ceiling, where today it is settled after 90 seconds. That is the trade: up to 30 minutes of an idle host against a killed working agent. The state store says which of the two happens more often.
- Settlement gains one evidence parser per engine for the background-task records. Claude has one now; Codex needs none; a third engine (#1207) adds its own or reports false.
- The reaper and the close path must honour `waiting`: a waiting attempt is live work, never a settled turn. This is the same line the reaper already draws for a host the runtime reports mid-turn (`engine.ts:3015-3021`). The line is drawn once: an attempt is either `waiting` (no verdict, no `completedAt`, host kept) or settled (a verdict, `needs_decision` included, or a lapsed ceiling with `completedAt` stamped), and a settled attempt's host is reaped on the next sweep exactly as today (`engine.ts:2969`, `3815`). No hold exists for a parked attempt: an operator answer spawns a fresh attempt from the worktree (README §3.6), and continuation into a live conversation exists only for the throttle case above, where the attempt is still `waiting`.
- The continuation delivery reuses the structured relay the flow engine makes today (`src/lib/flows/engine.ts:381`) and inherits its idempotent identity and journal-settled delivery (#1065). Nothing new is invented for it.
- Hard to reverse: once agents and the orchestrator rely on ending a turn to wait for their own tasks, going back to "first ended turn settles" reintroduces #1441 at once. The kill switch in slice 2 exists for one release, to recover from a parser defect; it is no mode.
