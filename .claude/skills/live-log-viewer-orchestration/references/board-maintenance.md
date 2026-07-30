# Board maintenance

Use this runbook for “run board maintenance” and natural requests to clean up the board, improve
chat names, compact review rounds, or reconcile associations. Complete every phase and finish
with the report defined below.

## Safety contract

Maintenance is reversible Viewer metadata work.

- Never delete a transcript, branch, worktree, pull request, flow, pipeline, or task.
- Never interrupt, kill, resume, message, merge, deploy, or restart a process or service.
- Never run a task, flow, pipeline, lifecycle, or runtime action.
- Preserve every active conversation when its title, role, or association is unclear.
- Hide a card only after the supersession proof in this runbook succeeds.
- Use Viewer APIs for mutations. Direct edits to state files, transcript files, or registry stores
  are forbidden.
- Record the previous value and the successful read-back for every mutation so an operator can
  reverse it.
- Stop the affected item and report ambiguity whenever evidence supports multiple targets.
- Return `needs_decision` when a required repair has no supported Viewer API or would create,
  start, stop, or delete a task, flow, pipeline, process, or worktree.

## 1. Fix the scope

Start from the operator's current view.

1. Call `viewer.snapshot` with `scope.kind: "visible"` and `text.include: false`.
2. Pin the returned `view.viewSessionId` for the rest of the pass. Resolve
   `AMBIGUOUS_ACTIVE_VIEW` by selecting one reported view explicitly.
3. Build the bounded card set from `view.visiblePaths`, `view.selectedPaths`, and
   `view.focusedPath`, preserving visual order and removing duplicates.
4. Request bounded transcript text for that set in batches of at most 16 paths with
   `scope.kind: "paths"`. Keep `lastMessages` and `maxCharsPerConversation` at the smallest
   values that establish the work, outcome, and current state.
5. If the operator named the whole project, extend the set with `GET /api/files?project=<project>`.
   Include current flow/pipeline attempts, live or recent working conversations, waiting/stalled
   conversations, and board-pinned cards. Leave archival history outside the pass.

`viewer.snapshot` returns at most 16 scoped conversations while `view.visiblePaths` can contain
more. Batch every visible path before declaring the visible layer inspected.

For a large set, the orchestrator may delegate read-only inventory to one fresh, fast model
through the Viewer's normal visible delegation path. Give it bounded transcript excerpts and the
current metadata read models. It may propose titles, association repairs, and supersession groups.
It must perform zero mutations. The orchestrator validates every proposal and owns every write.

When the request covers multiple projects, repeat this phase independently for each project. A
card belongs to the project reported by `/api/files`; worktree paths must retain their parent-repo
project grouping.

## 2. Build the evidence inventory

Read these Viewer surfaces before changing anything:

- `viewer.snapshot` for operator-visible order, attention, activity, and bounded transcript text;
- `GET /api/files?project=<project>` for canonical path, conversation identity, title revision,
  activity, process state, durable lineage, role, memberships, and review outcome;
- `GET /api/board?project=<project>` for the revision fence and hidden/manual/expanded state;
- `GET /api/flows`, `GET /api/pipelines`, and `GET /api/tasks` for durable associations, rounds,
  exact reviewed heads, assignments, and current container state;
- GitHub pull-request state only when transcript and Viewer metadata identify a repository and PR.

For each in-scope card, record an internal inventory row with:

- canonical conversation id and current transcript path;
- every owned predecessor/continuity path visible in the read models;
- current title, automatic title when present, and `titleRevision`;
- engine, role, activity, attention, process/host state, and parent/review lineage;
- task assignment, flow id/role/round, pipeline/stage/attempt, and creator lineage;
- issue, branch, worktree, and every PR mentioned by the conversation in chronological order;
- current or final owned outcome, current primary PR, exact reviewed head, verdict, and later-round
  evidence.

Never publish conversation ids, session ids, transcript paths, message text, absolute home paths,
or unrelated project names. They may appear in the private working inventory needed to perform
the pass.

### Evidence strength

Use the strongest available evidence:

1. durable flow or pipeline membership, stage attempt, exact review head, and recorded lineage;
2. explicit review marker/verdict, PR URL, branch, commit, or worktree evidence corroborated by
   current Viewer or GitHub state;
