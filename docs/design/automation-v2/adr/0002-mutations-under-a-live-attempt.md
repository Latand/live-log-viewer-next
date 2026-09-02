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
3. **Accept and defer, restart on request.** Every attempt binds the definition it runs (revision, prompt template, outputs, sandbox, account, effective role, pending notes) in the transaction that moves it from `pending` to `spawning`, the instant before its first spawn call. An edit to a stage whose attempt is bound is validated, applied to the stage, appended to the mutation log with `effect: "pending-next-attempt"` and the attempt number it will first apply to, and the response says so. A caller who wants it now passes `restart: true`; the running attempt is stopped through the identity-fenced stop path (`engine.ts:614`), and attempt n+1 starts from the current worktree under the new definition, recorded as `effect: "restarted-attempt"`.

## Decision

Option 3, with three rules that are not separable from it:

1. **Attempts own their definition from the spawning transition.** An attempt binds `definition` (revision, prompt template, outputs, sandbox, account) and re-clones its effective role when it leaves `pending` (`engine.ts:1945-1949`), and renders its prompt from those fields on the first spawn and on every handshake retry; nothing about a bound attempt is read from the live stage afterwards, including an attempt a controller wait bounced back to `pending` (`engine.ts:2040`). An unbound attempt takes the stage as it is when it binds, and a mutation accepted while one exists names it in `appliesFromAttempt` (README §3.2). This is what makes "silently changed under it" impossible, with no rule left to enforce.
2. **Definition edits and every action that creates or stops an attempt are revision-fenced.** `edit-stage` (with or without `restart`), `add-stage`, `remove-stage`, `reorder-stage`, `set-edge`, `rerun-stage`, `answer`, `skip-stage` and `checkpoint` require `expectedRevision`. A mismatch is refused with the current revision and the mutations since the caller's revision. Only `pause`, `resume`, `note`, `close` and the bookkeeping actions accept it optionally. Inside the transaction, after the fence, an action that would create an attempt or commit the worktree is refused while any attempt on any stage is unsettled (`pending`, `spawning`, `running`, `reviewing`, `committing`, or `waiting` set), naming that attempt; a running attempt is stopped only by `edit-stage { restart: true }`, never as a side effect of another action. Each such action creates the `pending` attempt record in the transaction that moves the cursor, where today the tick creates it afterwards (`engine.ts:1875-1876`, `4254`), so the predicate always has a record to read. The fence is what makes the predicate sufficient: creating attempt n+1 bumps the revision in the same transaction, so a second seat on a stale read is refused by the fence and a second seat on a fresh read is refused by the predicate. Two seats racing yield one attempt and one worktree owner (README §3.3). The flow store's revision counter (`src/lib/flows/store.ts:514-525`) is the precedent; the pipeline record gets the same counter bumped on every accepted mutation.
3. **Edges and budgets are definitions, activations are evidence.** The activation record on an attempt (`activatedBy`, `src/lib/pipelines/types.ts:120-123`) never changes; the derived round budget (`engine.ts:1684-1689`) keeps counting it. The edge itself may be retargeted or re-budgeted at any time and applies at the next verdict. This changes the "frozen evidence" rule from #353 and keeps its evidence.

A `remove-stage` on a stage with attempts is refused; the stage is routed around with `set-edge`. A `reorder-stage` moves only stages without attempts.

## Consequences

- Two revisions of a stage can be live at once: the running attempt's and the stage's. The record shows both (`definitionRevision` on the stage, `definition.revision` on the attempt) and the mutation log names the attempt the edit applies from, so the board and an agent reading `get_pipeline` see a pending edit as a recorded fact.
- Every mutation response carries `{ revision, mutation: { seq, effect, appliesFromAttempt } }`. An agent that edits and then wonders why nothing changed has the answer in the same reply. `appliesFromAttempt` is decided at accept time by the one binding rule, so the spawn-wait window (an attempt booked into a controller or account-lock wait before it bound) is covered by the same rule and never reads as unknown.
- `restart: true` kills a working agent. It is explicit, attributed and logged; nothing restarts implicitly.
- The revision fence adds one read before every definition edit and before every re-run, answer, skip or checkpoint. The orchestrator already reads `get_pipeline` before acting; the cost is the fence working as intended when two seats race.
- Each attempt carries its stage prompt template (at most `MAX_STAGE_PROMPT_LENGTH`, 8,000 characters) beside the role scaffold it already clones today (`engine.ts:1283`). A digest in its place was rejected: a handshake retry has to re-render the same text.
- The rule is hard to reverse because it defines what a stage definition and an attempt are on disk: once attempts carry their own definition, a future engine that reads the live stage for a bound attempt would reintroduce the silent change this rule removes.
