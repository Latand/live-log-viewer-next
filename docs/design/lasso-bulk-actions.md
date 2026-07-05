# Lasso multi-select + bulk actions on the scheme board

Status: **final** — every decision below was stress-tested with the user in a
one-question-at-a-time grill (2026-07-05). Decision markers: ✅ user-confirmed,
with the rationale that won.

## Intent

In select mode the user drags a rectangle around several agent cards → gets an
**ephemeral selection session**: selected cards are highlighted, the rest dim,
a bottom action bar offers bulk operations (broadcast a message, interrupt,
stop, remove from board, start a review flow per node). Esc or an empty click
dissolves everything. **No persistent group entity exists** — nothing is
named, stored, colored, or cleaned up. This was settled before the design and
re-confirmed during the grill (the "group color" idea was explicitly rejected
as persistence in disguise).

## Grilled decisions

### D1. Activation gesture ✅ repurpose V-mode background drag
A drag ≥ 4 px on empty canvas in «виділення» (V) starts the marquee. Today
that drag pans (`useSchemeCamera.ts` — `startPan` after clearing selection);
panning remains fully available via «рука» (H), Space-hold, middle button,
wheel, and the minimap, so nothing is lost. This is the Figma/Miro/tldraw
convention: V = select/marquee, H/Space = pan. A stationary press on the
background keeps today's behavior (clears selection / exits the session).

### D2. Shape ✅ rectangle, not freehand
Cards are 600×680–780 world px laid out in generation rows with 48–150 px
gaps; a freehand loop cannot capture a set a rectangle can't. Rect hit-testing
is a tiny pure function (`bun test`-able); freehand needs polylines,
point-in-polygon, path simplification, SVG overlay — all cost, no capture
power on this geometry.

### D3. Reaching distant nodes ✅ toggle-clicks + fit-selection; no physical regrouping
The user wanted far-away conversations "brought together". Physically moving
cards is impossible without violating two constraints: positions are **derived**
from the conversation tree in `buildSchemeLayout` (no stored coordinates
exist), and the 10 s files-poll relayout would overwrite any manual shove.
Instead:
- distant nodes join the set via toggle-clicks in the selection session (D4)
  or Shift+click outside it;
- a **«Показати вибірку»** action fits the camera to the selection bbox
  (same mechanism as `fit()`/`centerOn`), so the whole set is on screen at once.

### D4. Selection session ✅ the core interaction model
When a marquee commits a non-empty set — or the user presses a new
**selection-mode toolbar button** — the board enters an ephemeral session:

- panes go click-through (the same `pointer-events-none` wrapper the hand
  mode already uses on `NodesLayer`), so clicks stop landing on pane
  internals;
- selected cards: accent ring + corner checkmark + light tint;
- unselected cards: dimmed (low opacity + grayscale) — **dimmed, not hidden**,
  because hiding would destroy the tree's spatial context and reshuffle the
  layout;
- a plain click on a card **toggles** membership (no Shift needed); the click
  resolves geometrically via the existing `pickAt` world hit-test (panes are
  click-through), filtered to conversation nodes;
- a dashed bbox outline is drawn around the set with an «N вибрано» counter;
- click on empty background or Esc exits; everything vanishes.

**No colors.** A color label only makes sense if it outlives the action —
that's persistence, which is out. Single accent style for the one live set.

### D5. Hit test ✅ intersection, not Miro's ~90 % containment
The research doc surfaced Miro's rule (an object is lassoed when ~90 % of it
is inside the loop). That threshold protects boards of small, densely packed
stickies. Our objects are huge, sparsely placed cards: 90 % containment
degenerates into "outline the whole card", forcing constant zoom-outs, while
the false-capture problem it solves barely exists here — and a wrong capture
is fixed by one toggle-click (D4). Figma-style **intersect** wins: touch a
card, catch it. `intersects(worldRect, nodeRect)` is a trivial unit.

### D6. Selectable kinds ✅ full conversation cards only (`layout.nodes`)
Mini-stacks, review decks, drafts, and under-decks are not lasso targets:
they have no pane or deliverable transcript, so every bulk action except
"message" would be a guaranteed 409, and stack rows would join "за компанію"
as half-dead noise. Selection = the set of agents you actually operate.

### D7. Action set ✅ seven actions, three research candidates rejected

