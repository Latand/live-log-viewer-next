> треба ще запустити лінію на дизайн з gpt-6 astra - щоб коротше коли seat tick - воно щоб робилося лише тоді коли оркестратор стоїть нічого не робить, а якщо працює - бажано тіком не переривати роботу поточу. і ще плюс ода фіча -  яку ще давно ще писав тобі - це черга повідомлень які надсилатимуться після тоог як завершиться ход. схожа штука - просто це вже не тік, ле мої повідомлення , щоб непереривати роботу. И также очисти доску, архивируй все старые разговоры. Вот я вижу какой-то «3 дня назад» есть разговоры, и так далее.

Originating operator requirement, verbatim, 2026-09-08 04:54:47.199 UTC, manager conversation; recovered through Viewer `conversation_messages`. Private evidence E1 identifies the conversation, transcript and record. Wrappers containing personal context are excluded. The board-cleanup sentence belongs to the manager's separate task; it gives this design no authority to archive anything.

# Idle-only ticks and after-turn messages

Design only, against `88e5a9508be2802266734056d6436f3168201cad`. Local HEAD, merge-base, origin/main and remote main agreed at inspection. This package proposes product behavior; it contains no product implementation. [SOURCE-MAP.md](SOURCE-MAP.md) separates observed behavior, source reasoning and the proposed file manifest. [UX.md](UX.md) contains synthetic examples, [ACCEPTANCE.md](ACCEPTANCE.md) the causal verification plan, and [ISSUE-BRIEF.md](ISSUE-BRIEF.md) the issue-ready handoff.

## Decision

Build the two requested behaviors by extending the existing structured delivery queue and host fences:

1. An automatic tick may start a turn only with positive idle evidence at the final host write. A busy, waiting, blocked or unobservable seat receives zero tick input. A tick that loses admission is dropped; its underlying obligations remain eligible for a later fresh check.
2. A user can select **After this turn**. The Viewer persists the message immediately and starts it after an authoritative completed turn and a new idle admission. Pending user messages remain visible in server order, with edit/cancel while provably unsent. **Send now** explicitly retains the existing immediate interruption behavior.

Reuse `StructuredDeliveryQueue`, the runtime journal, registry delivery reservations, engine ledgers, the composer outbox, and existing runtime subscriptions. No native provider queue, new scheduler, queue database, transcript polling loop or board automation model is needed. No ADR is added: the existing dead-host wake ADR remains in force within the stricter admission rule; this is a reversible delivery-policy extension.

The stronger September requirement changes the current rule that an unknown or stalled turn can be woken. A stalled active seat stays protected. Existing board/attention surfaces can report a stall; recovery belongs to its current owner and requires authoritative evidence. Increasing a silence timeout cannot establish idle.

## Evidence and existing mechanisms

