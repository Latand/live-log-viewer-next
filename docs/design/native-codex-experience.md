# Native Codex: the queue the operator touches, and reliable Voice

The experience half of #1629, on top of the runtime integration in
`native-codex-runtime.md`. That stage owns admission, dispatch and the journal;
this one owns what the operator sees and does, and the Voice repairs the
independent review of the component branch required.

The reference is Codex CLI 0.154.0 and the native app's 0.153.4 protocol. Native
work identity, its limits, and what a future authorized live capture would need
are recorded in `native-voice-work-identity.md`.

## The queue is Codex's

Codex holds the queued messages, decides when the next one goes, and can
dispatch one the moment a turn ends without asking anybody. The panel above the
composer is a view of that queue rather than a plan for it:

- rows are the Viewer journal's — it knows about a mutation the queue has not
  acknowledged yet — and the ORDER is Codex's, read from the native snapshot;
- a row says which of the two it was seen in. An entry the journal holds and the
  queue does not is neither delivered nor gone: a disappearance settles nothing,
  and the row says "waiting for Codex to acknowledge it" instead of guessing;
- an entry leaves the panel when the journal settles it.

Reads arrive by push. Native's `thread/queue/changed` reaches the host,
the host publishes a revision counter on the runtime bus, and the panel refetches
when the counter moves — so a dispatch Codex made on its own appears as fast as
one the operator made.

Every write is an admission. Every control POSTs one command with its own immutable
idempotency key and returns when the journal commits; the runtime's executor
remains the single dispatch owner and the browser adds no second scheduler. The
row goes busy until the next read shows what happened, and a 202 whose receipt
says `rejected` is a failure — the HTTP code says the request was understood, the
journal's receipt is the verdict.

Nothing is retried from the panel. A change whose outcome is unknown keeps its
original operation and key, and its row says so rather than offering a button
that would be a second attempt at something nobody has the result of.

### What each control may do

| Row state | Controls | Why |
| --- | --- | --- |
| queued, acknowledged | edit, remove, move, send now | it has a native submission id to name |
| queued, not acknowledged | none | update/delete/send-now all name that id |
| dispatching, or with a dispatched revision | none | the payload became a turn and is fixed |
| uncertain | none | the runtime holds the original; a second mutation would be a blind retry |
| withdrawn | start, and only while idle | native no longer holds it; the journal admits no other action on it |
| delivered | — | it has left the panel; the message is in the transcript |

`send now` carries the fence the runtime requires: an explicit `null` on an idle
thread and the exact active turn otherwise, taken from the session projection so
the panel never guesses a turn id. Starting the queue is offered only from an
idle thread with something in it and a queue that was actually read, and it names
no entry at all — native's own `ThreadQueueStartParams.queuedSubmissionId` is
nullable, and a start without one dispatches the head of the queue.

The panel shows the queue and nothing behind it. The journal retains up to 128
settled entries so a reader can see what happened to them; a delivered message is
in the transcript, where the operator reads it, so it leaves the panel when the
journal settles it and the header counts what Codex may still dispatch.

Reorder names native submission ids and nothing else, so an entry Codex has not
acknowledged cannot take part; when the native snapshot is stale the panel says
so and offers no reorder at all, because an order that may already be wrong must
not be submitted as the intended one.

### Settings, honestly

Native's queue parameters carry no model or effort. A queued message runs on the
thread's settings at the moment Codex dispatches it, which is what
`profilePolicy: "thread-at-dispatch"` records. So each row says what it will run
on — the thread's own settings — and, when the operator had asked for something
else, says that separately as a request. There is no frozen queued profile,
because the protocol has none.

## The composer's two submissions

Enter still sends, and a Codex send still interrupts the running turn. That is
the operator's stated preference and nothing here changes it.

