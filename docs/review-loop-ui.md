# Spec: review-loop flows — orchestrated implement→review cycles with a 3D round deck

Target repo: `~/.agents/tools/live-log-viewer-next` (this repo). Next.js 16 App Router,
Tailwind v4, bun, TypeScript strict. Server runs on Linux — `/proc` and a local
tmux server are available.

Read `AGENTS.md` first (Next.js version differs from training data; check
`node_modules/next/dist/docs/` when unsure about an API).

Do NOT commit. Keep named exports and the existing file layout conventions
(`src/lib/*` for server logic, `src/components/*` for UI, `src/app/api/*` for routes).

## Problem summary

The user's working pattern is an implement→review cycle: one long-lived agent
writes code (Fable / Sonnet / Codex high), a second agent reviews it (e.g. Codex
at xhigh reasoning), findings go back to the implementer, and the cycle repeats.
Every review round uses a FRESH reviewer session with a new task; the
implementer session lives across all rounds.

Today the viewer can spawn agents (`POST /api/spawn`), message and resume them
(`POST /api/tmux`), kill them (`POST /api/proc`), and already renders review
verdicts as cards (`parseReview` in `src/components/feed/renderers.tsx`), but
the cycle itself is entirely manual: the user watches for "done", spawns a
reviewer by hand, copies findings back by hand, and old reviewer sessions
pile up as dead columns on the dashboard.

This spec adds:

1. a minimal **flow engine** — a server-side state machine that spawns
   reviewers, relays findings, and tracks rounds, with the implement→review
   loop as the first (and only, in v1) built-in template;
2. **per-role model/effort selection** with editable presets;
3. a **3D round deck** UI: past review rounds stack "under" the current one
   like cards, each pullable to the front.

Related spec: `docs/specs/2026-07-04-agent-questions-ui.md` explicitly deferred
loop orchestration to separate work — this is that work. The two features stay
independent: flows never assume question cards exist and vice versa.

## Decisions log (agreed with the user, 2026-07-04)

1. **Runtime**: the implementer is an interactive CLI in tmux, driven through
   the existing `src/lib/tmux.ts` machinery (kickoff and relay messages go via
   the tmux send path; the session survives viewer restarts). Reviewer rounds
   run **headless by default** (`codex exec` / `claude -p`), with an optional
   per-flow pane mode — see addendum decisions 11–12.
2. **Driver**: the viewer's server runs the loop state machine automatically.
   Each flow has an **Auto/Manual** toggle and a **Pause** control; Manual
   stops at every transition and waits for a click. A **round limit**
   (default 5) always forces a pause.
3. **Round trigger**: a transcript marker. The implementer is instructed to
   print a `REVIEW_READY:` line when it considers the work reviewable; the
   scanner detects it and starts a round. A manual «Почати ревью» button is
   always available as an alternate trigger.
4. **Review scope**: a base git ref is captured once at flow creation (choice
   of current `HEAD` or `merge-base` with the default branch). Every reviewer
   round covers the FULL range — `git diff <base>...HEAD` plus uncommitted
   changes — so earlier fixes get re-checked and nothing slips through.
5. **Fresh reviewers are fully blind**: no findings history, no round context
   in the reviewer prompt. Independence of each round's perspective is the
   point of using fresh reviewers.
6. **Triage**: none on the viewer side. All findings relay verbatim to the
   implementer, who is instructed to push back with arguments on findings it
   disagrees with. The long-lived implementer remembers prior rounds and prior
   rejections; that memory is the convergence mechanism.
7. **Model/effort config**: editable presets in a server-side JSON file plus a
   per-role override section in the flow creation form.
8. **Workflow scope**: the spec introduces a general "flow" concept (roles,
   steps, marker-driven transitions, engine-agnostic agents) and ships exactly
   one template — the implement→review loop. No graph editor, no parsing of
   native Claude Code Workflow runs in v1 (both listed under Deferred).
