---
name: llv-conveyor
description: The full issue→implement→review→merge→deploy conveyor for Agent Log Viewer — checkpoint loop, lane lifecycle, merge bars, deploy protocol, resource guard, and recovery playbooks. Use when orchestrating multi-lane development on this repo, running long autonomous sessions, or recovering from crashes/stuck reviews. Builds on live-log-viewer-orchestration (spawn/messaging) and review-loop (flow mechanics).
---

# LLV conveyor — autonomous multi-lane pipeline

The orchestrator (a long-lived Claude session in `~/.agents/tools/live-log-viewer-next`) drives every open issue through: **issue → worktree lane → implementer agent → review flow → merge on APPROVE → batched deploy → cleanup**. It self-paces with ScheduleWakeup checkpoints (1200–1800s; each wakeup prompt carries the full state so the loop survives compaction).

## Lane lifecycle

1. **Issue** with full spec on GitHub (`agent: *` label names the owner model — table in live-log-viewer-orchestration). Bodies with control chars → write file, `--body-file` (or REST `gh api -X POST repos/.../issues -f ...` when GraphQL is rate-limited).
2. **Worktree**: `git worktree add ../llv-<slug> -b agent/<issue>-<slug> origin/main` (fetch first).
3. **Spawn implementer** via `POST 127.0.0.1:8898/api/spawn` — engine/model per label, `src` = orchestrator transcript (lineage), prompt in English ending with the contract: `FINAL message exactly: REVIEW_READY: <PR url>`, NON-DRAFT PR, tsc+tests must pass, scope fences ("do NOT touch src/lib/{flows,agent,runtime}" for UI lanes).
4. **On REVIEW_READY**: bind a flow (`POST /api/flows` — implementerPath = transcript; for codex the **botfatherdev account-root copy** is the registry head under dual-root duplication; codex ≥0.144 puts `cwd` directly at `payload.cwd`). Reviewer: `gpt-5.6-sol` xhigh headless, roundLimit 5, baseMode merge-base, mode auto. 409 "already has an active flow" → find and resume/advance the existing one (the user also binds flows from the UI).
5. **Round policing each checkpoint**: read newest `~/.config/agent-log-viewer/state/flows/<id>/round-N-review.md`; compare the round's `reviewHeadSha` (in `state/flows.json` rounds[]) against `git -C <worktree> rev-parse HEAD`. Stale sha + newer commit → `retry-round`. Verdict file missing/unparsed → `retry-round`; twice-failed silently → out-of-band review (below). `needs_decision`/`paused` after APPROVE happens (e.g. "agent registry is busy") — verdict still counts if sha == HEAD.
6. **Merge on APPROVE at head** per the bar (below): `gh pr merge --squash` or REST `gh api -X PUT repos/.../pulls/N/merge -f merge_method=squash`.
7. **CLEANUP ONLY AFTER `state == MERGED`** (burned 4×): kill panes → `git worktree remove --force` → `branch -D` (worktree before branch). Close the flow if the engine left it open.
8. **Deploy in batches** (below), then PATCH the viewer task cards (`/api/tasks/<uuid>`) — the user tracks progress on the board, never in internal task lists.

## Merge bars

- **DATA bar** (runtime/flows/agent/scanner/data-integrity): clean APPROVE required; extend rounds (`extend {rounds:N}`) up to ~9–13 instead of merging with findings.
- **UI bar** (components/styling/mobile): 5–7 substantive rounds; if only non-core/cosmetic findings remain → merge + file a follow-up tail issue quoting the verdict verbatim. Post-approval trailing commits that are tests/comments/screenshots only → merge without another round.

## Out-of-band review (flows API unusable for a lane)

When the implementer transcript is gone or the engine can't run rounds: spawn a fresh headless Sol xhigh **reviewer pane** per round via /api/spawn (cwd = lane worktree; **`src` = the IMPLEMENTER's transcript path**, never the orchestrator's — lineage must draw the reviewer under its implementer, and once #192 lands pass `role:"reviewer"` + `reviews:<implementer ref>` instead; prompt: verify previous round's findings fixed + fresh full-diff vs merge-base; mandatory output `VERDICT: APPROVE|REQUEST_CHANGES` + reviewed HEAD sha + severity-tagged findings; "do not modify the repository"). On REQUEST_CHANGES: save pane verdict to a scratchpad file, relay to the implementer pane via `tmux send-keys -l "<short summary + file path + fix/push/REVIEW_READY round N+1 instruction>"`, then Enter after ~2s and a 2nd Enter (verify with capture-pane: composer cleared / "Working"). Kill the reviewer pane; fresh one next round.

## Deploy protocol

`sg docker -c "cd ~/.agents/tools/live-log-viewer-next && git pull --ff-only && scripts/rebuild.sh"` (timeout 600000). Phases end with `deployment phase: succeeded`. Then ALWAYS:
1. `curl 127.0.0.1:8898/` → 200 (first hit after promote can take ~25s cold).
2. **Remove the outgoing container** — promotion leaves it running (bug, #137): keep only the container named in `~/.config/agent-log-viewer/state/viewer-release.json`.
3. Topology: runtime-host container owns the **8898 proxy** → promoted `llv-deploy-*` on its candidate port. The legacy `agent-log-viewer.service` must stay stopped (its gnome autostart is disabled with `Hidden=true`); if it grabs 8898 the runtime-host crash-loops on bind.
4. Remind the user to hard-reload the tab (stale client after deploy causes phantom UI behavior).
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

- **Machine reboot**: check `viewer-release.json` container running; runtime-host owns 8898 (see deploy §3); panes are gone but worktrees survive — respawn implementers with "continue from git status/diff in this worktree" prompts; rebind flows to surviving transcripts; `advance` starts a round without the REVIEW_READY marker for offline implementers.
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
