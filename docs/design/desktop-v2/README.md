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
Rail (240 · 64 collapsed, the default under 1440)       Column (380 · 340 at 1280 · 400 at 1920)            Stage (the rest; a pinned pane of 480/520 at ≥ 1600)
  Agent Log Viewer ‹                                       atlas · 3 need you · 3 working                    one primary surface, and it always does work:
  Filter projects…                                         [board ⇄ list ⇄ map] [+] [⋯]                       · the board: task ▸ worker ▸ pipeline as one card (§4.12)
  Overview · 4 need you across 4 projects                  Filter · ↑ ↓ Enter                                  · conversation (§4.2) + composer (§4.3)
  Crowned · atlas ♛ 3                                      ┌ Orchestrator  working 2:14   ⚙ ┐                  · seat = orchestrator conversation + seat panel (§4.4)
  Projects · beacon-site · corvid-tools 1 · delta-ledger   │ list_conversations · ▰▰▰▰▰▱ 76% left │             · pipelines list · one pipeline: graph + editor (§4.6)
  Archive · 1                                              Needs you · 3   (conversations and pipelines)      · accounts & limits, and one account in detail (§4.5)
  + Create project                                         Pipelines · 3   └ 2/5 build · a question · 9 min    · map (§4.11) · overview cards (§4.10)
                                                           Working · 1                                        dialogs over the stage: + create · ⋯ board menu ·
                                                           Recent · 6 · All conversations · n ›                  ⋯ conversation menu · next-message · details & host ·
Status bar (44): ● connected · ⌨ 3 background tasks ··· ✦ Main 38 % left · ⌘ Main 55 % left · ? shortcuts       search · host details · shortcuts · new conversation ·
                                                                                                                new pipeline (templates) · rotate / create orchestrator
