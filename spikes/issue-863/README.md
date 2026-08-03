# Issue #863 — slow structured `list_pipelines`: phase profile, RED proof, repair

Status: **repaired.** `red.ts` is GREEN on the same fixture that produced every
number below; see "The repair" at the end for what shipped and what it cost.
The diagnosis sections are kept verbatim as the record of the measured baseline.

## Reproducing

All three scripts seed their own `LLV_STATE_DIR` sandbox under `$TMPDIR` and
delete it on exit. None of them read or write live viewer state.

```
bun spikes/issue-863/red.ts        # acceptance assertions — 6 RED before the repair, all GREEN after
bun spikes/issue-863/endToEnd.ts   # per-phase aggregate timings
COUNT=1000 CONCURRENCY=16 bun spikes/issue-863/red.ts
```

`corpus.ts` builds the production-shaped fixture: 500 pipelines, two staged
roles each, six attempts per stage with realistic prompt/input/output bodies and
a spec — 189 MB of registry, one quarter of it closed, spread over eight
projects so `project`/`state`/`includeClosed` filters all discriminate.

## Measured phase profile

`list_pipelines(project: "viewer", includeClosed: false, limit: 100)` against
that registry, through the real `createMcpToolService` + `SqliteMcpReceiptStore`:

| phase | single call | 8 concurrent (p95) |
| --- | --- | --- |
| store read (`loadPipelines`) | 265 ms | — |
| filter + slice | 0.4 ms | — |
| redaction (`redactPayload`) | 1089 ms | — |
| `binding` (read + filter + redact) | — | 11 175 ms |
| `claim` (SQLite receipt) | — | 9 862 ms |
| `completion` (receipt write) | — | 1 359 ms |
| `serialization` | — | 35 ms |
| `serviceTotal` | — | 12 766 ms |

Response size: **37.33 MB for 100 rows** — 365 KB per row. RSS grows **+2 300 MB**
across 8 concurrent calls (629 MB → 2 928 MB).

## Root cause

The store read is not the problem: it costs 265 ms, and `GET /api/pipelines`
calls the very same `getPipelines()` — which is why direct HTTP answered in
about 200 ms. The cost is everything the MCP path does *after* the read, all of
it scaling with full nested history that a list row never needs.

`src/lib/mcp/bindings.ts:1400` — `listPipelines`:

```ts
const pipelines = dependencies.getPipelines().pipelines
  .filter(...).filter(...).filter(...)
  .slice(0, limit);
return redactPayload({ count: pipelines.length, pipelines });
```

Four compounding effects:

1. **No projection.** The 100 surviving rows are whole `Pipeline` records —
   `stages[].prompt`, `stages[].effectiveRole.promptScaffold`, `spec`, and
   `runs[].attempts[]` with every `input`/`output` transcript body. That is the
   365 KB per row and the 37 MB response.
2. **Redaction walks the whole graph.** `redactPayload` recurses every key and
   runs `hardenedRedact` on every string, so it pays for history the caller
   discarded: 1.1 s of pure CPU per call.
3. **The 37 MB payload is then serialized four more times** — `JSON.stringify`
   for the receipt row, again for `resultSizeBytes`, again for the `content`
   text block, and again by the SDK for `structuredContent` over stdio. The
   receipt store additionally writes the 37 MB blob into SQLite and re-walks
   `storage_bytes` retention pruning, which is where `claim` and `completion`
   contention comes from under concurrency.
4. **Cancellation cannot land.** `bindings.ts:1918` binds the tool as
   `(args) => Promise.resolve(listPipelines(args, domainDependencies))` — the
   `McpToolCallContext` (and therefore `signal` and `deadlineAt`) is dropped, and
   the body is fully synchronous. The 30 s `deadlineSignal` in
   `createViewerMcpServer` is a timer that cannot fire while that synchronous
   walk owns the event loop, so a timed-out caller leaves the work running to
   completion and still pays the receipt write.

At 500 pipelines this already costs 12.8 s wall at concurrency 8. The reported
70 s is the same curve on a larger corpus with stdio framing of ~74 MB per
response (content text + structuredContent).

