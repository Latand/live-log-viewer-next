---
name: llv-conveyor
description: The full issue→implement→review→merge→deploy conveyor for Agent Log Viewer — checkpoint loop, lane lifecycle, merge bars, deploy protocol, resource guard, and recovery playbooks. Use when orchestrating multi-lane development on this repo, running long autonomous sessions, or recovering from crashes/stuck reviews. Builds on live-log-viewer-orchestration (spawn/messaging) and review-loop (flow mechanics).
---

# LLV conveyor — autonomous multi-lane pipeline

The orchestrator (a long-lived Claude session in `~/.agents/tools/live-log-viewer-next`) drives every open issue through: **issue → worktree lane → implementer agent → review flow → merge on APPROVE → batched deploy → cleanup**. It self-paces with ScheduleWakeup checkpoints (1200–1800s; each wakeup prompt carries the full state so the loop survives compaction).

## Lane lifecycle

1. **Issue** with full spec on GitHub (`agent: *` label names the owner model — table in live-log-viewer-orchestration). Bodies with control chars → write file, `--body-file` (or REST `gh api -X POST repos/.../issues -f ...` when GraphQL is rate-limited).
2. **Pipeline worktree**: pin the fetched base branch and commit in `POST /api/pipelines`; let the Pipeline API provision its dedicated worktree and branch.
3. **Materialize the implementer as a pipeline stage.** Create the owning pipeline through `POST 127.0.0.1:8898/api/pipelines` with `src` set to the orchestrator transcript and the implementer plus review stages declared before Start. The controller mints the stable client attempt ID, parent edge, and durable pipeline membership. A dead-host recovery may use `retry-stage` after a clean-worktree check or explicit operator approval for its hard reset and clean. Preserve a dirty interrupted worktree in `needs_decision` for the recovery-stage adoption path tracked in #387. A terminal container with a committed head gets an explicit successor pipeline with recovery and review stages; prior attempts remain historical evidence. Prompts stay English and end with the required fenced JSON verdict. NON-DRAFT PR, typecheck, tests, and scope fences remain part of the stage prompt. Prompt content is role + scope only; model identity and reasoning level are launch parameters. Never name the model or reasoning level in the prompt text.
4. **Run review through the declared pipeline review stage.** The controller binds the flow to the passed implementer transcript. For Codex, the **botfatherdev account-root copy** is the registry head under dual-root duplication; Codex ≥0.144 puts `cwd` directly at `payload.cwd`. Reviewer: `gpt-5.6-sol` xhigh headless, roundLimit 5, baseMode merge-base, mode auto. A 409 `already has an active flow` resolves through the existing flow followed by resume or advance.
5. **Round policing each checkpoint**: read newest `~/.config/agent-log-viewer/state/flows/<id>/round-N-review.md`; compare the round's `reviewHeadSha` (in `state/flows.json` rounds[]) against `git -C <worktree> rev-parse HEAD`. Stale sha + newer commit → `retry-round`. Verdict file missing/unparsed → `retry-round`; twice-failed silently → park the stage as `needs_decision` and follow Review recovery (below): Pipeline API `retry-stage` when the worktree is clean/safe, or a durable successor stage when preserving dirty recovery work — every recovery reviewer stays inside pipeline membership. `needs_decision`/`paused` after APPROVE happens (e.g. "agent registry is busy") — verdict still counts if sha == HEAD.
6. **Merge on APPROVE at head** per the bar (below): `gh pr merge --squash` or REST `gh api -X PUT repos/.../pulls/N/merge -f merge_method=squash`.
7. **CLEANUP ONLY AFTER `state == MERGED`** (burned 4×): kill panes → `git worktree remove --force` → `branch -D` (worktree before branch). Close the flow if the engine left it open.
8. **Deploy in batches** (below), then PATCH the viewer task cards (`/api/tasks/<uuid>`) — the user tracks progress on the board, never in internal task lists.

## Merge bars

- **DATA bar** (runtime/flows/agent/scanner/data-integrity): clean APPROVE required; extend rounds (`extend {rounds:N}`) up to ~9–13 instead of merging with findings.
- **UI bar** (components/styling/mobile): 5–7 substantive rounds; if only non-core/cosmetic findings remain → merge + file a follow-up tail issue quoting the verdict verbatim. Post-approval trailing commits that are tests/comments/screenshots only → merge without another round.
- **Fable gate on all UI/UX** (owner rule, 2026-07-14): every visual change is either designed by Fable BEFORE an Opus lane starts (design note in the issue), or gets a mandatory Fable critique round when the Opus lane finishes. Never hand Opus a raw user prompt for UI. Fable critiques against rendered screenshots — reuse/extend the demo-capture renderer (scripts/demo-capture*) to shoot the new feature. Don't interrupt mid-work lanes; critique lands at their finish.

## Reviewer isolation & delegation depth (#393)

- **Reviewer and verifier roles are terminal.** Each performs every assigned check inside its own single visible session and has zero child-launch capability: no helpers, workflows, teams, swarms, native subagents, Viewer children, or MCP children — regardless of engine. A reviewer that needs more coverage says so in its verdict; the orchestrator adds a stage.
- **Multiple perspectives = explicit stages.** Extra review angles run as separate visible pipeline stages the operator sees on the board (additional flow rounds or separate reviewer spawns), never as fan-out from inside a review session.
- **Delegating roles stay bounded.** Builder, architect, and orchestrator spawns always record lineage (`src`, plus `role`/`reviews` for reviewer spawns) and keep the delegation chain within the configured maximum depth — initially **two** (orchestrator → builder → helper; nothing deeper). Product enforcement is tracked in #393.

## Review recovery (flows API unusable for a lane)