| Action | Mechanism | Eligible nodes |
|---|---|---|
| Повідомлення всім | POST `/api/tmux` per path (ladder: live pane → resume → relay via root, `delivery.ts:223`) | any conversation |
| Interrupt всім | `action: "interrupt"` | live pane only; rest skipped |
| Зупинити всі | `action: "kill"` — panes die, **cards stay** with transcripts readable | roots only (`killConversation` refuses children, `delivery.ts:193`) |
| Прибрати зі схеми | today's `closeNode` (`ProjectDashboard.tsx:222`): kill + hide card | any (children hide; server filters their kill) |
| Флоу для кожного | POST `/api/flows` per path | `canStartFlow` nodes only (`flowModel.ts:91`) |
| Показати вибірку | camera fit to selection bbox | always |
| (implicit) toggle/clear | session mechanics | — |

Buttons show eligible counts («Interrupt 3/5»); ineligible nodes are skipped,
never errors. Mixed engines (claude + codex) need nothing special: message,
interrupt, and kill are engine-agnostic tmux operations.

**Stop vs Remove are two actions** (grilled after discovering `closeNode`
already kills the pane, so "collapse" was never UI-only): «заглуши двигуни,
залиш екрани почитати» and «приберись на дошці» are different intents that
often follow each other.

Rejected from the research candidate list:
- **label / color** — persistence, settled out;
- **review queue from changed files** — research rank #6, a separate lane
  feature dragging worktree diff collection behind it; not a selection action;
- **graceful shutdown with timeout** (ask agents to finish, kill leftovers) —
  state that lives for minutes needs a timer owner, progress UI, and
  page-reload survival; contradicts an ephemeral selection. v2 candidate on
  top of the flow machinery. v1 ships hard kill behind a confirm.

### D8. Fan-out ✅ client-side, strictly sequential
One POST at a time per path, reusing every existing server guard
(`pathAllowed`, resolve ladder, `withPaneLock`) with **no new bulk endpoint**
(a `/api/tmux/bulk` would duplicate routing and break the "routes only map
HTTP to delivery calls" rule, while buying no transactionality — tmux
deliveries are independent). Sequencing matters specifically because a
message delivery can **boot a resume window** (`sendToResumedAgent` spawns
tmux windows); parallel spawns are asking for trouble. Real selections are
2–8 agents; live-pane deliveries take tens of ms, so the whole sweep is
sub-second unless windows are booting — exactly when serialization helps.

The bar shows a per-node status column (spinner → ✓/✗ with the server's
error text, e.g. «немає активного пейна…»), stays open until dismissed, and
offers «повторити невдалі» which re-runs only the failed subset. Partial
failure never rolls anything back. A node that vanishes from the layout
mid-sweep reports as failed («вузол зник»).

### D9. Destructive confirmation ✅ inline confirm, no modal
«Зупинити всі» and «Прибрати зі схеми» both kill panes, so both flip the
button into a red «Точно N агентів?» state that auto-reverts after ~4 s —
the same pattern the flow strip uses for compact-confirm. No modal listing
victims: the selection is already highlighted on the canvas, the list would
duplicate the screen. Interrupt and the rest run unconfirmed.

### D10. Action bar placement ✅ fixed bottom-center, screen space
A `data-scheme-ui` bar like the top-left toolbar: the camera never touches
it, pan/zoom while it is open recompute nothing. A world-anchored floating
panel would need per-camera-frame repositioning — precisely the coupling the
canvas architecture forbids («camera state must never re-render panes») —
and would drift off-screen with a half-visible selection. The world-space
bbox outline shows *what* the bar refers to.

### D11. Broadcast composer ✅ full composer core, images and voice included
User chose the rich option. The `TmuxComposer` **component** is not reusable
— it is hard-wired to one `FileEntry` (per-path draft `llvDraft:<path>` and
sent-history `llvSent:<path>` in sessionStorage, its own interrupt/compact
buttons, pid-based target hook). But its core is already extracted as
`useComposer` (`src/hooks/useComposer.ts`): text state, image paste/attach,
voice input. A new `BulkComposer` builds on that hook inside the bar.
Images are re-sent in each per-node POST and duplicated into the inbox per
delivery — that is how `delivery.ts` already works (each delivery saves and,
on failure, deletes its own copies), so no server change.

### D12. Bulk flow config ✅ one shared mini-config popover
«Флоу для N» opens a compact popover over the bar: preset, round limit,
auto/manual — the same fields `FlowDialog` collects, defaults resolved from
the preset exactly as `FlowDialog` does — then one «Запустити N флоу» fires
sequential POSTs. Mass review launches almost always want identical rules;
per-node variation stays a per-card `FlowDialog` job. Never silently: bulk
auto-flows without a visible round limit was rejected as too bold.