9. **3D deck interaction**: swap-within-deck. One reviewer position per flow;
   the current round sits on top, past rounds stack behind with visible tabs.
   Clicking a tab slides that round to the front (read-only); the live round's
   tab pulses while it has activity. One click returns to the live round.
10. **Endings**: `APPROVE` → flow done (green), approval relayed to the
    implementer; `COMMENT` → notes relayed, flow done, with a «Ще коло»
    button; round limit → paused in a "needs decision" state (+N rounds or
    close).

### Addendum (2026-07-05, second interview reconciled)

Two interview passes resolved the reviewer runtime and the verdict channel
differently (tmux + transcript parsing vs headless + findings file). The
user's final call on 2026-07-05: **combine them** —

11. **Reviewer launch is headless by default, pane mode optional.** The
    default is a one-shot process (`codex exec` / `claude -p`) — nothing to
    clean up, the process ends when the review ends. A per-flow «pane mode»
    toggle instead spawns the reviewer as an interactive tmux agent through
    the existing `freshSpecFor()` path, for when the user wants to watch or
    interrogate the reviewer live. Same prompt, same read-only flags, same
    verdict handling — only the launch path differs.
12. **Verdict transport is a findings file with a transcript fallback.**
    Primary: `~/.claude/viewer-state/flows/<id>/round-<n>-review.md`, first
    line `VERDICT: APPROVE | REQUEST_CHANGES | COMMENT`, findings markdown
    below. Because the reviewer runs read-only (decision 13), the engine
    itself writes the file from the reviewer's captured final output
    (`--output-last-message` for codex, stdout for claude). Fallback: if no
    output was captured (pane mode has no captured stdout; a headless run may
    die oddly), the engine parses the reviewer transcript's final message via
    the shared `parseReview` contract. Only when both channels fail →
    `needs_decision`; the engine never guesses a verdict.
13. **Reviewer read-only is enforced technically, not only by prompt**: the
    reviewer command carries engine flags that block edits (see Engine
    adapters). The prompt instruction remains as the second layer.
14. **Codex as implementer runs at high reasoning**: the codex implementer
    preset uses `model_reasoning_effort=high` (reviewer stays xhigh).

## Data model

New module `src/lib/flows/` (server-only, pure like `src/lib/scanner/*`).

### Flow definition (the generalization layer)

A **FlowTemplate** describes a shape; v1 hardcodes one:

```
FlowTemplate {
  id: "implement-review-loop",
  roles: [
    { key: "implementer", lifetime: "attached" },   // binds to an existing session
    { key: "reviewer",    lifetime: "per-round" },  // fresh spawn each round
  ],
}
```

Templates live in code. The registry exists so a second template later (e.g.
plan→implement→review, or a test-writer role) reuses the engine, persistence,
API, and deck UI without schema changes. No user-defined templates in v1.

### Role configuration

```
RoleConfig {
  engine: "claude" | "codex",
  model: string | null,        // null = engine default
  effort: string | null,       // null = engine default; see Engine adapters
}
```

### Flow instance (persisted)

Stored in `~/.claude/viewer-state/flows.json` (same discipline as
`codex-lineage.json` / `resume-panes.json`: read on scan, atomic rewrite).

```
Flow {
  id: string,                     // short random id
  template: "implement-review-loop",
  project: string,                // FileEntry.project of the implementer
  cwd: string,                    // implementer's working directory
  implementerPath: string,        // transcript path of the attached session
  roles: { implementer: RoleConfig, reviewer: RoleConfig },  // config snapshot
  baseRef: string,                // resolved git SHA captured at creation
  baseMode: "head" | "merge-base",
  mode: "auto" | "manual",
  reviewerMode: "headless" | "pane",  // default "headless"
  roundLimit: number,             // default 5
  state: FlowState,
  rounds: Round[],
  createdAt: string,
  closedAt: string | null,
}

Round {
  n: number,                      // 1-based
  reviewerPath: string | null,    // headless run's transcript path once known
  findingsPath: string | null,    // round artifact file once written
  triggeredBy: "marker" | "button",
  readyNote: string | null,       // text after REVIEW_READY:
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null,
  findingsCount: number | null,
  startedAt: string,
  reviewedAt: string | null,      // verdict detected
  relayedAt: string | null,       // findings delivered to implementer
}
```

