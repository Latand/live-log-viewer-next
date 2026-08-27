# OpenClaw as a third engine (issue #1207)

## The originating requirement

Verbatim, from the operator's request line in GitHub issue #1207 (opened
2026-08-27, `gh issue view 1207`):

> Support OpenClaw as a third engine, at the same level Claude and Codex
> already are: the Viewer scans and renders OpenClaw conversations, and the
> Viewer can host an OpenClaw agent as a structured host (spawn, deliver a
> message, stream the turn, resume, kill).

Everything below is validated against that sentence. Scope beyond the sentence
is preserved in **Deferred — not currently justified**.

## Evidence discipline

Two sources: this repository, and read-only inspection of the OpenClaw
2026.6.10 install on the development machine. Source evidence was re-verified
against `origin/main` at `dbfa3753` on 2026-08-27. That commit includes the
structured-host inventory and kill work from #1203. No OpenClaw state was
written, and the operator's running Gateway was not started, stopped or
reconfigured.

The real session files hold the operator's private messaging history. Nothing
from them is reproduced here. Every shape below is described abstractly, every
identifier is invented (`agent:demo:local:main`, agent id `demo`), and every
count is an aggregate over files whose contents are not quoted.

Where the issue's starting facts turned out to be wrong, this document says so
and cites what was measured instead.

---

## Summary of decisions

| # | Question | Decision |
|---|----------|----------|
| a | Engine surface | Add `openclaw` to `Engine` and `Fmt`. Use explicit third arms at the viewing call sites. Defer the repository-wide hostability predicate and root-descriptor abstraction. |
| b | Viewing | The session file alone is authoritative for the message chain **and** for model/provider. The trajectory supplies only `sessionKey`. Checkpoints are excluded from discovery. |
| c | Project attribution | Add an exact-workspace pure path recognizer before disk-dependent resolution, and call the existing overlay for OpenClaw roots. Descendant repositories retain normal repository attribution. |
| d | Hosting transport | Keep ACP as the leading candidate. Do not select it for implementation until an isolated Gateway proves cancellation and kill parity. The installed bridge lacks status and model methods and hides `chat.abort` failures. |
| e | Phasing | Phase 1 ships viewing in one PR: discovery, stable attribution, list/search, model and effort display, turn state, and structured feed rendering. Hosting remains phase 2 after its transport gates pass. |

---

## Corrections to the issue's starting facts

Verification changed four of the issue's starting facts.

**1. Model and provider do not come from the trajectory file.** The issue says
"The trajectory file supplies model/provider/run metadata; the session file
supplies the message chain." Measured over the 54 session files (2 940 message
records): every `"assistant"` record carries `model`, `provider`, `api`,
`usage` and `stopReason` on the inner message object. All 1 452 of them. The
trajectory is not needed for any of it.

**2. The trajectory is not reliably a sibling of the session file.** Of 54
session-file basenames and 58 trajectory basenames, 40 pair by name; 14 session
files have no trajectory and 18 trajectories have no session file. Any join
must go through the `session.started` event's `sessionFile` field, which points
at the transcript explicitly, and must tolerate both halves being absent.

**3. The filename is not the session id.** 17 of 54 session files are named
`<sessionId>-topic-<n>.jsonl`, and their header `id` is the bare session id
without the `-topic-<n>` suffix. Header ids are bare v4-shaped ids in 52 of 54
cases and are unique across all files and across both agent ids. The header is
the identity; the filename is not.

**4. Each checkpoint is a self-contained transcript.** The one checkpoint file
present has its own `"session"` header and `parentId`-chained message records.
The session file named by that checkpoint does not exist. Merging the checkpoint
would duplicate its complete history. Phase 1 excludes
`*.checkpoint.*.jsonl` from discovery.

The `-topic-<n>` naming and the checkpoint-as-fork shape are inferences from
file structure; OpenClaw's own semantics for them were not read out of its
source and remain **uncertain**. The design only relies on the measured shape
(self-contained transcript, header id, no base file), which is enough to decide
exclusion.

---

## (a) Engine surface

### What is actually there

There are already **four** engine unions with three different memberships:

- `src/lib/types.ts:13`: `export type Engine = "codex" | "claude" | "shell"`
- `src/lib/types.ts:15`: `export type Fmt = "codex" | "claude" | "plain"`
- `src/lib/agent/cli.ts:29`: `export type AgentEngine = "claude" | "codex"`
- `src/lib/scanner/process.ts:14`: a second `AgentEngine` with the same members

Inline two-engine unions also appear across components, launch controls,
accounts, limits, registry, and runtime code. Most describe hostable engines or
engine-specific products. Phase 1 widens only the viewing types identified
below.

