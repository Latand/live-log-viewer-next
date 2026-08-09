# Hot state stores on SQLite

Issue #907 identified three whole-file JSON stores on request and controller
paths: flows, pipelines, and workflows. This phase moves those collections to
one SQLite database while retaining their TypeScript APIs.

## Storage shape

`state/state.sqlite` uses WAL mode, full synchronous durability, foreign keys,
and incremental vacuuming. One shared file gives the Viewer, inventory worker,
and MCP runtime one schema and migration ledger. It also avoids coordinating
separate database lifecycles when an operation moves a pipeline into the
archive. Each collection has its own revision and cooperative lease. Controller
callbacks hold that lease while each `persist()` checkpoint commits in a short
`BEGIN IMMEDIATE` transaction. Independent collection callbacks can run in
parallel while SQLite serializes their commits. Schema creation and connection
PRAGMAs use the same bounded busy retry, so two processes may safely create the
database on first boot.

The generic tables are:

```sql
state_collections(
  collection TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  change_floor INTEGER NOT NULL,
  migration_id TEXT NOT NULL,
  imported_at TEXT NOT NULL
)

state_rows(
  collection TEXT NOT NULL,
  row_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  row_order INTEGER NOT NULL,
  row_revision INTEGER NOT NULL,
  controller_active INTEGER NOT NULL,
  PRIMARY KEY(collection, row_key)
)

state_changes(
  collection TEXT NOT NULL,
  revision INTEGER NOT NULL,
  row_key TEXT NOT NULL,
  operation TEXT NOT NULL,
  PRIMARY KEY(collection, revision, row_key)
)

state_leases(
  collection TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_start_identity TEXT,
  acquired_at INTEGER NOT NULL
)
```

The collections are `flows`, `pipelines`, `pipelines_archive`, and
`workflows`. A flow row contains its rounds. A pipeline row contains stages,
runs, and attempts. A workflow row contains its template and stage runs. These
nested structures change together under existing lifecycle invariants, so a
separate child table would add joins and partial-record states without reducing
the dominant mutation cost.

Every committed collection change increments its collection revision once.
`state_changes` records the affected keys. A reader whose cached revision is
behind queries the keys changed after that revision and fetches only their
current rows. The revision, bounded change query, and row fetch share one read
transaction, so the cache always represents one committed snapshot. Change
history retains 1,024 revisions. Each write prunes at most 1,000 old rows and
advances `change_floor`; a cache older than that floor performs a full reload.
Order changes use the same seam. The indexed
`controller_active` column classifies each row when it is inserted or updated.
The flow controller queries active rows directly, and the pipeline controller
queries actionable rows plus terminal records with unfinished host cleanup.
Their checkpoints upsert the records that changed. Settled rows stay outside
the controller mutation query and checkpoint cost.

## Transactions and compatibility

`loadFlows`, `saveFlows`, `withFlowMutation`, `loadPipelines`,
`withPipelineMutation`, `loadWorkflows`, `saveWorkflows`, and the projection
readers retain their signatures. Store modules keep validation, normalization,
stale-flow revision fencing, and fresh-copy behavior. Arrays returned by the
flow and workflow loaders carry an internal baseline. A later detached save
becomes a row patch under the collection lease, preserves concurrent additions,
and accepts deletions only while the durable row still matches that baseline.
An untracked array passed directly to a full-save API keeps the historical
replacement behavior.

An async mutation acquires a collection lease through `BEGIN IMMEDIATE`.
`persist()` validates and commits the dirty rows, then the callback may continue
with external lifecycle work and issue another checkpoint. The lease keeps a
second cooperative writer outside that callback. A dead owner is recovered
from the shared Linux/macOS process identity backend, including PID-reuse
fencing. An unavailable start identity is inconclusive while the PID remains
alive; reclamation requires process death or a proven identity mismatch.
Acquisition retries follow the existing 30-second
bound and surface `FileTransactionBusyError` with the established store
message.

The mutation array materializes records lazily. At each checkpoint it compares
the JSON for each materialized record with that row's current value, which
captures nested object and array writes while avoiding a clone of untouched
records. After commit, the checkpoint retains those materialized roots and
re-baselines their committed JSON. Later checkpoints therefore capture nested
writes through references retained across asynchronous controller work.
Structural array changes reconcile keys and row order, then re-baseline all
current records. Controllers can pass an explicit changed row subset to
`persist()` for a bounded upsert.

Moving a settled pipeline acquires the `pipelines` and `pipelines_archive`
leases in lexical order and performs the archive upsert plus active deletion
in one database transaction. An existing archive row is replaced by the
authoritative active record. Workflow detached saves use a three-way field
merge, retaining concurrent operator state while persisting disjoint ownership
fields returned by an external spawn.

## First boot and rollback mirror

The promoted release first checks the complete schema-version and migration-id
marker set. Matching markers make SQLite authoritative immediately and bypass
legacy preflight, so stale or damaged rollback mirrors cannot rerun or block a
completed migration. With an absent, partial, or mismatched marker set, the
release preflights and normalizes all four legacy sources before opening the
database. It imports `flows`, `pipelines`, `pipelines_archive`, and `workflows`
in one `BEGIN IMMEDIATE` transaction. A fault after any individual import rolls
back every row and marker. A restart while authority remains `preparing`
retries an incomplete import from the still-authoritative JSON files. The
transaction clears any partial markers created by an earlier implementation
before reseeding, so a mixed database cannot become authoritative. A second
marker check inside that transaction prevents a concurrent completed import
from being replaced.

