# Orchestrator rotation handoff compaction — issue #1067

Design for bounding the successor mandate on `rotate_orchestrator` so a
designation can never outgrow the structured envelope, with a headless
summarizer for prior handoffs, a deterministic fallback, a size preflight
before any durable intent exists, and a verified terminal state for a failed
designation. Grounded in the code as of `main` at `ce38c64e` (2026-08-26).

## Originating requirement (verbatim)

Source: GitHub issue #1067, opened 2026-08-21 (identity-free as filed).

> ## Incident (2026-08-21)
>
> A project's manager seat accumulated ten stacked "Handoff from your
> predecessor" sections across successive rotations: core mandate ~4.5k chars,
> full mandate 29.5k. The next rotation intent carried a 30.5k-char mandate;
> its structured designation message exceeded the 32000-byte envelope bound
> and failed with "structured message text exceeds the 32000-byte envelope
> bound". The intent then sat in `pendingIntent.state: "pending"` indefinitely
> — successor conversation never spawned, incumbent kept its seat, and the card
> showed a permanent red "The last designation failed" banner.
>
> ## Mechanism
>
> 1. `rotate_orchestrator` defaults the successor mandate to the incumbent's
>    current mandate, and each rotation appends a new handoff section. Mandate
>    size grows monotonically — every seat eventually crosses any fixed
>    envelope bound.
> 2. A designation whose text exceeds the envelope fails delivery, but the
>    intent stays pending forever; there is no size preflight, no automatic
>    trim, and no expiry/rollback of the failed intent.
> 3. Agents cannot repair this state: rotation is operator-only, and there is
>    no operator surface to edit the mandate down or cancel the pending intent
>    (observed on the current sidebar rotate flow).
>
> ## Fix direction
>
> - Preflight the designation size at intent creation and refuse with an
>   actionable error instead of creating an undeliverable pending intent.
> - Bound handoff accumulation: keep the core mandate + the latest N handoffs
>   (or summarize older ones) when defaulting the successor mandate.
> - Give a failed designation a terminal state with a retry/edit path rather
>   than leaving `pending` + a dead banner.

The pipeline specification (2026-08-26) sharpens this into eight acceptance
criteria: single "Rotation history" section, headless Codex summarization on
`CODEX_LUNA_MODEL` via the `src/lib/flows/exec.ts` runner with a ~4 KB digest,
deterministic N=2 fallback, envelope preflight before intent creation, terminal
failed intent cleared by the next rotate/create, tests in
`seatCommand.test.ts` under isolated state, identity-free public artifacts, and
green gates. Section 9 validates the final design against both.

## 1. What the code does today

Every claim below is anchored to a current line.

**Rotation stacks handoffs verbatim.** `executeOrchestratorRotation`
(`src/lib/orchestrator/seatCommand.ts:537-607`) builds one handoff block whose
heading is the literal `## Handoff from your predecessor (rotation)` (line 565),
takes `baseMandate = text(rawBody.mandate) || incumbent.mandate` (line 576) and
submits `mandate: \`${baseMandate}\n\n${handoff}\`` (line 579). The successor's
stored `seat.mandate` is that whole string (`seats.ts:323`), so the next
rotation's base already carries every previous handoff. Caps on the fresh
block: `HANDOFF_TASK_CAP = 12`, `HANDOFF_TASK_TEXT_CAP = 140`,
`HANDOFF_NOTES_CAP = 2_000` (lines 517-519). Measured extremes of one block:
562 bytes with no tasks and no notes, about 4 753 bytes with 12 full-length
tasks and 2 000 bytes of notes.

**The desktop rotate draft posts the stacked mandate explicitly.**
`RotateDraft` prefills its textarea from `seat.mandate`
(`src/components/orchestrator/OrchestratorPanel.tsx`, state initializer
`readField("Rotate", project, "mandate") || seat.mandate`) and submits it as
`mandate`. So `text(rawBody.mandate)` is usually non-empty and already
contains the stacked sections — any compaction must split on section markers
regardless of whether the base came from the request or from the store.

**Two size checks disagree.** The seat command refuses a mandate over
`MANDATE_MAX_BYTES = 64_000` (`seatCommand.ts:210, 334-336`). Delivery is
bounded by `MAX_STRUCTURED_TEXT_BYTES = 32_000`
(`src/lib/runtime/structuredContent.ts:40`), asserted in three places:

- spawn mode: `src/lib/agent/spawnCommand.ts:244-275` composes
  `prompt = [role.scaffold, userPrompt].join("\n\n")` and calls
  `assertStructuredTextEnvelope(prompt)` before the durable receipt, answering
  413. The orchestrator scaffold for `roleParams.mode = "standard"` measures
  768 bytes (`resolveSpawnRole`, `src/lib/roles/registry.ts:153`).
- existing mode: `src/lib/runtime/structuredMessageDelivery.ts:264, 576`
  assert on the delivered text itself; no scaffold.
- `orchestratorMandateForDelivery` (`src/lib/orchestrator/prompt.ts:104-108`)
  appends `ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE` (692 bytes) when the mandate
  lacks it; the current default `ORCHESTRATOR_SYSTEM_PROMPT` (8 325 bytes,
  v9) already contains it.

