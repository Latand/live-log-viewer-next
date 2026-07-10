---
name: live-log-viewer-orchestration
description: One management surface for coding agents on this machine — spawn, message, and monitor Claude/Codex workers the way live-log-viewer does (tmux panes + viewer API), never via detached background-job runtimes. Use when launching worker/reviewer agents, delegating fixes to Codex, continuing an agent conversation programmatically, or working in ~/.agents/tools/live-log-viewer-next.
---

# Live Log Viewer — agent orchestration

The user's agent dashboard is **live-log-viewer** (`~/.agents/tools/live-log-viewer-next`, Next.js app on `127.0.0.1:8898`, start with `bun dev` / `agent-log-viewer`). It tails every agent conversation on the machine and manages agents as **tmux panes**. 

**Core rule: one management surface.** Every helper agent you start must be visible and controllable in the viewer — a tmux pane plus a transcript the scanner picks up. Never launch workers through detached background-job mechanisms (e.g. `codex-companion.mjs task`, plugin rescue subagents): they create a second, invisible control channel the user has explicitly rejected.

**Never fork — always spawn fresh + empty.** When orchestrating, **NEVER** spawn a *fork* agent — one that inherits your conversation/context — unless the user has **explicitly** asked for a fork this turn. Forked agents get confused: they carry your context and don't do the actual task they were meant to. **Every** helper agent (Codex or Claude) is spawned **completely empty** and handed its whole job as a **prompt**. Fresh-empty-plus-prompt is the default, always — for `/api/spawn`, for `/api/tmux` resumes, and for any subagent you launch (never `subagent_type: "fork"`). This is non-negotiable.

**Port rule — ALWAYS `127.0.0.1:8898`.** Every viewer API call (`/api/spawn`, `/api/tmux`, `/api/tasks/*`, `/api/files`, `/api/flows`) must go to the prod viewer on **8898** — the always-on instance the user actually watches. Port **8899** is a dev/scratch build: **never** send real spawns, messages, flows, or task actions there. The trap: if 8899 happens to be up it *appears* to work (both instances watch the same tmux + filesystem, so the effect shows on 8898 too) — but the moment 8899 is down your dispatch **silently fails**, and it is never the surface the user is looking at. `bun dev` defaults to 8899, so don't infer the port from a dev command. When unsure, confirm prod is up first: `curl -sS http://127.0.0.1:8898/api/files >/dev/null && echo 8898-up`. Prefer this HTTP API over hand-rolled tmux whenever the viewer is up — it is the one interface the user has asked agents to drive.

## Agent templates — which model for which job

Pick the agent by the job. These map 1:1 to the `agent: *` labels on GitHub
issues (`Latand/live-log-viewer-next`), so an issue's label already names who
should own it.

| Template (engine) | Use it for | Avoid |
|---|---|---|
| **GPT-5.6-Sol** (Codex, `gpt-5.6-sol`) | Architecture + planning, **bug-finding & diagnosis**, hard logic, adversarial review — the default for critique and decisions. | Mechanical implementation |
| **GPT-5.6-Terra** (Codex, `gpt-5.6-terra`) | Fast, accurate **implementation** and review-fixing of well-scoped tasks. | Open-ended design/architecture |
| **Opus 4.8** (Claude) | **Frontend**: styling, UI, icons, visual polish — it has taste. | Bug-finding, deep logic |
| **Fable 5** (Claude) | **Top tier**: planning/architecture, **UX/UI design**, **reviewing results + adversarial review**; orchestrator/advisor. | — |
| **Sonnet 5** (Claude) | Fast **web/docs research**, lightweight tasks. (Haiku 4.5 for cheaper/faster throughput.) | Deep design/review |

