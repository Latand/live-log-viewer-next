# Board tasks («стікери-задачі» on the scheme board) — final architecture

Status: **FINAL — every decision below was grilled with the user on
2026-07-05** (17 questions). The feature started as sticky notes and was
rebased mid-grill into **tasks**: trackable work items that live as sticky
cards on the project scheme, get assigned to one or many agents, and are
listed in a dockable task panel. Research input:
`docs/research/canvas-agent-orchestration-2026-07.md` (see «Research
influence» at the end).

## Concept

- A **Task** is a sticky card on the project board with its own world
  position, a status lifecycle, and a list of **assignments** — transcript
  paths of agents working on it. Many agents per task is the norm.
- Edges are drawn from the task card to every assigned agent node — the
  tldraw binding pattern: the connection follows the node through layout
  reshuffles.
- A pure annotation is simply a task in `inbox` with no assignments; there is
  no separate sticker entity. *(Grilled: single entity. Two entities double
  every surface — API, panel, rendering, menus — for a difference an
  unassigned task already covers.)*
- A **task panel** docks on the right; it is the tracking list the user asked
  for («закидываю задачи и трекаю»).
- Substrate for a future dispatcher agent: tasks persist on disk in a
  readable JSON with a full HTTP API. The dispatcher itself is out of scope.

## Data model

`src/lib/tasks/types.ts` (the seam between server and UI, mirrors
`src/lib/flows/types.ts`):

```ts
export type TaskStatus = "inbox" | "assigned" | "blocked" | "done";

export type AssignmentState = "delivered" | "failed" | "spawning";

export interface TaskAssignment {
  /** Transcript path; null while a codex spawn awaits scanner attribution. */
  path: string | null;
  /** tmux pane pid captured at spawn — the codex rollout attribution handle. */
  panePid: number | null;
  state: AssignmentState;
  /** Last delivery error, shown on the ⚠ edge; null when delivered. */
  error: string | null;
  at: string; // ISO of the last attempt
}

export interface BoardTask {
  id: string;        // crypto.randomUUID(), server-side
  project: string;   // FileEntry.project — the board the card lives on
  status: TaskStatus;
  /** Plain text, ≤ 6000 chars (server-enforced). First line acts as the
      title everywhere a compact label is needed. */
  text: string;
  /** Own world position on the board — the card is dragged freely. */
  pos: { x: number; y: number };
  assignments: TaskAssignment[];
  createdAt: string;
  updatedAt: string; // bumped by every PATCH
}
```

Grilled decisions baked into the model:

- **Single text field, first line = title, cap 6000 chars.** Tasks are
  thrown in fast (often by voice through STT); a mandatory separate title
  field adds friction to every creation. «First line is the title» is the
  same convention transcript titles already use (`_scan_jsonl_title`). The
  user raised the Miro-inspired 3000 cap to 6000.
- **Statuses move manually in v1.** The flows engine proved that
  marker-scanning (`REVIEW_READY:`) costs a poller with retries and
  false-positive handling. One automatic transition is allowed because it is
  a server action, never transcript scanning: a successful send/spawn flips
  `inbox → assigned`. `blocked`/`done` are user clicks on the status chip.
  Delivered text is prefixed `Задача #<short-id>: …` so a future marker
  protocol and dispatcher have an anchor to grip.
- **Own position, no anchor-offset.** The original note design anchored to a
  node with an offset; multi-assignment made a single anchor wrong. The card
  owns its position; the *edges* carry the relationship. This also deleted
  the orphan-tray concept: a task never orphans — dead assignments become
  dimmed chips on the card, and the panel is the permanent tracker.

## Persistence

`~/.claude/viewer-state/tasks.json` → `{ tasks: BoardTask[] }`, one file for
all projects (flows.json precedent; counts are small). `src/lib/tasks/store.ts`
copies the `flows/store.ts` pattern exactly: `atomicWriteJson` (tmp +
rename), runtime validation (`isTask`) on load, corrupt/missing file → `[]`.

Server code stays in `src/lib` as pure functions + fs, no Next imports —
unit-testable with `bun test`.

## Sync and concurrency (grilled)

- **Read: piggyback on `GET /api/files`** — response becomes
  `{ files, flows, tasks }`. One poll (10 s), the existing `lastBody` dedupe,
  the existing out-of-band refresh: mutations dispatch `TASKS_CHANGED_EVENT`
  (clone of `FLOWS_CHANGED_EVENT` in `useFiles.ts`) to force a refetch.
  *Why: flows already laid this exact track; a second endpoint means a second
  timer and a second staleness story for zero benefit. Assignment
  reconciliation (below) also happens naturally where files and tasks meet.*
