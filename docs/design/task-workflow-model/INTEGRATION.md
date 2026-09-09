# Production integration and ownership

Pinned source: `88e5a9508be2802266734056d6436f3168201cad`. Paths below are existing files unless explicitly marked proposed. Research owns only this design directory. The next build stage owns the frontend manifest; root retains deployment authority. Recheck the manifest at build HEAD before edits.

| Owner / order | Existing seam | Concrete change and evidence |
| --- | --- | --- |
| Board builder, 1 | `src/components/scheme/pipelineAnchor.ts:74`, `src/components/tasks/taskRelations.ts:26`, `src/components/pipelines/pipelineModel.ts`, `src/components/flows/flowModel.ts` | Add a pure task projection under `src/components/tasks/taskWorkflowModel.ts` (proposed). Read explicit taskIds, assignments, stage attempts and review bindings; retain relation provenance. Keep missing data and unlinked executions visible. Reuse durable conversation resolution, including pathless launch references. |
| Board builder, 2 | `src/components/scheme/SchemeBoard.tsx:196`, `src/components/scheme/TaskCard.tsx`, `src/components/scheme/TasksLayer.tsx`, `src/components/tasks/` | Render task summary/history and a complete windowed worker list. Integrate native target navigation, stage placeholders, unlinked executions and shared references. Do not hide old failed/review attempts when a successor starts. |
| Board builder, 3 | `src/components/scheme/layout.ts`, `src/components/scheme/pipelineAnchor.ts`, `src/components/scheme/agentLinks.ts:275`, `src/components/scheme/taskPlacement.ts`, `src/components/scheme/TaskEdgesLayer.tsx`, `src/components/scheme/focusFrames.ts` | Make expanded footprint, envelope, collision, ports and focus share final rectangles. Reuse current geometry; add only necessary measurement/index helpers. Protect accepted pins, including aggregate zoom. Resolve infeasible expansion with the existing full-window owner. |
| Board builder, 4 | `src/components/scheme/nodes.tsx`, `src/components/scheme/SchemeBoard.tsx`, `src/components/BranchPane.tsx:94`, `src/components/LogFeed.tsx:219` | Separate cheap camera/eligibility work from stable native owners. Gate hidden wrapper, summary, header and feed work. Existing paused feeds are a useful starting point; the header's age updates need equal scrutiny. |
| Board builder, 4 | `src/hooks/useLogTail.ts:224`, `src/hooks/logBus.ts`, `src/hooks/useRuntime.ts:40`, `src/hooks/runtimeBus.ts`, `src/components/TmuxComposer.tsx:1545`, `src/components/paneState.ts` | Suspend view-local subscriptions/timers with viewport eligibility. Keep durable transport/outbox owners independent. Preserve draft, selection, follow state, scroll anchor and original-key reconciliation on reentry. Hook changes require focused production-hook tests. |
| Board builder, 5 | `src/hooks/useBoardState.ts`, `src/hooks/useBoardActionHistory.ts`, `src/components/projectBoardMutations.ts`, `src/components/ProjectDashboard.tsx` | Use existing revision-aware board persistence and Return/navigation. Distinguish accepted pin from optimistic preview. Keep project switching and lookup by durable target identity. |
| Board builder, 5 | Existing locale files for the affected board translation keys | Use the established vocabulary shared with mobile; update the affected translation set consistently. No runtime implementation details in operator labels. |
| Independent reviewer | The builder's exact HEAD, manifest and focused tests | Reproduce both measured failures on the retained prototype; verify their closure on the integrated source. Review originating requirement, production evidence and over-built machinery. A green static specimen cannot approve production integration. |
| Automation/API owner, external dependency | `src/lib/tasks/types.ts:78`, `src/lib/pipelines/types.ts:138`, `src/lib/flows/types.ts`, `src/lib/workflows/types.ts`, `src/lib/mcp/bindings.ts`, `src/lib/pipelines/engine.ts` | Own durable typed successor/review/PR links and unified mutation APIs. Preserve existing records; add revision-fenced relation fields through #1446. Frontend uses read-only known relations meanwhile. No edits here by board owner. |
| Runtime/deployment owner, external dependency | `src/lib/runtime/contracts.ts`, `src/lib/runtime/deploymentLedger.ts`, `src/app/api/runtime/deployments/`, `src/runtime-host/` | Supply authoritative deployment identity, phase, revision and continuity evidence. Board consumes their existing read surface. Root alone submits deploy_exact_sha. |