A 30.5 KB mandate therefore passes the 64 KB API check and dies at the
32 000-byte envelope, exactly as the incident describes.

**The intent store already has a terminal marker.** `failOrchestratorSeatIntent`
records `intent.error` on the pending row (`src/lib/orchestrator/seats.ts:396-403`).
`beginOrchestratorSeatIntent` treats a pending row with `intent.error !== null`
(or an epoch below the active seat) as abandoned, moves it into the bounded
`history` (`ORCHESTRATOR_SEAT_HISTORY_CAP = 50`) and proceeds (lines 303-317,
landed with #878 on 2026-08-04). The panel derives the red banner from
`pending.intent.error` (`src/components/orchestrator/seatState.ts:185-216`);
the banner disappears the moment the row leaves `pending`. Both seat-command
failure paths record the error: existing-mode delivery failure
(`seatCommand.ts:399-413`) and spawn-mode rejection (lines 489-498). The
envelope assertion in spawn mode is synchronous and pre-receipt, so an
oversized mandate always takes the recorded-error path, never the 202 path.

What actually kept the incident "pending forever" is therefore two things:
the row's `state` field still says `"pending"` (the terminal marker is
`intent.error`, invisible in that field), and every retry recomposed the same
oversized mandate and failed at the same assertion — the store was ready to
terminalize, but nothing ever produced a deliverable successor. Compaction
plus preflight remove the second; section 6 makes the first explicit and
tested without a schema change.

**The headless runner.** `src/lib/flows/exec.ts`:

- `reviewerCommand` (lines 269-322) builds the Codex command:
  `codex [-c cli_auth_credentials_store=file] --disable multi_agent exec
  --ignore-user-config - --json --output-last-message <file>
  --dangerously-bypass-approvals-and-sandbox [-m <model>]
  [-c model_reasoning_effort=<effort>]`, prompt on stdin (fenced by
  `fenceViewerSpawnPrompt`), env from the account's `CODEX_HOME` with the
  WakaTime credential and `LLV_TOKEN` removed. `--ignore-user-config` means
  no user MCP server table is loaded and `--disable multi_agent` keeps the
  run single-agent — "mcp_servers empty" is already the shape of this command.
- `startHeadlessReview` (lines 324-399) spawns it `detached: true` with
  file-backed stdout/stderr under `statePath("flows")/<flowId>/round-N-*`,
  arms a timeout that calls `killOwnedRun` → `terminateHeadlessReviewerGroup`
  (SIGTERM the process group, SIGKILL after 3 s; lines 124-152, 214-223),
  records the run in an in-memory `runs` map keyed `flowId:round`, and on
  `close`/`error` kills the group again and signals `requestPipelineTick`.
- `scanEventStream` (lines 251-267) extracts the session id and last
  `agent_message` from the `--json` stream; `headlessReviewStatus`
  (lines 428-482) treats a populated `--output-last-message` artifact as the
  conclusive "done" signal.
- Account selection for headless runs lives outside exec.ts:
  `prepareReviewerLaunch` (`src/lib/flows/engine.ts:637-660`) →
  `chooseHeadlessReviewer` (`src/lib/flows/reviewerPolicy.ts:17-45`) →
  `accountManager.resolveHeadlessSpawn` (`src/lib/accounts/manager.ts:155-161`)
  → `selectHeadlessAccount` (`src/lib/accounts/headlessSelection.ts:44-71`),
  which answers `available | exhausted | unavailable` from the registry's
  fresh (≤ 5 min) quota observations without any network call.
- The headless reaper (`src/lib/headlessProcessReaper.ts:214-235`) only ever
  signals stale `codex exec` processes it can tie to a flow round; any other
  Codex owner is skipped. A one-shot summarizer is bounded by its own timer
  and by Codex exiting at the end of its turn; the reaper plays no part.
- The installed CLI (`codex-cli 0.149.1`) accepts `-s/--sandbox
  <read-only|…>`, `--skip-git-repo-check`, `--ignore-user-config`, `-m`,
  `--json`, `-o/--output-last-message`.

`CODEX_LUNA_MODEL = "gpt-5.6-luna"` (`src/lib/agent/models.ts:13`) is the
catalog's general-purpose Codex profile.

**A bounded transcript tail reader already exists.** `tailMessages` in
`src/lib/view/compactText.ts` reads the last 1 MiB of a transcript through an
`O_NOFOLLOW` descriptor with an identity check and yields
`{role, at, text}` rows for both engines (Claude `type: "assistant"` rows with
`message.content` text parts; Codex `payload.type: "agent_message"` rows).
It is module-private and takes a `FileEntry`. `hardenedRedact` in the same
file strips secrets from text.

## 2. Successor mandate composition (AC 1)

All constants live in `src/lib/orchestrator/handoffDigest.ts` (new) and are
imported by `seatCommand.ts`.

```ts
export const HANDOFF_HEADING = "## Handoff from your predecessor (rotation)"; // existing literal, moved
export const HISTORY_HEADING = "## Rotation history";
export const HISTORY_BUDGET_BYTES = 4_096;      // digest and fallback share it
export const FALLBACK_HANDOFF_COUNT = 2;        // AC 3, N=2
export const PREDECESSOR_REPORT_CAP_BYTES = 6_000;
export const SUMMARY_INPUT_CAP_BYTES = 48_000;
export const HANDOFF_DIGEST_TIMEOUT_MS = 75_000;
```