### Preset file

`~/.claude/viewer-state/review-loop-presets.json`:

```
{
  "presets": [
    { "name": "Fable → Codex xhigh",
      "implementer": { "engine": "claude", "model": "fable",  "effort": null },
      "reviewer":    { "engine": "codex",  "model": null,     "effort": "xhigh" } },
    { "name": "Sonnet → Codex xhigh", ... },
    { "name": "Codex high → Codex xhigh",
      "implementer": { "engine": "codex",  "model": null,     "effort": "high" },
      "reviewer":    { "engine": "codex",  "model": null,     "effort": "xhigh" } }
  ]
}
```

Seeded with the three presets above on first read if the file is missing.
Editing is by hand in v1 (documented in README); a preset picker UI reads it.

## State machine

```
FlowState =
  "waiting_ready"      // watching implementer transcript for REVIEW_READY / button
  | "spawn_pending"    // Manual only: round triggered, waiting for user click
  | "spawning"         // reviewer being started (headless process or tmux pane)
  | "reviewing"        // reviewer running, waiting for verdict
  | "relay_pending"    // Manual only: verdict in, waiting for user click
  | "relaying"         // findings being sent to implementer pane
  | "fixing"           // implementer working; next REVIEW_READY starts round n+1
  | "approved"         // terminal: APPROVE
  | "done_comment"     // terminal-ish: COMMENT relayed; «Ще коло» re-arms
  | "needs_decision"   // round limit hit, or verdict unparseable
  | "paused"           // user pressed Pause (from any non-terminal state)
  | "closed"           // user closed the flow
```

Transitions in Auto mode skip the `*_pending` states. Pause freezes the machine
wherever it is; Resume re-enters the frozen state. The engine **tick** runs
inside the existing scan pipeline (`src/lib/scanner/index.ts`) — the scanner
already tails every relevant transcript on the `/api/files` poll cadence, so no
new timers or transports are introduced. Each tick:

1. reconciles every non-terminal flow against transcript reality (marker
   appeared? verdict appeared? reviewer process died?),
2. executes at most one transition per flow per tick (keeps actions idempotent
   and observable),
3. rewrites `flows.json` only when something changed.

### Marker protocol

- **`REVIEW_READY: <one-line note>`** — printed by the implementer at the start
  of a line in its final assistant message. Detection: last assistant message
  of the transcript, line-anchored regex, only in messages newer than the
  previous round's `startedAt` (prevents re-firing on old markers and on the
  agent quoting the instruction). The same marker ends fix rounds — one
  uniform trigger for round 1 and round N.
