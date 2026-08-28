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
engine-agnostic path `POST /api/tmux` and `send_message_to_orchestrator` use —
and its recovery of a dead structured conversation is a success, not a failure.

Four limits travel with the decision and are not separable from it:

1. **Never a creation.** A wake resumes a host for a seat that already exists. A
   project with no active seat gets the `no-seat` verdict: a journal line and one
   idempotent board card, and nothing is spawned.
2. **Never a stale seat.** The seat epoch is re-read immediately before the send.
   A seat revoked or rotated between the decision and the send is refused, the
   refusal is journaled, and no wake is recorded as having happened.
3. **Never a wake that did not land, and never one that outlives its seat.**
   Resuming a host makes "the send was accepted" and "the seat has the message"
   two different facts, so only the second counts. A delivery the layer parked
   behind an account migration (`held`), left with the runtime (`queued`,
   `delivering`) or has not routed at all (`pending`) does not advance the wake
   stamp and does not advance the lifecycle event cursor — an acknowledged event
   is never offered again, so acking one before it landed is how a rotation
   loses the lane event its successor needed. The next check re-raises the same
   wake under the same `clientMessageId`, which makes the retry a replay rather
   than a second copy.

   A payload the layer kept is also durable, so limit 2 alone would not hold it:
   the epoch can move while the message waits, and the wake would then arrive at
   a predecessor. Every retained wake is therefore recorded against the epoch it
   was raised for and revoked — at once if the rotation landed during the send,
   otherwise by the next check, which is why the record survives the rotation
   that clears the rest of the row.
4. **Never more often than the wake interval, for any reason.** One
   project-scoped 60-minute bound, with no environment override, no exempt
   reason kind — a terminal lane event leads the next wake instead of raising an
   early one — and no reset when the seat rotates. The bound is what makes the
   cost below a number rather than a hope, so a reason allowed to jump it would
   be a decision to reopen this ADR, not an implementation detail.

#741's rule stands unchanged for #741's own runs; nothing here edits it.

## Consequences

The cost is real and bounded. A wake can boot a host that the retirement sweep
reclaimed minutes earlier, so the two can trade a host back and forth: worst
case one resume per project per wake interval (60 minutes, limit 4) for as long
as work stays open and the seat stays idle between wakes. That is the intended
loop rather than a leak — retirement reclaims what is not needed, the tick
brings back what is — and the wake interval is the bound on how often the trade
can happen. Retirement's own predicate still refuses every host that owes
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
