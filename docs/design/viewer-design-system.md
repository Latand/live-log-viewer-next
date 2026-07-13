# Viewer design system — issue #155, Deliverable A

Design direction for making the viewer feel like a designed product instead of a
functional wall of boxes. Grounded in the actual code as of `origin/main`
(post-#146): `src/app/globals.css`, `ProjectDashboard`, `MobileFocusView`,
`BranchPane`, `LogFeed` + `feed/cards/*`, `TmuxComposer`/`ComposerBar`,
`AgentRuntimeControls`, `TaskHeader` (`ProcessStatusControls`), `WorkerStacks`,
`ResidualStrip`, `taskToast`.

Audience: the Opus implementer of Deliverable B. Every spec below names the
component file it changes. Nothing here touches engines, APIs, or feed parsing;
this is class strings, tokens, and small component splits. All #145/#146
acceptance (44px touch targets, single-row mobile toolbar, docked toast
reservations) is preserved — where a spec shrinks something visually, the hit
area stays ≥44px on touch.

## Diagnosis (what the code confirms)

The operator's verdict maps to measurable facts in the codebase:

1. **No hierarchy** — everything is a bordered, shadowed box on `--color-bg`.
   `shadow-card` appears on header buttons, chips, tool cards, panes, and the
   floating create buttons alike. `PANE_TONES` tints the *entire header* of
   every card by state (`bg-[#fff7e6]`, `bg-[#eef8f0]`…), which is where the
   "washed-out beige card" comes from. Nothing is quiet, so nothing is loud.
2. **Duplication** — `StripChip` renders the active conversation's truncated
   title (`max-w-[52vw]`), and `BranchPane`'s header renders the same truncated
   title ~100px below.
3. **Inconsistency** — 12 distinct `text-[Npx]` sizes (9→15px) and 15 distinct
   corner radii (3,4,6,7,8,9,10,12,14,16,20px + md/lg/xl/2xl/full) are in use.
   The mobile top bar alone has three square-button treatments (hamburger
   `bg-bg`, HeaderMenu `bg-panel shadow-card`, view tabs as circles inside a
   pill). `font-mono` is applied to model chips, relative timestamps, worktree
   chips, and the composer mode chip — as decoration, not meaning.
4. **Chrome noise** — `ToolCard` renders every tool call as a full-width
   `rounded-[14px]` bordered, shadowed box with icon tile + summary + status +
   timestamp. `SysMsgCard` rows read "`label` системне · 1402 симв. показати".
   Section headers (`WorkerStacks`, `ResidualStrip`) are 10px BOLD UPPERCASE
   with `tracking-[.6px]` and a bare counter.
5. **Orphan/overweight controls** — `HandoffHandle docked` is a full-width 44px
   button strip below the mobile pane; `ProcessStatusControls` puts the kill
   button ("Вбити") permanently in the card header next to the title.
6. **Color ad hoc** — good role tokens exist in `@theme`, but ~30 raw hexes are
   sprinkled through components (`#fff7e6`, `#7a5300`, `#fbfbfd`, `#0d9488`,
   `#b8860b`, `#555`, `#333`…). No dark mode; the globals.css comment already
   promises "a dark theme lands app-wide later in one place".
7. **Spacing** — feed bottom padding is `pb-16` (desktop) over a composer that
   sits in a differently-tinted band (`bg-[#fbfbfd]`), producing the dead void;
   header rows pack chips at `gap-1` with no breathing room.

---

# 1. Token set

Proposed as a new `src/styles/tokens.css` imported from `globals.css` (Tailwind
v4 `@theme`, same mechanism as today). Legacy names (`--color-panel`,
`--color-dim`…) stay as aliases during migration so slices can land
independently; they are deleted in Slice 3.

## 1.1 Type

Two families, five sizes, three weights. Everything else is deleted.

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
--font-mono: ui-monospace, "JetBrains Mono", Menlo, monospace;

--text-caption: 10px;  /* counters, badge text, receipt chips     */
--text-label:   11px;  /* meta rows, chips, section headers       */
--text-ui:      12px;  /* buttons, inputs, secondary content      */
--text-body:    13px;  /* feed prose, card titles, list rows      */
--text-title:   15px;  /* page/project title, sheet headers       */
```

Line heights: `1.45` for body prose, `1.2` for single-line UI. Weights:

| weight | use |
| --- | --- |
| 400 | prose, values, timestamps |
| 600 | interactive labels, card titles, chip text |
| 700 | page title, alarming states only (stalled, failed) |

Today's habit of `font-bold` at 9–11px is the main "everything shouts" source;
600 replaces it everywhere except the two 700 cases.

**Mono rule (hard):** `font-mono` is reserved for content that is literally
machine text — shell commands, code, diffs, file paths, and opaque ids (PID,
tool call id, tmux pane target, git branch/worktree name). Everything else is
sans:

- timestamps and relative ages → sans + `tabular-nums` (fixes the
  `LastActivity` mono chip);
- model names (`fable-5`, `gpt-5.6`) → sans; they are product names, already
  identity-tinted (fixes the model chip and `AgentRuntimeControls` selects);
- the composer mode chip label ("resume", "root") → sans; the tmux target
  *value* inside it stays mono.

Mapping from today's 12 sizes: 9/9.5/10 → caption; 10.5/11 → label;
11.5/12 → ui; 12.5/13/13.5 → body; 14/15 → title.

## 1.2 Spacing

4px base grid. Tailwind's default scale already provides it; the token here is
the *rule*, plus three semantic paddings:

```
allowed steps: 2, 4, 6, 8, 12, 16, 24, 32   (px)
--pad-card:   10px 12px;   /* card header / composer padding        */
--pad-row:    6px 12px;    /* list & strip rows                     */
--gutter-feed: 12px;       /* feed horizontal gutter (compact pane) */
```

Vertical rhythm in the feed: message-to-message gap is 12px; chrome lines
(tool calls, system rows, thinking) pack at 2px so they read as one quiet
block between messages.

## 1.3 Radius — exactly two values

```css
--radius-control: 8px;    /* buttons, inputs, menu items, chips-as-rect */
--radius-surface: 12px;   /* cards, panes, menus, sheets, tool bodies   */
```

`rounded-full` remains **only** for: status dots, avatar circles, and textual
status badges (Badge spec §2.7). Buttons are never pills; segmented controls
are `--radius-control`. All of `rounded-[3|4|6|7|9|10|14|16|20px]`,
`rounded-md/lg/xl/2xl` are migrated to one of the two tokens (14/16/20 →
surface; 3–10 → control; user bubble `rounded-2xl` → surface).

## 1.4 Surfaces & elevation

Four surface levels; the shadow belongs to the level, never applied à la carte.

| token | light | dark | use |
| --- | --- | --- | --- |
| `--surface-canvas` | `#f3f3f6` | `#101014` | app background; slightly darker than today so cards actually lift |
| `--surface-card` | `#ffffff` | `#17171c` | panes, list rows, composer — the ONE primary surface |
| `--surface-sunken` | `#f7f7fa` | `#121216` | code blocks, raw output, collapsed strips, canvas-docked bands |
| `--surface-raised` | `#ffffff` | `#1d1d24` | menus, popovers, sheets, toasts |

```css
--shadow-1: 0 1px 2px rgb(20 20 30 / 0.05);                      /* card   */
--shadow-2: 0 8px 32px rgb(20 20 30 / 0.16), 0 1px 2px rgb(20 20 30 / 0.06);  /* raised */
```

Rules: `--shadow-1` appears only on `--surface-card` elements that float over
the canvas (panes, floating pills). Docked strips, buttons, chips, and anything
*inside* a card get **no shadow** — hairline `--border-default` only. This one
rule deletes most of the "wall of boxes" effect.

## 1.5 Color roles

Roles, not palette entries. Components may only reference roles; the raw-hex
sweep is part of migration. Light and dark values side by side; dark ships in
Slice 3 behind `prefers-color-scheme` + a `data-theme` override.

```
role                 light      dark       replaces (examples)
text-primary         #1c1c22    #e8e8ec    --color-ink
text-secondary       #55555f    #a2a2ae    #555 / #333 / --color-faint
text-muted           #8b8b95    #6f6f7a    --color-dim
border-default       #e6e6ea    #26262e    --color-line
border-strong        #c9c9d1    #3a3a44    done-state edges, drag handles
accent               #5a51e0    #8f88ff    --color-accent
accent-soft          #ecebfb    #262347    accent/10 backgrounds, tmsg cards
success              #1a8a3e    #4fc36f    --color-ok
success-soft         #e5f6ea    #14261a    #eef8f0, #f2faf4, #e5f6ea
warning              #9a6b00    #e0ae45    #b3831d #b8860b #8a5a00 #7a5300 (text-safe on soft)
warning-soft         #fff4dd    #2b2312    #fff7e6 #fff2d6 #fff9ed #fdf6ec
danger               #c62828    #f07171    --color-err
danger-soft          #fdeeee    #2c1616    #fdf0f0 #fff5f5 #ffe0e0 #f7e8e8
info (link/handoff)  #0d9488    #2dd4bf    the ad-hoc teal
engine-codex(+soft)  #2f6fd0/#e8f0fb   #6ba2e8/#152238   kept, incl. model-family tints
engine-claude(+soft) #d97757/#faeee9   #e08a6d/#2b1c15   kept
```

Lifecycle states map to roles once, in `paneState` → tone lookup:
`live→success · waiting→warning · returned→accent · stalled→danger · done→muted`.

The model-family tints (`utils.ts modelTint`) stay — they are a working feature
— but their *soft* variants must come from a dark-aware helper in Slice 3
(compute from HSL, as `effortTint` already does).

Diff and syntax tokens (`--color-diff-*`, hljs palette) stay as-is; they get
dark values in Slice 3 and are otherwise out of scope.

## 1.6 Motion

```css
--motion-fast: 120ms;  /* hover, press, chip state         */
--motion-base: 200ms;  /* expand/collapse, fades, popovers */
--motion-slow: 320ms;  /* sheets, overlays, deck moves     */
--ease-standard: cubic-bezier(0.2, 0, 0, 1);
```

Rules:
- every animated property uses one of the three durations + the one ease;
- **at most one attention animation on screen at a time** — the orbiting
  `pane-attention` comets stay (they're the product's signature), the pulsing
  activity dots drop `animate-pulse` everywhere except the focused card and
  the chip row (a static green dot still reads "live");
- `prefers-reduced-motion` disables everything (already mostly done — keep).

---

# 2. Hierarchy rules

These override any per-component habit:

1. **One primary surface per screen.** The focused conversation card (mobile)
   or the pane grid (desktop) is the only `--surface-card` + `--shadow-1`
   region. Top bar, chip strip, docked sections, and the composer band are flat
   (`--surface-canvas`/`--surface-sunken`, hairline separators, no shadow).
2. **State is an edge, not a wash.** A card's lifecycle shows in its status
   dot, its 2–3px top edge, and (waiting/stalled only) the orbiting border.
   Header backgrounds stay `--surface-card`. The full-header beige/green/red
   tints are deleted.
3. **A title appears once.** Whatever surface owns the title (the card header)
   is the only one that renders it; navigation chips identify by dot + engine +
   glyph only.
4. **Destructive actions live behind an overflow menu** (`⋯`) with an inline
   confirm step: kill agent, delete transcript, close column, delete project.
   Interrupt (Esc) is not destructive and stays inline. Nothing red is visible
   until the menu opens or the confirm is armed.
5. **Counters are muted.** Plain `tabular-nums` `--text-caption`
   `text-muted` after the label — never a bold accent pill. Accent pill
   counters are reserved for actionable attention (the attention queue, open
   tasks).
6. **Tool calls are chrome, not content.** Content (user/agent messages,
   requested diffs, images) gets surface and rhythm; tool calls, system turns,
   and thinking collapse into quiet single lines between messages.
7. **One accent element per component.** If a row already has an accent chip,
   its other elements are neutral.
8. Touch targets stay ≥44px on coarse pointers even where the visual element
   shrinks (inflate with padding/pseudo-element, as `HeaderMenu` items already
   do with `min-h-11`).

---

# 3. Component specs

Notation: `●` status dot, `▸/▾` disclosure, `⋯` overflow, mono in backticks.
Every "after" keeps existing behavior (aria, focus rings, 44px) unless stated.

## 3.1 Top bar (`ProjectDashboard` header, `HeaderMenu`, `ProjectViewTabs`)

**Before — mobile** (3 button treatments, everything bordered + shadowed):

```
┌──────────────────────────────────────────────────────────────┐
│ [☰] live-log-viewer-…  (◉▦|☰)  [attn-pill]   [＋]  [⋯]      │   52px
└──────────────────────────────────────────────────────────────┘
  bordered bg-bg   pill-of-circles   bordered bg-panel shadow ×2
```

**After — mobile** (one icon-button recipe, flat bar):

```
┌──────────────────────────────────────────────────────────────┐
│ ☰   live-log-viewer-next        ▦|☰   ⚡3   ＋   ⋯          │   52px
└──────────────────────────────────────────────────────────────┘
     15px/600 title, truncates     segmented  attn  quiet icon-buttons
```

- One **icon-button recipe** everywhere in the bar: 44×44 hit, no border, no
  background, `text-secondary`; hover/active → `--surface-sunken` +
  `text-primary`; radius `--radius-control`. (Borders return only on
  `--surface-raised` menus.)
- `ProjectViewTabs` becomes a standard **segmented control**: one
  `--surface-sunken` container, `--radius-control`, selected segment =
  `--surface-card` + `--shadow-1`-less border; not a pill of circles.
- Bar surface: `--surface-canvas` with a hairline bottom border — the bar must
  recede behind the card (rule 1).
- `HeaderMenu` popover: `--surface-raised`, `--radius-surface`, `--shadow-2` —
  unchanged structurally; menu items keep `min-h-11`.

**Before — desktop** (h-10; archive/delete always visible; three "+ X"
bordered buttons right):

```
│ [☰] project · status text  [🔊][archive][🗑][Tasks 3][+ Pipeline][+ Workflow] │ 40px
```

**After — desktop**:

```
│ ☰  live-log-viewer-next   3 live · 2 trees     ▦|☰    Tasks 3   ＋▾   ⋯   │ 40px
```

- Status text: `--text-label` `text-muted`, counters plain (rule 5).
- The three create buttons collapse into one **`＋` split-menu** (Agent, Task,
  Pipeline, Workflow — same items the mobile `＋` menu already has). The
  floating bottom-left create cluster on the board is then removed; one create
  entry point per screen.
- Archive project / **Delete project** / sound move into the desktop `⋯` menu
  (rule 4 — delete-project is the most destructive control in the app and is
  currently always visible).
- Tasks toggle keeps its position; its counter uses the Badge spec (§3.7),
  accent only when >0 (open tasks are actionable — allowed by rule 5).

## 3.2 Conversation chip row (`MobileFocusView` strip, `StripChip`)

**Before** (active chip duplicates the card title; pills 44px tall):

```
│ (● fix: suppress project hydra…) (⏸ Codex) (● Claude) (⤷ ● Codex) [🗺][☑3] │
        ↑ same title again 100px below in the card header
```

**After**:

```
│ (● Claude ✓)  (⏸ Codex)  (● Codex)  (⤷ Claude)   ···    🗺  ☑3            │
     active = accent ring + engine label only — never the title
```

- Chips: visual height 32px, `--radius-control` is wrong here — chips *are*
  status badges, so they keep pill shape (allowed by §1.3); hit area inflated
  to 44px with transparent padding.
- Active chip: `accent` 1.5px border + `accent-soft` fill, engine label
  `--text-label`/600. **No title** (rule 3). Verdict/waiting glyphs stay.
- Waiting chips keep the warning tone (`warning-soft` bg / `warning` text) —
  they are the strip's whole point.
- Inactive chips: `--surface-sunken`, `text-muted`, **no border** — border is
  reserved for the active/waiting states so the strip stops being a bead chain
  of outlines.
- Edge fades and scroll behavior unchanged. Desktop has no chip row (the
  scheme board is the switcher) — no desktop variant.

## 3.3 Conversation card (`BranchPane`, `AgentRuntimeControls`,
`ProcessStatusControls`, `SessionTitle`, `HandoffHandle`)

