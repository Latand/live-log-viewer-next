# Desktop v2 — independent design critique, round 1 (issue #1453)

Reviewed: branch `pipeline/1453-desktop-ui-ux-redesign-prototype-fi-dc58c192` at `0c67ae4b` (2026-09-02). Scope: `docs/design/desktop-v2/README.md`, `prototype/` (`index.html`, `app.js`, `styles.css`, `fixture.js`, `screens.js`) and `capture.ts`. Nothing under `src/` changed on this branch; `git status` is clean apart from this file.

**Method.** Read the pinned issue in full, the README, the mobile v2 and automation v2 documents and `src/styles/tokens.css`. Ran `bun docs/design/desktop-v2/capture.ts` in the foreground with `DESKTOP_V2_COLLECT=1`: 230 frames and every headless flow green, no gate failure. Opened every frame class at 1280, 1440 and 1920 in both schemes and clicked through the prototype headless (a throwaway probe script under the gitignored `out/`, deleted afterwards) to measure what the gates do not: where focus lands after a key, how many stage cards fit, whether the counts agree, what the crowded overview and map look like. Prior art: four `search_transcripts` phrasings (project-scoped, then unscoped) found nothing earlier about a desktop stage graph, an all-accounts meter view or a kanban thread on this desktop; the only hits were this pipeline's own turns.

**Operator feedback (2026-09-02, after seeing the desktop direction)**, weighed here as mandatory and carried as P1 findings 1, 2 and 3 below: (1) pipeline stages shown as a legible graph or timeline, never a plain strip; (2) an accounts surface that shows every account with a mandatory usage bar and a per-account detail of consumption, burn rate and reset timing; (3) a kanban where a task, the worker running it and the pipeline it belongs to are one visual thread.

**Frame check against the originating requirement.** The design serves the operator's words: a from-scratch desktop that keeps the shipped wave and draws the planned automation record. No WRONG-PREMISE. What the operator's feedback adds is three surfaces the README either cut (the readiness kanban, §6 and §7) or under-built (the stage strip, §4.6; the accounts stage, §4.5). This round is therefore an additive one on those three and a corrective one on keyboard reach and density.

---

## 1. First-glance triage

At 1440 dark (`out/1440/dark/board.png`) the frame reads correctly in under two seconds: rail on the left with counts in words, a column that says who needs me first, a status bar with the runtime and the two accounts. The seat card at the top of the column is the right first element. The row recipe (edge, two-line title, one meta line, one badge) holds at every width and both schemes, and the dark palette is token-exact.

Then the eye lands on the largest region of the screen and finds a placard: "3 need you · Press n to open the next decision" with a key legend (`app.js:431`, `styles.css:323`). At 1920 that placard owns 1280 × 1036 px (`out/_critique/board-1920.png` during review). The desktop's one structural advantage over the phone, room to see two things at once, is spent on an instruction the operator reads once. The board should land on something that does work (finding 4, answered by finding 3).

The second thing a power user notices is that the pipeline surface, which the README calls "the automation record drawn as it will be", is a row of five 172 px cards in a horizontally scrolling strip (`styles.css:410-411`), clipped at 1440 to three cards and at 1280 to one (`out/1440/dark/pipeline.png`, `out/1280/light/pipeline.png`). That is the strip the operator asked to replace (finding 1).

## 2. Hierarchy and density at each width

| Width | What holds | What breaks |
| --- | --- | --- |
| 1280 × 800 | Rail 220 + column 340 + stage 720 is a fair split; rows stay two lines; the composer keeps all five controls. | Column header sentence wraps to two lines and pushes the filter (`out/1280/dark/board-crowded.png`); the stage strip shows one of five stages; the stage editor is 320 px and its segmented labels wrap (`read-\nwrite`), its Save button is below the fold (`out/1280/dark/pipeline-edit-stage.png`); the rail is not collapsed by default despite `screens.js:13` calling collapsed "the 1280 default". |
| 1440 × 900 | The reference frame; every dialog fits; the feed's 880 px prose column reads well; the map's tiles are legible at 100 %. | Stage strip shows three of five stages; with the editor open it shows one and the selected stage is off-screen; the editor's Save sits at y = 831 of 900. Accounts stage uses a third of the stage and leaves the rest empty (`out/1440/dark/accounts.png`). |
| 1920 × 1080 | The pinned pane (520 px) beside a 760 px stage is the best use of width in the design (`out/1920/light/chat-split.png`); the stage graph shows four of five stages. | The empty stage is a 1280 px placard; the accounts stage is two 600 px cards floating in 1900 px; the overview grid pads quiet projects into full-height cards. |

Density verdict: the column is right; the stage is under-used on every screen that is not a conversation. A desktop primary surface should be dense by default and spend the width on relations (task ↔ worker ↔ pipeline), not on whitespace and hints.

