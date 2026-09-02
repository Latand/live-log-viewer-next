# ADR 0001: One automation record: extend the pipeline record, retire flows and workflows

- Status: proposed
- Date: 2026-09-02
- Issue: #1446 (design), #340 (standing directive), #931 (seed items 2 to 4)
- Verified against: commit `d79b463e`

## Context

Three engines describe one activity, "run a list of agents as a unit and review the result": `src/lib/pipelines` (stage graph, 4,556 lines in the engine), `src/lib/flows` (implementer plus fresh reviewer per round, 1,451 lines plus a 674-line headless executor) and `src/lib/workflows` (an earlier implement-then-review-loop engine whose UI has been fenced since #136). A pipeline `review-loop` stage embeds a flow, so a review inside a pipeline is described by two state machines at once: the flow's twelve states (`src/lib/flows/types.ts:17-29`) and the attempt's `reviewing` state plus a projection (`src/lib/pipelines/engine.ts:1514-1574`) and a reconciler that translates terminal flow states into verdicts (`engine.ts:2667-2726`). The #925 wedge cited by #931 was exactly a state one engine knew and the other did not.

Usage read from the state store on 2026-09-02 for records created since 2026-08-19: 715 run stages, 3 review-loop stages, 275 of 293 pipelines with a fail edge, no standalone flow since 2026-08-25, one workflow record with an epoch timestamp. The orchestrator builds every review loop as a reviewer run stage with a fail edge to a fixer stage.

The operator asked for "одна унифицированная штука" that agents can change first and the UI second (#1446), and, on 2026-07-17, for "one UI entry point, one API surface, one state store" (#340).

## Options

1. **Adapters.** Keep three records and three engines; put one `automation_action` facade in front that dispatches to whichever record a caller names. One API surface on paper, three state machines in fact. Every settlement, pause, retry and attribution rule stays triplicated, and the drift #931 documents continues. Cheapest to ship, changes nothing the operator complained about.
2. **A fourth record.** Define a new `Automation` type with its own store and engine, migrate pipelines, flows and workflows into it, delete all three. Cleanest on paper. In practice it re-implements the 226 engine tests' worth of pipeline behaviour (provisioning, publication, fail-edge budgets, adoption, host teardown, account pools) under a new name before any mutability lands, and the migration touches every board projection at once.
3. **Extend the pipeline record and retire the others.** The pipeline record already is a stage graph in one worktree with attempts, verdicts, publication and decisions. Add the mutation log, revision, checkpoints and per-attempt definition snapshots to it; express the review loop as a reviewer run stage with a fail edge, which is what 275 of 293 records already do; delete the flow and workflow engines after in-flight review-loop attempts settle.

## Decision

Option 3. The pipeline record is the automation record. Its name stays in code and in the tools (`create_pipeline`, `pipeline_action`, `get_pipeline`, `list_pipelines`); the concept is called an automation in prose only.

The `review-loop` stage kind, the embedded flow, the headless reviewer process and the flow record retire. The one flow mechanism that survives is the structured relay into an existing conversation (`src/lib/flows/engine.ts:381`), lifted into the pipeline engine as attempt continuation for provider-throttle resumes (README §3.6). Operator answers spawn a fresh attempt from the worktree: a parked attempt's host is reaped, so there is no conversation to continue.

## Consequences

- One state machine, one settlement rule, one mutation log, one store collection. Issue #340's acceptance is met by deletion; no facade remains.
- About 3,500 lines of engine and executor code and their tests are deleted, including the flow's round-level relay retries, launch leases and reviewer PID tracking. Nothing that survives depends on them: every pipeline reviewer is a structured conversation with the same spawn, liveness and teardown path as a builder.
- Headless one-shot reviewers (`codex exec`, `claude -p`) are gone. They were cheaper per round; the last two weeks ran 297 reviewer stages without them. If the cost matters later, a host kind on the run stage is the shape.
- Fresh reviewer per round stays; fresh fixer per round becomes the only fixer mode (#1073). Continuing a standing fixer conversation across rounds is deferred and, if wanted, is an option on the fail edge using the continuation primitive.
- Migrated records keep `flowId` and `reviewFlowSync` as frozen history; the `flows` collection becomes an archive nothing reads. Round artifacts stay on disk.
- Reversal cost is high once slice 9b lands: the flow engine would have to be rewritten. Slices 1 to 8 are reversible on their own, and 9a (refuse creation) is the last cheap point to stop.

## Rejected because

Option 1 keeps every incident mechanism in the list at `README.md` §1.6 alive and adds a dispatch layer on top. Option 2 spends the first several slices reproducing behaviour that already has 226 tests pinning it, before the first mutation the operator asked for exists.