**Before — mobile** (tinted header wash; kill + delete + close always visible;
9 chip species in row 2; handoff as a huge orphan strip below):

```
┌═ engine edge ════════════════════════════════┐
│▒▒ ● fix: suppress project hydration chi… ▒▒▒│ ← beige wash (waiting)
│▒▒            [Вбити] [⤢] [🗑] [✕] ▒▒▒▒▒▒▒▒▒│ ← destructive row, 3 button sizes
│▒▒ `2 хв тому` `fable-5` ▂▃▅ [⚙ fable-5·high]│ ← mono age, mono model
│▒▒ (ctx 71%) (wt: llv-design-155) (план) …  ▒│
├──────────────────────────────────────────────┤
│  …feed…                                      │
├──────────────────────────────────────────────┤
│ [ ⇄  перекинути агенту                     ] │ ← full-width orphan strip
└──────────────────────────────────────────────┘
```

**After — mobile**:

```
┌═ engine edge (2px, model tint) ═════════════┐
│ ● fix: suppress project hydration chimes  ⋯ │ ← surface-card, no wash
│ 2m · fable-5 ▂▃▅ · ctx 71%                  │ ← one quiet meta line, sans
├─────────────────────────────────────────────┤
│  …feed…                                     │
├─────────────────────────────────────────────┤
│  composer (§3.5)                            │
└─────────────────────────────────────────────┘

⋯ menu (surface-raised):        arming a destructive item:
┌───────────────────────┐      ┌───────────────────────────┐
│ ⤢  Розгорнути         │      │ ⛔ Вбити агента (PID 4711) │
│ ✎  Перейменувати      │  →   │    [Так, вбити]  [Ні]     │
│ ⇄  Перекинути агенту  │      └───────────────────────────┘
│ ⚙  Модель і зусилля…  │
│ ──────────────────────│
│ ✕  Закрити картку     │
│ ⛔ Вбити агента        │  ← danger text, confirm inline
│ 🗑 Видалити транскрипт │  ← danger text, confirm inline
└───────────────────────┘
```

