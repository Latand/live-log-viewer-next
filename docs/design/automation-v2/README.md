# Automation v2: one mutable record for pipelines, flows and review loops

## Originating requirement

Operator directive, 2026-09-02, voice, transcribed verbatim in issue #1446:

> А что, получается, что у нас нету функции изменения пайплайна? Выходит, что нам каждый раз нужно его пересоздавать … по пайплайнам и флоу, и ревью-флоу … нужно … интегрировать всё в одно … Fable нужно отдать вот эту архитектурную проходку, которая касается всего процесса автоматизации: ревью, пайплайнов и так далее. Должна быть какая-то одна унифицированная штука, которая работает у нас и которую можно менять легко: в первую очередь должен иметь возможность менять агент, а во вторую очередь уже в UI.

Working translation (mine, for reviewers who do not read Russian): "So we have no function to change a pipeline? Every time we have to recreate it. Pipelines, flows and review flows must be integrated into one thing. Fable takes this architecture pass over the whole automation process: review, pipelines and so on. There must be one unified thing that works for us and is easy to change: first an agent must be able to change it, second the UI."

Standing prior directive, 2026-07-17, issue #340: flows and pipelines "are conceptually the same thing: an editable list of agents (roles) that gets launched as a unit. They must become one feature", with the acceptance "one UI entry point, one API surface, one state store".

This design was verified against repository commit `d79b463e` (the tip of `main` on 2026-09-02). Every `file:line` below refers to that commit; the `src/` tree at the lane head `f5666310` is byte-identical to it, so every citation holds at both. Usage figures were read from the operator's state store on 2026-09-02 and cover records created between 2026-08-19 and 2026-09-02.

Revision 2 (2026-09-02) answers review round 2 of this lane: every file has one owning lane and §6 says which (§6.1); each slice names the gate that really keeps it behind current behaviour, and the admitted-action constant is that gate (§6.2); `answer` always spawns a fresh attempt because the reaper stops a parked host, and ADR-0003 says the same (§3.6); attempts bind their definition at the spawning transition, which decides `appliesFromAttempt` for the spawn-wait window too (§3.2, ADR-0002); and the mutation log has a named cap with compaction into the lifecycle journal (§3.3).

## Decision in one paragraph

Keep the pipeline record as the one durable automation record and make it mutable after start. Retire the flow record, the workflow record and the `review-loop` stage kind; the only loop is a reviewer run stage with a fail edge back to a fixer stage, which is already how 275 of the last 293 pipelines were built. Add to the record a revision counter, an append-only attributed mutation log, a paused flag, checkpoints, per-attempt definition snapshots and a per-attempt `waiting` reason. Extend `pipeline_action` with `edit-stage`, `rerun-stage`, `checkpoint`, `note` and `answer`, lift the after-start refusals from `add-stage`, `remove-stage`, `reorder-stage` and `set-edge`, and fence every definition-changing mutation on `expectedRevision`. A mutation that lands on a stage with a running attempt is recorded and applied to the next attempt; it is never applied under the running one silently, and a caller who wants it now says `restart: true`. Replace "the first ended turn settles the stage" with "an ended turn settles the stage only when nothing is pending", where pending means a background task, a provider throttle, an account limit or a host between publications, each bounded by a ceiling. The MCP tool schema publishes every mutation with a typed payload; the Viewer UI later calls the same PATCH route with the same payloads.

## 1. What runs today

### 1.1 Three engines, three records

| Record | Files | Own state machine | Own mutation API | Records created 2026-08-19 to 2026-09-02 |
| --- | --- | --- | --- | --- |
| Pipeline | `src/lib/pipelines/engine.ts` (4,556 lines), `store.ts`, `types.ts`, `git.ts`, `controller.ts`, `verdict.ts`, `durableEvidence.ts` | `draft, provisioning, running, needs_decision, paused, completed, closed` (`types.ts:208`) with attempt states `pending … skipped` (`types.ts:109-118`) | `PIPELINE_ACTIONS`, 17 actions (`types.ts:323-341`) | 293 pipelines, 718 stages, 1,315 attempts |
| Flow (review loop) | `src/lib/flows/engine.ts` (1,451 lines), `commands.ts`, `exec.ts`, `store.ts`, `types.ts` | 12 states (`flows/types.ts:17-29`) with per-round relay, retry and hold sub-states (`Round`, `flows/types.ts:93-179`) | `FlowAction`, 11 actions (`flows/types.ts:261-272`) | 45 flows since 2026-08-01: 26 created by a pipeline `review-loop` stage, 19 standalone; the last standalone flow was created on 2026-08-25 |
| Workflow | `src/lib/workflows/engine.ts`, `store.ts`, `types.ts` | 8 states (`workflows/types.ts:36-44`) | `patchWorkflow` (`workflows/engine.ts:526`) | 1 record in the store, carrying an epoch timestamp; the draft UI has been fenced since #136 (`src/components/ProjectDashboard.tsx:181`) |