Pipeline migration folds `pipelines.json` into `pipelines` and
`pipelines-archive.json` into `pipelines_archive` inside that shared cutover
transaction. The active/archive boundary becomes durable with flows and
workflows. Malformed or unreadable active JSON fails during preflight and
leaves the database unmarked. Malformed archive records retain the archive
reader's lenient, observable behavior. Local development without a release
target may initialize a requested collection directly; deployed cutover uses
the four-store coordinator.

After initialization, SQLite is authoritative. JSON stays as an explicit
rollback mirror because the retained previous Viewer binary has no SQLite
reader. Initial import and ordinary reads leave those files unchanged. A
fenced demotion checkpoints every mirror from one exact collection revision
and records it as `_sqliteRevision`. Steady-state writes avoid JSON
serialization, while later SQLite commits remain available for forward
recovery.

Release records advertise `hotStateBackend: sqlite-v1`. A durable
`hot-state-authority.json` record carries a monotonic epoch, the active release
revision, an optional activation timestamp, and one of four modes: `legacy`,
`preparing`, `sqlite`, or `fencing`. Authority publication, acknowledgement,
completion, and restore share one file-transaction lock. Restore compares the
exact transition record and publishes the prior semantic state through a newer
epoch. Delayed acknowledgements and stale restores cannot overwrite a later
handoff.

For the first SQLite release, the adapter durably publishes `preparing` before
moving the stable target. The promoted process waits for three stable
legacy-file observations, completes the dry run and atomic import, and changes
the same authority epoch to `sqlite`. It adds `activationReadyAt` after the hot
stores are initialized, then starts structured-host adoption and controllers
before adding `releaseReadyAt`. The deployment adapter uses the first timestamp
to complete target promotion; the capability route remains 503 until the
second timestamp records full release startup. Slow recoverable adoption stays
inside the longer post-promotion health gate. The release monitor starts before
activation work, so rollback fencing remains available during a failed or
stalled startup.

Every writer proves that its Viewer port or MCP release revision matches both
the durable target and SQLite authority. Passive candidates, portless MCP
processes without an explicit release revision, and retired releases cannot
initialize or mutate the database.

Rollback starts by publishing a new `fencing` epoch for the active SQLite
release. Mutation authority is checked before lease acquisition and again
inside each SQLite transaction. The deployment adapter checkpoints flows,
active pipelines, the pipeline archive, workflows, and the agent registry from
authoritative SQLite. The active Viewer may acknowledge the same request; the
acknowledgement compare-and-set accepts one exact epoch. Both paths record the
four exact revisions and suppress a later demotion callback from overwriting
those mirrors.

After checkpointing, the adapter publishes destination authority with the
checkpoint before changing the stable target. This order immediately fences
the source. A crash in that interval leaves the source target blocked and the
destination authority durable; retry recognizes that intermediate state and
finishes target publication. A checkpoint or publication failure restores the
source target and previous authority only while the adapter still owns the
transition, using a newer epoch.

The application launcher, development script, production script, package
metadata, and source-install documentation require Bun because these stores
depend on the built-in SQLite driver.

The migration planner parses every source and rejects malformed records, empty
keys, and duplicate keys without opening or writing the database. Tests cover
the dry run, complete-marker guard, first import, malformed-source failure,
repeated boot, exact checkpoint refresh, concurrent first boot, and pipeline
archive fold-in. A two-release test covers promotion, a final retiring JSON
write, a later SQLite mutation, demotion checkpointing, and rollback.

Request projections key the hot collections on their authoritative collection
revisions. Compatibility projections open SQLite read-only and never initialize
schema or take a writer transaction. One connection captures the flow and
workflow revisions for a request, and the resulting key is threaded through
every cwd resolution in that request. A second connection reads initialized
collection markers and all requested rows through one left-join statement.
That snapshot distinguishes an absent marker from an initialized empty
collection. Unrelated pipeline heartbeats leave the project-fact cache warm.
Directory discovery and `/api/files` tests mutate SQLite from another process
and verify immediate cache invalidation.

## Performance proof

The synthetic test runs nine measured mutation-and-read cycles after warm-up.
Its production-shaped SQLite path selects one active pipeline from 500 records,
persists that row, selects one active flow from 200 records, persists that row,
and reads both results. The JSON comparison parses, mutates, rewrites, and
re-reads the corresponding full documents. A 1-pipeline/1-flow SQLite run is
the settled-count control.

On 2026-08-06, the median timings were 5.030 ms for JSON, 2.330 ms for the
500-pipeline/200-flow SQLite corpus, and 1.878 ms for the 1/1 SQLite control.
The settled-record scale factor was 1.241. A production-shaped project-fact
request under unrelated pipeline churn measured 0.886 ms and retained the same
flow/workflow cache key. Resolving 7,700 project facts measured 365.761 ms and
used three read-only SQLite connections. The test requires a scale factor below
2.5, requires the corpus SQLite cycle to beat the corpus JSON cycle, bounds the
scanner path below 50 ms, and bounds the project-fact corpus below three
seconds with at most three read-only connections.

## Phase boundary

Tasks, MCP receipts, attention, project aliases, and the worktree map remain on
their current stores in phase 1. Their call patterns and retention contracts
differ from the three controller stores. The next wave can reuse the row,
revision, change-log, and migration seams after defining retention for tasks
and receipts, high-frequency attention coalescing, and conflict rules for
alias/worktree convergence.
