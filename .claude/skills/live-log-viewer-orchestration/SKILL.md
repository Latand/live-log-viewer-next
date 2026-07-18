---
name: live-log-viewer-orchestration
description: Spawn, message, and monitor Claude/Codex agents through Agent Log Viewer, the machine's one management surface. Use when launching a worker or reviewer agent, messaging or resuming an existing agent conversation, reading what the operator currently sees on the board, starting an implement→review flow, or working in ~/.agents/tools/live-log-viewer-next.
---

# Agent Log Viewer — orchestration

Agent Log Viewer (`~/.agents/tools/live-log-viewer-next`) is the user's dashboard for every coding agent on this machine. The prod instance runs at **`http://127.0.0.1:8898`**; its HTTP API is the management surface for agents.

## Hard rules

- **One management surface.** Every agent you start must appear in the viewer: a tmux pane or viewer-owned structured host, plus a transcript the scanner picks up. Detached background-job runtimes (`codex-companion.mjs task`, plugin rescue subagents) create an invisible second control channel — spawn through the viewer instead.
- **API-first.** While the prod viewer is up, all agent interaction — spawn, message, interrupt, kill, flows — goes through its API, which gives the delivery queue, receipts, and idempotency the user watches in the UI. If the probe `curl -sS http://127.0.0.1:8898/api/files >/dev/null` fails, the viewer is down: follow [references/tmux-fallback.md](references/tmux-fallback.md) exactly — it is the complete manual procedure for spawning and messaging over raw tmux.
- **Port 8898 only.** 8899 is a dev/scratch build (`bun dev` default): the user never watches it, and sends to it fail silently the moment it stops. Real spawns, messages, flows, and task actions go to 8898 even when 8899 appears to work.
- **Spawn fresh + empty.** Hand every helper its whole job as the first prompt. Fork (context-inheriting) agents only when the user explicitly asks for a fork this turn — forked agents carry your context and skip the actual task.
- Prompts to agents: English. Codex effort is set at boot (`-c model_reasoning_effort=...`), never mid-conversation.
- **Pipeline boundary.** A session running as a pipeline stage never starts another pipeline or helper. It returns `needs_decision` with the required follow-up. The owning orchestrator materializes that work through the Pipeline API.
- **Prompt = role + scope, nothing else.** Never name the model or reasoning level in the prompt text ("Act as Sol xhigh reviewer" is wrong twice: effort is a launch parameter that words cannot enable, and the model already knows what it is). Write the role — "You are a fresh-context Reviewer. …" — and pass model/effort only as spawn parameters.
- Review fan-out is budget-bound: Fable runs at most 1–2 independent review passes; swarms of 5+ reviewers are Sol-only and must run as visible pipeline stages.
- **Reviewer isolation (#393).** Reviewer and verifier roles perform every assigned check inside their own single session and have zero child-launch capability: they never launch helpers, workflows, teams, swarms, native subagents, Viewer children, or MCP children. Multiple review perspectives are always explicit visible pipeline stages, never fan-out from inside a review session.
- **Bounded delegation (#393).** Roles that may delegate (builder, architect, orchestrator) spawn only through the Viewer with lineage recorded (`src`, plus `role`/`reviews` where applicable) and keep the delegation chain within the configured maximum depth — initially two.
- After a worker finishes, keep its session/window: the user inspects and kills it from the UI.
- One orchestrator per file set: while a worker runs, monitor it and review its diff afterwards instead of editing the same files yourself.

## Choosing the agent

Templates map 1:1 to `agent:*` labels on GitHub issues (`Latand/live-log-viewer-next`) — a labeled issue already names its owner.

| Template (engine) | Use for | Avoid |
|---|---|---|
| **GPT-5.6-Sol** (Codex) | Visible review swarms of five or more reviewers (Viewer pipeline stages) and tasks the operator explicitly assigns to it | Default ownership of LLV UX/UI or Viewer bug work — that is Fable's |
| **GPT-5.6-Terra** (Codex) | Well-scoped implementation when the operator explicitly assigns it; parked otherwise | Unassigned pickup, open-ended design |
| **Opus 4.8** (Claude) | Frontend styling, icons, visual polish outside LLV | Bug-finding, deep logic |
| **Fable 5** (Claude) | All LLV UX/UI and Viewer bug investigation, implementation, and review; planning/architecture; orchestrator/advisor | — |
| **Sonnet 5** (Claude) | Web/docs research, lightweight tasks (Haiku 4.5 for cheap throughput) | Deep design/review |

Assignment defaults: all LLV UX/UI and Viewer bug investigation, implementation, and review go to Fable by default. Sol is reserved for visible review swarms of five or more reviewers and for explicit operator exceptions. Research goes to Sonnet, and Terra stays parked until the operator explicitly assigns a task to it. Fable runs at most one or two independent review passes on any change.

**Review-pass policy (#381).** Fable performs at most **one or two independent review passes** on any change. A review swarm of **five or more reviewers is Sol-only** and runs as declared Pipeline API stages the operator sees on the board. Structured Fable hosts deny the native Claude multi-agent tools (`Task`, `Agent`, `Workflow`, `TeamCreate`, `TeamDelete`, `SendMessage`); the owning orchestrator materializes each pipeline helper through the Pipeline API with durable lineage.

**Reviewer isolation and bounded delegation (#393).** An agent spawned as a **reviewer or verifier** does all of its assigned checks itself, inside that one visible session — it must never launch helpers, workflows, teams, swarms, native subagents, Viewer children, or MCP children. If a review needs more coverage or another perspective, the reviewer reports that in its verdict and the orchestrator adds an explicit pipeline stage the operator can see. Roles that are allowed to delegate (builder, architect, orchestrator) record lineage on every spawn and obey the configured maximum delegation depth, **initially two** (e.g. orchestrator → builder → helper; nothing deeper). Product enforcement of these limits is tracked in #393.

## Spawning

`POST http://127.0.0.1:8898/api/spawn` with `{"engine":"codex|claude","model":"<model>","cwd":"<abs dir>","prompt":"<first message>","src":"<your own transcript path>"}` (same-origin: call from localhost without an Origin header).

For generic callers, `src` stays optional. An explicit `src` wins; omission triggers silent caller inference; an unmatched external caller may create a root card. Orchestrators always supply `src` so the intended parent is deterministic and auditable. `src` records lineage in `~/.config/agent-log-viewer/state/handoff-lineage.json`.

### Mandatory pipeline spawn contract

Every implementer, recovery worker, helper, verifier, and reviewer associated with pipeline work runs as a Pipeline API stage. The owning orchestrator creates the pipeline through `POST /api/pipelines`, retries a parked clean stage through `PATCH /api/pipelines/<id>` with `{"action":"retry-stage"}`, or creates an explicit successor pipeline from a committed head when the prior container is terminal. Direct generic `/api/spawn` calls serve work with no pipeline identity.

`retry-stage` resets the worktree to `lastPassedCommit` and cleans untracked files. Require a clean worktree or explicit operator authorization for that rollback. A dead host that leaves a dirty worktree stays `needs_decision`; preserve the diff and use the recovery-stage adoption path tracked in #387 when available.

When creating a pipeline, the orchestrator passes its transcript as `src`. The pipeline controller then reserves a stable `pipeline_<id>_<stage>_<attempt>` identity and writes the parent edge plus pipeline membership before launching the structured host.

A pipeline stage spawn is accepted only after all of these checks pass:

1. `/api/pipelines` exposes the attempt with its `launchId`, `conversationId`, and `agentPath`.
2. `/api/files` exposes that same path with `durableLineage.parentConversationId` equal to the intended parent.
3. The same `/api/files` row carries the expected pipeline `containerId`, `stageId`, `slot`, role, and round membership.
4. `viewer.snapshot` for the operator active project includes the conversation path in the rendered view. Keep the snapshot response together with the matched `/api/files` lineage row as the grouping evidence.

If the operator view is absent, points at another project, or omits the card, the spawn remains unverified. Open the pipeline project and repeat `viewer.snapshot` before reporting the stage as done. Issue #387 tracks structural parent/container fields in the snapshot response itself.

## Messaging an existing agent

```
TOK=$(tr -d '\n' < ~/.config/agent-log-viewer/token)
curl -sS -X POST "http://127.0.0.1:8898/api/tmux?k=$TOK" \
  -H 'content-type: application/json' \
  -d '{"path":"<transcript path>","text":"...","clientMessageId":"<stable-id>"}'
```

- `path` is the conversation transcript (Claude `~/.claude/projects/**.jsonl`, Codex `~/.codex/sessions/**.jsonl`); the viewer resolves it to the live pane or respawns a resume window.
- `clientMessageId` makes retries idempotent; give each distinct message its own id — reusing one across different messages fails with `Idempotency key already belongs to another request`.
- Receipt outcomes: `delivered-to-live | queued | delivering | delivered | resumed | held`. Delivery is confirmed when the message appears in the target transcript; replies are readable there too, which makes this endpoint full duplex with any agent.
- Actions on the same endpoint: `{"action":"interrupt"}` (Escape), `{"action":"kill"}`, `{"action":"resume"}`, `{"action":"compact"}`, `{"action":"dialog-key","key":...}`.

**Session ownership.** The viewer tracks which process controls each session. `no-claim` / `structured resume host claim is unavailable` means a live process outside the viewer owns the target session — the viewer correctly refuses to write into it, and the session stays read-only (live tail) until that owner exits. To bring such a session under viewer control, act through the owning process; as a last resort kill it and let the viewer resume the session as its own structured host, after which structured delivery with receipts works.

## Reading the operator's live view

`GET http://127.0.0.1:8898/api/agent` returns the self-describing capability manifest. The `viewer.snapshot` capability — `POST /api/agent/snapshot` with `{"schemaVersion":1}` — returns what the human is looking at right now: active project and view mode, viewport/camera, focused/selected/visible conversation paths in visual order, each conversation's activity and attention state, and bounded secret-redacted transcript text for the requested `scope` (`focused | selected | visible | focused-selected | paths`).

- Multi-device: default picks the latest-interacted view, alternatives listed; pin with `view.id`. `409 AMBIGUOUS_ACTIVE_VIEW` → pick an alternative and retry.
- `404 NO_ACTIVE_VIEW` = nobody is watching (presence is in-memory; it republishes on the next browser heartbeat).
- Snapshots are inert reads — safe to poll before deciding whom to spawn or message.
- Loopback needs no token; remote callers use `Authorization: Bearer <LLV_TOKEN>`.

## Implement→review flows

The viewer runs implement→review cycles itself (spec: `docs/review-loop-ui.md`): long-lived implementer pane + fresh headless reviewer per round, `REVIEW_READY:` marker protocol, verdicts under `~/.config/agent-log-viewer/state/flows/`. API: `GET/POST /api/flows`, `PATCH /api/flows/<id>` (`pause|resume|advance|retry-round|extend|another-round|close`). Pipeline work declares a `review-loop` stage so the controller creates the flow with pipeline membership. Standalone implement→review work may start a flow directly.

## Data roots the viewer watches

| root | path |
|---|---|
| codex sessions | `~/.codex/sessions` |
| claude sessions | `~/.claude/projects` |
| codex plugin jobs | `~/.claude/plugins/data/codex-openai-codex/state` |
| claude bg tasks | `/tmp/claude-<uid>/<slug>/<sid>/tasks/*.output` |

Interactive `claude`/`codex` processes in tmux are auto-matched to their transcripts (fd holders, `--session-id` argv, cwd), so a correctly spawned pane appears in the UI with composer, kill, and interrupt controls.
