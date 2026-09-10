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

Reads are pushed, not polled. Native's `thread/queue/changed` reaches the host,
the host publishes a revision counter on the runtime bus, and the panel refetches
when the counter moves — so a dispatch Codex made on its own appears as fast as
one the operator made.

Writes are admissions. Every control POSTs one command with its own immutable
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
| withdrawn | send now, and only while idle | native no longer holds it; an explicit idle start is its one route |
| delivered | none | it is history, kept until the journal drops it |

`send now` carries the fence the runtime requires: an explicit `null` on an idle
thread and the exact active turn otherwise, taken from the session projection so
the panel never guesses a turn id. Starting the queue is offered only from an
idle thread with something in it and a queue that was actually read.

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
message. The draft clears and the status line says it was handed over the moment
the journal admits it — not that Codex has queued it, which is what the panel
says once Codex acknowledges. A refused admission gives the draft back.

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

A tool call gets the card the operator was looking at only when the ledger can
show that card belongs to that caller's own backing work. Two edges have to hold.

**Utterance to handoff** is the browser's, because it is the only peer that sees
both the transcript boundary and the handoff event. They share no identifier on
the wire, so the association is a fact in exactly one arrangement: one utterance
outstanding, one handoff arriving for the first time. Anything else — two
outstanding, or a canonical identity this call has already reported — is
published as an ambiguity, and it stands for the rest of the call, because every
unattributed utterance may still produce a handoff. The earlier client dropped
its queue and carried on, which let a later handoff look unambiguous and attach
one turn's work to another turn's card.

**Handoff to work** is the request's. Installed Codex carries its backing turn
identity on every MCP request in `params._meta["x-codex-turn-metadata"]`, read
off the transport rather than the arguments, so the reader answers about one turn
rather than about the conversation:

- a turn that has claimed a card keeps it through later utterances, a hangup and
  a reconnect. An accepted operation is frozen;
- a turn that has claimed none may claim one only when exactly one unclaimed join
  exists, nothing is ambiguous, and no newer spoken turn is still waiting for its
  own handoff;
- a turn native did not start from the call — no `turn_trigger` — never claims
  anything, which is what keeps a later typed request from inheriting the card;
- a caller that can prove no backing turn is refused by name rather than handed
  the conversation's latest card.

Retention is bounded by work, never by a clock. An accepted join survives a
hangup because the work it started does; it is retired when the host says that
turn finished, or — for a spoken turn no tool call ever claimed — when the thread
is observed going idle after the join, since native routes a handoff into a
running turn. The ten-minute window this replaces both discarded work that was
still running and left a finished call's card available to unrelated turns.

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
stage used for admission: with the queue at its admission bound, a control press
paints its own row inside 250 ms, and handing a draft to the queue clears the
composer inside 250 ms with the transport deliberately never answering.

## Limits

No live provider call was made for any of it. What is established is protocol and
context behaviour against installed Codex and the real Viewer code; real-provider
audio, spoken model quality, and whole-call behaviour over a long live call
remain unverified and need an authorized capture on a real account.

For a native turn carrying more than one handoff, the metadata has no finer
discriminator, so implicit selection stays refused there. Closing that needs an
acceptance receipt native does not emit today; the upstream seam and what a live
capture would have to record are in `native-voice-work-identity.md`.