`Engine` already carries a third member. `"shell"` represents background tasks
under the `claude-tasks` root and appears in 18 non-test files. The existing
member shows that union widening has low direct cost; engine-specific behavior
creates the work.

### The branches, classified

At `origin/main` `dbfa3753`, the repeated
`engine === "claude" || engine === "codex"` idiom appears in 33 non-test
files. A repository-wide replacement would dominate phase 1 while preserving
its current behavior. Phase 1 changes only the viewing call sites that must
accept OpenClaw:

- `src/lib/scanner/index.ts:300` and `src/lib/scanner/observe.ts:76` decide
  whether to derive authoritative turn state.
- `src/lib/scanner/scanCache.ts:173` primes persisted turn evidence.
- `src/lib/scanner/projectCatalog.ts:582` decides whether a transcript enters
  the complete list/search catalog.

The other narrowing predicates govern host lifecycle, launch, account
migration, tasks, workflows, and runtime controls. They keep excluding
OpenClaw during phase 1.

Eight erasure coercions use `engine === "codex" ? "codex" : "claude"`.
Phase 1 fixes the two feed coercions at
`src/components/feed/parse.ts:1311,1486`, because OpenClaw prose and tool rows
reach them. The launch, review-flow, task-send, inbox, and live-turn coercions
remain unreachable for a view-only engine and move to phase 2.

The root-specific viewing work is bounded:

| Concern | Current gate at `dbfa3753` | Phase-1 change |
|---|---|---|
| Discovery | `src/lib/scanner/roots.ts:33-47`; `discover.ts:347` | Add the root and an explicit third branch. |
| Metadata and search text | `describe.ts:883,889-999` | Parse OpenClaw cwd, start time, title, and first prompt. |
| Project overlay | `describe.ts:1001-1035` | Route OpenClaw cwd through `projectInfoFromCwd`. |
| Turn state | `turnState.ts:92`; `activity.ts:156-194,428` | Replace the `codex: boolean` parameter and cache key with an engine discriminator. |
| Model | `scanner/model.ts:25-45` | Admit the root and read the latest real assistant model. |
| Effort | `scanner/effort.ts:10,17-30,62-64` | Admit the root and read `thinking_level_change`. |
| Complete catalog | `conversationCatalog.ts:15`; `projectCatalog.ts:582` | Add OpenClaw to the catalog type and filter. |
| Feed | `feed/parse.ts:226,1374,2127`; `feed/tools.ts:184-188` | Add a structured renderer and carry the engine through prose and tool rows. |
| Persisted shapes | `scanCache.ts:105,109,111`; `projectCatalog.ts:124,136-137`; `resourceCollector.worker.ts:53` | Widen validators together and bump the scan schema from 9 to 10. |

`turnStateFromRecords(records, codex: boolean, authoritative)` cannot express
OpenClaw. The false arm expects Claude records whose top-level type is
`assistant`; OpenClaw wraps assistant messages in a top-level `message` record.
The replacement parameter is `engine: "codex" | "claude" | "openclaw"`.
`activity.ts`, `scanner/index.ts`, `scanner/observe.ts`, and the persisted cache
pass that value without another boolean conversion.

### The seam

Phase 1 uses the seams already present:

1. `Fmt` selects `renderOpenclaw` beside the existing renderers in
   `src/components/feed/parse.ts`.
2. `RootKey` selects the explicit scanner branch in discovery, metadata, model,
   effort, and turn-state code.
3. `EngineHost` remains the phase-2 host boundary at
   `src/lib/runtime/engineHost.ts:100-108`.

A root descriptor adds an abstraction around three transcript roots and does
not reduce the phase-1 edits above. A global `isHostableEngine` migration adds
changes across 33 files before OpenClaw is hostable. Both move to
**Deferred — not currently justified**. Phase 2 can introduce one narrow
hostability helper after its transport is proven and its real call sites are
known.

---

## (b) Viewing

### Which file is authoritative

**The session file, `<sessionId>[-topic-<n>].jsonl`, is authoritative for the
message chain and for model/provider/turn-state.** The trajectory is
authoritative for one thing only: `sessionKey`. Checkpoints are excluded.

Measured shape, over 54 files:

- Record 1 of every file, without exception: `{"type":"session","version":3,
  "id","timestamp","cwd"}`. `version` was 3 in all 55 headers read.
- Record types thereafter: `"message"` (2 940), `"custom"` (33),
  `"model_change"` (23), `"thinking_level_change"` (23).
- Every `"message"` record has exactly `{id, parentId, timestamp, type,
  message}`, a `parentId` chain with the same structural role as Claude's
  `uuid`/`parentUuid`.
- `message.role` is one of `"user"` (205), `"assistant"` (1 452) or
  `"toolResult"` (1 283).

