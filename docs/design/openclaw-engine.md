# OpenClaw as a third engine (issue #1207)

## The originating requirement

Verbatim, from the operator's request line in GitHub issue #1207 (opened
2026-08-27, `gh issue view 1207`):

> Support OpenClaw as a third engine, at the same level Claude and Codex
> already are: the Viewer scans and renders OpenClaw conversations, and the
> Viewer can host an OpenClaw agent as a structured host (spawn, deliver a
> message, stream the turn, resume, kill).

This document designs the first half of that sentence — scanning and rendering.
Hosting is deferred with its open requirements in **(d) Deferred — hosting**;
other out-of-scope work is preserved in **Deferred — not currently justified**.

## Evidence discipline

Two sources: this repository, and read-only inspection of the OpenClaw
2026.6.10 install on the development machine. Source evidence was re-verified
against `origin/main` at `a3f9c2e2` on 2026-08-27. Every file cited below is
byte-identical between that commit and `dbfa3753`, the baseline of the previous
revision, so every line reference still resolves. `dbfa3753` carries the
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
| d | Hosting | **Not designed here.** No transport is selected, so there is nothing to build a lifecycle on. **(d) Deferred — hosting** records the measured candidates, the termination gate that has to be passed before one is chosen, and the ownership, concurrency and lifecycle questions a hosting design must answer. |
| e | Phasing | Phase 1 ships viewing in one PR: discovery, stable attribution, list/search, model and effort display, turn state, structured feed rendering, awaiting-user state, and Viewer snapshots. Hosting is a separate design that does not start until the termination gate passes. |

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

At `origin/main` `a3f9c2e2`, the repeated
`engine === "claude" || engine === "codex"` idiom appears in 33 non-test
files. A repository-wide replacement would dominate phase 1 while preserving
its current behavior. Phase 1 changes only the viewing call sites that must
accept OpenClaw:

- `src/lib/scanner/index.ts:300` and `src/lib/scanner/observe.ts:76` decide
  whether to derive authoritative turn state.
- `src/lib/scanner/scanCache.ts:173` primes persisted turn evidence.
- `src/lib/scanner/projectCatalog.ts:582` decides whether a transcript enters
  the complete list/search catalog.
- `src/hooks/useSwitchboardData.ts:72` decides whether a recent conversation
  counts as awaiting the user, which drives the waiting bucket and the
  attention counter.
- `src/lib/view/snapshot.ts:58` decides whether a focused or selected path
  resolves to a conversation the Viewer snapshot reports at all.

The last two are viewing surfaces outside the scanner. Without them an OpenClaw
card is scanned, attributed and rendered, then vanishes from the waiting bucket
and from every snapshot an agent reads, which is not the parity phase 1 claims.

The other narrowing predicates govern host lifecycle, launch, account
migration, tasks, workflows, and runtime controls. They keep excluding
OpenClaw during phase 1.

Eight erasure coercions use `engine === "codex" ? "codex" : "claude"`.
Phase 1 fixes the two feed coercions at
`src/components/feed/parse.ts:1311,1486`, because OpenClaw prose and tool rows
reach them. A ninth erasure of the same kind, the
`entry.engine as "claude" | "codex"` cast at `src/lib/view/snapshot.ts:63`, is
fixed together with the snapshot filter above it, since a widened filter that
kept the cast would report OpenClaw entries as Claude. The launch,
review-flow, task-send, inbox, and live-turn coercions remain unreachable for
a view-only engine and move with the hosting work.

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
| Awaiting-user state | `src/hooks/useSwitchboardData.ts:72` | Admit `openclaw`, so a finished OpenClaw turn reaches the waiting bucket. |
| Viewer snapshot | `src/lib/view/snapshot.ts:58,63`; `src/lib/view/types.ts:81` | Admit `openclaw` in the transcript filter, the reported engine, and `SnapshotConversation`. |
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
3. `EngineHost` at `src/lib/runtime/engineHost.ts:100-108` remains the
   boundary any hosting design has to satisfy. Phase 1 does not touch it.

A root descriptor adds an abstraction around three transcript roots and does
not reduce the phase-1 edits above. A global `isHostableEngine` migration adds
changes across 33 files before OpenClaw is hostable. Both move to
**Deferred — not currently justified**. A hosting design can introduce one
narrow hostability helper once its transport is proven and its real call sites
are known.

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
excludes trajectories; the `data.sessionFile` back-pointer that would join the
key to a transcript is recorded in **(d) Deferred — hosting** as the one join a
hosting design will have to make.

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

## (d) Deferred — hosting

**Hosting is not designed in this document.** The candidate transports were
measured and none can be selected yet, so this is a requirement list for a
hosting design carrying its own issue. **Nothing in it is answered here.**

### The candidates, and the gate that picks one

