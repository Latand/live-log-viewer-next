# WakaTime activity integration (issue #473)

- Status: implementation-ready
- Grounded base: `origin/main` at `7df59ef07f2f9f8c30db24628af20d7ea1ed34fb`
- Issue: <https://github.com/Latand/live-log-viewer-next/issues/473>

## Decision

Agent Log Viewer will send API-key-authenticated Heartbeats directly from its
Node process. A server-owned scheduler samples scanner-derived turn windows,
materializes deterministic per-turn heartbeat streams into a durable local
outbox, and drains one bulk request per scheduler tick.

The implementation lives in one deep module at `src/lib/wakatime/sync.ts`.
Production callers learn one interface:

```ts
startWakatimeSync(): void
```

The module owns credential lookup, registry joins, mapping, sampling,
coalescing, outbox persistence, batching, delivery, backoff, diagnostics, and
timer lifecycle. Browser code, API routes, scanner request paths, and agent
execution never call WakaTime.

Activation requires `LLV_WAKATIME_ENABLED=1`. The default runtime creates no
timer, state file, or outbound request.

## Why Heartbeats are the MVP ingestion surface

WakaTime's current documentation says External Durations can be created only
by OAuth apps. Their `external_id` update semantics fit completed viewer turns
well, though a usable implementation would also need a registered WakaTime
OAuth app, authorization flow, token refresh, revocation, and integration
disconnect lifecycle. Agent Log Viewer has none of those ownership surfaces.

Heartbeats accept the operator's personal API key through HTTP Basic
authentication and support `type: "app"`, `category: "ai coding"`,
`ai_session`, project, language, and fractional Unix timestamps. The bulk
endpoint accepts 25 records. This is the documented path available to a local
single-user tool with API-key setup.

The alternatives resolve as follows:

| option | result | reason |
|---|---|---|
| External Durations with a personal API key | rejected | Current WakaTime documentation reserves creation for OAuth apps. |
| External Durations with OAuth | deferred | Requires product-level identity, consent, refresh, revocation, and disconnect ownership. |
| `wakatime-cli` child processes | rejected | Adds binary installation and opaque offline state while still using heartbeat semantics. |
| Direct Heartbeats | selected | Uses the existing Node outbound-call pattern, supports API-key setup, and remains fully testable through injected dependencies. |

Primary references:

- <https://wakatime.com/developers#heartbeats>
- <https://wakatime.com/developers#external-durations>
- <https://wakatime.com/help/creating-plugin>
- <https://github.com/wakatime/wakatime-cli/blob/develop/USAGE.md>

The protocol choice stays private to the WakaTime module. A future OAuth-backed
External Duration adapter can retain `startWakatimeSync()` and replace the
internal mapping and transport.

## Existing ownership seams on the pinned base

The implementation must reuse these authorities:

| concern | current authority | integration use |
|---|---|---|
| Completed scanner generation | `currentFileScan()` in `src/lib/scanner/scanCache.ts` | Joins or starts the shared generation; avoids a second independent filesystem scanner. |
| Turn classification | `src/lib/scanner/turnDuration.ts` | Supplies prompt-to-terminal windows for Claude and Codex, including interrupts, errors, steering, SDK prompts, and metadata exclusions. |
| Stable conversation identity | `agentRegistry().readOnlySnapshot()` plus `conversationLookupFromSnapshot()` | Resolves a scanned current-generation path to the durable `conversationId`. |
| Project attribution | `resolveProjectAttribution()` in `src/lib/session/projectResolution.ts` | Preserves explicit ownership, canonical worktree-to-parent grouping, launch-profile hints, and scanner fallback in their current order. |
| Runtime activation | `registerViewerRuntime()` in `src/lib/viewerInstrumentation.ts` | Starts the singleton only in the traffic-owning Node release. |
| App config and state paths | `configFilePath()` and `statePath()` in `src/lib/configDir.ts` | Keeps the key and outbox under Agent Log Viewer's config root with legacy path fallback. |
| Atomic state pattern | `src/lib/reaperRuntime.ts` | Uses a `0600` temporary sibling followed by rename inside a `0700` directory. |

`FileEntry.conversationId` is a response projection on this base. Raw scanner
snapshots can lack it. The WakaTime module must perform the read-only registry
join and accept only the latest generation path for each conversation. This
also prevents archived account-migration generations from producing a second
stream.

## Module interface and internal seams