- **Concurrency: last-write-wins per task.** PATCH applies unconditionally;
  the other tab converges on the next poll. One exception: **DELETE always
  wins** — a late PATCH against a deleted task gets 404 and the client
  silently drops the card. *Why: single-user tool; a "conflict" is the user
  racing himself between phone and desktop over one text field he just
  wrote. Optimistic `updatedAt` checks would add a conflict dialog that
  almost never fires.*

## Reconciliation (server, during `/api/files` assembly)

`src/lib/tasks/reconcile.ts` — pure function over `(files, tasks)` returning
patched tasks + a dirty flag; the route persists when dirty:

1. **Compaction follow (grilled):** when an assignment's path has a
   compaction/handoff successor in the lineage chain, rewrite the assignment
   to the successor **once, persistently**. *Why: the task is about the
   conversation; compaction is a technical continuation of it. Rewriting
   server-side keeps «send» aimed at the live session with zero extra logic
   in delivery, and keeps lineage-walking out of the client render path.*
2. **Codex spawn attribution:** an assignment with `path: null` and a
   `panePid` gets its path filled when the scanner attributes the rollout —
   the same pane-pid `/proc`-ancestry mechanism `rememberHandoffPane` /
   `persistHandoffLineage` already use.

## API routes

All mutations behind `rejectCrossOrigin` (same as flows/spawn/tmux).

| Route | What it does |
|---|---|
| `GET /api/files` | extended to `{files, flows, tasks}`; runs reconcile |
| `POST /api/tasks` | create `{project, text, pos}`; enforces 6000-char and ≤300-tasks-per-project caps (409 with a readable error) |
| `PATCH /api/tasks/:id` | partial `{text?, status?, pos?}`; LWW |
| `DELETE /api/tasks/:id` | delete; wins over concurrent PATCHes |
| `POST /api/tasks/:id/send` | body `{paths: string[]}` — delivers `Задача #id: <text>` to each target through `deliverConversationMessage` (live pane → resume → root relay), records/updates one assignment per target, flips `inbox→assigned`. Returns a per-target breakdown. Retry of a failed target = the same call with one path. |
| `POST /api/tasks/:id/spawn` | body `{engine, cwd}` — `freshSpecFor` + `spawnAgentWithPrompt` with the task text as the prompt; claude records `path` immediately, codex records `panePid` (state `spawning`) for reconcile to resolve |

Pure broadcast (composer toggle off, see below) needs **no new endpoint**:
the client loops the existing `/api/tmux` message route per selected target
and summarizes client-side. Nothing is persisted, by design.

### Partial delivery (grilled)

Each target is independent — any rung of the delivery ladder can 409. The
send endpoint therefore delivers to all targets sequentially and reports a
breakdown; successful targets become `delivered` assignments, failed ones are
recorded with `state: "failed"` + the error. *Why: all-or-nothing lies about
reality (the delivered messages already landed and cannot be unsent), and a
server-side auto-retry queue is hidden background state that would fire a
task into an agent an hour later in a different context — flows made round
retries manual for the same reason.* UI: toast «Доставлено 2 з 3;
✗ „<title>“: немає пейна»; the failed edge renders dashed coral with ⚠ and a
click retries that one target.

## Rendering — how tasks hook into the scheme

Hard constraint honored: **camera state never re-renders panes.** Tasks
follow the exact pattern Edges/Nodes already use.

- `src/components/scheme/TaskEdgesLayer.tsx` and
  `src/components/scheme/TasksLayer.tsx` — both `memo()`, rendered inside the
  transformed world div in `SchemeBoard.tsx` (edges before cards, cards after
  `NodesLayer`). They ride `translate/scale` for free; handlers pass through
  the existing ref-swap pattern (`selectRef` et al) so identities stay
  stable.
- **Edge geometry is derived at render time** from `layout.byPath` +
  `task.pos`; nothing task-related enters `buildSchemeLayout`. Position
  changes animate with the existing `MOVE_TRANSITION` / style-level SVG
  geometry transitions — the same glide as nodes, no new animation code.
