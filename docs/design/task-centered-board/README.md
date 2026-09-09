# Task-centered board — visual slice

Implementation notes for [`../task-centered-board.md`](../task-centered-board.md) (issue #1586): the board slice (bands, ranking, anchored zoom) plus the durable admission that gives every conversation a task.

## What changed

- **One horizontal band per task.** `src/components/scheme/taskBands.ts` projects recorded task membership, pipeline and flow containers, native lineage roots and open drafts onto bands, and lays the ordered bands out top to bottom at the full available width. Members wrap into rows; a band's height follows its members. `TaskBandsLayer.tsx` draws the band chrome; the existing node, slot, deck, draft and group layers draw the members at the rectangles the band layout assigns.
- **Semantic zoom with hysteresis.** Below 22% every member is a one-line chip; 22–81% shows title/status tiles; from 82% the selected conversation mounts its real reader while its siblings stay tiles. The crossings carry a two-point margin, so a wheel resting on a threshold never oscillates. Text and controls are counter-scaled, so zoom changes density, never legibility.
- **Canonical membership.** `src/lib/tasks/membership.ts` is the single writer: `ensureTaskMembership` resolves explicit targets, then a task whose admission origin key matches, then a task already holding a canonical assignment, and otherwise mints one placeholder with a `linked` assignment in the same task-file transaction. Placeholders carry `origin {kind, key, refinement}`, are exempt from the per-project task limit, and a replay of the same origin key converges on the same task. A Viewer launch commits membership in the spawn route before the spawn command runs (explicit task for a band-local «+ Agent», a placeholder titled from the prompt otherwise, keyed by the client attempt); a launch whose membership cannot be written is refused, and the receipt's launch/conversation identity is recorded onto the same assignment afterwards. Scanned root conversations without any membership are admitted on the scanner's durable controller pass in batches of 50, titled from their first prompt; a pipeline or flow without task ids claims one fallback task for its container. Nothing is written from a read-only GET.
- **Authoritative ranking.** A band's working count is the number of distinct conversations whose provider turn is open. A fresh mtime, a live process, a spawning receipt or a host-claimed attempt is `unknown` and contributes zero; a closed turn is idle. Bands sort by working count, then task creation, then id. A newly created card therefore never ranks as running.
- **Screen anchor.** The camera hook records the selected projection's screen position on every commit and, when the next commit finds it at a different world position or zoom, translates the camera before paint so both coordinates hold, mode crossings and re-wraps included. Explicit framings (fit, focus glide, jump, Return) re-baseline instead. Gesture and button zoom keep the band's left edge in place, since the world is exactly one viewport wide; only the anchor correction may offset it, and horizontal panning brings it back. Fit All frames the overview from the top at chip scale, Fit Current the top (working) bands at tile scale.
- **Interaction-aware reordering.** Rank moves are deferred while the operator pans or types inside the board; status labels update at once. When the deferred order differs, an «Order updated» control applies it.
- **Add-agent in context.** Every band ends with a local «+ Agent» (in the header at overview scale). It opens the existing launch form seeded with the task text; the draft is seated in the band and, once the launch has a transcript with a real path, the assignment is recorded through the existing task assignment route. That route adopts the conversation into the task's pipeline record with `autoStart: false`; it spawns nothing.
- **Shared conversations.** A conversation linked to several tasks has one reader owner, canonically in the earliest-created task's band; the other bands show a dashed reference tile naming the primary task. Opening the conversation from a reference tile hosts the one surface in that band (the tile's slot becomes the member's, the canonical band shows the tile in return), so the operator keeps the task context they clicked in; composer and delivery owner are unchanged. Shared running work counts once per linked task.
- **Membership provenance.** Recorded assignments and explicitly bound containers (pipeline `taskIds`, or a fallback task minted for that container) establish members. An execution the projection associated only through one matching worker stays a relation; its other stages are not promoted into the task.
- **Cross-task relations.** A recorded lineage edge whose endpoints lie in different bands is shown as a labelled continuation under each endpoint (and under mirrors of it), naming the other task; following it selects the other endpoint. The overview header carries the count instead of chips.

## Still open

- Membership before execution is enforced for Viewer launches through the HTTP spawn route. Agent-initiated spawns (capability header, no attempt key), pipeline stage launches, flow kickoffs and the raw runtime transport are admitted by their existing rules and reach a task through the scanner's admission pass after the transcript exists. Closing those seams touches the spawn command, pipeline engine and runtime host, which another lane owns at the time of writing.
- The agent's first-action title refinement (a prompted `update_task` with a one-shot refinement key) is not injected yet; a placeholder shows "Name pending" until the operator or an agent renames it through the ordinary edit path.
- Between a conversation appearing and its admission pass, the board shows it in a band derived from its container or lineage root, labelled "no task yet"; that band is projection only.

## Evidence

`evidence.json` is written by `scripts/capture-issue-1586-task-bands.ts`, which serves the production build against a synthetic home under the temp root, seeds one project with 25 invented tasks and 100 Claude transcripts (a 24-member band, a conversation shared by two tasks, working and idle turns), and drives the real board with the locally cached Chromium.

| Check | Result |
| --- | --- |
| Frames | 36 desktop frames (1280×800, 1440×900, 1920×1080 × 7/21/22/40/58/100% × light/dark), 3 with the orchestrator dock open, 2 phone frames |
| Bands per frame | 25 in every desktop frame; band width equals the available canvas minus two gutters; no vertical overlap; working bands above idle ones |
| Selected header drift, both axes | 0 px at every one of 52 steps: wheel to 40/22/21/7/24/58/81/84/100/58%, 20 toolbar out/in cycles, viewport 1440→1280→1440 |
| Cumulative drift after 20 cycles | 0 px |
| Presentations crossed while anchored | native reader → chip → native reader, across both thresholds in both directions |
| Dense band «+ Agent» | reachable after the 24th member |
| Phone viewports | the mobile focus view renders; the band board is a desktop surface |

The PNG frames stay local: the publication gate accepts only rasters it can reproduce from a deterministic generator, and browser screenshots are not that. Reproduce with:

```
bun run build
bun scripts/capture-issue-1586-task-bands.ts            # dense: 25 tasks / 100 conversations
BANDS_DENSITY=six bun scripts/capture-issue-1586-task-bands.ts
```

Frames land in `<tmp>/llv-issue-1586-*/out`; the evidence JSON is rewritten in this directory.

Unit and DOM coverage: `src/lib/tasks/membership.test.ts` (placeholder, replay, identity fill, explicit targets, limit exemption, admission planning, 1,000 imports in batches, interrupted durable pass), `src/app/api/spawn/membership.test.ts` (commit before execute, refusal without execution, unwritable store, failed spawn keeps membership, pass-through without attempt key), `taskBands.test.ts` (membership, provenance, mirrors, host overrides, continuations, ranking, hysteresis, wrapping at 375–1920, +Agent placement, 350 tasks / 1,000 conversations), `SchemeBoard.bands.dom.test.tsx` (mounted ranking, chip mode, both-axes anchor through wheel/toolbar/mode crossings, zoom without a selection, band-local add-agent), and the adjusted camera suite.

## Limits

- The 350-task / 1,000-conversation case is covered by the pure layout test, not by a browser run.
- Pipelines and review flows are exercised by the existing DOM suites (their halos and header controls sit inside the task band); the capture fixture seeds tasks and transcripts only, because pipelines are persisted in SQLite.
- A hand drag can pan horizontally after an anchor correction offset the band; zoom itself never opens a gap beside the band.