The closed [original queue request #12](https://github.com/Latand/live-log-viewer-next/issues/12) asks for persisted, inspectable text/images, ordering, revisiting, editing, cancelling and retry. [Structured queue #151](https://github.com/Latand/live-log-viewer-next/issues/151) supplied the engine-host transport. Its July 13 assignment explicitly required busy sends to enqueue durably and deliver in order, and forbade a second store. [Composer queue-first #561](https://github.com/Latand/live-log-viewer-next/issues/561) added local immediate acceptance/navigation requirements. These are existing product obligations.

The [#1245 research proposal](https://github.com/Latand/live-log-viewer-next/issues/1245#issuecomment-5447167563) specified a busy-seat skip and no held ticks. Later comments corrected its historical overlap and cadence measurements and documented subsequent wake behavior. Those old measurements are not evidence for the September incident.

Current source has three distinct facts:

- `seatTurnProgressing` skips a registry busy turn only when activity supports running/starting or waiting with an open turn. Missing activity, stalled and gone do not earn that skip. `seatInput` only asks liveness when the registry already says busy.
- `seatTickController` rechecks seat identity before dispatch, but its call supplies no idle delivery policy. `deliverConversationMessage` forwards into structured admission without a policy; `enqueueStructuredMessage` defaults to `interrupt-active`. The composer explicitly selects that same policy.
- The existing queue already supports `policy: queue`, serial drains, durable operations, original-key recovery, and host `expectedTurnId` fences. Browser queue-first acceptance is therefore distinct from deferring provider input until turn completion.

### September case, with limits

| UTC | Verified observation |
| --- | --- |
| 04:54:47.199 | Operator requests idle-only ticks and after-turn delivery. |
| 04:55:03.613 | Delivery-record receipt later reports the tick accepted. |
| 04:55:15.475 | Runtime session receipt reports the same operation admitted to the runtime journal. These are separate store stages. |
| 04:55:28.794–28.862 | Manager calls a tool and receives its result while handling the request. |
| 04:55:37.171 | Normalized transcript contains `turn_aborted`: previous turn interrupted on purpose. |
| 04:55:38.847 | Tick user message appears, marked with seat-tick authorship. |
| 04:55:42.013 / 43.472 | Runtime receipt / delivery-record receipt report delivery for that operation. |
| 04:55:55.440 | Manager acknowledges the tick arrived during this request. |

Thus the board's “04:56 tick” is a rounded reference to the 04:55:38 arrival. The interruption and tick arrival are observed. Current source explains a path that can interrupt after admission. The exact pre-check inputs and provider RPC frames from that instant were not recovered, so this design does not claim to have proved whether the initial admission was a stale registry read, an activity classification gap, or another check/dispatch race. A deterministic transport reproduction is required before an implementation claims the incident's cause fixed.

At 05:20–05:21 UTC, targeted live reads showed the manager's host alive/hosted, `turnState: idle`, `activeTurnId: null`, no attention IDs, and the structured runtime ready. That verifies current availability and illustrates why lifecycle `waiting` alone cannot decide whether a turn is active. It does not reconstruct the earlier state or identify the deployed source SHA.

## State model and authoritative idle

Use separate facts for host ownership, turn lifetime, pending requests and delivery. UI activity, tool completion, elapsed silence, transcript mtime, RPC acceptance and a displayed final paragraph do not individually establish turn completion.

| Evidence at the current owned host generation | Tick | After-turn queue head |
| --- | --- | --- |
| Active turn, model output, tool call or tool-result processing | Drop check | Wait |
| Tool wait, background command awaited by the turn, provider retry with open turn | Drop check | Wait |
| Blocking approval/question; malformed or unknown request blocking flag | Drop check | Wait; retain answer control |
| Validated nonblocking question and active turn | Drop check | Wait; question stays answerable |
| Validated nonblocking question, completed turn, host positively idle | May admit | May admit one message; question stays answerable |
| Complete terminal event for matching turn/generation, idle host, no blocking request/control/start reservation | May admit | May admit head |
| Error or interrupted terminal event | Defer until explicit recovery/continue establishes eligibility | Pause pending messages, show reason and Continue queue |
| Disconnected, unreadable, conflicting ownership, incomplete replay, unknown turn | No input | Retain and reconcile; no input |
| Dead/unhosted after a proven completed turn | Existing fenced recovery may restore host, then fresh idle admission | Existing recovery may restore host, then recheck; preserve keys |
| Dead over open/unknown turn | No wake input | Retain for recovery; death does not mean completion |

The host must expose a trustworthy idle decision after initialization/replay reconciliation. A default field value `idle` during construction is insufficient. Required evidence: current writer identity and generation; no active turn; no pending start or conflicting control; no blocking request; replay current through the evidence cursor used for admission. If the previous turn exists, its matching authoritative completion must be known. A genuinely new empty conversation uses positively established empty history instead.

For Codex, use canonical `turn/completed` and the owned thread's reconciled state; an item completion or nonblocking question is insufficient. For Claude, use the broker's matched final result for its active turn. A background task that remains part of an open turn remains busy. Detached work may outlive a completed parent turn; that alone does not keep the parent active. Any contradictory tool/control state makes admission unknown.

[#1558](https://github.com/Latand/live-log-viewer-next/issues/1558) owns validated `isBlocking: false`, all pending question IDs, replay, answer identity and retirement protection. Missing/null/string flags remain blocking. Never implement a second classifier here, and never clear requests merely to make the seat idle. Until that slice lands, the current conservative attention gate remains safe, with reduced availability for nonblocking questions.

## One admission path, two retention policies

Keep the existing `send` operation and policy vocabulary. Add a narrow **idle-only** policy for automatic ticks; retain **queue** for user after-turn sends and **interrupt-active** for explicit Send now. Store the policy with immutable payload, attachments, settings and origin at reservation. Reject unsupported policies on an older host before actuation. Never let omission during migration/recovery turn an after-turn or tick intent into the immediate default.

For queue and idle-only, the engine fence is explicitly `expectedTurnId: null`. No code may substitute the latest active turn ID, call steer, or issue interrupt to make it pass. Keep a separate predecessor-completion reference for user queue eligibility; it must never be reused as a steering fence.

### Final dispatch linearization

The existing queue's durable `queued → delivering` transition arbitrates operation ownership. It does not make the host idle by itself. The host must revalidate idle **after every asynchronous capability/history/evidence read**, immediately before synchronously reserving the start and writing the engine frame. Codex currently awaits confirmed-delivery history and leaves a start awaiting RPC response; protect that window with a per-host pending-start reservation. Claude must apply the same contract at its broker write.

All Viewer callers that can start input on the same host must cross this gate, including recovery and future idle context insertion. Use the existing host object and writer fence, with one synchronous state transition and a pending-start field; no generic locking framework. Different operation IDs cannot both reserve the same idle interval. A duplicate ID joins its existing in-flight result or reconciles its ledger. Release the reservation on proven pre-write refusal or authoritative terminal outcome; keep it unresolved after possible write with lost acknowledgment.

An independent process controlling the provider thread invalidates exclusive ownership. Native queue auto-dispatch, provider autonomous goals and concurrent realtime input cannot be assumed idle-compatible. Such a host must either provide authoritative serialization evidence or refuse this capability as unavailable. This design does not promise control over an unobserved external writer.

Seat identity/epoch is an additional fence for ticks. Validate it on preparation and final dispatch; make rotation revocation and tick claim arbitration use the same existing seat mutation transaction. The final epoch check and synchronous provider-frame write must share that short critical section with seat revocation; release it before waiting for a provider response. A read followed by an unlocked later write is insufficient. Rotation first revokes new tick claims, then proceeds through its established lifecycle. A claimed dispatch is either withdrawn with proof of zero actuation or remains attached to its original epoch for settlement. A rotation cannot relabel an uncertain tick as a successor wake. No new retirement/kill behavior is introduced.

### Tick path

1. Existing timer checks obligations/cadence and positive seat idle eligibility. Busy and unknown have distinct recorded skip reasons. Do not advance wake acknowledgment, child harvest, or owed-event cursors for either.
2. Prepare one existing `SeatTickAccounting` attempt with key, payload, epoch and commit plan. Carry idle-only intent all the way through structured admission and recovery.
3. At admission and final host dispatch, refuse an active/unknown seat or a user backlog that already owns the next turn. A new tick may never wait behind user messages as a pending input. Close a proven unactuated tick attempt as skipped; retain the obligations for the next fresh check.
4. An attempted tick with unknown outcome remains an outstanding accounting record under its original key. Retention authorizes reconciliation only. Reconcile it before preparing another wake. Recover confirmed delivery without sending; prove absence and revoke the old writer before releasing the attempt unsent.
5. Only authoritative delivery commits the existing wake stamps. Reevaluate old reasons on the next check after an unsent attempt closes. Keep current cadence/settings; no immediate catch-up burst or new per-turn tick subscription.

The final gate must also cover the current controller's outstanding-wake redispatch branch. Testing only the first `deliver` call leaves restart behavior unsafe.

### User queue path

1. Composer submission creates the usual local outbox row immediately. Display “Saving…” until durable server acceptance; retain the local bytes on timeout. Capture target, selected context, attachment refs, origin and profile at submission. A later view/model change must not silently alter the pending message.
2. Existing server admission assigns a stable conversation order in a transaction. Use the journal's monotonic event sequence for ordinary sends; client wall clocks never decide cross-device order. Reply with the durable operation key, queue position, policy and authoritative eligibility reason.
3. After a completed turn, the existing state-change notification kicks the existing delivery controller. It claims the oldest eligible user message and writes one new turn through the final idle gate. The following message waits for that new turn to complete. Do not batch all queued messages into one input or feed the provider's own next-turn queue.
4. Pending user messages precede a newly proposed automatic tick. Accepted control operations retain their current priority. An explicit Send now can overtake waiting after-turn messages; show that exception and keep those messages queued behind the immediate turn. It cannot overtake an unresolved handover with unknown outcome.
5. An interrupted/error turn pauses automatic release. **Continue queue** is a revision-fenced user decision to proceed once the host is positively idle; it changes eligibility for the retained head without submitting another copy. Approval answers remain on their original request controls and do not act as queue messages.

FIFO applies to pending after-turn messages within one logical conversation, across clients and remounts. Simultaneous submissions receive deterministic server order. Cross-conversation global ordering and arbitrary reordering are outside this slice. Reordering remains a historical #12 request and is explicitly deferred below.

Expose a bounded queue page through GET on the existing runtime operations collection, keyed by conversation and cursor, with queue revision, pending count and explicit coverage. The shared runtime session projection carries only count/revision/head status. Visible queue consumers fetch a page when that revision changes; offscreen cards need no page reads. Unknown operations remain in the queue projection even when the executor's transient effect has been removed. Pagination or a retention boundary cannot silently hide a blocked head or authorize later dispatch.

## Edit, cancel and immutable delivery

Local entries that have never reached the wire use the existing outbox editing/cancellation path. An uncertain initial admission is already beyond that proof: reconcile its original request first.

Server-accepted pending messages require a transaction that races correctly with `delivering`. [#1225](https://github.com/Latand/live-log-viewer-next/issues/1225) is the existing owner of that work. Current main already has `fromStatuses` fencing and discard/retry arbitration; its open issue is not evidence that those functions are absent. Reuse them and add the missing proof/behavior rather than recreating abandon-and-resend.

**Cancellation:** atomically compare expected queue revision, original operation and generation, and prove no host handover ever began. Remove the pending effect and record a durable cancelled tombstone. If dispatch won, answer a conflict with the newest state. `queued` alone is insufficient: current code can return an attempted operation to queued. Historical attempted/unknown entries cannot display “Cancelled before sending.” The existing discard-unknown action has different semantics and must keep its uncertainty wording.

**Editing:** preserve immutable admitted payloads. An explicit edit atomically retires a provably never-actuated version and creates a new immutable version at the same queue position, linked by the existing presentation/root identity. Both actions happen in the existing journal transaction under the same dispatch fence. Carry the original admission sequence as `queueOrder` on the replacement effect; its newer event sequence must not move it behind later messages. This is the only permitted replacement: it records a new user edit after authoritative proof that the previous version could never reach the host. A transport retry, timeout recovery or host rotation never creates a version. Each version's own original operation/client key remains fixed for every attempt and canonical reconciliation.

The edit request carries its own idempotency key and expected revision. Replaying a successful edit returns that version; changed content under that edit key conflicts. A stale tab cannot overwrite a newer edit or undo a cancellation. Unchanged edits are no-ops. While handover may have begun, edit/cancel are unavailable; the UI can offer a separate explicit follow-up draft, without claiming the original was changed.

Registry reservation and runtime journal are separate stores. The amendment protocol must publish a recoverable action record before crossing stores: fence the old reservation against re-admission, atomically replace the old runtime effect, and expose the replacement for dispatch only once its corresponding reservation is reconciled. A crash at any step leaves the UI “Updating…” with the old and new bytes retained. The journal's action winner and revision decide recovery. Never dispatch the replacement because the old row disappeared. This narrow completion of #1225 is a prerequisite for durable edit controls; local-only editing cannot be used to claim this requirement done.

## Restart, rotation and partial delivery

| Event | Required behavior |
| --- | --- |
| Browser reload, another tab or hidden card | Server queue/order persists. Local unknown admission retains original key and immutable snapshot. Subscribe/read latest state; do not replay a possibly sent bubble. |
| Viewer or runtime-host restart | Reload operation policy/order/fences. Reconcile attempted operations before any dispatch. Reuse existing recovery and handoff queue identities. |
| Account/native generation change within the same conversation | Existing generation handoff must fence predecessor, resolve any attempted delivery, then carry never-actuated pending messages in order. Preserve payload/profile/key; capacity failure stays visible. |
| Manager seat rotates to a different conversation | Do not silently redirect operator instructions. Retain original target queue and show “Target changed.” An explicit move requires the same proven-unsent amendment transaction and a visible target change. Uncertain entries remain with original target. |
| Engine accepts bytes, socket reply is lost | “Delivery unknown.” Hold the conversation's later after-turn messages behind that unresolved head. Read canonical evidence using the original key. No new send from a timeout, negative partial page or queue disappearance. |
| Receipt delivered, transcript echo delayed/evicted | Keep delivered truth and pending presentation until exact echo reconciliation; do not demote to failed or match unrelated repeated text. |
| Partial attachments/history or one of several messages delivered | Retain unresolved blobs and per-entry receipts. Delivered entries remain delivered; only the unresolved suffix waits. Never resend the batch. |
| Quota/auth failure | Preserve queue and account/model choice; display known retry/recovery reason. A reset time or auth-refresh notification alone releases nothing. |
| Cancellation/edit acknowledgment lost | Reconcile the original mutation key/revision. Keep bytes until its winner is known. |

Exactly-once is a safety contract conditional on authoritative recovery evidence. Availability can pause indefinitely when that evidence is missing. The implementation must never trade an unknown outcome for an invented delivery or absence claim. PR #1562's pagination work improves evidence coverage; it does not turn bounded negative history into universal proof of absence.

## Dependencies, ownership and rollout

Read-only coordination inspected the reviewed [Codex API plan #1562](https://github.com/Latand/live-log-viewer-next/pull/1562) at `7da95c6a4d1e8e1ef32183f17321db395bc41967`, its actual review artifact, all five issue bodies, and the board workflow's design/output. That review approved research/probes, with live-model and full Viewer integration still unverified. It did not approve this design or ship the APIs.

- [#1557](https://github.com/Latand/live-log-viewer-next/issues/1557): canonical pagination and original-key evidence reader. Reuse its reader.
- [#1558](https://github.com/Latand/live-log-viewer-next/issues/1558): nonblocking questions across host scheduling/recovery. Reuse its classification and pending-ID retention.
- [#1559](https://github.com/Latand/live-log-viewer-next/issues/1559): per-message frozen profile. Each pending entry retains its submitted profile.
- [#1560](https://github.com/Latand/live-log-viewer-next/issues/1560): idle history context using `thread/inject_items`. It starts zero turns and cannot deliver a queued user instruction that expects a response. Share the final idle/write serialization; add no context button here.
- [#1561](https://github.com/Latand/live-log-viewer-next/issues/1561): diagnostics/auth status. Consume truthful blocked/unknown status without adding recovery heuristics.
- Board workflow design for [#1453](https://github.com/Latand/live-log-viewer-next/issues/1453) / [#1446](https://github.com/Latand/live-log-viewer-next/issues/1446): queue persistence, receipt ingestion and recovery remain above offscreen UI dormancy. This slice adds no board layout, task model or worker grouping.

Respect the existing API lane's serialization order and explicit host/journal/queue file release. The deployment owner retains startup, succession, registry incident repair and `deploy_exact_sha`. This design can be reviewed now; product PRs start only after ownership release. A practical delivery sequence is final idle fence + tick policy, then after-turn composer/receipt projection, then #1225-backed durable editing/cancellation. Full feature acceptance requires all three.

Rollback disables new admissions/affordances while continuing settlement for stored policies and versions. Old binaries that do not understand the policy must hold those records visibly. Never map unknown policy to immediate delivery, delete retained payloads, or clear unresolved operations during rollback.

## Requirement and over-engineering check

The originating request directly justifies both changes. Tick admission covers model work, tools, waits and the observation/write race. After-turn messages preserve a completed current turn, then begin ordinary user turns in order. The existing queue and host ledger carry the work; the UI exposes what those stores can actually establish.

Cut a second persistent queue, native Codex queue adoption, timer-based idle detection, frontend dispatch ownership, a generic event-sourcing layer and a new workflow model. The necessary additions are policy propagation, final host serialization, authoritative eligibility/order projection and safe queued mutation at the existing transaction seam. Independent review should issue WRONG-PREMISE if it changes active-turn input for either protected mode, and OVER-BUILT if it introduces another scheduler/store.

## Deferred — not currently justified

- Arbitrary reorder/drag-and-drop from historical #12: preserve the request for later work; FIFO, stable edit position and cancel cover this September slice.
- Editing or retracting a message after possible engine handover; a separate follow-up is a new user action.
- Automatic cross-conversation retargeting on manager rotation; explicit proven-unsent move is the only supported proposal.
- Native provider queue, active history injection, new append-context composer action, realtime/autonomous-provider compatibility without authoritative serialization evidence.
- Tick cadence/settings changes, proactive ranking changes, retry budgets, automatic stall intervention, account/model fallback, new notification surfaces and board cleanup.
- A new ADR, queue service, database, polling controller, deployment path or benchmark framework.