- `layout.byPath` **grows entries for stacks and decks** (they are already
  `SchemeRect`s). Edge target resolution ladder (grilled):
  1. assignment path has a full node rect → edge to it;
  2. path is displayed only as a mini-card in a quiet stack or an under-deck
     item → edge to that stack/deck rect. *Why: the branch is still visible
     on the board; a blocker pointing at it must stay in sight exactly where
     the branch is drawn. Otherwise every natural «quieting» of a branch
     would sever its edges.*
  3. path absent from `files` entirely → no edge; the assignment renders as
     a dimmed dead chip on the card (with last-known title), removable or
     re-sendable.
  The ladder lives in a **pure module** `src/components/scheme/taskGeometry.ts`
  (`bun test`-able, no JSX).
- **Z-order (grilled):** task edges and cards above panes (annotation over
  the work), below open overlays — cards sit in the z 2–20 band, under-deck
  panel keeps z-30, toolbar z-40; a dragged or edited card lifts to z-30.
- **Far zoom:** cards keep their tinted color block (readable as status at
  any zoom); no constant-size label in v1.
- **Minimap (grilled):** tasks are 3 px dots colored by status; rectangles
  stay reserved for conversations; task edges are never drawn on the minimap.

### Task card

Fixed width 260 world-px; height grows with content up to ~340 px, then the
body scrolls internally (the select-mode wheel handler already respects
scrollable elements). Tinted background + a status strip on the top edge
(the engine-strip pattern from `BranchPane`). `done` cards dim (reduced
opacity) so the board does not shimmer with finished work.

Status palette (grilled — all from existing tokens / flows tones):

| status | color | precedent |
|---|---|---|
| `inbox` | amber `#e0ae45` | flows attention tone |
| `assigned` | accent `#5a51e0` | research: violet = prompt note |
| `blocked` | coral `#d97757` | Claude coral / research red |
| `done` | green `#1a8a3e` | flows approved tone |

Card anatomy: status strip → text (first line bold) → assignment chips
(engine badge + short title; dead = dimmed, failed = ⚠) → action row on
hover/selection: **надіслати** (to selection or picker), **⚡ агент**
(spawn), status chip cycle, delete.

## Interaction design (grilled)

- **Create:** a third tool in the toolbar — «задача» (`N` key) beside
  hand/select (H/V). The next click drops a card at that world point with an
  already-focused textarea, then the tool returns to select (one-shot).
  *Why toolbar-only: the toolbar is the established home for modes; node
  headers are already dense (flow button, handoff handle, under-deck).*