- **Header row 1**: dot + title (`--text-body`/600, one line) + a single `⋯`
  overflow button. Expand/collapse keeps an inline icon-button on desktop
  (frequent, non-destructive); on mobile it moves into the menu (the pane is
  already nearly full-screen).
- **Kill, delete transcript, close column → `⋯` menu** with the existing
  two-step confirm logic moved inside (`ProcessStatusControls` keeps its
  SIGTERM→SIGKILL escalation; it just renders in the menu). The PID chip stays
  out of the header; PID shows inside the menu row and in the confirm label.
- **Header row 2 — one meta line**, `--text-label` `text-muted`, separators
  `·`: age (sans, tabular) · model chip (sans, model-tint text, no pill bg
  unless focused) · effort meter · ctx% (only ≥70, warning tone) · worktree
  (desktop only, mono — it's an id). Plan/goal/rate-limit chips render only
  when present and cap at 2 visible + `+N` disclosure. Kind/branch label stays
  desktop-only.
- **Runtime controls**: the desktop raw `<select>`s are replaced by the same
  pattern mobile already has — one compact `⚙ fable-5 · high` chip opening a
  popover (desktop) / bottom sheet (mobile, existing) with model/effort/fast +
  Apply. One code path, two anchors.
- **State treatment** (rule 2): header background is always `--surface-card`.
  State lives in the dot + top edge + orbit (waiting/stalled) + `--shadow-1`
  ring only for `stalled`. `done` keeps its desaturated content but not a gray
  header band.
- **Handoff**: the mobile full-width strip is deleted; handoff becomes a `⋯`
  menu item (mobile) and keeps the hover-growing corner handle on the desktop
  scheme (the drag-to-link gesture is desktop-only anyway).
- Migration ribbon, flow banner, task strips: unchanged slots, restyled to
  tokens (`warning-soft` etc.).

**Desktop variant** — same header anatomy at compact density: row 1 buttons are
28px visual, menu identical; row 2 identical; `TaskStrip` rows keep h-7.

## 3.4 Feed items (`FeedItem`, `ToolCard`, `CmdGroupCard`, `SysMsgCard`,
`LogFeed` container)

