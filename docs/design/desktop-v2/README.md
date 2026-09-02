# Desktop v2 — the desktop experience, from scratch, prototype-first (issue #1453)

> **Originating requirement.** Operator directive, 2026-09-02, given in the orchestrator conversation right after approving the mobile v2 prototype, quoted verbatim from the #1453 pipeline specification:
>
> *"може щось на десктопі тоді якийсь прототип продумаємо? мб якийсь редизайн теж по десктопу по UX UI з нуля, з урахуванням того що в планах і того що зроблено вже"*
>
> Working translation (mine): "maybe then we think through some prototype for the desktop too? maybe a redesign of the desktop as well, UX and UI from scratch, taking into account what is planned and what is already done."
>
> Issue #1453 (opened by the operator the same day; read in full on 2026-09-02) carries the scope. Quoted verbatim:
>
> *Operator directive (2026-09-02, in the orchestrator conversation, after approving the mobile v2 prototype): while the mobile lanes run, think through a desktop prototype too — a UX/UI redesign of the desktop, from scratch, taking into account what is already done and what is planned. Same rule as mobile: **prototype-first**, the operator agrees the picture before any implementation lane opens. Fable owns the design.*
>
> *What must be absorbed. Shipped in the last wave (undeployed as of filing): compact failed-delivery notice (#1422), accounts dialog with actionable limits (#1424), agents search prior conversations first (#1430), feed starting window and "working…" timing (#1420), global message search profiled and ranked in memory (#1440), cached feed on switch with no board remount and in-app conversation links (#1445), orchestrator rotation authority contract (#1419), viewer-written Claude successor fork (#1448), seat tick note cap (#1450). Designed, not built: mobile v2 (#1439, `docs/design/mobile-v2/`): one bar, one banner slot, a navigation contract, sheets and in-flow receipts, state precedence, a shared vocabulary; the desktop must speak the same language and share tokens. The unified agent-mutable automation model (#1446, `docs/design/automation-v2/`): one record for pipelines, flows and review loops, editable after start; the desktop pipeline surface will eventually call the same PATCH payloads (slice 12). Standing rules: no confirmation prompts anywhere; controls are capability, not prohibition; identity-free artifacts; screen-reader work out of scope.*
>
> *Wanted. 1. An audit of the desktop as it is at 1280, 1440 and 1920 px in both schemes, from rendered frames of the current build against a seeded home (the #979 recipe), covering: board and project rail, the focused conversation and feed, orchestrator panel, pipelines (strip, hub, scheme board), accounts, search, attention, switching between projects and conversations. Name what works and must be kept. 2. A mobile-v2-consistent desktop information architecture: what the persistent frame is, what a primary surface is, where the seat lives, how pipelines are read and edited, how attention and arrivals surface, how search and switching feel, what is cut. 3. A static clickable prototype (HTML/CSS/JS with invented fixtures, no framework) under `docs/design/desktop-v2/prototype/`, both schemes, the three widths, with a capture script rendering PNGs into a gitignored `out/` and headless gates (no overflow, no overlapping controls, 44 px targets, keyboard focus order for the composer and dialogs). 4. A design document `docs/design/desktop-v2/README.md`: the requirement quoted verbatim with date and source, the audit, principles, information architecture, screen-by-screen notes, what is deliberately cut, an implementation plan sliced into issues (one lane per slice, one owner per file), and a "Deferred — not currently justified" section. 5. Approval gate: the orchestrator shows the prototype to the operator; only after their word do implementation lanes open.*
>
> *Out of scope for this lane: product code changes. Mobile (owned by #1439's lanes). Screen-reader accommodations.*

This directory is the picture. Nothing in product source changed. What is here:

| Path | What it is |
| --- | --- |
| `README.md` | This document: audit, principles, information architecture, screen notes, cuts, deferred scope, implementation plan. |
| `prototype/index.html` | The clickable prototype. Open it from the file system; no server, no build step. `prototype/fixture.js` is invented, identity-free data (projects, conversations, pipelines with automation-v2 fields, accounts, hosts); `prototype/screens.js` lists the 38 key screens; `prototype/app.js` and `prototype/styles.css` are the whole implementation. |
| `capture.ts` | `bun docs/design/desktop-v2/capture.ts` renders every key screen at 1280×800, 1440×900 and 1920×1080, dark and light, into `out/` (gitignored by `.gitignore` here) and gates each frame: nothing scrolls sideways (document, rail, column, stage, pinned pane, feed), every visible control is at least 44×44, no two visible controls overlap, a receipt never covers a control, the requested scheme applied, the bench never shows in a frame-sized viewport, the composer's Tab order is field → model chip → attach → dictate → send slot, a dialog takes focus on open, Tab wraps inside it, Escape closes it and returns focus to its trigger. After the matrix it clicks through the design headless: column arrow keys and Enter, the filter, the `n`/`N` queue across both item kinds, every single-key shortcut, focus return from the composer and from a menu, the send slot flipping between Stop and send, the answer path, Kill and Close with their receipts and inverse actions, the whole after-start pipeline editing story (edit-stage for the next attempt and with restart, set-edge, note, rerun refused while unsettled then allowed with stopCurrent, answer on a parked stage, add-stage and remove-stage with undo, completed → edit → re-run, draft → start), the arrival banner's seen stamp, the split pane's width rule, offline, the limit sheet's sign-in routing, the no-seat board and the crowded board. Run on 2026-09-02: 230 frames and every flow green. `DESKTOP_V2_ONLY=board,pipeline` and `DESKTOP_V2_WIDTHS=1440` narrow a run; `DESKTOP_V2_COLLECT=1` reports every failing frame at the end instead of stopping at the first. |
| `out/` | Gitignored. `out/<frame>/<scheme>/<screen>.png` plus `out/manifest.json` from `capture.ts`; `out/current/<frame>/<scheme>/<screen>.png` plus `out/current/geometry-<frame>.json` from the audit render (§1.0). |

**How to look at it.** On a window larger than the chosen frame the page shows a desktop frame with a bench above it (width, scheme, scenario, one link per screen). In a window of the frame's size, or with the browser's device emulation at 1440×900, the app fills the window and the bench disappears. Everything the design proposes is clickable: switch projects and conversations, answer a question, send, stop, kill and respawn, rotate the orchestrator, edit a stage after start, add and remove stages, answer a parked pipeline, use a reset, pin a conversation beside another at 1920. Query flags: `?scheme=dark|light`, `?w=1280|1440|1920`, `?scenario=noseat|degraded|offline|held|limit|stalled|killed|arrival|crowded|split`; the route is the hash (`#/board`, `#/chat/c2`, `#/pipeline/p1/stage/review`, …). Press `?` for the keyboard map.

---

## 1. Audit — what the desktop shows today

### 1.0 Method

The current build (`main` at `43629d70`, 2026-09-02) was served by the repository's own demo runtime (`scripts/demo-capture.ts` → `bootstrapDemoRuntime`: the disposable seeded home under `fixtures/demo-home/.capture`, the fixture's pending-question and orchestrator-seat holders, the dev server on an ephemeral port) with two pipelines seeded through the shipped store the way `scripts/capture-issue-507-editor.ts` does (a four-stage draft and a four-stage running pipeline whose first stages bind to the fixture's synthetic transcripts). Chrome was driven by playwright-core at 1280×800, 1440×900 and 1920×1080, dark and light, with the capture clock frozen at the fixture instant, and every frame was measured the way `capture.ts` measures the prototype: visible controls under 44×44, pairs of visible controls whose rects intersect, horizontal overflow. Two traps for whoever repeats this: the dev server only answers a browser whose origin it allows (`LLV_DEV_ORIGINS`), so the page is opened through the docker-bridge host the demo environment already names, and the fixture's tmux socket wants a short `LLV_DEMO_TMUX_TMPDIR` in a deep checkout. The driver is a scratch file kept under `out/_audit/` in this worktree (gitignored); lane 0 (§8) turns it into `scripts/capture-desktop-v2.ts`. Nineteen screens per frame and scheme; the numbers below are from 1440 dark unless stated and hold within a few units at the other five cells.

| Screen (1440 dark) | Visible controls | Under 44 px | Overlapping pairs | Smallest visible targets |
| --- | --- | --- | --- | --- |
| Overview | 40 | 33 | 12 | crown 24×24, notification close 24×24, push bell 26×26 |
| Project board (scheme, fit zoom 21 %) | 74 | 66 | 5 | Remove stage 5×4, Update stage 6×6, Move stage 6×6 |
| Focused conversation with a question (fit zoom 55 %) | 95 | 84 | 14 | Dismiss question 9×7, favourite 11×11, expand 14×10, remove column 14×10 |
| Conversation with a subagent tree | 121 | 111 | 15 | rename 12×10, round-limit buttons 11×11 |
| Orchestrator dock, live seat | 61 | 53 | 5 | read aloud 22×22, copy 22×22 |
| Orchestrator seat conversation on the board | 94 | 84 | 19 | rename 12×10, favourite 11×11 |
| Pipeline hub popover | 7 | 7 | 0 | Close controls 5×5, Start pipeline 30×9 |
| Switchboard | 5 | 5 | 0 | close 32×32, account switches 96×32 |
| Accounts dialog | 8 | 7 | 0 | close 22×22, Sign in 56×23 |
| Search palette | 9 | 4 | 0 | close 32×32, scope buttons 78×28 |
| Tasks panel open | 77 | 69 | 9 | on-canvas stage controls 5×4 |
| New pipeline dialog | 6 | 0 | 0 | — |

At 1280 the overlap counts rise (15–19 pairs on the board screens); at 1920 the fit zoom stays at 21–55 %, so the on-canvas controls scale to 8×5 px. Every screen shares the same five overlap pairs: the rail's crown toggle is an absolutely positioned control laid over each project row. The attention island covers the Tasks panel's own header when the panel is open, the deployment pill sits on the rail's Telegram row, and the arrival toast covers the board region it points at.

### 1.1 The project rail

`src/components/ProjectRail.tsx` is a fixed 248 px column. Its header holds the app title, the live count, the attention badge, the language toggle, the access QR and the push bell; at 248 px the title wraps to two lines under that load. Rows carry the name, an age, and two bare integers (`9 11`, `4 4`) with an occasional `⏸ 1` badge between them; the 2026-08 audit's finding 14 (unlabeled counter pairs) still stands. The bottom 45 % of the rail (from about y = 500 of 900 at 1440) is host and account furniture: RAM and swap meters (`ResourcesFooter`), two engine limit blocks with four bars and reset lines (`LimitsFooter`), the Telegram row, and the deployment pill riding on top of it. The rail is the project switcher and it spends less than half its height on projects.

### 1.2 The board header and the floating chrome

`src/components/ProjectDashboard.tsx:1740–1995` renders a 40 px header: project name, a status sentence ("nothing is running right now" / "7 branches running · 6 trees"), sound, settings, search, an Orchestrator toggle, a Tasks toggle with a count, and "+ Pipeline". Below the board sit a second create cluster ("+ Agent · + Task · + Pipeline", bottom-left), the task readiness strip (bottom), the corner status pill ("4 · 5 waiting", bottom-right, `CornerStatus`), the minimap, and, top-right, the attention island ("NEEDS YOU 1 · Next · filter", `AttentionIsland`) with the arrival toast docked under it. Five surfaces answer "what is going on" in four vocabularies: the header sentence, the island's count, the corner pill's "waiting", the rail's `⏸`. Archive project and Delete project are always-visible header controls on the desktop (design-system rule 4 asked for them behind `⋯`; only the phone got that).

### 1.3 The board itself

`src/components/scheme/SchemeBoard.tsx` is the primary surface: every conversation is a full card rendered on a zoomable canvas, pipelines are dashed regions with a hub chip, lineage lines and subagent badges connect them. Fit zoom on the seeded home is 21 % with two pipelines and one loose conversation, 55 % with six trees, 16–18 % at 1280 or with the Tasks panel open: the cards are thumbnails whose text is 2–7 px tall, the on-canvas stage editor controls (reorder, configure, remove) measure 5×4 px, and the board's one-glance triage is a row of unreadable rectangles (the 2026-08 audit's S1 finding 1, still standing: `layout.ts` wraps the rest band only past 10 500 px). Reading anything means zooming in, at which point the board no longer shows the rest. The list view (`ConversationList`) exists behind a segmented control and is a plain catalogue with a search field; it carries no state grouping.

### 1.4 The focused conversation, feed and composer

There is no conversation surface on the desktop. A conversation is a card on the canvas (`BranchPane`), expanded in place or expanded to the full window. Its header packs the dot, a status badge ("NEEDS YOU verify · stage 3/4"), the title, the process chip with a PID and Kill, expand, favourite, delete and close: at 55 % zoom those controls are 9–14 px targets. Below it the feed (`LogFeed`) shows the transcript with the avatar column, tool rows, the question card, then a "live tail" pill, a status row ("waiting for your answer · 1:29:40", in warning tone: the 2026-08 finding 3 is fixed on this row), the control strip (live, stop, refresh, more, terminal), the composer ("prompt — the agent will start"), and the model pill ("Sonnet · Light"). The question card leads with the question and its numbered options and ends with "Your own answer" and a Send button: this reads well and stays (§1.15). The composer's reasoning vocabulary ("Light") still differs from the seat's ("low") and the operator's (`low · high · xhigh · max`): finding 9 stands.

### 1.5 The orchestrator dock

`src/components/orchestrator/OrchestratorDock.tsx` pushes a 440 px column between the rail and the board (PRD #976 decision 1). With the rail that is 688 px before the board starts: 752 px of board at 1440, 592 at 1280. Its content is the best-designed surface in the build: an identity row (engine chip, model, a context figure, Rotate), the seat's conversation with the feed, "finished the turn — waiting for a reply", the control strip and a composer with the model pill. The create state (no seat) shows a prose panel, an MCP install hint in mono, engine, an "Account" select ("Main · active"), a row labelled "Reasoning" that fronts a model select and an effort select ("low"), the mandate disclosure, a footer sentence and "Create orchestrator": finding 15's mislabelled row stands. The dock is a per-project preference that is either open (and takes 30 % of the width) or closed (and the seat is out of sight).

### 1.6 Pipelines: strip, hub, scheme, editor, verdict

A pipeline appears three ways. On the canvas as a region with a hub chip ("⇢ Implement the export … 3/4 · stages running ▾", `PipelineHub`) whose popover holds pause/resume, retry/skip when parked and close; as a strip of stage chips with prev/next arrows, a verdict popover and a stage config popover (`PipelineStrip`); and, for a draft, as the on-canvas editor with five placeholder cards carrying reorder, configure, remove and add-edge controls (`PipelineEditor`, `StagePlaceholderPane`, `StageEdgeControls`) that render at the canvas zoom, so at fit zoom the whole editor is a set of 5×4 px targets. Findings of a failed review live in a popover on a chip. Nothing after start is editable, which is the automation-v2 requirement (#1446) the desktop has to carry: the record becomes mutable and the UI is "slice 12", deferred there to "the same PATCH payloads". The template picker (`PipelineTemplatePicker`: Plan → Build → Review, Build → Review, Build → Verify, Blank canvas, with the repository line) is clear and stays.

### 1.7 Switching: the switchboard and the corner pill

`src/components/Switchboard.tsx` opens a 95 vw × 95 vh modal from the corner pill: a title, the two engine account switches, a search field, then Waiting for you / Working / Recent / Older sections. On the seeded home it shows "Older 0" and "Nothing found" while four conversations are working, because the deck is fed by the timeline hook while the board already holds the files; the 2026-08 finding 12 ("Older" renders furniture at zero) stands, and finding 7 (cards say everything twice) stands in the source. Switching projects is the rail; switching conversations is the canvas, the switchboard, or the search palette's deep link. Three doors, none of them a list you can keep open.

### 1.8 Attention and arrivals

The attention island (`AttentionIsland`) floats top-right over the board with "NEEDS YOU n · Next › · filter", renders "NEEDS YOU 0" at rest (D1 of the 2026-08 audit, still open), and its queue popover is titled "Waiting on you". A new decision docks a toast under the island that repeats the row and covers the board region it points at (finding 8). The corner pill counts "waiting" with a different rule (5 waiting against NEEDS YOU 1 on the same screen). The rail badge is `⏸`. Overview rows carry no attention state (finding 2). `N`/`Shift-N` cycle the queue from the keyboard, which works and stays.

### 1.9 Accounts

`AccountsPanel` opens from the header's per-engine switch as a popover anchored to the board: the active account with a signed-in state and a "needs sign-in" chip, the checked time and Refresh, the 5 h and Week bars with "left" and reset lines, Sign in, Copy CLI, an "add account" field, and "Clean up abandoned homes". The content is right (the #1424 wave made limits actionable); the container is a popover the operator has to reopen per engine, and the same numbers are repeated in the rail footer.

### 1.10 Search

`search/GlobalSearch.tsx` (#1054, ranked in memory by #1440): "Find my messages", a scope switch (My messages / Everything), results with the title, the highlighted snippet, project and engine chips and the age, ↑ ↓ Enter, `/` to open. This is the one desktop surface with nothing to fix; v2 keeps it and gives it the dialog primitive.

### 1.11 Tasks

`tasks/TaskPanel.tsx` is a 280 px right panel with cards ("inbox · Polish overview cards · source · 2h ago"); the attention island renders over its header. The readiness strip at the bottom of the board is a second task surface.

### 1.12 Overview

`OverviewBoard.tsx`: a 40 px header, project cards with the bare count pair, engine chips and up to four live rows, "5 more live", and a quiet card for a project with nothing running. The one project that needs the operator is visible only in the rail badge and the island.

### 1.13 Width by width

- **1280×800.** Rail 248 + dock 440 leaves 592 px of board; fit zoom 18 %; header controls collide with the island when the Tasks panel opens (19 overlapping pairs). The rail footer pushes the project list to 40 % of the height.
- **1440×900.** The frames above.
- **1920×1080.** The same layout with a wider canvas: fit zoom still 21–55 %, so the extra width is spent on empty canvas and the cards stay thumbnails; the rail stays 248 px and the dock 440.

### 1.14 The 2026-08 audit findings, re-checked on this build

| Finding (docs/design/ux-audit-2026-08.md) | Status today | Where v2 answers it |
| --- | --- | --- |
| 1 fit zoom illegible on busy days | stands (21 % / 55 % / 16 %) | §3: the list column is the primary triage; the map is a secondary picker of tiles (§4.11) |
| 2 overview rows carry no attention state | stands | §4.10: the overview column is the cross-project Needs you list; cards sort by state |
| 3 operator-blocking waits show as green | fixed on the status row; the card badge still reads NEEDS YOU while the header dot is green | §2 (10): one precedence, one phrase per surface |
| 7 switch cards say everything twice | stands in source | §6: the switchboard is cut; rows are title · one meta line |
| 8 attention chrome occludes content | stands (toast over the board, island over the Tasks panel) | §4.8: no pill, no toast; the queue is the column; one banner slot for other-project arrivals |
| 9 three vocabularies for effort | stands | §4.3: `low · medium · high · xhigh · max` everywhere |
| 12 chips ellipsize, "Older 0" furniture | stands | §6: switchboard cut |
| 14 unlabeled counter pairs | stands | §4.1: rail rows read `3 need you · 3 working` |
| 15 "Reasoning" fronts a model dropdown | stands | §4.4: Model and Reasoning are separate segmented controls |
| D1 "NEEDS YOU 0" at rest | open | decided here: no pill at all on the desktop; the count lives in the column header, the rail row and the empty stage |
| T1 pipeline surface unaudited | closed by this audit (seeded pipelines) | §1.6 |

### 1.15 What works and stays

- The orchestrator dock's **content**: identity row, Rotate, the seat's own conversation, "finished the turn" phrase, the composer with the model pill. v2 moves it into a stage and a column card and keeps every element (§4.4).
- The **question card** order: question, numbered options, own answer. Kept, with the answer sending on the click (§4.2).
- **Global search** (#1054 / #1440): kept whole.
- **The template picker** for a new pipeline: kept whole.
- **Accounts** content (#1424): active account, windows, reset lines, Refresh, Use one reset, sign-in state. Kept, as a stage instead of a popover (§4.5).
- **The switchboard's triage grouping** (Waiting for you / Working / Recent): kept as the column's sections, always visible instead of modal.
- **Keyboard cycling of the queue** (`N`): kept and extended to a single-key map (§3.5).
- **Card state vocabulary and the depth ladder** (#961, #962): kept as the column's badges and the map's tiles.
- **Dark-scheme parity**: pixel-verified in the frames; kept through the shared tokens.
- **In-app conversation links and the cached feed on switch** (#1445): the column's row click is exactly that switch.
- **Direct Kill with the PID visible** in Host details; the two-step arm goes (standing rule), the receipt's Respawn is the safety net.

### 1.16 Prior art

Searched prior conversations (`search_transcripts`, four phrasings: "desktop redesign prototype rail column stage", "desktop v2 information architecture project rail switchboard", "scheme board pipeline strip hub audit 1440 desktop", "issue 1453 desktop UI/UX redesign"). Nothing earlier designed the desktop as a whole; the hits were the 2026-08 audit's reconnaissance stage (#693, whose synthesis is `docs/design/ux-audit-2026-08.md` and whose findings §1.14 re-checks) and this lane's own first attempt, whose prototype and capture script were preserved on a checkpoint branch when the account it ran on hit its limit; this document restores and finishes that work. The audit's own "what works" list (switchboard grouping, card state vocabulary, held/rotation visibility, dead-host recovery copy, launch-flow coherence, directory-picker keyboard support, composer focus discipline, dark parity) was re-checked against the frames and is carried in §1.15.

---

## 2. Design principles (from the requirement and the mobile v2 contract, made concrete for a desktop)

1. **One frame, three regions, one primary surface.** Rail (projects) · column (the project's triage list, the seat first) · stage (one thing at a time: a conversation, a pipeline, the seat, accounts, the map, the overview). Dialogs and popovers open over the stage and never create history. The desktop's extra width buys a fourth region only at ≥ 1600 px, where one conversation can be pinned beside the stage.
2. **The list is the board.** The column answers "what needs me, what is running, what just finished" in words, in state order, always on screen. The spatial view survives as a map of tiles behind one key; no conversation content is ever rendered on a canvas.
3. **The seat lives in the column and opens a stage.** The orchestrator is the first card of every project's column with its state, its current tool and its context meter; its conversation is a stage like any other, with the seat panel (identity, mandate, Rotate) at the top of it. Nothing pushes the board sideways.
4. **Pipelines are read in the column and edited in a stage.** A pipeline row says `stage k/n · <stage> · <state>`; its stage shows findings, the actions for its state, the stage graph with edges and add-points, the attributed change log, and a stage editor whose actions are the automation-v2 mutations (§4.6). Editing after start is the normal path.
5. **One queue, one phrase, no pill.** Needs you holds conversations and pipelines, in the column, on the overview, on the rail rows as counts, and behind `n` / `N`. An arrival in another project shows in the one banner slot and collapses; an arrival in the current project is a new row with an edge. Nothing floats over content.
6. **Keyboard first.** Single keys while nothing is being typed (`n N o / m a p t c [ ?`), arrows and Enter in the column, Escape as the universal "back to the column", Enter sends and Shift+Enter breaks a line. Every dialog traps focus and returns it. The capture proves the order.
7. **Host details behind one click.** Background tasks, PIDs, memory, hidden conversations and the runtime connection live in one dialog; the status bar carries the one host fact worth a glance (connected / degraded / offline, the task count, the accounts' lowest window).
8. **Few controls, all 44 px, none overlapping, one overflow.** Icon buttons are 44 px targets with 18 px glyphs; chips 30 px inside 44 px targets; the status bar is one target tall. The capture refuses any visible control under 44×44 and any two whose rects intersect.
9. **No confirmation prompts; receipts carry the inverse.** Kill → Respawn, Close → Reopen, Archive → Restore, Skip → Retry stage, remove stage → Undo, switch account → Switch back, Start → Pause, Pin → Unpin. Four seconds, in flow above the composer or at the bottom of the stage body, never covering a control.
10. **One state, one precedence, one vocabulary, shared with the phone.** killed > stalled > limit > held > waiting > working > returned > done; offline and degraded are frame-level. "Needs you", "a question", "plan approval", "needs a decision", "working 12:40", "finished the turn", `low · medium · high · xhigh · max`. The prototype's `stateBits` is the same function the mobile prototype carries.
11. **Both schemes, the product's tokens.** Every colour, radius, type size and shadow is `src/styles/tokens.css` value for value; the dark palette flips with `prefers-color-scheme` and `data-theme`.

---

## 3. Information architecture

### 3.1 The map

```
Rail (240 · 220 at 1280 · 64 collapsed with [)          Column (380 · 340 at 1280 · 400 at 1920)            Stage (the rest; a pinned pane of 480/520 at ≥ 1600)
  Agent Log Viewer ‹                                       atlas · 3 need you · 2 working · 3 pipelines      one primary surface:
  Filter projects…                                         [list ⇄ map] [+] [⋯]                               · empty: "3 need you · press n …" + the key map
  Overview · 4 need you across 4 projects                  Filter · ↑ ↓ Enter                                  · conversation (§4.2) + composer (§4.3)
  Crowned · atlas ♛ 3                                      ┌ Orchestrator  working 2:14   ⚙ ┐                  · seat = orchestrator conversation + seat panel (§4.4)
  Projects · beacon-site · corvid-tools 1 · delta-ledger   │ list_conversations · ▰▰▰▰▰▱ 76% left │             · pipelines list · one pipeline + stage editor (§4.6)
  Archive · 1                                              Needs you · 3   (conversations and pipelines)      · accounts & limits (§4.5)
  + Create project                                         Pipelines · 3   (+ n completed, folded)             · tasks · map (§4.11) · overview cards (§4.10)
                                                           Working · 2                                        dialogs over the stage: + create · ⋯ board menu ·
                                                           Recent · 5 · All conversations · n ›                  ⋯ conversation menu · next-message · details & host ·
Status bar (44): ● connected · ⌨ 3 background tasks ··· ✦ Main 38 % left · ⌘ Main 55 % left · ? shortcuts       search · host details · shortcuts · new conversation ·
                                                                                                                new pipeline (templates) · rotate / create orchestrator
```

### 3.2 The persistent frame

The rail, the column and the status bar never leave. The rail is the project switcher (Overview, crowned projects, projects, Archive, Create project) with a filter and a collapse to 64 px icons (`[`); a collapsed row shows the project's initials with its Needs you count. The column is the selected project's triage list: the seat card, then Needs you, Pipelines, Working, Recent, each a collapsible section with its count; a filter field at the top narrows every section including the seat card, `↑ ↓` walk the rows and `Enter` opens the highlighted one. The column header carries the project name, one sentence of counts, the list ⇄ map segmented control, `+` and `⋯`. The status bar carries the runtime state, the background task count (both open Host details), one chip per engine with the active account and its lowest window (opens Accounts & limits), and `? shortcuts`.

### 3.3 Primary surfaces and dialogs

Stages, pushed onto history: the empty stage, a conversation, the seat (`#/seat`), the pipelines list, one pipeline (with `/stage/<id>` and `/add/<index>` selecting the editor), accounts, tasks, the map (`#/map`), the overview (`#/overview`). Dialogs and popovers, replacing the route and creating no history: the board `⋯` menu, the `+` create menu, search (`/`), host details, keyboard shortcuts (`?`), new conversation, new pipeline, the rotate / create-orchestrator dialog, the conversation `⋯` menu, the next-message popover (model · reasoning · account), details & host. A scrim or a click-away layer owns everything outside a dialog; Escape closes it and returns focus to the control that opened it; browser back from a dialog pops the stage underneath and takes the dialog with it.

### 3.4 Widths

| Frame | Rail | Column | Stage | Pinned pane |
| --- | --- | --- | --- | --- |
| 1280 × 800 | 220 (64 collapsed) | 340 | 720 (876 collapsed) | — (the Pin control is absent under 1600) |
| 1440 × 900 | 240 | 380 | 820 | — |
| 1920 × 1080 | 240 | 400 | 1280, or 760 beside a pinned pane | 520 |

The pipeline stage's editor column is 360 px (320 at 1280); the feed's prose column is capped at 880 px and centred, so a 1920 stage reads as a page.

### 3.5 The keyboard map

| Key | Does |
| --- | --- |
| `n` / `N` | next / previous item that needs you, in the column's order (conversations and pipelines); on the overview across every project |
| `o` | the orchestrator's conversation; with no seat, the create dialog |
| `/` | find my messages |
| `m` | map ⇄ list |
| `a` `p` `t` | accounts & limits · pipelines · tasks |
| `c` | create (conversation · task · pipeline · orchestrator when none) |
| `[` | collapse / expand the rail |
| `↑` `↓` `Enter` | move in the column and open the highlighted row (also from inside the filter field) |
| `Esc` | close the dialog; from the composer, back to the column's current row; from the filter, clear it |
| `Enter` / `Shift+Enter` | send / newline in the composer |
| `?` | this list |

Single keys are inert while an input, textarea or select has focus; the capture types into the filter and the composer and checks that.

### 3.6 Where the seat lives, how pipelines are read and edited, how attention surfaces, how switching feels

- **Seat.** The column's first card: `Orchestrator` · state badge (`working 2:14`) · what it does now (running tool or last line) · the context meter filling with what remains, with a ⚙ opening `#/seat`. That stage is the orchestrator's own conversation with a seat panel above the feed: filled engine mark, model · reasoning, account · plan · "holding the seat for 2h · predecessor", the state badge, the meter (`76 % left of 100k`) with "Predecessor · open ›", the mandate preview (three faded lines), Rotate and Edit the mandate, and one sentence saying that changing mandate, model or account means a successor. With no seat the card invites ("No orchestrator · Create an orchestrator ›") and `o` opens the create dialog, which is the rotate dialog in create mode (engine · model · reasoning · account rows · mandate textarea · Cancel · Create orchestrator). Confirming acts on the click and lands on `#/seat`.
- **Pipelines.** Read: the column row (`stage 2/5 · build · running 2h · edit pending`, badge), the pipelines stage (Needs you / Active / Drafts / Completed / Archived), the map's regions. Edited: the pipeline stage (§4.6). A stage conversation reaches its pipeline from the first row of its `⋯` menu and shows `stage k/n` in its meta line.
- **Attention and arrivals.** The Needs you section (edged rows, badges), the count in the column header, the rail row's count and badge, the overview's cross-project queue, the empty stage's "3 need you · press n", `n` / `N`. A decision that arrives in **another** project shows in the banner slot at the top of the stage (`Needs you · a question · corvid-tools / Release 2.4 checklist`, open on click, × to dismiss, collapses after ~6 s, never announced twice once opened); one in the current project is a new edged row and nothing else. Offline and degraded take the same slot in info tone on every stage and the status bar's runtime chip turns.
- **Switching.** Projects: the rail (one click), the overview's card headers, the search result's project. Conversations: the column rows (a click replaces the stage and keeps the column), `n` / `N`, `↑ ↓ Enter`, the search result, the members line of a parent, the pipeline stage's `open ›` on an attempt, the arrival banner. The stage never remounts the frame: only the stage region changes, which is what #1445 made cheap.

---

## 4. Screen by screen

The prototype's 38 key screens, by their `screens.js` id. Every screen renders at the three frames in both schemes except `chat-split`, which renders at 1920 only.

### 4.1 Board and project rail (`board`, `board-noseat`, `board-degraded`, `board-crowded`, `board-rail-collapsed`, `board-menu`, `create-menu`, `overview`)

- **Rail rows** are dot · name · one line (`3 need you · 3 working`, `1 needs you · quiet · 41 min`, `quiet · 2d`, `archived · 9d`) · crown · a Needs you badge. Crowned projects sit in their own section; Archive folds; Create project is the rail's foot. Collapsed, a row is the project's two initials with the badge as a superscript.
- **Column rows** are dot · title (two lines when the row needs the operator) · one meta line · one trailing element. A conversation's meta reads `waiting 9 min · ⌘ gpt-5.6 · stage 2/5` or `working 12:40 · Edit cardStatus.ts · ✦ Opus · stage 2/5`; the state phrase never truncates, the now-fragment does. A pipeline's meta reads `stage 3/5 · review · 2 findings` or `stage 2/5 · build · running 2h · edit pending`. A row that needs the operator carries a 3 px warning (or danger) edge and a badge, and its dot is hidden: two coloured elements per row at most.
- **Needs you holds both kinds**: a conversation waiting on a question, a plan approval, stalled or at its limit, and a pipeline parked in `needs_decision`. The badge count, the rail count, `n` and the overview all read the same list.
- **Recent** shows five rows and `All conversations · n ›`; **Pipelines** shows the active ones and folds the completed count.
- **Degraded / offline**: the banner slot in info tone on the stage, the status bar's runtime chip in warning or danger, and `⋯ › Host details` carries a badge.
- **Crowded** (`board-crowded`: thirty conversations, ten pipelines, fourteen projects): every Needs you row ends inside the first screen at 1280×800 (the capture checks the last one's bottom edge), the rail scrolls, the column scrolls, the frame never scrolls sideways.
- **`+`** (`c`): New conversation, New task, New pipeline, and Create an orchestrator when there is none. **`⋯`**: Tasks (`t`), Pipelines (`p`), All conversations, Accounts & limits (`a`), Host details (with the runtime badge when not connected), Keyboard shortcuts (`?`), Sound, then Archive project (Restore in the receipt) and Delete project in danger colour (acts on the click; Restore in the receipt for 4 s).
- **Overview** (`#/overview`, the rail's first row): the column becomes the cross-project queue, every row carrying a project chip; the stage shows one card per project (name, crown, `3 need you · 3 working · 12 total`, its rows in state order, `4 more`), quiet projects as one line. `n` walks the queue across projects.

### 4.2 Conversation and feed (`chat-working`, `chat-waiting`, `chat-idle`, `chat-menu`, `chat-details`, `chat-arrival`, `chat-offline`, `chat-held`, `chat-limit`, `chat-stalled`, `chat-killed`, `chat-split`)

```
┌ ● Rebuild the board status projection                                          [pin] ⋯ ┐  52  title · meta: state phrase · ✦ Opus · high · stage 2/5 · llv-212-status-projection
│   working 12:40 · ✦ Opus · high · stage 2/5 · llv-212-status-projection                │
│ ⑂ 2 members · Explore: status readers · Test writer                                    │  32  members line, only when the conversation has children
│                                   ┌ Read issue 212 and tell me the smallest change … ┐ │      user bubble, right, 72 % max, 15 px
│ › 3 actions · Read ×2 · Grep ×1                                          13:41–13:42   │  44  folded run, one line
│ ✦ Opus                                                                          13:43  │  44  message header: click = copy / read aloud
│ The projection lives in one module that turns transcript facts into a card status …    │      prose, 15 px, 880 px column
│ ┌ 🔧 Edit CardStatusBadge.tsx                                              13:57 0.2s ┐│      a run with a failure: one sunken block,
│ │ ✕ Bash bun test …                                   exit 1                13:58 4.1s ││      36 px list items, the detail under the error,
│ │   1 fail · expected «held», received «working»                                       ││      the running tool last
│ └ ◌ Edit cardStatus.ts                                                     13:59 4s   ┘│
│ ┌ Message the agent…                                                                  ┐│
│ │ (✦ Opus · high ⌄)  📎  🎤            Enter send · Shift+Enter newline        ■ Stop │ │      one box; the slot is Stop while working and the draft is empty
└ └──────────────────────────────────────────────────────────────────────────────────────┘ ┘
```

- **State precedence** in `stateBits`, one function for the column row, the header meta, the composer slot and the map tile:

  | State | Row (meta · trailing) | Header meta | Composer |
  | --- | --- | --- | --- |
  | offline (frame-level) | rows keep their last state | unchanged; the banner says `Offline · reconnecting` | the slot is **Queue**; a send answers "Held until reconnected" |
  | degraded (frame-level) | — | unchanged; info banner | unchanged |
  | killed | `killed · messages queue` · › (Recent) | same, danger | placeholder `killed · text queues until a respawn`; the slot is **Respawn** |
  | stalled | `14 min · ✦ Opus` · badge `stalled`, danger edge | `stalled · 14 min` | send; `⋯ › Kill agent` hints "stalled" |
  | limit | `limit · Main resets 16:40` · badge `limit`, warning edge | same | the chip reads `Opus · Main at limit` in warning; its popover offers the other authenticated accounts and routes a not-signed-in one to the device sign-in |
  | held | `held · 2 messages queue` · › (Working) | same, warning | placeholder `held · text you send queues` |
  | waiting | `waiting 9 min · ⌘ gpt-5.6` · badge `a question` / `plan approval`, warning edge | `a question · 9 min` | question card + suggested chips; the placeholder reads `Your own answer…` |
  | working | `working 12:40 · Edit cardStatus.ts · ✦ Opus` · › | `working 12:40` | the slot is **Stop**; typing flips it to send |
  | returned | `finished the turn · 32 min` · › | same, accent | send |
  | done | `done · 2h` · › | same | send |

- **Header**: dot, title, one meta line (state phrase, engine glyph, model, reasoning, `stage k/n`, the worktree in mono), then at most three controls: Pin beside (≥ 1600 only, while nothing is pinned), the seat's ⚙ on the orchestrator's own conversation, `⋯`. Every former card control is a labelled row in `⋯`: the pipeline row first (`Pipeline · <task> · stage k/n · <stage> · <state>`, opening the pipeline stage), Pin beside / Unpin, Rename, Crown / Remove crown, Hand off (receipt: Open successor), Compact context (`71 % left`), Details & host, Open in terminal, a separator, Close card (receipt: Reopen), Kill agent in danger colour with a hint (`running now` / `stalled` / `not running`; receipt: Respawn). No row asks for confirmation.
- **Feed**: prose at 15 px in an 880 px column, the user's bubbles right at 72 %, a 44 px message header (mark · model · time) whose click offers copy and read aloud, a clean run of tool calls folded to one 44 px line, a run with a failure expanded into one sunken block of 36 px lines with the error detail, the running tool last, a viewer tool call with `open ›` when it names a conversation (#1445's in-app links).
- **Question** (`chat-waiting`): the card (`⚠ Needs you · 9 min`, the question at 15/600, options as 44 px rows with a radio mark, "Or type your own answer below — it is sent as the reply"); picking an option sends it, so does a suggested chip, so does send with typed text; the reply renders as the user's bubble, the state flips to working, the card folds to `› question · answered 14:05` and expands on click with the pick marked; the row leaves Needs you.
- **Details & host** (from `⋯`): account, context meter, worktree, pipeline, members; then the runtime row and the background tasks with a Kill each.
- **Arrival** (`chat-arrival`): the banner slot above the feed shows a decision that arrived in another project; its body opens the conversation and stamps it seen; back shows no banner again.
- **Split** (`chat-split`, 1920): Pin beside (header control or `⋯` row) pins the current conversation as a fourth region of 520 px with its own header, feed and composer (prefixed focus ids, so the composer gate walks both); the stage keeps its width rule (760 px beside the pane). At 1280 and 1440 the control does not exist and the capture checks that it does not render.

### 4.3 Composer (`chat-working`, `chat-model`, every chat screen)

One box under the feed, 880 px max, the field on top (auto-growing to 240 px) and one tool row under it: the model · reasoning chip (opening the next-message popover: "Applies to your next message", Model, Reasoning `low · medium · high · xhigh · max`, Speed for Codex, and an Account group first when the account is at its limit, listing the blocked account with its reset, the other authenticated accounts as `ready` rows, and a not-signed-in one as `sign in →`), attach, dictate, the `Enter send · Shift+Enter newline` hint, and the send slot: send, or **Stop** while the agent works and the draft is empty, **Queue** while offline, **Respawn** when killed. Enter sends; the slot flips from Stop to send the moment the draft is non-empty; Escape from the field returns focus to the column's current row. Tab order: field → chip → attach → dictate → send slot, measured on every chat frame. There is no status row and no live-tail pill: elapsed time is in the header meta, and following is the feed's default.

### 4.4 Orchestrator panel (`seat`, `seat-rotate`, `board-noseat`, `chat-menu` on the seat)

- **Seat card** in the column (§3.6). **Seat stage** (`#/seat`, `o`, the card, the ⚙, the seat conversation's `⋯ › Orchestrator seat`): the orchestrator's conversation with the seat panel above its feed. The panel is one card-height block: identity (filled engine mark, `Opus · high`, `Main · Max plan · holding the seat for 2h · predecessor`, the state badge), the meter (`76 % left of 100k`, `Predecessor · open ›`), the mandate preview (`Mandate v3`, three lines faded), and on the right Rotate (primary), Edit the mandate, and the one-sentence successor note. A rotation-recommended line appears in warning under the meter when ≤ 30 % of the window is left.
- **Rotate dialog** (`seat-rotate`): a plain-sentence hint ("A successor takes the seat with the mandate below; the current orchestrator hands over its context and stops"), Engine / Model / Reasoning as segmented controls (one vocabulary), Account rows (authenticated only), the Mandate textarea prefilled and focused, Cancel / Rotate orchestrator. Confirming acts on the click, lands on `#/seat`, and the feed shows the successor's first line. With no seat the same dialog is "Create an orchestrator" with Create orchestrator as its primary; the create panel's prose and MCP install line are gone (they belong in the docs and the receipt).
- Everything #976, #977, #1347, #1419 and #1448 decided about the seat's authority, rotation and successor forks is unchanged; only the surface moves (from a pushed dock to a card and a stage).

### 4.5 Accounts (`accounts`, the status bar chips, `chat-limit`, `chat-model`)

A stage (`a`, the status bar chips, `⋯ › Accounts & limits`): one card per engine. The active account as a header (filled mark, label, `active`, plan, `checked 14:02`, the lowest window in the corner as `38 % left / Week` coloured by what remains), each window as `label · meter · % left` with its reset line, Refresh and Use one reset as 44 px buttons; other authenticated accounts as `ready` rows that switch future launches on click (receipt: Switch back); accounts that are not signed in as `sign in →` rows that open the device sign-in and stay inactive until it returns; Add a … account last. The status bar shows, per engine, the active account and its lowest window; the limit state of a conversation (`chat-limit`) routes to the same rows from the composer chip.

### 4.6 Pipelines: strip, hub, scheme, and editing after start (`pipelines`, `pipeline`, `pipeline-running`, `pipeline-edit-stage`, `pipeline-edit-running`, `pipeline-add-stage`, `pipeline-draft`, `pipeline-completed`, `new-pipeline`, `board-map`)

The strip, the hub popover and the on-canvas editor are replaced by one stage; the scheme's pipeline regions survive on the map as regions of tiles with a hub chip that opens this stage.

```
┌ ● Archive TTL for closed pipelines (#206)                              needs a decision  ⧉ ┐  52  task · meta: state · stage 3/5 · started 3h · branch (mono) · rev 9 · last edit by operator 1h ago
│ ┌ Review · attempt 2 · 2 findings · stage 3/5 · review                                    ┐│      findings card (warning edge) with the Answer field:
│ │ 1. The sweep still runs on every poll …   2. The TTL test asserts on wall-clock time …  ││      answer { text } creates attempt 3 from the worktree
│ │ [Answer for the next attempt (sent as a note with the question)…            ] [Answer] ││
│ [Retry stage] [Skip stage] [Pause] [Archive]         PATCH /api/pipelines/p2 · expectedRevision 9 │      the actions for this state; the payload hint names the fence
│ ┌ Stages · click a stage to edit it, an edge to add one · edits after start land on the next attempt ┐
│ │ 1/5 build passed → 2/5 verify passed → 3/5 review failed ↺ fix ×3 → 4/5 fix passed → 5/5 publish  │      stage cards: role, engine · model · reasoning, access, attempts · state, open ›
│ ┌ Changes · 3 · every mutation is attributed and revision-stamped                          ┐│      rev 9 settle · review · attempt 2 failed · fail-edge budget 2 of 3 used · controller · 14:04
│ ┌ Linked tasks · 1 ┐                                                                        │
```

- **Pipelines list** (`p`): Needs you / Active / Drafts / Completed / Archived, rows as in the column, New pipeline in the header (the template picker, unchanged: Plan → Build → Review, Build → Review, Build → Verify, Blank graph; a draft lands in the column and opens its stage).
- **Actions by state**, acting on the click: draft → Start pipeline (receipt: Pause), Discard draft (Restore); needs a decision → Retry stage, Skip stage (Retry stage), Pause, Archive (Restore); running → Pause, Checkpoint, Archive; paused → Resume, Archive; completed → Re-run the last stage (reopens it), Archive; archived → Restore. The payload hint beside the actions shows the route and the `expectedRevision` the request carries.
- **Stage editor** (click a stage card; `#/pipeline/<id>/stage/<stage>`): Role, Engine, Model, Reasoning, Access, Sandbox (segmented), Declared outputs for a read-only stage, Account, Prompt; a note that says what the save does (`Applies from attempt n — the next time this stage runs`, or for a running stage `Attempt 1 is running with its own copy of this definition. Saving applies from attempt 2; Restart stops attempt 1 and starts 2 from the current worktree`, or for a completed pipeline `Save the edit first, then re-run this stage to reopen it`); **Save · from attempt n** and, on a running stage, **Restart now**. Then Edges (pass →, fail ↺ with the round budget; `Save edges`; a traversed edge may still be rewired, lowering the budget below the used count parks the next fail verdict), Note for the next attempt (`Add note`; ten pending notes per stage at most), Re-run this stage (from worktree / last-passed / checkpoint, `Stop attempt n first` when one is unsettled, refused otherwise and the note says why), Remove (only a stage without attempts; one with attempts stays as history and is routed around), and the payload hint (`edit-stage {stageId, expectedRevision}`). The stage card shows `edit pending · applies from attempt n` and `k notes for the next attempt` until an attempt binds them.
- **Add a stage** (the ⊕ on any edge or after the last stage; `#/pipeline/<id>/add/<index>`): id, role, engine, model, reasoning, prompt; the note says where it lands (`Inserted at its seam: build → new stage → verify`, and `history-only until an edge or a re-run reaches it` when it sits before the cursor); Add stage (receipt: Undo) opens the new stage's editor.
- **The change log** lists every mutation newest first: `rev n · action · stage · detail · actor · time · effect` (applied / pending-next-attempt / restarted-attempt), which is automation-v2's attributed log rendered.
- **Mapping to automation-v2 §3.3** (the same names, the same payloads, `expectedRevision` on every mutation that changes a definition, attaches a note, creates or stops an attempt): Save = `edit-stage`; Restart now = `edit-stage { restart: true }`; Save edges = `set-edge` (pass and fail with `maxRounds`); Add note = `note`; Re-run = `rerun-stage { from, stopCurrent }`; Answer = `answer { text }`; Add stage = `add-stage { stage, index }`; Remove stage = `remove-stage`; Checkpoint = `checkpoint { name }`; Retry stage / Skip stage / Pause / Resume / Archive / Restore / Start = `retry-stage` (`rerun-stage from: "last-passed"` once aliased) / `skip-stage` / `pause` / `resume` / `close` / `restore` / `start`. The prototype's fixture carries `revision`, `mutations`, per-stage `attempts`, `pendingEdit`, `notes`, `checkpoints` and `waiting`, and the capture's flows check the effects the engine will produce (a save on a running stage is pending for attempt n+1, a re-run is refused while attempt n is unsettled and allowed with `stopCurrent`, a completed pipeline reopens after edit-then-re-run, remove is refused on a stage with attempts). Until the automation slices land, the same screen shows today's actions and the editor answers a refused mutation with the refusal in its receipt: the control is the capability; the engine's answer is the truth.

### 4.7 Search (`search`)

`/` or the `⋯` row opens the dialog over the stage: the field with the query, the scope segmented control (My messages / Everything), a corpus line, results as 52 px rows (title, highlighted snippet, project chip, engine glyph, time), `↑ ↓` to move, Enter opens the conversation at the message, Escape closes and returns focus. This is #1054 / #1440 in the new dialog primitive.

### 4.8 Attention and arrivals (`board`, `overview`, `chat-arrival`, the empty stage)

No pill, no toast. The queue is the column's Needs you section (both kinds, edged rows), the column header's count, the rail row's count and badge, the overview column, and `n` / `N`. The empty stage says `3 need you · Press n to open the next decision, or pick a row on the left` (or `Nothing needs you`) and lists the five keys. A decision that arrives in another project shows in the stage's banner slot (`⚠ Needs you · a question · corvid-tools / Release 2.4 checklist`, open on click and stamp seen, `×`, collapse after ~6 s); one in the current project is a new row and nothing else, because the column is already the announcement. Offline and degraded take the same slot in info tone.

### 4.9 Project and conversation switching (`board`, `overview`, `chat-*`, `search`)

A rail row switches the project and lands on its empty stage (or the map when the map was the last view). A column row switches the conversation or the pipeline in the stage and keeps the column and the rail; the row is marked current. `n` / `N` walk the queue; on the overview they cross projects and switch the rail row with them. A search result switches both. The pinned pane (≥ 1600) stays while the stage changes. There is no modal switcher: the column is the switchboard, always open.

### 4.10 Overview (`overview`)

Described in §4.1. The column is the cross-project queue with project chips on every row; the stage is a grid of project cards (auto-fill, 300 px minimum) whose header is the project row (name, crown, counts, ›) and whose body is up to four rows in state order plus `n more` or `quiet · last activity 2d`.

### 4.11 Map (`board-map`, `m`)

The segmented control (or `m`) swaps the stage for the map: pipelines as dashed regions with the well fill, each with a hub chip (`⟐ Implement the export endpoint (#218) · 2/5 · running`) that opens the pipeline stage; inside, one tile per stage, either the stage's conversation (title, state phrase, engine · model, an edge and a badge when it needs the operator) or a ghost for a stage that has not started (`stage 3/5 · verify · Builder · not started`); loose conversations as tiles below; zoom out / 100 % / zoom in / fit; a minimap. Tiles are 200 px wide and read at 100 %; no conversation content is rendered on the canvas, so there is no zoom level at which the map is illegible. A click on a tile opens the stage.

### 4.12 Tasks, host details, create (`tasks`, `host`, `new-agent`, `new-pipeline`, `create-menu`, `keys`)

- **Tasks** (`t`): a stage listing the project's tasks (state dot, title, state · linked conversation), New task in the header, a row opening its linked conversation.
- **Host details**: the runtime row (`connected · updates stream` / `degraded · polling every 10 s` / `offline · reconnecting`), background tasks with name, PID in mono, memory, age and a Kill each (acts on the click), and Hidden (closed conversations with Reopen).
- **New conversation**: Engine, Model, Reasoning (segmented), Account rows (`ready` / `chosen`, a not-signed-in one routes to sign-in), Directory, First message; Start conversation acts on the click, lands in the new conversation, receipt with Kill.
- **Keyboard shortcuts** (`?`): the §3.5 table as a dialog.

---

## 5. Visual language

- **Tokens**: `prototype/styles.css`'s `:root` and dark blocks are `src/styles/tokens.css` value for value. Surfaces: canvas behind the frame, card for the seat card, the composer box, the stage cards and the map tiles, sunken for fields, folded runs and segmented controls, raised for dialogs, popovers and receipts, board / well / quiet on the map. Shadow-1 only on cards over the canvas; shadow-2 only on dialogs, popovers and receipts. Two radii: 8 px controls, 12 px surfaces; pills only for badges, chips and dots.
- **Type**: 15/600 stage titles and message content (prose at 1.5, user bubbles), 13/600 row titles, 13/400 rows and stage cards, 12 for tool lines, buttons and the editor's fields, 11 for meta lines and section headers, 10 for badges; tabular numerals on every time, count and percentage; mono only for PIDs, worktree and branch names and the payload hints.
- **State as an edge, at most two coloured elements per row**: a row that needs the operator carries a 3 px warning (or danger) edge and a badge; the current pipeline stage a 3 px accent edge; the selected stage card an accent ring; nothing tints a whole header. Dots: success live (pulsing only on the current row and the stage header), warning waiting or held, danger stalled or killed, accent returned or running pipeline, neutral done.
- **Badges**: one recipe, 20 px, soft fill + role text: `working 2:14`, `a question`, `plan approval`, `needs a decision`, `stalled`, `limit`, `running`, `passed`, `failed`, `draft`, `completed`, `active`, `ready`, `attempt 1 running`.
- **Engine marks**: a 16 px glyph in secondary colour (Claude sparkle, Codex command) in rows, meta lines, stage cards and message headers; the filled 36 px circle only on the account cards and the seat panel.
- **Meters**: the fill is what remains, coloured by what remains (accent above 30 %, warning at or under 30 %, danger at or under 10 %).
- **Motion**: stage change 120 ms crossfade; dialogs rise over 200 ms; the working dot pulses at 1.6 s; the banner collapses after ~6 s; everything stills under `prefers-reduced-motion` (the capture renders with it reduced).
- **Receipts**: raised surface, success edge, in flow above the composer box (inside a dialog, above its footer; on a list stage, at the bottom of the body), 4 s, the inverse action as an accent text button. The body shrinks by the receipt's height, so no control can sit beneath it; the gate checks every receipt against every control.

---

## 6. Deliberately cut

- **The scheme board as the primary surface** (`SchemeBoard` with expanded conversation cards, lineage lines, subagent badges, the on-canvas draft editor, drag-to-link handoff, lasso and bulk actions, tasks placed on the map, the task sticky composer). The frames show why: at fit zoom every day's board is a row of thumbnails with 5×4 px controls. The map survives as a secondary picker of tiles (§4.11); the actions the canvas gestures performed are rows (`⋯ › Hand off`, Close card, Archive) and, for bulk selection, §7.
- **The switchboard modal, the switch cards and the corner status pill** (`Switchboard`, `SwitchCard`, `CornerStatus`, `useSwitchboardData`). The column is the switchboard, always open, fed by the files the board already has.
- **The attention island, the "NEEDS YOU 0" pill and the arrival toast** on the desktop. The queue is the column; the only banner is for another project's arrival.
- **The orchestrator dock as a pushed third column** (`OrchestratorDock`, `OrchestratorPanelToggle`). The seat is a column card and a stage; the launch module inside `OrchestratorPanel` survives as the rotate / create dialog.
- **The pipeline strip, the hub popover, the verdict popover and the on-canvas stage editor** (`PipelineStrip` desktop mode, `PipelineHub`, `VerdictPopover`, `PipelineEditor`, `StagePlaceholderPane`, `StageEdgeControls`). One pipeline stage with findings, actions, the graph and the editor.
- **The rail footers** (RAM and swap meters, the two limit blocks, the Telegram row) and the rail header's toggles (language, access QR, push bell). Resources and background tasks are Host details; limits are the status bar and the Accounts stage; the three toggles become rows in the board `⋯` beside Sound (not prototyped; lane 1 carries them as rows).
- **The floating create cluster, the header's status sentence, sound and settings buttons, the always-visible Archive and Delete project**. One `+` menu, one `⋯` menu, one sentence of counts under the project name.
- **The task readiness strip and the Tasks side panel**. One Tasks stage.
- **The worker stacks and the residual strip** (`WorkerStacks`, `TreeAside`'s residual strip). Recent, `All conversations · n ›` and Host details › Hidden.
- **The conversation card's header controls** (kill with PID, expand, favourite, delete, close inline) and the two-step Kill. One `⋯` with labelled rows; the receipt's Respawn is the safety net (standing rule: no confirmation prompts).
- **The composer's status row, the live-tail pill and the control strip** on the desktop. Stop is the send slot, elapsed time is the header meta, the strip's rows are in `⋯`.
- **The "Reasoning" row that fronts a model select, the "Light / Medium" tier names and the `effort: default` label**. Model and Reasoning are separate segmented controls with the tier ids.
- **Per-engine account popovers anchored to the board**. One Accounts stage.

---

## 7. Deferred — not currently justified

Scope the requirement does not demand, kept on record here.

- **Semantic zoom for the map** (#183). The map of tiles is legible at 100 % and answers "where is everything" without it; #183 stays the destination if the tile map ever needs levels.
- **Spatial editing on the map** (drag-to-link handoff, manual placement, lasso and bulk actions, tasks on the canvas). The column rows and menus carry the same actions one at a time; a multi-select in the column (Shift-click, bulk Close / Archive / Kill with one receipt) is the shape if the operator asks for bulk actions.
- **A tabbed stage or multiple pinned panes.** One stage plus one pinned pane at ≥ 1600 covers "the orchestrator beside a worker"; more panes would recreate the canvas.
- **Resizable rail and column.** Fixed widths per frame keep the gates provable; a drag handle is a small addition later.
- **A command palette beyond `/` and the single keys.** The map of keys is short enough to learn from `?`.
- **Inline transcripts on the pipeline stage.** A stage card's `open ›` opens the attempt's conversation in the stage; embedding transcripts would rebuild the canvas problem.
- **Findings ledger across rounds, checkpoint browsing, per-attempt diffs.** Automation-v2 §7 defers the ledger; the change log and the attempt list cover what the record carries.
- **The readiness kanban as a stage.** The Tasks stage is a list; the kanban returns if the operator uses it on the desktop.
- **A tablet layout.** 768–1279 px stays on the current shell with the coarse-pointer sizing fix (2026-08 finding 11); this design starts at 1280.
- **An in-app theme toggle.** `data-theme` exists; the OS scheme flips the palette.
- **Screen-reader work.** Out of scope by the standing audit direction; nothing here blocks it later.
- **The document preview host** (`preview/ArtifactPreviewHost`). Untouched by this design; it opens over the stage as it opens over the board today.

---

## 8. Implementation plan — one lane per slice, one owner per file

Open only after the operator's word (Wanted 5). Each lane is one issue with the acceptance below, a pinned spec quoting the operator's requirement, and the frames from lane 0 as its evidence. A file has exactly one owner among open lanes; where a file is owned by an open mobile-v2 lane (`docs/design/mobile-v2/README.md` §8) or an automation-v2 lane (`docs/design/automation-v2/README.md` §6.1), the desktop lane opens after that lane merges and the row says so. New files carry ⁺ and live under `src/components/desktop/` unless a lane says otherwise; `src/lib/i18n/en.ts` and `uk.ts` are append-only per lane with keys prefixed `desktop2.<surface>.*`. Every edited path resolves on `origin/main` at `43629d70`.

| # | Lane | Owns (new ⁺ / edits) | After | Acceptance |
| --- | --- | --- | --- | --- |
| 0 | **Capture harness** | `scripts/capture-desktop-v2.ts` ⁺, `scripts/capture-desktop-v2.test.ts` ⁺ | — | Renders the production build against the seeded demo home (the `demo-capture` recipe with pipelines seeded through the shipped store, §1.0) at 1280×800, 1440×900 and 1920×1080, both schemes, the same screen ids as `prototype/screens.js` including the state screens via seeded fixtures; the same gates as `capture.ts` (no overflow, 44 px, no overlapping controls, receipt covers no control, scheme applied, composer and dialog focus order) and the §3.5 key flows; the test proves each gate can go red. |
| 1 | **Shell: frame, routes, status bar, dialog and receipt primitives, keyboard map, board menus, host details** | `DesktopShell.tsx` ⁺, `desktopNav.ts` ⁺ (+ test: stages push, dialogs replace and create no history, Escape returns focus to the trigger), `DesktopStatusBar.tsx` ⁺, `DesktopDialog.tsx` ⁺ (scrim, focus trap, Escape), `DesktopReceipt.tsx` ⁺ (in flow, 4 s, inverse action), `desktopKeys.ts` ⁺ (+ test: single keys inert while typing), `BoardMenu.tsx` ⁺, `CreateMenu.tsx` ⁺, `HostDetailsDialog.tsx` ⁺, `KeysDialog.tsx` ⁺; edits `src/components/Viewer.tsx` (the desktop branch mounts the shell; stops mounting the dock, the fixed attention anchor and the connection pill), `src/components/runtime/DeploymentStatusPill.tsx` (a status bar chip) | 0; mobile lane 1 (`Viewer.tsx`) | Frames `board`, `board-menu`, `create-menu`, `host`, `keys`, `board-rail-collapsed`; every dialog takes focus, wraps Tab, closes on Escape and returns focus; the status bar is 44 px tall and its chips open Host details and Accounts; no control under 44 px, none overlapping. |
| 2 | **Column, seat card, rail v2, overview v2** | `DesktopColumn.tsx` ⁺, `columnModel.ts` ⁺ (+ test: grouping, the precedence killed > stalled > limit > held > waiting > working > returned > done, both kinds in Needs you, Recent capped at five, the filter narrows the seat card, `n`/`N` order), `SeatCard.tsx` ⁺, `OverviewStage.tsx` ⁺; edits `src/components/ProjectRail.tsx` (rows read a phrase, the crown toggle inside the row's hit area, footers and header toggles stop mounting, Create project at the foot, collapse to 64 px), `src/components/OverviewBoard.tsx` (retired in favour of `OverviewStage`), `src/components/LimitsFooter.tsx`, `src/components/ResourcesFooter.tsx` (retired) | 1 | Frames `board`, `board-noseat`, `board-crowded`, `overview`; the queue count is the same number in the column header, the rail row and the overview; with thirty conversations and ten pipelines every Needs you row ends inside the first screen at 1280; the rail's crown never overlaps a row. |
| 3 | **Conversation stage: header, meta precedence, `⋯` menu, details, split** | `ConversationStage.tsx` ⁺, `DesktopConversationMenu.tsx` ⁺, `ConversationDetailsDialog.tsx` ⁺, `PinnedPane.tsx` ⁺; edits `src/components/BranchPane.tsx` (desktop: no inline header controls; the header becomes title + meta), `src/components/AgentControlStrip.tsx` (desktop: rows in the menu), `src/components/TaskHeader.tsx` (`ProcessStatusControls`: direct kill on the desktop) | 1; mobile lane 3 (`BranchPane.tsx`, `AgentControlStrip.tsx`, `TaskHeader.tsx`) | Frames `chat-working`, `chat-idle`, `chat-menu`, `chat-details`, `chat-offline`, `chat-held`, `chat-limit`, `chat-stalled`, `chat-killed`, `chat-split` (1920 only); the meta precedence test; Kill and Close act on the click with Respawn and Reopen in the receipt; the Pin control renders only at ≥ 1600. |
| 4 | **Feed and composer at desktop density** | edits `src/components/feed/FeedItem.tsx`, `feed/cards/ToolCard.tsx`, `feed/cards/CmdGroupCard.tsx`, `feed/QuestionCard.tsx`, `feed/SuggestedReplies.tsx`, `src/components/ComposerBar.tsx`, `RuntimePill.tsx`, `TmuxComposer.tsx`, `LogFeed.tsx`, `TurnStatusBar.tsx` | 3; mobile lanes 4 and 5 (they own these files until they merge) | Frames `chat-working`, `chat-waiting`, `chat-model`; 880 px prose column at 15 px; the 44 px message header; folded runs and the failure block; options and chips send on the click and the card folds; the box with the chip inside; the slot is Stop / send / Queue / Respawn; Enter sends, Shift+Enter breaks; Tab walks field → chip → attach → dictate → send; no status row, no live-tail pill on the desktop; one vocabulary. |
| 5 | **Seat stage and rotate dialog** | `SeatStage.tsx` ⁺, `SeatPanel.tsx` ⁺, `RotateDialog.tsx` ⁺; edits `src/components/orchestrator/OrchestratorPanel.tsx` (the launch module renders inside the dialog; the create prose and the MCP line go), `IncumbentHeader.tsx` (the identity row of the panel), `OrchestratorDock.tsx` and `OrchestratorPanelToggle.tsx` (deleted), `src/components/shellLayout.ts` (no dock inset) | 1, 3 | Frames `seat`, `seat-rotate`, `board-noseat`; `o` opens the seat or the create dialog; Rotate and Create act on the click and land on `#/seat`; the mandate textarea is focused on open; `capture-issue-977` and `978` retire with the dock and their acceptance moves to lane 0's `seat` frames. |
| 6a | **Pipelines, read side and today's actions** | `pipelines/PipelineStage.tsx` ⁺, `pipelines/PipelinesList.tsx` ⁺, `pipelines/StageCards.tsx` ⁺, `pipelines/ChangesLog.tsx` ⁺, `pipelines/PipelineActions.tsx` ⁺ (today's `PIPELINE_ACTIONS` through the existing PATCH route) | 1, 2 | Frames `pipelines`, `pipeline`, `pipeline-running`, `pipeline-draft`, `new-pipeline`; Retry / Skip / Pause / Resume / Archive / Start act on the click with their inverse in the receipt; every attempt's `open ›` opens its conversation; a stage conversation's `⋯` first row opens its pipeline. |
| 6b | **Pipeline editing after start = automation-v2 slice 12** | `src/components/pipelines/StageEditor.tsx` ⁺, `AddStageEditor.tsx` ⁺; edits `src/components/pipelines/VerdictPopover.tsx` (the findings block with the Answer field), `PipelineStrip.tsx`, `PipelineHub.tsx`, `PipelineEditor.tsx`, `StagePlaceholderPane.tsx`, `StageEdgeControls.tsx` (retired on the desktop), `pipelineModel.ts` (state phrases, `waiting`, pending edits) — automation-v2 lane G owns this directory | 6a; automation-v2 slices 10 and 11 | Frames `pipeline-edit-stage`, `pipeline-edit-running`, `pipeline-add-stage`, `pipeline-completed`; the flows of `capture.ts` (save → pending-next-attempt on a running stage, restart, set-edge, note, rerun refused then allowed with stopCurrent, answer, add / remove with undo, completed → edit → re-run) run against the real route with `expectedRevision`; a refused mutation lands in the receipt with the engine's reason. |
| 7 | **Map of tiles** | `MapStage.tsx` ⁺; edits `src/components/scheme/SchemeBoard.tsx` (tile mode: no expanded conversations on the canvas, hub chips open the pipeline stage, ghosts for stages that have not started), `scheme/layout.ts` (tile size; the rest band derives its width from the tree count — 2026-08 finding 1), `scheme/Minimap.tsx`, `scheme/expandedNode.ts`, `scheme/TasksLayer.tsx`, `scheme/TaskStickyComposer.tsx`, `scheme/BulkActionBar.tsx`, `scheme/lasso.ts` (off the map), `src/components/ProjectDashboard.tsx` (the desktop leaf mounts the map only when the column's view is map; the floating create cluster, the header toolbar, `TaskReadinessStrip`, `WorkerStacks` and the residual strip stop rendering on the desktop), `src/components/TaskReadinessStrip.tsx`, `WorkerStacks.tsx`, `TreeAside.tsx` (retired on the desktop) | 2; mobile lane 2 (`ProjectDashboard.tsx`); automation-v2 slices 9b and 12 (lane E's `ProjectDashboard.tsx` and `scheme/**` edits) | Frame `board-map`; every tile is legible at 100 %; the map's tools never overlap a hub chip; `m` toggles; a tile opens the stage. |
| 8 | **Accounts stage** | `AccountsStage.tsx` ⁺; edits `src/components/AccountsPanel.tsx` (the stage layout on the desktop; the popover container goes), `EngineAccountSwitch.tsx`, `AccountBadge.tsx`, `ProjectAccounts.tsx` (retired: the status bar and the stage replace the header switch), `ConnectionPill.tsx` (retired: the status bar's runtime chip) | 1; mobile lane 9 (`AccountsPanel.tsx`, `AccountBadge.tsx`, `EngineAccountSwitch.tsx`) | Frames `accounts`, `chat-limit`, `chat-model`; switch / refresh / use-reset act on the click; a not-signed-in row opens the device sign-in and stays inactive; the composer chip's Account group reaches the same rows; `capture-issue-1418` still green. |
| 9 | **Attention and arrivals** | edits `src/components/attention/AttentionIsland.tsx` (no desktop pill; the count is the column's), `AttentionToast.tsx` (desktop: the banner slot, other-project arrivals only, ~6 s collapse, seen stamp), `src/components/attention.ts` (the queue includes `needs_decision` pipelines in the column's order), `attention/navigate.ts` (`n` / `N` walk that order; across projects on the overview) | 2; mobile lane 8 (`AttentionIsland.tsx`, `AttentionToast.tsx`, `attentionQueue.ts`) | Frames `chat-arrival`, `board`, `overview`; the banner never shows for the current project; a seen decision is not announced again after back; `capture-issue-963` retires with the island and its acceptance moves to lane 0. |
| 10 | **Search in the dialog primitive** | edits `src/components/search/GlobalSearch.tsx` (desktop geometry: 760 px dialog over the stage, the scope control as a segmented control, `↑ ↓ Enter` kept) | 1 | Frame `search`; `/` opens with the field focused; Escape returns focus to the trigger. |
| 11 | **Retire and document** | delete `src/components/Switchboard.tsx`, `SwitchCard.tsx`, `CornerStatus.tsx`, `src/hooks/useSwitchboardData.ts`, `src/components/pipelines/PipelineHub.tsx` and their tests; update `docs/design/viewer-design-system.md` §3.1–3.3 | 3, 6b, 7, 8, 9 | Type-check green; no desktop surface imports a retired file; the design-system doc names the column, the stage and the status bar. |

Order: 0 → 1 → {2, 10} → {3, 5, 6a, 8, 9} → 4 → 6b → 7 → 11. Lanes 3, 4, 8 and 9 wait for the mobile lanes that own their files; 6b and 7 wait for the automation-v2 slices named. Review per lane by a fresh reviewer against the pinned quote and the frames. The desktop and the phone share `stateBits`, the badge recipe and the vocabulary, so a lane that lands on one form factor leaves the other untouched and a partial rollout is safe.

---

## 9. Validation against the requirement

| Wanted | Delivered here |
| --- | --- |
| 1 · audit at 1280, 1440, 1920, both schemes, from rendered frames of the current build against a seeded home, covering board and rail, conversation and feed, orchestrator panel, pipelines (strip, hub, scheme), accounts, search, attention, switching; what works and stays | §1: nineteen screens per cell rendered through the demo runtime with seeded pipelines, measured (§1.0 table), read (§1.1–1.13), re-checked against the 2026-08 audit (§1.14), the keep list (§1.15) |
| 2 · a mobile-v2-consistent IA: the persistent frame, a primary surface, where the seat lives, how pipelines are read and edited, how attention and arrivals surface, how search and switching feel, what is cut | §2, §3, §6; `stateBits`, the badge recipe, the receipt, the banner slot, the navigation contract and the vocabulary are the mobile v2 ones |
| 3 · static clickable prototype, HTML/CSS/JS, invented fixtures, both schemes, three widths, capture script with headless gates (no overflow, no overlapping controls, 44 px, focus order in composer and dialogs) | `prototype/` (38 screens, every action clickable, ten scenarios), `capture.ts` (230 gated frames and the flows, green on 2026-09-02), `.gitignore` with `out/` |
| 4 · design document: verbatim requirement with date and source, audit, principles, IA, screen by screen, cuts, implementation plan by lane with one owner per file, "Deferred — not currently justified" | this file; `git status` shows only `docs/design/desktop-v2/` |
| 5 · approval gate | the orchestrator shows `out/` and this document to the operator; lanes 0–11 open only after their word |

The operator's words: "з нуля" (from scratch) → §3 replaces the whole frame; "з урахуванням того що в планах" (what is planned) → §4.6 is automation-v2's slice 12 drawn, §2 and §4 are mobile v2's contract on a desktop; "того що зроблено вже" (what is done) → §1.15 keeps the wave that shipped (#1422 compact notices as receipts, #1424 accounts content, #1440 / #1054 search whole, #1445 switching as the column, #1419 / #1448 seat authority untouched) and the audit's protected list.

---

## 10. Over-engineering pass on this design

Cut from the first draft before it reached the prototype: a tabbed stage (one stage plus one pinned pane is the desktop's whole answer to "two things at once"); a resizable, rearrangeable dashboard (fixed widths per frame keep the gates provable and the frame learnable); a notification centre (the column is the queue; a banner slot is the only announcement); a command palette (`/` plus eleven single keys); inline transcripts on the pipeline stage (the attempt's `open ›` is one click); a second navigation model for the map (the map is a view of the same stage; tiles open the same routes); live conversation previews on the map (the exact thing the current board does at 21 %). What remains is one frame, one list, one stage, one dialog primitive, one receipt, one state function shared with the phone, and a pipeline stage that draws the automation record as it will be. A round that removes more is a successful round.