### Where model, provider and turn state come from

Inner `message` objects, on the assistant records:

- `model`, `provider`, `api` on all 1 452 assistant records.
- `usage` as `{input, output, cacheRead, cacheWrite, cost, totalTokens}` on
  1 451 of them. One record carries an OpenAI-native key set
  (`prompt_tokens`/`completion_tokens`/`total_tokens`) instead, so the reader
  must not assume the key set is invariant across OpenClaw versions.
- `stopReason` ∈ `{toolUse, stop, error, aborted}`.

`stopReason` is the turn-state signal. The last assistant record ending in
`stop` is a completed turn. `toolUse` keeps the turn busy, and `error` or
`aborted` ends it.

Two measured records use the synthetic provider value `openclaw`. Real model
outputs name an external provider. Synthetic records do not count as model
usage and cannot set the displayed model.

`model_change` and `thinking_level_change` records carry `{modelId, provider}`
and `{thinkingLevel}` respectively, which is where mid-conversation model and
effort changes come from.

### What the trajectory is for

`<base>.trajectory.jsonl` records share one flat key set across all 1 507
events measured: `{traceSchema, schemaVersion, seq, ts, type, source,
sourceSeq, traceId, sessionId, sessionKey, runId, workspaceDir, provider,
modelId, modelApi, data}`. Event types: `session.started`, `context.compiled`,
`prompt.submitted`, `tool.call`, `tool.result`, `model.completed`,
`session.ended`, `trace.metadata`, `trace.artifacts`, `turn.client_closed`.

Everything there except `sessionKey` duplicates the session file. `sessionKey`
does not appear in the session file and is needed only for hosting. Phase 1
excludes trajectories. Phase 2 reads the first `session.started` event and uses
its `data.sessionFile` back-pointer to join the key to the transcript.

"session" in the trajectory names a *run*. There were 143
`session.started` events across 58 files, one per submitted prompt.

### How a live session is detected

Two independent signals, and one of them does not work here.

**Signal 1: mtime and turn state.** `resourceActivity` at
`src/lib/scanner/discover.ts:337-340` grades by transcript age (`< 20 s` live,
`< 900 s` recent, else idle) and is engine-agnostic. Layered on it,
`src/lib/scanner/activity.ts:428` reads the transcript tail for turn state.
Once the OpenClaw branch of `turnStateFromRecords` exists, a trailing assistant
record with `stopReason: "toolUse"` reads as busy and one with `"stop"` reads
as done, matching the fidelity Claude and Codex have.

**Signal 2: process attribution is unavailable.** `argvEngine` at
`src/lib/scanner/process.ts:122` maps a live process
to an engine by binary basename, and `agentProcesses()` at `:155` pairs one pid
to one transcript by cwd. OpenClaw has no per-session process. One long-lived
Gateway process writes every session file for every agent id and every channel.
It was observed as one `node … openclaw/dist/index.js gateway --port <port>`
process. Mapping it to a conversation would attribute every OpenClaw
session to the same pid.

Phase 1 leaves `pid` and `proc` null for OpenClaw entries. `AgentEngine` stays
two-membered, so `src/lib/scanner/process.ts` remains unchanged.

### How the scanner discovers sessions across agent ids

The layout is `<stateDir>/agents/<agentId>/sessions/<sessionId>.jsonl`, where
`<stateDir>` is `~/.openclaw` by default, `~/.openclaw-dev` under `--dev`, and
`~/.openclaw-<name>` under `--profile <name>` (per `openclaw --help`), and is
overridable by `OPENCLAW_STATE_DIR`. There is no sessions-directory key in
`openclaw.json`; the path is derived from the state dir.

Discovery is therefore a two-level walk: enumerate `<stateDir>/agents/*/`, then
`sessions/*.jsonl` inside each. `scanRootEntries()`
(`src/lib/scanner/roots.ts:39`) already returns `[RootKey, string][]` and
already fans out over multiple account homes for both existing engines, so
OpenClaw contributes one entry per agent id and the existing realpath dedupe
applies unchanged.

The sessions directory is not clean, and the filter is the load-bearing part.
Beside real transcripts it holds `.trajectory.jsonl`, `.trajectory-path.json`,
`.codex-app-server.json`, `.acp-stream.jsonl`, `.checkpoint.<id>.jsonl`,
`sessions.json`, and dated `.bak` / `.deleted.<timestamp>` files from past
repairs. In the agent inspected, 58 trajectories, 58 `trajectory-path`
sidecars and 36 app-server sidecars against 54 transcripts, plus a long tail of
backups. `isTranscript(basename)`
admits `*.jsonl` and rejects any basename containing `.trajectory.`,
`.checkpoint.`, `.acp-stream.`, or a `.bak`/`.deleted.` segment. A rescan of
this shape without the filter would roughly triple the board's OpenClaw card
count with sidecars and dead backups.

