# Board header: one bar (#1801, item 1 + the 2026-09-19 comment)

**Originating requirement** (operator report, 2026-09-19, issue #1801 newest comment, as paraphrased there in English): "UI fix: this header needs to be put in order." Wanted, from the same comment: "one designed header. Every fact once, grouped by purpose, one search, consistent control heights, the waiting-for-you signal as the one loud element, and a layout that holds at 1280 px, at 2540 px and at 390 px. No feature is removed without saying where it went."

Prior work: `search_transcripts` ("board header toolbar top bar redesign", "kanban toolbar") found no earlier design of this header; one hit was an unrelated review of #1697.

## 1. Decisions

1. **One bar, 48 px tall**, replacing the 40 px project row (`ProjectDashboard.tsx`, the `h-10` div) plus the 53/82 px `.kb .bar` (`KanbanBoard.tsx`). Header height drops from 93 px (2540) and 122 px (1280) to 48 px at both.
2. **One control height: 32 px**, radius `--radius-control` (8 px), 12 px / 600 text, 15 px icons. Three variants only: *outlined* (card fill, default border), *pressed* (`aria-pressed="true"`: accent-soft fill, accent text, accent/45 border; used by the view switch segments, Orchestrator, Tasks), *quiet icon* (32 × 32, no border until hover; only inside the `⋯` menu trigger). The account switches take the outlined variant in the bar. Hover strengthens the border (`border-strong`) and never recolours the label, so pressed stays the only accent-coloured state. The `+` of the create controls is the same 15 px stroke icon as the others, in the control's own text colour. No pills, no 26/27/28 px controls, no tinted one-offs. Dark theme uses the same tokens; nothing is colour-coded by hand.
3. **The one loud element is the attention island** (`AttentionIsland`, fenced, untouched). It stays the only warning-coloured thing in the bar. Its mount in `Viewer.tsx` moves from `fixed right-4 top-12` to `top-[10px]` so its 28 px pill centres in the 48 px bar; the bar keeps the existing 236 px right reserve for it.
4. **One search in the bar: the task field.** It filters this board's cards by card title, description, member conversation titles and pipeline task text (`searchText`, all columns; unchanged behaviour). The message search (`search.open`, shortcut `/`, unchanged) leaves the bar and becomes the first row of the `⋯` menu. On the conversations view, which has no task filter, the same slot shows the message-search field-shaped button instead, so either view shows exactly one search.
5. **View switch**: one outlined 32 px group whose two segments fill it edge to edge, split by one rule, the selected one in the *pressed* variant; the group's border is the visible edge its neighbours are spaced from. Icon + label when the bar is ≥ 1700 px wide, icon only below (label stays as `aria-label` and tooltip).
6. **Every fact once** — see §3.
7. **Phone (390) is unchanged.** Under 640 px the desktop rows are not rendered; the phone already has one 52 px `MobileShell` bar: project title, `⚠ n` (hidden at zero), search, `⋯`. It already meets the requirement; this lane's only change there is that its ⋯ menu loses the Undo and Redo rows (§4).

## 2. Groups, left to right

| # | Purpose | Holds | Notes |
|---|---|---|---|
| 1 | where am I | project name (truncates, 48–220 px); account switches (`ProjectAccounts`) | accounts collapse into `⋯` below 1700 px |
| 2 | what is happening | `● N working` (green dot), or the existing red `catalog.unreachable` / `kanban.filesFailed` text | plain text |
| — | one elastic spacer | | the only empty stretch in the bar |
| 3 | find | task search field, 240 px, grows to 420 px max; min 160 px | |
| 4 | view | `Hidden N` (hidden at 0, as today) · board / conversations switch | `Hidden` is icon + count below 1700 px, the shape `Tasks` has |
| 5 | create | `+ Task`, `+ Agent` | one `+` button with a two-row menu below 1700 px; on Conversations the same group is drawn invisible and inert, so groups 4–7 keep their x when the view changes |
| 6 | panels | `Orchestrator` toggle · `Tasks N` toggle | icon only (+ count) below 1700 px; the Tasks panel opens under the bar, which spans it |
| 7 | more | `⋯` menu | §4 |
| 8 | what needs me | attention island, in the 236 px reserve | far right, where it already lives |

Gaps, measured edge to edge between visible controls: 8 px inside a group, 16 px between groups (panels and more are two groups). Bar padding 16 px left, 236 px right. On a project the island's toast sits 16 px under the island, clear of the bar's bottom border.

## 3. Duplicates and what each collapses into

| Today | Becomes |
|---|---|
| "N branches running · N trees" (row 1) and "N agents working" (row 2) | **`● N working`** from `model.totals.working` (the number the columns already show). The branches/trees line leaves the board view; on the conversations view, whose trees it describes, it stays as that view's group 2. |
| "N need you" text (row 2) and the island | **the island only.** The summary text and its amber dot are deleted. |
| "N tasks on the board", `Tasks N`, `Hidden N` | **`Tasks N`** (open tasks, the panel toggle) and **`Hidden N`** (what is off the board) stay, each on the control that acts on it. "N tasks on the board" is deleted: each column header already carries its count. |
| search icon (row 1) and `Find a task` (row 2) | decision 4 |

## 4. The `⋯` menu (one menu, `KanbanMenu` row pattern; en / uk)

Groups, top to bottom, each drawn only when it has a row, with one rule between two groups that both drew one (none at the top, none at the bottom):

1. Search your messages ( / ) — Пошук моїх повідомлень ( / ) (Board only; on Conversations it is the bar's find slot).
2. Below 1700 px: one row per engine account switch (`Claude · <account>`, `Codex · <account>`), each opening the existing account panel.
3. Mute sound / Sound levels (existing labels).
4. Archive project or Restore from archive · Delete project (danger row, existing confirm). Both stand down while anything in the project runs, as before; the group then draws nothing.

**Undo and Redo are gone** from the bar, this menu, the phone's menu rows and the Ctrl+Z / Ctrl+Shift+Z shortcut (operator amendment on #1801). They only reversed conversation-card closes; a proper kanban undo/redo is #1856, which builds its own history; the close-only model in `src/lib/board/history.ts` had no importer left and is deleted.

Trigger label: More actions — Більше дій (`mobile2.bar.more` wording reused under a desktop key).

## 5. Renamed labels

| Key | en | uk |
|---|---|---|
| `kanban.summaryWorking` | `{count} working` | `{count} працює` / `працюють` (plural forms kept) |
| `kanban.viewTab` | `Board` | `Дошка` |
| `dash.viewList` | `Conversations` | `Розмови` |
| new `dash.create` (narrow `+` button aria/tooltip) | `Create` | `Створити` |
| new `dash.more` | `More actions` | `Більше дій` |
| new `dash.searchShort` (narrow Conversations find label; the full wording stays as name and tooltip) | `Search` | `Пошук` |

Deleted keys once unused: `kanban.summaryNeeds`, `kanban.summaryTasks`, and the seven `board.undo*` / `board.redo*` / `board.historyGroup` strings. Unchanged: `Find a task` / `Знайти задачу`, `Hidden` / `Приховані`, `Task` / `Задача`, `Agent` / `Агент`, `Orchestrator` / `Оркестратор`, `Tasks` / `Задачі`.

## 6. Mock-ups

2540 px (bar 2292 px after the 248 px rail; wide tier):
```
| harbor  [Claude acct ▾] [Codex acct ▾]   ● 5 working  ······················  [🔍 Find a task            ] [Hidden 12] [▥ Board|☰ Conversations] [+ Task] [+ Agent]  [🤖 Orchestrator] [☑ Tasks 5]  [⋯]   ( NEEDS YOU 3 | Next › | ⏷ ) |
                                                                                                                          ^^^^^^^ pressed
```
1280 px (bar 1032 px, 780 px usable; narrow tier, one row):
```
| harbor   ● 5 working  ····  [🔍 Find a task      ] [Hidden 12] [▥|☰] [+] [🤖] [☑ 5] [⋯]      ( NEEDS YOU 3 | Next › | ⏷ ) |
```
Budget: name 120 + status 90 + search 160–200 + hidden 90 + switch 66 + create 32 + panels 32 + 56 + more 32 + gaps ≈ 740–780. If it still does not fit (long uk strings, `Hidden` in five digits) the search shrinks to 160 px, then the name truncates; nothing wraps, nothing hides.

390 px (phone, unchanged):
```
| harbor ⌄                         ⚠ 3   🔍   ⋯ |      52 px
```

## 7. Observed on main (one render, exported HEAD `eb94cddf`, production build, synthetic home, Chromium; en + uk light, en dark)

| Claim in the comment | Verdict | Measured |
|---|---|---|
| Two bars, empty middle | **Confirmed** | Row 1: 40 px, spacer 1721 of 2292 px (75 %) at 2540, 461 of 1032 at 1280. Row 2: 53 px with a 1225 px spacer at 2540; at 1280 it wraps to 82 px (board mode `scroll`), header total 122 px. |
| Same facts twice | **Corrected** | "branches running" counts live conversation files, "agents working" counts working/held rows: the fixture shows 19 against 5 side by side. Two measures that read as one fact, so one must go. The island counts the whole Viewer (`queue.length`), the summary text counts this project. `Hidden N` counts hidden task groups plus off-board and closed conversations, so it is no task count. |
| Two searches | **Corrected** | They search different things: the 28 × 28 icon opens message search, the 240 × 32 field filters cards. |
| Different weights and heights | **Confirmed** | Six heights in one header: 20 (name), 25 (switch), 26 (sound), 27 (Orchestrator, Tasks), 28 (search icon, island), 32 (field, `+` buttons). Radii: full pill, 8 px. Text 11.5 / 12 / 13 px at 400 / 600 / 700. |
| Switch has no selected state | **Confirmed, with cause** | Selected and unselected segments compute identically (transparent fill, `rgb(28,28,34)` text, 13 px / 400). `kanbanBoard.css:26-27` (`.kb button { background:none; border:0; padding:0 }`, `font/color: inherit`) overrides the Tailwind `bg-accent/10 text-accent px-2 py-1`, leaving 19 px tall segments with no padding: 153 × 25 px en, 130 × 25 uk. |
| No grouping | **Confirmed** | Uniform 8–12 px gaps, no separators; create buttons sit between the switch and the island. |
| "settings icon" in row 1 | **Misread** | It is `Sound levels`; Archive and Delete project also live in this row. |
| WAITING pill in row 2 | **Misread** | It is the Viewer-level island, `position: fixed` at y = 48 over row 2 (111 × 28 at zero; row 2 reserves 236 px for it). |
| *New, P1* | | At 1280 the `+ Task` (x 836–901) and `+ Agent` (x 909–984) buttons lie under the search field (x 425–1044): the `margin-right: -220px` on `.bar-tools` overlaps them and the render shows neither. One row removes the rule. |

Not rendered here: account pills, undo/redo and the non-zero island (the synthetic home had no accounts, history or waiting items); their sizes above come from the classes. The builder's evidence (`evidence/issue-1801/header.json`) renders them on a seeded home.

## 8. Build notes

- `KanbanBoard` `.bar` becomes the bar: it already owns query, hidden tray, create. `ProjectDashboard` stops rendering its `h-10` row on the board leaf and passes two nodes, `barLead` (groups 1) and `barTrail` (groups 6–7); on the conversations leaf it renders the same two nodes in its own 48 px row with the branches/trees line and the message-search button. Exempt the slots from the `.kb button` reset the way `.seat *` is, or restyle the switch with `.kb` classes; either way the pressed state must survive the reset.
- Delete `.kb[data-mode="scroll"|"tabs"] .bar` wrap rules, `flex-wrap`, the `order` rules and the −220 px margin. The tier follows the bar's own width (`ResizeObserver` already present, threshold 1700 px). The tabbed face (board under 768 px, a narrow desktop window outside this lane's three widths) is the one place the groups may wrap: one row there cannot hold them beside the 252 px of padding and island reserve.
- `Viewer.tsx`: island `top-12` → `top-[10px]`. No edits under `src/components/attention/`, `src/lib/attention/`, `src/lib/mcp/`, the pipeline data layer, or the limits code.
- Evidence: `BOARD_CAPTURE_CASE=header` in `scripts/capture-board-geometry.ts`, at 2540, 1850 and 1280, en and uk, light and dark, on a home seeded like production: three Claude accounts and one Codex account with usage readings bound to the project (invented names, written through the Viewer's account modules), three questions waiting behind live holder processes, working agents, two tasks off the board, and a quiet second project whose ⋯ shows Archive and Delete. It asserts header height 48, every control 32 px (island 28), gaps 8 / 16 around one spacer, no two rects intersecting, a non-zero island inside the bar, a non-zero Hidden, the pressed segment's fill differing from the other, the switch's x equal on Board and Conversations, hover leaving the label colour, `+` an icon in its control's colour, ⋯ rules only between drawn groups, no undo or redo anywhere, and the Claude panel listing all three accounts with usage. Phone, en and uk, light and dark: bar 52 px, 44 px targets, the waiting count, no undo row.

## Deferred — not currently justified

- `/` focusing the task field, matching issue numbers, per-column match counts, sticky search (#1801 item 4): conflicts with the existing `/` message-search shortcut; needs its own decision.
- Orchestrator placement and collapse, column expand (items 2, 3): #1841.
- A project-scoped waiting count beside the global island: would be a second counter; the cards already mark who waits.

## Build correction: the tier threshold is 1700 px, not 1200

Measured while building: labelled, with two account switches, the groups need about 1 300 px plus the bar's 16 px left padding and 236 px island reserve, so the first build put the wide tier at 1600 px of bar. The seeded capture of the fix round then showed 1602 px (a 1850 px viewport with the rail) is too tight in uk: the project name collapsed to nothing and the account switches ran into the status text. The uk labels need about 1 640 px, so the wide tier starts at 1700 px of bar (a 1948 px viewport), and the project name keeps at least 48 px before anything else gives. 2540 is wide; 1850 and 1280 are narrow. The evidence keeps the 1850 case and checks the name stays visible and the bar never overflows.

## Build correction: the name gives way, and the bar spans the Tasks panel

The render critique of the first fix round found two states the 6-letter fixture name and a closed Tasks panel had hidden:

- **A real-length name ran the row under the island at 1280.** The lead group's automatic minimum is its whole unwrapped name, so it never shrank and the row ran 25 px (en) to 60 px (uk) past the reserve; in uk `⋯` lay fully under the island. Narrow, the lead now has an explicit 48 px floor (`.kb .bar[data-bar-tier="narrow"] .bar-lead`, `min-w-12` on the other leaves' bar), so after the search reaches 160 px the name truncates down to that floor. On Conversations the branches/trees line also truncates (64 px floor). The capture now uses a 21-character project name and measures the last control's right edge against the island's left edge (16 px clear).
- **The Tasks panel pushed the bar back to two rows.** The panel sat beside the board, so the bar lost 280 px, the board's tabbed mode wrapped it, and the 236 px reserve guarded nothing because the island sat over the panel's own header. The Board now draws the panel itself, under its bar (`KanbanBoard`'s `aside` slot): the bar spans the board and the panel, keeps one 48 px row at every width, and the island lands on the bar, clear of the panel's scope switch and close button. The columns' mode follows the width the panel leaves them; the bar wraps only when the bar itself is under 768 px. Conversations already drew its bar across the panel's row.

## Build correction: in the narrow tier only the name truncates

The fourth critique read 1280 px with the long project name. On Conversations three texts truncated side by side (name, status, message-search label), and on the Board in uk the name kept 68 px while `Hidden` kept its full 118 px label. Below 1700 px of bar:

- `Hidden` is its icon and count, like `Tasks`; the full phrase stays as its accessible name and tooltip.
- On Conversations the find slot reads `Search` / `Пошук`; "Search your messages (/)" stays as its accessible name and tooltip. The status keeps only the live count ("N branches running"); "· N trees" and the quiet line are dropped from the bar, since the list under it shows them.
- The narrow `+` menu's two rows carry icons (new task, new conversation), like the `⋯` rows.

The attention toast, the island's own dismissable card, still floats over the Tasks panel's header while it shows. It lives in the fenced attention code and is left as a follow-up.
