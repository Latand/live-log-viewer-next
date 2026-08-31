# Runtime journal retention

The runtime host keeps a durable event tail and the projections needed to
resume work after a Viewer or host succession. Maintenance runs on wall clock,
including during quiet periods.

## Retained data

- `events` keeps the newest 20,000 rows. The compaction anchor records the
  deleted prefix and preserves hash-chain verification for the retained tail.
- session, operation, flow, workflow, task, and deployment projections keep
  their current state. Snapshot presentation applies its own smaller bounds.
- pending outbox work stays until it reaches a terminal receipt, subject to the
  orphan rule below. A delivered kill keeps one retained admission boundary for
  delivery fencing.
- engine producer receipts keep the highest cursor per session prefix. Other
  producer receipts stay while their event remains above the compaction anchor.

## Removed data

- event rows below the 20,000-row tail, their consumer checkpoints, completed
  outbox rows below the anchor, and unpinned operation rows below the anchor;
- superseded engine cursors and producer receipts whose events fell below the
  anchor;
- queued or pending `runtime.spawn` and `runtime.kill` effects after a persisted
  orphan timer records at least 60 continuous minutes with no hosted or
  recovering journal session and no current registry conversation. The first
  absent sweep starts the timer; any later liveness evidence clears it. Alias
  lookup resolves full chains, and cycles preserve pending work. An active
  pre-materialization launch receipt protects work while its conversation is
  forming. Completed receipts and materialized nonterminal receipts carry no
  independent liveness authority. An absent registry conversation, a terminal
  failed/conflicted launch receipt, a superseded conversation, or a latest
  registry host marked `dead` satisfies the registry half of this rule. An
  `unhosted` entry remains live authority because it is working or
  mid-transition. The sweep records a failed receipt whose reason starts with
  `stale:` and completes its outbox row. Sends and interrupts retain their
  unknown-fate settlement rules.

The orphan sweep runs every minute. Missing or unreadable registry evidence
leaves work unchanged and retries on the next tick.

## Space reclamation

SQLite reuses free pages, so row retention alone can leave the file much larger
than its live data. The runtime host checks `page_size`, `page_count`, and
`freelist_count` every minute. A rebuild is due when the freelist is at least
64 MiB and at least 25% of the database, with at least 24 hours since the last
successful rebuild. A failed attempt waits one hour before another attempt.

The rebuild runs in a separate `bun-container` process so the host socket event
loop can continue serving requests. It performs a passive WAL checkpoint,
enables incremental auto-vacuum for legacy journals, runs `VACUUM`, records the
completion time, and truncates the WAL. Subsequent freed pages remain available
for reuse and the same threshold schedules future reclamation.

## Request latency

The Viewer keeps the latest 256 completed runtime-host socket calls in memory.
`deployment_status` exposes their p95, maximum, sample count, and timeout count,
including inside its structured error details when the runtime host is
unreachable. Timeout logs include the request method and elapsed milliseconds.
The deliberate `wait` long poll is excluded from the percentile window; its
normal residence time can reach 30 seconds and belongs outside the journal
pressure measure.