`sessions.json` deserves a note because it looks tempting and should not be
used. It is a live index keyed by session key carrying `sessionFile`,
`sessionId`, `label`, `model`, `modelProvider`, token counts, `chatType`,
`lastInteractionAt` and `sessionStartedAt` (a ready-made metadata source). It
covered 21 entries against the 54 transcripts on disk, so it indexes only
recent sessions and would silently hide the rest. Phase 1 reads the transcripts.

### Rendering

`renderOpenclaw` calls the same primitives `renderClaude` does. The mapping:

| OpenClaw | Feed primitive |
|---|---|
| `role: "user"`, content string or `text` blocks | `addUserText` |
| `role: "assistant"`, `text` block | `addProse` |
| `role: "assistant"`, `thinking` block | `push({kind:"think"})` |
| `role: "assistant"`, `toolCall` block (`{id, name, arguments}`) | `registerCall(newToolEvent(…))` |
| `role: "toolResult"` record (`{toolCallId, toolName, isError, content}`) | `addOutput(toolCallId, text, isError)` |
| `custom` / `model_change` / `thinking_level_change` | `addSvc` |

This needs a third renderer because Claude stores a tool result as a
`tool_result` content block inside a `"user"` record; in OpenClaw it is a
top-level record with its own role. Translating OpenClaw into Claude's shape
would synthesize `"user"` records that the operator never sent. The third
renderer calls `addOutput` directly.

Content-block key sets to code against: `toolCall` is `{type, id, name,
arguments}` and sometimes carries `partialJson` or `input`; `thinking` is
`{type, thinking, thinkingSignature}`; assistant `text` sometimes carries
`textSignature`; the `toolResult` role's blocks are either `text` or a
`toolResult` block carrying both camelCase and snake_case id aliases. Read
`toolCallId` off the record itself; the block's copies are aliases.

---

## (c) Project attribution

### The measured problem

52 of 54 session headers carry the same `cwd`: the OpenClaw workspace,
`<stateDir>/workspace`. All 1 507 trajectory events carry the same
`workspaceDir`. The remaining two sessions' cwd is the home directory. Session keys
are channel-bound (`agent:<id>:<channel>:<kind>:<peer>…`,
`agent:<id>:cron:…`, `agent:<id>:main`) and name no repository.

The attribution decision must assign this shared workspace one stable project
that survives workspace deletion.

### Why the default answer fails the AGENTS.md invariant

The OpenClaw workspace **is itself a git repository**. It has a real `.git`
directory and no `origin` remote. Trace it through
`projectInfoFromCwd` (`src/lib/scanner/describe.ts:530`):

*While the directory exists:* no path recognizer matches, `hasGitMarker(cwd)`
is true so the persisted-map fallback at `:549-557` is skipped,
`repositoryRootForPath(cwd)` at `:568` returns the workspace, and
`projectIdentityFromRepositoryRoot` (`src/lib/projects/identity.ts:153`) finds
no remote and falls to `canonical = "local:" + realpath(root)`, minting
`repo-<digest>` with display name `workspace`.

*After the directory is deleted:* `gitDirectory(root)` at
`src/lib/projects/identity.ts:154` does `fs.lstatSync` on a path that is gone
and returns `null`. `repositoryRootForPath` returns `null`. `hasGitMarker` is
now false, so `:549` reaches `worktreeFromMemory` and then `persistedProjects`
which is populated from `flows` and `workflows` rows in `state.sqlite`
(`src/lib/scanner/describe.ts:492`), so a channel-bound session that never
joined a flow has no entry. Execution falls to `directoryProjectInfo()` at
`:562`, minting `dir-<digest>`.

`repo-<digest>` alive, `dir-<digest>` dead. Two different projects for the same
conversations, and every OpenClaw session that runs in the workspace fragments at once, because
they all share the one cwd. This is precisely the failure AGENTS.md describes: *"a
worktree's grouping must survive the checkout being deleted… Any mapping that
finds the parent repo only by reading on-disk git metadata silently fails
afterward."*

Any transcript whose cwd is a remote-less git repository has this hazard.
OpenClaw makes it systemic by putting 52 of 54 sessions in one such directory.

### The decision

**Add a pure path recognizer for the exact OpenClaw workspace directory, and
place it before every disk-dependent resolver.** AGENTS.md requires a path
recognizer when the path itself identifies the parent project.

```ts
/** Immediately after the scratchpad early-return at describe.ts:539. */
function projectInfoFromOpenclawWorkspace(cwd: string): ProjectInfo | null
```

