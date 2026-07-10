# Review loops

The viewer can orchestrate an implement→review cycle for any conversation it
tracks: one long-lived **implementer** agent writes code in a tmux pane, a
fresh **reviewer** session audits the full diff each round, findings flow back
to the implementer automatically, and the cycle repeats until the reviewer
approves. Every round gets a brand-new reviewer with no memory of earlier
rounds, so each verdict is an independent look at the code.

## Starting a flow

Open a project's scheme view and click the **Flow** chip above a conversation
pane. The "Start a flow" dialog makes that conversation the implementer and
asks for:

- **Preset** — an engine/model/effort pair for each role. Seeded presets put
  GPT-5.6-Terra on implementation and GPT-5.6-Sol on adversarial review, with
  Fable and Sonnet combinations available alongside them. Edit or add your
  own in `~/.config/agent-log-viewer/state/review-loop-presets.json`. Records
  carrying `managed: "role-registry"` (seeded presets and workflow templates)
  regenerate from the role registry on every load — a hand edit survives only
  after removing that flag, which turns the record into a custom entry that
  shadows the seed of the same name.
- **Base** — the git ref reviews diff against: current `HEAD` or the
  merge-base with the default branch. Captured once, so later rounds re-check
  earlier fixes across the whole range.
- **Auto / Manual** — auto runs every transition by itself; manual stops at
  each step and waits for a click.
- **Reviewer mode** — headless (one-shot `codex exec` / `claude -p`, edit
  tools disabled, nothing to clean up) or pane (an interactive tmux agent you
  can watch and interrogate).
- **Round limit** — a forced pause after N rounds (default 5), extendable.
- **Specification and acceptance criteria** — optional pinned review context,
  stored with the flow and shown to every fresh reviewer. Leave it blank and
  the kickoff asks the implementer to create `spec.md` before its first
  `REVIEW_READY:` marker.

## How a round runs

1. The implementer prints a line starting with `REVIEW_READY:` when it
   considers the work reviewable (the flow strip also has a manual trigger).
2. The engine spawns a fresh reviewer over `git diff <base>...HEAD` plus
   uncommitted changes. The reviewer runs read-only.
3. The verdict lands in
   `~/.claude/viewer-state/flows/<id>/round-<n>-review.md` — first line
   `VERDICT: APPROVE | REQUEST_CHANGES | COMMENT`, findings below.
4. Findings relay verbatim to the implementer, which answers each one with
   `FIXED` or `REJECTED — <reason>`, then prints `REVIEW_READY:` again.
5. `APPROVE` ends the flow green; `COMMENT` ends it with a "one more round"
   option; the round limit parks it until you extend or close.

Past rounds stack behind the current one as a deck in the scheme view — pull
any round forward to read it.

## Automation API

Everything the UI does is plain HTTP against the local server:

- `GET /api/flows` — flows and presets.
- `POST /api/flows` — create: `{implementerPath, preset?, roles?, baseMode,
  spec?, mode, reviewerMode, roundLimit}`.
- `PATCH /api/flows/<id>` — `{action: pause | resume | set-mode | advance |
  retry-round | cancel-round | extend | another-round | close}`. `advance`
  and `retry-round` accept an optional `note` the next reviewer sees as the
  round's ready note; `cancel-round` stops a running reviewer (kills the
  headless process or the reviewer pane) and parks the round in
  `needs_decision`; `set-round-limit` sets the absolute limit via `rounds`
  (0 = unlimited, never below the rounds already run). In the UI these are
  the “Stop” button, the note field and the 1–5/∞ limit picker on the flow
  strip. `close` also stops a still-running reviewer, so the strip's ✕ is a
  one-click teardown of the reviewer side; the UI applies it optimistically.

A ready-made Claude Code skill for driving flows agent-side ships with the
repo at `.claude/skills/review-loop/` — agents working in a clone pick it up
automatically.

## Troubleshooting

- **"reviewer process is missing after server restart"** — a dev-server
  reload dropped the headless reviewer from tracking. If its process still
  runs, wait for it to finish and the transcript fallback will pick the
  verdict up; otherwise use **Retry round**.
- **"reviewer verdict was unparseable"** — open the round artifact. A quota
  banner instead of a review means the reviewer engine hit its usage limit;
  switch the reviewer role and retry the round.
