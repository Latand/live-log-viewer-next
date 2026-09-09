# Pipeline stages that never start, and stages that never finish

Status: design, 2026-09-09. Architect stage of the "Fix autoStart parking on transient account contention" pipeline. Read-only: no product source was edited; this document is the stage's only output.

Issues:

- Scenario A (a stage that never starts): https://github.com/Latand/live-log-viewer-next/issues/1433 (canonical, updated with the 2026-09-09 evidence). https://github.com/Latand/live-log-viewer-next/issues/1485 was the same failure and is closed as a duplicate.
- Scenario B (a stage that never finishes): https://github.com/Latand/live-log-viewer-next/issues/1589 (new).

Both were observed on 2026-09-09 against the revision the Viewer was serving, which is the tip of `main` (`bf60e71d`) and the base of this lane. Every file:line below is against that revision.

## 1. Originating requirement

Operator, 2026-09-09 about 06:26Z, relayed by an external project's root manager to the Viewer manager seat (verbatim, the operator's own words):

> передай баг оркестратору ліве лог вьювер хай зафіксить прямо зараз цю хуйню бо не працює виодить як треба

The manager's relay of the same message (identifiers elided, otherwise verbatim):

> create_pipeline [...] autoStart:true produced pipeline [A] for Astra gpt-6-astra effort medium. At 06:25 check: needs_decision, cursor walkthrough/spawning; attempt needs_decision 'account mutation is busy in this process; retry shortly', conversationId:null, launchId:null. No process/agent ever created. User saw pipeline card and asked if merely created without started. [...] direct spawn [...] created conversation [C]. Fresh 06:26:13 evidence: actual host alive, turn busy, deliverable true. This proves same model/account can launch immediately through direct path while autoStart pipeline parks. [...] Historical recurring same account busy occurred pipeline [H] review BEFORE any IDs; do not treat user waiting as resolution. Acceptance: injected/real concurrent account mutation contention yields durable bounded queued/retry state with same identity, resumes after busy clears without new operator message, exactly one fresh launch; board shows truthful pending/failed reason and actual running only after host claim; no duplicate workers, no false completion; failure state not silent needs_decision for transient busy; legitimate unknown existing launch remains protected. [...] don't broadly kill/restart workers or bypass locks/timeouts.

Second scenario, added by the Viewer manager seat during this stage (2026-09-09, identifiers elided):

> pipeline [F] fix conversation final 05:40:18 Sep 9 valid JSON status pass / findings [] / confidence .97 REVIEW_READY. At 06:28 fix attempt still running, review attempts empty; agent_activity stale turn busy despite final. Owner has now PAUSED scheduling and spawned separate reviewer. [...] determine authoritative terminal-turn vs prose, stale host projection and controller advancement. Need causal reproduction and minimal fix for automatic exactly-once review advancement after authoritative completion, no advancement on mere final-looking prose/partial turn/unknown transport. Board running must reflect reality.

The two failures are unrelated in code. They share one consequence: the pipeline record and the board tell the operator something that is not true about a stage, and only a human notices. Each gets its own section, its own issue and its own slice.

## 2. Was this solved before

- #1433 (open, 2026-09-01) names Scenario A with a suspected mechanism and asks for a wait plus bounded automatic retries. Its one comment points at the unified automation model design (`docs/design/automation-v2/README.md`, §4.2 row "#1433", §6.3 slice 3): "the busy lock is a typed transient that books the wall-clock wait inside the same attempt; the spawn path queues on the async lock and never throws". Slices 1 and 2 of that plan have not landed (no `PIPELINE_ACTIONS_STAGED`, no `LLV_PIPELINE_SETTLEMENT_V1` in `src/lib/pipelines/`), so slice 3 has nothing to build on yet. This design takes slice 3's engine half and defers its lock half, with the reason in §3.6.
- #1485 (2026-09-03) is the same failure told from the orchestrator's side. Closed as a duplicate of #1433 during this stage.
- #1191 built the between-ticks wait this design reuses (`controllerWait`, `bookControllerWaitRound`). #1056 gave every retry its own launch identity. Both are load-bearing below.
- #1184 (open) is the nearest neighbour of Scenario B: a Claude host resumed after a restart idles on an interrupted `tool_use`. There the turn never continues. In Scenario B the turn continued and finished; the projection is what stays wrong. Distinct, and #1589 says so.
- #337 made the transcript the completion authority for a stage; #516 added the Claude recovery-tail release for a turn left busy by recovery bookkeeping. Scenario B is the Codex analogue of #516 at the tool ledger, not at the message level.
- Transcript search (five queries: the exact busy sentence project-scoped, the busy sentence unscoped, "autoStart pipeline needs_decision spawning launchId null", "turnState busy after task_complete final verdict stage not settled", "Continue the interrupted turn from the transcript severed turn stays open busy"). Twelve hits for the busy sentence, all of them orchestrator seats reporting a `stage_blocked` event with that text between 2026-08-29 and 2026-09-09, and one rotate-orchestrator refusal with the cross-process variant on 2026-09-08. None contains a diagnosis or a fix. Nothing relevant existed for Scenario B.

