# Issue #22: provenance-aware context windows and current memory snapshots

## Task statement

Resolve context capacity from in-band runtime metadata or a versioned exact-model registry, preserve raw usage when capacity is unknown, expose provenance in the shared context chip, and keep RAM/swap snapshots current and timestamped.

## Acceptance criteria

- AC1: Codex uses `token_count.info.model_context_window` as exact runtime capacity; records without that field preserve the prior hidden-chip behavior.
- AC2: Claude model aliases normalize provider prefixes, dates, Bedrock versions, Vertex versions, and explicit `[1m]` mode before exact registry lookup.
- AC3: The bundled registry is versioned `2026-07-10`; unknown and future model keys stay unresolved.
- AC4: Every visible context result carries `source`, `confidence`, `observedAt`, and registry-derived results carry `registryVersion`.
- AC5: Runtime percentages may reach 100; registry percentages cap at 99; registry overflow demotes to unknown capacity with raw usage retained.
- AC6: Unknown capacity renders `ctx <used>` with a neutral tone, no denominator, withheld percentage copy, and stays hidden in mobile pane headers.
- AC7: Known tooltips show the actual window and its runtime or registry provenance; registry tooltips disclose the registry version.
- AC8: Capacity resolves from the same transcript record as usage, so model changes and post-compaction usage select the current record.
- AC9: Context scanning remains synchronous and performs no provider/network polling.
- AC10: RAM uses `MemAvailable`, swap uses `SwapTotal - SwapFree`, host memory is captured on every resources request, and the sidebar labels capture age.
- AC11: Regression tests cover provenance math, registry overflow, exact aliases, future ids, Codex suppression, compaction/model change, and known/unknown chip rendering.
- AC12: `bun test`, `bunx tsc --noEmit`, and `git diff --check` pass before push.
