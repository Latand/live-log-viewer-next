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
| `capture.ts` | `bun docs/design/mobile-v2/capture.ts` renders every key screen at 390×844 and 430×932, dark and light, into `out/` (gitignored by `.gitignore` here) and gates each frame: no horizontal overflow, every control ≥ 44 px, the keyboard frame keeps the send control above the keyboard, the requested scheme actually applied. Run on 2026-09-02: 84 frames, all gates green. |

**How to look at it.** On a wide window the page shows a phone frame with a bench above it (frame size, colour scheme, one link per screen). On a phone-sized viewport, or with the browser's device emulation at 390×844, the shell fills the screen and the bench disappears. Everything the design proposes is tappable: switch projects and conversations, answer the question, send a message, rotate the orchestrator, retry a pipeline stage, kill a background task, use a reset. Query flags for the capture: `?scheme=dark|light`, `?frame=430`; the route is the hash (`#/board`, `#/chat/c2/kb`, …).

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
| 3 operator-blocking waits show as green "working" | still stands (`TurnStatusBar.tsx`) | §4.2: the bar's meta line and the composer status row use one precedence: blocked states outrank running, in word and tone |
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

1. **One primary surface at a time.** A screen is a list, a conversation, a pipeline, or the accounts page. Everything else is a sheet over it that closes with one tap on the scrim, the `×`, or a swipe down.
2. **One bar.** 52 px, canvas-coloured, hairline below. Left: back, or nothing. Middle: the title cell, which is itself the switcher. Right: at most three 44 px targets, in this order and only when relevant: attention badge (count > 0), search (board only), `⋯`.
3. **One banner slot.** Directly under the bar. It carries one thing at a time (a new attention arrival, a runtime degradation, a delivery failure), reserves its height in flow so it never covers a control, and collapses into the bar's badge after a few seconds or on dismiss.
4. **Host details behind one tap.** Background tasks with their PIDs and Kill, the runtime connection, hidden and collapsed conversations, the worktree and transport of the focused conversation: one "Host" row on the board and one "Details & host" row in the conversation `⋯`, both opening the same sheet.
5. **Content gets the width.** Agent messages run edge to edge with a 16 px inline engine mark, the model name and the time on one 11 px line above the text. User messages keep the bubble, at 86% max. Tool calls are one quiet 12 px line each; a run of two or more folds into one line with counts.
6. **Few controls, all 44 px, one overflow.** The capture refuses any visible control under 44 × 44. Visual weight is smaller than the hit area where the design system asks for it (chips 28–32 px inside 44 px targets).
7. **The composer and the model selector are one unit.** One rounded box: the field on top, and under it the model · reasoning chip, attach, dictate and send. The status line (working with elapsed time, or killed) sits on the box's top edge and carries the one inline non-destructive control, Stop.
8. **No confirmation prompts.** Kill, close, rotate, retry, skip, switch account, use a reset: each acts on the tap that names it and answers with a receipt line.
9. **Both schemes, the product's tokens.** Every colour, radius, type size and shadow in the prototype is a value from `src/styles/tokens.css`; the dark palette flips with `prefers-color-scheme` and a manual `data-theme`, exactly as the product does.

---

## 3. Information architecture

### 3.1 The map

```
Project switcher (sheet)
   │  Overview · crowned projects · projects · Archive · Create project
   ▼
Board (screen, one project)  ──── ⋯ ▸ New agent / task / pipeline · Tasks · All conversations ·
   │                                   Accounts & limits · Host details · Sound · Keep awake · Archive project
   ├─ Orchestrator card ──▸ Orchestrator conversation
   │        └─ ⚙ ───────▸ Seat sheet (status · context · predecessor · mandate · Rotate · Open)
   │                            └─ Rotate draft (fullscreen: engine · model · reasoning · account · mandate)
   ├─ Needs you ─────────▸ Conversation (question card + composer)
   ├─ Working ───────────▸ Conversation (working · elapsed · Stop)
   ├─ Pipelines row ─────▸ Pipelines (screen) ──▸ Pipeline (screen: findings · actions · stages · tasks)
   ├─ Recent ────────────▸ Conversation (idle)
   ├─ Host row ──────────▸ Host sheet (runtime · background tasks + PID + Kill · hidden · workers)
   └─ footer: "Tell the orchestrator…" ──▸ Orchestrator conversation, keyboard open
Bar (every screen): [‹] [title cell] [⚠ n] [search] [⋯]
   ⚠ n ──▸ Attention sheet (Waiting on you · Next)
Conversation (screen)
   ├─ title cell ────────▸ Switcher sheet (orchestrator · needs you · working · recent · Board ›)
   ├─ swipe the bar ─────▸ previous / next conversation
   ├─ ⋯ ────────────────▸ Rename · Crown · Hand off · Compact · Details & host · Open in terminal ·
   │                        Close card · Kill agent        (+ "Orchestrator seat" first, on the seat's own conversation)
   └─ composer chip ─────▸ Next-message sheet (model · reasoning · speed)
Accounts & limits (screen): per engine, account cards, windows, Refresh, Use one reset, Add
```

