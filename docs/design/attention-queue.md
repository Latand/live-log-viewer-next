# Attention queue: who is blocked on me

Status: **final, user-grilled 2026-07-05** (12 decisions confirmed in
interview). Research input: `docs/research/canvas-agent-orchestration-2026-07.md`
— attention routing ranks as the highest-value fleet-orchestration feature
across surveyed tools; its tier taxonomy (working / waiting-for-input /
blocked / errored / done / review-ready) and the "show only needs me" filter
were folded into the grill and shaped decisions D6 and D7.

## Problem

The orchestrator's main job is answering agents that wait on him. Today he
finds them by eye: the tab title shows `(N)`, the project rail sorts
attention-first, toasts flash once — but there is no ordered "serve the next
blocked agent" surface and no keyboard path to it. With 5–10 concurrent agents
across several projects the oldest waiting agent silently starves, and a
stalled (interrupted/crashed) agent is the least visible of all.

## Signals (verified in code)

| signal | source | identity | wait start |
|---|---|---|---|
| `pendingQuestion` | `src/lib/scanner/questions.ts` — structured AskUserQuestion / ExitPlanMode at the transcript tail, live claude sessions only | `toolUseId` | `askedAt` |
| `waitingInput` | `src/lib/scanner/waitingInput.ts` — tmux scrape: ≥15 s quiet + ≥15 s stable prompt-like screen | `path:waiting:⌊since⌋` | `since` |
| `stalled` | `activityVerdict` — jsonl turn open, mtime >180 s; `isAwaitingUser()` already caps it at a 2 h TTL | `path:stalled:⌊mtime⌋` | `mtime` |

Existing notification consumers (the queue must not re-fire them): title
counter and toast in `Viewer.tsx` (seen-set keyed on the identity above),
chime in `useAgentChimes.ts` (transition-from-live), Push in `src/lib/push.ts`
(sent-set on the same identity + 60 s waitingInput debounce), project-rail
ordering (`attentionCount`), switchboard «waiting» bucket.

## Decisions (each grilled with the user)

**D1 — Membership: hard-blocked only, no soft tier.** The queue contains
`pendingQuestion` + `waitingInput` items. The soft "yours to act" notion
(`isAwaitingUser` recents, `returned` subagents) stays in the switchboard.
*Why:* every conversation between user messages formally "waits"; letting
tier 2 in doubles the queue with soft items and breaks the badge's promise —
"this many agents are actually blocked on me".

**D2 — Plus a stalled tail segment.** `stalled` entries within the existing
2 h TTL join the queue *after* all hard-blocked items, as their own FIFO
segment; the badge counts them. *Why:* the research tier taxonomy calls out
blocked/errored explicitly, and stalled is our closest analogue — an
interrupted or fallen agent needs a resume, and it is the quietest signal in
the app today (questions get toast/chime/push; stalled gets nothing).

**D3 — Ordering: oldest-wait-first (FIFO), per segment.** Sort by `since`
ascending, `id` as tie-breaker; hard-blocked segment first, stalled segment
after. *Why:* the feature exists precisely against starvation;
freshest-first is what the switchboard already gives and it is what hides
the starving agent at the bottom. Stability: an item's position holds while
its `id` is unchanged — polls cannot reshuffle the queue because the sort
keys (`since`, `id`) are frozen at enqueue by construction.

**D4 — Hotkey: `N` forward, `Shift+N` backward, project-local.** Registered
globally in `Viewer.tsx` under the same `typing()` guard the scheme keys use
(no firing while a composer/input is focused). **N cycles only within the
currently open project.** *Why the key:* mnemonic, free (taken: H, V, Space,
0, 1, +, −, arrows, Esc), one-handed; no modifier — with focus in a composer
the key just types a letter, which is safer than a surprise camera jump
mid-sentence. *Why project-local:* the user explicitly wants the board
context to stay stable under the hotkey; cross-project keyboard flow is
deferred to the future all-projects board (see Out of scope).

**D5 — Scope: this feature ships without the global board.** A combined
all-projects canvas is a separate design (own layout, camera, performance
story). The queue builder is **surface-agnostic** — it takes `files` and an
optional project filter — so the future global board plugs N in without
rework. The **popover is global**: it lists all projects' items with project
chips, and clicking a foreign-project item explicitly switches the project
(click is a deliberate act, unlike a hotkey). *Why:* the queue delivers value
as a small diff now; welding it to a big new surface would delay it by weeks.