Beside it: **Alt+Enter**, and the same entry in the send menu, hands the draft to
Codex's queue. It goes to the queue route rather than through the composer's own
outbox, because putting it through both would be a second scheduler for one
message. The draft clears and the status line says it was handed over as soon as
the press is made, before the journal has answered — the composer is empty for
the next thing the operator types rather than frozen on a round trip. That is a
statement about the hand-off. Whether Codex has queued it is a separate fact,
and the panel says that once Codex acknowledges. A refused admission gives the
draft back, attachments and all.

**A hand-off whose reply never arrives keeps its whole envelope.** The journal
hashes a command behind its idempotency key and refuses a key whose payload
changed, so recovery is the envelope or it is nothing: the key, the exact command
— text, attachments, requested runtime, selected card — and the thread and
account it was admitted against are written BEFORE the request leaves, which is
what makes a reload or a navigation while it is still in flight recoverable. The
next press of the same message replays that one operation, and the journal
answers a replayed key with the operation it already holds, so Codex receives the
message once whether or not the first request landed. An account switched in
between does not move the message: the original binding is replayed and the
runtime either accepts it or refuses it, where rebinding would be neither.

A reply is only an answer when it identifies what it settled. The journal answers
with the operation it committed and a receipt status it knows; a 202 carrying an
empty body, no receipt status, a status this build has never heard of, or a
receipt for a different operation is UNKNOWN, and the operation keeps its
identity. Sending a different message afterwards does not settle the earlier one
either — unresolved hand-offs are listed above the queue, separately from the
messages Codex is holding, with one control that sends the stored envelope again.
Nothing resends on its own: native owns dispatch and this is a presentation
record; it is no second scheduler. The same rule governs every queue control, so a
row whose change had no answer replays that change rather than admitting a new
one.

Attachments ride the same road an ordinary send takes: the composer stages bytes,
the queue route admits and content-addresses them, and the command carries refs.
A refused attachment refuses the whole admission with the reason.

The queue survives a reload because it was never the browser's.

**Steering is explicit and refused early.** The send menu offers "steer the
running turn" only where the host advertises steering, and only while a turn is
running; the choice rides on the durable outbox entry, so a replay after a reload
asks for the same thing instead of silently becoming an interrupt. Claude's
broker advertises no steering, so the entry is absent there rather than admitting
an operation that fails later — which reads to the operator as a message lost
rather than never accepted.

## Voice: which work may read the spoken card

**None of it, on installed Codex 0.154.0.** Automatic selection needs two edges
and `native-voice-work-identity.md` establishes that neither is available, so
implicit voice-selected targeting is non-actionable and every spoken turn gets a
typed refusal that names the missing edge.

**Utterance to handoff** is the browser's to observe, because it is the only peer
that sees both the transcript boundary and the handoff event. They share no
identifier on the wire. The client still reports what it saw, and still refuses
to guess when two utterances are outstanding — that evidence is worth keeping —
but a report that only ONE was outstanding is arrival order, and the native
report defers "one-outstanding-utterance order" by name as permission to select a
card. A late handoff can still belong to earlier speech.

**Handoff to work** is not established at all. Installed Codex carries its
backing turn identity on every MCP request in
`params._meta["x-codex-turn-metadata"]`, read off the transport rather than the
arguments — but native steers more than one handoff into one backing turn, so
`turn_id` names the work and cannot name the utterance the work came from. No new
tool call inherits an operation merely by sharing its native turn.

So the reader classifies and refuses, and the refusals stay distinct because the
next move differs: there is no call; the call has reported no card; this request
proves no backing turn; the turn is not the call's at all; the client reported an
ambiguity; or — the ordinary one — the call points at a card and nothing ties it
to this request. It never hands out a card on evidence that cannot carry one.

What still works, and is the supported route from a spoken turn: explicit
`conversationId` and `selectedContext` targeting, the bound-view and context
tools, and the immutable context of an operation that was already admitted, which
travels with that operation's own key through recovery rather than through this
reader. The ledger keeps recording what each call was told, because the panel and
the control endpoint read it as evidence; only automatic target selection is
refused.