## RED assertions (current behaviour)

```
RED  bounded list rows — 365 KB per row (budget 64 KB)
RED  no attempt history in list rows — rows carry runs[].attempts[]
RED  no stage prompts in list rows — rows carry stages[].prompt
RED  no spec body in list rows — rows carry spec
PASS HTTP/MCP count parity — http 100 vs mcp 100
PASS HTTP/MCP ordering parity — id sequences compared
RED  concurrent x8 within 5000 ms — 12798 ms wall
RED  bounded RSS growth under concurrency — +2300 MB (629 → 2928 MB)
PASS all concurrent calls succeeded — 8/8 ok
```

Filter and ordering semantics already agree with HTTP, so the repair must
preserve them rather than establish them.

## The repair (shipped)

The lane was un-fenced when PR #859 was parked, so the whole repair landed at
once rather than in the two disjoint halves drafted in the appendix.

1. **`src/lib/pipelines/listProjection.ts`** (new) — `PipelineListRow` and
   `projectPipelineListRows`. Board-card fields only: identity, placement, state,
   cursor stage + state, attempt counts, and per-stage
   `{ id, kind, roleId, engine, model, effort, access, next, onFail, attempts,
   latestAttempt }`. Filters and stops at `limit` in ONE pass before any row is
   materialized, so nested history is never touched for a record that was going
   to be dropped. Operator free text (`task`, `stateDetail`, an attempt `error`)
   is clamped, which is what gives a row a length bound the registry does not
   have. `latestAttempt` uses the shared `latestOperationalStageAttempt`, so a
   lineage-adopted historical attempt is never reported as current work.
2. **`src/lib/pipelines/store.ts`** — `loadPipelinesForList()`, which shares the
   signature-keyed parse cache `loadPipelinesForProjection` already kept (no
   second copy of the registry in memory) and skips the per-caller
   `reviveLoadedPipeline` deep copy, because a row copies scalars and retains
   nothing. This is where the 265 ms read and the 8x re-parse under concurrency
   went. The registry is a single JSON file, so it admits no indexed read; the
   materialization the filter now precedes is the revive, not the parse.
3. **`src/lib/mcp/bindings.ts`** — `listPipelines` is async, projects, and
   redacts the projected rows; the tool table entry forwards `context`. The
   filter, ordering and `limit` bound are byte-for-byte the previous semantics.
   `get_pipeline` is untouched and remains the full-detail read.
4. **Cancellation** — the binding passes `throwIfCallEnded(context)` as the
   projection's checkpoint, and the projection yields to the event loop between
   row batches so the 30 s deadline timer can actually fire instead of waiting
   for a synchronous walk to release the loop. `createMcpToolService` skips
   `receipts.complete` for a `deadline`/`cancelled` outcome **on bounded reads
   only**, so an abandoned list call leaves no receipt row and its
   `clientRequestId` returns with the bounded lease. Durable mutation claims are
   excluded deliberately: `pruneBoundedReceipts` sweeps an unsettled claim only
   for `retention = 'bounded'`, so skipping the write for a mutating tool would
   strand a permanent `result_json IS NULL` row. Every outcome that produced a
   real answer still writes, so replay is unchanged.
5. **`src/lib/pipelines/engine.ts` and `types.ts` were not touched.** The list
   row type lives with the projection, and `getPipelines` stays the HTTP/detail
   seam — the binding reaches the bounded read through an optional
   `listPipelineRecords` dependency instead.

### Same fixture, after

```
PASS bounded list rows — 1 KB per row (budget 64 KB)
PASS no attempt history in list rows — rows carry no attempts
PASS no stage prompts in list rows — rows carry no prompts
PASS no spec body in list rows — rows carry no spec
PASS HTTP/MCP count parity — http 100 vs mcp 100
PASS HTTP/MCP ordering parity — id sequences compared
PASS concurrent x8 within 5000 ms — 37 ms wall
PASS bounded RSS growth under concurrency — +6 MB (583 -> 589 MB)
PASS all concurrent calls succeeded — 8/8 ok
```