From read-only inspection of OpenClaw 2026.6.10 on the development machine:

- **ACP bridge, `openclaw acp`** — leading, closest to the existing Codex stdio
  host. The installed server advertises no status and no model capability, and
  its cancel handler swallows a failed `chat.abort` and resolves as cancelled,
  so a failed Gateway abort looks successful and killing the bridge only closes
  the client.
- **Gateway WebSocket** — a direct client keeps the `chat.abort` result, at the
  cost of a private protocol, a direct connection to the operator's messaging
  service, and its own security review.
- **`openclaw agent --json`** — rejected: one terminal result, no streamed
  deltas, no permission channel, no proven remote abort.

**No transport is selected and no hosting work starts until one passes this
gate against an isolated Gateway:** cancel a deliberately long turn and verify
the Gateway run terminates, transcript growth stops, and the client sees a
**failure** when `chat.abort` fails; release the host mid-turn and verify the
same outcome through the runtime and resource kill surfaces; resume through a
fresh bridge and prove replay plus new events without duplication. The gate runs
under an isolated `HOME`, `XDG_CONFIG_HOME`, `OPENCLAW_STATE_DIR`,
`LLV_STATE_DIR` and `TMPDIR` and never touches the operator's Gateway. If stock
ACP fails the cancel step, hosting carries an upstream bridge fix or selects the
Gateway transport after its own proof. A detach-only release cannot ship under a
control labelled kill.

### Requirements a hosting design must answer

**1. Ownership and concurrency for sessions that also receive Gateway turns.**
Session keys are channel-bound: a session a Viewer-owned bridge holds can also
receive turns from a messaging channel or from cron, with no Viewer
involvement. Bridge-local health inference — child exit means dead, a pending
prompt means active, prompt completion means idle — describes only the turns
the bridge itself issued, so a Gateway-originated turn leaves an idle-looking
host that is busy and an abort aimed at the wrong run. The design must say who
owns a session, what happens when a second writer takes a turn (refuse, observe
or serialise), what `health()` reports and `send()` promises while a foreign
turn runs, and how a writer fence behaves when the Viewer is not the only
writer.

**2. The lifecycle surfaces.** Beyond the six `EngineHost` methods, at minimum:
**startup re-adoption** of hosts that outlived the Viewer process; **persistence
binding** between the registry row, the durable event store and the transcript;
**registry host-kind validation** for a third kind, through
`structuredHostControl.ts:23-67` and `resources.ts:163-207`; **successor
publication** when a host is replaced, rebound or generation-bumped; and
**restart failure handling** — what the board shows when re-adoption fails, and
how a half-adopted host retires without reporting a kill it never performed.

**3. Identity, model and effort.** `src/lib/agent/sessionKey.ts:7-19` accepts a
bare v4-shaped id, which a `-topic-<n>` filename cannot supply; the bare id is
in the transcript header and the trajectory's first `session.started` event
joins `sessionKey` to it through `data.sessionFile`. That join is the whole cost
of phase 1's trajectory exclusion. For Expected 5, effort may map to
`session/set_mode` or the advertised thought-level option, while model control
has no route in the installed ACP server — the selector stays disabled with an
explicit unsupported reason until one is demonstrated.

### The `node:sqlite` preflight, retained

Kept because it is diagnosed and should not be rediscovered. `openclaw` uses
`#!/usr/bin/env node` and the Viewer forwards `PATH`
(`src/lib/runtime/codexAppServerHost.ts:226,396-400`), so `node` can resolve to
a Bun 1.3.3 shim where `require("node:sqlite")` exits zero without returning
`DatabaseSync` — which is why an exit-code probe accepted a broken runtime. A
host resolves interpreter and entry script explicitly (`LLV_OPENCLAW_NODE`,
`LLV_OPENCLAW_ENTRY`), rejects Bun shim directories, names the interpreter in
every launch diagnostic, and preflights three codes:

| Code | Check | Message must name |
|---|---|---|
| `openclaw_runtime_missing` | configured interpreter is absent or not executable | the resolved path and configuration source |
| `openclaw_runtime_lacks_sqlite` | `<node> --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; if (typeof DatabaseSync !== "function") process.exit(1)'` fails | the resolved interpreter and its version |
| `openclaw_entry_missing` | entry script is absent | the path that was probed |

Gateway reachability is part of ACP initialization and surfaces as the bridge's
own failure, so it needs no separate probe.

---

## (e) Phasing

### The boundary

**Phase 1 is viewing, and it is the only phase this document designs.**
Viewing depends only on transcript files and existing feed primitives. Hosting
depends on a Gateway, a real Node runtime, and remote-run termination semantics
that remain unproven, so it is a separate design gated on section (d).

### What phase 1 ships