- **Edit inline on the card:** click the text in select mode → textarea in
  place, blur/Esc saves (autosave debounce). If the camera is too far out to
  read, the edit click first glides to the card via the existing `centerOn`.
  The right panel never hosts an editor. *Why: typing where you think is the
  value of a board; a panel editor severs the spatial link, a modal hides
  the context entirely (Excalidraw's low-friction typing precedent).*
- **Move:** drag the card in select mode; pointer deltas ÷ `cam.z` become
  world deltas; local state during the drag, one `PATCH {pos}` on drop.
  Camera pan must not start on a card press: cards carry `data-scheme-task`
  and the camera's `onPointerDown` treats them like `button/a/input`.
  In hand mode cards are click-through like panes.
- **Multi-select without lasso (user-defined):** in select mode a click
  selects one node; **Shift/Ctrl+click toggles** nodes in and out of the
  selection; Esc clears. `SchemeBoard`'s `selected: string | null` becomes a
  `Set<string>`; `useSchemeCamera.setSelected` gains the toggle path.
  Selected nodes get the existing accent ring.
- **Selection composer:** while ≥1 conversation node is selected, a docked
  composer bar appears — **the full conversation composer**, reusing
  `useComposer` + `ComposerBar`: STT voice recording, image paste/copy,
  everything the pane composer has. Send delivers to every selected node.
  A toggle **«створити задачу»**, on by default: on → the text becomes a
  task (`assigned`, assignments = selection, card placed near the selection
  centroid, panel row appears, edges drawn); off → pure broadcast with no
  persisted trace. *Why the toggle: tracking is the point of the pivot, so
  it is the default; but a quick «стоп, перевір ще раз» to three agents must
  not pollute the task list forever.*
- **Assign targets from a card:** «надіслати» uses the current selection
  when one exists; otherwise it opens a picker listing the project's
  conversations with checkboxes plus **«⤷ всім дітям»** of a chosen parent
  (the tree is already in `parent` links; the server loops delivery). Lasso
  is explicitly rejected by the user.
- **Spawn from a card (grilled):** «⚡ агент» opens a mini-popover
  engine+cwd, prefilled from the `/api/spawn` GET suggest (first assignee's
  cwd ranked top), then spawns directly with the task text as the brief.
  *Why direct spawn over a DraftAgentPane: the brief is already written — it
  is the task; a draft adds a step and a second copy of the same text. The
  codex attribution machinery is reused as-is.* The new assignment shows a
  «запускається…» chip until the scanner sees the transcript.

## Task panel

Docked right on desktop (beside the Switchboard region). Header toggle
**«цей проєкт / всі»**, defaulting to the current project (grilled: working
in a project you want its backlog without neighbors' noise; the global mode
serves the «накидав звідусіль і трекаю» flow — one filter over the existing
`project` field). Rows: status chip + first-line title + assignment count +
age. Click → glide the board camera to the card (`centerOn` over a rect from
`task.pos` + card size); a row from another project in «всі» mode first
switches the dashboard to that project, then glides.

## Mobile (grilled)

Full task workflow through a **sheet** in the mobile UI (`MobileFocusView`
world): create (with STT and images), edit, status changes, delete;
assignment via a checkbox list of the project's agents + «всім дітям» — the
same multi-target send without spatial gestures. The full-screen map (lite
mode) renders task cards as static tinted mini-cards; a tap opens the task
in the sheet. Spatial interactions (N tool, drag, Shift-click) stay
desktop-only. *Why: «закинути задачу голосом із телефона» is half the value
of the feature (and the reason persistence is server-side), while lite-map
multi-select would add modal state to a surface whose whole job is fast
picking with no live panes.*

## Limits (grilled)

- text ≤ **6000** chars (server-enforced, 400 on violation);
- ≤ **300 tasks per project** (POST past the cap → 409 with a readable
  Ukrainian error);
- card 260 world-px wide, body height cap ~340 px with internal scroll.

## Edge cases

- Assignment target gone from `files` (deleted, aged past FILE_CAP=400) →
  dead chip on the card; task and its other edges unaffected.
- Send fails on some targets → partial-delivery flow above; nothing retries
  automatically.
- Two tabs → per-task LWW; DELETE beats late PATCH (404 → silent card drop).
- `tasks.json` corrupt/missing → `loadTasks()` returns `[]`.
- Spawn attribution never resolves (pane died before the rollout appeared) →
  assignment stays `spawning`; reconcile marks it `failed` with «агент не
  запустився» once the panePid is no longer alive.
- A task created from the selection composer with the toggle on, while some
  deliveries fail → the task is still created; failed targets follow the
  failed-assignment flow.

## Research influence

Read after the grill started (`docs/research/canvas-agent-orchestration-2026-07.md`);
what it changed or confirmed:

- **tldraw bindings** (notes follow their target, can detach) → confirmed
  the edge model: edges re-derive from `layout.byPath` every layout, so they
  follow nodes through reshuffles for free.
- **Miro bounded body** (~3000 chars, constrained palette) → the char cap
  (user chose 6000) and the fixed four-color status palette.
- **Make Real + Agent Teams broadcast** (note → prompt to one / all children
  / selection) → directly shaped Q8–Q9: multi-select send with the full
  composer, «всім дітям», and the create-task toggle. The user replaced the
  suggested lasso with click multi-select.
- Ranked idea #1 (attention overlay) and #4 (bulk lasso menu) noted as
  natural follow-ups; both out of scope here.

## Implementation plan (for a Codex implementer in a separate git worktree)

Work in a worktree off `refactor/architecture-deepening`. Server logic stays
in `src/lib/tasks/*` as pure functions + fs (no Next imports). All UI strings
go through `useLocale`/`t()` in both `uk` and `en` catalogs
(`src/lib/i18n`). Follow the rendering-quality rules in ARCHITECTURE.md —
memoized layers, ref-stable handlers, style-level SVG geometry transitions.

Ordered steps:

1. **Types + store.** `src/lib/tasks/types.ts`, `src/lib/tasks/store.ts`
   (copy `flows/store.ts` patterns: atomic write, `isTask` validation).
   Extend `FilesResponse` in `src/lib/types.ts`.
   *Tests:* store round-trip, corrupt file → `[]`, validation rejects
   malformed tasks, first-line title helper.
2. **CRUD routes.** `src/app/api/tasks/route.ts` (POST),
   `src/app/api/tasks/[id]/route.ts` (PATCH/DELETE) with
   `rejectCrossOrigin`, LWW, DELETE-wins (404), caps (6000 chars, 300/project).
   Piggyback tasks into `src/app/api/files/route.ts`.
   *Tests:* command-layer units for caps and LWW/delete semantics (pure
   functions over a store injected as data).
3. **Reconcile.** `src/lib/tasks/reconcile.ts` — pure
   `(files, tasks) → {tasks, dirty}`: compaction-successor rewrite,
   panePid→path attribution hook, dead-spawn failure. Wire into the files
   route.
   *Tests:* successor rewrite (chain of 2+), attribution fill, no-op purity
   (same input → not dirty), dead-pane failure.
4. **Client data plumbing.** `useFiles` → `{files, flows, tasks}`;
   `TASKS_CHANGED_EVENT` + a small `mutateTask` helper module
   (`src/components/tasks/taskApi.ts`) that fires it after each mutation.
5. **Board geometry + layers.** `src/components/scheme/taskGeometry.ts`
   (pure: edge endpoint ladder over an extended `byPath`; card rect from
   `pos`). Extend `buildSchemeLayout`'s `byPath` with stacks/decks (two
   spread lines). `TaskEdgesLayer.tsx` (memo, dashed status-colored beziers,
   ⚠ marker + widened invisible hit path for retry clicks),
   `TasksLayer.tsx` + `TaskCard.tsx` (memo, tinted card, status strip,
   inline textarea, chips, action row). Wire both into `SchemeBoard` with
   ref-stable handlers.
   *Tests:* taskGeometry ladder (node → stack/deck → none), byPath
   extension.
