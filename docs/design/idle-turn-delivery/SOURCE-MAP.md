# Sources and implementation manifest

## Inspection pins and coverage

Inspected on 2026-09-08. HEAD, origin/main, remote main and merge-base: `88e5a9508be2802266734056d6436f3168201cad`. Read-only GitHub discovery preceded artifact creation. No matching open umbrella issue for the September paired requirement appeared in bounded all-state searches for `after turn`, `idle tick`, `queue in:title`, `idle in:title`, and `after-turn in:title`. Relevant historical and open owners were read; see the issue brief. Discovery was bounded; root should repeat the narrow search before publication to check for duplicates.

Five initial Viewer transcript searches used `idle tick`, `черга повідомлень`, `after turn`, `message queue`, and `#1245`, project-scoped first and global afterward. The first name-style project key returned no hits; it was invalid for this catalog. Subsequent project queries used the returned canonical project key. That first empty result establishes no historical absence. Two follow-ups (`чергу повідомлення`, `revisitable queue`) did not recover an earlier direct operator turn beyond the known requests.

Read actual normalized records for the originating manager request, the July 13 queue implementation assignment and tool results, the August 28 tick designer's response and publication tools, and the September board research. Read #12 and #561 for the older first-person queue requirements. The July transcript is a delegated implementation brief. No earlier direct operator transcript was recovered for that request. No raw transcript files were opened.

Private evidence E1–E5 is retained outside Git. Public documents contain the requirement excerpt, sanitized chronology and source references only. Exact paths, account context, real conversation/operation identifiers and tool bodies stay in that private evidence package. Current live runtime reads establish the observed receipt and present availability; no production lifecycle actions or test sends were used. The deployed product SHA was not established by those reads.

## Code evidence at the pin

| Source | Verified fact and design consequence |
| --- | --- |
| `src/lib/monitor/seatTick.ts:267` (`seatTurnProgressing`) | Positive progress test; missing activity returns false. September idle-only requirement must replace progress-as-admission logic. |
| `src/lib/monitor/seatTickSources.ts:463` (`seatInput`) | Liveness is read only for registry busy; failed read becomes null. A registry idle value cannot replace final host authority. |
| `src/lib/monitor/seatTickController.ts:734` and `:796` | Rechecks seat epoch and durably prepares accounting; first send has no protected delivery policy. |
| `src/lib/monitor/seatTickController.ts:485` | Outstanding-wake recovery can redispatch. Protected policy and unknown-outcome retention must cover this branch too. |
| `src/lib/monitor/seatTickAccounting.ts` | Existing durable prepare/dispatch/settlement and revision arbitration; reuse it for ephemeral wake attempts. |
| `src/lib/delivery.ts:675` and `:698` | General send recovers structured host, then enqueues without policy. Tick-specific intent must survive this call. |
| `src/lib/runtime/structuredMessageDelivery.ts:43`, `:98`, `:948`, `:1046` | Existing request policies, per-key in-process admission, registry reservation and runtime command; omitted policy becomes interrupt-active. In-process admission alone cannot decide multiple writers or host idle. |
| `src/lib/runtime/structuredDeliveryQueue.ts:514`, `:608`, `:801`, `:824` | Serial drain per instance; controls/reconfiguration precede event-sequence sends; policy decides steering/interrupt; host entry carries turn fence. Retain queue ownership and explicit null for protected modes. |
| `src/lib/runtime/structuredDeliveryQueue.ts:834`, `:880`, `:928` | Journal claim precedes host write; stale-turn can return to queued. An edit/cancel predicate needs evidence of no handover, beyond the status name. |
| `src/lib/runtime/codexAppServerHost.ts:1420`, `:1445`, `:1471`, `:1500` | Capability/history work may await; activeTurnId is checked before steer/start; a new start's active ID is set after RPC reply. Revalidate and reserve final idle synchronously. |
| `src/lib/runtime/codexAppServerHost.ts:2325`, `:2593`, `:2978` | Any current attention forces attention status; lifecycle updates active ID; RPC writes synchronously while response waits. #1558 owns the attention correction. |
| `src/lib/runtime/claudeStreamBrokerHost.ts:793`, `:819`, `:846`, `:1295` | Broker has per-entry ledger/dedup, active-turn fence, user-frame write, and matched result/turn queue. Protected mode must never write a queued-next-turn frame into active work. |
| `src/lib/runtime/engineHost.ts:12`, `:89` | QueueEntry already has optional null/string expectedTurnId; HostState splits active turn and pendingAttention. Extend that interface conservatively. |
| `src/runtime-host/journal.ts:585`, `:598`, `:645`, `:1592` | BEGIN IMMEDIATE transition, fromStatuses/discard winner, durable turn binding and queued structured receipt. A queued receipt establishes admission; host consumption is later. |
| `src/lib/runtime/http.ts:431`, `:479`, `:517` | Current discard path uses transition fencing and action arbitration. Uncertain discard is already a distinct possibility; it must not imply guaranteed recall. |
| `src/lib/runtime/handoffQueue.ts:36`, `handoffQueueStore.ts:14` | Existing ordered delivery IDs and generation fencing across release succession. Reuse, do not add queue ownership here. |
| `src/components/TmuxComposer.tsx:2467`, `:2668`, `:2760` | Composer sends interrupt-active; local queue dispatch and queue-first submission already exist. Add a persisted choice and server queue projection. |
| `src/components/conversation/outbox.ts:110`, `:736`, `:1145` | Waiting-turn state, unresolved retention and local cancellation exist. Wire/admission uncertainty must block local destructive edits. |
| `src/lib/orchestrator/seatCommand.ts:808`, `:894` | Rotation rechecks incumbent; tick claim revocation must share its authority arbitration without adding host lifecycle effects. |
| `src/hooks/runtimeBus.ts`, `src/components/conversation/OutboxBubbles.tsx` | Existing shared runtime projection and bubble owner. New labels/queue rows belong here or in the current composer consumer. |

