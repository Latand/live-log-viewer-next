# Review round 1 — agent questions UI (CHANGES REQUIRED)

Adversarial review of the uncommitted implementation of
`docs/specs/2026-07-04-agent-questions-ui.md` in this worktree. All findings
were verified against the code. Fix every blocker and major; fix minors unless
a minor conflicts with a blocker fix (then note why). The spec remains the
contract — where a finding cites a spec section, re-read that section before
fixing.

## Blockers

1. `src/app/api/answer/route.ts:75-106` — Spec step 3 is not implemented: no
   arrow navigation, no highlight re-verification before Enter, no waiting for
   the screen to advance between questions — just blind number keys with fixed
   sleep(150/350). Violates Decisions log #3 ("Keystrokes are never fired
   blind") and makes the Feature 6 "prompt UI drift" guarantee (502 with screen
   tail on highlight mismatch) impossible. Concrete case: plan approval
   hardcodes "1"/"2" (line 81), but Claude Code's ExitPlanMode dialog has three
   options (reject is 3, option 2 is a "yes" variant), so «Відхилити» can
   approve the plan. Multi-select relies on number keys toggling where the
   spec mandated arrow+Space with per-toggle verification. Fix: implement spec
   4.3 — capture pane, navigate, re-capture and match the highlighted label
   against the intended option before every Enter, abort with screen tail on
   mismatch.

2. `src/app/api/answer/route.ts:76-86` — Plan rejection with a comment
   delivers the wrong answer: the free-text branch at line 76 catches any
   non-empty body.text and returns early, so the reject-keystroke branch never
   runs (its comment handling at line 82 is dead code). QuestionCard.tsx:112
   sends { approve: false, text: comment }, so reject-with-comment pastes the
   comment into the approval dialog and presses Enter — submitting the
   highlighted option, typically "Yes" → the rejected plan gets approved. Fix:
   for kind "plan", send the reject keystroke first and deliver text via
   sendText only after the composer returns.

3. `src/app/api/answer/route.ts:132-136` — Step-2 screen verification is
   decorative: the fallback regex `/Approve|Reject|Затвердити|Відхилити|Yes|No|\d\./i`
   has no word boundaries, so any screen containing "no" (note, know…), "yes",
   or digit-dot passes. The strict needle almost never matches: an 80-char
   question slice breaks across wrapped, box-bordered TUI lines, and the plan
   needle is the literal "ExitPlanMode", which never appears on screen. Net:
   keystrokes can fire into arbitrary pane content — the exact failure step 2
   exists to prevent (spec 4.2, Feature 6). Fix: match a short unwrappable
   fragment (normalize whitespace on both sides) and drop the loose fallback;
   mismatch must 409.

4. `src/lib/push.ts:59-67` — Web Push never delivers: the VAPID JWT is signed
   with Node's default DER-encoded ECDSA signature (70 bytes at runtime) but
   ES256 requires 64-byte IEEE P1363, so every push service rejects it with
   401/403. sendPush (line 81) treats 401/403 as success and notifyQuestion
   marks the toolUseId as sent — the notification is lost permanently and
   silently, violating spec 5 (silent degradation is allowed only for the
   no-HTTPS case). Fix: `sign.sign({ key, dsaEncoding: "ieee-p1363" })`; only
   mark sent / keep subscriptions on 2xx.

## Major

5. `src/lib/push.ts:70-82` + `public/question-push-sw.js:1-9` — Push carries no
   payload; the SW hardcodes generic text and url "/". Spec 5 requires agent
   name/engine, question header or «план на затвердження», and deep link
   `/{session}#question`. Needs aes128gcm payload encryption (RFC 8291) with
   Node crypto — no new dependencies.

6. `src/lib/scanner/questions.ts:68-101` — "Last assistant message" condition
   weakened to "newest unanswered tool_use anywhere in the 128 KB tail". A
   question abandoned without a tool_result (user pressed Esc and continued;
   later assistant messages exist) resurfaces as pending indefinitely, and
   /api/answer step 1 treats it as pending too. Fix: stop at the first
   assistant record from the end; pending only if that record is the tool_use.

