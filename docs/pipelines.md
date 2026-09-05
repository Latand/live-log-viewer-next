# Linear agent pipelines

Pipelines run a user-defined chain of two to four agent stages in one dedicated git worktree. The first slice supports `run` and `review-loop` stages. Every transition is linear and declared through `next`.

## Create and inspect

`GET /api/pipelines` returns `{ "pipelines": [...] }`.

`GET /api/pipelines/<id>` returns `{ "ok": true, "pipeline": {...} }` with the full record for one pipeline.

`POST /api/pipelines` accepts:

```json
{
  "task": "Implement and verify pipeline support",
  "spec": "AC1: every run stage ends with structured JSON\nAC2: review uses the existing flow engine",
  "repoDir": "/absolute/path/to/repository",
  "src": "/absolute/path/to/the/launching/conversation.jsonl",
  "stages": [
    {
      "id": "plan",
      "kind": "run",
      "engine": "claude",
      "model": "sonnet",
      "effort": "high",
      "access": "read-only",
      "outputs": ["docs/design/pipeline-support.md"],
      "prompt": "Plan {{task}}. Use the pinned specification.",
      "next": "build"
    },
    {
      "id": "build",
      "kind": "run",
      "role": { "roleId": "builder" },
      "access": "read-write",
      "prompt": "Implement {{task}} using this prior output:\n{{prev.output}}",
      "next": "review"
    },
    {
      "id": "review",
      "kind": "review-loop",
      "role": { "roleId": "reviewer" },
      "effort": "xhigh",
      "access": "read-only",
      "sandbox": "restricted",
      "prompt": "Review the full pinned task and acceptance criteria.",
      "next": null
    }
  ]
}
```

Stage ids use letters, numbers, `_`, and `-`. They must be unique. Each `next` value names the following array entry; the last stage ends with `null`. A review-loop requires an earlier run session.

`access` controls repository mutation policy at settlement. It does not remove read tools, network access, SSH, GitHub CLI access, or worktree visibility. `sandbox` independently controls the engine's tool/network boundary. Every stage gets full host access by default; set `"sandbox": "restricted"` to keep the same repository policy inside the restrictive engine sandbox.

A read-only `run` stage may declare repository-relative `outputs`, such as a report or design document. The agent may write those files and scratch space. The controller verifies that the stage created no commit and touched no undeclared worktree path, then records the declared outputs itself. Unsafe paths, traversal, globs, duplicates, and `.git` are rejected at creation. Review-loop findings continue to use the flow's existing artifact and cannot declare worktree outputs.

### Role references and issue #35

`role` is optional. When present, `role.roleId` is a durable reference to one of the eight presets from issue #35. `engine`, `model`, `effort`, and `access` live on the stage as explicit overrides.

Resolution follows this order for each runtime field: explicit stage value, referenced role preset, Builder preset from the shared role registry. The current Builder preset is Codex GPT-5.6-Sol with medium effort. Pipeline creation fails closed when the registry cannot provide Builder, preventing a second embedded default from drifting away from the registry. A raw-prompt stage receives the task/spec context and structured verdict contract without a role scaffold. A referenced role receives its registry scaffold. Creation persists one immutable effective-role snapshot on each stage, and every attempt clones that snapshot so later registry edits cannot change first execution or retries.

## Structured stage verdicts

A run stage completes only when its finished turn ends with a fenced JSON block matching this contract:

```json
{
  "status": "pass",
  "findings": ["optional bounded finding"],
  "confidence": 0.9
}
```

Valid statuses are `pass`, `fail`, and `needs_decision`. Findings are optional, with at most 50 bounded strings. Confidence is optional and ranges from zero through one. A stage may include its own completion-evidence keys beside those controller fields; they remain in the canonical transcript while the controller persists only the bounded core verdict. The guard rejects invalid core fields, malformed JSON, and arbitrary trailing text. A terminal `REVIEW_READY` handoff line is accepted for compatibility with builder stages. Human-readable prose before the block becomes the stage output available through `{{prev.output}}`.

A review-loop stage attaches the latest passed run session to a regular review Flow. The stage role supplies the fresh reviewer. Flow approval becomes a pipeline `pass`; comment, closed, missing, and decision states park the pipeline for an operator. Review rounds, verdict parsing, findings delivery, and fresh-reviewer behavior stay owned by the Flow engine.

## Worktree, lineage, and recovery

Creation provisions a sibling worktree on `pipeline/<task-slug>-<id>`. Passed read-write stages commit pending work. For passed read-only stages, the controller commits only verified declared outputs. Both advance the saved `lastPassedCommit`. Retry closes an embedded flow, runs `git reset --hard <lastPassedCommit>` plus `git clean -fd` inside the pipeline-owned worktree, and appends a fresh attempt.