- **Verdict** — a findings file per round:
  `~/.claude/viewer-state/flows/<id>/round-<n>-review.md`. First line is the
  strict verdict (`VERDICT: APPROVE | REQUEST_CHANGES | COMMENT`), the rest is
  findings markdown (severity, file, line per finding — the same content
  shape `parseReview` renders in the feed). In headless mode the engine
  captures the reviewer's final output itself — `codex exec
  --output-last-message <tmpfile>` or `claude -p` stdout — validates the
  first line, and writes the artifact file. **Fallback** (pane mode always;
  headless when capture failed): parse the reviewer transcript's final
  message. Extract the parsing logic from
  `src/components/feed/renderers.tsx` into a shared module
  (`src/lib/review.ts`) used by the engine and the feed renderer; a verdict
  recovered this way is also persisted as the round's artifact file. Both
  channels empty or unparseable → `needs_decision`; the engine never guesses
  a verdict.
- **Dispositions** — on fix rounds the implementer is instructed to answer
  each finding with `FIXED`, or `REJECTED — <reason>`, before its next
  `REVIEW_READY`. Dispositions are for the human reading the feed and for the
  implementer's own memory; the engine does not parse them (decision 6: no
  viewer-side triage).

### Prompts (content requirements, exact wording at implementation time)

Prompts to agents are English. UI strings are Ukrainian.

- **Flow kickoff message to the implementer** (sent once when the flow is
  created, via the existing `/api/tmux` send path): explains the loop, the
  `REVIEW_READY:` marker contract, the disposition contract
  (`FIXED` / `REJECTED — reason`, and that rejections need arguments since the
  reviewer will be fresh and blind each round).
- **Reviewer prompt** (passed to the headless command each round): working
  directory; review `git diff <baseRef>...HEAD` plus uncommitted changes;
  read-only instruction (no edits, no commits); the implementer's `readyNote`
  as task context; required output format = first line
  `VERDICT: APPROVE | REQUEST_CHANGES | COMMENT`, then findings with severity,
  file, line. Nothing about previous rounds.
- **Relay message to the implementer**: the round's findings file content
  verbatim, plus a reminder of the disposition contract and of the marker
  that starts the next round.

## Engine adapters (model/effort → command)

Headless reviewers run via a new server module (`src/lib/flows/exec.ts`):
spawn in the flow's `cwd`, capture stdout/stderr, enforce a per-round timeout
(default 30 min → kill + `needs_decision`). In **pane mode**
(`reviewerMode: "pane"`) the reviewer instead spawns through the existing
`freshSpecFor()` tmux path with the same prompt and flags; the verdict then
comes from the transcript fallback (addendum decision 12), and round
completion is detected by the transcript going idle (existing `activity.ts`
mechanics) rather than process exit.

| engine | command core | model flag | effort flag |
| --- | --- | --- | --- |
| `claude` | `claude -p <prompt>` | `--model <model>` | none in v1 — the field is hidden for claude roles |
| `codex` | `codex exec <prompt> --json --output-last-message <tmpfile>` | `-m <model>` | `-c model_reasoning_effort=<low\|medium\|high\|xhigh>` |

`--json` turns codex stdout into a JSONL event stream; the engine reads the
session/thread id from the first events and persists it on the Round, so the
reviewer-transcript claim is deterministic and survives restarts (`claude -p`
gets the same guarantee via a pre-chosen `--session-id`). The cwd+mtime
heuristic remains only as a last resort while no id is known.

Exact flag sets are finalized at implementation time against the installed
CLI versions. Unknown model strings pass through to the CLI untouched — the
CLI is the validator.

Reviewer commands additionally carry read-only enforcement (decision 13):

| engine | read-only flags |
| --- | --- |
| `claude` | `--disallowedTools "Edit,Write,NotebookEdit"` |
| `codex` | `--sandbox read-only` |

These flags apply only to `per-round` roles; the attached implementer is never
restricted. The reviewer prompt still states the no-edits rule — the flags are
the backstop, the prompt sets expectations.

For the implementer role the same `{ model, effort }` options extend
`freshSpecFor()` in `src/lib/tmux.ts`, and the existing `SpawnAgentButton`
dialog gains optional model/effort fields (a general improvement, independent
of flows).

The adapter surface (headless command builder, transcript root, output
capture) is the extension point for future engines ("custom clients like
codex"): a new engine means a scanner root + an adapter entry, no engine
changes.

## API

New route `src/app/api/flows/route.ts` (same-origin guarded via
`rejectCrossOrigin`, like all mutating routes):

- `GET /api/flows` — all flows (the client merges them with `useFiles` data by
  transcript path).
- `POST /api/flows` — create: `{ implementerPath, preset | roles, baseMode,
  mode, reviewerMode, roundLimit }`. Server resolves `baseRef` by running git in the
  implementer's `cwd`; a failure (not a git repo, git missing) is a `409` with
  a readable message — flows require a git repo.
- `PATCH /api/flows/:id` — `{ action: "pause" | "resume" | "set-mode" |
  "advance" | "extend" | "another-round" | "close" }`. `advance` fires the
  pending Manual transition; `extend` adds N rounds from `needs_decision`;
  `another-round` re-arms from `done_comment`.
- Round triggering by button reuses `PATCH { action: "advance" }` from
  `waiting_ready`.

Flow state travels to the client piggybacked on the existing `/api/files`
poll: `listFiles()` output gains a top-level `flows` array (extend the
`/api/files` response shape, `FileEntry` itself stays untouched except —
optional — a `flowId`/`flowRole` annotation the client uses for grouping).

## UI

### Flow creation

- Column header menu of any live Claude/Codex conversation gets «Запустити
  флоу» → dialog: preset dropdown, expandable per-role engine/model/effort
  override, base mode radio («від поточного HEAD» / «від merge-base з main»),
  Auto/Manual, reviewer mode toggle («headless» / «tmux-панель»), round
  limit. Primary path — attaching to the already-running implementer.
- The spawn dialog (`SpawnAgentButton`) gets a «одразу з флоу» checkbox that
  opens the same config; the flow arms itself once the fresh session appears
  in the scanner.
- One active flow per implementer session; several flows per project are fine.

### Flow strip (the loop at a glance)

The implementer's branch group (`ProjectDashboard` group header area, next to
the existing `GroupCrown`) gains a flow strip:

- Round chips: `R1 ✖5 → R2 ✖2 → R3 ⏳` — number, verdict color (ok-green for
  APPROVE, err-red for REQUEST_CHANGES, amber for COMMENT, pulsing for the
  live round), findings count. Chip click focuses that round in the deck.
- State badge (Ukrainian): «чекає READY», «ревью», «передаю зауваження»,
  «фікси», «затверджено», «потребує рішення», «пауза».
- Controls: Auto/Manual toggle, «Пауза»/«Продовжити», «Почати ревью» (in
  `waiting_ready`), «Ще коло» (in `done_comment`), overflow menu with
  «Закрити флоу».
- In Manual mode the pending transition renders as a prominent action button
  on the strip («Заспавнити ревьюера», «Передати зауваження»).

### 3D round deck

The reviewer position in the implementer's group is a single deck component
replacing what would otherwise be N separate reviewer columns:

- **Layout**: the front card is a `BranchPane` (existing component — feed and
  header). Headless runs write transcripts too (`codex exec` under the codex
  sessions root, `claude -p` under the claude projects root), so the scanner
  picks them up and the feed renders normally; their cards hide the composer
  (a headless run takes no input). In pane mode the live round's card keeps
  the composer — the user can talk to the reviewer. Behind the front
  card, previous rounds render as stacked card
  edges with CSS `perspective` / `translateZ`/`translateY` offsets — each
  showing a slim tab: round number, verdict glyph, verdict color. Depth of
  the stack = loop history in one glance.
- **Swap**: clicking a tab animates that round's card to the front; the
  displaced card returns to its slot in the stack. Reuse the FLIP utilities
  (`FlipRow.tsx` / `useFlip.ts`) for the transition; respect
  `prefers-reduced-motion` (fall back to an instant swap).
- **Finished rounds**: a front card for a finished round shows a badge
  («Раунд 2 · ✖ REQUEST_CHANGES»); the session can still be opened fully via
  the existing `#f=` deep link from the card header. The review card inside
  the feed is the existing `parseReview` rendering — no new findings UI.