It fires only when the normalized cwd equals `<stateDir>/workspace` for the
default state directory, `OPENCLAW_STATE_DIR`, or a
`~/.openclaw-<profile>/workspace` path. It returns the existing directory
identity computed from `path.resolve(workspace)`, with display name
`OpenClaw`. It never calls `realpathSync`, so the identity is identical before
and after deletion.

Three properties this buys, each of which the alternatives lose:

- **Stable across deletion**, because nothing on disk is consulted.
- **Ahead of the repo resolver**, so the workspace's incidental `.git` never
  mints a competing `repo-` identity.
- **Inside the existing id namespace** (`dir-<32 hex>`, which
  `isCanonicalProjectId` at `src/lib/projects/identity.ts:22` already accepts),
  so the implementation keeps the naming scheme required by AGENTS.md.

The exact-match boundary preserves a repository nested under the workspace.
That descendant falls through to `worktreeFromGitFile` and repository
resolution while it exists, then to the existing persisted worktree map after
deletion. The one measured home-directory session keeps the existing home
directory identity.

`resolveProjectOverlay` at `src/lib/scanner/describe.ts:1001-1035` also needs an
`openclaw-sessions` branch. It uses `projectInfoFromCwd(cwd, stateKey)` first
and `projectInfoFromTranscript(pathname, stateKey)` as the persisted fallback.
The recognizer alone would never run for an OpenClaw root because the current
overlay calls `projectInfoFromCwd` only from the Codex and Claude branches.

### One project for the whole workspace

Rejected: a project per OpenClaw agent id. `projectInfoFromCwd` receives no
agent id, so this option would mint project ids from transcript paths and add a
second identity scheme. The transcript path already carries the agent id for a
future card subtitle or sidebar grouping.

---

## (d) Hosting transport

### What the transport has to do

`EngineHost` at `src/lib/runtime/engineHost.ts:100-108` has six methods. Current
`origin/main` adds lifecycle requirements around that interface:

| Requirement | Current contract |
|---|---|
| Deliver a message | `send(entry): Promise<DeliveryReceipt>` with a truthful delivery outcome |
| Stream a turn | `attach(afterSeq): AsyncIterable<RuntimeEvent>` |
| Observe turn state | `health()` with status, active turn, event cursor, pid, and process start identity |
| Resume | Reconstruct a host for the same session and replay durable events |
| Interrupt | `interrupt(turnRef)` must fail when the engine does not confirm the abort |
| Release and resource kill | `release()` plus identity-bound `releaseIfOwned` in the concrete host |
| Inventory | The registry row must pass `structuredHostControl.ts:23-67` and the structured resource types at `resources.ts:163-207` |
| Process safety | `structuredHostControl.ts:268-451` fences termination by pid and start identity and verifies that the process tree is gone |

### The three candidates

**1. ACP bridge, `openclaw acp`.** This is the closest transport shape to the
existing Codex stdio host. Read-only inspection of OpenClaw 2026.6.10 found
handlers for initialization, session create/load/list/resume/close,
prompt/cancel, mode, and config-option changes. It emits `session/update` and
calls the client for permission decisions.

The installed server has no `session/status` handler and advertises no status
capability. It also has no `session/set_model` handler or model capability.
Its config options cover thinking level and several session behaviors; model
selection is absent. Generic methods found in the bundled ACP client and SDK
are not evidence that this bridge server implements them.

Health can be derived locally without a status RPC: child exit means dead,
release means unhosted, a pending prompt means active, a permission callback
means attention, and prompt completion means idle. The host must test this
state machine against protocol fixtures.

Cancellation remains a blocker. The bridge's cancel handler sends
`chat.abort`, catches and logs any failure, clears its local pending prompt,
and resolves it as cancelled. A failed Gateway abort therefore looks
successful to an ACP client. Killing the bridge process only closes the client;
the Gateway may continue the run.

**2. Gateway WebSocket.** A direct client could call `chat.abort` and preserve
its result, which gives it a possible route to real interruption. The cost is a
private Gateway protocol and a direct connection to the operator's messaging
service. This option stays behind the same isolated proof gate and needs a
separate security review before selection.

**3. `openclaw agent --json` per turn.** The command returns one terminal JSON
result. It provides no streamed deltas, permission channel, or proven remote
abort. It cannot meet the structured-host requirement.

### Transport decision gate

ACP is the leading candidate because it already provides session lifecycle,
stream updates, and permission callbacks over stdio. Implementation is blocked
until an isolated Gateway test proves all of these properties:

1. Start a synthetic session and a deliberately long turn.
2. Send `session/cancel` and verify the Gateway run terminates, transcript
   growth stops, and the client receives a failure when `chat.abort` fails.
3. Release the host during an active turn and verify the same termination
   outcome through the runtime and resource kill surfaces.
