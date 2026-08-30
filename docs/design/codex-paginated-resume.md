# Codex paginated resume: metadata-only `thread/resume`, descending pages, live host through an oversized ack (issue #301, PR #886)

Design for the final round of PR #886. It is grounded in the branch head at the
time of writing (`2c041958`, the commit the parking note was written against)
and in the app-server protocol installed on the machine (codex-cli 0.149.1).
Stage 2 implements it; this document changes nothing under `src/`.

## Originating requirement (verbatim)

Issue #301, opened 2026-07-15, "Codex runtime: adopt paginated resume and
cursor-based reconnect replay" — the Gap and Acceptance sections:

> Local restart adoption викликає `thread/resume` з повними turns, потім
> відновлює весь власний JSONL ledger у RAM. Delivery confirmation додатково
> робить `thread/read { includeTurns: true }`. Upstream уже має metadata-only
> resume, initial page, backwards cursors та окремі paginated list APIs. Для
> `ThreadHistoryMode::Paginated` full-history resume повертає invalid request.
>
> Довгі threads отримують unbounded startup work, великі response frames і
> повторне сканування історії.
>
> - Thread з paginated history успішно resume-иться після Viewer/runtime-host restart.
> - Startup reads мають documented count/byte bounds незалежно від повної довжини thread.
> - Active turn, recent completed items і delivery IDs відновлюються один раз без дублів.
> - Stale/invalid cursor дає deterministic reset та новий checkpoint.
> - Regression fixtures покривають cold resume, running-thread resume, paginated thread, cursor invalidation, deleted local ledger tail і concurrent attach.
> - Existing `turn/steer expectedTurnId` та delivery idempotency contracts зберігаються.

Issue #301 comment of 2026-08-04 (production evidence: a coordinator session
with a 98 MB / 15,720-line transcript went to a dead host with "Codex
app-server emitted an oversized JSONL frame"). Its "Acceptance worth carrying"
list is what the PR #886 review rounds call **Expected 1–3**:

> - A session whose replay exceeds the frame bound stays reachable and continuable from the board.
> - The diagnostic names the observed frame size, the bound, and the message type.
> - A large session (order 100 MB transcript) can be resumed and messaged; a regression fixture pins the size that currently kills the host.