**Issue assignment rule.** Default every issue to **GPT-5.6-Sol** — it plans
everything. Downgrade only when the task clearly doesn't need a top architect:
- UX/UI **design** → **Fable 5**
- Frontend **implementation** / icons / styling → **Opus 4.8**
- **Bug-finding** / diagnosis → **GPT-5.6-Sol xhigh**
- General and mechanical **implementation** → **GPT-5.6-Terra low/high**
- Web/docs **research** → **Sonnet 5**

A *visual/layout* bug belongs to frontend (**Opus**). Known-correct behavior
belongs to the planner or a Codex implementer. Reserve Sol xhigh for diagnosis.

**Review.** Reviews and adversarial passes go to **Fable 5** or **Codex
(GPT-5.6-Sol xhigh)** — never have Opus or Sonnet review Codex's work. See
[[codex-is-the-reviewer]] and the review-loop flow below.

Spawn every one of these **through the viewer** (tmux pane + `8898` API), never a
detached job — the port rule and core rule above still apply.

## What the viewer watches (data roots)

| root | path |
|---|---|
| codex sessions | `~/.codex/sessions` |
| claude sessions | `~/.claude/projects` |
| codex plugin jobs | `~/.claude/plugins/data/codex-openai-codex/state` |
| claude bg tasks | `/tmp/claude-<uid>/<slug>/<sid>/tasks/*.output` |

Any interactive `claude`/`codex` process in tmux is auto-matched to its transcript (fd holders, `--session-id` argv, cwd) — so a pane you spawn correctly appears in the UI with composer, kill and interrupt controls.

## Reading the operator's live view — `viewer.snapshot`

To see **what the human is actually looking at right now** — same board, same device — call the snapshot capability. Discover it first with the manifest:

`GET http://127.0.0.1:8898/api/agent` → self-describing capability list with example calls.

The capability is `viewer.snapshot`:

`POST http://127.0.0.1:8898/api/agent/snapshot` with `{"schemaVersion":1}` (all fields optional). It returns the live browser view: the resolved device/view session and its freshness, the active `project` and view `mode` (`overview`/`scheme`/`list`/`mobile-focus`/`mobile-map`), the `viewport` and `camera`, the `focusedPath`, `selectedPaths`, and `visiblePaths` **in visual order** (freshest-first, left→right on the board), each visible conversation's activity + attention state, the durable board revision, and **bounded, secret-redacted compact text** for the requested scope.

Scope controls only which conversations get text, never membership:

```jsonc
{ "schemaVersion": 1,
  "scope": { "kind": "selected" },        // focused | selected | visible | focused-selected | paths
  "text": { "include": true, "lastMessages": 6, "maxCharsPerConversation": 3000 } }
```

- **Multi-device.** Default resolution picks the **latest-interacted** view and lists the others under `resolution.alternatives`. Pin one with `view.id` / `view.deviceId`. `view.resolution: "require-explicit"` returns **409 `AMBIGUOUS_ACTIVE_VIEW`** when two devices interacted near-simultaneously — pick from the alternatives and retry.
- **Nobody watching / after a server restart.** Returns **404 `NO_ACTIVE_VIEW`** — presence is in-memory and republishes on the browser's next heartbeat. This is honest: there is no live human view to report.
- **Reads are inert.** The snapshot never moves a camera, adds a node, touches board state, or ticks flows/tasks — safe to poll for orientation.
- Loopback needs no token; a remote agent caller uses `Authorization: Bearer <LLV_TOKEN>`. Port rule holds: **always `8898`**.

Use this to answer "what am I looking at, and which of these is blocked" before you spawn or message — then act through `/api/spawn` and `/api/tmux` as below.

## Spawning a new agent

**Preferred — viewer running:** `POST http://127.0.0.1:8898/api/spawn` with JSON `{"engine":"codex","model":"gpt-5.6-terra","cwd":"<abs dir>","prompt":"<first message>","src":"<your own transcript path>"}`. Use `gpt-5.6-sol` for architecture, diagnosis, and review. Same-origin only (call from localhost, no Origin header). **Always pass `src`** when spawning on behalf of a conversation (e.g. your own session): it records lineage in `~/.config/agent-log-viewer/state/handoff-lineage.json`, and the board draws the child under the parent with an arrow. Without it the new agent shows up as an unrelated root — the user treats that as a bug.