4. Resume the session through a fresh bridge and prove replay plus new streamed
   events without duplication.

The test uses an isolated `HOME`, `XDG_CONFIG_HOME`, `OPENCLAW_STATE_DIR`,
`LLV_STATE_DIR`, and `TMPDIR`. It must never connect to the operator's Gateway.
If stock ACP fails step 2, phase 2 must either add an upstream bridge fix that
propagates abort failure or select the direct Gateway transport after its own
proof. A detach-only release cannot ship under a control labelled kill.

Expected 5 has a separate gate. Effort maps to `session/set_mode` or the
advertised thought-level config option. Model control has no route in this ACP
server. Phase 2 must demonstrate a supported model method before enabling the
Viewer's model selector. Until then, OpenClaw model selection stays disabled
with an explicit unsupported reason.

Once the transport passes, replay remains Viewer-owned through a durable event
store. The session transcript is canonical across bridge restarts, while each
bridge process has its own runtime event cursor.

### The `node:sqlite` obstacle: root cause, fix, diagnosis

The observed failure comes from resolving `node` through a Bun child-process
shim. `openclaw` uses `#!/usr/bin/env node`, and the Viewer forwards `PATH`
through `CHILD_ENV_ALLOWLIST` and `subscriptionEnv` at
`src/lib/runtime/codexAppServerHost.ts:226,396-400`.

Bun 1.3.3 exposes a sharper trap: `require("node:sqlite")` can exit zero without
returning `DatabaseSync`. An ESM named import fails under that shim. The earlier
CommonJS exit-code probe therefore accepted the broken runtime.

The host resolves a Node interpreter and the OpenClaw entry script explicitly,
then spawns:

```
<node> <openclaw-dist-entry> acp --session <key> [--require-existing] ...
```

`LLV_OPENCLAW_NODE` and `LLV_OPENCLAW_ENTRY` provide explicit overrides. The
default resolver must reject Bun shim directories and include the selected
interpreter in any launch diagnostic.

The preflight stays small:

| Code | Check | Message must name |
|---|---|---|
| `openclaw_runtime_missing` | configured interpreter is absent or not executable | the resolved path and configuration source |
| `openclaw_runtime_lacks_sqlite` | `<node> --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; if (typeof DatabaseSync !== "function") process.exit(1)'` fails | the resolved interpreter and its version |
| `openclaw_entry_missing` | entry script is absent | the path that was probed |

Gateway reachability is part of ACP initialization and should surface the
bridge's own failure. A separate probe would duplicate the connection and auth
path. Tests prove that the Bun shim produces
`openclaw_runtime_lacks_sqlite`, while supported Node 22 and 26 runtimes pass.

---

## (e) Phasing

### The boundary

**Phase 1: viewing. Phase 2: hosting.** Viewing depends only on transcript
files and existing feed primitives. Hosting depends on a Gateway, a real Node
runtime, and remote-run termination semantics that remain unproven.

Phase 2 must build `SessionKey` from the transcript header id and the trajectory
session key. `src/lib/agent/sessionKey.ts:7-19` accepts a bare v4-shaped id;
OpenClaw topic filenames carry a suffix and cannot supply that value.

### What phase 1 ships

Phase 1 delivers Expected 1 and 2 in one PR. An OpenClaw card enters the full
catalog, receives stable project attribution, displays its real model and
effort, reports turn state, and opens through `renderOpenclaw`. The PR has no
plain-text fallback.

Work plan against `origin/main` at `dbfa3753`:

**1. Core unions.** In `src/lib/types.ts`, add `openclaw-sessions` to
`RootKey` and `openclaw` to `Engine` and `Fmt`. Keep both `AgentEngine` unions,
`StructuredHostRecord`, and `StructuredHostKillRef` two-membered because phase
1 creates no host.

**2. Discovery.** In `src/lib/scanner/roots.ts`, resolve
`OPENCLAW_STATE_DIR` with a `~/.openclaw` default and return one scan root per
`agents/<agentId>/sessions` directory. In `src/lib/scanner/discover.ts`, exclude
trajectory, checkpoint, ACP stream, sidecar, index, backup, and zero-length
files before ranking. Add explicit OpenClaw engine, format, and title fallbacks
at the resource-scope mapping around `:342-378`.

**3. Metadata, search, and attribution.** In
`src/lib/scanner/describe.ts`, parse cwd, timestamp, the first user prompt, and
the OpenClaw title. Generalize the search helper at
`:883-886` to an engine discriminator. Add the exact-workspace recognizer after
`:539` and the OpenClaw project overlay after `:1030`.

