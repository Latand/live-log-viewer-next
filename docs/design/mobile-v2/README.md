# Mobile v2 — the phone experience, prototype-first (issue #1439)

> **Originating requirement.** Operator directive, 2026-09-02, given from a phone screenshot of the production board and recorded in the #1439 pipeline specification: *"UI/UX on mobile has to be fixed, almost redone from scratch, but agree the picture / prototype with me first."*
>
> Issue #1439 (opened by the operator the same day; read in full on 2026-09-02) carries the observations and the acceptance list. Quoted verbatim:
>
> *Operator directive (2026-09-02, from a phone screenshot of the production board): the mobile UI/UX has to be fixed, close to a redesign from scratch, and the redesign is **prototype-first**: a picture the operator approves before any implementation lane starts. Fable owns the design.*
>
> *What the screenshot shows (390-px-class phone, board + focused orchestrator conversation)*
> - *Top bar is crowded: hamburger, truncated project name, search, an attention pill (warning count + chevron), a layers/count pill, "+", and "…" all on one row; the project name has 4 characters of room.*
> - *A stripe of background-task rows (name, PID, Kill) sits between the top bar and the engine tabs, each row 44 px, pushing the content down; these are host details, not what the operator came to see.*
> - *Engine/seat tabs row (engine pill, orchestrator card tab, a "2" count, a "degraded" pill) overlaps its own trailing icons.*
> - *Conversation header packs a WORKING chip with elapsed time, a truncated title and five 44-px controls (rename, Kill, forward, crown, close) on one line.*
> - *Feed spends a full left column on participant avatars ("PF", "1B", "UR"), leaving ~70% width for the message bubbles; tool rows ("MCP · VIEWER · Reading…" + an "Open conversation" button + duration) wrap awkwardly.*
> - *Bottom stack: a "live tail" pill, the working indicator, a pipeline card strip (two "1B" avatars + truncated titles), the composer, and a model/effort selector, each its own row above the browser chrome.*
> - *Net effect: on a phone screen roughly half the height is chrome and status, the operator scrolls to read, and taps land on tiny truncated targets.*
>
> *Wanted*
> 1. *A mobile-first prototype, approved before implementation. Static, clickable HTML/CSS (no rasters committed; a capture script renders PNGs locally) covering the core phone flows: board overview of a project; a focused conversation with composer; the orchestrator seat surface (status, rotate, mandate); switching between conversations and projects; the attention/alert entry; pipelines list and one pipeline; accounts/limits. Both colour schemes, 390×844 and 430×932 frames, keyboard-open state for the composer.*
> 2. *Design principles to hold: one primary surface at a time; chrome collapses to a single compact bar; host details (background tasks, PIDs) live behind one tap, never as always-on rows; message content gets the full width (avatars become small inline marks or a per-thread header); controls are 44 px and few, with overflow behind one menu; the composer and model selector are one unit; no confirmation prompts; no screen-reader-specific work in this pass.*
> 3. *A design document (docs/design/mobile-v2/) with the requirement quoted verbatim (date, source), the audit of what exists, the proposed information architecture, screen-by-screen notes, what is deliberately cut, and an implementation plan sliced into issues (one lane per slice, one owner per file) — but nothing implemented in this lane.*
> 4. *Approval gate: the orchestrator shows the prototype to the operator; only after their word do implementation lanes open.*
>
> *Out of scope for this lane: product code changes. Desktop layout. Screen-reader accommodations (per the standing audit scope).*

This directory is the picture. Nothing in product source changed. What is here:

| Path | What it is |
| --- | --- |
| `README.md` | This document: audit, information architecture, screen notes, cuts, open questions, implementation plan. |
| `prototype/index.html` | The clickable prototype. Open it in any browser from the file system; no server, no build step. `prototype/fixture.js` is invented, identity-free data; `prototype/screens.js` lists the key screens; `prototype/app.js` and `prototype/styles.css` are the whole implementation. |
| `critique.md` | The independent design critique (round 1, 2026-09-02). §10 below answers it finding by finding. |
| `capture.ts` | `bun docs/design/mobile-v2/capture.ts` renders every key screen at 390×844 and 430×932, dark and light, plus four screens at 844×390, into `out/` (gitignored by `.gitignore` here) and gates each frame: no horizontal overflow, every control ≥ 44 px, no two controls overlap, a receipt never covers a control, the bar's title cell keeps ≥ 190 px, the keyboard frame keeps the send control above the keyboard, the requested scheme actually applied, the bench never shows in a phone viewport. After the matrix it clicks through the navigation contract, the receipts (Kill in a conversation; Close card and Archive project on the board; Use one reset and Refresh on Accounts, the last four at both portrait frames), the composer slot, the answer path, the sign-in row (on the Accounts screen and in the limit sheet), the keyboard frame's send, the arrival banner's seen stamp, the sheet drag and the failure states headless. Run on 2026-09-02 after verify round 3: 120 frames and every flow green. |

**How to look at it.** On a wide window the page shows a phone frame with a bench above it (frame size, colour scheme, one link per screen). On a phone-sized viewport, or with the browser's device emulation at 390×844, the shell fills the screen and the bench disappears. Everything the design proposes is tappable: switch projects and conversations, answer the question, send a message, stop the agent, rotate the orchestrator, retry a pipeline stage, kill a background task, undo a kill from its receipt, use a reset, drag a sheet closed. Query flags: `?scheme=dark|light`, `?frame=430`, `?scenario=noseat|degraded|offline|held|limit|stalled|arrival|crowded` (the failure states and the long-list case, see `prototype/fixture.js`); the route is the hash (`#/board`, `#/chat/c2/kb`, …).

---

## 1. Audit — what a phone shows today, and why it fails

Everything below was read from the source on this branch (`main` at `0ffdf5d4`, 2026-09-02) and matched against the operator's screenshot observations. File references are `path:line`.

### 1.1 The top bar

