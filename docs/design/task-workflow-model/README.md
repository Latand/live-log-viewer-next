# Task-centred board: recovered workflow model

> Как сделать: нужно запустить, наверное, отдельного агента. Который проанализирует, если это как-то возможно, нашу работу с пайплайнами. То есть восстановит то, как агенты работают с пайплайнами, как они запускают, как они потом добавляют какие-то новые задачи. То есть вот. Microsoft Microsoft. GPT-5.6 Luna, она дешёвая. Вот, пусть там можно несколько агентов, или как-то придумать, как чтобы они прочитали. Подготовить для них скрипт, скажем так, с которого они будут читать разговоры. И они должны по тому, как по. Пайплайны и чтобы понять UX, как у нас может быть, что там сначала у нас было одно, потом мы добавили и хотим добавить ещё один ревью, кстати, не всегда, но в пайплайн попадает, поэтому это может быть как-то я даже не знаю, как это по вызовам нейронок смотреть. Понять, понять, понять, понять, понять, понять, понять, как именно у нас происходит работа, сделать reverse engineering того, что у нас происходит во флоу работы. Пусть делает, делает, делает это и. Наверное, это сделает лучше, чем Luna. Ну, она может использовать Luna как саб-агента, если захочет. И вот на основе этого я бы хотел, чтобы было понятно, как должна выглядеть разная. Разных видов вот этих карточек по задачам. Потому что вот, ну, отследить, как на задаче вешались карточки, агенты, какие там были ревьюеры, там всё такое. Вот я хочу, чтобы было общий интерфейс, который вот так, как мы вот управляем, и чтобы он использовался для отображения по привязке задачам.

Originating operator requirement, September 8, 2026 at 02:22 Europe/Kyiv (September 7, 23:22:41 UTC), Manager conversation, private case C0. Voice transcription retained verbatim; context envelope and personal paths omitted. Canonical requirements: issues #1453 and #1446. This document completes the research stage; the successor's build and review stages own production integration.

## Decision

Build the requested task-centred board by projecting existing task, pipeline, flow, conversation and release evidence into one navigable task history. Keep the native conversation reader and composer. Use the existing automation-v2 design for future engine changes. A second automation engine or transcript-mining service is unjustified.

The operator wants to understand how work actually proceeds: one task can have several pipelines, changed workers, two substantive reviews, targeted acceptance, a PR and more than one deployment attempt. A task card stays stable across those events. Success means those relations are visible and every worker remains reachable, including failed launches and older reviews.

The public package contains a synthetic clickable card specimen, this design, a source/ownership map, acceptance gates and a bounded API extraction module. Private chronology, real relationship identifiers, API records and source locators are outside Git. Original artifacts were preserved. The interrupted research directory was absent; these files are newly reconstructed.

Source pin: checkout HEAD, local origin/main and remote main all resolved to `88e5a9508be2802266734056d6436f3168201cad` during this research on September 8. Product-source edits are prohibited in this stage. The main checkout's installed Next guide `node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.md` was read because this worktree has no node_modules. It confirms serializable client boundaries. No Next product code was written.

## Evidence and coverage

Searches tried task-centred, workflow research, NativeSlot, add-stage, successor pipeline and standalone reviewer. Initial name-style project filters returned no hits; global results supplied the canonical opaque project key. Subsequent searches used that key. Search absence under the wrong project key is not historical absence. Hits were followed through Viewer conversation_messages, including tool calls/results, with bounded cursor pagination. No raw transcript files were read.

The original researcher was read through all pages of its September 7, 23:53–23:58 window. The historical task brief was recovered from its get_task result, because the task's current text is a shorter recovery assignment. The original attempt stopped before file creation; the current pipeline readback records exhausted verdict recovery. A statement that writing had started did not establish a file.

