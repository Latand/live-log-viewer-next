# Runtime Host Spike — Codex app-server & Claude stream-json, July 2026

Spike for issue **#25** (runtime: structured SDK / stream-json for both engines, on subscription), step 1 of Lane A in the backlog execution program (`docs/backlog-execution-2026-07.md`, commit `ddd5154`). Every claim below is either **verified** (live probe on this machine, exact command given), **documented** (engine's own schema/help text), or an explicit **unknown** with a verification path. No implementation is committed here.

## TL;DR

- **Both engines drive real turns on the paid subscription with no API key in the environment.** Verified: Codex `auth_mode=chatgpt` (`codex login status` → "Logged in using ChatGPT"), Claude `apiKeySource:"none"` in the `system/init` event on a `subscriptionType: max` OAuth credential.
- **Codex app-server delivers everything tmux gives us for machine control, natively and better.** Verified over one server with two concurrent WebSocket clients: late attach to an in-flight turn (`thread/resume` returns history and then live deltas), cross-client `turn/steer` folded into the running turn, cross-client `turn/interrupt` → `status:"interrupted"`, SIGKILL mid-turn → new server process resumes the same thread with context intact.
- **Claude stream-json covers the same list except multi-client, which needs our broker.** Verified: long-lived `-p --input-format stream-json` process takes multiple turns; a message written mid-turn **queues** and runs as the next turn; `control_request {subtype:"interrupt"}` aborts the turn and the session takes the next turn in the same process; SIGKILL then `--resume <id>` in a fresh process **keeps the same session id** and context; `--permission-prompt-tool stdio` routes permission decisions to the client as `can_use_tool` control requests.
- **Idempotency and fencing primitives exist natively on the Codex side**: `clientUserMessageId` round-trips into the persisted thread item (`item.clientId`), and `turn/steer` requires an `expectedTurnId` precondition ("request fails when it does not match the currently active turn" — a protocol-level CAS). Claude has neither; the broker and the #12 queue must supply them.
- **Both engines keep writing the session artifacts the viewer already scans** (`~/.codex/sessions/...rollout-*.jsonl`, `~/.claude/projects/<cwd>/<session>.jsonl`), so the read path (scanner, feed, history) survives the migration unchanged; only the control plane moves off tmux.
- **The human TTY escape hatch stays tmux** (optional, human-only). Codex has a daemon + `codex resume` TUI; Claude has a native background-agent daemon with per-worker PTY sockets — both are promising but partly internal/undocumented, so neither replaces the tmux hatch yet.

## Environment

| Component | Version / state | Evidence command |
| --- | --- | --- |
| codex CLI | `codex-cli 0.144.0` | `codex --version` |
| Claude Code | `2.1.197` | `claude --version` |
| Node | `v26.4.0` | `node --version` |
| Codex auth | ChatGPT subscription (`auth_mode: "chatgpt"` in `~/.codex/auth.json`) | `codex login status` → `Logged in using ChatGPT` |
| Claude auth | OAuth, `subscriptionType: "max"` (from `~/.claude/.credentials.json`, tokens not read) | `jq -r '.claudeAiOauth.subscriptionType' ~/.claude/.credentials.json` |
| API keys in env | none (`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` unset) | `env \| grep -cE '^(ANTHROPIC_API_KEY\|OPENAI_API_KEY)='` → 0 |
| Codex config defaults | `model = "gpt-5.6-sol"`, `approval_policy = "never"`, `sandbox_mode = "danger-full-access"` | `~/.codex/config.toml` |

Probes ran from a scratch directory outside any repo; Codex probes used `sandbox: "read-only"` (except the approval probe) and `effort: "low"`; Claude probes used `--model haiku`. All probe processes were children of one bounded foreground driver script with a hard timeout; per-probe cost was a handful of tiny turns.

## Codex: app-server (JSON-RPC 2.0)

### Protocol discovery — the schema is generated locally, no guessing

```bash
codex app-server generate-json-schema --out <dir>
```

emits the full protocol: `ClientRequest.json` (client→server methods), `ServerRequest.json` (server→client requests, i.e. approvals), `ServerNotification.json` (events), plus per-message param/response schemas (v2). Method inventory relevant to hosting:

- **Client→server:** `initialize`, `thread/start`, `thread/resume`, `thread/list`, `thread/loaded/list`, `thread/read`, `thread/fork`, `thread/rollback`, `thread/inject_items`, `thread/unsubscribe`, `thread/archive`, `turn/start`, `turn/steer`, `turn/interrupt`, `model/list`, `account/read`, `account/rateLimits/read`, `account/login/start`, `account/logout`, `review/start`, …
- **Server→client requests (block the turn until answered):** `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval`, `item/tool/requestUserInput`, `execCommandApproval`, `applyPatchApproval`, `mcpServer/elicitation/request`, …
- **Notifications:** `thread/started`, `thread/status/changed`, `turn/started`, `turn/completed`, `turn/diff/updated`, `item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `item/reasoning/*`, `thread/tokenUsage/updated`, `account/rateLimits/updated`, `error`, …

Two schema details matter architecturally:

- `TurnStartParams` and `TurnSteerParams` accept **`clientUserMessageId`** — a client-chosen id for the message.
- `TurnSteerParams` **requires `expectedTurnId`**: "Required active turn id precondition. The request fails when it does not match the currently active turn." (schema description). Steering is compare-and-swap on the active turn.
- `ThreadResumeParams` doc: "If thread_id identifies a running thread, app-server **rejoins that thread**" — late attach is a documented primitive, both for live and for on-disk threads.

### Transports

`codex app-server --listen` supports `stdio://` (default), `unix://PATH`, `ws://IP:PORT` (`--help`). Also present, from `codex app-server daemon --help` / `proxy --help`:

- `codex app-server daemon start|stop|restart|version|bootstrap|enable-remote-control` — a managed long-lived daemon ("Install durable local app-server management for SSH-driven use"); `daemon version` prints JSON: `{"status":"running","backend":"pid","socketPath":"~/.codex/app-server-control/app-server-control.sock","cliVersion":"0.144.0","appServerVersion":"0.135.0"}`.
- `codex app-server proxy --sock PATH` — "Proxy stdio bytes to the running app-server control socket": any process can bridge stdio JSONL to the daemon.

Observed transport facts:

- **stdio JSONL: verified** (all single-client probes).
- **`ws://127.0.0.1:<port>`: verified with two concurrent clients**, one JSON-RPC message per WebSocket frame.
- **`unix://PATH`: two caveats.** The path must fit `SUN_LEN` (~108 bytes; long paths fail with `Error: path must be shorter than SUN_LEN`), and raw newline-delimited JSON on the socket got no response to `initialize` in this spike — framing on that listener is an **unknown** (ws framing over the unix socket is the likely answer; the daemon's own control socket is designed to be reached through `app-server proxy`, which is the supported path).
- **Version skew is real:** the managed daemon runs a pinned standalone `appServerVersion 0.135.0` while the CLI is `0.144.0`. A host adapter must tolerate protocol drift between what it spawns and what a daemon runs.

### Live probes (driver: `appserver-driver.mjs`, JSONL logs kept per scenario)

All scenarios spawn `codex app-server` as a child, speak JSON-RPC over the chosen transport, and kill their children on exit. `initialize` params: `{clientInfo:{name:"llv-runtime-host-spike",...}, capabilities:{experimentalApi:true}}`, followed by the `initialized` notification.

**Baseline JSONL (`codex exec`, cheapest sanity):**

```bash
codex exec --json --skip-git-repo-check -s read-only -c model_reasoning_effort=low 'Reply with exactly: SPIKE-OK'
```

→ `thread.started {thread_id}`, `turn.started`, `item.completed {agent_message "SPIKE-OK"}`, `turn.completed {usage}`. Subscription auth, no key.

**basic (stdio, one client):** `thread/start {cwd, sandbox:"read-only", approvalPolicy:"never"}` → response contains the thread object **including the rollout path** (`~/.codex/sessions/2026/07/09/rollout-…-<threadId>.jsonl`). `turn/start {input:[{type:"text",…}], clientUserMessageId:"spike-basic-1", effort:"low"}` → event sequence: `thread/started → thread/status/changed → turn/started → item/started → item/agentMessage/delta → item/completed → thread/tokenUsage/updated → account/rateLimits/updated → turn/completed {status:"completed", durationMs}`. The persisted user-message item carries the client key back: `item/completed {item:{type:"userMessage", clientId:"spike-basic-1", …}}`. The rollout's `session_meta` records `originator:"llv-runtime-host-spike"` (from `clientInfo.name`), `source:"vscode"`, `cwd`, `cli_version` — attribution the scanner can read.

**multi (ws, two clients — the tmux-replacement scenario):**

1. Client A: `thread/start`, then `turn/start` on a long generation; A receives `turn/started {turnId}` and streaming `item/agentMessage/delta`.
2. **While the turn is in flight**, client B opens a second WebSocket: `thread/loaded/list` → shows the running thread id; `thread/resume {threadId}` → succeeds with the full thread object (`status`, `path`, `cwd`, `gitInfo`, `turns`, **`initialTurnsPage`** for history replay, and lineage fields `parentThreadId`, `forkedFromId`, `agentNickname`, `agentRole`) — and **B then receives the live deltas of the in-flight turn**.
3. B sends `turn/steer {threadId, expectedTurnId, input:[…STEERED-OK…], clientUserMessageId}` → accepted (`{turnId}` of the active turn); the steered instruction was honored **inside the same turn** (`STEERED-OK` appears in that turn's final agent message; no new turn id).
4. B starts a second long turn; **A** sends `turn/interrupt {threadId, turnId}` → `turn/completed {status:"interrupted", error:null}` delivered to **both** clients.

Verdicts: multi-client **yes**, late attach mid-turn **yes** (history + live deltas), cross-client steer/interrupt **yes**.

**crash (SIGKILL after a completed turn):** server 1 stores a marker in a turn, `SIGKILL` server 1, spawn server 2, `thread/resume {threadId}` → ok; next turn recalls the marker (`ZEBRA-7` returned). Restart-recovery **yes**.

**midcrash (SIGKILL during streaming):** server killed while `item/agentMessage/delta` was flowing; fresh server: `thread/resume` → ok, `thread/read` returns the thread, next `turn/start` completes normally (`ALIVE-AFTER-CRASH`). The half-streamed turn is lost as expected; the thread is not corrupted. Mid-turn crash adoption **yes** (at turn granularity).

**approval (structured approval round-trip):** `thread/start {approvalPolicy:"untrusted", sandbox:"workspace-write"}`, prompt asks for a file-writing shell command. The server sends a **JSON-RPC request** `item/commandExecution/requestApproval {command:…}`; the client answers `{decision:"accept"}`; the command runs; the turn completes. (A plain `echo` did **not** trigger approval under `untrusted` — safe-listed commands auto-run; the probe needed a write redirect.) Consequence: **an unanswered approval blocks the turn — whoever owns approvals must always be attached** (registry requirement below).

**model override (`gpt-5.6-luna`):** `model/list` → `["gpt-5.5","gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna","gpt-5.4","gpt-5.4-mini","gpt-5.3-codex-spark"]`; `thread/start {model:"gpt-5.6-luna"}` ran the turn on Luna end-to-end. Model (and `effort`) are per-thread **and per-turn** parameters — relevant to #23 (change model of a running agent) and to keeping probe/worker cost off the primary model.

### Codex unknowns

1. **`unix://` listener framing** (raw JSONL got no `initialize` response). Verify: try a WebSocket client over the unix socket, or standardize on `app-server proxy` / `ws://127.0.0.1`.
2. **TUI ↔ app-server interplay:** does interactive `codex resume <threadId>` in a terminal attach to a thread currently live inside an app-server (via the daemon), or does it spawn an independent process on the same rollout (duplicate-class risk, as with Claude interactive resume)? Needs a TTY test.
3. **Approval requests on multi-client:** which client(s) receive `item/*/requestApproval` when several are attached, and what happens if an approval-capable client detaches mid-request. Verify in the prototype phase.
4. **Daemon protocol stability:** `app-server` is marked `[experimental]`; daemon pins its own binary (0.135.0 vs 0.144.0 CLI observed). Pin and test the protocol per release.

## Claude: stream-json + control protocol (broker required for multi-client)

### CLI surface (2.1.197)

Relevant flags (`claude --help`): `-p/--print`, `--input-format stream-json`, `--output-format stream-json`, `--include-partial-messages`, `--replay-user-messages` ("Re-emit user messages from stdin back on stdout" — lets a broker sequence its own injections against model output), `--resume [id]`, `--fork-session` ("When resuming, create a new session ID" — **forking is now opt-in; plain resume keeps the id**, verified below), `--session-id <uuid>` (supervisor chooses the session id at spawn — identity by construction), `--permission-mode`, and a hidden-but-present `--permission-prompt-tool` (in `--help` output only as binary strings; accepted on the command line, verified below).

Control-protocol vocabulary embedded in the binary (`grep -a` over `claude.exe` strings): `control_request` / `control_response` / `control_cancel_request` framing with subtypes `initialize`, `interrupt`, `can_use_tool`, `set_permission_mode`, `set_model`, `hook_callback`, `mcp_message`, `rewind_conversation`.

### Live probes (driver: `claude-driver.mjs`)

All scenarios spawn `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku` (plus per-scenario flags) as a child in a scratch cwd. Input framing: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}` per line. Note: **nothing is emitted until the first stdin line arrives** — `system/init` follows the first input, so a supervisor must write before it can observe.