3. durable task assignment and task–pipeline membership;
4. bounded transcript statements corroborated by another current source;
5. prompt or current-title inference.

Evidence level 5 alone never authorizes hiding or association repair.

### Multi-PR conversations

A conversation may own or discuss several PRs. List every PR chronologically and distinguish
work owned by the conversation from background mentions. Derive the title from the current or
final owned outcome. Retain earlier owned PRs in the evidence inventory and existing durable
associations. A title may mention the current PR when the number distinguishes active lanes.

## 3. Name cards

Every maintained agent card gets a short human title carrying:

- feature or workstream;
- role or owned outcome;
- current state when it affects operator action.

Use forms such as:

- `Question Card Dismissal — Builder, Verification Running`
- `Board Maintenance — Reviewer, Changes Requested`
- `Usage Accounting — Fix Ready, CI Green`
- `Release Control — Orchestrator, Waiting for Approval`

Avoid generic titles such as `Codex session`, raw session ids, bare issue/PR numbers, copied
prompts, and model names without a task. Use a round number only when it distinguishes concurrent
or retained review rounds.

Rename with:

```json
PATCH /api/session/title
{
  "conversationId": "<canonical conversation id>",
  "title": "<human title>",
  "baseRevision": 3
}
```

Use `path` only when `/api/files` exposes no canonical conversation identity. On `409`, adopt the
returned current record, re-check the intended title, and retry with its revision. Verify each
success through a fresh `/api/files?project=<project>` read and record the returned revision.

## 4. Compact review rounds

Group review cards by all of these lane keys:

- reviewed implementer/conversation;
- flow or pipeline and stage;
- owned PR;
- review purpose or independent lens.

For each group:

1. Order rounds by durable round/attempt data, exact reviewed head, and terminal timestamp.
2. Keep every running or waiting review visible.
3. Keep the latest relevant completed review for the latest exact head visible.
4. Keep an older changes-requested verdict visible while its findings remain unresolved and the
   replacement head has no review.
5. Keep independent lenses visible while each carries unique unresolved findings.
6. Mark an older terminal card superseded only when a newer card has the same lane keys and
   reviews the same exact head or a demonstrably later head.

The supersession proof must name the surviving card, the superseded card, matching lane keys, both
review heads, both terminal/activity states, and the evidence source. Any missing field makes the
pair ambiguous.

When Viewer already folds a flow or pipeline reviewer into its durable round/stage group and the
card is absent from the rendered board, preserve that state. A second board hide would add no
compaction value.

Hide a proven superseded card with a revision-fenced board mutation:

```json
PATCH /api/board
{
  "schemaVersion": 1,
  "project": "<project>",
  "baseRevision": 12,
  "mutations": [
    { "kind": "close", "path": "<superseded transcript path>" }
  ]
}
```

The board route preserves the transcript and follows canonical conversation path aliases. Verify
that the response reports `applied: true` and the returned board contains the canonical path in
`prefs.hidden`. On `409`, re-read the board, revalidate the proof, and retry against the new
revision.

The rollback is a `restore` mutation with the recorded path and prior placement:

```json
{ "kind": "restore", "path": "<path>", "placement": "auto" }
```

Never use flow close, pipeline close/delete, session supersedence, task delete, or runtime actions
for review compaction.

## 5. Repair associations

Classify each suspected defect before writing:

- PR evidence disagrees with the title or current owned outcome;
- reviewer is detached from its implementer or review subject;
- task assignment or task–pipeline membership is absent or points elsewhere;
- flow/pipeline/stage membership or exact reviewed head is absent or wrong;
- pipeline creator lineage (`src`) is absent or wrong;
- a conversation has missing parent lineage after a spawn;
- a board path points at an older generation of the same canonical conversation.

Require one unique source and one unique target. Preserve the item and report competing candidates
when uniqueness is unavailable.

### Supported repairs