## 3. What a keyboard-first operator can do without the mouse

Measured headless at 1440 (probe, 2026-09-02):

- `n` opens the next decision. After it, `document.activeElement` is `body`. Forty presses of Tab from there walk the rail, the project filter, every rail row, the column tools and every column row, and still do not reach the composer field; the fortieth lands on the second question option. The README's "keyboard first" (§2 principle 6) is true for navigation and false for acting: the operator must reach for the mouse to answer the decision `n` just opened.
- `↓ Enter` opens a row and leaves focus on `body` as well (the whole app re-renders on every state change, `app.js:504`, and nothing restores focus except a dialog trigger, `app.js:138`).
- `Esc` on a pipeline stage sends focus to the rail's collapse button, the first tabbable element in the document (`app.js:654`), not to the column's current row as the key map promises.
- There is no key to reach the composer, to pick a question option (`1`–`9`), to jump to the stage's primary action (Answer, Retry stage), or to move between the column and the stage. The single-key map (`n N o / m a p t c [ ?`) is complete for "where"; it has nothing for "do".
- What works and must stay: the filter field with `↑ ↓ Enter`, `n`/`N` across both item kinds and across projects on the overview, single keys inert while typing, Escape closing dialogs with focus return to the trigger, `Enter` sends and `Shift+Enter` breaks, the composer's Tab order.

This is finding 5 (P1). A power user's desktop is judged by whether the next decision can be answered with three keystrokes.

## 4. The pipeline editing story

The story is right and the mechanics are proven: edit-stage on a running stage lands as "pending · applies from attempt 2", Restart stops and starts, set-edge changes the budget, notes attach, rerun is refused while an attempt is unsettled and allowed with `stopCurrent`, add-stage inserts at the seam with Undo, a completed pipeline reopens after edit-then-rerun (all in `capture.ts` flows, green). The change log with `rev n · action · stage · actor · effect` is exactly automation-v2's attributed log rendered. Keep all of it.

The surface that carries the story is wrong:

- The graph is a horizontally scrolling strip (`styles.css:410`), 172 px per stage, fail edges as a 10 px caption (`↺ fix ×3`, `app.js:326`), and one badge for the last attempt (`app.js:319`). Measured: 3 of 5 stages visible at 1440, 1 of 5 at 1280, 1 of 5 at 1440 with the editor open (and the stage being edited is not the visible one), 4 of 5 at 1920. There is no timeline: attempt 1 failed → fix → attempt 2 failed is text in a changes log, not a shape.
- Past rounds vanish. The findings card shows attempt 2's findings; attempt 1's findings are gone; the review stage card says `2 attempts · failed` and `open ›` goes to the last one only.
- The editor's primary action sits at the bottom of a scrolling pane (Save at y = 831 at 1440; off-screen at 1280); the editor is a form with nine fields stacked in one 360 px column while the stage beside it is empty.
- Developer text on a product surface: `PATCH /api/pipelines/p2 · expectedRevision 9` beside the actions (`app.js:349`), `edit-stage {stageId, expectedRevision}` under the editor (`app.js:376`, `:390`), and the tagline "every mutation is attributed and revision-stamped" on the changes card (`app.js:345`). The operator does not need the route; the engine's refusal in the receipt is the truth (README §4.6 says so itself).

Findings 1, 9, 10 and 19.

## 5. Attention and arrivals

The queue design is sound: Needs you holds conversations and pipelines, the badge is one recipe, the count is in the column header and the rail row, the empty stage repeats it, `n`/`N` walk it, the other-project banner collapses and stamps seen (`out/1440/dark/chat-arrival.png`, flow green). No pill, no toast, nothing floats over content: this fixes the 2026-08 audit's finding 8 and D1 for good.

Two gaps:

- The same item renders twice in the column: a parked pipeline is a row under Needs you and again under Pipelines (`out/1440/dark/board.png`, "Archive TTL for closed pipelines (#206)" twice within 300 px), and a pipeline's current attempt is a row under Needs you or Working while its pipeline is a row under Pipelines. Twelve rows describe seven things. The column is the switchboard; a switchboard lists each thing once (finding 7).
- An arrival in the current project is "a new row and nothing else" (README §4.8). With the operator reading a long feed at 1920 and the column scrolled, nothing moves. The header count changes silently. One pulse of the column header count and the rail badge on arrival (respecting reduced motion) costs nothing and keeps the no-toast rule (finding 20).

## 6. Consistency with mobile v2 and the tokens