`PipelineAttempt.reviewHeadSha` and `expectedReviewHeadSha` exist, but the recovered ordinary run-stage reviews often have null fields. Their historical SHA is in the recorded reviewer output. Render “Revision unrecorded” when the structured field is missing unless a separately verified evidence link is available. Do not parse arbitrary verdict prose into authority in the UI.

## Existing contracts that constrain the design

At this pin, `engine.ts:4219` allows add-stage only on draft pipelines. `:4487` allows overrides only for a target stage without attempts; other stages may already be running. `:4289` permits some future edge changes in running or parked pipelines but freezes executed evidence. The old statement “nothing can change after start” is too broad for current source. Retry paths at `:4451` and `:4479` call resetPipelineStage; the board must never implement “continue in place” by disguising that destructive retry. The automation owner owns a preservation-safe continuation API.

`linkedPipelineTasks` currently includes source/assignment lineage as well as explicit taskIds. The new projection must not strengthen a heuristic relation into a durable ownership claim. A shared manager/source conversation is evidence of creation context. Explicit task membership and direct stage-worker assignment are stronger. Surface provenance in details and expose unlinked work.

`taskRelationsByPath` intentionally omits done tasks and absent transcript paths from current pane controls. A task-history surface needs its own full-history projection, with an explicit unavailable target, so completed tasks and historical attempts remain inspectable without advertising a broken open action.

`workflows/types.ts` is an older workflow engine; it is not the proposed unified schema. Read `docs/design/automation-v2/README.md` for migration ownership and contracts before asking its owner for changes. This lane adopts a frontend view over existing sources, without forking that design.

## Typed view model (proposed, frontend only)

Use a task key plus sections of references. Each reference carries its kind, source identity, relation basis and availability. The execution key is pipeline id; stage key is `(pipeline, stage)`; attempt key is `(pipeline, stage, n)`; review key is `(flow, round, reviewer binding)` or the run-attempt key. Conversation id resolves its latest generation. PR identity is repository plus number. Release identity is deployment id plus revision.

Every status field retains its own source: task status, host activity, attempt state, review verdict, publication state, PR state, deployment phase. A single presentation “needs attention” flag may rank them, but cannot overwrite those underlying facts. Completed old attempts remain immutable history. A source loading error yields unavailable evidence, never an empty successful section.

No new backend is required for the initial known-relation view. Full historical cross-pipeline association needs the automation owner to persist missing links. If that dependency is still absent at review, the board must visibly represent unconfirmed associations and report the limit. Do not claim all historical tasks were reconstructed into production metadata.

## Minimal adoption sequence

1. Inventory and hash the predecessor artifact in place. Copy only useful design/layout ideas into the new lane; preserve the original directory and evidence.
2. Add the pure projection and explicit unresolved states, with synthetic multi-pipeline cases from this design. Connect it to existing board data sources.
3. Integrate geometry and task navigation with native conversation ownership. Prove saved pins in aggregate mode before wider layout changes.
4. Isolate conversation UI work at the outermost boundary. Instrument all layers before claiming zero hidden work.
5. Exercise production hooks, outbox and navigation with isolated transport fixtures, then run the visual matrix and exact-head checks. Publish only the board builder's reviewable PR through its authorized stage. Research performs no publication.

The boundary between view-local subscriptions and durable delivery is the highest-risk integration point. A patch that makes hidden counters zero by disabling receipt ingestion fails the delivery gate.