**single:** init → `{session_id, model:"claude-haiku-4-5-20251001", permissionMode:"default", apiKeySource:"none"}`; result → `{subtype:"success", result:"CLAUDE-OK", num_turns:1, usage{…, service_tier}, total_cost_usd}`. Full event-type sequence observed: `system/init, system/status, stream_event (partials), system/thinking_tokens, rate_limit_event, user (replayed), assistant, result/success`. **`rate_limit_event` is a structured quota signal in-stream.**

**multiturn (one process, sequential turns):** two `user` messages, two `result` events, same `session_id`, stdin stays open between turns. The long-lived single process is a real session host.

**inject (mid-turn injection semantics — issue Q1):** during an active counting turn (partials flowing), a second `user` message was written to stdin. Observed: the current turn **ran to completion** (full count, `result` #1), then the injected message was processed **as its own next turn** (`result` #2). **Semantics: queue-until-turn-end. There is no steer.** Nothing was lost, nothing interleaved.

**interrupt:** mid-turn `{"type":"control_request","request_id":"spike-int-1","request":{"subtype":"interrupt"}}` → `control_response {subtype:"success"}`, the turn ends with `result {subtype:"error_during_execution", is_error:true}`, and — key fact — **the same process then accepted and completed the next user turn** ("ALIVE"). Interrupt kills the turn, and the session lives on.

**resume after crash:** phase 1 stores a marker, then **SIGKILL** (no graceful shutdown). Phase 2: `claude -p --resume <session_id> …` in a **new** process → `init.session_id` **equals the original id**, the marker is recalled, and the resumed turns **append to the same transcript file** (`~/.claude/projects/<cwd-slug>/<session_id>.jsonl`, single `sessionId` throughout). This removes the historical fork-per-resume identity churn that feeds #31's duplicate pile-ups — as long as `--fork-session` is not passed.

**permission (structured approvals — replaces approval-menu scraping):** with default permission mode and **`--permission-prompt-tool stdio`**, a gated `Write` produced `control_request {subtype:"can_use_tool", tool_name:"Write", input:{…}}` on stdout; the client's `control_response {behavior:"allow", updatedInput}` unblocked it; the file was written, `permission_denials: 0`. **Without** the flag, the same action was silently auto-denied (`permission_denials: 1`) and **no** `can_use_tool` arrived — the flag is load-bearing. The `control_request {subtype:"initialize"}` handshake response also returns a capability snapshot (`commands`, `agents`, `models`, `account`, `pid`, …).

### Native background-agent surface (the `--bg` investigation from the issue)

Claude Code 2.1.197 ships its own supervisor infrastructure, discovered read-only:

- `claude --bg/--background` — "Start the session as a background agent"; `claude agents` — TUI to manage them; **`claude agents --json` lists live sessions machine-wide without a TTY**: `{pid, cwd, kind:"interactive", sessionId, name, status:"busy"|"idle", startedAt}`. Backing store: **`~/.claude/sessions/<pid>.json`** (adds `procStart`, `version`, `peerProtocol:1`, `entrypoint`).
- A daemon (`~/.claude/daemon.status.json`, `daemon.log`, `daemon/roster.json`) supervises dispatched workers; roster entries record `sessionId`, `pid`, `procStart`, restart `attempt`, and **per-worker sockets**: `rendezvousSock` and `ptySock` under `/tmp/cc-daemon-<uid>/…` — i.e. Anthropic's own broker keeps a control socket **and a PTY** per background worker. Workers launch with an internal `--daemon-worker` flag.

Assessment: the native daemon is the strongest hint that a broker per long-lived Claude process is the intended architecture, and `claude agents --json` + `sessions/<pid>.json` are immediately useful liveness inputs for the registry (they implement pid+procStart fencing already). The worker socket protocols (`peerProtocol: 1`, rendezvous/pty) are undocumented internals — during this spike two live pids shared one `sessionId` in that listing, so the native layer also does not prevent duplicates. Track it; do **not** build on it yet.

### The broker (what we must build for Claude)

One stream-json process has exactly one stdio pair, owned by its spawner. The broker is a small supervisor that owns that pair and exposes it:

- **Fan-out:** every stdout line is appended to an event ledger and republished to N subscribers. A late subscriber replays from the ledger and/or from the transcript file (the viewer already tails these — `src/lib/logTailStream.ts`); events carry `uuid`/`session_id`, so replay-then-live continuity is deterministic. (This spike verified the primitives — single-owner stdio, `--replay-user-messages` echo, transcript append — and leaves the literal N-subscriber demo to the prototype.)
- **Inject:** subscribers submit messages; the broker serializes them into stdin. Verified semantics: mid-turn injections queue as the next turn, so the broker can accept sends at any time without corrupting an active turn.
- **Interrupt / permission:** the broker forwards `control_request` interrupts and owns the `can_use_tool` channel (it is the single process the CLI can ask). It must expose pending permission requests as structured attention items to the viewer.
- **Lifecycle:** if the broker dies, the child's stdin closes and the process winds down; recovery is `--resume <session_id>` (verified, identity-stable). Run brokers outside the Next.js server process (viewer restarts must not restart agents — #10's core promise).