| Private case | Observed workflow | Design consequence |
| --- | --- | --- |
| C1: July 28 stage addition | An agent claimed add-stage was available; later evidence reports a draft-only refusal. A successor retained the same task and base. The owning conversation no longer resolves; the parent API/tool record is secondary evidence, explicitly labelled. | Keep request, refusal and successor as separate events. Do not label stage addition completed. |
| C2: August 5 review restart | A Claude successor request failed because its source conversation did not exist. A revised request returned a new pipeline. | A rejected launch is an operation outcome; a subsequently created pipeline has its own identity. |
| C3: September 5–7 accounting repair | Many pipelines continued one PR through contract disagreement, host/admission failure, quota, two reviews, targeted fixes, executable acceptance and merge. Some taskIds are empty; one recovery launch has no conversation. | Group through authoritative relation evidence. Preserve pathless attempts and missing task associations. |
| C4: September 7 account recognition | First review found two defects; second review found a further candidate-isolation defect; a successor ran fix, acceptance and merge. The earlier merge stage never started. | Count two substantive reviews. Label final acceptance separately and bind each verdict to its reviewed SHA. |
| C5: September 7 release batch | An exact-SHA deployment was accepted, then failed readiness; a recovery attempt rolled back; a repaired SHA was also accepted and failed. Both PR and candidate health checks had passed. Later combined main required another qualification. | Merge, release qualification, accepted deployment and successful deployment are independent facts. One deployment links several tasks. |
| C6: September 7–8 board artifact | Builder pass, publication failure, independent critique, later corrections, another critic's measured failures and quota stop coexist. | Preserve artifact verdict, publication outcome and verification status. A quota stop cannot become approval. |
| C7: research and preview | Research had no artifact despite a writing update. Preview hosting produced process/readiness evidence separately from design acceptance. | Artifact existence and preview availability each need their own observation. Preview hosting is not product deployment. |

This is a purposive incident sample across both engines, not a frequency estimate of all operator work. The private casebook distinguishes complete time windows from bounded partial worker tails. Current get_pipeline, get_task, deployment_status and GitHub PR readbacks corroborate durable states; historical tool records explain transitions. Search snippets are never used as sole proof of an effect.

## Current model and missing relations

| Object | Existing authority | Board representation |
| --- | --- | --- |
| Task | BoardTask UUID, text, status, placement, assignments, optional source | Stable task card and its history. Manual done remains a task status; it does not manufacture a deployment result. |
| Pipeline | Pipeline.id, taskIds, stages, runs, cursor, state, lastPassedCommit, publishedCommit | Execution section inside task detail. A pipeline may link multiple tasks. |
| Stage | Pipeline stage id, next and onFail | Planned slot even before any attempt exists. Separate pass and return edges. |
| Attempt | (pipeline id, stage id, n), launchId, conversationId, agentPath, state, verdict, flowId | All attempts listed oldest to newest; current one prominent. Missing conversation is “Launch unresolved”. |
| Conversation | Durable conversation id plus generation path | One native owner, reachable through task, attempt and review links; changing a transcript path does not create a second task. |
| Review | Run-stage role or flow round and reviewer bindings; source SHA when available | Substantive review versus targeted acceptance, verdict, findings and exact reviewed revision. |
| Successor | Often only named in prompts or tool evidence today | Confirmed relation when authoritative metadata exists; otherwise “Related execution, association unconfirmed”. Never infer from title alone. |
| Publication | Pipeline publishing state/error, publishedCommit; PR service readback | Local artifact ready / publication failed / branch published / PR merged, independently. |
| Deployment | Deployment ledger id, revision, phase, terminal, health and error | Shared release reference with per-attempt detail. Link PRs by verified commit ancestry. |
| Legacy workflow | Existing workflows/types.ts and embedded flow | Compatibility projection; no newly created legacy records. |