6. **Tools + interactions.** Third toolbar tool «задача» (`N`, one-shot
   place-then-select); card drag (÷ `cam.z`, PATCH on drop);
   `data-scheme-task` exemptions in `useSchemeCamera.onPointerDown`;
   multi-select `Set<string>` with Shift/Ctrl toggle + Esc clear + accent
   rings.
7. **Selection composer.** `src/components/tasks/SelectionComposer.tsx` on
   `useComposer`/`ComposerBar` (STT + images intact), «створити задачу»
   toggle (default on), client `/api/tmux` loop for the toggle-off
   broadcast, toast summaries.
8. **Send/spawn routes + card actions.** `/api/tasks/[id]/send` (per-target
   breakdown over `deliverConversationMessage`), `/api/tasks/[id]/spawn`
   (`freshSpecFor` + `spawnAgentWithPrompt`, panePid capture). Card picker
   (checkbox list + «всім дітям»), spawn popover prefilled from spawn GET
   suggest, failed-edge retry.
   *Tests:* breakdown assembly and assignment merging as pure functions.
9. **Task panel.** `src/components/tasks/TaskPanel.tsx`: right dock,
   «цей проєкт / всі» toggle, rows, camera glide on click, cross-project
   navigation.
10. **Mobile.** Task sheet (create/edit/status/assign via checkbox picker,
    STT), lite task mini-cards on the map, tap → sheet.
11. **Polish.** Minimap status dots; `done` dimming; i18n uk+en pass;
    `bun test` green; `bun run build` green; manual pass per
    ARCHITECTURE.md verification (curl `/api/files` shows tasks; POST/PATCH
    /DELETE behave; camera pan does not re-render cards — check with React
    profiler).

Test plan summary (`bun test`, pure logic only): store validation +
round-trip; caps/LWW/delete-wins; reconcile (successor, attribution,
purity, dead spawn); taskGeometry ladder; send-breakdown/assignment merge;
first-line title helper.

## Out of scope (explicit)

- Automatic status transitions via transcript markers (`TASK_DONE:`) — the
  `Задача #id` prefix is the reserved hook.
- The dispatcher agent that auto-triages the inbox and fans tasks out.
- Lasso selection and any bulk node menu beyond send.
- Markdown rendering in the task body (plain text only).
- Server-side auto-retry queues for failed deliveries.
- Cross-project tasks (a task belongs to exactly one project).
- Attachments/images inside the task body (images travel only in composer
  messages).
- Task edges on the minimap; far-zoom constant-size task labels.
- Optimistic concurrency (`updatedAt` conflict rejection).
- Attention overlay and cost strips (research ideas #1/#7 — separate
  features).
