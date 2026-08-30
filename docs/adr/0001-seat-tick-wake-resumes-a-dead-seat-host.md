# ADR 0001 — The seat tick's wake resumes a dead seat host

- Status: accepted
- Date: 2026-08-28
- Issue: #1245 (PR 1 of 2)
- Reverses: the delivery rule established for the conversation monitor in #741

## Context

The conversation monitor (#741) delivers its report to the project's
orchestrator and treats a delivery that had to resume a dead host as a **failed
run**. That rule is right for what #741 does: its job is to observe and report,
so booting a session in order to be heard is a side effect out of proportion to
the errand, and it means the monitor cannot tell "the orchestrator read this"
from "the orchestrator was created to read this".

The seat tick (#1245) has the opposite job. It exists because a seat with open
work stopped being woken at all — a session-scheduled monitor died with its
session, so every rotation dropped it and the incoming seat had no tick.
Meanwhile automatic structured host retirement (#747, #1237) reclaims hosts that
have gone idle, and an orchestrator between operator messages is exactly the
host that looks idle. If the tick refused to wake a reclaimed seat, the two
mechanisms would compose into a system that quietly stops working: retirement
reclaims the idle seat, the tick declines to disturb it, and the board sits.

## Decision

**A seat tick wake resumes the seat's host when it is dead.** The delivery goes
through `deliverConversationMessage` by durable conversation id — the same
engine-agnostic path `POST /api/conversation-host` (legacy alias `/api/tmux`)
and `send_message_to_orchestrator` use — and its recovery of a dead structured
conversation is a success, not a failure.

Five limits travel with the decision and are not separable from it:

1. **Never a creation.** A wake resumes a host for a seat that already exists. A
   project with no active seat gets the `no-seat` verdict: a journal line and one
   idempotent board card, and nothing is spawned.
2. **Never a stale seat.** The seat epoch is re-read immediately before the send.
   A seat revoked or rotated between the decision and the send is refused, the
   refusal is journaled, and no wake is recorded as having happened.
3. **Never a wake that did not land, and never one that outlives its seat.**
   Resuming a host makes "the send was accepted" and "the seat has the message"
   two different facts, so only the second counts. A delivery the layer parked
   behind an account migration (`held`), left with the runtime host (`queued`,
   `delivering`) or has not routed at all (`pending`) does not advance the wake
   stamp and does not advance the lifecycle event cursor — an acknowledged event
   is never offered again, so acking one before it landed is how a rotation
   loses the lane event its successor needed. A structured host makes this
   unavoidable rather than incidental: it admits *every* send as `queued`,
   whether the seat is idle or mid-turn, so the send's own answer can never say
   whether the seat got the message.

   Which is why the retained wake is recorded against the layer that is actually
   holding it — the runtime host operation for a send it queued, the Viewer's
   own reservation for a hold that never reached a host — and every later check
   asks that layer one question: is this still yours? Three answers, and both
   halves of the accounting come out of them:

   - **Still holding it.** Nothing moves. The next check re-raises the same wake
     under the same `clientMessageId`, which makes the retry a replay rather
     than a second copy.
   - **Delivered it.** The wake landed, and it is credited then, with the stamp
     and the cursor the check that raised it wrote down. Without this the hourly
     bound in limit 4 would be bypassed by every wake that was delivered and
     never observed.
   - **Settled it unsent.** Nobody was woken, so no stamp moves and the wake is
     owed again.

   A payload the layer kept is durable, so limit 2 alone would not hold it: the
   epoch can move while the message waits, and the wake would then arrive at a
   predecessor. So when the epoch under a retained wake moves, the wake is taken
   back out of that same layer — the runtime host's operation is failed, which
   completes the outbox row the drain would have delivered from. A revocation
   recorded anywhere else is one the delivery path ignores, which reproduces the
   defect this ADR is about rather than preventing it. The withdrawal happens at
   once if the rotation landed during the send, otherwise at the next check,
   which is why the record survives the rotation that clears the rest of the row.

   And when the holder has already let the payload go — the drain has it, or has
   delivered it — that is recorded as exactly that (`too-late`) rather than as a
   successful revocation. The Viewer cannot recall a message an engine has
   already been given, and that residue is real: in that narrow race a replaced
   seat may read one wake. What the mechanism owes there is to say so, on the
   line where the withdrawal is recorded, instead of reporting a revocation that
   did not happen — and to record nothing about it as a wake the project
   received, so the successor is still owed everything the message carried.
4. **Never more often than the wake interval, for any reason.** One
   project-scoped 60-minute bound, with no environment override, no exempt
   reason kind — a terminal lane event leads the next wake instead of raising an
   early one — and no reset when the seat rotates. The bound is what makes the
   cost below a number rather than a hope, so a reason allowed to jump it would
   be a decision to reopen this ADR, not an implementation detail.
5. **Never two tickers for one seat.** Limit 4 bounds a project, so it holds
   only while one process is ticking it; two overlapping clocks would double
   every number below. Two refusals hold it, and neither is a lock. A second
   start inside one process is refused out loud and journaled. And one process
   is not one process for ever — a deploy promotes a successor beside a
   predecessor that is still running with its timer armed — so every sweep
   re-asks whether this release still owns viewer traffic, which is the durable
   fact both processes read. A release that has been replaced refuses the
   sweep, records the lost authority where the line outlives the process that
   wrote it, and stops its own clock. A cross-process lock is deliberately
   absent: it would be a second, weaker answer beside the authority both
   processes already read, and a stale one would silence the tick outright.

#741's rule stands unchanged for #741's own runs; nothing here edits it.

## Amendment (2026-08-29, issue #1275): limit 4 is a default, and the project sets it

Limit 4 above says the 60-minute bound has "no environment override". That
sentence also says a reason allowed to jump the bound "would be a decision to
reopen this ADR, not an implementation detail". This is that decision, and it
was the operator's.

What limit 4 was defending is intact: nothing in a deployment, an environment
variable or a wake reason can change how often a project is woken. What changes
is that the project itself can. A durable per-project settings row
(`state/seat-tick-settings.json`) carries whether the tick wakes that project at
all and, when it does, the interval it waits out. A project with no row runs on
the 60 minutes above — every project did, until someone decided otherwise — so
nothing has to be configured for the tick to work, which is the property the
original "no configuration" wording was protecting and the only one it was
protecting.

Three things keep the amendment from turning the cost argument below into "it
depends":

- **A change is an explicit act with a reason on it.** The reason is required
  whenever the settings leave the default, it is stored on the row, and it is
  shown on a board card for as long as the setting stands. A tick that has gone
  quiet with nothing saying why is indistinguishable from a tick that broke.
- **A quiet tick keeps checking.** Only the WAKE is suppressed. The check runs,
  reads the board and writes its journal line, so the difference between "off"
  and "broken" is legible in the artifact that outlives every process.
- **Nothing else moved.** No exempt reason kind, no environment override, no
  reset on rotation, and the stamp still belongs to the project. The bound the
  cost argument uses is now the project's own number rather than a constant, and
  the number is on the record with the name of whoever set it.

Cross-project reach is deliberately NOT refused: a seat may set another
project's tick, and what answers for that is attribution — the row, the card and
the journal all name who changed whose tick — rather than a validation that
decides in advance which uses are legitimate.

## Consequences

The cost is real and bounded. A wake can boot a host that the retirement sweep
reclaimed minutes earlier, so the two can trade a host back and forth: worst
case one resume per project per wake interval (60 minutes, limits 4 and 5) for
as long as work stays open and the seat stays idle between wakes. That is the
intended loop rather than a leak — retirement reclaims what is not needed, the
tick brings back what is — and the wake interval is the bound on how often the
trade can happen. Retirement's own predicate still refuses every host that owes
anything, so a resumed seat is never reclaimed mid-turn.

The benefit is that "the tick survives rotation" and "hosts do not accumulate"
stop being in conflict. Neither mechanism has to know about the other.

## Alternatives rejected

- **Refuse to wake a dead host, card it instead.** Preserves #741's rule, and
  reproduces exactly the failure #1245 was filed for: a seat with open work that
  nothing wakes, and a board card nobody is watching because the agent that
  would watch it is the one that is asleep.
- **Exempt seats from host retirement.** Makes the seat a permanently resident
  host per project. Retirement exists because 65 live hosts on one machine made
  spawning fail; carving out an exemption trades a bounded resume for an
  unbounded residency, and it would have to be re-argued for every future
  long-lived role.
- **Wake only a live host, and let a dead one wait for the operator.** Puts a
  human in the loop of the mechanism whose entire purpose is that no human has
  to configure or restart it.

## Revisit when

Host resumes attributable to the tick exceed roughly one per project per wake
interval in the seat-tick journal (`state/seat-tick/runs.ndjson`, delivery
outcome `resumed`), or the retirement report starts showing seats reclaimed and
resumed inside the same sweep interval. Either would mean the wake interval is
no longer the bound this decision assumes it is.