Retention is bounded by work, never by a clock. A record survives a hangup
because the work it started does, and is retired when the thread is observed
going idle after the handoff was accepted, since native routes a handoff into a
running turn. There is no per-record turn verdict to use instead — which turn a
handoff was routed into is the very edge native does not report. The ten-minute
window this replaces both discarded work that was still running and left a
finished call's card available to unrelated turns.

Closing this needs an acceptance receipt native does not emit today; the upstream
seam and what a live capture would have to record are in
`native-voice-work-identity.md`.

## The spoken model's operating protocol

The persona the spoken session runs is this repository's own wording, and it
carries the functional protocol the installed app's fallback prompt implements:
the user's speech and the backing agent's messages both arrive as user-role text
and are told apart by `[USER]` and `[BACKEND]`, so an update is never fed back as
a fresh request; a backend message may be intermediate and the completion to rely
on is the tool return; a clearly self-contained conversational turn is answered
directly while anything uncertain still goes to the agent; and pacing, detail and
update-frequency preferences set for a task hold across later backend updates
until the task ends or the operator changes them. What is not adopted is that
prompt's identity or its instruction to conceal the arrangement.

## The canonical transcript reaches the browser

`thread/realtime/transcript/*` and `thread/realtime/item/*` are reduced into
runtime events, carried over the runtime bus with every other session event, and
merged into the panel beside what the WebRTC data channel delivered. A segment is
addressed by native's own item id where there is one, so a redelivered frame, a
`done` completing its own deltas and a replay after reconnect converge on one
line; a line the data channel already streamed is adopted by the committed text
rather than duplicated. A call whose data channel says nothing still shows what
the backend committed.

## The panel never claims an agent it cannot reach

The WebRTC leg runs to the provider, so a backing host that was interrupted,
replaced or killed leaves the call sounding perfectly alive. Two signals now
contradict it: a worker answer that fails to deliver (previously swallowed in
silence), and the runtime's own host axis. Both paint a distinct row — separate
from the transport error, which is a different failure — and both clear when the
link works again.

## Verification

`bun scripts/verify-native-codex-runtime.ts <absolute-codex-binary>` runs the
named runtime, queue, history, status, MCP and Voice checks, then the browser
half in its own process (each of those installs its own document over the same
globals, so they cannot share one). CI runs the same script.

`bun run build && bun scripts/capture-issue-1629-queue-panel.ts` renders the
panel in a real browser against the build's own stylesheet and measures what the
DOM tests cannot: that the controls are reachable and inside the panel, that a
row which cannot be changed offers none and says why, that a refusal is legible
and distinct from an ordinary row status, and that the panel stays inside its
width. It then reintroduces each of those defects in the page and fails if the
reading still holds.

Responsiveness is measured on the same production-shaped fixture the runtime
stage used for admission, at 128 rows: the number the journal keeps. The
journal's own admission bound is 2000, which no panel is expected to hold. A
control press commits the row's busy state inside 250 ms and handing a draft to
the queue clears the composer inside 250 ms, both with the transport deliberately
never answering. These are `act()` measurements in happy-dom: what they catch is
a render gone quadratic or an accidental await on the transport, not paint
timing, which no DOM harness observes.

## Limits

No live provider call was made for any of it. What is established is protocol and
context behaviour against installed Codex and the real Viewer code; real-provider
audio, spoken model quality, and whole-call behaviour over a long live call
remain unverified and need an authorized capture on a real account.

Implicit voice-selected targeting is non-actionable on this native version, for
every spoken turn including one with a single outstanding utterance: neither the
utterance-to-handoff nor the handoff-to-work edge is established, and cardinality,
arrival order and `turn_trigger` are deferred by name as permission. Explicit
targeting and the context tools are unaffected. Closing it needs an acceptance
receipt native does not emit today; the upstream seam and what a live capture
would have to record are in `native-voice-work-identity.md`.

The spoken persona ports the installed app's operating protocol from a source
reading. No reproduced live-model failure stands behind it, no real-provider call was made,
and nothing here is evidence about spoken audio quality.