Phase 1 delivers Expected 1 and 2 in one PR. An OpenClaw card enters the full
catalog, receives stable project attribution, displays its real model and
effort, reports turn state, and opens through `renderOpenclaw`. The PR has no
plain-text fallback.

Work plan against `origin/main` at `a3f9c2e2`:

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

**8. Awaiting-user state and Viewer snapshots.** `isAwaitingUser` at
`src/hooks/useSwitchboardData.ts:72` admits `openclaw`, so a recent OpenClaw
conversation that finished its turn reaches the waiting bucket and the attention
counter instead of sinking into the recency buckets. In
`src/lib/view/snapshot.ts`, `transcriptEntry` at `:58` admits `openclaw` so a
focused or selected OpenClaw path resolves instead of being dropped, and
`conversation` at `:63` drops the `"claude" | "codex"` cast and reports the real
engine; `SnapshotConversation["engine"]` at
`src/lib/view/types.ts:81` widens to match. `SnapshotSpawnStub`'s
`launch.engine` at `src/lib/view/types.ts:103` stays two-membered, because it
describes a spawn and phase 1 creates none.

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
- `src/hooks/useSwitchboardData.dom.test.tsx`: a recent OpenClaw conversation
  lands in the waiting bucket, while an OpenClaw subagent and a non-recent
  OpenClaw entry still do not.
- `src/lib/view/view.test.ts`: a selected OpenClaw path appears in the snapshot
  as `engine: "openclaw"` rather than being omitted or reported as Claude, and
  a path with no scan entry is still omitted.

**Gates:** `bunx tsc --noEmit --incremental false`; the touched test files by
path; `bun scripts/privacy-publication-gate.ts --base <merge-base>
--check-commits`; a non-draft PR against `main` with an identity-free body.

### What phase 1 explicitly does not ship

`AgentEngine` and `SessionKey` stay two-engine. Phase 1 adds no process
recognition, spawn path, registry entry, delivery controller, model selector,
or effort selector. It displays recorded model, provider, and effort values.
The repository-wide hostability predicate also stays out of phase 1.

---

## Baseline and file ownership

The evidence and line references in this revision use `origin/main` at
`a3f9c2e2` (2026-08-27); every cited file is unchanged since `dbfa3753`, which
carries the merged structured-host inventory, process-stamp, identity-fenced
release, and resource-kill work from #1203, plus the feed and orchestration work
named in the task.

No file fence remains. The implementer rebases this branch on current main
before editing, records the new merge base, and rechecks every cited branch
whose line moved. Phase 1 ships its scanner, catalog, attribution, model,
effort, cache, feed, awaiting-user and snapshot changes in one PR.

---

## Deferred — not currently justified

Cut from this design, with the reason. None of it is discarded. Hosting has its
own list in section (d).

**An engine-descriptor registry spanning the UI.** Would not fix the 107 binary
ternaries, which are the actual cost, and would abstract for a fourth engine
nobody has asked for. Revisit if a fourth engine appears. See (a).

**A transcript-root descriptor in phase 1.** Three transcript roots do not need
a registry around their existing switches. Explicit OpenClaw branches are
shorter and keep each parser beside the shape it understands.

**The 33-file hostability-predicate migration.** Most of those predicates
guard launch, lifecycle, tasks, workflows, or account behavior. OpenClaw cannot
reach them during phase 1. A hosting design may introduce a helper for the
smaller set its proven transport actually needs.

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

**Account and limits integration.** `LimitsCache`
(`src/lib/limits.ts:38,50`) is `Record<EngineName, …>` behind `version: 2`;
adding a third key is a persisted-shape migration. OpenClaw has no Viewer-owned
subscription window to display. This stays out of scope until OpenClaw's
account model is understood.

**Per-agent-id project grouping.** Presentational; can ride on card titles
without a second project-id namespace. See (c).

---

## Validation against the requirement

Read back against the quote at the top.

*"the Viewer scans and renders OpenClaw conversations"* is phase 1, items 1-7,
in one PR. Discovery, complete catalog/search, attribution, turn state,
model/provider/effort display, and the structured renderer ship together.

*"the Viewer can host an OpenClaw agent as a structured host (spawn, deliver a
message, stream the turn, resume, kill)"* is **not answered here**, and is not
claimed to be. No transport has passed the termination gate, so there is nothing
to design a lifecycle against; section (d) carries the open questions to the
design that will.

*"at the same level Claude and Codex already are"* is met for the phase-1
viewing surface: discovery, attribution, catalog and search, turn state,
model/effort display, feed rendering, the awaiting-user bucket, and Viewer
snapshots. Hosting reaches that bar only after section (d)'s gate and
requirements are both answered. Accounts, subscription limits, and
shared-Gateway process liveness have no equivalent OpenClaw concept and remain
outside the request.