Current `linkedPipelineTasks` already accepts explicit taskIds and task assignment/source lineage. Reuse it, while labelling the basis of the relation. A task assigned to a broad manager conversation must not absorb every pipeline that manager created: source-parent overlap alone is weak evidence for ownership. The API task response also exposes derived revision and pipelineIds fields that are absent from the base BoardTask interface; distinguish response enrichment from persisted task schema.

The source has no general typed PR/successor/deployment relation on BoardTask. Do not pretend the board can restore missing durable associations from text. The frontend can ship a complete view of known relations and an explicit unlinked section. Persistence of missing typed relations belongs to the automation/API owner; the integration map defines that dependency without expanding this lane into backend work.

## Card and navigation design

At overview scale, show task title, task state, current activity, a concrete next action, and counts for workers, reviews and executions. Keep publication and deployment labels visible when they require action. Example: “Search results stay anchored · verification waiting · 6 workers · 2 reviews · branch publication failed”. Keep the task's location and identity through replacement workers.

Selecting a task opens a compact detail surface with: originating requirement; current attempt; execution history; reviews and acceptance; artifacts/PR; releases. Each row opens its actual target. An empty planned stage opens stage details; a failed pathless launch opens attempt evidence. Every worker is reachable through a searchable, windowed list with total count and explicit older-attempt controls. Aggregation limits drawn cards, never the set of reachable records.

A shared worker has one canonical native conversation owner. Other tasks use labelled references to it. A shared release appears once in release detail and as a link from every proven member task. Direct reviewers, embedded flow reviewers and successor reviewers retain their actual membership; the board does not invent a common round number.

Selecting an attempt can focus the native card in place. Full-window mode portals the same owner. Return restores camera, selection and reader; draft, text selection, scroll anchor and unread position survive. Selection and keyboard activation use the same target resolver. Task details use ordinary scrolling and a bounded rendered row window.

The specimen `cards.html` illustrates these states with invented tasks and references. It is an information-architecture specimen, not a production board or geometry/performance proof. Real BranchPane, LogFeed and TmuxComposer remain the production conversation surface.

## Geometry, expansion and stable pins

Use one displayed rectangle per surface. For scale z, a reader with minimum readable screen size has world footprint screenWidth/z by screenHeight/z. Compute that before layout. For a group, union every displayed child rectangle, add heading space and padding, then separate sibling group envelopes. Edges, focus framing, hit testing and viewport eligibility consume the same final geometry.

The supplied 58% screenshot visibly places the expanded “Incremental indexing” conversation above its Search group, extending into the adjacent region. A fixed collapsed group bound cannot serve an expanded native reader. The later correction improves this; the critic's 1,152-case sweep reported zero geometry failures and endpoint error at most 0.019 px. Those are prior prototype measurements, not newly executed production results.

Preserve the active reader anchor and existing accepted world pins. Resolve automatic neighbours in deterministic order and recompute envelopes after each displacement. Pure pan changes only the camera transform and eligibility; it must not rerun layout or move world anchors. Zoom and expansion can change footprints. Commit the resulting geometry atomically so cards, labels and arrow tips do not briefly disagree.

Aggregate mode must apply saved pins after choosing its automatic layout. The prior 7% drag stored a world pin and announced success while the task's screen rectangle stayed unchanged: (412,387,240,104) before and after. Its automatic aggregate lattice overwrote the pin. A drag is complete only when the displayed centre follows the accepted coordinate and durable readback agrees; failure retains the prior pin and shows the actual failure. Never display “Position pinned” solely because local state was updated.

Two hard pins can make non-overlap geometrically impossible. Keep old pins intact. During a new drag, preview the nearest legal drop and commit that exact preview; reject an infeasible drop with an inline explanation. For conflicting legacy pins, expose an overlap indicator and a list of both targets; preserve original coordinates until an explicit move. If expanding between pinned neighbours cannot fit, open the existing native full-window surface and preserve Return. Do not silently shift pins or claim the conflicting legacy scene passed non-overlap.

