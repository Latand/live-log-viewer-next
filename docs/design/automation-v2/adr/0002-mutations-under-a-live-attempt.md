# ADR 0002: Mutations under a live attempt: accept, record, apply to the next attempt, restart only on request

- Status: proposed
- Date: 2026-09-02
- Issue: #1446, #452, #118 (the original override design), #353 (frozen edges)
- Verified against: commit `d79b463e`

## Context

Today a stage definition can change only before its first attempt: `override-stage` refuses a stage with any attempt, including a failed spawn (`src/lib/pipelines/engine.ts:4289`); `add-stage`, `remove-stage` and `reorder-stage` refuse a started record (`engine.ts:4017`, `4040`, `4065`); `set-edge` freezes a ran stage's pass edge and a traversed fail edge as "frozen evidence" (`engine.ts:4103`, `4114-4117`). The reasoning recorded on `override-stage` was sound for what it protected: an attempt clones the stage's `effectiveRole` when it is created (`engine.ts:1283`) but renders its prompt from the live stage at spawn (`engine.ts:1955-1960`), so an edit between creation and spawn would land silently, and an edit after spawn would look accepted and change nothing.

The operator's requirement is the opposite of a freeze: a running automation must be changeable, by agents first, and "a running attempt is never silently changed under it" (#1446, point 1). #452 shows the cost of the freeze: a review prompt over the note cap could never be shortened because the stage had a failed attempt, and four pipelines were unrecoverable in one day.

## Options

1. **Refuse** (today). Safe and useless: every change after start means a new record.
2. **Hot-apply.** Change the running attempt in place. Impossible for the prompt (delivered), the engine and the account (the host exists), and the access policy (enforced at settlement against work already done). The only honest hot change is stopping the attempt.
3. **Accept and defer, restart on request.** Every attempt snapshots the definition it runs (revision and prompt digest) when it is created. An edit to a stage whose attempt is running is validated, applied to the stage, appended to the mutation log with `effect: "pending-next-attempt"` and the attempt number it will first apply to, and the response says so. A caller who wants it now passes `restart: true`; the running attempt is stopped through the identity-fenced stop path (`engine.ts:614`), and attempt n+1 starts from the current worktree under the new definition, recorded as `effect: "restarted-attempt"`.

## Decision

Option 3, with three rules that are not separable from it:

1. **Attempts own their definition.** An attempt renders its prompt when it is created and stores `definition: { revision, promptDigest }`; nothing about a running attempt is read from the live stage afterwards. This is what makes "silently changed under it" impossible, with no rule left to enforce.
2. **Definition edits are revision-fenced.** `edit-stage`, `add-stage`, `remove-stage`, `reorder-stage` and `set-edge` require `expectedRevision`. A mismatch is refused with the current revision and the mutations since the caller's revision. Lifecycle actions (`pause`, `resume`, `rerun-stage`, `checkpoint`, `note`, `answer`, `skip-stage`, `close`) accept it optionally. The flow store's revision counter (`src/lib/flows/store.ts:514-525`) is the precedent; the pipeline record gets the same counter bumped on every accepted mutation.
3. **Edges and budgets are definitions, activations are evidence.** The activation record on an attempt (`activatedBy`, `src/lib/pipelines/types.ts:120-123`) never changes; the derived round budget (`engine.ts:1684-1689`) keeps counting it. The edge itself may be retargeted or re-budgeted at any time and applies at the next verdict. This changes the "frozen evidence" rule from #353 and keeps its evidence.

A `remove-stage` on a stage with attempts is refused; the stage is routed around with `set-edge`. A `reorder-stage` moves only stages without attempts.

## Consequences

- Two revisions of a stage can be live at once: the running attempt's and the stage's. The record shows both (`definitionRevision` on the stage, `definition.revision` on the attempt) and the mutation log names the attempt the edit applies from, so the board and an agent reading `get_pipeline` see a pending edit as a recorded fact.
- Every mutation response carries `{ revision, mutation: { seq, effect, appliesFromAttempt } }`. An agent that edits and then wonders why nothing changed has the answer in the same reply.
- `restart: true` kills a working agent. It is explicit, attributed and logged; nothing restarts implicitly.
- The revision fence adds one read before every definition edit. The orchestrator already reads `get_pipeline` before acting; the cost is the fence working as intended when two seats race.
- The rule is hard to reverse because it defines what a stage definition and an attempt are on disk: once attempts carry their own definition, a future engine that reads the live stage for a running attempt would reintroduce the silent change this rule removes.
