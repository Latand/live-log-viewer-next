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

**Placement**: a persistent button in the overview board header
(`OverviewBoard.tsx`), next to the board title — the board is the one screen
every session starts on, so the orchestrator is always one tap away. On the
phone the same header row hosts it with a ≥44px tap target.

**What opens**: the orchestrator is a *normal viewer conversation* — a Claude
session spawned into a tmux pane, whose transcript renders through the existing
conversation surface (`BranchPane` → `LogFeed` + `TmuxComposer`). No bespoke
chat widget: the button resolves the orchestrator conversation and navigates to
its canonical deep link (`#c=<conversationId>`), which `Viewer.tsx` already
knows how to resolve, pin, and open. Reusing the pane means images, dictation,
composer relays, activity states, and attention all work day one.

**Persistence / single instance**: a small state record
(`state/orchestrator.json`, via `statePath`) stores the orchestrator's
`conversationId` + transcript path. The button's flow:

1. `GET /api/orchestrator` → `{ record, exists, defaultCwd }`.
2. Record exists and its transcript is still on disk → navigate to
   `#c=<conversationId>` (Viewer resumes the same conversation — this is what
   survives viewer restarts).
3. No record (or transcript deleted) → `POST /api/spawn` with the orchestrator
   preset (below), then `POST /api/orchestrator` to adopt the new conversation.
   Adoption is first-write-wins: if another tab adopted a different
   conversation meanwhile, the server returns the canonical record and the
   button navigates there instead.

## Runtime identity

- **Engine/model/effort**: Claude **Fable**, reasoning **low** (issue default;
  configurable later via the role registry overrides). Fable-low keeps the
  always-on brain cheap; it escalates by *spawning* higher-effort workers, not
  by thinking harder itself.
- **Role preset**: the `orchestrator` role from the #35 registry
  (`src/lib/roles/defaults.ts`), `mode: standard`. The spawn route prepends the
  role scaffold; the button appends the built-in system prompt
  (`src/lib/orchestrator/prompt.ts`) that encodes the conveyor rules and the
  draft-only contract.
- **Working directory**: the viewer's own checkout (`process.cwd()` of the
  server, reported by `GET /api/orchestrator` as `defaultCwd`) — the
  orchestrator lives inside the viewer and finds the `llv-conveyor` skill
  there.
- **Spawn path**: the browser POSTs `/api/spawn` same-origin, i.e. an
  authenticated Viewer operator spawn (#212) — no capability header needed.
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

## Implemented in this PR (minimal slice)

- `src/lib/orchestrator/prompt.ts` — spawn config (fable/low/`orchestrator`
  role) + system prompt with conveyor rules and the draft-only contract.
- `src/lib/orchestrator/store.ts` — the single-instance record
  (`state/orchestrator.json`), first-write-wins adoption, replace-when-deleted.
- `src/app/api/orchestrator/route.ts` — `GET` (record + liveness + default
  cwd), `POST` (adopt).
- `src/components/OrchestratorChatButton.tsx` — the board-header button:
  resolve → (spawn + adopt) → navigate to `#c=…`. en+uk strings, 44px tap
  target on mobile, tokens only.
- Wired into `OverviewBoard.tsx`.

## Follow-up issues (out of scope here)

1. **Durable claim lock for spawn races** — a pending-claim token with TTL in
   the orchestrator store so two tabs pressing the button concurrently cannot
   spawn two panes (today the loser's pane is visible and killable, but it is
   an orphan).
2. **Resume-on-restart** — supervisor-side check that re-attaches or respawns
   the orchestrator session (`claude --resume`) after a viewer/host restart,
   instead of waiting for the next button press.
3. **On-scheme presence** — the orchestrator as a first-class node on the
   scheme (wedge-in placement near the viewed area or a reserved spot), its
   spawned agents/pipelines visually linked; coordinate with #183 semantic
   zoom.
4. **Configurable identity** — surface model/effort/mode overrides through the
   role-registry overrides UI instead of the hardcoded fable/low.
5. **Spawn capability for its own children (#213)** — once the orchestrator
   holds `LLV_SPAWN_CAPABILITY`, drop the same-origin-header workaround from
   the conveyor skill and prompt.
6. **All-projects task sync** — the triage loop that watches every project,
   creates GitHub issues, and binds them to pipelines (requirement 3 of #182)
   — needs the #189 draft flow plus task-card write APIs exercised end to end.
7. **Orchestrator health surface** — board indicator when the orchestrator
   pane died or its transcript went stale, with a one-tap respawn.