**D6 — "Show only needs me" filter ships in v1.** A funnel toggle as a second
segment of the badge pill + the `F` key (free on the scheme). Active filter
dims (CSS opacity — geometry untouched, no layout reshuffle) every scheme
node whose file is not in the queue. The state is React-only: **not
persisted, auto-disables when the queue empties.** *Why:* the user scans the
board visually as much as by keyboard; research ranks this filter inside the
top attention-routing feature. No persistence because a filter that survives
reload silently grays the whole board ("why is everything dim?"); a visible
toggle is mandatory because a state that restyles the whole board needs a
visible indicator.

**D7 — Badge: one fixed top-right pill in `Viewer.tsx`.** «N чекають», amber
like the toast, hidden at zero, rendered once for all views (overview,
project, mobile) in the same corner the toast appears — the toast visually
"docks" into it. *Why:* one persistent attention anchor app-wide; the
alternatives (per-view headers, project rail) each miss a surface (mobile has
no rail; the overview has a different header).

**D8 — No dismiss/snooze in v1.** Pressing N again *is* the skip. *Why:* the
feature is pure routing — the queue cleans itself when the user
answers; hidden snooze state contradicts the badge's "real count of blocked
agents" promise and creates the "badge says 2, I see 3" bug class. If long
waitingInputs prove annoying in practice, a 30 min snooze by id in
localStorage is a cheap v1.1.

**D9 — Jump = camera + ring + selection, no composer autofocus.** The jump
drives the existing highlight channel (`flashNode(path)` → `focus` prop →
`centerOn(node, 0.55)` glide + ring) and selects the node. Keyboard focus
stays on the document so the next N keeps working. *Why:* half the queue
(questions, plans, menus) is answered by clicking options in QuestionCard;
autofocus would make the second N type "n" into a composer and
kill the feature's core gesture.

**D10 — One counter everywhere.** Tab title, badge and popover all show
`buildAttentionQueue(files).length` (now including the stalled tail). Push is
deliberately narrower and unchanged: it fires on hard-blocked *events* only.
*Why:* two diverging numbers side by side is a classic trust hole; push is an
interruption, and the badge owns the state readout — the research's push-demand evidence
(Nimbalyst, AgentShell, Cursor forum) is all about waiting-for-input events,
which is exactly what the existing pipeline already sends.

**D11 — Data channel: ride the `/api/files` poll, no new endpoint.**
Everything needed (`pendingQuestion.askedAt`, `waitingInput.since`,
`activity`, `mtime`) is already in the payload; a dedicated endpoint would add
a second poll loop for zero new data. The queue is pure derived client state.

**D12 — Lifecycle: id-anchored cycle pointer, silent convergence.** Answering
from another tab or the phone clears the signal on the next poll (≤10 s) and
the item disappears from queue, badge and title simultaneously. The N-cycle
position is an *id*: when the current id vanishes, the next
press serves the next-oldest remaining item. The queue never fires
notifications of its own — toast/title/chime/push keep their seen-sets. All
five surfaces derive identity from one shared `attentionId(file)` helper so
they cannot drift.

Empty state: badge and funnel hidden, N and F are silent no-ops.

## Model

```ts
// src/components/attention.ts (client-pure, unit-testable)
export type AttentionTier = "blocked" | "stalled";

export interface AttentionItem {
  id: string;        // attentionId(file)
  file: FileEntry;
  project: string;   // projectKey(file)
  tier: AttentionTier;
  since: number;     // epoch seconds: askedAt | waitingInput.since | mtime
}

export function attentionId(file: FileEntry): string | null;
export function buildAttentionQueue(
  files: FileEntry[],
  now?: number,
  project?: string,          // optional filter: hotkey scope; omit = global (popover, badge)
): AttentionItem[];
export function nextAttention(
  queue: AttentionItem[],
  currentId: string | null,
  dir: 1 | -1,
): AttentionItem | null;     // id-anchored cycle, wraps, null on empty
```

`attentionId` returns `pendingQuestion.toolUseId`, else
`path:waiting:⌊since⌋`, else `path:stalled:⌊mtime⌋` for in-TTL stalled
conversations, else `null`. `buildAttentionQueue` filters files with a
non-null id, maps to items, sorts: tier (blocked < stalled), then `since`
asc, then `id`.