**Before** (every call a 14px-radius shadowed box; system rows verbose):

```
   ┌──────────────────────────────────────────────────┐
   │ [▣] Read src/app/page.tsx            ✓ ok  14:02 │
   └──────────────────────────────────────────────────┘
   ┌──────────────────────────────────────────────────┐
   │ [▣] Bash bun test                    ✓ ok  14:03 │
   └──────────────────────────────────────────────────┘
   [▣] `system-reminder` системне · 1402 симв. показати
   ┌──────────────────────────────────────────────────┐
   │ 4 команди · Bash ×4 · ✓4                14:03–14:05│
   └──────────────────────────────────────────────────┘
```

**After** (quiet single lines; ANY consecutive run of ≥2 tool events groups):

```
   ▸ 6 дій · Read ×3 · Bash ×2 · Edit          14:02–14:05
   ⚙ Grep "PANE_TONES" src/components · ok            14:06
   ✕ Bash bun test — exit 1                            14:07   ← danger, never grouped-closed
   › системне · 1.4k                                          ← one quiet line
```

- **ToolLine (default state)**: one line, `--text-ui`, `text-muted`, **no
  border, no background, no icon tile** — a 14px glyph, summary (truncating,
  `text-secondary`), status only when it isn't `ok` (success is silence), time
  right-aligned `--text-caption`. Click/tap expands in place to the detail
  body (chips, command, diff, output, raw record — all existing, mounted
  lazily as today) inside a `--surface-sunken` `--radius-surface` block.
