# Task-centered board — visual slice

Implementation notes for the board half of [`../task-centered-board.md`](../task-centered-board.md) (issue #1586). The design splits the work into a durable admission slice (A) and a board slice (B); this change ships B first, because the operator's request is about what the board shows and how it moves. Where B would normally lean on A, the board derives the missing record in projection only, and says so in its labels.

## What changed

- **One horizontal band per task.** `src/components/scheme/taskBands.ts` projects recorded task membership, pipeline and flow containers, native lineage roots and open drafts onto bands, and lays the ordered bands out top to bottom at the full available width. Members wrap into rows; a band's height follows its members. `TaskBandsLayer.tsx` draws the band chrome; the existing node, slot, deck, draft and group layers draw the members at the rectangles the band layout assigns.
- **Semantic zoom with hysteresis.** Below 22% every member is a one-line chip; 22–81% shows title/status tiles; from 82% the selected conversation mounts its real reader while its siblings stay tiles. The crossings carry a two-point margin, so a wheel resting on a threshold never oscillates. Text and controls are counter-scaled, so zoom changes density, never legibility.
- **Authoritative ranking.** A band's working count is the number of distinct conversations whose provider turn is open. A fresh mtime, a live process, a spawning receipt or a host-claimed attempt is `unknown` and contributes zero; a closed turn is idle. Bands sort by working count, then task creation, then id. A newly created card therefore never ranks as running.
- **Screen anchor.** The camera hook records the selected projection's screen position on every commit and, when the next commit finds it at a different world position or zoom, translates the camera before paint so its vertical position holds. Explicit framings (fit, focus glide, jump, Return) re-baseline instead. Bands span the viewport, so the x axis is locked and a member's horizontal slot is its row layout's.
- **Interaction-aware reordering.** Rank moves are deferred while the operator pans or types inside the board; status labels update at once. When the deferred order differs, an «Order updated» control applies it.
- **Add-agent in context.** Every band ends with a local «+ Agent» (in the header at overview scale). It opens the existing launch form seeded with the task text; the draft is seated in the band and, once the launch has a transcript with a real path, the assignment is recorded through the existing task assignment route. That route adopts the conversation into the task's pipeline record with `autoStart: false`; it spawns nothing.
- **Shared conversations.** A conversation linked to several tasks has one reader owner, in the earliest-created task's band; the other bands show a dashed reference tile that names the primary task and selects the canonical surface. Shared running work counts once per linked task.

## Deferred to slice A

Durable placeholder tasks at admission, the agent's first-action title refinement prompt, the `linked` assignment state and the import batches are not in this change. Until they land, a conversation without a recorded task is shown in a band derived from its container (pipeline or flow) or its lineage root, titled from its first prompt and labelled "no task yet"; a global «+ Agent» draft appears as an "Untitled task" band. These bands are projection only and write nothing.

## Evidence

`evidence.json` is written by `scripts/capture-issue-1586-task-bands.ts`, which serves the production build against a synthetic home under the temp root, seeds one project with 25 invented tasks and 100 Claude transcripts (a 24-member band, a conversation shared by two tasks, working and idle turns), and drives the real board with the locally cached Chromium.

| Check | Result |
| --- | --- |
| Frames | 36 desktop frames (1280×800, 1440×900, 1920×1080 × 7/21/22/40/58/100% × light/dark), 3 with the orchestrator dock open, 2 phone frames |
| Bands per frame | 25 in every desktop frame; band width equals the available canvas minus two gutters; no vertical overlap; working bands above idle ones |
| Selected header, vertical drift | 0 px at every one of 52 steps: wheel to 40/22/21/7/24/58/81/84/100/58%, 20 toolbar out/in cycles, viewport 1440→1280→1440 |
| Cumulative vertical drift after 20 cycles | 0 px |
| Presentations crossed while anchored | summary → chip → summary → native → summary |
| Horizontal slot | constant within a mode; changes only when tile widths change at a mode crossing or a resize re-wraps the row (recorded as `dxSincePrevious`) |
| Dense band «+ Agent» | reachable after the 24th member |
| Phone viewports | the mobile focus view renders; the band board is a desktop surface |

The PNG frames stay local: the publication gate accepts only rasters it can reproduce from a deterministic generator, and browser screenshots are not that. Reproduce with:

```
bun run build
bun scripts/capture-issue-1586-task-bands.ts            # dense: 25 tasks / 100 conversations
BANDS_DENSITY=six bun scripts/capture-issue-1586-task-bands.ts
```

Frames land in `<tmp>/llv-issue-1586-*/out`; the evidence JSON is rewritten in this directory.

Unit and DOM coverage: `taskBands.test.ts` (membership, mirrors, ranking, hysteresis, wrapping at 375–1920, +Agent placement, 350 tasks / 1,000 conversations), `SchemeBoard.bands.dom.test.tsx` (mounted ranking, chip mode, anchor through wheel/toolbar/mode crossings, pointer-anchored zoom without a selection, band-local add-agent), and the adjusted camera suite.

## Limits

- The 350-task / 1,000-conversation case is covered by the pure layout test, not by a browser run.
- Pipelines and review flows are exercised by the existing DOM suites (their halos and header controls sit inside the task band); the capture fixture seeds tasks and transcripts only, because pipelines are persisted in SQLite.
- A hand drag that is purely horizontal moves nothing in band mode; the world is exactly the viewport wide.