All three keep a whole-record JSON shape in the SQLite state collections (`state.sqlite`, collections `pipelines`, `pipelines_archive`, `flows`, `workflows`), each with its own load, validate, migrate and persist code (issue #931, seed items 2 and 3).

### 1.2 The pipeline engine

**Record.** A pipeline pins `task`, `spec`, `repoDir`, one worktree and branch, `baseRef`, `lastPassedCommit`, `publishedCommit`, an ordered `stages` array and one `runs` array of attempts per stage (`types.ts:248-303`). Execution position is one `cursor` naming a stage and its lifecycle state, plus the durable relay record (`input`, `activatedBy`) that fed it (`types.ts:276`). Pause stores the previous state in `pausedState` (`types.ts:278`).

**Stages and roles.** A stage carries `kind` (`run` or `review-loop`), an optional role reference, engine, model, effort, `access` (repository policy, enforced at settlement), `sandbox` (tool boundary), declared `outputs` for read-only stages, an account pin, `prompt`, a pass edge `next` and an optional fail edge `onFail: {to, maxRounds}` (`types.ts:67-94`). Role resolution runs once at creation through the shared registry and freezes an `effectiveRole` on the stage (`roles.ts:86-150`, `types.ts:96-99`). Every attempt clones that snapshot when it is created (`engine.ts:1283`). The prompt is rendered at spawn time from `stage.prompt` (`engine.ts:1955-1960`, `prompts.ts:8-56`), so the prompt is the one definition field an attempt does not snapshot.

**Tick loop.** One controller (`controller.ts:104-303`) runs pipelines, the file scan and flows as phases of a cycle with a 15 s phase deadline and up to 8 passes (`controller.ts:69-70`). `tickPipelines` (`engine.ts:3058-3115`) first runs nine reconcilers (embedded flows, adoptions, historical attempts, path rebinding, exhausted recovery, parked verdict misses, parked spawns, bound flows, unconfirmed and terminal hosts), then ticks a pipeline that is neither terminal, paused nor parked (`engine.ts:3078`).

**Spawn.** A run stage's attempt goes `pending → spawning → running`. The spawn resolves an account inside the project's allowed pool (`engine.ts:344-353`), records a reservation as soon as a launch id exists (`engine.ts:2007-2012`), and retries only three failure strings (`engine.ts:2838-2842`): a controller between publications gets a booked wall-clock wait of up to 30 s (`engine.ts:2865-2887`, `engine.ts:920`); the other two get two immediate handshake retries; every other error parks the pipeline in `needs_decision` (`engine.ts:2057`).

**Settlement.** While the scan projects an open turn the tick returns (`engine.ts:2120-2129`). Otherwise the durable transcript is the completion authority (`durableEvidence.ts:150-180`): a terminal turn is a Claude assistant record with `stop_reason` `end_turn` or an API error (`src/lib/accounts/migration/turnState.ts:202-211`) or a Codex turn-complete record with no open tool calls (`turnState.ts:127-182`). If the last assistant message parses as a fenced verdict (`verdict.ts:120-144`) the attempt settles: pass commits and publishes (`engine.ts:1731-1779`), fail routes along the fail edge while its derived round budget lasts (`engine.ts:1684-1729`), `needs_decision` parks (`engine.ts:1088-1094`). If the turn is terminal and the message has no verdict, verdict recovery records a miss and re-checks the same evidence at most three times, 30 s apart (`engine.ts:908-909`, `engine.ts:1028-1070`); the third miss stamps `completedAt` and parks the pipeline (`engine.ts:1057-1064`). A parked attempt with `completedAt` counts as turn-settled (`engine.ts:3815`), so the terminal host reaper stops its host on the next tick (`engine.ts:2963-3056`). A provider usage-limit notice at the end of the turn fails the attempt over to another allowed account by creating a fresh attempt in the same worktree (`engine.ts:1111-1174`).

**Publication.** A passed read-write stage is committed with `git add -A` (`git.ts:123-141`); a passed read-only stage may only have touched its declared outputs, and a HEAD that moved is refused as "read-only stage created a commit" (`git.ts:103-117`). The controller then fast-forwards `origin/<branch>` itself (`engine.ts:1753-1768`, `git.ts:277`); an unreachable remote leaves the pass in a retry seam (`engine.ts:1658-1679`). A review-loop stage additionally requires the local head to equal the accepted head and publishes before ingress (`engine.ts:2347-2385`), and its approval is fenced on the reviewed, local and remote heads all agreeing (`engine.ts:2624-2639`).

**What a started pipeline refuses.** From `patchPipeline` (`engine.ts:3904-4548`):

| Action | Allowed when | Reference |
| --- | --- | --- |
| `add-stage`, `remove-stage`, `reorder-stage` | draft only | `engine.ts:4017`, `4040`, `4065` |
| `override-stage` (prompt, role, engine, model, effort, account) | any non-terminal state, but only a stage with zero attempts; a failed spawn attempt counts | `engine.ts:4289` |
| `set-edge` pass | stage has never run | `engine.ts:4103` |
| `set-edge` fail (target or `maxRounds`) | fail edge never traversed | `engine.ts:4114-4117` |
| `retry-stage` | pipeline in `needs_decision`; refused after exhausted verdict recovery unless HEAD equals `lastPassedCommit` (`engine.ts:3698-3713`); refused while a pane host is alive (`engine.ts:3689-3696`); resets the worktree with `git reset --hard <lastPassedCommit>` and `git clean -fd` (`engine.ts:4246`, `git.ts:182-189`) | `engine.ts:4148-4256` |
| `skip-stage` | pipeline in `needs_decision`; also resets the worktree | `engine.ts:4257-4279`, `4272` |
| `pause` / `resume` | copies the state into `pausedState` and back | `engine.ts:4132-4147` |
| `update-draft` (task, spec, repoDir) | draft only | `engine.ts:3967` |

Nothing changes a stage after its first attempt, nothing re-runs a settled stage from the worktree it left, and nothing adds a round to a completed pipeline. Those three gaps are what the operator described.

**Attribution.** Only `pause` and `resume` carry an actor (`engine.ts:3908`, `src/lib/pauseResumeActor.ts:1-22`), and only through the MCP binding (`src/lib/mcp/bindings.ts:979-981`, `550-557`); the HTTP route passes none (`src/app/api/pipelines/[id]/route.ts:57`). No other mutation is recorded anywhere except as the state it left behind. The lifecycle journal derives its events from the record after the fact (`src/lib/lifecycle/projector.ts:20-25`, `42-65`), so it can name a pause and a stage outcome, and nothing else.

**MCP bindings.** `create_pipeline` forwards the request to `createPipelineFromRequest` and returns the record (`bindings.ts:961-973`); its schema is typed per field (`src/lib/mcp/server.ts:1945-1957`) and its description teaches the graph contract (`server.ts:1673-1682`). `pipeline_action` publishes only the action enum and passes every other field through untyped (`server.ts:1958-1963`), so an agent cannot read from the schema which fields `override-stage` or `set-edge` take. `flow_action` is a second mutation surface for the second record (`server.ts:2044-2052`, `bindings.ts:2460-2474`). `spawn_agent` posts to `/api/spawn` and creates a conversation with no automation identity at all (`bindings.ts:840-861`).

### 1.3 The flow engine

A flow attaches a fresh reviewer per round to one long-lived implementer conversation (`docs/review-loop.md`). Each round freezes the reviewer role at creation (`flows/engine.ts:149-163`), requires a clean committed HEAD before launch (`flows/engine.ts:274-276`), runs the reviewer as a detached headless process (`flows/exec.ts:412`, 30 min timeout at `exec.ts:17`), parses a `VERDICT:` file, relays findings into the implementer through the structured delivery path with idempotent identity (`flows/engine.ts:381`, `1208-1289`), and parks on the round limit (`flows/engine.ts:1028-1037`). The only definition change it accepts after start is the reviewer role for the next round (`flows/commands.ts:539-559`, reviewer only by design at `flows/types.ts:284-291`); the round limit and mode are the other two knobs. A pipeline `review-loop` stage creates such a flow with `roundLimit: 5` (`engine.ts:2462-2476`), squeezes the stage directive into the 2,000 character flow note (`engine.ts:2307-2326`, `flows/commands.ts:268`) and projects the flow's rounds back onto the attempt as `reviewFlowSync` (`engine.ts:1514-1574`, `types.ts:161-174`). Two state machines therefore describe one review: the flow's 12 states and the attempt's `reviewing` state plus a reconciler that translates terminal flow states into stage verdicts (`engine.ts:2667-2726`).

### 1.4 The workflow engine

`src/lib/workflows` is an earlier implement-then-review-loop engine with its own worktree provisioning and an embedded flow (`workflows/types.ts:1-80`). Its UI drafts are fenced (#136), one record survives in the store with an epoch timestamp, and the design document its header cites does not exist under `docs/design/`. It is dead code with a live store collection.

### 1.5 Usage evidence

Read from the operator's state store on 2026-09-02, pipelines created since 2026-08-19:

| Measure | Value |
| --- | --- |
| Pipelines | 293 |
| Stages: `run` / `review-loop` | 715 / 3 |
| Run stages by role: builder / reviewer / architect / prod-auditor | 398 / 297 / 21 / 2 |
| Pipelines with at least one fail edge | 275 |
| Attempts: passed / failed / needs_decision / skipped | 662 / 458 / 174 / 12 |
| Stages that needed 3 or more attempts | 209 of 718 |

The orchestrator already builds every loop as a reviewer run stage with a fail edge back to a fixer stage; each fail-edge round spawns a fresh fixer conversation that supersedes the previous one (`engine.ts:1961-1976`). The embedded flow path is used three times in two weeks. Standalone flows stopped on 2026-08-25.

Top attempt error classes in the same window (attempt `error` text, identifiers stripped):

| Class | Attempts | Mechanism |
| --- | --- | --- |
| verdict recovery exhausted: completed turn is missing or has an invalid fenced verdict | 39 | §1.2 settlement; includes every #1441 case |
| stage spawn failed: structured delivery controller unavailable, with or without retries | 34 | 30 s wait budget (`engine.ts:920`), #1114 |
| verdict recovery exhausted: transcript not yet readable after termination | 25 | `engine.ts:2214-2221` |
| historical attempt completed without a valid verdict | 24 | `engine.ts:2203-2208` |
| delivery started and the structured host did not answer | 20 | spawn path |
| structured spawn startup reached its 300 s setup bound | 11 | spawn path |
| review requires a clean committed HEAD | 7 | `flows/engine.ts:276`, #1374 |
| account mutation is busy | 6 | `src/lib/accounts/accountMutation.ts:59-63`, #1433 |
| fail-edge budget exhausted | 90 | `engine.ts:1724-1726`; the successor-pipeline trigger |

### 1.6 The incidents of the last week and the mechanism each exposed

| Incident | What happened | Mechanism in code |
| --- | --- | --- |
| #1441 verdict recovery kills agents waiting on background tasks (3 attempts in 24 h) | A Claude stage ended a turn to wait for its own background command; the transcript showed a terminal turn without a verdict; three checks 30 s apart exhausted; the pipeline parked and the reaper killed the host before the task notification arrived | Terminal turn = `stop_reason: end_turn` (`turnState.ts:206`); no reading of the background-task start record; recovery budget `engine.ts:908-909`; park stamps `completedAt` (`engine.ts:1058`), which the reaper reads as turn-settled (`engine.ts:3815`, `2963-3056`) |
| #1433 spawn parks on "account mutation is busy" | Parallel lanes spawned in the same second; the sync lock throws where it could wait; the string is not in the transient list; the attempt parked as `needs_decision` and waited up to 15 min for a manual retry | `accountMutation.ts:59-63` throws where `65-69` could wait; `engine.ts:2838-2842` transient list; `engine.ts:2057` park |
| #1409 a builder reports a fix without pushing; the next round approves unchanged source | A fix stage on a fail-edge round returned `pass` at the head it already had; the reviewer stage ran on identical bytes and found something else; the original finding left the record | Settlement records no head at attempt start (`types.ts:138-199` has `expectedReviewHeadSha` only for review-loop attempts); pass on a run stage commits whatever is there, including nothing (`git.ts:120-122`); fail-edge input carries findings and omits the reviewed SHA (`engine.ts:1694-1700`) |
| #1374 and #452 design lanes and override refusals deadlock | A read-only architect revised the doc between rounds; the flow refused the round on a dirty tree; a human committed by hand. Separately, a review prompt over 2,000 characters could never run because `override-stage` refuses a stage with attempts | `flows/engine.ts:276`; `engine.ts:2315-2318`; `engine.ts:4289` |
| #852 resume masks `needs_decision` and strands the operator's answer | A parked stage was paused and resumed; the operator's answer went to the delivery layer with no attempt to attach to | `pausedState` is a copy of the state (`types.ts:278`, `engine.ts:4135`); the tick reads only `state` (`engine.ts:3078`); no action binds a message to a parked attempt; `retry-stage` resets the worktree (`engine.ts:4246`) |
| #1073 fresh-implementer rotation | A nine-round flow through one long implementer session burned about a quarter of a weekly quota | Flows relay into the standing implementer (`flows/engine.ts:1208-1289`); rotation exists only in the pipeline fail-edge path |
| #340 flows vs pipelines | Two buttons, two records, two engines for one concept | §1.1, §1.3 |

The orchestrator's own workarounds this week, each a symptom of the same immutability:

- **Successor pipelines cut from lane branches** (recorded 2026-08-31): a fail-edge budget exhausted, or one more round was needed after completion, and the only path was to close the record and create a new pipeline with `baseBranch` set to the predecessor's branch. Cause: `set-edge` freezes a traversed fail edge (`engine.ts:4117`), `add-stage` is draft-only (`engine.ts:4017`), and a completed pipeline has no re-run action.
- **Checkpoint branches and WIP commits before any risky step** (recorded 2026-09-01 and 2026-09-02): `retry-stage` resets the worktree to `lastPassedCommit` and cleans untracked files (`engine.ts:4246`, `git.ts:182-189`), so any uncommitted stage work is lost on retry; the orchestrator commits checkpoints by hand to make retries survivable.
- **Manual pushes after a read-only stage committed rasters**: a read-only reviewer stage created a commit; settlement refused it as "read-only stage created a commit" (`git.ts:103-105`) and the publication pre-push hook refused the rasters; the orchestrator fixed the tree and pushed by hand because no action re-runs or re-classifies a stage in place.

## 2. What earlier work already decided

These decisions stand and this design builds on them. Where it changes one, it says so.

- **#340 (2026-07-17):** flows and pipelines become one feature with one UI entry point, one API surface, one state store. Kept; this design names which record survives.
- **#353:** stages form a graph with pass edges and verdict-keyed fail edges; loop budgets are derived from activation records (`activatedBy`), never from a counter (`types.ts:120-123`, `engine.ts:1684-1689`). Kept. Changed: #353 also froze a traversed fail edge and a ran stage's pass edge as "evidence" (`engine.ts:4087-4117`). The evidence is the activation record on the attempt, which stays immutable; the edge definition itself may change (§3.3).
- **#337:** the stage transcript artifact is the completion authority, independent of the runtime ledger and the scanner projection (`durableEvidence.ts:11-19`). Kept and extended with lifecycle evidence (§3.4).
- **#1279:** account pools travel with the project; a stage may pin an account only inside the pool. Kept; `edit-stage` re-reads the binding exactly as `override-stage` does today (`engine.ts:4364-4387`).
- **#907 and #931:** hot state lives in SQLite collections with revisions (`src/lib/state/sqliteStateStore.ts:490`); the audit's seed list names the two parallel state engines and the MCP-versus-HTTP duplication as consolidation targets. This design is the consolidation of seed items 3 and 4 for automation.
- **#686:** lifecycle events are derived from durable records with deterministic keys so re-projection appends nothing (`projector.ts:9-18`). Kept; the mutation log becomes one more projected source.
- **#774:** `PIPELINE_ACTIONS` is the single declaration the route and the MCP schema both admit (`types.ts:320-341`). Kept; every new action is added there first.
- **#670:** close tears hosts down, reports what it stopped, and leaves the worktree untouched. Kept unchanged.
- **#1245 (ADR 0001):** the seat tick wakes a seat by delivering through the durable conversation id. The continuation delivery in §3.6 uses the same path.
- **#1065 and #611:** structured relays settle only on delivery-journal evidence, and a provider park withholds the relay until the provider's deadline (`flows/types.ts:62-81`). Kept as the semantics of attempt continuation (§3.4, §3.6).

## 3. The unified model

### 3.1 One record

The pipeline record is the automation record. It keeps its name in code and in the tool names (`create_pipeline`, `pipeline_action`, `get_pipeline`, `list_pipelines`): the orchestrator already drives 293 records a fortnight through them, and a rename would be churn with no behaviour. ADR-0001 records why the record is extended, and why adapters over three records and a fourth record were both rejected.

Additions, as an illustrative sketch over the current types (`types.ts:248-303`):

```ts
type Pipeline = /* existing fields */ & {
  /** Increments on every accepted mutation; the fence for definition edits. */
  revision: number;
  /** Append-only, attributed. At most MAX_PIPELINE_MUTATIONS entries; at the
      cap the oldest are compacted into the lifecycle journal (§3.3). */
  mutations: PipelineMutation[];
  /** Highest seq compacted out of `mutations`; null before the first compaction. */
  mutationsCompactedThrough: number | null;
  /** Replaces state: "paused" and pausedState. A parked or running record
      stays parked or running while paused; the tick simply does not act. */
  paused: { at: string; actor: MutationActor } | null;
  /** Named worktree states a stage can be re-run from. */
  checkpoints: PipelineCheckpoint[];
};

type MutationActor =
  | { kind: "operator" }
  | { kind: "agent"; role: string | null; conversationId: string | null }
  | { kind: "controller" };

type PipelineMutation = {
  seq: number;
  at: string;
  actor: MutationActor;
  clientRequestId: string | null;
  /** The record revision after this mutation was applied. */
  revision: number;
  action: PipelineAction;
  stageId: string | null;
  /** The request payload. A text field over 1,000 characters is stored as
      `{ digest, length }`: the current text lives on the stage, and every text
      that ran lives on the attempt that ran it (§3.2). */
  payload: Record<string, unknown>;
  /** What the engine did with it. */
  effect: "applied" | "pending-next-attempt" | "restarted-attempt";
  /** The first attempt of `stageId` to run under this mutation, decided when
      the mutation is accepted by the binding rule in §3.2. Null when the
      mutation has no stage. */
  appliesFromAttempt: number | null;
};

type PipelineCheckpoint = {
  name: string;          // "stage:<id>:<n>" for automatic ones, free text for named ones
  sha: string;
  at: string;
  actor: MutationActor;
  stageId: string;
  attempt: number;
};
```

Stages and attempts gain the definition snapshot and the lifecycle reason:

```ts
type PipelineStage = /* existing fields */ & {
  /** Revision at which prompt, role, engine, model, effort, access, sandbox,
      outputs or account last changed. */
  definitionRevision: number;
  /** Pending notes attached by `note`, moved onto this stage's next attempt
      when it binds (§3.2). At most MAX_PENDING_STAGE_NOTES, each bounded like
      a stage prompt. */
  notes: Array<{ seq: number; text: string }>;
};

type PipelineStageAttempt = /* existing fields */ & {
  /** The stage definition this attempt runs, bound in the transaction that
      moves it from pending to spawning (§3.2). The prompt is rendered from
      these fields plus `effectiveRole`, never from the live stage. Null on an
      attempt that has not bound yet and on attempts migrated from schema 5. */
  definition: {
    revision: number;
    "prompt": string;
    outputs: string[];
    sandbox: PipelineSandbox;
    account: string | null;
  } | null;
  /** Branch head when the attempt was created and when it settled. */
  headAtStart: string | null;
  headAtSettle: string | null;
  /** Why the attempt has not settled although its turn ended. */
  waiting:
    | { kind: "background-task"; since: string; until: string; taskId: string }
    | { kind: "provider-throttle"; since: string; until: string; resetKnown: boolean }
    | { kind: "account-limit"; since: string; until: string | null }
    | { kind: "account-lock"; since: string; until: string }
    | { kind: "host-rebinding"; since: string; until: string }
    | { kind: "verdict-recovery"; since: string; until: string; checks: number }
    | null;
  /** Notes this attempt took from the stage when it bound, rendered into its
      prompt as a titled block. */
  notes: Array<{ seq: number; text: string }>;
  /** How this attempt started, when it is a re-run. */
  rerun: { of: number; from: "worktree" | "last-passed" | { checkpoint: string } } | null;
  /** Set when this attempt continues the previous attempt's conversation
      after a provider throttle and spawns no new one (§3.4, §3.6). */
  continuesAttempt: number | null;
};
```

`controllerWait` (`types.ts:184-188`) and `verdictRecovery` (`types.ts:125-136`) stay as the bookkeeping behind `waiting.kind = "host-rebinding"` and `"verdict-recovery"`; the new field is the one place a reader looks. `pausedState`, `expectedReviewHeadSha`, `reviewHeadSha`, `reviewFlowSync` and `flowId` become read-only history on migrated records and are not written for new ones.

### 3.2 Attempts bind their definition when they leave `pending`

Today an attempt clones `effectiveRole` when it is created (`engine.ts:1283`) but renders its prompt from the live stage at spawn (`engine.ts:1955-1960`) and reads the stage's account pin there too (`engine.ts:1969`). The new rule: **an attempt binds its definition in the record transaction that moves it from `pending` to `spawning`** (`engine.ts:1945-1949`), the instant before its first `spawnAgent` call. Binding copies the stage's prompt template, declared outputs, sandbox, account pin and `definitionRevision` onto the attempt, re-clones `effectiveRole`, and moves the stage's pending notes onto the attempt. From then on the prompt is rendered from attempt-owned fields, the attempt's own `input`, and the two record fields pinned at start (`task` and `spec`, editable only in a draft, `engine.ts:3967`); the live stage is never read again for that attempt. Handshake retries inside the same activation (`engine.ts:1998-2031`) and an attempt a controller wait bounced back to `pending` (`engine.ts:2040-2043`) keep their binding: the first send may already have reached a host, and re-rendering from a changed stage would be the silent change this rule exists to prevent.

The size precedent is `effectiveRole.promptScaffold`, already cloned per attempt today (`engine.ts:1283`); the stage prompt adds at most `MAX_STAGE_PROMPT_LENGTH` (8,000 characters, `limits.ts:7`) per attempt. Storing only a prompt digest was considered and cut: a digest cannot re-render a handshake retry.

`appliesFromAttempt` follows from the binding rule and is decided when the mutation is accepted. If the stage has an attempt that has not bound (state `pending` with `definition: null`), the mutation applies to that attempt and the response names it. Otherwise it applies to the next attempt the stage creates, numbered one past the last, whether the last is running, bounced into a wait, or settled. This covers the spawn-wait window a booked controller wait (`engine.ts:1933-1937`) or an account-lock wait (§3.4) opens: a note or an edit accepted while the attempt is still unbound reaches it; one accepted after it bound reaches the attempt after, and the response says so either way. A caller who wants a change to reach a bound attempt says `restart: true` (§3.3).

A running attempt is therefore defined by its own record, never by the stage it came from. That is the whole basis for "never applied under a running attempt silently": there is nothing to apply to.

### 3.3 Mutation API

All mutations go through `pipeline_action` and `PATCH /api/pipelines/<id>` with the same payloads; `PIPELINE_ACTIONS` (`types.ts:323-341`) stays the single declaration. Each mutation is validated, applied inside the existing record transaction (`store.ts:729-736`), appended to `mutations` with its actor, and bumps `revision`. A definition-changing mutation carries `expectedRevision`; a mismatch is refused with the current revision and the mutations since the caller's revision, so an agent re-reads and retries. Lifecycle mutations carry it optionally.

| Action | Payload | Allowed when | Effect on a stage whose attempt is running | Fence |
| --- | --- | --- | --- | --- |
| `edit-stage` (replaces `override-stage`) | `stageId`, any of `prompt`, `role`, `engine`, `model`, `effort`, `access`, `sandbox`, `outputs`, `account`, plus `restart?: boolean` | any non-terminal state, any stage, any attempt history | recorded as `pending-next-attempt`; with `restart: true` the running attempt is stopped through the identity-fenced stop path (`engine.ts:614`) and attempt n+1 starts from the current worktree | `expectedRevision` required |
| `add-stage` | `stage`, `index?` | any non-terminal state | inserted at its seam as today (`engine.ts:4022-4030`); a stage inserted before the cursor is history-only until an edge or a re-run reaches it | required |
| `remove-stage` | `stageId` | any non-terminal state; the stage has no attempts | n/a; a stage with attempts is routed around with `set-edge` | required |
| `reorder-stage` | `stageId`, `toIndex` or `stageIds` | any non-terminal state; only stages without attempts move | n/a | required |
| `set-edge` | `stageId`, `edge`, `to`, `maxRounds?` | any non-terminal state, ran or not, traversed or not | the running attempt keeps its `activatedBy`; the new edge applies at its next verdict | required |
| `rerun-stage` (replaces `retry-stage`) | `stageId`, `from: "worktree" \| "last-passed" \| { checkpoint }`, `note?`, `discardWorktree?` | `needs_decision`, `completed` (reopens the record), or `running` when no other attempt is mid-turn | refused while any attempt is mid-turn (host reports an active turn) | optional |
| `checkpoint` | `name` | any non-terminal state, no attempt mid-turn | the controller commits the worktree (`git add -A` for read-write, declared outputs for read-only, `git.ts:123-141`) and records `{name, sha}` | optional |
| `note` | `stageId`, `text` | any non-terminal state; at most `MAX_PENDING_STAGE_NOTES` pending on the stage | appended to `stage.notes`; the stage's next attempt to bind takes it (§3.2) and the response names that attempt in `appliesFromAttempt` | optional |
| `answer` | `text` | the cursor stage is parked in `needs_decision` | n/a: a parked attempt is settled and its host is not held; `answer` spawns attempt n+1 from the current worktree with the question and the text as a note (§3.6) | optional |
| `pause`, `resume` | none | as today | sets or clears the `paused` flag; parked stays parked | none |
| `skip-stage` | none | `needs_decision` | advances along the pass edge without resetting the worktree | none |
| `start`, `update-draft`, `set-position`, `link-task`, `unlink-task`, `set-src`, `delete`, `close` | as today | as today | unchanged | none |

Round limits: `set-edge` with `maxRounds` on a fail edge raises or lowers the budget at any time; the derivation stays `failEdgeRoundsUsed` (`engine.ts:1684-1689`), so lowering below the used count parks on the next fail verdict with the same detail as today. Swapping the next reviewer is `edit-stage` on the reviewer stage between rounds; nothing separate is needed.

Every mutation response says what happened: `{ revision, mutation: { seq, effect, appliesFromAttempt } }`. An agent that edits a running stage reads `pending-next-attempt` and the attempt number it will apply to, in the same answer; `appliesFromAttempt` is always set for a stage-scoped mutation (§3.2).

**Bound on the log.** `mutations` holds at most `MAX_PIPELINE_MUTATIONS` entries (200, declared in `limits.ts` beside the other record bounds), and a payload text field over 1,000 characters is stored as `{ digest, length }`, so the worst case is about 200 KB per record. When an accepted mutation would exceed the cap, the same mutation path first projects the record's mutations into the lifecycle journal (`projectPipelineEvents`, `projector.ts:98`, appended under idempotent keys by `appendLifecycleEvents`, `journal.ts:214-254`) and then drops the oldest entries down to the cap, recording `mutationsCompactedThrough`. Nothing is refused at the cap: a pause must always be accepted. The journal keeps its own capacity and retires ids past it (`journal.ts:247-250`), so the readable history is the record's tail plus the journal's retained range, and a mutation older than both is gone, as pause and resume history is today. `stage.notes` is bounded separately: at most `MAX_PENDING_STAGE_NOTES` (10) pending notes per stage, each at most `MAX_STAGE_PROMPT_LENGTH`; an eleventh is refused until an attempt binds, since ten unconsumed notes on one stage is a caller looping, not a workflow.

### 3.4 Lifecycle-aware settlement

Today's rule: the first terminal turn without a verdict starts a 90 s recovery budget and then settles the attempt as failed. The new rule, ADR-0003:

**A terminal turn settles an attempt only when nothing is pending for it.** In order:

1. A terminal turn whose last assistant message carries a valid fenced verdict settles immediately, as today (`engine.ts:2162-2169`). A verdict outranks every pending signal: the agent said it was done.
2. Otherwise the attempt is `waiting` when any of these holds, and no recovery check is spent while it does:
   - **Background task.** The transcript's stable tail contains the harness's background-task start (a tool result announcing a background task id) with no later completion notification for that id. The notification is a user record the reader already classifies (`src/lib/session/reader.ts:124-130`, `src/lib/claudeProtocolUser.ts:61-63`); the start-record parser is new in `durableEvidence.ts`. Codex has no equivalent record: its turn stays open while tools run, so the predicate is false there. `until` = `since` + a ceiling, 30 min by default.
   - **Provider throttle.** The turn ended on a provider notice the CLI classifies as retryable (overload, transient rate limit); a usage limit is the next case. `until` = the provider's stated reset or a bounded recheck, following the #611 shape (`flows/types.ts:62-81`). When it lapses the controller delivers one continuation (§3.6) into the same conversation; a dead host means attempt n+1 from the worktree.
   - **Account limit.** Unchanged: `recoverUsageLimitedAttempt` (`engine.ts:1111-1174`) fails over to another allowed account by creating attempt n+1 in the same worktree, and the parked attempt shows `waiting.kind = "account-limit"` with the reset beside the error string.
   - **Account lock and host rebinding.** Spawn-time transients. The busy account lock (`accountMutation.ts:46-51`) and the controller between publications (`engine.ts:2834-2836`) both book the existing wall-clock wait (`engine.ts:2865-2887`) and show as `waiting`; the transient set is decided by error type, and the substring list (`engine.ts:2838-2842`) goes away. The spawn path takes the async lock form (`accountMutation.ts:65-69`, `289-299`) so it queues and never throws.
3. When nothing is pending and the turn is terminal without a verdict, verdict recovery runs exactly as today (`engine.ts:1028-1070`), visible as `waiting.kind = "verdict-recovery"`.
4. A ceiling that lapses parks the attempt naming what it waited for ("waiting for background task <id> exceeded 30 min"), and only then is `completedAt` stamped, so the reaper (`engine.ts:3815`) never stops a host the attempt is still waiting on.

The board and `list_pipelines` show `waiting` on the stage card; the orchestrator's "every running stage must have transcript activity in the last 20 min" heuristic (`.claude/skills/llv-conveyor/SKILL.md`) reads it and stops guessing.

### 3.5 Publication binding

Every attempt records `headAtStart` when it is created and `headAtSettle` at settlement, both from `currentPipelineBranchHead` (`git.ts:193`). Two rules follow (#1409, points 1 and 2):

- A read-write stage settling `pass` on an attempt activated along a fail edge (`activatedBy.edge === "fail"`) must have advanced the head. If `headAtSettle === headAtStart`, the pass is refused and the attempt parks as `needs_decision` naming the unchanged SHA. A pass on a first activation with no change stays legal (a verification stage changes nothing).
- The fail-edge input (`engine.ts:1694-1700`) carries the reviewer's `headAtStart` as "reviewed at <sha>", and a reviewer attempt whose `headAtStart` differs from the pipeline's `publishedCommit` is refused before spawn, so no reviewer runs at a head nobody published.

Case C of #1409 (committed, could not push) is already caught by the controller publishing at settlement (`engine.ts:1760-1768`); the new fields make the report name the two SHAs.

### 3.6 Pause as a flag; answers; continuation only for throttles

`paused` is a flag beside the state. Pausing a parked record leaves `needs_decision` visible; resuming it leaves it parked with its decision affordance. The tick's skip condition (`engine.ts:3078`) reads the flag. This removes `pausedState` and the masking in #852.

**A parked attempt is settled and its host is not held.** A `needs_decision` verdict is a verdict, so the attempt reads as turn-settled (`engine.ts:3815`) and the terminal host reaper stops its host on the next sweep (`engine.ts:2963-3056`), exactly as today. Holding that host until the operator answers was considered and cut: an idle structured host costs on the order of half a gigabyte of resident memory (#747), a decision routinely arrives hours later, and any affordable hold would lapse before most answers and leave two code paths chosen by timing. `answer { text }` on a parked cursor stage therefore has one behaviour: it creates attempt n+1, which binds (§3.2) and spawns from the current worktree, with no reset, under a titled note that carries the parked attempt's question (its verdict findings and `stateDetail`) and the operator's text. If the reaper has not yet reached the old host, the spawn names it in `supersedes` (`engine.ts:1976`) and the reaper stops it on its sweep; nothing ever delivers into a parked conversation. #852's contract holds: the park stays visible under pause, plain resume leaves it parked, one canonical action creates one fresh attempt carrying the answer, a repeated call with the same `clientRequestId` replays the same mutation, and a live host is never taken over.

**Continuation exists for one caller: a provider throttle.** A throttled attempt is `waiting`, not settled: no verdict and no `completedAt`, so the reaper never lists it as a candidate (`engine.ts:2969`, `3815`) and the host stays. When the wait lapses the controller delivers one continuation into the same conversation through the structured delivery path with an idempotent client-message identity (the call the flow relay makes today, `flows/engine.ts:381`), recorded as attempt n+1 with `continuesAttempt = n`; a host that died during the wait means attempt n+1 spawns from the worktree instead. This is the one piece of the flow engine that survives the retirement, moved to `src/lib/pipelines/continuation.ts`.

### 3.7 Loops

The only loop is a fail edge from a reviewer run stage to a fixer run stage with `maxRounds`. Each round is a fresh fixer attempt in a fresh conversation superseding the last (`engine.ts:1961-1976`), which is the rotation #1073 asked for, at every round. A reviewer stage is a run stage with the reviewer role, `access: read-only` and, when isolation matters, `sandbox: restricted` (`src/lib/pipelines/stageSandbox.ts`); the #393 isolation rule is a role fence. The `review-loop` stage kind, the embedded flow, the headless reviewer process, the 2,000 character note, `reviewFlowSync` and the bound-flow reconcilers retire. Effort per round is `edit-stage` between rounds.

### 3.8 Attribution and the journal

Every mutation records its `actor`. The MCP binding derives it from the caller's server-side attribution the way `pause` does today (`bindings.ts:550-557`) and passes it for every action; the HTTP route passes the operator actor; controller-originated changes (automatic checkpoints, failover attempts, continuation deliveries) record the controller. The lifecycle projector (`projector.ts:98`) gains one source: each mutation projects to an event keyed `pipeline:<id>:mutation:<seq>`, so the journal names who changed what, idempotently on replay.

### 3.9 UI parity later, on the same API

The Viewer UI ships nothing in this pass. When it does, it calls `PATCH /api/pipelines/<id>` with exactly the payloads in §3.3; the route already admits the same action set the MCP schema publishes (`route.ts:12`, `types.ts:320-322`). The read model it needs is already what `list_pipelines` projects (`src/lib/pipelines/listProjection.ts`) plus three fields per stage card: `revision`, `waiting`, and whether the stage has pending edits (`definitionRevision` newer than the running attempt's `definition.revision`). The on-canvas stage editor from #118 and #189 (`override-stage`, add, remove, reorder on drafts) becomes the after-start editor by dropping its draft-only guard; that is the whole UI slice, and it is deferred.

### 3.10 What is retired

| Retired | Replaced by | Reference |
| --- | --- | --- |
| Flow record, `src/lib/flows/**`, `/api/flows`, `flow_action`, `list_flows`, `get_flow`, the Flow chip, `review-loop-presets.json`, `.claude/skills/review-loop` | reviewer run stage + fail edge; `pipeline_action` | §3.7 |
| Workflow record, `src/lib/workflows/**`, `/api/workflows`, workflow UI | nothing; already dead | §1.4 |
| `review-loop` stage kind, `tickReviewStage`, `reviewNote`, `publishReviewIngressHead`, `reconcileBoundReviewFlow`, `reconcilePipelineEmbeddedFlows`, `reviewFlowSync` | same | `engine.ts:2307-2556`, `2692-2737` |
| `override-stage`, `retry-stage` | `edit-stage`, `rerun-stage` (aliases kept for one release) | §3.3 |
| `pausedState` | `paused` flag | §3.6 |
| worktree reset on `skip-stage` | plain advance | §3.3 |
| `verdictRecoveryResetRefusal` | moot: `rerun-stage from: "worktree"` needs no reset | `engine.ts:3698-3713` |
| successor-pipeline and checkpoint-branch guidance in the skills | `rerun-stage`, `add-stage`, `set-edge`, `checkpoint` | `.claude/skills/llv-conveyor/SKILL.md:14-16, 35, 64` |

## 4. Validation

### 4.1 Against the operator's words

- "нету функции изменения пайплайна … каждый раз пересоздавать" → §3.3: every definition and graph field of a started record is editable; `rerun-stage` reopens a completed record; nothing requires recreating.
- "по пайплайнам и флоу, и ревью-флоу … интегрировать всё в одно" → §3.1, §3.7, §3.10: one record, one engine, one API, one store; flows and workflows retired, the review loop is a graph pattern of the same record.
- "менять легко: в первую очередь агент, во вторую очередь UI" → §3.3 and §3.8: `pipeline_action` grows the mutations first with a typed schema and attribution; §3.9: the UI later calls the same route with the same payloads and ships nothing now.

### 4.2 Against each incident

| Incident | Would the model have prevented it | How |
| --- | --- | --- |
| #1441 | yes, all three | the attempt is `waiting` on the background task, no recovery check is spent, `completedAt` is not stamped, the reaper does not stop the host; the notification opens a new turn and the verdict settles it |
| #1433 | yes | the busy lock is a typed transient that books the wall-clock wait inside the same attempt; the spawn path queues on the async lock and never throws; the record shows `waiting.kind = "account-lock"` |
| #1409 | yes, cases A and B; case C named | a fail-edge round that settles `pass` at an unchanged head is refused with the SHA; the reviewer's head travels in the fail-edge input; a reviewer at an unpublished head is refused before spawn |
| #1374 | yes | no clean-HEAD wall (the flow is gone); a passed architect stage commits its declared outputs every round; `rerun-stage from: "worktree"` tolerates a dirty tree; `checkpoint` exists |
| #452 | yes | no note cap (the reviewer is a full stage prompt); `edit-stage` works on a stage with failed attempts |
| #852 | yes | `paused` is a flag so the park stays visible and plain resume leaves it parked; `answer` creates one fresh attempt from the worktree carrying the question and the operator's text, idempotent on `clientRequestId`; nothing is delivered into the parked host, which the reaper stops as today |
| #1073 | yes | the fail-edge loop is the only loop and rotates every round; effort per round is an `edit-stage` between rounds |
| #340 | yes | one record, one API surface, one store; UI second |
| Successor pipelines | yes | `set-edge` raises `maxRounds` after exhaustion; `add-stage` after start; `rerun-stage` on a completed record |
| Checkpoint branches | yes | `rerun-stage` defaults to the current worktree; `checkpoint` names a state; only `{ checkpoint }` and `"last-passed"` reset, and only on a clean tree or with `discardWorktree: true` |
| Manual pushes after a read-only commit | yes | `edit-stage` changes `access` or `outputs` for the next attempt and `rerun-stage from: "worktree"` keeps the commit; the refusal itself stays as policy |

## 5. Migration

**Pipeline records.** Schema version 5 → 6 (`store.ts:18`, migration seam at `store.ts:486-491`): `revision = 0`, `mutations = []`, `checkpoints` seeded with one `stage:<id>:<n>` entry per passed attempt whose commit is known, `paused` derived from `state === "paused"` with `state` restored from `pausedState`, `definitionRevision = 0` and `notes = []` on every stage, `definition = null` and `notes = []` on every attempt, `waiting` derived from a pending `controllerWait` or `verdictRecovery`. An attempt without a binding renders from the live stage, which is today's behaviour; only attempts in `pending` at migration time can still bind, and they bind on their next spawning transition, so the fallback is deleted one release after slice 4. All other new fields default to `null` or `[]`. The archive collection migrates the same way on read. Nothing is dropped from old records.

**Flows.** Creation is refused first (`createFlowFromRequest`, `flows/commands.ts:133`, and the `review-loop` kind in `normalizeStages`, `engine.ts:3137`). Pipeline-owned flows in flight settle through the existing `reviewFlowSync` projection; on 2026-09-02 at most three such stages exist. After they settle, the flow engine, store, routes, tools and UI are deleted; the `flows` collection is renamed to `flows_archive` and read by nothing. Round artifacts under the state directory stay on disk as evidence. Attempts keep `flowId` and `reviewFlowSync` as frozen history.

**Workflows.** The one record is archived with the collection; engine, routes and UI are deleted in the same slice as flows.

**Skills and docs.** `docs/pipelines.md` and `docs/review-loop.md` merge into one document for the record; the orchestration skills replace their successor-pipeline and checkpoint-branch recipes with the mutations.

**Aliases.** `override-stage` maps to `edit-stage` and `retry-stage` to `rerun-stage from: "last-passed"` for one release, recorded in the mutation log under their new names.

## 6. Implementation plan

Twelve slices, each an issue. Every file has exactly one owning lane for the whole plan (§6.1); a slice that needs files from two lanes lists both, and the lanes land their parts in the slice's order. No file appears under two lanes anywhere in §6.3.

### 6.1 File ownership

| Lane | Files owned, with their tests |
| --- | --- |
| A (record and store) | `src/lib/pipelines/types.ts`, `store.ts`, `validation.ts`, `limits.ts`, `src/lib/pauseResumeActor.ts`, `src/lib/accounts/accountMutation.ts`, `src/lib/lifecycle/projector.ts` |
| B (engine) | `src/lib/pipelines/engine.ts`, `durableEvidence.ts`, `prompts.ts`, `git.ts`, `listProjection.ts` |
| C (transports) | `src/lib/mcp/server.ts`, `src/lib/mcp/bindings.ts`, `src/app/api/pipelines/[id]/route.ts` |
| D (continuation) | new `src/lib/pipelines/continuation.ts` |
| E (retirement) | `src/lib/flows/**`, `src/lib/workflows/**`, `src/app/api/flows/**`, `src/app/api/workflows/**`, `src/components/flows/**`, `src/components/workflows/**`, `src/components/ProjectDashboard.tsx`, `ProjectRail.tsx`, `OverviewBoard.tsx`, `projectModel.ts`, `src/components/runtime/runtimeModel.ts`, `src/components/mobile/**`, `src/components/scheme/**`, `docs/review-loop.md`, `.claude/skills/review-loop/**` |
| F (docs and skills) | `docs/pipelines.md`, `.claude/skills/llv-conveyor/SKILL.md`, `.claude/skills/live-log-viewer-orchestration/SKILL.md` |
| G (pipeline UI) | `src/components/pipelines/**` |

### 6.2 The gates

Both transports admit exactly `PIPELINE_ACTIONS`: the PATCH route builds its allow set from it (`route.ts:12`) and the MCP schema is `z.enum(PIPELINE_ACTIONS)` (`server.ts:1962`). Adding a name to that constant makes the action reachable from both at once, so the constant is the switch and nothing else pretends to be one. New actions land in a second constant beside it, `PIPELINE_ACTIONS_STAGED` (`types.ts`, lane A): `patchPipeline` accepts both sets, the engine tests call it directly as they do today, and neither transport admits a staged name. Slice 10 moves each name into `PIPELINE_ACTIONS` in the same change that publishes its typed payload. Three other gates are honest for the same reason. After-start graph edits (slice 6) are admitted only when the request carries `expectedRevision`, a field no caller sends before slice 10 publishes it, and a request without it meets today's refusal. The settlement and head-binding rules (slices 2 and 8) sit behind one environment kill switch, `LLV_PIPELINE_SETTLEMENT_V1`, which restores the 3 × 30 s rule and the unbound pass for one release. The retirement (slice 9a) starts with a refusal, which is the last cheap point to stop. Changes to actions already admitted (`pause` as a flag, `skip-stage` without a reset, the typed spawn transients) are live on merge and the table says so: they are the #852 and #1433 fixes.

### 6.3 Slices

| # | Issue title | Files (owner lane) | Depends on | Gate |
| --- | --- | --- | --- | --- |
| 1 | feat(pipelines): revision, attributed mutation log with cap and compaction, actor on every action | `types.ts`, `store.ts`, `limits.ts`, `pauseResumeActor.ts`, `projector.ts` mutation events (A) | none | additive; `expectedRevision` honoured only when present; the log projects to the journal from the first entry |
| 2 | fix(pipelines): settlement waits on pending background tasks and provider throttles (#1441) | `durableEvidence.ts`, `engine.ts` tickRunStage and reapers, `listProjection.ts` (B) | 1 | `LLV_PIPELINE_SETTLEMENT_V1` restores the 3 × 30 s rule for one release; until slice 7, a lapsed throttle wait spawns n+1 from the worktree |
| 3 | fix(pipelines): transient spawn failures wait inside the attempt (#1433, #1114) | `accountMutation.ts` async lock on the spawn path (A); `engine.ts` spawn path, classification by error type (B) | 2 | live on merge: it is the #1433 fix, and the park after the wait budget is today's behaviour |
| 4 | feat(pipelines): edit-stage after start; attempts bind their definition at the spawning transition | `types.ts` staged constant and attempt fields (A); `engine.ts` patchPipeline, newAttempt and the spawning transition, `prompts.ts` renders from the attempt (B) | 1, 3 | `edit-stage` in `PIPELINE_ACTIONS_STAGED`, unreachable from both transports; binding is behaviour-preserving, the copy is taken at the instant the prompt is rendered today |
| 5 | feat(pipelines): rerun-stage from worktree or checkpoint, checkpoint action, pause as a flag, skip without reset (#852) | `types.ts` (A); `engine.ts`, `git.ts` (B) | 4 | `rerun-stage` and `checkpoint` staged; the `paused` flag and the reset-free `skip-stage` are live on merge as the #852 fix; `retry-stage` keeps resetting until slice 10 aliases it |
| 6 | feat(pipelines): add, remove, reorder stages and rewire edges after start; editable round budgets | `store.ts` graph validators, `validation.ts` (A); `engine.ts` (B) | 5 | admitted after start only with `expectedRevision`; a request without it meets today's refusal |
| 7 | feat(pipelines): notes for the next attempt, answer, provider-throttle continuation | `types.ts` (A); `engine.ts`, `prompts.ts` note block (B); `continuation.ts` lifted from `flows/engine.ts` sendToImplementer (D) | 5 | `note` and `answer` staged; continuation replaces the slice-2 fallback for a lapsed throttle wait, behind the same kill switch |
| 8 | fix(pipelines): bind settlement to the published head (#1409) | `engine.ts` settlement, `git.ts` head reads (B) | 2 | behind `LLV_PIPELINE_SETTLEMENT_V1` with slice 2 |
| 9a | chore: refuse new flows and review-loop stages | `flows/commands.ts` createFlowFromRequest (E); `engine.ts` normalizeStages (B); `server.ts` tool descriptions name the replacement (C) | 7 | the refusal is the switch and the last cheap point to stop |
| 9b | chore: delete the flow and workflow engines, routes, tools, UI and skill | `src/lib/flows/**`, `src/lib/workflows/**`, `src/app/api/flows/**`, `src/app/api/workflows/**`, `src/components/flows/**`, `src/components/workflows/**`, `ProjectDashboard.tsx`, `ProjectRail.tsx`, `OverviewBoard.tsx`, `projectModel.ts`, `runtimeModel.ts`, `mobile/**`, `scheme/**`, `docs/review-loop.md`, `.claude/skills/review-loop/**` (E); `engine.ts` review-loop tick, reconcilers and `reviewFlowSync` writers (B); `server.ts` and `bindings.ts` flow tools (C); `store.ts` review-loop migration shims and `projector.ts` review-stage verdict event (A); `src/components/pipelines/StageCompletedCard.tsx` review-loop branch (G) | 9a, and every in-flight review-loop attempt settled | deletion |
| 10 | feat(mcp): typed per-action payloads, actor on every mutation, revision and mutations in get_pipeline; staged actions admitted | `types.ts` moves each staged name into `PIPELINE_ACTIONS` and adds the `override-stage` and `retry-stage` aliases (A); `server.ts`, `bindings.ts`, `route.ts` (C) | 1, and each action as lane B lands it | this is the switch for slices 4 to 7 |
| 11 | docs(pipelines): one record document; skills drop successor pipelines and checkpoint branches | `docs/pipelines.md`, `llv-conveyor/SKILL.md`, `live-log-viewer-orchestration/SKILL.md` (F) | 10 | docs |
| 12 | feat(ui): after-start stage editor on the same PATCH payloads | `src/components/pipelines/**` (G) | 10, 11 | deferred; named here so nobody designs a second API for it |

Lane B lands slices 2 to 8 in order, then its parts of 9a and 9b. Lane A lands its parts of 1, 3, 4, 5, 6, 7, 9b and 10 in that order. Lane C lands 9a's descriptions, 9b's deletions and 10. Lanes D, E, F and G each own one slice's worth of files. Slice 2 goes first after the log because it removes the most expensive failure class in §1.5.

## 7. Deferred, not currently justified

- **Findings ledger across rounds** (#1409, point 3): keep findings open until a reviewer clears them at a newer head. Point 1 alone catches all three observed cases; a ledger is new state with its own reconciliation.
- **Continuing the standing fixer conversation across fail-edge rounds** (the flow's relay model). Fresh-per-round is the observed practice and the quota-cheaper one (#1073); the continuation primitive in §3.6 makes this a small option later if a lane asks for it.
- **Automatic effort ladder per round** (#1073's knob): `edit-stage` between rounds does it by hand; a policy field waits for evidence that agents want it automated.
- **Adopting an existing conversation as a stage's first attempt** (the standalone flow use case): `adoptAttempt` exists for lineage (`engine.ts:1348`); no standalone flow has been created since 2026-08-25.
- **Headless one-shot reviewers** (`codex exec`, `claude -p`) as a cheaper stage host kind: 297 reviewer stages ran as full conversations in two weeks without asking for it.
- **Fan-out, parallel stages, voting panels**: already deferred by `docs/pipelines.md`; nothing in the quote asks for them.
- **A separate mutation collection or event store**: the record's own bounded array is enough and keeps one transaction.
- **Renaming pipelines to automations** in code, tools and routes.
- **UI editor**: named in slice 12, explicitly second.
- **Holding a parked attempt's host so an answer can continue its conversation** (#852's live-idle-host case): an idle host costs on the order of half a gigabyte (#747) and decisions arrive later than any affordable hold, so `answer` spawns fresh with the question as a note (§3.6). If the state store later shows most answers landing within minutes, a bounded hold the reaper honours like `waiting` is the shape.
- **Editing `task` or `spec` after start**: both are pinned into every attempt's prompt, and a change would split the record's attempts across two contracts without a record of which ran under which. `update-draft` stays draft-only; a changed contract is a `note` on the stages it affects.

## 8. Over-engineering pass on this design

Cut from the first draft: a new `Automation` type and store beside the pipeline record (the pipeline record already is the survivor); hot-applying an edit to a running attempt (impossible for a delivered prompt and unsafe for everything else, so the only honest behaviours are defer or restart); a `waiting` sub-state machine of its own (it is one field read from existing bookkeeping); a per-mutation approval flow (the operator's standing rule is that nothing asks for confirmation); templates and presets for whole graphs (the role registry already carries per-role presets, and `create_pipeline` takes the graph); a second HTTP surface for the UI (it calls the existing route). What remains is one record, one action list, one settlement predicate, and deletion of two engines. Cut in revision 2: the continuation branch of `answer`, which was unreachable under the reaper the design keeps (§3.6), and the per-attempt prompt digest, which could not re-render a handshake retry (§3.2).
