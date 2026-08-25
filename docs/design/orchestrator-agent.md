# Built-in Orchestrator agent — issue #182, Phase 1

Design + skeleton for the viewer's resident Orchestrator: one long-lived agent
conversation the user talks to, which drives everything else through the
viewer's own API surface. Grounded in the code as of `main` (post-#212/#215):
`src/app/api/spawn`, `src/app/api/pipelines`, `src/app/api/flows`,
`src/lib/roles/defaults.ts` (the #35 role registry), `Viewer.tsx` hash
deep-links, `OverviewBoard.tsx`.

Related vision, explicitly NOT in scope here: #183 semantic-zoom scheme (the
orchestrator's on-scheme node placement lands with that work).

## Chat surface

**Placement**: a project-scoped dock in the left sidebar, between the project
rail and the board. It follows the selected project while the project rail stays
visible. Mobile uses the project's pinned orchestrator row and standard focus
view.

**What opens**: the orchestrator is a *normal viewer conversation*. Its
transcript renders through the existing `LogFeed` + `TmuxComposer` surface in
the dock. Reusing the conversation surface carries images, dictation, composer
relays, activity states, and attention into the panel.

**Persistence / per-project seat**: `state/orchestrator-seats.json` stores one
active seat per canonical project, plus pending intents, revocations, and
rotation history. The sidebar flow:

1. `GET /api/orchestrator/seat?project=…` reads the project's active and pending
   seats.
2. A live active seat opens its conversation in the project's dock panel.
3. An empty or closed seat renders the draft controls. Confirm sends the edited
   mandate and selected engine/model/account to `POST /api/orchestrator/seat`.
4. Rotation sends the successor draft to `POST /api/orchestrator/rotate`; seat
   activation revokes the predecessor and links both conversations.

## Runtime identity

- **Engine/model/effort/account**: initialized from the shared launch defaults
  and editable in the project draft before creation or rotation. Both engines
  and every option supported by the ordinary draft controls remain available.
- **Role preset**: the `orchestrator` role from the #35 registry
  (`src/lib/roles/defaults.ts`), `mode: standard`. The spawn route prepends the
  role scaffold; the seat command delivers the built-in system prompt
  (`src/lib/orchestrator/prompt.ts`) that encodes the conveyor rules and the
  draft-only contract.
- **Working directory**: the selected project's canonical root, resolved by the
  seat command. The draft exposes no cwd field.
- **Spawn path**: the browser posts the draft to `/api/orchestrator/seat`; the
  seat command persists the intent before invoking the ordinary spawn path.
  Once running, the orchestrator's *own* API calls are agent-initiated and
  follow the #212/#213 spawn-capability rules encoded in its prompt.

## Viewer APIs it drives

| API | Use |
| --- | --- |
| `POST /api/spawn` | Spawn implementers/reviewers with `src` = its own transcript (lineage draws the diagram edges) and `role`/`reviews` per the role table. |
| `POST /api/flows`, `PATCH /api/flows/[id]` | Start and drive implement→review flows (rounds, verdict relays). |
| `POST /api/pipelines` (**`autoStart: false` always**) | Compose multi-stage pipelines as **drafts** — see the contract below. |
| `GET /api/files`, `GET /api/agent/snapshot` | Observe board state: conversations, activity, lineage, receipts. |
| `POST /api/tmux` | Relay messages into worker panes (verdict summaries, nudges). |
| `/api/tasks` | Keep task cards updated as work moves through the conveyor. |

Fences: it never touches `src/lib/runtime` internals and never bypasses the
public HTTP APIs above — it holds no in-process references; it IS an API
client that happens to be spawned by the product.

## The DRAFT-only pipeline contract (#189 comment on #182)

The orchestrator **NEVER auto-starts pipelines**:

- "Агент, побудуй мені пайплайн" → it assesses complexity, composes
  stages/roles, `POST /api/pipelines` with `autoStart: false`, and replies in
  chat with the draft id/link.
- The user reviews the draft on the board (editable via the #136 builder) and
  presses **Start** himself (`PATCH /api/pipelines/[id]` `action: start`).
- Auto-start is opt-in per request only — the user must have explicitly asked
  ("і запусти") in the same message.

This contract is written into the system prompt verbatim
(`src/lib/orchestrator/prompt.ts`) and covered by a test asserting the prompt
carries it.

## Conveyor rules in the system prompt

The prompt encodes the `llv-conveyor` loop the resident agent runs:

**issues → worktree lanes → implementer agents → review flows → merge bars
(merge on APPROVE only) → batched deploy → cleanup**, with:

- one lane per issue, one file owner at a time across active worktrees;
- fresh reviewer per round, `REVIEW_READY:` / `VERDICT:` contracts;
- merge bar: green gates (tsc + tests) and an APPROVE verdict before merge;
- status reporting: concise chat replies to the user + task-card updates; it
  reports what it *did* (links, ids, verdicts), not plans.

## How it reports status

Chat-first: the user reads the orchestrator's pane like any conversation.
Every action closes with a compact status line (spawned X → link, draft Y →
id, flow Z round N verdict). Board-native signals stay authoritative:
spawned workers appear with lineage edges under the orchestrator node, flows
show rounds, drafts sit on the scheme awaiting Start. Later phases add the
dedicated scheme node (#183) and push notifications for decision points.

## Current implementation

- `src/lib/orchestrator/prompt.ts` — versioned default mandate with conveyor
  rules and the draft-only contract.
- `src/lib/orchestrator/seats.ts` — per-project active seats, durable pending
  intents, revocations, and rotation lineage.
- `src/app/api/orchestrator/seat/route.ts` and
  `src/app/api/orchestrator/rotate/route.ts` — project-scoped create, status,
  and rotation entry points.
- `src/components/orchestrator/OrchestratorPanel.tsx` — project dock with draft,
  live conversation, liveness, error, and rotation states.

## Follow-up issues (out of scope here)

1. **Resume-on-restart** — supervisor-side check that re-attaches or respawns
   the orchestrator session (`claude --resume`) after a viewer/host restart,
   instead of waiting for the next panel open.
2. **On-scheme presence** — the orchestrator as a first-class node on the
   scheme (wedge-in placement near the viewed area or a reserved spot), its
   spawned agents/pipelines visually linked; coordinate with #183 semantic
   zoom.
3. **Spawn capability for its own children (#213)** — once the orchestrator
   holds `LLV_SPAWN_CAPABILITY`, drop the same-origin-header workaround from
   the conveyor skill and prompt.
4. **All-projects task sync** — the triage loop that watches every project,
   creates GitHub issues, and binds them to pipelines (requirement 3 of #182)
   — needs the #189 draft flow plus task-card write APIs exercised end to end.
5. **Orchestrator health surface** — board indicator when the orchestrator
   pane died or its transcript went stale, with a one-tap respawn.