- **Grouping**: extend the existing cmd-group logic so any run of ≥2
  consecutive tool events (not only shell commands) folds into one ToolLine
  header: `▸ N дій · Tool ×a · Tool ×b · t0–t1`. Expanded → the list of
  individual ToolLines. A group containing an error renders expanded with the
  failing line in `danger` (keeps `CmdGroupCard`'s `open={hasErr}` behavior).
- **Errors are content**: a failed call is never a quiet line — `danger` text
  + `danger-soft` left edge, always visible even inside groups.
- **SysMsgCard** → `› системне · 1.4k` one-liner (`--text-label`,
  `text-muted`); label chip only in expanded state. Same for `tnote`/`think`
  (think already quiet — align its type + indent).
- **Prose/user messages** (the content layer): agent prose keeps the avatar +
  free text; user bubble keeps `--color-user` fill at `--radius-surface`.
  Message gap 12px (rhythm §1.2); the chrome lines between two messages pack
  at 2px and share one left indent (today's `ml-9`) so they read as one
  column of quiet activity.
- **LogFeed container**: compact pane bottom padding `pb-4` → 12px, desktop
  `pb-16` → 16px; the "huge void" above the composer disappears. Follow pill
  and "show earlier" affordances restyled to Badge/quiet-button recipes,
  behavior unchanged.

**Mobile vs desktop**: identical anatomy; mobile uses `--gutter-feed` 12px and
full-width detail blocks; desktop keeps `max-w-[1060px]` centering for the
expanded single-pane view.

## 3.5 Composer (`TmuxComposer`, `ComposerBar`)

**Before** (separate tinted band; bordered icon squares; mono mode chip;
receipts as loose purple bubbles):

```
├──────────────────────────────────────────────┤  bg-#fbfbfd band
│      (надіслано-бульбашка 14:02)  [↻] [✕]    │
│ ┌──────────────────────────────────────────┐ │
│ │ Напиши агенту…                           │ │
│ └──────────────────────────────────────────┘ │
│ [`⌗ main:1.2`][■][⌄][🎤][🖼][▶]              │
└──────────────────────────────────────────────┘
```

**After** (part of the card, one control recipe):

```
├─────────────────────────────────────────────┤  surface-card, hairline top
│ ┌─────────────────────────────────────────┐ │
│ │ Напиши агенту…                      🎤 ▶ │ │  ← input owns mic+send
│ └─────────────────────────────────────────┘ │
│ ⌗ main:1.2 · ■ stop · ⌄ compact · 🖼        │  ← one quiet tool row
│ ✓ надіслано 14:02 · «поправ тести…»    ✕    │  ← receipts: one muted line each
└─────────────────────────────────────────────┘
```

- Composer surface = `--surface-card` (same as the card; the `#fbfbfd` band
  dies). Separation is the hairline border only.
- The **input is the anchor**: `--radius-control`, `--surface-sunken` fill;
  mic and send live inside its right edge (visual 32px, hit 44px on touch).
  Send = the only accent-filled control in the card (rule 7); recording state
  flips it to danger as today.
- Secondary controls (mode chip, interrupt, compact, images) form one quiet
  row of borderless icon-buttons under the input; mobile keeps the existing
  `+` fold-out for them. Mode chip: sans label, mono only for the pane target
  value. Compact's two-step arm keeps its teal → maps to `info` role.
- Sent receipts: one line per entry — status glyph + `--text-label` truncated
  text + time + dismiss; pending/held states use the Badge recipe (warning),
  failed uses danger + retry icon-button. No purple bubbles.
- Status line and durable `ReceiptChip`s unchanged in placement; restyled to
  roles.

**Desktop = mobile** here apart from density and the `+` fold-out.

## 3.6 Section headers (`WorkerStacks`, `ResidualStrip`, quiet list header,
scheme group titles)

**Before**:

```
▸ ЗГОРНУТІ ВОРКЕРИ 96        ▸ ТИХІ РОЗМОВИ Й ЗАДАЧІ 477
  10px BOLD UPPERCASE +.6px tracking, counter glued to label
```

**After**:

```
▸ Згорнуті воркери · 96      ▸ Тихі розмови й задачі · 477
```

- One **SectionHeader recipe**: chevron + sentence-case label
  (`--text-label`/600 `text-secondary`) + `·` + counter (`--text-caption`
  `tabular-nums` `text-muted`). No uppercase, no letter-spacing, no accent
  pill (rule 5). The uppercase was a CSS transform — i18n strings don't
  change.
- Strip surface: `--surface-canvas` (they are canvas furniture, not cards),
  hairline top border. Row heights unchanged (44px mobile / 32px desktop).
- Expanded member chips (worker/residual): keep pill shape (status badges),
  `--surface-sunken` + no border at rest, hairline border on hover; engine
  mini-badge + title + age as today.
- The same recipe applies to the `HeaderMenu`/`SendMenu` group labels and the
  runtime-sheet field labels ("Модель", "Зусилля") — currently also 10–11px
  uppercase bold.

## 3.7 Toasts & badges (`taskToast`, `ProcessStatusChip`, `RateLimitBadge`,
receipt chips, attention pill, counters)