| Repair | Viewer mechanism | Required proof and verification |
|---|---|---|
| Stale title after a PR/workstream change | `PATCH /api/session/title` | Chronological owned-PR inventory identifies the current/final outcome; verify in `/api/files`. |
| Superseded card visibility | `PATCH /api/board` with `close`; `restore` is the rollback | Full review-lane supersession proof; verify `prefs.hidden`. |
| Missing or wrong pipeline creator lineage | `PATCH /api/pipelines/<id>` with `{"action":"set-src","srcPath":"<path>"}` | Source path resolves to one canonical conversation. Omit `overwrite` when lineage is empty. For a proven correction, record both old fields and pass `overwrite:true`; verify `srcPath` and `srcConversationId` in the response and a fresh pipeline read. |
| Missing task–pipeline membership | `PATCH /api/pipelines/<id>` with `{"action":"link-task","taskId":"<id>"}` | Task and pipeline share one project and the task evidence names this lane; verify both `/api/pipelines` and `/api/tasks`. |
| Wrong task–pipeline membership | `unlink-task`, followed by `link-task` only when both sides are proven | Record the old link as rollback data; verify both read models after each write. |
| Missing task assignment to an existing lane | `POST /api/tasks/<id>/assignment` with `{"path":"<path>"}` | The task already has one active linked pipeline and the path resolves to its agent profile. Stop with `needs_decision` if the call would create a draft pipeline. |
| Wrong task assignment | `DELETE /api/tasks/<id>/assignment` with a stable assignment handle, then the supported assignment call | One old target and one replacement are proven; record the full old assignment before detaching it. |
| Stale board path for one canonical conversation | Let `/api/board` add canonical aliases during `close`/`restore`; use `remap-paths` only with explicit same-conversation generation proof | Old and new paths belong to the same canonical conversation; verify `pathAliases` and all placement lists. |

Supported repair calls remain metadata-only. A pipeline `set-src`, task link, or task assignment
must never be combined with `start`, `resume`, `retry-stage`, flow actions, delivery, or spawn.

### Unsupported repairs

The current Viewer has no general safe maintenance mutation for:

- a generic PR↔conversation association record;
- arbitrary reviewer↔implementer or reviewer↔review-subject lineage;
- rebinding a flow implementer or review round;
- rewriting an exact reviewed head;
- adding missing conversation `src`/parent lineage after spawn.

Use existing transcript and durable metadata as evidence without manufacturing a replacement
link. Report the case as ambiguous when several candidates exist. Return `needs_decision` when one
target is proven and the missing unsupported repair blocks correctness. Include the required
association, evidence, and narrow API capability that would be needed. Never patch registry,
flow, pipeline, or transcript stores directly.

## 6. Verify and report

After all intended mutations:

1. Re-read `/api/files`, `/api/board`, `/api/flows`, `/api/pipelines`, and `/api/tasks` for each
   affected project.
2. Re-run a pinned `viewer.snapshot` for the maintained visible paths.
3. Confirm every active conversation remains present and no mutation endpoint outside this
   runbook was called.
4. Confirm each renamed title, hidden path, retained review, and repaired association against its
   recorded evidence.
5. When `viewer.snapshot` disagrees with a successful mutation and fresh `/api/files` or
   association read-back, keep the durable mutation, avoid blind retries, and report a
   cross-surface convergence ambiguity.
6. Count unique cards: `renamed` and `repaired` count cards changed by this pass, `hidden` counts
   cards newly hidden by this pass, and `retained` counts active/latest cards deliberately left
   available. A renamed or repaired card can also be retained; describe overlaps. Count ambiguity
   cases separately and mention pre-existing hidden/folded cards outside the mutation count.

Return this compact report:

```text
Board maintenance: complete | needs_decision
Scope: <visible layer or named project live/recent layer>
Projects: <count>
Inspected: <count>
Renamed: <count>
Hidden: <count>
Retained: <count>
Repaired: <count>
Ambiguous: <count>

Hidden: <feature/lane summaries>
Repaired: <association summaries>
Ambiguities: <sanitized descriptions with competing candidates>
Safety: no transcript, branch, worktree, PR, flow, pipeline, task, or active process was
deleted or interrupted; no merge, deploy, or restart occurred.
```

For a public issue or PR, identify the projects as `this repo` and `an unrelated project`. Omit
account identities, external project names, session/conversation ids, transcript/message content,
and absolute home paths.
