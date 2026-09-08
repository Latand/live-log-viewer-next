# Causal verification plan

This is a design acceptance plan. No product tests, provider sends, lifecycle rehearsals or deployment were performed in this stage. Static source analysis and live read evidence are identified in SOURCE-MAP.md. A passing design review must not be reported as working production behavior.

## Isolation and evidence rules

Run only named test files in a disposable isolated state root outside the checkout. Provide private `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, `XDG_DATA_HOME`, `LLV_STATE_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` and `GEMINI_CLI_HOME`; use a short independent `TMPDIR` for Unix sockets. Allowlist environment variables and use synthetic provider fixtures without operator credentials. Match the pinned Bun and lockfile. Preserve existing worktrees and all evidence.

Use the repository's dependency installation and Next guides before implementation. These tests need controlled stdio/socket fixtures; merely importing the queue under a fake HOME does not prove that spawned descendants inherited it. Assert those homes and endpoint paths at the fixture process boundary. Never sweep runtime/registry directories against operator state.

Red controls must fail on the pinned baseline or on an intentionally restored defect, then pass with the focused fix. Use deterministic barriers around reads, reservation, writer claim, provider frame write and response. Do not increase deadlines or rely on sleeps to win a race. Count actual engine writes, interrupts, steers, canonical user inputs and starts separately. Distinguish first-party host fixture proof from live model consumption and production evidence.

## Required race proofs

| Interleaving | Required invariant and counterexample |
| --- | --- |
| Tick observes idle; user turn starts before tick reservation | New tick gets no input claim; user turn continues. Baseline default interrupt-active should produce an interrupt in the integrated red fixture. |
| Tick reserves; active turn appears before queue health check | Drop the proven-unsent tick and retain obligations. A durable queued receipt must not hide the loss of idle admission. |
| Queue reads idle; host changes during capability/history read | After the await, final guard rejects without any write. For user queue, retain same entry and wait; for a tick, close unsent. |
| Two clients claim the idle host before first turn/start response | Only one pending-start reservation succeeds. Different IDs cannot start two turns; same ID joins the same result. |
| Nonblocking request arrives between health read and write | If turn is active, zero protected input. If completed/idle, pending answer remains usable. A blocking request arriving in the same gap refuses input. |
| Completion event belongs to older turn/generation | It cannot release the current queue head. Unknown or contradictory state produces zero input. |
| Tick epoch checked; rotation tries to revoke before write | Shared short authority critical section gives one winner. Revocation first means zero old-seat write; write first retains original receipt ownership. No lock held while awaiting provider response. |
| Edit/cancel reads queued; dispatch claims before mutation | Transaction rejects mutation and returns newest state. Old text reaches host at most once; no replacement version is created. |
| Edit/cancel wins before dispatcher claims | Old operation is durably fenced; dispatch cannot send it. Edited version retains original queue order; cancellation has zero sends. |
| Mutation crashes between registry fence and journal replacement | Recover action winner from original mutation key; no old-version re-admission, no replacement activation before reconciliation, both payloads retained. |
| Write succeeds; response disappears; restart follows | Original operation remains unknown until matching canonical evidence resolves it. Zero second write, zero new operation key from recovery. Later FIFO messages remain blocked. |
| Partial pages omit the original key while writer can still act | Absence stays unknown; zero re-dispatch. A later matching page settles delivered once. |
| Tick becomes unresolved; settings/seat/obligations change | Original payload remains immutable for reconciliation; no fresh tick until original attempt settles. Proven-unsent close permits a newly computed future check. |

These are proposed proof obligations. Current atomicity remains to be established by the implementation. A mocked `health: idle` plus mocked successful `send` cannot establish any of them.

## Slice A — protect ticks at the final host write

Extend these existing targeted tests:

- `src/lib/monitor/seatTick.test.ts`
- `src/lib/monitor/seatTickSources.test.ts`
- `src/lib/monitor/seatTickController.test.ts`
- `src/lib/monitor/seatTickAccounting.test.ts`
- `src/lib/delivery.test.ts`
- `src/lib/orchestrator/seats.test.ts`
- `src/lib/orchestrator/seatCommand.test.ts`
- `src/lib/runtime/structuredDeliveryQueue.test.ts`
- `src/lib/runtime/codexAppServerHost.test.ts`
- `src/lib/runtime/claudeStreamBrokerHost.test.ts`

1. Reproduce the September shape through controller → general delivery → structured admission → queue → real host adapter fixture. Keep a synthetic active turn alive using a tool-wait barrier. The current omitted-policy path must exhibit an interrupt or premature input; then the protected policy must exhibit zero interrupt, steer and user-frame writes.
2. Exercise active sampling, ordinary tools, awaited background work, provider retry, blocking approval, nonblocking question, startup/replay gap, unreadable liveness and contradictory registry/host state. Silence duration never changes the no-write verdict.
3. Race at all three boundaries in the table. Both engine adapters must assert writes from their actual transport fixture, including start-in-flight and duplicate-key joining.
4. Check no wake stamp, event acknowledgment or child harvest advances on refused-unsent dispatch. Confirm only delivered evidence commits accounting. A delayed delivered receipt after UI/registry timeout still settles the original wake once.
5. Exercise outstanding-wake reconciliation, rotation, two tick controllers and restart. A lost response retains original key/payload; a stale wake cannot be replayed merely because the seat later becomes idle. Separate no-actuation cancellation from unconfirmed transport.
6. Preserve the existing dead-host recovery contract only for completed/empty turn evidence. Dead-over-busy and unknown never receive input to force progress.

## Slice B — after-turn user delivery and truthful UI

Extend/add these named tests:

- `src/lib/runtime/commands.test.ts`
- `src/lib/runtime/structuredMessageDelivery.test.ts`
- `src/lib/runtime/structuredMessageDelivery.sqlite.test.ts`
- `src/lib/runtime/structuredDelivery.integration.test.ts`
- `src/lib/runtime/structuredDeliveryController.test.ts`
- `src/lib/runtime/structuredDeliveryQueue.test.ts`
- `src/lib/runtime/structuredRecovery.test.ts`
- `src/lib/runtime/codexAppServerHost.integration.test.ts`
- `src/lib/runtime/claudeStreamBrokerHost.integration.test.ts`
- `src/runtime-host/journal.test.ts`
- `src/components/TmuxComposer.queueFirst.dom.test.tsx`
- `src/components/TmuxComposer.staleKey.dom.test.tsx`
- `src/components/TmuxComposer.afterTurn.dom.test.tsx` — new targeted rendered test.
- `src/components/conversation/outbox.test.ts`
- `src/components/conversation/OutboxBubbles.delivery.dom.test.tsx`
- `src/components/ComposerBar.dom.test.tsx`
- `src/lib/i18n/i18n.test.ts`

1. Submit A and B during an active turn from two clients, using reversed client timestamps. Server order decides. Complete the original turn; only A starts. Complete A; B starts. Verify original IDs, text/images/files, selected context, origin and distinct profile snapshots in canonical evidence.
2. Keep the original turn active with a tool call and then with a validated nonblocking question. Neither releases A. Complete the turn while that nonblocking question remains pending; A may start and the original answer affordance/ID survives. Mixed blocking requests still stop release. These frames must use the #1558 implementation rather than another test-only classifier.
3. Test item-completed, final assistant text, task-completed, provider retry expiry, thread-status idle without matching completion, mismatched generation and missing history as negative controls. Only authoritative completed-turn eligibility releases the queue. Error/interrupted pauses until an explicit Continue queue decision and fresh idle proof.
4. Submit an explicit Send now behind A/B. It may overtake known-unsent pending rows and uses existing interruption behavior. A/B keep their mode/order and wait for the immediate turn's completion. An unknown handover blocks this overtaking; do not bypass it under a new key.
5. Reload/remount after local saving, durable acceptance, dispatch, canonical arrival and terminal delivery. Duplicate identical text with different IDs stays distinguishable. Lost initial response reuses original ID; queue absence, receipt eviction and an old transcript echo cannot clear the new message.
6. Exercise provider disconnect, quota, account migration, runtime restart, confirmed successor binding, ambiguous predecessor, logical manager rotation and pending attachments. Preserve completed prefix and unresolved suffix. Partial recovery starts zero duplicate turns and retains all unresolved blobs.
7. Corrupt/truncate the history page that supplies a successful recovery match; the green recovery case must become unknown and produce zero re-send. Tie each match to thread, turn, key and content/profile snapshot. Native queue dispatch stays disabled.
8. Real rendered controls: selection is visible; keyboard, quick-ack, dictate-submit and Send use the same mode; scroll/focus remain stable as receipts arrive. Capture synthetic desktop and 390 px screenshots, inspect the actual images visually, and exercise edit/cancel status transitions. No OCR. A textual mockup is not rendered evidence.
9. Integrate with the board owner: hide the card during delivery, let the receipt advance, then restore. No hidden UI work beyond the board's budget; shared persistence/reconciliation continues. Reentry must show the new receipt without submitting again. Use production components and preserve the limits of fixture evidence.

## Slice C — durable queued mutation, owned with #1225

Extend these targeted tests, along with journal/queue tests above:

- `src/lib/runtime/http.test.ts`
- `src/lib/runtime/client.test.ts`
- `src/lib/agent/registry.admission.test.ts`
- `src/app/api/runtime/operations/[operationId]/settlement.test.ts`
- `src/app/api/runtime/operations/queue.test.ts` — new bounded projection and revision test.
- `src/components/TmuxComposer.afterTurn.dom.test.tsx`
- `src/components/TmuxComposer.reconciliation.dom.test.tsx`
- `src/components/conversation/outbox.test.ts`

Prove dispatch/edit/cancel races with real SQLite transactions and process barriers. Cover queued-after-attempt, same edit key with altered bytes, duplicate request, stale revision, cancel versus edit, explicit target move, changed attachments and a crash after each cross-store step. An edit creates exactly one new immutable version only after proof of zero old handover; recovery preserves that version's original key. Record old-version tombstone, replacement queueOrder and action winner. A cancelled/replaced version never revives after startup, account migration or a replay of its original enqueue request.

For unresolved outcomes, assert both bytes and recovery controls survive. A UI test that hides an uncertain bubble after Cancel must fail. Verify that current discard-unknown semantics do not acquire the stronger “Cancelled before sending” label.

## Verification scope and release handoff

After relevant targeted tests, run TypeScript checking and the whole-diff privacy gate including commits/untracked files, without a path filter or bypass. Missing dependencies are an environmental failure to resolve, never a passed typecheck. Test artifacts stay outside Git; public fixtures use invented names, paths and payloads.

The existing pipeline supplies a fresh independent design review next. Reviewer checks the original quote, both engines, actual file manifest, safe revision semantics and causal controls. Product implementation later needs its own fresh exact-head review and required CI. Root alone owns deploy_exact_sha and any production acceptance sends. This stage offers no deployment, runtime promotion or live-model-consumption claim.

## Design-stage checks

The five public Markdown artifacts were inspected for source-path existence, relative links, privacy and the writing constraint. The whole-diff privacy gate passed against the inspected merge-base, including untracked files and commit checks, without path filtering or a bypass. It ran with isolated homes/state and short TMPDIR, using the existing parent checkout's gate executable/dependencies. The design worktree has no node_modules; no typecheck or product test is claimed. Git remained unstaged with only the declared design directory added. Private evidence and gate output remain outside Git.