**Badge — one recipe** for every textual status chip:

```
(● PID 4711)   (⏸ очікує)   (✕ failed)   (ctx 82%)
soft-role bg · role text · --text-caption/600 · pill · 20px visual height
```

Tones: `neutral`(sunken/muted) · `success` · `warning` · `danger` · `accent` ·
engine tints. Counters (rule 5) are **not** badges — plain muted text.
`ProcessStatusChip`, `RateLimitBadge`, delivery receipts, verdict glyph chips,
ctx chip all become Badge calls; ad-hoc `#fff2d6`/`#7a5300`-style pairs die.

**Toast — before**: fully tinted green/red box, 11.5px bold, heavy shadow.

**After**:

```
┌▌ Надіслано 2 з 3 · ✕ «title»: помилка          ✕ ┐   surface-raised,
└──────────────────────────────────────────────────┘   radius-surface, shadow-2
 ▲ 3px role edge (success/danger) — not a full wash
```

- Body `--text-ui` `text-primary`; the role appears in the left edge + leading
  glyph only. Auto-dismiss, stacking, and the mobile docked-in-flow placement
  (finding 7 of #146) unchanged.
- The deploy pill / attention pill adopt the same raised-surface recipe.

---

# 4. Anti-goals

- No new fonts, no webfont loading — system stacks stay.
- No layout re-architecture: the scheme board, focus view, deck, and strips
  keep their structure; this pass is surfaces, type, and control placement.
- No behavior changes to feed parsing, polling, chime, presence, or tmux
  actions — `ProcessStatusControls`' escalation logic, lazy tool-body
  mounting, `feed-cv` virtualization, IntersectionObserver pausing all stay.
- No i18n string rewrites except where a spec names one (menu items); casing
  fixes are CSS.

# 5. Migration plan — 3 slices for the Opus implementer

Ordered by operator pain (hierarchy/duplication/destructive-prominence first,
feed noise second, furniture third). Each slice is independently shippable,
reviewed with before/after screenshots at desktop 1440 and mobile 390, en+uk,
and must not regress #145/#146 acceptance (44px targets, single-row mobile
toolbar, toast/deploy insets). Land after #153 merges.