```

### 3.2 The persistent frame

The rail, the column and the status bar never leave. The rail is the project switcher (Overview, crowned projects, projects, Archive, Create project) with a filter and a collapse to 64 px icons (`[`, and the default under 1440); a collapsed row shows the project's initials with its Needs you count. The column is the selected project's triage list: the seat card, then Needs you, Pipelines, Working, Recent, each a collapsible section with its count and a **sticky header** that stacks at the top edge as the column scrolls; a filter field at the top narrows every section including the seat card, `↑ ↓` walk the rows and `Enter` opens the highlighted one. **Each id renders once**: Needs you wins, Pipelines lists only what Needs you has not already shown, and a pipeline row folds its live attempt under it as an indented child row (`└ 2/5 build · builder · a question · 9 min`) unless that conversation is already in the queue. The column header carries the project name, one sentence of counts computed by the same function the rail row and the overview card use, the board ⇄ list ⇄ map segmented control, `+` and `⋯`. The status bar carries the runtime state, the background task count (both open Host details), one chip per engine with the active account and its lowest window (which opens that account's detail), and `? shortcuts`.

**The stage always does work.** There is no placard: the landing surface of a project is the board (§4.12) when it has tasks, else the first thing that needs the operator, else the orchestrator's conversation. The key legend lives in `?` and nowhere else.

### 3.3 Primary surfaces and dialogs

Stages, pushed onto history: the board (`#/board`, and `#/kanban` for it by name), a conversation, the seat (`#/seat`), the pipelines list, one pipeline (with `/stage/<id>` and `/add/<index>` selecting the editor), accounts (`#/accounts`) and one account in detail (`#/accounts/<engine>/<id>`), the map (`#/map`), the overview (`#/overview`). Dialogs and popovers, replacing the route and creating no history: the board `⋯` menu, the `+` create menu, search (`/`), host details, keyboard shortcuts (`?`), new conversation, new pipeline, the rotate / create-orchestrator dialog, the conversation `⋯` menu, the next-message popover (model · reasoning · account), details & host. A scrim or a click-away layer owns everything outside a dialog; Escape closes it and returns focus to the control that opened it; browser back from a dialog pops the stage underneath and takes the dialog with it.

### 3.4 Widths

| Frame | Rail | Column | Stage | Pinned pane |
| --- | --- | --- | --- | --- |
| 1280 × 800 | **64 by default** (220 with `[`) | 340 | 876 | — (the Pin control is absent under 1600) |
| 1440 × 900 | 240 | 380 | 820 | — |
| 1920 × 1080 | 240 | 400 | 1280, or 760 beside a pinned pane | 520 |

The rail starts collapsed under 1440 and `[` expands it, so the crowded column keeps the 156 px the rail would have taken; `screens.js` and this table say the same thing, and the capture asserts `data-rail="0"` at 1280 and `"1"` at 1440 and above.

The pipeline stage's editor pane is 440 px (520 at 1920) beside the graph; at 1280 the editor takes the stage's width and the graph collapses to a one-line ladder above it, so the stage being edited is never off screen. The editor's own body scrolls and its footer (Save · Restart · Cancel and the "applies from attempt n" note) never leaves the viewport. The column header's count sentence is one line at every width: `n need you · m working`, and at 1280 `n need you` alone — the Pipelines section header carries the pipeline count. The feed's prose column is capped at 880 px and centred, so a 1920 stage reads as a page.

### 3.5 The keyboard map

| Key | Does |
| --- | --- |
| `n` / `N` | next / previous item that needs you, in the column's order (conversations and pipelines); on the overview across every project |
| `o` | the orchestrator's conversation; with no seat, the create dialog |
| `/` | find my messages |
| `k` / `t` | the board (the kanban of task ▸ worker ▸ pipeline threads) |
| `m` | map ⇄ list |
| `a` `p` | accounts & limits · pipelines |
| `c` | create (conversation · task · pipeline · orchestrator when none) |
| `i` | type to the agent: focus the composer from anywhere in the frame |
| `1` – `9` | pick that option of the open question |
| `[` | collapse / expand the rail |
| `↑` `↓` `Enter` | move in the column and open the highlighted row (also from inside the filter field); `Enter` on a stage node opens its editor |
| `Esc` | close the dialog; **from anywhere in the stage, back to the column's current row**, focused and scrolled into view; from an account detail, back to the accounts stage with the focus on the row that opened it; from the filter, clear it |
| `Enter` / `Shift+Enter` | send / newline in the composer |
| `?` | this list |

**Where the focus is.** Opening a stage moves focus to the one thing the operator came to do: the first option of an open question, else the Answer field of a parked pipeline, else the first control of an open stage editor, else the composer, else the first row. Every re-render puts the focus back on the element that was there, found by its `data-focus` / `data-act` / `data-go` identity rather than its position, so acting never drops the operator on the body — the capture asserts that on every frame.

Single keys are inert while an input, textarea or select has focus: text is text. `Esc` is the bridge — it leaves the field for the column's current row, and from the column every single key works. That is also how the queue is walked: `n` opens the next decision, `Esc` returns, `n` opens the one after.

### 3.6 Where the seat lives, how pipelines are read and edited, how attention surfaces, how switching feels

- **Seat.** The column's first card: `Orchestrator` · state badge (`working 2:14`) · what it does now (running tool or last line) · the context meter filling with what remains, with a ⚙ opening `#/seat`. That stage is the orchestrator's own conversation with a seat panel above the feed: filled engine mark, model · reasoning, account · plan · "holding the seat for 2h · predecessor", the state badge, the meter (`76 % left of 100k`) with "Predecessor · open ›", the mandate preview (three faded lines), Rotate and Edit the mandate, and one sentence saying that changing mandate, model or account means a successor. With no seat the card invites ("No orchestrator · Create an orchestrator ›") and `o` opens the create dialog, which is the rotate dialog in create mode (engine · model · reasoning · account rows · mandate textarea · Cancel · Create orchestrator). Confirming acts on the click and lands on `#/seat`.
- **Pipelines.** Read: the column row (`stage 2/5 · build · running 2h · edit pending`, badge), the pipelines stage (Needs you / Active / Drafts / Completed / Archived), the map's regions. Edited: the pipeline stage (§4.6). A stage conversation reaches its pipeline from the first row of its `⋯` menu and shows `stage k/n` in its meta line.
- **Attention and arrivals.** The Needs you section (edged rows, badges), the count in the column header, the rail row's count and badge, the overview's cross-project queue, the empty stage's "3 need you · press n", `n` / `N`. A decision that arrives in **another** project shows in the banner slot at the top of the stage (`Needs you · a question · corvid-tools / Release 2.4 checklist`, open on click, × to dismiss, collapses after ~6 s, never announced twice once opened); one in the current project is a new edged row and nothing else. Offline and degraded take the same slot in info tone on every stage and the status bar's runtime chip turns.
- **Switching.** Projects: the rail (one click), the overview's card headers, the search result's project. Conversations: the column rows (a click replaces the stage and keeps the column), `n` / `N`, `↑ ↓ Enter`, the search result, the members line of a parent, the pipeline stage's `open ›` on an attempt, the arrival banner. The stage never remounts the frame: only the stage region changes, which is what #1445 made cheap.

---

## 4. Screen by screen

The prototype's 47 key screens, by their `screens.js` id. Every screen renders at the three frames in both schemes except `chat-split`, which renders at 1920 only — 278 frames, each one gated.

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

One box under the feed, 880 px max, the field on top (auto-growing to 240 px) and one tool row under it: the model · reasoning chip (opening the next-message popover: "Applies to your next message", Model, Reasoning `low · medium · high · xhigh · max`, Speed for Codex, and an Account group first when the account is at its limit, listing the blocked account with its reset, the other authenticated accounts as `ready` rows, and a not-signed-in one as `sign in →`), attach, dictate, and the send slot (the `Enter sends` hint lives in the placeholder, not in a permanent row): send, or **Stop** while the agent works and the draft is empty, **Queue** while offline, **Respawn** when killed. Enter sends; the slot flips from Stop to send the moment the draft is non-empty; Escape from the field returns focus to the column's current row. Tab order: field → chip → attach → dictate → send slot, measured on every chat frame. There is no status row and no live-tail pill: elapsed time is in the header meta, and following is the feed's default.

### 4.4 Orchestrator panel (`seat`, `seat-rotate`, `board-noseat`, `chat-menu` on the seat)

- **Seat card** in the column (§3.6). **Seat stage** (`#/seat`, `o`, the card, the ⚙, the seat conversation's `⋯ › Orchestrator seat`): the orchestrator's conversation with the seat panel above its feed. The panel is one card-height block: identity (filled engine mark, `Opus · high`, `Main · Max plan · holding the seat for 2h · predecessor`, the state badge), the meter (`76 % left of 100k`, `Predecessor · open ›`), the mandate preview (`Mandate v3` with an inline `Edit ›`, three lines of the real mandate faded out by a mask), and on the right **Edit the mandate** and **Rotate**, both secondary and both 44 px — Rotate is the one action that discards the seat's context, so it does not get the primary button. The identity row does not repeat the state badge the conversation header already carries. A rotation-recommended line appears in warning under the meter when ≤ 30 % of the window is left.
- **Rotate dialog** (`seat-rotate`): a plain-sentence hint ("A successor takes the seat with the mandate below; the current orchestrator hands over its context and stops"), Engine / Model / Reasoning as segmented controls (one vocabulary), Account rows (authenticated only), the Mandate textarea prefilled and focused, Cancel / Rotate orchestrator. Confirming acts on the click, lands on `#/seat`, and the feed shows the successor's first line. With no seat the same dialog is "Create an orchestrator" with Create orchestrator as its primary; the create panel's prose and MCP install line are gone (they belong in the docs and the receipt).
- Everything #976, #977, #1347, #1419 and #1448 decided about the seat's authority, rotation and successor forks is unchanged; only the surface moves (from a pushed dock to a card and a stage).

### 4.5 Accounts (`accounts`, the status bar chips, `chat-limit`, `chat-model`)

**Every account at once, every one with its meters.** A stage (`a`, the status bar chips, `⋯ › Accounts & limits`): one well per engine, and inside it one row per account on the same recipe — dot, label, plan · `checked 14:02`, then **both windows as meters** (`5 h` and `Week`, each with `% left` coloured by what remains) and one line of reset clocks, then `active` / `ready` / `sign in →`. An account that is not signed in carries the same two meters, empty, and says so; nothing on this stage is a one-line row that hides its consumption. Add a … account is the last row of each well.

**A row is a target.** Click or `Enter` opens `#/accounts/<engine>/<id>`, the account's own stage: the identity header, both windows as large meters with their reset clocks, the **burndown** (the ideal pace as a dashed line, what is actually left as the accent line, and the projection to empty as a dashed danger line — the read model `src/lib/burndown.ts` already computes), a pace panel that says `burning at 15.8 % per hour`, whether that is ahead of or behind pace, and either `runs out at 16:40 at this pace` or `lasts to the reset`, today's consumption by hour as bars, and the actions **Switch to this account** (receipt: Switch back) / Use one reset / Refresh / Sign in. `Esc` returns to the accounts stage with the focus back on the row that opened the detail.

The status bar shows, per engine, the active account and its lowest window, and its chip opens that account's detail. The composer chip's Account group uses the same row recipe with each account's lowest window; the limit state of a conversation (`chat-limit`) routes to those rows.

### 4.6 Pipelines: strip, hub, scheme, and editing after start (`pipelines`, `pipeline`, `pipeline-running`, `pipeline-edit-stage`, `pipeline-edit-running`, `pipeline-add-stage`, `pipeline-draft`, `pipeline-completed`, `new-pipeline`, `board-map`)

The strip, the hub popover and the on-canvas editor are replaced by one stage; the scheme's pipeline regions survive on the map as regions of tiles with a hub chip that opens this stage.

**The graph is the stage.** A pipeline is drawn as a signalling diagram, top to bottom, and it is the first thing in the stage body — never a strip that scrolls sideways or hides four stages of five:

```
 ● ┃ Architect          plan   ✦ Opus · high · read-only · 1 attempt · passed        ●  passed
   ┃ pass → build                                                              ⊕
 ● ┃ Builder           build   ⌘ gpt-5.6 · high · read-write · 1 attempt · running   ●  running
   ┃ pass → verify                                                             ⊕
 ● ┃ Builder          verify   ⌘ gpt-5.6 · medium · read-write · 2 attempts · passed ●● passed
   ┃ pass → review                                                             ⊕            ╭─╮
 ◉ ┃ Reviewer         review   ✦ Opus · xhigh · read-only · 3 attempts · running       ●●●  │ │  ↺ fix
   ┃   attempt 1 · failed · d2d2d2 · 2 findings   open ›                                    │ │  ● ● ○
   ┃   attempt 2 · failed · e3e3e3 · 1 finding    open ›                                    │ │
   ┃   attempt 3 · running · f4f4f4               open ›                                    │ │
   ┃ pass → docs ↓                                                             ⊕            │ │
 ● ┃ Builder             fix   ✦ Sonnet · high · read-write · 2 attempts · passed      ●●  ◂╯ │
   ┃ pass → review ↑                                                           ⊕
 ○ ┊ Builder            docs   ✦ Sonnet · medium · read-write · not started
```

A 2 px **spine** runs down a 28 px gutter and each stage is a **station** on it, filled by that stage's last verdict — green passed, red failed, violet and pulsing while it runs, hollow before it starts; the spine is violet where the pipeline has been and dashed grey where it has not. **Per-attempt pips** on the node say `attempt 1 failed → attempt 2 failed → attempt 3 running` as a shape. A **fail edge is a real loop**: a bracket in the right gutter from its source to its target, with the arrowhead at the target and the **round budget as pips** (`● ● ○` = 2 of 3 spent), and the node repeats it in words (`2 of 3 rounds`). Every node carries the role as its title with the stage id beside it, the engine mark, `model · reasoning`, access, the attempt summary, `edit pending · applies from attempt n` and `k notes` when they are pending. The current stage has an accent edge and its station pulses. A node expands into its attempt list (`attempt 2 · failed · 9c41aa · 2 findings · open ›`) on click or `Enter`, so a three-round loop's history is on the stage and not in three conversations. The ⊕ on each seam inserts a stage there.

The head of the stage is the task with one meta line (state · stage k/n · started · branch · rev · last edit), then the findings card of a parked pipeline (`Reviewer · attempt 2 · round 2 of 3 · 2 findings`, an earlier round folding open in place, the Answer field), then the actions, then the graph beside the editor.

- **Pipelines list** (`p`): Needs you / Active / Drafts / Completed / Archived, rows as in the column, New pipeline in the header (the template picker, unchanged: Plan → Build → Review, Build → Review, Build → Verify, Blank graph; a draft lands in the column and opens its stage).
- **Actions by state**, acting on the click: draft → Start pipeline (receipt: Pause), Discard draft (Restore); needs a decision → Retry stage, Skip stage (Retry stage), Pause, Archive (Restore); running → Pause, Checkpoint, Archive; paused → Resume, Archive; completed → Re-run the last stage (reopens it), Archive; archived → Restore. The receipt names the revision the record moved to; the request payload that carried it is the API contract below, not product copy.
- **Stage editor** (click a stage card; `#/pipeline/<id>/stage/<stage>`): Role, Engine, Model, Reasoning, Access, Sandbox (segmented), Declared outputs for a read-only stage, Account, Prompt; a note that says what the save does (`Applies from attempt n — the next time this stage runs`, or for a running stage `Attempt 1 is running with its own copy of this definition. Saving applies from attempt 2; Restart stops attempt 1 and starts 2 from the current worktree`, or for a completed pipeline `Save the edit first, then re-run this stage to reopen it`); **Save · from attempt n**, **Restart now** on a running stage, and Cancel, all three in a footer that never leaves the viewport, with the note beside them. The four less-used groups are disclosures, shut by default so the editor opens on what is edited most: Edges (pass →, fail ↺ with the round budget; `Save edges`; a traversed edge may still be rewired, lowering the budget below the used count parks the next fail verdict), Note for attempt n (`Add note`; ten pending notes per stage at most), Re-run this stage (from worktree / last-passed / checkpoint, `Stop attempt n first` when one is unsettled, refused otherwise and the note says why), Remove this stage (only a stage without attempts; one with attempts stays as history and is routed around). Role · Engine and Model · Reasoning and Access · Sandbox sit two to a row, and no segmented label wraps at any width. The stage node shows `edit pending · applies from attempt n` and `k notes for the next attempt` until an attempt binds them; the graph beside the editor keeps the edited stage on screen, and at 1280 the ladder above the editor does the same job in one line.
- **Add a stage** (the ⊕ on any edge or after the last stage; `#/pipeline/<id>/add/<index>`): id, role, engine, model, reasoning, prompt; the note says where it lands (`Inserted at its seam: build → new stage → verify`, and `history-only until an edge or a re-run reaches it` when it sits before the cursor); Add stage (receipt: Undo) opens the new stage's editor.
- **The change log** lists every mutation newest first: `rev n · action · stage · detail · actor · time · effect` (applied / pending-next-attempt / restarted-attempt), which is automation-v2's attributed log rendered.
- **Mapping to automation-v2 §3.3** (the same names, the same payloads, `expectedRevision` on every mutation that changes a definition, attaches a note, creates or stops an attempt): Save = `edit-stage`; Restart now = `edit-stage { restart: true }`; Save edges = `set-edge` (pass and fail with `maxRounds`); Add note = `note`; Re-run = `rerun-stage { from, stopCurrent }`; Answer = `answer { text }`; Add stage = `add-stage { stage, index }`; Remove stage = `remove-stage`; Checkpoint = `checkpoint { name }`; Retry stage / Skip stage / Pause / Resume / Archive / Restore / Start = `retry-stage` (`rerun-stage from: "last-passed"` once aliased) / `skip-stage` / `pause` / `resume` / `close` / `restore` / `start`. The prototype's fixture carries `revision`, `mutations`, per-stage `attempts`, `pendingEdit`, `notes`, `checkpoints` and `waiting`, and the capture's flows check the effects the engine will produce (a save on a running stage is pending for attempt n+1, a re-run is refused while attempt n is unsettled and allowed with `stopCurrent`, a completed pipeline reopens after edit-then-re-run, remove is refused on a stage with attempts). Until the automation slices land, the same screen shows today's actions and the editor answers a refused mutation with the refusal in its receipt: the control is the capability; the engine's answer is the truth.

### 4.7 Search (`search`)

`/` or the `⋯` row opens the dialog over the stage: the field with the query, the scope segmented control (My messages / Everything), a corpus line, results as 52 px two-line rows — the title with the project chip, the engine glyph and the time right-aligned on line one, the highlighted snippet clipped on line two, so a long snippet never paints over the meta column, `↑ ↓` to move, Enter opens the conversation at the message, Escape closes and returns focus. This is #1054 / #1440 in the new dialog primitive.

### 4.8 Attention and arrivals (`board`, `overview`, `chat-arrival`, the empty stage)

No pill, no toast. The queue is the column's Needs you section (both kinds, edged rows), the column header's count, the rail row's count and badge, the overview column, and `n` / `N`. There is no key legend on the stage; `?` is the one place for keys. A decision that arrives in another project shows in the stage's banner slot (`⚠ Needs you · a question · corvid-tools / Release 2.4 checklist`, open on click and stamp seen, `×`, collapse after ~6 s). One in the **current** project is a new row with its warning edge fading in once, and the column header's count and the rail badge ticking once (200–320 ms, still under reduced motion) — the column is the announcement, and silence would be a step too far. Offline and degraded take the same slot in info tone.

### 4.9 Project and conversation switching (`board`, `overview`, `chat-*`, `search`)

A rail row switches the project and lands on its landing stage — the board when the project has tasks, else the first thing that needs the operator, else the seat (or the map when the map was the last view). A column row switches the conversation or the pipeline in the stage and keeps the column and the rail; the row is marked current. `n` / `N` walk the queue; on the overview they cross projects and switch the rail row with them. A search result switches both. The pinned pane (≥ 1600) stays while the stage changes. There is no modal switcher: the column is the switchboard, always open.

### 4.10 Overview (`overview`)

Described in §4.1. The column is the cross-project queue with project chips on every row; the stage is a grid of cards (auto-fill, 300 px minimum) for the projects that have something running: the header is the project row (name, crown, `9 need you · 11 working · 11 pipelines`, ›) and the body is up to eight rows in state order plus `n more`. Projects with nothing running do not get a card — they collapse into one `Quiet · 8` strip of chips (name · last activity) under the grid, so fourteen projects fit one 1440 screen and the crowned project keeps its rows instead of being padded out by eight empty cards.

### 4.11 Map (`board-map`, `map-crowded`, `map-pinned`, `m`)

The segmented control (or `m`) swaps the stage for the map. A running pipeline is a **group** on a well: its header is the record (`⟐ Implement the export endpoint (#218) · 2/5 · running`, a `needs a decision` badge when it is parked) and opens the pipeline stage; inside it is the same transit vocabulary at a smaller scale — a horizontal spine of **stations**, one node per stage that has started (station, `k/n`, role, engine · model, `2 findings` on a failed one, and `↺ <target> ● ● ○` where a fail edge leaves it), and every stage that has **not** started folded into one ladder tile (`3/5 verify · 4/5 review · 5/5 fix · not started`) so the map never drowns in ghosts. Loose conversations — the ones no pipeline owns — sit in one band below, as 200 px tiles with a title, a state phrase and their engine · model. A node opens its attempt's conversation, the ladder opens the pipeline. Nothing is rendered at a size that needs zooming, so there are no zoom tools and no minimap.

**The system arranges it, and honours you when you disagree.** By default the operator does nothing: every group and the loose band are laid out for them, top to bottom, sized to the map's width, with no two items overlapping — the capture asserts that. Drag a group by its header and it is **pinned** where it was put: it keeps that place, the receipt says so and carries **Release**, the group's header shows a pin mark that releases it, and the header of the map carries `Release all to auto` while anything is pinned. The rest of the map re-flows around a pinned group rather than sitting under it. Nothing is ever *forced* into a place the operator chose, and nothing they chose is ever quietly undone.

### 4.12 The board: a task, its worker and its pipeline as one thread (`kanban`, `kanban-crowded`, `k`, `t`)

The three objects the operator manages used to live on three surfaces joined by one-way links. The board is the surface where they are **one card**:

```
┌ In review · 2 ────────────┐
│┃ Archive TTL for closed   │   the task: title and issue ref; a warning edge and a
│┃ pipelines  #206          │   `needs you` badge when any part of the thread is parked
│┃  needs you               │
│┃  ⌘ gpt-5.6               │   the worker: engine mark, model, its state phrase —
│┃  working 4:02            │   opens the conversation
│┃  ⟐ 3/5 review            │   the pipeline: stage k/n and the stage's name, the record's
│┃  needs a decision ●●●●○  │   state, and the stage ladder as pips — opens the pipeline
└───────────────────────────┘
```

Five columns, the readiness sections the current build already computes (`taskReadiness.ts`): Now, In review, Blocked, Planned, Done, each with its count and its own vertical scroll — the board never scrolls sideways, at 1280 or at 1920. A task with no worker and no pipeline is a plain card with `＋ Assign a worker or a pipeline`, which opens the create menu. A task the orchestrator holds carries a seat chip. Dragging a card between columns changes its status on the drop, with a receipt that carries Undo — no confirmation. The board is the landing surface of a project that has tasks (§3.2), reachable by `k` or `t` and by the first button of the column header's segmented control.

The thread closes in both directions: the pipeline stage's Linked tasks panel renders the same card, a conversation's `⋯` menu opens its task, and its header meta reads `task · <title>`.

### 4.13 Host details and create (`host`, `new-agent`, `new-pipeline`, `create-menu`, `keys`)

- **Host details**: the runtime row (`connected · updates stream` / `degraded · polling every 10 s` / `offline · reconnecting`), background tasks with name, PID in mono, memory, age and a Kill each (acts on the click), and Hidden (closed conversations with Reopen).
- **New conversation**: Engine, Model, Reasoning (segmented), Account rows (`ready` / `chosen`, a not-signed-in one routes to sign-in), Directory, First message; Start conversation acts on the click, lands in the new conversation, receipt with Kill.
- **Keyboard shortcuts** (`?`): the §3.5 table as a dialog.

---

## 5. Visual language

### 5.0 Design plan (written before the rework, checked against the rendered frames after)

**Subject.** A cockpit for one operator supervising a dozen autonomous coding
agents on their own machine. Not a SaaS dashboard for a team: one person, all
day, hands on the home row, answering three questions — *what needs me*,
*what is running*, *what runs out and when*. The vernacular is dispatch and
signalling, not analytics: lanes, stations, verdicts, budgets, a line that
either advances or loops back.

**Palette** — six named values, all `src/styles/tokens.css` value for value,
light / dark:

| Name | Token | Light | Dark | Job |
| --- | --- | --- | --- | --- |
| Slate paper | `--surface-canvas` | `#f3f3f6` | `#101014` | the frame behind everything; the rail and column sit directly on it |
| Sheet | `--surface-card` | `#ffffff` | `#17171c` | the one lit plane: the stage, and the nodes/cards/tiles that carry an identity |
| Well | `--surface-well` | `#f0f0f4` | `#131318` | a group recessed into the sheet: a kanban column, a map group, the editor |
| Signal violet | `--color-accent` | `#5a51e0` | `#8f88ff` | the live path only — the traversed spine, the current station, the selected node |
| Amber | `--color-warning` | `#8a5f00` | `#e0ae45` | the operator is the blocker: a waiting row's edge, a fail loop, a round budget |
| Verdict pair | `--color-success` / `--color-danger` | `#177a37` / `#c62828` | `#4fc36f` / `#f07171` | passed and failed, on pips and stations only |

The engine marks keep their brand hues (`--color-claude` `#d97757`,
`--color-codex` `#2f6fd0`) and appear only as a 13–16 px glyph beside a model
name. Terracotta is a generic-AI tell when it is a page accent; here it is the
shipped identity of one of the two engines, at glyph size, and the page accent
is violet.

**Type.** One family (the system sans), one monospace, used for exactly three
things: shas, branch and worktree names, PIDs. Roles: display 15/700/-0.01em
(stage title), row title 13/600, body 13/400, feed prose 15/1.5 in an 880 px
measure, meta 11/400 muted, badge 10/600, station keys 10/400 tabular. Every
count, percentage, time and attempt number is tabular. No ALL-CAPS eyebrow
anywhere: a section header is sentence case at 11/600 with its count beside
it, because the count is the information and the label is the handle.

**Meta grammar.** Fragments in a fixed order separated by a 3 px hairline dot
at 45 % opacity, drawn by `.meta > * + *::before` — never a typed `·` in the
content. One state phrase per surface, coloured only when the state is not
"fine".

**Layout.** One horizontal ladder of planes, left-aligned, no floating chrome:

```
┌── rail 240 ──┬── column 380 ──┬────────── stage ──────────┬─ pin 480 ─┐
│ projects     │ seat card      │  shead: title · one sub   │ (≥1600)   │
│ + counts     │ Needs you  ◂── │  sbody: the work itself   │           │
│              │ Pipelines      │                           │           │
│              │  └ attempt     │                           │           │
│              │ Working        │                           │           │
│              │ Recent         │                           │           │
├──────────────┴────────────────┴───────────────────────────┴───────────┤
│ status bar 44: runtime · tasks ·············· accounts · ? shortcuts  │
└───────────────────────────────────────────────────────────────────────┘
```

Elevation ladder, deliberately four steps and no more: **canvas** (rail,
column, status bar) → **sheet** (the stage, one border, one `shadow-1`) →
**well** (groups inside the sheet: kanban columns, map groups, the editor,
panels) → **float** (`shadow-2`, dialogs, popovers, receipts only). Rows,
nodes, tiles and cards inside a well carry no shadow at all; a border exists
only where two planes meet. That is the whole answer to "identical rounded
cards with one grey shadow": the shadow says *this floats over the page*, and
nothing else is allowed to say it.

**The one memorable element: the transit line.** A pipeline is drawn as a
signalling diagram, and it is the only place in the product that spends ink:

```
 ●━━┫ Architect          plan  ◆ Opus · high · read-only     ┃
 ┃  ┃   attempt 1 · passed · a1f3c9 · open ›                 ┃
 ●━━┫ Builder           build  ◆ gpt-5.6 · high              ┃
 ┃  ┃   attempt 1 · running · a1f3c9 · open ›                ┃
 ◉━━┫ Reviewer         review  ◆ Opus · xhigh · read-only  ╮ ┃  ↺ fix
 ┊  ┃   attempt 1 · failed · 2 findings ›                   │ ┃  ● ● ○
 ┊  ┃   attempt 2 · failed · 2 findings ›                   │ ┃  2 of 3
 ○┄┄┫ Fix                 fix  ◆ Sonnet · high             ◂╯ ┃
```

A continuous 2 px **spine** runs down a 28 px gutter; each stage is a
**station** on it (a 14 px ring, filled by the last verdict — green passed,
red failed, violet pulsing running, hollow not started); the spine is violet
where the pipeline has been and a dashed grey where it has not; a **fail edge
is a real loop** drawn as a bracket in a 64 px right gutter, amber, with an
arrowhead at its target and its round budget as pips (`● ● ○` = 2 of 3 used)
on the loop itself. Per-attempt verdict pips sit on the node, and the attempt
list expands under it.

The same line vocabulary appears at three scales, so a pipeline is the same
recognisable object wherever the operator meets it: full size on the pipeline
stage; as a horizontal micro-spine of stations inside a group on the map; and
as a 8 px pip run inside the pipeline chip on a kanban card. Nothing else in
the design is allowed this much ink — rows, fields, dialogs and menus stay
quiet, borderless and on one radius ladder (8 px controls, 12 px surfaces).

**Motion**, four moments and no more: the current station and the working dot
pulse at 1.6 s; a decision that arrives in the current project fades its
warning edge in once and ticks its count once (200 / 320 ms); dialogs and
receipts rise 6 px over 200 ms; a change-log row slides in 8 px when it is
new. No section-entrance animation, no hover transition on cards. Everything
stills under `prefers-reduced-motion`, which is how the capture renders.

**Checked against the generic-AI tells before building.** Identical rounded
cards with one grey shadow → replaced by the four-step elevation ladder above,
and the gate that shadow-2 exists only on floats. ALL-CAPS eyebrows → none;
sentence-case headers carrying counts. Middle-dot-only meta → the hairline-dot
`.meta` grammar. Monospace on every label → mono on shas, branches and PIDs
only. `→` on buttons → `›` is the row affordance for "this opens a surface",
and the one `sign in →` is the shipped account phrase from #1424. Tinted
near-black surfaces → `#101014` is the shipped dark canvas token and the brief
pins the tokens value-for-value; the brief wins over the tell. Fade-slide-up
everywhere → the four moments above.

**What was revised after writing this plan and before building.** The first
draft made the stage graph a horizontal timeline with the loop drawn under the
row — which is what every CI product draws, and it is also what forced the
sideways scroll the critique measured (F1). Vertical spine with the loop in a
right gutter is the choice that serves *this* brief: a seven-stage record with
two loops fits a 1280 px stage without scrolling, and the loop has somewhere to
put its budget. The second revision: the kanban card first carried three
separate rows (task, worker, pipeline) with a border each — three cards in a
trench coat. It became one card with one title and two chips that share the
card's plane, because the operator requirement is that the three read as *one
thread*.

**What the rendered frames changed.** Seven things survived the plan and did
not survive the screenshots. (1) The map drew each fail edge as an arc between
its two stations; once the spine wrapped at 1280 and 1440 the arc crossed the
nodes it passed, so the map now states the loop on the node it leaves and the
drawn loop stays on the pipeline stage, where there is a gutter for it. (2) The
loop's label started rotated along the bracket and was unreadable at 10 px;
it is horizontal in its own 40 px lane. (3) The kanban chip was one line and
truncated the stage name to `3/5 …` in a 150 px column; it became two, with the
ladder pips beside the state. (4) The column header's count sentence would not
fit beside a three-button view control, so the pipelines count moved to the
Pipelines section header that already had it, and at 1280 the working count
goes too. (5) The four secondary editor groups were open by default and made
the editor a wall; they are disclosures. (6) The board's subtitle explained how
to drag; it now counts what is there, because an instruction a power user reads
four hundred times is furniture. (7) The question options' `1 2 3` read as
ordinal numbering — the generic tell — so they are drawn as keycaps, which is
what they are: the key you press.

### 5.1 Recipes

- **Tokens and the elevation ladder**: `prototype/styles.css`'s `:root` and dark blocks are `src/styles/tokens.css` value for value. Four planes and no more (§5.0): canvas (rail, column, status bar) → sheet (the stage, one border and one shadow-1) → well (kanban columns, map groups, the editor, panels) → float (shadow-2, only dialogs, popovers and receipts). Rows, nodes, tiles and cards inside a well carry no shadow at all, and a border exists only where two planes meet. Two radii: 8 px controls, 12 px surfaces; pills only for badges, chips and dots.
- **Type**: 15/700 stage titles (the one real step above a row title), 15/1.5 message prose in an 880 px measure, 13/600 row titles, 13/400 rows and nodes, 12 for tool lines, buttons and the editor's fields, 11 for meta lines and section headers, 10 for badges and station keys; tabular numerals on every time, count, percentage and attempt number; mono only for shas, branch and worktree names and PIDs. No ALL-CAPS eyebrow anywhere.
- **Meta grammar**: fragments in a fixed order separated by a 3 px hairline dot at 45 % opacity, drawn by the stylesheet, never a typed `·` in the content; the state phrase is the only coloured fragment.
- **State as an edge, at most two coloured elements per row**: a row that needs the operator carries a 3 px warning (or danger) edge and a badge; the current stage node a 3 px accent edge; the selected node an accent ring; nothing tints a whole header. Dots: success live (pulsing only on the current row and the stage header), warning waiting or held, danger stalled or killed, accent returned or running pipeline, neutral done.
- **Badges**: one recipe, 20 px, soft fill + role text: `working 2:14`, `a question`, `plan approval`, `needs a decision`, `needs you`, `stalled`, `limit`, `running`, `passed`, `failed`, `draft`, `completed`, `active`, `ready`, `attempt 1 running`.
- **Pips**: 8 px marks, one recipe at three scales — a stage's attempts on its node, a fail edge's round budget on its loop (hollow until spent), and a pipeline's whole ladder in miniature inside a kanban card's pipeline chip.
- **Engine marks**: a 16 px glyph in secondary colour (Claude sparkle, Codex command) in rows, meta lines, stage cards and message headers; the filled 36 px circle only on the account cards and the seat panel.
- **Meters**: the fill is what remains, coloured by what remains (accent above 30 %, warning at or under 30 %, danger at or under 10 %).
- **Motion**: four moments (§5.0) — the current station and the working dot pulse at 1.6 s; an arrival in the current project fades its edge in and ticks its count once; dialogs and receipts rise 6 px over 200 ms; a new change-log row slides in 8 px. The banner collapses after ~6 s. Everything stills under `prefers-reduced-motion` (the capture renders with it reduced).
- **Receipts**: raised surface, success edge, in flow above the composer box (inside a dialog, above its footer; on a list stage, at the bottom of the body), 4 s, the inverse action as an accent text button. The body shrinks by the receipt's height, so no control can sit beneath it; the gate checks every receipt against every control.

---

## 6. Deliberately cut

- **The scheme board as the primary surface** (`SchemeBoard` with expanded conversation cards, lineage lines, subagent badges, the on-canvas draft editor, drag-to-link handoff, lasso and bulk actions, tasks placed on the map, the task sticky composer). The frames show why: at fit zoom every day's board is a row of thumbnails with 5×4 px controls. The map survives as a secondary picker of tiles (§4.11); the actions the canvas gestures performed are rows (`⋯ › Hand off`, Close card, Archive) and, for bulk selection, §7.
- **The switchboard modal, the switch cards and the corner status pill** (`Switchboard`, `SwitchCard`, `CornerStatus`, `useSwitchboardData`). The column is the switchboard, always open, fed by the files the board already has.
- **The attention island, the "NEEDS YOU 0" pill and the arrival toast** on the desktop. The queue is the column; the only banner is for another project's arrival.
- **The orchestrator dock as a pushed third column** (`OrchestratorDock`, `OrchestratorPanelToggle`). The seat is a column card and a stage; the launch module inside `OrchestratorPanel` survives as the rotate / create dialog.
- **The pipeline strip, the hub popover, the verdict popover and the on-canvas stage editor** (`PipelineStrip` desktop mode, `PipelineHub`, `VerdictPopover`, `PipelineEditor`, `StagePlaceholderPane`, `StageEdgeControls`). One pipeline stage with findings, actions, the graph and the editor. The strip is the defect the graph replaces: it showed 3 of 5 stages at 1440 and 1 of 5 at 1280, with the fail edge as a 10 px caption.
- **The rail footers** (RAM and swap meters, the two limit blocks, the Telegram row) and the rail header's toggles (language, access QR, push bell). Resources and background tasks are Host details; limits are the status bar and the Accounts stage; the three toggles become rows in the board `⋯` beside Sound (not prototyped; lane 1 carries them as rows).
- **The floating create cluster, the header's status sentence, sound and settings buttons, the always-visible Archive and Delete project**. One `+` menu, one `⋯` menu, one sentence of counts under the project name.
- **The task readiness strip and the Tasks side panel**. One board (§4.12), which is the readiness model rendered as the project's landing surface; the strip's chips become the card's worker and pipeline chips.
- **The worker stacks and the residual strip** (`WorkerStacks`, `TreeAside`'s residual strip). Recent, `All conversations · n ›` and Host details › Hidden.
- **The conversation card's header controls** (kill with PID, expand, favourite, delete, close inline) and the two-step Kill. One `⋯` with labelled rows; the receipt's Respawn is the safety net (standing rule: no confirmation prompts).
- **The composer's status row, the live-tail pill and the control strip** on the desktop. Stop is the send slot, elapsed time is the header meta, the strip's rows are in `⋯`.
- **The "Reasoning" row that fronts a model select, the "Light / Medium" tier names and the `effort: default` label**. Model and Reasoning are separate segmented controls with the tier ids.
- **Per-engine account popovers anchored to the board**. One Accounts stage.

---

## 7. Deferred — not currently justified

Scope the requirement does not demand, kept on record here.

- **Semantic zoom for the map** (#183). The map of groups is legible at 100 % and answers "where is everything" without it; #183 stays the destination if it ever needs levels.
- **Spatial editing on the map beyond pinning** (drag-to-link handoff, lasso and bulk actions, tasks on the canvas). Moving a group to pin it is in (§4.11); linking and bulk selection are not. The column rows and menus carry the same actions one at a time; a multi-select in the column (Shift-click, bulk Close / Archive / Kill with one receipt) is the shape if the operator asks for bulk actions.
- **A tabbed stage or multiple pinned panes.** One stage plus one pinned pane at ≥ 1600 covers "the orchestrator beside a worker"; more panes would recreate the canvas.
- **Resizable rail and column.** Fixed widths per frame keep the gates provable; a drag handle is a small addition later.
- **A command palette beyond `/` and the single keys.** The map of keys is short enough to learn from `?`.
- **Inline transcripts on the pipeline stage.** A stage card's `open ›` opens the attempt's conversation in the stage; embedding transcripts would rebuild the canvas problem.
- **Findings ledger across rounds, checkpoint browsing, per-attempt diffs.** Automation-v2 §7 defers the ledger; the change log, the node's attempt list and the findings card's `round n ›` fold cover what the record carries.
- **The map's fail edge drawn as an arc between its two stations.** Tried and cut: the spine wraps at 1280 and 1440, so the arc crossed the nodes and the ladder tile it passed. The map states the loop as `↺ <target> ● ● ○` on the node it leaves; the full-size loop stays on the pipeline stage, where there is a gutter to draw it in.
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
| 2 | **Column, seat card, rail v2, overview v2** | `DesktopColumn.tsx` ⁺, `columnModel.ts` ⁺ (+ test: grouping, the precedence killed > stalled > limit > held > waiting > working > returned > done, both kinds in Needs you, Recent capped at five, the filter narrows the seat card, `n`/`N` order), `SeatCard.tsx` ⁺, `OverviewStage.tsx` ⁺; edits `src/components/ProjectRail.tsx` (rows read a phrase, the crown toggle inside the row's hit area, footers and header toggles stop mounting, Create project at the foot, collapse to 64 px), `src/components/OverviewBoard.tsx` (retired in favour of `OverviewStage`), `src/components/LimitsFooter.tsx`, `src/components/ResourcesFooter.tsx` (retired) | 1 | Frames `board`, `board-noseat`, `board-crowded`, `board-rail-collapsed`, `overview`, `overview-crowded`; the queue count is the same number in the column header, the rail row and the overview; no `data-go` appears twice in the column; section headers stick; with thirty conversations and ten pipelines every Needs you row ends inside the first screen at 1280 and the rail is collapsed there by default; fourteen projects fit one 1440 overview with the quiet ones as one strip. |
| 3 | **Conversation stage: header, meta precedence, `⋯` menu, details, split** | `ConversationStage.tsx` ⁺, `DesktopConversationMenu.tsx` ⁺, `ConversationDetailsDialog.tsx` ⁺, `PinnedPane.tsx` ⁺; edits `src/components/BranchPane.tsx` (desktop: no inline header controls; the header becomes title + meta), `src/components/AgentControlStrip.tsx` (desktop: rows in the menu), `src/components/TaskHeader.tsx` (`ProcessStatusControls`: direct kill on the desktop) | 1; mobile lane 3 (`BranchPane.tsx`, `AgentControlStrip.tsx`, `TaskHeader.tsx`) | Frames `chat-working`, `chat-idle`, `chat-menu`, `chat-details`, `chat-offline`, `chat-held`, `chat-limit`, `chat-stalled`, `chat-killed`, `chat-split` (1920 only); the meta precedence test; Kill and Close act on the click with Respawn and Reopen in the receipt; the Pin control renders only at ≥ 1600. |
| 4 | **Feed and composer at desktop density** | edits `src/components/feed/FeedItem.tsx`, `feed/cards/ToolCard.tsx`, `feed/cards/CmdGroupCard.tsx`, `feed/QuestionCard.tsx`, `feed/SuggestedReplies.tsx`, `src/components/ComposerBar.tsx`, `RuntimePill.tsx`, `TmuxComposer.tsx`, `LogFeed.tsx`, `TurnStatusBar.tsx` | 3; mobile lanes 4 and 5 (they own these files until they merge) | Frames `chat-working`, `chat-waiting`, `chat-model`; 880 px prose column at 15 px; the 44 px message header; folded runs and the failure block; options and chips send on the click and the card folds; the box with the chip inside; the slot is Stop / send / Queue / Respawn; Enter sends, Shift+Enter breaks; Tab walks field → chip → attach → dictate → send; no status row, no live-tail pill on the desktop; one vocabulary. |
| 5 | **Seat stage and rotate dialog** | `SeatStage.tsx` ⁺, `SeatPanel.tsx` ⁺, `RotateDialog.tsx` ⁺; edits `src/components/orchestrator/OrchestratorPanel.tsx` (the launch module renders inside the dialog; the create prose and the MCP line go), `IncumbentHeader.tsx` (the identity row of the panel), `OrchestratorDock.tsx` and `OrchestratorPanelToggle.tsx` (deleted), `src/components/shellLayout.ts` (no dock inset) | 1, 3 | Frames `seat`, `seat-rotate`, `board-noseat`; `o` opens the seat or the create dialog; Rotate and Create act on the click and land on `#/seat`; the mandate textarea is focused on open; `capture-issue-977` and `978` retire with the dock and their acceptance moves to lane 0's `seat` frames. |
| 6a | **Pipelines: the stage graph, the read side and today's actions** | `pipelines/PipelineStage.tsx` ⁺, `pipelines/PipelinesList.tsx` ⁺, `pipelines/StageGraph.tsx` ⁺ (the spine, the stations, the per-attempt pips, the fail loops with their round budgets, the attempt list, the 1280 ladder), `pipelines/ChangesLog.tsx` ⁺, `pipelines/PipelineActions.tsx` ⁺ (today's `PIPELINE_ACTIONS` through the existing PATCH route) | 1, 2 | Frames `pipelines`, `pipeline`, `pipeline-running`, `pipeline-draft`, `pipeline-long`, `new-pipeline`; every stage of a seven-stage record is on screen at 1280, 1440 and 1920 with and without the editor and `.graph` never scrolls sideways; every node shows role, engine, model, reasoning, access and its attempt pips; every fail edge shows its target and `k of n rounds`; a node expands into its attempts and every attempt with a conversation has `open ›`; Retry / Skip / Pause / Resume / Archive / Start act on the click with their inverse in the receipt; a stage conversation's `⋯` first row opens its pipeline. |
| 6b | **Pipeline editing after start = automation-v2 slice 12** | `src/components/pipelines/StageEditor.tsx` ⁺, `AddStageEditor.tsx` ⁺; edits `src/components/pipelines/VerdictPopover.tsx` (the findings block with the Answer field), `PipelineStrip.tsx`, `PipelineHub.tsx`, `PipelineEditor.tsx`, `StagePlaceholderPane.tsx`, `StageEdgeControls.tsx` (retired on the desktop), `pipelineModel.ts` (state phrases, `waiting`, pending edits) — automation-v2 lane G owns this directory | 6a; automation-v2 slices 10 and 11 | Frames `pipeline-edit-stage`, `pipeline-edit-running`, `pipeline-add-stage`, `pipeline-completed`; the flows of `capture.ts` (save → pending-next-attempt on a running stage, restart, set-edge, note, rerun refused then allowed with stopCurrent, answer, add / remove with undo, completed → edit → re-run) run against the real route with `expectedRevision`; a refused mutation lands in the receipt with the engine's reason. |
| 7 | **Map of tiles** | `MapStage.tsx` ⁺; edits `src/components/scheme/SchemeBoard.tsx` (tile mode: no expanded conversations on the canvas, hub chips open the pipeline stage, ghosts for stages that have not started), `scheme/layout.ts` (tile size; the rest band derives its width from the tree count — 2026-08 finding 1), `scheme/Minimap.tsx`, `scheme/expandedNode.ts`, `scheme/TasksLayer.tsx`, `scheme/TaskStickyComposer.tsx`, `scheme/BulkActionBar.tsx`, `scheme/lasso.ts` (off the map), `src/components/ProjectDashboard.tsx` (the desktop leaf mounts the map only when the column's view is map; the floating create cluster, the header toolbar, `TaskReadinessStrip`, `WorkerStacks` and the residual strip stop rendering on the desktop), `src/components/TaskReadinessStrip.tsx`, `WorkerStacks.tsx`, `TreeAside.tsx` (retired on the desktop) | 2; mobile lane 2 (`ProjectDashboard.tsx`); automation-v2 slices 9b and 12 (lane E's `ProjectDashboard.tsx` and `scheme/**` edits) | Frames `board-map`, `map-crowded`, `map-pinned`; nothing exceeds the map's client width at any width; a group with unstarted stages renders one ladder tile for them; no two groups overlap in the auto layout; dragging a group pins it with a receipt that carries Release, the rest flows around it, and Release (or `Release all to auto`) returns it; `m` toggles; a node opens its conversation. |
| 8 | **Accounts stage** | `AccountsStage.tsx` ⁺; edits `src/components/AccountsPanel.tsx` (the stage layout on the desktop; the popover container goes), `EngineAccountSwitch.tsx`, `AccountBadge.tsx`, `ProjectAccounts.tsx` (retired: the status bar and the stage replace the header switch), `ConnectionPill.tsx` (retired: the status bar's runtime chip) | 1; mobile lane 9 (`AccountsPanel.tsx`, `AccountBadge.tsx`, `EngineAccountSwitch.tsx`) | Frames `accounts`, `account-detail`, `chat-limit`, `chat-model`; every account row carries two meters (the gate counts `2 × rows`) including the not-signed-in one; a row opens `#/accounts/<engine>/<id>` with the burndown, the pace line, the depletion line and the actions; Escape returns to the stage with the focus on that row; Switch from the detail lands a receipt with Switch back; the composer chip's Account group reaches the same rows; `capture-issue-1418` still green. |
| 9 | **Attention and arrivals** | edits `src/components/attention/AttentionIsland.tsx` (no desktop pill; the count is the column's), `AttentionToast.tsx` (desktop: the banner slot, other-project arrivals only, ~6 s collapse, seen stamp), `src/components/attention.ts` (the queue includes `needs_decision` pipelines in the column's order), `attention/navigate.ts` (`n` / `N` walk that order; across projects on the overview) | 2; mobile lane 8 (`AttentionIsland.tsx`, `AttentionToast.tsx`, `attentionQueue.ts`) | Frames `chat-arrival`, `board`, `overview`; the banner never shows for the current project; a seen decision is not announced again after back; `capture-issue-963` retires with the island and its acceptance moves to lane 0. |
| 10 | **Search in the dialog primitive** | edits `src/components/search/GlobalSearch.tsx` (desktop geometry: 760 px dialog over the stage, the scope control as a segmented control, `↑ ↓ Enter` kept) | 1 | Frame `search`; `/` opens with the field focused; Escape returns focus to the trigger. |
| 12 | **The board: task ▸ worker ▸ pipeline as one thread** | `board/BoardStage.tsx` ⁺, `board/ThreadCard.tsx` ⁺, `board/boardModel.ts` ⁺ (+ test: the five readiness sections from `taskReadiness.ts`, a card's worker and pipeline resolution, a drop changes status and the inverse restores it); edits `src/components/TaskReadinessStrip.tsx` (retired on the desktop), `src/lib/taskReadiness.ts` (the read model is reused, not forked) | 2, 6a | Frames `kanban`, `kanban-crowded`; no horizontal scroll at any width, columns scroll vertically, every card ≥ 44 px, none overlapping; a card renders worker and pipeline chips whenever the task has them and `＋ Assign` when it has neither; the worker chip opens `#/chat/<id>`, the pipeline chip opens `#/pipeline/<id>`, a drag to `done` changes the status and the receipt's Undo restores it; the landing route of a project with tasks is the board. |
| 11 | **Retire and document** | delete `src/components/Switchboard.tsx`, `SwitchCard.tsx`, `CornerStatus.tsx`, `src/hooks/useSwitchboardData.ts`, `src/components/pipelines/PipelineHub.tsx` and their tests; update `docs/design/viewer-design-system.md` §3.1–3.3 | 3, 6b, 7, 8, 9 | Type-check green; no desktop surface imports a retired file; the design-system doc names the column, the stage and the status bar. |

Order: 0 → 1 → {2, 10} → {3, 5, 6a, 8, 9} → 4 → 12 → 6b → 7 → 11. Lanes 3, 4, 8 and 9 wait for the mobile lanes that own their files; 6b and 7 wait for the automation-v2 slices named. Review per lane by a fresh reviewer against the pinned quote and the frames. The desktop and the phone share `stateBits`, the badge recipe and the vocabulary, so a lane that lands on one form factor leaves the other untouched and a partial rollout is safe.

---

## 9. Validation against the requirement

| Wanted | Delivered here |
| --- | --- |
| 1 · audit at 1280, 1440, 1920, both schemes, from rendered frames of the current build against a seeded home, covering board and rail, conversation and feed, orchestrator panel, pipelines (strip, hub, scheme), accounts, search, attention, switching; what works and stays | §1: nineteen screens per cell rendered through the demo runtime with seeded pipelines, measured (§1.0 table), read (§1.1–1.13), re-checked against the 2026-08 audit (§1.14), the keep list (§1.15) |
| 2 · a mobile-v2-consistent IA: the persistent frame, a primary surface, where the seat lives, how pipelines are read and edited, how attention and arrivals surface, how search and switching feel, what is cut | §2, §3, §6; `stateBits`, the badge recipe, the receipt, the banner slot, the navigation contract and the vocabulary are the mobile v2 ones |
| 3 · static clickable prototype, HTML/CSS/JS, invented fixtures, both schemes, three widths, capture script with headless gates (no overflow, no overlapping controls, 44 px, focus order in composer and dialogs) | `prototype/` (47 screens, every action clickable, thirteen scenarios), `capture.ts` (278 gated frames plus the structural gates of §11 and the flows, green on 2026-09-02), `.gitignore` with `out/` |
| 4 · design document: verbatim requirement with date and source, audit, principles, IA, screen by screen, cuts, implementation plan by lane with one owner per file, "Deferred — not currently justified" | this file; `git status` shows only `docs/design/desktop-v2/` |
| 5 · approval gate | the orchestrator shows `out/` and this document to the operator; lanes 0–11 open only after their word |

The operator's words: "з нуля" (from scratch) → §3 replaces the whole frame; "з урахуванням того що в планах" (what is planned) → §4.6 is automation-v2's slice 12 drawn, §2 and §4 are mobile v2's contract on a desktop; "того що зроблено вже" (what is done) → §1.15 keeps the wave that shipped (#1422 compact notices as receipts, #1424 accounts content, #1440 / #1054 search whole, #1445 switching as the column, #1419 / #1448 seat authority untouched) and the audit's protected list.

The five requirements the operator added when the rework was commissioned, and where each one is met:

| Wanted | Delivered here | Proven by |
| --- | --- | --- |
| 1 · pipeline stages as a legible, crafted stage graph — current stage, pass and fail edges, review-round budget as pips, per-attempt verdict pips, role/engine/model/effort per node — never a plain strip | §4.6: a vertical spine of stations with per-attempt pips, fail edges as bracketed loops carrying their round budget, the whole definition on every node, the attempt list on demand, the 1280 ladder | frames `pipeline`, `pipeline-running`, `pipeline-long` (seven stages, two loops, one traversed twice) at three widths in both schemes; the gate that `.graph` never scrolls sideways and every node and loop carries its fields |
| 2 · every account at once, each with a mandatory usage bar, each row clickable to a detail of consumption, burn rate and reset/burnout timing | §4.5: one row per account with both windows as meters (empty ones for a signed-out account), and `#/accounts/<engine>/<id>` with the burndown, `burning at n % per hour`, `runs out at 16:40` or `lasts to the reset`, today by hour, and the actions | frames `accounts`, `account-detail`; the gate `.arow .meter === 2 × rows`; the flow that clicks a non-active row, reads its pace, switches with an inverse, and Escapes back onto that row |
| 3 · a kanban where a task, its worker and its pipeline are one visual thread | §4.12: five readiness columns of cards, each card a task with its worker chip and its pipeline chip carrying the stage ladder in miniature; drag to change status with Undo | frames `kanban`, `kanban-crowded`; the flows that open the worker and the pipeline from the chips and drag a card to Done |
| 4 · one distinctive, opinionated identity inside the shared tokens, checked against the generic-AI tells | §5.0: the design plan, its named palette from `tokens.css`, the four-plane elevation ladder, the tell-by-tell check, the two revisions the plan itself failed, and the transit line as the one place boldness is spent | every frame; the gates that keep the ladder honest (no shadow on a row, no ALL-CAPS, hairline meta) and the self-critique in §5.0 |
| 5 · pipelines on the map as groups of stage nodes among loose conversations, auto-arranged by default and honouring an operator's move with an easy release | §4.11: groups with a horizontal spine, unstarted stages folded into one ladder tile, a loose band, an auto layout that overlaps nothing, and pinning by drag with Release and Release all to auto | frames `board-map`, `map-crowded`, `map-pinned`; the flow that asserts the auto layout overlaps nothing, drags a group, asserts the pin and the re-flow, and releases it |

---

## 10. Over-engineering pass on this design

Cut from the first draft before it reached the prototype: a tabbed stage (one stage plus one pinned pane is the desktop's whole answer to "two things at once"); a resizable, rearrangeable dashboard (fixed widths per frame keep the gates provable and the frame learnable); a notification centre (the column is the queue; a banner slot is the only announcement); a command palette (`/` plus eleven single keys); inline transcripts on the pipeline stage (the attempt's `open ›` is one click); a second navigation model for the map (the map is a view of the same stage; tiles open the same routes); live conversation previews on the map (the exact thing the current board does at 21 %). What remains is one frame, one list, one stage, one dialog primitive, one receipt, one state function shared with the phone, and a pipeline stage that draws the automation record as it will be. A round that removes more is a successful round.

The rework round removed more: the map's zoom tools and its empty minimap (they served a canvas this design does not have), the payload hints beside the actions and under the editor (documentation for the implementer on a product surface; the contract stays in §4.6's mapping table), the empty stage's key legend (`?` already owns it), the composer's permanent `Enter send` row (the placeholder says it once), the meta tagline, and — during the rework itself — the map's fail-edge arc, which crossed the nodes it passed once the spine wrapped. Four editor groups that were always open became disclosures, so the editor opens on what is edited most. Nothing was added that a gate does not check.

---

## 11. Critique round 1 — every finding, and what the rework did with it

The independent critique is `critique.md`. Severity is the critique's: P1 changes
what the product is, P2 how it behaves on an ordinary day, P3 is cheap and
visible. Every finding is applied. Four were applied in a way the critique
itself offered as an alternative, or in a way its own acceptance forced; those
say so and why.

| # | Applied | Where it landed |
| --- | --- | --- |
| F1 · P1 · the stage strip must become a legible graph | yes | §4.6 and `graph()` in `app.js`: a vertical spine of stations, per-attempt pips, fail edges as bracketed loops with their round budget as pips, the whole definition on every node, an attempt list on demand, the 1280 ladder beside the editor. New frame `pipeline-long` (seven stages, two fail edges, one loop traversed twice) at all three widths. **One departure:** the critique offered "a wrapped grid at ≥ 1600" as an alternative; the spine is one column at every width, because a wrapped grid breaks the line's continuity, which is the whole device — and the vertical spine already fits seven stages at 1280 without scrolling, which was the acceptance. |
| F2 · P1 · every account with a mandatory bar and a detail | yes | §4.5: one row recipe for all five accounts, both windows as meters (empty on the signed-out one), and `#/accounts/<engine>/<id>` with the burndown, the pace, the depletion clock, today by hour and the actions. New frame `account-detail`. |
| F3 · P1 · a kanban where task, worker and pipeline are one thread | yes | §4.12: `#/kanban` (`k`, `t`), the five readiness sections, the card with its worker chip and its pipeline chip carrying the stage ladder as pips, `＋ Assign` when neither exists, drag between columns with Undo. New frames `kanban`, `kanban-crowded`. |
| F4 · P2 · the empty stage is a placard | yes | §3.2: the landing stage is the board when the project has tasks, else the first thing that needs the operator, else the seat. The key legend left; `?` owns it. New frame `board-notasks`. |
| F5 · P1 · focus dies after `n`, `Enter` and every re-render | yes | §3.5: a stage takes focus on open (the question's first option, the Answer field, the editor's first control, the composer, the first row), every re-render restores the element by its identity, and `Esc` is the bridge from any field back to the column's current row. `i` focuses the composer, `1`–`9` pick an option, `Enter` on a node opens its editor. **One resolution:** the critique's own acceptance wants `1` to work *and* the composer focused. Both hold only if the option list — not the composer — takes focus when a question is open, and `n` is walked as `n · Esc · n`. Single keys never fire inside a text field: text is text. A gate on every frame asserts the active element is never the body. |
| F6 · P2 · the counts disagree | yes | One `counts(project)` derived from the same lists the column renders; the seat does not count as working; the fixture's typed `needs` / `working` / `total` are gone. A gate compares the rail row, the column header and every overview card against it on every frame. |
| F7 · P2 · the column lists the same thing twice | yes | §3.2: Needs you wins, Pipelines lists only what it has not shown, and a pipeline folds its live attempt as an indented child row unless the queue already has it. Gate: no `data-go` twice in `.col-body`. |
| F8 · P2 · at 1280 the crowded column hides everything below the queue | yes | Sticky section headers that stack at the top edge, Recent folded on a column over one screen, and a header sentence that is one line at every width. **The alternative taken:** the critique offered glyph counts (`9 ⚠ · 10 ● · 10 ⟐`) *or* dropping the pipelines count; the pipelines count is dropped (and `working` too at 1280), because the Pipelines section header already carries it and a legend of glyphs is a second vocabulary to learn. |
| F9 · P2 · the stage editor hides its primary action | yes | §4.6: a bounded editor pane with its own scroller and a footer (Save · Restart · Cancel and the note) that never leaves the viewport; Role · Engine, Model · Reasoning, Access · Sandbox two to a row; the account as F2's row recipe; the four secondary groups as disclosures. Gate: no segmented label wraps, no control overlaps. |
| F10 · P2 · attempt and round history is unreadable | yes | §4.6: a node expands into `attempt n · state · sha · k findings · open ›`, and the findings card folds `round 1 · 2 findings ›` open in place. |
| F11 · P2 · the map clips, drowns in ghosts, carries an empty minimap | yes | §4.11: groups sized to the map, unstarted stages folded into one ladder tile, the loose band, no zoom tools. **The alternative taken:** the minimap is removed rather than given outlines — fit-to-width plus vertical scroll is the whole navigation, and a second map of the map is the accessory to leave at home. |
| F12 · P3 · search results overflow into the meta column | yes | §4.7: two lines, meta right-aligned on line one, the snippet clipped on line two. Gate: the snippet is clipped and never intersects the meta. |
| F13 · P3 · the seat panel promotes Rotate | yes | §4.4: three faded lines of the mandate with an inline `Edit ›`; Edit the mandate and Rotate both secondary and 44 px; the duplicated badge gone. |
| F14 · P2 · the overview pads quiet projects | yes | §4.10: active projects get cards of up to eight rows, quiet ones collapse into one `Quiet · n` strip. New frame `overview-crowded`. |
| F15 · P3 · composer hint clutter, the pinned pane's missing menu | yes | The hint moved into the placeholder; the pinned pane's header carries the same `⋯`. |
| F16 · P3 · the fixture lies about which conversation belongs to which pipeline | yes | `p1`'s plan attempt is its own conversation (`Design the export endpoint`), `p2`'s verify stage has its own, and `c5` stays loose. Every attempt's conversation is unique per pipeline. **One more found while drawing it:** `p1`'s review had a fail edge to a stage `fix` that does not exist in `p1`; a dangling edge draws nothing, so it now returns to `build`, which is what that pipeline actually does. |
| F17 · P3 · the rail default at 1280 contradicts the doc | yes | Collapsed under 1440, expanded at 1440 and above; §3.4, `screens.js` and the gate all say it. |
| F18 · P3 · "attempt" versus "round" | yes | An attempt is one run of a stage, a round one traversal of a fail edge. The findings title is `Reviewer · attempt 2 · round 2 of 3 · 2 findings`, the node says `2 of 3 rounds`, the change log says `attempt 2 failed · round 2 of 3 used`. Gate: the findings title must match that shape. |
| F19 · P3 · OVER-BUILT: payload hints, the tagline, zoom tools | yes | All removed (§10). Gate: no `PATCH`, `expectedRevision` or JSON-shaped hint anywhere on a stage, no zoom control, no minimap. The API contract stays in §4.6's mapping table and in lane 6b's acceptance, which is where an implementer reads it. |
| F20 · P3 · a current-project arrival makes no visible move | yes | §4.8: the row appears with its edge fading in once and the counts tick once, still under reduced motion, and no banner. New scenario and frame `board-arrival-here`. |

**The critique's §10 "must not be regressed" list holds.** The frame, the column
recipe, `stateBits` and its precedence, the badge recipe, the receipt with its
inverse, no confirmation anywhere, the composer box and its slot, the question
card, the draft surviving a switch, every pipeline editing mechanic and the
change log, the template picker, the accounts content from #1424, the seat and
its rotate dialog, the split pane at ≥ 1600, search and its keys, both schemes
token-exact, 44 px targets, no overlapping controls, no sideways scroll, and
the banned-word list — each still has its frame or its flow in `capture.ts`,
and the run that produced this revision was green on all 278 frames and every
flow.
