# K6c: messages survive a successful account switch (#1695, #1709)

Status: implemented in the K6c pull request, on top of K6b (#1708, merged as f1396da9). Its tests were written
against the failing behaviour first; the pull request lists them with their red checks.

K6 requires that a conversation switched to another account keeps what the operator sent. Before K6c it did not.

## What happened before

`commitSuccessor` (`src/lib/agent/registry.ts`) committed a switch and, in the same transaction, failed every
pending delivery of the conversation, emptied its text and settled its owner `lost` (or `unverified` for an
uncertain one), with "its owning account migration committed; send again". Nothing reached the successor, and
the text was gone.

Before 96007ed5 (PR #759, "bound stale intents and cancel held input"), commit re-assigned `held` deliveries to
the successor. PR #759 replaced that without a recorded reason. The operator's decision for K6c: an account
change keeps the conversation going, and a message that provably never left is not sent again by hand.

## Evidence the design relies on

- **One claim, before any command.** `attempts` is incremented only in `beginDeliveryAttempt`, which moves the
  delivery to `delivery-uncertain`. It refuses while a migration is in flight, and every actuator calls it
  before its command:
  - structured send (`enqueueStructuredMessage`);
  - legacy send (`deliverConversationMessage`);
  - migration drain (`drainHeldDeliveries`);
  - runtime HTTP retry.
- **No uncertain row at commit.** A `delivery-uncertain` delivery blocks the successor from starting
  (`successorCreationReady`), so none is pending at commit.
- **Journal identity.** The journal deduplicates a command by conversation and idempotency key, with its request
  hash, so a carried delivery keeps its original identity.
- **Serializable admissions.** Registry mutations are serializable: the SQLite store reruns a mutation whose read
  revision moved, and the JSON store holds its write lock.
- **Old records keep unknown fields.** `normalizeHeldDelivery` spreads the stored record, so the code this builds
  on (f1396da9) keeps a field it does not know when it rewrites a record.

## Contract

### At commit (`settleDeliveriesAtCommit`, in the commit's own transaction)
Each pending delivery gets exactly one decision (`commitDeliveryDecision`).

**Carry.** A delivery is carried when all of these hold:
- it is unattempted: `attempts` is 0, it has no materialized artifact, and no retry attempt points at it;
- it belongs exactly to this conversation: its `conversationId` and `runtimeConversationId` are the committing
  conversation;
- this switch owns it:
  - a `held` delivery passes `migrationHeldDelivery`: its fence names the committing migration, or it is a legacy
    record admitted after that migration's own conversation intent began;
  - an `assigned` delivery is assigned to the predecessor generation;
- its own owner row exists, and no owner row that points at it has an outcome.

A carried delivery moves to the successor as `assigned`, with its text, images, command (operation id, kind,
policy, turn id, origin), client message id, digests, attempts and admission order unchanged. Its owner stays
unsettled, and the ordinary drain delivers it.

**Excluded.** Owned by this switch, but not delivered automatically. Each ends `failed` with its payload kept and
a specific reason:

| Case | Why | Disposition, receipt |
| --- | --- | --- |
| `attempted`: attempts > 0, an artifact, a retry attempt, or uncertain | it may have reached the previous account | `unverified`, "verify-first" |
| `turn`: a string `command.turnId` under a policy other than `interrupt-active` | the queue delivers it only into that turn, which belonged to the previous account | `lost`, "safe" |
| `inject`: `command.kind` is `inject` | injected context is never held across a switch (#1560) | `lost`, "safe" |
| `requestLocal`: an `ephemeral-*` payload | only the sending client holds its bytes | `lost`, "safe" |

A `turnId` under `interrupt-active` only names the turn to interrupt, and the queue delivers the message at idle
without it, so such a message is carried.

**Leave.** Nothing proves this switch owns the delivery, so it stays exactly as it is:
- its identity is another conversation's (an alias);
- its fence names another operation;
- it is a legacy held record without proof;
- it is assigned to an older generation;
- its owner row is missing or already settled.

### Order
- **The sequence.** `HeldDelivery.admissionSeq` (additive and optional) is assigned in the transaction that
  creates the reservation, as the highest sequence among the canonical conversation's records plus one. A replay
  keeps its record and sequence.
- **`compareDeliveryAdmission`.** Sequenced records order by sequence. A record without one was written before it
  existed: it orders before every sequenced record, and among such records by `createdAt`, then id, as before.
  `pendingDeliveries`, and so the drain, use this order.
- **Rollback.** Code before K6c creates records without a sequence, and they order by the legacy rule. It keeps
  the sequence on records it rewrites, because its normalizer spreads the stored record. A record created by old
  code during a rollback therefore orders before sequenced records that are still pending when K6c returns.

### No overtaking
- **The gate.** `beginDeliveryAttempt` refuses a claim while an earlier-ordered delivery of the same conversation
  is `assigned` to the same generation. Every actuator already handles a refused claim:
  - the structured and legacy sends requeue the delivery and answer `held`, and the migration tick they request
    delivers it in order;
  - the drain skips it until its turn;
  - the HTTP retry answers 503 retryable.
- **The section.** A claim is not yet a delivery: the command reaches the journal afterwards, and the journal
  keeps arrival order. So each actuator claims and hands over its command inside `withConversationActuation`, a
  per-conversation section:
  - it spans the structured send from its claim to the journal's answer;
  - it spans the drain from each claim through its delivery;
  - it spans the whole legacy send;
  - it spans the retry from its claim through its re-admission.

  A later send waits in the section until the earlier command is admitted, then passes the gate, because the
  earlier row is no longer `assigned`.
- **Not gating.** An uncertain delivery does not gate a claim, and nothing is replayed. An earlier held or
  older-generation delivery does not gate one either (see the limitations below).

### Explicit recovery, as it behaves today (unchanged by K6c)
- **Receipts.** `message_receipt` and `sendReceiptFor` answer "safe" for an excluded delivery that was never
  attempted (`lost`) and "verify-first" for one that may have been delivered (`unverified`).
- **The same key again.**
  - A `lost` record with the same payload is placed again: the same record and operation are re-armed to the
    current generation and delivered through the ordinary path.
  - An `unverified` record stays failed.
  - A new key is a new message, ordered after everything before it.
- **Nothing automatic.** Nothing re-arms an excluded record. The composer outbox waits on a held send's receipt
  and never replays it locally.
- **Retention.** The kept text lives on the failed record until terminal-delivery compaction removes it.

### Picker
While a recorded switch waits, the picker shows two notes:
- "Messages sent now are held and delivered after the switch, in the order they were sent. Cancel delivers them on
  the current account instead."
- "Not carried: a message bound to the current turn, injected context, or attachments only the sending browser
  holds. Each ends failed with its reason, keeps the text the Viewer holds for it, and its receipt says whether
  sending it again is safe."

## Release limitations
- **Deliveries a committed switch cannot attribute stay as they are.** This covers legacy held records without
  proof, a fence naming another operation, older-generation assignments, and missing or settled owners. They are:
  - never failed, deleted or cleaned up silently, and not delivered;
  - still counted toward the conversation's limit of 100 pending deliveries;
  - still keeping a rolled-back block from clearing (K6b).

  They do not gate new sends: only an `assigned` delivery of the same generation does. Recovery is an explicit
  send.
- **Ordering holds within one Viewer process.** During a deploy's overlap, two Viewer processes can each actuate
  the same conversation.
- **A crash between a claim and its journal admission** leaves an uncertain delivery that gates nothing. A later
  send can reach the journal before it; journal reconciliation settles the uncertain one, and it is never
  replayed.
- **The runtime host's startup continuation** for an interrupted Codex turn is a system message with no
  reservation, and is not ordered by this.
- **An excluded delivery that was attempted** keeps its failed record even if its earlier journal command is
  later confirmed delivered. That is the existing cancellation contract; its receipt says "verify-first".

## Scope
- `registry.ts`: sequence, admission order, the claim gate, and the commit decision.
- `contracts.ts`: the optional `admissionSeq`.
- `intentLiveness.ts`: the not-carried reasons.
- `deliveryActuation.ts`: the section.
- The section is wired into `structuredMessageDelivery.ts`, `coordinator.ts`, `delivery.ts` and `runtime/http.ts`.
- The picker notes (en, uk).
- Tests that pinned commit-time cancellation now pin carrying:
  - `registry.reseat`;
  - `structuredMessageDelivery.accountReseat`;
  - `structuredDelivery.integration`, whose production port now writes the message once to the successor's
    engine.

  The K6b cancel fixture attempts its earlier message first.
- No runtime host protocol change. No real account switch in any test.