## 3. Scenario A: a stage spawn that fails before allocation

### 3.1 Evidence

| When (UTC) | What |
| --- | --- |
| 2026-09-09 06:21:00.3 | `create_pipeline`, `autoStart: true`, one Codex run stage, project-bound account. Record created in `provisioning`. |
| 06:21:02.8 | Viewer log: `[limits] claude fallback: oauth-rate-limited`. A limits refresh ran; the quota tick that accompanies it is one of the lock holders in §3.3. |
| 06:21:05.1 | Attempt 1 `startedAt`. The attempt record: `state: needs_decision`, `launchId: null`, `conversationId: null`, `accountId: null`, `error: "account mutation is busy in this process; retry shortly"`. Pipeline `needs_decision`, cursor `walkthrough/spawning`. No receipt, no conversation, no process. |
| 06:25:31.1 | Owner closes the pipeline (record preserved, `closedAt` set). |
| 06:25:31.3 | Owner launches the same account, model and prompt through `spawn_agent` (the direct path): `state: starting`, a launch id and a conversation id returned at once. |
| 06:26:13 | That conversation: host alive, turn busy, deliverable. |
| 2026-09-08 13:55:11 | Earlier occurrence: a review stage activated 7 s after its builder passed (13:55:04), same error, same empty identity fields, later closed by hand. |

The operator's inference is exact: the same account could launch through the direct path while the pipeline path parked.

### 3.2 The code path

1. `tickRunStage` (`src/lib/pipelines/engine.ts:2052`) activates the attempt, sets `spawning`, persists, and calls `ports.spawnAgent` inside a retry loop (`engine.ts:2190`).
2. Production `spawnAgent` is `spawnPipelineAgent` (`engine.ts:354`). Before any reservation it calls `registry.beginSpawnRequest(...)` directly (`engine.ts:421`).
3. `beginSpawnRequest` takes the synchronous lock: `withAccountMutationLock` (`src/lib/agent/registry.ts:4135`).
4. The sync acquire is `acquireLocalSync` (`src/lib/accounts/accountMutation.ts:59-63`): if the process-wide `runtime.localHeld` flag is set, it throws `AccountMutationBusyError("account mutation is busy in this process; retry shortly")` immediately. No wait, no queue.
5. The throw propagates out of `spawnAgent`. The engine's transient classifier (`engine.ts:3027-3031`) recognises only "structured delivery controller is unavailable", "structured initial message" and "runtime host request timed out", so `engine.ts:2204` rethrows, `engine.ts:2245` calls `park`, and `park` (`engine.ts:1277`) writes `needs_decision` on the attempt and the pipeline with the error as `stateDetail`.
6. Nothing schedules another tick for that attempt. `needs_decision` is terminal until `retry-stage`.

`launchId` is null because step 3 threw before `beginSpawnRequestInFile` ran, so there is no receipt to recover from. That is also why the existing `spawning`-state recovery (`engine.ts:2254` onwards) cannot help: it needs a launch id.

### 3.3 Why the flag was set

`runtime.localHeld` is true for the entire life of any `withAccountMutationLockAsync` holder in the same process (`accountMutation.ts:65-69`, released at `accountMutation.ts:53-57`). Two things make that life long:

- The holder's own work. The async holders in the Viewer process are network-bound: `QuotaController.tick` (`src/lib/accounts/migration/quotaController.ts:187`) probes every account of an engine in parallel with a 15 s timeout (`quotaController.ts:132`) while holding the lock; `managedCodexRuntime.probeQuota` and `loginSnapshot` (`src/lib/accounts/codexRuntime.ts:336`, `:263`) talk to the Codex app-server under it; Claude validity and OAuth refresh probes (`src/lib/accounts/spawnHealth.ts:140`, `:147`); image admission on structured delivery (`src/lib/runtime/structuredMessageDelivery.ts:979`); account select (`src/lib/accounts/manager.ts:355`, `:362`). The quota tick runs in the Viewer process (the fast controller registered from `viewerInstrumentation.ts:416`) and again in the inventory worker (`LLV_ACCOUNT_CONTROLLER_INVENTORY_WORKER=1`), on every account-migration tick and on the 30 s limits cadence.
- The wait for the file lock. `acquireAsync` (`accountMutation.ts:248-269`) takes the local flag first and only then polls the cross-process file lock, up to 2000 × 5 ms. A holder in another process (the inventory worker, the runtime host, an MCP host process) therefore turns every in-process async acquirer into a 10 s holder of `localHeld`, during which every sync acquirer in the Viewer fails.

Which holder had the flag at 06:21:05 cannot be read from the record; the lock does not log its holder. The limits refresh 2.3 s earlier and the second incident sitting 7 s after a stage settlement (when the reaper, the delivery ledger and the quota tick all move) are circumstantial. The mechanism does not depend on which one it was: any of them produces this failure, and the direct path survives all of them.

### 3.4 The asymmetry

The direct spawn path (`spawn_agent`, `POST /api/agents/spawn`) calls the same `registry.beginSpawnRequest`, but wrapped in `withAccountMutationLockAsync` (`src/lib/agent/spawnCommand.ts:785-809`). The async acquire queues on `localWaiters` and runs when the holder releases. Inside that transaction the sync `withAccountMutationLock` in `beginSpawnRequest` sees an active transaction context and runs inline (`accountMutation.ts:277-279`). So the direct path waits a few seconds and succeeds; the pipeline path throws in the same situation. `projectBindings.ts:270-276` and `codexRuntime.ts:401-404` show the codebase already treating the sync busy error as a retryable result elsewhere; the pipeline engine is the caller that does not.

### 3.5 Red reproduction

Two tests. The first proves the contention is real and is the exact call the engine makes; the second proves the engine's response to it and turns green with the fix. Both run in isolation: a temporary `LLV_STATE_DIR`, a child process for the lock test so the shared `globalThis` lock runtime never touches the live state directory, and the engine test harness that already exists. Neither touches the operator's registry (AGENTS.md: never run suites against the live state).

**Test 1, real contention on the real lock and the real registry call** (`src/lib/accounts/accountMutation.test.ts`, beside "same-process contenders leave an async transaction holder runnable"). In a child `bun -e` with `LLV_STATE_DIR` set to a temp dir:

1. Hold `withAccountMutationLockAsync` on a promise that resolves later (this is `QuotaController.tick`'s shape).
2. While held, call `agentRegistry().beginSpawnRequest(<minimal structured codex request with a fresh clientAttemptId>)` directly, as `engine.ts:421` does. Expect a thrown `AccountMutationBusyError` whose message contains `in this process`, thrown in under 100 ms. This is the red line for the pipeline path today and stays true after the fix; it documents the fail-fast contract the engine must handle.
3. While still held, start `withAccountMutationLockAsync(() => agentRegistry().beginSpawnRequest(<same request>))`, as `spawnCommand.ts:785` does. Release the holder. Expect `kind: "created"` and a launch id. This is the direct path's behaviour and the control.
4. Assert the receipt count in the temp registry is exactly one.

**Test 2, the engine books a durable wait instead of parking** (`src/lib/pipelines/engine.test.ts`, modelled on "stage activation rides out a controller that is unavailable for a few seconds (#1191)" at `engine.test.ts:2067`):

```ts
test("a stage spawn that meets a busy account lock waits inside its attempt and launches once (#1433)", async () => {
  const h = harness();
  await create(h.ports);
  await tickPipelines([], h.ports);
  const advance = frozenWallClock(h);
  const baseSpawn = h.ports.spawnAgent;
  let spawnCalls = 0;
  const scheduled: number[] = [];
  const reserved: string[] = [];
  h.ports.spawnAgent = async (input, onReserved) => {
    spawnCalls += 1;
    // Thrown before any reservation, exactly as engine.ts:421 does today.
    if (spawnCalls <= 2) throw new AccountMutationBusyError("account mutation is busy in this process; retry shortly");
    return baseSpawn(input, (r) => { reserved.push(r.launchId); onReserved(r); });
  };
  Object.assign(h.ports, { scheduleTick: (ms: number) => { scheduled.push(ms); }, sleep: async () => { throw new Error("no sleep inside the tick"); } });

  await tickPipelines([], h.ports);
  let p = loadPipelines()[0]!;
  expect(p.state).toBe("running");                       // RED today: "needs_decision"
  expect(p.cursor).toMatchObject({ stageId: "plan", state: "pending" });
  const a = p.runs[0]!.attempts.at(-1)!;
  expect(a.n).toBe(1);
  expect(a.state).toBe("pending");
  expect(a.launchId).toBeNull();
  expect(a.controllerWait).toMatchObject({ rounds: 1 });
  expect(p.stateDetail).toMatch(/^stage spawn deferred: account mutation is busy/);

  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);                      // second failure, second round
  advance(scheduled.at(-1)!);
  await tickPipelines([], h.ports);                      // holder gone, launch
  p = loadPipelines()[0]!;
  expect(spawnCalls).toBe(3);
  expect(reserved).toHaveLength(1);                      // exactly one launch
  expect(p.runs[0]!.attempts).toHaveLength(1);           // same attempt identity
  expect(p).toMatchObject({ state: "running", stateDetail: null, cursor: { stageId: "plan", state: "running" } });
  expect(scheduled).toEqual([1_000, 2_000]);
});
```

A second engine test covers exhaustion: the port throws the busy error on every call, the clock advances past the 30 s budget, and the pipeline parks with `stage spawn failed after N retries over Ss: account mutation is busy in this process`, `attempt.state: needs_decision`, still `launchId: null`, and no further scheduled tick. That is today's terminal shape with an honest sentence in front of it.

A third covers the cross-process wording: `new Error("account mutation is busy; retry shortly")` (what `acquireAsync` throws after its own 10 s at `accountMutation.ts:263`) is classified the same way. The classifier keys on the sentence prefix, not the class, because that variant is a plain `Error`.

### 3.6 Design

**One change, in one file.** `src/lib/pipelines/engine.ts` learns that "account mutation is busy" is a transient that belongs to the between-ticks wait it already has.

1. A predicate beside `isStructuredDeliveryControllerFailure` (`engine.ts:3023`):
   `isAccountLockContention(failure) = failure.startsWith("account mutation is busy")`. Added to `isTransientStructuredSpawnFailure` so `isStructuredSpawnPark` (`engine.ts:3017`) and the retry-stage admission at `engine.ts:4385` keep treating the parked shape as a spawn park.
2. In the spawn loop (`engine.ts:2203-2218`), the branch that today only `isStructuredDeliveryControllerFailure` takes (`controllerFailure = message; break;`) also takes the new predicate. The two immediate 1 s handshake retries are wrong for this failure: they sleep inside the pipelines phase (the #1191 problem) and a lock held for seconds does not clear in one. The wall-clock wait spends its time between ticks.
3. `bookControllerWaitRound` (`engine.ts:3054`) is used unchanged: `attempt.controllerWait = { startedAt, rounds, retryAfter }`, backoff `min(8 s, 1 s × 2^rounds, remaining)` inside `SPAWN_CONTROLLER_WAIT_BUDGET_MS` (30 s), a `scheduleTick(delay)` so the controller wakes itself, `attempt.state = "pending"`, cursor `pending`, persist.
4. While waiting, the record says so. Today the controller wait leaves `stateDetail` null (the #1191 test asserts that). For a deferred spawn set `pipeline.stateDetail = "stage spawn deferred: <reason>; retry at <retryAfter>"` and clear it on the successful launch, in the place that already clears the rate-limit prefix (`engine.ts:2243`). The board, `list_pipelines` and `get_pipeline` already render `stateDetail`; no protocol change, no UI change. The #1191 test's `stateDetail: null` assertion is for the controller-unavailable variant and stays as it is: that wait keeps its existing silence, this one gets a sentence, and the difference is the predicate.
5. On exhaustion the existing `controllerWaitParkDetail` sentence parks the attempt (`engine.ts:2225-2227`). Same terminal shape as today, so nothing downstream (retry-stage, the reaper, the board) meets a new state.

**What the acceptance sentences map to.**

- *Durable bounded queued/retry state with same identity*: `controllerWait` is persisted on the attempt; the attempt stays `n = 1`; the budget is 30 s wall-clock from the first sighting.
- *Resumes after busy clears without a new operator message*: the scheduled tick re-enters `tickRunStage` with `attempt.state === "pending"` and a due `retryAfter`, and calls `spawnAgent` again. No message, no operator action.
- *Exactly one fresh launch*: the busy error is thrown before `beginSpawnRequest` reserves anything, so `launchId` is null and there is no receipt to duplicate. Each retry carries its own `clientAttemptId` (`handshake_retry_<k>_…`, #1056), so if a future variant throws after reserving, the registry's replay by client attempt id still cannot mint two receipts for one identity, and the `spawning` branch at `engine.ts:2254` recovers a reserved-but-unfinished launch from its receipt rather than spawning again.
- *Legitimate unknown existing launch remains protected*: the wait is booked only on the throw path, where `launchId` is null. An attempt that has a launch id never enters it; it takes the receipt recovery branch, which refuses to spawn over an unknown receipt state.
- *Board shows truthful pending/failed reason; running only after host claim*: `stateDetail` names the deferral while pending; `running` is written only after `spawnAgent` returns a launch (`engine.ts:2237-2242`), which is after host publication, unchanged.
- *Failure state not silent needs_decision for transient busy*: the park happens only after the budget, with the retry count and elapsed seconds in the sentence.
- *No lock bypass, no longer timeouts, no manual live state changes*: the lock module is untouched; the budget is the existing 30 s; the fix is a classification.

**Crash, close and restart races.**

- Viewer restart while `pending` with a booked wait: the attempt is persisted as `pending` with `controllerWait.retryAfter`. The next controller pass sees a pending cursor and a due (or past-due) `retryAfter` and re-activates the same attempt (`engine.ts:2086-2087`). No reservation existed, so nothing is orphaned. `spawnsThisProcess` (an in-memory set) is empty after a restart, and the `spawning` guard at `engine.ts:2254` that parks "interrupted before durable launch evidence" applies only to attempts persisted in `spawning`, which this one is not.
- Close while `pending`: `close` sets the pipeline terminal; `tickPipelines` ticks only pipelines outside the terminal states (`engine.ts:3279`), so the scheduled tick finds nothing to do. The scheduled timer is `unref`-ed (`engine.ts:955`) and harmless.
- Two Viewer processes (deploy hand-over) ticking the same record: the same guard that already protects the #1191 wait applies: the attempt is re-activated only when `retryAfter` is due, and the spawn itself is fenced by `clientAttemptId` in the registry, so two processes cannot both reserve.
- The holder never releases (a wedged probe): the 30 s budget expires and the stage parks with the honest sentence. Retry-stage works as today.

**Options considered.**

| Option | Verdict | Why |
| --- | --- | --- |
| A. Classify the busy error as a transient and book the existing between-ticks wait (above) | chosen | One predicate and one branch in one file; reuses a wait record, a backoff and a park sentence that already exist and are already tested; no lock change. |
| B. Wrap the pipeline reservation in `withAccountMutationLockAsync`, as the direct path does (automation-v2 slice 3, lane A half) | deferred | It queues inside the controller's pipelines phase, whose lease is 15 s (`src/lib/pipelines/controller.ts:69`). The async acquire can wait up to 10 s on the file lock alone, and several stages activating in one pass would stack. That is the exact failure #1191 removed by moving waits between ticks. Revisit only if A's park-after-budget is observed. |
| C. Keep the two immediate 1 s handshake retries for this error | rejected | Sleeps inside the phase, and a probe that holds the lock for seconds is not cleared by a second's sleep. |
| D. Raise `ASYNC_LOCK_ATTEMPTS` or `LOCK_STALE_MS`, or let the sync path spin | rejected | Forbidden by the requirement ("no bypass locks/longer timeouts"), and it does not address the fail-fast contract. |
| E. Record the holder's operation name in the lock so the park sentence can name it (#1433's last acceptance bullet) | deferred | Needs `accountMutation.ts` changes (lane A) and a label on every caller. Nothing in the originating requirement asks for it; A's sentence already says how long and how many times. |

## 4. Scenario B: a finished stage that reads as running

### 4.1 Evidence

| When (UTC) | What |
| --- | --- |
| 2026-09-09 05:27:19 | Builder stage attempt 1 starts (Codex, project-bound account). |
| 05:28:43 | The first turn is aborted by the engine (`turn_aborted`, reason `interrupted`) and a second turn starts at 05:28:52. Normal. |
| 05:36:27 | A deploy starts the new Viewer container. The old host is severed. |
| 05:36:42 | The last record the old host writes: a `function_call` (ordinal 420). Its output never arrives: that call id appears once in the whole file. |
| 05:38:43 | The re-hosted conversation receives the standing continuation (`Continue the interrupted turn from the transcript.`, `src/lib/runtime/startup.ts:137`, delivered at `startup.ts:493`); `task_started` for a new turn id. |
| 05:40:18 | `task_complete` for that turn. The final assistant message carries `REVIEW_READY`, a PR link, and a valid fenced verdict `{"status":"pass","findings":[],"confidence":0.97}`. Recorded as `phase: final_answer`. |
| 05:40:18 | Journal: `agent_stalled` for the attempt, "transcript silent for 48 min under a live host" (the event carries the transcript's timestamp; it was written 48 minutes later). |
| 06:28:37 | The attempt is still `running`, the review stage has `attempts: []`, and the owner pauses the pipeline and spawns a reviewer by hand. |
| 06:31:56 (this stage) | `agent_activity`: `turnState: busy`, `lifecycle: stalled`, `reason: host_alive_transcript_silent`, `evidenceSource: transcript`, host alive. `conversation_deliverability`: `hostStatus: idle`, deliverable. The two surfaces disagree. |

### 4.2 The replay

`turnStateFromRecords` (`src/lib/accounts/migration/turnState.ts:125`) was run, unmodified, over the real transcript's last 128 KiB through `readStableTailRecords` (the same call `durableStageTurnEvidence` makes at `src/lib/pipelines/durableEvidence.ts:154`), from this worktree with `LLV_STATE_DIR` pointed at a temp dir:

```
integrity complete  prefixTruncated true  records 80  firstOrdinal 396  lastOrdinal 475
turnState {"state":"busy","source":"tool","terminalAt":null}
durable.turn busy  message.ts 1788932418415
openTools [<one id: the 05:36:42 function_call>]  anonymous 0
```

Record types in the window: 3 `function_call`, 2 `function_call_output`, 7 `custom_tool_call`, 7 `custom_tool_call_output`, 1 `task_started`, 1 `task_complete`. One call without an output; that is the whole story.

### 4.3 Mechanism

The Codex branch of `turnStateFromRecords` walks the tail forward with one `openTools` set for the whole window:

- `task_started` / `turn_started` (`turnState.ts:138-142`) set `turnOpen = true` and reset the terminal markers, but do not touch `openTools` or `anonymousTools`.
- `task_complete` / `turn_aborted` (`turnState.ts:144-154`) close the turn only if `openTools.size === 0 && anonymousTools === 0`; otherwise they re-open it.
- A tool call record adds its id (`turnState.ts:166-172`); only an output record with the same id removes it.

A call the restart severed has no output record and never will (the app-server does not replay a dead process's tool). It sits in the set forever. The continuation turn's `task_complete` therefore reads as premature, and every later `task_complete` in the file will too. The projection is `busy` with `source: "tool"` until the transcript is abandoned.

Every reader trusts this one function: `transcriptTurnResult` in the scanner (`src/lib/scanner/activity.ts:185`) turns it into `jsonl_turn_open` / `jsonl_turn_stalled`; liveness reads the same evidence (`src/lib/lifecycle/liveness.ts:361`), which is why `agent_activity` says `busy` with `evidenceSource: transcript`; and the engine's settlement gate reads it through `durableStageTurnEvidence` (`durableEvidence.ts:157`). In `tickRunStage`: `engine.ts:2317` returns early while the scan projects an open turn under a host that is not known dead; if it gets past that, `engine.ts:2350` needs `durable.turn === "terminal"` to settle, and `engine.ts:2430` returns on `durable.turn === "busy"`. The stage cannot settle by any path, and the reaper cannot fire either because the host is genuinely alive and idle.

The runtime host's own view (registry, `hostStatus: idle`) is right. The transcript is the authority the engine chose in #337 (a stale `running` ledger must not block a finished transcript), and the choice is still right; the ledger's blind spot is the bug.

### 4.4 Design

**One change, in one function.** A turn boundary resets the tool ledger.

- `task_started`, `turn_started` and `user_message` clear `openTools` and `anonymousTools`. A new turn cannot inherit an earlier turn's unanswered calls; whatever was open belonged to a turn that will never complete them. `user_message` clears the ledger with the other turn boundaries: measured over the rollout corpus, a steer abandons the outstanding call.
  - This amends the carve-out the section originally made, that a steer mid-turn must not drop the turn's own tools. The corpus refutes that premise: over the August rollouts (967 files) a `user_message` arrives 55 times in 5 files while a named tool is outstanding, and of the 506 calls outstanding at those steers, 0 were ever answered later in the same file. Carrying such a call forward reproduces exactly the poisoning this section exists to fix. Replaying both shapes over the 128 KiB tail of 4,906 readable rollouts, clearing here changes no final-tail verdict, so the effect is one rule holding at every turn boundary. Shipped in `turnState.ts` with #1592; the reasoning is recorded at the code as well.
- `turn_aborted` closes the turn regardless of open tools and clears the ledger. An abort ends the turn with everything in it; today an abort mid-tool leaves the transcript busy for the same reason.
- `task_complete` / `turn_complete` keep their guard: while the *same* turn has an open tool, completion is premature and the turn stays busy (the "issue 51" tests, `turnState.test.ts:16` and `:31`, are unchanged and must stay green).

No engine change. Once the evidence reads terminal, `tickRunStage` takes the existing path: `durableTerminal` at `engine.ts:2350`, `parsePipelineStageVerdict` on the final message, `settleStageVerdict`, next-stage activation. The `agent_stalled` verdict disappears on the next liveness pass because the turn state becomes idle.

Turn-id scoping (matching each tool to the turn that issued it) would also fix this and is more precise; it is heavier than the problem, needs the passthrough metadata on each record, and the boundary reset gives the same answer for every real transcript shape (a turn's tools are always between its `task_started` and its terminal event). Deferred, §6.

### 4.5 Red reproduction

**Pure** (`src/lib/accounts/migration/turnState.test.ts`):

```ts
test("a tool call severed by a restart does not keep the next turn busy", () => {
  const severed = [
    { type: "event_msg", timestamp: "2026-09-09T05:28:52Z", payload: { type: "task_started", turn_id: "turn-1" } },
    { type: "response_item", timestamp: "2026-09-09T05:36:42Z", payload: { type: "function_call", call_id: "call-cut-off" } },
    // the restart: no output record for call-cut-off, ever
    { type: "event_msg", timestamp: "2026-09-09T05:38:43Z", payload: { type: "task_started", turn_id: "turn-2" } },
    { type: "response_item", timestamp: "2026-09-09T05:38:44Z", payload: { type: "message", role: "user" } },
    { type: "response_item", timestamp: "2026-09-09T05:40:18Z", payload: { type: "message", role: "assistant", phase: "final_answer" } },
    { type: "event_msg", timestamp: "2026-09-09T05:40:18.415Z", payload: { type: "task_complete", turn_id: "turn-2" } },
  ];
  expect(turnStateFromRecords(severed, "codex")).toMatchObject({
    state: "terminal", source: "lifecycle", terminalAt: "2026-09-09T05:40:18.415Z",
  }); // RED today: { state: "busy", source: "tool" }
});

test("an aborted turn releases its open tools", () => { /* task_started, function_call, turn_aborted → terminal */ });
test("a task_complete inside the turn that still owns an open tool stays busy", () => { /* unchanged guard, already at turnState.test.ts:31 */ });
```

**Durable** (`src/lib/pipelines/durableEvidence.test.ts`): a fixture transcript with the six records above written to a temp file; `durableStageTurnEvidence("codex", path)` returns `turn: "terminal"` and the final message. Red today: `turn: "busy"`.

**Engine** (`src/lib/pipelines/engine.test.ts`): no new mechanics, but one end-to-end guard is cheap and answers "exactly-once advancement": a running structured run-stage whose durable evidence for the attempt's transcript is `{ turn: "terminal", message: <valid pass verdict after startedAt> }` settles on one tick, the next stage gets exactly one attempt, and a second tick with the same evidence creates nothing more. The harness's `durableTurns` map (`engine.test.ts:474`) is the seam; `runningStructuredStage` (`engine.test.ts:3029`) builds the state. Most of this is already covered by the #337 settlement tests; the new case is only the fixture whose *raw records* would have read busy before the fix, run through the real `durableStageTurnEvidence` rather than the map, so the test fails for the real reason.

**Not advancing on the wrong evidence** (the manager's negative acceptance). Already enforced and covered, unchanged by this design: a final-looking message inside an open turn does not settle (`engine.ts:2427-2430`, "a recovered idle host over a mid-turn transcript must not terminalize the attempt"); a message older than `attempt.startedAt` is ignored (`engine.ts:2350`); an unknown transport with no durable read returns without settling (`engine.ts:2399`); prose without a fenced verdict records a recovery miss and, after three, parks (`engine.ts:2456-2464`). The design adds no new settlement path, so these stay the only ways in.

## 5. Ownership and slicing

Two independent slices; neither depends on the other, on automation-v2 slices 1 and 2, or on the task-centered board lane (#1586, pipeline builder in flight), whose files are `src/components/**`, `projectModel.ts`, board and task code. Nothing below touches those.

| Slice | Issue | Files (sole writer) | Tests | Notes |
| --- | --- | --- | --- | --- |
| A1 | #1433 | `src/lib/pipelines/engine.ts` (predicate, loop branch, `stateDetail` on the deferral) | `src/lib/pipelines/engine.test.ts` (three tests in §3.5), `src/lib/accounts/accountMutation.test.ts` (contention test, additive) | `engine.ts` is automation-v2 lane B; this is that lane's slice-3 half. `accountMutation.ts` is not edited. |
| B1 | #1589 | `src/lib/accounts/migration/turnState.ts` | `src/lib/accounts/migration/turnState.test.ts`, `src/lib/pipelines/durableEvidence.test.ts` (fixture), one engine end-to-end case in `engine.test.ts` | Not in any automation-v2 lane. Touches a function every liveness reader shares, so the reviewer should run `src/lib/scanner/activity.test.ts` and `src/lib/lifecycle/liveness.test.ts` by path. |

Run tests by path only. `bun test src/lib/agent/` and other directory sweeps are forbidden on this machine (AGENTS.md); the lock test writes to a temporary `LLV_STATE_DIR` in a child process and must keep doing so.

Rollout: both slices are engine and projection logic served by the Viewer container; a normal release carries them. No live-state surgery is needed for the two incident records: the first is closed and preserved; the second is paused by its owner with a hand-spawned reviewer, and unpausing it after B1 ships will settle the builder attempt from the transcript on the next tick (the verdict is already there) and activate a review attempt, which the owner may not want twice. That decision is the owner's, so this design does not touch it.

## 6. Deferred, not currently justified

- **Async lock on the pipeline reservation** (automation-v2 slice 3, lane A half). Reason in §3.6 option B: it moves the wait inside the controller's 15 s phase. Reconsider only if A1's park-after-budget is observed in production.
- **Naming the lock holder in the park sentence** (#1433's last bullet). Needs a label through `accountMutation.ts` and every async caller. The originating requirement asks for a truthful pending/failed reason, which "deferred: account mutation is busy; retry at …" and "failed after N retries over Ss" already give.
- **Shortening the holders** (probing accounts outside the lock, or holding the local flag only while the file lock is actually held). Real and worth an issue of its own; not needed for the acceptance, and it changes lock semantics for every caller.
- **Turn-id scoped tool ledger** for Codex (§4.4). Correct and heavier; the boundary reset answers every observed shape.
- **Rewriting the startup continuation** so a severed tool call is re-driven explicitly (#1184's Claude side). The continuation already worked here; the projection was the fault.
- **A `waiting` sub-state on the attempt** for the board. `stateDetail` on the existing record is the protocol the board already reads; a new state is the automation-v2 record work, not this fix.

## 7. Over-engineering pass

Cut from the first draft of this design: a retry counter and backoff of its own for the busy error (the #1191 wait record already is one); a new `AccountLockWait` type on the attempt (one string predicate reuses `controllerWait`); an engine change for Scenario B (the settlement path is right once the evidence is right); a turn-id ledger (§6); a change to `accountMutation.ts` (§6). What remains is one predicate plus one branch in `engine.ts`, one `stateDetail` sentence, and one reset in `turnState.ts`, each with a red test that fails for the real reason.

## 8. Validation against the originating requirement

- "не працює виодить як треба" (the pipeline card says one thing and the agent does another): both scenarios end with the record telling the truth, in the state fields the board already renders.
- "durable bounded queued/retry state with same identity": §3.6, persisted `controllerWait`, attempt `n = 1`, 30 s budget.
- "resumes after busy clears without new operator message": the controller's own scheduled tick.
- "exactly one fresh launch; no duplicate workers": null `launchId` before the throw; `clientAttemptId` fencing after.
- "board shows truthful pending/failed reason and actual running only after host claim": the deferral sentence; `running` unchanged.
- "failure state not silent needs_decision for transient busy": park only after the budget, with count and seconds.
- "legitimate unknown existing launch remains protected": the wait is entered only on the pre-reservation throw.
- "don't broadly kill/restart workers or bypass locks/timeouts": no lock or timeout changes, no live actions taken during this stage.
- "automatic exactly-once review advancement after authoritative completion, no advancement on mere final-looking prose/partial turn/unknown transport": §4.4 and §4.5; the authority stays the transcript's terminal event plus a fenced verdict newer than the attempt.
- "Board running must reflect reality": the same function feeds `agent_activity`, so the stalled-busy verdict on a finished transcript disappears with B1.