### 2.1 Split

```ts
export interface SplitMandate { core: string; history: string | null; handoffs: string[] }
export function splitMandate(mandate: string): SplitMandate
```

A section boundary is a line that equals `HISTORY_HEADING` or
`HANDOFF_HEADING` exactly (`^## …$`, multiline). `core` is everything before
the first boundary, `trimEnd()`-ed. Each following section runs to the next
boundary. At most one history section is expected; if a malformed mandate
carries several, they are concatenated in order into `history`. `handoffs`
keeps each handoff body (heading line removed) oldest first. A mandate with no
boundary returns `{core: mandate, history: null, handoffs: []}`. The split is
applied to whichever base the rotation uses — request `mandate` or
`incumbent.mandate` — so the desktop draft's stacked text compacts too.

### 2.2 Compose

```ts
export interface ComposeInput {
  core: string;
  history: string | null;        // rendered digest or fallback body, already ≤ HISTORY_BUDGET_BYTES
  handoff: HandoffParts;         // { header: string[]; tasks: string | null; notes: string | null }
  budgetBytes: number;           // envelope − launch overhead (section 5)
  deliver: (mandate: string) => string;   // orchestratorMandateForDelivery
}
export type ComposeOutcome =
  | { kind: "fits"; mandate: string; bytes: number; historyDropped: boolean; notesTruncatedTo: number | null }
  | { kind: "too_large"; bytes: number; budgetBytes: number };
export function composeSuccessorMandate(input: ComposeInput): ComposeOutcome
```

Rendering, in order, joined by `"\n\n"`:

1. `core`
2. `HISTORY_HEADING + "\n" + history` — omitted when `history` is null
3. `HANDOFF_HEADING + "\n\n" + header.join("\n\n") + tasks + notes` — the
   fresh block, identical in wording to today's lines 564-574 so the existing
   rotation test keeps passing.

Measurement is `Buffer.byteLength(deliver(mandate), "utf8")`, which is exactly
the string spawn mode places after the scaffold and existing mode delivers, so
the directive appended by `orchestratorMandateForDelivery` is counted.

Fit loop, in the order the acceptance criteria state:

1. Render with everything. If `bytes ≤ budgetBytes` → `fits`.
2. Drop the history section (`historyDropped = true`). Re-measure.
3. Truncate `notes` (the "Notes from the caller" text) by code points to
   the largest length that fits, appending ` …[truncated]`; if even zero notes
   do not fit, remove the notes paragraph entirely. Re-measure.
4. Still over → `too_large`. The core plus a minimal handoff cannot be
   delivered; the caller answers 413 (section 5). Nothing else is trimmed:
   the task list is already capped at ~2.2 KB by the existing constants and
   the predecessor line is the successor's only pointer to its history.

### 2.3 Byte table

| Piece | Bytes | Source |
|---|---|---|
| Structured envelope | 32 000 | `MAX_STRUCTURED_TEXT_BYTES` |
| Spawn-mode launch overhead (scaffold + `"\n\n"`) | 770 for `mode: "standard"` | measured via `resolveSpawnRole` |
| Existing-mode overhead | 0 | delivery asserts the text alone |
| Status directive, when the mandate lacks it | 692 | `ORCHESTRATOR_INITIAL_STATUS_DIRECTIVE` |
| Default core mandate (v9, directive included) | 8 325 | `ORCHESTRATOR_SYSTEM_PROMPT` |
| Rotation history section | ≤ 4 096 + 20 | `HISTORY_BUDGET_BYTES` + heading |
| Fresh handoff | 562 … ~4 753 | measured extremes under existing caps |

Worst case with the default core: 8 325 + 4 116 + 4 753 + 4 + 770 ≈ 18 KB,
independent of how many rotations preceded it. Compaction bites only for
bespoke cores above roughly 22 KB; refusal only when the core alone plus a
minimal handoff exceeds the budget (core ≳ 29.7 KB in spawn mode). The
incident's 4.5 KB core would have rotated at ~14 KB.

### 2.4 First rotation and replay

- With no prior history and no prior handoffs (first rotation), the
  summarizer is not invoked and no history section is rendered. The fresh
  handoff already carries the predecessor's transcript path and the open
  tasks; spending 60-90 s to restate the predecessor's last report on every
  first rotation buys nothing the successor cannot read itself.
- When `orchestratorSeatFor(project).pending` carries this request's
  `clientRequestId` with `intent.error === null`, the rotation is a replay of
  an in-flight intent: skip composition and summarization entirely and pass
  `mandate: pending.mandate` through. `executeOrchestratorSeatRequest`
  already delivers the stored mandate on replay (lines 397, 456); this only
  avoids a second summarizer run on retry.

### 2.5 Marker hygiene

Digest and fallback bodies are normalized so that a line beginning with
`## ` becomes `- ` before rendering. The next rotation's split therefore sees
exactly one history boundary and one handoff boundary, whatever the model or
a caller's notes contained.

## 3. Headless summarizer (AC 2)