- **Live tab pulse**: while an older round is at the front and the live round
  has transcript activity, the live round's tab pulses (existing `live`
  green pulse token). One click returns to it.
- **Claiming**: reviewer sessions belonging to a flow are claimed by the deck
  and excluded from `buildBranchGroups`' normal column flow (extend
  `projectModel.ts` with the flow annotations from `/api/files`), so they
  never appear twice. Deck front-card selection is ephemeral client state
  (deliberately NOT persisted — on reload the live round is in front).

### Switchboard / attention model

`useSwitchboardData` learns flow states: `needs_decision`, `spawn_pending`,
`relay_pending`, `approved` (fresh), and `paused` classify the implementer's
conversation under «Чекає тебе» with a flow-specific subtitle («флоу:
потребує рішення — ліміт раундів», «флоу: затверджено ✓»). `reviewing` and
`fixing` stay under «Працюють».

## Edge cases

- **Viewer restart**: flows load from `flows.json`; the first tick reconciles
  each flow against reality. Headless reviewer processes are children of the
  viewer, so a flow that was `reviewing` has lost its process: if the round's
  artifact file already exists, the verdict is picked up as usual; else the
  transcript fallback is tried; else the flow moves to `needs_decision`
  («повторити раунд»). Pane-mode reviewers live in tmux and survive the
  restart — the flow just re-attaches and keeps watching the transcript. No
  transition is replayed twice: every action (spawn, relay) is recorded in
  the Round before execution and checked on tick.