The stage transcript artifact is the completion authority. When a durable read of the attempt's transcript shows a native terminal turn whose final assistant message contains a valid fenced verdict without a conflicting verdict fence, the attempt settles once from the last valid fence: the controller records the verdict, commits any pending work, advances `lastPassedCommit` to the actual stage HEAD, and schedules the next stage — even when the runtime session ledger is still reporting the turn as running, the scanner projection has transiently lost the transcript, or the host is already gone. A transcript whose turn is still open is mid-work: its messages are never verdict candidates, so a recovered idle host cannot terminalize the attempt.

A terminal parser miss starts up to three durable evaluations. Identical evidence is rechecked no more often than every 30 seconds, while a newer completed assistant message is evaluated immediately. The attempt receipt records the check count, selected assistant-message timestamp, and a content-free rejection reason. A newer valid completed turn in the same conversation settles immediately, including after restart, resume, generation rollover, transcript compaction, or exhaustion of the evaluation budget. Three failed checks settle into a durable `needs_decision` state naming the missing evidence. Retry and skip are refused for that recovery state because both actions clean the worktree; the operator can continue the same conversation or close the pipeline with its lineage and worktree intact. A pass that leaves the next stage pending wakes the controller itself instead of waiting for an unrelated tick.

Run stages use Viewer spawn receipts and conversation lineage. Stage zero descends from `src` when supplied. Later stages descend from the latest completed stage session. Each attempt persists its launch id, Viewer conversation id, transcript path, native session id, pane id, output, verdict, and timestamps. Pausing holds coordinator transitions while preserving the active session for inspection and resume.

A task spawn reserves its linked draft pipeline after task admission and before pane actuation. The draft keeps a `task-spawn` creation intent keyed by task id and launch id, plus the reserved Viewer conversation id. Transcript settlement fills the creator path through the same idempotent ensure operation. Controller recovery can fill the path from the conversation registry when the route process stops after launch settlement. Replays reuse the receipt and the task's linked draft, preserving one pane and one active pipeline.

Pipeline stages cannot create another pipeline. The stage-kind validator and the injected prompt contract enforce this one-level composition limit.

## Control

`PATCH /api/pipelines/<id>` accepts one action:

- `set-position` — persist `{ x, y }` as the exact desktop board pin for the pipeline group. Automatic anchors remain render-derived; a drag writes this smallest durable override directly on the pipeline record.
- `pause` — hold coordinator transitions and pause an embedded review flow.
- `resume` — return to the saved pipeline phase and resume an embedded flow.
- `retry-stage` — restore the last passed commit and start a fresh attempt.
- `skip-stage` — record an operator skip and follow `next`.
- `close` — close the pipeline and any embedded flow while retaining history, the worktree, and any live stage panes for inspection. A close first asks the runtime host to end each resident stage host; when the calling process has no structured control channel at all (an MCP host process), it ends the host by the identity the registry recorded (pid, start identity, boot epoch). That path acts only on an attempt affirmatively bound to the row: the attempt names the conversation the row is the current generation of, and its launch has a receipt naming that same conversation; no launch, no receipt, or a receipt naming another conversation is unresolved ownership and nothing is signalled. The same authority (the row still naming that exact process for that conversation, no orchestrator seat) is asked again after every await inside the termination and one step before each signal. The report says which Viewer generation started the host and whether it still exists. A signal that was sent and did not end the whole authorized tree — a survivor, a refused signal — leaves the close refused with the pids named, and the survivors' identities are kept on the attempt: until each is proven gone, no later close may terminalize the attempt on registry or transcript evidence, however dead the row looks.

After a Viewer restart, startup adoption consults the pipeline record before re-hosting a structured conversation: a conversation whose stage attempt has already settled (passed, failed, parked or skipped) is not resumed on the strength of its unfinished-turn claim alone, because no controller would accept its verdict or advance it. Work owed to it — a held delivery, a pending operation, an orchestrator recovery — still hosts it, and the close above then reaches that host.

When a park happened before the stage produced a verdict, `retry-stage` and `skip-stage` refuse with 409 while the attempt's pane still hosts a live agent — resetting the worktree under a mid-turn agent would let its strays land in the next stage commit. Wait for the agent to exit or kill the pane, then retry.

The pipeline tick runs in the same durable scanner-controller pass as the flow tick. `GET /api/files` remains a pure read and includes the current pipeline records for the project UI. The pipeline store fails closed on malformed or future-schema state, and that failure is contained: the files payload carries `pipelinesError` and serves everything else, and the shared tick skips pipelines while flows, workflows, and tasks keep running.

## Deferred composition

Branching, conditional verdict edges, fan-out, parallel stages, voting panels, DAGs, rich visual editing, and runtime-event ownership remain later slices.