Checked value for value: `styles.css` `:root` and the dark block match `src/styles/tokens.css` (surfaces, roles, radii, motion, the depth ladder). `stateBits` (`app.js:89`) is the mobile function with the same precedence; the badge recipe, the receipt (4 s, inverse action, in flow), the banner slot precedence (offline > degraded > arrival), the `low · medium · high · xhigh · max` vocabulary and the question card order are the mobile ones. The capture's banned-word list keeps "Waiting on you", "live tail" and "confirm" out. Good.

Divergences worth fixing:

- Round versus attempt. Mobile §4.7 titles the findings block `Review · round 3 · 2 findings`; desktop titles it `Review · attempt 2 · 2 findings` (`app.js:333`) and the stage cards count attempts. Automation v2 uses "attempt" for one run of a stage and "round" for the fail-edge budget. Use both, consistently, on both prototypes: `attempt 2 · round 2 of 3` (finding 18).
- Mobile keeps the readiness kanban reachable (its §6: "Tasks board redesign: the task sheet is reachable from `⋯ › Tasks` and unchanged"); the desktop cuts the readiness strip (§6) and defers the kanban (§7). With the operator's feedback the desktop now leads and the phone will follow; the desktop must define the thread vocabulary (task card, worker chip, pipeline chip) so mobile can reuse it (finding 3).

## 7. Edge cases

| Case | Frame | Verdict |
| --- | --- | --- |
| Fourteen projects | `board-crowded` (rail), `out/_critique/overview-crowded-1440.png` | Rail scrolls, fine. Overview: eight quiet projects each take a full-height card with one line of text while the crowned project's card hides "28 more" (finding 14). |
| Thirty conversations | `board-crowded` 1280 | Needs you (9 rows) fills the column; Pipelines, Working and Recent are below the fold; the header sentence wraps (finding 8). Every Needs-you row does end inside the first screen, as gated. |
| Ten pipelines | `out/_critique/pipelines-crowded-1440.png`, `map-crowded-1440.png` | Pipelines list is clean. The map becomes a vertical stack of dashed regions whose tiles are mostly "not started" ghosts; regions clip at the right edge at 1440 (p1's 4/5 review tile, p2's 5/5) and the minimap is an empty rectangle (finding 11). |
| No seat | `board-noseat` | The seat card invites, `o` opens Create, Create seats one. Right. |
| Degraded | `board-degraded` | Info banner, status chip in warning, board menu badge. Right. |
| Offline | `chat-offline` | Banner, status chip in danger, slot reads Queue, send is held. Right. |
| Limit | `chat-limit`, `chat-model` | The row leads Needs you with a `limit` badge, the chip reads `Opus · Main at limit`, the popover offers Lab as ready and routes Second to sign-in. Right. |
| Killed / stalled / held | `chat-killed`, `chat-stalled`, `chat-held` | One precedence, one phrase per surface, slot flips to Respawn. Right. |
| Split at 1920 | `chat-split` | Two composers, both walked by the gate. The pinned pane's header has only `×`, no `⋯` (finding 15). |

## 8. Over-built and missing against the issue

**Over-built (cut or shrink):**

- Payload hints and the meta tagline on the pipeline stage (`app.js:345`, `:349`, `:376`, `:390`). The route and `expectedRevision` are the implementation lane's contract, not the operator's.
- The map's zoom controls and minimap (`app.js:429`, `styles.css:508`). README §7 defers semantic zoom because tiles are legible at 100 %; then the zoom buttons, the percentage and an empty minimap are furniture. Fit-to-width and vertical scroll cover it.
- The permanent `Enter send · Shift+Enter newline` hint in every composer (`app.js:294`), twice on the split screen. Once learned it is noise in the one row that should be quiet; the `?` dialog already lists it.
- The empty stage's key legend. It duplicates `?` and the status bar's `shortcuts` chip.

**Missing against the issue and the operator's feedback:**