`src/lib/wakatime/sync.ts` exports `startWakatimeSync()`. It also exports a
factory used by focused tests:

```ts
interface WakatimeSync {
  tick(): Promise<void>;
  stop(): void;
}

function createWakatimeSync(deps: WakatimeSyncDependencies): WakatimeSync;
```

The factory is an internal test seam. Its dependencies are:

- `scan(): Promise<FileScanSnapshot>` backed by `currentFileScan()`;
- `registrySnapshot()` backed by `agentRegistry().readOnlySnapshot()`;
- `recentTurnWindows(entry)` backed by the scanner helper described below;
- `fetch`, `now`, `random`, `scheduleInterval`, and `scheduleTimeout`;
- `readCredential`, `readState`, `writeState`, and a sanitized logger.

Production assembly stays inside `sync.ts`. Tests inject memory adapters and a
fake fetch. The remote WakaTime dependency therefore has two adapters at its
seam: Node `fetch` in production and the fake transport in tests.

No WakaTime request or response type leaves this module.

## Event source

### Scheduler

`startWakatimeSync()` uses a `globalThis.__llvWakatimeSync` singleton guard. It
schedules an initial deferred tick and a 60-second interval. Both timers call
`.unref?.()`. A single-flight fence permits one running tick and at most one
trailing tick, matching the account controller's overlap discipline.

Each tick requests `currentFileScan()`. That function owns generation
coalescing and waits for a completed current snapshot. Browser polling can
share the same scan generation, while a browser-free process still receives a
server-owned refresh every minute.

Scan, state, credential, and network failures end the WakaTime tick locally.
They never propagate into the scanner cache, `/api/files`, an agent host, or a
request handler.

### Multi-turn enumeration

`FileEntry.lastTurn` carries only the newest window. A minute can contain
several short turns, so polling that field alone can erase earlier completed
work.

Implementation must deepen `src/lib/scanner/turnDuration.ts` with one internal
scanner interface:

```ts
interface RecentTurnWindows {
  windows: TurnBoundary[];
  prefixTruncated: boolean;
  complete: boolean;
}

recentTurnWindowsFor(entry: FileEntry): RecentTurnWindows
```

The existing record state machine becomes a multi-window parser. It accumulates
every initiator-to-terminal window in the existing 128 KiB transcript tail,
including the final open window. `lastTurnFromRecords()` returns the final item
from that shared parser, preserving the UI contract and all issue #268/#406
semantics.

`prefixTruncated` comes from the tail read offset. A truncated prefix can omit
old windows after a long outage or an unusually large turn. The sync module
records a `history_gap` counter and starts at the first complete visible
window. It never invents timestamps. Continuous one-minute observation and the
durable per-stream cursor cover the normal runtime and restart path.

Eligible entries satisfy every condition below:

1. engine is `claude` or `codex`;
2. root is a conversation root and the path ends in `.jsonl`;
3. scanner derivation completed;
4. the registry resolves the path to a conversation;
5. the path equals that conversation's latest generation path;
6. the turn window has a finite positive start and a finite end when closed.

Unregistered, incomplete, shell, task-output, archived-generation, malformed,
and zero-length windows are skipped with counters only. A later tick can pick
up an entry after registry adoption or complete derivation.

## WakaTime field mapping

One scanner turn becomes one stable heartbeat stream.

| WakaTime field | value | rule |
|---|---|---|
| `entity` | `agent-log-viewer/<engine>/<turnDigest[0..15]>` | Opaque and stable for active samples across restart or transcript path rotation. End boundaries use `agent-log-viewer/boundary/<turnDigest[0..15]>`. |
| `type` | `app` | The viewer observes an agent application session. It has no focused source file. |
| `project` | canonical project string | Resolve with conversation ownership, latest launch-profile cwd/project, and `FileEntry.project` fallback through `resolveProjectAttribution()`. Freeze the result on first stream observation. |
| `category` | `ai coding` | Exact documented category for agent work. |
| `language` | omitted | The viewer has no source-file language authority. |
| `branch` | omitted | `FileEntry.worktree` is a worktree label and carries no branch guarantee. |
| `time` | sample timestamp divided by 1000 | Fractional Unix seconds from scanner timestamps and the injected clock. |
| `ai_session` | full `turnDigest` | Stable opaque AI-session correlation without a transcript path or raw conversation id. |
| `is_write` | omitted | A completed agent turn does not prove a file save. |

The digest is:

```text
sha256("llv-wakatime-v1\0" + conversationId + "\0" + startedAtMs)
```

The local outbox event key is:

```text
sha256("llv-wakatime-heartbeat-v1\0" + turnDigest + "\0" + sampleTimeMs)
sha256("llv-wakatime-boundary-v1\0" + turnDigest + "\0" + boundaryTimeMs)
```

Titles, prompts, transcript paths, cwd values, model names, account ids, and
file contents never enter a WakaTime payload.

## Active and idle clock

The first persisted state records `enabledAtMs`. This timestamp is the privacy
and backfill boundary.

For each turn:

```text
effectiveStart = max(turn.startedAt, enabledAtMs)
effectiveEnd   = turn.endedAt ?? now
```

The module materializes heartbeats at:

1. `effectiveStart`;
2. every 120 seconds anchored to `effectiveStart` while work remains active;
3. the exact `endedAt` for a closed turn when it differs from the latest sample.

The 120-second interval matches WakaTime's documented plugin convention. A
short closed turn receives its active start and exact boundary marker. A long
turn receives enough interior samples to stay below WakaTime's default
15-minute join threshold.

An open turn accrues samples through the current clock only while a live process
and non-idle runtime state remain authoritative. A closed or frozen interval
receives a marker under the reserved `agent-log-viewer-boundary` project.
WakaTime's duration algorithm assigns the following sub-timeout gap to that
reserved project, keeping the canonical project limited to the active span.
Overlapping turns in one canonical project suppress interior boundaries and
contribute their wall-clock union.

Completed windows ending before `enabledAtMs` stay local and unsent. A turn
that crosses the enable boundary starts at `enabledAtMs`. This makes the first
opt-in forward-looking and prevents surprise history upload.

## Coalescing and duplicate behavior

The state stores `lastMaterializedAtMs` per turn digest. Repeated scans of the
same open or closed window generate only newly due samples. Pending event keys
form a unique set, so repeated ticks and registry path rotation coalesce before
delivery.

After a successful bulk response, the module removes the acknowledged events
through an atomic state write. Restarted processes resume from stream cursors
and the pending outbox.

The Heartbeats endpoint exposes no documented idempotency key. The delivery
contract is at-least-once across the narrow crash window between WakaTime's 2xx
response and the local acknowledgment write. A crash there can replay at most
the in-flight batch of 25 records. Every other restart path coalesces locally.
This limitation must appear in `docs/wakatime.md` and the PR description.

## Durable outbox and backpressure

State lives at `statePath("wakatime-state.json")`:

```ts
interface WakatimeStateV1 {
  version: 1;
  enabledAtMs: number;
  streams: Record<string, {
    entity: string;
    engine: "claude" | "codex";
    project: string;
    startedAtMs: number;
    endedAtMs: number | null;
    lastMaterializedAtMs: number;
    lastObservedAtMs: number;
  }>;
  pending: Array<{
    key: string;
    stream: string;
    kind: "activity" | "boundary";
    createdAtMs: number;
    heartbeat: WakatimeHeartbeat;
  }>;
  retry: {
    failures: number;
    retryAtMs: number;
    reason: "network" | "timeout" | "rate_limit" | "server" | "auth" | null;
  };
  counters: {
    accepted: number;
    permanentlyRejected: number;
    compacted: number;
    dropped: number;
    historyGaps: number;
  };
}
```

The file contains no credential, authorization header, raw conversation id,
transcript path, cwd, title, prompt, response body, or file content. Project
names are present because they are payload data awaiting delivery. The file is
written with mode `0600`; its parent directory uses `0700`.

Persistence ordering is strict:

1. merge newly observed samples into memory;
2. atomically persist the outbox;
3. send the oldest batch;
4. validate the ordered item results from an outer `201`/`202` response;
5. atomically persist each accepted/permanently rejected item and every retry state.

A failure in step 2 suppresses network delivery for that tick. This prevents
an untracked successful request.

Bounds:

- maximum pending events: 10,000;
- maximum retained streams: 5,000;
- delivered closed-stream retention: 30 days;
- bulk request size: 25;
- bulk requests per tick: one.

At the pending limit, compact each stream while preserving its first sample,
exact final sample, newest sample, and interior samples no farther than ten
minutes apart. If the compacted set still exceeds the limit, evict the oldest
whole streams until the bound holds. Increment `compacted` and `dropped` and
emit one rate-limited count-only diagnostic. Scanning and agent work always
continue.

