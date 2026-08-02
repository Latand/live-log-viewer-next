# Issue #863 — slow structured `list_pipelines`: phase profile, RED proof, integration plan

Status: **diagnosis complete, repair fenced.** Every file the repair must edit is
also modified by open PR #859, so no product source was changed here.

## Reproducing

All three scripts seed their own `LLV_STATE_DIR` sandbox under `$TMPDIR` and
delete it on exit. None of them read or write live viewer state.

```
bun spikes/issue-863/red.ts        # acceptance assertions — currently 6 RED
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

## Why the repair is fenced

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

## Disjoint integration plan (after #859 lands)

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
