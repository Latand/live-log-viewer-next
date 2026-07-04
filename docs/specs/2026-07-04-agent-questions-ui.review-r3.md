# Review round 3 — agent questions UI (CHANGES REQUIRED)

All ten round-2 findings verified fixed. The findings below are new, introduced
by the round-2 fixes (A) or latent and now confirmed (B-E). Fix all of them.

## Blocker

A. `src/app/api/answer/route.ts:180` — moveToOption's for-loop condition
   `step < Math.abs(targetIndex - currentIndex)` re-evaluates each iteration
   while targetIndex/currentIndex are reassigned inside the body, so every
   successful arrow decrements the remaining distance while `step` increments —
   the loop exits after ceil(d/2) moves (distance 3 moves 2, distance 2 moves
   1; only distance 1 completes). Selecting any option two or more rows from
   the current highlight (e.g. option 3 of a question, or the reject row in
   the three-option plan dialog) always ends short of the target → the final
   check at route.ts:193 throws 502 «активний варіант не збігається», pane
   left mid-navigation; in a multi-question flow this aborts after earlier
   questions were already committed (see C). Fix: loop
   `while (currentIndex !== targetIndex)` with a bounded iteration cap, or
   snapshot the distance once before the loop.

## Major

B. `src/lib/scanner/waitingInput.ts:46-47` — the stability check compares
   `now - previous.at`, but `at` is refreshed to `now` on every probe with an
   unchanged screen, so it measures the gap between consecutive probes rather
   than how long the screen has been stable. useFiles polls every 10 s, so
   consecutive probes are ~10 s apart, always under STABLE_MS (15 s) —
   waitingInput never becomes truthy while any tab is polling, which is
   precisely when the user is watching. The scrape-fallback feature and its
   push debounce are effectively inert. Fix: compare against
   `previous.since`, keeping the `at` refresh for the TTL sweep. Also clean
   the dead branch in looksPromptLike (lines 20-21:
   `if (READY_MARKERS.test(tail)) return false; return false;`).

## Minor

C. `src/app/api/answer/route.ts:248-270` — multi-question delivery is not
   retryable after a mid-sequence failure: question 1's Enter is already
   committed in the TUI but the tool_result is only written after all
   questions, so on retry the loop restarts at qIndex 0 and waits 8 s for
   question 1's fragment, which is no longer on screen → guaranteed 502; the
   card stays failed forever. Fix: start the walk at the first question whose
   fragment is currently visible, skipping already-answered ones.

D. `src/lib/scanner/index.ts:83` + `src/lib/push.ts:187-197` — the notify pass
   is awaited inside listFiles, and an undeliverable question (all sends
   "failed" → never recorded in push-sent.json) is retried on every scan; each
   /api/files response then pays for the full serial round of push fetches,
   which have no timeout. Fire-and-forget the notify pass (or add
   AbortSignal.timeout to sendPush) so push-service latency never sits on the
   files-poll path.

E. `src/app/api/answer/route.ts:133` — parseOptions anchors the dialog block
   on the FIRST highlighted-looking line; a plan line rendered above the
   dialog that starts with an arrow/pointer and a number or dash (e.g.
   «→ 1. do X», «> - item») matches both isOptionLine and isHighlighted and
   would hijack the block. The real dialog is at the bottom of the screen —
   prefer the last highlighted match (findLast).