A missing or corrupt state file creates version 1 with `enabledAtMs = now`.
Corrupt-state recovery starts a forward-looking baseline, records a sanitized
diagnostic, and avoids historical replay. Pending records in an unreadable
file can be lost; the operator documentation must identify state-file backup as
the recovery mechanism for that rare case.

## Delivery, retry, and rate limits

Endpoint:

```text
POST https://api.wakatime.com/api/v1/users/current/heartbeats.bulk
```

Request properties:

- `Authorization: Basic <base64(apiKey)>`;
- `Content-Type: application/json`;
- `User-Agent: agent-log-viewer-wakatime/1`;
- `redirect: "manual"` so a WakaTime 302 rate-limit response stays observable;
- five-second abort deadline;
- body is an array of at most 25 validated heartbeat objects.

For outer `201` and `202` responses, the module validates the ordered
`responses` array and classifies every item. Missing, malformed, or
cardinality-mismatched responses retain the entire batch. Response bodies and
item error details never enter state or diagnostics.

Failure policy:

| outcome | action |
|---|---|
| missing key | retain outbox, skip fetch, emit one transition diagnostic |
| timeout or network error | retain batch; exponential retry |
| `302` or `429` | retain batch; honor valid `Retry-After`; exponential retry |
| `500`-`599` | retain batch; exponential retry |
| `401` or `403` | retain batch; open a 15-minute auth circuit; retry immediately after a key-file source stamp changes |
| `400` or another permanent `4xx` | remove the validated attempted batch, increment `permanentlyRejected`, and emit status plus count |

Retry delay starts at 30 seconds, doubles with 20 percent jitter, and caps at
15 minutes. A valid `Retry-After` can extend the delay up to 24 hours. Success
resets the failure count. Retry state is durable, so a restart cannot create a
tight loop.

One request per 60-second tick yields roughly 0.017 requests per second during
backlog drain, far below WakaTime's documented average ceiling of 10 requests
per second over five minutes.

## Startup and shutdown lifecycle

`registerViewerRuntime()` adds this block inside
`activateViewerRuntimeWhenCurrent()`:

```ts
if (process.env.LLV_WAKATIME_ENABLED === "1") {
  const { startWakatimeSync } = await import("@/lib/wakatime/sync");
  startWakatimeSync();
}
```

The dynamic import preserves the Node builtin isolation required by
`src/instrumentation.ts`. Release candidates wait for traffic ownership before
starting, so blue-green overlap cannot create two active schedulers against the
shared state directory.

The module installs no process signal handlers. The CLI and deployment runtime
retain process ownership. Unref'd timers allow immediate process exit; the
five-second request deadline bounds an in-flight call. Every outbound event was
persisted before fetch, so restart resumes it. The documented 25-event replay
window covers termination after remote acceptance.

`stop()` clears module-owned timers and aborts an in-flight test transport. It
exists for deterministic tests and module replacement during development.

## Configuration and secret handling

| setting | precedence and effect |
|---|---|
| `LLV_WAKATIME_ENABLED=1` | Process-start opt-in. Any other value leaves the module unloaded. |
| `WAKATIME_API_KEY` | Highest-priority credential, synchronously captured into integration-owned memory and removed from the ambient environment. |
| `~/.config/agent-log-viewer/wakatime-api-key` | File fallback through `configFilePath("wakatime-api-key")`; the legacy app config path remains available through the existing resolver. |

The key file is read at delivery time, so a drop-in or replacement can recover
an auth circuit without restarting the viewer. A replacement environment value
installed in the running server is captured and removed on the next tick.

The implementation never reads `~/.wakatime.cfg`. That file belongs to
WakaTime's CLI and editor plugins. The MVP also has a fixed HTTPS origin.
`LLV_WAKATIME_API_URL`, per-project keys, proxy configuration, and self-hosted
servers stay outside scope because each expands the credential-exfiltration
surface.

Secret invariants:

- Authorization is an in-memory request header only.
- URLs never contain keys or tokens.
- Logger arguments carry outcome class, HTTP status, retry time, and counts.
- Response bodies are parsed only for item status validation and stay absent from diagnostics and state.
- State and journal payloads contain no secret or secret-derived fingerprint.
- Browser DTOs, HTML, React state, and API responses remain unchanged.
- Test fixtures use obvious placeholders and assert their absence from state,
  logs, request body, and URLs.
