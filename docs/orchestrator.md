# The orchestrator

Every project in Agent Log Viewer can designate one agent as its
**orchestrator**. You tell it what you want shipped, in a dock beside the
board; it opens a lane per issue, spawns the implementer, runs a fresh reviewer
each round, merges on APPROVE, and reports back. It works through the Viewer's
own HTTP API and MCP tools, so everything it starts is a card you can open,
read, interrupt or take over.

![The orchestrator dock beside its project board](media/orchestrator-dock.png)

This page walks the whole flow on a fresh install, in the three steps an
operator actually performs: open a project and press **Orchestrator**, tell it
what to ship, and go to the board when an agent needs a decision.

## Before you start

1. **Run the Viewer.** `bunx agent-log-viewer` serves it on `127.0.0.1:8898`
   and supervises the structured runtime host that agents launch through — see
   [Run](../README.md#run). Neither Docker nor tmux is required for this flow.
2. **Register the Viewer MCP server** for the engine that will hold the seat:
   `scripts/install-mcp.sh` from a clone, or the one-line `claude mcp add
   viewer …` / `[mcp_servers.viewer]` snippets in
   [Connect an orchestrator through MCP](../README.md#connect-an-orchestrator-through-mcp).
   The create draft reports what it found — `viewer MCP: registered ✓`, or the
   exact command to run when it finds none. An orchestrator without that
   registration can still talk to you; it cannot drive the board.
3. **Open the project you want driven.** A project is a repository the Viewer
   has seen an agent working in, or one you add with **Create project**. The
   orchestrator spawns its lanes as git worktrees of that checkout.

## 1. Open a project and press Orchestrator

Select the project in the left rail, then press **Orchestrator** in the project
header. The dock opens between the rail and the board and stays that project's
own surface: drag its right edge to resize it, and both the width and the
open/closed state are remembered per project. A phone reaches the same seat
through the orchestrator row pinned in the conversation list.

Until a project has an orchestrator, the dock shows the create draft — and the
draft is already filled in:

- **The mandate is written for you.** It is the versioned default in
  `src/lib/orchestrator/prompt.ts`, delivered as the first message of the new
  conversation: the conveyor rules (issue → lane → implementer → review →
  merge bar → deploy → cleanup), the pipeline stage contract, the two report
  channels, when it may move your screen, and the deploy protocol. You never
  type "you are an orchestrator" anywhere. The text is editable and the summary
  line says which mandate you are on — the built-in version, or your own rules.
  Read the draft's own warning before confirming: under the default mandate it
  deploys on its own unless you edit that out.
- **Engine, model, effort and account** are the same launch controls the
  board's **Create → Agent** draft uses. The draft opens on Claude Opus at low
  effort; change any of it before you confirm.
- **Confirm** designates the seat and delivers the mandate exactly once. The
  designation is recorded before anything is spawned, so a lost reply or a
  reloaded page converges on the one orchestrator instead of creating a second.

One seat per project. It is durable state on the machine, so every window you
open that project in finds the same orchestrator.

## 2. Tell it what to ship

A fresh seat greets you and stops:

```
Ready in <project>.
Tell me what to ship — I open lanes, spawn implementers and reviewers, and
merge on APPROVE. Nothing starts until you ask.
```

Then you talk to it in the dock's composer the way you would message a
colleague: *"take issues 12 and 14"*, *"fix the flaky test in the scanner"*,
*"review PR 30"*. Plain requests are enough; the operating rules are already in
its mandate.

What it does with work you accept:

- **One lane per issue** — a worktree and a branch, one owner per file across
  active lanes, an implementer agent spawned into it with a real task title.
- **A fresh reviewer every round** over the whole diff, findings relayed back
  to the implementer automatically, verdicts as
  `VERDICT: APPROVE | REQUEST_CHANGES`. This is the same machinery the **Flow**
  chip starts by hand — see [docs/review-loop.md](review-loop.md) for the round
  protocol and the presets.
- **A pipeline** when the work wants declared stages: two to four stages in one
  dedicated worktree, each ending in a structured JSON verdict, each transition
  declared through `next` — see [docs/pipelines.md](pipelines.md).
- **The merge bar**: merge on an APPROVE verdict with green gates, never on red.
- **Task cards and reports** kept current as state changes.

Everything it starts shows up on the project board as cards, descending from
the orchestrator's own card, so the board answers "what is running right now"
without anyone being asked. Watch it there, or leave and let the orchestrator
work.

## 3. Go to the board when something needs a decision

The point of the seat is that you stop watching. Four surfaces bring you back,
and all four name the same decision, from the same queue:

- **The dock badge.** The orchestrator's own badge reads `live`, `quiet`,
  `finished` or `host gone` — and `needs you` whenever the attention queue
  counts a wait on this seat, which outranks every other word.
- **A toast**, titled with the decision itself: the question's own header, a
  plan to approve, a permission prompt, a rate-limit wall, or an interrupted
  agent. Opening it lands you on the card.
- **The attention island** in the corner: how many agents are waiting, `N` /
  `Shift-N` to step through them, `F` to show only what waits on you.
- **The card**, where a blocked `AskUserQuestion` renders as a question with
  clickable options and the answer is delivered back into the agent.

An orchestrator that cannot proceed escalates the same way. When it files a
`blocked` or `question` report, that report enters the attention queue as a
hard block on its own conversation — the badge, the toast and the island all
show it, so a manager waiting on you looks exactly like an agent waiting on
you. The report ages out on its own if it stops mattering.

Answer in the dock, and the orchestrator picks the work back up.

## Rotation, when the seat fills up

The row above the conversation says **who** holds the seat: engine badge,
model, effort, account, and its context reading — a percentage of the model's
window when the seat's launch profile names one, the token count when it does
not. Past the rotation threshold — half the model's window — the dock
recommends rotating and carries the server's own reasons verbatim. Two
recorded compactions, a transcript past 8 MB, and a host that is gone each add
a reason of their own.

Press **Rotate**, and the draft opens prefilled with the incumbent's own
parameters. The successor receives the mandate plus a handoff the server
composes: the predecessor's identity and transcript path, the project's open
board tasks, your notes, and one compact **Rotation history** section standing
in for every earlier handoff — so a seat that has rotated a dozen times costs
exactly what a fresh one costs. The predecessor keeps its conversation, its
card and ordinary Viewer access; only its manager authority moves. Both cards
stay linked, and the successor's header links back.

Nothing rotates by itself. Crossing the threshold changes what the dock says
and nothing else.

The mandate itself lands in the feed as a single folded **Mandate** card with
the delivery's line count, and a rotation handoff as its second section — so an
8 KB first message stays one row you can open when you want it.

## What lives where

| Surface | Where | What it is for |
| --- | --- | --- |
| Orchestrator dock | Left of the board, per project | The seat's conversation: who holds it, its context wear, Rotate, and the composer you talk to it in. |
| Board | The project's canvas | Every conversation as a card: the orchestrator, its implementers, each round's reviewer, background tasks. Arrows follow lineage. |
| Pipelines | Groups on the same board, with a control hub | A declared chain of stages in one worktree — pause, resume, retry a stage, skip, close ([docs/pipelines.md](pipelines.md)). |
| Review flows | The **Flow** chip and the verdict deck | Implement → review rounds over a conversation, by hand or driven by the orchestrator ([docs/review-loop.md](review-loop.md)). |
| Tasks | Task cards on the board and the readiness strip | What is planned, running, on review, blocked or done; a task can spawn its own agent. |
| Attention | The corner island, toasts, the dock badge | One queue of everything waiting on you, across every project. |
| Telegram | The left rail's footer row | Connect an account and receive its daily report; independent of the orchestrator's own channels. |
| Phone | The pinned orchestrator row and the focus view | The same seat, the same composer, the same attention queue. |

## Which model does which job

The seat is one agent; the agents it spawns are picked per job. The role
registry ships the presets the conveyor uses, and the mandate tells the seat to
spawn "per the role table":

| Job | Engine and model | Effort | Where it comes from |
| --- | --- | --- | --- |
| The orchestrator seat | Claude Opus | high | `Orchestrator` role preset (the dock's own create draft opens at low) |
| Deep implementation, the hard bugs | Codex GPT-5.6-Sol | xhigh | operator routing |
| UI work | Claude Opus | high | operator routing |
| Design and critique | Claude Fable | high | operator routing |
| Simple, fully specified tasks | Codex GPT-5.6-Luna | xhigh | operator routing |
| Review, every round | Codex GPT-5.6-Sol | xhigh | `Reviewer` role preset |
| Verification, prod audits | Codex GPT-5.6-Sol | high / xhigh | `Verifier`, `Prod-auditor` presets |
| Default builder | Codex GPT-5.6-Sol | medium | `Builder` role preset |
| Cleanups and deploys | Codex GPT-5.6-Terra | low / medium | `Cleaner`, `Deployer` presets |

The presets live in `src/lib/roles/defaults.ts`; a pipeline stage or a flow
role reference resolves through them, and an explicit `engine`/`model`/`effort`
on the stage overrides the preset. Every launch surface offers the same scale
— `low`, `medium`, `high`, `xhigh`, plus `max` and `ultra` where the model has
them.

## When you do not need this

Three tasks a week does not need an orchestrator. Spawn one agent for one task
from **Create → Agent** and talk to it directly: read its transcript, answer
its blocked questions, start a review loop when a change deserves one. The
create draft says as much on its own face.

The seat starts paying off when several things run at once while you are
somewhere else — when you would otherwise be the one remembering which lane
needs a reviewer, which PR is green, and which agent has been sitting on a
question for twenty minutes.

## Where to read more

- [README](../README.md) — install, the MCP server, the CLI options, security.
- [docs/review-loop.md](review-loop.md) — rounds, presets, the HTTP API,
  troubleshooting.
- [docs/pipelines.md](pipelines.md) — stage contracts, verdicts, worktrees,
  recovery.
- [docs/media/README.md](media/README.md) — how every screenshot on this page
  is regenerated from the synthetic demo fixture.