When the implementer transcript disappears or the engine cannot run rounds, park the owning stage with `needs_decision`. The orchestrator retries the review stage through the Pipeline API or creates a successor pipeline whose first run stage performs one fresh Sol xhigh read-only review and whose final stage verifies the repair. Set pipeline `src` to the orchestrator transcript; record the previous implementer path and conversation ID in the pipeline spec and review directive. Require `VERDICT: APPROVE|REQUEST_CHANGES`, reviewed HEAD SHA, and severity-tagged findings. Reviewer isolation per #393 still holds: the recovery reviewer runs its checks alone and launches nothing. Raw reviewer `/api/spawn` calls have no place in pipeline work.

Before accepting the recovery, join `/api/pipelines`, `/api/files`, and `viewer.snapshot`: the reviewer path must have the expected pipeline membership and parent in `/api/files`, and the active operator snapshot must include that path in the rendered view. Keep the earlier attempts and verdicts as compact history.

## Deploy protocol

`sg docker -c "cd ~/.agents/tools/live-log-viewer-next && git pull --ff-only && scripts/rebuild.sh"` (timeout 600000). Phases end with `deployment phase: succeeded`. Then ALWAYS:
1. `curl 127.0.0.1:8898/` → 200 (first hit after promote can take ~25s cold).
2. **Remove the outgoing container** — promotion leaves it running (bug, #137): keep only the container named in `~/.config/agent-log-viewer/state/viewer-release.json`.
3. Topology: runtime-host container owns the **8898 proxy** → promoted `llv-deploy-*` on its candidate port. The legacy `agent-log-viewer.service` must stay stopped (its gnome autostart is disabled with `Hidden=true`); if it grabs 8898 the runtime-host crash-loops on bind.
4. Remind the user to hard-reload the tab (stale client after deploy causes phantom UI behavior).
5. **Runtime-host protocol changes** (anything under `src/runtime-host/` or new socket methods): rebuild its image too — `docker compose build runtime-host && LLV_VIEWER_DEPLOYMENTS=1 docker compose up -d runtime-host` (WITHOUT `LLV_VIEWER_DEPLOYMENTS=1` the recreate silently drops the 8898 proxy). Stale runtime-host symptom: viewer logs `runtime request method is unsupported`.
6. Since the #194 cutover (2026-07-14) spawns are pane-less (`LLV_SPAWN_TRANSPORT=structured`, `target:null`); tmux is attach-only legacy. Module-level singletons in route-reachable code MUST live on `globalThis` (Next standalone bundles instrumentation separately — in-process tests can't catch it). `docker logs` survives restarts — use `--since` to check whether a restart cleared an error. First Claude structured spawn after a deploy may time out (cold broker) — retry once.
Batch merges into one deploy; deploy immediately for user-blocking fixes.

## Resource guard (every checkpoint — the machine has OOM'd)

- `free -h`: available < 4–6G or swap > 30% → act. Kill ONLY orphaned MCP processes (`ppid=1`, etime > 2h). Live panes' MCP fleets belong to the user — never kill them; suggest closing finished panes instead.
- `pgrep -c -f "codex exec"` > ~7 → investigate. Cap concurrent codex xhigh reviewer rounds at ~2 (brief 3 OK when >10G free).
- Root causes already fixed (keep them true): #162 headless codex runs with `mcp_servers={}` + process-group kill + reaper + probe backoff; #168 integration tests use isolated temp homes.

## Data safety (hard rules, learned the hard way)

- **NEVER delete transcripts/user data without explicit per-batch user confirmation** — present the candidate list first. Identify fixture transcripts ONLY by their first user prompt; never body-grep (real sessions quote test markers).
- Deleted-but-open transcripts are recoverable: `(deleted)` rollout links in `/proc/<pid>/fd/` → copy fd content back to the path; re-sync while the session lives (fd size > file size → overwrite).
- Conversations with ≥1 human-authored message are untouchable, always.

## Recovery playbooks

- **Machine reboot**: check `viewer-release.json` container running; runtime-host owns 8898 (see deploy §3); panes are gone while worktrees survive. Inspect each pipeline worktree first. Clean parked stages may use `retry-stage`; dirty stages stay `needs_decision` and retain every byte for the #387 recovery-stage adoption path. Rebind flows to surviving transcripts; `advance` starts a round without the REVIEW_READY marker for offline implementers.
- **Controller hang** (all flows `spawning`, no logs, 0 codex exec): `docker restart <current llv-deploy>` → 8898=200 → retry-round each.
- **"agent registry is busy"** (accounts UI dead, flows pausing): transient lock contention (#179) — retry the operation; flows that approved mid-error still count, close stale flows of merged PRs.
- **Claude spawn lands on login screen**: account with dead token selected (#178) — kill pane, respawn with explicit `accountId`; re-login via `CLAUDE_CONFIG_DIR=~/.config/agent-log-viewer/accounts/claude/<id> claude` + `/login`.
- **codex CLI self-update mid-spawn** (spawn 500s, pane says "restart Codex"): kill pane, respawn; expect rollout format drift after updates (e.g. 0.144 moved `cwd` to `payload.cwd`).
- **GraphQL rate limit exhausted** (agents share 5000/hr): everything has a REST equivalent — `gh api repos/...` for view/merge/issues/comments.

## Interaction rules

- User messages (UA/RU, often dictated) override the current checkpoint plan — his active complaint becomes the top lane immediately.
- Every user-visible defect gets a GitHub issue with the diagnosis baked in, then a lane; answer the user with cause → what's already done → what ships next.
- Board cards (`/api/tasks`) are the single user-facing progress tracker: PATCH on merges/deploys, `status: "done"` when shipped.
- zsh traps: unquoted `$VAR` does not word-split (use explicit loops); `=====` needs quoting; heredocs for anything with braces.