### 3.1 Seam

The seat command never spawns processes itself. `SeatCommandDependencies`
gains one member:

```ts
export interface HandoffDigestRequest {
  project: string;
  clientRequestId: string;           // artifact directory name and run key
  priorHistory: string | null;       // previous digest body, if any
  priorHandoffs: string[];           // oldest first, heading removed
  predecessor: { path: string; engine: "claude" | "codex" } | null;
}
export type HandoffDigestOutcome =
  | { kind: "digest"; text: string }                                   // ≤ HISTORY_BUDGET_BYTES, non-empty, redacted
  | { kind: "fallback"; reason: "unavailable" | "exhausted" | "timeout" | "failed" | "empty" | "over_budget" | "error" };

summarizeHandoffs(request: HandoffDigestRequest): Promise<HandoffDigestOutcome>;
```

`productionSeatCommandDependencies.summarizeHandoffs` is
`summarizeHandoffsHeadless` from `handoffDigest.ts`. Tests inject a fake and
never reach exec.ts. The rotation wraps the call in `try/catch`; a thrown
error is `{kind: "fallback", reason: "error"}`.

`ExistingConversationTarget`'s eligible variant gains `engine`, read from
`RegistryConversation.engine` (`src/lib/agent/registry.ts:416`) in
`productionSeatCommandDependencies.conversationTarget`, so the rotation can
hand the summarizer `{path, engine}` for the predecessor.

### 3.2 Production implementation

```ts
export async function summarizeHandoffsHeadless(
  request: HandoffDigestRequest,
  runtime: {
    resolveAccount: () => HeadlessSpawnAvailability;   // accountManager.resolveHeadlessSpawn("codex", null, [])
    run: (input: HeadlessCodexRunRequest) => Promise<HeadlessRunResult>;   // runHeadlessCodexOnce
    readPredecessorReport: (path: string, engine: "claude" | "codex") => string | null;
    now: () => number;
  } = productionDigestRuntime,
): Promise<HandoffDigestOutcome>
```

Steps:

1. **Account.** `resolveAccount()` once. `exhausted` → `fallback/exhausted`,
   `unavailable` → `fallback/unavailable`, both immediately and with no
   network. One account, one attempt: the flow engine's per-round account
   rotation exists because a review verdict is worth waiting for, and AC 3
   says rotation never blocks on the summarizer, so the digest gets a single
   bounded try.
2. **Predecessor report.** `readPredecessorReport(path, engine)` returns the
   text of the last assistant message in the transcript tail (section 3.5),
   truncated by code points to `PREDECESSOR_REPORT_CAP_BYTES`; `null` when
   the file is missing, unreadable, or has no assistant message.
3. **Input bound.** Assemble `priorHistory`, then `priorHandoffs`, then the
   report. If the total exceeds `SUMMARY_INPUT_CAP_BYTES`, drop the oldest
   handoffs first until it fits (the previous digest already covers them).
   Every piece passes through `hardenedRedact` before it enters the prompt.
4. **Run.** `run({...})` with the prompt in 3.3, `model: CODEX_LUNA_MODEL`,
   `effort: "low"`, `sandbox: "read-only"`, `cwd` = a fresh empty directory
   inside the artifact directory, `timeoutMs: HANDOFF_DIGEST_TIMEOUT_MS`,
   `artifactDir: statePath("orchestrator", "handoff-digests", clientRequestId)`.
5. **Validate.** `status !== "done"` → `fallback/timeout` or `fallback/failed`
   (a quota refusal mid-run surfaces as a non-zero exit with an empty
   last-message artifact and lands here). `finalOutput.trim()` empty →
   `fallback/empty`. Apply `hardenedRedact` and the marker normalization
   (2.5); `Buffer.byteLength > HISTORY_BUDGET_BYTES` → `fallback/over_budget`
   (AC 3 names over-budget as a fallback trigger, so the digest is discarded
   whole). Otherwise `{kind: "digest", text}`.
6. **Cleanup.** `fs.rmSync(artifactDir, {recursive: true, force: true})` in a
   `finally`. The rotation response and a single `console.warn` line carrying
   the fallback reason (never transcript text) are the diagnostic record.

Latency budget for the rotation call: ≤ 75 s for the summarizer plus the
existing spawn path. Two concurrent rotations for one project both summarize;
the second's `beginOrchestratorSeatIntent` answers `in_progress` as it does
today, only later.

### 3.3 Prompt

Sent on stdin (the existing `fenceViewerSpawnPrompt` suffix stays; it is
347 bytes of spawn policy the summarizer has no way to act on).

```
You are compacting the rotation history of a project manager agent's mandate.
Write a digest of the material below for the manager's successor. Use exactly
these three headings and short bullet points under each:

Decisions:
Blockers:
In flight:

Rules: at most 3500 bytes in total. Keep only what the successor needs to act:
decisions already made, blockers still open, and work in flight with its
current state. Never include names, account handles, email addresses,
tokens, or file paths. Do not use Markdown headings starting with "#". Do not
run commands or read files; everything you need is below. Output the digest
only — no preamble, no closing remarks.

=== Previous rotation history ===
<priorHistory or "(none)">

=== Earlier handoffs, oldest first ===
--- handoff 1 ---
<body>
--- handoff N ---
<body>

=== Predecessor's last report ===
<report or "(unavailable)">
```