Read the installed Next Route Handlers guide from the parent checkout's `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`. This worktree has no node_modules. No product code or standalone executable prototype was written; implementation must read its own installed guides again after dependencies are available.

## Exact proposed product manifest

This is the minimum planned edit set at the inspected base, grouped by responsibility. Existing dependency PRs may satisfy rows before this work starts; rebase the manifest and omit already-satisfied edits. Do not treat this list as permission to modify these paths in the design stage. Any additional file needs a concrete source-discovered reason in the implementation PR.

| File | Proposed change | Ownership |
| --- | --- | --- |
| `src/lib/monitor/seatTick.ts` | Positive idle pre-check and truthful busy/unknown reasons | Tick slice |
| `src/lib/monitor/seatTickSources.ts` | Current authoritative seat eligibility and withdrawal outcome projection | Tick slice |
| `src/lib/monitor/types.ts` | Eligibility and protected wake metadata | Tick slice |
| `src/lib/monitor/seatTickController.ts` | Explicit idle-only dispatch, loss-of-admission settlement, recovery branch | Tick slice |
| `src/lib/monitor/seatTickAccounting.ts` | Preserve policy/claim identity; settle only proven unsent or delivered | Tick slice |
| `src/lib/delivery.ts` | Carry protected tick policy and seat fence through general transport | Shared delivery, after release |
| `src/lib/orchestrator/seatCommand.ts` | Coordinate rotation with tick authority claim; zero new kill/resume behavior | Seat owner |
| `src/lib/orchestrator/seats.ts` | Same transaction for epoch revocation and final tick dispatch | Seat owner |
| `src/lib/runtime/contracts.ts` | Protected policy, completion reference, queue presentation and mutation results | Shared; API lane first |
| `src/lib/runtime/commands.ts` | Validate policy/fence and queued mutation commands | Shared |
| `src/lib/runtime/engineHost.ts` | Final idle admission contract and explicit unsent refusal | Shared; #1558 first |
| `src/lib/runtime/codexAppServerHost.ts` | Revalidate after awaits; pending-start reservation and dedup join | Shared host |
| `src/lib/runtime/claudeStreamBrokerHost.ts` | Enforce equivalent broker idle/write admission | Shared host |
| `src/lib/runtime/structuredDeliveryQueue.ts` | Completed-turn release, explicit idle fence, FIFO head block on unknown, tick skip, Send now ordering | Shared queue |
| `src/lib/runtime/structuredMessageDelivery.ts` | Freeze/carry mode and completion reference through reservation/recovery | Shared delivery |
| `src/lib/runtime/structuredDeliveryController.ts` | Propagate authoritative completion eligibility via existing state-change kick | Shared controller; no new timer |
| `src/runtime-host/journal.ts` | Queue projection/order and transaction-fenced queued amendment/dispatch winner | #1225 and runtime owner |
| `src/lib/runtime/client.ts` | Existing socket command/read support for queue projection/amendment | #1225/shared |
| `src/runtime-host/host.ts` | Validate/route corresponding socket requests | #1225/shared; no release logic |
| `src/lib/runtime/http.ts` | Existing runtime read/action surface for pending list, edit/cancel/continue | #1225/shared |
| `src/app/api/runtime/operations/route.ts` | Add bounded GET queue projection on the existing collection | Queue read surface |
| `src/app/api/runtime/operations/[operationId]/route.ts` | Narrow mutation handler using existing HTTP module | #1225/shared |
| `src/lib/agent/registry.ts` | Fence/retain reservation across proven-unsent amendment; preserve original attempt identity | #1225; incident owner releases first |
| `src/lib/runtime/structuredRecovery.ts` | Preserve protected policy and immutable edited-version key; never recreate retired version | Shared recovery |
| `src/components/tmuxComposerRuntime.ts` | Typed mode, authoritative queue read and action calls | Composer |
| `src/components/TmuxComposer.tsx` | Mode snapshot, server pending rows, edit/cancel/continue controls | Composer; coordinate board dormancy |
| `src/components/ComposerBar.tsx` | Reuse send menu for mode selection and explicit immediate action | Composer |
| `src/components/conversation/outbox.ts` | Persist mode and presentation-version association; retain unknown bytes | Shared outbox |
| `src/components/conversation/OutboxBubbles.tsx` | Truthful accepted/queued/delivering/delivered/unknown labels and controls | Shared outbox |
| `src/lib/i18n/en.ts` | New strings | Composer |
| `src/lib/i18n/uk.ts` | Matching strings | Composer |

The queue list is a bounded projection through the existing runtime operations collection; snapshots/receipts carry only queue summary/revision. Reuse the current runtime subscription and composer adapter, with no new persistence owner or polling controller. Control operations remain separate from user queue rows. The UI cannot infer mutation eligibility from receipt status alone.

This includes the #1225 prerequisite because full requested editing/cancellation cannot honestly be promised by changing only the send menu. Pure tick protection can ship as a smaller independently reviewed subset. No files in deployment, runtime-host succession, task board geometry, handoff queue storage, scanner or provider SDK are planned for modification.

## This stage's output manifest

Exactly five public Markdown files, all in `docs/design/idle-turn-delivery`:

- `README.md` — originating requirement, design, state model, dependencies and deferred scope.
- `SOURCE-MAP.md` — inspected evidence and proposed product manifest.
- `UX.md` — synthetic states and sequence diagrams.
- `ACCEPTANCE.md` — causal test plan and verification limits.
- `ISSUE-BRIEF.md` — canonical issue discovery and root-ready brief.

Private evidence is a separate local artifact outside Git. The existing pipeline's next review stage supplies fresh independent review; this architect stage does not self-certify that review or launch helpers.