### Claude unknowns

1. **Free-form waiting detection** stays heuristic: a clarifying question asked in plain text ends with an ordinary `result {subtype:"success"}` — indistinguishable, at the protocol level, from completion (issue Q5). The workable signal becomes: turn ended + no queued outbound + no pending `can_use_tool`/`AskUserQuestion` + idle — computed from owned state instead of `waitingInput.ts` pane heuristics; `AskUserQuestion`/`ExitPlanMode` keep coming from the transcript (`src/lib/scanner/questions.ts`) and, in SDK mode, also surface through `can_use_tool`.
2. **Interactive human takeover of a broker-owned session** has no native path (attaching a TTY to a running `-p` process is not a thing). Escape hatch below.
3. **Native daemon wire protocols** (`rendezvousSock`, `peerProtocol`) — undocumented; revisit each release.
4. **stream-json input schema breadth** (images, tool results in user messages) — not probed here; the SDK exercises them, so treat as documented-but-unverified.

## Capability matrix

| Capability | Codex app-server | Claude stream-json (+broker) | tmux baseline (today) |
| --- | --- | --- | --- |
| Late attach to running agent | **Native, verified** — `thread/resume` rejoins live thread, returns `initialTurnsPage` + live deltas | **Broker** — replay ledger/transcript, then live; primitives verified, fan-out demo pending | Native (`tmux attach`), but output is a rendered screen, lossy |
| Structured event observation | **Native, verified** — typed notifications incl. deltas, items, token usage, rate limits | **Native, verified** — typed JSONL incl. partials, `rate_limit_event`, `result{usage}` | None — screen scraping (`paneScreen` + regex heuristics) |
| Steer into in-flight turn | **Native, verified** — `turn/steer` + `expectedTurnId` CAS, folds into current turn | **No steer** — mid-turn stdin **queues** as next turn (verified); interrupt-then-send as explicit fallback | Paste lands in composer; behavior depends on TUI state — the #12 hang/loss class |
| Interrupt | **Native, verified** — `turn/interrupt` → `status:"interrupted"`, cross-client allowed | **Native, verified** — `control_request interrupt` → turn errors, session survives | Esc keystroke, unverifiable |
| Restart / resume (planned restart) | **Verified** — new server + `thread/resume`; also `exec resume`, `thread/fork`, `thread/rollback` | **Verified** — `--resume <id>` keeps session id, appends same transcript; `--fork-session` opt-in | `claude --resume` in new pane — historically forked ids, duplicate panes (#31) |
| Subscription OAuth (no API key) | **Verified** — ChatGPT plan; `account/rateLimits/updated {planType:"pro", usedPercent, resetsAt}` in-stream | **Verified** — `apiKeySource:"none"`, Max plan; `rate_limit_event` in-stream | Same auth, but quota state scraped from screens |
| Multiple simultaneous clients | **Native, verified** — 2 concurrent ws clients on one server; `thread/unsubscribe` per client | **Broker fan-out** (one owner, N subscribers) | Native (multiple `tmux attach`) |
| Crash adoption (host process dies) | **Verified incl. mid-turn SIGKILL** — thread resumable by any new server process | **Verified** — SIGKILL + `--resume` restores identity & context; in-flight turn lost | Pane survives viewer death (tmux server owns it) — the one lifecycle property to consciously replace (daemon/broker placement, R10-5) |
| Human TTY escape hatch | Partial — `codex resume <id>` TUI (fork-vs-attach **unknown**); daemon+`proxy` for machine clients | None for `-p` processes; native daemon has per-worker `ptySock` (internal) | **Native — this is tmux's remaining unique value** |
| Idempotent delivery hook | **Native** — `clientUserMessageId` → persisted `item.clientId` (verified round-trip) | None native — broker ledger + queue id (#12) | None — paste + composer-verify heuristics |
| Approvals / permissions | **Native, verified** — server→client JSON-RPC requests; blocking | **Verified** — `can_use_tool` via `--permission-prompt-tool stdio`; blocking | Menu scraping + keystrokes (`parseScreenMenu`) |

**Answers to #25's open questions:** (1) mid-run injection: Codex steers the live turn (`turn/steer`, CAS-fenced); Claude queues to next turn — the #12 queue must model both (`steered` vs `queued` receipts). (2) Multi-client/late attach: Codex native, verified mid-turn; Claude via broker, replay primitives verified. (3) Resume after crash: verified on both engines, including Codex mid-turn kill; Claude keeps the session id. (4) Subscription auth: verified end-to-end on both, no API keys. (5) Waiting/idle: hard signals now exist for turn-end, interrupts, approvals, and token/limit state; free-form "A or B?" questions remain a heuristic on both engines (turn-ended + nothing-pending + idle).

## EngineHost — host-neutral adapter seam (derived)

The registry (#10) stays the source of truth; hosts are adapters behind one interface, keyed by the engine's own durable session identity. Tmux remains a legacy adapter during migration.

```ts
type Engine = "codex" | "claude";
/** The ONLY durable identity: engine + engine-native session/thread id.
 *  codex: threadId (== rollout session id); claude: session_id (== transcript basename). */
interface SessionKey { engine: Engine; sessionId: string }

interface HostCapabilities {
  steerInFlight: boolean;        // codex: true; claude: false
  queueWhileBusy: boolean;       // claude: true (verified); codex: turn/start while busy → use steer/queue policy
  multiClient: boolean;          // codex: true; claude: broker-provided
  nativeIdempotencyKey: boolean; // codex clientUserMessageId; claude: broker ledger
  midTurnCrashResume: boolean;   // both: true (turn granularity)
  ptyEscapeHatch: boolean;       // tmux adapter only, for now
  setModel: boolean; setPermissionMode: boolean;
}

interface EngineHost {
  capabilities(): HostCapabilities;
  /** Spawn a new session. MUST return the SessionKey before the first turn is sent
   *  (codex: thread/start response; claude: supervisor-chosen --session-id),
   *  and MUST persist {key, parent, spawnSource} to the registry first (#34). */
  start(spec: SpawnSpec): Promise<SessionHandle>;
  /** Adopt an existing session after crash/restart/claim-takeover. Never spawns a duplicate:
   *  fails if another live claim exists (G4). codex: thread/resume; claude: --resume. */
  adopt(key: SessionKey): Promise<SessionHandle>;
  /** Observe. Late subscribers get replay (afterSeq) then live events. Read-only, any number. */
  attach(key: SessionKey, opts?: { afterSeq?: number }): AsyncIterable<EngineEvent>;
  /** Deliver a message. Requires the caller to hold the session claim (G4).
   *  idempotencyKey is mandatory; receipt says what actually happened. */
  send(key: SessionKey, msg: { idempotencyKey: string; text: string; images?: string[] },
       policy: "queue" | "steer-if-active" ): Promise<DeliveryReceipt>;
  interrupt(key: SessionKey): Promise<void>;                      // claim-holder only
  answer(key: SessionKey, attentionId: string, res: AttentionResolution): Promise<void>;
  health(key: SessionKey): Promise<HostHealth>;                   // live pid+procStart evidence or "unhosted"
  release(key: SessionKey): Promise<void>;                        // stop hosting; session data persists (reap-safe)
}

type DeliveryReceipt =
  | { outcome: "steered"; turnId: string }        // codex ack (turn/steer response)
  | { outcome: "queued"; position?: number }      // claude mid-turn, or codex queue policy
  | { outcome: "turn-started"; turnId: string }   // idle session, new turn
  | { outcome: "rejected"; reason: "stale-turn" | "no-claim" | "dead-host" };

type EngineEvent =
  | { kind: "turn-started"; turnId: string; seq: number }
  | { kind: "delta"; turnId: string; text: string; seq: number }
  | { kind: "item"; item: NormalizedItem; seq: number }             // messages, tool calls, diffs
  | { kind: "turn-ended"; turnId: string; status: "completed" | "interrupted" | "error"; usage?: Usage; seq: number }
  | { kind: "attention"; id: string; attention: ApprovalRequest | PermissionRequest | UserQuestion; seq: number } // blocks until answer()
  | { kind: "limits"; snapshot: RateLimitSnapshot; seq: number }    // account/rateLimits/updated | rate_limit_event
  | { kind: "session-status"; status: "active" | "idle" | "unhosted" | "dead"; seq: number };
```

Adapter mapping: `CodexAppServerHost` (child stdio per session initially; daemon+`proxy`/`ws://` once framing/daemon questions close) and `ClaudeBrokerHost` (broker process per session, stream-json + control protocol). Both write their events from the engine's native stream; the scanner keeps reading rollouts/transcripts exactly as today, which also serves as the replay source for `attach(afterSeq)`.

## Requirements derived for the dependent work

### #10 — durable registry (observation/actuation split per G6)

- **R10-1** Registry rows key on `SessionKey` (engine + native session id). Pane ids, pids, and socket paths are mutable host columns; identity lives only in the `SessionKey`. (Codex `thread/resume` and Claude id-stable `--resume` make this key durable — verified.)
- **R10-2** Row fields (minimum): `sessionKey`, `artifactPath` (rollout/transcript — both observed authoritative), `cwd`, `hostKind` (`tmux | codex-app-server | claude-broker`), `hostEndpoint`, `hostPid`+`procStart`, `claimRef` (G4), `status`, `lastEventAt`, `spawnSource`/`originator` (codex `session_meta.originator` from `clientInfo.name`; set codex `threadSource`/`sessionStartSource` and claude `--session-id` at spawn), `parentSessionKey` (#34 — codex threads natively carry `parentThreadId`/`forkedFromId`; record ours at spawn regardless).
- **R10-3** Boot/refresh reconciliation inputs, in order of trust: registry rows → engine session stores on disk → live evidence: `claude agents --json` + `~/.claude/sessions/<pid>.json` (native, includes `procStart`) and, per running app-server, `thread/loaded/list`. Recovery action is `adopt()` (resume-by-id), verified on both engines including mid-turn crash; entries whose artifacts are gone are marked dead and stay visible.
- **R10-4** Host processes must be decoupled from the Next server lifetime (tmux's one genuine advantage). Acceptable placements: codex app-server daemon (`daemon bootstrap` exists precisely for this), broker processes under the existing docker/systemd unit, or per-session child processes with restart-and-adopt on viewer boot (works today, verified; costs in-flight turns on viewer crash).
- **R10-5** An unanswered server→client approval **blocks the turn** (verified). The registry must guarantee an approval-owner is attached for every hosted session, and must surface "attention pending, no owner" as a first-class alarm state.
- **R10-6** Version columns: engine CLI version and (codex) `appServerVersion` per host — daemon/CLI skew observed live (0.135.0 vs 0.144.0); adapters gate features by capability checks.

### G4 — cross-process claims (durable state framework)

- **RG4-1** One **writer claim** per `SessionKey`: `send`/`interrupt`/`answer`/`release` require the claim; `attach` never does. Claim record: `{sessionKey, ownerId, epoch, leaseUntil, opLog[]}` with atomic acquire (O_EXCL/rename), renewal, and expiry-then-adopt. Two reconcilers racing must produce exactly one owner and one logical transition (program acceptance #2).
- **RG4-2** Every actuation carries the claim `epoch` as a fencing token; a holder that lost its lease must have its late writes refused by the claim store. Precedent inside the protocol itself: `turn/steer`'s required `expectedTurnId` ("fails when it does not match the currently active turn") — adopt the same CAS pattern one level up.
- **RG4-3** Operation records: persist `{opId (== idempotencyKey for sends), sessionKey, epoch, intent, result}` before actuating; crash between persist and ack is resolved by consulting engine state (codex: thread items by `clientId`; claude: broker ledger/transcript) — zero duplicate operations across restart (program crash-matrix #3).
- **RG4-4** 8898 (prod) and 8899 (dev) must not actuate the same sessions: claims live in the state dir (`LLV_STATE_DIR`-scoped); same store ⇒ claims arbitrate, different stores ⇒ hosts are invisible to each other — make the choice explicit in config.
- **RG4-5** Process-level operations (kill, health) must match `pid` **and** `procStart` from the claim/registry before acting — `~/.claude/sessions/<pid>.json` and the codex daemon both already record `procStart` for exactly this reason. Name-pattern kills are forbidden (a broad `pkill -f "codex app-server"` during this spike took down the machine's shared daemon; restored via `codex app-server daemon start`).

### #12 — durable outbound queue + delivery idempotency

- **R12-1** Queue entry id **is** the idempotency key, persisted before any attempt (queued → sending → delivered/failed with attempts + last error, per the issue).
- **R12-2** Codex delivery: pass the entry id as `clientUserMessageId` on `turn/start`/`turn/steer`. Confirmation is structural: the id comes back as `item.clientId` in `item/completed` and is persisted in the thread (verified round-trip). Retry rule: before re-sending, check thread items for the id — at-least-once send, exactly-once effect.
- **R12-3** Claude delivery: the broker appends `{entryId, sessionId, writtenAt}` to its ledger when the line enters stdin, and marks delivered when the corresponding `user` event (`--replay-user-messages`) / transcript record appears. Retry consults the ledger and transcript before any re-send.
- **R12-4** Routing by session state — this replaces `ensureDeliverable` screen-guessing: idle → `turn-started`; active turn → `steered` (codex, policy allowing) or `queued` (claude native queueing, verified). Interrupt-to-deliver is never implicit.
- **R12-5** `rejected/stale-turn` (codex CAS miss) → re-read state, retry once, then park the entry as attention. All entries editable/cancelable while not mid-flight (issue A.1) — the persisted queue makes the `sending` window the only lock.
- **R12-6** Where a human must act (pending approval), the entry parks with the structured attention item attached; "offer the tmux target" becomes "offer the attention card + optional TTY hatch".

### #31 — lifecycle, duplicates, reaping

- **R31-1** Lifecycle states come from owned structured events (`turn/started`/`turn/completed`, `thread/status/changed`, `result`, attention-pending), plus host `health()` — `waitingInput.ts` heuristics retire for hosted sessions.
- **R31-2** Duplicate definition sharpens: >1 live host/claim for one `SessionKey`. For viewer-owned hosts, G4 claims make duplicates impossible by construction; external duplicates (user-launched) are detected via `claude agents --json` (observed listing two pids on one sessionId) and `/proc`, and surfaced for collapse.
- **R31-3** Reaping is `release()` of an idle host process — the session artifact persists and `adopt()` restores it on demand (verified both engines), so conservative auto-close finally has a safety proof. Gates stay: no active turn, no pending attention, claim quiesced, no user focus on the session, quiet period elapsed. Dry-run first, per the issue.
- **R31-4** Kill/reap actuations follow RG4-5 (pid+procStart match only).
- **R31-5** Admission/reap policy inputs now include structured quota (`account/rateLimits/updated`, `rate_limit_event`) and `thread/tokenUsage/updated` — no more screen-scraped limit banners; this also feeds G3 (dispatcher) and #36 (burndown).

### Auth & accounts (#40 hook)

Codex app-server exposes `account/read`, `account/rateLimits/read`, `account/login/start`, `account/logout`, and pushes `account/rateLimits/updated {planType, primary/secondary windows, usedPercent, resetsAt}` per turn (observed). Claude emits `rate_limit_event` in-stream and `claude auth login` manages the OAuth credential. One runtime instance is bound to one account (`~/.codex/auth.json` is a single slot; `CODEX_HOME` selects the config dir, so account pools can run one app-server per `CODEX_HOME`). For #40's "switch Codex account when the 5h window empties": the switch trigger (structured limits) and the switch surface (login/logout RPCs or per-account `CODEX_HOME` hosts) both exist; wire them at the EngineHost layer, keyed off the same events R31-5 consumes.

### Human TTY escape hatch — verdict

Keep tmux as the **optional, human-only** hatch, spawned on demand (open a pane running `codex resume <threadId>` / `claude --resume <sessionId>`), with two honesty notes: interactive resume of a session whose host is live must first `release()` the host claim (otherwise it creates exactly the duplicate class #31 fights — enforce via G4), and the codex TUI fork-vs-attach question (unknown #2) decides whether the hatch is attach-in-place or release-then-takeover on that engine. The machine control plane never routes through tmux again; the pane-paste path (`src/lib/delivery.ts`, `tmux.ts` composer-verify) survives only inside the legacy tmux adapter until migration completes.

## Recommendation

Adopt the two-adapter plan exactly as the backlog program sequences it: **Codex first** (app-server child per session over stdio; move to daemon+`proxy`/`ws://` once unknowns 1–2 close) because attach/steer/interrupt/fencing/idempotency are native and verified; **Claude behind the broker** built to the same `EngineHost` seam, reusing the queue semantics this spike verified (queue-on-busy, interrupt survives, id-stable resume, `can_use_tool` routing via `--permission-prompt-tool stdio`). The registry (#10) records `SessionKey`-first rows with G4 claims from day one; #12 rides `clientUserMessageId`/broker-ledger; #31 reaps via `release()`+`adopt()`. tmux remains solely the human hatch.

## Appendix — exact probe commands

```bash
# Versions / auth (no secrets printed)
claude --version; codex --version; node --version
codex login status
jq -r '.auth_mode' ~/.codex/auth.json
jq -r '.claudeAiOauth.subscriptionType' ~/.claude/.credentials.json

# Codex protocol schema (source of the method/param evidence)
codex app-server generate-json-schema --out <dir>
codex app-server --help; codex app-server daemon --help; codex app-server proxy --help
codex app-server daemon version

# Codex baseline
codex exec --json --skip-git-repo-check -s read-only \
  -c model_reasoning_effort=low 'Reply with exactly: SPIKE-OK'

# Codex app-server scenarios (driver spawns `codex app-server` [--listen ws://127.0.0.1:8977])
node appserver-driver.mjs basic            # stdio: thread/start, turn/start, event stream, clientId round-trip
node appserver-driver.mjs multi            # ws: 2 clients, mid-turn thread/resume, turn/steer, turn/interrupt
node appserver-driver.mjs crash            # SIGKILL after turn; new process thread/resume + recall
node appserver-driver.mjs midcrash         # SIGKILL during deltas; resume + next turn
node appserver-driver.mjs approval         # approvalPolicy=untrusted; item/commandExecution/requestApproval → {decision:"accept"}
node appserver-driver.mjs basic gpt-5.6-luna   # model/list + per-thread/turn model override

# Claude stream-json scenarios (driver spawns `claude -p --input-format stream-json --output-format stream-json --verbose --model haiku`)
node claude-driver.mjs single              # + --include-partial-messages --replay-user-messages; init/result fields
node claude-driver.mjs multiturn           # one process, two turns, same session_id
node claude-driver.mjs inject              # mid-turn user message → queued as next turn
node claude-driver.mjs interrupt           # control_request interrupt → error_during_execution; session survives
node claude-driver.mjs resume && node claude-driver.mjs resume phase2   # SIGKILL; --resume keeps session_id
node claude-driver.mjs permission          # + --permission-prompt-tool stdio → can_use_tool round-trip

# Claude native surfaces (read-only)
claude agents --json
cat ~/.claude/daemon.status.json; ls ~/.claude/daemon ~/.claude/sessions
grep -aoE '"(interrupt|can_use_tool|set_permission_mode|set_model|hook_callback|mcp_message|rewind_conversation)"' \
  "$(dirname "$(readlink -f "$(which claude)")")/claude.exe" | sort | uniq -c
```

Probe drivers and raw JSONL logs live in the session scratchpad (`probes/appserver-driver.mjs`, `probes/claude-driver.mjs`, `probes/logs/*.log`); they are throwaway spike tooling and stay out of the repo.