The parked review (PR #886 comment, 2026-08-25), verbatim:

> - P1 — `src/lib/runtime/codexAppServerHost.ts:2932` — a `thread/resume` frame over the reducer's 64 MiB output budget still rejects adoption, `open()` releases the provisional host, and the same large session stays unreachable on every attempt (violates Expected 1).
> - P1 — `src/lib/runtime/codexAppServerHost.ts:2969` — an oversized `turn/start` / `turn/steer` acknowledgement still calls `fail()` and the test suite requires the dead-host behaviour (violates Expected 1 and 3).
> - P2 — `src/lib/runtime/codexAppServerHost.ts:1008` — the inline-history / unsupported-protocol fallback stack bypasses pagination and can reach full turn pages and `thread/read includeTurns:true`, duplicating the single-frame path this issue removes.

Everything below is validated against these quotes, never against the previous
revision of the branch.

## Where the branch actually is

The three cited line numbers match commit `755eadc1`, the head of review round
four. The branch received one more commit before the lane was parked,
`2c041958` ("recover oversized Codex writes safely"), and that commit already
reworked all three sites. The design therefore starts from an audit of `2c041958`
against the quotes, so stage 2 fixes what is still wrong instead of re-doing
what is done.

| Finding | State at `755eadc1` (reviewed) | State at `2c041958` (branch head) | Residual gap against the quote |
| --- | --- | --- | --- |
| P1 oversized `thread/resume` | `thread/resume` was in `REPLAY_ENVELOPE_METHODS`, so it streamed through the reducer; reducer overflow → `skipOverflowedReducedFrame` rejected the awaiting rpc → adoption failed → `release()`. | `thread/resume` is no longer reduced. A complete or unterminated oversized resume frame reaches `reportOversizedFrame`, which routes a pending `thread/resume` to `recoverOversizedResume` (`thread/read includeTurns:false`, then pages from the newest turn). Test at `codexAppServerHost.test.ts:1589` covers it. | The same failure class survives one layer down: a **page** (`thread/turns/list`, `thread/items/list`) that overflows the reducer's 64 MiB output budget is still rejected by `skipOverflowedReducedFrame` (`:2859`), `collectTurnPagesByView` / `hydrateTurnItems` throw, adoption fails, the host is released, and the attempt repeats on every adoption. Deterministic and size-coupled — exactly what Expected 1 forbids. |
| P1 oversized `turn/start` / `turn/steer` ack | `reportOversizedFrame` called `fail()` for any mutating method. | The host stays alive. The pending rpc rejects with "…outcome is uncertain", `uncertainMutation` closes the writer, and the next `send()` runs `reconcileUncertainMutation` (a descending `thread/items/list` scan for the client id). Tests at `:2173` and `:2203` pin the alive host. | Two truthfulness gaps. (1) The first `send()` rejects, so the delivery queue records a failed attempt for a message that landed; the card shows "not delivered" until a later send happens to reconcile it. (2) `uncertainMutation` is set for **every** method in `MUTATING_RPC_METHODS`; for one without a `clientUserMessageId` (`turn/interrupt`, `thread/realtime/*`, `thread/inject_items`) `reconcileUncertainMutation` throws unconditionally, so the writer never reopens: the card says alive, nothing can ever be delivered. That is a zombie, and it contradicts "continuable from the board". |
| P2 inline-history / unsupported-protocol fallback stack | `resumedTurns()` inline replay, `isUnknownMethodError`, sticky `turnPaginationUnsupported` / `itemPaginationUnsupported`, `scanDeliveryTurnPages` with `itemsView: "full"`, and the `thread/read includeTurns:true` delivery fallback all existed. | All of it is deleted in `2c041958` (the list is under D3). The only `thread/read` calls left are `ensureCanonicalTranscriptPath` (`:1566`) and `recoverOversizedResume` (`:2943`), both `includeTurns: false`. | None in the host. One small leftover: the two metadata reads are two copies of the same block. |

## Protocol ground truth

Source: `codex app-server generate-json-schema --experimental --out <dir>` from
codex-cli 0.149.1 (the `v2/` bundle). Field descriptions are quoted from the
schema; nothing below is taken from memory.

| Method / type | Fact from the schema |
| --- | --- |
| `thread/resume` params | `excludeTurns`: "When true, return only thread metadata and live-resume state without populating `thread.turns`. This is useful when the client plans to call `thread/turns/list` immediately after resuming." Also `initialTurnsPage`: "When present, include a `thread/turns/list` page in the resume response so clients can bootstrap recent turns without a second request." `permissions` is the named profile id. |
| `thread/resume` response | required `thread`, `cwd`, `model`, `modelProvider`, `approvalPolicy`, `approvalsReviewer`, `sandbox`. Optional `turnsBackwardsCursor`: "Opaque cursor for hydrating paginated turns backwards. Pass this as `cursor` to `thread/turns/list` with `sortDirection: "desc"`. The first page includes the turn identified by the cursor." Optional `itemsBackwardsCursor`, same wording for `thread/items/list`. |
| `Thread` | `turns`: "Only populated on `thread/resume`, `thread/rollback`, `thread/fork`, and `thread/read` (when `includeTurns` is true) responses." `status` is required and is one of `notLoaded` / `idle` / `systemError` / `active {activeFlags}`. `historyMode`: enum `legacy` \| `paginated`, default `legacy`. `path` is "[UNSTABLE] Path to the thread on disk." |
| `thread/turns/list` | params `threadId`, `cursor` ("Opaque cursor to pass to the next call to continue after the last turn."), `limit` (uint32, "Optional turn page size."), `sortDirection` (`asc` \| `desc`, "defaults to descending"), `itemsView` (`notLoaded` "items was not loaded for this turn. The field is intentionally empty." \| `summary` \| `full` "every ThreadItem available from persisted app-server history for this turn"; defaults to summary). Response `{ data: Turn[], nextCursor, backwardsCursor }`. |
| `thread/items/list` | params `threadId`, `cursor`, `limit`, `sortDirection` ("defaults to ascending"), optional `turnId` filter ("When omitted, returns items across the thread."). Response `{ data: entries with turnId + item, nextCursor, backwardsCursor }`. |
| `thread/read` | params `threadId`, `includeTurns` ("When true, include turns and their items from rollout history."). Response `{ thread: Thread }` — with `includeTurns: false` the frame is thread metadata only, and it still carries `status` and `path`. |
| `turn/start` | response `{ turn: Turn }`; `clientUserMessageId` is a request param. |
| `turn/steer` | response `{ turnId }`. |
| `turn/interrupt` | response `{}`. |
| `thread/start` | accepts `historyMode`. Not sent by the host today. |

Two things the schema cannot say, taken from the issue's upstream links: a
thread whose `historyMode` is `paginated` rejects a full-history resume as an
invalid request, so `excludeTurns: true` is the only resume that works for
such a thread; and running-thread resume bootstraps the cursors from the live
thread. Both push in the same direction as this design.

JSON-RPC serialization detail the host already relies on (`REPLAY_RESPONSE_PREFIX`,
`:350`): a response frame begins `{"id":N,"result":` or `{"id":N,"error":`,
so the first 2 KiB of any oversized response reveal both the request it answers
and whether it is a success or a failure. The design below leans on that.

## Decision

Three decisions, one per finding. The default answer to "build more" was no;
each one is the smallest mechanism that satisfies the quoted requirement.

### D1 — `thread/resume` is metadata-only; history arrives in descending pages within the frame budget

This is what `2c041958` does. The design keeps it and removes one flag.

Adoption sequence in `open()` (`:878`–`:940`), with the byte/count bound of each read:

1. `initialize`, `account/read`, `model/list`, `config/read` — unchanged.
2. `thread/resume { threadId, permissions?, config, excludeTurns: true }`.
   The consumed fields are `thread.id`, `thread.path`, `thread.status`,
   `turnsBackwardsCursor`, `itemsBackwardsCursor`. The frame is thread
   metadata; it is never passed through the reducer. A returned id different
   from the requested one aborts adoption (existing check).
3. `thread/turns/list { itemsView: "notLoaded", sortDirection: "desc", limit: 10, cursor }`
   starting at `turnsBackwardsCursor` (inclusive of that turn per the schema),
   following `nextCursor` until it is `null`. Each page is at most ten `Turn`
   records without items. Ceiling `MAX_RESUME_TURN_PAGES = 4096` (40,960 turns);
   past it adoption fails with a named error.
4. `thread/items/list { sortDirection: "desc", limit: 10, cursor }` starting at
   `itemsBackwardsCursor`, following `nextCursor` until `null`. Each page passes
   through `CodexReplayFrameReducer` with the existing budgets: ordinary strings
   16 Ki units, image data URLs 24 MiB + 64, reduced output 64 MiB, raw input
   512 MiB, then `shrinkReducedReplayFrame` down to `MAX_LINE_BYTES`
   (24 MiB + 256 KiB). Ceiling `MAX_RESUME_ITEM_PAGES = 65,536` (655,360 items).
5. Collected turns are reversed into chronological order, items attached per
   turn (`itemsView: "full"` on the assembled record), and the existing
   `rememberConfirmedDeliveries` → `restoreEvents` → `reconcileThreadHistory`
   → `reconcileAfterOpen(threadStatus(resume), resumedActiveTurnId(history))`
   chain runs unchanged.

Why descending: the newest page carries the active turn (`status: inProgress`)
and the most recent `userMessage.clientId` values, so the active-turn fence and
delivery idempotency are correct after page one, and the delivery scan
(`scanDeliveryItemPages`, `:2360`) can stop at the first hit. The resume
cursors anchor the snapshot at resume time; anything that happens after is
delivered by live notifications and reconciled through the existing
pre-restore buffer.

Options considered and rejected:

- `initialTurnsPage` on `thread/resume`. It puts a page back into the resume
  frame, which is the coupling this issue removes, and it creates a second
  code path for "first page" versus "next page". One page loop is enough.
- `thread/turns/list` with `itemsView: "full"`. A turn page's size is the sum
  of its items, so the count bound stops being a byte bound. Items are paged
  by item count instead.
- `thread/items/list` filtered by `turnId` per turn. One rpc per turn instead of
  one per ten items, and the resume response hands out a thread-wide items
  cursor for exactly this purpose.

Change to `2c041958`: drop `oversizedResumeRecoveryPending` (`:768`, `:986`,
`:2951`). A resume result with no `turnsBackwardsCursor` pages once from the
current newest turn with no cursor; an empty thread answers with an empty
page and the flag's only job disappears. The recovery path (D2-resume below)
then needs no side channel into `collectResumedTurns`.

### D1-overflow — a page over the reducer budget must not make the session unreachable

This is the residual P1. Rule:

1. `skipOverflowedReducedFrame` rejects the awaiting page rpc with a **typed**
   error (`OversizedResponseError { method, observedBytes }`) instead of a bare
   `Error`, so the page loops can tell "this page cannot be admitted" from
   "the server failed".
2. On that error the page loop re-requests the **same cursor with `limit: 1`**.
   A single turn record cannot overflow; a single item overflows only if its
   images alone exceed 64 MiB after string capping.
3. If the single-element page still overflows, hydration **stops descending at
   that point**: the turns and items collected so far (all newer than the
   overflow) are reconciled as usual, the diagnostic item is emitted
   (Expected 2 wording: observed bytes, bound, message type), and adoption
   completes. Older history is still in the local event ledger, which
   `restoreEvents` loads in full regardless; what is lost is ledger-gap
   reconciliation for turns older than the overflow, and the transcript says
   so.

The delivery scan uses the same iterator, so a retry after a lost ack still
finds a recent client id in the newest pages and falls through to "not
persisted" (start a turn) only when the overflow sits above it. That is the
documented bound: "one persisted item whose bounded reduction exceeds 64 MiB"
is outside the supported envelope, and the host says so instead of dying.

Rejected: raising `REPLAY_STREAM_OUTPUT_UNITS`, or a second reduction pass with
smaller image caps. Both add budget knobs to defend a shape (tens of MiB of
inline images in one tool result) that has not been observed; the limit-1
retry plus a loud stop is the smaller mechanism, and it degrades to a
readable, continuable host.

### D2 — an oversized mutating acknowledgement keeps the host alive; the outcome comes from the events the host already consumes

Observation that makes this small: `send()` never resolves on the rpc ack
alone. Every delivery ends in `awaitDeliveryConfirmation` (`:1204`, `:1236`),
which resolves only when a `userMessage` item carrying the entry's
`clientId` is observed — live via `item/completed` (`:3211` →
`rememberConfirmedDelivery`) or from persisted pages on a retry
(`confirmedDelivery` → `scanPersistedDeliveries`, `:2338`). The ack contributes
one fact: the turn id. So an oversized ack is a delivery whose turn id is
late, and the confirmation path already handles that.

Rule, applied in `reportOversizedFrame` and `send()`:

| Oversized frame | Envelope head | What happens |
| --- | --- | --- |
| response to `turn/start` | `"result"` | The pending rpc rejects with `OversizedResponseError`. `send()` catches it and enters `awaitDeliveryConfirmation(entry, { outcome: "turn-started", turnId: pending })`; `turn/started` sets `activeTurnId` as it does today (`:3187`), and `rememberConfirmedDelivery` fills the receipt's turn id from the `item/completed` params. The send resolves `{ outcome: "turn-started", turnId }`. |
| response to `turn/steer` | `"result"` | Same, with `{ outcome: "steered", turnId: currentTurn }` — the steer target is known before the rpc. |
| response to `turn/start` / `turn/steer` | `"error"` | The server refused; nothing started. The send rejects with the diagnostic. The queue's existing retry runs `confirmedDelivery` first, so a duplicate turn is impossible even if the head was misread. |
| response to `turn/interrupt`, `thread/realtime/*`, `thread/inject_items`, `thread/compact/start` | any | The caller rejects with the diagnostic (plus "outcome is uncertain" for the mutating ones). The writer stays open: an interrupt's outcome is the `turn/completed { interrupted }` notification the host already handles, and the realtime/persona paths have their own uncertain-outcome fences on the notification deadline. |
| response to `thread/resume` | `"result"` | `recoverOversizedResume` as in `2c041958`, through one shared `readThreadMetadata()` (the `thread/read includeTurns:false` probe that `ensureCanonicalTranscriptPath` already performs). The recovered `Thread` supplies `path` and `status`; history then pages from the newest turn (D1). |
| response to `thread/resume` | `"error"` | Adoption fails with the diagnostic. The server refused the resume; there is nothing to keep alive. |
| response to `thread/start` | any | Adoption fails with the diagnostic (a fresh thread with an unknown id cannot be adopted). Unchanged; not a resume concern. |

Consequences:

- The operator sees the delivery move from pending to delivered once, with the
  real turn id, and a `[viewer diagnostic] Codex app-server emitted an
  oversized JSONL frame: observed N bytes, bound M bytes, message type
  response to turn/start; …` item in the transcript. No false "not delivered"
  attempt, no dead card, no zombie.
- The `uncertainMutation` field, `reconcileUncertainMutation`, the
  `allowUncertainDeliveryReconciliation` parameter on
  `writerFenceAllowsActuation`, and `PendingRpc.clientUserMessageId` are
  deleted. They re-implemented, behind a writer fence, the idempotency scan
  that `confirmedDelivery` already performs on every send.
- The delivery-confirmation timeout (`deliveryConfirmationTimeoutMs`, 5 min,
  `:2401`) remains the backstop for a confirmation that never arrives. It
  predates this PR and applies to every delivery equally; changing its
  `fail()` policy is out of scope (Deferred).

Rejected: keeping the fence (`2c041958`). It is correct only for acks that
carry a client id, reports a landed message as failed, and is a second
reconciliation mechanism beside the one every ordinary delivery uses.

### D3 — fallback paths that stay deleted

`2c041958` removed the following; stage 2 keeps them out and adds a regression
pin that adoption plus a send never issue `itemsView: "full"` or
`thread/read includeTurns: true`:

- `resumedTurns()` — inline `thread.turns` / `initialTurnsPage` reader.
- `isUnknownMethodError()` and the sticky `turnPaginationUnsupported` /
  `itemPaginationUnsupported` fields.
- `collectTurnPagesByView(cursor, "full")` and the `itemsView` parameter.
- `scanDeliveryTurnPages()` (`itemsView: "full"` delivery scan).
- The `thread/read { includeTurns: true }` delivery fallback and
  `ACTIVE_THREAD_READ_TIMEOUT_MULTIPLIER`.
- `thread/resume` and `thread/read` in `REPLAY_ENVELOPE_METHODS`.

Not a fallback, kept: `recoverOversizedResume`. It reads no history; it
re-reads the same metadata the resume was supposed to return and then takes
the one hydration path. Also kept, outside this lane: the reducer for
`thread/turns/list` / `thread/items/list` pages and for `turn/completed` /
`item/completed` notifications, and `scheduleOversizedCompletionReconciliation`
(tests at `:2005`, `:2090`, `:2132`).

## Operator-visible state, end to end

| Situation | Card / transcript |
| --- | --- |
| Large session adoption (any size) | Status follows `thread.status` from the resume; history reconciled from pages; no diagnostic. |
| Resume frame oversized (server ignored `excludeTurns`) | One diagnostic item naming the size, bound, and `response to thread/resume`; status from `thread/read`; history from pages; send works. |
| A page overflows the reducer | Limit-1 retry; if still over, one diagnostic item and adoption completes with history newer than the overflow reconciled. Status truthful; send works. |
| Oversized `turn/start` / `turn/steer` success ack | Delivery resolves with the real turn id when the user item is observed; one diagnostic item. |
| Oversized error ack | That delivery attempt fails with the diagnostic; the queue retries through the idempotency scan; other deliveries unaffected. |
| Oversized ack for interrupt / realtime / inject | That operation rejects with the diagnostic; deliveries unaffected. |

Diagnostics are capped at `MAX_OVERSIZED_FRAME_DIAGNOSTICS = 8` per host
(existing) so a pathological stream cannot flood the transcript.

## Tests mapped to Expected 1–3

All in `src/lib/runtime/codexAppServerHost.test.ts` unless noted. "RED at
head" means the test fails against `2c041958` before the stage-2 change, which
is the RED-verify the pipeline requires; "exists" means it passes today and is
kept as a pin.

Expected 1 — replay over the bound stays reachable and continuable:

- exists `an overflowing thread/resume replay recovers metadata and paginates history` (`:1589`); add: exactly one `thread/read`, with `includeTurns: false`.
- exists `a session past the size that killed the host resumes through pages and takes a message` (`:1800`).
- exists `an oversized notification frame is skipped with a surfaced diagnostic and the host survives` (`:1968`), `an unterminated oversized tail buffer is discarded to the next newline and the host survives` (`:2306`), `an oversized response that no request is awaiting is skipped and the host survives` (`:2229`).
- RED at head `an item page over the reducer output budget is retried one item at a time and adoption completes` — fake: a page whose reduced form exceeds 64 MiB when `limit` is 10 and fits when it is 1 (three items each carrying a 24 MiB data-URL string does it); assert one `limit: 1` request, no dead host, all items in the ledger, send → `turn-started`.
- RED at head `a single item still over the reducer budget ends hydration with a diagnostic and adoption completes` — fake: one item over 64 MiB after capping; assert the diagnostic text contains the observed bytes, the bound, and `response to thread/items/list`, that turns newer than it are reconciled, that adoption does not throw, and that send works.
- RED at head `an oversized turn/start acknowledgement resolves the delivery from the persisted user item` — rewrite of `:2173`: the **first** `send()` resolves `{ outcome: "turn-started", turnId: "turn-1" }`, exactly one `turn/start` was issued, a following steer works.
- RED at head `an oversized turn/steer acknowledgement resolves as steered without a duplicate steer` — rewrite of `:2203`: first `send()` resolves `{ outcome: "steered", turnId: "turn-1" }`, one `turn/steer`.
- RED at head `an oversized error acknowledgement rejects the delivery and leaves later deliveries writable` — entry X gets an oversized `error` envelope → rejects with the diagnostic; entry Y → `turn-started`.
- RED at head `an oversized turn/interrupt acknowledgement leaves deliveries writable` — `interrupt()` rejects with the diagnostic; a following `send()` succeeds. Pins the zombie-writer gap.

Expected 2 — the diagnostic names size, bound, and message type:

- exists: the `oversized JSONL frame.*observed \d+ bytes, bound \d+ bytes, message type` assertions in the tests above; the two new overflow tests assert the same shape for page responses.

Expected 3 — a large session is resumed and messaged; a fixture pins the size:

- exists `:1800` asserts `JSON.stringify(turns).length > MAX_APP_SERVER_LINE_BYTES` and then sends. Keep the assertion on the exported bound so a change to the bound cannot silently shrink the fixture below the production shape.
- exists `:1589` sends after an oversized resume.

P2 regression pin (no fallback regrows):

- GREEN at head, new `adoption and delivery never request full turn pages or full thread reads` — over a full adopt → send → retry flow, assert no `thread/turns/list` with `itemsView: "full"` and no `thread/read` with `includeTurns: true`. Existing partial assertions at `:1613`, `:1914`, `:1932` fold into it.

Removed with the fence: any expectation that a first send rejects with
"outcome is uncertain" for a `result` envelope. The fake's `rejectFullTurnPages`
knob stays: `:1773` uses it to prove the host never asks for a full turn page,
which is the P2 pin.

Test runs: by path, under isolated `HOME` / `XDG_CONFIG_HOME` / `LLV_STATE_DIR`
/ `TMPDIR`; `codexAppServerHost.test.ts`, `codexAppServerHost.compact.test.ts`,
`codexAppServerHost.pluginGrant.test.ts`, `codexImageFrames.test.ts`. No
directory sweeps.

## File list (stage 2)

| File | Change |
| --- | --- |
| `src/lib/runtime/codexAppServerHost.ts` | `OversizedResponseError`; typed rejection in `skipOverflowedReducedFrame` and `reportOversizedFrame`; limit-1 retry and stop-with-diagnostic in the shared page iterator used by `collectTurnPagesByView`, `hydrateTurnItems`, `scanDeliveryItemPages`, `reconcilePersistedTurn`; `send()` catches the typed error and routes into `awaitDeliveryConfirmation`; pending receipt turn id filled at confirmation; delete `uncertainMutation`, `reconcileUncertainMutation`, `writerFenceAllowsActuation(allow…)`, `PendingRpc.clientUserMessageId`, `oversizedResumeRecoveryPending`; one `readThreadMetadata()` shared by `ensureCanonicalTranscriptPath` and `recoverOversizedResume`. Net expectation: fewer lines than `2c041958`. |
| `src/lib/runtime/codexAppServerHost.test.ts` | Tests listed above; fake app-server gains an "oversized page at limit > 1" knob and an oversized-`error`-envelope knob for `turn/start`, `turn/steer`, `turn/interrupt`. |
| `src/lib/runtime/codexAppServerHost.compact.test.ts` | Only if the typed error changes a message a compact test matches. |
| `docs/design/codex-paginated-resume.md` | This document. |

Not touched: `src/lib/runtime/engineHost.ts` (the `DeliveryReceipt` union is
unchanged), `src/lib/runtime/codexImageFrames.ts` (`ReplayFrameOverflowError`
already exists), `src/lib/accounts/codexAppServer.ts` (see Deferred).

## Over-engineering pass

Machinery in `2c041958` that is heavier than the problem, and what replaces it:

| Cut | Why | Simpler mechanism |
| --- | --- | --- |
| `uncertainMutation` + `reconcileUncertainMutation` + fence parameter + `PendingRpc.clientUserMessageId` | A second reconciliation path beside `confirmedDelivery`; wrong for acks without a client id (zombie writer); reports a landed message as failed. | Route the send into `awaitDeliveryConfirmation`; let the existing `item/completed` / persisted-page scan supply the outcome. |
| `oversizedResumeRecoveryPending` | A flag whose only purpose is to make a null cursor mean "page anyway". | Null cursor pages once from the newest turn; an empty thread returns an empty page. |
| Duplicate `thread/read includeTurns:false` blocks (`:1566`, `:2943`) | Same rpc, same id check, two copies. | One `readThreadMetadata()`. |
| A per-method "server ignores excludeTurns" fallback | Not needed: the oversized-resume recovery is method-agnostic (it keys on the pending rpc, not on a capability flag). | Nothing to add. |

Kept after the pass, with the reason:

- The reducer for page responses and completion notifications: one item can
  legally exceed the line bound (issue #638 shape), and the alternative is the
  single-frame kill this issue removes.
- `retryOnceOnInvalidCursor`: the issue's acceptance names a deterministic
  reset on a stale cursor; the retry restarts from the current newest turn
  with no side effects.
- `MAX_RESUME_TURN_PAGES` / `MAX_RESUME_ITEM_PAGES`: ceilings, documented above.
  They bound the loop, not the thread; see Deferred for the read-count concern.

No ADR: none of these decisions is hard to reverse. Each is a code path that a
later change can replace without migrating state or protocol.

## Validation against the quotes

- Expected 1: an oversized resume frame → metadata re-read + pages; an
  oversized page → limit-1 retry, then a loud stop with adoption completing;
  an oversized ack → delivery resolved from the user item. In every case the
  host stays reachable and a send works. No path calls `fail()` on frame size.
- Expected 2: the single diagnostic string (`oversizedFrameDiagnostic`, `:527`)
  carries observed bytes, bound, and message type; every oversized path emits
  it, including the new page-overflow stop.
- Expected 3: the `:1800` fixture pins a replay above `MAX_APP_SERVER_LINE_BYTES`
  and messages the host afterwards; the `:1589` fixture does the same after an
  oversized resume.
- Issue acceptance: paginated thread resumes (D1 is the only resume shape a
  paginated thread accepts); active turn, recent items, and delivery ids
  reconcile once (descending pages, `itemReplayKey` dedupe, first-hit stop);
  stale cursor resets deterministically; `turn/steer expectedTurnId` and
  delivery idempotency are untouched. Fixture coverage for concurrent attach
  and the deleted-ledger tail is pre-existing (`:2567`, `:1526`).

## Deferred — not currently justified

Moved out of scope, with the trigger that would justify each:

- **Ledger-gap-bounded hydration.** Startup reads today scale with the thread
  (every turn and item is paged, then reconciled against the ledger). The
  issue's bullet "documented count/byte bounds independent of the full thread
  length" would be met by stopping the descent at the first turn whose
  terminal event the ledger already holds — reads then scale with what
  happened while the host was down. Deferred because it changes ledger
  reconciliation semantics (`reconcileTurnHistory` currently repairs partially
  recorded turns anywhere in history) and Expected 1–3 do not require it.
- **`historyMode: "paginated"` on `thread/start`.** The host would then only
  ever create threads that reject full-history resume. Justified once the
  rest of the Viewer's Codex clients (accounts migration) are page-based.
- **`src/lib/accounts/codexAppServer.ts:348` `readThread` with
  `includeTurns: true`.** It reads only `id` and `path`, so the flag costs a
  full-history frame for nothing; a one-line flip to `false`. Outside this
  lane's fence (the protocol seam does not require it) and outside P2, which
  is about the host. Candidate follow-up issue.
- **Durable cursor checkpoint** (issue adapter item 2) and **lifecycle
  alignment with `thread/unsubscribe` / `thread/loaded/list`** (item 6). No
  observed failure needs them; the resume cursors are re-obtained on every
  adoption.
- **Mutating-rpc timeout policy.** `rpc()` still calls `fail()` when a
  mutating method times out (`:2622`), and `awaitDeliveryConfirmation` fails
  the host after `deliveryConfirmationTimeoutMs`. Both predate this PR and are
  about time, not frame size.
- **`initialTurnsPage`.** Saves one round trip per adoption; adds a second
  page source. Not worth a code path.