`src/components/ProjectDashboard.tsx:1693–1893` builds the phone header under a documented budget (#613): five fixed 44 px targets (projects, search, shelf, create, more) plus the attention pill, and the project name as the one elastic cell. The comment itself measures the outcome: a fully populated row leaves the name ~73 px at 390 px. On the operator's phone the shelf trigger, the pill and search were all present, so the name got four characters. The budget was honoured; the budget is wrong for a phone. `OverviewBoard.tsx:130–136` repeats the same shape on the all-projects screen.

### 1.2 The background-task stripe

`ProjectDashboard.tsx:1985–1997` docks every parentless background process as a `TaskStrip` (`BranchPane.tsx:569–620`) above the board — on the phone too. Each row is 44 px, carries a PID chip and a Kill control, and is always on. The screenshot's stripe is this: host detail, rendered as the first thing under the bar.

### 1.3 The engine/seat tabs row

The focus view's strip (`src/components/mobile/MobileFocusView.tsx:492–560`) is one 56 px row holding the compact connection pill ("degraded"), the pinned orchestrator row (`MobileOrchestratorRow.tsx`, a chip capped at 38vw plus a 44 px controls button from #1347), the scrolling conversation chips, and a right cluster of pipelines-count, map and tasks buttons. Chips identify by engine label only (design-system rule 3), so on a board with three Claude conversations the strip reads "Claude · Claude · Claude". The row that carries the most navigation carries the least information, and at 390 px its trailing icons collide with the chip scroller's fade.

### 1.4 The conversation header

`BranchPane.tsx:305–380` renders, on one line: activity dot, the title editor (#1348 made it legible), `ProcessStatusControls` (Kill, two-step armed), the details toggle (44 px), the crown (44 px), expand (44 px), `DeleteFileButton`, and close (44 px). Five to six controls on a 390 px line leave the title one to four characters (audit 2026-08 finding 4, still standing). The WORKING chip with elapsed time is `TurnStatusBar` (`LogFeed.tsx:1057`), which renders success tone whenever the turn runs, including while the agent is blocked on the operator (finding 3, still standing: `TurnStatusBar.tsx:84–108`).

### 1.5 The feed

`src/components/feed/FeedItem.tsx:104–135`: every agent message is a flex row with a 26 px avatar column and a gap; user bubbles cap at 75% (`:152`, `:181`). Above every message sits an actions row (time, speak, copy). Tool calls render as `ToolCard` boxes; a viewer MCP call carries a summary, an "Open conversation" button (`pipelineSlot.openTranscript`) and a duration, which wraps to three lines at 390 px. Thinking, system rows and tool groups each have their own chrome. The design-system's §3.4 (quiet tool lines, generalized grouping) was specified in #155 and never shipped on this surface.

### 1.6 The bottom stack

With a conversation focused the phone stacks, bottom-up: the composer's model/reasoning pill row (44 px, #499, `ComposerBar.tsx:427–436`), the composer primary row (56 px), the inline subagent tray or the related-task strip (44 px rows with shadow, `SubagentTrayView.tsx:88`), `TurnStatusBar`, and the live-tail pill (`LogFeed.tsx:769`) which renders even while following. `mobile/chatBudget.ts` counts 264 px of persistent chrome and proves the transcript keeps 60% of an 844 px viewport; that arithmetic never included the docked task stripe (1.2), the attention banner (1.9), the subagent tray or the live-tail pill, which is why the operator's phone shows about half the height as chrome while the budget test stays green.

### 1.7 The bottom shelf, the pipeline dock and sheet, map-lite

- `MobileBottomShelf.tsx`: a modal for the handoff control and the folded worker/quiet/readiness strips, opened from a header trigger with a count badge. "Hidden" is a concept the operator has to learn, and its contents are host detail again.
- `MobilePipelineDock.tsx` / `MobilePipelineDockSheet.tsx`: a bottom sheet of collapsible rails, each unfolding the desktop `PipelineStrip` in mobile mode, with the verdict popover in a nested sheet, and a *third* pipeline surface, the prev/current/next hop chips, inside the conversation strip (`MobileFocusView.tsx:735–830`). One object, three surfaces.
- `MobileMapLite.tsx`: a pick-only projection of the scheme, built to bound memory (#418). Nodes spend their width on a constant engine chip and four characters of title (finding 13, still standing). It answers "where is everything" with a picture nobody can read on a phone.

### 1.8 The orchestrator row and sheet

`MobileOrchestratorRow.tsx` + `MobileOrchestratorSheet.tsx` (#979, #1347, #1004): the seat is pinned first in every leaf, a live seat opens its conversation in the standard focus view, the create and rotate drafts share the desktop's launch module in a fullscreen sheet, and the keyboard budget is measured. This is the one mobile surface whose decisions hold; v2 keeps every one of them and only moves the row into a card on the board (§3.3) and gives the live seat a bottom sheet instead of a fullscreen one.

### 1.9 The attention chrome

`attention/AttentionIsland.tsx:35–110`: on the phone the island is two 44 px buttons (count, next) in the header, rendered at zero as "⚠ 0" (a designed quiet-zero; audit decision D1 is still open). `AttentionToast.tsx:38–60`: a new arrival is a permanent in-flow banner above the board (finding 8, still standing) that repeats what the island and the card already say, and stays until dismissed.

### 1.10 The composer

`ComposerBar.tsx:190–470`: input + attachment fold + mic + send on one row, and the `RuntimePill` on its own always-visible row under it. The pill says "Sonnet · Light" (`reasoningTier.*`) while the seat sheet's dropdown says "low" (`effortTier.*`) and the operator's own vocabulary is `low / high / xhigh / max` (finding 9, still standing).

### 1.11 Accounts, project switching, search

Accounts open the desktop `AccountsPanel` dialog from an account badge tap; on a phone it is a scaled-down dialog. Projects open through a hamburger into a fixed drawer holding the desktop `ProjectRail`. Search (#1054) is a header slot and a fullscreen palette; it works and stays.

### 1.12 The 2026-08 audit findings, re-checked on this branch

| Finding | Status today | Where v2 answers it |
| --- | --- | --- |
| 3 operator-blocking waits show as green "working" | still stands (`TurnStatusBar.tsx`) | §4.2: the bar's meta line, the rows and the send slot follow one precedence: blocked states outrank running, in word and tone |
| 4 five inline header controls crush the title | still stands (`BranchPane.tsx:339–377`) | §4.2: the bar has back, title cell, attention, one `⋯` |
| 5 keyboard hides the mandate field | fixed by #1004 | kept; the rotate draft reuses it |
| 6 question card leads with transport jargon | still stands (`QuestionCard.tsx:368`) | §4.3: the card is question, options, "or type your own answer"; transport is a caption |
| 8 attention toast occludes / repeats | still stands (`AttentionToast.tsx`) | §4.6: one banner slot, auto-collapses into the badge |
| 9 three vocabularies for effort | still stands (`RuntimePill.tsx`, `en.ts:629–644`) | §4.4 + Q5: one vocabulary everywhere on the phone |
| 13 map-lite nodes waste width | still stands | §6: map-lite is cut on the phone |
| 17 orchestrator row truncates the state word | still stands (`MobileOrchestratorRow.tsx`) | §4.1: the seat is a card with a state badge that never truncates |
| 18 icon-only controls have no touch route to their meaning | still stands | §4.2: every control on the phone is a labelled row in a sheet, or one of four bar icons |

### 1.13 What earlier lanes settled, and what v2 does with each

Searched prior conversations (`search_transcripts`: "mobile focus view", "390px", "MobileFocusView", "bottom shelf", "orchestrator sheet") and the issues behind them.

| Decision | Source | v2 |
| --- | --- | --- |
| The focused chat owns the viewport; secondary surfaces default to zero height | #419, `chatBudget.ts` | **Kept and strengthened.** The budget model is rewritten to include everything that can appear (§3.4). |
| The document never scrolls sideways at 390 px | #353, #613 | **Kept**, gated by the capture. |
| Five fixed targets in the header, name is the elastic cell | #613 | **Replaced.** The bar carries a title cell and at most three targets (§3.2). |
| The orchestrator is pinned first in every phone leaf; a live seat opens the standard focus view; create/rotate are a fullscreen sheet with the desktop's launch module | #976 decisions 1 and 5, #979 | **Kept.** The pin becomes the first card on the board; the drafts keep their sheet. |
| Rotate and seat settings reachable from the phone row | #1347 | **Kept**, as the card's second target and the seat sheet. |
| Composer budgets against the keyboard-shrunk visual viewport; the field stays above the fold | #983, #1004 | **Kept**, gated by the capture's keyboard frame. |
| Opening a conversation on the phone stamps "seen" | #1244 | **Kept**: a board row tap, a switcher tap and the attention row tap are the open gesture. |
| The rename editor is legible on the phone | #1348 | **Kept**: rename lives in the `⋯` menu and edits the title cell in place. |
| The model/reasoning control is always visible on the phone | #499 | **Kept**, as the chip inside the composer box instead of a separate row. |
| Search gets a header slot | #1054 | **Kept on the board bar**; inside a conversation it is a row in `⋯`. |
| Map-lite is bounded so the largest board cannot OOM a phone | #418 | **Superseded**: the board becomes a list; nothing world-sized is mounted on a phone. |
| Two-step Kill, confirmed delete | #699, design-system rule 4 | **Changed by the operator's standing rule** ("no confirmation prompts"): destructive actions live last in the `⋯` menu, in danger colour, and act on tap (Q4). |

---

## 2. Design principles (from the requirement, made concrete)

1. **One primary surface at a time.** A screen is a list, a conversation, a pipeline, or the accounts page. Everything else is a sheet over it that closes with one tap on the scrim, the `×`, or a drag of its handle past 80 px.
2. **One bar.** 52 px, canvas-coloured, hairline below. Left: back, or nothing. Middle: the title cell, which is itself the switcher. Right: at most three 44 px targets, in this order and only when relevant: attention badge (count > 0), search (board only), `⋯`.
3. **One banner slot.** Directly under the bar. It carries one thing at a time, in this precedence: offline, runtime degraded, a decision that arrived while the operator reads something else. It reserves its height in flow so it never covers a control. The arrival banner never shows on the board (the queue is the board's first section) and collapses into the bar's badge after ~6 s or on dismiss.
4. **One navigation contract.** Screens push onto a stack; sheets never create history; the browser's back gesture and the bar's `‹` are the same pop; a sibling switch (a switcher row, a bar or dock swipe) replaces the top of the stack. Nothing ever lands on a sheet route after a back (§3.3).
5. **Host details behind one tap.** Background tasks with their PIDs and Kill, the runtime connection, hidden and collapsed conversations, the worktree and pipeline of the focused conversation: one `⋯ › Host details` row on the board and one `⋯ › Details & host` row in the conversation, both opening the same sheet. Nothing about the host sits on the primary surface; the one host fact the operator needs unprompted, degradation, is the banner slot's job.
6. **Content gets the width.** Agent messages run edge to edge at 15 px with a 16 px inline engine glyph, the model name and the time on one 11 px line above the text. User messages keep the bubble, at 86% max. Tool calls are chrome: one quiet line each, a clean run folds into one line with counts, a run with a failure expands into one sunken block whose lines are list items.
7. **Few controls, all 44 px, none overlapping, one overflow.** The capture refuses any visible control under 44 × 44 and any two visible controls whose rects intersect. Visual weight is smaller than the hit area where the design system asks for it (chips 28–32 px inside 44 px targets).
8. **The composer and the model selector are one unit, and the send slot is the one inline control.** One rounded box: the field on top, and under it the model · reasoning chip, attach, dictate and the send slot. The slot is send, or Stop while the agent works and the draft is empty, or Queue while offline, or Respawn when killed. There is no status row; elapsed time lives in the bar's meta line only.
9. **No confirmation prompts; receipts carry the inverse.** Kill, close, rotate, retry, skip, switch account, use a reset: each acts on the tap that names it and answers with a receipt in flow between the body and the dock, for 4 s, with the inverse action as a 44 px text button when one exists (Kill → Respawn, Close → Reopen, Archive → Restore, Skip → Retry stage, switch → Switch back).
10. **One state, one phrase, one precedence.** A conversation's state is computed once (killed > stalled > limit > held > waiting > working > returned > done; offline and degraded are screen-level) and rendered once per surface: a badge on rows that need the operator, a phrase in the meta line otherwise. The queue is "Needs you" everywhere.
11. **Both schemes, the product's tokens.** Every colour, radius, type size and shadow in the prototype is a value from `src/styles/tokens.css`; the dark palette flips with `prefers-color-scheme` and a manual `data-theme`, exactly as the product does. Every meter fills with what remains.

---

## 3. Information architecture

### 3.1 The map

```
Project switcher (sheet)
   │  Overview · crowned projects · projects · Archive · Create project
   ▼
Board (screen, one project)  ──── ⋯ ▸ New agent / task / pipeline · Tasks · All conversations ·
   │                                   Accounts & limits · Host details [degraded] · Sound · Keep awake · Archive project
   ├─ Orchestrator card ──▸ Orchestrator conversation        (no seat: "Create an orchestrator ›" ▸ create draft)
   │        └─ ⚙ ───────▸ Seat sheet (status · context · predecessor · mandate · Rotate · Open)
   │                            └─ Rotate draft (fullscreen: engine · model · reasoning · account · mandate)
   ├─ Needs you ─────────▸ Conversation (question card + composer)  |  Pipeline (findings · Retry / Skip)
   ├─ Pipelines row ─────▸ Pipelines (screen) ──▸ Pipeline (screen: findings · actions · stages · tasks)
   ├─ Working ───────────▸ Conversation (Stop in the send slot)
   ├─ Recent (3) ────────▸ Conversation (idle)   ·   All conversations · n ▸ catalog
   └─ footer: "Tell the orchestrator…" ──▸ Orchestrator conversation, keyboard open
Bar (every screen): [‹] [title cell] [⚠ n] [search] [⋯]      ⋯ opens the board menu over the current screen
   ⚠ n ──▸ Needs you sheet (conversations and pipelines · Next skips the current one and wraps)
Conversation (screen)
   ├─ title cell ────────▸ Switcher sheet (orchestrator · Needs you · Working · Recent · Board ›)
   ├─ swipe the bar or the dock ─▸ previous / next in the switcher's order, never Recent; bumps at the ends
   ├─ ⋯ ────────────────▸ [Orchestrator seat] · [Pipeline · <task> · stage k/n] · Rename · Crown · Hand off ·
   │                        Compact · Details & host · Open in terminal · Close card · Kill agent
   └─ composer chip ─────▸ Next-message sheet (model · reasoning · speed · [account, when at limit])
Accounts & limits (screen): per engine, account cards, windows, Refresh, Use one reset, sign-in rows, Add
```

### 3.2 The bar budget

At 390 px: `[‹ 44] [title ≥ 190] [⚠ ~56] [search 44] [⋯ 44]` with 4 px gaps. Measured after the rework: the title cell is 236 px on the board and on every conversation, pipeline and accounts bar with the badge present; the capture refuses any frame under 190. The conversation bar shows the title on one line and a meta line under it: dot · state phrase · engine glyph · model · reasoning · `stage k/n` when the conversation is its pipeline's current stage. The state phrase never truncates; the model and reasoning do first.

### 3.3 The navigation contract

Screens: Board, Conversation, Pipelines, Pipeline, Accounts & limits. Sheets: Projects, Needs you, board `⋯`, Host, Search, Seat, Rotate draft (fullscreen), conversation `⋯`, Switcher, Next message, Stage configuration (from a never-run stage's row on the pipeline screen). Sheets take at most 88% of the height, keep the screen behind visible and dimmed, and are modal in the sense `useModalLayer` already implements.

| Gesture | What it does |
| --- | --- |
| Tap a row, a stage, a banner, a queue item, Next › | **Push** the screen. 200 ms slide from the right. |
| Bar `‹`, the platform back (iOS edge swipe, Android back) | **Pop** to the screen the operator came from. The reverse slide. The board is the bottom of the stack; `‹` on a deep-linked screen goes to the board. |
| Open a sheet (`⋯`, `⚠`, title cell, ⚙, chip) | The sheet opens **over the current screen** and creates no history entry (the route is replaced). Every screen's `⋯` opens the board menu over that screen; `⚠` opens the queue over that screen. |
| Close a sheet (scrim, `×`, a drag past 80 px, a row that pushes) | Back to the same screen, scroll position kept. A back gesture while a sheet is open pops the screen underneath and takes the sheet with it; forward never re-opens a sheet. |
| Switcher row, bar swipe, dock swipe | **Replace** the top of the stack with the sibling conversation; 120 ms crossfade. `‹` still leaves the way the operator came in. The swipe walks the switcher's order (orchestrator, Needs you, Working) and never Recent; at either end the title cell bumps 12 px. |
| Kill, Close card, Archive | Act, show the receipt with its inverse, then pop (Close, Archive) or stay (Kill). |

The prototype implements this with `pushState` / `replaceState` and a depth counter (`prototype/app.js`, "route"), and the capture's flows check it headless: Pipeline → stage → conversation → `‹` ends on the pipeline; board → `⋯` → Accounts → browser back ends on the board with no sheet; `⚠` from a conversation → close returns to it at the same scroll offset; the swipe sequence from the orchestrator equals the switcher's rows minus Recent and bumps after the last one.

### 3.4 The viewport budget, rewritten

Measured in the prototype at 390 × 844, keyboard closed, a conversation focused and working:

| Region | Today (`chatBudget.ts` + what the screenshot adds) | v2 |
| --- | --- | --- |
| Bar | 52 header + 56 strip | 52 |
| Docked background tasks | 44 per task (not in the budget) | 0 (host sheet) |
| Attention banner | ~60 while present (not in the budget) | 45, transient, never on the board, collapses into the badge |
| Conversation header | 56 | 0 (folded into the bar's title cell) |
| Subagent tray / task strip | 44 (not in the budget) | 0 (a row in Details & host; members open from the feed) |
| Live-tail pill + status bar | ~40 (not in the budget) | 0 (Stop is the send slot; elapsed time is in the bar) |
| Composer | 56 + 44 pill row | 109 (one box: field 32 + tools 44 + padding, 14 px home inset) |
| **Chrome total** | **264 budgeted, ~440–480 observed** | **161 (206 with a banner)** |
| **Transcript** | **~45% observed** | **81% (76% with a banner)** |

Keyboard open (336 px): the safe-area inset goes to zero, suggested-reply chips stay, and the transcript keeps 315 px — 62% of the 508 px that are visible, with the whole question card inside it. The capture's keyboard frame gates that the send control sits above the keyboard and the field below the bar.

---

## 4. Screen by screen

The prototype's 29 key screens, by their `screens.js` id. Both frames and both schemes render for each; `board`, `board-attention`, `chat-working` and `pipeline` also render at 844 × 390.

### 4.1 Board (`board`, `board-attention`, `board-projects`, `board-menu`, `board-host`, `board-search`, `board-noseat`, `board-degraded`, `board-crowded`)

```
┌ atlas ⌄                        ⚠ 3   🔍   ⋯ ┐  52   bar: title cell = project switcher
│ Orchestrator                                 │
│ ┌ 🤖 Orchestrator  working 2:14           ⚙ ┐│       seat card: state badge, what it does now,
│ │    list_conversations                      ││       context meter (fills with what remains)
│ │    ▰▰▰▰▰▰▰▱                                ││       tap = open its conversation, ⚙ = seat sheet
│ Needs you · 3                                 │
│ ▌Implement the export endpoint    a question │  56   left edge + badge; meta: waiting 9 min · ⌘ gpt-5.6
│ ▌Migrate accounts …           plan approval  │
│ ▌Fast conversation switching  needs a decision│       a pipeline decision is a queue row too
│   stage 3/5 · review failed · 2 findings · 1h │
│ Pipelines · 3                                 │
│ ● 3 pipelines · 1 active · 1 needs you …    › │       one dot, no edge (its warning moved up)
│ Working · 3                                   │
│ ● Rebuild the board status projection ♛     › │       working 12:40 · Edit cardStatus.ts · ✦ Opus
│ Recent · 3  (three rows, then All conversations · n ›)
├ (🤖 Tell the orchestrator…)              🎤 ┤  44   footer: one tap to the orchestrator, keyboard open
```

- The board is the desktop switchboard's triage grouping (Needs you / Working / Recent), with the seat first (#976 decision 5). **Needs you holds both item kinds**: a conversation waiting on a decision, stalled, or at its account limit, and a pipeline in `needs_decision` (title, `stage 3/5 · review failed · 2 findings`, badge `needs a decision`, tap → the pipeline). The badge, the queue sheet and Next › count and reach the same list.
- Rows are dot · title · one meta line · one trailing element. On a row that needs the operator the edge and the badge are the two coloured elements; the meta reads `waiting 9 min · ⌘ gpt-5.6`, in secondary text, and the title may take two lines. On a working row the meta reads `working 12:40 · <running tool or last line> · ✦ Opus`. The state phrase never truncates. Every row ends with `started 3h ago` when the transcript names its launch (#1487): the phrase's age is the state's own clock — how long owed, how long this turn, how long since the last move — and the launch is the other question the operator asks of every row, so both ride the line, each under its own word.
- The pipelines summary row sits above Working while any pipeline is active, so ten working lanes do not push it past the fold; Recent is capped at three rows plus `All conversations · n ›`. With thirty conversations and ten pipelines (`board-crowded`) the board is 1 212 px tall and every decision row ends above 490 px.
- **No seat** (`board-noseat`): the card is an invitation: bot mark, "No orchestrator", one accent line "Create an orchestrator ›" opening the create draft (the rotate sheet in create mode); the footer says "Create an orchestrator to talk to…".
- **Degraded / offline** (`board-degraded`, and every screen): the banner slot in info tone, "Runtime degraded · polling / Updates arrive every 10 s" or "Offline · reconnecting / Showing the last state received · 14:02". The `⋯ › Host details` row carries the runtime badge. There is no Host section on the board.
- The board shows no arrival banner (P2-1): the queue is the first section.
- `⚠ 3` opens **Needs you · 3**: conversations and pipelines, `Next ›` in the header when there is more than one, which skips the item the operator is looking at and wraps.
- **Projects** (tap the name), **`⋯`**, **Host**, **Search**: as before; `⋯ › Host details` shows the runtime badge when it is not `connected`; the host sheet's runtime row reads `connected · updates stream`, `degraded · polling every 10 s`, or `offline · reconnecting`.

### 4.2 Conversation (`chat-working`, `chat-idle`, `chat-orchestrator`, `chat-menu`, `chat-switch`, `chat-model`, `chat-host`, `chat-arrival`, `chat-offline`, `chat-held`, `chat-limit`, `chat-stalled`)

```
┌ ‹  Rebuild the board status projection  ⚠ 3  ⋯ ┐  52  title cell: tap = switcher, swipe = prev/next
│    ● working 12:40 · ✦ Opus · high              │      meta line: state phrase first, never truncated
├ Needs you · plan approval · Migrate accounts… × ┤  45  banner slot, only for an arrival, collapses in ~6 s
│                    ┌ Read issue 212 and tell … ┐│      user bubble, right, 86% max, 15 px
│ › 3 actions · Read ×2 · Grep        13:41–13:42 │      folded run, one 44 px line
│ ✦ Opus                                    13:43 │      44 px header whose top 12 px are the gap; tap = Copy / Read aloud
│ The projection lives in one module that turns … │      full width, 15 px
│ ┌ 🔧 Edit CardStatusBadge.tsx        13:57 0.2s ┐│      a run with a failure: one sunken block is the target,
│ │ ✕ Bash bun test …           exit 1 13:58 4.1s ││      its lines are 36 px list items, the detail under the error,
│ │   1 fail · expected «held», received «working»││      the running tool last
│ └ ◌ running Edit cardStatus.ts…               4s┘│
│ ┌ message the agent…                          ┐ │
│ │ (Opus · high ⌄)  ＋  🎤                   ■ │ │      one box; the slot is Stop while working and empty
└ └──────────────────────────────────────────────┘ ┘
```

- **State precedence**, computed once in `stateBits` and used by every surface:

  | State | Dot | Row (meta · trailing) | Bar meta | Composer |
  | --- | --- | --- | --- | --- |
  | offline (screen-level) | — | rows keep their last state | `offline · reconnecting`, muted | the slot is **Queue**; a send answers "Held until reconnected" |
  | degraded (screen-level) | — | — | unchanged | info banner on every screen |
  | killed | danger | `killed · 14 min` · › (Recent) — only a host that died with its turn OPEN; a host stopped after its turn settled is the ordinary end of a finished stage and reads as done / finished the turn, neutral (#1487) | same, danger | placeholder `killed · text queues until a respawn`; the slot is **Respawn** — and stays Respawn over a settled host with no process, whose placeholder reads `the host stopped · …` |
  | stalled | danger edge | `14 min · ✦ Opus` · badge `stalled` (Needs you) | `stalled · 14 min` | send; `⋯ › Kill agent` hints "stalled" |
  | limit | warning edge | `Main resets 16:40 · ✦ Opus` · badge `limit` (Needs you) | `limit · Main resets 16:40` | the chip reads `Opus · Main at limit` in warning and its sheet offers the other authenticated accounts inline; one that is not signed in shows `sign in →` and opens the device sign-in |
  | held | warning | `held · 2 messages queued` · › (Working) | same, warning | placeholder `held · text you send queues` |
  | waiting | warning edge | `waiting 9 min · ⌘ gpt-5.6` · badge `a question` | `a question · 9 min` | question card + chips |
  | working | success | `working 12:40 · Edit cardStatus.ts · ✦ Opus` · › | `working 12:40` | the slot is **Stop**; typing flips it to send (the message queues behind the turn) |
  | returned | accent | `finished the turn · 32 min` · › | same | send |
  | done | neutral | `done · 2h` · › | same | send |

- **`⋯`** holds every former header control as a labelled row, plus two first-group rows when they apply: "Orchestrator seat" on the seat's own conversation, and `Pipeline · <task> · stage k/n · <stage> · <state>` on a stage conversation, opening the pipeline screen (`‹` from there returns here). Then Rename, Crown/Remove crown, Hand off, Compact context (`29% left`), Details & host, Open in terminal, a separator, Close card, and Kill agent in danger colour with a "running now / stalled / not running" hint. No row asks for confirmation (Q4). Kill's receipt carries Respawn; Close's carries Reopen.
- **Switcher** (tap the title): the same sections as the board, dense 44 px rows, the current one checked, `Board ›` in the header. Rows replace the current conversation (a sibling switch). The bar swipe and a swipe on the dock step through the same list without opening it.
- **Details & host** from `⋯` is the host sheet with a "This conversation" block on top: account, context (`29% left`), worktree (mono), pipeline. Transport is shown only when it is not the default, so never in the fixture.
- **Arrival** (`chat-arrival`): a decision that arrives while the operator reads another conversation shows in the banner slot (`Needs you · plan approval / Migrate accounts to the new binding`, body tap opens it and stamps seen, so the same decision is not announced again, `×` dismisses) and collapses into the badge after ~6 s. The prototype runs the timer and the seen stamp; lane 8 tests both.

### 4.3 Waiting for a reply (`chat-waiting`, `chat-keyboard`)

- The question card is warning-soft with a 45% warning border, headed `⚠ Needs you · 9 min`, then the question in 600 weight at 15 px, then each option as a 44 px white row with a radio mark, then one muted line: "Or type your own answer below — it is sent as the reply." Picking an option **sends it**; so does tapping a suggested-reply chip; so does send with typed text. The reply then renders as the user's bubble, the state flips to working, and the card folds to one quiet 44 px line `› question · answered 14:01` that expands to the original question and options with the chosen one marked. Transport state, when it matters, is a caption under the card (finding 6).
- Suggested replies ride as 32 px chips (44 px hit) directly above the composer box.
- **Keyboard open** (`#/chat/c2/kb`): the `.kb` block reserves 336 px, the safe-area inset goes to zero, chips stay, the box sits on the keyboard with the send control at 32 px visual / 44 px hit; the whole question card stays inside the 315 px of feed that remain. The field opens with a reply already typed, and that text is the live draft: one tap on send answers the question and lands back on the conversation. The gate measures send-bottom against 844 − 336 and field-top against the bar.

### 4.4 Next message (`chat-model`)

The chip inside the box opens one sheet: "Applies to your next message: Opus · high", then Model rows, Reasoning rows (`low · medium · high · xhigh · max`), and for Codex a Speed group (standard / fast — priority tier). When the account is at its limit, an Account group comes first: the blocked account with `limit · resets 16:40`, the other authenticated accounts as `ready` rows; choosing one launches the next message there. An account that is not signed in shows `sign in →` and opens the device sign-in, exactly as on the Accounts screen; it never becomes the launch target until it returns, and the limit stays until an authenticated account is chosen. Selection closes the sheet and the chip updates. One vocabulary, the operator's (Q5).

### 4.5 Orchestrator seat (`seat`, `seat-rotate`)

- **Seat card** (board): `Orchestrator` + a badge with the seat conversation's state phrase (`working 2:14`), a second line with what it does now (the running tool or its last line), and the context meter filling with what remains. Account and plan live in the sheet.
- **Seat sheet** (bottom sheet, from the card's ⚙ or the conversation's `⋯`): identity (model · reasoning, state badge, filled engine mark + account · plan + "holding the seat for 2h"), Context (`76% left of 100k`), "Predecessor · open ›", the Mandate v3 preview (three lines, faded), "Edit the mandate · replaces the orchestrator", one sentence saying that changing mandate, model or account means a successor, and two footer buttons at the thumb: Rotate, Open conversation (primary). Rotation-recommended renders one warning line under the meter when ≤ 30% of the window is left.
- **Rotate draft** (fullscreen, unchanged in substance from #979/#1347): a plain-sentence hint, Engine / Model / Reasoning as segmented controls, Account rows, the Mandate textarea prefilled, and the footer Cancel / Rotate orchestrator. With no seat the same sheet is "Create an orchestrator" with Create orchestrator as its primary. Confirming acts on the tap and lands in the (new) orchestrator's conversation. The #1004 keyboard behaviour carries over verbatim.

### 4.6 Attention entry

Three entries, one queue, one phrase: the bar badge `⚠ n` on every screen (hidden at zero), the banner in the one slot on arrival (never on the board), and the edged rows in the board's Needs you section. The badge opens the Needs you sheet over the current screen with `Next ›`; the banner's body opens the conversation; both stamp "seen" (#1244). Pipelines in `needs_decision` are queue items like any other.

### 4.7 Pipelines (`pipelines`, `pipeline`, `pipeline-running`)

- **List**: Needs you / Active / a folded "n completed" toggle. Rows: dot, task title (two lines when it needs the operator), `stage k/n · <stage> · <state> · started`, state badge.
- **One pipeline**: the bar's title cell is the task title with a meta line `needs a decision · stage 3/5 · 2h ago` (no header block, no template line: the stage list says it). When a review failed, the findings block (`Review · round 3 · 2 findings`, the findings as a numbered list); the actions for the current state as two 44 px buttons (Skip stage / Retry stage; Pause; Resume; Archive), acting on tap, Skip and Archive with their inverse in the receipt; the stage list as one card with a row per stage, the current stage marked by an accent edge; every reviewed stage has a conversation and opens it (`‹` returns to the pipeline); linked tasks below.

### 4.8 Accounts & limits (`accounts`)

A screen from `⋯`, per engine: the active account as a card (filled engine mark, label, `active`, plan, "checked 14:32", the lowest window in the corner as `38% left / Week`, coloured by what remains), its windows as `label · meter · % left` with the reset line under each, the resets line, and Refresh / Use one reset as 44 px text buttons; other authenticated accounts as quiet rows (`ready`) that switch future launches on tap, with "Switch back" in the receipt; accounts that are not signed in as quiet rows with a trailing `sign in →` that opens the device sign-in and become active only after it returns; "Add a … account" last.

---

## 5. Visual language

- **Tokens**: the prototype's `:root` and dark blocks are `src/styles/tokens.css` value for value. Surfaces: canvas behind, card for rows and the composer, sunken for the field, expanded runs and segmented controls, raised for sheets and receipts. Shadow-1 only on cards over the canvas; shadow-2 only on sheets and receipts. Two radii: 8 px controls, 12 px surfaces; pills only for badges, chips and dots.
- **Type**: 15/600 bar titles, 13/600 row titles, **15/400 message content** (agent prose, user bubbles, the question and its options) at 1.45, 13 for row titles and sheet rows, 12 for tool lines and buttons, 11 for meta lines, 10 for badges; tabular numerals on every time and count; mono only for PIDs and worktree names. Fields are 16 px so iOS never zooms.
- **State as an edge, at most two coloured elements per row**: a row that needs the operator carries a 3 px warning (or danger, stalled) edge and a badge, and its meta stays in secondary text; the current pipeline stage a 3 px accent edge; nothing tints a whole header. Dots elsewhere: success live (pulsing only on the focused surface, still under reduced motion), warning waiting or held, danger stalled or killed, accent returned, neutral done.
- **Badges**: one recipe, 20 px, soft fill + role text: `working 2:14`, `a question`, `plan approval`, `needs a decision`, `stalled`, `limit`, `running`, `active`, `needs sign-in`, `degraded`, `offline`.
- **Engine marks**: a 16 px glyph in secondary colour (Claude sparkle, Codex command) inside rows, sheet rows and message headers; the filled circle in the engine colour only on account cards (36 px) and in the seat sheet. The marks are the only avatars left.
- **Meters**: one semantic everywhere: the fill is what remains, coloured by what remains (accent above 30%, warning at or under 30%, danger at or under 10%). Context reads `76% left of 100k`; the accounts corner reads `38% left / Week`.
- **Motion**: push 200 ms slide from the right and pop its reverse; sibling switch 120 ms crossfade; sheets rise 24 px over 320 ms and follow the finger on a drag of the handle, closing past 80 px or springing back over 200 ms; the swipe bump 12 px over 200 ms; the working dot pulses at 1.6 s; the arrival banner collapses after ~6 s; everything stills under `prefers-reduced-motion`.
- **Receipts**: raised surface, success edge, in flow between the body and the dock (inside a sheet, between its body and its footer), 4 s, with the inverse action as an accent text button. The receipt takes its own height, so the scroller above it shrinks and no control can sit beneath it; a feed keeps its last message in view when it shortens. Below a screen without a dock the receipt keeps the home inset under it.
- **Landscape**: same layout, the bench needs both width and height (≥ 640 × 600), so an 844 × 390 phone gets the shell; sheets take 88% of 390 px; the keyboard frame is not budgeted in landscape.

---

## 6. Deferred — not currently justified

Scope the requirement does not demand, kept on record here.

- **Map-lite on the phone** (`MobileMapLite.tsx`, `mobileMapModel.ts`, `mapGate.ts`). The board list answers "what needs me, what is running" in words; the picture answered it in four-character labels. The desktop scheme is untouched. If a phone ever needs spatial navigation, #183's semantic zoom is the destination.
- **The conversation chip strip.** Replaced by the title-cell switcher, the board and the bar/dock swipe. Chips could not name conversations (rule 3) and cost 56 px permanently.
- **The hamburger and the project drawer.** The project name is the switcher.
- **The "Hidden" shelf** (`MobileBottomShelf.tsx`). Its contents (handoff, collapsed workers, quiet strips, readiness) are `⋯ › Hand off` and the Host sheet.
- **The pipeline hop chips in the strip, the dock and the nested verdict sheet.** One pipeline screen holds them; a stage conversation reaches its pipeline from `⋯`.
- **The subagent badge rail and the inline tray on the phone.** Children are rows in Details & host and open from the feed; the desktop keeps the badges.
- **The composer status row and the live-tail pill** (removed in round 1). Stop is the send slot; elapsed time is the bar meta; following is the feed's default and needs no pill.
- **The board's Host section and row** (removed in round 1). Host detail lives behind `⋯ › Host details`; degradation is the banner slot's job.
- **The board banner** (removed in round 1). The queue is the board's first section; the banner slot on the board carries runtime states only.
- **Confirmation steps** (two-step Kill, confirmed delete, compact's arm). Removed by the operator's standing rule; the receipt's inverse action is the safety net (Q4).
- **The attention "⚠ 0" pill on the phone.** Hidden at zero (Q3). The desktop's quiet-zero stays as designed until D1 is answered.
- **Per-message action buttons row.** Copy and Read aloud open from a tap on the message's header line (mark · model · time), a 44 px target whose top 12 px are the message gap.
- **Delete project on the phone.** With no confirmation prompts, an irreversible bulk action does not belong on a 44 px row you can reach while scrolling; the desktop `⋯` keeps it.
- **A two-line title in the conversation bar.** The meta line is never empty (idle reads `finished the turn · 32 min`), so the bar keeps one title line; Needs you rows take two.
- **A tablet layout.** 768–1024 px stays on the desktop shell with the coarse-pointer sizing fix from the 2026-08 audit (finding 11).
- **Screen-reader work.** Out of scope by the standing audit direction; nothing here blocks it later.
- **Tasks board redesign.** The task sheet is reachable from `⋯ › Tasks` and unchanged; pipeline-linked tasks show as rows on the pipeline screen.

---

## 7. The five open questions — answered

Each was recommended in the first pass and the round-1 critic agreed, with two amendments now in the prototype.

1. **Board = triage list, map-lite cut on the phone.** Yes. The list answers the phone's questions in words; the desktop scheme is untouched.
2. **Keep the board footer "Tell the orchestrator…".** Yes, as a launcher into the orchestrator conversation with the keyboard open. It never sends from the board (the reply lands in the conversation). With no seat it launches the create draft.
3. **Hide the badge at zero; the banner collapses after ~6 s.** Yes to both, amended: no arrival banner on the board at all, and the collapse is prototyped (a timer in `app.js`) before lane 8 inherits it.
4. **Kill and Close act on the tap.** Yes, no arm step anywhere. The safety net is the receipt with its inverse action (Kill → Respawn, Close → Reopen), which the prototype now carries and the capture's flow exercises.
5. **One reasoning vocabulary, the tier ids.** Yes. `low · medium · high · xhigh · max` are the operator's own words. This is a deliberate departure from the 2026-08 audit's friendly names.

---

## 8. Implementation plan — one lane per slice, one owner per file

Open only after the operator's word (Wanted 4). Each lane is one issue with the acceptance below, a pinned spec quoting the operator's requirement, and the frames from lane 0 as its evidence. A file has exactly one owner among open lanes; where two slices touch the same file they are ordered, and the later one opens after the earlier merges. `src/lib/i18n/en.ts` and `uk.ts` are append-only per lane, keys prefixed by surface (`mobile2.board.*`, `mobile2.chat.*`, …), so the only merge work is the orchestrator rebasing in order. Round-1 additions are marked **r1**, verify-round additions **v**. Every edited path resolves on `origin/main`; new files carry ⁺.

| # | Lane | Owns (new ⁺ / edits) | After | Acceptance |
| --- | --- | --- | --- | --- |
| 0 | **Capture harness** | `scripts/capture-mobile-v2.ts` ⁺, `scripts/capture-mobile-v2.test.ts` ⁺ | — | Renders the production build against a seeded home (the #979 recipe) at 390×844, 430×932 and 844×390, both schemes, the same screen ids as `prototype/screens.js` including **r1** the state screens (`board-noseat`, `board-degraded`, `board-crowded`, `chat-arrival`, `chat-offline`, `chat-held`, `chat-limit`, `chat-stalled`) via seeded fixtures; the same gates as `capture.ts` (no overflow, 44 px, **r1** no overlapping controls, receipt covers no control, title cell ≥ 190, bench hidden, keyboard) and **r1** the navigation flows of §3.3; the test proves each gate can go red. |
| 1 | **Shell: one bar, one banner slot, navigation contract, sheet + receipt primitives, project switcher, board menu** | `src/components/mobile/MobileShell.tsx` ⁺, `mobileNav.ts` ⁺ (+ test: push/replace/pop, sheets create no history, never land on a sheet route), `MobileSheet.tsx` ⁺ (drag-to-close), `MobileReceipt.tsx` ⁺ (in flow above the dock, 4 s, inverse action), `MobileMeter.tsx` ⁺ (fills with what remains), `MobileProjectSheet.tsx` ⁺, `MobileMenuSheet.tsx` ⁺; edits `src/components/Viewer.tsx` (drop the drawer, plumb attention count, runtime state and arrivals into the shell), `src/components/ProjectDashboard.tsx` (mobile header branch → shell; docked `TaskStrip`s stop rendering on mobile and are passed as host data), `src/components/OverviewBoard.tsx` (mobile header → shell) | 0 | Board bar shows title cell + ≤ 3 targets; project name ≥ 190 px at 390 with attention present; no docked task rows on the phone; **r1** `⋯` and `⚠` open over the current screen and close back onto it; browser back and `‹` agree; banner slot shows offline / degraded on every screen; receipts carry Respawn / Reopen / Restore / Switch back; frames `board`, `board-projects`, `board-menu`, `board-degraded`. |
| 2 | **Board list + host sheet** | `src/components/mobile/MobileBoard.tsx` ⁺, `mobileBoardModel.ts` ⁺ (+ test: grouping, seat first, **r1** the precedence killed > stalled > limit > held > waiting > working > returned > done, pipeline decisions in Needs you, pipelines row above Working when active, Recent capped at 3, now-fragment), `MobileHostSheet.tsx` ⁺; edits `ProjectDashboard.tsx` (mobile leaf mounts the board when no conversation is focused) | 1 | Frames `board`, `board-host`, `board-crowded`; **r1** no Host section on the board; badge count = Needs you rows (conversations + pipelines); kill from the host sheet acts without a prompt; rows stamp "seen" on open (#1244 test). |
| 3 | **Conversation screen: title cell, meta precedence, `⋯` menu, switcher, swipe** | edits `src/components/mobile/MobileFocusView.tsx` (becomes the conversation screen: no strip, bar title cell, switcher sheet, **r1** swipe on bar and dock in the switcher's order with a bump, sibling switch = replace), `src/components/BranchPane.tsx` (mobile: no inline header controls), `src/components/AgentControlStrip.tsx` (mobile: rows in the menu, **r1** the pipeline row first), `src/components/TaskHeader.tsx` (`ProcessStatusControls` lives there; mobile: direct kill); `MobileSwitchSheet.tsx` ⁺, `MobileConversationMenu.tsx` ⁺ | 1 | Frames `chat-working`, `chat-idle`, `chat-menu`, `chat-switch`, **r1** `chat-offline`, `chat-held`, `chat-limit`, `chat-stalled`; the meta line's precedence test (offline > killed > stalled > limit > held > waiting > working > returned > done, `stage k/n` on the current stage); `‹` from a stage conversation returns to the pipeline; rename still legible (#1348 test kept). |
| 4 | **Feed: full width, tool runs, question card** | `src/components/feed/FeedItem.tsx`, `feed/cards/ToolCard.tsx`, `feed/cards/CmdGroupCard.tsx`, `feed/QuestionCard.tsx`, `feed/SuggestedReplies.tsx` | — (parallel with 3) | No avatar column on the phone; **r1** message content at 15 px; the header is a 44 px target whose top 12 px are the gap (no overlap with prose); a clean run of ≥ 2 tool events folds to one line and the running tool stays last; a run with a failure is one sunken block of 36 px list items with the detail; **r1** options and chips both send on tap, the reply is the user bubble, the card folds to `question · answered` and expands; frames `chat-waiting`. |
| 5 | **Composer unit + send slot + budget** | `src/components/ComposerBar.tsx`, `RuntimePill.tsx`, `TmuxComposer.tsx`, `LogFeed.tsx` (**r1** live-tail pill and status bar removed on the phone), `TurnStatusBar.tsx` (**r1** not rendered on the phone), `src/components/mobile/chatBudget.ts` (+ test with the §3.4 numbers: 161 / 206) | 3 | Frames `chat-keyboard`, `chat-model`; send above a 336 px keyboard; the chip inside the box; **r1** the slot is Stop while working with an empty draft, flips to send on typing, Queue offline, Respawn when killed; the chip offers the other authenticated accounts at limit and routes a not-signed-in one to the device sign-in (**v** the P2-8 rule holds in the sheet too); one vocabulary (Q5). |
| 6 | **Orchestrator seat card + sheet** | `src/components/mobile/MobileOrchestratorRow.tsx` → `MobileSeatCard.tsx` (rename; **r1** state badge, now line, meter by remaining, no-seat invitation), `MobileOrchestratorSheet.tsx` (live state as a bottom sheet; **r1** account · plan here, no working-dir row, "Predecessor · open ›", "Edit the mandate · replaces the orchestrator", Cancel in the draft; create mode from the invitation), `orchestratorRowState.ts` | 2 | Frames `seat`, `seat-rotate`, `board-noseat`; `capture-issue-979` gates still green (rotate reach, mandate above the fold). |
| 7 | **Pipelines list + one pipeline** | `src/components/mobile/MobilePipelinesScreen.tsx` ⁺, `MobilePipelineScreen.tsx` ⁺; edits `src/components/pipelines/PipelineStrip.tsx` (mobile row mode), `VerdictPopover.tsx` (inline findings block) | 2 | Frames `pipelines`, `pipeline`, `pipeline-running`; **r1** the bar carries the task title and meta, no header block or template line; findings heading in the product's words; every reviewed stage opens its conversation; retry/skip/pause/resume/archive act on tap and reach the same actions as the desktop, Skip and Archive with their inverse in the receipt. |
| 8 | **Attention: badge, queue sheet, arrival banner** | `src/components/attention/AttentionIsland.tsx`, `AttentionToast.tsx`, `MobileAttentionSheet.tsx` ⁺, **r1** `attentionQueue.ts` ⁺ (+ test: conversations and `needs_decision` pipelines in one list, Next skips the current item and wraps) | 1 | Frames `board-attention`, `chat-arrival`; **r1** the badge counts pipelines; the arrival banner shows on every non-board screen and collapses after ~6 s (test with fake timers); hidden at zero on the phone (Q3). |
| 9 | **Accounts & limits screen** | `src/components/AccountsPanel.tsx` (mobile layout), `AccountBadge.tsx`, `EngineAccountSwitch.tsx` | 1 | Frame `accounts`; switch / refresh / use-reset act on tap; **r1** a row that is not signed in opens the device sign-in and stays inactive; the corner number names its window; meters fill with what remains; `capture-issue-1418` still green. |
| 10 | **Retire** | delete `src/components/mobile/MobileMapLite.tsx`, `mobileMapModel.ts`, `mapGate.ts`, `mobileMapFixture.ts`, `MobilePipelineDock.tsx`, `MobilePipelineDockSheet.tsx`, **v** `src/components/MobileBottomShelf.tsx` (it sits beside `ProjectDashboard.tsx`, not under `mobile/`) and their tests; drop the shelf props from `ProjectDashboard.tsx`; update `docs/design/viewer-design-system.md` §3.2. Shipped with it: the two things only the dock could reach moved to `MobilePipelineScreen.tsx` — a never-run stage's configuration (its row opens the Stage configuration sheet) and a stage's earlier attempts and review transcripts (rows under the stage) — and the conversation's `⋯ › Pipeline` row opens the pipeline screen (§4.2). | 2, 3, 5, 7 | Type-check green; no `mobile-map` presence mode reported (`viewPresenceBus` test). |

Order: 0 → 1 → {2, 3, 4, 9} → {5, 6, 8} → 7 → 10. Review per lane by a fresh reviewer against the pinned quote and the frames. Deploy after 10, or after 5 if the operator wants the conversation screen early; every lane leaves the desktop untouched, so a partial rollout is safe.

---

## 9. Validation against the requirement

| Wanted | Delivered here |
| --- | --- |
| 1 · prototype: board, conversation + composer (idle, working with elapsed time, waiting), seat (status, rotate, mandate), switching conversations and projects, attention entry, pipelines list and one pipeline, accounts/limits; both schemes; 390×844 and 430×932; keyboard open | `prototype/` — 29 screens, all clickable, including the failure states; `?scheme`, `?frame`, `?scenario`, `#/chat/c2/kb`; `capture.ts` renders 120 gated frames and runs the flows |
| 2 · one primary surface; single compact bar; host details behind one tap; full-width messages; few 44 px controls with one overflow; composer + model selector as one unit; no confirmation prompts; no screen-reader work | §2, §3, §4; the capture refuses any control under 44 px or overlapping another; no host row on the board; no status row in the dock |
| 3 · design document: verbatim requirement, audit, IA, screen notes, cuts, implementation plan by lane and file owner; nothing implemented | this file; `git status` shows only `docs/design/mobile-v2/` |
| 4 · approval gate | the orchestrator shows `out/` and this document to the operator; lanes 0–10 open only after their word |

---

## 10. Critique round 1 — what changed per finding

`critique.md` (2026-09-02) made 4 P1, 12 P2 and 9 P3 findings. Every P1 and P2 is applied; of the P3s, eight are applied and one is applied in part. Two acceptance numbers were not reached and are stated as measured. Everything section 5 of the critique names as right is kept: the bar budget (now gated), one overflow with the danger group last, sheets with scrim/×/handle (the handle now works), the switcher mirroring the board, full-width prose with the inline mark, the composer box with the chip inside, the keyboard frame, the question card order, the killed state with Respawn, the seat sheet at the thumb, the pipeline screen, accounts, tokens value-for-value, the identity-free fixture, `out/` gitignored, the lane shape.

| Finding | What changed | Where |
| --- | --- | --- |
| **P1-1** navigation model | One contract (§3.3): screens push, sheets replace and create no history, browser back = `‹` = pop, sibling switch = replace; `⋯` and `⚠` open over the current screen (`#/pipelines/menu`, `#/chat/c1/attention`, …); `‹` from a stage conversation returns to its pipeline; the swipe walks the switcher's order minus Recent and bumps at both ends; push/pop/switch transitions as specified. The capture's flows check all five acceptances headless. | `app.js` route + wiring, `styles.css` `.screen`, `capture.ts` `flows()` |
| **P1-2** pipeline decisions in the queue | `attention()` is derived from both kinds; a `needs_decision` pipeline is a Needs you row (`stage 3/5 · review failed · 2 findings`, badge `needs a decision`), a queue-sheet row, a Next › target and counted in the badge (reads 3). The summary row lost its warning edge. With ten pipelines (`board-crowded`) every decision row ends above 490 px. | `app.js` `attention`, `pipelineNeedRow`, `attentionSheet`; `fixture.js` |
| **P1-3** only the happy path | Six states as fixture scenarios and screens: `board-noseat` (invitation card, create draft), `board-degraded` (info banner, host badge), `chat-offline` (banner, bar meta `offline · reconnecting`, Queue slot, "Held until reconnected"), `chat-held`, `chat-limit` (chip in warning, the ready account in the chip's sheet), `chat-stalled` (danger edge, Kill hint). One precedence list in §4.2, implemented in `stateBits`. | `fixture.js` `SCENARIOS`, `app.js` `stateBits`, `banner`, `composer`, `modelSheet` |
| **P1-4** status row repeats the bar | The row is gone. Stop is the send slot while the agent works and the draft is empty; typing flips it to send; killed shows the placeholder and a Respawn slot. Dock measures 109 px working and idle; chrome 161 / 206 with a banner; the keyboard frame is unchanged. | `app.js` `composer`, `styles.css` `.box .send` |
| **P2-1** banner redundant / missing | No arrival banner on the board; on every other screen an arrival shows in the slot, body tap opens and stamps seen, `×` dismisses, a 6 s timer collapses it. Screen `chat-arrival`. | `app.js` `banner`, `armArrival` |
| **P2-2** row anatomy | Row = dot · title · one meta line · one trailing element. Meta order: state phrase (never truncated), now-fragment, engine glyph, model; effort only in the bar and the chip. When the badge is present the meta drops the decision word (`waiting 9 min`) and stays in secondary text; the edge and the badge are the two coloured elements (the dot is hidden on edged rows). The pipelines row has one dot in its strongest state. | `app.js` `convRow`, `styles.css` `.row.wait`, `.m .fix` |
| **P2-3** what the agent is doing | Seat card: `Orchestrator` + state badge, a now line (running tool or last message), meter only; account and plan moved to the sheet. Working rows carry `working 12:40 · Edit cardStatus.ts`. | `app.js` `nowFragment`, `seatCard` |
| **P2-4** two meter meanings | Every meter fills with what remains, coloured by what remains; context reads `76% left of 100k`; the accounts corner reads `38% left / Week`; the fixture stores `left`. | `app.js` `meter`, `fixture.js` `windows[].left` |
| **P2-5** overlapping hit areas, chrome cost | No negative margins. The message header is a 44 px target whose top 12 px are the gap and whose bottom edge is the prose top. Tool runs: a clean run folds to one 44 px line, a run with a failure is one sunken block of 36 px list items and the block is the target. The gate refuses intersecting control rects (clipped to their scroll ancestors). **Measured, not reached:** `chat-working` still spends 236 px on tool lines (two folded runs at 44 and one expanded block of three 36 px lines plus the failure detail), against the critique's 150 px. The fixture keeps the failure run expanded on purpose (the design system: a failed call is never quiet), and the two folded runs are already one line each; what remains is the amount of tool activity this fixture tells. Headers cost 132 px, of which 36 are the message gaps. | `styles.css` feed block, `app.js` `feedHtml`, `capture.ts` `gate` |
| **P2-6** receipts cover controls, no undo | Receipts take their own height in flow between the body and the dock (above a sheet's footer inside a sheet), 4 s; the body shrinks by that height, so no control is beneath a receipt on any screen — a list at scroll top included; the gate checks a receipt against every control. Inverse actions: Kill → Respawn, Close → Reopen, Archive → Restore (pipeline and project), Skip → Retry stage, switch account → Switch back; Use one reset states the new window. The flow kills c1 from `⋯`, checks the receipt covers nothing, and respawns from it; then, at 390×844 and 430×932, it closes a card and archives the project (both land on the board) and uses a reset and refreshes on Accounts, checking each receipt against every control (verify round 3). | `app.js` `toast`, `toastHtml`, `render`; `styles.css` `.toast` |
| **P2-7** two answer controls | Chips send on tap, as options do; the reply renders as the user's bubble; the card folds to `› question · answered 14:01` and expands to the original options with the pick marked. | `app.js` `answer`, `questionCard` |
| **P2-8** unauthenticated account becomes active | A row whose auth is not Authenticated shows `sign in →` and opens the device sign-in on tap; it stays inactive. | `app.js` `accountCard`, `signIn` |
| **P2-9** conversation cannot reach its pipeline | `⋯` first group: `Pipeline · <task> · stage k/n · <stage> · <state>` → pipeline screen; the bar meta ends with `· stage k/n` on the current stage's conversation; Details & host lists the pipeline; `‹` returns to the pipeline. | `fixture.js` `pipeline:` on c1/c5/c8/c9, `app.js` `chatMenu`, `Chat` |
| **P2-10** 13 px prose | Message content, user bubbles, the question and its options at 15 px; rows, meta and chrome keep 13 / 11. Transcript share re-measured: 81%. | `styles.css` `.ma .txt`, `.mu .bubble`, `.q` |
| **P2-11** vocabulary | "Needs you" everywhere (section, sheet title `Needs you · 3`, question header, banner); no "live tail"; runtime `connected / degraded / offline`; transport only when not default (so never in the fixture); findings heading `Review · round 3 · 2 findings`; instructional notes removed; no "confirm" in copy; no Working dir. The capture greps the prototype for the banned phrases (comments stripped) and fails on any. | `app.js`, `capture.ts` `vocabulary()` |
| **P2-12** OVER-BUILT: three doors to the host sheet | The board's Host section and row are cut; `⋯ › Host details` carries the runtime badge when degraded or offline; the conversation keeps `Details & host`; the seat sheet's Working dir row is cut. | `app.js` `Board`, `boardMenu`, `seatSheet` |
| **P3-1** landscape undefined | The bench needs ≥ 640 × 600, so 844 × 390 shows the shell; the capture renders four screens in landscape and gates that the bench is hidden; §5 states the rule. | `styles.css` media query, `capture.ts` `LANDSCAPE` |
| **P3-2** long lists | Recent capped at three rows plus `All conversations · n ›`; the pipelines row moves above Working while any pipeline is active; `board-crowded` (30 conversations, 10 pipelines) measures 1 212 px. | `app.js` `Board`, `fixture.js` `crowded` |
| **P3-3** pipeline screen | Title cell = task title, meta = `needs a decision · stage 3/5 · 2h ago`; header block and template line gone; both review stages have conversations (c8, c9) and open them. | `app.js` `PipelineDetail`, `fixture.js` |
| **P3-4** title truncation | Needs you rows (conversations and pipelines) take two title lines. **Declined in part:** the two-line bar title, because the conversation bar's meta line is never empty (idle reads `finished the turn · 32 min`), so the case the finding names does not occur; listed in §6. | `styles.css` `.t.two` |
| **P3-5** engine marks too loud | Glyph in secondary colour inside rows, sheet rows and message headers; the filled circle only on account cards and in the seat sheet and rotate draft. | `styles.css` `.mark`, `.mark.fill` |
| **P3-6** switching in the unreachable zone | A horizontal swipe on the dock walks the same list as the bar swipe; §3.1 names both. | `app.js` touch wiring |
| **P3-7** copy pass | "Predecessor · open ›"; "Edit the mandate · replaces the orchestrator"; "Cancel" in the draft; the footer reads "Tell the orchestrator…" and fits at 390 without an ellipsis. | `app.js` `seatSheet`, `rotateSheet`, `Board` |
| **P3-8** dark-scheme quiet rows | Quiet rows' titles drop to secondary colour, so Recent reads quieter than Working in dark. | `styles.css` `.row.quiet .t` |
| **P3-9** promised gestures | The handle and the sheet header follow the finger; release past 80 px closes, otherwise a 200 ms spring back; the capture drags the board menu closed. Next › skips the item the operator is on and wraps (checked from c2 → c6 → p2). | `app.js` touch wiring, `next` |

**Not reached, stated as measured.** P2-5's 150 px tool-line budget on `chat-working` (236 px, reason above). P2-4 asked for the note in §5 and got it. Every other acceptance in the critique is met by the prototype and, where it is measurable, by the capture.

### Verify round — what changed per finding

The independent verification (2026-09-02, at the rework's head commit) confirmed every P1 and P2 and returned one P2 and three P3s. All four are applied; none is declined.

- **P2 · the limit sheet let a not-signed-in account become the launch target.** The chip's Account group now applies the P2-8 rule: an authenticated account is a `ready` row that takes over the next message; one that is not signed in carries `sign in →`, opens the device sign-in through the same `signIn` act as the Accounts screen, and leaves the limit and the chip (`Opus · Main at limit`) untouched. The fixture gains an authenticated alternative Claude account (`Lab`, Pro plan) so `chat-limit` shows a real escape hatch next to the sign-in row. §4.2's limit row and §4.4 say so; lane 5's acceptance carries it. The capture's flow opens the sheet under `?scenario=limit`, taps the sign-in row, checks the receipt, the chip and that no `md:` act exists for that row, then chooses `Lab` and checks the chip reads `Opus · high`. — `fixture.js` `accounts.claude`, `app.js` `modelSheet`, `styles.css` `.mrow .r .signin`, `capture.ts` `flows()`.
- **P3 · the keyboard screen's send did nothing.** The prefilled reply is seeded into the draft store when the `/kb` route first renders, so the send control acts on what the field shows: one tap renders the user bubble, folds the question and lands on `#/chat/c2`. §4.3 states it; the flow checks it. — `app.js` `composer`, `capture.ts` `flows()`.
- **P3 · lane 3 owned a file that does not exist.** `ProcessStatusControls` is exported from `src/components/TaskHeader.tsx`; lane 3 now owns that file. Every path in §8 was re-checked against `origin/main`: each resolves or carries ⁺; the check also found lane 10's `MobileBottomShelf.tsx` listed without its directory, and it lives in `src/components/`, not `src/components/mobile/`, so the row now names both directories. — §8.
- **P3 · "stamps seen" was described and not implemented.** Opening a conversation now writes `S.seen`, and the banner slot skips a decision the operator has already opened, so the banner's body tap both opens and silences it. §4.2 says exactly that; the flow taps the body, lands on the decision with no banner, and returns with none. — `app.js` `Chat`, `banner`, `capture.ts` `flows()`.

### Verify round 3 — what changed per finding

- **P2 · receipts still covered controls on list screens.** The screen receipt stops floating over the scroller: `render` inserts it in flow between `.body` and `.dock`, the slot a sheet's receipt already takes above its footer, so the body shrinks by its height and a list at scroll top cannot keep rows under it (the padding-plus-scroll-to-bottom mechanism, which only helped a feed, is gone); the 4 s timing and the inverse button are unchanged. §2 (9), §5 and §10 P2-6 say so; the flow runs the receipt gate after Close card → board, Archive project → board, Use one reset and Refresh on Accounts at 390×844 and 430×932. — `app.js` `render`, `styles.css` `.toast.flow`, `capture.ts` `flows()`.