- **Reviewer fails** (non-zero exit, killed pane, or timeout): flow →
  `needs_decision` with a «повторити раунд» action (starts a fresh reviewer
  in the flow's `reviewerMode` for the same round number; the dead run's card
  stays in the deck marked «перервано», a stderr tail surfaced on the strip
  for headless runs).
- **Implementer dies**: flow → `paused` with a banner; the existing resume
  flow (`resumeSpecFor`) revives the session, after which Resume re-arms the
  flow against the resumed transcript path (update `implementerPath` via the
  existing compaction/resume linking in `links.ts`).
- **Marker false positives**: line-anchored regex + only-last-assistant-message
  + newer-than-last-round guards (see Marker protocol). The kickoff message
  itself contains the marker string — that message is user-role, and detection
  only reads assistant messages.
- **`REVIEW_READY` while a round is already running**: ignored; the running
  round finishes first. The full-range diff (decision 4) makes the next round
  cover whatever the implementer added meanwhile.
- **Verdict unparseable** (reviewer finished, but neither the captured output
  nor the transcript fallback yields a valid `VERDICT:`): flow →
  `needs_decision`, strip shows «вердикт не розпізнано», with actions
  «повторити раунд» / «закрити»; the raw output is still saved as the round
  artifact for inspection. Never guess a verdict.
- **User chats with the implementer mid-review**: allowed and unmonitored; the
  engine only reacts to markers and verdicts. The relay send uses the same
  pane-busy checks as today's `TmuxComposer` queue so it never types over an
  active prompt.
- **tmux gone**: kickoff/relay sends to the implementer fail cleanly
  (existing error paths), flow → `paused` with the error surfaced on the
  strip. Reviewer rounds don't touch tmux at all.
- **Round limit reached**: after the Nth `REQUEST_CHANGES` relay the flow
  parks in `needs_decision` instead of `fixing`→`waiting_ready`.

## Deferred (explicitly not in v1)

- Additional flow templates (plan→implement→review, test-writer roles) and any
  template editor UI — the engine is shaped for them, nothing more.
- Visualizing native Claude Code Workflow runs (phases, fan-outs) with the
  deck/strip visual language — separate spec; the artifact format is
  third-party and unstable.
- Preset editor UI (JSON file editing is the v1 path).
- Viewer-side finding triage / dismiss buttons (decision 6 puts triage in the
  implementer; revisit only if convergence proves poor in practice).
- Multi-reviewer panels per round, verdict voting.
- git/gh automation on APPROVE (commit, push, PR creation) — the implementer
  owns its git actions.
- Claude-engine effort flag (add when the CLI exposes one).
- Web Push notifications for flow states (piggybacks on the notification work
  in the agent-questions spec once both exist).

## Verification gates

- `bunx tsc --noEmit && bun run lint && bun run build` after every work item.
- Visual iteration with `agent-browser` against a dev server, including: a
  3-round flow with mixed verdicts (deck stacking, swap animation, tab pulse),
  Manual mode pending-action buttons, `needs_decision` at the round limit,
  and a viewer restart mid-`reviewing`.
- UI strings in Ukrainian, matching the existing tone («Чекає тебе»,
  «Працюють»).
