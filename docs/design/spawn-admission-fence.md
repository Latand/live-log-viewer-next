# The spawn admission fence, and what recovery may conclude from it

A launch dispatched through the MCP `spawn_agent` tool carries a downstream key
derived from the caller's `clientRequestId`. When the dispatch is interrupted —
the host dies, the connection resets, the answer is unreadable — the caller
recovers that exact key rather than launching again. Recovery may report only
what durable state can prove:

| what durable state holds | recovery reports |
| --- | --- |
| a launch receipt for the key | `accepted` / `in-flight` / `settled` |
| an admission fence whose digest is the bound request | `not-executed` |
| neither | `unknown` — execution remains possible |

`unknown` is the safe answer and it never decays into `failed`. A bare HTTP 400,
or the current absence of a conversation, proves nothing about what the server
did before it answered: only the fence does.

## Every pre-reservation refusal writes the fence

`POST /api/spawn` refuses a number of requests before it reserves anything.
Recovery cannot distinguish "refused before reservation" from "reserved and then
lost" unless each of those refusals leaves a request-bound compare-and-set fence
behind. Issue #1641 was one refusal that did not: a reviewer launch naming no
`reviews` answered 400 and wrote nothing, so its owner's key stayed `unknown`
indefinitely and the reviewer could be neither recovered nor safely relaunched.

Two branches reach that same refusal, and both fence:

- **Role resolution, then the mandatory reviewer contract.** Viewer control
  calls (the MCP dispatch and its recovery probe alike) present a same-origin
  marker, so this is the branch a tool-dispatched launch takes.
- **The agent lineage refusal**, for a request that arrives without that marker
  — an agent calling the endpoint directly with its own spawn capability. It
  fires earlier, on the same missing field.

`mandatoryReviewsError` in `src/app/api/spawn/admission.ts` is the single
predicate behind both, and `/api/spawn/validate` — the endpoint recovery probes
— applies it too. A validator that calls a launch admissible while the route
refuses it is the drift that made this unrecoverable; sharing the predicate is
what prevents it returning.

## The caller is authenticated before any fence is written

A fence is terminal for its key. An unauthenticated caller must never be able to
burn a key that belongs to someone else, so both paths establish the caller
before the first refusal that fences. `/api/spawn` still defers its 403 until
after validation, so a stranger learns the ordinary refusal and nothing more —
it simply writes no fence while doing so. `/api/spawn/validate` answers the
stranger 403 outright.

Precedence is unchanged, and the compare-and-set enforces it under the account
lock:

- A launch receipt that already owns the key wins: no fence is written, and the
  refusal reports `fenced: false`, which keeps recovery at `unknown`.
- A fence already held for the key with a **different** request digest is a
  conflict: the refusal reports `fenced: false`, and a later reservation on that
  key answers 409. A corrected launch uses a new key.

## Recovering a stranded launch

1. The owning caller replays its recovery with the **unchanged** original
   arguments and the original `clientRequestId`. Any changed field produces a
   different digest, which the fence contradicts, and the answer stays
   `unknown`.
2. A `not-executed` outcome with evidence `spawn-admission-fence` is
   authoritative: nothing was launched, and the reason names the refusal.
3. Only then may a corrected launch go out, under a **new** key, with the field
   the refusal named.