**4. Turn state.** Replace the boolean discriminator and cache field in
`src/lib/accounts/migration/turnState.ts` and
`src/lib/scanner/activity.ts`. Add explicit OpenClaw arms in
`src/lib/scanner/index.ts:300`, `src/lib/scanner/observe.ts:76`, and the
persisted-evidence path in `src/lib/scanner/scanCache.ts:173`.

**5. Model and effort display.** In `src/lib/scanner/model.ts`, admit the root
and read the newest assistant record whose provider is a real provider. A
record with provider `openclaw` cannot replace the displayed model. In
`src/lib/scanner/effort.ts`, admit the root and read the latest
`thinking_level_change`; add `off` and `adaptive` to the accepted scale.

**6. Catalog and persisted shapes.** Add OpenClaw to
`src/lib/scanner/conversationCatalog.ts:15`, the catalog inclusion at
`src/lib/scanner/projectCatalog.ts:582`, and the validators in
`projectCatalog.ts:124,136-137`, `scanCache.ts:105,109,111`, and
`resourceCollector.worker.ts:53`. Bump `FILE_SCAN_CACHE_SCHEMA_VERSION` from 9
to 10 in the same change.

**7. Structured feed.** Add `renderOpenclaw` and a three-way `Fmt` dispatch in
`src/components/feed/parse.ts`. Widen its prose and tool-summary engine types,
plus `src/components/feed/tools.ts`, to carry `openclaw`. Emit one service row
when the real provider/model changes. Update `FeedItem.tsx`, `utils.ts`, and
`scheme/offscreenClusters.ts` so OpenClaw uses its own label, icon, and color on
the board and in the feed. The mapping table in section (b) defines the record
behavior.

**Tests**, all against invented fixtures under an isolated
`HOME`/`XDG_CONFIG_HOME`/`LLV_STATE_DIR`/`TMPDIR`, run by path:

- `src/lib/scanner/describe.test.ts` covers title/search text, the same
  workspace identity before and after deletion, the workspace's
  remote-less `.git`, the OpenClaw overlay, and a genuine nested checkout that
  retains repository attribution.
- `src/lib/scanner/discover.test.ts`: a fixture agent tree yields one entry
  per transcript, and zero for `.trajectory.jsonl`, `.checkpoint.<id>.jsonl`,
  `.acp-stream.jsonl`, `.trajectory-path.json`, `sessions.json` and `.bak`
  siblings.
- `src/lib/accounts/migration/turnState.test.ts`: `stopReason` of `stop`
  reads terminal, `toolUse` reads busy, `error`/`aborted` read terminal.
- `src/lib/scanner/model.test.ts` and `effort.test.ts` cover real model display,
  synthetic-provider exclusion, model changes, `off`, `adaptive`, and an
  unknown effort.
- `src/lib/scanner/conversationCatalog.test.ts` proves complete list and search
  inclusion, including first-prompt search.
- `src/app/api/files/scanCache.real.test.ts` and
  `src/lib/resourceCollector.test.ts` prove persisted OpenClaw entries survive
  validation.
- a new `src/components/feed/openclaw.parse.test.ts` covers the six-row mapping,
  provider/model service rows, tool-result attachment, and OpenClaw prose
  identity.
- `src/components/scheme/offscreenClusters.test.ts` covers the OpenClaw board
  color.

**Gates:** `bunx tsc --noEmit --incremental false`; the touched test files by
path; `bun scripts/privacy-publication-gate.ts --base <merge-base>
--check-commits`; a non-draft PR against `main` with an identity-free body.

### What phase 1 explicitly does not ship

`AgentEngine` and `SessionKey` stay two-engine. Phase 1 adds no process
recognition, spawn path, registry entry, delivery controller, model selector,
or effort selector. It displays recorded model, provider, and effort values.
The repository-wide hostability predicate also stays out of phase 1.

### Phase 2, sketched

Phase 2 starts with the isolated transport proof in section (d). After that
gate passes, its implementation map follows current `origin/main`:

1. Parse the bare session id from the transcript header, join the trajectory
   session key through `data.sessionFile`, widen `AgentEngine` in
   `src/lib/agent/cli.ts` and `SessionKey`, then add the two structured-spawn
   construction arms.
2. Implement the selected host with all six `EngineHost` methods,
   identity-bound `releaseIfOwned`, process start identity in `health()`, and a
   writer fence. `releaseIfOwned` must abort and verify the Gateway run before
   it reaps the bridge child.
3. Publish the host through `structuredDeliveryController.ts`, including state
   projection, generation rebind, owned termination, and registry retirement.
4. Extend `structuredHostControl.ts:23-67`, `resources.ts:163-207`, the resource
   validators, and the runtime-host API so OpenClaw appears in inventory and
   the resource kill path carries the same pid/start-identity fence. An orphan
   bridge cannot report kill success unless a fresh control path verifies the
   Gateway run ended.