- `bun run privacy:check` remains unchanged and must pass on the PR head.

Operator setup documentation should create the key file with mode `0600` and
explain that project names, opaque per-turn entities, category, engine marker,
and timestamps leave the machine after opt-in.

## Observability

The MVP has no visual status surface and no manual sync route. Safe operation
requires these count-only server diagnostics:

- startup enabled, including credential presence as a boolean;
- first transition into missing-key, auth, rate-limit, network, or server
  backoff;
- recovery from a prior failure class;
- queue compaction or drop counts;
- corrupt-state recovery and transcript-tail history-gap counts.

Repeated identical failures are suppressed until status changes or one hour
passes. Logs use the `[wakatime]` prefix and contain no project, entity,
conversation, path, title, credential, request body, or response body.

The durable state counters provide local evidence without a browser endpoint.
Operator verification uses the WakaTime dashboard as the primary path. The
setup guide may also show an authenticated `GET /heartbeats` check whose
credential travels through stdin-backed curl config or an equivalent process-
argument-safe mechanism.

## Test seams and required behavioral coverage

### Scanner tests

Extend `src/lib/scanner/turnDuration.test.ts`:

1. multi-turn parsing returns every completed Claude and Codex window;
2. steering, tool results, metadata, interrupts, API errors, and lifecycle
   completion retain existing boundaries;
3. `lastTurnFromRecords()` remains the final-window projection;
4. a truncated prefix never fabricates a start;
5. the final open window is present with `endedAt: null`.

### WakaTime module tests

Create `src/lib/wakatime/sync.test.ts` with injected clocks, memory state, fake
scans, registry fixtures, timers, logs, and fetch:

1. disabled startup creates no timer, state, or request;
2. missing credential materializes durable work and skips fetch;
3. canonical project attribution and current-generation registry identity feed
   the exact heartbeat fields;
4. language, branch, titles, paths, cwd, prompts, and contents stay absent;
5. a short closed turn produces an active start and an exact project-boundary marker;
6. a long/open turn produces deterministic 120-second samples and no repeats
   across ticks;
7. neighboring turns preserve their idle gap under WakaTime's published duration algorithm, and overlapping turns use wall-clock union semantics;
8. path rotation with the same conversation and start reuses the stream digest;
9. several turns between scans all reach the outbox;
10. the first enable boundary suppresses completed history and truncates a
    crossing turn;
11. pending state persists before fetch; a failed state write suppresses fetch;
12. outer 201/202 responses acknowledge successful items, retain transient items, reject permanent items, and fail closed on malformed or mismatched arrays;
13. timeout, network, 302, 429, 5xx, 401, and 403 retain the batch and set the
    expected durable retry state;
14. permanent 4xx removes the attempted validated batch and increments its
    counter;
15. corrupt state starts a current-time baseline without throwing;
16. overflow compaction respects bounds and endpoint retention rules;
17. single-flight ticks produce one running fetch and one trailing cycle;
18. the placeholder key appears only in the Authorization header supplied to
    fake fetch and never in logs, state, URL, body, child environments,
    arguments, transcripts, or artifacts;
19. open turns freeze across abrupt exit, stale transcript, idle composer, and
    restart, while a live silent tool call continues accruing.

### Bootstrap tests

Extend `src/instrumentation.test.ts` or add a focused viewer-instrumentation
test proving:

- the module starts only for `LLV_WAKATIME_ENABLED=1`;
- traffic ownership gates startup;
- repeated registration keeps one singleton;
- timer handles are unref'd.

### Implementation verification

Run on the implementation head:

```bash
bun test src/lib/scanner/turnDuration.test.ts src/lib/wakatime/sync.test.ts src/instrumentation.test.ts
bun test
bunx tsc --noEmit
bun run lint
bun run privacy:check
bun run build
```

Tests never contact WakaTime and never use a real credential.

## Documentation changes

Implementation includes:

1. `docs/wakatime.md` with setup, data disclosure, key-file permissions,
   forward-only first enable, disablement, dashboard verification, retry
   behavior, state backup, and the 25-event crash replay limitation;
2. `ARCHITECTURE.md` environment-contract rows for
   `LLV_WAKATIME_ENABLED` and `WAKATIME_API_KEY`/key-file fallback;
3. an update to the architecture's external-service constraint describing
   local filesystem authority plus explicit opt-in outbound integrations;