## Slice 1 — Tokens + top bar + conversation card (the "landing" surfaces)

1. Add `src/styles/tokens.css` with §1 tokens; import from `globals.css`;
   alias legacy names (`--color-panel: var(--surface-card)` etc.) so untouched
   components keep rendering.
2. Top bar (§3.1): icon-button recipe, segmented view toggle, desktop `＋`
   split-menu, archive/delete/sound → desktop `⋯` menu, remove the floating
   create cluster from the board.
3. Chip row (§3.2): active chip drops the title; inactive chips borderless.
4. Card (§3.3): header rows restructured; kill/delete/close (+ mobile expand,
   handoff) → `⋯` menu with inline confirms; state wash → edge treatment;
   meta line consolidation; runtime controls unified into chip + popover/sheet;
   delete the mobile handoff strip.
5. Update `describe`-level render tests that assert removed controls
   (`AgentRuntimeControls.*.test`, `BranchPane` render tests, dashboard tests).

Acceptance: on one phone screen, exactly one white card over a flat gray
frame; no red/destructive control visible anywhere at rest; the title appears
once; every top-bar control is the same shape.

## Slice 2 — Feed + composer (the transcript column)

1. ToolLine + generalized grouping (§3.4) replacing `ToolCard` summary and
   extending `CmdGroupCard`'s grouping to all tool kinds; error visibility
   rules; SysMsg/tnote/think one-liners.