5. Extend `scanner/process.ts` so the bridge process carries the structured-host
   stamp and is attributable without matching the shared Gateway process.
6. Wire effort control through the proven ACP mode/config method. Enable model
   control only after the transport proof demonstrates a supported model
   method.

This is a separate PR and issue. It includes protocol fixtures plus isolated
Gateway tests for prompt streaming, attention, resume, runtime kill, resource
kill, abort failure, process-identity mismatch, controller rebind, and replay.

---

## Baseline and file ownership

The evidence and line references in this revision use `origin/main` at
`dbfa3753` (2026-08-27). That baseline includes the merged structured-host
inventory, process-stamp, identity-fenced release, and resource-kill work from
#1203, plus the feed and orchestration work named in the task.

No file fence remains. The implementer rebases this branch on current main
before editing, records the new merge base, and rechecks every cited branch
whose line moved. Phase 1 may edit the feed renderer directly and ships its
scanner, catalog, attribution, model, effort, cache, and presentation changes
in the same PR.

---

## Deferred — not currently justified

Cut from this design, with the reason. None of it is discarded.

**An engine-descriptor registry spanning the UI.** Would not fix the 107 binary
ternaries, which are the actual cost, and would abstract for a fourth engine
nobody has asked for. Revisit if a fourth engine appears. See (a).

**A transcript-root descriptor in phase 1.** Three transcript roots do not need
a registry around their existing switches. Explicit OpenClaw branches are
shorter and keep each parser beside the shape it understands.

**The 33-file hostability-predicate migration.** Most of those predicates
guard launch, lifecycle, tasks, workflows, or account behavior. OpenClaw cannot
reach them during phase 1. Phase 2 may introduce a helper for the smaller set
its proven transport actually needs.

**Host-only erasure coercions.** Draft launch, direct reviews, task send, inbox,
and live-turn rows have no OpenClaw producer in phase 1. They move with the
hosting work so each third arm has a real behavior and test.

**Merging trajectory and checkpoint files into the conversation.** The issue's
Expected 1 assumes a three-file join. The evidence says the session file is
self-sufficient, the trajectory adds only `sessionKey`, and a checkpoint is a
complete alternative transcript whose merge would duplicate history. Building
the join would be machinery heavier than the problem.

**`sessions.json` as a metadata source.** Indexes only recent sessions (21 of
54 on the machine inspected); using it would silently hide the rest.

**Process-based liveness for OpenClaw.** One Gateway process writes every
session; pid attribution would map every conversation to the same pid.
Reconsider only if OpenClaw grows per-session processes.

**Model registry entries for OpenClaw's models.** `MODEL_REGISTRY`
(`src/lib/scanner/modelRegistry.ts:13`) is an Anthropic context-window
snapshot. OpenClaw runs OpenAI-family models through an OpenAI response API, so
`normalizeModelKey` finds no entry and `registryWindow` returns null. An unknown
context window is accurate. Adding OpenAI model windows creates a separate
maintenance surface.

**OpenClaw model control.** The installed ACP server exposes no model method or
model config option. Keep the selector disabled until the phase-2 transport
proof identifies a supported route.

**Account and limits integration.** `LimitsCache`
(`src/lib/limits.ts:38,50`) is `Record<EngineName, …>` behind `version: 2`;
adding a third key is a persisted-shape migration. OpenClaw has no Viewer-owned
subscription window to display. This stays out of scope until OpenClaw's
account model is understood.

**`openclaw agent --json` as a reduced send mode.** It can send one message and
return one terminal result. Streaming, attention, resume, and verified abort
remain unavailable, so it cannot satisfy the originating host requirement.

**Per-agent-id project grouping.** Presentational; can ride on card titles
without a second project-id namespace. See (c).

---

## Validation against the requirement

Read back against the quote at the top.

*"the Viewer scans and renders OpenClaw conversations"* is phase 1, items 1-7,
in one PR. Discovery, complete catalog/search, attribution, turn state,
model/provider/effort display, and the structured renderer ship together.

*"the Viewer can host an OpenClaw agent as a structured host (spawn, deliver a
message, stream the turn, resume, kill)"* remains phase 2. ACP is eligible only
after the isolated proof shows real run termination and propagated abort
failure. A transport that only detaches the Viewer fails this requirement and
does not ship.

*"at the same level Claude and Codex already are"* is met for the phase-1
viewing surface. Hosting reaches that bar only after runtime and resource kill,
resume, delivery, streaming, attention, inventory, and process identity pass
the phase-2 gates. Accounts, subscription limits, and shared-Gateway process
liveness have no equivalent OpenClaw concept and remain outside the request.