## UI wiring

- **`Viewer.tsx`** owns the queue (`useMemo` over polled `files`), the badge
  pill + funnel, the popover, the `N`/`Shift+N`/`F` key handler, the cycle
  pointer (`useRef<string | null>`), and the filter boolean. A popover click
  on a foreign-project item calls `selectProject(item.project)` and hands the
  path down; N never leaves the current project.
- **Focus hand-off**: `Viewer` passes a `focusRequest: {path, nonce} | null`
  prop to `ProjectDashboard`, which feeds it into the existing
  `pendingFocusRef`/`flashNode` path (nonce so repeated jumps to the same
  node re-flash). No `queueColumnOpen` — a read-only jump must not mutate
  manual column prefs.
- **Filter**: `Viewer` passes `attentionPaths: ReadonlySet<string> | null` to
  `ProjectDashboard` → `SchemeBoard` → node shells add a dimming class when
  the set is non-null and misses their path. Memoized set identity changes
  only when membership changes, so camera-frame renders stay untouched.
- **Badge/popover copy** (uk, matches prototype tone): pill «3 чекають»;
  popover rows: title, project chip, `fmtAge(since)`, first line of the
  question header / screen tail; stalled rows get the existing stalled amber
  wording.

## Implementation plan (Codex implementer, separate git worktree)

Branch off `main` in a worktree; steps are ordered and independently
committable.

1. **`src/components/attention.ts` + `attention.test.ts`** — implement
   `attentionId`, `buildAttentionQueue`, `nextAttention` exactly per the
   model above. Unit tests (`bun test`): identity precedence
   (question > waiting > stalled > null); stalled TTL boundary (2 h ± 1 s);
   segment order (blocked before stalled regardless of since); FIFO inside a
   segment; id tie-breaker; project filter; `nextAttention` wrap-around,
   backward direction, vanished-current-id fallback to next-oldest, empty →
   null. Reuse fixture-builder patterns from `projectModel.test.ts`.
2. **Shared identity refactor** — switch `Viewer.tsx` (toast seen-set, title),
   `src/lib/push.ts` (`notifyQuestionNow`), and the switchboard/chime call
   sites that re-derive `pendingQuestion?.toolUseId ?? path:waiting:…` to
   `attentionId()`. Push keeps its own narrowing (never send for stalled):
   guard on `file.pendingQuestion || file.waitingInput` before using the id.
   No behavior change intended — cover with one test asserting the derived id
   strings are byte-identical to the current format (existing
   `push-sent.json` entries must stay valid).
3. **Badge + popover in `Viewer.tsx`** — top-right fixed pill (toast corner),
   hidden at zero; popover with the global queue, project chips, click =
   `selectProject` + focus hand-off. Title effect switches from the inline
   filter count to `queue.length` (D10).
4. **Hotkeys + cycle** — `N`/`Shift+N` (project-local queue via
   `buildAttentionQueue(files, now, project)`), `F` (filter toggle), all
   under a `typing()` guard identical to `useSchemeCamera`'s; cycle pointer
   ref per D12; F auto-off effect when the queue empties.
5. **Focus + dimming plumbing** — `focusRequest` prop into
   `ProjectDashboard` (feed `pendingFocusRef`), `attentionPaths` prop down to
   the scheme node shells with an opacity class; verify camera-render
   isolation (dimming must not re-render on camera frames — set identity
   stable across polls with unchanged membership).
6. **Verification** — `bun test`; `bun run build` green;
   manual: seed two waiting agents in different projects (spawn via the
   viewer's own tmux path), confirm badge count matches title, N cycles
   oldest-first within the project only, popover click switches project and
   glides, F dims non-queue nodes and auto-clears when the last item is
   answered, answering from a second browser tab removes the item within one
   poll without a toast replay.

## Out of scope (v1)

- The combined all-projects canvas board (separate design doc; the queue
  builder's project parameter is the ready seam for its N support).
- Soft tier 2 (finished-turn conversations, returned subagents) in queue or
  badge.
- Snooze/dismiss persistence.
- Any push/chime/toast behavior changes beyond the shared-id refactor.
- Mobile hotkeys (badge + popover fully work on mobile; N/F are
  desktop-only).
- Review-ready / errored-process detection beyond the existing `stalled`
  activity (the research's "review-ready" tier maps to the flows feature,
  not this queue).