**Fallback — viewer not running:** replicate its spawn path (`spawnAgentWithPrompt` in `src/lib/tmux.ts`) with tmux directly:

1. `PANE=$(tmux new-window -d -P -F "#{pane_id}" -t <active-session>: -n <window-name> -c <cwd>)` — pick the active session via `tmux list-clients -F "#{client_activity} #{client_session}"` (freshest wins), fallback `list-sessions`.
2. Type the boot command literally, then Enter:
   - claude: `claude --dangerously-skip-permissions --session-id $(uuidgen)` (+ `--model <m>`); the session-id makes the transcript path knowable: `~/.claude/projects/<cwd with non-alnum → "-">/<sid>.jsonl`.
   - codex: `codex -c model_reasoning_effort=<low|medium|high|xhigh>` (+ `-m <model>`).
3. Poll readiness every ~1s (≤60s): `tmux capture-pane -p -t $PANE`. Ready markers: `? for shortcuts`, `Context N% used`, `⏎ send`, `Press up to edit`. Startup gates (`Do you trust`, `Press enter to continue`, `Resume from summary`) default to the safe option — answer with Enter and keep polling. If the foreground command falls back to a shell, the agent died: read the screen tail for the error.
4. Deliver the prompt as a bracketed paste, never raw send-keys for multi-line text:
   `tmux load-buffer -b <buf> <file>` → `tmux paste-buffer -d -p -b <buf> -t $PANE` → sleep ~0.5s → `tmux send-keys -t $PANE Enter`.
5. Verify submission: if the composer line (last line starting with `❯` or `›`) still shows the prompt head or `[Pasted text`, press Enter again (an extra Enter on an empty composer is a no-op).
6. **Record lineage** so the board links the new agent under its parent: while the viewer is still down, add an entry to the `children` map in `~/.config/agent-log-viewer/state/handoff-lineage.json` — `{"<child transcript path>": "<parent transcript path>"}` (for codex, find the rollout by grepping `~/.codex/sessions/YYYY/MM/DD/*.jsonl` for a prompt fragment). Edit this file ONLY while the viewer is stopped: the running server caches it in memory and overwrites external edits. If the viewer came back up in the meantime, restart it after the edit.

## Messaging an existing agent

**Viewer running:** `POST /api/tmux` `{"path":"<transcript path>","text":"..."}` — it finds the live pane or respawns a resume window (`claude --resume <sid>` / `codex resume <id>`). Actions: `{"action":"interrupt"}` (Escape), `{"action":"kill"}`.

**Direct tmux:** find the pane by walking `/proc` ppid chains to `tmux list-panes -a` pids, then use the same paste-verify procedure. Before sending, check the screen: a shell prompt means no agent; an approval/rate-limit wall means do not paste blindly.

## Review-loop flows (implement→review)

The viewer orchestrates implement→review cycles itself (spec: `docs/review-loop-ui.md` in the repo): long-lived implementer in tmux + fresh headless reviewer per round with approval-free command access and a prompt-level read-only contract, `REVIEW_READY:` marker protocol, verdict files under `~/.config/agent-log-viewer/state/flows/`. API: `GET/POST /api/flows`, `PATCH /api/flows/<id>` (`pause|resume|advance|retry-round|extend|another-round|close`). Prefer starting a flow over hand-rolling your own loop when the task is implement→review.

## Conventions

- Prompts to agents: English. Set codex effort via `-c model_reasoning_effort=...` at boot (it is not settable mid-conversation from outside).
- One orchestrator: while a worker runs, don't edit the same files yourself — monitor the pane (`capture-pane` until `esc to interrupt` disappears) and review its diff afterwards.
- Keep sessions/windows around after completion; the user inspects them in the viewer and kills them from the UI.
