# OpenClaw as a third engine (issue #1207)

## The originating requirement

Verbatim, from the operator's request line in GitHub issue #1207 (opened
2026-08-27, `gh issue view 1207`):

> Support OpenClaw as a third engine, at the same level Claude and Codex
> already are: the Viewer scans and renders OpenClaw conversations, and the
> Viewer can host an OpenClaw agent as a structured host (spawn, deliver a
> message, stream the turn, resume, kill).

Everything below is validated against that sentence. Scope that the sentence
does not demand is preserved in **Deferred — not currently justified**.

## Evidence discipline

Two sources: this repository, and read-only inspection of the OpenClaw
2026.6.10 install on the development machine. Source evidence was first read at
`ac197031` and re-verified against `main` at `e61c1ce4`, which is the baseline
phase 1 is cut from — see *Baseline and lane ownership*. No OpenClaw state was
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
| a | Engine surface | A third union member on `Engine`/`Fmt`, in preference to an engine-descriptor registry. The seam is `Fmt` for rendering plus a named `hostable` predicate for lifecycle. |
| b | Viewing | The session file alone is authoritative for the message chain **and** for model/provider. The trajectory supplies only `sessionKey`. Checkpoints are excluded from discovery. |
| c | Project attribution | A pure path recognizer for the OpenClaw workspace, minting one stable directory identity, inserted ahead of every disk-dependent resolver. |
| d | Hosting transport | The ACP bridge (`openclaw acp`), spawned through an explicit real-Node interpreter, behind a four-check preflight whose every message names the interpreter it resolved. |
| e | Phasing | Viewing (phase 1) / hosting (phase 2). Phase 1 is one PR — scanning, attribution, turn state and structured rendering together — cut against `main` at `e61c1ce4`. |

---

## Corrections to the issue's starting facts

The issue asked for these to be re-verified rather than assumed. Four of them
did not survive.

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

**4. Checkpoints are not fragments to merge.** The one checkpoint file present
is a *complete* transcript in its own right — its own `"session"` header, then
its own `parentId`-chained message records — and the session file it is named
after does not exist. A checkpoint is an alternative branch of a conversation,
not a continuation of one. Merging it into the base conversation would
duplicate the whole history. Phase 1 excludes `*.checkpoint.*.jsonl` from
discovery.

The `-topic-<n>` naming and the checkpoint-as-fork shape are inferences from
file structure; OpenClaw's own semantics for them were not read out of its
source and remain **uncertain**. The design only relies on the measured shape
(self-contained transcript, header id, no base file), which is enough to decide
exclusion.

---

## (a) Engine surface

### What is actually there

There are already **three** engine unions with three different memberships:

- `src/lib/types.ts:13` — `export type Engine = "codex" | "claude" | "shell"`
- `src/lib/types.ts:15` — `export type Fmt = "codex" | "claude" | "plain"`
- `src/lib/scanner/process.ts:13` — `export type AgentEngine = "claude" | "codex"`

plus 38 inline `"claude" | "codex"` type literals spread over 18 non-test
component files — the "~15 component files" the issue counted — and more in
`src/lib`: `src/components/AccountBadge.tsx:31`,
`src/components/draftSpawn.ts:17`, `src/components/DraftAgentPane.tsx:54`,
`src/components/RuntimePill.tsx:548`, `src/lib/events.ts:65` and `:88`,
`src/lib/limits.ts:38`, `src/lib/limitsHistoryStore.ts:21`,
`src/lib/types.ts:680`, `src/lib/lifecycle/inventorySelection.ts:43`.

`Engine` already carries a third member. `"shell"` — background tasks under the
`claude-tasks` root — is referenced in 18 non-test files and the codebase
handles it without incident. **That is the empirical answer to "how much does a
third member cost": the widening itself is nearly free, and it has been paid
once already.**

### The branches, classified

308 engine comparisons across 124 non-test files
(`engine === "codex"`, `=== "claude"`, and their negations). They fall into
four classes, and only two of them matter.

**Class A — narrowing predicates, in 32 non-test files. Safe. Do not touch in
phase 1.**

The idiom `entry.engine === "claude" || entry.engine === "codex"` is the single
most repeated engine expression in the codebase. Representative sites:
`src/lib/scanner/index.ts:300`, `src/lib/scanner/observe.ts:76`,
`src/lib/scanner/scanCache.ts:173`,
`src/lib/lifecycle/inventorySelection.ts:98`,
`src/lib/lifecycle/liveness.ts:532` and `:681`,
`src/lib/session/titleTarget.ts:68`, `src/lib/session/titleStore.ts:163`,
`src/lib/accounts/migration/coordinator.ts:87`,
`src/lib/workflows/store.ts:218`, `src/lib/wakatime/operatorActivity.ts:84`,
`src/app/api/tasks/[id]/send/route.ts:80`,
`src/app/api/tasks/[id]/spawn/route.ts:221`, `src/lib/agent/registry.ts`
(2), `src/lib/runtime/commands.ts` (2), `src/lib/mcp/bindings.ts` (4),
`src/lib/tasks/store.ts`, `src/lib/pipelines/store.ts`,
`src/lib/view/snapshot.ts`, `src/hooks/useSwitchboardData.ts`. Reproduce the
full list with (add `-l` for the file list, which is the unit that matters —
several lines carry two matches, so an occurrence count lands anywhere between
35 and 39 depending on how you count):

```
grep -rnE 'engine === "(claude|codex)" \|\| [^)]*engine === "(codex|claude)"' \
  src/ --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
```

