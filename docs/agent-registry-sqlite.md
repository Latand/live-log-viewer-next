# Agent registry SQLite rollout

The registry supports four values for `LLV_AGENT_REGISTRY_SQLITE`:

- `off` keeps `agent-registry.json` authoritative. This is the default.
- `dual-write` reads JSON, writes JSON and SQLite under the existing JSON writer lock, and verifies parity after every mutation.
- `read` reads and transacts through `agent-registry.sqlite` in WAL mode, then refreshes `agent-registry.json` on a bounded five-second checkpoint cadence. Startup and release demotion write a revision-stamped checkpoint.
- `sqlite` uses SQLite for reads and writes after the parity burn-in. It refreshes the JSON mirror at process start and removes JSON serialization from registry operations.

The first process that opens any gated SQLite mode creates `agent-registry.sqlite` and imports the normalized contents of `agent-registry.json` in one transaction. An interrupted import has no migration marker, so the next boot retries the complete import. Durable memberships, spawn receipts, capability digests, lineage, conversation generations, migration state, delivery receipts, and routing policy all migrate through the same snapshot.

Every process with an enabled SQLite mode must run on Bun. The Docker Viewer uses `bun-container --bun`, and the published CLI selects Bun automatically when the gate is enabled. For a source checkout, launch Next with `bun --bun node_modules/.bin/next start`.

Managed releases read the mode from the Viewer Compose environment. Set one
`LLV_AGENT_REGISTRY_SQLITE=<mode>` entry in the service environment before a
deployment starts. The immutable Viewer candidate receives that validated
value, its deployment capability response reports the opened registry mode,
and the runtime-host successor receives the same value after predecessor
environment deduplication. Candidate health fails when the configured and
observed modes differ, so promotion cannot publish a split registry fleet.

## Rollout

1. Stop every Viewer and runtime-host process that can mutate the registry. Confirm that no registry writer remains before changing backend files.
2. Preserve a copy of the current state directory. Archive the known stale `agent-registry.sqlite`, `agent-registry.sqlite-wal`, and `agent-registry.sqlite-shm` together under distinct inactive names, retaining their timestamps and permissions as diagnostic evidence.
3. Keep the current `agent-registry.json` at its active path and clear only the three active SQLite paths after the archive is verified.
4. Start exactly one Bun-hosted process with `LLV_AGENT_REGISTRY_SQLITE=dual-write`. Its first boot creates SQLite and imports the authoritative JSON in one transaction. Verify parity and stop this importer before allowing the writer fleet to start.
5. Start every Bun-hosted Viewer and runtime-host process with `LLV_AGENT_REGISTRY_SQLITE=dual-write`.
6. Treat `RegistryParityError` as a rollout stop. Keep JSON authoritative while investigating any mismatch.
7. Restart every registry writer with `LLV_AGENT_REGISTRY_SQLITE=read` for an SQLite-read burn-in with a continuously refreshed JSON rollback mirror.
8. After that burn-in, restart every writer with `LLV_AGENT_REGISTRY_SQLITE=sqlite` to remove JSON rewrites from the operation path.
9. Retain `agent-registry.json`, `agent-registry.sqlite`, and the SQLite WAL files throughout both burn-ins.

`/api/files` reports the backend mode, revision, transaction count, transaction p95,
writer-wait p95, rollback-mirror checkpoint timestamp, and dirty-checkpoint state under
`systemHealth.registry`. The cached response exposes the stable mirror checkpoint
timestamp and omits time-decaying writer rate; rollout probes derive both values at
observation time. `/api/runtime/deployments/capabilities/v1` reports
`registryBackendMode` from the registry instance opened by that Viewer process.
A rollout probe must
observe one current release owner, a bounded mirror age in `read`, and a stable JSON
mtime during `sqlite` streaming.

The release gate uses a registry of at least 14,660,822 bytes with ten mixed
structured-host lanes and a concurrent reader. Registry mutation p95 must stay
below 250 ms, SQLite writer-wait p95 below 100 ms, reader p95 below 100 ms,
the cold `/api/files` probe below 1,000 ms, and its warm probe below 500 ms.
The measured revision delta must equal the admitted material and coalesced
cursor transactions, and the JSON mirror inode metadata must remain unchanged
through steady-state `sqlite` traffic.

A failed scheduled rollback checkpoint retains the dirty revision and retries
with exponential backoff capped at 30 seconds. Successful convergence resets
the retry series.

The `read` and `sqlite` paths bypass the whole-registry writer lock, its retry/backoff loop, stale-lock recovery, temp-file cleanup, and startup JSON compaction. Per-session operation locks remain active. They serialize host actuation independently of registry persistence.

## Rollback

1. Stop every process that can mutate the registry.
2. Preserve the JSON and SQLite files together for diagnosis.
3. When rolling back from `sqlite`, start one process with `LLV_AGENT_REGISTRY_SQLITE=read` and stop it after startup. Startup refreshes the JSON mirror to the current SQLite revision.
4. Restart all processes with `LLV_AGENT_REGISTRY_SQLITE=off`. The JSON mirror is the authoritative rollback source.
5. A rollback with no subsequent `off`-mode mutations can resume directly in `dual-write`. It admits an existing backend pair only when the revisions and normalized snapshots agree, preserving both files and throwing `RegistryParityError` on any drift.
6. After any `off`-mode mutation, stop every writer again and archive `agent-registry.sqlite`, `agent-registry.sqlite-wal`, and `agent-registry.sqlite-shm` together under distinct names. Keep that archived trio with the pre-rebaseline JSON for diagnosis.
7. With the active SQLite paths clear and the current JSON retained, start exactly one Bun process in `dual-write`. First boot creates a fresh database and imports the authoritative JSON in one transaction. Stop that process after initialization, preserve a fresh state-directory copy, then restart every writer in `dual-write`.

Keep the SQLite files until the rollback has been validated. The database and WAL artifacts preserve evidence for diagnosing storage failures and caller-level state changes.