Ports terminate on displayed boundaries. Clip only after geometry; offscreen relationships become labelled continuation targets. A label must not imply a worker disappeared. Deduplicate parallel relationship summaries while retaining the full typed edges in task detail. Edge paths must avoid unrelated node interiors and reserve space for labels/arrowheads.

## Zero hidden conversation UI work

The critic measured 480 / 2,000 / 20,000 offscreen NativeSlot executions over 20 pans for 24 / 100 / 1,000 conversations. An offscreen rich summary invoked latestSummary and JSON.parse once per pan. Inner native pane/feed/header executions and hidden DOM mutations were zero in that particular workload. The builder's narrower zero counters therefore did not cover all conversation UI work.

Camera state belongs to the board's geometry/visibility shell. Build a spatial index of cheap node rectangles when model/footprints change; query it on pan. Publish eligibility transitions only for changed IDs. A hidden conversation boundary receives stable props and no camera or changing box object. Filtering eligibility must happen before constructing conversation-specific summary/native elements. Keep one warmed owner per conversation; its hidden boundary remains quiescent.

Activity can preserve native state while suppressing effects, but it alone does not stop a parent wrapper from executing. Use it only behind a memoized, stable-prop boundary. Gate header age timers, LogFeed runtime selectors, TmuxComposer runtime/receipt selectors and view-local prune timers as well as log subscriptions. Current useLogTail already unsubscribes when paused; reuse that path. Cache summaries by conversation data revision and compute only for visible summary surfaces. Never parse source text during pan or in a hidden summary.

Keep receipt ingestion, durable outbox persistence and transport recovery at their existing owner above visibility gating. They continue while a card is hidden. Suppress only that card's UI callbacks, parsing, rendering and timers. On reentry, read the latest authoritative snapshot once, restore the reader state and reconcile the original delivery key. Accepted or unknown delivery must retain the same operation identity; a remount cannot send again. Do not compact unresolved outbox operations.

This is a production requirement. A fixture transport, React render counter or synthetic exactly-once response cannot prove production subscription and delivery behaviour. See ACCEPTANCE.md for the precise gates.

## Options and over-engineering review

| Option | Trade-off | Decision |
| --- | --- | --- |
| Keep pipeline-shaped board unchanged | Cheap; cannot express one task's multi-pipeline review/release history clearly | Does not satisfy the originating request |
| Existing-model task projection and stable native surfaces | Reuses identities, controls and current engine; incomplete links stay explicit | Build now |
| New workflow database, event sourcing framework and graph editor | Duplicates automation-v2 and expands migrations/ownership | Deferred |
| CSS hide or Activity alone | Retains state with little code; leaves changing wrappers/summary work | Insufficient for measured requirement |
| Unmount every invisible reader | Simple render budget; threatens unsent draft, selection and scroll recovery | Use only with proven external state restoration |
| Existing spatial layout plus indexed eligibility and memoized owner | Small mechanism that targets the measured work | Preferred; add a library only after native index profiling proves need |

No new ADR is needed: this stage chooses a reversible frontend projection. The hard-to-reverse automation storage and mutation decisions already belong to automation-v2.

## Validation against the requirement

The recovered casebook explains creation, added work, retries, review caps, successors, publication and deployment batches from tool evidence. Task cards expose those relationships and all worker identities without requiring a single pipeline per task. Source integration is assigned to the next build stage; its completion requires actual production-component tests and independent review. This research pass does not declare the board shipped, the task done in production, or the older pipelines settled.

## Deferred — not currently justified

A replacement automation state machine, general event-sourcing service, automatic transcript-derived task ownership, bulk historical data rewrites, a new composer, new deployment controls and a graph-layout library remain outside this frontend slice. The broader #1453 desktop rail/accounts/search audit and mobile work retain their existing owners. #1446's agent-first mutation/migration programme remains required under its own owner; it is not discarded or implicitly completed here.