Every one of them is asking *"is this an engine I can host, rename, hydrate or
spawn?"* — and under a widened union each one keeps answering **no** for
OpenClaw, which is exactly right for phase 1. The codebase already has a safe
default for a third engine, and it spread the definition across 32 files
without naming it. That spread is the argument for naming it before phase 2.

**This count was wrong in an earlier draft of this document, and the correction
is worth keeping visible: the first pass found 15 files, and the real figure is
32.** Two reasons, both of which will bite anyone who re-derives this with a
quick grep. The idiom appears in *both operand orders* — `claude || codex` and
`codex || claude` — and a pattern anchored on one order silently halves the
result. And it turns up in files with nothing else engine-shaped in them
(`src/lib/view/snapshot.ts`, `src/hooks/useSwitchboardData.ts`,
`src/lib/pipelines/store.ts`), so a search scoped to the files that *look*
engine-related misses them too. Anyone sizing item 9 from a single-order grep
will plan half the work.

**Class B — erasure coercions (8 sites). Actively wrong. Must be fixed.**

`src/components/DraftAgentPane.tsx:396`,
`src/components/flows/directReviewGroups.ts:134` and `:146`,
`src/components/feed/parse.ts:1311` and `:1486`,
`src/app/api/tasks/[id]/send/route.ts:94`,
`src/lib/runtime/liveTurn.ts:374`,
`src/lib/tasks/inboxScanner.ts:144`.

These read `engine === "codex" ? "codex" : "claude"` and *relabel* anything
that is not Codex as Claude. TypeScript approves: the expression is total over
any union. An OpenClaw conversation flowing through
`src/lib/tasks/inboxScanner.ts:144` becomes a Claude conversation in the task
inbox, and nothing anywhere reports it.

**Class C — presentation ternaries (~99 sites). Cosmetic. Long tail.**

Colours, labels, avatars: `src/components/utils.ts:95`,
`src/components/feed/FeedItem.tsx:106-107`,
`src/components/scheme/offscreenClusters.ts:384`. A third engine renders in
Claude's colour with Claude's icon. Wrong, visible, harmless, and fixable
incrementally.

**Class D — genuinely engine-specific machinery. This is the real work.**

Eight places, all of them keyed on the transcript **root** rather than on a
free-floating engine string:

| Concern | Site | Shape |
|---|---|---|
| Root inventory | `src/lib/scanner/roots.ts:33-47` | `Record<RootKey, string>` + `scanRootEntries()` |
| Root → engine | `src/lib/scanner/discover.ts:347` | `rootName === "codex-sessions" ? "codex" : "claude"` |
| Metadata derivation | `src/lib/scanner/describe.ts:918-983` | `if (rootName === …) else if … else if …` |
| Turn state | `src/lib/scanner/activity.ts:428` → `src/lib/accounts/migration/turnState.ts:92` | a **boolean** `codex: boolean` |
| Effort extraction | `src/lib/scanner/effort.ts:19-30` | `entry.root === "codex-sessions"` / `"claude-projects"` |
| Feed rendering | `src/components/feed/parse.ts:2127` | `cfg.fmt === "claude" ? renderClaude : renderCodex` |
| Host construction | `src/lib/runtime/structuredSpawn.ts:1312`, `:1372` | `engine === "codex" ? … : …` |
| Persisted-cache validators | `src/lib/scanner/scanCache.ts:105,109,111`; `src/lib/scanner/projectCatalog.ts:136-137`; `src/lib/resourceCollector.worker.ts:45` | literal enum echoes |

Of these, only two are structurally hostile.

`turnStateFromRecords(records, codex: boolean, authoritative)` at
`src/lib/accounts/migration/turnState.ts:92` cannot express a third engine at
all — the parameter is a boolean, fed from `root.startsWith("codex")` at
`src/lib/scanner/activity.ts:428`. A new root falls into the `false` arm and
gets Claude's parser, which keys on `record.type === "assistant"` and
`message.stop_reason` (`turnState.ts:166-173`). No OpenClaw record has
`type: "assistant"` — they are all `type: "message"` — so every branch misses
and the function returns `{ state: "unknown", source: "empty" }` forever. The
failure is quiet and degrades to mtime-only activity rather than lying, but the
boolean must become a discriminator before OpenClaw can report turn state.

The three persisted-cache validators echo the enums as literals. Widen one and
not the others and entries are silently dropped:
`src/lib/resourceCollector.worker.ts:45` discards the whole entry;
`src/lib/scanner/projectCatalog.ts:136-137` blanks `engine` and `fmt` to
`undefined`. **They move together, in the same commit, with
`FILE_SCAN_CACHE_SCHEMA_VERSION` (`src/lib/scanner/scanCache.ts:75`) bumped from
9 to 10** so an older build rejects a newer snapshot wholesale and rescans
instead of reading it through a narrower enum.

### Registry of engine descriptors, or a third union member?

**A third union member.** A descriptor registry is over-built here, and the
evidence for that is specific rather than aesthetic:

1. The widening is already proven cheap — `"shell"` did it.
2. A descriptor cannot help Class B or Class C at all. Those 107 ternaries are
   binary expressions that are *total* over any union; no amount of descriptor
   indirection makes `x === "codex" ? a : b` stop compiling. They have to be
   read and fixed by hand either way.
3. The facts that genuinely vary are few, they all live in the scanner, and
   they are already keyed on `RootKey` — which is a descriptor key in all but
   name.

What is worth building is far smaller than a registry: **one root descriptor**,
declared next to `ROOTS`, carrying exactly the five facts the scanner branches
on.