The 3 500-byte instruction leaves headroom under the 4 096-byte validation
bound for models that overshoot slightly.

### 3.4 Generalizing exec.ts

Two small changes; the reviewer path keeps its behavior and signature.

1. `reviewerCommand` gains a trailing `options: { sandbox?: "bypass" | "read-only" } = {}`.
   For `"read-only"` the Codex args replace
   `--dangerously-bypass-approvals-and-sandbox` with `-s read-only` and add
   `--skip-git-repo-check` (the summarizer runs in an empty directory).
   Claude branch unchanged. Default remains `"bypass"`, so the existing
   assertion that the reviewer carries no `--sandbox` stays true.
2. The detached spawn, timer, `runs` bookkeeping and group-kill from
   `startHeadlessReview` move into a private `launchDetached(key, built,
   artifacts, timeoutMs, runtime, onExit)`; `startHeadlessReview` calls it
   with `onExit = signalCompletion` and returns exactly what it returns
   today. New export:

   ```ts
   export interface HeadlessCodexRunRequest {
     key: string;                      // runs-map key, e.g. `orchestrator-handoff:${clientRequestId}`
     cwd: string;
     "prompt": string;               // quoted so the privacy gate's transcript detector skips the line
     model: string | null;
     effort: string | null;
     account: HeadlessCodexAccount | null;
     artifactDir: string;              // stdout.log, stderr.txt, last-message.md are written here
     timeoutMs: number;
     sandbox: "bypass" | "read-only";
     runtime?: HeadlessReviewRuntime;  // { command } test seam, as today
   }
   export function runHeadlessCodexOnce(request: HeadlessCodexRunRequest): Promise<HeadlessRunResult>
   ```

   It resolves on the child's `close`/`error` (or the timeout kill) with
   `status` derived the same way `headlessReviewStatus` derives it —
   `done` when the last-message artifact is populated or the exit code is 0
   with a scanned agent message, `timeout` when the timer fired, otherwise
   `failed` — and `finalOutput` = artifact text, else the last
   `agent_message` from `scanEventStream(stdout)`. A duplicate `key` while a
   run is live resolves `failed` immediately, mirroring the `runs.has(key)`
   guard. No restart seam: a rotation request that dies with the server has
   nobody to hand a digest to; the detached child finishes its turn and exits
   on its own.

Reused unchanged: `reviewerEnvironment` (credential scrubbing),
`terminateHeadlessReviewerGroup`, `killOwnedRun`, `scanEventStream`,
`readOptional`, the `runs` map, `procBackend.processIdentity`.

### 3.5 Transcript tail reader

**As built, this reuse was not possible.** `src/lib/view/compactText.ts` cannot
be edited in a publishable change: its own secret-redaction regex (the
`sk-…`/`gh…_` token alternation on line 15) matches the publication gate's
`credential` detector, so the gate fails on the whole file the moment the file
enters a diff — verified with
`bun scripts/privacy-publication-gate.ts --paths src/lib/view/compactText.ts`.

`handoffDigest.ts` therefore carries its own `lastAssistantReport(path, engine)`:
the same bounded tail read through an `O_NOFOLLOW` descriptor with a
device/inode identity check, recognizing both engines' row shapes, returning the
last assistant text truncated to `PREDECESSOR_REPORT_CAP_BYTES`. `hardenedRedact`
is still imported from `compactText.ts` — importing it changes nothing there.

## 4. Deterministic fallback (AC 3)

```ts
export function fallbackHistory(priorHistory: string | null, priorHandoffs: string[], reason: string): string | null
```

Returns `null` when there is nothing prior. Otherwise allocates
`HISTORY_BUDGET_BYTES` newest-first: the newest handoff, then the second
newest (`FALLBACK_HANDOFF_COUNT = 2`), then the previous digest if room
remains; each piece is taken verbatim when it fits, else truncated by code
points to the remaining budget with ` …[truncated]`, and pieces with no room
left are omitted. Rendering is oldest-first:

```
(verbatim — summarizer <reason>)

### Earlier rotation history
<previous digest>

### Earlier handoff
<second newest body>

### Earlier handoff
<newest body>
```

`### ` lines are not split boundaries (2.1), and the marker normalization
(2.5) applies to the bodies. The same function runs for every fallback
reason, so the successor mandate is a pure function of the incumbent's
mandate, the fresh handoff, and the reason string.

## 5. Size preflight and error contract (AC 4)

### 5.1 Placement

`executeOrchestratorSeatRequest` replaces the `MANDATE_MAX_BYTES` check at
lines 334-336 with the envelope preflight, after the mode is known (the
`conversationId` presence decides it, line 341) and before either
`beginOrchestratorSeatIntent` call (lines 365, 450):

```ts
export function launchOverheadBytes(mode: "spawn" | "existing", roleParams: unknown): number
// spawn: byteLength(resolveSpawnRole({ role: "orchestrator", roleParams }).scaffold) + 2; existing: 0
export function mandatePreflight(mandate: string, mode, roleParams):
  | { ok: true; bytes: number; overhead: number }
  | { ok: false; bytes: number; overhead: number; bound: number; excess: number }
```