- A stage graph or timeline (Wanted 2, "how pipelines are read"; operator item 1).
- Every account with a meter and a detail view (Wanted 1 and 2, "accounts"; operator item 2). The current build has the pieces: `AccountsPanel` content, `LimitsFooter`'s burndown trigger and `BurndownPanel` (ideal pace versus actual remaining, `computePace`, depletion projection); the prototype drops the burndown entirely.
- The kanban and the task ↔ worker ↔ pipeline thread (operator item 3). The current build has `taskReadiness.ts` with five fixed sections (now, review, blocked, planned, done) and `TaskReadinessStrip` chips that already link a task to its pipeline attempt and reviewer; the prototype's Tasks stage is a three-row list linking to a conversation only (`app.js:419`).
- Acting from the keyboard (Wanted 3 "keyboard focus order" was read as Tab order inside the composer; the issue's operator is keyboard-first end to end).

---

## 9. Findings

Severity: P1 changes what the product is; P2 changes how it behaves on an ordinary day; P3 is cheap and visible. Each carries screen and element, why it hurts, fix intent, acceptance.

### F1 · P1 · Pipeline stage: the stage strip must become a legible graph or timeline (operator item 1)

- **Where.** `#/pipeline/<id>` and every `stage/` and `add/` route; `.stages` / `.stg` / `.edge` in `styles.css:410-424`, `stageCard` and `edgeHtml` in `app.js:319-330`. Frames `pipeline`, `pipeline-running`, `pipeline-edit-stage`, `pipeline-edit-running`, `pipeline-add-stage`, `pipeline-completed` at all widths.
- **Why it hurts.** The record's shape is invisible: 3 of 5 stages at 1440, 1 of 5 at 1280, 1 of 5 while editing at 1440 with the edited stage off-screen (measured). The fail edge is a 10 px caption, review rounds are a count, the current stage is a 3 px edge on a card that may be scrolled out. The operator cannot answer "where is this pipeline, what looped, how many rounds are left" at a glance, which is the one question the stage exists for.
- **Fix intent.** Design a stage graph with its own visual language and put it first in the stage body: stages as nodes in a vertical timeline (or a wrapped grid at ≥ 1600) so nothing scrolls sideways at 1280; pass edges as a continuous spine; a fail edge drawn as a loop back to its target with the round budget as pips (`● ● ○` = round 2 of 3 used); per-stage attempt pips coloured by verdict (passed / failed / running / skipped) so `attempt 1 failed → fix → attempt 2 failed` is a shape; on every node the role as the title, the engine mark, `model · reasoning`, access, and the attempt summary; the current stage with a pulsing dot and accent edge; `edit pending · applies from attempt n` and `k notes` as a small marker; ⊕ on edges stays. The editor (F9) must never hide the graph: the graph is the left column, the editor the right, and at 1280 the editor overlays with the graph collapsed to a one-line ladder above it. Add a seven-stage pipeline to the fixture so the graph is proven on a long record, and render the same node recipe as tiles inside the map's regions.
- **Acceptance.** All stages visible without horizontal scroll at 1280, 1440 and 1920 with and without the editor open (new gate: `.stages` scrollWidth ≤ clientWidth on every pipeline frame); the selected stage is on screen while editing; every node shows role, engine mark, model, reasoning, access and attempt pips; every fail edge shows its target and `k of n rounds`; a frame `pipeline-long` (seven stages, two fail edges, one loop traversed twice) renders at all three widths in both schemes and passes the 44 px and overlap gates.

### F2 · P1 · Accounts: every account with a mandatory usage bar and a per-account detail view (operator item 2)

- **Where.** `#/accounts`, `accountsView` in `app.js:411-418`, `.acc-body` in `styles.css:461`; frame `accounts` at all widths; also the composer chip's Account group (`chat-model`, `chat-limit`).
- **Why it hurts.** Only the active account per engine has meters (4 meters for 5 accounts, measured); Lab and Team are one-line rows that read `ready` and switch on click; Second is a `sign in →` row. The operator cannot compare accounts before switching, cannot see that Lab has 91 % of its window while Main has 38 %, and has no way to open how fast an account is burning or when it runs out. The current build already computes pace and depletion (`src/lib/burndown.ts`, `BurndownPanel`), so the prototype regresses a shipped capability.
- **Fix intent.** One row per account under its engine, every row the same recipe: filled mark, label, plan, `active` / `ready` / `sign in` badge, then two meters (5 h and Week) with `% left` and the reset clock; the not-signed-in row carries empty meters and `sign in →` in the same slot. The row is a target: click or Enter opens an account detail as a stage (`#/accounts/<engine>/<id>`) with the identity header, both windows as large meters with reset clocks, the burndown chart (ideal pace versus remaining, the current build's `BurndownPanel` in the design system's tokens), `burning at n % per hour · ahead of pace`, `runs out at 16:40 at this pace` (or `lasts to the reset`), today's consumption by hour, and the actions Switch to this account / Use one reset / Refresh / Sign in, acting on the click with a receipt. The status bar chips keep the active account's lowest window and open the accounts stage; the composer chip's Account group reuses the same row recipe with the meters.
- **Acceptance.** Every account row on the accounts stage has two meters (gate: `.arow .meter` count = 2 × rows); a new frame `account-detail` at all widths and schemes shows the chart, the pace line, the depletion line and the actions; the capture clicks a non-active row and lands on its detail, presses Escape and returns to the accounts stage with focus on that row; Switch from the detail lands a receipt with Switch back.

### F3 · P1 · Kanban: a board where a task, its worker and its pipeline are one thread (operator item 3)

- **Where.** `#/tasks` (`tasksView`, `app.js:419-421`), the empty stage (`app.js:431`), the pipeline stage's Linked tasks card, the conversation header meta. README §6 cuts the readiness strip and §7 defers "the readiness kanban as a stage".
- **Why it hurts.** The three objects the operator manages are on three surfaces with one-way links: a task row opens a conversation; a pipeline card lists linked tasks; a conversation shows `stage 2/5`. Nothing shows "this task is being done by this worker inside this pipeline at this stage" in one place, and the desktop's landing surface is a placard while that picture is missing. The current build already has the read-model (`taskReadiness.ts`: now / review / blocked / planned / done) and chip links from a task to its pipeline attempt and reviewer; the prototype drops both.
- **Fix intent.** A Board stage (`#/kanban`, key `k`, the segmented control becomes list / kanban / map) that is the default primary surface for a project. Columns are the five readiness sections, each with its count and vertical scroll (never sideways). A card is the thread: task title and issue ref; under it the worker chip (engine mark, model, state phrase with elapsed, the conversation's `⋯` on hover) and the pipeline chip (`stage k/n · <stage> · <state>`, with the F1 attempt pips in miniature); the seat chip when the orchestrator owns the task; a `needs you` badge when any part of the thread is in the queue. The card opens the task; the worker chip opens the conversation; the pipeline chip opens the pipeline stage; from a conversation, `⋯ › Task · <title>` and the header meta `task · <title>` close the loop; the pipeline stage's stage nodes show the task and the Linked tasks card becomes the thread card. Drag between columns changes the task's status on drop with a receipt (Undo); no confirmation. Unassigned tasks (no worker, no pipeline) render as plain cards with a `+ Assign` row that opens the create menu prefilled. `n`/`N` still walk the queue; on the kanban the highlighted card follows.
- **Acceptance.** New frames `kanban`, `kanban-crowded` (thirty conversations, ten pipelines, twelve tasks) at all widths and schemes: no horizontal scroll, columns scroll vertically, every card ≥ 44 px, no overlap; a card renders worker and pipeline chips whenever the task has them; headless: click worker chip → `#/chat/<id>`, click pipeline chip → `#/pipeline/<id>`, drag a card to `done` → status changes and the receipt's Undo restores it; the landing route of a project is the kanban when the project has tasks (F4).

### F4 · P2 · The empty stage is a placard on the desktop's largest region

- **Where.** `emptyStage` (`app.js:431`), `.empty` (`styles.css:323`); frames `board`, `board-noseat`, `board-degraded`, `board-crowded`, `board-rail-collapsed` at all widths; 1280 px wide at 1920.
- **Why it hurts.** Every project switch lands here. The primary region shows a sentence and a key legend that duplicates `?`. A power user sees the same instruction hundreds of times a day and learns to ignore the region.
- **Fix intent.** The landing stage does work: the kanban (F3) when the project has tasks, else the first Needs-you item, else the seat's conversation. The key legend leaves; the status bar's `? shortcuts` is the one place for keys.
- **Acceptance.** No frame in the matrix shows a stage whose only content is a sentence and a legend; `#/board` renders the kanban for `atlas` and the seat conversation for a project with no tasks.

### F5 · P1 · Acting from the keyboard: focus dies after `n`, `Enter` and every re-render

- **Where.** `render` (`app.js:504`) rebuilds `#app` and restores focus only for dialogs (`app.js:521`) and the filter (`app.js:642`); `n`/`N` (`app.js:675`); Escape (`app.js:654`). Every chat and pipeline frame.
- **Why it hurts.** Measured: after `n`, focus is on `body`; forty Tabs do not reach the composer; after `↓ Enter`, focus is on `body`; Escape on a pipeline stage lands on the rail's collapse button. The operator can find the decision from the home row and then must take the mouse to answer it. That contradicts principle 6 and the issue's "keyboard focus order" intent.
- **Fix intent.** Opening a stage moves focus to its primary target: the composer field on a conversation (the first question option when a question is open); the Answer field on a parked pipeline, else the first stage node; the first row of a list stage. Add `i` (focus the composer from anywhere in the frame), `1`–`9` (pick a question option while the card is open and nothing is being typed), `Enter` on a stage node (open its editor), `Esc` from anywhere in the stage (back to the column's current row, focused and scrolled into view). Every re-render restores the previously focused element by its `data-focus` / `data-go` / `data-act` identity. Tab order inside the frame starts at the stage when a stage is open (the rail and column are reachable with Shift+Tab or `[` / `Esc`).
- **Acceptance.** Capture flows: `n` → active element is the composer field on `chat-waiting` and the Answer field on `pipeline`; `1` picks the first option and the row leaves Needs you; `i` from the column focuses the composer; `Esc` from the composer, from a stage node and from the pipeline actions returns to the column's current row (asserted, not "any row"); after every flow step `document.activeElement` is never `body`; from stage open to the send slot is at most five Tabs.

### F6 · P2 · The counts disagree across the three places that promise the same number

- **Where.** Rail row `atlas · 3 need you · 3 working` (`rail`, fixture `working: 3`), column header `3 need you · 2 working · 3 pipelines` (`column`, `app.js:218`, computed without the seat), overview card `3 working`. Frames `board`, `overview`.
- **Why it hurts.** README §4.1 and lane 2's acceptance promise one number in the rail, the column header and the overview. The prototype shows two numbers for "working" on one screen, which is the exact class of defect the 2026-08 audit's finding 14 named.
- **Fix intent.** One function computes a project's counts from the same list the column renders; decide once whether the seat counts as working (recommendation: it does not, the seat card shows itself) and apply everywhere including the fixture's project rows, which should be derived, not typed.
- **Acceptance.** Capture asserts equality of the rail row's phrase, the column header's phrase and the overview card's counts for every project, in `board`, `overview` and `board-crowded`.

### F7 · P2 · The column lists the same thing twice; the pipeline ↔ attempt thread is invisible

- **Where.** `column` (`app.js:218-245`): a `needs_decision` pipeline renders under Needs you and under Pipelines; a pipeline's current attempt renders as a conversation row while its pipeline renders as a pipeline row. Frame `board` at 1440: "Archive TTL for closed pipelines (#206)" twice.
- **Why it hurts.** Twelve rows for seven things on the ordinary board; on the crowded board the duplication doubles the queue's length. The relation between the attempt and its pipeline is a `stage 2/5` fragment the operator has to match by eye.
- **Fix intent.** Each id renders once: Needs you wins, Pipelines lists only pipelines not already shown, and a pipeline row folds its live attempt under it as an indented child row (`└ 2/5 build · Builder · a question · 9 min`) that opens the conversation, so the thread reads top-down in the column too (the same thread F3 draws as a card).
- **Acceptance.** Gate: no `data-go` value appears twice in `.col-body`; the pipeline row on `board` shows its attempt as a child row; `n` still reaches the attempt.

### F8 · P2 · At 1280 the crowded column hides everything below the queue and the header wraps

- **Where.** `.col-head h1 small` and `.col-body` (`styles.css:280`); frame `board-crowded` at 1280.
- **Why it hurts.** Nine Needs-you rows fill 800 px; Pipelines, Working and Recent are below the fold with no way to jump; the header sentence "9 need you · 10 working · 10 pipelines" wraps and shoves the filter down.
- **Fix intent.** Sticky section headers that stack as the column scrolls (each a 44 px target that collapses its section); the header sentence as one line of tabular numbers with glyphs at 1280 (`9 ⚠ · 10 ● · 10 ⟐`) or the pipelines count dropped; Recent collapsed by default when the column is over one screen.
- **Acceptance.** At 1280 crowded every section header is visible or stuck at the top edge without scrolling past the queue; the column header is one line at every width; the crowded gate still holds.

### F9 · P2 · The stage editor hides its primary action and squeezes its controls

- **Where.** `.editor` (`styles.css:426-440`), frames `pipeline-edit-stage`, `pipeline-edit-running`, `pipeline-add-stage`, `pipeline-completed` at 1280 and 1440.
- **Why it hurts.** Save at y = 831 of 900 at 1440 and below the fold at 1280 × 800; `read-write` wraps inside its segment at 1280; Account is a native select among segmented controls; nine fields stack in one 360 px column beside an empty stage.
- **Fix intent.** The editor pane gets a sticky footer with Save / Restart / Cancel always visible and the "applies from attempt n" note beside them; Role · Engine · Model · Reasoning on one row of segmented controls at ≥ 1440, Access · Sandbox on one row, Account as the same row recipe as F2; the prompt textarea takes the remaining height. At 1280 the editor takes the stage width with the graph ladder above (F1).
- **Acceptance.** Save and Restart are inside the viewport on every editor frame at every width without scrolling; no segmented label wraps (gate: each `.seg button` is one line); the composer-style focus order holds inside the editor (field → segmented groups → prompt → Save).

### F10 · P2 · Attempt and round history is unreadable on the pipeline stage

- **Where.** `stageCard` (`app.js:319`): `2 attempts · failed` and one `open ›`; the findings card shows only the current attempt's findings (`app.js:333`).
- **Why it hurts.** The reviewer's first-round findings are the context for the second round; a three-round loop's history is the reason the operator is being asked to decide. Today that history is in the change log's prose or in three separate conversations.
- **Fix intent.** A stage node expands (click or Enter) into its attempt list: `attempt 1 · failed · 7be2d0 · 2 findings · open ›`, `attempt 2 · failed · 9c41aa · 2 findings · open ›`; the findings card carries a `round 1 ›` fold with the earlier findings; the round pips of F1 are the same data.
- **Acceptance.** On `pipeline` the review node lists both attempts with their heads and `open ›`; round 1 findings are reachable without leaving the stage; a gate confirms every attempt with a conversation has an `open ›` target.

### F11 · P2 · The map clips at the right edge, drowns in ghosts, and carries an empty minimap

- **Where.** `mapView` (`app.js:422-430`), `.minimap` (`styles.css:508`); frames `board-map` at 1280 and 1440, `map-crowded` (probe).
- **Why it hurts.** At 1440 p1's `4/5 review` tile and p2's `5/5` tile are cut off; with ten pipelines the map is a vertical stack of regions where most tiles say "not started", and the minimap draws nothing.
- **Fix intent.** Tiles wrap inside a region as a grid; stages that have not started collapse into one ladder tile per region (`3/5 verify · 4/5 review · 5/5 publish · not started`); loose conversations stay as tiles; the zoom tools and the minimap go (fit-to-width plus vertical scroll cover it), unless the minimap actually draws the region outlines.
- **Acceptance.** No tile or region exceeds the map's client width at any width (gate on `.region` right edge); a region with three unstarted stages renders one ladder tile; the minimap is either removed or shows outlines that the capture verifies are non-empty.

### F12 · P3 · Search results overflow into the meta column

- **Where.** `.search-rows .mrow` (`styles.css:561-564`), rows rendered at `app.js:452-456`; frames `search` at 1440 and 1920.
- **Why it hurts.** Title and snippet run together with no separator ("Orchestrator · atlasMorning."), and long snippets paint over the project chip and time ("honest about held delive" under "atlas ✦ 13:4"). The README promises 52 px rows with title, snippet, chips and time.
- **Fix intent.** Two lines: title with meta right-aligned on line 1, the highlighted snippet truncated on line 2.
- **Acceptance.** Gate: the snippet element is `overflow: hidden` and its right edge is left of the meta element's left edge on every result row.

### F13 · P3 · The seat panel promotes Rotate and truncates the mandate

- **Where.** `seatPanel` (`app.js:308-316`); frames `seat`, `chat-split`.
- **Why it hurts.** The mandate preview shows one line ("You are the atlas orchestrator.") where the README promises three faded lines; Rotate, the one action that discards the seat's context, is the largest primary button on the screen while Edit the mandate is secondary; the header meta repeats the panel's badge.
- **Fix intent.** Three-line faded mandate preview with an inline `Edit ›`; Rotate as a secondary button beside Edit the mandate, both 44 px; the rotation-recommended line stays the only warning.
- **Acceptance.** The preview shows three lines of the fixture mandate; Rotate is not the primary style; the frame passes the gates.

### F14 · P2 · Overview with fourteen projects pads quiet projects into full-height cards

- **Where.** `.ov-grid` (`styles.css:451`), overview cards; probe frame `overview-crowded-1440`.
- **Why it hurts.** Eight quiet projects each occupy a 300 × 100 px card with one line; the crowned project's card, the one with nine decisions, shows four rows and "28 more".
- **Fix intent.** Active projects get cards with up to eight rows in state order; quiet projects collapse into one "Quiet · 8" strip of chips (name · last activity) under the active cards; the column stays the cross-project queue.
- **Acceptance.** A new frame `overview-crowded` at 1440 shows every project in one screen; the crowned project's card lists at least six rows.

### F15 · P3 · Composer hint clutter and the pinned pane's missing menu

- **Where.** `.hint` in `composer` (`app.js:294`); `chatHead` for the pinned pane (`app.js:299`).
- **Why it hurts.** "Enter send · Shift+Enter newline" is permanent in every composer and appears twice on the split screen; the pinned pane's header has `×` only, so Kill, Details and Hand off are unreachable there.
- **Fix intent.** The hint moves into the placeholder (`Message the agent… · Enter sends`) or shows once until the first send; the pinned pane's header gets the same `⋯` as the stage's.
- **Acceptance.** No `.hint` element on chat frames; the pinned pane has a `⋯` that opens the conversation menu and returns focus on Escape.

### F16 · P3 · Fixture wiring makes the demo lie about which conversation belongs to which pipeline

- **Where.** `fixture.js:136` (`c5`, "Migrate accounts to the new binding", a plan-approval conversation) is `p1`'s plan attempt (`fixture.js:165`), so the map draws it inside the export-endpoint region; `c3` is both the build and the verify attempt of `p2` (`fixture.js:187-188`), so the map shows the same title twice in one region.
- **Why it hurts.** The operator will read the map and the pipeline stage on these fixtures; a region that contains an unrelated conversation undermines the "one thread" story F3 sells.
- **Fix intent.** Give `p1` its own plan conversation (`Design the export endpoint`), give `p2`'s verify stage its own attempt conversation, and keep `c5` loose.
- **Acceptance.** Every attempt's `conv` is unique per pipeline and its title names the pipeline's task.

### F17 · P3 · Rail default at 1280 and the "1280 default" claim disagree

- **Where.** `screens.js:13` titles `board-rail-collapsed` "rail collapsed to icons (1280 default)"; `S.rail` defaults to expanded at every width (`app.js:83`); README §3.4 lists 220 px at 1280.
- **Why it hurts.** Either the rail eats 220 of 1280 px by default or the doc and the screen list are wrong; a reviewer of lane 1 will implement one of them.
- **Fix intent.** Decide: collapsed by default under 1440 (recommended; `[` expands, and the collapsed rows already carry initials and the badge), and say so in §3.4 and `screens.js`.
- **Acceptance.** `board` at 1280 renders with `data-rail="0"` and the crowded column gets 340 px plus the 156 px the rail gave back.

### F18 · P3 · "attempt" versus "round": one vocabulary across both prototypes and automation v2

- **Where.** `pipeView` findings title (`app.js:333`), `stageCard` attempt summary, mobile v2 README §4.7 ("round 3").
- **Fix intent.** "attempt" is one run of a stage; "round" is one traversal of a fail edge. Findings title: `Review · attempt 2 · round 2 of 3 · 2 findings`. Apply to both prototypes and to the README's §4.6 examples.
- **Acceptance.** The capture's vocabulary check adds a pair of asserts: the findings title matches the pattern, and neither prototype uses "round" for a stage attempt.

### F19 · P3 · OVER-BUILT: payload hints, the meta tagline, zoom tools

- **Where.** `app.js:345`, `:349`, `:376`, `:390` (payload text), `app.js:429` (zoom tools), `styles.css:508` (minimap).
- **Why it hurts.** Route strings and mutation payloads on a product surface are documentation for the implementer, and they cost a full-width row beside the actions; the zoom tools exist for a map the README says needs no zoom.
- **Fix intent.** Cut the payload hints and the tagline (the README's §4.6 mapping table already carries the contract; a refused mutation lands in the receipt with the engine's reason); cut the zoom tools and the minimap unless F11 gives the minimap a job.
- **Acceptance.** No element on the pipeline frames contains "PATCH", "expectedRevision" or a JSON-shaped hint; the map has no zoom controls; the lane 6a/6b acceptance in README §8 still names `expectedRevision` as the API contract.

### F20 · P3 · A current-project arrival makes no visible move

- **Where.** README §4.8 ("one in the current project is a new row and nothing else"); `banner` (`app.js:247`).
- **Why it hurts.** With the column scrolled or the operator deep in a feed at 1920, a new decision in the current project changes a count silently. The no-toast rule is right; silence is a step too far.
- **Fix intent.** On arrival, the column header's count and the rail badge pulse once (200 ms, none under reduced motion) and the new row's edge fades in; the column scrolls the new row into view only if the operator is at the top of the column already.
- **Acceptance.** Headless: set a fixture arrival in the current project; assert the row appears in Needs you with the edge, the header count increments, and no banner renders.

---

## 10. What must not be regressed in the rework

- The frame: rail · column · stage · status bar, no pushed dock, no floating chrome; dialogs replace the route and create no history; Escape returns focus to the trigger (flow green).
- The column recipe: seat card first, sections in state order, both kinds in Needs you, the filter with `↑ ↓ Enter`, `n`/`N` across kinds and across projects on the overview.
- `stateBits` precedence and the one-phrase-per-surface rule; the badge recipe; the receipt with its inverse (Kill → Respawn, Close → Reopen, Skip → Retry stage, remove → Undo, switch → Switch back); no confirmation anywhere.
- The composer box: field on top, chip · attach · dictate · slot, the slot as Stop / send / Queue / Respawn, Enter sends, Shift+Enter breaks, Tab order gated; the question card order and answer-on-click; suggested chips; the draft surviving a switch (measured: it does).
- The pipeline editing mechanics and the change log (every flow in `capture.ts`); the template picker; the actions by state.
- Accounts content from #1424: windows, reset lines, Refresh, Use one reset, sign-in routing from the composer chip.
- The seat: card, stage, rotate/create dialog with the mandate focused, successor note.
- The split pane at ≥ 1600 with two gated composers; Pin absent under 1600.
- Search: `/`, scope control, `↑ ↓ Enter`, Escape with focus return.
- Both schemes token-exact; 44 px targets; no overlapping controls; no sideways scroll; the banned-word list.
- The capture's habit of proving each claim headless; every new surface above adds its frames and its flows to the same script.

The rework stage applies every P1 and P2 and the cheap P3s, and declines the rest with a reason in a "Critique round 1" section of the README.
