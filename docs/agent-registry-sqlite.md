# Agent registry SQLite rollout

The registry supports four values for `LLV_AGENT_REGISTRY_SQLITE`:

- `off` keeps `agent-registry.json` authoritative. This is the default.
- `dual-write` reads JSON, writes JSON and SQLite under the existing JSON writer lock, and verifies parity after every mutation.
- `read` reads and transacts through `agent-registry.sqlite` in WAL mode, then refreshes `agent-registry.json` as the rollback mirror.
- `sqlite` uses SQLite for reads and writes after the parity burn-in. It refreshes the JSON mirror at process start and removes JSON serialization from registry operations.

The first process that opens any gated SQLite mode creates `agent-registry.sqlite` and imports the normalized contents of `agent-registry.json` in one transaction. An interrupted import has no migration marker, so the next boot retries the complete import. Durable memberships, spawn receipts, capability digests, lineage, conversation generations, migration state, delivery receipts, and routing policy all migrate through the same snapshot.

## Rollout

1. Preserve a copy of the current state directory.
2. Start every Viewer and runtime-host process with `LLV_AGENT_REGISTRY_SQLITE=dual-write`.
3. Treat `RegistryParityError` as a rollout stop. Keep JSON authoritative while investigating any mismatch.
4. Restart every registry writer with `LLV_AGENT_REGISTRY_SQLITE=read` for an SQLite-read burn-in with a continuously refreshed JSON rollback mirror.
5. After that burn-in, restart every writer with `LLV_AGENT_REGISTRY_SQLITE=sqlite` to remove JSON rewrites from the operation path.
6. Retain `agent-registry.json`, `agent-registry.sqlite`, and the SQLite WAL files throughout both burn-ins.

The `read` and `sqlite` paths bypass the whole-registry writer lock, its retry/backoff loop, stale-lock recovery, temp-file cleanup, and startup JSON compaction. Per-session operation locks remain active. They serialize host actuation independently of registry persistence.

## Rollback

1. Stop every process that can mutate the registry.
2. Preserve the JSON and SQLite files together for diagnosis.
3. When rolling back from `sqlite`, start one process with `LLV_AGENT_REGISTRY_SQLITE=read` and stop it after startup. Startup refreshes the JSON mirror to the current SQLite revision.
4. Restart all processes with `LLV_AGENT_REGISTRY_SQLITE=off`. The JSON mirror is the authoritative rollback source.
5. To resume the rollout, use `dual-write` first. That mode imports the current JSON snapshot into SQLite and verifies parity before serving registry operations.

Keep the SQLite files until the rollback has been validated. The database and WAL artifacts preserve evidence for diagnosing storage failures and caller-level state changes.
