# Review round 2 — agent questions UI (CHANGES REQUIRED)

Round-1 verification: all 18 previous findings are fixed or acceptably closed
(details omitted — no action needed on them), EXCEPT the two partials folded
into new findings 6 and 9 below. The RFC 8291/8188 crypto, VAPID signing,
chained lock, and card states all verified correct. The new findings below
were introduced by the round-1 fixes; every one was verified against the code.
Fix all majors and minors.

## Major

1. `src/lib/push.ts:98-123,161-186` + `src/lib/scanner/index.ts:83` — An
   exception inside the notify pass is uncaught: a malformed `p256dh`/`auth`
   in push-subscriptions.json makes `b64urlDecode`/`computeSecret` throw
   inside sendPush (only fetch errors are caught), and `writeJson` throws on a
   full disk. The rejection propagates through notifyChain → `notifyQuestion`
   rejects → the `Promise.all` in `listFiles` rejects → every `/api/files`,
   `/api/answer` (via knownState) and `/api/tmux` (via knownLivePids) call
   returns 500 until the file is hand-fixed. One bad subscription record
   bricks the whole viewer. Fix: wrap the per-subscription send in try/catch
   (treat throw as "failed" or "dead") and make notifyQuestion never reject.

2. `src/app/api/answer/route.ts:108-125,189-196` — `parseOptions` scans the
   whole captured screen and `isOptionLine` accepts `-`/`*`/`1.` lines, so the
   plan markdown itself (rendered above the dialog) parses as options.
   `planOptionLabel` uses `find()` (first match in screen order): any plan
   bullet containing "accept", "proceed", "yes", "no", "reject"… becomes the
   target label. `moveToOption` then computes the distance between a plan-text
   line and the dialog highlight, sprays that many arrow keys into the pane,
   and the final highlight check fails → 502. Plan approval reliably fails for
   plans whose text contains those common words. Fix: restrict option parsing
   to the dialog region — e.g. the contiguous option block containing the
   highlighted line — or pick the last match instead of the first.

3. `src/app/api/answer/route.ts:158-161` — `moveToOption` captures the pane
   immediately after each arrow with no settle wait; `capture-pane` races the
   TUI redraw, so the post-loop highlight check reads a stale frame → spurious
   502 whenever navigation distance ≥ 1. Delivery of any non-default option is
   flaky, and in multi-question flows a mid-sequence abort leaves the flow
   wedged (see 4). Fix: after each keystroke poll until the highlight actually
   moved (reuse the waitForScreen pattern) instead of one immediate capture.

4. `src/components/feed/QuestionCard.tsx:201-205` +
   `src/app/api/answer/route.ts:213-241` — Multi-question payloads (the tool
   allows up to 4) cannot be answered: a single-select option click
   auto-submits immediately with the remaining questions empty. The server
   answers Q1, `continue`s past Q2, then `confirmAnswered` times out (the
   tool_result is written only after all questions are answered) → 10 s hang
   + 502 with Q1's answer already committed; retry then 409s because
   `verifyInitialScreen` matches `questions[0]` while the screen shows Q2. The
   free-text branch (route.ts:213-215) has the same shape. Fix: when
   `questions.length > 1`, the card must collect answers for every question
   before submitting; make verifyInitialScreen accept a fragment of any
   question.

## Minor

5. `src/app/api/answer/route.ts:75-96` — `fragments()` returns nothing for
   question texts with fewer than 2 words of ≥3 chars or a joined length <12
   («Continue?», «Deploy now?»), so `verifyInitialScreen` 409s unconditionally
   and such questions can never be answered from the UI. Fall back to matching
   the full normalized text when no fragments exist.

6. `src/lib/push.ts:80-85` vs `167-185` — `saveSubscription` writes SUBS_FILE
   outside notifyChain, and the notify pass writes back its `alive` list
   unconditionally even when nothing changed: a device subscribing while a
   pass is in flight gets silently dropped. Route saveSubscription through the
   same chain and skip the write-back when the list is unchanged.

7. `public/question-push-sw.js` (notificationclick) — when any window client
   exists it is focused without navigating to the notification URL; the deep
   link only works when no tab is open. Call `client.navigate(url)` (or
   postMessage) before focusing.

8. `src/lib/scanner/questions.ts:129` — unreachable statement after `break`
   (refactor leftover); delete it.

9. `src/lib/scanner/waitingInput.ts:17-21` — READY_MARKERS (which includes
   Codex's «Context N% used» footer) is tested against the same 12-line tail
   as the prompt bank and takes precedence; if Codex keeps its context footer
   visible under an approval prompt, waiting-input never fires for Codex —
   its primary target. Give WAITING_INPUT_PROMPTS precedence when both match.

10. `src/app/api/answer/route.ts:191-193` — approve picks the first
    accept-matching option, which in Claude Code's three-option ExitPlanMode
    dialog is «Yes, and auto-accept edits» rather than plain approve; add an
    explicit preference order (plain "yes/approve" over "auto-accept"
    variants).
