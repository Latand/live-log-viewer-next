# Issue-ready brief for root

Proposed title: **Idle-only seat ticks and explicit after-turn user message delivery**

Canonical discovery was read-only. No exact open umbrella issue was found in the bounded searches recorded in SOURCE-MAP.md. Do not create duplicates of existing queue, terminalization, nonblocking-question or board work. Root can create one narrow requirement issue after rechecking current discovery, linking the dependencies below. This stage did not create, update, reopen or close any GitHub issue.

## Problem and originating request

On September 8 at 04:54 UTC, the operator requested that ticks arrive only when the orchestrator is truly idle, and that their own messages can be queued until the current turn completes. A tick was admitted during that request; the transcript records an interrupted turn immediately before the tick's arrival. Current main routes a tick through the general delivery path whose structured admission defaults to interrupt-active. The composer also explicitly uses interrupt-active even though it first queues locally.

The exact historical pre-check state remains unproven. The product requirement is clear: protected sends must cause zero interruption, steering or provider input while the current turn is active, including tools, waits and the gap between observation and final dispatch.

## Proposed scope

- Reuse the existing structured queue, reservations, runtime journal, engine ledgers and outbox.
- Give ticks an explicit idle-only policy with final host/generation/seat admission. Drop proven-unsent stale ticks; preserve owed work and reconcile uncertain attempts under their original keys.
- Give the composer visible After this turn and Send now choices. After-turn uses FIFO server order, one new message/turn at each authoritative completed boundary. Send now explicitly interrupts current work.
- Show saving, queued, sending, accepted/verifying, delivered, paused and unknown truthfully. Keep target/order/payload/profile visible and durable across clients, reload, hidden cards, restart and rotation.
- Complete safe durable edit/cancel with #1225's existing transaction/arbitration owner. A new edit version is allowed only after proof the old version could never actuate. Transport recovery always retains the relevant version's original key. No optimistic recall of attempted/unknown messages.
- Preserve approvals and validated nonblocking questions, partial delivery and original-key canonical recovery.

## Existing owners and exclusions

| Issue/plan | Relationship |
| --- | --- |
| [#1245](https://github.com/Latand/live-log-viewer-next/issues/1245) | Historical tick requirement/design; closed, with subsequent corrections. Preserve cadence/accounting while enforcing September idle-only intent. |
| [#12](https://github.com/Latand/live-log-viewer-next/issues/12), [#151](https://github.com/Latand/live-log-viewer-next/issues/151), [#561](https://github.com/Latand/live-log-viewer-next/issues/561) | Existing queue persistence, host transport and queue-first presentation. Reuse and extend. |
| [#1225](https://github.com/Latand/live-log-viewer-next/issues/1225) | Existing canonical owner for race-safe pending operation mutation. Some primitives already exist on main; finish proof and queued-edit behavior there. |
| [#1557–#1561 plan](https://github.com/Latand/live-log-viewer-next/pull/1562) | Reviewed API research; serialized implementation owns history, questions, profiles, context and diagnostics. Reuse its scheduling/recovery facts. |
| [#1453](https://github.com/Latand/live-log-viewer-next/issues/1453), [#1446](https://github.com/Latand/live-log-viewer-next/issues/1446) | Existing board/workflow owners; preserve offscreen queue persistence and truthful shared state. |
| [#1197](https://github.com/Latand/live-log-viewer-next/issues/1197) | Existing recovery-delivery test obligation; share coverage where applicable. |

Exclude a second queue framework, native provider queue, append-context UI, board cleanup/layout, tick settings, account fallback and deployment work. Arbitrary reorder remains a deferred historical request. No product implementation is authorized by the design artifact itself.

## Acceptance and handoff

Require the paired red/green transport and concurrency cases in ACCEPTANCE.md, both engine adapters, fresh review and truthful browser examples. Recheck the exact target SHA and file manifest before implementation. Serialize shared host/journal/queue work after the deployment owner and API lane release the files. Root retains all production release authority.

Design artifacts: `docs/design/idle-turn-delivery/{README,SOURCE-MAP,UX,ACCEPTANCE,ISSUE-BRIEF}.md`. The architect's private evidence remains outside Git. The current pipeline's next stage performs independent review; no helper was launched by the design stage.