```ts
interface TranscriptRootDescriptor {
  root: RootKey;
  engine: Engine;          // discover.ts:347 reads this instead of branching
  fmt: Fmt;                // selects the feed renderer
  dir: () => string[];     // account homes / profile dirs
  isTranscript(basename: string): boolean;  // excludes .trajectory/.checkpoint/.bak
}
```

That is the whole descriptor. It does **not** carry launch arguments, model
catalogues, account shapes or UI labels — those either do not exist for
OpenClaw in phase 1 or are better expressed as the capability predicate below.
Proposing a descriptor that carries them would be building the abstraction for
a fourth engine that nobody has asked for.

### The seam

Three named things, and they are what keep the third engine off 300 call sites.

1. **`Fmt` is the rendering seam.** `src/components/feed/parse.ts:2127`
   dispatches on `cfg.fmt`, and `renderClaude`
   (`src/components/feed/parse.ts:1943`) is a pure record→primitive emitter: it
   calls `addUserText`, `addProse`, `push({kind:"think"})`,
   `registerCall(newToolEvent(…))`, `addOutput`, `addCompact`, `pushImage`, and
   returns. A third renderer calling the same primitives is the entire feed
   change. No card, no tool summariser, no timeline consumer learns a third
   engine.

2. **A named capability predicate is the lifecycle seam.** The 32 Class-A
   files already implement it; give it a name and a single definition —

   ```ts
   /** Engines the Viewer can host, resume, rename and hydrate. */
   export function isHostableEngine(engine: Engine | null | undefined): engine is AgentEngine
   ```

   — and adopt it at those sites. This is the precedent
   the codebase already set for capability probing:
   `hostSupportsCompact(host)` at `src/lib/runtime/engineHost.ts:126`. Phase 1
   defines it to exclude OpenClaw; phase 2 changes it in one place and every
   call site follows. Without the name, phase 2 is a 32-file audit that a
   reviewer cannot check.

3. **`EngineHost` is the hosting seam** (`src/lib/runtime/engineHost.ts:100`).
   Six methods. `src/lib/runtime/structuredSpawn.ts:1312` and `:1372` are the
   only two construction sites, and both are `if/else` — turning them into a
   three-way switch is a phase-2 edit of two functions.

**What the seam does not protect.** Class B's eight erasure sites and Class C's
ninety-nine presentation ternaries sit outside all three seams, and no seam can
pull them in, because they are expressions over the union rather than
dispatches through it. TypeScript will not flag a single one. They must be
enumerated by grep and fixed by reading. This document's Class B list is that
enumeration for the eight that produce wrong data.

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
  message}` — a `parentId` chain, structurally the same idea as Claude's
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

`stopReason` is the turn-state signal, and it is cleaner than either engine's
current one: the last assistant record ending in `stop` is a completed turn;
`toolUse` is a turn still running; `error`/`aborted` are terminal. That is the
third branch of `turnStateFromRecords` in about five lines.

Two provider values are synthetic — records OpenClaw injected rather than
model output, distinguishable because `provider` is `openclaw` rather than a
real provider name. They must not be counted as model usage and must not set
the conversation's displayed model.

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
does not appear in the session file at all, and it is what phase 2 needs to
resume a session (`openclaw acp --session <key>`). Phase 1 reads it — from the
first `session.started` event, whose `data.sessionFile` is also the reliable
back-pointer to the transcript — and stores it, doing nothing else with it.

"session" in the trajectory names a *run*. There were 143
`session.started` events across 58 files, one per submitted prompt.

### How a live session is detected

Two independent signals, and one of them does not work here.

**Signal 1 — mtime and turn state. Works.** `resourceActivity` at
`src/lib/scanner/discover.ts:337-340` grades by transcript age (`< 20 s` live,
`< 900 s` recent, else idle) and is engine-agnostic. Layered on it,
`src/lib/scanner/activity.ts:428` reads the transcript tail for turn state.
Once the OpenClaw branch of `turnStateFromRecords` exists, a trailing assistant
record with `stopReason: "toolUse"` reads as busy and one with `"stop"` reads
as done, matching the fidelity Claude and Codex have.

**Signal 2 — process attribution. Does not work, and phase 1 must not pretend
it does.** `argvEngine` at `src/lib/scanner/process.ts:122` maps a live process
to an engine by binary basename, and `agentProcesses()` at `:155` pairs one pid
to one transcript by cwd. OpenClaw has no per-session process. One long-lived
Gateway process writes every session file for every agent id and every channel
— observed on this machine as a single `node … openclaw/dist/index.js gateway
--port <port>`. Mapping it to a conversation would attribute every OpenClaw
session to the same pid.

Phase 1 therefore leaves `pid`/`proc` null for OpenClaw entries. This costs
nothing that matters: `argvEngine` returns `AgentEngine`, which phase 1 does
not widen, so `src/lib/scanner/process.ts` — a file the #1199 lane owns — is
not touched at all.

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
repairs — in the agent inspected, 58 trajectories, 58 `trajectory-path`
sidecars and 36 app-server sidecars against 54 transcripts, plus a long tail of
backups. `isTranscript(basename)`
admits `*.jsonl` and rejects any basename containing `.trajectory.`,
`.checkpoint.`, `.acp-stream.`, or a `.bak`/`.deleted.` segment. A rescan of
this shape without the filter would roughly triple the board's OpenClaw card
count with sidecars and dead backups.

`sessions.json` deserves a note because it looks tempting and should not be
used. It is a live index keyed by session key carrying `sessionFile`,
`sessionId`, `label`, `model`, `modelProvider`, token counts, `chatType`,
`lastInteractionAt` and `sessionStartedAt` — a ready-made metadata source. It
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

The one shape difference worth calling out is why this is a third renderer
rather than a record-shape adapter. In Claude's format a tool result is a
`tool_result` content block inside a `"user"` record; in OpenClaw it is a
top-level record with its own role. Translating OpenClaw into Claude's shape
would mean synthesising fake `"user"` records to carry results the operator
never sent — inventing records to satisfy a parser. The third renderer calls
`addOutput` directly and invents nothing. Roughly 80 lines against a translator
that would be shorter to write and permanently harder to reason about.

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
are channel-bound — `agent:<id>:<channel>:<kind>:<peer>…`, `agent:<id>:cron:…`,
`agent:<id>:main` — and name no repository.

So the question is not "which of many projects" but "what is the one project
these all belong to, and does that answer survive the workspace being gone".

### Why the default answer fails the AGENTS.md invariant

The OpenClaw workspace **is itself a git repository** — it has a real `.git`
directory — with no `origin` remote. Trace it through
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
— which is populated from `flows`/`workflows` rows in `state.sqlite`
(`src/lib/scanner/describe.ts:492`), so a channel-bound session that never
joined a flow has no entry. Execution falls to `directoryProjectInfo()` at
`:562`, minting `dir-<digest>`.

`repo-<digest>` alive, `dir-<digest>` dead. Two different projects for the same
conversations, and every OpenClaw session that runs in the workspace fragments at once, because
they all share the one cwd. This is precisely the failure AGENTS.md describes: *"a
worktree's grouping must survive the checkout being deleted… Any mapping that
finds the parent repo only by reading on-disk git metadata silently fails
afterward."*

It is worth being honest that this hazard is not OpenClaw's. Any transcript
whose cwd is a remote-less git repository has it today. OpenClaw makes it
systemic by putting 52 of 54 sessions in one such directory.

### The decision

**Add a pure path recognizer for the OpenClaw workspace, and place it in the
pure-path group so it precedes every disk-dependent resolver.** This is exactly
the instruction AGENTS.md gives for a new agent layout: *"prefer a pure path
recognizer beside #1–#4 and wire it into `projectInfoFromCwd`."*

```ts
/** Recognizer 1.5, immediately after the scratchpad early-return at
    describe.ts:539 — ahead of every resolver that reads the disk. */