`bytes = Buffer.byteLength(orchestratorMandateForDelivery(mandate), "utf8")`;
refuse when `bytes + overhead > MAX_STRUCTURED_TEXT_BYTES`. This mirrors
`spawnCommand.ts:245, 273` and `structuredMessageDelivery.ts:264` exactly,
which is why no safety margin is needed. `MANDATE_MAX_BYTES` is deleted: one
bound, the delivery bound, decides.

`executeOrchestratorRotation` composes with `budgetBytes =
MAX_STRUCTURED_TEXT_BYTES − launchOverheadBytes("spawn", rawBody.roleParams ?? {mode: "standard"})`,
so a rotation that reaches the seat request always passes the preflight; the
preflight there is the guard for `create_orchestrator`, adoption, and any
caller-supplied mandate.

### 5.2 Error contract

```json
{
  "error": "mandate is too large to deliver: 31840 bytes of mandate plus 770 bytes of launch overhead exceeds the 32000-byte structured envelope by 610 bytes; shorten the mandate by at least 610 bytes",
  "code": "mandate_too_large",
  "bytes": 31840,
  "overhead": 770,
  "bound": 32000,
  "excess": 610
}
```

HTTP 413. No intent is created, no spawn or delivery is attempted, the
incumbent (if any) is untouched, and an errored pending row from an earlier
attempt is left as it was (it is cleared by the next call that reaches
`begin`, section 6). The rotation route returns the same body plus
`rotatedFrom`.

### 5.3 Rotation response additions

On success the rotation body gains

```json
"handoff": { "history": "digest" | "fallback" | "none", "reason": null | "<fallback reason>", "historyDropped": false, "mandateBytes": 14210 }
```

and `rotate_orchestrator` in `src/lib/mcp/bindings.ts:1677-1692` passes
`handoff: result.handoff ?? null` through, so the agent or operator who
rotated can see when the digest fell back and why.

## 6. Terminal failed intent (AC 5)

No schema change. The terminal state is the existing one: a pending row whose
`intent.error` is non-null. Facts, verified above:

- `failOrchestratorSeatIntent` records the error on every delivery or spawn
  failure the seat command sees (`seatCommand.ts:385, 401, 461, 496`;
  `seats.ts:396-403`), including the reconciled failure of an accepted launch
  (`seatCommand.ts:319-321`).
- `beginOrchestratorSeatIntent` never blocks on such a row: it terminalizes it
  into `history` with `reason: "terminal_error"` and proceeds
  (`seats.ts:303-317`). So the next `rotate_orchestrator` or
  `create_orchestrator` (spawn or adoption) that reaches `begin` clears it.
- The panel banner reads `pending.intent.error` (`seatState.ts:185, 216`) and
  goes away with the row; `orchestratorSeatFor().history` keeps the evidence.

What the design adds is the guarantee that the row is reachable only by a
*deliverable* mandate that failed for another reason: the preflight removes
the one failure that was certain to repeat. The doc comment on
`failOrchestratorSeatIntent` and the seat-command header should say
"terminal, cleared by the next begin" in those words, and a test pins it
(section 7, AC 5). Adding a `state: "failed"` value would touch
`normalizeSeat`, every UI state derivation and the mobile row for no
behavioral gain; it is listed under Deferred.

## 7. Test plan (AC 6), one test per criterion

Isolation, unchanged from the file's existing harness
(`seatCommand.test.ts:23-38`): every test runs under a fresh
`LLV_STATE_DIR = mkdtemp("llv-seat-command-")`, restored and removed in
`afterEach`; all side effects go through injected `SeatCommandDependencies`
(spawn, deliver, conversationTarget, projectTasks, launchSettlement,
summarizeHandoffs, now). No test in this file spawns a process or opens a
socket. The operator's live state under `$XDG_CONFIG_HOME/agent-log-viewer`
is never read because `statePath` honors `LLV_STATE_DIR` wholesale
(`src/lib/configDir.ts:115-119`). Run by path only:

```
bun test src/lib/orchestrator/seatCommand.test.ts src/lib/orchestrator/handoffDigest.test.ts src/lib/flows/exec.test.ts
```

Fixture builder: `stackedMandate(core, n)` renders `core` followed by `n`
handoff sections using the real `HANDOFF_HEADING` and bodies carrying a
unique token per section (`note-1 … note-n`). Conversation ids in fixtures
are assembled from parts as the existing file does; no UUID-shaped or
home-path literals.