### 3.2 The bar budget

At 390 px: `[‹ 44] [title ≥ 190] [⚠ ~56] [search 44] [⋯ 44]` with 4 px gaps. The board bar has no back, so the title cell gets ~236 px with everything present and ~300 px at zero attention. The conversation bar shows the title on one line and a meta line under it (dot · model · reasoning · state phrase); at 390 px the title keeps ~190 px, roughly 24 characters of 13 px text, before it truncates. That is the width the header used to give one character.

### 3.3 Screens versus sheets

Screens (own the bar): Board, Conversation, Pipelines, Pipeline, Accounts & limits. Sheets (over a screen): Projects, Attention, board `⋯`, Host, Search, Seat, Rotate draft (fullscreen), conversation `⋯`, Switcher, Next message. Sheets take at most 88% of the height, keep the screen behind visible and dimmed, and are modal in the sense `useModalLayer` already implements (focus in, Escape/scrim closes, body scroll locked).

### 3.4 The viewport budget, rewritten

Measured in the prototype at 390 × 844, keyboard closed, a conversation focused and working:

| Region | Today (`chatBudget.ts` + what the screenshot adds) | v2 |
| --- | --- | --- |
| Bar | 52 header + 56 strip | 52 |
| Docked background tasks | 44 per task (not in the budget) | 0 (host sheet) |
| Attention banner | ~60 while present (not in the budget) | 44, transient, collapses into the badge |
| Conversation header | 56 | 0 (folded into the bar's title cell) |
| Subagent tray / task strip | 44 (not in the budget) | 0 (a row in Details & host; members open from the feed) |
| Live-tail pill + status bar | ~40 (not in the budget) | 36 status row on the composer, only while working or killed |
| Composer | 56 + 44 pill row | 108 (one box: field 32 + tools 44 + padding) |
| **Chrome total** | **264 budgeted, ~440–480 observed** | **196 (240 with a banner)** |
| **Transcript** | **~45% observed** | **77% (72% with a banner)** |

Keyboard open (336 px): the status row hides, the safe-area inset goes to zero, and the transcript keeps 362 px — 71% of the 508 px that are visible. The capture's keyboard frame gates that the send control sits above the keyboard and the field below the bar.

---

## 4. Screen by screen

The prototype's 21 key screens, by their `screens.js` id. Both frames and both schemes render for each.

### 4.1 Board (`board`, `board-attention`, `board-projects`, `board-menu`, `board-host`, `board-search`)

```
┌ atlas ⌄                        ⚠ 2   🔍   ⋯ ┐  52   bar: title cell = project switcher
├ Agent is waiting for a reply · a question  × ┤  44   banner slot (transient)
│ Orchestrator                                 │
│ ┌ 🤖 Orchestrator  live                   ⚙ ┐│       seat card: tap = open its conversation,
│ │    ◆ Opus · high · Main · Max plan · ctx 24%│       ⚙ = seat sheet
│ │    ▰▰▱▱▱▱▱▱ context                        ││
│ Needs you · 2                                 │
│ ▌● Implement the export endpoint  a question  │  56   left edge = warning, badge names the decision
│ ▌● Migrate accounts …           plan approval │
│ Working · 2                                   │
│ ● Rebuild the board status projection ♛     › │       dot · model · reasoning · working 12:40
│ Pipelines · 3                                 │
│ ▌●●● 3 pipelines · 1 active · 1 need you …  › │
│ Recent · 2 · Host                             │
├ (🤖 Tell the orchestrator what should get done…) 🎤 ┤  44   footer: one tap to the orchestrator, keyboard open
```

- The board is the desktop switchboard's triage grouping (protected by the 2026-08 audit: Waiting for you / Working / Recent), with the seat first (#976 decision 5) and pipelines and host as one row each. Rows are the one primary surface: card white on canvas, 56 px, dot + title + one meta line + a decision badge or chevron.
- The banner is the attention toast's new home: one line, in flow, dismissable, and it collapses into the `⚠ 2` badge on its own after a few seconds (audit finding 8). The prototype shows it on first load; `×` dismisses.
- `⚠ 2` opens **Waiting on you**: each item is title + decision line + engine, with `Next ›` in the header. The badge renders only when the count is above zero (Q3).
- **Projects** (tap the name): Overview, crowned projects first, live and attention counters as plain text plus a warning badge, Archive folded, Create project. The hamburger and the drawer are gone.
- **`⋯`**: New agent / task / pipeline, Tasks, All conversations (the catalog list view), Accounts & limits, Host details, Sound alerts, Keep screen awake, Archive project. Delete project stays on the desktop (§6).
- **Host** (row or menu): runtime connection as a badge, background tasks as rows with a mono PID and a red Kill that acts on tap, hidden quiet conversations and collapsed workers as rows into the catalog. This is where 1.2 and 1.7 went.
- **Search** keeps its bar slot on the board and opens the #1054 palette as a sheet with the field focused.

### 4.2 Conversation (`chat-working`, `chat-idle`, `chat-orchestrator`, `chat-menu`, `chat-switch`, `chat-host`)

```
┌ ‹  Rebuild the board status projection  ⚠ 2  ⋯ ┐  52  title cell: tap = switcher, swipe = prev/next
│    ● Opus · high · working 12:40                │      meta line: dot, model, reasoning, state phrase
│                    ┌ Read issue 212 and tell … ┐│      user bubble, right, 86% max
│ › 3 actions · Read ×2 · Grep        13:41–13:42 │      folded tool run, one 44 px line
│ ◆ Opus                                    13:43 │      inline mark + model + time; tap = Copy / Read aloud
│ The projection lives in one module that turns … │      full width
│ 🔧 Edit src/components/CardStatusBadge.tsx  0.2s│      single tool call, quiet
│ ✕ Bash bun test …              exit 1  13:58 4.1s│      a failed call is never quiet: danger, detail below
│ ◌ running Edit src/components/cardStatus.ts…  4s│
├ ● working · 12:40 · live tail            ■ Stop ┤  36  status row: precedence blocked > running
│ ┌ message the agent…                          ┐ │
│ │ (Opus · high ⌄)  ＋  🎤                   ⬆ │ │      one box: chip, attach, dictate, send
└ └──────────────────────────────────────────────┘ ┘
```

- The bar's meta line replaces the WORKING chip, the header chips and the strip chip's title. Its state phrase follows one precedence rule (finding 3): `a question · 9 min` in warning outranks `working 12:40` in success; `killed · messages queue` in danger outranks both.
- **`⋯`** holds every former header control as a labelled row: Rename, Crown/Remove crown, Hand off to a new agent, Compact context (with the ctx %), Details & host, Open in terminal, then a separator, Close card, and Kill agent in danger colour. On the orchestrator's own conversation the first row is "Orchestrator seat" (status · rotate · mandate). No row asks for confirmation (Q4).
- **Switcher** (tap the title): the same sections as the board, dense 44 px rows, the current one checked, `Board ›` in the header. The bar swipe (#419's gesture) steps through this list without opening it.
- The feed keeps the design system §3.4 that never shipped: prose is content, tool calls are chrome, runs fold, errors stay visible, the viewer MCP row's "Open conversation" becomes a 44 px link glyph at the row's end.
- **Details & host** from `⋯` is the host sheet with a "This conversation" block on top: account, context meter, worktree (mono), transport.
- The subagent badge rail and the inline tray are gone from the viewport; a parent's folded children are rows in Details & host and open from the feed's own "spawned …" lines (§6).

### 4.3 Waiting for a reply (`chat-waiting`, `chat-keyboard`)

- The question card is warning-soft with a 45% warning border, headed `⚠ waiting for your answer · 9 min`, then the question in 600 weight, then each option as a 44 px white row with a radio mark, then one muted line: "Or type your own answer below — it is sent as the reply." Picking an option sends it (receipt: "Answer sent — NDJSON"), the card collapses to an "Answered:" line, and the state flips to working. Transport state, when it matters, is a caption under the card (finding 6).
- Suggested replies ride as 32 px chips (44 px hit) directly above the composer box; a tap fills the field.
- **Keyboard open** (`#/chat/c2/kb`): the `.kb` block reserves 336 px, the status row hides, the safe-area inset goes to zero, chips stay, the box sits on the keyboard with the send control at 32 px visual / 44 px hit. The gate measures send-bottom against 844 − 336 and field-top against the bar.

### 4.4 Next message (`chat-model`)

The chip inside the box opens one sheet: "Applies to your next message: Opus · high", then Model rows, Reasoning rows (`low · medium · high · xhigh · max`), and for Codex a Speed group (standard / fast — priority tier). Selection closes the sheet and the chip updates. One vocabulary, the operator's (Q5).

### 4.5 Orchestrator seat (`seat`, `seat-rotate`)

- **Seat sheet** (bottom sheet, from the card's ⚙ or the conversation's `⋯`): identity (model · reasoning, `live` badge, engine mark + account + "holding the seat for 2h"), Context meter with the numbers, Working dir, "Replaced an earlier orchestrator ›", the Mandate v3 preview (three lines, faded), "Edit the mandate — opens a rotation", one sentence saying that changing mandate, model or account means a successor, and two footer buttons at the thumb: Rotate, Open conversation (primary). Rotation-recommended renders one warning line under the meter.
- **Rotate draft** (fullscreen, unchanged in substance from #979/#1347): a plain-sentence hint, Engine / Model / Reasoning as segmented controls, Account rows, the Mandate textarea prefilled, and the footer Keep this one / Rotate orchestrator. Confirming rotates on the tap and lands in the successor's conversation. The #1004 keyboard behaviour (field above the fold, sheet body is the scroller) carries over verbatim.

### 4.6 Attention entry

Three entries, one queue: the bar badge `⚠ n` on every screen, the banner in the one slot on arrival, and the warning-edged rows in the board's Needs you section. The badge opens the Waiting on you sheet with `Next ›`; the banner's body opens the conversation; both stamp "seen" (#1244).

### 4.7 Pipelines (`pipelines`, `pipeline`, `pipeline-running`)

- **List**: Needs you / Active / a folded "n completed" toggle. Rows: dot, task title, `stage k/n · <stage> · <state> · started`, state badge.
- **One pipeline**: title, state badge, `stage 3/5 · started 2h ago`, the template as a second line; when a review failed, the findings block (danger-soft, findings as a numbered list); the actions for the current state as two 44 px buttons (Skip stage / Retry stage; Pause; Resume; Archive), acting on tap; the stage list as one card with a row per stage (check / cross / spinner / number glyph, `run · passed` or `review loop · round 3 · failed · 2 findings`, the current stage marked by an accent edge; a stage with a conversation opens it); linked tasks below. This replaces the dock, the sheet, the nested verdict sheet and the hop chips.

### 4.8 Accounts & limits (`accounts`)

A screen from `⋯`, per engine: the active account as a card (engine mark, label, `active`, plan, "checked 14:32", the lowest window's `% left` in the corner coloured by capacity), its windows as `label · meter · % left` with the reset line under each (5h, Week, and the flagship `Opus · Week` row from #1418), the resets line, and Refresh / Use one reset as 44 px text buttons; other accounts as quiet rows (`needs sign-in` / `Signed out` / `ready`) that switch future launches on tap; "Add a … account" last. The note at the end says what it does: nothing here asks you to confirm.

---

## 5. Visual language

- **Tokens**: the prototype's `:root` and dark blocks are `src/styles/tokens.css` value for value. Surfaces: canvas behind, card for rows and the composer, sunken for the field and segmented controls, raised for sheets. Shadow-1 only on cards over the canvas; shadow-2 only on sheets and receipts. Two radii: 8 px controls, 12 px surfaces; pills only for badges, chips and dots.
- **Type**: 15/600 bar titles, 13/600 row titles, 13/400 prose at 1.45, 12 for tool lines and buttons, 11 for meta lines, 10 for badges; tabular numerals on every time and count; mono only for PIDs and worktree names. Fields are 16 px so iOS never zooms.
- **State as an edge**: waiting rows carry a 3 px warning edge at the left; the current pipeline stage a 3 px accent edge; nothing tints a whole header. Dots: success live (pulsing only on the focused surface, still under reduced motion), warning waiting, danger stalled/killed, accent returned, strong done.
- **Badges**: one recipe, 20 px, soft fill + role text: `live`, `a question`, `plan approval`, `needs a decision`, `running`, `active`, `needs sign-in`.
- **Engine marks**: 16 px circles in the engine colour with the engine glyph (Claude sparkle, Codex command); 36 px on account cards. The marks are the only avatars left.
- **Motion**: sheets rise 24 px over 320 ms with the standard ease; the working dot pulses at 1.6 s; everything stills under `prefers-reduced-motion`.

---

## 6. Deferred — not currently justified

Scope the requirement does not demand, kept on record here.

- **Map-lite on the phone** (`MobileMapLite.tsx`, `mobileMapModel.ts`, `mapGate.ts`). The board list answers "what needs me, what is running" in words; the picture answered it in four-character labels. The desktop scheme is untouched. If a phone ever needs spatial navigation, #183's semantic zoom is the destination.
- **The conversation chip strip.** Replaced by the title-cell switcher, the board and the bar swipe. Chips could not name conversations (rule 3) and cost 56 px permanently.
- **The hamburger and the project drawer.** The project name is the switcher.
- **The "Hidden" shelf** (`MobileBottomShelf.tsx`). Its contents (handoff, collapsed workers, quiet strips, readiness) are `⋯ › Hand off` and the Host sheet.
- **The pipeline hop chips in the strip, the dock and the nested verdict sheet.** One pipeline screen holds them.
- **The subagent badge rail and the inline tray on the phone.** Children are rows in Details & host and open from the feed; the desktop keeps the badges.
- **Confirmation steps** (two-step Kill, confirmed delete, compact's arm). Removed by the operator's standing rule; see Q4 for the one place a guard might be worth keeping.
- **The attention "⚠ 0" pill on the phone.** Hidden at zero (Q3). The desktop's quiet-zero stays as designed until D1 is answered.
- **Per-message action buttons row.** Copy and Read aloud open from a tap on the message's header line (mark · model · time), a 44 px target that already exists in the rhythm.
- **Delete project on the phone.** With no confirmation prompts, an irreversible bulk action does not belong on a 44 px row you can reach while scrolling; the desktop `⋯` keeps it.
- **A tablet layout.** 768–1024 px stays on the desktop shell with the coarse-pointer sizing fix from the 2026-08 audit (finding 11).
- **Screen-reader work.** Out of scope by the standing audit direction; nothing here blocks it later.
- **Tasks board redesign.** The task sheet is reachable from `⋯ › Tasks` and unchanged; pipeline-linked tasks show as rows on the pipeline screen.

---

## 7. Open questions for the operator

Each with the recommended answer; the prototype shows the recommendation.

1. **Board = triage list, map-lite cut on the phone?** Recommended: yes. The list is the switchboard grouping the audit protected, gives every row a full title and a decision word, and mounts nothing world-sized. The alternative (keep a map behind a `⋯` row) costs a lane and answers no phone question the list does not.
2. **Keep the board footer "Tell the orchestrator what should get done in atlas…"?** Recommended: yes. It is the one-tap dispatch path (board → orchestrator conversation with the keyboard open, text carried over) and costs one 44 px row on the board only. Cut it if the board should be read-only.
3. **Hide the attention badge at zero on the phone, and let the banner collapse into it after ~6 s?** Recommended: yes to both. The badge at zero spends the warning accent on nothing at the width where every pixel counts; the banner stays in flow and dismissable while it is up. (This is audit decision D1 for the phone only.)
4. **Kill agent and Close card act on the tap, with no arm step?** Recommended: yes, per the standing rule, with the rows last in the menu, separated, and Kill in danger colour with a "running now" hint. If one guard is wanted anywhere, it is Kill on a working conversation: a two-tap arm inside the same row (first tap turns the row into "Kill · tap again") is the smallest possible one and needs no dialog.
5. **One reasoning vocabulary on the phone: the tier ids (`low · medium · high · xhigh · max`)?** Recommended: yes, the ids, everywhere on the phone (chip, sheet, rotate draft, meta lines). They are the words the operator already uses for agents and issue labels; the 2026-08 audit recommended the `Light / Medium / High …` names instead, so this is a deliberate departure and needs a word.

---

## 8. Implementation plan — one lane per slice, one owner per file

Open only after the operator's word (Wanted 4). Each lane is one issue with the acceptance below, a pinned spec quoting the operator's requirement, and the frames from lane 0 as its evidence. A file has exactly one owner among open lanes; where two slices touch the same file they are ordered, and the later one opens after the earlier merges. `src/lib/i18n/en.ts` and `uk.ts` are append-only per lane, keys prefixed by surface (`mobile2.board.*`, `mobile2.chat.*`, …), so the only merge work is the orchestrator rebasing in order.

| # | Lane | Owns (new ⁺ / edits) | After | Acceptance |
| --- | --- | --- | --- | --- |
| 0 | **Capture harness** | `scripts/capture-mobile-v2.ts` ⁺, `scripts/capture-mobile-v2.test.ts` ⁺ | — | Renders the production build against a seeded home (the #979 recipe) at 390×844 and 430×932, both schemes, the same screen ids as `prototype/screens.js`; the same gates as `capture.ts` (no overflow, 44 px, keyboard); the test proves each gate can go red. |
| 1 | **Shell: one bar, one banner slot, sheet primitive, project switcher, board menu** | `src/components/mobile/MobileShell.tsx` ⁺, `MobileSheet.tsx` ⁺, `MobileProjectSheet.tsx` ⁺, `MobileMenuSheet.tsx` ⁺; edits `src/components/Viewer.tsx` (drop the drawer, plumb attention count and toast into the shell), `src/components/ProjectDashboard.tsx` (mobile header branch → shell; docked `TaskStrip`s stop rendering on mobile and are passed as host data), `src/components/OverviewBoard.tsx` (mobile header → shell) | 0 | Board bar shows title cell + ≤ 3 targets; project name ≥ 190 px at 390 with attention present; no docked task rows on the phone; frames `board`, `board-projects`, `board-menu`. |
| 2 | **Board list + host sheet** | `src/components/mobile/MobileBoard.tsx` ⁺, `mobileBoardModel.ts` ⁺ (+ test: grouping, seat first, counts), `MobileHostSheet.tsx` ⁺; edits `ProjectDashboard.tsx` (mobile leaf mounts the board when no conversation is focused) | 1 | Frames `board`, `board-host`; kill from the host sheet acts without a prompt; rows stamp "seen" on open (#1244 test). |
| 3 | **Conversation screen: title cell, meta precedence, `⋯` menu, switcher, swipe** | edits `src/components/mobile/MobileFocusView.tsx` (becomes the conversation screen: no strip, bar title cell, switcher sheet, swipe kept), `src/components/BranchPane.tsx` (mobile: no inline header controls), `src/components/AgentControlStrip.tsx` (mobile: rows in the menu), `src/components/ProcessStatusControls.tsx` (mobile: direct kill); `MobileSwitchSheet.tsx` ⁺, `MobileConversationMenu.tsx` ⁺ | 1 | Frames `chat-working`, `chat-idle`, `chat-menu`, `chat-switch`; the meta line's precedence test (blocked > running > idle); rename still legible (#1348 test kept). |
| 4 | **Feed: full width, quiet tool lines, question card** | `src/components/feed/FeedItem.tsx`, `feed/cards/ToolCard.tsx`, `feed/cards/CmdGroupCard.tsx`, `feed/QuestionCard.tsx`, `feed/SuggestedReplies.tsx` | — (parallel with 3) | No avatar column on the phone; a run of ≥ 2 tool events folds; a failed call renders in danger with its detail; the question card order is question → options → own answer, transport as a caption; frames `chat-waiting`. |
| 5 | **Composer unit + status row + budget** | `src/components/ComposerBar.tsx`, `RuntimePill.tsx`, `TmuxComposer.tsx`, `LogFeed.tsx` (live-tail pill only while not following; status bar moves into the composer dock), `TurnStatusBar.tsx`, `src/components/mobile/chatBudget.ts` (+ test with the §3.4 numbers) | 3 | Frames `chat-keyboard`, `chat-model`; send above a 336 px keyboard; the chip inside the box; one vocabulary (Q5). |
| 6 | **Orchestrator seat card + sheet** | `src/components/mobile/MobileOrchestratorRow.tsx` → `MobileSeatCard.tsx` (rename), `MobileOrchestratorSheet.tsx` (live state as a bottom sheet; drafts unchanged), `orchestratorRowState.ts` | 2 | Frames `seat`, `seat-rotate`; `capture-issue-979` gates still green (rotate reach, mandate above the fold). |
| 7 | **Pipelines list + one pipeline** | `src/components/mobile/MobilePipelinesScreen.tsx` ⁺, `MobilePipelineScreen.tsx` ⁺; edits `src/components/pipelines/PipelineStrip.tsx` (mobile row mode), `VerdictPopover.tsx` (inline findings block) | 2 | Frames `pipelines`, `pipeline`, `pipeline-running`; retry/skip/pause/resume act on tap and reach the same actions as the desktop. |
| 8 | **Attention: badge, banner slot, queue sheet** | `src/components/attention/AttentionIsland.tsx`, `AttentionToast.tsx`, `MobileAttentionSheet.tsx` ⁺ | 1 | Frames `board-attention`, `board` (banner); the banner collapses after ~6 s (test with fake timers); hidden at zero on the phone (Q3). |
| 9 | **Accounts & limits screen** | `src/components/AccountsPanel.tsx` (mobile layout), `AccountBadge.tsx`, `EngineAccountSwitch.tsx` | 1 | Frame `accounts`; switch / refresh / use-reset act on tap; `capture-issue-1418` still green. |
| 10 | **Retire** | delete `MobileMapLite.tsx`, `mobileMapModel.ts`, `mapGate.ts`, `mobileMapFixture.ts`, `MobileBottomShelf.tsx`, `MobilePipelineDock.tsx`, `MobilePipelineDockSheet.tsx` and their tests; drop the shelf props from `ProjectDashboard.tsx`; update `docs/design/viewer-design-system.md` §3.2 | 2, 3, 5, 7 | Type-check green; no `mobile-map` presence mode reported (`viewPresenceBus` test). |

Order: 0 → 1 → {2, 3, 4, 9} → {5, 6, 8} → 7 → 10. Review per lane by a fresh reviewer against the pinned quote and the frames. Deploy after 10, or after 5 if the operator wants the conversation screen early; every lane leaves the desktop untouched, so a partial rollout is safe.

---

## 9. Validation against the requirement

| Wanted | Delivered here |
| --- | --- |
| 1 · prototype: board, conversation + composer (idle, working with elapsed time, waiting), seat (status, rotate, mandate), switching conversations and projects, attention entry, pipelines list and one pipeline, accounts/limits; both schemes; 390×844 and 430×932; keyboard open | `prototype/` — 21 screens, all clickable; `?scheme`, `?frame`, `#/chat/c2/kb`; `capture.ts` renders 84 gated frames |
| 2 · one primary surface; single compact bar; host details behind one tap; full-width messages; few 44 px controls with one overflow; composer + model selector as one unit; no confirmation prompts; no screen-reader work | §2, §3, §4; the capture refuses any control under 44 px |
| 3 · design document: verbatim requirement, audit, IA, screen notes, cuts, implementation plan by lane and file owner; nothing implemented | this file; `git status` shows only `docs/design/mobile-v2/` |
| 4 · approval gate | the orchestrator shows `out/` and this document to the operator; lanes 0–10 open only after their word |
