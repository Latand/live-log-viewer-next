---
name: review-loop
description: Drive Live Log Viewer's implement→review flows — start a review cycle for a conversation, monitor rounds, relay verdicts, and recover stuck rounds. Use when the user asks to run a review loop / review cycle on agent work, wants a fresh reviewer per round, or asks to orchestrate implement→review with the viewer.
---

# Review loops (implement → review flows)

Live Log Viewer ships a flow engine that orchestrates the implement→review
cycle: one long-lived implementer agent writes code, a fresh reviewer session
audits the full diff each round, findings are relayed back automatically, and
the cycle repeats until the reviewer approves. This skill explains how to
drive it from an agent.

The viewer must be running (default `http://127.0.0.1:8898`). All endpoints
are same-origin: call them from localhost without an Origin header.

## Concepts

- **Implementer** — an interactive CLI agent (claude or codex) in a tmux pane,
  tracked by its transcript path. It lives across all rounds.
- **Reviewer** — a fresh session per round, headless by default
  (`codex exec` / `claude -p` with edit tools disabled), so every round is a
  blind, independent look at the full diff.
- **Round scope** — `git diff <baseRef>...HEAD` plus uncommitted changes.
  `baseRef` is captured once at flow creation, so later rounds re-check
  earlier fixes.
- **Marker protocol** — the implementer prints a line starting with
  `REVIEW_READY:` when the tree is reviewable; the scanner detects it and
  starts a round. The implementer answers findings with `FIXED` or
  `REJECTED — <reason>` per item.

## Start a flow

From the UI: open the project scheme, click the «Flow» chip above a
conversation pane → "Start a flow" dialog (that conversation becomes the
implementer).

From an agent:

1. Spawn or pick the implementer conversation. To spawn fresh:
   `POST /api/spawn` `{"engine":"claude"|"codex","cwd":"<abs dir>","prompt":"<kickoff>"}`
   — returns the transcript `path` for claude; for codex, find the newest
   `~/.codex/sessions/**/rollout-*.jsonl` whose `cwd` matches. To set codex
   reasoning effort, boot the pane yourself with
   `codex -c model_reasoning_effort=high` (the spawn API uses engine defaults).
2. Create the flow:

   ```
   POST /api/flows
   {
     "implementerPath": "<transcript path>",
     "preset": "<preset name>",            // or "roles": {implementer, reviewer}
     "baseMode": "head" | "merge-base",
     "mode": "auto" | "manual",
     "reviewerMode": "headless" | "pane",
     "roundLimit": 5
   }
   ```

   A role is `{engine: "claude"|"codex", model: string|null, effort: string|null}`
   (codex effort: low|medium|high|xhigh). `GET /api/flows` lists flows and the
   editable presets (stored in `~/.claude/viewer-state/review-loop-presets.json`).

3. The engine relays its own kickoff protocol to the implementer. Instruct
   your implementer to print `REVIEW_READY:` only when the tree is stable and
   the build is green.

## Monitor and control

- `GET /api/flows` — states: `waiting_ready → spawning → reviewing →
  relaying → fixing → …`, terminal `approved` / `commented` / `closed`, and
  `needs_decision` (with `stateDetail`) when the engine will not guess.
- `PATCH /api/flows/<id>` with `{"action": ...}`:
  `pause`, `resume`, `set-mode`, `advance` (manual-mode transitions or force a
  round from `waiting_ready`), `retry-round` (re-run the current round from
  `needs_decision`), `cancel-round` (stop a running reviewer mid-round; the
  flow lands in `needs_decision`), `extend` (+N rounds at the limit),
  `another-round`, `close`. `advance` and `retry-round` take an optional
  `note` string delivered to the next reviewer as the round's ready note —
  use it to steer a re-review after cancelling.
- Round artifacts: `~/.claude/viewer-state/flows/<flowId>/round-<n>-review.md`
  — first line `VERDICT: APPROVE | REQUEST_CHANGES | COMMENT`, findings below.

## Recovering stuck rounds

- `needs_decision: "reviewer process is missing after server restart"` — a
  dev-server reload killed or orphaned the headless reviewer. Check
  `pgrep -af "codex exec"` first: if the reviewer still runs, wait for it to
  exit, then set the flow state back to `reviewing` (edit
  `~/.claude/viewer-state/flows.json`; the engine is stateless and re-reads
  it) so the engine picks the verdict up from the transcript. If nothing
  survives, `retry-round`.
- `needs_decision: "reviewer verdict was unparseable"` — read the round
  artifact. A usage-limit banner means the reviewer engine ran out of quota:
  switch `roles.reviewer` in `flows.json`, then `retry-round`.
- Round limit reached — `{"action":"extend","rounds":N}` to keep going, or
  `close`.

## Conventions

- Prompts to agents: English.
- One orchestrator: while the implementer fixes, do not edit the same files
  yourself.
- Keep flow panes/windows around after completion; the user inspects them in
  the viewer.
