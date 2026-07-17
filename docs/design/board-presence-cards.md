# Board presence & cards — unified interaction model

One design stream for issues **#292** (card navigation/expansion/linked agents),
**#290** (Kanban readiness lanes), **#289** (auto-hide one-shot reviewers),
**#142** (native Codex subagent card policy), **#339** (Claude in-harness
subagent transcripts), **#97** (rate-limited engine visibility + reseat).
Constraint input: **#183** (semantic-zoom "memory palace") — §6 checks every
decision against it. Reference: **#268** (elapsed work time), anti-pattern
**#272** (focus stealing).

Grounded in production reality at `6fa8f12d`:
`src/components/scheme/{SchemeBoard,TaskCard,TasksLayer,taskStacks,taskGeometry,
taskPlacement,layout,nodes,useSpatialNav,spatialNav,workerCollapse,Minimap}`,
`src/components/{TaskStacksStrip,LaunchHistory,StructuredSpawnStatus}`,
`src/components/flows/directReviewGroups.ts`, `src/components/projectModel.ts`,
`src/components/mobile/{MobileFocusView,mapGate}`. Ideas were mined from stale
PR #294 (its review findings are folded into §3.2 and §5.3); the design here is
fresh and does not assume that branch merges.

Audience: implementers of the slices in §5. Nothing here touches engines or
delivery; the server-side pieces (lineage edges, receipts, the #289 close
mutation, #97 successor spawn) are named where a board surface depends on them.

---

## 0. Production reality — what already exists

The board today has **four separate "get out of the way" grammars**, each with
its own vocabulary, trigger, and destination:

| Grammar | Module | Trigger | Destination |
|---|---|---|---|
| Task status stacks | `taskStacks.ts` | quiet task card (no active assignment, no attention, >15 min untouched) | bottom `TaskStacksStrip`, one counted row per status |
| Worker collapse | `workerCollapse.ts` | worker-class conversation idle >15 min; flow reviewer instantly on verdict | `WorkerStacks` strip, one stack per origin; one minimap dot each |
| Quiet-branch mini stacks | `layout.ts` (`MiniStack`) | child conversation not column-worthy (`projectModel.columnWorthy`) | on-canvas mini-card column under the parent, dashed edge |
| Direct-review history | `directReviewGroups.ts` | every round of a one-shot review group terminal | group leaves the deck grammar entirely; reviewers fold to worker stacks |

And **three unrelated card families**: agent panes (`nodes.tsx`, 600 px world
windows), reviewer decks (round spines beside implementers), and task stickies
(`TaskCard.tsx`, 260 px, internal scrollbar past 340 px body).

What the open issues actually complain about is the *seams* between these
grammars: engine-spawned children ignore all of them and land as root cards
(#142/#339); a rate-limited agent looks identical to a working one (#97);
finished reviewers escape the fold when manually placed (#289); tasks pile up
with no readiness read (#290); and cards are not first-class keyboard citizens
(#292).

The design principle for everything below: **do not add a fifth grammar —
converge on one presence ladder** (§1.2) that all card families obey, and one
state language (§2) that all surfaces render.

---

## 1. Unified information architecture

### 1.1 Vocabulary

- **Card** — the atomic board citizen: one *identity* with durable state and a
  world-space rect. Three families: **agent card** (a conversation pane),
  **task card** (a `BoardTask` sticky), **deck** (a review group's round
  spine — a card whose body is a stack of rounds). Drafts and pipeline slots
  are proto-cards (a card that will exist).
- **Stack** — a compact roll-up of ≥1 quiet cards sharing an *origin*
  (flow, pipeline, spawner, parent conversation) or a *lane* (task status).
  A stack is itself a nav target and a camera target; it shows a count and a
  rolled-up state dot (§2.2). Expanding a member restores the exact card.
- **Tray** — new (§1.4): the stack of a parent agent card's quiet or
  hand-folded engine-spawned children, docked *inside* the parent's
  footprint rather than beside it.
- **Lane** — new (§1.3): a labeled world-space column in the task lanes band;
  the Kanban read of #290.
- **Presence** — where on the ladder (§1.2) an identity currently renders.
  Presence is *presentation*, derived per render; it never mutates data.
  The only durable presence inputs are: the user's expand pins
  (`llvTaskExpand`, worker-collapse pins) and the #289 hidden mutation.

### 1.2 The presence ladder — what collapses/hides when

Every identity renders at exactly one level. One rule set, replacing the four
ad-hoc triggers, evaluated top-down (first match wins):

```
P4 full-window   the single expanded overlay (agents only; unchanged)
P3 expanded card full durable content, geometry-participating
P2 compact card  the default board citizen (clamped preview)
P1 stack row     a line inside a stack/tray/deck spine
P0 hidden        durable close (#289 mutation, manual close, tombstone)
```

| Identity is… | Level | Rationale / today's equivalent |
|---|---|---|
| expanded by the user (durable pin) | P3 | `expandedIds` pin, worker-collapse pin |
| needing attention: failed delivery, failed spawn, `pendingQuestion`, `waitingInput`, overdue open task, **rate-limited (#97)** | P2, surfaced out of any stack | `needsAttention` — extended with rate-limited |
| live / mid-turn / spawning, and **operator-spawned or owner-touched** | P2 | `assignmentActive`, `isCollapseExempt` |
| live / mid-turn **engine-spawned child** (#142/#339) | P2 under the parent — unless hand-folded (durable fold pin → P1 in the tray) | owner decision: live work stays visible |
| quiet engine-spawned child | P1 in the parent's tray, **immediately on turn end** (no 15-min wait) | new — keeps fan-outs from lingering |
| recently touched (<15 min) | P2 | `TASK_STACK_RECENT_MS`, idle window |
| quiet task | P1 in its **lane stack** (§1.3) | today: bottom strip stack |
| quiet worker conversation | P1 in its **origin stack** | `workerCollapse` unchanged |
| quiet child conversation | P1 in the parent's mini stack / tray | `MiniStack` unchanged |
| one-shot reviewer with terminal verdict (#289) | P1 in its deck spine or review-history stack; board node durably closed | `splitDirectReviewGroups` + new server mutation |
| closed / tombstoned | P0 | `hiddenPaths` |

Two invariants the ladder makes explicit (both already implicit in code, both
must survive every slice):

1. **Nothing is ever lost.** P1/P0 keep transcript, lineage, receipts, task
   text, assignments and history; expanding restores the exact card. (#289
   contract, `taskStacks` contract.)
2. **A card renders in exactly one place.** The `renderedPaths` /
   `claimedReviewerPaths` exclusion discipline generalizes: tray membership,
   lane membership, deck membership and node placement are mutually exclusive
   per identity per render.

### 1.3 Readiness lanes (Kanban) — #290

#### The model

A **task lanes band**: a framed world-space region containing five labeled
columns. Ukrainian headings (per #290), EN mirrors for the `en` locale:

| Lane | Heading (uk) | Membership |
|---|---|---|
| Planned | «Заплановано» | `status: inbox` |
| Now | «Тепер» | `status: assigned` |
| Ready for review | «На перевірці» | `status: review` (new status value) |
| Blocked | «Заблоковано» | `status: blocked` |
| Done | «Готово» | `status: done` |

**Decision: lanes are statuses, and `review` becomes a fifth persisted
status** inserted into `TASK_STATUS_CYCLE` between `assigned` and `done`
(tone: `info` violet — the review color the flow decks already use).

Options considered:

- **(A) Derived lanes** (status + live assignment signals decide the column).
  Keeps the data model frozen, but lane membership then *flaps with poll
  noise* — a card teleports from «Тепер» to «На перевірці» because its agent
  went idle for a poll tick. Kanban columns are workflow stages the owner
  moves work through; deriving them from activity destroys exactly the
  spatial stability #183 needs. Rejected.
- **(B) Fifth persisted status** (chosen). One enum value: server route
  validation, `TASK_TONES`, `TASK_STATUS_CYCLE`, EN/UK copy. Forward- and
  backward-mappable (`review` → `assigned` if ever removed), so no ADR-grade
  irreversibility. Activity signals (working, stalled, rate-limited) render
  as **badges on the card inside its lane** (§2), never as lane placement.

#### Placement & geometry

- The band docks as a **top band** — its own row above the favorites band
  (band order: lanes → favorites → rest), using the exact banding mechanism
  `layout.ts` already runs for favorites (`bandTop` + `FAV_BAND_GAP`).
  Owner decision (2026-07-17): top, not left. Lane growth therefore shifts
  the agent field down; that reflow is acceptable because (a) band height
  changes only when a card is promoted/expanded or a column overflows —
  not per poll tick, and (b) the existing reflow machinery already absorbs
  it: nodes glide via `MOVE_TRANSITION` and the spatial-nav camera follow
  (`glideBy`) keeps the anchored card steady on screen. Spatial memory:
  tasks always live "up top", agents below.
- Columns are fixed-width (`TASK_W + gutter`), cards flow top-down per lane
  ordered by `updatedAt` (freshest first); lane height grows as needed. Lane
  headers carry the heading + count + rolled-up state dots, and are nav/camera
  targets (`lane::<status>` keys in `byPath`).
- **Within its lane, a card is at P1 by default** — a one-line row (title +
  state dot + assignment count), denser than today's stack chips. The ladder
  (§1.2) promotes it in place to P2/P3 (attention, activity, recency, pin):
  the card grows inside the column and pushes neighbors down. No collision
  pass needed inside lanes — columns are lists, not free space.
- **Hand placement survives**: a card dragged out of its lane onto the canvas
  becomes `placement: "pinned"` with a free `pos` (today's model, collision
  pass and all) and shows a small lane-color tab as its column echo. Dragging
  a card into a lane (or the card's «fold» action) clears the manual pos and
  re-docks it. #290's "preserve every card, ID, text, association" is thus
  structural: lanes change only `status`/`placement`, never content.
- Task↔agent edges (`TaskEdgesLayer`) keep working from lane positions — the
  connector is the bridge between the task zone and the agent field, and the
  #292 connector navigation (§3.5) makes it a two-way teleport.
- The bottom `TaskStacksStrip` becomes a **projection of the lanes** (same
  partition, same counts — a shortcut list that glides the camera to the lane
  or card), not an independent collapse destination. On mobile it is the
  primary lane surface (§1.5).

#### Legend

A compact status legend (per #290) renders in the band header: five dots +
headings + the three activity badges (§2.2). One line, collapsible.

### 1.4 Child/subagent nesting — one policy for #142 and #339

**Policy: provenance decides presence.**

- **Operator-spawned** conversations (viewer `/api/spawn`, handoffs, drafts) —
  deliberate acts of the owner — keep today's behavior: full P2 node under
  the parent, staircase layout, full lifecycle.
- **Engine-spawned** children — Codex `spawn_agent` rollouts
  (`thread_source: "subagent"`, #142) and Claude in-harness subagents
  (`<parent-sid>/subagents/**/agent-*.jsonl`, sidechain shape, #339) —
  render as **full P2 nodes under the parent while working** (owner
  decision 2026-07-17: live work stays visible), and fold into a **tray
  docked on the parent card immediately when their turn ends** — no 15-min
  idle wait, unlike other workers. The operator can also **hand-fold a
  live child** into the tray (a durable per-child fold pin — the inverse of
  the expand pin) when a fan-out gets noisy; the tray's roll-up dots keep
  its state visible.

The **tray** (new element on the agent card, both desktop pane and map-lite
card):

- A slim docked row at the parent card's lower edge: `⑂ N` + up to N activity
  dots (§2.2), e.g. `⑂ 3 ● ● ○`. Zero children → no tray.
- Click/Enter expands the tray **in place** into the existing quiet-branch
  mini-stack grammar (`MiniStack` rows under the parent, dashed edge) — no new
  list component; the tray is a docked entry point to a grammar that already
  exists. Expansion is a durable pin (worker-collapse pin set).
- A tray member row opens the child transcript read-only (P4 overlay), like
  any mini-stack row today. Direct control of in-process children is #15's
  scope and stays out of this design (relay semantics unchanged).
- **Ladder overrides still apply**: a child with `pendingQuestion` /
  `waitingInput` / failure surfaces to P2 beside the parent (attention beats
  the tray); an owner-touched child (`userAuthored`) is exempt from tray
  demotion (same `isCollapseExempt` rules). The tray badge inherits the
  hottest child state (§2.2 roll-up) so nothing urgent hides.

Prerequisites this policy consumes (server-side, specified in #142/#339, not
re-designed here): durable `engine-native` lineage edges for Codex children;
path-derived lineage + sidechain parsing + `journal.jsonl`/`*.meta.json`
exclusion for Claude subagents; receipt grouping by pane+launchId so children
never corrupt the parent's launch receipt. The board policy is downstream:
once `file.parent` + a `lineage: engine-native` marker are truthful, tray
membership is `isChildConversation(file) && file.spawnOrigin === "engine"`
(exact field name up to the runtime slice; the board only needs the boolean).

### 1.5 Mobile

- `MobileFocusView` map-lite: lanes render as one framed zone with heading +
  count per column (no card DOM); tapping a lane opens the task sheet
  filtered to it. `mapGate.mapReachable` counts the lane band as a reason to
  show the map.
- The task sheet reorganizes by lane (five sections in cycle order) — it is
  the same partition as the band, so counts always agree.
- Trays render on mobile focus cards as the same `⑂ N` chip; tap → the
  existing child list.

---

## 2. Card state language

### 2.1 The state model

One enum, derived (never stored), for **every** card family and every
roll-up. Precedence top-down; first match wins:

| State | Signal (existing fields) | Meaning |
|---|---|---|
| **rate-limited** | `file.rateLimit` present (`resetAt` current/future) | engine cannot take a turn (#97) |
| **dead** | spawn `failed`; `proc: killed`; gone from scan; assignment `failed` | needs replacement or dismissal |
| **waiting** | `pendingQuestion` / `waitingInput` / flow `waiting_ready` | blocked on the operator |
| **working** | `activity: live` / `proc: running` / spawn `starting·binding·queued` | turn in progress |
| **stalled** | `activity: stalled` | mid-turn but no writes — soft warning |
| **verdict-reached** | reviewer with terminal `review.verdict`; task `done` | terminal success; parks (#289) |
| **idle** | none of the above | quiet |

`rate-limited` outranks `working` **by design**: the #97 incident was exactly
a rate-limited engine reading green. The scanner already populates
`file.rateLimit` (pane-screen probe, `waitingInput.ts`); the change is in the
*projection* — every surface that renders "працює" must consult rate-limit
first. Flows attached to a rate-limited conversation render
`blocked: rate-limited` instead of a silent `waiting_ready` (flow strip +
deck chip copy change).

### 2.2 Visuals at three densities

The same state must read at every zoom/presence level — this is also the #183
level-of-detail contract (§6):

| State | **Dot** (minimap, tray, stack roll-up) | **Badge** (P1 row, P2 card header) | **Card** (P2/P3 field) |
|---|---|---|---|
| working | filled accent, gentle pulse | `● працює · 4:32` (live timer, §2.3) | status strip in tone, live meta row |
| stalled | accent, hollow | `◐ призупинилось · 9:12` | as working, amber meta |
| waiting | warning, blink 2 s cycle | `✋ очікує відповіді · 12:07` | attention ring (existing queue treatment) |
| rate-limited | danger, hollow, no pulse | `⏳ ліміт до 19:55` (countdown to `resetAt`; windowless: `⏳ ліміт вичерпано`) | danger-soft header band + **reseat CTA** (§2.4) |
| dead | muted gray, static | `✕ впав` / exact spawn error | desaturated (today's `done` treatment) + retry where `retrySafe` |
| verdict-reached | success, static | verdict chip `✓ APPROVE` / `✎ CHANGES` | parks per #289 |
| idle | muted, static | age `N хв тому` | default |

Roll-up rule for stacks/trays/decks/lanes: **the container shows the hottest
member state** in the precedence order above (rate-limited beats working,
etc.), plus the count. A lane header shows up to three dots (hottest three
member states); the minimap keeps one dot per stack (`stackDotsFor`) but the
dot takes the roll-up color instead of the origin-kind color when any member
is rate-limited / dead / waiting.

Badges reuse the existing `Badge` component and `RateLimitBadge` (already
mounted at `nodes.tsx:583/639`, `BranchPane.tsx:343`); the work is extending
the same badge to stack rows, tray chips, task assignment chips, and lane
headers — not inventing a new one.

### 2.3 Elapsed time (#268 as the reference contract)

The timer semantics come from #268 (prompt-receipt timestamp → last agent
event, ticking while working, frozen on turn end). This design adopts the same
clock for **card meta rows**: the working badge shows `працює · M:SS` live;
waiting shows time since the agent's question (`очікує · M:SS` — how long the
operator has been the blocker); rate-limited shows the countdown, not an
elapsed. One shared hook (same source of truth as the pane-bottom indicator
#268 builds) so the pane, the card badge, and the stack roll-up can never
disagree. Frozen final durations render on verdict-reached deck rounds
(`перевірено за 14:03`).

### 2.4 Rate-limited card & successor reseat (#97)

The rate-limited P2 agent card gains one affordance block (desktop pane header
popover; mobile sheet row):

```
⏳ Ліміт акаунта <badge accountId> · відновиться о 19:55
[ Продовжити на іншому акаунті ▾ ]   [ Тихо припаркувати ]
```

- **«Продовжити…»** lists healthy accounts (the accounts panel's data). Pick →
  the product does what the operator did by hand on 2026-07-10: spawn a
  successor in the same cwd with a handoff prompt (`/api/spawn` +
  `accountId`), rebind attached flows' `implementerPath`, and park the old
  conversation quietly — **not** as a fresh manual card (the #86 class).
  Guard: check registry lineage first; if account-migration (#40) already
  forked this thread, the control renders disabled with «міграція вже
  триває» instead of double-reseating.
- The old card's tray/deck/edges transfer with the rebind (successor takes the
  node position — same in-place succession the board already does for
  `predecessorPath`).
- Flows in `waiting_ready` against a rate-limited implementer render
  `blocked: rate-limited` on their strip chip, in the same danger-soft tone —
  the loop stops looking healthy.
- False-positive fence: only a **current** pane banner / structured signal
  sets the state (issue #56's inverse bug — historical banner text — stays
  excluded; the scanner probe already distinguishes these).

---

## 3. Navigation

### 3.1 Nav targets — extending the existing tiers

`useSpatialNav` already walks every `layout.byPath` key (nodes, decks, quiet
stacks, drafts, slots) by pure geometry, with camera-follow and the ±zoom
ladder. The design **adds keys, not a new system**:

- `task::<id>` for every placed card (free-pinned and lane-docked),
- `lane::<status>` for lane headers,
- `tray::<parentPath>` for subagent trays,
- worker stacks already have `wstack::*` keys once they gain world rects
  (today they live only in the strip; the lane band gives the task side world
  presence — worker stacks stay strip-only for now, out of scope here).

Arrow keys therefore move across agents → decks → trays → task lanes in one
continuous field, no modes and no wrap. `collectNavTargets` gains the new
keys; `navTargetLabel` announces task titles / lane headings — **never
filesystem paths** (existing rule, and the PR #294 SR requirement).

Task-nav lifecycle (the PR #294 root-review gap, designed in from the start):
the reflow-follow effect must depend on task geometry too — a task move,
lane re-dock, collision relocation, or removal re-baselines the follow and
drops a selection whose target left the board, without waiting for an
unrelated keypress.

### 3.2 The expansion ladder as interaction

| Level | Task card | Agent card | Gesture |
|---|---|---|---|
| P1 | lane row / stack chip | tray row, mini-stack row, deck spine | `Enter` → P2; click |
| P2 | compact card: title `line-clamp-2` + preview `line-clamp-3`, status strip, chips, action row, **no internal scrollbar** | pane (600 px window) | `Enter` → P3 |
| P3 | full durable text, no clipping; participates in collision/edges/camera bounds | — (panes don't grow) | `Enter` → P4 (agents) |
| P4 | — | full-window overlay | `Esc` walks back down one level per press |

P2→P3 card expansion rules (carrying every PR #294 review finding as a design
constraint, since they were found the hard way):

1. The grown box routes through the **same slot search as everything else**
   (`findSlot`) against *all* obstacles — panes, decks, stacks, placed and
   expanded cards — never a partial obstacle list. Collapse restores the
   exact prior arrangement (display-only displacement of neighbors).
2. The action row (send/status/fold/delete) is **inside the card's collision
   box** (`taskRect` includes it), not floating below it.
3. Height estimation stays a provable upper bound in both presentations
   (the existing `taskCardHeight` wrap simulation; clamps bound P2).
4. Every interactive element ≥ 28×28 px hit area (icons stay 12 px);
   coarse-pointer targets ≥ 44 px.
5. Disclosure is a real `<button>` with `aria-expanded`, localized
  («Розгорнути задачу» / «Згорнути задачу»).
6. In lanes, P3 growth displaces only down-column (no collision pass); on the
   free canvas it uses (1).

### 3.3 Key map (additions in bold)

| Key | Action |
|---|---|
| Arrows | move selection ring by geometry across all tiers |
| `+` / `−` | zoom ladder on the anchor (existing) |
| **Enter / Space** | **expand one level (P1→P2→P3→P4); on an agent chip / assignment chip — open the linked agent** |
| **Esc** | **collapse one level; then clear ring (existing)** |
| F2 | rename (existing, agents) |
| **E** | **toggle task edit (replaces "click card body to edit" as the only path — the stationary-press edit stays)** |
| **G** | **jump along the card's first connector to the remote endpoint (§3.5); repeat toggles back** |

### 3.4 Focus rules — #272 is the anti-pattern

Non-negotiables, stated once here and inherited by every slice:

1. **Selection ring ≠ DOM focus.** Spatial nav never calls `.focus()`; it
   moves the ring and the camera. The board viewport (`tabIndex=0`) holds DOM
   focus only when the user clicked/tabbed into it.
2. **Typing wins.** All nav/expansion keys pass through the existing guards
   (`isTypingTarget`, `GUARD_SELECTOR`, `scrollConsumes`) — a focused
   composer, editor, or dialog consumes its own keys, always.
3. **No focus from data paths.** Poll refetches, relayouts, lane re-docks,
   succession swaps, tray promotions: none may call `.focus()` or remount a
   focused ancestor. Concretely: keys for cards/panes are identity-based
   (`conversationId` / task id), never path-based (paths rotate on
   migration/adoption — the #272 remount source), and `autoFocus` is
   reserved for explicit user actions (beginEdit's rAF-focus is fine).
4. **Camera motion is not focus.** Center/glide/follow never scrolls a
   clipped ancestor (the viewport's onScroll reset stays) and never grabs
   focus.
5. Regression test (from #272's acceptance, extended to lanes): focused
   composer + store updates that reorder entries, re-dock lanes, and promote
   trays → `document.activeElement` unchanged, draft intact, caret intact.

### 3.5 Linked-agent access & connector navigation

**Assignment chips (P2/P3 task card)** — the truthful-state matrix (PR #294's
P1 finding, kept): a pure classifier derives
`spawning / failed / gone / killed / unhosted / migrating / live` per
assignment from the assignment plus its agent's current generation (resolved
by `conversationId` with path fallback; stable React keys from the
assignment's own identity). Each chip:

- state dot + engine badge + title (truthful copy per state; failed shows the
  exact error, never a spinner),
- **open** control (crosshair, ≥28 px): centers the camera on whatever box
  the assignment edge lands on (pane, tray, stack, deck) and runs the
  canonical opener — a hidden node restores, a visible one rings. Disabled
  (with reason) for gone/failed.
- **detach** control: works pathless through the stable
  `path | conversationId | panePid` handle.

**Connectors** (assignment + source edges; the un-landed PR #294 scope,
adopted here as the design):

- every visible route gets a wide invisible hit path (~16 px stroke) over the
  thin visual one; `pointer-events` scoped to the hit paths only,
- hover/keyboard focus reveals a compact chip naming both endpoints
  («Задача ↔ Агент-титул»),
- primary activation (`click` / `G`) glides to the **remote** endpoint
  relative to the currently visible/focused one; repeated activation
  ping-pongs without losing the connector context,
- when both endpoints are visible or proximity is ambiguous, the chip offers
  the two explicit endpoint actions; coarse-pointer taps always get the
  two-choice chip,
- hidden/parked endpoints restore on jump (same opener as the chip crosshair),
- isolation: hit paths yield to pan/drag/multi-select/failed-edge-retry
  (retry badge keeps priority), and no per-frame React state during camera
  motion (hover chip renders in the SVG layer, positioned in world space).

---

## 4. Auto-hide / auto-park of one-shot reviewers — #289

The presentation layer already does the right thing for *direct* reviewers:
`splitDirectReviewGroups` parks all-terminal groups out of the deck grammar
and folds reviewers into worker stacks, immediately on verdict
(`shouldCollapseWorker`'s reviewer rule). #289's gap is durability and
coverage; the design keeps **fold = pure projection, hide = one durable
mutation**:

1. **Projection (client, exists / extends):** any reviewer at
   `verdict-reached` (§2.1) renders at P1 — deck spine entry when its group
   still has an actionable round, review-history stack otherwise. This
   already covers restart/replay for free (pure function of scan).
2. **Durable close (server, new — the #289 contract):** when a
   Viewer-managed reviewer's terminal verdict is *durably observed*
   (structured transcript, Codex and Claude shapes, incl. aliases
   APPROVE / REQUEST CHANGES / NO FINDINGS), emit **one idempotent board
   mutation** moving its node to hidden and clearing manual placement. This
   is what the projection cannot do: a reviewer the operator once manually
   placed carries a durable pin that outranks folding (§1.2) — the mutation
   is the sanctioned way to release that pin. Revision-fenced, idempotent
   across duplicate terminal events, generation remap and replay.
3. **What never hides:** active, verdict-less, failed-before-verdict, and
   waiting-input reviewers (they're `waiting`/`dead`/`working` in §2.1, not
   `verdict-reached`); anything owner-touched.
4. **Where the evidence lives:** transcript, conversation identity, review
   edge, receipts and issue/PR evidence are untouched (P1 ≠ deletion);
   the deck spine keeps the verdict chip + frozen duration (§2.3); the
   review-history stack row opens the transcript read-only.
5. **Consistency rule:** a reviewer is *never* a free root card after its
   verdict — the same grammar whether it came from a managed flow, a direct
   spawn, or (post-#142/#339) an engine-spawned child that happens to carry
   `role=reviewer`.

---

## 5. Implementation slices

Ordered so each lands independently and later slices consume earlier ones.
"Changes" lists real files at base `6fa8f12d`; "new" marks new modules.

### S1 — Subagent lineage & parsing foundation (#339, runtime half of #142)

Scanner/runtime work the board consumes; specified in the issues, summarized
here for ordering only: path-derived lineage for
`<parent-sid>/subagents/**/agent-*.jsonl`; Claude sidechain entry parsing
(titles, bodies, activity); exclude `journal.jsonl`/`*.meta.json`;
durable `engine-native` lineage edge for Codex children; receipt settling
grouped by pane+launchId; an `engine`-provenance marker on `FileEntry`.

*Accepts:* a Workflow subagent renders titled, non-empty, and parented on the
board; the journal file produces no card; one `/api/spawn` + three
`spawn_agent` children = receipts intact, four conversations, three of them
children of the first; provenance flag present on all four.

### S2 — Subagent tray (#142 board policy, #339 board policy)

- Changes: `projectModel.ts` (`columnWorthy` gains the engine-provenance
  demotion), `layout.ts` (tray rect on `SchemeNode`), `nodes.tsx` (tray chip
  + roll-up dots), `workerCollapse.ts` (tray members excluded from origin
  stacks), `Minimap.tsx` (tray members leave the node rects), mobile card.
- New: `scheme/subagentTray.ts` (pure partition: children → tray / promoted,
  attention overrides, fold/expand pin handling).
- *Accepts:* engine-spawned child renders as a full node under its parent
  while working — never as an unlinked root; the moment its turn ends it
  folds into the tray (no idle wait); a live child can be hand-folded and
  the fold pin survives reloads; child with `pendingQuestion`/failure
  promotes out of the tray; owner-touched child never auto-folds; tray
  roll-up shows hottest child state; operator-spawned children unchanged.

### S3 — Card presence & navigation (#292 core; PR #294 mined, built fresh)

- Changes: `TaskCard.tsx` (P2 clamps, disclosure, P3 full text, truthful
  assignment-chip matrix, ≥28 px targets, action row in geometry),
  `taskGeometry.ts` (`taskRect(task, expanded)`, action-row height),
  `taskPlacement.ts` (expanded pass through `findSlot` vs *all* obstacles),
  `TaskEdgesLayer.tsx` (edges anchor grown boxes), `spatialNav.ts` +
  `useSpatialNav.ts` (`task::` targets, task-aware reflow/removal
  lifecycle), `SchemeBoard.tsx` (Enter/Esc ladder, `E` edit key),
  `TasksLayer.tsx`.
- New: `tasks/assignmentState.ts` (pure state classifier).
- *Accepts:* collapsed cards have no internal scrollbar; expanded cards
  never overlap panes/cards/controls (the 126→568 px / pane-at-y=200 probe
  passes); arrows walk panes ↔ task cards with camera follow; Enter/Esc walk
  the ladder; SR labels use titles, not paths; #272 regression (§3.4.5)
  green; all six assignment states render truthfully; detach works pathless.

### S4 — Readiness lanes (#290)

- Changes: `lib/tasks/types.ts` + server task route validation (`review`
  status), `tasks/taskModel.ts` (cycle + tone + copy EN/UK),
  `taskStacks.ts` (partition becomes lane partition; P1 lane rows),
  `SchemeBoard.tsx`/`TasksLayer.tsx` (lane band render, dock/undock drags),
  `layout.ts` (lanes band as the first band above favorites), `Minimap.tsx`
  (lane zone outline), `TaskStacksStrip.tsx` (becomes lane projection),
  mobile task sheet + `mapGate.ts`.
- New: `scheme/taskLanes.ts` (pure lane layout: columns, ordering, in-lane
  promotion geometry).
- *Accepts:* every task renders in exactly one lane or as an explicit
  free-pinned card with a lane tab; lane headings uk/en + legend; promotion
  to P2/P3 happens in-column without collision passes; strip and band counts
  always agree; drag in/out of the band round-trips
  `placement`/`pos`/`status` correctly; agent field geometry unchanged by
  lane growth; lane headers are nav/camera targets.

### S5 — Reviewer auto-hide (#289)

- Changes: server board-mutation path (revision-fenced idempotent close on
  durable terminal verdict — Codex + Claude shapes + aliases),
  `directReviewGroups.ts` (no change to grammar; consumes the cleared pins),
  review-history stack row copy (verdict chip + frozen duration).
- *Accepts:* the #289 list verbatim — detection across both transcript
  shapes; one idempotent mutation; lineage/receipts/evidence retained;
  active/failed/waiting reviewers stay visible; survives restart, replay,
  generation remap, duplicate events; production-shaped multi-reviewer board
  test; protected UI/locale files byte-identical where required.

### S6 — Rate-limited state & reseat (#97)

- Changes: state-precedence projection (`utils.activityDot` call sites,
  `nodes.tsx` meta row, `taskStacks.assignmentActive` →
  attention-on-rate-limit, stack/tray/lane roll-ups, `Minimap` dot color),
  flow strip / deck chip `blocked: rate-limited` copy, pane header popover
  with reseat + park actions wired to spawn/flow-rebind APIs,
  migration-lineage guard.
- New: `components/reseat/` (popover + account pick; API glue).
- *Accepts:* a rate-limited implementer never reads «працює» anywhere (card,
  stack chip, lane row, minimap); attached flows show blocked-rate-limited;
  countdown renders from `resetAt`; reseat spawns successor in same cwd,
  rebinds flows, parks the old card without creating a manual card; disabled
  with reason when #40 migration already forked; historical banners (#56)
  never trigger it.

### S7 — Connector navigation (#292 remainder)

- Changes: `TaskEdgesLayer.tsx`, `agentLinks.ts`/`AgentLinksLayer` (hit
  paths, hover/focus chip, endpoint jump, `G` key in `SchemeBoard`),
  touch chip.
- *Accepts:* the §3.5 list — wide targets, endpoint naming, remote-endpoint
  glide + ping-pong, two-choice on ambiguity/touch, retry-badge priority,
  no per-frame React churn during camera motion, desktop + mobile
  acceptance on a dense board.

Dependency notes: S2 needs S1. S4 needs S3 (P1/P2/P3 card levels). S5 and S6
are independent of S3/S4 (can land in parallel after S1). S7 last — it
polishes edges that S3/S4 reposition.

---

## 6. Semantic-zoom compatibility (#183)

#183 will want agents → flow zones → project map with continuous morphing.
Checks against this design:

1. **Three-density state language (§2.2) is the LOD spec.** dot → badge →
   full card is exactly the "dot → zone badge → project glow" ladder #183
   asks for; nothing needs re-inventing at the flow-zone level — a zone
   renders roll-up dots the same way a tray chip does today.
2. **Everything lives in world space.** Lanes are a world zone (not screen
   chrome), trays are docked world geometry, stacks/decks have world rects.
   Zoom-out can morph cards into their containing zone summaries because
   every container has a rect and a roll-up state. The one remaining
   screen-space surface (`TaskStacksStrip`) is demoted to a *projection* of
   the world-space lanes (§1.3) — deletable when semantic zoom lands.
3. **The presence ladder ≈ level-of-detail.** P3→P2→P1→dot is a per-card
   zoom ladder already; semantic zoom can drive presence from camera z
   (far zoom renders lane bands and trays as their roll-ups without card
   DOM), which slots into the existing `dormant` far-zoom machinery.
4. **Lanes as a "room".** The task band pinned at the top is a stable
   spatial anchor — at project-map level it becomes the project's task
   shelf; user-placed free cards keep their coordinates, which is the
   spatial-memory contract.
5. **No painted corners:** presence is derived (pure per render), so a
   future zoom-driven presence override composes instead of conflicting;
   card expansion state is presentation state, not data; nav targets are
   `byPath` keys, so zone-level nav is "add zone keys", same as §3.1 did.
6. **One caution to respect in S4:** lane column *heights* must not encode
   information (only order and membership do) — at far zoom columns compress
   to counts, and any meaning attached to height would be lost.

---

## 7. Open questions for the owner

Resolved by the owner (2026-07-17): lane band sits **on top** (§1.3); live
engine children render **fully while working**, with a manual fold into the
tray (§1.4).

1. **`review` as a fifth persisted task status (§1.3)** — confirm. It touches
   the task API contract and both locales. Fallback is derived lanes, at the
   cost of poll-noise lane flapping.
2. **Reseat policy (§2.4)** — one-click manual only, or also a policy-driven
   auto-reseat ("always continue on account X when rate-limited")? Designed
   as manual-first; auto is a small follow-up on the same path.
3. **`E`/`G` key choices (§3.3)** — plain-letter shortcuts on the board are
   new; conflicts with future single-key bindings are cheap to change now.
4. **#289 scope of the durable close** — designed to also cover engine-
   spawned reviewers (S1 provenance) under the same contract; confirm that's
   wanted from day one or flow/direct reviewers first.