| measure | before | after |
| --- | --- | --- |
| response, 100 rows | 37.33 MB | 0.12 MB |
| per row | 365 KB | 1 KB |
| `binding` p95 (x8) | 10 345 ms | 221 ms |
| `claim` p95 (x8) | 9 025 ms | 1 ms |
| `completion` p95 (x8) | 1 276 ms | 1 ms |
| `serviceTotal` p95 (x8) | 11 844 ms | 223 ms |
| wall, 8 concurrent | 11 878 ms | 37 ms |
| RSS growth, 8 concurrent | +2 115 MB | +6 MB |

The remaining 221 ms binding max is the one cold-cache registry parse; every
later call inside the signature window is about 1 ms.

The 500-pipeline builder now lives at `src/lib/pipelines/fixtures/corpus.ts` and
is imported by both `corpus.ts` here and
`src/lib/pipelines/listProjection.test.ts`, so the measured shape and the tested
shape cannot drift apart. The suite asserts the structural bars (response bytes,
which fields exist, filter/ordering parity, cancellation); wall clock and RSS
stay in `red.ts`, where they are not flaky host-speed assertions in CI.

## Appendix: why the repair was originally fenced


| file the repair needs | why | also modified by |
| --- | --- | --- |
| `src/lib/mcp/bindings.ts` | `listPipelines` body + the tool binding that must forward `context` | PR #859 (`PIPELINE_CONTROLLER_ACTIONS`, line ~72) |
| `src/lib/mcp/server.ts` | cooperative deadline checks / receipt-write skip on abort | PR #859 (`TOOL_INPUT_SCHEMAS.pipeline_action`) |
| `src/lib/pipelines/store.ts` | bounded indexed read variant | PR #859 |
| `src/lib/pipelines/types.ts` | the list-row type | PR #859 |
| `src/lib/pipelines/engine.ts` | `getPipelines` seam | PR #859 **and** PR #842 |

There is no seam that lets a new module replace the bound handler without
editing `bindings.ts`: the tool table is a literal in that file. PR #859's edits
are textually distant from `listPipelines`, so the conflict is ownership, not
merge mechanics.

### Disjoint integration plan as drafted (superseded by "The repair" above)

1. **New file `src/lib/pipelines/listProjection.ts`** — owned by nobody today.
   Export `PipelineListRow` (id, task, project, state, stateDetail, branch,
   worktreeDir, createdAt, closedAt, cursor stage id + state, per-stage
   `{ id, kind, roleId, engine }`, and `attemptCounts` per stage) plus
   `projectPipelineListRows(pipelines, { project, state, includeClosed, limit, signal })`.
   Filter first, `slice` to `limit`, then project — so nested history is never
   copied for a row that was going to be dropped. Budget: ≤ 4 KB per row.
2. **New file `src/lib/pipelines/listProjection.test.ts`** — port the RED
   assertions from `red.ts` into the suite, including the HTTP/MCP parity and
   post-close visibility cases, and keep the 500-pipeline fixture by importing
   `corpus.ts`'s builder (move it to `src/lib/pipelines/__fixtures__` at that
   point).
3. **`src/lib/mcp/bindings.ts` — three lines.** `listPipelines` calls
   `projectPipelineListRows(...)` and redacts the projected rows; the tool table
   entry becomes `(args, context) => Promise.resolve(listPipelines(args, domainDependencies, context))`
   so `signal`/`deadlineAt` reach the projection.
4. **Cancellation.** `projectPipelineListRows` checks `signal.aborted` between
   filter and projection and throws the existing `DeadlineExceededError`;
   `createMcpToolService` skips `receipts.complete` when the signal aborted
   before the binding returned, so a timed-out caller leaves no receipt row and
   no orphan SQLite write.
5. **`get_pipeline` is untouched** — it already returns the full record and
   remains the full-detail read.
6. **Re-run** `bun spikes/issue-863/red.ts` to GREEN, plus
   `bun test src/lib/pipelines/listProjection.test.ts src/lib/mcp/bindings.test.ts`
   by path only.

Expected after the repair: ≤ 400 KB per response instead of 37 MB, redaction
under 20 ms, and concurrency-8 wall inside the 5 s budget with RSS growth in the
tens of MB.