| AC | Test (file) | Asserts |
|---|---|---|
| 1 | `stacked handoffs compact into ONE rotation history section` (seatCommand) | seed active seat with `stackedMandate(core, 3)`; fake summarizer returns `"Decisions:\n- digest-token"`; after rotation the spawned prompt starts with `core`, contains exactly one `HISTORY_HEADING` and exactly one `HANDOFF_HEADING`, contains `digest-token` and none of `note-1..3`; the stored successor `seat.mandate` has the same shape; the fake received `priorHandoffs.length === 3` and `priorHistory === null` |
| 1 | `the desktop draft's explicit stacked mandate compacts the same way` (seatCommand) | same seed, rotation body carries `mandate: stackedMandate(core, 3)` explicitly → identical assertions |
| 1 | `a second rotation feeds the previous digest and only the newest handoff to the summarizer` (seatCommand) | rotate twice; second fake call receives `priorHistory` containing the first digest and `priorHandoffs.length === 1` |
| 1 | `first rotation renders no history section and does not call the summarizer` (seatCommand) | existing rotation test extended: fake summarizer call count 0, prompt lacks `HISTORY_HEADING`, `body.handoff.history === "none"` |
| 2 | `the headless digest runs Luna on the resolved account with the bounded inputs` (handoffDigest) | `summarizeHandoffsHeadless` with fake `resolveAccount → available`, fake `run` capturing its request, fixture predecessor transcript in the sandbox (one Claude-shaped, one Codex-shaped case) → `run` saw `model === CODEX_LUNA_MODEL`, `sandbox === "read-only"`, `timeoutMs === HANDOFF_DIGEST_TIMEOUT_MS`, prompt contains each handoff body and the last assistant text, and outcome is `digest` with the run's `finalOutput` |
| 2 | `read-only summarizer command shape` (exec) | `reviewerCommand(codexRole, …, {sandbox: "read-only"})` args contain `-s read-only`, `--skip-git-repo-check`, `--ignore-user-config`, `--disable multi_agent`, and not `--dangerously-bypass-approvals-and-sandbox`; the default call is unchanged |
| 2 | `runHeadlessCodexOnce resolves done from the last-message artifact and times out a hung child` (exec) | fake executable (existing pattern, `exec.test.ts:221-260`) writes the artifact → `done` + `finalOutput`; a sleeping fake with `timeoutMs: 200` → `timeout`, artifact dir cleaned by caller |
| 3 | `summarizer fallback keeps the latest two handoffs verbatim within the budget` (seatCommand) | seed 4 handoffs; fake returns `{kind: "fallback", reason: "timeout"}` → prompt contains `note-4` and `note-3` and none of `note-1`/`note-2`; history section ≤ `HISTORY_BUDGET_BYTES + heading`; `body.handoff === {history: "fallback", reason: "timeout", …}` |
| 3 | `a throwing summarizer never blocks rotation` (seatCommand) | fake rejects → status 200, fallback shape, `reason: "error"` |
| 3 | `exhausted or unavailable accounts fall back without running anything` (handoffDigest) | `resolveAccount → exhausted` / `unavailable` → outcome `fallback` with that reason, `run` call count 0 |
| 3 | `empty and over-budget digests fall back` (handoffDigest) | fake `run` returns `done` with `""` → `empty`; with 5 000 bytes → `over_budget`; with a `## ` line → digest line normalized to `- ` |
| 4 | `an oversized mandate is refused before any intent exists` (seatCommand) | `create` with a 31 900-byte mandate (spawn mode) → 413, `code: "mandate_too_large"`, `bytes`, `overhead: 770`, `bound: 32000`, `excess`; `orchestratorSeatFor().pending === null`; no spawn recorded. Existing-mode variant with 32 100 bytes → 413 with `overhead: 0`; no delivery recorded |
| 4 | `rotation compacts further before refusing: history first, then notes` (seatCommand) | incumbent core of 26 000 bytes + 2 handoffs, fake digest 4 000 bytes, notes 2 000 bytes → 200; prompt lacks `HISTORY_HEADING`, notes end with `…[truncated]`, `byteLength(scaffold + "\n\n" + prompt) ≤ 32000`; then core of 31 000 bytes → 413, no pending, incumbent still active, no spawn |
| 5 | `a failed delivery is terminal and the next rotate clears it` (seatCommand) | rotation whose spawn dependency answers 413 → `pending.intent.error` set, incumbent active; next rotation with a fresh key and a working spawn → 200, `pending === null`, `history[0].reason === "terminal_error"`, active = successor. Existing-mode variant: adoption whose `deliver` answers `{ok: false}` → same terminal marker, cleared by `create` on another key |
| 6 | `twelve rotations keep every successor mandate under the bound` (seatCommand) | loop 12 rotations with 12 max-length tasks and 2 000-byte notes each, fake summarizer returning a 3 800-byte digest; after each: `byteLength(scaffold + "\n\n" + prompt) ≤ 32000`, exactly one history and one handoff heading; repeat the loop with a fallback summarizer |
| 7 | `bun scripts/privacy-publication-gate.ts --base $(git merge-base HEAD main)` | manual gate before push; fixtures use invented tokens only |
| 8 | `bunx tsc --noEmit`, the three files above | manual gate |

## 8. Files the implementer touches

