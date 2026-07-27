# Automatic analysis — a model-backed conversation monitor agent

Architecture, UX and control contract for the replacement of the rejected
deterministic monitor (PR #744, issue #741). Design only: nothing here is
implemented, nothing is installed, and the scheduler stays disabled until the
operator authorises installation.

Grounded in the tree at `pipeline/architecture-model-backed-conversation-m-1961522d`
(post-#743). Every code reference below was read, not recalled.

---

## 0. Decisions the implementer inherits

These are settled. They are not options to re-weigh in review.

**D1 — The semantic reader is Claude Opus 5.** Engine `claude`, model id `opus`
(`ENGINE_MODELS.claude[0]`, `src/lib/agent/models.ts`), reasoning tier `high`
(`ENGINE_EFFORTS.claude`, `src/lib/agent/efforts.ts`). The operator decided this
directly and explicitly authorised spending the available Opus 5 quota on this
work. There is **no tiering ladder, no cheaper default, no escalation path** —
proposing one is a regression against this decision. The earlier
"cost-aware lightweight model" instruction was written against a Codex quota
spike; Opus is a separate budget the operator has chosen to spend here.

The model/tier is pinned at provisioning, not chosen per run. A role override
may change the **tier**; it may not change engine or model (§5.4).

**D2 — Cost is measured, never avoided.** Bounded per-run context and per-run
usage telemetry are still first-class, for a different reason: the operator
wants to *see* what it spends. Two consequences that are load-bearing:

- a run whose delta is empty is cheap **by construction** — the model is never
  woken at all (§4.4), and that fact is still recorded as a run;
- usage is derived deterministically from the monitor's own transcript, not
  self-reported by the model (§8.3).

**D3 — Deterministic code may never make the semantic classification.** This
came from the product shape, not from the model tier, so it survives D1 intact.
Deterministic code collects, dedupes, bounds and enforces safety. Opus reads and
judges. Concretely: nothing under `src/lib/analysis/**` may contain a keyword
table, an intent regex, an overlap score, or a threshold that decides *what an
operator meant*. `TASKISH` in `src/lib/tasks/inboxScanner.ts:86` is the exact
shape that is forbidden here — the collector may reuse that file's *structural*
helpers (`stripInjectedContext`, service-prompt shapes, fingerprinting) and must
not reuse its intent regex.

**D4 — The monitor cannot create GitHub issues.** Not "must not": cannot. It has
no shell, no network tool, and no viewer tool that reaches GitHub (§5).

---

## 1. What was rejected, and what is kept

PR #744 built a script that classified operator intent with word-overlap scoring
and threshold bands. The operator rejected that as a product direction. The
branch stays open as evidence.

**Kept as prior art** (cite it in the implementation, don't re-derive it):

| From #744 | Where it lands here |
| --- | --- |
| watermark + `seen` fingerprint ring | §4.2, extended to per-conversation cursors |
| `clientRequestId` idempotency on task creates | §4.3, now one of three layers |
| redaction shapes, incl. the nested percent-encoding gap found in review | §7 |
| own-output exclusion | §4.1, now structural (identity-based, not marker-based) |
| project scoping of evidence | §4.1 / §6.4 |
| GitHub evidence collection | §3.4 — moved server-side, because the agent has no shell |

**Blocking review findings from #744, and how this design answers them:**

- *probe/send race that could resume a host as a side effect of observing it* —
  inverted. Resuming is the **intended** behaviour for the monitor's own
  session, and it is authorised for exactly one conversation id (§3.3). No
  probe-then-send window exists because there is no probe.
- *lock reclaimable by age while a run was still live* — the run lease is
  pid + `startIdentity` based (`procBackend.processIdentity`), the pattern
  already proven in `src/lib/wakatime/lease.ts`. Age is never sufficient
  evidence of a dead holder (§6.5).

**The live failure this replaces.** A `# BEGIN llv-orchestrator-watchdog` crontab
block fires every 30 minutes against a hard-coded predecessor transcript path
under `$HOME/.config/agent-log-viewer`. It has been nudging a dead conversation
for over a day while the live orchestrator received nothing, and it writes
nothing on success. Removing that block is part of installation, and it is an
**operator action** (§11).

---

## 2. Shape of the system

```
                    settings (per project, durable, revision-fenced)
                                     │  enabled / cadence / mode
                                     ▼
  scheduler  ──lease──►  due?  ──►  collector (deterministic)
  (in-process,                        │  delta since watermark
   lease-guarded)                     │  bounded task map + evidence
                                      ▼
                              empty? ─yes─► journal: no-delta   (model NOT woken)
                                      │no
                                      ▼
                        wake/resume THE monitor session by identity
                                      │  run packet (bounded, one message)
                                      ▼
                        ┌───────────────────────────────┐
                        │  monitor agent — Claude Opus 5│  narrow tool grant
                        │  reads, correlates, judges    │  (§5)
                        └───────────────────────────────┘
                                      │ create_task / update_task (idempotent)
                                      │ analysis_report  ← the closing receipt
                                      ▼
                          journal + watermark advance + usage
                                      │
                                      ▼
                    Automatic analysis section in the project Task panel
```

Component boundaries, as files the builder creates:

| Module | Owns | Must not |
| --- | --- | --- |
| `src/lib/analysis/settings.ts` | durable per-project settings + designation record, revision CAS | know anything about scheduling |
| `src/lib/analysis/schedule.ts` | due computation, missed-slot detection, next-run instant | perform IO on conversations |
| `src/lib/analysis/scheduler.ts` | the lease-guarded ticker, dispatch, timeout sweep | classify anything |
| `src/lib/analysis/session.ts` | provisioning, resolution by identity, succession following | send messages |
| `src/lib/analysis/delta.ts` | the bounded operator-message delta, exclusions, dedupe | judge intent (D3) |
| `src/lib/analysis/evidence.ts` | canonical task map, pipelines, flows, agents, GH refs | judge intent (D3) |
| `src/lib/analysis/packet.ts` | assembling and bounding the run packet | judge intent (D3) |
| `src/lib/analysis/journal.ts` | run records, retention, usage attribution | mutate tasks |
| `src/lib/analysis/report.ts` | the completion receipt, watermark advance | accept a receipt for a run it did not dispatch |
| `src/app/api/analysis/**` | HTTP contract (§8.4) | expose transcript text or paths |
| `src/components/analysis/**` | the settings section (§8) | fetch conversation content |

Nothing here reads or writes viewer domain state files directly. Tasks,
conversations, pipelines and flows are reached through their existing
commands/APIs, exactly as #741 required.

---

## 3. Session lifecycle and ownership

### 3.1 One durable, project-owned session

Enabling Automatic analysis for a project **provisions or designates** exactly
one conversation as that project's monitor. The designation record is the
authority; a transcript path is never an identity.

```ts
interface MonitorDesignationV1 {
  schemaVersion: 1;
  project: string;                      // FileEntry.project (worktrees already
                                        // fold into the parent repo — AGENTS.md)
  conversationId: `conversation_${string}`;
  engine: "claude";
  model: "opus";                        // D1, pinned
  effort: string;                       // default "high"
  designatedAt: string;                 // ISO
  origin: "provisioned" | "reprovisioned" | "succeeded";
  /** Set when this designation replaced a previous conversation; the chain is
      kept so the audit can explain a change of identity. */
  supersedes: `conversation_${string}` | null;
}
```

Provisioning is `POST /api/spawn` with: `role: "monitor"`, explicit `project`
(so the registry records durable `projectOwnership`,
`src/lib/agent/registry.ts:383`, rather than inferring from cwd), `cwd` = the
project's repo root, `engine: "claude"`, `model: "opus"`, `effort` from the role,
`readOnly: true`, `allowSubagents: false`, `mcpServers: ["viewer"]`.

Single instance is enforced by compare-and-set on the settings record, the same
first-write-wins shape `adoptOrchestratorRecord` uses
(`src/lib/orchestrator/store.ts:74`): a second enable that races returns the
canonical designation instead of minting a twin.

### 3.2 Visibly marked as the monitor

Three independent markings, all derived from durable state, none from a title
string:

1. **Registry** — `agentRole: "monitor"` is copied from the launch receipt at
   admission (`src/lib/agent/registry.ts:395`, "never re-derived by resume,
   migration, or restart adoption"). This is what survives a rollover.
2. **Board card** — the conversation's card carries a `Badge tone="info"`
   reading *Analysis* (`src/components/ui/Badge.tsx`, design-system §3.7),
   shown when the registry role is `monitor` **and** the conversation is the
   project's current designation. Role alone is not enough: a superseded former
   monitor must not keep the badge.
3. **Settings section** — names the designated session and deep-links to it via
   the existing `#c=<conversationId>` route `Viewer.tsx` already resolves.

### 3.3 Wake / resume mechanics

Resolution ladder, run fresh on every fire. It never touches a stored path:

1. `settings.designation.conversationId` → `registry.conversation(id)`.
2. If the record carries `supersededBy` (`registry.ts:392`), follow the
   succession, rewrite the designation with `origin: "succeeded"`, and journal
   it. A model swap or a resume that mints a new generation is therefore
   invisible to the scheduler.
3. Canonical path = `conversation.generations.at(-1).path` — derived at the
   moment of use, never persisted as identity.
4. Host state from the registry (`AgentHostStatus`: `starting | live | idle |
   handoff | unhosted | dead`) plus the turn state.

| Host state | Action | Journal |
| --- | --- | --- |
| `idle`, hosted, no live turn | deliver the packet | `dispatched` → receipt |
| `live` / mid-turn / `starting` / `handoff` | **do nothing** — never interrupt | `skipped-busy`, watermark unchanged |
| `unhosted` / `dead` | resume-and-deliver through the normal delivery ladder with `resumeModel: "opus"` | `dispatched`, `resumed: true` |
| conversation id unknown to the registry | reprovision (§6.3) | `failed:resolution` then `reprovisioned` |
| no repo cwd for the project | blocked | `failed:resolution`, blocker surfaced |

Delivery goes through the same service the composer and `/api/runtime/send` use
(`deliverConversationMessage`, `src/lib/delivery.ts:484`) with an explicit
`conversationId`. **The resume-as-side-effect that was a blocking finding in
#744 is here the point**, and it is fenced by identity: the dispatcher asserts
the target conversation id equals the designation before it sends, and refuses
otherwise. The monitor may wake itself; it may wake nothing else — and it holds
no tool that could (§5).

A busy skip is not silent. Three consecutive `skipped-busy` fires raise the
blocker `monitor-busy` in the settings surface, because a monitor that never
gets a turn is indistinguishable from a broken one until someone says so.

### 3.4 What the session is, in product terms

A normal viewer conversation, rendered by the normal conversation surface. No
bespoke chat widget — the same reasoning `docs/design/orchestrator-agent.md`
gives for the orchestrator. The operator can open it, read its reasoning, and
talk to it. Talking to it is not a run; only a dispatched packet is (§4.5).

### 3.5 Disable

`enabled: false` stops future wakes. It does **not** kill the session, delete
the designation, reset the watermark, truncate the journal, or touch a single
task the monitor created. Re-enabling resumes against the same identity and the
same watermark, so the first run after a disabled month analyses the delta since
the last completed run, bounded by the lookback floor (§4.2).

---

## 4. The run

### 4.1 Bounded delta collection (deterministic)

Inputs: the project's conversation catalog (`FileEntry`, project attribution
already folds worktrees into the parent repo per AGENTS.md), the watermark, and
the run budget.

The collector, in order:

1. **Project scoping** — only conversations whose `FileEntry.project` equals the
   settings project. Another project's conversations are not read, and another
   project's cards, pipelines and flows never enter the evidence set (§6.4).
2. **Own-output exclusion — structural, not textual.** Every generation path and
   `continuityPaths` entry of the monitor's own conversation id is removed from
   the candidate set before any record is read. #744 excluded its own writing by
   prefixing a marker string on its messages; that fails the moment a marker is
   dropped, reworded, or quoted. Identity cannot be dropped. The run packet the
   scheduler delivers lands in the monitor's transcript as a `user` record, so
   without this the monitor would read its own briefing back as operator intent
   on the very next fire.
3. **Operator-authored records only** — `kind: "message"`, `role: "user"`
   (`SessionRecord`, `src/lib/session/reader.ts:10`).
4. **Harness-noise exclusion — structural only.** `stripInjectedContext` and the
   service-prompt shapes from `inboxScanner.ts:61,78` (injected context blocks,
   `Caveat:`, `[Request interrupted`, cross-session relays, AGENTS.md dumps).
   These recognise *envelope*, not meaning, so they are allowed under D3. The
   intent regex is not.
5. **Cursor filter** — records after each conversation's cursor (§4.2).
6. **Dedupe** — fingerprint = sha256 over the normalised text plus conversation
   id plus record instant; drop anything in the `seen` ring.
7. **Budget** — oldest-first, capped at `maxRecords` (default 150) and
   `maxChars` (default 80 000). Truncation is explicit in the packet and in the
   journal; unconsumed records stay unconsumed, because the watermark only
   advances over what a completed run actually consumed.

The collector never decides whether a message is a request. It hands Opus
everything an operator actually typed in the window, minus envelope noise.

### 4.2 Watermark

```ts
interface AnalysisWatermarkV1 {
  schemaVersion: 1;
  project: string;
  /** Upper bound actually consumed by a COMPLETED run. */
  consumedThrough: string | null;         // ISO
  /** Never look back past this: set on first enable, and clamped forward after
      a long outage so a re-enable cannot replay a year of transcripts. */
  floorAt: string;                        // ISO
  cursors: Record<string, {               // keyed by conversationId
    lastTs: string | null;                // records may carry no instant
    lastFingerprint: string;
    lastIndex: number;                    // ordinal within the read, for null ts
  }>;
  /** Bounded ring of consumed fingerprints (5 000, the inboxScanner bound). */
  seen: string[];
  updatedAt: string;
}
```

Per-conversation cursors rather than one global instant, because transcript
instants are per-file, sometimes absent, and never globally ordered. A default
lookback floor of 7 days applies on first enable and after any outage longer
than that.

**The watermark advances only on a completion receipt naming the dispatched
`runId` (§4.5).** Nothing else moves it — not the send, not a timeout, not a
crash. This single rule is what makes crash recovery correct (§6.2).

### 4.3 Idempotent provenance on tasks

A new optional block on `BoardTask` (`src/lib/tasks/types.ts`), written only by
the analysis path:

```ts
interface TaskAnalysisProvenanceV1 {
  schemaVersion: 1;
  /** Internal provenance — which monitor said so, and when. */
  monitorConversationId: `conversation_${string}`;
  /** Internal conversation + time provenance for the request itself.
      A conversation ID, never a transcript path. */
  sourceConversationId: `conversation_${string}`;
  sourceAt: string | null;               // ISO of the operator record
  firstSeenAt: string;
  lastSeenAt: string;
  runId: string;                         // the run that last touched this card
  /** Every request phrasing this card answers. A later run that judges a
      paraphrase to be the same ask APPENDS its key here instead of creating a
      twin. This is the multi-turn-paraphrase mechanism. */
  requestKeys: string[];
  state: "proposed" | "needs-confirmation" | "tracked" | "stalled" | "completed";
  /** True only when the operator explicitly asked for a GitHub issue. The
      monitor cannot open one (§5); this marks the card for the orchestrator. */
  issueRequested: boolean;
}
```

`requestKey` = sha256 prefix over the normalised operator text. **Three
independent duplicate bounds**, in increasing order of trust:

1. `clientRequestId` = `analysis:<project>:<requestKey>` on `create_task` — the
   existing receipt store (`recentCreates`, `src/lib/tasks/commands.ts`) turns a
   retried identical call into a replay.
2. **Server-side uniqueness.** A create whose `requestKey` already appears in
   any `analysis.requestKeys` for that project is refused and returns the
   existing task. This is enforced inside the same `mutateTasksFile` transaction
   that persists, so it cannot race. A repeated run therefore creates nothing
   even if the model asks it to — duplicate prevention does not depend on model
   discipline.
3. **Packet context.** The task map handed to the model carries the existing
   cards with their `requestKeys` and states, so the model updates rather than
   proposes. This is the layer that catches a *paraphrase* (a different
   `requestKey`), and it is a semantic judgement — which is exactly why it is
   the model's job and not the collector's.

### 4.4 The empty-delta short circuit

If the collector yields zero new operator records **and** no change in the task
map since the last run, the scheduler writes a `no-delta` run record and stops.
The model is not woken; no tokens are spent. This is what makes a quiet interval
free, and it is deliberately still a *run*: `no-delta` and `missed` are
different rows, which is the whole point of #741's audit requirement.

### 4.5 The run packet and the closing receipt

The scheduler mints `runId` (uuid) **before** the send, journals `dispatched`,
then delivers one message containing:

- run header: `runId`, project, window `[from, to]`, cadence, mode
  (`suggest-only` | `manage-tasks`), truncation flags;
- the delta: operator records, each with conversation id, instant, and text —
  full fidelity, because this is an internal local conversation, not a published
  artifact;
- the canonical task map: project cards (id, first line, status, `requestKeys`,
  `state`, `updatedAt`), open pipelines and flows with last-movement instants,
  live/stalled agents, and bounded GitHub references (§3.4 of #744's
  `githubEvidence` prior art, moved server-side because the monitor has no
  shell);
- the contract: what it may do, what it must never do, and the requirement to
  close with `analysis_report`.

The run closes when the agent calls `analysis_report` with the `runId`. The
report carries counts, per-request outcomes and, in `suggest-only` mode, the
proposals themselves. A report for an unknown or already-closed `runId` is
refused. Only then does the watermark advance.

Operator conversation *with* the monitor outside a dispatched packet is not a
run: no `runId`, no watermark movement, no journal row.

---

## 5. Tool grants, and why over-grant is structurally impossible

The monitor's grant is the smallest set that lets it read the board and write
cards. Three **independent** bounds, in the spirit of
`docs/design/computer-use-grant.md` — each sufficient on its own.

### 5.1 Bound 1 — the tools do not exist in that session

The viewer MCP server is a per-session stdio process launched from the profile
`applyClaudeSpawnPolicy` writes (`--strict-mcp-config --mcp-config <profile>`,
`src/lib/agent/cli.ts:207`). The monitor's profile carries
`LLV_MCP_ROLE=monitor` plus the project and conversation id on the `viewer`
entry's env. `startViewerMcpServer` registers only:

```
MONITOR_TOOL_NAMES = [
  "list_conversations", "get_conversation",
  "list_tasks", "get_task", "create_task", "update_task",
  "board_snapshot", "list_pipelines", "get_pipeline",
  "list_flows", "get_flow", "agent_activity", "operator_snapshot",
  "analysis_report",                       // new, §4.5
]
```

Everything else in `MCP_TOOL_NAMES` (`src/lib/mcp/server.ts:14`) is **absent
from the session's tool list**: `spawn_agent`, `send_message`,
`conversation_action`, `conversation_migration`, `create_pipeline`,
`pipeline_action`, `flow_action`, `link_task_to_pipeline`, `deploy_exact_sha`,
`deployment_status`, `lifecycle_events`, `request_attention`. An unrecognised
`LLV_MCP_ROLE` value fails closed to the read-only subset. The env can only
narrow; a role name can never add a tool that is not in its own table.

### 5.2 Bound 2 — the CLI policy

Provisioned `readOnly: true`, which the command builder already turns into
`--permission-mode plan --disallowedTools Edit,Write,NotebookEdit`
(`cli.ts:232`) with no `--dangerously-skip-permissions`. The monitor profile's
`--settings` file additionally denies `Bash`, `WebFetch` and `WebSearch`, and
the native multi-agent hook `applyClaudeSpawnPolicy` installs already denies
`Task, Agent, Workflow, TeamCreate, TeamDelete, SendMessage`
(`spawnPolicy.ts:25`).

**No Bash means no `gh`, no `git merge`, no deploy script, no `docker`.** D4 is
therefore a property of the grant, not a sentence in a prompt.

### 5.3 Bound 3 — server-side role admission

`"monitor"` joins `SPAWN_DENIED_ROLE_IDS`
(`src/lib/agent/spawnAdmission.ts:9`), described in that file as "a hardcoded
contract constant: role overrides only carry config/promptScaffold, so no
persisted preset can widen this set". A spawn request originating from a
monitor conversation is refused by the server even if the CLI bounds were
somehow bypassed.

### 5.4 The pinned model

The `monitor` role in `src/lib/roles/defaults.ts` declares
`config: { engine: "claude", model: "opus", effort: "high" }`,
`capabilities: ["read-only"]`. Provisioning re-validates the resolved role and
refuses to provision if an override changed `engine` or `model`. Tier is
overridable; D1 is not.

### 5.5 Suggest-only vs manage-tasks — enforced, not requested

The behaviour mode lives in the settings record. `create_task` / `update_task`
calls from a monitor-role conversation are checked against the **current
persisted mode of that conversation's designated project**, resolved from the
designation record (the env is a hint, the record is the authority; a mismatch
fails closed). In `suggest-only` the calls are refused with a typed
`McpToolRefusal`, and the model puts its proposals in the `analysis_report`
instead. The settings surface renders those proposals with an operator
**Accept**, which creates the card through the identical idempotent path
(§4.3) — so accepting a proposal and a `manage-tasks` run produce byte-identical
provenance.

Mode is read at call time, so flipping to `suggest-only` mid-run takes effect on
the very next tool call.

---

## 6. Failure recovery

### 6.1 Missed runs

The scheduler stores `nextRunAt`. On start (viewer restart, redeploy, laptop
resume) it compares `nextRunAt` to now:

- one `missed` journal record naming the outage span and the number of skipped
  slots — a missed run is **auditable as a specific absence**, not an inference
  from a gap in the log;
- then exactly one catch-up run over the widened delta (bounded by the lookback
  floor and the run budget), typed `kind: "catch-up"`. Missed slots are never
  replayed one-by-one; that would spend quota re-reading the same window.

### 6.2 Crash mid-run

No receipt arrives. After `runTimeoutMs` (default 20 minutes, strictly less than
the cadence) the sweep marks the run `failed:timeout`. The watermark did not
move, so the next run re-reads the same delta. Any cards the crashed run already
wrote are found by their `requestKeys` and updated instead of duplicated (§4.3
bound 2). Recovery is therefore a re-run, not a repair.

### 6.3 Session gone

The designated conversation is unknown to the registry (deleted, registry loss).
The scheduler reprovisions, at most **one attempt per cadence and two
consecutive attempts total**; after that the project enters
`blocked: provisioning-failed` and stops firing until the operator acts. The new
designation records `supersedes`, and the watermark, journal and every existing
task carry over unchanged — a new session, the same monitor.

### 6.4 Project scoping failures

Evidence is assembled per project. A card, pipeline, flow or agent from another
project can never satisfy a request raised here, and the packet never contains
another project's material. This was HIGH-4 in #744's review; it stays an
acceptance test (§10).

### 6.5 Concurrency

- **Scheduler lease** — one owner across processes, pid + `startIdentity`, the
  `src/lib/wakatime/lease.ts` pattern. Age alone never reclaims a lease from a
  live holder. This is the direct answer to #744's second blocking finding.
- **One open run per project** — the dispatch is fenced on "no open run"; a
  `run-now` during an open run returns `409 busy` with the open `runId` rather
  than dispatching a second packet.
- **Settings writes** — compare-and-set on `revision` (§8.4).
- **Task writes** — inside `mutateTasksFile`, the existing transaction.

### 6.6 Unreadable state

A corrupt settings file must **not** read as "disabled with no history" — that
is a silent stop of the kind this whole design exists to prevent. It fails
closed: the scheduler stops for that project, the surface shows
`blocker: state-unreadable`, and nothing overwrites the file.

---

## 7. Privacy

The repository's publication gate cannot inspect runtime-emitted cards, so
**tests are the only guard**. Every rule below gets one.

| Surface | Carries | Never carries |
| --- | --- | --- |
| run packet (into the monitor session) | full operator text, conversation ids, instants | — (internal, local, never published) |
| board card text | the monitor's own short summary | operator's words quoted back, paths, handles, emails, tokens |
| `analysis` provenance | conversation ids, instants, fingerprints | transcript paths, account ids |
| journal | ids, counts, instants, outcomes, usage | any message text, any path |
| settings UI | ids, counts, instants, model/tier, outcomes | message text, paths, credentials, account identity |

Everything that leaves the monitor session passes through the shared hardened
redactor (`hardenedRedact`, `src/lib/view/compactText.ts:10`) extended with
#744's review-found shapes: email addresses, absolute paths down to two
segments, and **percent-/dash-encoded path forms including the nested case**.
Cards carry a monitor-authored label plus a line saying the summary is the
monitor's own words, never the operator's — the "no quote block" fix from #744's
HIGH-3.

Redaction patterns and their fixtures are assembled at runtime, because a
literal path or address in a committed test file is itself a gate finding.

---

## 8. "Automatic analysis" — placement and control contract

### 8.1 Placement

**A collapsed section at the foot of the project Task panel**
(`src/components/tasks/TaskPanel.tsx`), rendered with the existing
`SectionHeader` recipe (`src/components/ui/SectionHeader.tsx`, design-system
§3.6) beside `FavoritesSection`.

Why this and not something new:

- The panel is already the project's task surface, and this feature's entire
  output is project tasks. Its controls belong with the things it produces.
- It is already reachable on **both** form factors — the desktop header's Tasks
  toggle (`ProjectDashboard.tsx:1593`, `taskPanelOpen` is project board state)
  and the phone's shelf. No new header target: the phone header is at its
  documented 390px budget, where `ProjectDashboard.tsx:1414` states any new
  control must either fit a 44px slot or fold into the `⋯` menu.
- There is **no settings page or settings dialog in this app** — `src/app` has
  exactly one route, and per-project controls live in the dashboard header and
  its panels. Inventing a settings surface would be a new pattern, which the
  brief forbids.
- No new modal layer, so no interaction with `modalLayer.ts` ownership rules.

The `⋯` menu gets one row, *Automatic analysis*, that opens the panel and
scrolls to the section — a phone affordance, not a second surface.

### 8.2 What the section shows

Collapsed (one row): state dot + `Automatic analysis` + last outcome + relative
time, or the blocker in `text-danger` when one is set.

Expanded:

| Control / field | Type | Default | Semantics |
| --- | --- | --- | --- |
| Enabled | switch | **off** | On → provision-or-designate the session (§3.1) and activate the scheduler. Off → stop future wakes only (§3.5). |
| Cadence | select `15 / 30 / 60 / 180` min | **30** | Recomputes `nextRunAt` from `lastRunAt`; never fires a catch-up merely because the cadence shortened. |
| Behaviour | radio `Suggest only` / `Create and update tasks` | **Suggest only** | §5.5. Enforced server-side at tool-call time. |
| Monitor session | link + *Analysis* badge | — | Deep-links `#c=<conversationId>`. Shows *not provisioned* before first enable. |
| Model | static text `Claude Opus 5 · high` | — | Not editable here. States plainly: *semantic analysis uses a model and may consume quota.* |
| Last run | outcome badge + relative instant | — | `found N` / `nothing new` / `skipped — busy` / `missed` / `failed — <reason>`. |
| Next run | relative instant | — | `paused` while disabled; `blocked` when a blocker is set. |
| Window | `from → to`, relative | — | The watermark's consumed-through and the current head. |
| Usage | last run + last 24 h | — | in/out/cache tokens (§8.3) + the Claude window burndown at run time where available. `—` when unavailable; never a guess. |
| Blocker | banner | none | `monitor-busy`, `provisioning-failed`, `state-unreadable`, `delivery-failed`, `resolution-failed`. |
| Run now | button | — | §8.4. Disabled while disabled, blocked, or a run is open. |
| Recent runs | last 5 rows | — | outcome, instant, counts. Full journal behind a *more* link. |

Copy lives in `src/lib/i18n/en.ts` + `uk.ts` under `analysis.*` (the i18n test
enforces locale parity).

### 8.3 Usage telemetry

Measured, not self-reported. Between dispatch and receipt, the monitor
transcript's own assistant records carry `usage.input_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens` and `output_tokens` —
the extraction `src/lib/scanner/context.ts:79` already performs. The journal
attributes the delta over the run's span to the run. Where the Claude limits
reader (`fetchClaudeLimits`, `src/lib/limits.ts:305`) has a current window, the
surface also shows the plan-window position at run time.

If usage cannot be attributed (transcript unreadable, records without usage),
the field reads `—`. An unmeasured run is never rendered as a free one.

### 8.4 HTTP contract

| Route | Body / query | Returns |
| --- | --- | --- |
| `GET /api/analysis?project=<p>` | — | `{ revision, settings, designation, watermark: {from,to}, lastRun, nextRunAt, blocker, usage, recentRuns }` |
| `PATCH /api/analysis` | `{ project, baseRevision, enabled?, cadenceMinutes?, mode? }` | `200 { revision, … }` or `409 { error:"revision conflict", current }` |
| `POST /api/analysis/run` | `{ project, clientRequestId }` | `202 { runId }`, or `409 { reason: "disabled" \| "busy" \| "blocked", … }` |
| `GET /api/analysis/runs?project=<p>&limit=` | — | journal page, sanitized at the route (§7) |
| `POST /api/analysis/report` *(and the `analysis_report` MCP tool)* | `{ runId, outcome, findings[], proposals[] }` | `200` or `409 unknown/closed run` |

**Run now goes through the identical path as a scheduled fire**: same collector,
same budget, same lease, same single-flight fence, same idempotency, same
journal — it differs only in `kind: "run-now"` and in not moving `nextRunAt`.
The builder must not add a second dispatch path.

Every route sanitizes its response down to the audit fields, so the privacy
promise is structural rather than trusted to the caller — the same correction
#744 made under review.

### 8.5 Durability and cross-device correctness

Settings live in `state/automatic-analysis.json` (`statePath`), keyed by
project, with an integer `revision` and an atomic write. Writes are
compare-and-set on `baseRevision`; a stale device gets a 409 with the current
state and re-renders. The server is the single authority, so two devices cannot
disagree about whether the scheduler is on.

**Dependency on PR #745 (board-sync convergence): none.** That PR touches
`src/hooks/useBoardState.ts` and two of its tests, and nothing else. This design
deliberately does **not** put the setting in `board.json`/`BoardProjectStateV1`,
for three reasons: agent lifecycle state is not view presentation; every card
drag rewrites the board file and settings should not contend with drags; and
#745's per-key last-writer-wins reconciliation is designed for *view intent*,
where dropping a superseded queued mutation is correct — while "the scheduler is
enabled" must never be resolved by a client-side merge. This design borrows the
**revision-fence pattern** #745 proves, not its code, and the two lanes share no
file.

---

## 9. Task schema and provenance — the builder's record shapes

Additive only; every existing task loads unchanged.

- `BoardTask.analysis?: TaskAnalysisProvenanceV1` (§4.3) — validated in the task
  store's `projectState`-style validator; unknown/malformed blocks reject the
  file rather than loading silently, matching the board store's posture.
- `create_task` / `update_task` accept `analysis` **only** from a monitor-role
  caller in `manage-tasks` mode. An operator-created card never carries it.
- Status vocabulary reuses the existing `TaskStatus`. The analysis `state` is
  a separate axis, because "the monitor believes this is stalled" and "the
  operator moved the card to blocked" are different claims and must not
  overwrite each other.
- `issueRequested: true` cards render a *needs an issue* marker; the orchestrator
  or the operator opens the issue. The monitor cannot (§5).

---

## 10. Acceptance tests

Run by path, against an isolated `HOME` / `XDG_CONFIG_HOME` / `TMPDIR` /
`LLV_STATE_DIR`. Never sweep the live registry — `AGENTS.md` documents the day
this killed the operator's own conversation host.

**The semantic boundary is injectable.** `runAnalysis(deps)` takes a
`semanticReader` port. Unit and acceptance tests drive a scripted reader; the
real reader is the Opus session. No test spends quota, and no test asserts what
a model will say.

### Mandated

1. **Multi-turn paraphrases that heuristics miss** — a fixture transcript where
   the ask is built across four operator turns ("the export thing we discussed",
   "yeah do that one", …) with no imperative verb in any single message. Two
   assertions: (a) `taskTextFromPrompt` (the rejected heuristic) returns `null`
   for every one of those records — this pins *why* the rewrite happened; (b)
   the collector nonetheless delivers all four records to the reader, in order,
   with their conversation ids and instants intact. The judgement itself is the
   reader's, and the scripted reader proves the pipeline carries it through to a
   card.
2. **The same session across scheduler fires** — three fires; exactly one
   provisioning call; all three dispatch to the identical `conversationId`; a
   generation rollover between fire 2 and 3 (new transcript path, same id) does
   not provision a fourth session and does not change the designation.
3. **Duplicate prevention across repeated runs** — a run creates one card;
   re-running the identical window creates nothing, updates the same card's
   `lastSeenAt`; a *paraphrase* in a later window appends a second entry to
   `requestKeys` on the same card instead of creating a twin; a create whose
   `requestKey` already exists is refused by the store even when the reader asks
   for it (bound 2 proven without the model's cooperation).
4. **Own-output exclusion** — the run packet delivered into the monitor session
   appears in its transcript as a `user` record; the next run's collector
   returns zero records from that conversation. Additionally: a card the monitor
   itself wrote never re-enters as an operator request.
5. **Project scoping** — a terminal-state card, a passing pipeline and a merged
   PR reference all belonging to project B never appear in project A's packet
   and never mark A's request as answered; a request in A stays untracked when
   only B has matching evidence.
6. **Safe recovery after a missed run** — the scheduler is stopped across two
   cadence slots; on start it writes exactly one `missed` record naming the
   span and the slot count, then runs once over the widened window; the
   watermark ends where the catch-up run consumed to, and nothing is
   double-created.

### Additional, and each one is a failure mode the builder must **handle rather
than discover**

7. Mid-turn session → `skipped-busy`, no interrupt call issued, watermark
   unchanged; three in a row raise `monitor-busy`.
8. Unhosted session → resumed and delivered; the resume targets the designated
   id and nothing else; a dispatcher asked to send to a non-designated id
   refuses.
9. Crash mid-run (no receipt) → `failed:timeout`, watermark unchanged, re-run
   creates nothing new.
10. A receipt for an unknown or already-closed `runId` is refused, and does not
    advance the watermark.
11. Empty delta → `no-delta` recorded, the semantic reader is **never invoked**
    (assert zero calls — this is the cost guarantee).
12. Disable → no further fires; the designation, watermark, journal and every
    created task survive; re-enable resumes from the same watermark.
13. `suggest-only` → `create_task` from the monitor conversation is refused with
    a typed refusal; the proposal appears in the report; operator Accept creates
    the card with byte-identical provenance to a `manage-tasks` run.
14. Tool grant → the monitor session's registered MCP tool list equals
    `MONITOR_TOOL_NAMES` exactly; an unknown `LLV_MCP_ROLE` yields the read-only
    subset; a spawn request from a monitor conversation is refused at admission.
15. Privacy → no card text, journal record or API response contains an email, an
    absolute path (including percent- and dash-encoded and nested forms), an
    account id, or any substring of the operator's own message text.
16. Revision fence → a PATCH at a stale `baseRevision` is refused with 409 and
    the current state; the losing device converges without a reload.
17. `Run now` during an open run → `409 busy`, one run in the journal.
18. Corrupt settings file → scheduler stops for that project, blocker
    `state-unreadable`, file untouched.
19. Reprovisioning is bounded: two consecutive failures → `provisioning-failed`,
    no third attempt until the operator acts.

### Not covered by tests, and named as such

Semantic accuracy. Whether Opus correctly reads a given conversation is
validated by an operator-run evaluation against real transcripts during the
supervised soak (§11), not by unit tests. Any test that pins the model's
judgement would pin a snapshot of a model, which is worse than no test.

---

## 11. Rollout

1. Land the slice with the scheduler **inert** — the setting exists and defaults
   off for every project; no lease is taken while no project is enabled.
2. Operator enables it for the Live Log Viewer project only, in
   **`suggest-only`** mode.
3. Supervised soak: the operator reads the proposals and the usage numbers for
   an agreed number of runs and judges accuracy and cost.
4. Only then: `manage-tasks`, and only then a second project.
5. **Operator action, not the implementer's**: remove the
   `# BEGIN llv-orchestrator-watchdog` crontab block. Leaving it in place while
   this ships means two monitors, one of which talks to a dead conversation.

---

## 12. Open questions — for the operator, not for the implementer to guess

1. **Reprovisioning authority.** §6.3 auto-reprovisions a lost session (bounded
   to two attempts) because a monitor that dies silently is the exact failure
   being replaced. The alternative is to block and wait for the operator. Which?
2. **Reasoning tier.** D1 pins Opus 5; the default tier here is `high`. `xhigh`
   or `max` would read harder for more quota. Confirm `high`, or name the tier.
3. **Lookback floor.** 7 days on first enable and after a long outage. A
   re-enable after a month otherwise replays a month. Confirm, or set another
   bound.
4. **Cadence floor.** The select offers 15 minutes as its shortest option.
   Should anything shorter be reachable at all?
5. **What "found nothing" should feel like.** Should a run that found nothing
   for N consecutive cycles quietly widen the cadence, or is a fixed cadence the
   whole point?
6. **Scope beyond one project.** The design is per-project throughout. Is a
   single monitor covering several projects ever wanted, or is per-project the
   permanent shape?
7. **Attention.** `request_attention` is deliberately **not** granted, so the
   monitor cannot pull the operator's viewer. Should an urgent finding be able
   to raise attention, or is the board card always enough?