2. Feed rhythm: 12px message gap, 2px chrome packing, gutter + bottom-padding
   fix (kills the feed→composer void).
3. Composer (§3.5): surface merge, input-anchored mic/send, quiet tool row,
   receipt lines.
4. Mono/tabular sweep inside the feed and composer (timestamps, model names).

Acceptance: a 40-tool-call transcript reads as messages with quiet gray
activity between them — zero bordered boxes that the user didn't open; a
failed call is still impossible to miss.

## Slice 3 — Sections, badges, toasts, dark mode (the furniture)

1. SectionHeader recipe (§3.6) across WorkerStacks / ResidualStrip / quiet
   list / menu group labels / sheet field labels.
2. Badge recipe (§3.7) replacing `ProcessStatusChip`, `RateLimitBadge`,
   receipts, ctx/verdict chips; counter de-emphasis everywhere; toast redesign.
3. Raw-hex sweep: every remaining literal maps to a role token (grep gate:
   `#[0-9a-f]{3,6}` outside `tokens.css`/`utils.ts` tints must be zero);
   `modelTint` softs become dark-aware.
4. Enable dark values (`prefers-color-scheme` + `data-theme` override), verify
   both palettes on every surface incl. diff/syntax tokens; drop the legacy
   token aliases.

Acceptance: the operator can flip the OS theme and nothing falls back to a
light-only hex; section headers no longer shout; every status chip in the app
is one of six Badge tones.