| File | Change |
|---|---|
| `src/lib/orchestrator/handoffDigest.ts` (new) | constants; `splitMandate`, `composeSuccessorMandate`, `fallbackHistory`, `normalizeMarkers`, `launchOverheadBytes`, `mandatePreflight`; `summarizeHandoffsHeadless` + `productionDigestRuntime` |
| `src/lib/orchestrator/handoffDigest.test.ts` (new) | AC 2/3 unit tests with fixture transcripts under `LLV_STATE_DIR` |
| `src/lib/orchestrator/seatCommand.ts` | import the module; delete `MANDATE_MAX_BYTES`; preflight before both `begin` calls; `summarizeHandoffs` dependency + production wiring; `engine` on the eligible target; rotation: replay short-circuit, split, summarize, compose, `handoff` response field; move the heading literal |
| `src/lib/orchestrator/seatCommand.test.ts` | tests in section 7; fixture builder; `engine` on the fake target |
| `src/lib/flows/exec.ts` | `reviewerCommand` sandbox option; extract `launchDetached`; export `runHeadlessCodexOnce` |
| `src/lib/flows/exec.test.ts` | command-shape and one-shot run tests |
| ~~`src/lib/view/compactText.ts`~~ | Not touched — see 3.5; the reader lives in `handoffDigest.ts` |
| `src/lib/mcp/bindings.ts` | `rotateOrchestrator` passes `handoff` through (one line) |
| `docs/design/orchestrator-handoff-compaction.md` | this document |

Not touched: `seats.ts` (no schema change), `prompt.ts`, every component under
`src/components/` (banner semantics are unchanged), `structuredContent.ts`,
`models.ts`, the API route modules (they only forward to the command).

## 9. Validation against the requirement, and the over-engineering pass

Against the issue's three fix directions: preflight at intent creation with
an actionable error (section 5); bounded accumulation by summarizing older
handoffs with a verbatim N=2 fallback (sections 2-4); a terminal state for a
failed designation with a retry path — the retry path is the existing draft
textarea plus a rotation that now composes a deliverable mandate, and the
terminal state is the existing `intent.error` row made explicit and tested
(section 6). Against the eight acceptance criteria: each has a section and a
row in the test table.

Cut on purpose, and why the simpler mechanism suffices:

- No new seat schema or `state: "failed"` value — the store's abandoned-row
  rule already exists and the UI already renders it.
- No retry across accounts, no queue, no persistent digest cache — one
  bounded attempt, then a pure fallback; the digest is recomputed from the
  stored mandate on the next rotation anyway.
- No configuration knobs or environment variables for budgets — five
  constants next to the code that uses them.
- No summarizer on the first rotation — nothing to compact.
- No task-list trimming beyond the existing caps — the two named trims
  already guarantee a fit for any core under ~29.7 KB.
- No ADR: every choice here is a local constant or a pure function and is
  reversible in one PR.

## Deferred — not currently justified

- **Operator surface to cancel a pending intent** (issue mechanism 3). Once a
  pending row can only hold a deliverable mandate, the remaining pending
  states are genuinely in flight or already terminal; cancel adds a second
  way to end a transition with no incident behind it.
- **`state: "failed"` on the seat row.** Cosmetic today; revisit if a consumer
  needs to distinguish an errored pending row without reading `intent.error`.
- **Summarizing on the first rotation** (digesting the predecessor's last
  report when there are no prior handoffs). The transcript path in the
  handoff covers it; add only if successors demonstrably skip reading it.
- **Claude-engine summarizer fallback when every Codex account is exhausted.**
  The deterministic fallback already meets the acceptance criteria; a second
  engine doubles the surface for a rare window.
- **Truncating an over-budget digest as an alternative to the fallback.** The
  criteria name over-budget as a fallback trigger; measure how often it
  happens before softening it.

## 10. Corrections from the first review round

Two defects the design did not anticipate, both fixed at the root in the
implementation and covered by tests:

**The summarizer is an await point across a durable transition.** Rotation
reads the incumbent, its mandate and its transcript path, then waits up to 75 s
for the digest, then designates a successor with `replaceIncumbent: true`. A
designation that settles inside that window owns the seat by the time rotation
resumes, and replacing it would revoke a newer orchestrator on the strength of
a stale read — handing the successor a superseded mandate and losing the newer
one's own handoff. `executeOrchestratorRotation` now re-reads the seat after
composition and proceeds only when `conversationId` and `seatEpoch` still match
what it read; otherwise it answers 409 `incumbent_changed`, naming the epoch it
composed against and the one that is current. Nothing is spawned and no intent
is created, so rotating again simply recomposes from the seated orchestrator.
The synchronous path — a first rotation, or a replay of a pending intent — has
no await point and passes the check trivially, so the serialization the store
already provides is unchanged.

**"Identity-free" cannot be delegated to the model.** The prompt asks for a
digest without names, handles, addresses or paths, but the material being
compacted is transcript-derived, the model may quote it back, and whatever it
writes is pasted into the successor's mandate and re-summarized at every later
rotation — one leak becomes permanent. `hardenedRedact` covers credentials
only. `identityRedact` in `handoffDigest.ts` now removes four classes
deterministically — email addresses, account handles (`@name` and the owner
segment of a code-hosting URL), filesystem paths (home-relative, rooted at a
real filesystem root, or three or more segments deep) and opaque record ids —
and runs on every piece of summarizer input and again on the model's output,
before the budget check. Over-redaction is the intended failure mode: a digest
of decisions, blockers and in-flight work needs none of those to be useful, and
two-segment API routes and ordinary URLs survive it. The deterministic fallback
is deliberately untouched: AC 3 specifies the prior handoffs verbatim, and they
are the seat's own text, carrying the predecessor pointer the successor needs.