### D13. Keyboard ✅ Esc only, no Ctrl+A
Esc clears the set and exits the session (extends the existing Esc handler
in `useSchemeCamera`). Bar buttons are ordinary tab-reachable buttons with
focus rings. **Ctrl+A was offered and declined** — select-all stays out.

### D14. Touch ✅ no marquee gesture; session works via toolbar button
The marquee stays a mouse/trackpad gesture — on coarse-pointer devices one
finger keeps panning/tapping as today. But the selection-mode **toolbar
button** arms the session on any device, and toggle-taps + the action bar
work with a finger, so touch gets the whole feature without a new gesture.
The mobile full-screen map (lite/`mapMode`) is excluded entirely: its taps
are picks that jump back to the dashboard, and lite shells exist precisely
because live panes exceed the phone's budget.

## State shape

```ts
/* SchemeBoard-owned; replaces `selected: string | null` */
interface SelectionState {
  /** Session armed via toolbar button even while empty. */
  armed: boolean;
  /** Transcript paths of selected conversation nodes. */
  paths: ReadonlySet<string>;
}
/* session active ⇔ armed || paths.size > 0 */
```

- Keys are transcript paths — stable across the 10 s poll relayout, so the
  selection survives reshuffles for free.
- A layout-change effect prunes paths no longer present in `layout.nodes`;
  if the set empties and the session isn't armed, the bar closes.
- `useSchemeCamera`'s `setSelected(value: string | null)` contract is kept
  via an adapter (`null` → clear, path → single-element set outside the
  session / toggle inside it), so the camera hook needs no rewrite; the
  existing single-click ring becomes a one-element selection.

## Rendering-quality constraints (binding)

- **During the drag** only the overlay renders: the marquee rect and the
  live candidate highlights are drawn in a screen-space overlay component
  with its own local state, computed from `layout` geometry — the memoized
  `NodesLayer` is untouched per pointermove.
- **On commit** exactly one `NodesLayer` re-render (new `selection` +
  `session` props) — same cost class as today's single-click ring change.
- The **bbox outline** lives inside the transformed world div, so the camera
  moves it via the container transform with zero re-renders; it re-renders
  only when selection or layout changes.
- The action bar is screen-space (`data-scheme-ui`); camera frames never
  touch it. Handlers passed into `NodesLayer` stay identity-stable (existing
  ref-trampoline pattern in `SchemeBoard`).

## Failure handling