7. `src/components/LogFeed.tsx:232` + `QuestionCard.tsx:8,81-87` — Card-state
   machine breaks on consecutive questions and omits `superseded`.
   QuestionCard is not keyed by toolUseId: when question A is answered and B
   arrives before an unmount, the card stays in "answered" showing A's label —
   B is unanswerable from the UI. A 409 renders as `failed`; spec requires a
   superseded collapse showing the answer that actually happened, and the
   server never extracts the real answer (actualAnswer at route.ts:35-37 is a
   constant string). Fix: key={pending.toolUseId}, add superseded state, read
   the recorded tool_result in step 1 and return it in the 409 body.

8. `src/components/feed/QuestionCard.tsx:21,95` — Feature 6 "no pane" card is
   missing and its guard unreachable: hasPane = pid !== null && proc ===
   "running", which are preconditions for pendingQuestion to exist, so it is
   always true; a lost pane only surfaces as repeated 409s. Implement the
   read-only card with «відкрити сесію» reusing resumeSpecFor (the server must
   report pane availability, e.g. resolveTarget result, alongside
   pendingQuestion or via the 409 body).

9. `src/app/api/answer/route.ts:152-162` — The in-flight lock fails to
   serialize ≥3 concurrent requests: waiters B and C both await A's promise
   and then both run deliver() concurrently (C never re-reads the lock B
   installed) → duplicate keystrokes. Fix: chain onto the stored promise
   (`locks.set(key, previous.then(run))`).

10. `src/components/Viewer.tsx:105-127` — The "toast on new pending question"
    re-arms on every poll for the first waiting file, with no seen-set, no
    baseline on load, and no dismissal other than opening the session. Fix:
    track notified toolUseIds; toast only on first observation; add a dismiss
    control.

## Minor

11. `src/lib/push.ts:84-98` — notifyQuestion runs under Promise.all with
    unsynchronized read-modify-write of push-sent.json and
    push-subscriptions.json: last writer wins. Serialize writes (module-level
    promise chain is enough).
12. `src/lib/push.ts:85` — waitingInput push has no 60 s debounce (spec 5):
    fires at ~15 s; the minute-bucketed id is dedupe, not debounce, and a
    flapping screen re-pushes every minute. Debounce: push only when
    waitingInput has been continuously true ≥ 60 s.
13. `src/lib/tmux.ts` READY_MARKERS + `waitingInput.ts:17` — "Context \d+%
    used" (Codex footer) added to READY_MARKERS and tested against the whole
    screen: if Codex draws that footer during an approval prompt, the fallback
    never fires for Codex — its primary target. Test the tail only.
14. `src/app/api/answer/route.ts:108-116` — confirmAnswered runs the full
    listFiles() pipeline every 500 ms for up to 10 s; spec says poll the
    transcript. Poll pendingQuestionFor against a fresh stat/tail-read of the
    one transcript.
15. `QuestionCard.tsx:34-44` — waitingInput card omits the spec's elapsed time
    (`since` delivered but unused); the Feature 6 killed-agent collapse «агент
    завершився» is not rendered — the card just vanishes.
16. `QuestionCard.tsx:163-167` — multiSelect «Надіслати» enabled with zero
    selections → server sends no keystrokes → guaranteed 10 s wait + 502.
    Disable the button at zero selections.
17. `src/lib/scanner/waitingInput.ts:14` — probes map never pruned for dead
    processes/panes; grows for the server's lifetime.
18. `ARCHITECTURE.md` — no documentation added for
    questions/waiting-input/answer/push flows; add a section.

## Root cause to internalize

The delivery pipeline's safety layers (screen verification, highlight
verification, comment ordering) were replaced by timing assumptions, and the
push channel was never validated against a real push service's requirements.
Restore the verify-before-act discipline everywhere.