4. the non-draft PR description with `Closes #473`, verification evidence,
   privacy behavior, heartbeat duplicate limitation, and deferred OAuth scope.

Disablement requires unsetting `LLV_WAKATIME_ENABLED` and restarting the
viewer. The key may remain for later reuse or be removed by the operator. The
outbox remains local and dormant while disabled.

## Rollout

1. Land the deep module, scanner enumeration, bootstrap wiring, tests, and
   operator docs behind the disabled default.
2. Dogfood with a placeholder-free local key on one operator machine. Confirm
   one short turn, one turn longer than two minutes, one idle gap, one restart,
   and one simulated network outage in the WakaTime dashboard and local
   count-only diagnostics.
3. Run the full verification stack on the PR head.
4. Publish a non-draft PR that closes issue #473.
5. Run at most two independent review rounds, applying additive repair commits
   when required.

No migration runs for disabled operators. State schema changes after v1 require
an explicit versioned reader and forward migration inside `sync.ts`.

## Explicit MVP scope

Included:

- Claude and Codex conversation turns with stable registry identity;
- active and completed turn heartbeat sampling;
- canonical parent-project attribution across worktrees;
- API-key Basic authentication;
- durable bounded outbox, batching, backoff, and restart recovery;
- server diagnostics, behavioral tests, setup, disablement, and verification
  documentation.

Deferred:

- WakaTime OAuth registration and token lifecycle;
- External Durations and their `external_id` update semantics;
- full historical backfill beyond the retained scanner tail;
- source-language inference, branch inference, dependencies, line counts, token
  counts, and AI line-change fields;
- per-project credentials, custom API origins, proxies, and self-hosted servers;
- visual status, manual sync, queue inspection, and browser configuration;
- deletion synchronization from Agent Log Viewer into WakaTime.

## Acceptance traceability

| issue #473 criterion | design closure |
|---|---|
| Stable project, entity, language/category, and time semantics | Canonical project attribution, digest-scoped per-turn app entities, a reserved boundary project, omitted unsupported language, `ai coding`, deterministic sampling, and same-project overlap union. |
| Credential privacy | Server-owned env capture, child-environment isolation, key-file lookup, header-only Basic auth, fixed HTTPS endpoint, secret-free state/logs/tests/browser surfaces, and the unchanged privacy gate. |
| Duplicate, restart, idle, failure, retry, batching, and rate-limit behavior | Durable stream cursors and outbox, explicit 25-event crash replay window, liveness-frozen open turns, itemized bulk acknowledgments, failure matrix, one 25-record batch per tick, and durable jittered backoff. |
| Viewer responsiveness during WakaTime failure | Traffic-owned unref'd scheduler, shared scan generations, single-flight ticks, five-second fetch deadline, bounded outbox, and swallowed module-local failures. |
| Focused behavioral tests and operator documentation | Scanner, sync, bootstrap, privacy, retry, and overflow coverage plus `docs/wakatime.md` and environment-contract updates. |
| Current architecture and runtime ownership | Exact `7df59ef0` grounding, scanner-owned turn semantics, registry-owned identity, project-resolution authority, current-file-scan seam, and viewer-instrumentation startup. |
| Non-draft PR and two-round review cap | Rollout requires `Closes #473`, the full gate evidence, a ready PR, and at most two independent review rounds. |

## Implementation handoff

The implementation stage has these fixed choices:

1. Refactor `turnDuration.ts` around a shared multi-window parser and expose
   `recentTurnWindowsFor()`; keep `FileEntry.lastTurn` behavior byte-compatible.
2. Add `src/lib/wakatime/sync.ts` as the sole WakaTime knowledge owner with
   `startWakatimeSync()` and the injected test factory.
3. Drive it every 60 seconds through `currentFileScan()`, then join current
   paths to `agentRegistry().readOnlySnapshot()` and resolve projects through
   `resolveProjectAttribution()`.
4. Map each turn to a digest-scoped `app` entity, `ai coding`, canonical
   project, `ai_session`, 120-second samples, and exact reserved-project boundaries.
5. Persist before delivery, batch 25, send one request per tick, and use the
   retry table above.
6. Wire the dynamic opt-in import inside traffic-owned viewer instrumentation.
7. Add focused scanner, sync, bootstrap, privacy, and overflow tests plus
   `docs/wakatime.md` and environment-contract updates.
8. Run the listed gates, publish the non-draft `Closes #473` PR, and stop after
   two review rounds.

No architectural choice remains for implementation.