Every action resolves to the existing per-path `DeliveryOutcome` (or the
flows route's error). The bar renders ✓ / ✗ / spinner per node with the
server's Ukrainian error text verbatim, keeps results until dismissed, and
re-runs only failures on «повторити невдалі». Eligibility filters run
client-side for honest counts, but the server re-checks everything — a node
that went quiet between poll and click degrades to a reported ✗, never a
silent skip.

## Research notes (docs/research/canvas-agent-orchestration-2026-07.md)

Read during the grill; effects on this design:
- **Confirms** the feature (ranked idea #4: lasso + contextual bulk menu) and
  the demand evidence (duplicated work, ownership confusion in 3–5-agent
  fleets).
- **Miro's ~90 % containment rule** was grilled and rejected for this board's
  object scale (D5).
- From its candidate action list: broadcast + interrupt/kill-with-confirm
  adopted (D7, D9); **label** rejected as persistence; **review queue from
  changed files** deferred to the separate review-lane feature (rank #6);
  **graceful shutdown protocol** deferred to v2 (D7).
- «Mission zones» (rank #5) is the right future home for the user's
  "long-lived colored group" wish — explicitly a different feature.

## Implementation plan (for a Codex implementer in a separate git worktree)

Branch off `refactor/architecture-deepening` (or `main` if merged) in its own
worktree. Steps are ordered so each lands compilable and testable.

1. **Pure geometry: `src/components/scheme/lasso.ts`**
   - `screenRectToWorld(rect, cam): SchemeRect`
   - `rectsIntersect(a: SchemeRect, b: SchemeRect): boolean`
   - `nodesInRect(nodes: SchemeNode[], world: SchemeRect): string[]`
   - `selectionBBox(nodes: SchemeNode[], paths: ReadonlySet<string>): SchemeRect | null`
   - `pruneSelection(paths: ReadonlySet<string>, nodes: SchemeNode[]): ReadonlySet<string>` (returns the same reference when nothing changed — the pruning effect depends on that to avoid render loops)
   - Tests (bun): zero-area rects, inverted drags (drag up-left), zoom ≠ 1
     transforms, boundary-touch counts as intersect, prune identity.
2. **Selection state in `SchemeBoard.tsx`**
   - Replace `selected: string | null` with `SelectionState`; adapter for
     `useSchemeCamera`'s `setSelected`; pruning effect on `layout`;
     `ringed` → `paths.has(...)`.
   - Extend `NodesLayer` props: `selection: ReadonlySet<string>`,
     `session: boolean` (drives click-through + dimming + checkmarks).
     Keep the memo; verify with React DevTools that camera frames still skip it.
3. **Marquee: `useLasso.ts` + `MarqueeOverlay`**
   - Pointerdown routing in select mode: background press → arm pending
     marquee; ≥ 4 px movement starts it (below threshold falls through to
     today's clear-selection click). Shift+drag adds to the set instead of
     replacing. Pointer capture + window-level up/cancel (mirror the camera
     hook's pattern).
   - Overlay renders the rect and candidate highlights in screen space from
     its own state; commit on release into `SelectionState`.
4. **Session rendering**
   - Toolbar selection-mode button (Lucide `BoxSelect`) toggling `armed`;
     works on touch (D14).
   - Click-through panes during the session (reuse the `interactive=false`
     wrapper), toggle-clicks resolved via `pickAt` filtered to
     `layout.nodes` paths; checkmark badge + tint on selected; dim class on
     unselected; dashed bbox + counter inside the world div.
   - Esc handling through the existing keyboard effect.
5. **Bulk runner: `src/components/scheme/bulkActions.ts`**
   - `runBulk(items, runner, onProgress)` — strictly sequential, collects
     `{path, ok, error?}`, supports a retry subset. Inject `fetch` for tests.
   - Eligibility predicates (message / interrupt / kill-root / remove / flow)
     as pure functions over `SchemeNode` + `flowsByImpl`. Tests for both.
6. **`BulkActionBar` + `BulkComposer`**
   - Fixed bottom-center `data-scheme-ui` bar: counter, composer
     (`useComposer` core — text, images, voice), action buttons with
     eligible counts, inline confirms for Зупинити/Прибрати (auto-revert
     ~4 s), per-node result column, «повторити невдалі», dismiss.
   - «Прибрати зі схеми» calls the `onClose` prop per path (client `closeNode`
     handles kill + hide + prefs).
7. **Bulk flow popover**
   - Preset / round limit / auto-manual (defaults from `GET /api/flows`
     presets like `FlowDialog`), «Запустити N флоу» → sequential POSTs via
     the same runner.
8. **Fit-selection**
   - Add `fitRect(rect: SchemeRect)` to `SchemeCamera` (generalizes `fitCam`
     math + `glideTo`); wire the «Показати вибірку» button.
9. **i18n + docs**
   - All new strings in both `en` and `uk` dictionaries.
   - Update ARCHITECTURE.md's scheme-canvas section (selection session, new
     files) in the same PR.

### Test plan
- `bun test` units: `lasso.ts` geometry (step 1), `bulkActions.ts` runner
  ordering / partial failure / retry subset with a mock fetch, eligibility
  predicates across node shapes (root/child, live/quiet, flow-hosting).
- Manual verification on desktop: marquee vs pan/zoom/wheel coexistence,
  Space-hold during a session, 10 s poll reshuffle with an active selection,
  broadcast to a mix of live + quiet + child nodes (expect resume boots and
  relays), stop-all confirm flow. Visual pass via the docker-puppeteer setup
  (`LLV_DEV_ORIGINS`, browse `172.17.0.1`) for the session dimming and bar.
- Rendering regression: with the profiler, confirm camera pan during an open
  session re-renders neither `NodesLayer` nor the bar.

### Out of scope (explicit)
- Persistent groups, names, colors, labels, saved selections — settled: never.
- Freehand lasso; Miro-style containment thresholds.
- Touch marquee gesture; lasso/bulk on the mobile lite map (`mapMode`).
- Ctrl/Cmd+A select-all (offered, declined).
- Graceful shutdown protocol with timeout (v2 candidate).
- Review queue built from selected agents' changed files (separate feature,
  research rank #6).
- Physically regrouping/moving nodes on the board (layout stays derived).
- Bulk `/compact`, bulk dialog-answering, bulk handoff.