function projectInfoFromOpenclawWorkspace(cwd: string): ProjectInfo | null
```

It fires when `cwd` is, or is under, `<stateDir>/workspace` for the default
state dir, `OPENCLAW_STATE_DIR`, or any `~/.openclaw-<profile>` sibling. It
returns a `DirectoryProjectIdentity` computed from `path.resolve(workspace)`
— never `fs.realpathSync` — so the identity is byte-identical whether or not
the directory exists.

Three properties this buys, each of which the alternatives lose:

- **Stable across deletion**, because nothing on disk is consulted.
- **Ahead of the repo resolver**, so the workspace's incidental `.git` never
  mints a competing `repo-` identity.
- **Inside the existing id namespace** (`dir-<32 hex>`, which
  `isCanonicalProjectId` at `src/lib/projects/identity.ts:22` already accepts),
  so no second naming scheme is invented — the other thing AGENTS.md warns
  against.

The display name is set explicitly rather than taken from the basename:
`projectIdentityFromDirectory` would name this project **workspace**, which
reads like a repository and would collide in the sidebar with any real
checkout of that name.

Sessions whose cwd is a genuine git checkout are untouched — the recognizer is
scoped to the workspace subtree and everything else falls through to the
existing chain. The one home-directory session resolves to the existing
`home-<user>` directory identity, as it would today.

### One project for the whole workspace

Rejected: a project per OpenClaw agent id. It would need the transcript path
rather than the cwd (`projectInfoFromCwd` only receives a cwd), which means
hooking `resolveProjectOverlay` (`src/lib/scanner/describe.ts:1001`) and
minting ids from a source other than a directory — a second naming scheme, for
a distinction that is presentational. The agent id is already in the transcript
path and can drive a card title or a subtitle without touching project
identity. If the operator later wants per-agent lanes, that is a sidebar
grouping change that leaves identity alone, and this decision does not block it.

---

## (d) Hosting transport

### What the transport has to do

From `EngineHost` (`src/lib/runtime/engineHost.ts:100-107`) and what
`CodexAppServerHost` needs to satisfy it:

| Requirement | `EngineHost` member |
|---|---|
| Deliver a message | `send(entry): Promise<DeliveryReceipt>` — and the receipt must discriminate `steered` / `turn-started` / `queued-next-turn` / `rejected` |
| Stream a turn | `attach(afterSeq): AsyncIterable<RuntimeEvent>` |
| Observe turn state | `health(): Promise<HostState>` with `status`, `activeTurnRef`, `eventCursor` |
| Resume | construction via `adopt(id, options)` (`codexAppServerHost.ts:750`) |
| Kill | `release()` |
| Survive a viewer restart | `HostState.pid` + `processStartIdentity`, re-adoption, and a durable event store |

### The three candidates

**1. ACP bridge — `openclaw acp`.** JSON-RPC over stdio, structurally identical
to `codex app-server`, which `CodexAppServerHost` already drives over the same
substrate (`spawn(…, {stdio: ["pipe","pipe","pipe"], detached: true})` at
`codexAppServerHost.ts:757` and `:773`). The installed bundle contains
`initialize`, `session/new`, `session/prompt`, `session/cancel`,
`session/update`, `session/resume`, `session/status`, `session/list`,
`session/set_model`, `session/set_mode`, `session/set_config_option`, plus
client-side `fs/*` and `terminal/*` callbacks. The CLI exposes `--session <key>`,
`--session-label`, `--require-existing`, `--reset-session`, `--provenance`, and
gateway `--url/--token/--token-file`.

Maps to all six members: `session/prompt` → `send`, `session/update`
notifications → `attach`, `session/cancel` → `interrupt`,
`session/request_permission` → `answer`, `session/status` → `health`,
child termination → `release`, `--session <key> --require-existing` → resume.

**2. Gateway WebSocket.** No child process to own, so `release()` has no
meaning — you cannot kill a shared service. Requires speaking OpenClaw's
internal Gateway RPC, which is not a published stable protocol, plus token or
password auth. Decisively: it is the operator's live Gateway, carrying their
personal messaging channels, and a Viewer defect on that socket is a defect in
the operator's messaging. Rejected.

**3. `openclaw agent --json` per turn.** One process per turn. `--json` emits a
single terminal result with no streaming, so `attach` degrades to "nothing until the turn ends";
there is no `interrupt`, no attention channel, and turn state is a process exit
code. Four of six members unsatisfied. Rejected for hosting; it remains a
reasonable fallback for a fire-and-forget send, and is noted as such under
Deferred.

**Choice: the ACP bridge.**

### What the ACP bridge cannot do

The bridge is a *client* of the Gateway — `openclaw acp --help` describes it as
"Run an ACP bridge backed by the Gateway", and it takes a gateway URL and
token. The Gateway owns the agent; the bridge does not. Four consequences, and
they are not small:

1. **`release()` detaches; it does not stop the agent.** A turn in flight keeps
   running inside the Gateway and keeps writing the session file after the
   Viewer's host is gone. "Kill" means "stop watching". For Codex, killing the
   app-server child stops the work; here it does not. The Viewer must not
   display this as a kill.
2. **No hosting without the Gateway, and the Viewer must not manage it.** The
   Gateway is the operator's own long-running service. If it is down, hosting
   is unavailable and must say so; starting it is out of bounds.
3. **No exclusive claim on a session.** The operator's Telegram channel, a cron
   job and the Viewer can all drive the same session key concurrently. The
   `expectedTurnId` fence on `QueueEntry` (`engineHost.ts:22`) rejects a stale
   Viewer-side write, but nothing prevents an operator message arriving
   mid-turn from another channel. Codex's single-owner assumption does not
   hold, and the registry's claim model should treat an OpenClaw host as
   advisory rather than exclusive.
4. **Cancellation is likely advisory.** `session/cancel` exists, but the
   trajectory records `turn.client_closed` events (3 observed) that sit
   alongside `session.ended`, which reads as "the client went away" being
   logged rather than aborting the run. **Uncertain** — the bridge was not
   exercised, because doing so would have opened a session against the
   operator's live Gateway. Phase 2 must measure this before claiming
   interrupt works.

One thing the bridge does *better* than Codex: because the Gateway holds the
session, surviving a Viewer restart needs no process adoption. Re-attaching is
launching a new bridge with `--session <key> --require-existing`. But the
`RuntimeEvent` `seq` cursor is per-bridge-process, so `attach(afterSeq)` cannot
be served by a fresh bridge. Replay stays a Viewer-side responsibility through
the existing `FileRuntimeEventStore`
(`codexAppServerHost.ts:709`: `options.eventStore ?? new FileRuntimeEventStore()`),
with the session file as canonical transcript — the same division Codex
already uses.

### The `node:sqlite` obstacle: root cause, fix, diagnosis

**The cause is `PATH`.** OpenClaw is fine and Bun is fine; the resolution of
the name `node` is what breaks.

Reproduced on this machine:

- `openclaw` is a shim whose first line is `#!/usr/bin/env node`.
- `which node` resolves to `/tmp/bun-node-<hash>/node` — a shim directory Bun
  prepends to `PATH` for its child processes. `node --version` there answers
  with a Bun error in place of a version.
- `bun -e 'require("node:sqlite")'` on Bun 1.3.3 fails: *No such built-in
  module: node:sqlite*.
- `openclaw --help` under that `node` terminates with
  `error: Registry URL must be http:// or https:// Received: "node:sqlite"`.
- The same command run as `/usr/bin/node <openclaw-dist-entry> --help` exits
  clean, with no error. `/usr/bin/node` (v26) imports `node:sqlite`
  successfully; so does a v22 runtime.

And the mechanism by which the Viewer would inherit this: `PATH` is the first
entry of `CHILD_ENV_ALLOWLIST` at `src/lib/runtime/codexAppServerHost.ts:226`,
and `subscriptionEnv` (`:396-400`) forwards every allowlisted variable
verbatim. A Viewer running under Bun hands its Bun-shimmed `PATH` to any child
it spawns. An `openclaw` child would resolve `node` to Bun and die at startup,
every time.

Note also that the operator's own running Gateway is launched with an explicit
absolute path to a bundled Node runtime rather than through the shim — the same
workaround, arrived at independently.

**The fix.** Never spawn the `openclaw` shim and never depend on inherited
`PATH`. Spawn the interpreter directly on OpenClaw's entry script:

```
<node> <openclaw-dist-entry> acp --session <key> [--require-existing] ...
```

resolved from `LLV_OPENCLAW_NODE` and `LLV_OPENCLAW_ENTRY`, mirroring the
`options.binary ?? process.env.LLV_CODEX_BINARY ?? "codex"` precedent at
`src/lib/runtime/codexAppServerHost.ts:771`. The child's `PATH` is rebuilt with
any `/tmp/bun-node-*` segment removed, so a nested `node` lookup inside
OpenClaw cannot fall back into the shim.

**The named diagnosis.** `stderrExitDiagnostic`
(`src/lib/runtime/codexAppServerHost.ts:378`) relays the last four stderr lines
verbatim — useful, but what it produces is prose, and the observed
failure string talks about a registry URL. Scraping it is the wrong primary
mechanism. The host runs a **preflight before spawn**, each check with its own
code, and a launch failure surfaces as that code rather than as a dead host:

| Code | Check | Message must name |
|---|---|---|
| `openclaw_runtime_missing` | configured interpreter is absent or not executable | the path that was resolved, and where it came from (`LLV_OPENCLAW_NODE`, or `PATH` lookup) |
| `openclaw_runtime_lacks_sqlite` | `<node> -e 'require("node:sqlite")'` exits non-zero | the resolved interpreter path and its `--version` output |
| `openclaw_entry_missing` | entry script is absent | the path that was probed |
| `openclaw_gateway_unreachable` | no Gateway backing the bridge | the gateway URL that was tried |

**Every message names the interpreter it resolved.** This is the whole value of
the diagnosis, because the underlying fault is a name resolving to the wrong
binary. "SQLite support is unavailable in this Node runtime" sends the operator
to install a Node they already have. The same failure reported as —

```
openclaw_runtime_lacks_sqlite: resolved node -> /tmp/bun-node-<hash>/node
  (from PATH); that runtime has no node:sqlite. Set LLV_OPENCLAW_NODE to a
  real Node 22+ binary.
```

— shows a `/tmp/bun-node-*` path, and the operator is done reading. A
diagnosis that reports only the symptom hides the one fact that identifies the
cause.

Keep it at these four checks. The preflight costs two `statSync` calls, one
short subprocess and one gateway reachability probe, cached per host launch,
and it earns that by turning a dead host into a sentence. Anything more
belongs in `doctor`, and OpenClaw already has one. As a backstop, a post-spawn
stderr matcher for `node:sqlite` maps into `openclaw_runtime_lacks_sqlite` with
the same resolved-path line attached, since the observed message does contain
that token even though its prose is about something else.

The preflight is the only place this belongs. `detectLaunchFailure`
(`src/lib/status.ts:261`) is the other named-failure surface in the codebase,
but it reads a tmux screen, and the tmux transport is being removed (#1161).
Adding an OpenClaw case there would be building on a floor that is coming out.

---

## (e) Phasing

### The boundary

**Phase 1: viewing. Phase 2: hosting.** The issue expected this split; three
things confirm it, and the third is the one that actually decides it.

1. Viewing is additive and root-keyed. Every phase-1 edit is a new branch in an
   existing `rootName` switch, a new member on a union that already has three,
   or a new file. Nothing changes behaviour for Claude or Codex.
2. Viewing has no external dependency. Hosting depends on a service the Viewer
   does not own (the Gateway), a runtime it does not run (real Node), and a
   claim model that does not exist (no exclusive session ownership). Two of
   those three still carry open uncertainties — see (d). Bundling them with
   viewing would hold a shippable increment hostage to them.
3. **Hosting's data model rides on viewing's.** `SessionKey`
   (`src/lib/agent/sessionKey.ts:7`) is `{engine, sessionId}`, and
   `normalizeSessionId` (`:14`) requires the whole value to be a bare
   v4-shaped id. OpenClaw header ids satisfy that — but the *filename* does
   not, for the 17 of 54 files named `-topic-<n>`. Phase 1 is what establishes
   that the registry's `sessionId` comes from the header rather than the
   filename, and proves the registry↔transcript join with fixtures. Phase 2
   adopts and resumes against that join. Doing them together means designing
   the join and the host lifecycle at once, against a shape that phase 1's own
   evidence only just corrected.

There is a fourth reason, opportunistic but real: the boundary drawn here keeps
phase 1 out of `src/lib/scanner/process.ts`, which the #1199 lane owns.
`AgentEngine` is the *hostable*-engine union, and phase 1 deliberately does not
make OpenClaw hostable, so it does not widen it.

### What phase 1 ships

Board and feed parity for OpenClaw conversations — Expected 1 and 2 — in a
single PR, with OpenClaw explicitly **not** hostable and every Class-A
predicate still answering "no". Scanning, project attribution, turn state,
effort and structured rendering ship together; there is no interim state in
which an OpenClaw conversation appears on the board but opens as unstructured
text.

Work plan, in dependency order, against `main` at `e61c1ce4`. One file
(`src/lib/resources.ts`) is owned by the #1199 lane and is deliberately skipped
at item 9; everything else here is free.

**1. `src/lib/types.ts`** — `RootKey` gains `"openclaw-sessions"` (`:8-11`);
`Engine` gains `"openclaw"` (`:13`); `Fmt` gains `"openclaw"` (`:15`).
Compile and read every error: they are the exhaustive-position call sites, and
they are the only ones the compiler will ever hand you.

**2. `src/lib/scanner/roots.ts`** — add the OpenClaw root to `ROOTS` (`:33`)
resolved from `OPENCLAW_STATE_DIR` with `~/.openclaw` default; extend
`scanRootEntries()` (`:39`) to fan out one entry per `<stateDir>/agents/*/
sessions` directory. Add `openclawSessionRootFor(candidate)` beside
`codexSessionRootFor` (`:83`) so `/api/log` path allowlisting covers the new
root. Declare the `TranscriptRootDescriptor` here.

**3. `src/lib/scanner/discover.ts:347`** — replace the two-way root ternary
with a descriptor lookup, and fix the title fallback at `:365` alongside it.

**4. `src/lib/scanner/describe.ts`** — add an `else if (rootName ===
"openclaw-sessions")` branch to `deriveTranscriptMetadata` (after `:983`)
setting `engine`/`fmt`/`kind`, reading `cwd` and `sessionStartedAt` from the
header record, and taking the title from the first `"user"` message. Add the
`projectInfoFromOpenclawWorkspace` early-return after `:539`.

**5. `src/lib/accounts/migration/turnState.ts:92`** — change the `codex:
boolean` parameter to a discriminator, add the OpenClaw arm keyed on the last
assistant record's `stopReason`, and update the two call sites
(`src/lib/scanner/activity.ts:175` and `:428`) plus the `cached.codex ===
codex` cache-key comparisons at `:165`, `:184`, `:212`, `:256`.

**6. The three persisted-cache validators, in one commit** —
`src/lib/scanner/scanCache.ts:105,109,111` plus bumping
`FILE_SCAN_CACHE_SCHEMA_VERSION` at `:75` from 9 to 10;
`src/lib/scanner/projectCatalog.ts:136-137`;
`src/lib/resourceCollector.worker.ts:45`.

**7. `src/components/feed/parse.ts`** — add `renderOpenclaw` beside
`renderClaude` (`:1943`) and extend the dispatch at `:2127` from a two-way
`fmt` test to a three-way one. The mapping table under *(b) Rendering* is the
specification; the renderer emits only primitives that already exist.

**8. `src/lib/scanner/effort.ts`** — add `"off"` and `"adaptive"` to `TIERS`
(`:10`); add an `entry.root === "openclaw-sessions"` arm to `pickEffort`
(`:18`) reading `thinkingLevel` from `thinking_level_change` records. Do
**not** touch `argvEffort` (`:34`) — there is no per-session process to read
argv from.

**9. The capability predicate** — define `isHostableEngine` (suggested home:
`src/lib/agentCapabilities.ts` or beside `Engine` in `src/lib/types.ts`) and
adopt it at the Class-A sites. Behaviour-preserving by construction; the value
is that phase 2 becomes a one-line change with a test instead of a 32-file
audit.

One of those 32 files is still owned elsewhere: `src/lib/resources.ts`, under
the #1199 lane. Phase 1 adopts the predicate in the other 31 and leaves that
copy in place. Since the predicate is defined to exclude OpenClaw, the mixed
state behaves identically either way, and the leftover is a mechanical
follow-up once #1199 merges.

**10. Class B, the eight erasure sites** — seven take an explicit third arm in
phase 1: `src/components/feed/parse.ts:1311` and `:1486`,
`src/components/DraftAgentPane.tsx:396`,
`src/components/flows/directReviewGroups.ts:134` and `:146`,
`src/app/api/tasks/[id]/send/route.ts:94`,
`src/lib/tasks/inboxScanner.ts:144`.

The eighth, `src/lib/runtime/liveTurn.ts:374` with
`RuntimeLiveTurnToolEngine` (`:22`), waits for phase 2. Nothing produces
live-turn rows for an engine the Viewer does not host, so widening a hosting
type inside a viewing PR would add an unreachable branch. Carry it on the
phase-2 issue.

**Tests**, all against invented fixtures under an isolated
`HOME`/`XDG_CONFIG_HOME`/`LLV_STATE_DIR`/`TMPDIR`, run **by path**:

- `src/lib/scanner/describe.test.ts` — the case AGENTS.md requires: an OpenClaw
  workspace cwd resolves to the same project whether or not the directory
  exists, and a workspace carrying a remote-less `.git` still resolves to the
  directory identity rather than a `repo-` identity.
- `src/lib/scanner/discover.test.ts` — a fixture agent tree yields one entry
  per transcript, and zero for `.trajectory.jsonl`, `.checkpoint.<id>.jsonl`,
  `.acp-stream.jsonl`, `.trajectory-path.json`, `sessions.json` and `.bak`
  siblings.
- `src/lib/accounts/migration/turnState.test.ts` — `stopReason` of `stop`
  reads terminal, `toolUse` reads busy, `error`/`aborted` read terminal.
- a new `src/components/feed/openclaw.test.ts` — the six-row mapping table
  above, plus a synthetic-provider record not setting the displayed model.
- `src/lib/scanner/effort.test.ts` — `off` and `adaptive` normalise; an
  unknown tier still returns null.

**Gates:** `bunx tsc --noEmit --incremental false`; the touched test files by
path; `bun scripts/privacy-publication-gate.ts --base <merge-base>
--check-commits`; a non-draft PR against `main` with an identity-free body.

### What phase 1 explicitly does not ship

`AgentEngine` stays two-membered. `isHostableEngine` returns false for
OpenClaw. `SessionKey` cannot name an OpenClaw session. No spawn path, no
registry entry, no delivery controller. Model and effort **controls** — Expected
5 — are phase 2, because they configure a launch and phase 1 does not launch
anything; phase 1 gets read-only model/provider display for free from the
assistant records.

### Phase 2, sketched

`AgentEngine` widening; `isHostableEngine` flipped; an `OpenclawAcpHost`
implementing `EngineHost`; the preflight and its four diagnosis codes; third
arms at `structuredSpawn.ts:1312` and `:1372`; the advisory-claim change to the
registry; `--model` and `--thinking` wired to the existing model/effort
controls. Its own PR, its own tests, its own issue. The open uncertainties from
(d) — whether `session/cancel` aborts a run, and whether
`session/request_permission` reaches the attention queue — get measured at the
start of phase 2, before anything is built on them.

---

## Baseline and lane ownership

**Phase 1 is cut against `main` at `e61c1ce4`**, which already contains PR
#1206 (the #1202 `suggest_replies` lane, merged 2026-08-27). The implementer
rebases on current `main`. This document's evidence was originally read at
`ac197031`; both commits are recorded here because the difference is what
decides whether the file:line citations below still hold.

Every line this document cites was re-read at `e61c1ce4` and is unchanged.
`src/components/feed/parse.ts` is byte-identical between the two commits, so
`:1311`, `:1486`, `:1943` and `:2127` all still point at what the text says
they do; so are `src/lib/types.ts`, all six cited `src/lib/scanner/` files,
`src/lib/accounts/migration/turnState.ts`,
`src/lib/resourceCollector.worker.ts`, `src/lib/projects/identity.ts`,
`src/lib/agent/sessionKey.ts`, `src/lib/status.ts` and the three cited
`src/lib/runtime/` files. The one cited file #1206 did touch is
`src/lib/mcp/bindings.ts`, which this document cites only at file level as a
Class-A site; re-counted at `e61c1ce4`, the Class-A surface is still 32 files.

**Fences lifted.** `src/components/feed/**` (including `parse.ts`),
`src/components/LogFeed.tsx`, `src/lib/mcp/**` and
`src/lib/orchestrator/prompt.ts` have no other owner. Phase 1 takes the feed
renderer directly, so there is no `"plain"` fallback state and no split
delivery: scanning, attribution, turn state and structured rendering ship
together in one PR.

**Still owned — the #1199 lane, in final review.** `src/lib/resources.ts`,
`src/lib/scanner/process.ts`, `src/lib/runtime/structuredHostControl.ts`,
`src/lib/runtime/structuredDeliveryController.ts` and
`src/components/ResourcesFooter.tsx`. Phase 1 touches none of them, and needs
none of them:

- `src/lib/scanner/process.ts` holds `AgentEngine` (`:13`) and `argvEngine`
  (`:122`). Phase 1 deliberately does not make OpenClaw hostable and does not
  do process attribution, so neither needs to change. The phase boundary was
  drawn partly for this reason and it still holds.
- `src/lib/resources.ts:793` is a Class-A narrowing predicate. It keeps
  answering "no" for OpenClaw, which is the phase-1 answer anyway. It is the
  single Class-A copy item 9 skips.
- `src/components/ResourcesFooter.tsx:474` is a Class-C label expression that
  renders `?` for an unrecognised engine — honest, and correct until someone
  gives OpenClaw a label.

Phase 2 will need `src/lib/scanner/process.ts` and
`src/lib/runtime/structuredDeliveryController.ts`, so it should not start until
#1199 has merged.

---

## Deferred — not currently justified

Cut from this design, with the reason. None of it is discarded.

**An engine-descriptor registry spanning the UI.** Would not fix the 107 binary
ternaries, which are the actual cost, and would abstract for a fourth engine
nobody has asked for. Revisit if a fourth engine appears. See (a).

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
`normalizeModelKey` finds no entry and `registryWindow` returns null — an
unknown context window, which is the correct answer here. Adding OpenAI
model windows is a separate decision with its own maintenance burden and is not
required by the requirement.

**Account and limits integration.** `LimitsCache`
(`src/lib/limits.ts:38,50`) is `Record<EngineName, …>` behind `version: 2`;
adding a third key is a persisted-shape migration. But OpenClaw does not have
its own subscription — it routes to an OpenAI provider whose quota is already
accounted elsewhere — so a third limits engine would report a window that does
not exist. Out of scope until OpenClaw's account model is understood.

**`openclaw agent --json` as a fallback transport.** Genuinely unsuitable for
hosting, but it is the simplest possible "send one message and read the reply".
If phase 2's ACP work stalls on the Gateway dependency, it is a viable reduced
mode — send only, no streaming, no interrupt — and should be reconsidered then
rather than built now.

**Per-agent-id project grouping.** Presentational; can ride on card titles
without a second project-id namespace. See (c).

---

## Validation against the requirement

Read back against the quote at the top.

*"the Viewer scans and renders OpenClaw conversations"* — phase 1, items 1–10,
in one PR. Both halves of the clause land together: scanning and attribution
from items 1–6, structured rendering from item 7. No fallback state, no partial
delivery.

*"the Viewer can host an OpenClaw agent as a structured host (spawn, deliver a
message, stream the turn, resume, kill)"* — phase 2, over the ACP bridge, with
one honest deviation the operator should see now rather than at delivery:
**"kill" cannot mean what it means for Claude and Codex.** The Gateway owns the
agent, so releasing the host stops the Viewer watching while the agent keeps working.
Every other verb in the sentence maps cleanly.

*"at the same level Claude and Codex already are"* — reached for scanning,
rendering, project attribution, turn state and model display. Not reached, and
not proposed, for accounts, limits and process-level liveness — because for
those three OpenClaw has no equivalent to be at the same level as. Claiming
parity there would mean inventing a subscription and a per-session process that
do not exist.

Nothing in this design exists because it was interesting. The one place the
design deliberately spends more than the minimum is the named capability
predicate, which is behaviour-preserving in phase 1 and buys a checkable
one-line change in phase 2 instead of a 32-file audit.
